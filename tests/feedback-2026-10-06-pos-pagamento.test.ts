// Varredura de 06/10/2026 (agente D): cancelamento, status e perguntas DEPOIS do total e do
// pagamento. Cada teste guarda um defeito reproduzido na conversa:
//   - A2: cancelar pedido PAGO dava 4 respostas opostas conforme a frase ("não tem compra em
//     aberto", "Carrinho limpo", estorno na hora, reclamação). Agora todas perguntam
//     "confirma?" e só o "sim" estorna.
//   - A5/M1: "paguei"/"manda o pix de novo" antes de existir cobrança respondiam "em
//     andamento" ou "você ainda não tem pedidos"; a tela da entrega não entendia "pix",
//     "o frete tá caro", "chega que horas?" nem "bom dia".
//   - M2: pedido pago sem prazo, loja nem endereço nas respostas.
//   - M4: "qual a chave pix?" sem resposta certa; "o pix expirou" dizia "Troquei pra Pix".
//   - M5/M10/B1: "dinheiro"/"vale refeição" viravam busca; "ok" depois do Pix = "Imagina!";
//     "quero cancelar meu pedido" = "Não achei esse item"; "quero o dinheiro de volta" sem
//     pagamento prometia estorno.
//   - M6: "quero de novo o mesmo" virava busca.
//   - A4: troca de endereço depois de pagar dizia "atualizado" e o pedido ia pro antigo.
// Puros sempre; conversa com banco local.
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { detectIntent } from "../src/lib/lia-intents";
import { recordPayment } from "../src/lib/payments/ledger";
import * as copy from "../src/lib/lia-copy";

// ---------- puros ----------

test("cancelar, desistir e pedir o dinheiro de volta têm intent de cancelamento/estorno", () => {
  for (const q of ["cancela", "pode cancelar", "quero desistir", "desisti", "cancela tudo", "cancelar tudo"]) {
    assert.equal(detectIntent(q).kind, "cancel", q);
  }
  for (const q of ["cancela o pedido", "quero cancelar meu pedido", "desisti da compra"]) {
    assert.deepEqual(detectIntent(q), { kind: "cancel", explicitOrder: true }, q);
  }
  for (const q of ["quero meu dinheiro de volta", "me devolve o dinheiro", "quero o estorno", "estorno", "quero reembolso", "quero devolver", "faz o estorno"]) {
    assert.deepEqual(detectIntent(q), { kind: "refund_request" }, q);
  }
  // Reclamação de entrega continua reclamação; "não quero cancelar" mantém.
  assert.equal(detectIntent("veio errado, quero meu dinheiro de volta").kind, "complaint");
  assert.equal(detectIntent("nao quero cancelar").kind, "reject");
  assert.equal(detectIntent("não cancela").kind, "reject");
  // Limpar a lista continua limpar a lista.
  assert.equal(detectIntent("limpa o carrinho").kind, "clear_cart");
  assert.equal(detectIntent("tira tudo").kind, "clear_cart");
});

test("forma de pagamento não aceita, chave pix, prazo e repetir pedido não viram busca", () => {
  for (const q of ["dinheiro", "vale refeição", "posso pagar em dinheiro?", "aceita vale refeição?", "boleto", "posso pagar na entrega?"]) {
    assert.deepEqual(detectIntent(q), { kind: "unsupported_payment" }, q);
  }
  assert.equal(detectIntent("porta dinheiro").kind, "free_text");
  assert.equal(detectIntent("qual a chave de fenda mais barata?").kind, "free_text", "chave de fenda é produto");
  assert.equal(detectIntent("pode estornar?").kind, "refund_request");
  for (const q of ["qual a chave pix?", "qual a chave?", "manda a chave pix"]) {
    assert.deepEqual(detectIntent(q), { kind: "resend_code", expired: false, keyAsk: true }, q);
  }
  assert.equal(detectIntent("chega que horas?").kind, "status");
  for (const q of ["quero de novo o mesmo", "oi, quero de novo o mesmo", "o mesmo de novo", "o mesmo de sempre", "igual da última vez"]) {
    assert.equal(detectIntent(q).kind, "repeat_last", q);
  }
  assert.equal(detectIntent("quero o mesmo shampoo da outra vez").kind, "free_text", "com produto continua busca");
  assert.deepEqual(detectIntent("pra qual endereço vai?"), { kind: "address_question", order: true });
});

