import { recordDeliveryEvent } from "./delivery-events";
// Ciclo de vida operado pelo /ops (revisão 02/09): cotação manual, comprado, saiu,
// entregue, cancelar/estornar, fila e lista de espera.
import { whatsappAdapter } from "@/lib/adapters/whatsapp";
import { normalizeCity } from "@/lib/coverage";
import { normalizeMsg } from "@/lib/lia-intents";
import { AWAITING_OPERATOR_QUOTE_STATUS, CONCIERGE_STORE_KEY, CONCIERGE_STORE_LABEL, OPS_QUEUE_STATUSES, PAID_OR_IN_FULFILLMENT_STATUSES, REFUND_CONFIRMED_PREFIX, REFUND_PENDING_FLAG, appendOrderNote } from "@/lib/order-flags";
import { refundOrderViaProvider } from "@/lib/payments/ledger";
import { pricingMode, serviceFeeForSubtotal, serviceLineForItems } from "@/lib/pricing";
import { medicineEnabled } from "@/lib/medicine";
import { prisma } from "@/lib/prisma";
import * as copy from "@/lib/lia-copy";
import { PURCHASE_BLOCKED_PREFIX } from "@/lib/order-monitor";
import { BasketItem, FreightChoiceState, basketTriedKey, cardTotal, display, orderDateLabel, quoteTtlMinutes, roundMoney } from "./conversation-types";
import { TurnSupersededError, addressOnlyCtx, orderFactsCtx, deliverNotice, markTurnReplied, normalizePhone, notifyOperator, readCtx, reply, resetConversationForClosedOrder, writeCtx, notifyOwner, operatorIsHired } from "./turn-runtime";
import { deadlineFit, humanEstimate, promiseMissesDeadline } from "./live-freight";
import { leftOutForSummary } from "./list-misses";
import { PLAN_B_ACCEPTED_PREFIX, PLAN_B_NONE_PREFIX, PLAN_B_OFFERED_PREFIX, blockedReasonOf, planBMarkerAt } from "./plan-b";
import { issueValidatedRetailerQuotePayment } from "./order-payments";
import { buildStoreFulfillments, isMultiStoreOrder, perStoreQuoteReady, STORE_SHARE_REFUNDED, type SplitItem } from "./purchase/store-split";

// Prazo dito × as duas formas de entrega (10/10, rodada 10 g29). `null` = nenhuma tem prazo legível.
export function freightDeadlineFits(choice: FreightChoiceState, neededBy: { date: string; morning?: boolean }): [copy.DeadlineFit | null, copy.DeadlineFit | null] | null {
  const kind = choice.kind ?? "ml";
  const label = (estimate?: string) => (kind === "store" ? humanEstimate(estimate) : estimate);
  const fits: [copy.DeadlineFit | null, copy.DeadlineFit | null] = [deadlineFit(label(choice.barato.estimate), neededBy), deadlineFit(label(choice.rapido.estimate), neededBy)];
  return fits[0] || fits[1] ? fits : null;
}

