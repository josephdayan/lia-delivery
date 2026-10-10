// Rodada 9, grupo G26 (10/10): item que some (escolha ambígua + itens novos, lista numerada na mesma linha, "cada um
// paga a sua parte... quero também arroz"), "põe o papel de volta" com o resumo na mesa, edição do pedido guardado antes
// do cadastro ("o mais barato de todos", "tira X", "põe de volta", "não, deixa o arroz", "o que tem na cesta?"), "até
// sexta, dá?" / "sábado que vem, chega?" com os cards na tela, pergunta que não escolhe ("tem de 2 litros?"), "tem que
// chegar amanhã" que virava item e "tem mais barato a areia?" com o item nomeado. Textos reais de
// /mnt/project-files/testes-whatsapp/rodada9/grupo-a.md e grupo-b.md (jornada 307).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, sizeGapFor } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { planActions } from "../src/lib/dialogue/plan";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { opsPublishManualQuote } from "../src/lib/ops-lifecycle";
import * as copy from "../src/lib/lia-copy";
import { asksDeadline, detectIntent, parseNeededBy, parseRefinement, splitOrdersRest } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";
import type { DialogueAction } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5526${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g26_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "swift", storeLabel = "Swift", delivery?: string): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as ChoiceOption;
const pend = (query: string, options: ChoiceOption[]): PendingChoice => ({ query, qty: 1, options }) as PendingChoice;
const line = (sku: string, name: string, unitPrice: number, storeKey = "mambo", storeLabel = "Mambo"): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel }) as BasketItem;

const LEITES = [
  opt("swift-7134", "Leite Integral Ninho Nestlé 1l", 7.67, "swift", "Swift", "Swift · hoje, 6h–8h"),
  opt("mambo-8011", "Leite Integral Forti+ Ninho 1L", 9.56, "mambo", "Mambo", "Mambo · hoje, 7h–10h"),
  opt("indiana-80455", "Leite Integral Piracanjuba UHT 1L", 6.92, "farmaciaindiana", "Farmácia Indiana", "Farmácia Indiana · 9 dias úteis")
];
const AMBIGUOUS = "gostei desse leite integral, mais um desodorante, ração de cachorro adulto e pilhas AAA";
const NUMBERED = "1) 2x carvão 3kg 2) duas cervejas long neck Heineken caixa 3) um par de linguiça toscana 4) meia dúzia de pão de alho 5) 3 refrigerantes guaraná 2l 6) sal grosso";

// ---------------------------------------------------------------- puros

test("A1/B-307: plano sem busca (só 'unclear' ou só escolha) não cobre lista de 3+ itens; lista numerada na linha conta todos", () => {
  const ctx = { step: "choosing", pending: [pend("leite integral", LEITES)] } as DeliveryContext;
  const state = buildDialogueState(ctx, { hasAddress: true });
  const unclear = planActions({ actions: [{ type: "unclear", text: "Qual opção de leite integral você prefere?" }] as DialogueAction[] }, state, { text: AMBIGUOUS });
  assert.deepEqual(unclear, { ok: false, reason: "lista_maior_que_as_acoes" });
  // Pergunta solta continua valendo como "unclear".
  assert.equal(planActions({ actions: [{ type: "unclear", text: "Qual?" }] as DialogueAction[] }, state, { text: "gostei desse leite integral" }).ok, true);
  const phrases = resolveListItems(NUMBERED).map((l) => l.phrase);
  assert.equal(phrases.length, 6, JSON.stringify(phrases));
  assert.ok(phrases.some((p) => /pão de alho/.test(p)) && phrases.some((p) => /guaraná/.test(p)) && phrases.some((p) => /sal grosso/.test(p)), JSON.stringify(phrases));
  const fresh = buildDialogueState({ step: "collecting" } as DeliveryContext, { hasAddress: true });
  const three = planActions({ actions: ["carvão 3kg", "cerveja long neck Heineken", "linguiça toscana"].map((query) => ({ type: "search", query, qty: 1 })) as DialogueAction[] }, fresh, { text: NUMBERED });
  assert.equal(three.ok, false);
  // "2 arroz 3 feijão" não é numeração (sem marcador 1).
  assert.equal(resolveListItems("1. arroz 2. feijão 3. óleo 1.5l").length, 3);
});

