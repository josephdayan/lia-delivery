// Rodada 9, grupo G27 (10/10): quantidade × tamanho × contagem ("um par de pilhas AA", "meia dúzia", "guaraná 2l",
// "água sanitária 5 litros" virando 2x, "jogo de 4 copos" virando 1 copo), "esquece X… não, pera, continua" (antes e depois
// do cadastro) e "esquece tudo… não, pera, continua", "não achei" falso quando a loja não respondeu, gíria e frases que viram
// item, itens pedidos junto com a ideia de presente, "chega inteiro os ovos?" lido como reclamação e a pergunta composta
// respondida só num pedaço. Textos reais de /mnt/project-files/testes-whatsapp/rodada9/grupo-b.md (jornadas 301-308).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, packAdjusted, runTurnScoped, setCountOf } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests, checkCandidatesLive, unansweredDrops } from "../src/lib/live-availability";
import { asksArrivalCondition, detectIntent, isDiscourseOnly, splitQuestionsOnly } from "../src/lib/lia-intents";
import { itemsAfterAlso, reconcileLineCounts, resolveListItems } from "../src/lib/list-items";
import * as copy from "../src/lib/lia-copy";
import type { ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";
import type { LiveItemCheck } from "../src/lib/live-freight";
import type { DialogueAction } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5527${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g27_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "swift", storeLabel = "Swift"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const pend = (query: string, options: ChoiceOption[], qty = 1, qtyExplicit = false): PendingChoice => ({ query, qty, ...(qtyExplicit ? { qtyExplicit: true } : {}), options }) as PendingChoice;

// ---------------------------------------------------------------- puros

test("A2/A5: 'um par de' = 2 unidades (o que se vende em par continua 1 par); meia dúzia = 6", () => {
  const line = (t: string) => resolveListItems(t).map((l) => [l.phrase, l.qty]);
  assert.deepEqual(line("um par de pilhas AA Duracell"), [["pilhas AA Duracell", 2]]);
  assert.deepEqual(line("um par de meias"), [["par de meias", 1]]);
  assert.deepEqual(line("meia dúzia de pão de alho"), [["pão de alho", 6]]);
  // A cartela de 2 pilhas fecha o par: 1 cartela, não 2 (= 4 pilhas).
  assert.equal(packAdjusted("Pilha Alcalina Duracell AA 2 unidades", 2, "pilhas AA Duracell").qty, 1);
  assert.equal(packAdjusted("Pilha Alcalina Duracell AA 2 unidades", 4, "pilhas AA").qty, 2);
  // Sem conteúdo contável ("2 sabonetes" com kit de 2 no nome não é regra de pilha/ovo): não mexe.
  assert.equal(packAdjusted("Desodorante Rexona 2 unidades", 2, "desodorante").qty, 2);
});

test("A1/A4/A5: a quantidade e o tamanho da IA se acertam com a própria mensagem", () => {
  // IA leu 1 para "um par de" / "12 caixinhas": vale a contagem dita.
  assert.deepEqual(reconcileLineCounts([{ phrase: "pilha AA Duracell", qty: 1 }], "um par de pilhas AA Duracell").map((l) => l.qty), [2]);
  assert.deepEqual(reconcileLineCounts([{ phrase: "leite", qty: 1 }], "leite 12 caixinhas").map((l) => l.qty), [12]);
  // 2x sem número nenhum na mensagem ("5 litros" e "100L" são tamanho): a IA inventou.
  const kit = reconcileLineCounts(
    [
      { phrase: "saco de lixo reforçado 100L", qty: 1 },
      { phrase: "água sanitária 5 litros", qty: 2 }
    ],
    "kit limpeza pós-obra: removedor de cimento, luva de borracha, rodo, balde, pano de chão, saco de lixo reforçado 100L e água sanitária 5 litros. Preciso que chegue amanhã cedo"
  );
  assert.deepEqual(kit.map((l) => l.qty), [1, 1]);
  assert.deepEqual(reconcileLineCounts([{ phrase: "sachê gato sênior", qty: 2 }], "ração renal gato idoso, sachê gato sênior e areia").map((l) => l.qty), [1]);
  // O tamanho dito volta para a busca; a linha repetida do próprio cliente continua somada.
  assert.equal(reconcileLineCounts([{ phrase: "refrigerante guaraná", qty: 3 }], "3 refrigerantes guaraná 2l")[0].phrase, "refrigerante guaraná 2l");
  assert.deepEqual(reconcileLineCounts([{ phrase: "arroz", qty: 2 }], "arroz, feijão, arroz").map((l) => l.qty), [2]);
  assert.equal(setCountOf("jogo de 4 copos"), 4);
  assert.equal(setCountOf("kit com seis taças"), 6);
  assert.equal(setCountOf("copo americano"), null);
});

test("A1/M10: gíria e condição da entrega nunca viram item", () => {
  const phrases = (t: string) => resolveListItems(t).map((l) => l.phrase);
  const p301 = phrases("tlgd q eu so tenho 50 conto kkk. quero 2 pizza congelada, 1 coca 2l e bolacha recheada 3 pacotes");
  assert.ok(!p301.some((p) => /tlgd|kkk/.test(p)), JSON.stringify(p301));
  assert.ok(p301.includes("pizza congelada") && p301.includes("coca 2l"), JSON.stringify(p301));
  assert.deepEqual(phrases("quero 6 taças de vinho e um jogo de 4 copos, tem que chegar inteiro, são frágeis"), ["taças de vinho", "jogo de 4 copos"]);
  assert.deepEqual(phrases("beleza, então vou viajar sexta, preciso de shampoo de viagem 100ml"), ["shampoo de viagem 100ml"]);
  assert.ok(!phrases("saco de lixo 100L e água sanitária 5 litros. Preciso que chegue amanhã cedo").some((p) => /chegue/.test(p)));
  for (const t of ["kkk", "tlgd q", "kkkk rs", "hahaha"]) assert.equal(isDiscourseOnly(t), true, t);
  for (const t of ["pizza", "kit kat"]) assert.equal(isDiscourseOnly(t), false, t);
});

test("A3: o que vem depois de 'também' junto da ideia de presente é pedido à parte", () => {
  assert.equal(
    itemsAfterAlso("preciso de presente de aniversário pra um menino de 7 anos, gasto no máximo R$ 80. Também um cartão de aniversário e embalagem de presente"),
    "cartão de aniversário, embalagem de presente"
  );
  assert.equal(itemsAfterAlso("arroz e feijão"), null);
});

test("M3/M1: 'chega inteiro?' é pergunta; pergunta composta tem uma resposta por tema", () => {
  assert.equal(asksArrivalCondition("chega inteiro os ovos? já veio quebrado outra vez"), true);
  assert.equal(asksArrivalCondition("chega inteiro mesmo? tem seguro?"), true);
  assert.equal(asksArrivalCondition("o pedido veio quebrado"), false);
  const asks = splitQuestionsOnly("oi, como funciona isso? vocês cobram taxa? quanto tempo demora? posso devolver?");
  assert.equal(asks?.length, 4);
  assert.equal(splitQuestionsOnly("vocês cobram taxa? quero arroz"), null);
  assert.equal(splitQuestionsOnly("posso devolver?"), null);
  assert.match(copy.missLine({ status: "unchecked", label: "luva de borracha" }), /não responderam a tempo/);
});

// ---------------------------------------------------------------- conversa (banco)

test("A7: antes do cadastro, 'esquece as taças' tira e 'não, pera, continua com as taças' devolve as 6 taças", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer("6 taças de vinho, jogo de 4 copos");
  const out1 = await send(c.phone, "esquece as taças");
  assert.equal((await ctxOf(c.convoId)).pendingRequest, "jogo de 4 copos", out1);
  assert.match(out1, /Tirei \*taças de vinho\*/, out1);
  const out2 = await send(c.phone, "não, pera, continua com as taças");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.pendingRequest, "jogo de 4 copos, 6 taças de vinho", out2);
  assert.doesNotMatch(out2, /continua com as taças/, out2);
});

