// Pausa de loja (11/10/2026, g62). Dados reais do pedido #W22GDO (UTC):
//   - Mambo 1667641377381-01: comprada 09/10 19:54:46 com a promessa "em até 3h (hoje, 13h–16h SP)",
//     janela que já tinha passado na compra (16:54 SP); alerta/pausa 10/10 08:00:26; faturou 09:12:26.
//   - Swift 1667645447969-01: comprada 09/10 19:54:41 com a promessa "em até 19h (amanhã, 6h–8h SP)"
//     = 10/10 09:00–11:00 UTC; alerta/pausa 10/10 09:00:26, no INÍCIO da janela; faturou 13:00:27.
// Régua do alerta/pausa: (1) o prazo é o FIM da janela + folga (LIA_STALL_WINDOW_GRACE_MIN, padrão 240);
// (2) janela já vencida na compra → a mesma janela no dia seguinte; prazo vencido sem janela → sem prazo.
// O cancelamento automático (stalledWallClock + stalledPastGrace) não muda.
import "./helpers/load-env";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { pollVtexOrderStatuses, readStoreOrder, stallAlertDeadline, stallWindowGraceMinutes, storeOrderHealth, windowFromEvidence } from "../src/lib/purchase/vtex-status";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __resetPausedStoresForTests, pausedStoresSnapshot } from "../src/lib/store-pause";

const OWNER = "+5511900001013";
const sent: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  sent.push({ to, text });
  return { provider: "test", to, text };
};
const users: string[] = [];
let dbOk = false;
const ENV_KEYS = ["LIA_SILENT_STORES", "LIA_STALL_QUIET_HOURS", "LIA_STALL_MIN_START_MIN", "LIA_STALL_AUTO_CANCEL", "LIA_STALL_WINDOW_GRACE_MIN"];

