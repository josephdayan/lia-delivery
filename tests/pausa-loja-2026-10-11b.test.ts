// Pausa de loja (11/10/2026, g59). Produção: Mambo e Swift (pedido #W22GDO) foram pausadas pelo vigia às
// 05:00–06:00 UTC de 10/10 (madrugada em SP) por "parado em payment-approved além do prazo" e faturaram
// às 06:12 e 10:00 UTC, entregando no mesmo dia — alarme falso, loja fora da vitrine por mais de um dia.
// Regras: (1) a pausa do vigia cai sozinha quando o pedido que a causou anda na loja (a do dono nunca);
// (2) na entrega agendada/sem prazo a madrugada não conta e há um tempo mínimo de início;
// (3) lojas que nunca sinalizam (LIA_SILENT_STORES) não são pausadas por falta de sinal: só o dono sabe.
// O cancelamento automático (pedido à loja e aviso ao cliente) segue a régua de 09/10, sem mudança.
import "./helpers/load-env";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { businessMinutesBetween, inQuietHours, pollVtexOrderStatuses, stallMinStartMinutes, storeOrderHealth } from "../src/lib/purchase/vtex-status";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __resetPausedStoresForTests, isSilentStore, pauseRowActive, pauseStore, pausedStoresSnapshot, refreshPausedStores, resumeStoreIfPausedByOrder } from "../src/lib/store-pause";
import { storesForShopper } from "../src/lib/store-areas";

const OWNER = "+5511900001012";
const sent: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  sent.push({ to, text });
  return { provider: "test", to, text };
};
const users: string[] = [];
let dbOk = false;
const min = (n: number) => n * 60_000;
const ENV_KEYS = ["LIA_SILENT_STORES", "LIA_STALL_QUIET_HOURS", "LIA_STALL_MIN_START_MIN", "LIA_STALL_AUTO_CANCEL"];

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

// ---------- (2) relógio do vigia ----------

test("11/10: madrugada (22h–8h de SP) não conta no relógio; limite configurável", () => {
  // 21:00 SP (00:00 UTC) → 09:00 SP: só 21–22 e 8–9 contam = 120 min.
  assert.equal(businessMinutesBetween(new Date("2026-10-10T00:00:00Z"), new Date("2026-10-10T12:00:00Z")), 120);
  assert.equal(businessMinutesBetween(new Date("2026-10-10T14:30:00Z"), new Date("2026-10-10T15:00:00Z")), 30);
  assert.equal(inQuietHours(new Date("2026-10-10T05:30:00Z")), true); // 02:30 SP
  assert.equal(inQuietHours(new Date("2026-10-10T11:00:00Z")), false); // 08:00 SP
  assert.equal(inQuietHours(new Date("2026-10-11T00:59:00Z")), false); // 21:59 SP
  assert.equal(inQuietHours(new Date("2026-10-11T01:00:00Z")), true); // 22:00 SP
  process.env.LIA_STALL_QUIET_HOURS = "off";
  assert.equal(inQuietHours(new Date("2026-10-10T05:30:00Z")), false);
  assert.equal(businessMinutesBetween(new Date("2026-10-10T00:00:00Z"), new Date("2026-10-10T12:00:00Z")), 720);
  process.env.LIA_STALL_QUIET_HOURS = "23-6";
  assert.equal(inQuietHours(new Date("2026-10-10T09:30:00Z")), false); // 06:30 SP
  delete process.env.LIA_STALL_QUIET_HOURS;
  assert.equal(stallMinStartMinutes(), 120);
  process.env.LIA_STALL_MIN_START_MIN = "240";
  assert.equal(stallMinStartMinutes(), 240);
  process.env.LIA_STALL_MIN_START_MIN = "abc";
  assert.equal(stallMinStartMinutes(), 120);
  delete process.env.LIA_STALL_MIN_START_MIN;
});

