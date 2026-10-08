// Plano B automático (decisão do dono, 04/09: "nunca é pra não ter algo").
//
// Quando a compra de um pedido PAGO trava na loja (nota "🛑 COMPRA BLOQUEADA": sem
// estoque, sem entrega no CEP, mínimo, preço acima do teto), o sistema não espera um
// humano: procura o mesmo item em outra loja consultável, confirma AO VIVO para o CEP
// do cliente, e oferece a troca com dois botões — "Trocar" ou "Devolver o dinheiro".
// Troca aceita → itens do pedido substituídos, diferença a favor do cliente devolvida
// em parcial, compra segue; recusa → estorno integral na hora. Sem resposta → a regra
// de estorno automático (6h do bloqueio/da oferta) fecha o pedido.
//
// A busca é injetável (testes) e roda por import dinâmico do cérebro para não fechar
// ciclo (delivery-service → ops-lifecycle → plan-b → delivery-service).
import { prisma } from "@/lib/prisma";
import * as copy from "./lia-copy";
import { whatsappAdapter } from "./adapters/whatsapp";
import { checkCandidatesLive, type Simulate } from "./live-availability";
import { humanEstimate, liveCheckConfigured, liveCheckSupported } from "./live-freight";
import { PURCHASE_BLOCKED_PREFIX } from "./order-monitor";
import { appendOrderNote } from "./order-flags";
import { refundOrderViaProvider } from "./payments/ledger";
import { serviceFeeForItems } from "./pricing";
import { deliverNotice, markTurnReplied, notifyOperator, outsideServiceWindow, readCtx, reply, writeCtx } from "./turn-runtime";
import type { BasketItem, ChoiceOption, DeliveryContext } from "./conversation-types";

export type PlanBSubstitute = { fromSku: string; fromName: string; fromStore: string; qty: number; to: ChoiceOption };
export type PlanBState = { orderId: string; substitutes: PlanBSubstitute[]; offeredAt: string };
export type SearchOptions = (query: string, cep: string) => Promise<ChoiceOption[]>;

export const PLAN_B_OFFERED_PREFIX = "🔁 PLANO B oferecido em";
export const PLAN_B_ACCEPTED_PREFIX = "🔁 PLANO B aceito em";
export const PLAN_B_NONE_PREFIX = "🔁 PLANO B: sem substituto verificado";

function priceTolerance(): number {
  return Number(process.env.LIA_PLAN_B_PRICE_TOLERANCE ?? 0.15);
}

export function blockedReasonOf(notes: string | null | undefined): string | undefined {
  return (notes ?? "")
    .split("\n")
    .filter((line) => line.startsWith(PURCHASE_BLOCKED_PREFIX))
    .pop()
    ?.slice(PURCHASE_BLOCKED_PREFIX.length)
    .trim();
}

