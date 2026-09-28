import "./helpers/load-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { recordPayment } from "../src/lib/payments/ledger";
import { savePurchaseAccount, heldPixCode } from "../src/lib/purchase-execution";
import { runVtexApiPurchases, finishPendingVtexOrders, SERVER_BUYER_ID } from "../src/lib/purchase/vtex-runner";
import { mockPixOutCalls } from "../src/lib/payments/pix-out/mock";
import { opsActionButtonId } from "../src/lib/ops-actions";
import { handleOperatorInbound } from "../src/lib/ops-actions-inbound";
import { readStoreMailOnce } from "../src/lib/store-mail-reader";
import { fakeVtex } from "./helpers/fake-vtex";

process.env.OPS_TOKEN ??= "unit-ops-token";
process.env.LIA_OPERATOR_PHONE = "+5511999990000";
process.env.LIA_PIX_OUT_PROVIDER = "mock";
process.env.LIA_BUYER_DOCUMENT = "12.345.678/0001-99";
for (const k of ["LIA_PIX_OUT_OFF", "LIA_AUTO_PURCHASE_OFF", "LIA_PURCHASE_SUBMIT_OFF", "LIA_SERVER_BUYER_OFF", "LIA_PIX_OUT_MOCK_MODE"]) delete process.env[k];
const OPERATOR = "+5511999990000";
const STORE = "drogariasp";
const RECEIVER = "12345678000199";
const users: string[] = [];
let sequence = 0;

async function paidOrder(overrides: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { phone: `+55090966${process.pid}${++sequence}`, name: "Joseph Teste" } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "paid", storeKey: STORE, storeLabel: "Drogaria São Paulo", customerName: "Joseph Teste",
      items: [{ sku: "dsp-354260", name: "Sabonete Dove Creamy Comfort 90g", qty: 1, unitPrice: 5.39, lineTotal: 5.39, storeKey: STORE, storeLabel: "Drogaria São Paulo", productUrl: "https://www.drogariasaopaulo.com.br/sabonete-dove/p" }],
      itemsSubtotal: 5.39, deliveryFee: 8.9, serviceFee: 0.54, total: 14.83, cep: "01233-020",
      deliveryAddress: "Rua Engenheiro Edgar Egidio de Souza, 221 ap 13, Santa Cecília, São Paulo, SP",
      fulfillments: [{ storeKey: STORE, deliveryPromise: "pela própria loja · prazo da loja: 90 min" }],
      paidAt: new Date(Date.now() - 60_000), courierKey: "retailer_delivery", ...overrides,
    },
  });
  await recordPayment({ deliveryOrderId: order.id, provider: "mercadopago", providerPaymentId: `9${process.pid}${String(sequence).padStart(4, "0")}${Date.now() % 100000}`, amountCents: 1483, status: "approved", method: "pix" });
  return order;
}
const oldStores = process.env.LIA_AUTO_PURCHASE_STORES;
process.env.LIA_AUTO_PURCHASE_STORES = STORE;
after(async () => {
  if (oldStores === undefined) delete process.env.LIA_AUTO_PURCHASE_STORES; else process.env.LIA_AUTO_PURCHASE_STORES = oldStores;
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.purchaseReceiver.deleteMany({ where: { storeKey: STORE } });
  await prisma.purchaseAccount.deleteMany({ where: { storeKey: STORE } });
  await prisma.storeMailSeen.deleteMany({ where: { messageId: { startsWith: "t-" } } });
  await prisma.$disconnect();
});