beforeEach(async () => {
  process.env.LIA_OWNER_PHONE = OWNER;
  process.env.LIA_ADMIN_PHONES = OWNER;
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await prisma.appFlag.deleteMany({ where: { key: { startsWith: "store_paused:" } } });
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
  __resetPausedStoresForTests();
});
after(async () => {
  delete process.env.LIA_OWNER_PHONE;
  delete process.env.LIA_ADMIN_PHONES;
  for (const k of ENV_KEYS) delete process.env[k];
  if (dbOk) {
    await prisma.appFlag.deleteMany({ where: { key: { startsWith: "store_paused:" } } });
    await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
    await prisma.message.deleteMany({ where: { conversation: { userId: { in: users } } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  await prisma.$disconnect();
});

const SWIFT_BOUGHT = new Date("2026-10-09T19:54:41Z");
const SWIFT_WINDOW = { start: "2026-10-10T09:00:00+00:00", end: "2026-10-10T10:59:59+00:00" };
const MAMBO_BOUGHT = new Date("2026-10-09T19:54:46Z");
const MAMBO_PROMISED = { start: "2026-10-09T16:00:00+00:00", end: "2026-10-09T18:59:59+00:00" };

test("11/10 (g62): Swift — o prazo da loja é o início da janela; o alerta espera o fim + folga", () => {
  const h = (iso: string, state = "payment-approved") => storeOrderHealth({ state, boughtAt: SWIFT_BOUGHT, eta: SWIFT_WINDOW.start, window: SWIFT_WINDOW, now: new Date(iso) });
  assert.equal(h("2026-10-10T09:00:26Z"), "ok", "início da janela (o alerta de produção)");
  assert.equal(h("2026-10-10T11:00:26Z"), "ok", "08:00 SP, fim da janela: ainda dentro da folga");
  assert.equal(h("2026-10-10T13:00:00Z"), "ok");
  assert.equal(h("2026-10-10T13:00:27Z", "invoiced"), "ok", "faturou");
  // Ainda sem começar 4 h depois do fim da janela: aí sim parada.
  assert.equal(h("2026-10-10T14:59:58Z"), "ok");
  assert.equal(h("2026-10-10T15:00:00Z"), "stalled");
  // Folga configurável.
  process.env.LIA_STALL_WINDOW_GRACE_MIN = "60";
  assert.equal(stallWindowGraceMinutes(), 60);
  assert.equal(h("2026-10-10T12:00:00Z"), "stalled");
  process.env.LIA_STALL_WINDOW_GRACE_MIN = "abc";
  assert.equal(stallWindowGraceMinutes(), 240);
});

test("11/10 (g62): Swift sem a janela no pedido da loja (só o prazo = início) seguia dando alarme às 08:00 SP", () => {
  // Régua do #34 só com o prazo da loja: madrugada segura até 11:00 UTC, depois 'stalled' — a Swift faturou 13:00.
  // A janela vem da evidência do fechamento (deliveryOption "[início→fim]") quando o pedido da loja não a traz.
  const window = windowFromEvidence({ deliveryOption: `swift-agendada [${SWIFT_WINDOW.start}→${SWIFT_WINDOW.end}]` });
  assert.deepEqual(window, SWIFT_WINDOW);
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt: SWIFT_BOUGHT, eta: SWIFT_WINDOW.start, window, now: new Date("2026-10-10T11:00:26Z") }), "ok");
  assert.equal(windowFromEvidence({ deliveryOption: "swift-normal" }), undefined);
  assert.equal(windowFromEvidence(null), undefined);
});

test("11/10 (g62): a janela vem do pedido na loja (logisticsInfo[].deliveryWindow)", () => {
  const sig = readStoreOrder({ state: "payment-approved", shippingData: { logisticsInfo: [{ shippingEstimateDate: SWIFT_WINDOW.start, deliveryWindow: { startDateUtc: SWIFT_WINDOW.start, endDateUtc: SWIFT_WINDOW.end } }] } });
  assert.deepEqual(sig.window, SWIFT_WINDOW);
  assert.equal(readStoreOrder({ state: "invoiced", shippingData: { logisticsInfo: [{ shippingEstimateDate: SWIFT_WINDOW.start, deliveryWindow: null }] } }).window, undefined);
});

test("11/10 (g62): Mambo — janela prometida já vencida na compra vira a mesma janela no dia seguinte", () => {
  const d = stallAlertDeadline({ boughtAt: MAMBO_BOUGHT, eta: MAMBO_PROMISED.start, window: MAMBO_PROMISED });
  assert.equal(d.kind, "deadline");
  // 10/10 13h–16h SP + 4 h de folga.
  assert.equal(d.kind === "deadline" && d.at.toISOString(), "2026-10-10T22:59:59.000Z");
  const h = (iso: string, state = "payment-approved") => storeOrderHealth({ state, boughtAt: MAMBO_BOUGHT, eta: MAMBO_PROMISED.start, window: MAMBO_PROMISED, now: new Date(iso) });
  assert.equal(h("2026-10-09T20:15:00Z"), "ok", "antes: prazo negativo = 'Expressa' parada em 20 min");
  assert.equal(h("2026-10-10T08:00:26Z"), "ok", "o alerta de produção");
  assert.equal(h("2026-10-10T09:12:26Z", "invoiced"), "ok");
  assert.equal(h("2026-10-10T23:00:00Z"), "stalled");
});

test("11/10 (g62): Mambo — prazo da loja já vencido na compra e sem janela: régua sem prazo (12 h úteis)", () => {
  assert.deepEqual(stallAlertDeadline({ boughtAt: MAMBO_BOUGHT, eta: MAMBO_PROMISED.start }), { kind: "none" });
  const h = (iso: string) => storeOrderHealth({ state: "payment-approved", boughtAt: MAMBO_BOUGHT, eta: MAMBO_PROMISED.start, now: new Date(iso) });
  assert.equal(h("2026-10-09T20:15:00Z"), "ok");
  assert.equal(h("2026-10-10T08:00:26Z"), "ok");
  // 16:54–22:00 SP = 306 min; faltam 414 min a partir das 8h SP → 14:54 SP = 17:54 UTC.
  assert.equal(h("2026-10-10T17:53:00Z"), "ok");
  assert.equal(h("2026-10-10T17:55:00Z"), "stalled");
  // Prazo da loja depois da compra (o que o pedido da Mambo mostrava: 10/10 08:00 UTC): a madrugada segura.
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt: MAMBO_BOUGHT, eta: "2026-10-10T08:00:00Z", now: new Date("2026-10-10T08:00:26Z") }), "ok");
});

test("11/10 (g62): Expressa e prazo comum sem janela seguem a régua de antes", () => {
  const boughtAt = new Date("2026-10-10T15:00:00Z");
  const eta30 = new Date(boughtAt.getTime() + 30 * 60_000).toISOString();
  assert.deepEqual(stallAlertDeadline({ boughtAt, eta: eta30 }), { kind: "fast", promiseMin: 30 });
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: eta30, now: new Date(boughtAt.getTime() + 21 * 60_000) }), "stalled");
  const eta6h = new Date(boughtAt.getTime() + 6 * 3_600_000).toISOString();
  assert.deepEqual(stallAlertDeadline({ boughtAt, eta: eta6h }), { kind: "deadline", at: new Date(eta6h) });
});

