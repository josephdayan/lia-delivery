// Rodada 10, grupo G28 (10/10): marca em comum lida como o MESMO item ("feijão da Camil" dobrava o arroz Camil), escolha com
// carrossel aberto lida como item ou como outro item ("o mais barato de 500g" respondia sobre o macarrão; "o Pilão de 29,48"
// virava "Somei 1x o Pilão de 29,48"), refino que soma variante excludente ("integral" + "desnatado", "10kg 3kg") e nega a
// opção que a Lia acabou de mostrar, resposta à pergunta da Lia que vira item ("as duas, me mostra") e o remédio isento que
// sumia antes do cadastro ("paracetamol" → "Remédio de receita eu não consigo comprar"; "é sem receita" virava item).
// Textos reais de /mnt/project-files/testes-whatsapp/rodada10/grupo-b.md (jornadas 302, 306, 307).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, planPreSignup, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { answerOpenQuestion, cheaperAskTarget, isDiscourseOnly, parseChoiceByCitedPrice, replaceRefinedSize } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { mergeListMisses } from "../src/lib/list-misses";
import { display, type BasketItem, type ChoiceOption, type DeliveryContext, type PendingChoice } from "../src/lib/conversation-types";
import type { DialogueAction } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5528${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, extra?: unknown) => {
    outbox.push({ to, kind: key, text: [text, extra].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join("\n") });
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
afterEach(() => {
  __setLiveSimulateForTests(null);
  __clearLiveCheckCacheForTests();
  delete process.env.LIA_MEDICINE_MIP;
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address" }) } });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g28_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = log;
  }
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "santaluzia", storeLabel = "Casa Santa Luzia"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const pend = (query: string, options: ChoiceOption[], extra: Partial<PendingChoice> = {}): PendingChoice => ({ query, qty: 1, options, ...extra }) as PendingChoice;
const item = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "santaluzia", storeLabel: "Casa Santa Luzia", ...extra });
const D = (over: Partial<PreDecision> = {}): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, ...over });

// ---------------------------------------------------------------- puros

test("M2: medida não nomeia item da cesta — 'o mais barato de 500g' com o café em escolha não aponta o macarrão 500g", () => {
  const basket = [{ name: "Macarrão Espaguete N°8 Adria 500g", ask: "macarrão espaguete" }];
  assert.equal(cheaperAskTarget("o mais barato de 500g", basket, ["café Pilão"]), null);
  // Nomeando o item, continua valendo (rodada 8 g25).
  assert.equal(cheaperAskTarget("tem macarrão mais barato?", basket, ["café Pilão"]), 0);
});

test("M2: 'o Pilão de 29,48' escolhe pela marca + preço da opção na tela; teto e pergunta não", () => {
  const shown = [
    { name: "Café Torrado e Moído Tradicional Pilão 500g Almofada", price: 48.39 },
    { name: "Café Torrado e Moído Tradicional a Vácuo Pilão 500g", price: 29.48 },
    { name: "Café Pilão Extraforte Espresso 12, caixa com 10 Cápsulas", price: 42.34 }
  ];
  assert.equal(parseChoiceByCitedPrice("não, to falando do café. o Pilão de 29,48", shown, "café Pilão"), 1);
  assert.equal(parseChoiceByCitedPrice("o de R$ 48,39", shown, "café Pilão"), 0);
  assert.equal(parseChoiceByCitedPrice("até 30,00", shown, "café Pilão"), null);
  assert.equal(parseChoiceByCitedPrice("o de 29,48 é de qual loja?", shown, "café Pilão"), null);
  // Palavra que nenhuma opção tem ("Melitta") não é essa opção.
  assert.equal(parseChoiceByCitedPrice("o Melitta de 29,48", shown, "café Pilão"), null);
});

test("M3/M7: refino com peso novo ou variante excludente SUBSTITUI o anterior (nada de '10kg 3kg' / 'integral desnatado')", () => {
  assert.equal(replaceRefinedSize("ração cachorro adulto 10kg", ["3kg"]), "racao cachorro adulto");
  assert.equal(replaceRefinedSize("ração cachorro adulto 10 kg", ["de 3 kg"]), "racao cachorro adulto");
  assert.equal(replaceRefinedSize("leite Piracanjuba integral", ["Piracanjuba desnatado"]), "leite piracanjuba");
  assert.equal(replaceRefinedSize("leite semidesnatado", ["integral"]), "leite");
  // Sem conflito, a base fica como estava.
  assert.equal(replaceRefinedSize("leite Piracanjuba", ["desnatado"]), "leite Piracanjuba");
  assert.equal(replaceRefinedSize("fralda RN", ["tamanho P"]), "fralda");
});

