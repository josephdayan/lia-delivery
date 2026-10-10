// Rodada 13, grupo G37 (10/10): achados da rodada 13, grupo B (/mnt/project-files/testes-whatsapp/rodada13/grupo-b.md,
// jornadas 304 a 308, repro 309/310). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "bom dia" + "dia dos professores amanhã ... uma caixa de bombom e um cartão até 50 reais" antes do cadastro: a IA
//      devolvia "caixa de bombom, cartão", o "cartão" virava forma de pagamento ("preciso do número do endereço") e o
//      pedido, o prazo e o teto sumiam;
//   2. "alpiste pra passarinho, 2 pacotes de alpiste" virava 3x (1 + 2) e cobrava a mais;
//   3. "cartão" respondendo "cartão de agradecimento ou vela?" era lido como pagamento; "esquece o chinelo, vou levar o
//      meu mesmo" avisava "*vou levar meu mesmo* não está na sua cesta"; "uns 70 reais" no fim da lista era ignorado;
//      "sábado de manhã" nunca era confirmado; "o de sempre" sem histórico só era respondido na 2ª vez.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import * as copy from "../src/lib/lia-copy";
import { detectIntent, isOrderWithDeadline, mergeShoppingLines, openQuestionPick, parseBasketLines, parseNeededBy, parseOrderBudget } from "../src/lib/lia-intents";
import { onboardingNote } from "../src/lib/address-parse";
import { resolveListItems } from "../src/lib/list-items";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5537${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, ...rest: unknown[]) => {
    outbox.push({ to, kind: key, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
    return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
  };
}

const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

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
  __clearLiveCheckCacheForTests();
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g37_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return phone;
}
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel }) as BasketItem;
const decision = (d: Partial<PreDecision>): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...d });

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: o cartão numa lista é item; sozinho, com bandeira, final ou 'no' continua pagamento", () => {
  for (const t of ["caixa de bombom, cartão", "cartão comemorativo", "cartão pra professora", "cartão do dia dos professores"]) {
    assert.equal(detectIntent(t).kind, "free_text", t);
  }
  for (const t of ["cartão", "no cartão", "cartão de crédito", "pode ser no cartão", "sim, no pix", "cartão, obrigado", "cartão final 4242", "cartão da minha mãe", "vou de cartão"]) {
    assert.equal(detectIntent(t).kind, "choose_payment", t);
  }
  // O "Anotei" do pré-cadastro guarda o cartão solto ao lado de outro produto (como cartão de presente); sozinho, não.
  assert.equal(onboardingNote("caixa de bombom, cartão").text, "caixa de bombom, cartão de presente");
  assert.equal(onboardingNote("cartão").text, "");
  assert.equal(onboardingNote("arroz, no pix").text, "arroz");
});

test("1b: teto no fim do presente ('uma caixa de bombom e um cartão até 50 reais') é do presente inteiro", () => {
  const said = "dia dos professores amanhã preciso de um presente pra professora do meu filho, uma caixa de bombom e um cartão ate 50 reais";
  const b = parseOrderBudget(said);
  assert.equal(b?.cap, 50, JSON.stringify(b));
  assert.equal(b?.total, true);
  assert.doesNotMatch(b!.rest, /50/);
  // Item único com teto continua teto do item; lista sem presente com "até" também.
  assert.equal(parseOrderBudget("presente pra minha mãe, um perfume até 100 reais"), null);
  assert.equal(parseOrderBudget("arroz e um feijão até 20 reais"), null);
  assert.equal(parseNeededBy(said)?.label, "amanhã");
});

