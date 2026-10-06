import "./helpers/load-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { recordPayment } from "../src/lib/payments/ledger";
import {
  ensurePurchaseJobForPaidOrder,
  manualQueueJobForPaidOrder,
  claimNextPurchaseJob,
  MANUAL_QUEUE_STATUS,
} from "../src/lib/purchase-worker";
import { autoRefundDecision, opsMarkBought, opsSetRecipient } from "../src/lib/ops-lifecycle";
import { parseRecipientName } from "../src/lib/delivery-service";
import { purchaseUrlAllowed, purchaseHostAllowed } from "../src/lib/purchase-preparation";
import { detectIntent } from "../src/lib/lia-intents";

const users: string[] = [];
let sequence = 0;
async function paidOrder(items: object[], storeKey = "kalunga") {
  const user = await prisma.user.create({ data: { phone: `+55090799${process.pid}${++sequence}` } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "paid", storeKey, storeLabel: storeKey, items,
      itemsSubtotal: 20, deliveryFee: 8, serviceFee: 2, total: 30, cep: "01310-100",
      deliveryAddress: "Rua Teste, 10, Centro, São Paulo - SP", paidAt: new Date(Date.now() - 60_000),
      courierKey: "retailer_delivery",
    },
  });
  await recordPayment({ deliveryOrderId: order.id, provider: "mercadopago", providerPaymentId: `manual-${process.pid}-${sequence}`, amountCents: 3000, status: "approved", method: "pix" });
  return order;
}
after(async () => {
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

test("loja sem execução automática vira fila manual explícita e nunca é reivindicada", async () => {
  const order = await paidOrder([
    { sku: "kalunga-1", name: "Caneta", qty: 2, unitPrice: 10, storeKey: "kalunga", storeLabel: "Kalunga", productUrl: "https://www.kalunga.com.br/prod/caneta" },
  ]);
  assert.equal(await ensurePurchaseJobForPaidOrder(order.id), null);
  const job = await manualQueueJobForPaidOrder(order.id);
  assert.ok(job);
  assert.equal(job.status, MANUAL_QUEUE_STATUS);
  assert.equal(job.storeKey, "kalunga");
  // Idempotente: segunda chamada devolve o mesmo job.
  assert.equal((await manualQueueJobForPaidOrder(order.id))?.id, job.id);
  assert.equal(await claimNextPurchaseJob("manual-tests", ["kalunga"]), null);
  // Estorno automático (dono 06/10): 6h sem compra, na fila manual ou na automática.
  const at = (h: number) => new Date(Date.now() - h * 3_600_000);
  assert.equal(autoRefundDecision({ status: "paid", paidAt: at(5), manualQueue: true }).refund, false);
  assert.equal(autoRefundDecision({ status: "paid", paidAt: at(5) }).refund, false);
  assert.equal(autoRefundDecision({ status: "paid", paidAt: at(6.1), manualQueue: true }).refund, true);
  assert.equal(autoRefundDecision({ status: "paid", paidAt: at(6.1) }).refund, true);
  // O operador registra a compra à mão e o job manual fecha.
  await opsSetRecipient(order.id, "  maria   silva ");
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).customerName, "maria silva");
  await opsMarkBought(order.id, "MANUAL-123");
  const closed = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(closed.status, "completed");
  assert.equal(closed.storeOrderNumber, "MANUAL-123");
});

test("cesta com mais de uma loja também vai para a fila manual", async () => {
  const order = await paidOrder([
    { sku: "cobasi-1", name: "Ração", qty: 1, unitPrice: 10, storeKey: "cobasi", storeLabel: "Cobasi", productUrl: "https://www.cobasi.com.br/racao/p" },
    { sku: "swift-2", name: "Carne", qty: 1, unitPrice: 10, storeKey: "swift", storeLabel: "Swift", productUrl: "https://www.swift.com.br/carne/p" },
  ], "concierge");
  const job = await manualQueueJobForPaidOrder(order.id);
  assert.equal(job?.status, MANUAL_QUEUE_STATUS);
  assert.equal(job?.storeKey, "concierge");
  assert.match(job?.lastErrorMessage ?? "", /mais de uma loja/);
  await prisma.purchaseJob.update({ where: { id: job!.id }, data: { status: "canceled" } });
});

test("domínios por loja: Mercado Livre inclui Mercado Pago; outras lojas não", () => {
  assert.equal(purchaseHostAllowed("mercadolivre", "www.mercadopago.com.br"), true);
  assert.equal(purchaseHostAllowed("mercadolivre", "produto.mercadolivre.com.br"), true);
  assert.equal(purchaseHostAllowed("cobasi", "www.mercadopago.com.br"), false);
  assert.equal(purchaseUrlAllowed("mercadolivre", "https://www.mercadopago.com.br/checkout/x"), true);
  assert.equal(purchaseUrlAllowed("mercadolivre", "https://mercadolivre.com.br.evil.test/x"), false);
});

test("política: Mercado Livre entra na allowlist mas nunca no clique automático", async () => {
  const { automaticPurchaseDecision } = await import("../src/lib/purchase-policy");
  const old = process.env.LIA_AUTO_PURCHASE_STORES;
  try {
    process.env.LIA_AUTO_PURCHASE_STORES = "mercadolivre";
    await prisma.$transaction(async (tx) => {
      assert.match((await automaticPurchaseDecision(tx, "mercadolivre", 1000))!, /confirmação do dono/);
      assert.equal(await automaticPurchaseDecision(tx, "mercadolivre", 1000, new Date(), "owner_confirm"), null);
    });
  } finally {
    if (old === undefined) delete process.env.LIA_AUTO_PURCHASE_STORES; else process.env.LIA_AUTO_PURCHASE_STORES = old;
  }
});

test("destinatário: nome válido, intent 'é pra outra pessoa'", () => {
  assert.equal(parseRecipientName("  é maria da silva "), "Maria Da Silva");
  assert.equal(parseRecipientName("João"), "João");
  assert.equal(parseRecipientName("12345"), null);
  assert.equal(parseRecipientName("quero 2 arroz e feijão pra hoje por favor"), null);
  assert.equal(detectIntent("é pra outra pessoa").kind, "recipient_other");
  assert.equal(detectIntent("entrega pra minha mãe").kind, "recipient_other");
  assert.equal(detectIntent("quem vai receber é o João").kind, "recipient_other");
  assert.notEqual(detectIntent("quero arroz").kind, "recipient_other");
});