test("M7: 'as duas, me mostra' é fala, não item — nem na lista, nem na resposta à pergunta da Lia, nem no 'Ficou de fora'", () => {
  assert.deepEqual(resolveListItems("as duas, me mostra"), []);
  assert.equal(isDiscourseOnly("os dois"), true);
  assert.equal(answerOpenQuestion("Você prefere ver uma opção mais em conta ou uma ração de 3 kg?", "as duas, me mostra"), null);
  const at = Date.now();
  const kept = mergeListMisses([], [
    { query: "as duas", qty: 1, reason: "not_found", at },
    { query: "me mostra", qty: 1, reason: "not_found", at },
    { query: "lâmpada led", qty: 1, reason: "not_found", at }
  ]);
  assert.deepEqual(kept.map((m) => m.query), ["lâmpada led"]);
  // Quantidade por extenso continua sendo quantidade de produto.
  assert.deepEqual(resolveListItems("duas cocas").map((l) => [l.phrase, l.qty]), [["cocas", 2]]);
});

test("M6: 'é sem receita' e a medida solta são do remédio de antes; 'e também' não entra no nome do item", () => {
  assert.deepEqual(resolveListItems("e o paracetamol? é sem receita, 750mg").map((l) => l.phrase.replace(/^o /, "")), ["paracetamol 750mg"]);
  assert.deepEqual(resolveListItems("paracetamol 750mg, é sem receita").map((l) => l.phrase), ["paracetamol 750mg"]);
  assert.deepEqual(
    resolveListItems("to com dor de cabeça, preciso de um paracetamol e um band-aid. e também pão de forma e manteiga").map((l) => l.phrase),
    ["paracetamol", "band-aid", "pão de forma", "manteiga"]
  );
});

test("M6: antes do cadastro, com o remédio isento ligado, a recusa de remédio da IA não vale para paracetamol", () => {
  const text = "to com dor de cabeça, preciso de um paracetamol e um band-aid. e também pão de forma e manteiga";
  const decision = D({ medicine: true, items: [{ query: "band-aid", qty: 1, cheapest: false }, { query: "pão de forma", qty: 1, cheapest: false }, { query: "manteiga", qty: 1, cheapest: false }] });
  process.env.LIA_MEDICINE_MIP = "true";
  assert.deepEqual(planPreSignup(decision, { text }), { ok: false, reason: "remedio_isento" });
  // Remédio de receita nomeado continua recusado pela IA.
  const rx = planPreSignup(D({ medicine: true, items: [{ query: "band-aid", qty: 1, cheapest: false }] }), { text: "amoxicilina e band-aid" });
  assert.ok(rx.ok && rx.steps.some((s) => s.type === "medicine"));
  delete process.env.LIA_MEDICINE_MIP;
  // Sem o isento, a recusa de sempre.
  const off = planPreSignup(decision, { text });
  assert.ok(off.ok && off.steps.some((s) => s.type === "medicine"));
});

// ---------------------------------------------------------------- caminho real (runTurnScoped)

test("M1 (302): 'feijão da Camil' com o arroz Camil na cesta e o feijão em escolha não dobra o arroz", async (t) => {
  if (!dbOk) return t.skip();
  const feijao = pend("feijão carioca", [opt("swift-7695", "Feijão Carioca Swift 1kg", 8.47, "swift", "Swift"), opt("mambo-6089", "Feijão Carioca Tipo 1 Camil 1kg", 10.49, "mambo", "Mambo"), opt("santaluzia-87289", "Feijão Carioca Guto 1KG", 10.3)]);
  const arroz = item("santaluzia-26569", "Arroz Camil Tipo 1 5kg", 31.5, { brand: "Camil", ask: "arroz camil 5kg" });
  const c = await customerWith({ basket: [arroz], pending: [feijao] }, "choosing");
  const out = await send(c.phone, "feijão da Camil");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((b) => b.sku === arroz.sku)?.qty, 1, out.slice(0, 500));
  assert.doesNotMatch(out, /já estava na cesta/, out.slice(0, 500));
  // O feijão Camil foi escolhido ou ficou como única opção da escolha.
  const chosen = ctx.basket?.some((b) => b.sku === "mambo-6089") || ctx.pending?.[0]?.options.every((o) => /camil/i.test(o.name));
  assert.ok(chosen, JSON.stringify({ basket: ctx.basket, pending: ctx.pending }).slice(0, 600));
});

