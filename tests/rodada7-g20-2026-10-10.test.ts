// Rodada 7, grupo G20 (10/10): aceite da troca de loja do pedido mínimo por texto ("sim, pode trocar", "pode trocar de
// loja") mesmo com carrossel aberto, troca só para o que a loja entrega no CEP, laço "Responde o número" sem saída,
// "não achei" lembrado no resumo final, turno superado sem resposta, "10kg de qualquer marca" sem termo duplicado e
// "o mais barato de tudo" valendo para o pedido inteiro com aviso de entrega extra/prazo.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, mergeQueryTerms, opsPublishManualQuote } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { acceptsSwapOffer, declinesSwapOffer, detectIntent, stripIndifference, wantsCheapestForAll } from "../src/lib/lia-intents";
import { leftOutForSummary } from "../src/lib/list-misses";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5579${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g20_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas", extra: Partial<ChoiceOption> = {}): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel, ...extra });
const sig = (basket: BasketItem[]) => basket.map((i) => `${i.sku}:${i.qty}`).sort().join("|");
const pend = (query: string, options: ChoiceOption[], extra: Partial<PendingChoice> = {}): PendingChoice => ({ query, qty: 1, options, ...extra }) as PendingChoice;

// ---------------------------------------------------------------- puros

test("A1/A2: aceite e recusa da troca por texto, com as frases reais; troca de ITEM não é aceite", () => {
  for (const t of ["sim, pode trocar", "pode trocar de loja", "sim, troca pela outra loja", "trocar de loja", "Trocar de loja", "aceito a troca", "pode trocar"]) {
    assert.equal(acceptsSwapOffer(t), true, t);
  }
  for (const t of ["troca o arroz pelo feijão", "trocar o rodo", "pode trocar pelo mais barato", "tira o caderno", "sim"]) {
    assert.equal(acceptsSwapOffer(t), false, t);
  }
  for (const t of ["mantém como está", "não troca", "deixa assim", "nao precisa trocar"]) assert.equal(declinesSwapOffer(t), true, t);
  assert.equal(declinesSwapOffer("não, quero manteiga"), false);
});

test("A5: 'qualquer marca' é filtro e a frase de busca nunca repete termo", () => {
  assert.equal(stripIndifference("10kg de qualquer marca"), "10kg");
  const base = "ração cachorro filhote 10kg";
  assert.deepEqual(mergeQueryTerms(base, "10kg de qualquer marca").fresh, []);
  assert.deepEqual(mergeQueryTerms(base, "ração filhote 10kg").fresh, []);
  assert.deepEqual(mergeQueryTerms(base, "10 kg").fresh, []);
  assert.equal(mergeQueryTerms("leite", "sem lactose").query, "leite sem lactose");
  assert.equal(mergeQueryTerms(base, "golden 10kg").query, "ração cachorro filhote 10kg golden");
});

test("A2: 'Não peguei qual você quer' sempre dá a saída", () => {
  assert.match(copy.choiceNotUnderstood(), /pula/);
  assert.match(copy.noMoreOptionsAskReword("caderno pequeno"), /pula/);
});

test("A4: o que não foi achado volta no resumo final; o que entrou depois na cesta não", () => {
  const now = Date.now();
  const ctx = { listMisses: [{ query: "gelo", qty: 1, reason: "not_found" as const, at: now - 25 * 60_000 }, { query: "shampoo pet", qty: 1, reason: "not_found" as const, at: now }] };
  assert.deepEqual(leftOutForSummary(ctx, [{ name: "Carvão Vegetal 3kg", ask: "carvão" }, { name: "Shampoo Pet Clean Cães 500ml" }], now), ["gelo"]);
  const text = copy.manualQuoteSummary({ items: [{ qty: 1, name: "Carvão Vegetal 3kg" }], produtos: 20, frete: 5, total: 25, leftOut: ["gelo"] });
  assert.match(text, /Ficou de fora \(não achei\): \*gelo\*/);
});

test("M4: 'QUERO O MAIS BARATO DE TUDO' é para o pedido inteiro", () => {
  for (const t of ["QUERO O MAIS BARATO DE TUDO", "o mais barato de tudo", "pode ser o mais barato pra todos"]) assert.equal(wantsCheapestForAll(t), true, t);
  assert.equal(wantsCheapestForAll("quero o mais barato"), false);
  // Com a IA ligada, o roteador (que escolhe o de cada item) decide — não a IA, que escolhia só o da vez.
  const text = "QUERO O MAIS BARATO DE TUDO";
  const ctx = { step: "choosing", pending: [pend("arroz", [opt("a", "Arroz", 20)]), pend("feijão", [opt("b", "Feijão", 8)])] } as DeliveryContext;
  assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false }), "intent:cheapest_all");
});

// ---------------------------------------------------------------- conversa (banco)