test("11/10: caso Mambo/Swift — agendada com prazo vencido de madrugada não é 'parada' até 8h + tempo de início", () => {
  // Comprada 9/10 às 18:00 SP (21:00 UTC); a loja deu prazo 10/10 00:00 SP (03:00 UTC).
  const boughtAt = new Date("2026-10-09T21:00:00Z");
  const eta = "2026-10-10T03:00:00Z";
  const h = (iso: string) => storeOrderHealth({ state: "payment-approved", boughtAt, eta, now: new Date(iso) });
  // Antes: 05:00–06:00 UTC = "stalled" (a pausa de produção). Agora: madrugada não dispara.
  assert.equal(h("2026-10-10T05:00:00Z"), "ok");
  assert.equal(h("2026-10-10T06:00:00Z"), "ok");
  assert.equal(h("2026-10-10T10:59:00Z"), "ok"); // 07:59 SP
  // 08:00 SP: prazo vencido, fora da madrugada e já com 4 h úteis (18–22h) → aí sim parada.
  assert.equal(h("2026-10-10T11:00:00Z"), "stalled");
  // A loja faturou: nunca é parada.
  assert.equal(storeOrderHealth({ state: "invoiced", boughtAt, eta, now: new Date("2026-10-10T11:00:00Z") }), "ok");
});

test("11/10: tempo mínimo de início — comprada tarde, prazo curto de agenda: espera as horas úteis da manhã", () => {
  // Comprada às 21:30 SP (00:30 UTC), prazo 01:30 SP do dia seguinte (agendada > 3 h? não: 4 h).
  const boughtAt = new Date("2026-10-10T00:30:00Z");
  const eta = "2026-10-10T04:31:00Z";
  const h = (iso: string) => storeOrderHealth({ state: "payment-approved", boughtAt, eta, now: new Date(iso) });
  // 08:00 SP: só 30 min úteis (21:30–22:00) < 120.
  assert.equal(h("2026-10-10T11:00:00Z"), "ok");
  assert.equal(h("2026-10-10T12:29:00Z"), "ok");
  assert.equal(h("2026-10-10T12:30:00Z"), "stalled"); // 09:30 SP = 120 min úteis
  process.env.LIA_STALL_MIN_START_MIN = "60";
  assert.equal(h("2026-10-10T11:30:00Z"), "stalled");
  delete process.env.LIA_STALL_MIN_START_MIN;
});

test("11/10: sem prazo — 12 h úteis, e nunca de madrugada; Expressa segue a régua de 09/10 (loja aberta)", () => {
  const boughtAt = new Date("2026-10-09T22:49:00Z"); // 19:49 SP
  const at = (m: number) => new Date(boughtAt.getTime() + min(m));
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, now: at(12 * 60) }), "ok"); // 07:49 SP
  // 2h11 antes das 22h + 9h49 a partir das 8h = 12 h úteis às 17:49 SP.
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, now: at(21 * 60 + 59) }), "ok");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt, now: at(22 * 60) }), "stalled");
  // Expressa 30 min comprada às 23:00 SP: a loja prometeu entregar de madrugada, então está aberta.
  const late = new Date("2026-10-10T02:00:00Z");
  assert.equal(storeOrderHealth({ state: "payment-approved", boughtAt: late, eta: new Date(late.getTime() + min(30)).toISOString(), now: new Date(late.getTime() + min(21)) }), "stalled");
});

// ---------- (3) lojas que não sinalizam ----------

test("11/10: lojas que não sinalizam — Mambo e Cobasi por padrão, LIA_SILENT_STORES configura", () => {
  assert.equal(isSilentStore("mambo"), true);
  assert.equal(isSilentStore("cobasi"), true);
  assert.equal(isSilentStore("swift"), false);
  assert.equal(isSilentStore("drogal"), false);
  process.env.LIA_SILENT_STORES = "swift";
  assert.equal(isSilentStore("mambo"), false);
  assert.equal(isSilentStore("swift"), true);
  process.env.LIA_SILENT_STORES = "";
  assert.equal(isSilentStore("mambo"), false);
  delete process.env.LIA_SILENT_STORES;
  const reason = 'pedido #W22GDO (x) parado em "payment-approved" além do prazo';
  assert.equal(pauseRowActive({ key: "store_paused:mambo", value: reason, updatedBy: "vigia" }), false);
  assert.equal(pauseRowActive({ key: "store_paused:swift", value: reason, updatedBy: "vigia" }), true);
  assert.equal(pauseRowActive({ key: "store_paused:mambo", value: "pausada pelo dono", updatedBy: "wa:+5511999999999" }), true);
  assert.equal(pauseRowActive({ key: "store_paused:drogal", value: "off", updatedBy: "vigia" }), false);
});