test("1c: 'bom dia' e depois o pedido com 'cartão' antes do cadastro: anota tudo (prazo e teto) e busca depois do endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "bom dia");
  // O que a IA do pré-cadastro devolveu em produção.
  __setPreSignupModelForTests(async () => decision({ items: [{ query: "caixa de bombom", qty: 1, cheapest: false }, { query: "cartão", qty: 1, cheapest: false }] }));
  const out = await send(phone, "dia dos professores amanhã preciso de um presente pra professora do meu filho, uma caixa de bombom e um cartão ate 50 reais");
  __setPreSignupModelForTests(null);
  assert.doesNotMatch(out, /n[uú]mero\*? do seu endere[cç]o/i, out.slice(0, 500));
  assert.match(out, /caixa de bombom/i, out.slice(0, 500));
  assert.match(out, /cart[aã]o de presente/i, out.slice(0, 500));
  assert.match(out, /R\$ 50,00/, out.slice(0, 500));
  assert.match(out, /amanh[aã]/i, out.slice(0, 500));
  let ctx = await ctxOf(phone);
  assert.match(ctx.pendingRequest ?? "", /bombom/);
  assert.equal(ctx.orderBudget?.cap, 50);
  assert.equal(ctx.neededBy?.label, "amanhã");
  // Depois do endereço, o pedido guardado vira a busca (nunca "O que você precisa?").
  const after = await send(phone, ADDRESS_MSG);
  assert.doesNotMatch(after, /^✅ Anotado\. O que você precisa\?$/m, after.slice(0, 600));
  ctx = await ctxOf(phone);
  assert.ok(!ctx.pendingRequest, JSON.stringify(ctx.pendingRequest));
  assert.ok([...(ctx.pending ?? []).map((p) => p.query), ...(ctx.basket ?? []).map((b) => b.name), ...(ctx.listMisses ?? []).map((m) => m.query)].some((q) => /bombom/i.test(q)), after.slice(0, 600));
  assert.equal(ctx.orderBudget?.cap, 50);
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: o item citado de novo com a contagem diz quantos são (não soma 1 + 2); 'mais dois' continua somando", () => {
  const said = "ração pra peixe betta e alpiste pra passarinho, 2 pacotes de alpiste";
  const det = parseBasketLines(said);
  assert.deepEqual(det.map((l) => [l.qty, l.phrase]), [[1, "ração pra peixe betta"], [2, "alpiste pra passarinho"]]);
  assert.deepEqual(resolveListItems(said).map((l) => l.qty), [1, 2]);
  // Linhas da IA (como em produção: "alpiste passarinho" + "2 alpiste"): 2x, nunca 3x.
  const merged = mergeShoppingLines([{ phrase: "ração peixe betta", qty: 1 }, { phrase: "alpiste passarinho", qty: 1 }, { phrase: "alpiste", qty: 2 }], det);
  assert.deepEqual(merged.map((l) => [l.qty, l.phrase]), [[1, "ração peixe betta"], [2, "alpiste passarinho"]]);
  const det2 = parseBasketLines("ração pra peixe betta e alpiste pra passarinho, 2 pacotes de alpiste".replace(", 2 pacotes de alpiste", ""));
  assert.deepEqual(det2.map((l) => l.qty), [1, 1]);
  // Somas que continuam: "mais dois leites", "arroz, feijão, arroz".
  const leite = parseBasketLines("leite sem lactose; mais dois leites");
  assert.equal(leite[0].qty, 3);
  assert.equal(mergeShoppingLines([{ phrase: "leite sem lactose", qty: 1 }, { phrase: "leite", qty: 2 }], leite)[0].qty, 3);
  assert.deepEqual(parseBasketLines("arroz, feijão, arroz").map((l) => l.qty), [2, 1]);
  // Linha própria continua própria ("arroz 2kg, 1 arroz"; "molho de tomate e 4 tomates").
  assert.equal(parseBasketLines("arroz 2kg, 1 arroz").length, 2);
  assert.deepEqual(parseBasketLines("molho de tomate e 4 tomates").map((l) => l.qty), [1, 4]);
});

