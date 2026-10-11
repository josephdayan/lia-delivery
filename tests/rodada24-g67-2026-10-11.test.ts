// Rodada 24, grupo G67 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada24/grupo-b.md (R24-1 a R24-9):
// "não achei X, procura por Y", "não, 4 arroz" depois de "muda o arroz pra 3", "pode ser no Mambo então", o total novo
// prometido depois de reabrir o pedido, tamanho de fralda pelo peso, frete+prazo+mínimo com endereço na pergunta e a troca
// por pedido mínimo que diminuía a medida "pelo mesmo valor".
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, measureRatio, runTurnScoped, samePackFactor } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { detectIntent, parseJoinStoresAsk, parseNamedQtyCorrection, parseSearchRedirect, rejectsUnnamedStore, splitQuestionsOnly, storeNamedIn } from "../src/lib/lia-intents";
import { diaperSizeOf, parseDiaperFitAsk } from "../src/lib/product-question";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5524${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, more?: unknown) => {
    outbox.push({ to, kind: key, text: [text, more].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ") });
    return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
  };
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
beforeEach(() => {
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
after(async () => {
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const base = { flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true };
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ ...base, ...ctxExtra }) } });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g67_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "mambo", storeLabel: "Mambo", ...extra
});

// ---------------------------------------------------------------- R24-1 (A1): "não achei X, procura por Y"

test("R24-1: 'não achei a escova de dente pet, procura por escova dental para cachorro' é a busca de Y", () => {
  assert.deepEqual(parseSearchRedirect("não achei a escova de dente pet, procura por escova dental para cachorro"), {
    query: "escova dental para cachorro",
    replaces: "escova de dente pet",
    afterMiss: true
  });
  assert.deepEqual(parseSearchRedirect("a escova ficou de fora, busca escova dental canina"), { query: "escova dental canina", replaces: "escova", afterMiss: true });
  assert.deepEqual(parseSearchRedirect("pode procurar por sabonete líquido?"), { query: "sabonete liquido", afterMiss: false });
  // "tenta de novo" / "procura outro" / "o mais barato" não são um nome novo; a frente que não é reclamação também não.
  assert.equal(parseSearchRedirect("tenta de novo"), null);
  assert.equal(parseSearchRedirect("procura outro"), null);
  assert.equal(parseSearchRedirect("quero arroz, procura o mais barato"), null);
  assert.equal(parseSearchRedirect("shampoo, procura por condicionador"), null);
});

test("R24-1: na conversa, a reclamação não vira item fantasma", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [bi("mb-fio", "Fio Dental Fiodent Extra Fino 100m", 5.49, { ask: "fio dental" })], notFound: ["escova de dente pet"] });
  const out = await send(c.phone, "não achei a escova de dente pet, procura por escova dental para cachorro");
  assert.doesNotMatch(out, /n[aã]o achei a escova de/i, out);
  assert.doesNotMatch(out, /procura por escova/i, out);
  assert.deepEqual((await ctxOf(c.convoId)).notFound ?? [], []);
});

// ---------------------------------------------------------------- R24-2 (A2): "não, 4 arroz"

test("R24-2: 'não, 4 arroz' é correção da quantidade (não soma)", () => {
  assert.deepEqual(parseNamedQtyCorrection("não, 4 arroz"), { phrase: "arroz", qty: 4 });
  assert.deepEqual(parseNamedQtyCorrection("na verdade 4 do arroz"), { phrase: "arroz", qty: 4 });
  assert.deepEqual(parseNamedQtyCorrection("não, 4 pacotes de arroz"), { phrase: "arroz", qty: 4 });
  // Sem moldura de correção segue sendo pedido (soma); o que já valia continua.
  assert.equal(parseNamedQtyCorrection("4 arroz"), null);
  assert.deepEqual(parseNamedQtyCorrection("peraí, é só 1 molho, não 5"), { phrase: "molho", qty: 1 });
});

test("R24-2: na conversa, 'não, 4 arroz' com 3x arroz na cesta deixa 4x", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [bi("mb-arroz", "Arroz Polido Longo Fino Tipo 1 Camil 5kg", 34.64, { ask: "arroz 5kg", qty: 3, lineTotal: 103.92 }), bi("mb-feijao", "Feijão Carioca Camil 1kg", 8.9, { ask: "feijão" })]
  });
  const out = await send(c.phone, "não, 4 arroz");
  assert.doesNotMatch(out, /somei/i, out);
  const arroz = (await ctxOf(c.convoId)).basket?.find((b) => b.sku === "mb-arroz");
  assert.equal(arroz?.qty, 4, out);
});

