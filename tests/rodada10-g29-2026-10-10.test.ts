// Rodada 10, grupo G29 (10/10): troca de loja / juntar que desfazia a marca escolhida (Limpol → Ypê, Dove Men+Care →
// Dove feminino) e piorava o prazo calado; prazo dito ("até amanhã de manhã", "até sexta", "aniversário hoje") que recebia
// a resposta genérica; teto do presente ("gasto até 60 reais", "vai ficar dentro dos 60?") ignorado ou respondido com a
// cobertura; pergunta de desempate do café repetida 3 vezes. Textos reais de
// /mnt/project-files/testes-whatsapp/rodada10/grupo-b.md (jornadas 304, 305, 307, 308).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, keepsBrand, runTurnScoped, sameAudience } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { bestByAnswers } from "../src/lib/dialogue/execute";
import { __setPreSignupModelForTests, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests, deadlineFit } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { opsPublishManualQuote } from "../src/lib/ops-lifecycle";
import * as copy from "../src/lib/lia-copy";
import { asksBudgetLeft, parseBudgetFitAsk, parseNeededBy, parseOrderBudget, statesDeadline } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";
import type { DialogueAction } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5529${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown) => {
    outbox.push({ to, kind: key, text: typeof text === "string" ? text : JSON.stringify(text) });
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
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria Teste" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address" }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g29_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "swift", storeLabel = "Swift", delivery?: string): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as ChoiceOption;
const pend = (query: string, options: ChoiceOption[]): PendingChoice => ({ query, qty: 1, options }) as PendingChoice;
const line = (sku: string, name: string, unitPrice: number, storeKey = "mambo", storeLabel = "Mambo", delivery?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as BasketItem;
const decision = (d: Partial<PreDecision>): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...d });

const GIFT = "preciso de um presente pra minha amiga que faz aniversário hoje, gasto até 60 reais, ela gosta de chocolate e de creme pras mãos";
const BABY = "preciso de fralda Pampers M, lenço umedecido Huggies, pomada Hipoglós e shampoo Johnson's. Preciso que chegue até amanhã de manhã, acabou tudo aqui";
const CAFES = [
  opt("santaluzia-3389", "Café Pilão Tradicional 250g", 22.18, "santaluzia", "Casa Santa Luzia", "Casa Santa Luzia · 1 dia útil"),
  opt("mambo-5501", "Café Drip Coffee Pilão Tradicional 10 Sachês", 19.9, "mambo", "Mambo", "Mambo · hoje"),
  opt("mambo-5502", "Café Pilão Extra Forte 250g", 23.4, "mambo", "Mambo", "Mambo · hoje"),
  opt("mambo-5503", "Café Pilão Tradicional 500g", 36.4, "mambo", "Mambo", "Mambo · hoje")
];
const LEITES = [
  opt("swift-7134", "Leite Integral Ninho Nestlé 1l", 7.67, "swift", "Swift", "Swift · hoje, 6h–8h"),
  opt("indiana-80455", "Leite Integral Piracanjuba UHT 1L", 6.92, "farmaciaindiana", "Farmácia Indiana", "Farmácia Indiana · 9 dias úteis")
];

// ---------------------------------------------------------------- puros

test("304: 'gasto até 60 reais' é o teto do pedido, 'faz aniversário hoje' é prazo de hoje e o presente sai da lista", () => {
  assert.equal(parseOrderBudget(GIFT)?.cap, 60);
  assert.equal(parseNeededBy(GIFT)?.label, "hoje");
  assert.equal(parseNeededBy("a festa é hoje, preciso de balão")?.label, "hoje");
  // O que sobra da frase vira só os produtos: a moldura do presente e o "ela gosta de" não são itens.
  assert.deepEqual(resolveListItems(parseOrderBudget(GIFT)!.rest).map((l) => l.phrase), ["chocolate", "creme pras mãos"]);
  assert.deepEqual(resolveListItems("presente pra minha amiga, ela adora chocolate").map((l) => l.phrase), ["chocolate"]);
  // Presente sozinho continua o pedido (a recomendação cuida).
  assert.deepEqual(resolveListItems("quero um presente pra minha mãe").map((l) => l.phrase), ["presente pra minha mãe"]);
  // "vai ficar dentro dos 60 reais com a entrega?" pergunta o teto com o valor; sem "?" não é pergunta.
  assert.equal(parseBudgetFitAsk("vai ficar dentro dos 60 reais com a entrega?")?.cap, 60);
  assert.equal(parseBudgetFitAsk("vai ficar dentro dos 60?")?.cap, 60);
  assert.equal(parseBudgetFitAsk("cabe nos 100?")?.cap, 100);
  assert.equal(parseBudgetFitAsk("fica dentro dos 60"), null);
  assert.equal(parseBudgetFitAsk("chega em 2 dias?"), null);
  assert.ok(asksBudgetLeft("vai ficar dentro dos 60?"));
});