const desinf = bi("americanas-2521453", "Desinfetante Antibacteriano Veja Banheiro Power Oxi Ativo Líquido Squeeze 500ml", 13.19, { ask: "desinfetante Veja Gold Max Ultra Zeta" });
const rodo = bi("telhanorte-1", "Rodo 40Cm Com Cabo Alklin", 24.09, { storeKey: "telhanorte", storeLabel: "Telhanorte", ask: "rodo" });
const veja = opt("mambo-veja", "Desinfetante Multisuperficies Veja Power Action Pinho 1L", 16.48, "mambo", "Mambo");

test("A1: 'sim, pode trocar' aplica a troca oferecida no desinfetante — o rodo fica", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [desinf, rodo];
  const c = await customerWith({ basket, minSwap: { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: desinf.sku, qty: 1, option: veja }] } });
  const out = await send(c.phone, "sim, pode trocar");
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.basket?.some((b) => b.sku === veja.sku), out.slice(0, 400));
  assert.ok(ctx.basket?.some((b) => b.sku === rodo.sku), out.slice(0, 400));
  assert.ok(!ctx.basket?.some((b) => b.sku === desinf.sku), out.slice(0, 400));
  assert.equal(ctx.minSwap, undefined);
});

test("A1: 'mantém como está' recusa a oferta (não repete a mesma oferta)", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [desinf, rodo];
  const c = await customerWith({ basket, minSwap: { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: desinf.sku, qty: 1, option: veja }] } });
  const out = await send(c.phone, "mantém como está");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.minSwap, undefined);
  assert.ok(ctx.basket?.some((b) => b.sku === desinf.sku));
  assert.match(out, /pedido mínimo/i, out.slice(0, 400));
});

test("A2: com o carrossel do caderno aberto, 'pode trocar de loja' aceita a oferta em vez de 'Responde o número'", async (t) => {
  if (!dbOk) return t.skip();
  const caderno = bi("americanas-cad", "Caderno Pequeno Brochura 48 Folhas Tilibra", 12.5, { ask: "caderno pequeno" });
  const bombom = bi("mambo-bom", "Bombom Sonho de Valsa 251g", 22, { storeKey: "mambo", storeLabel: "Mambo", ask: "bombom" });
  const basket = [bombom, caderno];
  const alt = opt("cea-cad", "Caderno Pequeno Capa Dura 80 Folhas", 18.68, "cea", "C&A");
  const c = await customerWith(
    {
      basket,
      minSwap: { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: caderno.sku, qty: 1, option: alt }] },
      pending: [pend("caderno pequeno", [opt("cea-cad", "Caderno Pequeno Capa Dura 80 Folhas", 18.68, "cea", "C&A"), opt("lc-cad", "Caderno Pequeno Espiral 96 Folhas", 21.9, "livrariascuritiba", "Livrarias Curitiba")])]
    },
    "choosing"
  );
  const out = await send(c.phone, "pode trocar de loja");
  assert.doesNotMatch(out, /Responde o número|já mostrei tudo/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.basket?.some((b) => b.sku === alt.sku), out.slice(0, 400));
  assert.ok(!ctx.basket?.some((b) => b.sku === caderno.sku));
});

// A troca só para loja que entrega no CEP (A1) está em tests/minimum-swap.test.ts (precisa da Pague Menos ligada no import).

const filhote3kg = opt("cobasi-853755", "Ração GranPlus Menu Cães Filhotes Carne e Arroz 3 kg", 66.9, "cobasi", "Cobasi");

test("A5: 'essa de 3kg não serve, quero 10kg de qualquer marca' diz que não tem 10 kg — sem 'qualquer marca' na busca", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [pend("ração cachorro filhote 10kg", [filhote3kg], { closestFalta: "é de 3 kg" })] }, "choosing");
  const out = await send(c.phone, "essa de 3kg não serve, quero 10kg de qualquer marca");
  assert.doesNotMatch(out, /qualquer marca/i, out.slice(0, 400));
  assert.match(out, /Não tenho \*ração cachorro filhote 10kg\*[\s\S]*mais perto que tenho é de 3 kg[\s\S]*pula/, out.slice(0, 400));
});

test("A5: refino da IA com o termo que a busca já tem ('ração filhote 10kg') nunca vira 'filhote 10kg filhote 10kg'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "filhote 10kg" }] }));
  const c = await customerWith({ pending: [pend("ração cachorro filhote 10kg", [filhote3kg], { closestFalta: "é de 3 kg" })] }, "choosing");
  const out = await send(c.phone, "ração filhote 10kg");
  assert.doesNotMatch(out, /10kg (?:filhote )?10kg/i, out.slice(0, 400));
  assert.match(out, /Não tenho \*ração cachorro filhote 10kg\*/, out.slice(0, 400));
});

