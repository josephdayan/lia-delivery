// Ensaio da compra antes de cobrar + simulação com as coordenadas do endereço (08/10/2026, noite).
// Caso real: a vitrine prometeu TURBO 30 min (Drogarias Pacheco) pela simulação só por CEP; a compra
// mandou as coordenadas do endereço, a TURBO sumiu, o cliente foi cobrado e estornado.
import "./helpers/load-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { rehearsePurchase, type RehearsalOrder } from "../src/lib/purchase/rehearsal";
import { __setSimulationGeoForTests, liveItemAvailability } from "../src/lib/live-freight";
import { fakeVtex } from "./helpers/fake-vtex";

let dbOk = true;
const env = { ...process.env };
before(async () => {
  process.env.LIA_AUTO_PURCHASE_STORES = "drogariasp";
  process.env.LIA_PURCHASE_REHEARSAL = "true";
  process.env.LIA_SERVER_BUYER_OFF = "false";
  process.env.LIA_BUYER_DOCUMENT = "12345678000199";
  try {
    await prisma.purchaseAccount.upsert({
      where: { storeKey: "drogariasp" },
      create: { storeKey: "drogariasp", label: "Drogaria SP", email: "compras@example.test", enabled: true, loginReady: true, paymentReady: true },
      update: { email: "compras@example.test" }
    });
  } catch {
    dbOk = false;
  }
});
after(async () => {
  for (const key of ["LIA_AUTO_PURCHASE_STORES", "LIA_BUYER_DOCUMENT", "LIA_LIVE_FREIGHT_OFF", "LIA_SIM_GEO", "LIA_PURCHASE_REHEARSAL", "LIA_SERVER_BUYER_OFF"]) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  if (dbOk) await prisma.purchaseAccount.deleteMany({ where: { storeKey: "drogariasp" } }).catch(() => undefined);
  __setSimulationGeoForTests(null);
});

const order = (promise: string): RehearsalOrder => ({
  id: "ord-rehearsal",
  cep: "01233-020",
  deliveryAddress: "Rua Engenheiro Edgar Egidio de Souza, 221 ap 13, Santa Cecília, São Paulo, SP",
  customerName: "Joseph Teste",
  phone: "5511999990000",
  buyerDocument: null,
  buyerName: null,
  items: [{ sku: "dsp-354260", name: "Sabonete Dove", qty: 1, storeKey: "drogariasp", storeLabel: "Drogaria São Paulo" }],
  fulfillments: [{ deliveryPromise: `pela própria loja · prazo da loja: ${promise}` }]
});

test("ensaio: a entrega prometida existe → pode cobrar; a cesta é esvaziada e nada é fechado", async (t) => {
  if (!dbOk) return t.skip();
  const fake = fakeVtex();
  assert.equal(await rehearsePurchase(order("90 min"), fake.fetchImpl), null);
  assert.ok(fake.calls.some((c) => c.url.endsWith("/items/removeAll")), "cesta esvaziada");
  assert.ok(!fake.calls.some((c) => /\/transaction|vtexvault/.test(c.url)), "nunca fecha o pedido");
  const ship = fake.calls.find((c) => c.url.endsWith("/attachments/shippingData"))!.body as { selectedAddresses: Record<string, unknown>[] };
  assert.ok(Array.isArray(ship.selectedAddresses[0].geoCoordinates), "o ensaio manda as coordenadas, como a compra");
});

test("ensaio: prometeu 30 min e a loja só tem 90 min pro endereço (caso TURBO) → NÃO cobra (delivery)", async (t) => {
  if (!dbOk) return t.skip();
  const fail = await rehearsePurchase(order("30 min"), fakeVtex().fetchImpl);
  assert.equal(fail?.kind, "delivery");
  assert.deepEqual(fail?.skus, ["dsp-354260"]);
});

test("ensaio: item indisponível na cesta com endereço → NÃO cobra (items)", async (t) => {
  if (!dbOk) return t.skip();
  const fail = await rehearsePurchase(order("90 min"), fakeVtex({ available: false }).fetchImpl);
  assert.equal(fail?.kind, "items");
});

test("ensaio: loja fora do ar/timeout não inventa recusa (cobra como antes)", async (t) => {
  if (!dbOk) return t.skip();
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await rehearsePurchase(order("90 min"), down as never), null);
  const five = fakeVtex({ transactionStatus: 403 });
  const flaky = async (url: string, init?: RequestInit) => (url.includes("/orderForm") && !url.includes("/items") ? new Response("busy", { status: 503 }) : five.fetchImpl(url, init));
  assert.equal(await rehearsePurchase(order("90 min"), flaky as never), null);
});

test("ensaio: loja sem conta de compra automática não é ensaiada (vai pra fila manual)", async (t) => {
  if (!dbOk) return t.skip();
  const o = order("90 min");
  o.items = [{ ...o.items[0], storeKey: "cobasi", sku: "cobasi-1" }];
  assert.equal(await rehearsePurchase(o, fakeVtex().fetchImpl), null);
});

test("simulação da vitrine/cotação manda as MESMAS coordenadas que a compra (geoCoordinates [lng, lat])", async () => {
  process.env.LIA_LIVE_FREIGHT_OFF = "false";
  process.env.LIA_SIM_GEO = "true";
  __setSimulationGeoForTests(async () => ({ lat: -23.5475, lng: -46.63611 }));
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ items: [{ id: "123", availability: "available", sellingPrice: 300 }], logisticsInfo: [{ itemIndex: 0, slas: [{ id: "NORMAL", price: 690, shippingEstimate: "1bd", deliveryChannel: "delivery" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await liveItemAvailability("mambo", ["mambo-123"], "01233020");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(bodies.length >= 1);
  assert.deepEqual(bodies[0].geoCoordinates, [-46.63611, -23.5475]);
  assert.equal(bodies[0].postalCode, "01233020");
});