test("305/308: prazo dito como frase própria, com 'de manhã' marcado; com produto na mensagem não é só prazo", () => {
  assert.equal(statesDeadline("Se puder chegar até sexta, tá bom")?.label, "sexta");
  const morning = statesDeadline("preciso até amanhã de manhã, qual das duas serve?");
  assert.equal(morning?.label, "amanhã");
  assert.equal(morning?.morning, true);
  assert.equal(parseNeededBy(BABY)?.morning, true);
  assert.equal(statesDeadline("preciso de papel higiênico e sabonete, tem que chegar amanhã"), null);
  // "1 dia útil" chega amanhã, mas sem hora: pra "amanhã de manhã" é incerto; 60 min serve; pra hoje não chega.
  const tomorrow = parseNeededBy("preciso que chegue até amanhã de manhã")!;
  assert.equal(deadlineFit("prazo da loja: 1 dia útil", tomorrow), "unsure");
  assert.equal(deadlineFit("prazo da loja: 60 min", tomorrow), "ok");
  assert.equal(deadlineFit("prazo da loja: 1 dia útil", { date: parseNeededBy("preciso pra hoje")!.date }), "late");
  const body = copy.shippingSpeedChoice({ total: 172.19 }, { total: 185.1, estimate: "prazo da loja: 60 min" }, "store", undefined, { label: "amanhã", morning: true, fits: ["unsure", "ok"] });
  assert.match(body, /\*2\)\* Mais rápida[^\n]*chega até \*amanhã de manhã\* ✅/, body);
});

test("308: desempate cruza as respostas ('o tradicional' + 'o de 250g') e fica com a que bate", () => {
  assert.deepEqual(bestByAnswers(["o tradicional", "o de 250g"], CAFES).map((o) => o.sku), ["santaluzia-3389"]);
  assert.deepEqual(bestByAnswers(["tradicional mesmo"], CAFES).map((o) => o.sku), ["santaluzia-3389", "mambo-5501", "mambo-5503"]);
  assert.deepEqual(bestByAnswers(["sei lá"], CAFES), []);
});

test("307/308: troca de loja não muda o público e a oferta diz quando muda a marca; mesmo produto não é 'troca'", () => {
  assert.equal(sameAudience("Desodorante Dove Men+Care Invisible Dry 50ml desodorante Dove masculino", "Desodorante Roll-On Dove Invisible Care 50ml"), false);
  assert.equal(sameAudience("Sabonete em Barra Palmolive Naturals", "Sabonete em Barra para Crianças Palmolive Kids Splashers"), false);
  assert.equal(sameAudience("Detergente Líquido Limpol Neutro 500ml", "Detergente Líquido Neutro Limpol 500ml"), true);
  const offer = copy.minimumSwapOffer({ newTotal: 2.41, delta: -0.77, storeLabel: "Americanas", pairs: [{ fromName: "Detergente Limpol", fromPrice: 3.18, toName: "Detergente Ypê", toPrice: 2.41, change: copy.swapChangeNote("marca", "Limpol") }], etaNote: copy.swapEtaNote("Americanas · hoje", "3 dias úteis") });
  assert.match(offer, /→ \*Detergente Ypê\* \(R\$ 2,41\) — ⚠️ _muda a marca: não achei Limpol em outra loja_/, offer);
  assert.match(offer, /o prazo passa de \*Americanas · hoje\* para \*3 dias úteis\*/, offer);
  const joined = copy.consolidationOffer({ storeLabel: "Pacheco", joinedTotal: 172.19, keptTotal: 180, keptStores: 2, pairs: [{ fromName: "Fralda Pampers  Confort Sec M", fromPrice: 104.49, toName: "Fralda Pampers Confort Sec M", toPrice: 104.49 }] });
  assert.doesNotMatch(joined, /troco:/, joined);
});

// ---------------------------------------------------------------- conversa (banco)

