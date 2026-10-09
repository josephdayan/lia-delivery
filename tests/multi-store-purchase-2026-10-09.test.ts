// Pedido de várias lojas (09/10/2026, dono: "pedido de duas coisas de lojas diferentes tem que fechar").
// Um trabalho de compra por loja dentro do mesmo pedido, um Pix de saída por loja com o seu valor,
// falha parcial devolvendo só a parte da loja que falhou, e acompanhamento/vigia por loja.
import "./helpers/load-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { recordPayment } from "../src/lib/payments/ledger";
import { savePurchaseAccount } from "../src/lib/purchase-execution";
import { ensurePurchaseJobsForPaidOrder } from "../src/lib/purchase-worker";
import { runVtexApiPurchases } from "../src/lib/purchase/vtex-runner";
import { pollVtexOrderStatuses } from "../src/lib/purchase/vtex-status";
import { watchPaidOrder } from "../src/lib/ops-lifecycle";
import { mockPixOutCalls } from "../src/lib/payments/pix-out/mock";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { aggregateOrderStatus, buildStoreFulfillments, storeScope, MULTI_STORE_TRACKING_KEY } from "../src/lib/purchase/store-split";
import { fakeVtex } from "./helpers/fake-vtex";

process.env.OPS_TOKEN ??= "unit-ops-token";
process.env.LIA_PIX_OUT_PROVIDER = "mock";
process.env.LIA_BUYER_DOCUMENT = "12.345.678/0001-99";
for (const k of ["LIA_PIX_OUT_OFF", "LIA_AUTO_PURCHASE_OFF", "LIA_PURCHASE_SUBMIT_OFF", "LIA_SERVER_BUYER_OFF", "LIA_PIX_OUT_MOCK_MODE"]) delete process.env[k];
const oldStores = process.env.LIA_AUTO_PURCHASE_STORES;
process.env.LIA_AUTO_PURCHASE_STORES = "drogariasp,mambo";

const sent: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  sent.push({ to, text });
  return { provider: "test", to, text };
};

const users: string[] = [];
let sequence = 0;
const DSP = { sku: "dsp-354260", name: "Sabonete Dove Creamy Comfort 90g", qty: 1, unitPrice: 5.39, lineTotal: 5.39, storeKey: "drogariasp", storeLabel: "Drogaria São Paulo", productUrl: "https://www.drogariasaopaulo.com.br/sabonete-dove/p" };
const MAMBO = { sku: "mambo-777", name: "Chocolate Lacta 80g", qty: 1, unitPrice: 9.9, lineTotal: 9.9, storeKey: "mambo", storeLabel: "Mambo", productUrl: "https://www.mambo.com.br/chocolate/p" };
const PROMISE = "pela própria loja · prazo da loja: 90 min";

async function multiOrder(overrides: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { phone: `+55090988${process.pid}${++sequence}`, name: "Joseph Teste" } });
  users.push(user.id);
  // Cliente dentro da janela de 24h do WhatsApp (os avisos saem como texto).
  const convo = await prisma.conversation.create({ data: { userId: user.id } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "oi" } });
  const items = [DSP, MAMBO];
  const total = 30.72;
  const fulfillments = buildStoreFulfillments(items, [
    { storeKey: "drogariasp", storeLabel: "Drogaria São Paulo", fee: 8.9, promise: PROMISE },
    { storeKey: "mambo", storeLabel: "Mambo", fee: 5, promise: PROMISE }
  ], total);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "paid", storeKey: "concierge", storeLabel: "Lia", customerName: "Joseph Teste",
      items, itemsSubtotal: 15.29, deliveryFee: 13.9, serviceFee: 1.53, total, cep: "01233-020",
      deliveryAddress: "Rua Engenheiro Edgar Egidio de Souza, 221 ap 13, Santa Cecília, São Paulo, SP",
      fulfillments, paidAt: new Date(Date.now() - 60_000), courierKey: "retailer_delivery", ...overrides
    }
  });
  await recordPayment({ deliveryOrderId: order.id, provider: "mercadopago", providerPaymentId: `8${process.pid}${String(sequence).padStart(4, "0")}${Date.now() % 100000}`, amountCents: 3072, status: "approved", method: "pix" });
  return order;
}

// Cada loja responde no seu domínio; o resto (CEP, cofre) vai para a primeira.
function router(a: ReturnType<typeof fakeVtex>, b: ReturnType<typeof fakeVtex>) {
  return async (url: string, init?: RequestInit) => (new URL(url).hostname === "www.mambo.com.br" ? b.fetchImpl(url, init) : a.fetchImpl(url, init));
}
const mamboSlas = [{ id: "EXPRESSA", price: 500, shippingEstimate: "90m" }];

