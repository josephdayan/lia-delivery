// Caso real de 02/09: chá de R$4,49 (Natural da Terra) cobrado com "tarifa padrão", sem
// estoque para o CEP e abaixo do mínimo da loja; pago às 10h45 no cartão e o cliente ficou
// o dia inteiro sem notícia. Três contratos aqui: (1) loja sem política de frete não
// cobra automático; (2) pedido pago sem compra há 2h+ alerta o operador e, com bloqueio,
// avisa o cliente — sem repetir; (3) "Não consegui comprar → estornar" estorna pelo
// provedor, fecha o pedido e explica ao cliente com o motivo.
import "./helpers/load-env";
process.env.LIA_OPERATOR_PHONE = "+5511900000000";
// Estorno Pagar.me em mock (sem chave) — mesmo arranjo do saved-card.test.
process.env.PAGARME_MOCK = "true";
// Modo ESTRITO de produção: só cobra automático o que a loja confirmou ao vivo.
process.env.LIA_CHARGE_ONLY_VERIFIED = "true";
// Estorno automático vale para qualquer data nos testes (em prod: só pagos a partir de 04/09).
process.env.LIA_AUTO_REFUND_SINCE = "2000-01-01T00:00:00Z";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, opsPurchaseFailedRefund, watchPaidOrder } from "../src/lib/delivery-service";
import { reconcilePayments } from "../src/lib/payments/reconcile";
import { PURCHASE_BLOCKED_PREFIX } from "../src/lib/order-monitor";
import { autoRefundDecision } from "../src/lib/ops-lifecycle";
import { AWAITING_OPERATOR_QUOTE_STATUS } from "../src/lib/order-flags";
import { getStore } from "../src/lib/stores";
import * as copy from "../src/lib/lia-copy";

const OPERATOR = "+5511900000000";
const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let phoneSeq = 0;
let msgSeq = 0;
let dbOk = false;

const outbox: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
(whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};

function newPhone(): string {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  return `${PREFIX}${digits}`;
}
function textsTo(to: string, start: number): string {
  return outbox.slice(start).filter((m) => m.to === to).map((m) => m.text).join("\n---\n");
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `wd_${RUN}_${++msgSeq}` });
  return textsTo(phone, start);
}

// Cliente real sempre escreveu pra Lia antes de pagar: o helper grava essa mensagem inbound
// (default 5 min atrás = dentro da janela de 24h da Meta; passe 2 dias pra simular fora).
async function paidOrder(paidAgoMs: number, notes = "Pagamento: cartão", lastInboundAgoMs = 5 * 60_000) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: "collecting", context: "{}" } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "quero um chá", createdAt: new Date(Date.now() - lastInboundAgoMs) } });
  const paidAt = new Date(Date.now() - paidAgoMs);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id,
      phone,
      cep: "01229-000",
      deliveryAddress: TEST_ADDRESS,
      storeKey: "concierge",
      storeLabel: "Lia",
      items: [{ sku: "naturaldaterra-165908", name: "Ice Tea Pêssego Zero", qty: 1, unitPrice: 4.49, lineTotal: 4.49, storeKey: "naturaldaterra" }] as unknown as object,
      itemsSubtotal: 4.49,
      serviceFee: 0.45,
      deliveryFee: 18,
      total: 24.14,
      courierKey: "retailer_delivery",
      notes,
      status: "paid",
      paidAt
    }
  });
  await prisma.payment.create({
    data: { deliveryOrderId: order.id, provider: "pagarme", providerPaymentId: `ch_${RUN}_${order.id.slice(-4)}`, method: "card", amountCents: 2414, status: "approved" }
  });
  return { phone, userId: user.id, orderId: order.id };
}

async function wipeTestData() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipeTestData();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
    dbOk = false;
    console.warn("⚠️  Banco indisponível — vigia de pedido pago será pulado.");
  }
});

after(async () => {
  if (!dbOk) return;
  await wipeTestData();
  await prisma.$disconnect();
});

