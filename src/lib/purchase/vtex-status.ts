// Acompanhamento pelo PRÓPRIO pedido na loja (27/09/2026). O comprador do servidor guarda, na
// tentativa `vtex_order`, os cookies do fechamento (CheckoutDataAccess/Vtex_CHKO_Auth): com
// eles, `orders/order-group/{og}` devolve o estado real do pedido — sem depender de e-mail.
//
// Regra de precisão (dono, 27/09: "msg de saiu pra entrega precisa estar ACCURATE"):
//   - `invoiced`                         → aviso "a loja emitiu a nota, preparando o envio" (1x)
//   - rastreio da transportadora com eventos → "shipped" (enviado; previsão da loja)
//   - último evento de rota/entregador   → "out_for_delivery" (saiu pra entrega)
//   - rastreio finalizado com data       → "delivered"
//   - `canceled`                         → alerta ao dono (a loja cancelou depois do Pix)
// Prazo decorrido NUNCA é evidência. Sem sinal explícito, nada é dito ao cliente.
import { prisma } from "../prisma";
import { appendOrderNote } from "../order-flags";
import { recordDeliveryEvent } from "../delivery-events";
import { VTEX_API_STORE_KEYS, VTEX_API_STORES, type FetchLike } from "./vtex-checkout";
import { MULTI_STORE_TRACKING_KEY, storeStageFromKeys } from "./store-split";

type Json = Record<string, unknown>;
const INVOICED_MARK = "🧾 Loja faturou (status do pedido na loja)";
const STALL_MARK = "⛔ LOJA NÃO COMEÇOU O PEDIDO";
const LATE_MARK = "⏰ Passou do prazo da loja sem sinal de entrega";
// Estados ANTES de a loja começar a separar. Pedido comprado que fica aqui além do prazo = a loja
// não pegou o pedido (Drogal 08/10: 13 h em "payment-approved" com Expressa de 30 min).
const PRE_HANDLING = new Set(["order-created", "order-completed", "on-order-completed", "payment-pending", "payment-approved", "approve-payment", "window-to-cancel", "waiting-for-seller-confirmation", "waiting-for-authorization", "waiting-ffmt-authorization", "authorize-fulfillment", "order-accepted"]);

