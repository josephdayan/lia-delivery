// Rodada 6, grupo G17 (10/10): compra do mês em texto longo de "áudio transcrito" (itens sumindo da fila), ração do
// cachorro + da gata virando "não achei", dipirona "sem receita" lida como receita e frases de contexto virando item.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, asteriskCorrection } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { runTurnScoped } from "../src/lib/turn-runtime";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { resolveListItems } from "../src/lib/list-items";
import { mergeShoppingLines, isNonItemSegment, normalizeMsg } from "../src/lib/lia-intents";
import { looksLikePrescriptionRequest } from "../src/lib/medicine";
import type { ChoiceOption, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5578${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;

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
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Márcia Souza", cpf: "52998224725", cpfName: "Márcia Souza" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g17_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
async function optionsFor(query: string, n = 2): Promise<ChoiceOption[]> {
  const cands = (await gatherCrossStoreCandidates(query, 20, 4, { noLongTail: true })).slice(0, n);
  assert.ok(cands.length, `catálogo de teste sem ${query}`);
  return cands.map((c) => ({ sku: c.item.sku, name: c.item.name, brand: c.item.brand, unitPrice: c.item.unitPrice, storeKey: c.store.key, storeLabel: c.store.label }));
}

// Texto literal da jornada 302.
const COMPRA_DO_MES =
  "então, é assim, vou falar tudo que eu lembrar tá, é a compra do mês, ai: arroz 5kg, feijão carioca 2 kg, aquele óleo de soja, açúcar, café, ah e leite 12 caixinhas, sabe o macarrão espaguete 3 pacotes, molho de tomate, ah esqueci, papel higiênico o de 12 rolos, detergente, sabão em pó, amaciante, e uns biscoitos pra criança, bolacha recheada, e carne moída 1 kg, frango uns 2 quilos, ovos uma dúzia, ahh e banana, maçã, e desodorante rexona, shampoo";
const PEDIDO_RACOES =
  "tenho um cachorro labrador adulto e uma gata castrada. preciso de racao pro labrador 15kg, racao pra gata castrada, areia sanitaria e um petisco pra cada";
const LISTA_COM_DIPIRONA = "preciso de dipirona, band-aid, protetor solar fps 50, um shampoo anticaspa, e tambem leite, pão de forma e uma ração pra gato";

// A1 (302): cada item pedido vira uma linha; a fala ("aquele", "sabe o", "uns", "ah esqueci") não vira item ---------
test("compra do mês falada: os 21 itens viram 21 linhas limpas, com a quantidade dita depois do produto", () => {
  const lines = resolveListItems(COMPRA_DO_MES);
  const phrases = lines.map((l) => normalizeMsg(l.phrase));
  const wanted = ["arroz", "feijao", "oleo de soja", "acucar", "cafe", "leite", "macarrao espaguete", "molho de tomate", "papel higienico", "detergente", "sabao em po", "amaciante", "biscoito", "bolacha recheada", "carne moida", "frango", "ovos", "banana", "maca", "desodorante rexona", "shampoo"];
  for (const w of wanted) assert.ok(phrases.some((p) => p.includes(w)), `${w} sumiu: ${phrases.join(" | ")}`);
  assert.equal(lines.length, wanted.length, phrases.join(" | "));
  for (const p of phrases) assert.doesNotMatch(p, /^(aquele|sabe|uns|ah|ai)\b|esqueci/, p);
  const qty = (w: string) => lines.find((l) => normalizeMsg(l.phrase).includes(w))?.qty;
  assert.equal(qty("leite"), 12);
  assert.equal(qty("macarrao"), 3);
  assert.equal(qty("ovos"), 12);
  assert.equal(qty("papel higienico"), 1, "12 rolos é o pacote, não a quantidade");
});

test("hesitação e contexto não são item: 'ah esqueci', 'na verdade entrega no meu trabalho', lista da escola", () => {
  for (const phrase of ["ah esqueci", "esqueci", "lembrei", "deixa eu ver", "tenho um cachorro labrador adulto", "temos dois gatos", "na verdade entrega no meu trabalho"]) {
    assert.ok(isNonItemSegment(phrase), phrase);
  }
  assert.deepEqual(resolveListItems("na verdade entrega no meu trabalho").map((l) => l.phrase), []);
  const escola = resolveListItems("preciso do material escolar do meu filho, caderno, cola, tesoura sem ponta, 3º ano").map((l) => normalizeMsg(l.phrase));
  assert.deepEqual(escola, ["caderno", "cola", "tesoura sem ponta"]);
  assert.deepEqual(resolveListItems("o menino gosta de carrinho e a menina de slime").map((l) => l.phrase), ["carrinho", "slime"]);
  // Correção com objeto continua valendo; "tenho um cachorro e ração" segue com a ração.
  assert.deepEqual(resolveListItems("arroz, café, aliás esquece o café").map((l) => l.phrase), ["arroz"]);
  assert.ok(resolveListItems("tenho um cachorro e ração").some((l) => /ra[cç][aã]o/.test(l.phrase)));
});

// A3 (303): duas rações para espécies diferentes são dois itens; frase de contexto não troca as linhas da IA ------
test("ração do labrador + ração da gata: o determinístico não tem contexto como item", () => {
  const phrases = resolveListItems(PEDIDO_RACOES).map((l) => normalizeMsg(l.phrase));
  assert.ok(phrases.some((p) => /racao.*labrador.*15kg/.test(p)), phrases.join(" | "));
  assert.ok(phrases.some((p) => /racao.*gata castrada/.test(p)), phrases.join(" | "));
  assert.ok(!phrases.some((p) => /tenho|^gata castrada$|^uma gata/.test(p)), phrases.join(" | "));
});

test("ração do labrador + ração da gata: o trecho de contexto não substitui as rações que a IA separou", () => {
  // Linhas que a IA devolveu na jornada 303 (reproduzido com o modelo de produção).
  const ai = ["ração cachorro labrador adulto 15kg", "ração gata castrada", "areia sanitária", "petisco cachorro", "petisco gato"].map((phrase) => ({ phrase, qty: 1 }));
  const det = resolveListItems(PEDIDO_RACOES);
  const merged = mergeShoppingLines(ai, det).map((l) => normalizeMsg(l.phrase));
  assert.ok(merged.includes("racao cachorro labrador adulto 15kg"), merged.join(" | "));
  assert.ok(merged.includes("racao gata castrada"), merged.join(" | "));
  assert.ok(merged.includes("petisco cachorro") && merged.includes("petisco gato"), merged.join(" | "));
  assert.ok(!merged.some((p) => /tenho/.test(p)), merged.join(" | "));
  // O mesmo trecho com contexto: mesmo com o determinístico ANTIGO (contexto no meio), a IA vence quando separou mais.
  const oldDet = [
    { phrase: "tenho um cachorro labrador adulto", qty: 1, decision: "split" as const, reason: "qty_propria", span: "tenho um cachorro labrador adulto e uma gata castrada" },
    { phrase: "gata castrada", qty: 1, decision: "split" as const, reason: "qty_propria", span: "tenho um cachorro labrador adulto e uma gata castrada" },
    { phrase: "racao pro labrador 15kg", qty: 1 },
    { phrase: "racao pra gata castrada", qty: 1 }
  ];
  const merged2 = mergeShoppingLines(ai, oldDet).map((l) => normalizeMsg(l.phrase));
  assert.ok(merged2.includes("racao cachorro labrador adulto 15kg") && merged2.includes("racao gata castrada"), merged2.join(" | "));
});

// A4 (304): dipirona "sem receita" é isento; a lista com dipirona segue inteira ----------------------------------
test("'sem receita' / 'não precisa de receita' não é pedido de remédio de receita", () => {
  assert.equal(looksLikePrescriptionRequest("dipirona 500mg gotas, a normal sem receita"), false);
  assert.equal(looksLikePrescriptionRequest("dipirona que não precisa de receita"), false);
  assert.equal(looksLikePrescriptionRequest("tem antialérgico isento de receita?"), false);
  assert.equal(looksLikePrescriptionRequest("amoxicilina sem receita"), true);
  assert.equal(looksLikePrescriptionRequest("preciso de um remédio de receita"), true);
  assert.equal(looksLikePrescriptionRequest(LISTA_COM_DIPIRONA), false);
});

test("lista com dipirona (remédio isento ligado): os outros 6 itens seguem e não há recusa de receita", async (t) => {
  if (!dbOk) return t.skip();
  const prev = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const c = await customerWith({});
    const out = await send(c.phone, LISTA_COM_DIPIRONA);
    assert.doesNotMatch(out, /Remédio de receita|Me diz o nome do que você precisa/i, out.slice(0, 600));
    const ctx = await ctxOf(c.convoId);
    const named = [...(ctx.pending ?? []).map((p: PendingChoice) => p.query), ...(ctx.basket ?? []).map((b: { name: string }) => b.name), out].join(" | ");
    for (const w of [/band.?aid|curativo/i, /protetor/i, /shampoo/i, /leite/i, /p[aã]o de forma/i, /ra[cç][aã]o/i]) assert.match(named, w, named.slice(0, 800));
    const out2 = await send(c.phone, "dipirona 500mg gotas, a normal sem receita");
    assert.doesNotMatch(out2, /receita eu não consigo|precisa de receita/i, out2.slice(0, 600));
  } finally {
    if (prev === undefined) delete process.env.LIA_MEDICINE_MIP;
    else process.env.LIA_MEDICINE_MIP = prev;
  }
});

// A1 (302): item novo pedido no meio das escolhas não apaga a fila --------------------------------------------------
test("compra do mês: 'leite integral 12 caixas de 1 litro' no meio das escolhas não apaga a fila (biscoito… shampoo)", async (t) => {
  if (!dbOk) return t.skip();
  const queue: PendingChoice[] = [];
  for (const q of ["amaciante", "biscoito infantil", "carne moída 1kg", "ovos", "desodorante rexona", "shampoo"]) {
    queue.push({ query: q, qty: 1, options: await optionsFor(q) });
  }
  const c = await customerWith(
    { pending: queue, pendingSince: Date.now(), listMisses: [{ query: "leite caixinha", qty: 12, reason: "not_found", at: Date.now() }], listInOneMessage: true },
    "choosing"
  );
  const out = await send(c.phone, "leite integral 12 caixas de 1 litro");
  const ctx = await ctxOf(c.convoId);
  const left = (ctx.pending ?? []).map((p: PendingChoice) => normalizeMsg(p.query));
  for (const q of ["biscoito infantil", "carne moida 1kg", "ovos", "desodorante rexona", "shampoo"]) {
    assert.ok(left.includes(q), `${q} saiu da fila: ${left.join(" | ")} :: ${out.slice(0, 500)}`);
  }
  assert.ok(left.some((q: string) => q.includes("leite")) || (ctx.basket ?? []).some((b: { name: string }) => /leite/i.test(b.name)), `${left.join(" | ")} :: ${out.slice(0, 500)}`);
});

// O caminho da jornada 302 em produção: o leite era faltante e o pedido dele de novo virou "refaz a faltante" (gerente
// de diálogo, search retry) — a fila virava SÓ o leite e o resto da compra do mês sumia sem aviso.
test("compra do mês: refazer a faltante (leite) no meio das escolhas mantém a fila inteira", async (t) => {
  if (!dbOk) return t.skip();
  const queue: PendingChoice[] = [];
  for (const q of ["amaciante", "biscoito infantil", "carne moída 1kg", "ovos", "desodorante rexona", "shampoo"]) {
    queue.push({ query: q, qty: 1, options: await optionsFor(q) });
  }
  const miss = { query: "leite integral", qty: 12, at: Date.now() };
  const c = await customerWith({ pending: queue, pendingSince: Date.now(), lastMiss: miss, listMisses: [{ ...miss, reason: "not_found" }], listInOneMessage: true }, "choosing");
  const prevFlag = process.env.LIA_DIALOGUE_LLM;
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query: "leite integral", qty: 12, retry: true }] }));
  let out = "";
  try {
    const start = outbox.length;
    await runTurnScoped(() => handleDeliveryMessage({ phone: c.phone, text: "leite integral 12 caixas de 1 litro", messageId: `g17_${RUN}_${++seq}` }));
    out = outbox.slice(start).filter((m) => m.to === c.phone).map((m) => m.text).join("\n---\n");
  } finally {
    __setDialogueModelForTests(null);
    if (prevFlag === undefined) delete process.env.LIA_DIALOGUE_LLM;
    else process.env.LIA_DIALOGUE_LLM = prevFlag;
  }
  const ctx = await ctxOf(c.convoId);
  const left = (ctx.pending ?? []).map((p: PendingChoice) => normalizeMsg(p.query));
  for (const q of ["amaciante", "biscoito infantil", "carne moida 1kg", "ovos", "desodorante rexona", "shampoo"]) {
    assert.ok(left.includes(q), `${q} saiu da fila: ${left.join(" | ")} :: ${out.slice(0, 500)}`);
  }
  assert.ok(left.some((q: string) => q.includes("leite")), `${left.join(" | ")} :: ${out.slice(0, 500)}`);
});