test("textos novos: confirmação de estorno, Pix novo e loja/prazo do pedido", () => {
  const ask = copy.withdrawConfirmAsk({ shortId: "ABC123", itemsPreview: "1x Caneta", total: 30 });
  // Sem número do pedido pro cliente (dono, 08/10 noite): o pedido é ancorado pelos itens.
  assert.match(ask, /Confirma o cancelamento do pedido \(1x Caneta\)\?/);
  assert.doesNotMatch(ask, /#/);
  assert.match(ask, /R\$ 30,00/);
  assert.match(ask, /\*sim\*/);
  assert.doesNotMatch(copy.paymentSwitched("pix", 23.7, true), /Troquei/);
  assert.match(copy.paymentSwitched("pix", 23.7, true), /Pix novo/);
  assert.match(copy.paymentSwitched("pix", 23.7), /Troquei pra Pix/);
  assert.equal(copy.orderDeliveryInfo({ stores: ["Drogal"], promise: "pela própria loja · prazo da loja: 3h" }), "🚚 Loja *Drogal* · entrega pela própria loja · prazo da loja: 3h");
  assert.doesNotMatch(copy.orderStatusLine({ shortId: "X", status: "awaiting_quote_confirmation" }), /em andamento/);
});

// ---------- conversa, com banco ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `pp_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}

async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return { phone, userId: user.id };
}

async function setCtx(userId: string, ctx: Record<string, unknown>) {
  await prisma.conversation.upsert({
    where: { id: `conv_${userId}` },
    update: { context: JSON.stringify(ctx), status: "active" },
    create: { id: `conv_${userId}`, userId, status: "active", currentStep: "delivery", context: JSON.stringify(ctx) }
  });
}
const baseCtx = { flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true };

const ITEMS = [{ sku: "drogal-1", name: "Caneta Azul", qty: 1, unitPrice: 20, lineTotal: 20, storeKey: "drogal", storeLabel: "Drogal" }];

async function order(c: { phone: string; userId: string }, data: Record<string, unknown>) {
  return prisma.deliveryOrder.create({
    data: {
      userId: c.userId,
      conversationId: `conv_${c.userId}`,
      phone: c.phone,
      storeKey: "drogal",
      storeLabel: "Drogal",
      items: ITEMS,
      itemsSubtotal: 20,
      deliveryFee: 8,
      serviceFee: 2,
      total: 30,
      cep: "01310-100",
      deliveryAddress: "Rua Teste, 10, Centro, São Paulo - SP",
      courierKey: "retailer_delivery",
      fulfillments: [{ storeKey: "drogal", storeLabel: "Drogal", deliveryMode: "retailer_delivery", deliveryPromise: "pela própria loja · prazo da loja: 3h", deliveryFee: 8 }],
      ...data
    }
  });
}

// Pedido PAGO e ainda não comprado, com o pagamento no razão (o estorno mock usa ele).
async function paidCustomer() {
  const c = await customer();
  await setCtx(c.userId, baseCtx);
  const o = await order(c, { status: "paid", paidAt: new Date(Date.now() - 60_000), notes: "Pagamento: Pix" });
  await recordPayment({ deliveryOrderId: o.id, provider: "mock", providerPaymentId: `pp-${RUN}-${seq}`, amountCents: 3000, status: "approved", method: "pix" });
  return { ...c, order: o, shortId: o.id.slice(-6).toUpperCase() };
}

async function statusOf(id: string) {
  return (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id } })).status;
}

async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const orders = await prisma.deliveryOrder.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.payment.deleteMany({ where: { deliveryOrderId: { in: orderIds } } });
  await prisma.purchaseJob.deleteMany({ where: { deliveryOrderId: { in: orderIds } } });
  await prisma.deliveryEvent.deleteMany({ where: { deliveryOrderId: { in: orderIds } } });
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

