// Rodada 23, grupo G65 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada23/grupo-a.md (N1-N5, R22-7 obs.,
// R22a-7) e grupo-b.md (R23-6 a R23-10): recusa da loja no fechamento, papaya × petisco, sogra/compras apertadas, quentinha,
// "quanto tá dando o frango?", Pepsi Twist no "mais barato", teto por extenso na escolha, "pode ser essa", pastilha,
// "hoje de desinfetante", "Basic+ Care Baby", "melhor preta" e "amaciante eu já disse que não quero".
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import {
  bareColorTarget,
  cheapestForOrder,
  handleDeliveryMessage,
  namesOnlyBasketItem,
  parseBareColorPref,
  runTurnScoped,
  sameFreshProduct
} from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { detectIntent, normalizeMsg, parseAlreadyDeclined, parseItemPriceAsk, parseRefusedRetry, stripReturnLead } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { scoreCatalogMatch, unaskedVariantMarker, type CatalogItem } from "../src/lib/stores/types";
import { namedProductWords } from "../src/lib/recommend/handle";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5523${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g65_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const cat = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({ sku: `t-${name}`, name, unitPrice: 10, unit: "un", ...extra }) as CatalogItem;

// ---------------------------------------------------------------- R23-6: loja recusou a cesta no fechamento

test("R23-6: 'tira a alface e tenta de novo' é refazer a lista recusada sem a alface", () => {
  assert.deepEqual(parseRefusedRetry("tira a alface e tenta de novo"), { drop: ["alface"], retry: true });
  assert.deepEqual(parseRefusedRetry("tenta de novo"), { drop: [], retry: true });
  assert.deepEqual(parseRefusedRetry("pode tentar de novo sem o frango"), { drop: ["frango"], retry: true });
  assert.deepEqual(parseRefusedRetry("tira a alface"), { drop: ["alface"], retry: false });
  assert.equal(parseRefusedRetry("quero alface"), null);
});

test("R23-6: a recusa diz que a lista ficou guardada e como tentar de novo", () => {
  const msg = copy.itemsNotDeliverableHere(["alface", "tomate"], false, true);
  assert.match(msg, /tenta de novo/, msg);
  assert.doesNotMatch(copy.itemsNotDeliverableHere(["alface"], false), /tenta de novo/);
});

test("R23-6: na falta de alternativa já vista, só vale o MESMO hortifrúti (sem molho, picado ou em cubos)", () => {
  assert.equal(sameFreshProduct({ name: "Tomate Italiano (unidade ~160 g)" }, { name: "Tomate Pelado Raiola 2,5kg" }), false);
  assert.equal(sameFreshProduct({ name: "Tomate Italiano (unidade ~160 g)" }, { name: "Tomate Débora (unidade ~150 g)" }), true);
  assert.equal(sameFreshProduct({ name: "Cebola Pacote 1kg" }, { name: "Cebola Alho e Salsa Swift 85g", brand: "Swift" }), false);
  assert.equal(sameFreshProduct({ name: "Cebola Pacote 1kg" }, { name: "Cebola Branca 1kg" }), true);
  assert.equal(sameFreshProduct({ name: "Batata Lavada Pacote 2kg" }, { name: "Batata-doce em Cubos Swift 300g", brand: "Swift" }), false);
});

test("R23-6: com a lista recusada guardada, 'tira a alface e tenta de novo' procura o resto (sem 'não achei na cesta')", async (t) => {
  if (!dbOk) return t.skip();
  const refusedBasket = { items: [bi("sw-alface", "Alface Crespa Swift", 4.99, { ask: "alface" }), bi("sw-tomate", "Tomate Italiano (unidade ~160 g)", 1.2, { ask: "tomate" })], at: Date.now() };
  const c = await customerWith({ basket: [], refusedBasket });
  const out = await send(c.phone, "tira a alface e tenta de novo");
  assert.match(out, /Tirei \*alface\*/, out);
  assert.match(out, /Procurando de novo: \*tomate\*/, out);
  assert.doesNotMatch(out, /n[aã]o achei (?:esse item )?na sua cesta/i, out);
  assert.equal((await ctxOf(c.convoId)).refusedBasket, undefined);
});

test("R23-6: tirar tudo o que foi recusado não procura nada", async (t) => {
  if (!dbOk) return t.skip();
  const refusedBasket = { items: [bi("sw-alface", "Alface Crespa Swift", 4.99, { ask: "alface" })], at: Date.now() };
  const c = await customerWith({ basket: [], refusedBasket });
  const out = await send(c.phone, "tira a alface e tenta de novo");
  assert.match(out, /não sobrou nada da lista/, out);
});

// ---------------------------------------------------------------- R23-7: papaya

test("R23-7: 'papaya' não casa o petisco Papaya Pets só pela marca", () => {
  const pet = cat("Petisco Papaya Pets para Cães Sabor Frango 65g", { brand: "Papaya Pets", category: "Pet" });
  assert.equal(scoreCatalogMatch("papaya", pet), 0);
  assert.ok(scoreCatalogMatch("papaya", cat("Mamão Papaya (unidade ~400 g)")) > 0);
  // Pedido do pet (marca inteira ou o animal dito): continua casando.
  assert.ok(scoreCatalogMatch("petisco papaya pets", pet) > 0);
  assert.ok(scoreCatalogMatch("petisco papaya cachorro", pet) > 0);
});

test("R23-7: 'troca o mamão por papaya' com o papaya já na cesta diz que já é (sem nova busca)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [bi("sw-papaya", "Mamão Papaya (unidade ~400 g)", 6.9, { ask: "mamão", storeKey: "swift", storeLabel: "Swift" })] });
  const out = await send(c.phone, "troca o mamão por papaya");
  assert.match(out, /já é \*papaya\*/, out);
  assert.equal((await ctxOf(c.convoId)).basket?.[0]?.sku, "sw-papaya");
  // Repetir só o pedido de antes não é "já é": "troca o leite por leite em pó" segue sendo troca.
  const d = await customerWith({ basket: [bi("am-leite", "Leite Integral Piracanjuba 1L", 5.9, { ask: "leite integral" })] });
  const swap = await send(d.phone, "troca o leite por leite em po");
  assert.doesNotMatch(swap, /já é/, swap);
});