test("B-307: pergunta não escolhe — 'tem de 2 litros? eu queria 3 de 2l' não vira pick; o refino entende a medida", () => {
  const guarana = [opt("s-200", "Refrigerante Guaraná Antarctica 200ml", 2.52), opt("i-2l", "Refrigerante Guaraná Antártica 2l", 10.99, "farmaciaindiana", "Farmácia Indiana", "9 dias úteis")];
  const state = buildDialogueState({ step: "choosing", pending: [pend("guaraná", guarana)] } as DeliveryContext, { hasAddress: true });
  const text = "tem de 2 litros? eu queria 3 de 2l";
  assert.deepEqual(planActions({ actions: [{ type: "pick", option: 2 }] as DialogueAction[] }, state, { text }), { ok: false, reason: "pick:pergunta_nao_escolhe" });
  assert.equal(planActions({ actions: [{ type: "pick", option: 2 }] as DialogueAction[] }, state, { text: "quero a 2, tem gelada?" }).ok, true);
  assert.equal(planActions({ actions: [{ type: "pick", option: 2 }] as DialogueAction[] }, state, { text: "quero o segundo" }).ok, true);
  assert.deepEqual(parseRefinement(text), ["2l"]);
});

test("A2: o resto da mensagem fora da fala de pagadores segue como pedido", () => {
  assert.equal(splitOrdersRest("cada um paga a sua parte, somos em 3 aqui. quero também arroz"), "quero também arroz");
  assert.equal(splitOrdersRest("eu pago o meu, e quero arroz e feijão"), "e quero arroz e feijão");
  assert.equal(splitOrdersRest("a fantasia e a abóbora são minhas, as balas e o pirulito são do meu colega que paga separado. dá pra fazer dois pedidos?"), null);
  assert.equal(splitOrdersRest("sou estudante, moro em república com mais 2, vamos dividir a compra. eu pago o meu, ele paga o dele"), null);
});

test("A4: prazo com dia — 'chegar até sexta, dá?', 'sábado que vem, chega?' e 'chega até sexta? me responde sim ou não'", () => {
  const sat = new Date("2026-10-10T15:00:00Z");
  assert.equal(parseNeededBy("preciso disso pra sábado que vem, chega?", sat)?.date, "2026-10-17");
  assert.equal(parseNeededBy("sábado que vem, chega?", sat)?.label, "sábado");
  assert.equal(parseNeededBy("chega na sexta?", sat)?.date, "2026-10-16");
  for (const t of ["chegar até sexta, dá?", "sábado que vem, chega?", "chega até sexta? me responde sim ou não", "preciso que chegue até sexta, dá?"]) assert.ok(asksDeadline(t), t);
  assert.equal(asksDeadline("arroz e feijão"), null);
  const ctx = { step: "choosing", pending: [pend("leite integral", LEITES)] } as DeliveryContext;
  assert.equal(dialogueBypassReason({ text: "sábado que vem, chega?", intent: detectIntent("sábado que vem, chega?"), ctx, hasAddress: true, looksLikeList: false }), "intent:deadline_ask");
  const rows = [
    { n: 1, name: "Leite A", delivery: "Swift · hoje", today: true, onTime: true },
    { n: 2, name: "Leite B", delivery: "Indiana · 9 dias úteis", onTime: false }
  ];
  assert.match(copy.choiceEtaAnswer(rows, false, "sexta, 16/10"), /^Depende da loja\. Chega até \*sexta, 16\/10\*: \*1\*/);
  assert.match(copy.choiceEtaAnswer([rows[1]], false, "sexta, 16/10"), /^Não, essa não chega até \*sexta, 16\/10\*/);
});

test("baixa: 'tem que chegar amanhã' é prazo, não item; tamanho pedido ausente avisa mesmo com um card sem medida", () => {
  assert.deepEqual(resolveListItems("preciso de papel higiênico e sabonete, tem que chegar amanhã").map((l) => l.phrase), ["papel higiênico", "sabonete"]);
  assert.deepEqual(resolveListItems("arroz, precisa chegar até sexta").map((l) => l.phrase), ["arroz"]);
  assert.ok(parseNeededBy("preciso de papel higiênico e sabonete, tem que chegar amanhã"));
  const gap = sizeGapFor("ração cachorro adulto 15kg", [{ name: "Ração Golden Adulto 10,1kg" }, { name: "Ração Premier Adulto 10,1 kg" }, { name: "Ração Pedigree Adulto" }]);
  assert.equal(gap?.falta, "é de 10,1 kg");
  assert.equal(sizeGapFor("ração cachorro adulto 15kg", [{ name: "Ração Golden Adulto 15kg" }, { name: "Ração Pedigree Adulto" }]), null);
});

