// Rodada 3, grupo g9 (09/10): lista longa sem perder item, resposta a pergunta da Lia que soma (não recomeça), "como cancelo?"
// que só explica, endereço com CEP antes do cadastro, Sim/Não/Depende nas perguntas de entrega e pagamento, "não achei"
// que a reescrita anti-repetição não apaga, link/inglês e polimentos (cidade no resumo, palavrão de raiva).
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, parsePreDecision, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setRepeatModelForTests, rewriteRepeated, conveysMiss } from "../src/lib/dialogue/repeat";
import { planActions } from "../src/lib/dialogue/plan";
import { answerOpenQuestion, asksDeliveryToday, detectIntent, isAngerSwear, normalizeMsg } from "../src/lib/lia-intents";
import { stripLinks, translateEnglishOrder } from "../src/lib/en-order";
import * as copy from "../src/lib/lia-copy";
import type { DialogueAction } from "../src/lib/dialogue/types";

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
process.env.LIA_DIALOGUE_LLM = "true";

const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const act = (type: DialogueAction["type"], rest: Partial<DialogueAction> = {}): DialogueAction => ({ type, ...rest });
function mainModel(script: () => DialogueAction[] | null) {
  __setDialogueModelForTests(async () => {
    const actions = script();
    return actions ? { actions } : null;
  });
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g9_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  return phone;
}
async function registered(ctxExtra: Record<string, unknown> = {}, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return phone;
}
async function context(phone: string) {
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
beforeEach(() => {
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(null);
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
});
after(async () => {
  __setPreSignupModelForTests(null);
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

const LONG_LIST =
  "preciso de: 2 leites, meia dúzia de ovos, 1kg de tomate, arroz tio joão 5kg, feijao carioca, 2 pacotes de macarao parafuso, óleo de soja, açucar, cafe pilao, papel higenico 12 rolos, detergente ype, 1 sabão em pó omo";

// ---------------------------------------------------------------- 1. lista longa

test("1) o extrator de pré-cadastro não corta a lista em 8 itens", () => {
  const raw = { items: Array.from({ length: 12 }, (_, i) => ({ query: `item ${i + 1}`, qty: 1, cheapest: false })) };
  assert.equal(parsePreDecision(raw)?.items.length, 12);
});

test("1) cliente novo manda 12 itens: os 12 entram e nenhum some calado (IA devolve só 8 → caminho determinístico anota todos)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  __setPreSignupModelForTests(async () =>
    D({ items: ["2 leites", "6 ovos", "tomate 1kg", "arroz tio joão 5kg", "feijao carioca", "2 macarao parafuso", "óleo de soja", "açucar"].map((query) => ({ query, qty: 1, cheapest: false })) })
  );
  const out = await send(phone, LONG_LIST);
  const ctx = await context(phone);
  const saved = `${out}\n${ctx.pendingRequest ?? ""}`.toLowerCase();
  for (const word of ["caf", "papel", "detergente", "sab"]) assert.match(saved, new RegExp(word), `faltou ${word}: ${saved}`);
  assert.ok((ctx.pendingRequest ?? "").split(", ").length >= 12, ctx.pendingRequest);
});

// ---------------------------------------------------------------- 2. resposta à pergunta pendente

test("2) 'Qual leite você quer?' + 'o integral mesmo, e o pão de forma': pura — leite integral + pão de forma, somados", () => {
  assert.equal(answerOpenQuestion("Qual leite você quer?", "o integral mesmo, e o pão de forma"), "adiciona leite integral, pão de forma");
  assert.equal(answerOpenQuestion("Qual leite você quer?", "integral"), "adiciona leite integral");
  assert.equal(answerOpenQuestion("Qual leite você quer?", "o da Piracanjuba"), "adiciona leite piracanjuba");
  assert.equal(answerOpenQuestion("Qual leite você quer?", "não, deixa"), null);
});

test("2) depois de 'Qual leite você quer?', a resposta com item extra mantém a cesta e nunca abre 'lista nova'", async (t) => {
  if (!dbOk) return t.skip();
  const amaciante = { sku: "amac-1", name: "Amaciante Mais Cuidado 1,7L", qty: 1, unitPrice: 12.9, lineTotal: 12.9, storeKey: "carrefour", storeLabel: "Carrefour" };
  const phone = await registered({ basket: [amaciante] });
  let turn = 0;
  mainModel(() => (++turn === 1 ? [act("unclear", { text: "Qual leite você quer?" })] : null));
  const first = await send(phone, "eu queria, tipo, aquele leite, não, o outro, sabe, e ah, pão de forma também, o integral");
  assert.match(first, /Qual leite você quer\?/);
  assert.ok((await context(phone)).openQuestion, "a pergunta aberta fica guardada");
  const out = await send(phone, "o integral mesmo, e o pão de forma");
  assert.doesNotMatch(out, /lista nova|deixei de fora/i, out);
  const ctx = await context(phone);
  const names = [...(ctx.basket ?? []).map((b: { name: string }) => b.name), ...(ctx.pending ?? []).map((p: { query: string }) => p.query)].join("|").toLowerCase();
  assert.match(names, /amaciante/, "a cesta antiga continua");
  assert.match(names, /leite/, names);
  assert.match(names, /p[aã]o/, names);
  assert.equal(ctx.openQuestion, undefined);
});

// ---------------------------------------------------------------- 3. "como cancelo?"

test("3) pergunta sobre cancelar não passa pela IA (que lia como pedido) e só explica", async (t) => {
  for (const q of ["como cancelo?", "dá pra cancelar?", "posso cancelar depois?"]) {
    assert.equal(detectIntent(q).kind, "cancel_question", q);
    const why = dialogueBypassReason({ text: q, intent: detectIntent(q), ctx: { step: "awaiting_quote_confirmation" } as never, hasAddress: true, looksLikeList: false });
    assert.equal(why, "intent:cancel_question", q);
  }
  for (const c of ["cancela", "quero cancelar", "cancelar"]) assert.equal(detectIntent(c).kind, "cancel", c);
  if (!dbOk) return t.skip();
  const item = { sku: "lt-1", name: "Leite Integral 1L", qty: 1, unitPrice: 5.49, lineTotal: 5.49, storeKey: "carrefour", storeLabel: "Carrefour" };
  const phone = await registered({ basket: [item] });
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const order = await prisma.deliveryOrder.create({
    data: { userId: user.id, phone, storeKey: "carrefour", storeLabel: "Carrefour", items: [item], total: 21.39, status: "awaiting_quote_confirmation" }
  });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id } });
  await prisma.conversation.update({
    where: { id: convo.id },
    data: { context: JSON.stringify({ flow: "delivery", step: "awaiting_quote_confirmation", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", deliveryOrderId: order.id, basket: [item] }) }
  });
  mainModel(() => [act("cancel")]);
  const out = await send(phone, "como cancelo?");
  assert.doesNotMatch(out, /Cancelado/i, out);
  assert.match(out, /cancelar/i);
  const still = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(still.status, "awaiting_quote_confirmation");
  assert.match(copy.cancelHowTo(false), /cancelar/);
});

// ---------------------------------------------------------------- 4. endereço antes do cadastro

test("4) 'muda o endereço pro trabalho: Rua…, CEP' antes do cadastro salva o endereço com o CEP (não vira item nem pede o CEP)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  const out = await send(phone, "muda o endereço pro trabalho: Rua Funchal 418, Vila Olímpia, 04551-060");
  assert.doesNotMatch(out, /Falta o \*CEP\*|Anotei|muda o endere/i, out);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.match(user.defaultAddress ?? "", /Funchal 418/);
  assert.equal(user.cep?.replace(/\D/g, ""), "04551060");
});