export async function sendFreightChoice(phone: string, choice: FreightChoiceState, neededBy?: { date: string; label: string; morning?: boolean }) {
  const totalFor = (fee: number) =>
    roundMoney(choice.itemsSubtotal + (choice.serviceFee ?? serviceFeeForSubtotal(choice.itemsSubtotal)) + fee);
  // Loja: o SLA cru ("60m") vira "prazo da loja: 60 min" no texto e "60 min" no botão.
  const kind = choice.kind ?? "ml";
  const label = (estimate?: string) => (kind === "store" ? humanEstimate(estimate) : estimate);
  const short = (estimate?: string) => (kind === "store" ? humanEstimate(estimate)?.replace(/^prazo da loja: /, "") : estimate);
  const barato = { total: totalFor(choice.barato.fee), estimate: label(choice.barato.estimate) };
  const rapido = { total: totalFor(choice.rapido.fee), estimate: label(choice.rapido.estimate) };
  const fits = neededBy ? freightDeadlineFits(choice, neededBy) : null;
  const body = copy.shippingSpeedChoice(barato, rapido, kind, choice.budgetCap, fits && neededBy ? { label: neededBy.label, morning: neededBy.morning, fits } : undefined);
  try {
    markTurnReplied();
    const interactive = await whatsappAdapter.sendShippingChoices(phone, body, { estimate: short(choice.barato.estimate) }, { estimate: short(choice.rapido.estimate) });
    if (interactive) return;
  } catch (error) {
    console.warn("[whatsapp:shipping-choice:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, body);
}

// Estorno pelo provedor (revisão 02/09): o operador não precisa mais ir ao painel do MP/
// Pagar.me e voltar com a referência — a API estorna e a referência entra sozinha.
// Continua exigindo o pedido em `refund_pending` (o operador abriu o estorno de propósito).
export async function opsRefundViaProvider(orderId: string, amount?: number) {
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!current) throw new Error("Order not found");
  if (current.status !== "refund_pending") throw new Error("O pedido não está aguardando estorno.");
  const result = await refundOrderViaProvider(orderId, amount);
  return opsConfirmRefund(orderId, result.reference, result.amount);
}

// O operador publica a cotação feita à mão no /ops: grava custo real dos produtos +
// frete + modalidade, move o pedido para awaiting_quote_confirmation e manda ao cliente
// o resumo com os botões de pagamento — a cobrança em si é issueValidatedRetailerQuotePayment.
export async function opsPublishManualQuote(
  orderId: string,
  input: {
    itemsSubtotal: number;
    deliveryFee: number;
    deliveryMode?: "operator_courier" | "retailer_delivery";
    deliveryPromise?: string;
    etaMinutes?: number;
    // Margem exata por item (cotação instantânea). Ausente = cotação manual do /ops,
    // onde só existe o subtotal — as faixas progressivas valem sobre ele inteiro.
    serviceFee?: number;
    items?: { qty: number; name: string; unitPrice?: number }[];
    // Cesta de várias lojas (09/10): frete e prazo de CADA loja. Vira uma entrada por loja em
    // `fulfillments`, com a parte do cliente — é o que a compra e a devolução de cada loja usam.
    perStore?: Array<{ storeKey: string; storeLabel: string; fee: number; promise?: string }>;
  }
) {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Order not found");
  if (order.status !== AWAITING_OPERATOR_QUOTE_STATUS) {
    throw new Error("Só é possível cotar um pedido que está aguardando cotação do operador.");
  }
  const itemsSubtotal = roundMoney(Math.max(0, Number(input.itemsSubtotal) || 0));
  const deliveryFee = roundMoney(Math.max(0, Number(input.deliveryFee) || 0));
  if (itemsSubtotal <= 0) throw new Error("Informe o custo dos produtos (maior que zero).");
  const serviceFee = input.serviceFee != null ? roundMoney(input.serviceFee) : serviceFeeForSubtotal(itemsSubtotal);
  // "produtos" shown to the customer already includes the markup.
  const produtos = roundMoney(itemsSubtotal + serviceFee);
  const total = roundMoney(produtos + deliveryFee);
  // Só entrega do varejista (revisão 02/09): o motoboy da base do operador saiu do
  // produto em 09/08 e do código agora.
  const deliveryMode = "retailer_delivery" as const;
  const sameHour = false;
  const courierKey = "retailer_delivery";

  const items: BasketItem[] = input.items?.length
    ? input.items.map((entry) => {
        const qty = Math.max(1, Math.round(Number(entry.qty) || 1));
        const unitPrice = Math.max(0, Number(entry.unitPrice) || 0);
        return {
          sku: `concierge:${normalizeMsg(entry.name)}`,
          name: entry.name,
          qty,
          unitPrice,
          lineTotal: roundMoney(unitPrice * qty),
          storeKey: CONCIERGE_STORE_KEY,
          storeLabel: CONCIERGE_STORE_LABEL
        };
      })
    : ((order.items as unknown as BasketItem[]) ?? []);
  // Linha "Taxa de serviço da Lia" (08/10, modelo service_fee: a margem inteira, produtos pelo
  // preço da loja; modelo markup: só a taxa do remédio isento, como em 29/09). O total não muda.
  const medicineFee = input.serviceFee != null
    ? roundMoney(Math.min(serviceFee, serviceLineForItems(items)))
    : pricingMode() === "service_fee" ? serviceFee : 0;

  const quoteExpiresAt = new Date(Date.now() + quoteTtlMinutes() * 60_000);
  const fulfillment = {
    storeKey: order.storeKey,
    storeLabel: order.storeLabel,
    deliveryMode,
    deliveryPromise: input.deliveryPromise,
    deliveryFee,
    retailerTotal: produtos,
    etaMinutes: input.etaMinutes
  };
  const perStoreStores = new Set(items.map((i) => i.storeKey));
  const perStore =
    input.perStore && input.perStore.length > 1 &&
    input.perStore.every((s) => perStoreStores.has(s.storeKey)) && perStoreStores.size === input.perStore.length &&
    Math.abs(input.perStore.reduce((sum, s) => sum + s.fee, 0) - deliveryFee) < 0.01
      ? buildStoreFulfillments(items as SplitItem[], input.perStore, total)
      : null;
  // Flip ATÔMICO: a condição de status vai no próprio UPDATE. Sem isso, um cancelamento
  // concorrente (cliente mandando "cancelar", ou a expiração de abandono) era
  // sobrescrito e o pedido "ressuscitava" indo pedir pagamento.
  const claimed = await prisma.deliveryOrder.updateMany({
    where: { id: order.id, status: AWAITING_OPERATOR_QUOTE_STATUS },
    data: {
      status: "awaiting_quote_confirmation",
      items: items as unknown as object,
      fulfillments: (perStore ?? [fulfillment]) as unknown as object,
      itemsSubtotal,
      serviceFee,
      deliveryFee,
      total,
      courierKey,
      quoteExpiresAt,
      notes: appendOrderNote(order.notes, `Cotação manual enviada (${sameHour ? "motoboy na hora" : "entrega do varejista"}).`)
    }
  });
  if (!claimed.count) {
    throw new Error("O pedido mudou de estado antes da cotação sair (cancelado ou já cotado). Recarregue o /ops.");
  }

  // Se a conversa JÁ seguiu em frente (outro pedido/outra cesta), o contexto novo vale
  // mais: a cotação sai rotulada com o pedido a que pertence e NADA é sobrescrito —
  // sem isso, uma cotação atrasada apagava a compra em andamento e despejava o resumo
  // de outra sessão no meio do papo (27/08 S19, resumo do PS5 na sessão do arroz).
  let conversationMovedOn = false;
  let neededBy: { date: string; label: string; morning?: boolean } | undefined;
  let orderBudget: { cap: number } | undefined;
  let joinRuledOut = false;
  let joinSlower: { eta: string; saving: number } | undefined;
  let leftOut: string[] = [];
  if (order.conversationId) {
    const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
    if (convo) {
      const ctx = readCtx(convo.context);
      neededBy = ctx.neededBy;
      orderBudget = ctx.orderBudget;
      // Juntar já descartado para ESTA cesta (10/10, rodada 14 g41): o fechamento tentou e não juntou (ou o cliente pediu e a
      // Lia disse que não dá) — o resumo não oferece juntar de novo.
      const signature = basketTriedKey(items);
      joinSlower = ctx.joinSlower?.key === signature ? { eta: ctx.joinSlower.eta, saving: ctx.joinSlower.saving } : undefined;
      joinRuledOut = !joinSlower && (ctx.joinRuledOut === signature || ctx.consolidationTried === signature);
      // O que o cliente pediu e ficou sem produto entra no resumo (10/10, rodada 7 A4) — lido antes do reset abaixo.
      leftOut = leftOutForSummary(ctx, items);
      conversationMovedOn =
        (Boolean(ctx.deliveryOrderId) && ctx.deliveryOrderId !== order.id) ||
        ((ctx.basket?.length ?? 0) > 0 && ctx.deliveryOrderId !== order.id) ||
        ((ctx.pending?.length ?? 0) > 0 && ctx.deliveryOrderId !== order.id);
      if (!conversationMovedOn) {
        try {
          await writeCtx(convo.id, {
            ...addressOnlyCtx(ctx),
            deliveryOrderId: order.id,
            step: "awaiting_quote_confirmation",
            // "mais barato"/"entrega mais rápida" DEPOIS do total dependem dos dois
            // (27/08 S12/S14).
            ...(ctx.freightChoice?.orderId === order.id ? { freightChoice: ctx.freightChoice } : {}),
            // "mais barato" depois do total, prazo, orçamento, faltantes, item tirado e recusa do ensaio: a recotação e o
            // "tira o gelo" depois do total continuam sabendo (rodadas 5, 8, 9; ponto único na rodada 10 g30).
            ...orderFactsCtx(ctx)
          });
        } catch (error) {
          // Turno superado no meio da publicação: o pedido volta pra fila e o turno
          // morre SEM falar — quem escreveu por baixo é o dono da conversa agora.
          if (error instanceof TurnSupersededError) {
            await prisma.deliveryOrder.updateMany({
              where: { id: order.id, status: "awaiting_quote_confirmation" },
              data: {
                status: AWAITING_OPERATOR_QUOTE_STATUS,
                quoteExpiresAt: null,
                notes: appendOrderNote(order.notes, "⚠️ Cotação revertida: a conversa avançou durante a publicação. Cote de novo pelo /ops.")
              }
            });
          }
          throw error;
        }
      }
    }
  }

  const summaryInput = {
    // Preço por linha SEMPRE que a margem exata por item existe: sem ele, o cliente
    // somava os preços de mensagens antigas e achava o subtotal "errado" (27/08 S1).
    items: items.map((item) => ({
      qty: item.qty,
      name: item.name,
      ...(input.serviceFee != null && item.unitPrice > 0
        ? { lineTotal: roundMoney(display(item.unitPrice, item.medicine) * item.qty) }
        : {})
    })),
    produtos: roundMoney(produtos - medicineFee),
    ...(medicineFee > 0 ? { serviceLine: medicineFee } : {}),
    frete: deliveryFee,
    deliveryPromise: input.deliveryPromise,
    etaMinutes: input.etaMinutes,
    total,
    deliveryAddress: order.deliveryAddress ?? undefined,
    sameHour,
    ...(neededBy && promiseMissesDeadline(input.deliveryPromise, neededBy.date) ? { deadlineMiss: { label: neededBy.label } } : {}),
    // Prazo dito e cumprido (10/10, rodada 10 g29): o resumo diz que serve.
    ...(() => {
      const fit = neededBy && !conversationMovedOn ? deadlineFit(input.deliveryPromise, neededBy) : null;
      return neededBy && (fit === "ok" || fit === "unsure") ? { deadlineFit: { label: neededBy.label, morning: neededBy.morning, fit } } : {};
    })(),
    ...(orderBudget && total <= orderBudget.cap + 0.005 && !conversationMovedOn ? { withinBudget: { cap: orderBudget.cap } } : {}),
    deliveries: new Set(items.map((item) => item.storeKey).filter(Boolean)).size,
    // Passou do orçamento dito na conversa (10/10, rodada 8 M3: R$ 112,55 com "se passar de 100 me avisa", sem aviso).
    ...(orderBudget && total > orderBudget.cap + 0.005 && !conversationMovedOn ? { overBudget: overBudgetSummaryInput(orderBudget.cap, items, input.serviceFee != null) } : {}),
    ...(leftOut.length && !conversationMovedOn ? { leftOut } : {}),
    ...(joinRuledOut && !conversationMovedOn ? { joinRuledOut: true } : {}),
    ...(joinSlower && !conversationMovedOn ? { joinSlower } : {})
  };
  // O pedido JÁ saiu de "aguardando cotação". Se o RESUMO (a peça essencial) falhar, o
  // cliente fica sem total nenhum e o operador sem poder recotar → rollback pra fila.
  // Depois que o resumo saiu, NÃO se faz rollback: menu e aviso de validade são
  // acessórios ("pix"/"cartão" por texto funcionam), e reverter aqui desalinharia
  // pedido e conversa — o cliente pode já ter tocado num botão e o pedido avançado.
  try {
    // Conversa em outro assunto: o resumo chega ROTULADO com o pedido a que pertence,
    // pra nunca parecer a cesta da compra atual (27/08 S19).
    if (conversationMovedOn) {
      await reply(
        order.phone,
        copy.quoteForOrderLabel(order.id.slice(-6).toUpperCase(), orderDateLabel(order.createdAt))
      );
    }
    // Resumo com botão "Trocar endereço" (dono, 11/08). Corpo interativo tem teto de 1024
    // chars na Meta — resumo comprido (ou canal sem botão) cai no texto com a dica escrita.
    let summarySent = false;
    const buttonBody = copy.manualQuoteSummary({ ...summaryInput, addressButton: true });
    if (summaryInput.deliveryAddress && buttonBody.length <= 1024) {
      try {
        // Envio direto pelo adapter (fora do reply()) também é resposta do turno: sem a
        // marca, a rede anti-silêncio mandava "Me perdi aqui 😅" logo depois do total
        // (05/10, toque em "cartão" que publicou a cotação).
        markTurnReplied();
        summarySent = Boolean(await whatsappAdapter.sendQuoteSummary(order.phone, buttonBody));
      } catch (error) {
        console.warn("[whatsapp:quote-summary:fallback-text]", error instanceof Error ? error.message : error);
      }
    }
    if (!summarySent) await reply(order.phone, copy.manualQuoteSummary(summaryInput));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[ops:publish-quote:send-failed]", detail);
    const rolled = await prisma.deliveryOrder.updateMany({
      where: { id: order.id, status: "awaiting_quote_confirmation" },
      data: {
        status: AWAITING_OPERATOR_QUOTE_STATUS,
        quoteExpiresAt: null,
        notes: appendOrderNote(order.notes, `⚠️ Cotação revertida: falha ao enviar no WhatsApp (${detail.slice(0, 120)}). Tente cotar de novo.`)
      }
    });
    // A conversa só volta pra "aguardando cotação" se o PEDIDO de fato voltou — se ele
    // já avançou (corrida com um toque de pagamento), reescrever o contexto aqui
    // desalinharia os dois.
    if (rolled.count && order.conversationId) {
      const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
      if (convo) {
        const ctx = readCtx(convo.context);
        await writeCtx(convo.id, { ...addressOnlyCtx(ctx), ...orderFactsCtx(ctx), deliveryOrderId: order.id, step: AWAITING_OPERATOR_QUOTE_STATUS });
      }
    }
    throw error;
  }
  try {
    // Remédio isento: botões comuns Pix/Cartão valem (05/10, dono); o que a Meta veta é o
    // pagamento NATIVO do WhatsApp, que segue fora para remédio (order-payments/whatsapp-pay).
    const interactive = await whatsappAdapter.sendPaymentChoices(order.phone, total, cardTotal(total));
    if (!interactive) await reply(order.phone, copy.paymentMethod(total, cardTotal(total)));
  } catch (error) {
    // Resumo já chegou: o cliente tem o total e "pix"/"cartão" por texto funcionam.
    console.warn("[ops:publish-quote:followup-send-failed]", error instanceof Error ? error.message : error);
  }
  return prisma.deliveryOrder.findUnique({ where: { id: order.id } });
}

// `paidTotal` (financeiro, 23/09): quanto saiu de verdade na loja, produtos + frete, lido
// do comprovante na hora da compra. Opcional — sem ele o P&L usa a cotação como estimativa
// e marca o pedido como "custo estimado" até alguém registrar.
export async function opsMarkBought(orderId: string, storeOrderNumber: string, trackingUrl?: string, paidTotal?: number | null) {
  const order = await recordDeliveryEvent(orderId, {
    kind: "bought", source: "operator", sourceReference: "Compra confirmada no /ops",
    storeOrderNumber, trackingUrl
  });
  if (paidTotal != null) return opsSetStoreCost(orderId, paidTotal);
  return order;
}

// Custo real na loja, registrado ou corrigido depois da compra (pelo operador no card ou
// pelo dono no /ops/financeiro). Só vale em pedido que já tem compra — antes disso não
// existe comprovante — e nunca aceita valor negativo. Fica na nota para auditoria.
export async function opsSetStoreCost(orderId: string, paidTotal: number) {
  const amount = roundMoney(Number(paidTotal));
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Valor pago na loja inválido (ex.: 87,90).");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    const purchased = Boolean(order.storeOrderNumber) || ["retailer_preparing", "retailer_out_for_delivery", "delivered", "operator_buying", "ready_for_pickup", "dispatched"].includes(order.status);
    if (!purchased) throw new Error("Registre o custo real depois de confirmar a compra na loja.");
    if (order.storePaidTotal != null && Math.abs(order.storePaidTotal - amount) < 0.005) return order;
    return tx.deliveryOrder.update({
      where: { id: orderId },
      data: {
        storePaidTotal: amount,
        notes: appendOrderNote(order.notes, `💰 Custo real na loja: R$ ${amount.toFixed(2).replace(".", ",")}${order.storePaidTotal != null ? ` (antes R$ ${order.storePaidTotal.toFixed(2).replace(".", ",")})` : ""} (${new Date().toISOString()}).`)
      }
    });
  });
}