// ---------------------------------------------------------------- R23-8: frases da vida não viram item

test("R23-8: 'to fazendo as compras pra minha sogra que ta de cama' e 'compra do mês apertada' não viram itens", () => {
  assert.deepEqual(resolveListItems("to fazendo as compras pra minha sogra que ta de cama, arroz, feijão e leite").map((l) => l.phrase), ["arroz", "feijão", "leite"]);
  assert.deepEqual(resolveListItems("to comprando pra minha sogra: arroz, feijão e leite").map((l) => l.phrase), ["arroz", "feijão", "leite"]);
  assert.deepEqual(resolveListItems("a compra do mes ta apertada, arroz, feijão e óleo").map((l) => l.phrase), ["arroz", "feijão", "óleo"]);
});

// ---------------------------------------------------------------- R23-9: quentinha e preço de um item

test("R23-9: 'vcs vendem quentinha?' é pergunta de serviço (comida pronta), não busca", () => {
  assert.deepEqual(detectIntent("vcs vendem quentinha?"), { kind: "service_question", topic: "hot_meal" });
  assert.deepEqual(detectIntent("tem marmitex?"), { kind: "service_question", topic: "hot_meal" });
  assert.notEqual(detectIntent("quero uma marmita congelada").kind, "service_question");
  assert.match(copy.serviceAnswer("hot_meal", "São Paulo"), /congeladas/);
});

test("R23-9: 'quanto ta dando o frango?' pergunta o preço do item (o total segue sendo o total)", () => {
  assert.equal(parseItemPriceAsk("quanto ta dando o frango?"), "frango");
  assert.equal(parseItemPriceAsk("quanto custa o arroz"), "arroz");
  assert.equal(parseItemPriceAsk("quanto ta dando?"), null);
  assert.equal(parseItemPriceAsk("quanto ta o total?"), null);
  assert.equal(parseItemPriceAsk("quanto deu tudo?"), null);
});