test("A2: 'cancela' depois de pagar pergunta antes; 'não' mantém, 'sim' estorna", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  const ask = await send(c.phone, "cancela");
  assert.match(ask, /Confirma o cancelamento do pedido/, ask);
  assert.doesNotMatch(ask, new RegExp(c.shortId), "número do pedido não vai pro cliente");
  assert.doesNotMatch(ask, /Não tem compra em aberto/);
  assert.equal(await statusOf(c.order.id), "paid", "nada estornado antes do sim");
  const kept = await send(c.phone, "não");
  assert.match(kept, /segue normal/);
  assert.equal(await statusOf(c.order.id), "paid");
  // Outra frase, mesmo caminho.
  const again = await send(c.phone, "quero meu dinheiro de volta");
  assert.match(again, /Confirma o cancelamento/, again);
  const done = await send(c.phone, "sim");
  assert.match(done, /Estornei R\$ 30,00/, done);
  assert.equal(await statusOf(c.order.id), "refunded");
});

test("A2: 'cancela tudo' com pedido pago não diz 'Carrinho limpo'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  const out = await send(c.phone, "cancela tudo");
  assert.doesNotMatch(out, /Carrinho limpo/);
  assert.match(out, /Confirma o cancelamento/, out);
});

test("A2: 'cancela o pedido' também confirma antes; 'pode cancelar' confirma", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  const ask = await send(c.phone, "cancela o pedido");
  assert.match(ask, /Confirma o cancelamento/, ask);
  assert.doesNotMatch(ask, /Estornei/);
  assert.equal(await statusOf(c.order.id), "paid");
  const done = await send(c.phone, "pode cancelar");
  assert.match(done, /Estornei/, done);
  assert.equal(await statusOf(c.order.id), "refunded");
  // Depois de estornado, "quero cancelar meu pedido" não é item da cesta.
  const after1 = await send(c.phone, "quero cancelar meu pedido");
  assert.doesNotMatch(after1, /Não achei esse item/);
});

test("A2: 'quero o estorno' com o pedido já comprado na loja explica, sem prometer estorno", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  await prisma.deliveryOrder.update({ where: { id: c.order.id }, data: { storeOrderNumber: "V123" } });
  const out = await send(c.phone, "quero o estorno");
  assert.match(out, /já foi feita na loja/);
  assert.doesNotMatch(out, /Confirma o cancelamento|Estornei/);
  assert.equal(await statusOf(c.order.id), "paid");
});

test("M10: dinheiro de volta de pedido cancelado sem pagamento diz que nada foi cobrado", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await setCtx(c.userId, baseCtx);
  const o = await order(c, { status: "canceled" });
  const out = await send(c.phone, "quero meu dinheiro de volta");
  assert.match(out, /cancelado antes do pagamento[\s\S]*nada foi cobrado/, out);
  assert.doesNotMatch(out, new RegExp(o.id.slice(-6).toUpperCase()), "número do pedido não vai pro cliente");
  assert.doesNotMatch(out, /estorno o valor/);
});

test("A5: 'já paguei' com o total na tela e sem cobrança diz que ainda não gerou e mostra Pix/cartão", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const o = await order(c, { status: "awaiting_quote_confirmation", quoteExpiresAt: new Date(Date.now() + 20 * 60_000) });
  await setCtx(c.userId, { ...baseCtx, step: "awaiting_quote_confirmation", deliveryOrderId: o.id });
  const out = await send(c.phone, "já paguei");
  assert.match(out, /Ainda não gerei a cobrança/, out);
  assert.match(out, /Pix/);
  assert.doesNotMatch(out, /em andamento/);
  const status = await send(c.phone, "quando chega?");
  assert.match(status, /Ainda não gerei a cobrança/, status);
  assert.match(status, /prazo da loja: 3h/, "repete o prazo da loja");
  const hi = await send(c.phone, "bom dia");
  assert.match(hi, /total pronto/, hi);
  assert.equal(await statusOf(o.id), "awaiting_quote_confirmation");
});