test("M2 (302): 'o mais barato de 500g' com o café em escolha fala do café, não do macarrão 500g da cesta", async (t) => {
  if (!dbOk) return t.skip();
  const cafe = pend("café Pilão", [
    opt("americanas-4001502", "Café Torrado e Moído Tradicional Pilão 500g Almofada", 44, "americanas", "Americanas"),
    opt("santaluzia-3389", "Café Torrado e Moído Tradicional a Vácuo Pilão 500g", 26.8),
    opt("americanas-2535074", "Café Pilão Extraforte Espresso 12, caixa com 10 Cápsulas de alumínio", 38.5, "americanas", "Americanas")
  ]);
  const macarrao = item("santaluzia-47713", "Macarrão Espaguete N°8 Adria 500g", 4.8, { ask: "macarrão espaguete" });
  const c = await customerWith({ basket: [macarrao], pending: [cafe] }, "choosing");
  const out = await send(c.phone, "o mais barato de 500g");
  assert.doesNotMatch(out, /macarr[aã]o/i, out.slice(0, 500));
  assert.ok((await ctxOf(c.convoId)).basket?.some((b) => b.sku === "santaluzia-3389"), out.slice(0, 500));
});

test("M2 (302): 'não, to falando do café. o Pilão de 29,48' escolhe essa opção — nada de 'Somei 1x o Pilão de 29,48'", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    opt("americanas-4001502", "Café Torrado e Moído Tradicional Pilão 500g Almofada", 44, "americanas", "Americanas"),
    opt("santaluzia-3389", "Café Torrado e Moído Tradicional a Vácuo Pilão 500g", 26.8),
    opt("americanas-2535074", "Café Pilão Extraforte Espresso 12, caixa com 10 Cápsulas de alumínio", 38.5, "americanas", "Americanas")
  ];
  const price = display(26.8).toFixed(2).replace(".", ",");
  const macarrao = item("santaluzia-47713", "Macarrão Espaguete N°8 Adria 500g", 4.8, { ask: "macarrão espaguete" });
  const c = await customerWith({ basket: [macarrao], pending: [pend("café Pilão", options)] }, "choosing");
  const out = await send(c.phone, `não, to falando do café. o Pilão de ${price}`);
  assert.doesNotMatch(out, /Somei/, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.basket?.some((b) => b.sku === "santaluzia-3389"), JSON.stringify(ctx.basket));
  assert.equal(ctx.basket?.length, 2);
});

test("M3 (302): 'então 6 do Piracanjuba desnatado mesmo' depois do refino 'integral' mostra o desnatado que já apareceu", async (t) => {
  if (!dbOk) return t.skip();
  // Como em produção: a IA leu refino + quantidade.
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "Piracanjuba desnatado" }, { type: "set_qty", target: 0, qty: 6 }] as DialogueAction[] }));
  const integral = opt("drogal-14888", "Leite integral Piracanjuba 1 Litro", 6.6, "drogal", "Drogal");
  const desnatado = opt("farmaciaindiana-80457", "Leite Piracanjuba Desnatado UHT 1L", 6, "farmaciaindiana", "Farmácia Indiana");
  const leite = pend("leite caixa com 12 Piracanjuba ou Italac integral", [integral], {
    shownOptions: [integral, opt("mambo-8052", "Leite Longa Vida Semidesnatado Italac 1L", 6.5, "mambo", "Mambo"), desnatado]
  });
  const c = await customerWith({ basket: [item("santaluzia-26569", "Arroz Camil Tipo 1 5kg", 31.5)], pending: [leite] }, "choosing");
  const out = await send(c.phone, "então 6 do Piracanjuba desnatado mesmo");
  assert.doesNotMatch(out, /N[aã]o achei/, out.slice(0, 600));
  assert.doesNotMatch(out, /integral desnatado|desnatado integral/i, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const names = [...(ctx.pending?.[0]?.options ?? []), ...(ctx.basket ?? [])].map((o) => o.name);
  assert.ok(names.some((n) => /piracanjuba/i.test(n) && /desnatado/i.test(n) && !/integral/i.test(n)), JSON.stringify({ pending: ctx.pending?.[0], basket: ctx.basket }).slice(0, 600));
  assert.equal(ctx.pending?.[0]?.qty ?? ctx.basket?.find((b) => /desnatado/i.test(b.name))?.qty, 6);
});