after(async () => {
  if (oldStores === undefined) delete process.env.LIA_AUTO_PURCHASE_STORES; else process.env.LIA_AUTO_PURCHASE_STORES = oldStores;
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: users } } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.purchaseReceiver.deleteMany({ where: { storeKey: { in: ["drogariasp", "mambo"] } } });
  await prisma.purchaseAccount.deleteMany({ where: { storeKey: { in: ["drogariasp", "mambo"] } } });
  await prisma.$disconnect();
});

test("09/10: partes por loja somam o total ao centavo; status do pedido = loja mais atrasada", () => {
  const f = buildStoreFulfillments([DSP, MAMBO], [
    { storeKey: "drogariasp", storeLabel: "Drogaria São Paulo", fee: 8.9 },
    { storeKey: "mambo", storeLabel: "Mambo", fee: 5 }
  ], 30.72);
  assert.equal(f.length, 2);
  assert.equal(Math.round(f.reduce((s, x) => s + x.customerShare, 0) * 100), 3072);
  assert.equal(Math.round(f.reduce((s, x) => s + x.deliveryFee, 0) * 100), 1390);
  const order = { items: [DSP, MAMBO], fulfillments: f, deliveryFee: 13.9, itemsSubtotal: 15.29, total: 30.72 };
  const mambo = storeScope(order, "mambo")!;
  assert.equal(mambo.multi, true);
  assert.deepEqual(mambo.items.map((i) => i.sku), ["mambo-777"]);
  assert.equal(mambo.ceilingCents, 1490);
  assert.equal(storeScope({ ...order, fulfillments: [] }, "mambo"), null, "cesta de 2 lojas sem cotação por loja não vira compra");
  assert.equal(aggregateOrderStatus(["bought", "paid"]), "paid");
  assert.equal(aggregateOrderStatus(["bought", "delivered"]), "retailer_preparing");
  assert.equal(aggregateOrderStatus(["out_for_delivery", "delivered"]), "retailer_out_for_delivery");
  assert.equal(aggregateOrderStatus(["delivered", "delivered"]), "delivered");
});

test("09/10: duas lojas no mesmo pedido — um trabalho e um Pix de saída por loja, cada um com o seu valor; acompanhamento por loja", async () => {
  for (const storeKey of ["drogariasp", "mambo"]) await savePurchaseAccount({ storeKey, email: "compras@example.test", loginReady: true, paymentReady: true, enabled: true, paymentKind: "pix_out" });
  await prisma.purchaseSpend.updateMany({ data: { budgetDay: "2000-01-01" } });
  const order = await multiOrder();
  const jobs = await ensurePurchaseJobsForPaidOrder(order.id);
  assert.equal(jobs.length, 2);
  const byStore = Object.fromEntries(jobs.map((j) => [j.storeKey, j]));
  assert.equal(byStore.drogariasp.expectedTotal, 14.29);
  assert.equal(byStore.mambo.expectedTotal, 14.9);
  assert.equal(new Set(jobs.map((j) => j.fulfillmentKey)).size, 2);

  const a = fakeVtex({ orderGroup: `v${process.pid}0101dgsp` });
  const b = fakeVtex({ domain: "www.mambo.com.br", skuId: "777", priceCents: 990, slas: mamboSlas, orderGroup: `v${process.pid}0102mmb` });
  const pays = mockPixOutCalls.pay;
  const start = sent.length;
  const report = await runVtexApiPurchases({ maxJobs: 2, fetchImpl: router(a, b) as never });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.runs.map((r) => r.status), ["completed", "completed"], JSON.stringify(report.runs));
  assert.equal(mockPixOutCalls.pay, pays + 2, "um Pix de saída por loja");
  const payouts = await prisma.pixPayout.findMany({ where: { deliveryOrderId: order.id } });
  const storeOf = (id: string) => jobs.find((j) => j.id === id)?.storeKey;
  assert.deepEqual(Object.fromEntries(payouts.map((p) => [storeOf(p.purchaseJobId), p.amountCents])), { drogariasp: 1429, mambo: 1490 });
  const done = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(done.status, "retailer_preparing");
  assert.ok(done.storeOrderNumber, "número da primeira loja comprada");
  const toCustomer = sent.slice(start).filter((m) => m.to === order.phone).map((m) => m.text).join("\n---\n");
  assert.match(toCustomer, /Drogaria São Paulo/);
  assert.match(toCustomer, /Mambo/);
  const sub = await prisma.trackingSubscription.findUniqueOrThrow({ where: { deliveryOrderId: order.id } });
  assert.equal(sub.storeKey, MULTI_STORE_TRACKING_KEY);

  // Vigia por loja: a Drogaria entrega, a Mambo não começa. O pedido não fica "entregue" e o aviso
  // de loja parada é da Mambo.
  const eta = new Date(Date.now() - 5 * 60_000).toISOString();
  const later = new Date(Date.now() + 25 * 60_000);
  const statusFetch = async (url: string) => {
    const mambo = new URL(url).hostname === "www.mambo.com.br";
    const state = mambo ? "payment-approved" : "invoiced";
    const extra = mambo ? {} : { packageAttachment: { packages: [{ courierStatus: { finished: true, deliveredDate: new Date().toISOString() } }] }, isCompleted: true };
    return new Response(JSON.stringify([{ orderId: "x", state, shippingData: { logisticsInfo: [{ shippingEstimateDate: eta }] }, ...extra }]), { status: 200 });
  };
  await prisma.trackingSubscription.update({ where: { id: sub.id }, data: { nextCheckAt: new Date(0) } });
  const polled = await pollVtexOrderStatuses({ fetchImpl: statusFetch as never, now: later });
  assert.deepEqual(polled.errors, []);
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.notEqual(after1.status, "delivered", "uma loja só não fecha o pedido");
  assert.match(after1.notes ?? "", /\(Mambo\)/, "vigia marca a loja parada");
  assert.doesNotMatch(after1.notes ?? "", /\(Drogaria São Paulo\).*NÃO COMEÇOU/);
  const freshSub = await prisma.trackingSubscription.findUniqueOrThrow({ where: { id: sub.id } });
  assert.equal(freshSub.completedAt, null, "assinatura segue enquanto alguma loja não chegou");
});

