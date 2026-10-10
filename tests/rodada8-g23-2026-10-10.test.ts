// Rodada 8, grupo G23 (10/10): item da lista sumindo quando vem junto de uma escolha (pilhas AA), "só quero 1
// desodorante, o roll-on. tira os outros dois" e troca de ideia que acumulava itens antes do cadastro, muletas/frases
// virando item ("vamos dividir a", "sabe", "gastar pouco"), "ignora" que não limpava, ❌ tratado como "oi", "escolhe você
// tudo que falta" só para o item da vez e "só isso, quanto fica?" que não fechava. Textos reais de
// /mnt/project-files/testes-whatsapp/rodada8/grupo-b.md.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { detectIntent, isDiscourseOnly, wantsChoiceForAll } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { discardsLastNote, keepOnlyInGroup, replaceInGroup } from "../src/lib/pending-edits";
import type { ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";
import type { DialogueAction } from "../src/lib/dialogue/types";

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
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
// Cliente novo, sem endereço (o pedido fica guardado em pendingRequest).
async function newcomer(pendingRequest?: string) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address", ...(pendingRequest ? { pendingRequest } : {}) }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g23_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "swift", storeLabel = "Swift"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const pend = (query: string, options: ChoiceOption[]): PendingChoice => ({ query, qty: 1, options }) as PendingChoice;
const PRE = (over: Partial<PreDecision>): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over });

// ---------------------------------------------------------------- puros

test("M1: muleta, pagador e frase de contexto nunca viram item (textos reais de 301, 303, 305, 306)", () => {
  const phrases = (t: string) => resolveListItems(t).map((l) => l.phrase);
  assert.deepEqual(phrases("sou estudante, moro em república com mais 2, vamos dividir a compra. eu pago o meu, ele paga o dele"), []);
  assert.deepEqual(phrases("na verdade não são esses itens, ignora. quero 2 pacotes de macarrão"), ["pacotes de macarrão"]);
  assert.deepEqual(phrases("é... tipo... sabe aquele... aquele negócio de milho ... é pra festa junina da igreja"), ["negócio de milho"]);
  assert.deepEqual(phrases("preciso montar uma cesta básica pra doação, tenho só R$ 100, me ajuda a montar até 100 reais"), []);
  assert.deepEqual(phrases("voltei, desculpa. então quero esse leite do Ninho, e um shampoo, e ração de gato adulto 1kg, e pilhas AA").slice(1), ["shampoo", "ração de gato adulto 1kg", "pilhas AA"]);
  assert.deepEqual(phrases("eu quero arroz e ele quer feijão"), ["arroz", "feijão"]);
  for (const t of ["gastar pouco", "vamos dividir a", "eu pago o meu", "voltei", "desculpa", "sabe"]) assert.equal(isDiscourseOnly(t), true, t);
  // Produto e orçamento continuam: um substantivo qualquer salva o trecho; dinheiro é teto, não fala.
  for (const t of ["leite", "ração pro meu dog", "até 100 reais", "pilhas AA", "pão"]) assert.equal(isDiscourseOnly(t), false, t);
  assert.deepEqual(phrases("ração pro meu dog, ele é filhote"), ["ração pro meu dog filhote"]);
  assert.match(phrases("presente pra minha mãe, tenho só R$ 100")[0] ?? "", /até 100 reais/);
});