test("A7: com a escolha aberta, 'esquece os copos' e 'não, pera, quero sim os copos' devolvem o jogo de 4 sem nova busca", async (t) => {
  if (!dbOk) return t.skip();
  // Como em produção: a IA tirou o item da fila (alvo 1 = 1º da fila, cesta vazia) e não entendeu o "quero sim os copos".
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async ({ text }) =>
    /esquece/.test(text) ? { actions: [{ type: "remove", target: 1 }] as DialogueAction[] } : { actions: [{ type: "unclear", text: "Qual opção de taça você prefere?" }] as DialogueAction[] }
  );
  const tacas = pend("taças de vinho", [opt("swift-t1", "Taça de Cristal para Vinho Bohemia 450ml", 24.18)], 6, true);
  const copos = pend("jogo de 4 copos", [opt("swift-c1", "Jogo 4 Copos Nadir 300ml", 39.9), opt("swift-c2", "Copo Cônico Coza Cozy 300ml", 6.5)]);
  const c = await customerWith({ pending: [tacas, copos] }, "choosing");
  const out1 = await send(c.phone, "esquece os copos");
  assert.equal((await ctxOf(c.convoId)).pending?.length, 1, out1);
  const out = await send(c.phone, "não, pera, quero sim os copos");
  const ctx = await ctxOf(c.convoId);
  const back = ctx.pending?.find((p) => p.query === "jogo de 4 copos");
  assert.ok(back, out.slice(0, 500));
  assert.equal(back?.options.length, 2);
});

