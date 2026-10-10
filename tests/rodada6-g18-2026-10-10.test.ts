// Rodada 6, grupo G18 (10/10): oferta de troca de loja velha aceita por um "1" solto e trocando sabão de roupa por
// sabão de louça, "não, deixa o arroz" que tirava o arroz, quantidade "12 caixas" perdida, "tem mais barato?" que
// tirava a areia mais barata, troca/devolução sem resposta, "o que falta?" na apresentação genérica, "2" respondendo
// "A ou B?" lido como opção do carrossel, "ok" no cadastro como despedida, presente acima do orçamento de dois filhos
// e item sem entrega no endereço novo avisado só no fechamento.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { planActions } from "../src/lib/dialogue/plan";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { __setRepeatModelForTests, rewriteRepeated } from "../src/lib/dialogue/repeat";
import { asksBasketContents, asksReturnPolicy, detectIntent, openQuestionAlternative, parseKeepItem } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { productKindConflict } from "../src/lib/stores/types";
import { eligibleCandidates, giftRecipientCount } from "../src/lib/recommend/fallback";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";
import type { RecommendRequest, ShelfPlan } from "../src/lib/recommend/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5578${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
    return key === "sendDeliveryChoices" ? false : key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
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
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setRepeatModelForTests(null);
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
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g18_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const sig = (basket: BasketItem[]) => basket.map((i) => `${i.sku}:${i.qty}`).sort().join("|");

// ---------------------------------------------------------------- puros

test("A2: troca automática nunca muda o tipo (roupa × louça, pó × pasta, cachorro × gato)", () => {
  assert.equal(productKindConflict("Lava-Roupas Sabão em Pó Surf 5 em 1 Rosas 800g", "Lava-Louças Sabão em Pasta Urca 500g"), true);
  assert.equal(productKindConflict("Sabão em Pó Omo Lavagem Perfeita 800g", "Sabão em Barra Ypê 5 Unidades"), true);
  assert.equal(productKindConflict("Ração Golden Cães Adultos 15kg", "Ração Golden Gatos Castrados 10kg"), true);
  assert.equal(productKindConflict("Lava-Roupas Sabão em Pó Surf 800g", "Sabão em Pó Brilhante Roupas 800g"), false);
  assert.equal(productKindConflict("Arroz Camil 5kg", "Arroz Tio João 5kg"), false);
});

test("M1: pergunta de troca/devolução é reconhecida; troca de ITEM não é", () => {
  for (const t of ["e se o vestido não servir, posso trocar?", "e se eu quiser devolver tudo?", "dá pra devolver se não gostar?", "qual a política de troca?", "e se o caderno vier errado dá pra trocar?"]) {
    assert.equal(asksReturnPolicy(t), true, t);
  }
  assert.equal(detectIntent("e se o vestido não servir, posso trocar?").kind, "return_question");
  for (const t of ["posso trocar o arroz por feijão?", "troca o arroz por um mais barato", "quero meu dinheiro de volta", "tira o arroz"]) {
    assert.equal(asksReturnPolicy(t), false, t);
  }
  assert.equal(detectIntent("quero devolver tudo").kind, "refund_request");
});

test("A5: 'não, deixa o arroz' é manter; 'deixa o arroz de fora' / 'deixa só o arroz' não", () => {
  assert.equal(parseKeepItem("não, deixa o arroz"), "arroz");
  assert.equal(parseKeepItem("pode deixar o arroz mesmo"), "arroz");
  assert.equal(parseKeepItem("mantém o leite"), "leite");
  assert.equal(parseKeepItem("deixa o arroz de fora"), null);
  assert.equal(parseKeepItem("deixa só o arroz"), null);
  assert.equal(parseKeepItem("deixa pra lá"), null);
  assert.equal(parseKeepItem("arroz"), null);
});