test("A4: 'tira o gelo' com o gelo entre os não achados diz que ele já estava de fora e some das faltantes", async (t) => {
  if (!dbOk) return t.skip();
  const carvao = bi("mambo-carvao", "Carvão Vegetal 3kg", 19.9, { storeKey: "mambo", storeLabel: "Mambo", ask: "carvão" });
  const c = await customerWith({ basket: [carvao], listMisses: [{ query: "gelo", qty: 1, reason: "not_found", at: Date.now() }] });
  const out = await send(c.phone, "tira o gelo");
  assert.match(out, /\*gelo\* já tinha ficado de fora/, out.slice(0, 300));
  const ctx = await ctxOf(c.convoId);
  assert.ok(!(ctx.listMisses ?? []).some((m) => m.query === "gelo"));
  assert.equal(ctx.basket?.length, 1);
});

test("A4: o resumo final publicado lembra o que ficou de fora", async (t) => {
  if (!dbOk) return t.skip();
  const carvao = bi("mambo-carvao", "Carvão Vegetal 3kg", 19.9, { storeKey: "mambo", storeLabel: "Mambo", ask: "carvão" });
  const c = await customerWith({ basket: [carvao], listMisses: [{ query: "gelo", qty: 1, reason: "not_found", at: Date.now() - 30 * 60_000 }] }, "awaiting_operator_quote");
  const order = await prisma.deliveryOrder.create({
    data: { userId: c.userId, phone: c.phone, conversationId: c.convoId, status: "awaiting_operator_quote", items: [carvao] as unknown as object, cep: "01310-100", deliveryAddress: ADDRESS, storeKey: "concierge", storeLabel: "Lia" }
  });
  const ctx0 = await ctxOf(c.convoId);
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx0, deliveryOrderId: order.id }) } });
  const start = outbox.length;
  await opsPublishManualQuote(order.id, { itemsSubtotal: 19.9, deliveryFee: 8.9, deliveryMode: "retailer_delivery" });
  const out = outbox.slice(start).filter((m) => m.to === c.phone).map((m) => m.text).join("\n");
  assert.match(out, /Ficou de fora \(não achei\): \*gelo\*/, out.slice(0, 600));
});

test("A4: turno superado por uma escrita de fora, sem mensagem mais nova, ainda responde", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  const carvao = bi("mambo-carvao", "Carvão Vegetal 3kg", 19.9, { storeKey: "mambo", storeLabel: "Mambo", ask: "carvão" });
  const c = await customerWith({ basket: [carvao] });
  let calls = 0;
  __setDialogueModelForTests(async () => {
    // 1ª chamada: algo de FORA do turno grava o contexto (o /ops, o vigia do pedido) — o CAS deste turno falha.
    if (++calls === 1) {
      const ctx = await ctxOf(c.convoId);
      await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx, lastSent: undefined, touchedBy: "ops" }) } });
    }
    return { actions: [{ type: "answer", topic: "delivery_fee" }] };
  });
  const out = await send(c.phone, "quanto ta ficando até agora?");
  assert.ok(out.trim().length > 0, "turno sem resposta");
});

test("M4: 'QUERO O MAIS BARATO DE TUDO' escolhe o mais barato de cada item e avisa a entrega extra e o prazo", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = [opt("mambo-a1", "Arroz Branco Tio João 5kg", 32, "mambo", "Mambo", { delivery: "prazo da loja: 3h" }), opt("mambo-a2", "Arroz Branco Camil 5kg", 27, "mambo", "Mambo", { delivery: "prazo da loja: 3h" })];
  const cafe = [opt("mambo-c1", "Café Melitta Tradicional 500g", 24, "mambo", "Mambo", { delivery: "prazo da loja: 3h" }), opt("indiana-c2", "Café 3 Corações Tradicional 250g", 11, "farmaciaindiana", "Farmácia Indiana", { delivery: "prazo da loja: 3 dias úteis" })];
  const c = await customerWith({ pending: [pend("arroz", arroz), pend("café", cafe)] }, "choosing");
  const out = await send(c.phone, "QUERO O MAIS BARATO DE TUDO");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual(ctx.basket?.map((b) => b.sku).sort(), ["indiana-c2", "mambo-a2"], out.slice(0, 500));
  assert.ok(!ctx.pending?.length);
  assert.match(out, /2 entregas/, out.slice(0, 600));
  assert.match(out, /3 dias úteis/, out.slice(0, 600));
});

test("M4: escolha que não cria entrega nem atrasa não ganha aviso", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = bi("mambo-a2", "Arroz Branco Camil 5kg", 27, { storeKey: "mambo", storeLabel: "Mambo", delivery: "prazo da loja: 3h" });
  const cafe = [opt("mambo-c1", "Café Melitta Tradicional 500g", 24, "mambo", "Mambo", { delivery: "prazo da loja: 3h" })];
  const c = await customerWith({ basket: [arroz], pending: [pend("café", cafe)] }, "choosing");
  const out = await send(c.phone, "1");
  assert.doesNotMatch(out, /entregas|chega mais tarde/, out.slice(0, 400));
});