test("M5: 'Esquece tudo' seguido de 'não, pera, continua' devolve as escolhas", async (t) => {
  if (!dbOk) return t.skip();
  const racao = pend("ração gato sênior", [opt("swift-r1", "Ração Golden Gatos Sênior 1kg", 39.9)]);
  const areia = pend("areia", [opt("swift-a1", "Areia Pipicat Classic 4kg", 16.49)]);
  const c = await customerWith({ pending: [racao, areia] }, "choosing");
  const cleared = await send(c.phone, "Esquece tudo");
  assert.ok(!(await ctxOf(c.convoId)).pending?.length, cleared);
  const out = await send(c.phone, "não, pera, continua");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual(ctx.pending?.map((p) => p.query), ["ração gato sênior", "areia"], out);
  assert.doesNotMatch(out, /O que você (quer|gostaria)/, out);
});

test("A2: IA lê 'um par de pilhas AA Duracell' como 1 pilha: a escolha da cartela de 2 fecha em 1 cartela", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query: "pilhas AA Duracell", qty: 1 }] as DialogueAction[] }));
  const c = await customerWith({});
  await send(c.phone, "um par de pilhas AA Duracell");
  const ctx = await ctxOf(c.convoId);
  const pilhas = ctx.pending?.[0] ?? null;
  const basket = ctx.basket ?? [];
  // Ou a escolha está aberta com 2 unidades, ou já entrou na cesta (opção única) em embalagens que somam 2.
  const miss = ctx.listMisses?.find((m) => /pilha/i.test(m.query));
  const qty = pilhas?.qty ?? miss?.qty ?? basket.find((b) => /pilha/i.test(b.name))?.qty;
  assert.equal(qty, 2, JSON.stringify({ pending: ctx.pending, listMisses: ctx.listMisses, basket }).slice(0, 500));
});

test("A2: cartela de 2 escolhida para 'par de pilhas' (2 un) entra como 1 cartela", async (t) => {
  if (!dbOk) return t.skip();
  const pilhas = pend("pilhas AA Duracell", [opt("farmaciaindiana-3118", "Pilha Alcalina Duracell AA 2 unidades", 15.99, "farmaciaindiana", "Farmácia Indiana"), opt("swift-p4", "Pilha Duracell AA 4 Unidades", 30)], 2, true);
  const c = await customerWith({ pending: [pilhas] }, "choosing");
  const out = await send(c.phone, "1");
  const item = (await ctxOf(c.convoId)).basket?.find((b) => b.sku === "farmaciaindiana-3118");
  assert.equal(item?.qty, 1, out.slice(0, 400));
});

