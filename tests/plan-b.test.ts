// Plano B (04/09): pedido PAGO travou na loja → substituto verificado ao vivo oferecido
// com botões; "trocar" substitui e a compra segue, "devolver" estorna na hora. Pré-voo:
// a loja é consultada de novo no instante da cobrança; "não" definitivo = nada cobrado.
import "./helpers/load-env";
const OPERATOR = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}00`;
process.env.LIA_OPERATOR_PHONE = OPERATOR;
process.env.PAGARME_MOCK = "true";
process.env.LIA_AUTO_REFUND_SINCE = "2000-01-01T00:00:00Z";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, watchPaidOrder } from "../src/lib/delivery-service";
import { __setPlanBForTests, offerPlanB, PLAN_B_ACCEPTED_PREFIX, PLAN_B_NONE_PREFIX, PLAN_B_OFFERED_PREFIX } from "../src/lib/plan-b";
import { autoRefundDecision } from "../src/lib/ops-lifecycle";
import { PURCHASE_BLOCKED_PREFIX } from "../src/lib/order-monitor";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { ChoiceOption } from "../src/lib/conversation-types";
import type { LiveItemCheck } from "../src/lib/live-freight";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `pb_${RUN}_${++msgSeq}` });
  return textsTo(phone, start);
}

const ORIGINAL = { sku: "naturaldaterra-165908", name: "Ice Tea Pêssego Zero", qty: 1, unitPrice: 4.49, lineTotal: 4.49, storeKey: "naturaldaterra", storeLabel: "Natural da Terra" };
const SUB: ChoiceOption = { sku: "paguemenos-777", name: "Chá Ice Tea Pêssego Zero 1,5L", unitPrice: 3.99, storeKey: "paguemenos", storeLabel: "Pague Menos", productUrl: "https://www.paguemenos.com.br/p/777" };
const TOO_EXPENSIVE: ChoiceOption = { sku: "paguemenos-999", name: "Ice Tea Premium", unitPrice: 9.99, storeKey: "paguemenos", storeLabel: "Pague Menos" };
const NOT_VERIFIABLE: ChoiceOption = { sku: "PETZ-1", name: "Ice Tea Petz", unitPrice: 3.5, storeKey: "petz", storeLabel: "Petz" };
const searchAll = async () => [NOT_VERIFIABLE, TOO_EXPENSIVE, SUB];
const simulateOk = async (_store: string, skus: string[]) => new Map<string, LiveItemCheck>(skus.map((sku) => [sku, { sku, available: true, fee: 9.9, estimate: "1bd", etaMinutes: 24 * 60 }]));

async function paidBlockedOrder(opts: { paidAgoMs?: number; blocked?: boolean; item?: typeof ORIGINAL; status?: string } = {}) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: "collecting", context: "{}" } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "quero um chá", createdAt: new Date(Date.now() - 5 * 60_000) } });
  const item = opts.item ?? ORIGINAL;
  const paidAt = new Date(Date.now() - (opts.paidAgoMs ?? 20 * 60_000));
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, conversationId: convo.id, phone, cep: "01229-000", deliveryAddress: TEST_ADDRESS,
      storeKey: item.storeKey, storeLabel: item.storeLabel,
      items: [item] as unknown as object,
      itemsSubtotal: item.lineTotal, serviceFee: Math.round(item.lineTotal * 0.1 * 100) / 100, deliveryFee: 18, total: 24.14,
      courierKey: "retailer_delivery",
      notes: `Pagamento: cartão${opts.blocked === false ? "" : `\n${PURCHASE_BLOCKED_PREFIX} item sem estoque na Natural da Terra para o CEP; mínimo R$50.`}`,
      status: opts.status ?? "paid", paidAt,
      quoteExpiresAt: opts.status === "awaiting_quote_confirmation" ? new Date(Date.now() + 30 * 60_000) : null
    }
  });
  if ((opts.status ?? "paid") === "paid") {
    await prisma.payment.create({ data: { deliveryOrderId: order.id, provider: "pagarme", providerPaymentId: `ch_${RUN}_${order.id.slice(-4)}`, method: "card", amountCents: 2414, status: "approved" } });
  }
  return { phone, userId: user.id, convoId: convo.id, orderId: order.id };
}
async function wipe() {
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
    await prisma.$queryRaw`select 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB) throw error;
  }
});
after(async () => {
  __setPlanBForTests({ search: null, simulate: null });
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

test("bloqueio → oferta de troca com substituto verificado (loja consultável, preço na tolerância); não repete", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: searchAll, simulate: simulateOk });
  const o = await paidBlockedOrder();
  const start = outbox.length;
  assert.equal(await offerPlanB(o.orderId), "offered");
  const msg = textsTo(o.phone, start);
  assert.match(msg, /A \*Natural da Terra\* ficou sem \*Ice Tea Pêssego Zero\*/);
  assert.match(msg, /Encontrei \*Chá Ice Tea Pêssego Zero 1,5L\* na \*Pague Menos\*, prazo da loja: 1 dia útil/);
  assert.match(msg, /Sai R\$ ?0,55 mais barato e eu devolvo a diferença\. Troco\?/);
  assert.match(textsTo(OPERATOR, start), /ofereci troca ao cliente/);
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.match(after1.notes ?? "", new RegExp(PLAN_B_OFFERED_PREFIX));
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: o.convoId } });
  assert.match(convo.context ?? "", /awaiting_plan_b/);
  assert.equal(await offerPlanB(o.orderId), "skip");
});