test("304: presente com 'aniversário hoje' e 'gasto até 60 reais' antes do cadastro — teto e prazo guardados, itens limpos", async (t) => {
  if (!dbOk) return t.skip();
  // Como a produção: a IA leu o presente como recomendação.
  __setPreSignupModelForTests(async () => decision({ recommend: true, budget: 60 }));
  const c = await newcomer();
  const out = await send(c.phone, GIFT);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.orderBudget?.cap, 60, JSON.stringify(ctx));
  assert.equal(ctx.neededBy?.label, "hoje", JSON.stringify(ctx));
  assert.doesNotMatch(out, /presente pra minha amiga|gosta de chocolate|1x de creme|60 reais/i, out);
  assert.match(out, /chocolate/i, out);
  assert.match(out, /creme pras mãos/i, out);
  // O teto e o prazo aparecem na confirmação (o cliente vê que foram ouvidos).
  assert.match(out, /Até \*R\$ 60,00\* no total/, out);
  assert.match(out, /Pra chegar até \*hoje\*/, out);
});

test("304: 'vai ficar dentro dos 60 reais com a entrega?' responde o teto (nunca a cobertura), sozinho ou junto da escolha", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "answer", topic: "area" }] as DialogueAction[] }));
  const bombom = line("pacheco-11", "Caixa de Bombom Sonho de Valsa 251g", 18.99, "drogariaspacheco", "Drogarias Pacheco");
  const c = await customerWith({ basket: [bombom] });
  const out = await send(c.phone, "vai ficar dentro dos 60?");
  assert.match(out, /Cabe, sim: do seu teto de \*R\$ 60,00\*/, out);
  assert.doesNotMatch(out, /Atendo/, out);
  assert.equal((await ctxOf(c.convoId)).orderBudget?.cap, 60);

  __setDialogueModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
  const creme = line("paguemenos-22", "Creme para Mãos Neutrogena 56g", 17.18, "paguemenos", "Pague Menos");
  const bombons = [opt("pacheco-11", "Caixa de Bombom Sonho de Valsa 251g", 18.99, "drogariaspacheco", "Drogarias Pacheco"), opt("pacheco-12", "Caixa de Bombom Garoto 250g", 15.49, "drogariaspacheco", "Drogarias Pacheco")];
  const d = await customerWith({ basket: [creme], pending: [pend("caixa de bombom", bombons)] }, "choosing");
  const both = await send(d.phone, "o Sonho de Valsa. vai ficar dentro dos 60 reais com a entrega?");
  assert.match(both, /Sonho de Valsa/, both);
  assert.match(both, /teto de \*R\$ 60,00\*/, both);
  assert.doesNotMatch(both, /Atendo|não achei/i, both);
  // A conta já inclui o Sonho de Valsa nomeado (creme R$ 17,18 + bombom, com a entrega) e a escolha segue aberta nele.
  assert.match(both, /Cabe, sim/, both);
  assert.doesNotMatch(both, /ainda falta escolher/, both);
});

test("304: o resumo diz que não chega hoje e que ficou dentro dos R$ 60", async (t) => {
  if (!dbOk) return t.skip();
  const today = parseNeededBy("preciso pra hoje")!;
  const bombom = line("pacheco-11", "Caixa de Bombom Sonho de Valsa 251g", 18.99, "drogariaspacheco", "Drogarias Pacheco");
  const c = await customerWith({ basket: [bombom], neededBy: today, orderBudget: { cap: 60 } }, "awaiting_operator_quote");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, conversationId: c.convoId, status: "awaiting_operator_quote", items: [bombom] as unknown as object, cep: "01310-100", deliveryAddress: ADDRESS, storeKey: "concierge", storeLabel: "Lia" }
  });
  const ctx0 = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx0, deliveryOrderId: order.id }) } });
  const start = outbox.length;
  await opsPublishManualQuote(order.id, { itemsSubtotal: 18.99, deliveryFee: 11.8, deliveryMode: "retailer_delivery", deliveryPromise: "pela própria loja · prazo da loja: 1 dia útil" });
  const out = outbox.slice(start).filter((m) => m.to === c.phone).map((m) => m.text).join("\n");
  assert.match(out, /precisa pra \*hoje\*, mas essa entrega não chega a tempo/, out);
  assert.match(out, /Dentro do seu limite de R\$ 60,00/, out);
});

test("305: lista + 'Preciso que chegue até amanhã de manhã' antes do cadastro anota o prazo (sem o texto genérico)", async (t) => {
  if (!dbOk) return t.skip();
  __setPreSignupModelForTests(async () =>
    decision({ items: ["fralda Pampers M", "lenço umedecido Huggies", "pomada Hipoglós", "shampoo Johnson's"].map((query) => ({ query, qty: 1, cheapest: false })), answers: ["delivery_time"] })
  );
  const c = await newcomer();
  const out = await send(c.phone, BABY);
  assert.match(out, /Pra chegar até \*amanhã de manhã\*/, out);
  assert.doesNotMatch(out, /O prazo depende da loja/, out);
  assert.match(out, /fralda Pampers M/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.neededBy?.morning, true);
});

