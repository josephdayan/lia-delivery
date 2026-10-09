// Pedido comprado que a loja não começa (09/10/2026). Caso real: Drogal, Expressa 30 min, comprado e
// com Pix pago às 19:49 de 08/10 — ficou 13 h em "payment-approved", ninguém soube, nada chegou.
// Regra: o vigia percebe em ~20 min, conta a verdade ao cliente, avisa o dono e tira a loja da vitrine
// até o dono mandar "lia loja <loja> on". Loja que anda normalmente não dispara nada.
import "./helpers/load-env";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { pollVtexOrderStatuses, storeOrderHealth } from "../src/lib/purchase/vtex-status";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __resetPausedStoresForTests, parseStoreToggleCommand, pausedStoresSnapshot, refreshPausedStores, resumeStore } from "../src/lib/store-pause";
import { storesForShopper } from "../src/lib/store-areas";
import { handleOperatorInbound } from "../src/lib/ops-actions-inbound";

const OWNER = "+5511900000909";
const sent: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  sent.push({ to, text });
  return { provider: "test", to, text };
};
const users: string[] = [];
let dbOk = false;

beforeEach(async () => {
  process.env.LIA_OWNER_PHONE = OWNER;
  process.env.LIA_ADMIN_PHONES = OWNER;
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
  if (dbOk) {
    await prisma.appFlag.deleteMany({ where: { key: { startsWith: "store_paused:" } } });
    await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
    await prisma.message.deleteMany({ where: { conversation: { userId: { in: users } } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  await prisma.$disconnect();
});

const min = (n: number) => n * 60_000;

test("09/10: saúde do pedido na loja — Expressa parada em 20 min, entrega longa só depois do prazo, loja andando = ok", () => {
  const boughtAt = new Date("2026-10-08T22:49:00Z");
  const eta30 = "2026-10-08T23:19:34Z";
  const at = (m: number) => new Date(boughtAt.getTime() + min(m));
  // O caso da Drogal.
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: eta30, now: at(10) }), "ok");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: eta30, now: at(21) }), "stalled");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: eta30, now: at(13 * 60) }), "stalled");
  assert.equal(storeOrderHealth({ state: "window-to-cancel", boughtAt, eta: eta30, now: at(25) }), "stalled");
  // A loja começou: não é parada; passou 1 h do prazo sem entrega = atraso (só o dono é avisado).
  assert.equal(storeOrderHealth({ state: "handling", boughtAt, eta: eta30, now: at(40) }), "ok");
  assert.equal(storeOrderHealth({ state: "handling", boughtAt, eta: eta30, now: at(95) }), "late");
  assert.equal(storeOrderHealth({ state: "invoiced", boughtAt, eta: eta30, now: at(95), delivered: true }), "ok");
  // Entrega longa (Mambo, janela no dia seguinte): pré-separação por horas é normal até o prazo.
  const etaTomorrow = new Date(boughtAt.getTime() + min(20 * 60)).toISOString();
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: etaTomorrow, now: at(6 * 60) }), "ok");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, eta: etaTomorrow, now: at(20 * 60 + 1) }), "stalled");
  assert.equal(storeOrderHealth({ state: "invoiced", boughtAt, eta: etaTomorrow, now: at(20 * 60 + 30) }), "ok");
  // Sem prazo conhecido: 12 h.
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, now: at(11 * 60) }), "ok");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, now: at(12 * 60) }), "stalled");
  // Cancelada pela loja tem o caminho próprio.
  assert.equal(storeOrderHealth({ state: "canceled", boughtAt, eta: eta30, now: at(200) }), "ok");
});

test("09/10: comando do dono 'lia loja <loja> on|off'", () => {
  assert.deepEqual(parseStoreToggleCommand("lia loja drogal on"), { storeKey: "drogal", on: true });
  assert.deepEqual(parseStoreToggleCommand("Lia loja Drogal religar"), { storeKey: "drogal", on: true });
  assert.deepEqual(parseStoreToggleCommand("lia loja drogal off"), { storeKey: "drogal", on: false });
  assert.deepEqual(parseStoreToggleCommand("lia loja mambo pausar"), { storeKey: "mambo", on: false });
  assert.equal(parseStoreToggleCommand("loja drogal on"), null);
  assert.equal(parseStoreToggleCommand("lia offline"), null);
});

