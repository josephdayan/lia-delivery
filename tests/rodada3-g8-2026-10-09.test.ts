// Rodada 3, grupo g8 (09/10): desfazer troca ("não, quero o nivea de antes") sem virar lista nova, "mais barato" que mantém
// subtipo/tamanho e só vale com economia real, "lego ou carrinho" como UM item com alternativa, negação de atributo
// ("sem cheiro") como filtro, aviso de loja pedida que não aparece e item pendente certo na pergunta de fechamento.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, sameSubtypeForCheaper, requestedStoreMissing, isUndoSwapText } from "../src/lib/delivery-service";
import { detectAlternativeItem, parseAltAnswer } from "../src/lib/alt-items";
import { keepNegation } from "../src/lib/dialogue/plan";
import { namesOtherItem } from "../src/lib/dialogue/execute";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

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

const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "carrefour"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel: storeKey });

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

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g8_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}

// 1) Desfazer a troca -------------------------------------------------------------------------------------
const protetor = bi("p-nivea", "Protetor Solar Facial Nivea Sun FPS 30 40ml", 40.69, { ask: "protetor solar fps 30" });
const fralda = bi("f-1", "Fralda Huggies Supreme Care P 28 Unidades", 39.9);
const racao = bi("r-1", "Ração Cachorro Golden 10kg", 99.9);
const swapState = () => ({
  basket: [fralda, racao],
  pending: [
    { query: "protetor solar fps 30", qty: 1, options: [opt("p-labial", "Protetor Solar Hidratante Labial Nivea Sun FPS 30 4,8g", 21.93)] },
    { query: "lâmpada led", qty: 1, options: [opt("l-1", "Lâmpada Led 9W", 9.9), opt("l-2", "Lâmpada Led 12W", 12.9)] }
  ],
  lastSwap: { removed: [protetor], to: "protetor solar fps 30", at: Date.now() }
});

for (const phrase of ["nao, quero o nivea de antes", "não, quero o Nivea de antes", "volta o anterior", "quero o de antes"]) {
  test(`'${phrase}' depois de uma troca desfaz a troca: nada de lista nova e a cesta mantém as escolhas`, async (t) => {
    if (!dbOk) return t.skip();
    const c = await customerWith(swapState(), "choosing");
    const out = await send(c.phone, phrase);
    assert.doesNotMatch(out, /lista nova|deixei de fora/i, out.slice(0, 400));
    assert.match(out, /desfiz a troca/i, out.slice(0, 400));
    const ctx = await ctxOf(c.convoId);
    const skus = (ctx.basket ?? []).map((b) => b.sku).sort();
    assert.ok(skus.includes("p-nivea"), "o protetor tirado voltou");
    assert.ok(skus.includes("f-1") && skus.includes("r-1"), "as outras escolhas ficaram");
    assert.ok(!(ctx.pending ?? []).some((p) => p.query === "protetor solar fps 30"), "a troca pendente saiu");
  });
}

test("desfazer a troca sem mais nada pendente volta direto pro total com o protetor original", async (t) => {
  if (!dbOk) return t.skip();
  const state = swapState();
  const c = await customerWith({ ...state, pending: [state.pending[0]] }, "choosing");
  const out = await send(c.phone, "volta o anterior");
  assert.doesNotMatch(out, /lista nova|deixei de fora/i, out.slice(0, 400));
  assert.match(out, /Nivea Sun FPS 30 40ml/i, out.slice(0, 600));
});

test("'nao, quero o dove' (outra marca, sem troca recente) com a cesta cheia não vira lista nova", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [fralda, racao] });
  const out = await send(c.phone, "nao, quero um sabonete dove");
  assert.doesNotMatch(out, /lista nova|deixei de fora/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).length >= 2, "a cesta não foi apagada");
});

test("isUndoSwapText: exige troca recente, cita o item tirado e não confunde endereço/pagamento", () => {
  const swap = { removed: [protetor], to: "protetor", at: Date.now() };
  assert.equal(isUndoSwapText("nao, quero o nivea de antes", swap), true);
  assert.equal(isUndoSwapText("volta o anterior", swap), true);
  assert.equal(isUndoSwapText("quero o dove de antes", swap), false, "marca que não é a tirada");
  assert.equal(isUndoSwapText("usa o endereço de antes", swap), false);
  assert.equal(isUndoSwapText("volta o anterior", { ...swap, at: Date.now() - 40 * 60_000 }), false, "troca antiga");
});