test("8) troca de endereço escrita sem cidade: o resumo leva a cidade do CEP", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  await send(phone, "muda o endereço pro trabalho: Rua Funchal 418, Vila Olímpia, 04551-060");
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.match(user.defaultAddress ?? "", /Funchal 418/);
  assert.match(user.defaultAddress ?? "", /São Paulo/, user.defaultAddress ?? "");
});

// ---------------------------------------------------------------- 5. Sim / Não / Depende

test("5) 'entregam hoje?': a resposta abre com Sim / Não / Depende da loja", () => {
  for (const q of ["entregam hoje?", "vocês entregam hoje?", "chega hoje?", "dá pra entregar hoje?"]) assert.ok(asksDeliveryToday(q), q);
  assert.equal(asksDeliveryToday("qual o prazo?"), false);
  assert.match(copy.basketEtaAnswer([{ store: "Mambo", when: "amanhã, 5h–8h" }], true), /^Não, hoje não\./);
  assert.match(copy.basketEtaAnswer([{ store: "Drogal", when: "3h" }], true), /^Sim, chega hoje\./);
  assert.match(copy.basketEtaAnswer([{ store: "Mambo", when: "amanhã" }, { store: "Drogal", when: "3h" }], true), /^Depende da loja\./);
  assert.match(copy.choiceEtaAnswer([{ n: 1, name: "A", delivery: "Mambo · amanhã" }, { n: 2, name: "B", delivery: "Mambo · 2 dias" }], true), /^Não, nenhuma/);
  assert.match(copy.todayUnknown(), /^Depende da loja/);
  assert.match(copy.unsupportedPayment(), /^Não/);
});