test("M3 (302): a busca refinada não acha, mas a opção pedida JÁ foi mostrada — volta ela, sem 'Não achei'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "Zylactea desnatado" }] as DialogueAction[] }));
  const integral = opt("drogal-90001", "Leite integral Zylactea 1 Litro", 6.6, "drogal", "Drogal");
  const desnatado = opt("farmaciaindiana-90002", "Leite Zylactea Desnatado UHT 1L", 6, "farmaciaindiana", "Farmácia Indiana");
  const leite = pend("leite Zylactea integral", [integral], { shownOptions: [integral, desnatado] });
  const c = await customerWith({ pending: [leite] }, "choosing");
  const out = await send(c.phone, "então o Zylactea desnatado mesmo");
  assert.doesNotMatch(out, /N[aã]o achei/, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const onTable = ctx.pending?.[0]?.options.map((o) => o.sku) ?? [];
  assert.ok(onTable.includes(desnatado.sku) || ctx.basket?.some((b) => b.sku === desnatado.sku), JSON.stringify(ctx.pending?.[0]).slice(0, 600));
});

test("M7 (307): 'as duas, me mostra' respondendo à pergunta da Lia não vira item nem 'Ficou de fora'", async (t) => {
  if (!dbOk) return t.skip();
  const racao = pend("ração cachorro adulto 10kg", [opt("cobasi-915700", "Ração GranPlus Choice Cães Adultos Frango e Carne 10,1 kg", 103, "cobasi", "Cobasi")]);
  // Com a pergunta da Lia em aberto (como em produção) e sem ela.
  for (const asked of [true, false]) {
    const question = { text: "Você prefere ver uma opção mais em conta ou uma ração de 3 kg?", at: Date.now(), said: "essa estoura meus 100 reais, tem uma mais em conta ou de 3kg?" };
    const detergente = item("farmaciaindiana-1", "Detergente Líquido Limpol Neutro 500ml", 2.5, { storeKey: "farmaciaindiana", storeLabel: "Farmácia Indiana" });
    const c = await customerWith({ basket: [detergente], pending: [racao], ...(asked ? { openQuestion: question } : {}) }, "choosing");
    const { result: out, logs } = await withLogs(() => send(c.phone, "as duas, me mostra"));
    // Antes: a busca rodava "as duas" e "me mostra" como produtos (lines=2).
    assert.ok(!logs.some((l) => /\[perf:buildChoices\].*lines=[1-9]/.test(l)), logs.join("\n"));
    assert.doesNotMatch(out, /Somei|\*as duas\*|me mostra\*|N[aã]o achei: as duas/i, out.slice(0, 600));
    const ctx = await ctxOf(c.convoId);
    assert.equal(ctx.basket?.length, 1, JSON.stringify(ctx.basket));
    assert.ok(!(ctx.listMisses ?? []).some((m) => /duas|mostra/.test(m.query)), JSON.stringify(ctx.listMisses));
    assert.ok(!(ctx.pending ?? []).some((p) => /duas|mostra/.test(p.query)), JSON.stringify(ctx.pending?.map((p) => p.query)));
  }
});

test("M7 (307): refino 'de 3kg' na ração de 10kg busca 3kg, não '10kg 3kg'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "3kg" }] as DialogueAction[] }));
  const racao = pend("ração cachorro adulto 10kg", [opt("cobasi-915700", "Ração GranPlus Choice Cães Adultos Frango e Carne 10,1 kg", 103, "cobasi", "Cobasi")]);
  const c = await customerWith({ pending: [racao] }, "choosing");
  const out = await send(c.phone, "ração de cachorro adulto de 3kg");
  assert.doesNotMatch(out, /10\s?kg 3\s?kg/i, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  assert.doesNotMatch(ctx.pending?.[0]?.query ?? "", /10\s?kg/i, out.slice(0, 600));
});

test("M6 (306): antes do cadastro, 'preciso de um paracetamol e um band-aid...' anota o paracetamol (remédio isento ligado)", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  // Como em produção: a IA marcou remédio e deixou o paracetamol fora dos itens.
  __setPreSignupModelForTests(async () =>
    D({ medicine: true, items: [{ query: "band-aid", qty: 1, cheapest: false }, { query: "pão de forma", qty: 1, cheapest: false }, { query: "manteiga", qty: 1, cheapest: false }] })
  );
  const c = await newcomer();
  const out = await send(c.phone, "to com dor de cabeça, preciso de um paracetamol e um band-aid. e também pão de forma e manteiga");
  assert.doesNotMatch(out, /Remédio de receita eu não consigo/, out);
  assert.match(out, /paracetamol/i, out);
  assert.doesNotMatch(out, /também pão/i, out);
});