// 2) "Mais barato" mantém subtipo e tamanho, e só vale com economia real -------------------------------------------
test("sameSubtypeForCheaper: labial/aerossol não é o protetor solar facial", () => {
  const cur = "protetor solar facial nivea sun fps 30 40ml";
  assert.equal(sameSubtypeForCheaper(cur, "Protetor Solar Hidratante Labial Nivea Sun FPS 30 4,8g"), false);
  assert.equal(sameSubtypeForCheaper(cur, "Protetor Solar Aerossol Nivea Sun FPS 30 200ml"), false);
  assert.equal(sameSubtypeForCheaper(cur, "Protetor Solar Infantil Nivea Sun Kids FPS 30"), false);
  assert.equal(sameSubtypeForCheaper(cur, "Protetor Solar Facial Dauf FPS 30 40ml"), true);
});

test("'troca o protetor por um mais barato': labial de 4,8 g e aerossol quase igual não valem; mantém o atual", async (t) => {
  if (!dbOk) return t.skip();
  const cur = bi("cur-prot", "Protetor Solar Corporal Nivea Sun FPS 30 200ml", 35.19, { ask: "protetor solar fps 30", storeKey: "carrefour" });
  const c = await customerWith({ basket: [cur] });
  const out = await send(c.phone, "troca o protetor por um mais barato");
  assert.doesNotMatch(out, /labial|4,8 ?g/i, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  for (const b of (ctx.basket ?? [])) assert.doesNotMatch(b.name, /labial|4,8 ?g/i);
  for (const o of (ctx.pending?.[0]?.options ?? [])) assert.doesNotMatch(o.name, /labial|4,8 ?g/i);
  // ou trocou por um equivalente de tamanho comparável, ou manteve (e disse que é o melhor preço): nunca fica sem o protetor
  const names = [...(ctx.basket ?? []).map((b) => b.name), ...((ctx.pending ?? []).map((p) => p.query))].join(" ").toLowerCase();
  assert.match(names, /protetor/);
});

// 3) "X ou Y" é UM item com alternativa ------------------------------------------------------------------------------------
test("detectAlternativeItem: 'lego ou carrinho' é um item; atributos e listas continuam como antes", () => {
  const stores = ["Ri Happy"];
  const alt = detectAlternativeItem("preciso de um brinquedo da ri happy pra menino de 5 anos, lego ou carrinho", stores);
  assert.deepEqual(alt?.alternatives, ["lego", "carrinho"]);
  assert.doesNotMatch(alt?.base ?? "", /ri happy/i, "a loja não entra na busca");
  assert.deepEqual(detectAlternativeItem("lego ou carrinho")?.alternatives, ["lego", "carrinho"]);
  assert.equal(detectAlternativeItem("tenis preto ou branco"), null);
  assert.equal(detectAlternativeItem("ração 10kg ou 15kg"), null);
  assert.equal(detectAlternativeItem("fralda, pilha, lego ou carrinho"), null);
});

test("parseAltAnswer: 1, 2, 'o carrinho', 'os dois'; o resto não é resposta", () => {
  const alts: [string, string] = ["lego", "carrinho"];
  assert.equal(parseAltAnswer("1", alts), 0);
  assert.equal(parseAltAnswer("2", alts), 1);
  assert.equal(parseAltAnswer("o carrinho", alts), 1);
  assert.equal(parseAltAnswer("lego", alts), 0);
  assert.equal(parseAltAnswer("os dois", alts), "both");
  assert.equal(parseAltAnswer("quanto custa o frete", alts), null);
});

test("'lego ou carrinho': a Lia pergunta qual e '2' / 'o carrinho' escolhe, em vez de 'não entendi'", async (t) => {
  if (!dbOk) return t.skip();
  for (const answer of ["2", "o carrinho"]) {
    const c = await customerWith({});
    const q = await send(c.phone, "preciso de um brinquedo da ri happy pra menino de 5 anos, lego ou carrinho");
    assert.match(q, /\*lego\* ou \*carrinho\*/i, q.slice(0, 400));
    assert.ok((await ctxOf(c.convoId)).askEither, "guardou a pergunta");
    const out = await send(c.phone, answer);
    assert.doesNotMatch(out, /não entendi|cesta está vazia|Não achei \*?brinquedo.*lego/i, out.slice(0, 500));
    const ctx = await ctxOf(c.convoId);
    assert.equal(ctx.askEither, undefined, "a pergunta foi respondida");
    const seen = JSON.stringify({ pending: ctx.pending, basket: ctx.basket, out }).toLowerCase();
    assert.doesNotMatch(seen, /ri happy/, "a loja não virou termo de busca");
  }
});

// 4) Negação de atributo é filtro ---------------------------------------------------------------------------------------------
test("keepNegation: 'sem cheiro' volta pra frase da IA que deixou só 'cheiro'", () => {
  assert.equal(keepNegation("troca a areia por uma sem cheiro de 4kg", "areia higiênica para gato cheiro 4kg"), "areia higiênica para gato sem cheiro 4kg");
  assert.equal(keepNegation("areia sem perfume", "perfume"), "sem perfume");
  assert.equal(keepNegation("leite sem lactose", "leite sem lactose"), "leite sem lactose", "já está certo");
  assert.equal(keepNegation("quero cafe sem acucar", "café açúcar"), "café açúcar sem acucar");
  assert.equal(keepNegation("quero areia", "areia"), "areia");
});

test("'troca a areia por uma sem cheiro de 4kg' (caminho sem IA): a busca leva o 'sem cheiro', nunca 'cheiro' solto", async (t) => {
  if (!dbOk) return t.skip();
  const areia = bi("a-1", "Areia Higiênica Kets para Gatos 4kg", 29.9, { ask: "areia higiênica para gato 4kg" });
  const c = await customerWith({ basket: [areia] });
  const out = await send(c.phone, "troca a areia por uma sem cheiro de 4kg");
  assert.doesNotMatch(out, /Não achei \*areia[^*]*(?<!sem )cheiro/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  const queries = [...(ctx.pending ?? []).map((p) => p.query), out].join(" ");
  assert.doesNotMatch(queries, /(?<!sem )\bcheiro\b/i, queries.slice(0, 400));
});

// 5) Loja pedida que não aparece ---------------------------------------------------------------------------------------------
test("requestedStoreMissing: pediu Kopenhagen e as opções são de outras lojas → avisa uma vez", () => {
  const choice = { query: "chocolate presente", qty: 1, options: [opt("x1", "Ferrero Rocher 8un", 36.29, "americanas"), opt("x2", "Lindt Lindor", 16.49, "americanas")] };
  assert.match(requestedStoreMissing("queria um chocolate kopenhagen pra dar de presente", choice) ?? "", /Kopenhagen/);
  assert.equal(requestedStoreMissing("queria um chocolate pra dar de presente", choice), null, "não pediu loja");
  const withStore = { ...choice, options: [...choice.options, opt("x3", "Caixa Kopenhagen", 90, "kopenhagen")] };
  assert.equal(requestedStoreMissing("chocolate kopenhagen", withStore), null, "a loja pedida aparece");
  assert.equal(requestedStoreMissing("chocolate kopenhagen", { ...choice, storeNoted: true }), null, "avisa uma vez só");
});

// 6) Pergunta de fechamento cita o item pendente ---------------------------------------------------------------------------
test("namesOtherItem: pergunta que cita 'opções de lâmpada' com a ração na tela é trocada", () => {
  const ctx = { basket: [bi("l-1", "Lâmpada Led 9W Branca E27", 12)], pending: [{ query: "ração gato", qty: 1, options: [] }] } as unknown as DeliveryContext;
  assert.equal(namesOtherItem("Você quer dizer que é só isso mesmo ou quer escolher uma das opções de lâmpada?", "ração gato", ctx), true);
  assert.equal(namesOtherItem("Você quer dizer que é só isso mesmo ou quer escolher uma das opções de ração?", "ração gato", ctx), false);
  assert.equal(namesOtherItem("Qual lâmpada você prefere?", "ração gato", ctx), false, "não é pergunta de opções");
});