test("loja sem política de frete calibrada NÃO cobra automático: vai pro operador com o motivo na nota", async (t) => {
  if (!dbOk) return t.skip();
  // Decathlon está no roster de teste e não tem semente de frete → "tarifa padrão".
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  let out = await send(phone, "quero creatina");
  for (let i = 0; i < 4 && /Responde \*1\*/.test(out); i++) out = await send(phone, "1");
  const closed = await send(phone, "so isso");
  assert.doesNotMatch(closed, /Total: R\$/, `cobrou automático com tarifa padrão: ${closed.slice(0, 300)}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  assert.ok(order, "esperava pedido na fila do operador");
  assert.equal(order!.status, AWAITING_OPERATOR_QUOTE_STATUS);
  assert.match(order!.notes ?? "", /tarifa padrão é chute/);
});

test("modo estrito: loja com tabela semeada mas SEM confirmação ao vivo também vai pro operador", async (t) => {
  if (!dbOk) return t.skip();
  // Petz tem frete semeado ("loja"), mas a simulação está desligada → nada confirmado
  // para o CEP → o total não sai automático (é o que faltou no chá de 02/09).
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  // Item da Petz acima de qualquer mínimo (a Petz não tem mínimo; evita o nudge de R$30).
  const catalog = getStore("petz").listCatalog();
  const item = catalog.find((i) => i.unitPrice >= 20 && i.unitPrice <= 80 && !/,|\se\s|^\d/i.test(i.name)) ?? catalog[0];
  const qty = Math.max(1, Math.ceil(60 / item.unitPrice));
  let out = await send(phone, `quero ${qty} ${item.name}`);
  for (let i = 0; i < 4 && /Responde \*1\*/.test(out); i++) out = await send(phone, "1");
  const closed = await send(phone, "so isso");
  assert.doesNotMatch(closed, /Total: R\$/, `cobrou sem confirmação ao vivo: ${closed.slice(0, 300)}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  assert.equal(order?.status, AWAITING_OPERATOR_QUOTE_STATUS, `sem pedido na fila. cards: ${out.slice(0, 300)} | fechamento: ${closed.slice(0, 300)}`);
  assert.match(order?.notes ?? "", /sem confirmação ao vivo/);
});

test("pedido pago há 3h sem compra e com bloqueio: alerta o operador e avisa o cliente UMA vez", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await paidOrder(3 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} item sem estoque na Natural da Terra para o CEP; mínimo R$50.`);
  const start = outbox.length;
  assert.equal(await watchPaidOrder(orderId), "operator+customer");
  assert.match(textsTo(OPERATOR, start), /PAGO há 3h sem compra/);
  assert.match(textsTo(OPERATOR, start), /sem estoque/);
  assert.equal(textsTo(phone, start), copy.purchaseDelayedCustomer(orderId.slice(-6).toUpperCase(), true));
  const again = outbox.length;
  assert.equal(await watchPaidOrder(orderId), "none", "mesmo bucket não repete");
  assert.equal(outbox.length, again);
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  assert.match(order.notes ?? "", /COMPRA PENDENTE 2h/);
});

test("pedido pago há 10 min é normal: nada dispara; via cron o de 5h conta no relatório", async (t) => {
  if (!dbOk) return t.skip();
  const fresh = await paidOrder(10 * 60_000); // 1º lembrete agora é aos 30 min (04/09)
  assert.equal(await watchPaidOrder(fresh.orderId), "none");
  const stuck = await paidOrder(5 * 60 * 60_000);
  const start = outbox.length;
  const report = await reconcilePayments();
  assert.ok(report.paidStuckAlerts >= 1, JSON.stringify(report));
  assert.match(textsTo(OPERATOR, start), new RegExp(`#${stuck.orderId.slice(-6).toUpperCase()} PAGO há 5h`));
  // Sem bloqueio conhecido, o cliente não recebe "atrasou" antes das 6h — às 6h o
  // dinheiro volta sozinho (dono 06/10), e a mensagem dele é a do estorno.
  assert.equal(textsTo(stuck.phone, start), "");
});

test("'Não consegui comprar → estornar': estorna pelo provedor, fecha o pedido e explica com o motivo", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await paidOrder(60 * 60_000);
  const start = outbox.length;
  const order = await opsPurchaseFailedRefund(orderId, "sem estoque para o seu endereço");
  assert.equal(order.status, "refunded");
  assert.match(order.notes ?? "", /Compra não realizada \(sem estoque para o seu endereço\)/);
  assert.match(order.notes ?? "", /ESTORNO CONFIRMADO: integral/);
  const paid = await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: orderId } });
  assert.equal(paid.status, "refunded");
  assert.equal(paid.refundedCents, 2414);
  const msg = textsTo(phone, start);
  assert.match(msg, /Não consegui comprar \*Ice Tea Pêssego Zero\*/);
  assert.match(msg, /sem estoque para o seu endereço/);
  assert.match(msg, /R\$ 24,14/);
  // Já estornado não estorna de novo.
  await assert.rejects(() => opsPurchaseFailedRefund(orderId), /Só um pedido pago/);
});