export async function opsMarkRetailerOutForDelivery(orderId: string, trackingUrl?: string) {
  return recordDeliveryEvent(orderId, {
    kind: "out_for_delivery", source: "operator", sourceReference: "Saída confirmada no /ops", trackingUrl
  });
}

export async function opsMarkDelivered(orderId: string) {
  return recordDeliveryEvent(orderId, {
    kind: "delivered", source: "operator", sourceReference: "Entrega confirmada no /ops"
  });
}

export async function opsCancelRefund(orderId: string) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const current = await tx.deliveryOrder.findUniqueOrThrow({where:{id:orderId}});
    if (["refund_pending", "refunded", "canceled"].includes(current.status)) return {order:current,changed:false};
    const uncertain = await tx.purchaseJob.findFirst({where:{deliveryOrderId:orderId,submissionId:{not:null},status:{in:["submitting","outcome_unknown"]}}});
    if(uncertain) throw new Error("Confira o resultado da compra na loja antes de cancelar ou estornar.");
    const paid = Boolean(current.paidAt) || PAID_OR_IN_FULFILLMENT_STATUSES.includes(current.status);
    const updated = await tx.deliveryOrder.update({where:{id:orderId},data:paid ? {status:"refund_pending",notes:appendOrderNote(appendOrderNote(current.notes,REFUND_PENDING_FLAG),`🧾 Estorno solicitado pelo operador em ${new Date().toISOString()}.`)} : {status:"canceled",notes:appendOrderNote(current.notes,`🧾 Pedido cancelado sem pagamento em ${new Date().toISOString()}.`)}});
    // Carrinho aberto continua reservando a conta até conferência, mesmo após cancelar.
    await tx.purchaseJob.updateMany({where:{deliveryOrderId:orderId,status:{in:["claimed","awaiting_approval","approved"]},lockedAt:{not:null}},data:{status:"needs_review",lastErrorCode:"ORDER_CANCELED",lastErrorMessage:"Pedido cancelado; confira e esvazie o carrinho antes de liberar a conta."}});
    await tx.purchaseJob.updateMany({where:{deliveryOrderId:orderId,status:{in:["queued","retrying","preflight_queued","preflighting","cart_ready","awaiting_approval","approved"]},lockedAt:null},data:{status:"canceled",nextAttemptAt:null}});
    return {order:updated,changed:true};
  });
  const order=result.order;
  if(!result.changed)return order;
  const paymentReceived = Boolean(order.paidAt) || order.status === "refund_pending";
  // O pedido fechou: a conversa não pode continuar presa nele (revisão 18/08 — cliente
  // ouvia "ainda estou cotando" de pedido cancelado e, em `choosing_freight`, o botão de
  // frete não tinha saída).
  await resetConversationForClosedOrder(order, paymentReceived ? "refund" : "cancel");
  await reply(order.phone, paymentReceived ? copy.refundRequested() : copy.canceledUnpaid());
  return order;
}