test("5) 'entregam hoje?' sem itens e com o resumo na tela responde direto; 'posso pagar na entrega?' começa com Não", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  mainModel(() => [act("answer", { topic: "area" })]);
  const none = await send(phone, "vocês entregam hoje?");
  assert.match(none, /^Depende da loja/, none);
  assert.doesNotMatch(none, /Atendo/);
  const pay = await send(phone, "posso pagar na entrega?");
  assert.match(pay, /^Não/, pay);

  const item = { sku: "lt-1", name: "Leite Integral 1L", qty: 1, unitPrice: 5.49, lineTotal: 5.49, storeKey: "carrefour", storeLabel: "Carrefour" };
  const screen = await registered();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone: screen } });
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: screen, storeKey: "carrefour", storeLabel: "Carrefour", items: [item], total: 21.39, status: "awaiting_quote_confirmation",
      fulfillments: [{ storeKey: "carrefour", storeLabel: "Carrefour", deliveryPromise: "amanhã, 5h–8h" }]
    }
  });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id } });
  await prisma.conversation.update({
    where: { id: convo.id },
    data: { context: JSON.stringify({ flow: "delivery", step: "awaiting_quote_confirmation", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", deliveryOrderId: order.id, basket: [item] }) }
  });
  mainModel(() => [act("status")]);
  const on = await send(screen, "vocês entregam hoje?");
  assert.match(on, /^Não, hoje não\./, on);
  assert.match(on, /amanhã/);
  assert.doesNotMatch(on, /Ainda não gerei/);
});

// ---------------------------------------------------------------- 6. "não achei" não some na reescrita

test("6) a reescrita anti-repetição nunca apaga a informação de que não achou", async () => {
  const said = "Esses eu não achei em nenhuma loja agora:\n• carregador lightning";
  assert.ok(conveysMiss(said));
  __setRepeatModelForTests(async () => "Entendi, você procura um carregador Lightning.");
  assert.equal(await rewriteRepeated({ customer: "carregador lightning", said, recent: [said] }), null, "sai o texto original, que diz que não achou");
  __setRepeatModelForTests(async () => "Também não achei esse carregador aqui; me diz outro nome?");
  assert.match((await rewriteRepeated({ customer: "carregador lightning", said, recent: [said] })) ?? "", /não achei/);
  __setRepeatModelForTests(async () => "Combinado! Quando precisar é só chamar 💚");
  assert.match((await rewriteRepeated({ customer: "valeu", said: "Qualquer coisa é só chamar 🙂", recent: ["Qualquer coisa é só chamar 🙂"] })) ?? "", /Combinado/);
});

// ---------------------------------------------------------------- 7. link e inglês

test("7) link: a Lia não abre e pede o nome; inglês básico vira português e não trava a lista", async (t) => {
  assert.deepEqual(stripLinks("https://www.amazon.com.br/dp/B08XYZ"), { text: "", hadLink: true });
  assert.deepEqual(stripLinks("quero isso https://www.amazon.com.br/dp/B08XYZ e leite"), { text: "quero isso e leite", hadLink: true });
  assert.equal(stripLinks("arroz e feijão").hadLink, false);
  assert.equal(translateEnglishOrder("I need a phone charger and some milk"), "carregador de celular, leite");
  assert.equal(translateEnglishOrder("milk and bread please"), "leite, pão");
  for (const pt of ["me manda leite", "arroz e feijão", "pasta de dente", "banana"]) assert.equal(translateEnglishOrder(pt), null, pt);
  if (!dbOk) return t.skip();
  const phone = await registered();
  const out = await send(phone, "https://www.amazon.com.br/dp/B08XYZ");
  assert.match(out, /Não consigo abrir link/);
  assert.doesNotMatch(out, /não achei/i);
});

// ---------------------------------------------------------------- 8. polimentos

test("8) palavrão de raiva vira desculpa curta com convite a contar o problema", async (t) => {
  for (const msg of ["que porra é essa", "aff, que merda", "puta merda"]) {
    assert.ok(isAngerSwear(normalizeMsg(msg)), msg);
    assert.equal(detectIntent(msg).kind, "insult", msg);
  }
  assert.equal(detectIntent("me manda 2 leites, porra").kind, "free_text");
  assert.match(copy.angerApology(), /^Desculpa!/);
  if (!dbOk) return t.skip();
  const phone = await registered();
  const out = await send(phone, "que porra é essa");
  assert.match(out, /^Desculpa!/, out);
});

test("8) 'trocar endereço': o endereço que a IA devolve precisa estar na fala do cliente (nada de repetir o antigo)", () => {
  const state = { passo: "total_na_mesa", cesta: [] } as never;
  const plan = (text: string, said: string) => {
    const r = planActions({ actions: [{ type: "change_address", text: said }] } as never, state, { text });
    assert.ok(r.ok);
    return (r as { steps: { text: string }[] }).steps[0].text;
  };
  assert.equal(plan("trocar endereço", "Rua Funchal 418, Vila Olímpia, 04551-060"), "trocar endereço");
  assert.equal(plan("trocar endereço: Rua Funchal 418, 04551-060", "Rua Funchal 418, 04551-060"), "trocar endereço: Rua Funchal 418, 04551-060");
});
