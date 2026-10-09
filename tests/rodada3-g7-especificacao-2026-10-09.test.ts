// Rodada 3 (09/10, grupo g7): "capa de celular" sem modelo mostrava capa de Motorola Razr de R$ 114. Item que depende de
// especificação não dita (modelo, entrada do cabo, medida…) vira PERGUNTA de uma linha; o resto da lista segue e a
// resposta do cliente volta para a busca daquele item.
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { isBareRacao, racaoStagesMixed, combineSpecQuery, specAnswerLooksValid, specAnswerUnknown, specKindOf } from "../src/lib/spec-ask";
import type { DeliveryContext } from "../src/lib/conversation-types";

test("detecta o item que depende de especificação não dita", () => {
  const kinds: Array<[string, string | null]> = [
    ["capa de celular", "capa"],
    ["capinha", "capa"],
    ["película de vidro", "pelicula"],
    ["carregador", "carregador"],
    ["carregador de celular", "carregador"],
    ["cartucho de impressora", "cartucho"],
    ["toner", "cartucho"],
    ["filtro de água", "filtro"],
    ["filtro de ar", "filtro"],
    ["pneu", "pneu"],
    ["pneu de bicicleta", "pneu"],
    // com a especificação dita, segue normal
    ["capa iphone 13", null],
    ["capa de celular samsung a54", null],
    ["película galaxy a54", null],
    ["carregador usb-c", null],
    ["carregador tipo c", null],
    ["carregador de pilha", null],
    ["carregador de notebook", null],
    ["cartucho hp 664", null],
    ["filtro de água europa", null],
    ["filtro de café", null],
    ["filtro de linha", null],
    ["pneu 175/70 R14", null],
    ["pneu aro 26", null],
    ["ração filhote", null],
    ["ração golden", null],
    ["ração para gato adulto", null],
    // outros usos da palavra
    ["capa de chuva", null],
    ["capa de sofá", null],
    ["arroz", null]
  ];
  for (const [phrase, kind] of kinds) assert.equal(specKindOf(phrase), kind, phrase);
});

test("ração pelada só vira pergunta se o catálogo separa idade/porte", () => {
  assert.ok(isBareRacao("ração"));
  assert.ok(isBareRacao("ração para cachorro"));
  assert.ok(isBareRacao("ração de gato 10kg"));
  assert.ok(!isBareRacao("ração filhote"));
  assert.ok(!isBareRacao("ração golden"));
  assert.ok(!isBareRacao("ração para gato adulto"));
  assert.ok(racaoStagesMixed(["Ração Golden Cães Filhotes 1kg", "Ração Pedigree Cães Adultos 10kg"]));
  assert.ok(racaoStagesMixed(["Ração Premier Pequeno Porte 2kg", "Ração Premier Grande Porte 10kg"]));
  assert.ok(!racaoStagesMixed(["Ração Golden Cães Adultos 1kg", "Ração Pedigree Cães Adultos 10kg"]));
});

test("a resposta curta serve só para a pergunta certa", () => {
  assert.ok(specAnswerLooksValid("capa", "iphone 13"));
  assert.ok(specAnswerLooksValid("capa", "Galaxy A54"));
  assert.ok(specAnswerLooksValid("pelicula", "moto g84"));
  assert.ok(!specAnswerLooksValid("capa", "pilha aa"));
  assert.ok(!specAnswerLooksValid("capa", "arroz"));
  assert.ok(specAnswerLooksValid("carregador", "é tipo c"));
  assert.ok(specAnswerLooksValid("carregador", "lightning"));
  assert.ok(specAnswerLooksValid("carregador", "usb-c"));
  assert.ok(!specAnswerLooksValid("carregador", "iphone 13 pro max e mais uns 20 itens que preciso"));
  assert.ok(specAnswerLooksValid("cartucho", "hp 664"));
  assert.ok(specAnswerLooksValid("pneu", "175/70 R14"));
  assert.ok(specAnswerLooksValid("racao", "filhote porte pequeno"));
  assert.ok(specAnswerUnknown("não sei"));
  assert.ok(specAnswerUnknown("qualquer um"));
  assert.ok(!specAnswerUnknown("iphone 13"));
});

test("a resposta vira a nova frase de busca do item", () => {
  assert.equal(combineSpecQuery({ kind: "capa", query: "capa de celular", qty: 1 }, "iphone 13"), "capa iphone 13");
  assert.equal(combineSpecQuery({ kind: "capa", query: "capa de celular", qty: 2 }, "é iphone 13"), "2 capa iphone 13");
  assert.equal(combineSpecQuery({ kind: "carregador", query: "carregador", qty: 1 }, "é tipo c"), "carregador tipo c");
  assert.equal(combineSpecQuery({ kind: "cartucho", query: "toner", qty: 1 }, "impressora hp 107"), "toner hp 107");
  assert.equal(combineSpecQuery({ kind: "filtro", query: "filtro de água", qty: 1 }, "europa"), "filtro de água europa");
});

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `r3g7_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
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

test("e2e: 'capa de celular' sem modelo pergunta o modelo, não mostra capa nenhuma", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  const reply = await send(phone, "capa de celular");
  assert.match(reply, /qual o modelo do celular/i);
  assert.doesNotMatch(reply, /Razr|R\$ ?\d/i);
  const ctx = await context(phone);
  assert.equal(ctx.specAsk?.asks[0]?.kind, "capa");
});

test("e2e: a resposta 'iphone 13' volta para a busca da capa e limpa a pergunta", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  await send(phone, "capa de celular");
  const reply = await send(phone, "iphone 13");
  assert.match(reply, /iphone 13/i);
  assert.doesNotMatch(reply, /qual o modelo/i);
  assert.equal((await context(phone)).specAsk, undefined);
});

test("e2e: no meio de uma lista, o resto segue e a pergunta vem junto", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  const reply = await send(phone, "arroz, capa de celular e pilha");
  assert.match(reply, /arroz/i);
  assert.match(reply, /qual o modelo do celular/i);
  assert.equal((await context(phone)).specAsk?.asks.length, 1);
  const answer = await send(phone, "galaxy a54");
  assert.match(answer, /galaxy a54/i);
  assert.equal((await context(phone)).specAsk, undefined);
});

test("e2e: com a especificação dita não pergunta nada", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  const reply = await send(phone, "carregador usb-c");
  assert.doesNotMatch(reply, /qual a entrada do cabo/i);
  assert.equal((await context(phone)).specAsk, undefined);
});

test("e2e: carregador pergunta a entrada e 'é tipo c' volta para a busca", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  assert.match(await send(phone, "carregador"), /USB-C, Lightning/);
  const reply = await send(phone, "é tipo c");
  assert.match(reply, /tipo c|usb-c/i);
  assert.equal((await context(phone)).specAsk, undefined);
});

test("e2e: 'não sei' deixa o item de fora sem chutar", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await customer();
  await send(phone, "pneu");
  const reply = await send(phone, "não sei");
  assert.match(reply, /deixo \*pneu\* de fora/i);
  assert.equal((await context(phone)).specAsk, undefined);
});