test("09/10: falha parcial — a Mambo recusa depois do pagamento, só a parte dela volta, a Drogaria segue comprada", async () => {
  await prisma.purchaseSpend.updateMany({ data: { budgetDay: "2000-01-01" } });
  const order = await multiOrder();
  const a = fakeVtex({ orderGroup: `v${process.pid}0201dgsp` });
  const b = fakeVtex({ domain: "www.mambo.com.br", skuId: "777", priceCents: 990, slas: mamboSlas, available: false });
  const start = sent.length;
  const report = await runVtexApiPurchases({ maxJobs: 2, fetchImpl: router(a, b) as never });
  assert.deepEqual(report.errors, []);
  const jobs = await prisma.purchaseJob.findMany({ where: { deliveryOrderId: order.id } });
  const dsp = jobs.find((j) => j.storeKey === "drogariasp")!;
  const mambo = jobs.find((j) => j.storeKey === "mambo")!;
  assert.equal(dsp.status, "completed");
  assert.equal(mambo.status, "canceled");
  assert.equal(mambo.lastErrorCode, "STORE_SHARE_REFUNDED");
  const payment = await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: order.id } });
  const mamboShare = storeScope(order, "mambo")!.shareCents;
  assert.equal(payment.refundedCents, mamboShare, "devolve só a parte da Mambo");
  const fresh = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(fresh.status, "retailer_preparing", "a Drogaria segue");
  assert.match(fresh.notes ?? "", /Parte da Mambo devolvida/);
  const toCustomer = sent.slice(start).filter((m) => m.to === order.phone).map((m) => m.text).join("\n---\n");
  assert.match(toCustomer, /Mambo/);
  assert.match(toCustomer, /R\$ ?15,89/);
});

test("09/10: vigia do pago por loja — loja sem compra depois do prazo devolve só a parte dela; a outra continua", async () => {
  process.env.LIA_SERVER_BUYER_OFF = "true";
  try {
    const order = await multiOrder({ paidAt: new Date(Date.now() - 7 * 3_600_000) });
    const jobs = await ensurePurchaseJobsForPaidOrder(order.id);
    const dsp = jobs.find((j) => j.storeKey === "drogariasp")!;
    // A Drogaria já foi comprada; a Mambo ficou parada.
    await prisma.purchaseJob.update({ where: { id: dsp.id }, data: { status: "completed", storeOrderNumber: `v${process.pid}0301dgsp-01`, completedAt: new Date() } });
    await prisma.deliveryOrder.update({ where: { id: order.id }, data: { storeOrderNumber: `v${process.pid}0301dgsp-01` } });
    assert.equal(await watchPaidOrder(order.id), "auto_refunded");
    const payment = await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: order.id } });
    assert.equal(payment.refundedCents, storeScope(order, "mambo")!.shareCents);
    const mambo = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: order.id, storeKey: "mambo" } });
    assert.equal(mambo.status, "canceled");
    assert.equal((await prisma.purchaseJob.findUniqueOrThrow({ where: { id: dsp.id } })).status, "completed");
    // Segunda passada não devolve de novo.
    await watchPaidOrder(order.id);
    assert.equal((await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: order.id } })).refundedCents, storeScope(order, "mambo")!.shareCents);
  } finally {
    delete process.env.LIA_SERVER_BUYER_OFF;
  }
});