export function planBMarkerAt(notes: string | null | undefined, prefix: string): Date | undefined {
  const line = (notes ?? "")
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .pop();
  const iso = line?.slice(prefix.length).trim().split(/[\s:]/)[0];
  const parsed = iso ? Date.parse(line!.slice(prefix.length).trim().slice(0, 24)) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

async function defaultSearch(query: string, cep: string): Promise<ChoiceOption[]> {
  const brain = await import("./delivery-service");
  return brain.searchOptionsForPlanB(query, cep);
}

// Ganchos de teste: busca e simulação ao vivo injetáveis (o vigia chama offerPlanB sem deps).
let searchOverride: SearchOptions | null = null;
let simulateOverride: Simulate | null = null;
export function __setPlanBForTests(overrides: { search?: SearchOptions | null; simulate?: Simulate | null }) {
  if ("search" in overrides) searchOverride = overrides.search ?? null;
  if ("simulate" in overrides) simulateOverride = overrides.simulate ?? null;
}

// Para cada item do pedido, o melhor substituto: loja consultável, confirmado ao vivo
// para o CEP, sku diferente, preço até `tolerance` acima do pago. Mais rápido primeiro,
// depois mais barato. Um item sem substituto invalida o plano (não trocamos meia cesta).
export async function findSubstitutes(
  order: { items: unknown; cep: string },
  search: SearchOptions = searchOverride ?? defaultSearch,
  simulate: Simulate | undefined = simulateOverride ?? undefined
): Promise<PlanBSubstitute[] | null> {
  const items = ((order.items as unknown as BasketItem[]) ?? []).filter(Boolean);
  if (!items.length) return null;
  const out: PlanBSubstitute[] = [];
  for (const item of items) {
    let options: ChoiceOption[] = [];
    try {
      options = await search(item.name, order.cep);
    } catch (error) {
      console.warn("[plan-b:search-failed]", error instanceof Error ? error.message : error);
      return null;
    }
    // Simulação injetada (testes) ignora o kill-switch; em produção vale liveCheckSupported.
    const supported = simulate ? liveCheckConfigured : liveCheckSupported;
    const candidates = options.filter(
      (o) => o.storeKey && supported(o.storeKey) && o.sku !== item.sku && o.unitPrice <= item.unitPrice * (1 + priceTolerance())
    );
    if (!candidates.length) return null;
    const wrapped = candidates.map((o) => ({ storeKey: o.storeKey!, sku: o.sku, o }));
    const live = await checkCandidatesLive(wrapped, order.cep, simulate, supported);
    const confirmed = live.kept
      .map((w) => ({ o: w.o, check: live.checks.get(`${w.storeKey}:${w.sku}`) }))
      .filter((c) => c.check?.available);
    if (!confirmed.length) return null;
    confirmed.sort(
      (a, b) =>
        (a.check?.etaMinutes ?? Number.MAX_SAFE_INTEGER) - (b.check?.etaMinutes ?? Number.MAX_SAFE_INTEGER) || a.o.unitPrice - b.o.unitPrice
    );
    const best = confirmed[0];
    out.push({
      fromSku: item.sku,
      fromName: item.name,
      fromStore: item.storeLabel,
      qty: item.qty,
      to: { ...best.o, verified: true, etaMinutes: best.check?.etaMinutes, delivery: humanEstimate(best.check?.estimate) ?? best.o.delivery }
    });
  }
  return out;
}


export function refundDifference(order: { items: unknown; deliveryFee: number }, subs: PlanBSubstitute[], newDeliveryFee?: number): number {
  const items = ((order.items as unknown as BasketItem[]) ?? []).filter(Boolean);
  const oldSubtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const newSubtotal = items.reduce((s, i) => {
    const sub = subs.find((x) => x.fromSku === i.sku);
    return s + (sub ? sub.qty * sub.to.unitPrice : i.lineTotal);
  }, 0);
  const newPrices = items.map(i => {
    const sub = subs.find(s => s.fromSku === i.sku);
    return { unitPrice: sub?.to.unitPrice ?? i.unitPrice, qty: sub?.qty ?? i.qty };
  });
  const oldBase = oldSubtotal + serviceFeeForItems(items) + order.deliveryFee;
  const newBase = newSubtotal + serviceFeeForItems(newPrices) + (newDeliveryFee ?? order.deliveryFee);
  const diff = Math.round((oldBase - newBase) * 100) / 100;
  return Math.max(0, diff);
}

export type OfferOutcome = "offered" | "none" | "skip";

export async function offerPlanB(orderId: string, deps: { search?: SearchOptions } = {}, now = new Date()): Promise<OfferOutcome> {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "paid" || order.storeOrderNumber) return "skip";
  const blocked = blockedReasonOf(order.notes);
  if (!blocked) return "skip";
  const notes = order.notes ?? "";
  if (notes.includes(PLAN_B_OFFERED_PREFIX) || notes.includes(PLAN_B_NONE_PREFIX) || notes.includes(PLAN_B_ACCEPTED_PREFIX)) return "skip";

  const shortId = order.id.slice(-6).toUpperCase();
  const subs = order.cep ? await findSubstitutes({ items: order.items, cep: order.cep }, deps.search ?? searchOverride ?? defaultSearch) : null;
  if (!subs) {
    await prisma.deliveryOrder.update({
      where: { id: orderId },
      data: { notes: appendOrderNote(order.notes, `${PLAN_B_NONE_PREFIX} (${now.toISOString()}) — segue para o operador; estorno automático em ${process.env.LIA_AUTO_REFUND_BLOCKED_HOURS ?? 6}h.`) }
    });
    return "none";
  }

  const diff = refundDifference(order, subs);
  const text = copy.planBOffer(
    subs.map((s) => ({ fromStore: s.fromStore, from: s.fromName, to: s.to.name, store: s.to.storeLabel ?? s.to.storeKey ?? "outra loja", delivery: s.to.delivery })),
    diff
  );
  // Contexto da conversa: a resposta ("trocar"/"devolver") precisa achar a oferta.
  if (order.conversationId) {
    const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
    if (convo) {
      const ctx = readCtx(convo.context);
      const inFlight = (ctx.basket?.length ?? 0) > 0 && ctx.deliveryOrderId !== order.id;
      const next: DeliveryContext = { ...ctx, planB: { orderId: order.id, substitutes: subs, offeredAt: now.toISOString() } };
      if (!inFlight) next.step = "awaiting_plan_b";
      await writeCtx(convo.id, next);
    }
  }
  await prisma.deliveryOrder.update({
    where: { id: orderId },
    data: {
      notes: appendOrderNote(
        order.notes,
        `${PLAN_B_OFFERED_PREFIX} ${now.toISOString()}: ${subs.map((s) => `${s.fromName} → ${s.to.name} (${s.to.storeLabel ?? s.to.storeKey})`).join("; ")}${diff ? ` — devolve R$ ${diff.toFixed(2).replace(".", ",")} se aceitar` : ""}`
      )
    }
  });
  // Fora da janela de 24h não há botão: vai por template com instrução em texto.
  if (await outsideServiceWindow(order.phone)) {
    await deliverNotice(order.phone, `${text}\n\n${copy.planBTextFallback()}`, { items: order.items });
  } else {
    const sent = await whatsappAdapter.sendPlanBButtons(order.phone, text);
    if (!sent) await reply(order.phone, `${text}\n\n${copy.planBTextFallback()}`);
    else markTurnReplied();
  }
  await notifyOperator(copy.operatorPlanBOffered(shortId, subs.map((s) => `${s.fromName} → ${s.to.name} (${s.to.storeLabel ?? s.to.storeKey})`).join("; ")), order.phone);
  return "offered";
}