test("2b: lista com o alpiste repetido abre UMA escolha de alpiste, com 2", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({});
  await send(phone, "ração pra peixe betta e alpiste pra passarinho, 2 pacotes de alpiste");
  const ctx = await ctxOf(phone);
  const all = [...(ctx.pending ?? []).map((p) => ({ q: p.query, qty: p.qty })), ...(ctx.basket ?? []).map((b) => ({ q: b.name, qty: b.qty })), ...(ctx.listMisses ?? []).map((m) => ({ q: m.query, qty: 1 }))];
  const alpiste = all.filter((x) => /alpiste/i.test(x.q));
  assert.equal(alpiste.length, 1, JSON.stringify(all));
  assert.notEqual(alpiste[0].qty, 3, JSON.stringify(all));
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: a palavra que nomeia uma alternativa da pergunta 'A ou B?' é a resposta", () => {
  const q = "Você prefere um cartão de agradecimento ou uma vela?";
  assert.equal(openQuestionPick(q, "cartão"), "cartão de agradecimento");
  assert.equal(openQuestionPick(q, "a vela"), "vela");
  assert.equal(openQuestionPick(q, "prefiro o cartão"), "cartão de agradecimento");
  assert.equal(openQuestionPick(q, "pix"), null);
  assert.equal(openQuestionPick("Qual leite você quer: o integral ou o desnatado?", "desnatado"), "desnatado");
  assert.equal(openQuestionPick("Qual leite você quer?", "integral"), null);
});

test("3b: 'cartão' respondendo 'cartão de agradecimento ou vela?' busca o cartão — não abre o pagamento", async (t) => {
  if (!dbOk) return t.skip();
  const bombom = line("swift-6412", "Caixa de Bombom Lacta Favoritos 250,6g", 17.57, "swift", "Swift");
  const phone = await customerWith({ basket: [bombom], openQuestion: { text: "Você prefere um cartão de agradecimento ou uma vela?", at: Date.now(), said: "e um cartão de agradecimento ou vela, algo pequeno" } });
  const out = await send(phone, "cartão");
  assert.doesNotMatch(out, /como quer pagar|Pix ou cart[aã]o|Seu pedido/i, out.slice(0, 500));
  assert.match(out, /cart[aã]o de agradecimento/i, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.ok(!ctx.deliveryOrderId, "nenhum pedido aberto");
});

test("3c: 'esquece o chinelo, vou levar o meu mesmo' tira o chinelo sem 'não está na sua cesta' e sem pular o da tela", async (t) => {
  if (!dbOk) return t.skip();
  const chinelo = line("cobasi-chinelo", "Chinelo Havaianas Tradicional 39/40", 39.99, "americanas", "Americanas");
  const escova = line("drogal-5274", "Escova de Dente Sanifill Pocket", 6.59, "drogal", "Drogal");
  // Chinelo na CESTA.
  const phone = await customerWith({ basket: [escova, chinelo] });
  const out = await send(phone, "esquece o chinelo, vou levar o meu mesmo");
  assert.doesNotMatch(out, /n[aã]o est[aá] na sua cesta/i, out.slice(0, 400));
  assert.match(out, /Tirei/i, out.slice(0, 400));
  let ctx = await ctxOf(phone);
  assert.ok(!(ctx.basket ?? []).some((b) => /chinelo/i.test(b.name)), out.slice(0, 400));
  assert.ok((ctx.basket ?? []).some((b) => /escova/i.test(b.name)));
  // Chinelo na FILA, sabonete na tela: o sabonete continua em escolha.
  const sab = { sku: "mambo-1", name: "Sabonete Nivea 85g", unitPrice: 4.06, storeKey: "mambo", storeLabel: "Mambo" };
  const phone2 = await customerWith({ basket: [escova], pending: [{ query: "sabonete", qty: 1, options: [sab] }, { query: "chinelo", qty: 1, options: [{ ...chinelo }] }] }, "choosing");
  const out2 = await send(phone2, "esquece o chinelo, vou levar o meu mesmo");
  assert.doesNotMatch(out2, /n[aã]o est[aá] na sua cesta|Deixei \*?sabonete/i, out2.slice(0, 400));
  ctx = await ctxOf(phone2);
  assert.ok(!(ctx.pending ?? []).some((p) => /chinelo/.test(p.query)), out2.slice(0, 400));
  assert.ok((ctx.pending ?? []).some((p) => /sabonete/.test(p.query)), out2.slice(0, 400));
});

test("3d: 'uns 70 reais' no fim da lista é o orçamento do pedido", async (t) => {
  const said = "quero montar um lanche pos academia whey banana pasta de amendoim aveia iogurte grego e pao integral uns 70 reais";
  const b = parseOrderBudget(said);
  assert.equal(b?.cap, 70, JSON.stringify(b));
  assert.doesNotMatch(b!.rest, /70/);
  assert.equal(parseOrderBudget("whey, banana e aveia, uns 70 reais cada"), null);
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, said);
  assert.match(out, /R\$ 70,00/, out.slice(0, 500));
  assert.equal((await ctxOf(phone)).orderBudget?.cap, 70);
});