// ---------------------------------------------------------------- R24-3 (M1): "pode ser no Mambo então"

test("R24-3: só a loja ('pode ser no Mambo então') é a loja do pedido, não item", () => {
  const labels = ["Mambo", "Casa Santa Luzia", "Cobasi"];
  assert.deepEqual(parseJoinStoresAsk("pode ser no Mambo então", labels), { store: "Mambo", storeOnly: true });
  assert.deepEqual(parseJoinStoresAsk("na casa santa luzia mesmo", labels), { store: "Casa Santa Luzia", storeOnly: true });
  assert.equal(parseJoinStoresAsk("quero o suco da mambo", labels), null);
  assert.equal(parseJoinStoresAsk("o shampoo da cobasi", labels), null);
  assert.equal(parseJoinStoresAsk("mambo", labels), null);
});

// As lojas do ambiente de teste são Carrefour, Oba, Petz, O Boticário e Decathlon.
test("R24-3: na conversa, 'pode ser na Petz então' com 2 lojas tenta juntar na Petz (sem virar item)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("cf-suco", "Suco Del Valle Kapo Maracujá 200ml", 3.62, { ask: "suco", storeKey: "carrefour", storeLabel: "Carrefour" }),
      bi("pz-shampoo", "Shampoo Neutro para Cachorro MyHug 500 ml", 25.08, { ask: "shampoo cachorro", storeKey: "petz", storeLabel: "Petz" })
    ]
  });
  const out = await send(c.phone, "pode ser na Petz então");
  assert.doesNotMatch(out, /já é o que está na sua cesta|não achei/i, out);
  assert.match(out, /\*Petz\*/, out);
  assert.equal((await ctxOf(c.convoId)).basket?.length, 2);
});

async function quotedCustomer(items: BasketItem[]) {
  const c = await customerWith({ basket: [] }, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, status: "awaiting_quote_confirmation", storeKey: items[0].storeKey!, storeLabel: items[0].storeLabel!, items, itemsSubtotal: 20, total: 28 }
  });
  const ctx = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx, deliveryOrderId: order.id, notFound: ["escova de dente pet"] }) } });
  return { ...c, orderId: order.id };
}
const closeAttempts = (out: string) => out.split("\n---\n").filter((m) => /Produtos|Seu pedido|Total/.test(m)).length;

test("R24-3: depois de reabrir o pedido e só buscar (nada mudou na cesta), o total sai de novo no mesmo turno", async (t) => {
  if (!dbOk) return t.skip();
  const c = await quotedCustomer([
    bi("mb-suco", "Suco Kapo Sabor Maracujá Del Valle 200ml", 3.62, { ask: "suco" }),
    bi("mb-barra", "Barra de Cereais Nutry Bolo de Chocolate 22g", 2.85, { ask: "barra de cereal" })
  ]);
  const out = await send(c.phone, "não achei a escova de dente pet, procura por xyzwq canino");
  assert.match(out, /total anterior não vale mais/, out);
  assert.equal(closeAttempts(out.split("total anterior não vale mais")[1] ?? ""), 1, out);
});

test("R24-3: a edição que já fecha o total não ganha um segundo fechamento", async (t) => {
  if (!dbOk) return t.skip();
  const c = await quotedCustomer([
    bi("mb-suco", "Suco Kapo Sabor Maracujá Del Valle 200ml", 3.62, { ask: "suco" }),
    bi("mb-barra", "Barra de Cereais Nutry Bolo de Chocolate 22g", 2.85, { ask: "barra de cereal" })
  ]);
  const out = await send(c.phone, "tira a barra de cereal");
  assert.match(out, /Tirei/, out);
  assert.ok(closeAttempts(out) <= 1, out);
});

// ---------------------------------------------------------------- R24-4/R24-5 (M2/M3): fralda pelo peso