test("pedido pago → comprador no servidor fecha na loja, guarda o Pix para o toque do dono, dono toca, paga, compra registrada", async () => {
  await savePurchaseAccount({ storeKey: STORE, email: "compras@example.test", loginReady: true, paymentReady: true, enabled: true, paymentKind: "pix_out" });
  await prisma.purchaseSpend.updateMany({ data: { budgetDay: "2000-01-01" } });
  const order = await paidOrder();
  const fake = fakeVtex({ orderGroup: `v${process.pid}00001dgsp` });
  const before = mockPixOutCalls.pay;
  const report = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: fake.fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].status, "awaiting_receiver", JSON.stringify(report.runs[0]));
  assert.equal(mockPixOutCalls.pay, before, "recebedor novo: sem toque do dono não sai dinheiro");
  const job = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: order.id } });
  assert.equal(job.status, "pix_captured");
  assert.equal(job.browserSessionId, SERVER_BUYER_ID);
  const evidence = job.checkoutEvidence as { totalCents: number; deliveryOption: string };
  assert.equal(evidence.totalCents, 1429);
  assert.equal(evidence.deliveryOption, "SUPER EXPRESSA");
  assert.ok(await heldPixCode(job.id), "copia-e-cola guardado para o toque");
  const placed = await prisma.purchaseAttempt.findFirstOrThrow({ where: { purchaseJobId: job.id, step: "vtex_order" } });
  assert.equal((placed.details as { storeOrderNumber: string }).storeOrderNumber, `v${process.pid}00001dgsp-01`);
  // Dono toca "Pagar e memorizar": o servidor paga com o código guardado (sem navegador).
  const action = await prisma.opsAction.findFirstOrThrow({ where: { purchaseJobId: job.id, kind: "receiver_new", status: "pending" } });
  assert.equal(await handleOperatorInbound(OPERATOR, opsActionButtonId(action, "pay")!), "handled");
  assert.equal(mockPixOutCalls.pay, before + 1);
  assert.equal((await prisma.purchaseJob.findUniqueOrThrow({ where: { id: job.id } })).status, "pix_paid");
  // Próxima passada do cron registra a compra com o número da loja e avisa o cliente.
  assert.equal(await finishPendingVtexOrders(), 1);
  const done = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(done.status, "retailer_preparing");
  assert.equal(done.storeOrderNumber, `v${process.pid}00001dgsp-01`);
  assert.equal((await prisma.purchaseJob.findUniqueOrThrow({ where: { id: job.id } })).status, "completed");
  // E-mail "Pagamento foi aprovado" da loja: lido no servidor, deduplicado, sem tocar o pedido já comprado.
  const mailId = `t-${process.pid}-1`;
  const reader = { listRecent: async () => [mailId], read: async () => ({ id: mailId, from: '"Drogaria São Paulo" <pedidos@drogariasaopaulo.com.br>', subject: "Drogaria São Paulo | Pagamento foi aprovado", text: `Confirmamos o pagamento do seu pedido v${process.pid}00001dgsp-01 :)`, receivedAt: Date.now() }) };
  process.env.LIA_GMAIL_CLIENT_ID = "x"; process.env.LIA_GMAIL_CLIENT_SECRET = "y"; process.env.LIA_GMAIL_REFRESH_TOKEN = "z";
  const first = await readStoreMailOnce(reader as never);
  assert.equal(first.checked, 1, JSON.stringify(first)); assert.equal(first.reported, 1, JSON.stringify(first)); assert.equal(first.matched, 1, JSON.stringify(first));
  const again = await readStoreMailOnce(reader as never);
  assert.equal(again.checked, 0, "mensagem vista não é reportada de novo");
  assert.match((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).notes ?? "", /📧 paid/);
});