test("A7: 'jogo de 4 copos' com o copo avulso escolhido vira 4 copos, com aviso", async (t) => {
  if (!dbOk) return t.skip();
  const copos = pend("jogo de 4 copos", [opt("swift-c2", "Copo Cônico Coza Cozy 300ml", 6.5), opt("swift-c1", "Jogo 4 Copos Nadir 300ml", 39.9)]);
  const c = await customerWith({ pending: [copos] }, "choosing");
  const out = await send(c.phone, "1");
  const item = (await ctxOf(c.convoId)).basket?.find((b) => b.sku === "swift-c2");
  assert.equal(item?.qty, 4, out.slice(0, 400));
  assert.match(out, /avulsa/, out.slice(0, 400));
  // O jogo já é o conjunto: 1.
  const c2 = await customerWith({ pending: [copos] }, "choosing");
  await send(c2.phone, "2");
  assert.equal((await ctxOf(c2.convoId)).basket?.find((b) => b.sku === "swift-c1")?.qty, 1);
});

test("M3: 'chega inteiro os ovos? já veio quebrado outra vez' antes de comprar responde sobre quebra (sem chamar o responsável)", async (t) => {
  if (!dbOk) return t.skip();
  const ovos = pend("ovos", [opt("swift-o1", "Ovos Brancos 10 Unidades", 12.9)]);
  const c = await customerWith({ pending: [ovos] }, "choosing");
  const out = await send(c.phone, "chega inteiro os ovos? já veio quebrado outra vez");
  assert.doesNotMatch(out, /avisei o responsável/i, out);
  assert.match(out, /quebrad/i, out);
  assert.equal(detectIntent("chega inteiro os ovos? já veio quebrado outra vez").kind, "complaint");
  const ctx = await ctxOf(c.convoId);
  assert.ok(!ctx.attendance, JSON.stringify(ctx.attendance ?? null));
});

test("M1: 'como funciona isso? vocês cobram taxa? quanto tempo demora? posso devolver?' responde as quatro", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer();
  const out = await send(c.phone, "oi, como funciona isso? vocês cobram taxa? quanto tempo demora? posso devolver?");
  assert.match(out, /Pix ou cartão/, out);
  assert.match(out, /taxa/i, out);
  assert.match(out, /prazo/i, out);
  assert.match(out, /devolu/i, out);
});

test("A4: loja regional que não respondeu a tempo é busca parcial (não 'não achei')", async () => {
  // Regional calada (null = timeout) cai da vitrine sem resposta; a que respondeu "sem estoque" é recusa de verdade.
  const pool = [
    { storeKey: "swift", sku: "swift-1" },
    { storeKey: "mambo", sku: "mambo-1" }
  ];
  const live = await checkCandidatesLive(pool, "01310-100", async (storeKey, skus) => (storeKey === "swift" ? null : new Map<string, LiveItemCheck>(skus.map((sku) => [sku, { sku, available: false }]))), () => true);
  assert.equal(live.kept.length, 0);
  assert.deepEqual(unansweredDrops(live.dropped, live.checks, "01310-100").map((c) => c.sku), ["swift-1"]);
  // A frase para o cliente nunca é "não achei" nesse caso.
  assert.match(copy.itemsNotCheckedNow(["luva de borracha"]), /não responderam a tempo/);
  assert.doesNotMatch(copy.missesBlock([{ status: "unchecked", label: "luva de borracha" }]), /não achei/);
});

test("g25: a IA cola 'mais barato' no nome ('óleo mais barato'): o modificador sai da busca e vira ordenação", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query: "óleo mais barato", qty: 1 }] as DialogueAction[] }));
  const c = await customerWith({});
  const out = await send(c.phone, "quero o óleo mais barato");
  const ctx = await ctxOf(c.convoId);
  assert.doesNotMatch(out, /não achei/i, out.slice(0, 400));
  const choice = ctx.pending?.[0];
  if (choice) {
    assert.doesNotMatch(choice.query, /barat/i);
    const prices = choice.options.map((o) => o.unitPrice);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), JSON.stringify(prices));
  } else assert.ok(ctx.basket?.length, out.slice(0, 400));
});
