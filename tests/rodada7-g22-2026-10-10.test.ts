// Rodada 7, grupo G22 (10/10): remédio no meio de lista longa (a IA do diálogo recusava a mensagem inteira), "só o
// cartão, sem vela" com a vela na tela, "deixa a fralda como estava", fragmentos que viravam item ("pra minha gata",
// "a normal sem receita"), item já escolhido reenviado, "sim" a uma pergunta da Lia, "quantas lâmpadas eu pedi?", "ok"
// no cadastro, correção com asterisco, opções vencidas, "pula essa", "1" com os botões do pedido mínimo, "Pra seus filhos".
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { isDescriptorFragment, openQuestionYes, parseKeepItem } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { listHasNonMedicineItem, planActions } from "../src/lib/dialogue/plan";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { dialogueBypassReason } from "../src/lib/dialogue";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5579${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
const DIPIRONA_LIST = "preciso de dipirona, band-aid, protetor solar fps 50, um shampoo anticaspa, e tambem leite, pão de forma e uma ração pra gato";
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

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting", userExtra: Record<string, unknown> = {}): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", ...userExtra } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g22_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "carrefour", storeLabel = "Carrefour") => ({ sku, name, unitPrice, storeKey, storeLabel });
const line = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", ...extra }) as BasketItem;

// 1) Remédio no meio de lista longa: a IA do diálogo devolvia "medicine" e os outros 6 itens sumiam ------------------
test("plano da IA: 'medicine' para lista com outros itens cai no caminho determinístico (texto literal da rodada 7)", () => {
  const state = buildDialogueState({ flow: "delivery", step: "collecting" } as DeliveryContext, { hasAddress: true });
  const plan = planActions({ actions: [{ type: "medicine" }] } as never, state, { text: DIPIRONA_LIST });
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.reason, "remedio_no_meio_da_lista");
  assert.equal(listHasNonMedicineItem(DIPIRONA_LIST), true);
  // Só remédio: a recusa da IA continua valendo.
  assert.equal(planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "quero dipirona" }).ok, true);
  assert.equal(listHasNonMedicineItem("dipirona e paracetamol"), false);
  // Com o remédio isento ligado, a recusa da IA para dipirona "sem receita" também não vale; receita nomeada, sim.
  const prev = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const otc = planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "dipirona 500mg gotas, a normal sem receita" });
    assert.equal(!otc.ok && otc.reason, "remedio_isento");
    assert.equal(planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "quero rivotril" }).ok, true);
  } finally {
    if (prev === undefined) delete process.env.LIA_MEDICINE_MIP;
    else process.env.LIA_MEDICINE_MIP = prev;
  }
});

test("lista literal com dipirona: o remédio sai com aviso curto e os outros itens seguem", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const out = await send(c.phone, DIPIRONA_LIST);
  assert.doesNotMatch(out, /Me diz o nome do que você precisa|O que você precisa\?$/, out.slice(0, 500));
  assert.match(out, /band-aid|protetor|shampoo|leite|ração/i, out.slice(0, 500));
});

// 2) "só o cartão, sem vela" com a vela NA TELA; "deixa a fralda como estava" -------------------------------------------
test("'so o cartao, sem vela' com a vela na tela e sem cartão na lista: tira a vela e não busca 'cartão'", async (t) => {
  if (!dbOk) return t.skip();
  const sab = line("g22-sab", "Sabonete Dove 90g", 4.5, { qty: 2, lineTotal: 9 });
  const pending = [{ query: "vela", qty: 1, options: [opt("g22-v1", "Vela Branca 6un", 9.9), opt("g22-v2", "Vela Aromática", 19.9)] }];
  const c = await customerWith({ basket: [sab], pending }, "choosing");
  const out = await send(c.phone, "so o cartao, sem vela");
  assert.match(out, /Tirei \*?vela/i, out.slice(0, 500));
  assert.doesNotMatch(out, /Não achei|não achei/, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.pending ?? []).length, 0, JSON.stringify(ctx.pending));
  assert.equal(ctx.basket?.[0]?.sku, "g22-sab");
});

