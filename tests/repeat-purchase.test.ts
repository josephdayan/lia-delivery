// "O de sempre" (dono, 04/09): quem já pediu um produto vê ele em PRIMEIRO, com destaque,
// quando pede de novo — mesmo que o ranking o deixaria de fora do top-3.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5506${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
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
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `rp_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n");
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
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

// No ambiente de teste (13 vitrines desligadas) o Arroz Solito 5kg do Carrefour é o 5º
// candidato de "arroz": sem histórico fica fora do top-3; com histórico tem que ser o 1º.
const SOLITO = { sku: "CRF-MER-216", name: "Arroz Solito Tipo 1 5Kg", qty: 1, unitPrice: 18.69, lineTotal: 18.69, storeKey: "carrefour", storeLabel: "Carrefour" };

test("sem histórico: Solito não é a 1ª opção de 'arroz'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}0001`;
  await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  const reply = await send(phone, "arroz");
  const first = reply.split("\n").find((l) => l.startsWith("*1)*")) ?? "";
  assert.ok(first, reply);
  assert.doesNotMatch(first, /Solito/);
  assert.doesNotMatch(reply, /você já pediu/);
});

test("com pedido entregue de Solito: ele vem em 1º, com estrela e 'você já pediu'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}0002`;
  const user = await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone, cep: "01229-000", deliveryAddress: TEST_ADDRESS, storeKey: "carrefour", storeLabel: "Carrefour",
      items: [SOLITO] as unknown as object, itemsSubtotal: 18.69, serviceFee: 1.87, deliveryFee: 9.9, total: 30.46,
      courierKey: "retailer_delivery", status: "delivered", paidAt: new Date(Date.now() - 7 * 24 * 3_600_000)
    }
  });
  const reply = await send(phone, "arroz");
  const first = reply.split("\n").find((l) => l.startsWith("*1)*")) ?? "";
  assert.match(first, /^\*1\)\* ⭐ Arroz Solito Tipo 1 5Kg — R\$ ?[\d,]+ · _Carrefour[^_]*_ · _você já pediu_$/, reply);
  const lines = reply.split("\n").filter((l) => /^\*\d\)\*/.test(l));
  assert.equal(lines.filter((l) => l.includes("você já pediu")).length, 1, "só o já pedido ganha destaque");
  assert.ok(lines.length <= 3);
});

test("copy: linha com destaque", () => {
  assert.equal(copy.choiceLine(0, "Arroz X", 9.9, undefined, true), "*1)* ⭐ Arroz X — R$ 9,90 · _você já pediu_");
  assert.equal(copy.choiceLine(1, "Arroz Y", 9.9), "*2)* Arroz Y — R$ 9,90");
});
