// "Preciso pra hoje" (dono, 04/09): a vitrine fica só com o que a loja entrega em menos de
// 1 dia (prazo da entrega mais rápida); se ninguém entrega hoje, diz isso e mostra o mais
// rápido. Simulação injetada; lojas de teste (Carrefour/Oba) tratadas como consultáveis.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { __setLiveSimulateForTests } from "../src/lib/live-availability";
import type { LiveItemCheck } from "../src/lib/live-freight";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5504${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `ug_${RUN}_${++seq}` });
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
  __setLiveSimulateForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});
async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  return phone;
}
const optionLines = (reply: string) => reply.split("\n").filter((l) => /^\*\d\)\*/.test(l));
// Só o Arroz Solito (Carrefour, 5º do ranking) tem entrega em 2h; o resto, 1 dia útil.
const simulate = async (_store: string, skus: string[]) =>
  new Map<string, LiveItemCheck>(
    skus.map((sku) => [
      sku,
      sku === "CRF-MER-216"
        ? { sku, available: true, fee: 6.9, estimate: "1bd", etaMinutes: 1440, fastFee: 8.9, fastEstimate: "2h", fastEtaMinutes: 120 }
        : { sku, available: true, fee: 6.9, estimate: "1bd", etaMinutes: 1440, fastFee: 6.9, fastEstimate: "1bd", fastEtaMinutes: 1440 }
    ])
  );

test("'preciso de arroz hoje': só quem entrega hoje aparece, com o prazo rápido no card", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(simulate, () => true);
  const phone = await customer();
  const reply = await send(phone, "preciso de arroz pra hoje");
  assert.match(reply, /Chega hoje — opções de \*arroz\*/, reply.slice(0, 300));
  const lines = optionLines(reply);
  assert.equal(lines.length, 1, reply);
  assert.match(lines[0], /Solito/);
  assert.match(lines[0], /_Carrefour · 2h_/);
  assert.doesNotMatch(reply, /Nada chega hoje/);
});

test("'preciso de arroz hoje' sem ninguém entregando hoje: diz isso e mostra o mais rápido", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(
    async (_s: string, skus: string[]) => new Map(skus.map((sku) => [sku, { sku, available: true, fee: 6.9, estimate: "1bd", etaMinutes: 1440, fastFee: 6.9, fastEstimate: "1bd", fastEtaMinutes: 1440 }])),
    () => true
  );
  const phone = await customer();
  const reply = await send(phone, "arroz urgente pra hoje");
  assert.match(reply, /Nada chega hoje para \*arroz\* nas lojas que consigo confirmar\. O mais rápido que tenho:/, reply.slice(0, 300));
  assert.ok(optionLines(reply).length >= 1, reply);
});

test("sem urgência, nada muda: cabeçalho normal e prazo da entrega mais barata", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(simulate, () => true);
  const phone = await customer();
  const reply = await send(phone, "arroz");
  assert.match(reply, /Olha o que achei 👇/, reply.slice(0, 200));
  assert.doesNotMatch(reply, /Chega hoje|Nada chega hoje/);
  assert.match(reply, /· 1 dia útil_/);
});
