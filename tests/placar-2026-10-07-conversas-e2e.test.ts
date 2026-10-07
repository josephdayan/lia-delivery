// Placar de conversas de 07/10/2026 (scripts/bench-conversations.mts): cada teste guarda um defeito
// reproduzido na conversa de um "cliente" contra a Lia de verdade. Puros em placar-2026-10-07-conversas.test.ts;
// aqui, a conversa com banco local (IA desligada: parser determinístico).
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
  if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
  (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
    outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
    return key === "sendDeliveryChoices" ? false : { provider: "test", to };
  };
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `esc_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
type Line = { sku: string; name: string; qty: number };
async function basket(phone: string): Promise<Line[]> {
  return ((await context(phone)).basket ?? []) as Line[];
}
// Escolha aberta montada à mão: duas lojas e prazos conhecidos (o seed de teste é uma loja só).
async function withChoice(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const options = [
    { sku: "CRF-PAD-003", name: "Leite UHT Integral Carrefour Classic 1L", unitPrice: 5.38, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 },
    { sku: "MB-LEITE-1", name: "Leite Integral Italac 1L", unitPrice: 6.04, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje", etaMinutes: 120 },
    { sku: "CRF-PAD-027", name: "Leite Integral Jussara Max 1L", unitPrice: 5.71, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }
  ];
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", step: "choosing", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pending: [{ query: "leite", qty: 1, options }], pendingSince: Date.now() })
    }
  });
  return options;
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
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});


test("c40/c28: depois de 'não achei', 'tenta de novo' refaz uma vez e depois diz a verdade; pedido novo não herda o 'não achei'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero bola de tenis");
  assert.match(first, /eu não achei/i, first.slice(0, 200));
  const retry = await send(phone, "Pode ser qualquer marca, tenta de novo.");
  assert.match(retry, /eu não achei/i, retry.slice(0, 200));
  assert.doesNotMatch(retry, /tenta de novo\*/i, "a frase do cliente não pode virar produto");
  const honest = await send(phone, "tenta de novo");
  assert.match(honest, /Procurei de novo/i, honest.slice(0, 200));
  const next = await send(phone, "quero leite");
  assert.doesNotMatch(next, /bola de t[eê]nis/i, next.slice(0, 200));
  assert.match(next, /Leite/i);
});

test("c30: o 2º pedido de atendente em seguida não repete o mesmo texto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const one = await send(phone, "quero falar com uma pessoa");
  const two = await send(phone, "preciso falar com um atendente mesmo");
  assert.match(one, /Avisei o responsável/);
  assert.notEqual(one, two);
  assert.match(two, /Já avisei o responsável/);
});

test("c36: 'não gostei dessas, quero da dove' busca o mesmo produto da marca — não tira o item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero desodorante");
  const out = await send(phone, "não gostei dessas, quero da dove");
  assert.doesNotMatch(out, /Deixei .* de fora/i, out.slice(0, 300));
  const ctx = await context(phone);
  assert.equal(ctx.step, "choosing", "a escolha do desodorante continua aberta");
});

test("c12: 'acho que vou no 1, Omo 1,4kg' é escolha — 1 unidade na cesta, sem item novo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const options = [
    { sku: "CRF-LIM-001", name: "Lava Roupas em Pó Lavagem Perfeita Omo 1,4kg", unitPrice: 20.79, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 },
    { sku: "CRF-LIM-002", name: "Lava Roupas em Pó Primavera Tixan Ypê 1,6kg", unitPrice: 28.58, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }
  ];
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", step: "choosing", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pending: [{ query: "sabão em pó", qty: 1, options }] })
    }
  });
  const out = await send(phone, "Acho que vou no 1, Omo 1,4kg.");
  assert.doesNotMatch(out, /Anotei \*Omo/i, out.slice(0, 300));
  const items = await basket(phone);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 1);
  assert.match(items[0].name, /Omo/);
  assert.equal(((await context(phone)).pending ?? []).length, 0, "nada novo na fila");
});

test("c10: 'tira o arroz, por favor' com o total na mesa mostra o total novo — não a saudação", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero 4 carne");
  await send(phone, "1");
  await send(phone, "quero arroz");
  await send(phone, "1");
  const quote = await send(phone, "pagar");
  assert.match(quote, /Seu pedido/, quote.slice(0, 400));
  const out = await send(phone, "Tira o arroz, por favor.");
  assert.doesNotMatch(out, /Oi! Sou a Lia/i, out.slice(0, 400));
  assert.match(out, /Tirei/i);
  assert.match(out, /Total|Seu pedido/i, out.slice(0, 400));
  assert.match(out, /Carne/i, "a carne ficou no novo total");
  assert.doesNotMatch(out.split("Tirei")[1] ?? "", /• .*Arroz/i, "o arroz saiu do novo total");
});

test("c16: 'trocar endereço — <endereço completo>' usa o endereço da própria mensagem", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero arroz");
  await send(phone, "1");
  await send(phone, "pagar");
  const out = await send(phone, "trocar endereço — Rua Oscar Freire, 379, apto 12, 01426-001");
  assert.doesNotMatch(out, /Manda o \*endereço novo/i, out.slice(0, 300));
  assert.match(out, /Endereço atualizado/i, out.slice(0, 300));
});