test("3e: 'sábado de manhã' junto da festa é prazo, anotado no pré-cadastro", async (t) => {
  const now = new Date("2026-10-10T12:00:00-03:00"); // sábado
  const said = "festa de aniverssario do meu sobrinho sabado de manhã, preciso de vela e guardanapo";
  assert.deepEqual(parseNeededBy(said, now), { date: "2026-10-17", label: "sábado", morning: true });
  assert.equal(parseNeededBy("pago no sábado", now), null);
  assert.equal(parseNeededBy("a festa é sexta", now)?.label, "sexta");
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, said);
  assert.match(out, /s[aá]bado de manh[aã]/i, out.slice(0, 500));
  assert.equal((await ctxOf(phone)).neededBy?.label, "sábado");
});

test("3f: 'me manda o de sempre' sem pedido nenhum, antes do cadastro, já diz que não há pedido pra repetir", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  // A IA do pré-cadastro lia como recomendação.
  __setPreSignupModelForTests(async () => decision({ recommend: true }));
  const out = await send(phone, "me manda o de sempre");
  __setPreSignupModelForTests(null);
  assert.ok(out.includes(copy.noPreviousOrder()), out.slice(0, 400));
  assert.match(out, /endere[cç]o/i, out.slice(0, 400));
});

test("3g: a sequência de escolhas cita o 4º item pelo nome (sem 'e mais 1')", () => {
  assert.equal(copy.choiceSequence(["desinfetante", "água sanitária", "escova sanitária", "papel higiênico"]), "Achei os 4 itens. Vamos um de cada vez: *desinfetante*, depois *água sanitária*, *escova sanitária* e *papel higiênico*.");
  assert.match(copy.choiceSequence(["a", "b", "c", "d", "e"]), /e mais 2 itens\.$/);
  assert.match(copy.choiceSequence(["a", "b"]), /depois \*b\*\.$/);
});

// 4 (reteste da rodada 13, grupo A, N2) ---------------------------------------------------------------------------------
test("4a: produto + prazo é pedido com prazo, nunca só a pergunta 'quando chega?'", () => {
  const said = "preciso de papel higiênico e 2 sabonetes de jasmim, a visita chega hoje";
  assert.equal(detectIntent(said).kind, "free_text");
  assert.equal(isOrderWithDeadline(said), true);
  for (const t of ["chega hoje?", "meu pedido chega hoje?", "quando chega?"]) assert.equal(detectIntent(t).kind, "status", t);
  assert.equal(onboardingNote(said).text, "papel higiênico, 2 sabonetes de jasmim");
  assert.equal(onboardingNote("bolo pra festa hoje, vela").text, "bolo pra festa hoje, vela");
});

test("4b: antes do cadastro, 'preciso de papel higiênico e 2 sabonetes de jasmim, a visita chega hoje' anota os itens e o prazo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "preciso de papel higiênico e 2 sabonetes de jasmim, a visita chega hoje");
  assert.match(out, /papel higi[eê]nico/i, out.slice(0, 500));
  assert.match(out, /2x sabonetes? de jasmim/i, out.slice(0, 500));
  assert.doesNotMatch(out, /visita chega/i, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.match(ctx.pendingRequest ?? "", /sabonete/);
  assert.equal(ctx.neededBy?.label, "hoje");
});