export async function opsConfirmRefund(orderId: string, reference: string, amount?: number) {
  const safeReference = reference.replace(/[\r\n]/g, " ").trim().slice(0, 120);
  if (!safeReference) throw new Error("Informe a referência do estorno para auditoria.");
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!current) throw new Error("Order not found");
  if (current.status !== "refund_pending") throw new Error("O pedido não está aguardando estorno.");
  const refundAmount = amount == null ? current.total : roundMoney(Number(amount));
  if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount > current.total + 0.01) {
    throw new Error("O valor do estorno deve ser maior que zero e não pode ultrapassar o total pago.");
  }
  const amountLabel = Math.abs(refundAmount - current.total) <= 0.01 ? "integral" : `parcial R$ ${refundAmount.toFixed(2).replace(".", ",")}`;
  const notesWithoutPending = (current.notes ?? "")
    .split("\n")
    .filter((line) => line !== REFUND_PENDING_FLAG)
    .join("\n");
  const order = await prisma.deliveryOrder.update({
    where: { id: orderId },
    data: {
      status: "refunded",
      notes: appendOrderNote(
        notesWithoutPending,
        `${REFUND_CONFIRMED_PREFIX} ${amountLabel} — ${safeReference}`
      )
    }
  });
  await reply(order.phone, copy.refundConfirmed());
  return order;
}

// Free-text note from the operator to the customer (out-of-stock, item refund,
// delay…) — sent as Lia, logged in the conversation. Substitutions are disabled.
export async function opsNotifyCustomer(orderId: string, text: string) {
  const message = (text ?? "").trim();
  if (!message) throw new Error("Empty message");
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Order not found");
  await reply(order.phone, message);
  if (order.conversationId) {
    try {
      await prisma.message.create({
        data: { conversationId: order.conversationId, sender: "operator", text: message }
      });
    } catch (error) {
      console.warn("[ops:notify:log]", error instanceof Error ? error.message : error);
    }
  }
  return order;
}

// Ordem da fila (04/09): o pedido do amigo do dono, pago e travado, estava no FIM da
// página atrás de cotações abandonadas de teste ("não tá lá esse pedido"). Agora quem
// precisa de ação humana vem primeiro e, dentro do grupo, o mais novo em cima.
const OPS_QUEUE_PRIORITY: Record<string, number> = {
  refund_pending: 0,
  paid: 1,
  awaiting_operator_quote: 2,
  operator_buying: 3,
  retailer_preparing: 4,
  ready_for_pickup: 4,
  retailer_out_for_delivery: 5,
  dispatched: 5,
  awaiting_quote_confirmation: 6,
  awaiting_payment: 6
};

export async function getOperatorQueue() {
  const orders = await prisma.deliveryOrder.findMany({
    where: { OR: [{ status: { in: OPS_QUEUE_STATUSES } }, { events: { some: { deliveryStatus: { in: ["pending", "unknown", "failed"] } } } }] },
    orderBy: { createdAt: "desc" },
    include: {
      purchaseJobs: { include: { items: true }, orderBy: { createdAt: "asc" } },
      events: { orderBy: { occurredAt: "desc" }, take: 5 },
      acquisitionTouch: { select: { source: true, campaignCode: true, sourceType: true, sourceId: true, headline: true } }
    }
  });
  return orders.sort((a, b) => (OPS_QUEUE_PRIORITY[a.status] ?? 9) - (OPS_QUEUE_PRIORITY[b.status] ?? 9) || b.createdAt.getTime() - a.createdAt.getTime());
}