test("R23-9: na conversa, 'quanto ta dando o frango?' responde o frango da cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [bi("sw-frango", "Frango Inteiro Temperado Swift (unidade ~1,7 kg)", 28.99, { ask: "frango", storeKey: "swift", storeLabel: "Swift" }), bi("sw-arroz", "Arroz Tio João 5kg", 27.9, { ask: "arroz", storeKey: "swift", storeLabel: "Swift" })]
  });
  const out = await send(c.phone, "quanto ta dando o frango?");
  assert.match(out, /\*Frango Inteiro Temperado Swift[^*]*\*/, out);
  assert.match(out, /está saindo/, out);
  assert.doesNotMatch(out, /Arroz/, out);
});

test("R23-9: na conversa, 'vcs vendem quentinha?' com escolha aberta responde e mantém as opções", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [{ query: "arroz", qty: 1, options: [opt("am-a", "Arroz Tio João 5kg", 27.9), opt("am-b", "Arroz Camil 5kg", 25.9)] }] }, "choosing");
  const out = await send(c.phone, "vcs vendem quentinha?");
  assert.match(out, /Quentinha pronta/, out);
  assert.equal((await ctxOf(c.convoId)).pending?.[0]?.query, "arroz");
});

// ---------------------------------------------------------------- R23-10: Pepsi Twist no "mais barato"

test("R23-10: 'o mais barato' de refrigerante genérico não leva a Pepsi Twist (sabor não pedido)", () => {
  assert.equal(unaskedVariantMarker("refrigerante 2 litros", "Refrigerante Pepsi Twist Pet 2 Litros"), true);
  assert.equal(unaskedVariantMarker("refrigerante 2 litros", "Refrigerante Pepsi Pet 2 Litros"), false);
  // "com 10 unidades" não é sabor: o ovo mais barato continua o mais barato.
  assert.equal(unaskedVariantMarker("ovos", "Ovos Caipira Ito country com 10 Unidades"), false);
  const p: PendingChoice = { query: "refrigerante 2 litros", qty: 1, options: [opt("a", "Refrigerante Pepsi Twist Pet 2 Litros", 7.49), opt("b", "Refrigerante Coca-Cola Original 2L", 9.99)] } as PendingChoice;
  assert.equal(cheapestForOrder({ basket: [] } as unknown as DeliveryContext, p).index, 1);
  const eggs: PendingChoice = { query: "ovos", qty: 1, options: [opt("a", "Ovos Vermelho Caipira Mantiqueira Grandes - 10 un", 18.37), opt("b", "Ovos Caipira Ito country com 10 Unidades", 15.38)] } as PendingChoice;
  assert.equal(cheapestForOrder({ basket: [] } as unknown as DeliveryContext, eggs).index, 1);
});

// ---------------------------------------------------------------- R23a-1: teto por extenso na escolha

test("R23a-1: 'no máximo uns trezentos reais' com a lista andando é o teto do pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      basket: [bi("am-sab", "Sabonete Dove 90g", 4.5)],
      pending: [
        { query: "shampoo", qty: 1, options: [opt("am-sh1", "Shampoo Seda 325ml", 14.9), opt("am-sh2", "Shampoo Elseve 400ml", 22.9)] },
        { query: "condicionador", qty: 1, options: [opt("am-co1", "Condicionador Seda 325ml", 15.9)] }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "no máximo uns trezentos reais");
  assert.match(out, /R\$ 300,00\* no total/, out);
  assert.equal((await ctxOf(c.convoId)).orderBudget?.cap, 300);
});

// ---------------------------------------------------------------- R23a-2: "pode ser essa" depois de "a mais barata é a 3"