// Puro. Parado = loja ainda não começou e:
//   - entrega rápida (prazo da loja ≤ 3 h): passou metade do prazo, no mínimo 20 min (30 min → 20 min);
//   - entrega longa: o prazo da loja venceu;
//   - sem prazo conhecido: 12 h.
// Atrasado (só aviso ao dono) = já começou, mas o prazo venceu há 1 h (rápida) / 12 h (longa) sem entrega.
// Parado além da tolerância = a Lia pede o cancelamento na própria loja (09/10, dono: "nesses casos o
// estorno devia ser automático"). Tolerância: rápida (≤ 3 h) = prazo + 1 h; longa = prazo + 12 h; sem
// prazo = 24 h. Antes disso a loja ainda pode entregar (um atraso não é um cancelamento).
export function stalledPastGrace(input: { boughtAt: Date; eta?: string; now: Date }): boolean {
  const etaAt = input.eta ? Date.parse(input.eta) : NaN;
  if (!Number.isFinite(etaAt)) return input.now.getTime() - input.boughtAt.getTime() >= 24 * 3_600_000;
  const fast = (etaAt - input.boughtAt.getTime()) / 60_000 <= 180;
  return input.now.getTime() >= etaAt + (fast ? 60 : 12 * 60) * 60_000;
}
export function stallAutoCancelEnabled(): boolean {
  return process.env.LIA_STALL_AUTO_CANCEL !== "false";
}
const CANCEL_REQUESTED_MARK = "🧾 Cancelamento pedido à loja";
// Cancelamento pelo próprio comprador (API pública do checkout VTEX), com os cookies do fechamento.
export async function requestStoreCancellation(
  domain: string,
  orderId: string,
  cookies: Record<string, string>,
  fetchImpl: FetchLike,
  reason = "Pedido não iniciado dentro do prazo prometido"
): Promise<{ ok: boolean; status: number }> {
  const r = await fetchImpl(`https://${domain}/api/checkout/pub/orders/${encodeURIComponent(orderId)}/user-cancel-request`, {
    method: "POST",
    headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "), Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ reason }),
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: r.ok, status: r.status };
}

export function storeOrderHealth(input: { state: string | null; boughtAt: Date; eta?: string; now: Date; delivered?: boolean }): "ok" | "stalled" | "late" {
  if (input.delivered) return "ok";
  const elapsedMin = (input.now.getTime() - input.boughtAt.getTime()) / 60_000;
  const etaAt = input.eta ? Date.parse(input.eta) : NaN;
  const promiseMin = Number.isFinite(etaAt) ? (etaAt - input.boughtAt.getTime()) / 60_000 : null;
  const fast = promiseMin != null && promiseMin <= 180;
  if (input.state && PRE_HANDLING.has(input.state)) {
    if (promiseMin == null) return elapsedMin >= 12 * 60 ? "stalled" : "ok";
    if (fast) return elapsedMin >= Math.max(20, promiseMin / 2) ? "stalled" : "ok";
    return input.now.getTime() >= etaAt ? "stalled" : "ok";
  }
  if (promiseMin != null && input.state !== "canceled") {
    const graceMin = fast ? 60 : 12 * 60;
    if (input.now.getTime() >= etaAt + graceMin * 60_000) return "late";
  }
  return "ok";
}
const CANCELED_MARK = "🛑 LOJA CANCELOU O PEDIDO";
const LAST_MILE = /sa[ií]u para (a )?entrega|em rota de entrega|rota de entrega|saiu com o entregador|out for delivery|entregador/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function etaTextFrom(iso: string | undefined | null, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return undefined;
  const tz = "America/Sao_Paulo";
  const day = (x: Date) => x.toLocaleDateString("pt-BR", { timeZone: tz });
  if (day(d) === day(now)) return "hoje";
  if (day(d) === day(new Date(now.getTime() + 86_400_000))) return "amanhã";
  return `até ${d.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit" }).replace(".", "")}`;
}

export type StoreOrderSignal = {
  state: string | null;
  eta?: string;
  trackingUrl?: string;
  delivered?: Date;
  lastMile?: Date;
  shipped?: Date;
};
// Puro: lê o JSON do order-group e devolve só o que a loja afirma.
export function readStoreOrder(order: Json): StoreOrderSignal {
  const state = typeof order.state === "string" ? order.state : null;
  const logistics = (((order.shippingData as Json | undefined)?.logisticsInfo as Json[] | undefined) ?? []);
  const eta = logistics.map((l) => l.shippingEstimateDate).find((x): x is string => typeof x === "string");
  const packages = (((order.packageAttachment as Json | undefined)?.packages as Json[] | undefined) ?? []);
  const out: StoreOrderSignal = { state, ...(eta ? { eta } : {}) };
  for (const pkg of packages) {
    const url = typeof pkg.trackingUrl === "string" && /^https:\/\//.test(pkg.trackingUrl) ? pkg.trackingUrl : undefined;
    if (url && !out.trackingUrl) out.trackingUrl = url;
    const courier = (pkg.courierStatus as Json | undefined) ?? {};
    const events = ((courier.data as Json[] | undefined) ?? []).filter((e) => typeof e.description === "string");
    const when = (e: Json) => new Date(String(e.createDate ?? e.lastChange ?? e.date ?? ""));
    const deliveredDate = typeof courier.deliveredDate === "string" ? new Date(courier.deliveredDate) : null;
    if (courier.finished === true && deliveredDate && Number.isFinite(deliveredDate.getTime())) out.delivered = deliveredDate;
    if (events.length) {
      const first = when(events[0]);
      out.shipped = Number.isFinite(first.getTime()) ? first : new Date();
      const last = events[events.length - 1];
      if (LAST_MILE.test(String(last.description))) {
        const t = when(last);
        out.lastMile = Number.isFinite(t.getTime()) ? t : new Date();
      }
    }
  }
  return out;
}

type PollReport = { checked: number; notices: number; events: number; errors: string[] };
type PolledOrder = { id: string; phone: string; items: unknown; notes: string | null; status: string };

// Uma loja de um pedido: lê o pedido NA loja e aplica a régua de sempre (vigia, cancelamento, etapas).
// `multi` (09/10, pedido de várias lojas): marcas com o nome da loja, etapa da PRÓPRIA loja e evento
// por loja. Devolve em quantos minutos olhar de novo e se esta loja terminou (entregue/cancelada).
async function pollStoreOrder(input: {
  order: PolledOrder;
  storeKey: string;
  storeOrderNumber: string;
  details: { orderGroup?: string; storeOrderNumber?: string; cookies?: Record<string, string> };
  boughtAt: Date;
  // Etapa da loja antes da leitura (multi: pelos eventos da loja; uma loja: pelo status do pedido).
  preparing: boolean;
  multi: boolean;
  fetchImpl: FetchLike;
  now: Date;
  report: PollReport;
}): Promise<{ every: number; done: boolean }> {
  const { order, storeKey, storeOrderNumber, details, boughtAt, multi, fetchImpl, now, report } = input;
  const store = VTEX_API_STORES[storeKey];
  const r = await fetchImpl(`https://${store.domain}/api/checkout/pub/orders/order-group/${details.orderGroup}`, {
    headers: { Cookie: Object.entries(details.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`loja HTTP ${r.status}`);
  const body = (await r.json()) as unknown;
  const first = (Array.isArray(body) ? body[0] : body) as Json | undefined;
  if (!first) throw new Error("pedido não encontrado na loja");
  const sig = readStoreOrder(first);
  const eta = etaTextFrom(sig.eta, now);
  const common = { source: "tracking_reader" as const, storeKey, storeOrderNumber, ...(sig.trackingUrl ? { trackingUrl: sig.trackingUrl } : {}) };
  // Notas atuais (outra loja do mesmo pedido pode ter escrito nesta rodada).
  const notes = multi ? ((await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { notes: true } }))?.notes ?? "") : order.notes ?? "";
  const mark = (base: string) => (multi ? `${base} (${store.label})` : base);
  const addNote = async (text: string) => {
    const current = multi ? (await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { notes: true } }))?.notes ?? null : order.notes;
    await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(current, text) } });
  };
  // Vigia (09/10): loja que não começa o pedido comprado dentro do prazo. Avisa o dono na hora (mesmo
  // quando o cliente é o próprio dono testando: alerta de dinheiro/loja nunca é suprimido),
  // conta a verdade ao cliente e tira a loja da vitrine até o dono religar (store-pause.ts).
  const health = storeOrderHealth({ state: sig.state, boughtAt, eta: sig.eta, now, delivered: Boolean(sig.delivered || sig.lastMile || sig.shipped) });
  const shortId = order.id.slice(-6).toUpperCase();
  // Parado além da tolerância: a Lia pede o cancelamento na loja; quando a loja confirmar "canceled",
  // o estorno automático abaixo devolve o dinheiro. Uma vez por pedido (por loja, no pedido de várias).
  let cancelAccepted = false;
  if (health === "stalled" && stallAutoCancelEnabled() && !notes.includes(mark(CANCEL_REQUESTED_MARK)) && stalledPastGrace({ boughtAt, eta: sig.eta, now })) {
    let outcome = "";
    try {
      const res = await requestStoreCancellation(store.domain, storeOrderNumber, details.cookies ?? {}, fetchImpl);
      outcome = res.ok ? `aceito (HTTP ${res.status})` : `recusado (HTTP ${res.status})`;
    } catch (error) {
      outcome = `falhou (${error instanceof Error ? error.message : String(error)})`;
    }
    await addNote(`${mark(CANCEL_REQUESTED_MARK)} em ${now.toISOString()}: ${outcome}.`);
    console.warn("[store-stall:cancel-request]", storeKey, shortId, storeOrderNumber, outcome);
    if (outcome.startsWith("aceito")) {
      cancelAccepted = true;
      const { deliverNotice } = await import("../turn-runtime");
      const copy = await import("../lia-copy");
      await deliverNotice(order.phone, copy.retailerStalledCanceling(store.label, shortId), { items: order.items }).catch(() => undefined);
      report.notices += 1;
    }
    // Recarrega as notas para o bloco de "parado" não repetir o aviso de antes.
    order.notes = (await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { notes: true } }))?.notes ?? order.notes;
  }
  const notesNow = order.notes ?? "";
  if (health === "stalled" && !notesNow.includes(mark(STALL_MARK))) {
    const { pauseStore } = await import("../store-pause");
    const paused = await pauseStore(storeKey, `pedido #${shortId} (${storeOrderNumber}) parado em "${sig.state}" além do prazo`, "vigia");
    await addNote(`${mark(STALL_MARK)}: ainda em "${sig.state}" em ${now.toISOString()}, prazo da loja vencido. Loja tirada da vitrine; cliente avisado; cobrar a loja e estornar se ela não resolver.`);
    const { deliverNotice, notifyOwner } = await import("../turn-runtime");
    const copy = await import("../lia-copy");
    if (!cancelAccepted) await deliverNotice(order.phone, copy.retailerStalled(store.label, shortId), { items: order.items }).catch((error) => console.error("[store-stall:customer-notice-failed]", error instanceof Error ? error.message : error));
    await notifyOwner(copy.ownerStoreStalled({ storeLabel: store.label, storeKey, shortId, storeOrderNumber, state: String(sig.state), minutes: Math.round((now.getTime() - boughtAt.getTime()) / 60_000), paused }));
    console.error("[store-stall]", storeKey, shortId, storeOrderNumber, sig.state);
    report.notices += 1;
  } else if (health === "late" && !notes.includes(mark(LATE_MARK)) && !notes.includes(mark(STALL_MARK))) {
    await addNote(`${mark(LATE_MARK)} (status "${sig.state}" em ${now.toISOString()}).`);
    const { notifyOwner } = await import("../turn-runtime");
    const copy = await import("../lia-copy");
    await notifyOwner(copy.ownerOrderLate({ storeLabel: store.label, shortId, storeOrderNumber, state: String(sig.state) }));
    console.warn("[store-late]", storeKey, shortId, storeOrderNumber, sig.state);
  }
  if (sig.state === "canceled") {
    // Pedido de várias lojas: marca SEM 🛑 (o 🛑 trava a compra das outras lojas do pedido).
    const canceledMark = multi ? `🚫 A ${store.label} cancelou a parte dela` : CANCELED_MARK;
    if (!notes.includes(canceledMark)) await addNote(`${canceledMark} (status da loja em ${now.toISOString()}).`);
    // Estorno automático (09/10): a loja cancelou = o dinheiro do cliente volta agora (no pedido de várias
    // lojas, só a parte desta loja). Falhou → olha de novo em 10 min (o alerta ao dono sai uma vez).
    const { autoRefundStoreCanceled, storeCancelAutoRefundEnabled } = await import("../ops-lifecycle");
    const refund = storeCancelAutoRefundEnabled() ? await autoRefundStoreCanceled(order.id, { storeKey, storeLabel: store.label, storeOrderNumber, source: "store-status" }) : "skipped";
    if (refund === "skipped" && !notes.includes(canceledMark)) {
      const { notifyOwner } = await import("../turn-runtime");
      await notifyOwner(`🛑 A ${store.label} cancelou o pedido #${shortId} (${storeOrderNumber}) depois da compra. Conferir o reembolso da loja e estornar ${multi ? "a parte dela" : "o cliente"} no /ops.`);
    }
    if (refund === "failed") return { every: 10, done: false };
    return { every: 0, done: true };
  }
  if (sig.delivered) {
    await recordDeliveryEvent(order.id, { ...common, kind: "delivered", sourceReference: `store-status:${details.orderGroup}:delivered`, occurredAt: sig.delivered < now ? sig.delivered : now });
    report.events += 1;
  } else if (sig.lastMile) {
    await recordDeliveryEvent(order.id, { ...common, kind: "out_for_delivery", sourceReference: `store-status:${details.orderGroup}:last-mile`, occurredAt: sig.lastMile < now ? sig.lastMile : now });
    report.events += 1;
  } else if (sig.shipped && input.preparing) {
    await recordDeliveryEvent(order.id, { ...common, kind: "shipped", sourceReference: `store-status:${details.orderGroup}:shipped`, occurredAt: sig.shipped < now ? sig.shipped : now, ...(eta ? { etaText: eta } : {}) });
    report.events += 1;
  } else if (sig.state === "invoiced" && input.preparing && !notes.includes(mark(INVOICED_MARK))) {
    const { deliverNotice } = await import("../turn-runtime");
    const copy = await import("../lia-copy");
    await deliverNotice(order.phone, copy.retailerInvoiced(store.label, eta), { items: order.items });
    await addNote(`${mark(INVOICED_MARK)} em ${now.toISOString()}${eta ? ` — previsão ${eta}` : ""}.`);
    report.notices += 1;
  }
  // Mais perto da entrega, olhar mais vezes. Entrega rápida (Expressa 30 min, Drogal 08/10): a previsão
  // da loja nas próximas 2h — ou vencida há menos de 6h — olha a cada 5 min (o cron roda a cada 3);
  // antes eram 60 min fixos e a entrega de 30 min chegava antes da 2ª olhada.
  const etaAt = sig.eta ? Date.parse(sig.eta) : NaN;
  const soon = Number.isFinite(etaAt) && etaAt - now.getTime() < 2 * 3_600_000 && now.getTime() - etaAt < 6 * 3_600_000;
  // Ainda antes da separação: olha a cada 5 min na 1ª hora depois da compra (o vigia pega a
  // Expressa parada em ~20 min), depois a cada 15.
  const preHandling = Boolean(sig.state && PRE_HANDLING.has(sig.state));
  const firstHour = now.getTime() - boughtAt.getTime() < 3_600_000;
  const every = soon || (preHandling && firstHour) ? 5 : preHandling ? 15 : sig.lastMile || sig.shipped ? 20 : sig.state === "invoiced" ? 30 : 60;
  return { every, done: Boolean(sig.delivered) };
}