async function boughtOrder(input: { phone: string; storeKey: string; storeLabel: string; storeOrderNumber: string; boughtMinutesAgo: number }) {
  const user = await prisma.user.create({ data: { phone: input.phone, name: "Cliente" } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "retailer_preparing", storeKey: "concierge", storeLabel: "Lia", storeOrderNumber: input.storeOrderNumber,
      items: [{ sku: `${input.storeKey}-1`, name: "Banana", qty: 1, unitPrice: 4.95, storeKey: input.storeKey, storeLabel: input.storeLabel }], itemsSubtotal: 4.95, total: 12.35,
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

function vtexReply(orderId: string, state: () => string, eta: string, calls: string[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("user-cancel-request")) return new Response("", { status: 200 });
    return new Response(JSON.stringify([{ orderId, state: state(), shippingData: { logisticsInfo: [{ shippingEstimateDate: eta }] } }]), { status: 200 });
  };
}

test("11/10: Mambo (não sinaliza) parada — não sai da vitrine nem alarma o cliente; dono avisado uma vez", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_STALL_QUIET_HOURS = "off"; // relógio fixo: o teste não depende da hora em que roda
  const phone = `+55101178${process.pid}1`;
  // Agendada: comprada há 6 h, prazo vencido há 1 h (parada, ainda longe da tolerância de cancelamento).
  const order = await boughtOrder({ phone, storeKey: "mambo", storeLabel: "Mambo", storeOrderNumber: "1669100000001-01", boughtMinutesAgo: 6 * 60 });
  const calls: string[] = [];
  const fetchImpl = vtexReply("1669100000001-01", () => "payment-approved", new Date(Date.now() - min(60)).toISOString(), calls);
  const tick = async () => {
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
    return pollVtexOrderStatuses({ fetchImpl });
  };
  const start = sent.length;
  const toCustomer = () => sent.slice(start).filter((m) => m.to === phone).map((m) => m.text);
  const toOwner = () => sent.slice(start).filter((m) => m.to === OWNER).map((m) => m.text);
  await tick();
  assert.equal(toCustomer().length, 0, "cliente não é alarmado");
  assert.equal(pausedStoresSnapshot().has("mambo"), false);
  assert.equal(await prisma.appFlag.findUnique({ where: { key: "store_paused:mambo" } }), null);
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0], /1669100000001-01.*payment-approved/);
  assert.match(toOwner()[0], /segue na vitrine/);
  assert.match(toOwner()[0], /lia loja mambo off/);
  assert.equal(calls.filter((c) => /user-cancel-request/.test(c)).length, 0);
  await tick();
  assert.equal(toOwner().length, 1, "aviso ao dono uma vez só");
  assert.equal(toCustomer().length, 0);
});

test("11/10: Mambo (não sinaliza) além da tolerância — o pedido de cancelamento à loja segue a régua de 09/10", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_STALL_QUIET_HOURS = "off";
  const phone = `+55101178${process.pid}2`;
  const order = await boughtOrder({ phone, storeKey: "mambo", storeLabel: "Mambo", storeOrderNumber: "1669100000002-01", boughtMinutesAgo: 30 * 60 });
  const calls: string[] = [];
  const fetchImpl = vtexReply("1669100000002-01", () => "payment-approved", new Date(Date.now() - min(13 * 60)).toISOString(), calls);
  await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
  const start = sent.length;
  await pollVtexOrderStatuses({ fetchImpl });
  assert.equal(calls.filter((c) => /user-cancel-request/.test(c)).length, 1, "cancelamento automático não mudou");
  const toCustomer = sent.slice(start).filter((m) => m.to === phone).map((m) => m.text);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0], /Pedi o cancelamento na loja/);
  assert.equal(pausedStoresSnapshot().has("mambo"), false, "mas a loja não sai da vitrine");
});

test("11/10: cancelamento automático não depende da madrugada (relógio corrido de 09/10)", async (t) => {
  if (!dbOk) return t.skip();
  // Madrugada o dia todo: o vigia não alarma, mas o pedido à loja sai como antes.
  process.env.LIA_STALL_QUIET_HOURS = "0-24";
  const phone = `+55101178${process.pid}3`;
  const order = await boughtOrder({ phone, storeKey: "swift", storeLabel: "Swift", storeOrderNumber: "1669100000003-01", boughtMinutesAgo: 30 * 60 });
  const calls: string[] = [];
  const fetchImpl = vtexReply("1669100000003-01", () => "payment-approved", new Date(Date.now() - min(13 * 60)).toISOString(), calls);
  await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
  await pollVtexOrderStatuses({ fetchImpl });
  assert.equal(calls.filter((c) => /user-cancel-request/.test(c)).length, 1);
  assert.equal(pausedStoresSnapshot().has("swift"), false, "vigia não pausa de madrugada");
});