// ---- janela de 24h (03/09: o aviso do chá morreu com erro 131047) ----
import { whatsappAdapter as adapterForTemplates } from "../src/lib/adapters/whatsapp";

test("cliente fora da janela de 24h: com template configurado o aviso vai por template; sem template, nota no pedido e nada é enviado", async (t) => {
  if (!dbOk) return t.skip();
  const templates: { to: string; name: string; params: string[] }[] = [];
  (adapterForTemplates as { sendTemplateMessage: unknown }).sendTemplateMessage = async (to: string, input: { name: string; bodyParams: string[] }) => {
    templates.push({ to, name: input.name, params: input.bodyParams });
    return { provider: "test", to, template: input.name };
  };
  // Cliente cuja última mensagem foi há 2 dias (fora da janela). Com bloqueio, o cliente é
  // avisado já no 1º alerta (sem bloqueio, às 6h o pedido é estornado — dono 06/10).
  const stale = await paidOrder(3 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque para o CEP.`, 2 * 24 * 60 * 60_000);

  process.env.LIA_TEMPLATE_ORDER_UPDATE = "pedido_atualizacao";
  try {
    const start = outbox.length;
    assert.equal(await watchPaidOrder(stale.orderId), "operator+customer");
    assert.equal(textsTo(stale.phone, start), "", "fora da janela não pode sair texto livre");
    // Operador também está fora da janela (nunca escreveu pra Lia): alerta dele vai por template.
    const toCustomer = templates.filter((m) => m.to === stale.phone);
    const toOperator = templates.filter((m) => m.to !== stale.phone);
    assert.equal(toCustomer.length, 1);
    // {{1}} = rótulo do item, nunca o número do pedido (dono, 08/10 noite).
    assert.equal(toCustomer[0].params[0], "de Ice Tea Pêssego Zero");
    assert.match(toCustomer[0].params[1], /pedido/i);
    assert.equal(toOperator.length, 1);
    assert.equal(toOperator[0].params[0], "operador");
  } finally {
    delete process.env.LIA_TEMPLATE_ORDER_UPDATE;
  }

  // Sem template: nada sai e o pedido registra o porquê (bucket seguinte para não colidir com o marcador de 6h).
  process.env.LIA_AUTO_REFUND_OFF = "true"; // aqui o assunto é a janela, não o estorno automático
  const stale2 = await paidOrder(13 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque para o CEP.`, 2 * 24 * 60 * 60_000);
  // Bloqueio só avisa em 2h e 24h+: força o bucket de 24h.
  await prisma.deliveryOrder.update({ where: { id: stale2.orderId }, data: { paidAt: new Date(Date.now() - 25 * 60 * 60_000) } });
  const before = templates.length;
  const start2 = outbox.length;
  assert.equal(await watchPaidOrder(stale2.orderId), "operator");
  assert.equal(templates.length, before, "sem template configurado nada sai por template");
  assert.equal(textsTo(stale2.phone, start2), "");
  const after = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: stale2.orderId } });
  assert.match(after.notes ?? "", /Aviso ao cliente NÃO enviado: fora da janela/);
  delete process.env.LIA_AUTO_REFUND_OFF;
});


