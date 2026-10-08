// Falha do Mercado Pago com CREDENCIAL REAL nunca pode virar cobrança mock.
//
// O bug (encontrado em 18/08): o catch de `createPix` engolia o erro e devolvia um
// `mockpix_...` para um pedido de verdade. O cliente recebia um código incolável com a
// dica de sandbox ("responda *paguei*") e, como o cérebro trata pixId começado em
// "mock" como sandbox, um "paguei" marcava o pedido como PAGO sem dinheiro nenhum.
// Aqui o contrato fica travado: com token setado, erro do MP explode como
// PaymentProviderError; o pedido segue aguardando e dá pra tentar de novo.
import "./helpers/load-env";
process.env.LIA_OPERATOR_PHONE = "+5511900000000";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import {
  PaymentProviderError,
  checkoutAdapter,
  paymentsAreMocked,
  pixAdapter
} from "../src/lib/payments/mercadopago";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";

const OPERATOR = "+5511900000000";
const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5502${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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

const realFetch = globalThis.fetch;

// Token real + fetch quebrado = o cenário exato do bug (timeout/500 do Mercado Pago).
async function withRealCredsAnd<T>(fetchImpl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = "APP_USR-test-token";
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = previous;
  }
}

const failingFetch = (async () => {
  throw new Error("fetch failed: ETIMEDOUT api.mercadopago.com");
}) as unknown as typeof globalThis.fetch;