async function swiftOrder(phone: string, storeOrderNumber: string) {
  const user = await prisma.user.create({ data: { phone, name: "Cliente" } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "retailer_preparing", storeKey: "concierge", storeLabel: "Lia", storeOrderNumber,
      items: [{ sku: "swift-1", name: "Picanha", qty: 1, unitPrice: 89.9, storeKey: "swift", storeLabel: "Swift" }], itemsSubtotal: 89.9, total: 99.9,
      paidAt: new Date("2026-10-09T19:50:00Z"), courierKey: "retailer_delivery"
    }
  });
  const convo = await prisma.conversation.create({ data: { userId: user.id } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "oi" } });
  const job = await prisma.purchaseJob.create({
    data: {
      deliveryOrderId: order.id, fulfillmentKey: "swift", storeKey: "swift", storeLabel: "Swift", status: "completed", storeOrderNumber, completedAt: SWIFT_BOUGHT,
      checkoutEvidence: { deliveryOption: `agendada [${SWIFT_WINDOW.start}→${SWIFT_WINDOW.end}]`, deliveryPromise: "prazo da loja: em até 19h (amanhã, 6h–8h)" }
    }
  });
  const og = storeOrderNumber.replace(/-\d+$/, "");
  await prisma.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "vtex_order", status: "placed", idempotencyKey: `vtex-order:${og}`, details: { orderGroup: og, storeOrderNumber, cookies: { CheckoutDataAccess: "x" } } } });
  await prisma.trackingSubscription.create({ data: { deliveryOrderId: order.id, storeKey: "swift", storeOrderNumber } });
  return order;
}

test("11/10 (g62): Swift #W22GDO no vigia de verdade — sem pausa nem aviso até faturar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `+55101179${process.pid}1`;
  const storeOrderNumber = "1667645447969-01";
  const order = await swiftOrder(phone, storeOrderNumber);
  let state = "payment-approved";
  const calls: string[] = [];
  // O pedido na loja só traz o prazo (= início da janela); a janela vem da evidência do fechamento.
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("user-cancel-request")) return new Response("", { status: 200 });
    return new Response(JSON.stringify([{ orderId: storeOrderNumber, state, shippingData: { logisticsInfo: [{ shippingEstimateDate: SWIFT_WINDOW.start }] } }]), { status: 200 });
  };
  const tick = async (iso: string) => {
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
    return pollVtexOrderStatuses({ fetchImpl, now: new Date(iso) });
  };
  const start = sent.length;
  for (const iso of ["2026-10-09T20:10:00Z", "2026-10-10T09:00:26Z", "2026-10-10T11:00:26Z", "2026-10-10T12:00:00Z", "2026-10-10T13:00:00Z"]) await tick(iso);
  assert.equal(pausedStoresSnapshot().has("swift"), false, "Swift segue na vitrine");
  assert.equal(await prisma.appFlag.findUnique({ where: { key: "store_paused:swift" } }), null);
  assert.equal(sent.slice(start).length, 0, "ninguém alarmado");
  assert.equal(calls.filter((c) => /user-cancel-request/.test(c)).length, 0);
  state = "invoiced";
  await tick("2026-10-10T13:00:27Z");
  const notes = (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).notes ?? "";
  assert.doesNotMatch(notes, /LOJA NÃO COMEÇOU/);
  assert.match(notes, /Loja faturou/);
});

test("11/10 (g62): Swift que não começa até o fim da janela + folga — aí sim sai da vitrine", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `+55101179${process.pid}2`;
  const storeOrderNumber = "1667645447970-01";
  const order = await swiftOrder(phone, storeOrderNumber);
  const fetchImpl = async (url: string) => {
    if (url.includes("user-cancel-request")) return new Response("", { status: 200 });
    return new Response(JSON.stringify([{ orderId: storeOrderNumber, state: "payment-approved", shippingData: { logisticsInfo: [{ shippingEstimateDate: SWIFT_WINDOW.start }] } }]), { status: 200 });
  };
  await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
  await pollVtexOrderStatuses({ fetchImpl, now: new Date("2026-10-10T15:05:00Z") });
  assert.ok(pausedStoresSnapshot().has("swift"));
  const notes = (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).notes ?? "";
  assert.match(notes, /LOJA NÃO COMEÇOU/);
});