test("'trocar' substitui o item no pedido pago, limpa o bloqueio, reinicia o relógio e manda o operador comprar", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: searchAll, simulate: simulateOk });
  const o = await paidBlockedOrder();
  assert.equal(await offerPlanB(o.orderId), "offered");
  const start = outbox.length;
  const reply = await send(o.phone, "planb_trocar");
  assert.match(reply, /Trocado: agora é \*Chá Ice Tea Pêssego Zero 1,5L\* da \*Pague Menos\*, prazo da loja: 1 dia útil/);
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.equal(after1.status, "paid");
  const items = after1.items as unknown as { sku: string; storeKey: string; lineTotal: number }[];
  assert.equal(items[0].sku, "paguemenos-777");
  assert.equal(after1.storeKey, "paguemenos");
  assert.equal(after1.itemsSubtotal, 3.99);
  assert.doesNotMatch(after1.notes ?? "", new RegExp(PURCHASE_BLOCKED_PREFIX));
  assert.match(after1.notes ?? "", new RegExp(PLAN_B_ACCEPTED_PREFIX));
  assert.match(textsTo(OPERATOR, start), /Comprar agora: 1x Chá Ice Tea Pêssego Zero 1,5L — Pague Menos https:\/\/www\.paguemenos\.com\.br\/p\/777/);
  // Relógio do estorno automático reinicia no aceite: 5,9h depois do aceite (já 6h+ desde o
  // pagamento, que foi 20 min antes) ainda não estorna.
  assert.equal(autoRefundDecision(after1, new Date(Date.now() + 5.9 * 3_600_000)).refund, false);
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: o.convoId } });
  assert.doesNotMatch(convo.context ?? "", /planB/);
});

test("substituto bem mais barato: diferença devolvida em parcial no aceite", async (t) => {
  if (!dbOk) return t.skip();
  const cheap: ChoiceOption = { ...SUB, unitPrice: 1.99 };
  __setPlanBForTests({ search: async () => [cheap], simulate: simulateOk });
  const o = await paidBlockedOrder();
  assert.equal(await offerPlanB(o.orderId), "offered");
  assert.match(outbox.filter((m) => m.to === o.phone).pop()?.text ?? "", /Sai R\$ ?2,75 mais barato e eu devolvo a diferença/);
  const reply = await send(o.phone, "trocar");
  assert.match(reply, /Devolvi R\$ ?2,75 de diferença/);
  const pay = await prisma.payment.findFirstOrThrow({ where: { deliveryOrderId: o.orderId } });
  assert.equal(pay.refundedCents, 275);
  assert.equal(pay.status, "partially_refunded");
});