// Someone asked from outside the delivery area. Deduped by (phone, cep); repeats bump
// `hits` so the /ops demand map reflects real intensity. Never throws into the chat flow.
export async function recordWaitlistLead(input: {
  phone: string;
  cep: string;
  city?: string;
  uf?: string;
  reason?: "outside_coverage" | "too_far" | "fee_too_high";
}) {
  const phone = normalizePhone(input.phone);
  const reason = input.reason ?? "outside_coverage";
  try {
    await prisma.waitlistLead.upsert({
      where: { phone_cep: { phone, cep: input.cep } },
      create: { phone, cep: input.cep, city: input.city ?? null, uf: input.uf ?? null, reason },
      update: { hits: { increment: 1 }, city: input.city ?? undefined, uf: input.uf ?? undefined, reason }
    });
  } catch (err) {
    console.error("[waitlist] failed to record lead", err);
  }
}

// Demand map for /ops: leads grouped by city (most-wanted first) + the latest raw entries.
export async function getWaitlist() {
  const leads = await prisma.waitlistLead.findMany({ orderBy: { updatedAt: "desc" }, take: 300 });
  const byRegion = new Map<string, { city: string; uf?: string; leads: number; hits: number; lastAt: Date }>();
  for (const l of leads) {
    const key = `${normalizeCity(l.city ?? "")}|${l.uf ?? ""}`;
    const cur = byRegion.get(key);
    if (cur) {
      cur.leads += 1;
      cur.hits += l.hits;
      if (l.updatedAt > cur.lastAt) cur.lastAt = l.updatedAt;
    } else {
      byRegion.set(key, { city: l.city ?? "—", uf: l.uf ?? undefined, leads: 1, hits: l.hits, lastAt: l.updatedAt });
    }
  }
  const regions = [...byRegion.values()].sort((a, b) => b.leads - a.leads || b.hits - a.hits);
  return { total: leads.length, regions, recent: leads.slice(0, 40) };
}