// ---------------------------------------------------------------- conversa (banco)

test("A1: carrossel de leite + 'gostei desse leite integral, mais um desodorante, ração...' — a IA só perguntou qual leite; os 3 itens ficam na fila", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "unclear", text: "Qual opção de leite integral você prefere: 1, 2 ou 3?" }] as DialogueAction[] }));
  const c = await customerWith({ pending: [pend("leite integral", LEITES)] }, "choosing");
  const out = await send(c.phone, AMBIGUOUS);
  const ctx = await ctxOf(c.convoId);
  const queued = (ctx.pending ?? []).map((p) => p.query).join(" | ");
  const seen = `${out}\n${queued}\n${JSON.stringify(ctx.listMisses ?? [])}\n${JSON.stringify(ctx.notFound ?? [])}`;
  for (const item of [/desodorante/i, /ra[cç][aã]o/i, /pilha/i]) assert.match(seen, item, out.slice(0, 600));
  assert.match(queued, /leite/i, queued);
});

test("A2: 'cada um paga a sua parte, somos em 3 aqui. quero também arroz' responde os pagadores E guarda o arroz (com e sem cadastro)", async (t) => {
  if (!dbOk) return t.skip();
  const text = "cada um paga a sua parte, somos em 3 aqui. quero também arroz";
  const c = await customerWith({ basket: [line("swift-7134", "Leite Integral Ninho Nestlé 1l", 7.67, "swift", "Swift")] });
  const out = await send(c.phone, text);
  assert.match(out, /dois pedidos/, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  const seen = `${out}\n${JSON.stringify(ctx.pending ?? [])}\n${JSON.stringify(ctx.basket ?? [])}\n${JSON.stringify(ctx.listMisses ?? [])}`;
  assert.match(seen, /arroz/i, out.slice(0, 600));
  const n = await newcomer("leite integral");
  const outNew = await send(n.phone, text);
  assert.match(outNew, /dois pedidos/, outNew);
  assert.match((await ctxOf(n.convoId)).pendingRequest ?? "", /arroz/, outNew);
});

test("A3: 'põe o papel de volta' com o resumo na mesa reabre o pedido e devolve o MESMO item", async (t) => {
  if (!dbOk) return t.skip();
  const papel = line("pacheco-888516", "Papel Higiênico Deluxe Cotton Folha Dupla 20m 12 Rolos", 13.19, "drogariaspacheco", "Drogarias Pacheco");
  const sabonete = line("mambo-12864", "Sabonete em Barra Raiz Oriente Phebo 90g", 7.25);
  const c = await customerWith({ basket: [sabonete], lastRemoved: { items: [papel], queries: [], at: Date.now() } }, "awaiting_operator_quote");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, conversationId: c.convoId, status: "awaiting_operator_quote", items: [sabonete] as unknown as object, cep: "01310-100", deliveryAddress: ADDRESS, storeKey: "concierge", storeLabel: "Lia" }
  });
  const ctx0 = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx0, deliveryOrderId: order.id }) } });
  // A publicação do resumo (depois do "tira o papel") não pode apagar o item tirado.
  await opsPublishManualQuote(order.id, { itemsSubtotal: 7.25, deliveryFee: 15.9, deliveryMode: "retailer_delivery" });
  const published = await ctxOf(c.convoId);
  assert.equal(published.step, "awaiting_quote_confirmation");
  assert.equal(published.lastRemoved?.items?.[0]?.sku, "pacheco-888516");
  const out = await send(c.phone, "põe o papel de volta");
  assert.match(out, /Voltei \*Papel Higiênico Deluxe Cotton/, out.slice(0, 600));
  assert.doesNotMatch(out, /Não tenho uma lista aberta|não achei/i, out.slice(0, 600));
  const after = await ctxOf(c.convoId);
  const back = [...(after.basket ?? []), ...(((await prisma.deliveryOrder.findFirst({ where: { userId: c.userId, status: { not: "canceled" } }, orderBy: { createdAt: "desc" } }))?.items as unknown as BasketItem[]) ?? [])];
  assert.ok(back.some((b) => b.sku === "pacheco-888516"), JSON.stringify(back).slice(0, 400));
});