// M5 (302): "*" corrige o item da mensagem anterior — nunca abre itens novos ---------------------------------------
test("asteriskCorrection: só asterisco de abertura; *negrito* não é correção", () => {
  assert.equal(asteriskCorrection("*caixinhas de 1 litro, longa vida"), "caixinhas de 1 litro longa vida");
  assert.equal(asteriskCorrection("*arroz 5kg"), "arroz 5kg");
  assert.equal(asteriskCorrection("*arroz*"), null);
  assert.equal(asteriskCorrection("quero *arroz*"), null);
  assert.equal(asteriskCorrection("arroz"), null);
});

test("'*caixinhas de 1 litro, longa vida' depois do leite: corrige o leite da fila, sem itens novos", async (t) => {
  if (!dbOk) return t.skip();
  const queue: PendingChoice[] = [
    { query: "amaciante", qty: 1, options: await optionsFor("amaciante") },
    { query: "biscoito infantil", qty: 1, options: await optionsFor("biscoito") },
    { query: "leite integral 1 litro", qty: 12, qtyExplicit: true, options: await optionsFor("leite integral") }
  ];
  const c = await customerWith({ pending: queue, pendingSince: Date.now() }, "choosing");
  await prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "leite integral 12 caixas de 1 litro", createdAt: new Date(Date.now() - 60_000) } });
  const out = await send(c.phone, "*caixinhas de 1 litro, longa vida");
  const ctx = await ctxOf(c.convoId);
  const left = (ctx.pending ?? []).map((p: PendingChoice) => normalizeMsg(p.query));
  assert.equal(left.length, 3, `${left.join(" | ")} :: ${out.slice(0, 400)}`);
  assert.ok(!left.some((q: string) => q.includes("*") || q === "longa vida"), left.join(" | "));
  const leite = (ctx.pending as PendingChoice[]).find((p) => /leite/i.test(p.query));
  assert.ok(leite && /longa vida/i.test(leite.query) && leite.qty === 12, `${left.join(" | ")} :: ${out.slice(0, 400)}`);
  assert.doesNotMatch(out, /Somei|\*caixinhas/i, out.slice(0, 400));
});