export type DecisionOutcome = "accepted" | "substitute_gone" | "refunded" | "stale";

// "Trocar": confirma o substituto AO VIVO de novo, troca os itens do pedido pago, devolve
// diferença a favor do cliente, limpa o bloqueio e manda o operador comprar.
export async function acceptPlanB(phone: string, ctx: DeliveryContext, convoId: string): Promise<DecisionOutcome> {
  const state = ctx.planB;
  if (!state) return "stale";
  const order = await prisma.deliveryOrder.findUnique({ where: { id: state.orderId } });
  if (!order || order.status !== "paid") {
    await clearPlanB(ctx, convoId);
    await reply(phone, copy.planBStale());
    return "stale";
  }
  const live = await checkCandidatesLive(
    state.substitutes.map((s) => ({ storeKey: s.to.storeKey ?? "", sku: s.to.sku, s })),
    order.cep,
    simulateOverride ?? undefined,
    simulateOverride ? liveCheckConfigured : liveCheckSupported
  );
  if (state.substitutes.some(s => !live.checks.has(`${s.to.storeKey}:${s.to.sku}`))) {
    await reply(phone, copy.planBNotVerified());
    return "stale";
  }
  const gone = state.substitutes.some((s) => {
    const check = live.checks.get(`${s.to.storeKey}:${s.to.sku}`);
    return check ? !check.available : false;
  });
  if (gone) {
    await clearPlanB(ctx, convoId);
    const { opsPurchaseFailedRefund } = await import("./ops-lifecycle");
    await opsPurchaseFailedRefund(order.id, "o substituto também esgotou", { origin: "auto", internalReason: "plano B: substituto esgotou na confirmação" });
    return "substitute_gone";
  }

  const items = ((order.items as unknown as BasketItem[]) ?? []).filter(Boolean);
  const newItems: BasketItem[] = items.map((i) => {
    const sub = state.substitutes.find((x) => x.fromSku === i.sku);
    if (!sub) return i;
    const unitPrice = sub.to.unitPrice;
    return {
      sku: sub.to.sku,
      name: sub.to.name,
      brand: sub.to.brand,
      qty: sub.qty,
      unitPrice,
      lineTotal: Math.round(unitPrice * sub.qty * 100) / 100,
      storeKey: sub.to.storeKey ?? i.storeKey,
      storeLabel: sub.to.storeLabel ?? i.storeLabel,
      productUrl: sub.to.productUrl,
      freeShipping: sub.to.freeShipping
    };
  });
  const newSubtotal = Math.round(newItems.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
  const diff = refundDifference(order, state.substitutes);
  const stores = [...new Set(newItems.map((i) => i.storeKey))];
  const storeFields = stores.length === 1 ? { storeKey: stores[0], storeLabel: newItems[0].storeLabel } : {};
  const cleanedNotes = (order.notes ?? "")
    .split("\n")
    .filter((line) => !line.startsWith(PURCHASE_BLOCKED_PREFIX))
    .join("\n");
  const now = new Date();
  let refundNote = "";
  if (diff > 0) {
    try {
      const result = await refundOrderViaProvider(order.id, diff);
      refundNote = ` Diferença devolvida: R$ ${diff.toFixed(2).replace(".", ",")} (${result.reference}).`;
    } catch (error) {
      refundNote = ` ⚠️ Diferença de R$ ${diff.toFixed(2).replace(".", ",")} NÃO devolvida (${error instanceof Error ? error.message.slice(0, 120) : "erro"}) — estornar parcial à mão.`;
    }
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.deliveryOrder.findUniqueOrThrow({where:{id:order.id}});
    if(current.status!=="paid" || current.storeOrderNumber || JSON.stringify(current.items)!==JSON.stringify(order.items)) throw new Error("Pedido mudou antes da troca; confira a operação.");
    if(await tx.purchaseJob.findFirst({where:{deliveryOrderId:order.id,status:{in:["submitting","outcome_unknown"]},submissionId:{not:null}}})) throw new Error("Compra em conferência na loja; não substituir agora.");
    await tx.deliveryOrder.update({
    where: { id: order.id },
    data: {
      items: newItems as unknown as object,
      itemsSubtotal: newSubtotal,
      serviceFee: serviceFeeForItems(newItems),
      ...storeFields,
      notes: appendOrderNote(
        cleanedNotes,
        `${PLAN_B_ACCEPTED_PREFIX} ${now.toISOString()}: ${state.substitutes.map((s) => `${s.fromName} → ${s.to.name} (${s.to.storeLabel ?? s.to.storeKey})${s.to.productUrl ? ` ${s.to.productUrl}` : ""}`).join("; ")}. Bloqueio anterior: ${blockedReasonOf(order.notes) ?? "-"}.${refundNote}`
      )
    }
  });
  });
  await clearPlanB(ctx, convoId);
  try {
    const { ensurePurchaseJobForPaidOrder } = await import("./purchase-worker");
    await ensurePurchaseJobForPaidOrder(order.id);
  } catch (error) {
    console.warn("[plan-b:enqueue-failed]", error instanceof Error ? error.message : error);
  }
  const first = state.substitutes[0];
  await reply(phone, copy.planBAccepted(state.substitutes.map((s) => s.to.name), first.to.storeLabel ?? first.to.storeKey ?? "a loja", first.to.delivery, diff > 0 && !refundNote.includes("NÃO") ? diff : undefined));
  await notifyOperator(
    copy.operatorPlanBAccepted(order.id.slice(-6).toUpperCase(), state.substitutes.map((s) => `${s.qty}x ${s.to.name} — ${s.to.storeLabel ?? s.to.storeKey}${s.to.productUrl ? ` ${s.to.productUrl}` : ""}`).join("; ")),
    phone
  );
  return "accepted";
}

export async function declinePlanB(phone: string, ctx: DeliveryContext, convoId: string): Promise<DecisionOutcome> {
  const state = ctx.planB;
  if (!state) return "stale";
  await clearPlanB(ctx, convoId);
  const order = await prisma.deliveryOrder.findUnique({ where: { id: state.orderId } });
  if (!order || order.status !== "paid") {
    await reply(phone, copy.planBStale());
    return "stale";
  }
  const { opsPurchaseFailedRefund, customerReasonFromBlock } = await import("./ops-lifecycle");
  const blocked = blockedReasonOf(order.notes);
  await opsPurchaseFailedRefund(order.id, blocked ? customerReasonFromBlock(blocked) : "a loja não confirmou a compra", {
    origin: "auto",
    internalReason: `plano B recusado pelo cliente (bloqueio: ${blocked ?? "-"})`
  });
  return "refunded";
}

async function clearPlanB(ctx: DeliveryContext, convoId: string) {
  ctx.planB = undefined;
  if (ctx.step === "awaiting_plan_b") ctx.step = "collecting";
  await writeCtx(convoId, ctx);
}