test("R24-4/5: tamanho de fralda pelo peso é pergunta sobre a fralda da cesta", () => {
  const cesta = ["Espaguete Barilla 500g", "Fralda Descartável Pampers Supersequinha M 40 Unidades"];
  assert.deepEqual(parseDiaperFitAsk("e a fralda, é a M mesmo pra bebê de 7 kg?", cesta), { index: 1, asked: "M", kg: 7 });
  assert.deepEqual(parseDiaperFitAsk("minha bebê nasceu com 3,2 kg, que tamanho de fralda é esse? o pampers RN serve?", ["Fralda Pampers Recém Nascido Proteção Insuperável 36 Unidades"]), { index: 0, asked: "RN", kg: 3.2 });
  assert.equal(parseDiaperFitAsk("quero arroz 5 kg", cesta), null);
  assert.equal(parseDiaperFitAsk("quanto pesa o queijo? 1 kg?", cesta), null);
  assert.equal(diaperSizeOf("Fralda Huggies Tripla Proteção Tamanho XG"), "XG");
  assert.equal(diaperSizeOf("Fralda Pampers Confort Sec G 60 Unidades"), "G");
  assert.match(copy.diaperFitAnswer({ size: "M", kg: 7, min: 5.5, max: 9.5, fits: true, suggested: [], inBasket: true }), /Serve, sim/);
  assert.match(copy.diaperFitAnswer({ size: "M", kg: 3.2, min: 5.5, max: 9.5, fits: false, suggested: ["RN", "P"], inBasket: true }), /RN\* ou \*P/);
});

test("R24-4: na conversa, 'é a M mesmo pra bebê de 7 kg?' responde sem busca e sem mexer na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [bi("am-fralda", "Fralda Descartável Pampers Supersequinha M 40 Unidades", 47.29, { ask: "pampers m 40 unidades", storeKey: "americanas", storeLabel: "Americanas" })] });
  const out = await send(c.phone, "e a fralda, é a M mesmo pra bebê de 7 kg?");
  assert.match(out, /Serve, sim/, out);
  assert.doesNotMatch(out, /não achei/i, out);
  assert.equal((await ctxOf(c.convoId)).basket?.length, 1);
});

test("R24-4: com o total na mesa, a dúvida da fralda não derruba o pedido", async (t) => {
  if (!dbOk) return t.skip();
  const items = [bi("am-fralda", "Fralda Descartável Pampers Supersequinha M 40 Unidades", 47.29, { ask: "pampers m", storeKey: "americanas", storeLabel: "Americanas" })];
  const c = await customerWith({ basket: [] }, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, status: "awaiting_quote_confirmation", storeKey: "americanas", storeLabel: "Americanas", items, itemsSubtotal: 47.29, total: 55.29 }
  });
  const ctx = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx, deliveryOrderId: order.id }) } });
  const out = await send(c.phone, "e a fralda, é a M mesmo pra bebê de 7 kg?");
  assert.match(out, /Serve, sim/, out);
  assert.doesNotMatch(out, /total anterior não vale mais/, out);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "awaiting_quote_confirmation");
});

// ---------------------------------------------------------------- R24-6 (M4): frete + prazo + mínimo com endereço

test("R24-6: frete e prazo numa frase com o endereço, mais o mínimo, são três respostas de serviço", () => {
  const text = "antes de pedir: quanto é o frete e em quanto tempo chega na Avenida Paulista 1000, São Paulo? tem pedido mínimo?";
  assert.equal(detectIntent("antes de pedir: quanto é o frete e em quanto tempo chega na Avenida Paulista 1000, São Paulo?").kind, "service_question");
  const topics = (splitQuestionsOnly(text) ?? []).map((i) => (i.kind === "service_question" ? i.topic : i.kind));
  assert.deepEqual(topics, ["fee", "eta", "minimum"]);
});

test("R24-6: na conversa (sem cadastro), uma resposta só e um pedido de endereço só", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const out = await send(phone, "antes de pedir: quanto é o frete e em quanto tempo chega na Avenida Paulista 1000, São Paulo? tem pedido mínimo?");
  assert.match(out, /frete/i, out);
  assert.match(out, /prazo/i, out);
  assert.match(out, /mínimo/i, out);
  assert.equal(out.split("\n---\n").length, 1, out);
});

// ---------------------------------------------------------------- R24-8 (M6): troca por mínimo que diminui a medida

