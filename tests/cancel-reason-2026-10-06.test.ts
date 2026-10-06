// Testadora no grupo (06/10/2026): "quando cancelado faz a pergunta com algumas opções de
// motivo, por exemplo: valor frete, valor produto, comprei outro app, desisti da compra".
// Pedido cancelado → lista de motivos; o toque (ou número/palavra curta) vira nota no pedido;
// qualquer outra mensagem desarma a pergunta e segue o fluxo normal.
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseCancelReason } from "../src/lib/lia-intents";
import { AWAITING_OPERATOR_QUOTE_STATUS } from "../src/lib/order-flags";

test("06/10: motivo do cancelamento — toque, número e palavra curta; pedido novo nunca vira motivo", () => {
  assert.equal(parseCancelReason("cancelmotivo:frete", false), "frete", "o toque vale mesmo sem pergunta aberta");
  assert.equal(parseCancelReason("cancelmotivo:inventado", true), null);
  assert.equal(parseCancelReason("1", true), "frete");
  assert.equal(parseCancelReason("2", true), "preco");
  assert.equal(parseCancelReason("3", true), "outro_app");
  assert.equal(parseCancelReason("4", true), "desisti");
  assert.equal(parseCancelReason("5", true), "outro");
  assert.equal(parseCancelReason("frete caro", true), "frete");
  assert.equal(parseCancelReason("achei o produto caro", true), "preco");
  assert.equal(parseCancelReason("comprei em outro app", true), "outro_app");
  assert.equal(parseCancelReason("no rappi tava melhor", true), "outro_app");
  assert.equal(parseCancelReason("desisti", true), "desisti");
  assert.equal(parseCancelReason("1", false), null, "sem pergunta aberta, número é número");
  assert.equal(parseCancelReason("quero arroz e feijão", true), null);
  assert.equal(parseCancelReason("pilha aaa", true), null);
});

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5501${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}7`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
let prisma: typeof import("../src/lib/prisma").prisma;
let handleDeliveryMessage: typeof import("../src/lib/delivery-service").handleDeliveryMessage;

async function customerWithQuote() {
  const phone = `${PREFIX}${String(++seq).padStart(3, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS } });
  const convo = await prisma.conversation.create({ data: { userId: user.id } });
  const order = await prisma.deliveryOrder.create({
    data: { userId: user.id, conversationId: convo.id, phone, items: [{ name: "Pilha AAA", qty: 1, unitPrice: 11.15 }], status: AWAITING_OPERATOR_QUOTE_STATUS, cep: "01310-100", deliveryAddress: ADDRESS }
  });
  await prisma.conversation.update({
    where: { id: convo.id },
    data: { context: JSON.stringify({ flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, step: "awaiting_quote", deliveryOrderId: order.id, storeKey: "concierge" }) }
  });
  const send = async (text: string) => {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `cancelreason_${RUN}_${++seq}` });
    return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  };
  return { phone, userId: user.id, orderId: order.id, convoId: convo.id, send };
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
  ({ prisma } = await import("../src/lib/prisma"));
  ({ handleDeliveryMessage } = await import("../src/lib/delivery-service"));
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  (whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
    outbox.push({ to, text });
    return { provider: "test", to, text };
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  if (!dbOk) return;
  await wipe();
  await prisma.$disconnect();
});

test("06/10: pedido cancelado pergunta o motivo; '1' vira nota 'Frete caro' no pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithQuote();
  const canceled = await c.send("cancelar");
  assert.match(canceled, /Cancelado\. Nada foi cobrado/, canceled);
  assert.match(canceled, /por que cancelou\?[\s\S]*\*1\)\* Frete caro[\s\S]*\*3\)\* Comprei em outro app/, canceled);
  const thanks = await c.send("1");
  assert.match(thanks, /anotei/, thanks);
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: c.orderId } });
  assert.equal(order.status, "canceled");
  assert.match(order.notes ?? "", /Motivo do cancelamento \(cliente\): Frete caro/);
  const ctx = JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: c.convoId } })).context ?? "{}");
  assert.equal(ctx.cancelReason, undefined, "uma resposta só");
});

test("06/10: depois de perguntar o motivo, um pedido novo segue o fluxo normal (não vira motivo)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWithQuote();
  await c.send("cancelar");
  await c.send("oi");
  const order = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: c.orderId } });
  assert.doesNotMatch(order.notes ?? "", /Motivo do cancelamento/);
  const ctx = JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: c.convoId } })).context ?? "{}");
  assert.equal(ctx.cancelReason, undefined, "a pergunta desarma");
  const late = await c.send("cancelmotivo:desisti");
  assert.match(late, /anotei/, "o toque atrasado na lista ainda vale");
  const after = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: c.orderId } });
  assert.match(after.notes ?? "", /Desisti da compra/);
});