test("'deixa a fralda como estava': é manter (parseKeepItem) e recusa a pergunta de mais barato", async (t) => {
  assert.equal(parseKeepItem("deixa a fralda como estava"), "fralda");
  assert.equal(parseKeepItem("deixa o arroz do jeito que estava"), "arroz");
  if (!dbOk) return t.skip();
  const fralda = line("g22-fr", "Fralda Pampers Confort Sec M 40un", 59.9, { ask: "fralda pampers M" });
  const protetor = line("g22-pr", "Protetor Solar Sundown FPS 50 200ml", 49.9, { ask: "protetor solar" });
  const c = await customerWith({ basket: [fralda, protetor], cheaperAsk: { at: Date.now() } });
  const out = await send(c.phone, "deixa a fralda como estava");
  assert.doesNotMatch(out, /mais barato que achei|Troquei/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), ["g22-fr", "g22-pr"]);
});

// 3) Fragmentos e item reenviado --------------------------------------------------------------------------------------
test("fragmentos de contexto não viram item: 'pra minha gata' herda a ração, '10kg cada' é tamanho, 'a normal sem receita' some", () => {
  const pets = resolveListItems("quero ração pro meu cachorro e outra pra minha gata, 10kg cada").map((l) => l.phrase);
  assert.equal(pets.length, 2, JSON.stringify(pets));
  assert.match(pets[0], /^ração .*cachorro.*10kg/);
  assert.match(pets[1], /^ração .*gata.*10kg/);
  assert.deepEqual(resolveListItems("dipirona 500mg gotas, a normal sem receita").map((l) => l.phrase), ["dipirona 500mg gotas"]);
  assert.equal(isDescriptorFragment("pra minha gata"), true);
  assert.equal(isDescriptorFragment("a normal sem receita"), true);
  assert.equal(isDescriptorFragment("ração pra minha gata"), false);
  // "leite integral, a normal" continua com 2 itens (pode ser outro leite).
  assert.equal(resolveListItems("leite integral, a normal").length, 2);
});

test("ração já escolhida mandada de novo com outro carrossel aberto: diz que já está na cesta, sem pendência duplicada", async (t) => {
  if (!dbOk) return t.skip();
  const racao = line("g22-rc", "Ração Golden Cães Adultos Raças Grandes Labrador 15kg", 189.9, { ask: "ração cachorro labrador adulto 15kg" });
  const pending = [{ query: "areia para gato", qty: 1, options: [opt("g22-a1", "Areia Higiênica Pipicat 4kg", 17.59), opt("g22-a2", "Areia Sanitária Viva Verde 4kg", 29.9)] }];
  const c = await customerWith({ basket: [racao], pending }, "choosing");
  const out = await send(c.phone, "racao para cachorro labrador adulto 15kg");
  assert.match(out, /já está na cesta/, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["areia para gato"]);
});

// 5) "sim" a uma pergunta da Lia, "quantas lâmpadas", "ok" no cadastro, asterisco -------------------------------------
test("openQuestionYes: pergunta de sim/não vira o pedido; com alternativas, não", () => {
  assert.equal(openQuestionYes("Você quer trocar a areia escolhida por outra mais barata?"), "troca a areia escolhida por outra mais barata");
  assert.equal(openQuestionYes("Você quer que eu procure um lápis mais barato?"), "procura um lapis mais barato");
  assert.equal(openQuestionYes("Você quer a areia ou o petisco?"), null);
  assert.equal(openQuestionYes("Qual leite você quer?"), null);
});

test("'sim' à pergunta da Lia com outro carrossel aberto: não cai em 'Não peguei qual você quer'", async (t) => {
  if (!dbOk) return t.skip();
  const areia = line("g22-ar", "Areia Higiênica Pipicat Classic 4kg", 17.59, { ask: "areia para gato 4kg" });
  const pending = [{ query: "petisco para cachorro", qty: 1, options: [opt("g22-p1", "Petisco Dog Bifinho 65g", 6.9), opt("g22-p2", "Petisco Keldog 500g", 24.9)] }];
  const c = await customerWith({ basket: [areia], pending, openQuestion: { text: "Você quer trocar a areia escolhida por outra mais barata?", at: Date.now() } }, "choosing");
  const out = await send(c.phone, "sim");
  assert.doesNotMatch(out, /Não peguei qual você quer/, out.slice(0, 500));
  assert.match(out, /areia/i, out.slice(0, 500));
});

