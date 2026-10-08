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

type Json = Record<string, unknown>;
const INVOICED_MARK = "🧾 Loja faturou (status do pedido na loja)";
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

export async function pollVtexOrderStatuses(input: { limit?: number; fetchImpl?: FetchLike; now?: Date } = {}) {
  const now = input.now ?? new Date();
  const fetchImpl = input.fetchImpl ?? fetch;
  const report = { checked: 0, notices: 0, events: 0, errors: [] as string[] };
  const subs = await prisma.trackingSubscription.findMany({
    where: { completedAt: null, nextCheckAt: { lte: now }, storeKey: { in: VTEX_API_STORE_KEYS }, deliveryOrder: { status: { in: ["retailer_preparing", "retailer_out_for_delivery"] } } },
    include: { deliveryOrder: true },
    orderBy: { nextCheckAt: "asc" },
    take: Math.max(1, Math.min(25, input.limit ?? 10)),
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
      const store = VTEX_API_STORES[sub.storeKey];
      const r = await fetchImpl(`https://${store.domain}/api/checkout/pub/orders/order-group/${details.orderGroup}`, {
        headers: { Cookie: Object.entries(details.cookies).map(([k, v]) => `${k}=${v}`).join("; "), Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`loja HTTP ${r.status}`);
      const body = (await r.json()) as unknown;
      const first = (Array.isArray(body) ? body[0] : body) as Json | undefined;
      if (!first) throw new Error("pedido não encontrado na loja");
      const sig = readStoreOrder(first);
      const eta = etaTextFrom(sig.eta, now);
      const common = { source: "tracking_reader" as const, storeKey: sub.storeKey, storeOrderNumber: sub.storeOrderNumber, ...(sig.trackingUrl ? { trackingUrl: sig.trackingUrl } : {}) };
      const notes = order.notes ?? "";
      if (sig.state === "canceled") {
        if (!notes.includes(CANCELED_MARK)) {
          await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(order.notes, `${CANCELED_MARK} (status da loja em ${now.toISOString()}). Conferir reembolso da loja e estornar o cliente.`) } });
          const { notifyOwner } = await import("../turn-runtime");
          await notifyOwner(`🛑 A ${store.label} cancelou o pedido #${order.id.slice(-6).toUpperCase()} (${sub.storeOrderNumber}) depois da compra. Conferir o reembolso da loja e estornar o cliente no /ops.`, order.phone);
        }
        await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { completedAt: now, lastCheckedAt: now } });
        continue;
      }
      if (sig.delivered) {
        await recordDeliveryEvent(order.id, { ...common, kind: "delivered", sourceReference: `store-status:${details.orderGroup}:delivered`, occurredAt: sig.delivered < now ? sig.delivered : now });
        report.events += 1;
      } else if (sig.lastMile) {
        await recordDeliveryEvent(order.id, { ...common, kind: "out_for_delivery", sourceReference: `store-status:${details.orderGroup}:last-mile`, occurredAt: sig.lastMile < now ? sig.lastMile : now });
        report.events += 1;
      } else if (sig.shipped && order.status === "retailer_preparing") {
        await recordDeliveryEvent(order.id, { ...common, kind: "shipped", sourceReference: `store-status:${details.orderGroup}:shipped`, occurredAt: sig.shipped < now ? sig.shipped : now, ...(eta ? { etaText: eta } : {}) });
        report.events += 1;
      } else if (sig.state === "invoiced" && order.status === "retailer_preparing" && !notes.includes(INVOICED_MARK)) {
        const { deliverNotice } = await import("../turn-runtime");
        const copy = await import("../lia-copy");
        await deliverNotice(order.phone, copy.retailerInvoiced(store.label, eta), { items: order.items });
        await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(order.notes, `${INVOICED_MARK} em ${now.toISOString()}${eta ? ` — previsão ${eta}` : ""}.`) } });
        report.notices += 1;
      }
      // Mais perto da entrega, olhar mais vezes. Entrega rápida (Expressa 30 min, Drogal 08/10): a previsão
      // da loja nas próximas 2h — ou vencida há menos de 6h — olha a cada 5 min (o cron roda a cada 3);
      // antes eram 60 min fixos e a entrega de 30 min chegava antes da 2ª olhada.
      const etaAt = sig.eta ? Date.parse(sig.eta) : NaN;
      const soon = Number.isFinite(etaAt) && etaAt - now.getTime() < 2 * 3_600_000 && now.getTime() - etaAt < 6 * 3_600_000;
      const every = soon ? 5 : sig.lastMile || sig.shipped ? 20 : sig.state === "invoiced" ? 30 : 60;
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { nextCheckAt: new Date(now.getTime() + every * 60_000), lastCheckedAt: now, lastError: null, failures: 0, ...(sig.delivered ? { completedAt: now } : {}) } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${order.id.slice(-6)}: ${message}`);
      await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { lastCheckedAt: now, lastError: message.slice(0, 300), failures: { increment: 1 }, nextCheckAt: new Date(now.getTime() + Math.min(6 * 60, 30 * (sub.failures + 1)) * 60_000) } }).catch(() => undefined);
    }
  }
  return report;
}