async function boughtOrder(input: { phone: string; storeKey: string; storeLabel: string; storeOrderNumber: string; boughtMinutesAgo: number }) {
  const user = await prisma.user.create({ data: { phone: input.phone, name: "Cliente" } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "retailer_preparing", storeKey: "concierge", storeLabel: "Lia", storeOrderNumber: input.storeOrderNumber,
      items: [{ sku: `${input.storeKey}-1`, name: "Chocolate", qty: 1, unitPrice: 4.95, storeKey: input.storeKey, storeLabel: input.storeLabel }], itemsSubtotal: 4.95, total: 12.35,
      paidAt: new Date(Date.now() - min(input.boughtMinutesAgo + 1)), courierKey: "retailer_delivery"
    }
  });
  const convo = await prisma.conversation.create({ data: { userId: user.id } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "oi" } });
  const job = await prisma.purchaseJob.create({
    data: { deliveryOrderId: order.id, fulfillmentKey: input.storeKey, storeKey: input.storeKey, storeLabel: input.storeLabel, status: "completed", storeOrderNumber: input.storeOrderNumber, completedAt: new Date(Date.now() - min(input.boughtMinutesAgo)) }
  });
  const og = input.storeOrderNumber.replace(/-\d+$/, "");
  await prisma.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "vtex_order", status: "placed", idempotencyKey: `vtex-order:${og}`, details: { orderGroup: og, storeOrderNumber: input.storeOrderNumber, cookies: { CheckoutDataAccess: "x" } } } });
  await prisma.trackingSubscription.create({ data: { deliveryOrderId: order.id, storeKey: input.storeKey, storeOrderNumber: input.storeOrderNumber } });
  return order;
}

test("09/10: Drogal parada — cliente avisado, dono avisado, loja fora da vitrine; uma vez só; 'lia loja drogal on' religa", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `+55090977${process.pid}1`;
  const order = await boughtOrder({ phone, storeKey: "drogal", storeLabel: "Drogal", storeOrderNumber: "1667434680238-01", boughtMinutesAgo: 25 });
  const eta = new Date(Date.now() + min(5)).toISOString();
  const fetchImpl = async () => new Response(JSON.stringify([{ orderId: "1667434680238-01", state: "payment-approved", shippingData: { logisticsInfo: [{ shippingEstimateDate: eta }] } }]), { status: 200 });
  const tick = async () => {
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
    return pollVtexOrderStatuses({ fetchImpl });
  };
  const toCustomer = () => sent.filter((m) => m.to === phone).map((m) => m.text);
  const toOwner = () => sent.filter((m) => m.to === OWNER).map((m) => m.text);

  await tick();
  assert.equal(toCustomer().length, 1, "cliente avisado");
  assert.match(toCustomer()[0], /Drogal ainda não começou a separar seu pedido \*#[A-Z0-9]{6}\*/);
  assert.match(toCustomer()[0], /dinheiro de volta/);
  assert.equal(toOwner().length, 1, "dono avisado");
  assert.match(toOwner()[0], /não começou o pedido .*1667434680238-01/);
  assert.match(toOwner()[0], /saiu da vitrine .*lia loja drogal on/);
  const notes = (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).notes ?? "";
  assert.match(notes, /LOJA NÃO COMEÇOU O PEDIDO/);

  // Fora da vitrine (este processo e qualquer outro que reler o banco).
  assert.ok(pausedStoresSnapshot().has("drogal"));
  __resetPausedStoresForTests();
  await refreshPausedStores(true);
  const keys = storesForShopper([{ key: "drogal" }, { key: "mambo" }]).map((s) => s.key);
  assert.deepEqual(keys, ["mambo"]);

  // Segunda olhada: nada repetido.
  await tick();
  assert.equal(toCustomer().length, 1);
  assert.equal(toOwner().length, 1);

  // O dono religa pelo WhatsApp.
  const handled = await handleOperatorInbound(OWNER, "lia loja drogal on");
  assert.equal(handled, "handled");
  assert.match(toOwner().at(-1)!, /drogal de volta na vitrine/);
  __resetPausedStoresForTests();
  await refreshPausedStores(true);
  assert.deepEqual(storesForShopper([{ key: "drogal" }, { key: "mambo" }]).map((s) => s.key), ["drogal", "mambo"]);
});

test("09/10: loja que anda normalmente (Expressa começada a tempo) não dispara nada e continua na vitrine", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `+55090977${process.pid}2`;
  const order = await boughtOrder({ phone, storeKey: "mambo", storeLabel: "Mambo", storeOrderNumber: "1666621374623-01", boughtMinutesAgo: 25 });
  const start = sent.length;
  const eta = new Date(Date.now() + min(5)).toISOString();
  const fetchImpl = async () => new Response(JSON.stringify([{ orderId: "1666621374623-01", state: "handling", shippingData: { logisticsInfo: [{ shippingEstimateDate: eta }] } }]), { status: 200 });
  await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
  await pollVtexOrderStatuses({ fetchImpl });
  assert.equal(sent.slice(start).filter((m) => m.to === phone || m.to === OWNER).length, 0);
  assert.equal(pausedStoresSnapshot().has("mambo"), false);
  await resumeStore("mambo", "teste");
});