test("R23a-2: 'pode ser essa' leva a opção que a Lia acabou de apontar", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    { pending: [{ query: "dipirona gotas", qty: 1, highlightSku: "dsp-3", options: [opt("dsp-1", "Dipirona Gotas EMS 20ml", 9.9, "dsp", "Drogaria SP"), opt("dsp-2", "Dipirona Gotas Medley 20ml", 8.9, "dsp", "Drogaria SP"), opt("dsp-3", "Dipirona Gotas Neo Química 20ml", 6.9, "dsp", "Drogaria SP")] }] },
    "choosing"
  );
  const out = await send(c.phone, "pode ser essa");
  assert.match(out, /✅.*Neo Química/, out);
  assert.ok((await ctxOf(c.convoId)).basket?.some((i) => i.sku === "dsp-3"));
});

test("R23a-2: 'pode ser essa' sem nada apontado pergunta qual, com os números", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    { pending: [{ query: "dipirona gotas", qty: 1, options: [opt("dsp-1", "Dipirona Gotas EMS 20ml", 9.9, "dsp", "Drogaria SP"), opt("dsp-2", "Dipirona Gotas Medley 20ml", 8.9, "dsp", "Drogaria SP")] }] },
    "choosing"
  );
  const out = await send(c.phone, "pode ser essa");
  assert.match(out, /Qual delas\?/, out);
  assert.match(out, /\*2\* — Dipirona Gotas Medley/, out);
});

// ---------------------------------------------------------------- R23a-3: pastilha para garganta

test("R23a-3: o produto dito junto do sintoma ('pastilha') manda na prateleira e no título", () => {
  assert.deepEqual(namedProductWords("pastilha para garganta", "dor de garganta"), ["pastilha"]);
  assert.deepEqual(namedProductWords("to com dor de garganta", "dor de garganta"), []);
  assert.equal(copy.priceSortedHeader("pra dor de garganta", true), "As opções mais em conta pra dor de garganta:");
  assert.equal(copy.priceSortedHeader("arroz", true), "As mais baratas de *arroz*:");
});

// ---------------------------------------------------------------- R23a-4: "preciso hoje de desinfetante"

test("R23a-4: 'preciso hoje de desinfetante, …' não cria o item 'hoje de desinfetante'", () => {
  assert.deepEqual(
    resolveListItems("preciso hoje de desinfetante, pano de chão, rodo, vassoura e saco de lixo").map((l) => l.phrase),
    ["desinfetante", "pano de chão", "rodo", "vassoura", "saco de lixo"]
  );
});

// ---------------------------------------------------------------- R23a-5: baixos

test("R23a-5: 'Nada chega hoje' não se repete item a item — os seguintes dizem 'também sem entrega hoje'", () => {
  assert.equal(copy.noneTodayAgainHeader("rodo"), "Agora *rodo* (também sem entrega hoje) — o mais rápido:");
});

test("R23a-5: 'voltei. sim' é o sim (a volta não engole a resposta)", () => {
  assert.equal(stripReturnLead(normalizeMsg("voltei. sim pode ser")), "sim pode ser");
  assert.equal(stripReturnLead(normalizeMsg("oi voltei, pode ser")), "pode ser");
  assert.equal(detectIntent("voltei, sim").kind, detectIntent("sim").kind);
});

test("R23a-5: 'Basic+ Care Baby' é um nome só (o '+' colado não separa itens)", () => {
  assert.deepEqual(resolveListItems("algodão Basic+ Care Baby e lenço").map((l) => l.phrase), ["algodão Basic+ Care Baby", "lenço"]);
  assert.deepEqual(resolveListItems("arroz + feijão").map((l) => l.phrase), ["arroz", "feijão"]);
});

const ALGODAO = bi("am-alg", "Algodão Higiene Bebê Basic+ Care Baby 100 Unidades", 30.79);
const TERMO = { query: "termômetro bebê", qty: 1, options: [opt("dsp-t1", "Termômetro Clínico Digital G-tech Branco 1 Unidade", 15.39, "dsp", "Drogaria SP"), opt("dsp-t2", "Termômetro Digital Multilaser Hc148", 16.05, "dsp", "Drogaria SP")] };