test("'quantas lâmpadas eu pedi?' com as lâmpadas ainda em escolha: diz a quantidade pedida", async (t) => {
  assert.match(copy.basketQtyAnswer([{ qty: 3, name: "lâmpada LED", pending: true }], "lampadas"), /3x lâmpada LED.*falta só escolher/);
  if (!dbOk) return t.skip();
  const pending = [{ query: "lâmpada LED", qty: 3, qtyExplicit: true, options: [opt("g22-l1", "Lâmpada LED 9W Bivolt", 8.9), opt("g22-l2", "Lâmpada LED 12W", 12.9)] }];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "quantas lampadas eu pedi?");
  assert.match(out, /3x lâmpada LED/, out.slice(0, 400));
});

test("'ok' no pedido de nome + CPF do cadastro: pede de novo em vez de 'Imagina!'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ cpfOnboarding: true }, "need_cpf");
  const out = await send(c.phone, "ok");
  assert.doesNotMatch(out, /Imagina/, out);
  assert.match(out, /nome completo.*CPF/i, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.step, "need_cpf");
});

test("correção com asterisco com escolha aberta não vai para a IA; o '*' nunca fica no nome do item", () => {
  const ctx = { flow: "delivery", step: "choosing", pending: [{ query: "leite", qty: 12, options: [opt("x", "Leite 1L", 5)] }] } as unknown as DeliveryContext;
  assert.equal(dialogueBypassReason({ text: "*caixinhas de 1 litro, longa vida", intent: { kind: "free_text" }, ctx, hasAddress: true, looksLikeList: true }), "correcao_asterisco");
  assert.deepEqual(resolveListItems("*arroz 5kg").map((l) => l.phrase), ["arroz 5kg"]);
  assert.ok(resolveListItems("*caixinhas de 1 litro, longa vida").every((l) => !l.phrase.includes("*")));
});

// 6) Opções vencidas, "pula essa", "1" com botões do mínimo, "seus filhos" ---------------------------------------------
test("conversa parada 40 min com opções na tela: 'o primeiro' diz o que expirou; 'sim' procura de novo", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [{ query: "café", qty: 1, options: [opt("g22-c1", "Café Pilão 500g", 19.9), opt("g22-c2", "Café Melitta 500g", 21.9)] }];
  const c = await customerWith({ pending, pendingSince: Date.now() - 40 * 60_000 }, "choosing");
  await prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "café", createdAt: new Date(Date.now() - 40 * 60_000) } });
  const out = await send(c.phone, "o primeiro");
  assert.match(out, /\*café\*.*expiraram/, out.slice(0, 400));
  assert.doesNotMatch(out, /de quê/i);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.expiredCart?.noticed, true);
});

test("'tira o leite, pula essa': tira o leite sem dizer que '*pula*' não está na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [
    { query: "leite", qty: 1, options: [opt("g22-le1", "Leite Integral Italac 1L", 5.9), opt("g22-le2", "Leite Integral Piracanjuba 1L", 6.4)] },
    { query: "pão de forma", qty: 1, options: [opt("g22-pf1", "Pão de Forma Wickbold 500g", 9.9), opt("g22-pf2", "Pão de Forma Pullman 480g", 10.9)] }
  ];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "tira o leite, pula essa");
  assert.doesNotMatch(out, /\*pula\* não está/, out.slice(0, 400));
  assert.match(out, /Tirei leite/i, out.slice(0, 400));
  assert.doesNotMatch(out, /Não peguei/, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["pão de forma"]);
});

test("'1' com os botões do pedido mínimo na tela é o botão 'tirar', não 1x do último item", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [
    line("americanas-9", "Detergente Líquido Limpol Neutro 500ml", 2.9),
    line("mambo-1", "Arroz Polido Tipo 1 Tio João 1kg", 7.6, { storeKey: "mambo", storeLabel: "Mambo" })
  ];
  const c = await customerWith({ basket, minimumButtonsAt: Date.now(), lastChoice: { query: "arroz", chosenSku: "mambo-1", at: Date.now() } });
  const out = await send(c.phone, "1");
  assert.match(out, /Tirei Detergente/i, out.slice(0, 400));
  assert.doesNotMatch(out, /✅ 1x/);
});

test("presente pra dois filhos: 'seus filhos', nunca 'seu filhos'", () => {
  const req = (recipient: string) => ({ form: "need" as const, need: "presente", recipient, criteria: [] });
  assert.match(copy.recommendIntro(req("filhos")), /Pra seus filhos/);
  assert.match(copy.recommendIntro(req("minhas filhas")), /Pra suas filhas/);
  assert.match(copy.recommendIntro(req("mãe")), /Pra sua mãe/);
  assert.match(copy.recommendIntro(req("cachorro")), /Pra seu cachorro/);
});