// ---------- (1) despausa automática ----------

test("11/10: Swift pausada pelo vigia volta sozinha quando o pedido fatura; dono avisado uma vez", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_STALL_QUIET_HOURS = "off";
  const phone = `+55101178${process.pid}4`;
  const order = await boughtOrder({ phone, storeKey: "swift", storeLabel: "Swift", storeOrderNumber: "1669100000004-01", boughtMinutesAgo: 6 * 60 });
  let state = "payment-approved";
  const fetchImpl = vtexReply("1669100000004-01", () => state, new Date(Date.now() - min(60)).toISOString());
  const tick = async () => {
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
    return pollVtexOrderStatuses({ fetchImpl });
  };
  const start = sent.length;
  const toOwner = () => sent.slice(start).filter((m) => m.to === OWNER).map((m) => m.text);
  await tick();
  assert.ok(pausedStoresSnapshot().has("swift"), "Swift (sinaliza) parada sai da vitrine");
  assert.equal((await prisma.appFlag.findUniqueOrThrow({ where: { key: "store_paused:swift" } })).updatedBy, "vigia");
  const ownerBefore = toOwner().length;

  state = "invoiced";
  await tick();
  const flag = await prisma.appFlag.findUniqueOrThrow({ where: { key: "store_paused:swift" } });
  assert.equal(flag.value, "off");
  assert.equal(pausedStoresSnapshot().has("swift"), false);
  __resetPausedStoresForTests();
  await refreshPausedStores(true);
  assert.deepEqual(storesForShopper([{ key: "swift" }, { key: "drogal" }]).map((s) => s.key), ["swift", "drogal"]);
  const resumed = toOwner().slice(ownerBefore);
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /Swift voltou sozinha para a vitrine/);
  assert.match(resumed[0], /1669100000004-01/);
  assert.match(resumed[0], /lia loja swift off/);

  state = "handling";
  await tick();
  assert.equal(toOwner().slice(ownerBefore).length, 1, "aviso da volta uma vez só");
});

test("11/10: pausa do dono, de outro pedido ou com o pedido cancelado não cai sozinha", async (t) => {
  if (!dbOk) return t.skip();
  // Dono pausou à mão.
  await pauseStore("swift", "pausada pelo dono", `wa:${OWNER}`);
  assert.equal(await resumeStoreIfPausedByOrder("swift", "1669100000005-01"), false);
  assert.equal((await prisma.appFlag.findUniqueOrThrow({ where: { key: "store_paused:swift" } })).value, "pausada pelo dono");
  // Vigia pausou por OUTRO pedido.
  await pauseStore("drogal", 'pedido #GTGH3C (1669100000099-01) parado em "payment-approved" além do prazo', "vigia");
  assert.equal(await resumeStoreIfPausedByOrder("drogal", "1669100000005-01"), false);
  assert.equal(await resumeStoreIfPausedByOrder("drogal", "1669100000099-01"), true);
  assert.equal((await prisma.appFlag.findUniqueOrThrow({ where: { key: "store_paused:drogal" } })).value, "off");

  // Pedido cancelado pela loja não religa.
  process.env.LIA_STALL_QUIET_HOURS = "off";
  process.env.LIA_STALL_AUTO_CANCEL = "false";
  const phone = `+55101178${process.pid}5`;
  const order = await boughtOrder({ phone, storeKey: "drogal", storeLabel: "Drogal", storeOrderNumber: "1669100000006-01", boughtMinutesAgo: 6 * 60 });
  await pauseStore("drogal", `pedido #X (1669100000006-01) parado em "payment-approved" além do prazo`, "vigia");
  const fetchImpl = vtexReply("1669100000006-01", () => "canceled", new Date(Date.now() - min(60)).toISOString());
  await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
  await pollVtexOrderStatuses({ fetchImpl });
  assert.notEqual((await prisma.appFlag.findUniqueOrThrow({ where: { key: "store_paused:drogal" } })).value, "off");
});