test("A3/M6/M1: edição do pedido guardado — só o roll-on, troca no lugar e 'ignora'", () => {
  const segs = ["papel higiênico", "desodorante em creme", "sabonete", "desodorante aerosol", "desodorante roll-on"];
  const keep = keepOnlyInGroup(segs, "só quero 1 desodorante, o roll-on. tira os outros dois");
  assert.deepEqual(keep?.segments, ["papel higiênico", "sabonete", "desodorante roll-on"]);
  assert.deepEqual(keepOnlyInGroup(segs, "fica só o aerosol")?.segments, ["papel higiênico", "sabonete", "desodorante aerosol"]);
  assert.equal(keepOnlyInGroup(["arroz", "feijão"], "só quero arroz"), null);
  assert.deepEqual(replaceInGroup(["papel higiênico", "desodorante em creme", "sabonete"], "não, melhor aerosol", "desodorante aerosol"), ["papel higiênico", "desodorante aerosol", "sabonete"]);
  assert.deepEqual(replaceInGroup(["desodorante aerosol"], "ah, esquece, quero roll-on mesmo", "desodorante roll-on"), ["desodorante roll-on"]);
  assert.equal(replaceInGroup(["arroz"], "e feijão", "feijão"), null);
  assert.equal(replaceInGroup(["leite integral"], "e mais um leite desnatado", "leite desnatado"), null);
  assert.equal(discardsLastNote("na verdade não são esses itens, ignora. quero 2 pacotes de macarrão"), true);
  assert.equal(discardsLastNote("quero 2 pacotes de macarrão"), false);
});

test("M7/M10: ❌ vale como 'não'; 'só isso, quanto fica?' fecha a lista", () => {
  for (const t of ["❌", "❌❌", "👎"]) assert.equal(detectIntent(t).kind, "reject", t);
  assert.equal(detectIntent("👍").kind, "affirm");
  for (const t of ["só isso, quanto fica?", "é só isso. quanto deu?", "só isso então, qual o total?"]) assert.equal(detectIntent(t).kind, "done", t);
  assert.equal(detectIntent("quanto fica?").kind === "done", false);
});

test("M2: 'escolhe você tudo que falta' e 'o mais barato de todos que faltam' valem para todos os pendentes", () => {
  assert.equal(wantsChoiceForAll("escolhe você tudo que falta, não quero ver mais opção"), "any");
  assert.equal(wantsChoiceForAll("escolhe você pra mim o resto, tanto faz a marca"), "any");
  assert.equal(wantsChoiceForAll("o mais barato de todos que faltam, quero gastar pouco"), "cheapest");
  assert.equal(wantsChoiceForAll("escolhe você"), null);
  assert.equal(wantsChoiceForAll("o mais barato"), null);
  const text = "escolhe você tudo que falta, não quero ver mais opção";
  const ctx = { step: "choosing", pending: [pend("leite", [opt("a", "Leite", 5)]), pend("café", [opt("b", "Café", 8)])] } as DeliveryContext;
  assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false }), "intent:choose_all");
});

// ---------------------------------------------------------------- conversa (banco)

test("A1: escolha + 3 itens na mesma mensagem — a IA devolveu só pick + 2 buscas e as pilhas não podem sumir", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  // O modelo real devolveu escolha do Ninho + shampoo + ração (teto de 3 ações): as pilhas ficaram de fora.
  __setDialogueModelForTests(async () => ({
    actions: [
      { type: "pick", option: 2 },
      { type: "search", query: "shampoo", qty: 1 },
      { type: "search", query: "ração gato adulto 1kg", qty: 1 }
    ] as DialogueAction[]
  }));
  const leite = pend("leite", [opt("swift-1", "Leite Semidesnatado Parmalat 1L", 5.49), opt("swift-7134", "Leite Integral Ninho Nestlé 1l", 7.67)]);
  const c = await customerWith({ pending: [leite] }, "choosing");
  const out = await send(c.phone, "voltei, desculpa. então quero esse leite do Ninho, e um shampoo, e ração de gato adulto 1kg, e pilhas AA");
  const ctx = await ctxOf(c.convoId);
  const seen = `${out}\n${JSON.stringify(ctx.pending ?? [])}\n${JSON.stringify(ctx.basket ?? [])}\n${JSON.stringify(ctx.listMisses ?? [])}`;
  assert.match(seen, /pilha/i, out.slice(0, 600));
  assert.doesNotMatch(out, /Achei os 2 itens/, out.slice(0, 600));
  assert.doesNotMatch(out, /\bvoltei\b|\bdesculpa\b/i, out.slice(0, 600));
});