test("305: 'preciso até amanhã de manhã, qual das duas serve?' na escolha da entrega diz qual serve", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "answer", topic: "delivery_time" }] as DialogueAction[] }));
  const freightChoice = { orderId: "x", itemsSubtotal: 150, serviceFee: 10, stores: 1, kind: "store" as const, quotedAt: Date.now(), barato: { fee: 12.19, estimate: "1bd" }, rapido: { fee: 25.1, estimate: "60m" } };
  const c = await customerWith({ freightChoice }, "choosing_freight");
  const out = await send(c.phone, "preciso até amanhã de manhã, qual das duas serve?");
  assert.match(out, /Pra \*amanhã de manhã\*, a que serve é a \*2\) Mais rápida\*/, out);
  assert.match(out, /1\)\* Mais barata \(1 dia útil\): chega \*amanhã\*, mas sem hora marcada/, out);
  assert.doesNotMatch(out, /Agendar horário|O prazo depende/, out);
  assert.equal((await ctxOf(c.convoId)).step, "choosing_freight");
});

test("308: 'Se puder chegar até sexta, tá bom' responde qual opção / se a cesta chega até sexta", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "answer", topic: "delivery_time" }] as DialogueAction[] }));
  const c = await customerWith({ pending: [pend("leite integral", LEITES)] }, "choosing");
  const cards = await send(c.phone, "Se puder chegar até sexta, tá bom");
  assert.match(cards, /até \*sexta, \d\d\/\d\d\*/, cards);
  assert.doesNotMatch(cards, /O prazo depende da loja/, cards);
  const d = await customerWith({ basket: [line("mambo-1", "Pilha Duracell AA 4 unidades", 22.9, "mambo", "Mambo", "Mambo · 1 dia útil")] });
  const basket = await send(d.phone, "Se puder chegar até sexta, tá bom");
  assert.match(basket, /Dá, chega até \*sexta\*/, basket);
  const e = await customerWith({});
  const empty = await send(e.phone, "Se puder chegar até sexta, tá bom");
  assert.match(empty, /Anotado: precisa chegar até \*sexta\*/, empty);
});

test("308: a pergunta de desempate do café sai uma vez só — na 2ª a Lia cruza as respostas e escolhe", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  const questions = ["Você prefere o café tradicional 250g ou o drip coffee tradicional?", "Você prefere o tradicional ou o extra forte?", "Você prefere o de 250g ou o de 500g?"];
  let asked = 0;
  __setDialogueModelForTests(async () => ({ actions: [{ type: "unclear", text: questions[Math.min(asked++, 2)] }] as DialogueAction[] }));
  const c = await customerWith({ pending: [pend("café Pilão", CAFES)] }, "choosing");
  const first = await send(c.phone, "o tradicional");
  assert.match(first, /Você prefere/, first);
  const second = await send(c.phone, "o de 250g");
  assert.doesNotMatch(second, /Você prefere/, second);
  assert.match(second, /Café Pilão Tradicional 250g/, second);
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.basket?.some((b) => b.sku === "santaluzia-3389"), JSON.stringify(ctx.basket));
});

// 307 pelo caminho real (talk-prod, 10/10): "detergente limpol neutro 500ml" → card da Americanas → "Não, só isso" ofereceu
// "Limpol Neutro (R$ 3,18) → *Ype Neutro* (R$ 2,41)" sem aviso. O catálogo da Americanas não traz o campo marca: a marca vem
// do nome. Depois da correção: "→ *Detergente Líquido Neutro Limpol 500ml*" + "o prazo passa de *hoje* para *4 dias úteis*".
test("307: troca de loja guarda a marca escolhida (Limpol ≠ Ypê); mesma marca em outra loja passa", () => {
  // Nos testes os catálogos ligados não trazem marca (a inferência pelo nome só roda com as lojas de produção, como no
  // talk-prod acima); aqui a marca vem do campo.
  const limpol = { name: "Detergente Líquido Limpol Neutro 500ml", brand: "Limpol", storeKey: "americanas", storeLabel: "Americanas" };
  assert.equal(keepsBrand(limpol, { name: "Detergente Líquido Ype Neutro 500ml" }), false);
  assert.equal(keepsBrand(limpol, { name: "Detergente Líquido Neutro Limpol 500ml" }), true);
  assert.equal(keepsBrand({ name: "Desodorante Dove Men+Care Invisible Dry 50ml", brand: "Dove" }, { name: "Desodorante Rexona Men 50ml" }), false);
});