test("R23a-5: 'o de bebê, o Basic+ Care Baby' com o algodão já na cesta aponta o item da cesta", () => {
  const ctx = { step: "choosing", basket: [ALGODAO], pending: [TERMO] } as unknown as DeliveryContext;
  assert.equal(namesOnlyBasketItem(ctx, "o de bebê, o Basic+ Care Baby")?.sku, "am-alg");
  assert.equal(namesOnlyBasketItem(ctx, "o multilaser"), null);
});

test("R23a-5: na conversa, 'o de bebê, o Basic+ Care Baby' não soma +1 nem inventa 'óleo Basic'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [ALGODAO], pending: [TERMO] }, "choosing");
  const out = await send(c.phone, "o de bebê, o Basic+ Care Baby");
  assert.match(out, /já é o que está na sua cesta/, out);
  assert.doesNotMatch(out, /[oó]leo/i, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((i) => i.sku === "am-alg")?.qty, 1);
  assert.equal(ctx.pending?.[0]?.query, "termômetro bebê");
});

const CANETA = bi("am-can", "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", 7.69, { ask: "caneta azul", qty: 2, lineTotal: 15.38 });
const ACUCAR = { query: "açúcar", qty: 1, options: [opt("mb-ac1", "Açúcar Cristal União 1kg", 4.83, "mambo", "Mambo"), opt("sl-ac2", "Açúcar Demerara Macrozen 1kg", 13.2, "santaluzia", "Casa Santa Luzia")] };

test("R23a-5: 'ah, melhor preta' com o açúcar na tela é a cor da caneta da cesta", () => {
  assert.equal(parseBareColorPref("ah, melhor preta"), "preta");
  assert.equal(parseBareColorPref("melhor o primeiro"), null);
  const ctx = { step: "choosing", basket: [CANETA], pending: [ACUCAR] } as unknown as DeliveryContext;
  assert.equal(bareColorTarget(ctx, "preta")?.sku, "am-can");
  // Com as canetas na tela, a cor é da escolha aberta (o caminho de sempre).
  const pens = { step: "choosing", basket: [], pending: [{ query: "caneta", qty: 1, options: [opt("x", "Caneta BIC Azul", 2), opt("y", "Caneta BIC Preta", 2)] }] } as unknown as DeliveryContext;
  assert.equal(bareColorTarget(pens, "preta"), null);
});

test("R23a-5: na conversa, 'ah, melhor preta' troca a caneta (não procura 'açúcar preta')", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [CANETA], pending: [ACUCAR] }, "choosing");
  const out = await send(c.phone, "ah, melhor preta");
  assert.doesNotMatch(out, /a[cç][uú]car pret/i, out);
  assert.match(out, /caneta preta/i, out);
});

test("R23a-5: 'amaciante eu já disse que nao quero' (já fora da lista) confirma que saiu", () => {
  assert.equal(parseAlreadyDeclined("amaciante eu já disse que nao quero"), "amaciante");
  assert.equal(parseAlreadyDeclined("já falei que não quero amaciante"), "amaciante");
  assert.equal(parseAlreadyDeclined("nao quero amaciante"), null);
  assert.equal(parseAlreadyDeclined("eu já disse que quero amaciante"), null);
});

test("R23a-5: na conversa, 'amaciante eu já disse que nao quero' não pergunta o que tirar", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [{ query: "sabão em pó", qty: 1, options: [opt("am-s1", "Sabão em Pó Surf 800g", 12.9), opt("am-s2", "Sabão em Pó Omo 800g", 19.9)] }] }, "choosing");
  const out = await send(c.phone, "amaciante eu já disse que nao quero");
  assert.match(out, /\*amaciante\* já está fora da lista/, out);
  assert.doesNotMatch(out, /Quer que eu tire/i, out);
  assert.equal((await ctxOf(c.convoId)).pending?.[0]?.query, "sabão em pó");
});