// ---- pedido PAGO sem compra (revisão 02/09) ----
// O cliente pagou e ninguém comprou: ou o operador ainda não agiu, ou a compra foi
// bloqueada (sem estoque / sem entrega no CEP / mínimo da loja) e a nota "🛑 COMPRA
// BLOQUEADA" ficou só no /ops. Chamado pelo cron a cada 10 min; idempotente por marcador.
// Primeiro lembrete em 30 min (04/09: "chega rápido" não combina com 2h de silêncio).
const STUCK_BUCKETS_MIN = [30, 120, 360, 720, 1440, 2880, 4320];
function bucketLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}min` : `${Math.round(minutes / 60)}h`;
}

// ---- estorno AUTOMÁTICO (decisão do dono, 04/09) ----
// "Nunca é pra não dar certo, mas às vezes não vai, e aí tem que ir sem mim e sem /ops."
// Pedido PAGO sem número de compra na loja: (a) com "🛑 COMPRA BLOQUEADA" há
// LIA_AUTO_REFUND_BLOCKED_HOURS (6) → estorna sozinho; (b) sem bloqueio mas sem compra há
// LIA_AUTO_REFUND_STALE_HOURS (24) → idem. Só status `paid`: pedido que o operador moveu
// para "comprando"/"preparando" nunca é tocado. Kill-switch: LIA_AUTO_REFUND_OFF=true.
// Puro (testável); o efeito fica em watchPaidOrder, que o cron chama a cada 10 min.
export type AutoRefundDecision =
  | { refund: false }
  | { refund: true; kind: "blocked" | "stale"; reason: string; customerReason: string };

function autoRefundBlockedHours(): number {
  return Number(process.env.LIA_AUTO_REFUND_BLOCKED_HOURS ?? 6);
}
function autoRefundSince(): number {
  const parsed = Date.parse(process.env.LIA_AUTO_REFUND_SINCE ?? "2026-09-04T12:00:00Z");
  return Number.isFinite(parsed) ? parsed : Date.parse("2026-09-04T12:00:00Z");
}
// Dono (06/10): pago e sem compra na loja por 6h → estorna sozinho e avisa o cliente, sem
// esperar humano (era 24h). Pedido com compra enviada e resultado desconhecido NÃO entra:
// opsPurchaseFailedRefund recusa e o dono reconcilia.
function autoRefundStaleHours(): number {
  return Number(process.env.LIA_AUTO_REFUND_STALE_HOURS ?? 6);
}
// Fila manual: era 48h (11/09, humano comprando quando pudesse). Desde 06/10 a vitrine só
// tem loja automática, então a fila manual é exceção e segue o mesmo prazo de 6h.
function autoRefundManualHours(): number {
  return Number(process.env.LIA_AUTO_REFUND_MANUAL_HOURS ?? 6);
}

// O bloqueio é escrito em jargão de operação; o cliente recebe uma frase simples.
export function customerReasonFromBlock(block: string): string {
  const b = block.toLowerCase();
  if (/estoque|indispon|esgot/.test(b)) return "a loja ficou sem o item para o seu endereço";
  if (/entrega|cep|frete|m[ií]nimo/.test(b)) return "a loja não entrega esse pedido no seu endereço";
  if (/pre[çc]o|acima|teto|maximum|mais caro/.test(b)) return "o preço na loja subiu acima do combinado";
  return "a loja não confirmou a compra";
}

export function autoRefundDecision(
  input: { status: string; storeOrderNumber?: string | null; paidAt?: Date | null; notes?: string | null; manualQueue?: boolean },
  now = new Date()
): AutoRefundDecision {
  if (process.env.LIA_AUTO_REFUND_OFF === "true") return { refund: false };
  if (input.status !== "paid" || input.storeOrderNumber || !input.paidAt) return { refund: false };
  // Só pedidos pagos DEPOIS da regra existir: em 04/09 havia 15 pedidos `paid` de
  // junho–agosto (testes/sandbox e pendências antigas) que o cron estornaria em bloco.
  if (input.paidAt.getTime() < autoRefundSince()) return { refund: false };
  // Relógio: reinicia quando o plano B é oferecido (o cliente precisa de tempo para
  // responder) e quando é aceito (a compra do substituto recomeça do zero).
  const clockStart = Math.max(
    input.paidAt.getTime(),
    planBMarkerAt(input.notes, PLAN_B_OFFERED_PREFIX)?.getTime() ?? 0,
    planBMarkerAt(input.notes, PLAN_B_ACCEPTED_PREFIX)?.getTime() ?? 0
  );
  const hours = (now.getTime() - clockStart) / 3_600_000;
  const blocked = blockedReasonOf(input.notes);
  if (blocked && hours >= autoRefundBlockedHours()) {
    return { refund: true, kind: "blocked", reason: blocked, customerReason: customerReasonFromBlock(blocked) };
  }
  if (hours >= (input.manualQueue ? autoRefundManualHours() : autoRefundStaleHours())) {
    return { refund: true, kind: "stale", reason: `sem compra confirmada ${Math.floor(hours)}h depois do pagamento`, customerReason: "não consegui confirmar a compra a tempo" };
  }
  return { refund: false };
}

// ---- desistência do cliente antes da compra (11/09, CDC art. 49) ----
// Só enquanto NENHUM dinheiro pode ter saído para a loja: pedido `paid`, sem número na
// loja e sem job em estado de compra. Carrinho nas mãos do dono (ML) só desiste se a
// ação pendente for consumida aqui primeiro (CAS): se o dono já tocou, perde a corrida.
const WITHDRAW_BLOCKING = ["submitting", "outcome_unknown", "awaiting_store_number", "pix_captured", "pix_submitted", "pix_paid", "store_confirmed"];
// Só leitura (06/10): a conversa pergunta "confirma?" antes de estornar; a pergunta só sai
// se a desistência ainda é possível. A decisão de verdade continua no customerWithdrawRefund.
export async function customerCanWithdraw(orderId: string): Promise<boolean> {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { status: true, storeOrderNumber: true } });
  if (!order || order.status !== "paid" || order.storeOrderNumber) return false;
  const blocking = await prisma.purchaseJob.findFirst({ where: { deliveryOrderId: orderId, status: { in: WITHDRAW_BLOCKING } }, select: { id: true } });
  return !blocking;
}

export async function customerWithdrawRefund(orderId: string): Promise<{ ok: true; amount: number } | { ok: false; reason: string }> {
  const gate = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== "paid" || order.storeOrderNumber) return { ok: false as const, reason: "compra já registrada" };
    const jobs = await tx.purchaseJob.findMany({ where: { deliveryOrderId: orderId } });
    if (jobs.some((j) => WITHDRAW_BLOCKING.includes(j.status))) return { ok: false as const, reason: "compra em andamento" };
    for (const job of jobs.filter((j) => j.status === "awaiting_owner_confirm")) {
      const { consumePendingActionForJob, mirrorOpsAction } = await import("./ops-actions");
      const consumed = await consumePendingActionForJob(tx, job.id, "ml_cart_ready", "customer_withdrew", "customer");
      if (!consumed) return { ok: false as const, reason: "dono já confirmou" };
      await mirrorOpsAction(tx, consumed, "customer_withdrew", "customer");
      await tx.purchaseSpend.updateMany({ where: { purchaseJobId: job.id, status: "reserved" }, data: { status: "released", releasedAt: new Date(), releaseNote: "cliente desistiu antes da confirmação do dono" } });
    }
    await tx.purchaseJob.updateMany({ where: { deliveryOrderId: orderId, status: { notIn: ["completed", "canceled"] } }, data: { status: "canceled", lockedAt: null, claimToken: null, browserSessionId: null, lastErrorCode: "CUSTOMER_WITHDREW", lastErrorMessage: "Cliente desistiu antes da compra; pedido estornado." } });
    await tx.opsAction.updateMany({ where: { deliveryOrderId: orderId, status: "pending" }, data: { status: "canceled" } });
    return { ok: true as const, notes: order.notes };
  });
  if (!gate.ok) return gate;
  const result = await refundOrderViaProvider(orderId);
  const current = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  const order = await prisma.deliveryOrder.update({
    where: { id: orderId },
    data: {
      status: "refunded",
      notes: appendOrderNote(
        appendOrderNote((current.notes ?? "").split("\n").filter((l) => l !== REFUND_PENDING_FLAG).join("\n"), `↩️ Cliente desistiu antes da compra — estorno pelo provedor em ${new Date().toISOString()}.`),
        `${REFUND_CONFIRMED_PREFIX} integral — ${result.reference}`
      )
    }
  });
  await resetConversationForClosedOrder(order, "refund");
  return { ok: true, amount: result.amount };
}

// Destinatário do pedido editável pelo operador (a compra automática exige o nome).
export async function opsSetRecipient(orderId: string, name: string) {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > 120) throw new Error("Nome do destinatário inválido.");
  return prisma.deliveryOrder.update({ where: { id: orderId }, data: { customerName: clean } });
}

const AUTO_REFUND_FAILED_MARKER = "⚠️ ESTORNO AUTOMÁTICO FALHOU";

export async function watchPaidOrder(
  orderId: string,
  now = new Date()
): Promise<"none" | "operator" | "operator+customer" | "auto_refunded" | "auto_refund_failed" | "plan_b_offered"> {
  let order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "paid" || !order.paidAt) return "none";
  // Pedido de várias lojas (09/10): o prazo vale POR LOJA — a loja que não comprou a tempo devolve só
  // a parte dela; as outras seguem. Nunca o estorno integral (uma loja pode estar pagando o Pix dela).
  const multi = isMultiStoreOrder(order) && perStoreQuoteReady(order);
  if (multi) {
    if ((await refundStaleStores(order, now)) > 0) return "auto_refunded";
    order = (await prisma.deliveryOrder.findUnique({ where: { id: orderId } })) ?? order;
    if (order.status !== "paid") return "none";
  }
  if (order.storeOrderNumber) return "none";

  // Plano B antes de tudo (04/09): bloqueio novo → substituto verificado oferecido na
  // hora. Marcadores na nota evitam repetir; "sem substituto" segue para alerta/estorno.
  const notes0 = order.notes ?? "";
  if (!multi && blockedReasonOf(notes0) && !notes0.includes(PLAN_B_OFFERED_PREFIX) && !notes0.includes(PLAN_B_NONE_PREFIX) && !notes0.includes(PLAN_B_ACCEPTED_PREFIX)) {
    const { offerPlanB } = await import("./plan-b");
    const outcome = await offerPlanB(orderId, {}, now);
    if (outcome === "offered") return "plan_b_offered";
    order = (await prisma.deliveryOrder.findUnique({ where: { id: orderId } })) ?? order;
  }

  // Estorno automático vem ANTES de qualquer alerta: não faz sentido avisar "pendente 6h"
  // e devolver o dinheiro no mesmo tick.
  const manualQueue = Boolean(await prisma.purchaseJob.findFirst({ where: { deliveryOrderId: orderId, status: "manual_queue" }, select: { id: true } }));
  const decision = autoRefundDecision({ ...order, manualQueue }, now);
  if (decision.refund && !multi) {
    const shortId = order.id.slice(-6).toUpperCase();
    try {
      await opsPurchaseFailedRefund(orderId, decision.customerReason, { origin: "auto", internalReason: decision.reason });
      await notifyOwner(copy.operatorAutoRefundAlert(shortId, Number(order.total), decision.reason), order.phone);
      return "auto_refunded";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[auto-refund:failed]", orderId, message);
      // Nota + alerta UMA vez; o cron tenta de novo a cada 10 min sem repetir o aviso.
      if (!(order.notes ?? "").includes(AUTO_REFUND_FAILED_MARKER)) {
        await prisma.deliveryOrder.update({
          where: { id: orderId },
          data: {
            notes: appendOrderNote(
              order.notes,
              `${AUTO_REFUND_FAILED_MARKER}: ${message.replace(/[\r\n]/g, " ").slice(0, 160)} (${now.toISOString()}) — tenta de novo a cada 10 min; se persistir, estornar à mão no /ops.`
            )
          }
        });
        await notifyOwner(copy.operatorAutoRefundFailedAlert(shortId, message), order.phone);
      }
      return "auto_refund_failed";
    }
  }

  const minutes = Math.floor((now.getTime() - order.paidAt!.getTime()) / 60_000);
  const bucket = [...STUCK_BUCKETS_MIN].reverse().find((m) => minutes >= m);
  if (!bucket) return "none";
  const marker = `⏰ COMPRA PENDENTE ${bucketLabel(bucket)}`;
  if ((order.notes ?? "").includes(marker)) return "none";
  const blockedReason = blockedReasonOf(order.notes);
  await prisma.deliveryOrder.update({
    where: { id: orderId },
    data: { notes: appendOrderNote(order.notes, `${marker}: alerta enviado em ${now.toISOString()}.`) }
  });
  const shortId = order.id.slice(-6).toUpperCase();
  await notifyOperator(copy.operatorPaidStuckAlert(shortId, bucketLabel(minutes), blockedReason), order.phone);
  // Passou de 6h com o dinheiro parado: o dono também precisa saber. Antes de 6h o alerta
  // é só de quem compra — cobrar o operador a cada 30 min não é assunto do dono.
  if (bucket >= 360 && operatorIsHired()) {
    await notifyOwner(copy.operatorPaidStuckAlert(shortId, bucketLabel(minutes), blockedReason), order.phone);
  }
  // Cliente: bloqueio SEM plano B avisa já no 1º alerta ("estou tentando outra loja");
  // com plano B oferecido ele já tem a pergunta na tela. Sem bloqueio, só a partir de 6h
  // e depois em 24h/48h/72h — nunca a cada 10 min.
  const planBOffered = (order.notes ?? "").includes(PLAN_B_OFFERED_PREFIX);
  const firstAlert = !(order.notes ?? "").includes("⏰ COMPRA PENDENTE");
  const tellCustomer = blockedReason ? !planBOffered && (firstAlert || bucket >= 1440) : bucket >= 360;
  if (!tellCustomer) return "operator";
  const delivered = await deliverNotice(order.phone, copy.purchaseDelayedCustomer(shortId, Boolean(blockedReason)), { items: order.items });
  if (delivered === "skipped") {
    await prisma.deliveryOrder.update({
      where: { id: orderId },
      data: { notes: appendOrderNote((await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } }))?.notes ?? null, "⚠️ Aviso ao cliente NÃO enviado: fora da janela de 24h e sem template (LIA_TEMPLATE_ORDER_UPDATE). Avisar por outro canal.") }
    });
    return "operator";
  }
  return "operator+customer";
}

// Lojas de um pedido de várias lojas que passaram do prazo sem compra (mesma régua do estorno
// automático do pedido inteiro: bloqueio, fila manual ou 6 h sem compra). Devolve só a parte de cada uma.
async function refundStaleStores(order: { id: string; status: string; paidAt: Date | null; notes: string | null }, now: Date): Promise<number> {
  const jobs = await prisma.purchaseJob.findMany({ where: { deliveryOrderId: order.id, storeOrderNumber: null, status: { in: ["queued", "retrying", "needs_review", "awaiting_approval", "manual_queue", "preflight_queued"] } } });
  let refunded = 0;
  for (const job of jobs) {
    const decision = autoRefundDecision({ status: "paid", storeOrderNumber: null, paidAt: order.paidAt, notes: order.notes, manualQueue: job.status === "manual_queue" }, now);
    if (!decision.refund) continue;
    try {
      const { refundStoreShare } = await import("./purchase/store-refund");
      const result = await refundStoreShare(job.id, { reason: decision.customerReason, internalReason: `${job.storeLabel}: ${decision.reason}`, origin: "auto" });
      if (result.status === "refunded") refunded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[auto-refund:store-share-failed]", order.id, job.storeKey, message);
      const marker = `${AUTO_REFUND_FAILED_MARKER} (${job.storeLabel})`;
      const current = await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { notes: true, phone: true } });
      if (current && !(current.notes ?? "").includes(marker)) {
        await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(current.notes, `${marker}: ${message.replace(/[\r\n]/g, " ").slice(0, 160)} (${now.toISOString()}) — tenta de novo a cada 10 min.`) } });
        await notifyOwner(copy.operatorAutoRefundFailedAlert(order.id.slice(-6).toUpperCase(), `${job.storeLabel}: ${message}`), current.phone);
      }
    }
  }
  return refunded;
}

// "Não consegui comprar → estornar": um clique no /ops que estorna pelo provedor,
// fecha o pedido e explica ao cliente, com o motivo. Sem razão no pagamento
// (pedido antigo), lança a mensagem legível e o caminho manual continua valendo.
// Loja cancelou DEPOIS da compra (09/10/2026, dono: "nesses casos o estorno devia ser automático").
// Caso real: Drogal cancelou o #GTGH3C às 8h25 e o dinheiro do cliente ficou preso esperando um toque
// no /ops. Regra do sistema: cancelamento confirmado pela loja (status do pedido ou e-mail) = estorno
// integral pelo provedor na hora, cliente avisado, dono avisado (com o Pix pago à loja a recuperar).
// Idempotente pela nota; falha (provedor recusou) vira nota + alerta, e quem chamou tenta de novo.
export const STORE_CANCELED_REFUND_MARK = "🤖 Estorno automático: loja cancelou";
export function storeCancelAutoRefundEnabled(): boolean {
  return process.env.LIA_STORE_CANCEL_AUTO_REFUND !== "false";
}
export async function autoRefundStoreCanceled(
  orderId: string,
  input: { storeKey: string; storeLabel: string; storeOrderNumber: string; source: "store-status" | "mail" }
): Promise<"refunded" | "already" | "skipped" | "failed"> {
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!current) return "skipped";
  if ((current.notes ?? "").includes(STORE_CANCELED_REFUND_MARK) || current.status === "refunded") return "already";
  if (!current.paidAt || !["retailer_preparing", "retailer_out_for_delivery", "paid", "refund_pending"].includes(current.status)) return "skipped";
  const shortId = orderId.slice(-6).toUpperCase();
  // Pedido de várias lojas (09/10): a loja que cancelou devolve só a parte dela; as outras seguem.
  if (isMultiStoreOrder(current)) {
    const job = await prisma.purchaseJob.findFirst({ where: { deliveryOrderId: orderId, storeKey: input.storeKey, storeOrderNumber: input.storeOrderNumber } });
    if (!job) return "skipped";
    if (job.status === "canceled" && job.lastErrorCode === STORE_SHARE_REFUNDED) return "already";
    try {
      const { refundStoreShare } = await import("./purchase/store-refund");
      const result = await refundStoreShare(job.id, { reason: `a ${input.storeLabel} cancelou a parte dela`, internalReason: `${input.storeLabel} cancelou o pedido ${input.storeOrderNumber} depois da compra (via ${input.source}); Pix pago à loja a recuperar`, origin: "auto", storeCanceled: { storeOrderNumber: input.storeOrderNumber } });
      if (result.status === "skipped") return "skipped";
      console.warn("[store-canceled:auto-refund-share]", input.storeKey, shortId, input.storeOrderNumber, result.reference);
      return "refunded";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[store-canceled:auto-refund-share-failed]", orderId, input.storeKey, message);
      const marker = `${AUTO_REFUND_FAILED_MARKER} (${input.storeLabel})`;
      if (!(current.notes ?? "").includes(marker)) {
        await prisma.deliveryOrder.update({ where: { id: orderId }, data: { notes: appendOrderNote(current.notes, `${marker}: loja cancelou e a devolução da parte dela falhou — ${message.replace(/[\r\n]/g, " ").slice(0, 160)} (${new Date().toISOString()}).`) } });
        await notifyOwner(copy.operatorAutoRefundFailedAlert(shortId, `${input.storeLabel}: ${message}`));
      }
      return "failed";
    }
  }
  try {
    const result = await refundOrderViaProvider(orderId);
    const payout = await prisma.pixPayout.findFirst({ where: { deliveryOrderId: orderId, status: "paid" }, orderBy: { createdAt: "desc" } });
    const notesWithoutPending = (current.notes ?? "").split("\n").filter((line) => line !== REFUND_PENDING_FLAG).join("\n");
    const order = await prisma.deliveryOrder.update({
      where: { id: orderId },
      data: {
        status: "refunded",
        notes: appendOrderNote(
          appendOrderNote(
            notesWithoutPending,
            `${STORE_CANCELED_REFUND_MARK} (${input.storeLabel} nº ${input.storeOrderNumber}, via ${input.source}) — pelo provedor em ${new Date().toISOString()}.${payout ? ` Pix pago à loja (R$ ${(payout.amountCents / 100).toFixed(2).replace(".", ",")}, ${payout.endToEndId ?? payout.providerPayoutId ?? "sem e2e"}) a recuperar.` : ""}`
          ),
          `${REFUND_CONFIRMED_PREFIX} integral — ${result.reference}`
        )
      }
    });
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: orderId, completedAt: null }, data: { completedAt: new Date() } });
    await resetConversationForClosedOrder(order, "store-canceled-refund");
    const delivered = await deliverNotice(order.phone, copy.storeCanceledRefunded(input.storeLabel, shortId, result.amount), { items: order.items }).catch(() => "skipped" as const);
    if (delivered === "skipped") {
      await prisma.deliveryOrder.update({ where: { id: orderId }, data: { notes: appendOrderNote(order.notes, "⚠️ Aviso do estorno NÃO enviado: cliente fora da janela de 24h e sem template. Avisar por outro canal.") } });
    }
    await notifyOwner(copy.ownerStoreCanceledRefunded({ storeLabel: input.storeLabel, shortId, storeOrderNumber: input.storeOrderNumber, total: result.amount, storePaid: payout ? payout.amountCents / 100 : undefined }));
    console.warn("[store-canceled:auto-refund]", input.storeKey, shortId, input.storeOrderNumber, result.reference);
    return "refunded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[store-canceled:auto-refund-failed]", orderId, message);
    if (!(current.notes ?? "").includes(AUTO_REFUND_FAILED_MARKER)) {
      await prisma.deliveryOrder.update({
        where: { id: orderId },
        data: { notes: appendOrderNote(current.notes, `${AUTO_REFUND_FAILED_MARKER}: loja cancelou e o estorno falhou — ${message.replace(/[\r\n]/g, " ").slice(0, 160)} (${new Date().toISOString()}). Estornar à mão no /ops.`) }
      });
      await notifyOwner(copy.operatorAutoRefundFailedAlert(shortId, message));
    }
    return "failed";
  }
}

export async function opsPurchaseFailedRefund(
  orderId: string,
  reason?: string,
  opts: { origin?: "ops" | "auto"; internalReason?: string } = {}
) {
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!current) throw new Error("Order not found");
  if (!["paid", "refund_pending"].includes(current.status)) {
    throw new Error("Só um pedido pago (ou com estorno pendente) pode ser estornado por compra não realizada.");
  }
  const result = await refundOrderViaProvider(orderId);
  const safeReason = (reason ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 160);
  const notesWithoutPending = (current.notes ?? "")
    .split("\n")
    .filter((line) => line !== REFUND_PENDING_FLAG)
    .join("\n");
  const order = await prisma.deliveryOrder.update({
    where: { id: orderId },
    data: {
      status: "refunded",
      notes: appendOrderNote(
        appendOrderNote(
          notesWithoutPending,
          opts.origin === "auto"
            ? `🤖 Estorno automático (regra 04/09): compra não realizada — ${(opts.internalReason ?? safeReason).replace(/[\r\n]/g, " ").slice(0, 200)} — pelo provedor em ${new Date().toISOString()}.`
            : `🧾 Compra não realizada${safeReason ? ` (${safeReason})` : ""} — estorno pelo provedor em ${new Date().toISOString()}.`
        ),
        `${REFUND_CONFIRMED_PREFIX} integral — ${result.reference}`
      )
    }
  });
  await resetConversationForClosedOrder(order, "refund");
  const items = ((order.items as unknown as { qty: number; name: string }[]) ?? []).map((i) => (i.qty > 1 ? `${i.qty}x ${i.name}` : i.name));
  const delivered = await deliverNotice(order.phone, copy.purchaseFailedRefunded(items, result.amount, safeReason || undefined), { items: order.items });
  if (delivered === "skipped") {
    return prisma.deliveryOrder.update({
      where: { id: orderId },
      data: { notes: appendOrderNote(order.notes, "⚠️ Aviso do estorno NÃO enviado: cliente fora da janela de 24h e sem template (LIA_TEMPLATE_ORDER_UPDATE). Avisar por outro canal.") }
    });
  }
  return order;
}

// Orçamento do pedido estourado (10/10, rodada 8 M3): o teto e o item mais caro (a sugestão de corte mais óbvia).
function overBudgetSummaryInput(cap: number, items: BasketItem[], priced: boolean): { cap: number; priciest?: { name: string; lineTotal: number } } {
  if (!priced || items.length < 2) return { cap };
  const top = [...items]
    .filter((item) => item.unitPrice > 0)
    .map((item) => ({ name: item.name, lineTotal: roundMoney(display(item.unitPrice, item.medicine) * item.qty) }))
    .sort((a, b) => b.lineTotal - a.lineTotal)[0];
  return top ? { cap, priciest: top } : { cap };
}