// ---- estorno AUTOMÁTICO (decisão do dono, 04/09: "tem que ir sem mim e sem /ops") ----
test("bloqueado há 6h+: estorna sozinho pelo provedor, avisa cliente e operador, fecha o pedido; idempotente", async (t) => {
  if (!dbOk) return t.skip();
  const o = await paidOrder(7 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} item sem estoque na Natural da Terra para o CEP; mínimo R$50.`);
  const start = outbox.length;
  assert.equal(await watchPaidOrder(o.orderId), "auto_refunded");
  const after = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.equal(after.status, "refunded");
  assert.match(after.notes ?? "", /Estorno automático \(regra 04\/09\)/);
  assert.match(after.notes ?? "", /ESTORNO CONFIRMADO: integral/);
  const pay = await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: o.orderId } });
  assert.equal(pay.status, "refunded");
  assert.match(textsTo(o.phone, start), /Não consegui comprar \*Ice Tea Pêssego Zero\* \(a loja ficou sem o item para o seu endereço\)\. Estornei o valor integral de R\$ ?24,14/);
  assert.match(textsTo(OPERATOR, start), /Estorno automático do pedido #/);
  assert.equal(await watchPaidOrder(o.orderId), "none", "já estornado: nada a fazer");
});

test("bloqueado há 3h só alerta; sem bloqueio não estorna em 5h e estorna em 6h+ (dono 06/10)", async (t) => {
  if (!dbOk) return t.skip();
  const early = await paidOrder(3 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque.`);
  assert.equal(await watchPaidOrder(early.orderId), "operator+customer");
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: early.orderId } })).status, "paid");

  const stale5 = await paidOrder(5 * 60 * 60_000);
  assert.equal(await watchPaidOrder(stale5.orderId), "operator");
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: stale5.orderId } })).status, "paid");

  const stale7 = await paidOrder(7 * 60 * 60_000);
  const start = outbox.length;
  assert.equal(await watchPaidOrder(stale7.orderId), "auto_refunded");
  assert.match(textsTo(stale7.phone, start), /não consegui confirmar a compra a tempo/);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: stale7.orderId } })).status, "refunded");
});

test("kill-switch e pedido já em compra nunca estornam sozinhos", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_AUTO_REFUND_OFF = "true";
  try {
    const o = await paidOrder(30 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque.`);
    assert.notEqual(await watchPaidOrder(o.orderId), "auto_refunded");
    assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "paid");
  } finally {
    delete process.env.LIA_AUTO_REFUND_OFF;
  }
  const buying = await paidOrder(30 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque.`);
  await prisma.deliveryOrder.update({ where: { id: buying.orderId }, data: { status: "operator_buying" } });
  assert.equal(await watchPaidOrder(buying.orderId), "none");
  assert.equal(autoRefundDecision({ status: "operator_buying", paidAt: new Date(0), notes: `${PURCHASE_BLOCKED_PREFIX} x` }).refund, false);
  assert.equal(autoRefundDecision({ status: "paid", storeOrderNumber: "123", paidAt: new Date(0), notes: `${PURCHASE_BLOCKED_PREFIX} x` }).refund, false, "com número de compra na loja não é falha");
  process.env.LIA_AUTO_REFUND_SINCE = "2026-09-04T12:00:00Z";
  try {
    assert.equal(autoRefundDecision({ status: "paid", paidAt: new Date("2026-08-30T15:26:53Z"), notes: `${PURCHASE_BLOCKED_PREFIX} x` }, new Date("2026-09-05T00:00:00Z")).refund, false, "pago antes da regra existir nunca é estornado em bloco");
    assert.equal(autoRefundDecision({ status: "paid", paidAt: new Date("2026-09-04T13:00:00Z"), notes: `${PURCHASE_BLOCKED_PREFIX} x` }, new Date("2026-09-05T00:00:00Z")).refund, true);
  } finally {
    process.env.LIA_AUTO_REFUND_SINCE = "2000-01-01T00:00:00Z";
  }
});

test("provedor falha: pedido continua pago, nota e alerta uma vez, tenta de novo sem repetir", async (t) => {
  if (!dbOk) return t.skip();
  const o = await paidOrder(7 * 60 * 60_000, `Pagamento: cartão\n${PURCHASE_BLOCKED_PREFIX} sem estoque.`);
  await prisma.payment.deleteMany({ where: { deliveryOrderId: o.orderId } }); // sem razão → provedor não estorna
  const start = outbox.length;
  assert.equal(await watchPaidOrder(o.orderId), "auto_refund_failed");
  const after = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.equal(after.status, "paid");
  assert.match(after.notes ?? "", /ESTORNO AUTOMÁTICO FALHOU/);
  assert.match(textsTo(OPERATOR, start), /FALHOU/);
  assert.equal(textsTo(o.phone, start), "", "cliente não recebe nada numa falha interna");
  const start2 = outbox.length;
  assert.equal(await watchPaidOrder(o.orderId), "auto_refund_failed");
  assert.equal(textsTo(OPERATOR, start2), "", "alerta não repete a cada tick");
  const notes = (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } })).notes ?? "";
  assert.equal(notes.split("ESTORNO AUTOMÁTICO FALHOU").length - 1, 1, "nota não repete");
});