test("R24-8: medida da troca — 2 L → 1 L é metade, e 2× 1 L mantém a medida", () => {
  assert.equal(measureRatio("Água Sanitária Multiuso Safi Cloro Ativo Líquido 2L", "Água Sanitária Ype Líquida Cloro Ativo 1L"), 0.5);
  assert.equal(samePackFactor("Água Sanitária Multiuso Safi Cloro Ativo Líquido 2L", "Água Sanitária Ype Líquida Cloro Ativo 1L"), 2);
  assert.equal(measureRatio("Água Sanitária Safi 2L", "Água Sanitária Ypê 2L"), 1);
  assert.equal(samePackFactor("Lenço Umedecido Huggies 88 Unidades", "Lenço Umedecido Huggies 48 Unidades"), null);
  assert.ok((measureRatio("Lenço Umedecido Huggies 88 Unidades", "Lenço Umedecido Huggies 48 Unidades") ?? 1) < 1);
});

test("R24-8: a oferta não diz só 'mesmo valor' quando vem menos produto", () => {
  const msg = copy.minimumSwapOffer({
    newTotal: 5.49,
    delta: 0,
    storeLabel: "Americanas",
    pairs: [{ fromName: "Água Sanitária Safi 2L", fromPrice: 5.49, toName: "Água Sanitária Ypê 1L", toPrice: 5.49, change: copy.swapMeasureNote("2 l", "1 l", { less: true, samePriceOrMore: true }) }]
  });
  assert.match(msg, /menos produto/, msg);
  assert.match(msg, /1 l em vez de 2 l/, msg);
  assert.match(copy.swapPacksNote(2, "1 l", "2 l"), /os mesmos 2 l/);
});

// ---------------------------------------------------------------- R24-7 (M5): trocar de loja sem saída

test("R24-7: 'mudei de ideia, prefiro tudo na Petz, troca' com o total na mesa vai para juntar na Petz", async (t) => {
  if (!dbOk) return t.skip();
  const c = await quotedCustomer([
    bi("cf-leite", "Leite Integral Longa Vida Parmalat 1 Litro", 5.49, { ask: "leite", qty: 2, lineTotal: 10.98, storeKey: "carrefour", storeLabel: "Carrefour" }),
    bi("pz-shampoo", "Shampoo Neutro para Cachorro MyHug 500 ml", 25.08, { ask: "shampoo cachorro", storeKey: "petz", storeLabel: "Petz" })
  ]);
  const out = await send(c.phone, "mudei de ideia, prefiro tudo na Petz, troca");
  assert.doesNotMatch(out, /\*troca\* eu não achei|O que você (gostaria de|quer) trocar/i, out);
  assert.match(out, /\*Petz\*/, out);
});

test("R24-7: recusa de loja sem nome é reconhecida (e o botão 'Trocar de loja' não conta)", () => {
  assert.equal(rejectsUnnamedStore("mudei de ideia, não quero dessa loja, quero comprar numa outra"), true);
  assert.equal(rejectsUnnamedStore("quero comprar em outra loja"), true);
  assert.equal(rejectsUnnamedStore("Trocar de loja"), false);
  assert.equal(rejectsUnnamedStore("quero outro café"), false);
  assert.equal(storeNamedIn("a santa luzia", ["Mambo", "Casa Santa Luzia"]), "Casa Santa Luzia");
});

test("R24-7: 'não quero dessa loja' pergunta qual loja sai; o nome de uma junta na outra", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("cf-leite", "Leite Integral Longa Vida Parmalat 1 Litro", 5.49, { ask: "leite", storeKey: "carrefour", storeLabel: "Carrefour" }),
      bi("pz-shampoo", "Shampoo Neutro para Cachorro MyHug 500 ml", 25.08, { ask: "shampoo cachorro", storeKey: "petz", storeLabel: "Petz" })
    ]
  });
  const ask = await send(c.phone, "mudei de ideia, não quero dessa loja, quero comprar numa outra");
  assert.match(ask, /Qual loja você quer tirar do pedido: \*Carrefour\* ou \*Petz\*/, ask);
  const out = await send(c.phone, "a carrefour");
  assert.match(out, /\*Petz\*/, out);
  assert.doesNotMatch(out, /não achei/i, out);
  assert.equal((await ctxOf(c.convoId)).storeChangeAsk, undefined);
});