test("'devolver' estorna integral na hora com o motivo em linguagem simples", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: searchAll, simulate: simulateOk });
  const o = await paidBlockedOrder();
  assert.equal(await offerPlanB(o.orderId), "offered");
  const reply = await send(o.phone, "planb_devolver");
  assert.match(reply, /Não consegui comprar \*Ice Tea Pêssego Zero\* \(a loja ficou sem o item para o seu endereço\)\. Estornei o valor integral/);
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.equal(after1.status, "refunded");
  assert.match(after1.notes ?? "", /plano B recusado pelo cliente/);
});

test("substituto esgotou entre a oferta e o aceite: estorna e explica", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: searchAll, simulate: simulateOk });
  const o = await paidBlockedOrder();
  assert.equal(await offerPlanB(o.orderId), "offered");
  __setPlanBForTests({ simulate: async (_s: string, skus: string[]) => new Map(skus.map((sku) => [sku, { sku, available: false }])) });
  const reply = await send(o.phone, "sim");
  assert.match(reply, /o substituto também esgotou/);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } })).status, "refunded");
});

test("sem substituto verificado: marca a nota e o vigia segue para alerta; cliente sabe que estou tentando", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: async () => [], simulate: simulateOk });
  const o = await paidBlockedOrder({ paidAgoMs: 40 * 60_000 });
  const start = outbox.length;
  assert.equal(await watchPaidOrder(o.orderId), "operator+customer");
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.match(after1.notes ?? "", new RegExp(PLAN_B_NONE_PREFIX));
  assert.match(after1.notes ?? "", /COMPRA PENDENTE 30min/);
  assert.match(textsTo(o.phone, start), /travou na loja/);
});

test("vigia: bloqueio novo dispara o plano B na hora (sem esperar balde de alerta)", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: searchAll, simulate: simulateOk });
  const o = await paidBlockedOrder({ paidAgoMs: 5 * 60_000 });
  const start = outbox.length;
  assert.equal(await watchPaidOrder(o.orderId), "plan_b_offered");
  assert.match(textsTo(o.phone, start), /Troco\?/);
  // Sem resposta: 6h depois da OFERTA (não do pagamento) o estorno automático fecha.
  const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  assert.equal(autoRefundDecision(after1, new Date(Date.now() + 5 * 3_600_000)).refund, false);
  assert.equal(autoRefundDecision(after1, new Date(Date.now() + 6.1 * 3_600_000)).refund, true);
});

test("pré-voo: loja sem o item na hora de cobrar → nada cobrado, pedido fecha e o cliente vê alternativas", async (t) => {
  if (!dbOk) return t.skip();
  __setPlanBForTests({ search: null, simulate: null });
  const o = await paidBlockedOrder({ status: "awaiting_quote_confirmation", blocked: false });
  await prisma.conversation.update({
    where: { id: o.convoId },
    data: { context: JSON.stringify({ step: "awaiting_quote_confirmation", deliveryOrderId: o.orderId, deliveryAddress: TEST_ADDRESS, deliveryAddressVerified: true }) }
  });
  __setPreflightForTests(async () => ({ storeKey: "naturaldaterra", kind: "item-unavailable", skus: ["naturaldaterra-165908"] }));
  try {
    const reply = await send(o.phone, "pix");
    assert.match(reply, /Conferi na \*Natural da Terra\* na hora de cobrar e \*Ice Tea Pêssego Zero\* não está mais disponível para o seu endereço\. Nada foi cobrado\./);
    const after1 = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: o.orderId } });
    assert.equal(after1.status, "canceled");
    assert.match(after1.notes ?? "", /PRÉ-VOO/);
    assert.equal(after1.pixId, null, "nenhuma cobrança emitida");
  } finally {
    __setPreflightForTests(null);
  }
});