test("M6: antes do cadastro, 'não, melhor aerosol' e 'esquece, quero roll-on mesmo' trocam o desodorante (não somam)", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  const answers: Record<string, string> = { "não, melhor aerosol": "desodorante aerosol", "ah, esquece, quero roll-on mesmo": "desodorante roll-on" };
  __setPreSignupModelForTests(async ({ text }) => PRE({ items: [{ query: answers[text] ?? text, qty: 1, cheapest: false }] }));
  const c = await newcomer("papel higiênico, desodorante em creme, sabonete");
  await send(c.phone, "não, melhor aerosol");
  assert.equal((await ctxOf(c.convoId)).pendingRequest, "papel higiênico, desodorante aerosol, sabonete");
  const out = await send(c.phone, "ah, esquece, quero roll-on mesmo");
  assert.equal((await ctxOf(c.convoId)).pendingRequest, "papel higiênico, desodorante roll-on, sabonete");
  assert.doesNotMatch(out, /creme|aerosol/i, out);
});

test("A3: 'só quero 1 desodorante, o roll-on. tira os outros dois' mantém o roll-on e nada vira item", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer("papel higiênico, desodorante em creme, sabonete, desodorante aerosol, desodorante roll-on");
  const out = await send(c.phone, "só quero 1 desodorante, o roll-on. tira os outros dois");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.pendingRequest, "papel higiênico, sabonete, desodorante roll-on", out);
  assert.doesNotMatch(out, /tira os outros|em creme|aerosol/i, out);
});

test("M1: 'na verdade não são esses itens, ignora' tira o que a mensagem anterior anotou", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer("arroz");
  await send(c.phone, "e um sabão em pó e amaciante");
  const before = (await ctxOf(c.convoId)).pendingRequest ?? "";
  assert.match(before, /sab[aã]o/);
  const out = await send(c.phone, "na verdade não são esses itens, ignora. quero 2 pacotes de macarrão");
  const ctx = await ctxOf(c.convoId);
  assert.doesNotMatch(ctx.pendingRequest ?? "", /sab[aã]o|amaciante|ignora|verdade/i, out);
  assert.match(ctx.pendingRequest ?? "", /arroz/);
  assert.match(ctx.pendingRequest ?? "", /macarr/);
});

test("M2: 'escolhe você tudo que falta, não quero ver mais opção' põe a 1ª opção de cada item na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        pend("leite", [opt("swift-l1", "Leite Integral Italac 1L", 5.2), opt("swift-l2", "Leite Integral Ninho 1L", 7.67)]),
        pend("café", [opt("swift-c1", "Café Pilão 500g", 21.99), opt("swift-c2", "Café Melitta 500g", 19.9)]),
        pend("açúcar", [opt("swift-a1", "Açúcar União 1kg", 5.49), opt("swift-a2", "Açúcar Caravelas 1kg", 4.99)])
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "escolhe você tudo que falta, não quero ver mais opção");
  const ctx = await ctxOf(c.convoId);
  const skus = (ctx.basket ?? []).map((b) => b.sku).sort();
  assert.deepEqual(skus, ["swift-a1", "swift-c1", "swift-l1"], out.slice(0, 500));
  assert.equal(ctx.pending?.length ?? 0, 0, out.slice(0, 500));
});

test("M10: 'só isso, quanto fica?' fecha a lista (não pede 'diz só isso')", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [{ sku: "swift-l1", name: "Leite Integral Italac 1L", qty: 1, unitPrice: 5.2, lineTotal: 5.2, storeKey: "swift", storeLabel: "Swift" }] });
  const out = await send(c.phone, "só isso, quanto fica?");
  assert.doesNotMatch(out, /Diz \*"só isso"\*/, out.slice(0, 500));
});