test("M2: perguntas sobre a própria cesta", () => {
  assert.deepEqual(asksBasketContents("o que falta?"), {});
  assert.deepEqual(asksBasketContents("o que falta escolher?"), {});
  assert.deepEqual(asksBasketContents("o que eu já pedi?"), {});
  assert.deepEqual(asksBasketContents("quantas lampadas eu pedi?"), { item: "lampadas" });
  assert.equal(asksBasketContents("o que falta pro mínimo da loja e quanto custa o frete?"), null);
  assert.equal(asksBasketContents("arroz"), null);
});

test("M3: número responde à pergunta 'A ou B?' da Lia", () => {
  assert.equal(openQuestionAlternative("Qual lápis você quer trocar: o de cor ou o preto HB?", 2), "o preto HB");
  assert.equal(openQuestionAlternative("Qual lápis você quer trocar: o de cor ou o preto HB?", 1), "o de cor");
  assert.equal(openQuestionAlternative("Você quer o integral, o desnatado ou o semidesnatado?", 3), "o semidesnatado");
  assert.equal(openQuestionAlternative("Qual leite você quer?", 1), null);
  assert.equal(openQuestionAlternative("Qual lápis você quer trocar: o de cor ou o preto HB?", 3), null);
});

test("A6: contagem depois do produto com embalagem é quantidade; rolos do papel são o pacote", () => {
  const leite = resolveListItems("leite integral 12 caixas de 1 litro");
  assert.equal(leite.length, 1);
  assert.equal(leite[0].qty, 12);
  assert.match(leite[0].phrase, /leite integral 1 ?litro/);
  assert.equal(resolveListItems("macarrão espaguete 3 pacotes")[0].qty, 3);
  assert.equal(resolveListItems("papel higiênico 12 rolos")[0].qty, 1);
  assert.equal(resolveListItems("cerveja duas latas")[0].phrase, "cerveja lata");
});

test("A6: busca da IA sem quantidade herda o '12 caixas' da fala; remove com 'deixa o X' é recusado", () => {
  const ctx = { flow: "delivery", step: "collecting", basket: [bi("arroz-1", "Arroz Camil 5kg", 30)] } as DeliveryContext;
  const state = buildDialogueState(ctx, { hasAddress: true });
  const plan = planActions({ actions: [{ type: "search", query: "leite integral 1 litro", qty: 1 }] }, state, { text: "leite integral 12 caixas de 1 litro" });
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.steps[0].type === "search" ? plan.steps[0].lines : null, [{ query: "leite integral 1 litro", qty: 12 }]);
  const remove = planActions({ actions: [{ type: "remove", target: 1 }] }, state, { text: "não, deixa o arroz" });
  assert.equal(remove.ok, false);
});

test("M8: presente pra dois com orçamento total — cada um cabe na metade", () => {
  assert.equal(giftRecipientCount("dia das crianças, tenho 2 filhos, uns 150 reais no total"), 2);
  assert.equal(giftRecipientCount("presente pro menino e pra menina, 150 no total"), 2);
  assert.equal(giftRecipientCount("presente pros meus filhos, 100 reais cada"), 1);
  assert.equal(giftRecipientCount("presente pra minha mãe até 150"), 1);
  const request: RecommendRequest = { form: "need", need: "presente", text: "dia das crianças, 2 filhos, uns 150 reais no total", criteria: [], constraints: [], budget: 150, source: "regex" };
  const input = {
    request,
    plan: { picks: [], source: "table" } as ShelfPlan,
    candidates: [
      { shelfId: "produto", option: { sku: "jogo", name: "Jogo de Tabuleiro Interativo", unitPrice: 110, storeKey: "a" } },
      { shelfId: "produto", option: { sku: "carrinho", name: "Carrinho Hot Wheels Pista", unitPrice: 45, storeKey: "a" } }
    ]
  };
  assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["carrinho"]);
});

test("M9: reescrita anti-repetição nunca troca um pedido de dado por despedida", async () => {
  __setRepeatModelForTests(async () => "Combinado! Quando precisar é só chamar 💚");
  try {
    const said = "Pra eu te atender, me manda seu *endereço com CEP* — rua, número, bairro e cidade 📍";
    assert.equal(await rewriteRepeated({ customer: "ok", said, recent: [said] }), null);
  } finally {
    __setRepeatModelForTests(null);
  }
});