test("'*arroz 5kg' com o arroz na tela troca as opções do arroz", async (t) => {
  if (!dbOk) return t.skip();
  const queue: PendingChoice[] = [
    { query: "arroz", qty: 1, options: await optionsFor("arroz") },
    { query: "feijão", qty: 1, options: await optionsFor("feijão") }
  ];
  const c = await customerWith({ pending: queue, pendingSince: Date.now() }, "choosing");
  await prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "arroz e feijão", createdAt: new Date(Date.now() - 60_000) } });
  const out = await send(c.phone, "*arroz 5kg");
  const ctx = await ctxOf(c.convoId);
  const left = (ctx.pending ?? []).map((p: PendingChoice) => normalizeMsg(p.query));
  assert.deepEqual(left, ["arroz 5kg", "feijao"], out.slice(0, 400));
});

// A3 (303): a ração da gata não troca a do cachorro; o tamanho pedido abre a vitrine ---------------------------------
test("'racao pra gata castrada 1kg' com a ração do labrador na cesta não troca a ração do cachorro", async (t) => {
  if (!dbOk) return t.skip();
  const [dog] = (await optionsFor("ração cães adultos porte grande 15kg", 4)).filter((o) => /15\s?kg/i.test(o.name));
  assert.ok(dog, "catálogo de teste sem ração de cachorro 15 kg");
  const c = await customerWith({ basket: [{ ...dog, storeKey: dog.storeKey ?? "", storeLabel: dog.storeLabel ?? "", qty: 1, lineTotal: dog.unitPrice, ask: "ração cachorro labrador adulto 15kg" }] });
  const out = await send(c.phone, "racao pra gata castrada 1kg");
  assert.doesNotMatch(out, /Tirei/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b: { sku: string }) => b.sku === dog.sku), out.slice(0, 400));
});