test("A4: 'não, deixa o arroz' logo depois de 'tira o arroz' com o resumo na mesa devolve o arroz (sem perguntar)", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "unclear", text: "Você quer retirar o arroz do pedido ou manter como está?" }] as DialogueAction[] }));
  const arroz = line("swift-7694", "Arroz Branco Swift 1kg", 4.37, "swift", "Swift");
  const sabonete = line("mambo-12864", "Sabonete em Barra Raiz Oriente Phebo 90g", 7.25);
  const c = await customerWith({ basket: [sabonete], lastRemoved: { items: [arroz], queries: [], at: Date.now() } }, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, conversationId: c.convoId, status: "awaiting_quote_confirmation", items: [sabonete] as unknown as object, cep: "01310-100", deliveryAddress: ADDRESS, storeKey: "concierge", storeLabel: "Lia", itemsSubtotal: 7.25, deliveryFee: 15.9, total: 23.15 }
  });
  const ctx0 = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx0, deliveryOrderId: order.id }) } });
  const asked = await send(c.phone, "o que tem na cesta?");
  assert.match(asked, /No seu pedido:[\s\S]*Sabonete[\s\S]*Total: R\$ 23,15/, asked);
  const out = await send(c.phone, "não, deixa o arroz");
  assert.match(out, /Voltei \*Arroz Branco Swift 1kg\*/, out.slice(0, 600));
  assert.doesNotMatch(out, /retirar o arroz/, out);
});

test("A4: antes do cadastro, 'o mais barato de todos', 'tira', 'põe de volta', 'não, deixa' e 'o que tem na cesta?' editam o pedido guardado", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer("papel higiênico, sabonete, arroz");
  const cheap = await send(c.phone, "o mais barato de todos");
  assert.match(cheap, /mais barato/, cheap);
  assert.doesNotMatch(cheap, /1x o mais barato de todos/, cheap);
  assert.equal((await ctxOf(c.convoId)).pendingRequest, "papel higiênico mais barato, sabonete mais barato, arroz mais barato");
  const removed = await send(c.phone, "tira o papel higiênico");
  assert.match(removed, /Tirei \*papel higiênico\* da lista/, removed);
  assert.doesNotMatch((await ctxOf(c.convoId)).pendingRequest ?? "", /papel/);
  const back = await send(c.phone, "põe o papel de volta");
  assert.match(back, /Voltei \*papel higiênico\* pra lista/, back);
  assert.doesNotMatch(back, /põe o papel de volta/, back);
  await send(c.phone, "tira o arroz");
  const kept = await send(c.phone, "não, deixa o arroz");
  assert.match(kept, /Voltei \*arroz\* pra lista/, kept);
  assert.doesNotMatch(kept, /deixa o arroz/, kept);
  const list = await send(c.phone, "o que tem na cesta?");
  assert.match(list, /Até agora anotei:[\s\S]*sabonete[\s\S]*papel higiênico[\s\S]*arroz/, list);
  const final = (await ctxOf(c.convoId)).pendingRequest ?? "";
  assert.equal(final.split(", ").length, 3, final);
});

test("A4: 'preciso que chegue até sexta, dá?' com os cards na tela responde sim/não pro dia, mesmo reescrito pela IA", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "answer", topic: "delivery_time" }] as DialogueAction[] }));
  const c = await customerWith({ pending: [pend("leite integral", LEITES)] }, "choosing");
  for (const text of ["preciso que chegue até sexta, dá?", "preciso disso pra sábado que vem, chega?"]) {
    const out = await send(c.phone, text);
    assert.match(out, /^(Dá|Não|Depende da loja)[\s\S]*até \*(sexta|sábado), \d\d\/\d\d\*/, out);
    assert.doesNotMatch(out, /^Prazo de cada opção/, out);
  }
});

test("baixa: 'tem mais barato a areia?' com a areia nomeada não pergunta 'de qual item'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "more_options", sort: "cheaper" }] as DialogueAction[] }));
  const areia = { ...line("cobasi-203580", "Areia Pipicat Multi-Cat Odor Block para Gatos 12 kg", 51.69, "cobasi", "Cobasi"), ask: "areia pra gato" } as BasketItem;
  const sabonete = line("mambo-12864", "Sabonete em Barra Raiz Oriente Phebo 90g", 7.25);
  const lastChoice = { ...pend("sabonete", [opt("mambo-12864", "Sabonete em Barra Raiz Oriente Phebo 90g", 7.25, "mambo", "Mambo")]), chosenSku: "mambo-12864" };
  const c = await customerWith({ basket: [areia, sabonete], lastChoice });
  const out = await send(c.phone, "tem mais barato a areia?");
  assert.doesNotMatch(out, /De qual item/, out.slice(0, 600));
});