// ---------------------------------------------------------------- conversa (banco)

test("A2: oferta de troca de loja morre com outra fala no meio — o '1' depois não troca nada", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [bi("americanas-8761607", "Lava-Roupas Sabão em Pó Surf 5 em 1 Rosas e Flor-de-Lis 800g", 13), bi("mambo-805", "Arroz Parboilizado Tipo 1 Camil 5kg", 28, { storeKey: "mambo", storeLabel: "Mambo" })];
  const minSwap = { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: "americanas-8761607", qty: 1, option: opt("swift-urca", "Lava-Louças Sabão em Pasta Urca 500g", 10.8, "swift", "Swift") }] };
  const c = await customerWith({ basket, minSwap });
  await send(c.phone, "quanto deu tudo?");
  assert.equal((await ctxOf(c.convoId)).minSwap, undefined);
  const out = await send(c.phone, "1");
  assert.doesNotMatch(out, /Troquei de loja/i, out.slice(0, 300));
  assert.ok((await ctxOf(c.convoId)).basket?.some((b) => /Lava-Roupas/.test(b.name)));
});

test("A2: oferta de troca de loja com a cesta já mudada não é aceita pelo '1'", async (t) => {
  if (!dbOk) return t.skip();
  const old = [bi("americanas-8761607", "Lava-Roupas Sabão em Pó Surf 5 em 1 Rosas e Flor-de-Lis 800g", 13)];
  const basket = [...old, bi("mambo-805", "Arroz Parboilizado Tipo 1 Camil 5kg", 28, { storeKey: "mambo", storeLabel: "Mambo" })];
  const minSwap = { fromStoreKey: "americanas", key: sig(old), replacements: [{ fromSku: "americanas-8761607", qty: 1, option: opt("swift-urca", "Lava-Louças Sabão em Pasta Urca 500g", 10.8, "swift", "Swift") }] };
  const c = await customerWith({ basket, minSwap });
  const out = await send(c.phone, "1");
  assert.doesNotMatch(out, /Troquei de loja|Lava-Louças/i, out.slice(0, 300));
  assert.ok(!(await ctxOf(c.convoId)).basket?.some((b) => /Lava-Louças/.test(b.name)));
});

test("A5: 'não, deixa o arroz' mantém o arroz mesmo com a IA pedindo para tirar", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "remove", target: 1 }] }));
  const c = await customerWith({ basket: [bi("mambo-805", "Arroz Parboilizado Tipo 1 Camil 5kg", 28, { storeKey: "mambo", storeLabel: "Mambo", ask: "arroz 5kg" })] });
  const out = await send(c.phone, "não, deixa o arroz");
  assert.doesNotMatch(out, /Tirei/i, out);
  assert.match(out, /mantive/i);
  assert.equal((await ctxOf(c.convoId)).basket?.length, 1);
});

test("A6: 'tem mais barato?' com a mais barata já na cesta diz isso e não reabre a escolha", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("cobasi-203580", "Areia Pipicat Classic para Gatos 4 kg", 15, "cobasi", "Cobasi"), opt("cobasi-203572", "Areia para Gato Mitzi Granulado 4kg", 16, "cobasi", "Cobasi"), opt("cobasi-1203878", "Areia Biodegradável Cansei de Ser Gato 4 kg", 59, "cobasi", "Cobasi")];
  const c = await customerWith({
    basket: [bi("cobasi-203580", "Areia Pipicat Classic para Gatos 4 kg", 15, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "areia para gato 4kg" })],
    lastChoice: { query: "areia para gato 4kg", qty: 1, options, chosenSku: "cobasi-203580" }
  });
  const out = await send(c.phone, "tem mais barato?");
  assert.match(out, /já está o mais barato/i, out.slice(0, 300));
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.pending?.length ?? 0, 0);
  assert.equal(ctx.basket?.[0]?.sku, "cobasi-203580");
});

