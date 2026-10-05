// Compra real do dono em 05/10/2026 (lenço umedecido, #9AK28P → #FZUI31). Cada teste
// guarda um dos defeitos daquela conversa:
//   1. preço que a loja BAIXOU no fechamento regravava a conversa com a cesta antiga →
//      "Saiu o total do seu pedido — esse é separado", o "cartão" abria um SEGUNDO pedido e
//      o cliente recebia a cobrança duas vezes;
//   2. aviso "a loja mudou o preço" quando o preço só caiu;
//   3. toque em outro card do MESMO carrossel virava "botão de conversa antiga";
//   4. a confirmação do "Adicionar ao carrinho" é só "✅ produto".
// Banco local + WhatsApp mock + simulação VTEX mockada (fetch).
import "./helpers/load-env";
// A compra real foi na Mambo (frete e preço por simulação VTEX); o harness desliga a loja.
import "./helpers/enable-mambo";
process.env.LIA_MANUAL_CONCIERGE = "true";

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5501${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}9`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
const realFetch = globalThis.fetch;

const LENCO = {
  sku: "mambo-8152",
  name: "Lenço Umedecido Turma da Mônica Huggies com 48 unidades",
  brand: "Huggies",
  unitPrice: 13.9,
  storeKey: "mambo",
  storeLabel: "Mambo",
  productUrl: "https://www.mambo.com.br/lenco-umedecido-turma-da-monica-huggies-com-48-unidades/p"
};

// Simulação VTEX da Mambo: preço por unidade em centavos + uma entrega.
function mockSimulation(sellingPriceCents: number) {
  process.env.LIA_LIVE_FREIGHT_OFF = "false";
  process.env.LIA_CHARGE_ONLY_VERIFIED = "true";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("orderForms/simulation")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
      return new Response(
        JSON.stringify({
          items: body.items.map((i) => ({ id: i.id, quantity: i.quantity, sellingPrice: sellingPriceCents, availability: "available" })),
          logisticsInfo: body.items.map((_, itemIndex) => ({ itemIndex, slas: [{ name: "Normal", price: 1590, shippingEstimate: "6h" }] }))
        }),
        { status: 200 }
      );
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
}

async function customerWithBasket(qty: number) {
  const phone = `${PREFIX}${String(++seq).padStart(3, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS } });
  const send = async (text: string) => {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `lenco_${RUN}_${++seq}` });
    return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  };
  const convo = await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        step: "collecting",
        storeKey: "concierge",
        basket: [{ ...LENCO, qty, lineTotal: LENCO.unitPrice * qty }]
      })
    }
  });
  return { phone, userId: user.id, convoId: convo.id, send };
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
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.LIA_LIVE_FREIGHT_OFF = "true";
  process.env.LIA_CHARGE_ONLY_VERIFIED = "false";
});
after(async () => {
  if (!dbOk) return;
  await wipe();
  await prisma.$disconnect();
});

test("05/10: preço que CAI no fechamento não reabre a cesta, não avisa e o cartão não cria 2º pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithBasket(2);
  mockSimulation(1290); // catálogo R$13,90 → loja cobra R$12,90 agora
  const quote = await c.send("pagar");
  assert.doesNotMatch(quote, /separado do que a gente/i, quote.slice(0, 300));
  assert.doesNotMatch(quote, /mudou o preço/i, "preço menor não é aviso");
  const orders = await prisma.deliveryOrder.findMany({ where: { userId: c.userId } });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "awaiting_quote_confirmation");
  assert.equal((orders[0].items as { unitPrice: number }[])[0].unitPrice, 12.9, "o total sai com o preço da loja");
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: c.convoId } });
  const ctx = JSON.parse(convo.context ?? "{}");
  assert.equal(ctx.deliveryOrderId, orders[0].id, "a conversa aponta para o pedido cotado");
  assert.equal(ctx.step, "awaiting_quote_confirmation");
  assert.ok(!ctx.basket?.length, "a cesta não volta para a conversa");

  const card = await c.send("cartao");
  assert.doesNotMatch(card, /Me perdi aqui/, card.slice(0, 300));
  const after = await prisma.deliveryOrder.findMany({ where: { userId: c.userId } });
  assert.equal(after.length, 1, `um pedido só (veio: ${after.map((o) => o.status).join(", ")})`);
  assert.equal(after[0].status, "awaiting_payment");
});

test("05/10: preço que SOBE no fechamento continua avisado antes do total", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithBasket(1);
  mockSimulation(1500);
  const quote = await c.send("pagar");
  assert.match(quote, /mudou o preço/i, quote.slice(0, 300));
  const orders = await prisma.deliveryOrder.findMany({ where: { userId: c.userId } });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "awaiting_quote_confirmation");
});

test("05/10: toque em outro card do carrossel que ainda está na tela entra na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithBasket(1);
  // Conversa depois do pedido recusado: só endereço, nenhuma escolha aberta.
  await prisma.conversation.update({
    where: { id: c.convoId },
    data: { context: JSON.stringify({ flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true }) }
  });
  const pending = {
    query: "lenço umedecido",
    qty: 1,
    options: [
      { ...LENCO },
      { sku: "drogariaspacheco-834920", name: "Lenço Umedecido Piquitucho Premium Capim Limão 60 Unidades", unitPrice: 8.96, storeKey: "drogariaspacheco", storeLabel: "Drogarias Pacheco" }
    ]
  };
  await prisma.message.create({ data: { conversationId: c.convoId, sender: "carousel", metadata: `wamid.lenco.${RUN}`, text: JSON.stringify({ header: "Olha o que achei 👇", pending }) } });
  const out = await c.send("optsku:mambo-8152");
  assert.doesNotMatch(out, /conversa antiga/i, out);
  assert.match(out, /^✅ Lenço Umedecido Turma da Mônica Huggies com 48 unidades$/m, out);
  assert.doesNotMatch(out, /1 un —|quer mais\? é só falar/i, "confirmação curta");
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: c.convoId } });
  const ctx = JSON.parse(convo.context ?? "{}");
  assert.deepEqual(ctx.basket.map((i: { sku: string }) => i.sku), ["mambo-8152"]);
});

test("05/10: botão de carrossel que nunca foi mostrado continua sendo 'conversa antiga'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithBasket(1);
  await prisma.conversation.update({
    where: { id: c.convoId },
    data: { context: JSON.stringify({ flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true }) }
  });
  const out = await c.send("optsku:mambo-999999");
  assert.match(out, /conversa antiga/i);
});