test("M1: tela da entrega entende pix, frete caro, prazo, reenvio de pix, paguei e bom dia", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const o = await order(c, { status: "awaiting_operator_quote", total: 0 });
  await setCtx(c.userId, {
    ...baseCtx,
    step: "choosing_freight",
    deliveryOrderId: o.id,
    freightChoice: { orderId: o.id, itemsSubtotal: 20, serviceFee: 2, stores: 1, quotedAt: Date.now(), kind: "store", barato: { fee: 8, estimate: "3h" }, rapido: { fee: 12, estimate: "30m" } }
  });
  const pix = await send(c.phone, "pix");
  assert.match(pix, /Antes do pagamento, escolhe a entrega/, pix);
  assert.doesNotMatch(pix, /Não peguei/);
  const fee = await send(c.phone, "o frete tá caro");
  assert.match(fee, /frete é o que a própria loja cobra/, fee);
  const eta = await send(c.phone, "chega que horas?");
  assert.match(eta, /O prazo depende da entrega/, eta);
  const resend = await send(c.phone, "manda o pix de novo");
  assert.match(resend, /Ainda não gerei a cobrança/, resend);
  assert.doesNotMatch(resend, /ainda não tem pedidos/);
  const expired = await send(c.phone, "o pix expirou");
  assert.match(expired, /Ainda não gerei a cobrança/, expired);
  const paid = await send(c.phone, "paguei");
  assert.match(paid, /Ainda não gerei a cobrança/, paid);
  assert.doesNotMatch(paid, /total sendo fechado/);
  const hi = await send(c.phone, "bom dia");
  assert.match(hi, /só falta escolher a entrega/, hi);
  assert.match(hi, /Mais barata/);
  assert.equal(await statusOf(o.id), "awaiting_operator_quote");
});

test("M2: pedido pago responde prazo, loja e endereço do pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  const when = await send(c.phone, "quando chega?");
  assert.match(when, /prazo da loja: 3h/, when);
  assert.match(when, /Drogal/);
  const eta = await send(c.phone, "qual o prazo de entrega?");
  assert.match(eta, /prazo da loja: 3h/, eta);
  const store = await send(c.phone, "o pedido é de qual loja?");
  assert.match(store, new RegExp(`#${c.shortId}\\* é da loja \\*Drogal\\*`), store);
  const where = await send(c.phone, "pra qual endereço vai?");
  assert.match(where, /Rua Teste, 10, Centro/, where);
});

test("A4: trocar o endereço depois de pagar avisa que o pedido pago vai pro endereço antigo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await paidCustomer();
  const out = await send(c.phone, "quero mudar o endereço");
  assert.match(out, new RegExp(`#${c.shortId}\\* já está pago e vai para \\*Rua Teste, 10`), out);
  assert.match(out, /vale para os próximos/);
  const notes = (await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: c.order.id } })).notes ?? "";
  assert.match(notes, /trocar o endereço DEPOIS de pagar/);
});

test("M4: 'qual a chave pix?' explica o copia-e-cola e reenvia; Pix vencido não diz 'Troquei pra Pix'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const o = await order(c, { status: "awaiting_payment", pixId: "mock-pp", pixCopiaECola: "00020126MOCKPIX-pp", notes: "Pagamento: Pix" });
  await setCtx(c.userId, { ...baseCtx, step: "awaiting_payment", deliveryOrderId: o.id, paymentIssuedAt: Date.now() });
  const key = await send(c.phone, "qual a chave pix?");
  assert.match(key, /Pix copia e cola/, key);
  assert.match(key, /MOCKPIX/, "o código vai de novo");
  const ok = await send(c.phone, "blz");
  assert.match(ok, /Fico no aguardo/, ok);
  const money = await send(c.phone, "dinheiro");
  assert.match(money, /só \*Pix\* ou \*cartão/, money);
  assert.doesNotMatch(money, /não achei/);
  const expired = await send(c.phone, "o pix expirou");
  assert.doesNotMatch(expired, /Troquei pra Pix/, expired);
  assert.match(expired, /Pix novo/, expired);
});

test("M6: 'quero de novo o mesmo' repete o último pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await setCtx(c.userId, baseCtx);
  await order(c, { status: "delivered", paidAt: new Date(Date.now() - 86_400_000), deliveredAt: new Date() });
  const out = await send(c.phone, "quero de novo o mesmo");
  assert.match(out, /Achei sua última compra/, out);
  assert.match(out, /Caneta Azul/);
});

test("M5: 'pode mandar' com item escolhido fecha a lista, não responde 'Imagina!'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await setCtx(c.userId, baseCtx);
  const first = await send(c.phone, "quero arroz");
  assert.match(first, /Responde \*1\*/, first.slice(0, 300));
  await send(c.phone, "1");
  const out = await send(c.phone, "pode mandar");
  assert.doesNotMatch(out, /Imagina!/, out.slice(0, 300));
  assert.match(out, /entrega|Total|pagar/i, out.slice(0, 300));
});