test("sem IA: 'ração cachorro labrador adulto 15kg' abre com opção de 15 kg", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const out = await send(c.phone, "racao pro cachorro labrador adulto 15kg");
  const ctx = await ctxOf(c.convoId);
  const first = ctx.pending?.[0]?.options?.[0]?.name ?? ctx.basket?.[0]?.name ?? "";
  assert.match(first, /15\s?kg/i, out.slice(0, 500));
});

// A1 (302): a IA devolveu "leite caixinha" (12x) e a busca pela embalagem não achava leite nenhum ------------------
test("'leite caixinha' x12 acha leite (a caixinha é a embalagem, não o nome)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const out = await send(c.phone, "12 leite caixinha");
  assert.doesNotMatch(out, /não achei/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  const names = [...(ctx.pending?.[0]?.options ?? []).map((o: ChoiceOption) => o.name), ...(ctx.basket ?? []).map((b: { name: string }) => b.name)];
  assert.ok(names.some((n) => /leite/i.test(n)), `${names.join(" | ")} :: ${out.slice(0, 400)}`);
});

// M6 (303): "faltou a ração do labrador, 15kg" com o resumo (não pago) na tela é item esquecido, não reclamação ------
test("'faltou a racao do labrador, 15kg' com o resumo na tela procura a ração e não chama o responsável", async (t) => {
  if (!dbOk) return t.skip();
  const [areia] = await optionsFor("areia sanitária gato", 1);
  const basket = [{ ...areia, storeKey: areia.storeKey ?? "", storeLabel: areia.storeLabel ?? "", qty: 1, lineTotal: areia.unitPrice, ask: "areia sanitária" }];
  const c = await customerWith({ basket }, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, conversationId: c.convoId, phone: c.phone, items: basket, status: "awaiting_quote_confirmation", cep: "01310-100", deliveryAddress: ADDRESS }
  });
  const ctx0 = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx0, deliveryOrderId: order.id, storeKey: "concierge" }) } });
  const out = await send(c.phone, "faltou a racao do labrador, 15kg");
  assert.doesNotMatch(out, /sinto muito|equipe vai verificar|respons[aá]vel/i, out.slice(0, 500));
  assert.match(out, /ra[cç][aã]o/i, out.slice(0, 500));
});

test("'tenta de novo' com faltante no meio das escolhas refaz a faltante (sem item 'tenta de novo') e mantém a fila", async (t) => {
  if (!dbOk) return t.skip();
  const queue: PendingChoice[] = [];
  for (const q of ["amaciante", "biscoito infantil", "shampoo"]) queue.push({ query: q, qty: 1, options: await optionsFor(q) });
  const c = await customerWith({ pending: queue, pendingSince: Date.now(), listMisses: [{ query: "leite integral", qty: 12, reason: "not_found", at: Date.now() }] }, "choosing");
  const out = await send(c.phone, "tenta de novo");
  assert.doesNotMatch(out, /tenta de novo\*/i, out.slice(0, 400));
  const left = ((await ctxOf(c.convoId)).pending ?? []).map((p: PendingChoice) => normalizeMsg(p.query));
  for (const q of ["amaciante", "biscoito infantil", "shampoo"]) assert.ok(left.includes(q), `${q} saiu: ${left.join(" | ")} :: ${out.slice(0, 400)}`);
  assert.ok(left.some((q: string) => q.includes("leite")), `${left.join(" | ")} :: ${out.slice(0, 400)}`);
});