export async function pollVtexOrderStatuses(input: { limit?: number; fetchImpl?: FetchLike; now?: Date } = {}) {
  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const report: PollReport = { checked: 0, notices: 0, events: 0, errors: [] };
  const take = Math.max(1, Math.min(25, input.limit ?? 10));
  const subs = await prisma.trackingSubscription.findMany({
    where: { completedAt: null, nextCheckAt: { lte: now }, storeKey: { in: VTEX_API_STORE_KEYS }, deliveryOrder: { status: { in: ["retailer_preparing", "retailer_out_for_delivery"] } } },
    include: { deliveryOrder: true },
    orderBy: { nextCheckAt: "asc" },
    take,
  });
  for (const sub of subs) {
    report.checked += 1;
    const order = sub.deliveryOrder;
    try {
      const attempt = await prisma.purchaseAttempt.findFirst({
        where: { step: "vtex_order", purchaseJob: { deliveryOrderId: order.id } },
        orderBy: { createdAt: "desc" },
      });
      const details = (attempt?.details ?? {}) as { orderGroup?: string; storeOrderNumber?: string; cookies?: Record<string, string> };
      if (!details.orderGroup || !details.cookies || details.storeOrderNumber !== sub.storeOrderNumber) {
        // Pedido sem cookies do fechamento (comprado à mão/antigo): só o e-mail acompanha.
        await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { nextCheckAt: new Date(now.getTime() + 6 * 3_600_000), lastCheckedAt: now, lastError: "sem acesso ao pedido na loja" } });
        continue;
      }
      const job = await prisma.purchaseJob.findFirst({ where: { deliveryOrderId: order.id, storeKey: sub.storeKey }, orderBy: { createdAt: "desc" }, select: { completedAt: true, createdAt: true } });
      const boughtAt = job?.completedAt ?? job?.createdAt ?? sub.createdAt;
      const polled = await pollStoreOrder({ order, storeKey: sub.storeKey, storeOrderNumber: sub.storeOrderNumber, details, boughtAt, preparing: order.status === "retailer_preparing", multi: false, fetchImpl, now, report });
      if (polled.done && !polled.every) {
        await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { completedAt: now, lastCheckedAt: now } });
        continue;
      }
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { nextCheckAt: new Date(now.getTime() + polled.every * 60_000), lastCheckedAt: now, lastError: null, failures: 0, ...(polled.done ? { completedAt: now } : {}) } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${order.id.slice(-6)}: ${message}`);
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { lastCheckedAt: now, lastError: message.slice(0, 300), failures: { increment: 1 }, nextCheckAt: new Date(now.getTime() + Math.min(6 * 60, 30 * (sub.failures + 1)) * 60_000) } }).catch(() => undefined);
    }
  }
  await pollMultiStoreOrders({ take, fetchImpl, now, report });
  return report;
}

// Pedido de várias lojas (09/10): uma assinatura por pedido; dentro dela, cada loja comprada pela API
// é lida no seu próprio pedido (cookies da tentativa `vtex_order` DO TRABALHO dela) e tem o seu vigia.
async function pollMultiStoreOrders(input: { take: number; fetchImpl: FetchLike; now: Date; report: PollReport }) {
  const { now, fetchImpl, report } = input;
  const subs = await prisma.trackingSubscription.findMany({
    where: { completedAt: null, nextCheckAt: { lte: now }, storeKey: MULTI_STORE_TRACKING_KEY, deliveryOrder: { status: { in: ["paid", "retailer_preparing", "retailer_out_for_delivery"] } } },
    include: { deliveryOrder: true },
    orderBy: { nextCheckAt: "asc" },
    take: input.take,
  });
  for (const sub of subs) {
    report.checked += 1;
    const order = sub.deliveryOrder;
    try {
      const jobs = await prisma.purchaseJob.findMany({ where: { deliveryOrderId: order.id, status: "completed", storeOrderNumber: { not: null }, storeKey: { in: VTEX_API_STORE_KEYS } }, orderBy: { createdAt: "asc" } });
      const keys = (await prisma.deliveryEvent.findMany({ where: { deliveryOrderId: order.id }, select: { dedupeKey: true } })).map((e) => e.dedupeKey);
      let next: number | null = null;
      let pending = false;
      for (const job of jobs) {
        const stage = storeStageFromKeys(order.id, job.storeKey, keys);
        const notes = (await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { notes: true } }))?.notes ?? "";
        if (stage === "delivered" || notes.includes(`🚫 A ${VTEX_API_STORES[job.storeKey].label} cancelou a parte dela`)) continue;
        const attempt = await prisma.purchaseAttempt.findUnique({ where: { purchaseJobId_idempotencyKey: { purchaseJobId: job.id, idempotencyKey: `vtex-order:${job.submissionId}` } } });
        const details = (attempt?.details ?? {}) as { orderGroup?: string; storeOrderNumber?: string; cookies?: Record<string, string> };
        if (!details.orderGroup || !details.cookies || details.storeOrderNumber !== job.storeOrderNumber) continue;
        pending = true;
        try {
          const polled = await pollStoreOrder({ order, storeKey: job.storeKey, storeOrderNumber: job.storeOrderNumber!, details, boughtAt: job.completedAt ?? job.createdAt, preparing: stage === "bought", multi: true, fetchImpl, now, report });
          if (polled.every) next = Math.min(next ?? polled.every, polled.every);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.errors.push(`${order.id.slice(-6)} ${job.storeKey}: ${message}`);
          next = Math.min(next ?? 30, 30);
        }
      }
      // Loja ainda por comprar (pedido "pago"): a assinatura segue viva e olha de novo.
      const stillBuying = order.status === "paid";
      if (!pending && !stillBuying) {
        await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { completedAt: now, lastCheckedAt: now } });
        continue;
      }
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { nextCheckAt: new Date(now.getTime() + (next ?? 15) * 60_000), lastCheckedAt: now, lastError: null, failures: 0 } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${order.id.slice(-6)}: ${message}`);
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { lastCheckedAt: now, lastError: message.slice(0, 300), failures: { increment: 1 }, nextCheckAt: new Date(now.getTime() + Math.min(6 * 60, 30 * (sub.failures + 1)) * 60_000) } }).catch(() => undefined);
    }
  }
}