test("A6: troca 'areia para gato 4kg mais barata' nunca tira a areia sem pôr outra", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "swap", from: 1, to: "areia para gato 4kg mais barata" }] }));
  const c = await customerWith({ basket: [bi("g18-areia-barata", "Areia Higiênica para Gatos 4kg", 0.5, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "areia para gato 4kg" })] });
  const out = await send(c.phone, "tem mais barato? 4kg da areia ta 65 na farmacia");
  assert.doesNotMatch(out, /Tirei/i, out.slice(0, 300));
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.basket?.some((b) => /areia/i.test(b.name)), JSON.stringify(ctx.basket));
});

test("M1: 'e se não servir, posso trocar?' na escolha responde a política e mantém o carrossel", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [{ query: "vestido", qty: 1, options: [opt("v1", "Vestido Midi Floral", 89), opt("v2", "Vestido Longo Liso", 99)] }];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "e se o vestido não servir, posso trocar?");
  assert.match(out, /política da loja/i, out);
  assert.equal((await ctxOf(c.convoId)).pending?.length, 1);
  const both = await send(c.phone, "voces dao nota fiscal? e se o caderno vier errado dá pra trocar?");
  assert.match(both, /nota fiscal/i);
  assert.match(both, /política da loja/i, both);
});

test("M2: 'o que falta?' e 'quantos leites eu pedi?' respondem com a cesta e o que falta escolher", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      basket: [bi("l1", "Leite Integral Piracanjuba 1L", 6, { qty: 12, lineTotal: 72, ask: "leite integral" })],
      pending: [{ query: "lâmpada led", qty: 2, options: [opt("lp1", "Lâmpada LED 9W", 8), opt("lp2", "Lâmpada LED 12W", 10)] }]
    },
    "choosing"
  );
  const out = await send(c.phone, "o que falta?");
  assert.match(out, /Leite Integral/);
  assert.match(out, /Falta escolher: lâmpada led/i, out);
  const qty = await send(c.phone, "quantos leites eu pedi?");
  assert.match(qty, /12x Leite Integral/, qty);
});

test("M3: '2' respondendo 'o de cor ou o preto HB?' não põe a opção 2 do carrossel aberto na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [{ query: "borracha", qty: 1, options: [opt("b1", "Borracha Branca Mercur", 2), opt("b2", "Borracha Snoopy", 4)] }];
  const c = await customerWith(
    {
      basket: [bi("lc", "Lápis de Cor Faber-Castell 12 Cores", 20), bi("lp", "Lápis Preto HB Faber-Castell", 1.5)],
      pending,
      openQuestion: { text: "Qual lápis você quer trocar: o de cor ou o preto HB?", at: Date.now(), said: "esse lapis ta caro, ta mais barato na papelaria da esquina" }
    },
    "choosing"
  );
  await send(c.phone, "2");
  const ctx = await ctxOf(c.convoId);
  assert.ok(!ctx.basket?.some((b) => b.sku === "b2"), JSON.stringify(ctx.basket?.map((b) => b.name)));
});

test("M9: 'ok' logo depois do 'O que você quer?' não é despedida", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ lastSent: { texts: ["📍 Endereço salvo: Avenida Paulista 1000\n\nO que você quer?"], at: Date.now() } });
  const out = await send(c.phone, "ok");
  assert.doesNotMatch(out, /Qualquer coisa é só chamar|Quando precisar/i, out);
  assert.match(out, /o que você precisa/i);
});

test("M7: trocar para um endereço onde a loja não entrega avisa na hora e tira só aquele item", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("mambo-805", "Arroz Parboilizado Tipo 1 Camil 5kg", 28, { storeKey: "mambo", storeLabel: "Mambo" }),
      bi("americanas-8761607", "Lava-Roupas Sabão em Pó Surf 5 em 1 Rosas e Flor-de-Lis 800g", 13)
    ]
  });
  await send(c.phone, "trocar endereço");
  const out = await send(c.phone, "Rua Barão de Jaguara 1000, Centro, Campinas, 13015-001");
  assert.match(out, /não confirmou entrega de \*Arroz Parboilizado/i, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  assert.ok(!ctx.basket?.some((b) => b.storeKey === "mambo"));
});