test("recebedor já memorizado: compra inteira sem nenhum toque; 403 no fechamento devolve para revisão e libera o orçamento", async () => {
  await prisma.purchaseSpend.updateMany({ data: { budgetDay: "2000-01-01" } });
  await prisma.purchaseReceiver.upsert({ where: { storeKey_receiverDoc: { storeKey: STORE, receiverDoc: RECEIVER } }, create: { storeKey: STORE, receiverDoc: RECEIVER, receiverName: "DROGARIA SAO PAULO SA", status: "approved" }, update: { status: "approved" } });
  const order = await paidOrder();
  const before = mockPixOutCalls.pay;
  const report = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: fakeVtex({ orderGroup: `v${process.pid}00002dgsp` }).fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.equal(report.runs[0]?.status, "completed", JSON.stringify(report.runs));
  assert.equal(mockPixOutCalls.pay, before + 1);
  const done = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(done.status, "retailer_preparing");
  assert.equal(done.storeOrderNumber, `v${process.pid}00002dgsp-01`);
  // reCAPTCHA no fechamento: nada criado, nada pago, orçamento liberado, job em revisão.
  const blocked = await paidOrder();
  const captcha = fakeVtex({ transactionStatus: 403 });
  const r2 = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: captcha.fetchImpl });
  assert.equal(r2.runs[0]?.status, "needs_review", JSON.stringify(r2.runs));
  assert.equal(mockPixOutCalls.pay, before + 1, "recusa não paga nada");
  const job = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: blocked.id } });
  // Recusa ANTES do pedido = estorno na mesma passada (regra 25/09): job cancelado, cliente estornado.
  assert.equal(job.status, "canceled");
  assert.equal(job.lastErrorCode, "VTEX_RECAPTCHA_REQUIRED");
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: blocked.id } })).status, "refunded");
  assert.equal((await prisma.purchaseSpend.findFirstOrThrow({ where: { purchaseJobId: job.id } })).status, "released");
  assert.ok(captcha.calls.some((c) => c.url.endsWith("/items/removeAll")));
  // Recusa antes do pedido = estorno automático no mesmo tick (pagamento mockado sem provedor
  // real: o ledger recusa; o teste prova que a regra ESCOLHE estornar e que pedido velho não).
  const { refundableServerFailure } = await import("../src/lib/purchase/vtex-runner");
  assert.equal(refundableServerFailure("VTEX_RECAPTCHA_REQUIRED"), true);
  assert.equal(refundableServerFailure("VTEX_TRANSACTION_400"), true);
  assert.equal(refundableServerFailure("VTEX_ITEMS"), true);
  assert.equal(refundableServerFailure("STALE_PAID_ORDER"), false);
  assert.equal(refundableServerFailure("PIX_CAPTURE_REFUSED"), false);
  assert.equal(refundableServerFailure(null), false);
  // Item sem estoque: falha antes de reservar; cesta esvaziada; revisão com motivo.
  const gone = await paidOrder();
  const out = fakeVtex({ available: false });
  const r3 = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: out.fetchImpl });
  assert.equal(r3.runs[0]?.status, "needs_review");
  const j3 = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: gone.id } });
  assert.equal(j3.lastErrorCode, "VTEX_ITEMS");
  assert.equal(await prisma.purchaseSpend.count({ where: { purchaseJobId: j3.id } }), 0);
  // Pedido pago há dias (compra à mão não registrada): revisão, sem tocar a loja nem pagar.
  const stale = await paidOrder({ paidAt: new Date(Date.now() - 3 * 86_400_000) });
  const untouched = fakeVtex({ orderGroup: `v${process.pid}00009dgsp` });
  const r4 = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: untouched.fetchImpl });
  assert.equal(r4.runs[0]?.status, "needs_review", JSON.stringify(r4.runs));
  const j4 = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: stale.id } });
  assert.equal(j4.lastErrorCode, "STALE_PAID_ORDER");
  assert.equal(untouched.calls.length, 0, "loja não é chamada para pedido velho");
  assert.equal(mockPixOutCalls.pay, before + 1);
  // Kill-switch do comprador do servidor.
  process.env.LIA_SERVER_BUYER_OFF = "true";
  assert.equal((await runVtexApiPurchases({ maxJobs: 1 })).enabled, false);
  delete process.env.LIA_SERVER_BUYER_OFF;
});

test("Pix da loja recusado na conferência: motivo gravado, nenhum pagamento sai e o cliente é estornado na passada seguinte", async () => {
  await prisma.purchaseSpend.updateMany({ data: { budgetDay: "2000-01-01" } });
  const order = await paidOrder();
  const before = mockPixOutCalls.pay;
  // Loja emite Pix com valor diferente do conferido: a conferência recusa antes de pagar.
  const r1 = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: fakeVtex({ orderGroup: `v${process.pid}00007dgsp`, pixAmount: "99.99" }).fetchImpl });
  assert.equal(r1.runs[0]?.status, "outcome_unknown", JSON.stringify(r1.runs));
  assert.match(r1.runs[0]?.detail ?? "", /Valor do Pix/);
  const job = await prisma.purchaseJob.findFirstOrThrow({ where: { deliveryOrderId: order.id } });
  const refused = await prisma.purchaseAttempt.findFirstOrThrow({ where: { purchaseJobId: job.id, step: "pix_capture", status: "refused" } });
  assert.match(refused.errorMessage ?? "", /Valor do Pix/);
  assert.equal(mockPixOutCalls.pay, before, "nada pago à loja");
  assert.equal(await prisma.pixPayout.count({ where: { purchaseJobId: job.id } }), 0);
  // Próxima passada do cron: job cancelado, orçamento liberado, cliente estornado.
  const r2 = await runVtexApiPurchases({ maxJobs: 1, fetchImpl: fakeVtex().fetchImpl });
  assert.deepEqual(r2.errors, []);
  const after = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.status, "canceled");
  assert.equal((await prisma.purchaseSpend.findFirstOrThrow({ where: { purchaseJobId: job.id } })).status, "released");
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "refunded");
});