const pixOkFetch = (async () =>
  new Response(
    JSON.stringify({
      id: 987654321,
      point_of_interaction: { transaction_data: { qr_code: "00020126REAL-PIX-PAYLOAD" } }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )) as unknown as typeof globalThis.fetch;

// ---------- contrato do adapter (puro, sem banco) ----------

test("com credencial real, um Pix que falha explode em vez de virar mock", async () => {
  await withRealCredsAnd(failingFetch, async () => {
    await assert.rejects(
      () => pixAdapter.createPix({ orderId: "order_real_1", amount: 42.5 }),
      (error: unknown) => {
        assert.ok(error instanceof PaymentProviderError, "erro do MP tem que ser PaymentProviderError");
        assert.match((error as Error).message, /ETIMEDOUT/);
        return true;
      }
    );
  });
});

test("com credencial real, um link de cartão que falha explode em vez de virar mock", async () => {
  const serverError = (async () =>
    new Response("upstream boom", { status: 500 })) as unknown as typeof globalThis.fetch;
  await withRealCredsAnd(serverError, async () => {
    await assert.rejects(
      () => checkoutAdapter.createLink({ orderId: "order_real_2", amount: 42.5, method: "card" }),
      PaymentProviderError
    );
  });
});

test("sem credencial, o mock continua valendo (dev/testes)", async () => {
  assert.equal(process.env.MERCADO_PAGO_ACCESS_TOKEN ?? "", "");
  assert.equal(paymentsAreMocked(), true);
  const pix = await pixAdapter.createPix({ orderId: "order_mock_1", amount: 10 });
  assert.equal(pix.mock, true);
  assert.match(pix.pixId, /^mockpix_/);
  const link = await checkoutAdapter.createLink({ orderId: "order_mock_1", amount: 10, method: "card" });
  assert.equal(link.mock, true);
  await withRealCredsAnd(realFetch, async () => assert.equal(paymentsAreMocked(), false));
});

test("a copy da falha não promete nada, diz que não cobrou e abre a retentativa", () => {
  const text = copy.paymentIssueFailed();
  assert.match(text, /nada foi cobrado/i);
  assert.match(text, /\*pix\*/);
  assert.match(text, /\*cartão\*/);
  assert.doesNotMatch(text, /paguei|sandbox/i);
  assert.doesNotMatch(text, /hoje|mesmo dia|~1h/i);
});

// ---------- comportamento do cérebro (banco real, WhatsApp mockado) ----------

function newPhone(): string {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  return `${PREFIX}${digits}`;
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `pif_${RUN}_${++msgSeq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}

function operatorTextsSince(start: number): string {
  return outbox.slice(start).filter((m) => m.to === OPERATOR).map((m) => m.text).join("\n---\n");
}

// Pedido já comprometido e aguardando pagamento, SEM cobrança emitida — exatamente o
// estado em que a emissão anterior falhou.
async function awaitingPaymentOrder(pixId: string | null = null, pixCopiaECola: string | null = null) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id,
      phone,
      cep: "01310-100",
      deliveryAddress: TEST_ADDRESS,
      storeKey: "concierge",
      storeLabel: "Lia",
      items: [{ sku: "x", name: "Café", qty: 1, unitPrice: 20, lineTotal: 20 }] as unknown as object,
      itemsSubtotal: 20,
      courierKey: "retailer_delivery",
      deliveryFee: 10,
      serviceFee: 0,
      total: 30,
      notes: "Pagamento: Pix",
      status: "awaiting_payment",
      pixId,
      pixCopiaECola
    }
  });
  const convo = await prisma.conversation.create({
    data: {
      userId: user.id,
      status: "active",
      currentStep: "awaiting_payment",
      context: JSON.stringify({
        flow: "delivery",
        step: "awaiting_payment",
        cep: "01310-100",
        deliveryAddress: TEST_ADDRESS,
        deliveryAddressVerified: true,
        deliveryOrderId: order.id
      })
    }
  });
  await prisma.deliveryOrder.update({ where: { id: order.id }, data: { conversationId: convo.id } });
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
    console.warn("⚠️  Banco indisponível — evals de falha de cobrança serão pulados.");
  }
});

after(async () => {
  if (!dbOk) return;
  await wipeTestData();
  await prisma.$disconnect();
});

test("MP fora do ar: o cliente é avisado, o pedido segue aguardando e o operador é alertado", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await awaitingPaymentOrder();
  const start = outbox.length;
  const out = await withRealCredsAnd(failingFetch, () => send(phone, "pix"));

  assert.match(out, /não consegui gerar seu pagamento/i);
  assert.doesNotMatch(out, /MOCKPIX|sandbox|responda \*paguei\*/i);

  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.status, "awaiting_payment", "o pedido continua aguardando pagamento");
  assert.equal(order.pixId, null, "nenhuma cobrança falsa gravada");
  assert.equal(order.pixCopiaECola, null);
  assert.match(order.notes ?? "", /Falha ao gerar a cobrança/);

  assert.match(operatorTextsSince(start), /\[operador\][\s\S]*falhou ao gerar a cobrança/i);
});

test("depois da falha, 'paguei' NÃO marca o pedido como pago", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await awaitingPaymentOrder();
  await withRealCredsAnd(failingFetch, async () => {
    await send(phone, "pix");
    const out = await send(phone, "paguei");
    assert.match(out, /ainda não caiu/i);
  });
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.paidAt, null);
});

test("com credencial real, um pixId 'mock' residual não aprova pelo texto", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await awaitingPaymentOrder("mockpix_legado", "00020126MOCKPIX-legado");
  const out = await withRealCredsAnd(failingFetch, () => send(phone, "paguei"));
  assert.match(out, /ainda não caiu/i);
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.paidAt, null);
});

test("com o MP de volta, repetir *pix* emite a cobrança real", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, orderId } = await awaitingPaymentOrder();
  await withRealCredsAnd(failingFetch, () => send(phone, "pix"));
  const out = await withRealCredsAnd(pixOkFetch, () => send(phone, "pix"));

  assert.match(out, /00020126REAL-PIX-PAYLOAD/);
  assert.doesNotMatch(out, /sandbox/i);
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.pixId, "987654321");
  assert.equal(order.pixCopiaECola, "00020126REAL-PIX-PAYLOAD");
  assert.equal(order.status, "awaiting_payment");
});

// Pix em UMA forma só (dono, 08/10 noite: "vem o card automático e de novo a chave; só precisa de um").
// Caso real: o cartão não aprovou, o cliente mandou "Pix" → saía a bolha nativa E o código em texto.
test("bolha nativa do Pix entregue = a única mensagem da cobrança (sem código repetido, sem número do pedido)", async (t) => {
  if (!dbOk) return t.skip();
  const bubbles: { to: string; body: string; itemName: string }[] = [];
  const adapter = whatsappAdapter as unknown as { sendPixOrderDetails: unknown };
  const original = adapter.sendPixOrderDetails;
  adapter.sendPixOrderDetails = async (to: string, input: { body: string; itemName: string }) => {
    bubbles.push({ to, body: input.body, itemName: input.itemName });
    return { messageId: "bubble" };
  };
  const env = { native: process.env.LIA_NATIVE_PIX, name: process.env.LIA_PIX_MERCHANT_NAME, key: process.env.LIA_PIX_KEY, type: process.env.LIA_PIX_KEY_TYPE };
  Object.assign(process.env, { LIA_NATIVE_PIX: "1", LIA_PIX_MERCHANT_NAME: "Lia Delivery", LIA_PIX_KEY: "12345678000199", LIA_PIX_KEY_TYPE: "CNPJ" });
  try {
    // Cobrança de cartão aberta (link) e o cliente troca pra Pix.
    const { phone, orderId } = await awaitingPaymentOrder("pref-1", "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1");
    await prisma.deliveryOrder.update({ where: { id: orderId }, data: { notes: "Pagamento: cartão" } });
    const out = await withRealCredsAnd(pixOkFetch, () => send(phone, "pix"));
    assert.equal(bubbles.filter((b) => b.to === phone).length, 1, "a bolha saiu");
    assert.doesNotMatch(out, /00020126REAL-PIX-PAYLOAD/, `o código NÃO vem de novo em texto: ${out}`);
    assert.doesNotMatch(bubbles[0].body + bubbles[0].itemName, /#|próxima mensagem/, "sem número do pedido e sem 'próxima mensagem'");
    // Primeira cobrança Pix também: só a bolha.
    const second = await awaitingPaymentOrder();
    const before = bubbles.length;
    const out2 = await withRealCredsAnd(pixOkFetch, () => send(second.phone, "pix"));
    assert.equal(bubbles.length, before + 1);
    assert.doesNotMatch(out2, /00020126REAL-PIX-PAYLOAD/, out2);
    // Pediu o código de novo: aí sim vai em texto.
    const resent = await withRealCredsAnd(pixOkFetch, () => send(second.phone, "manda o codigo de novo"));
    assert.match(resent, /00020126REAL-PIX-PAYLOAD/);
  } finally {
    adapter.sendPixOrderDetails = original;
    for (const [k, v] of [["LIA_NATIVE_PIX", env.native], ["LIA_PIX_MERCHANT_NAME", env.name], ["LIA_PIX_KEY", env.key], ["LIA_PIX_KEY_TYPE", env.type]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
