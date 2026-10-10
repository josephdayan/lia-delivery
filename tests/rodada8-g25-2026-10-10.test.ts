// Rodada 8, grupo G25 (10/10): reteste em produção dos achados que "corrigidos" não pegavam. Cada teste passa pelo
// caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. o resumo final não avisava o item que ficou de fora (o fechamento da cesta apagava `listMisses` antes do resumo);
//   2. a oferta de troca de loja (pedido mínimo) sumia depois de uma pergunta lateral sobre o item;
//   3. "aceito a troca, pode ser" lido como edição de item; "sim" à pergunta da própria Lia;
//   4. reclamação forte virando pedido de atendente com citação inventada; "melhor deixar" com o total na mesa;
//   5. baixas (fragmento "a normal sem receita", "tem um mais em conta?", orçamento "até 50", lenço íntimo pra bebê...);
//   6. remédio + item comum na mesma frase: o item comum não pode sumir.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, recommendationLeftovers, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { cheaperAskTarget, detectIntent } from "../src/lib/lia-intents";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5577${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g25_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas", extra: Partial<ChoiceOption> = {}): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel, ...extra });
const pend = (query: string, options: ChoiceOption[], extra: Partial<PendingChoice> = {}): PendingChoice => ({ query, qty: 1, options, ...extra }) as PendingChoice;

// 1 ------------------------------------------------------------------------------------------------------------------
test("1: o resumo do fechamento real ('só isso') avisa o que ficou de fora; 'tira o gelo' depois não reabre o pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ listMisses: [{ query: "gelo em cubos", qty: 1, reason: "not_found", at: Date.now() }] });
  await send(c.phone, "quero arroz");
  await send(c.phone, "1");
  const quote = await send(c.phone, "só isso");
  assert.match(quote, /Seu pedido/, quote.slice(0, 400));
  assert.match(quote, /Ficou de fora \(não achei\): \*gelo em cubos\*/, quote.slice(0, 800));
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.step, "awaiting_quote_confirmation");
  assert.ok((ctx.listMisses ?? []).some((m) => m.query === "gelo em cubos"), "a faltante sobrevive ao resumo");
  // Com a IA ligada (produção), "tira o gelo" não vai para a IA (que só via a cesta): o cérebro diz que já estava de fora.
  assert.equal(dialogueBypassReason({ text: "tira o gelo", intent: detectIntent("tira o gelo"), ctx, hasAddress: true, looksLikeList: false }), "intent:remove_miss");
  const out = await send(c.phone, "tira o gelo");
  assert.match(out, /\*gelo em cubos\* já tinha ficado de fora/, out.slice(0, 300));
  const after = await ctxOf(c.convoId);
  assert.equal(after.step, "awaiting_quote_confirmation", "o total continua na mesa");
  assert.ok(after.deliveryOrderId);
});

// 2/3 ----------------------------------------------------------------------------------------------------------------
const sig = (basket: BasketItem[]) => basket.map((i) => `${i.sku}:${i.qty}`).sort().join("|");
const caderno = bi("americanas-4042685", "Caderno Soho Grampeado Pequeno 32 Folhas Tilibra Pautado", 16.99, { ask: "caderno pequeno" });
const bombom = bi("paguemenos-57318", "Bombom Ouro Branco 20g", 2.99, { storeKey: "paguemenos", storeLabel: "Pague Menos", ask: "bombom" });
const caderneta = opt("livrariascuritiba-368320", "Caderneta Grampeada Fitto Flexível Soho", 13.58, "livrariascuritiba", "Livrarias Curitiba");
const swapCtx = () => {
  const basket = [bombom, caderno];
  return { basket, minSwap: { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: caderno.sku, qty: 1, option: caderneta }] } };
};
async function itemsAfter(c: { convoId: string; userId: string }): Promise<BasketItem[]> {
  const ctx = await ctxOf(c.convoId);
  if (ctx.basket?.length) return ctx.basket;
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  return (order?.items as unknown as BasketItem[]) ?? [];
}

test("2: 'tem outro caderno pequeno?' / 'mostra outros cadernos' não recusam a troca; a oferta sobrevive e 'pode trocar de loja' aceita", async (t) => {
  if (!dbOk) return t.skip();
  for (const lateral of ["tem outro caderno pequeno?", "mostra outros cadernos"]) {
    const c = await customerWith(swapCtx());
    const first = await send(c.phone, lateral);
    assert.doesNotMatch(first, /Troquei de loja/i, `${lateral}: ${first.slice(0, 300)}`);
    const mid = await ctxOf(c.convoId);
    assert.ok(mid.minSwap || mid.minSwapParked, `${lateral}: a oferta ficou guardada`);
    const out = await send(c.phone, "pode trocar de loja");
    assert.doesNotMatch(out, /Responde o número|Qual loja/i, out.slice(0, 300));
    const items = await itemsAfter(c);
    assert.ok(items.some((b) => b.sku === caderneta.sku), `${lateral}: ${out.slice(0, 400)}`);
    assert.ok(!items.some((b) => b.sku === caderno.sku));
  }
});

test("2: depois da fala lateral, um '1' solto não aceita a oferta guardada (rodada 6 A2 continua valendo)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(swapCtx());
  await send(c.phone, "tem outro caderno pequeno?");
  const out = await send(c.phone, "1");
  assert.doesNotMatch(out, /Troquei de loja/i, out.slice(0, 300));
});

test("3: 'aceito a troca, pode ser' aceita a troca de loja (não vira edição de item)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(swapCtx());
  const out = await send(c.phone, "aceito a troca, pode ser");
  assert.doesNotMatch(out, /já é o que está na sua cesta/i, out.slice(0, 300));
  assert.match(out, /Troquei de loja/i, out.slice(0, 300));
});

const areia = bi("cobasi-203572", "Areia para Gato Mitzi Granulado Sanitário Kelco 4kg", 17.59, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "areia sanitária gato 4kg" });
const leitePend = () => pend("leite", [opt("mambo-8057", "Leite Semidesnatado Longa Vida Parmalat 1 Litro", 5.49, "mambo", "Mambo"), opt("mambo-8058", "Leite Integral Italac 1L", 4.99, "mambo", "Mambo")], { qty: 12 });

test("3: 'tem mais barato? 4kg da areia ta 65' nomeia a areia escolhida — vai direto ao mais barato dela, sem perguntar", async (t) => {
  assert.equal(cheaperAskTarget("tem mais barato? 4kg da areia ta 65 na farmacia", [areia], ["leite"]), 0);
  assert.equal(cheaperAskTarget("a areia que eu já escolhi, tem uma mais barata?", [areia], ["leite"]), 0);
  assert.equal(cheaperAskTarget("tem leite mais barato?", [areia], ["leite"]), null);
  assert.equal(cheaperAskTarget("tem mais barato?", [areia], ["leite"]), null);
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  let asked = 0;
  __setDialogueModelForTests(async () => {
    asked++;
    return { actions: [{ type: "unclear", text: "Você quer ver leites mais baratos ou buscar uma areia de gato mais barata?" }] };
  });
  const c = await customerWith({ basket: [areia], pending: [leitePend()] }, "choosing");
  const out = await send(c.phone, "tem mais barato? 4kg da areia ta 65 na farmacia");
  assert.equal(asked, 0, "não pergunta 'leite ou areia?'");
  assert.doesNotMatch(out, /Não peguei|leites mais baratos ou/i, out.slice(0, 400));
  assert.match(out, /areia/i, out.slice(0, 400));
});

test("3: 'sim' à pergunta da Lia 'Você quer trocar a areia escolhida por uma opção mais barata?' faz a troca, sem repetir a pergunta", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  let asked = 0;
  __setDialogueModelForTests(async () => {
    asked++;
    return { actions: [{ type: "unclear", text: "Você quer trocar a areia por outra opção mais barata?" }] };
  });
  const c = await customerWith(
    { basket: [areia], pending: [leitePend()], openQuestion: { text: "Você quer trocar a areia escolhida por uma opção mais barata?", at: Date.now() } },
    "choosing"
  );
  const out = await send(c.phone, "sim");
  assert.equal(asked, 0, out.slice(0, 300));
  assert.doesNotMatch(out, /Não peguei|Você quer trocar a areia|Não achei esse item/i, out.slice(0, 400));
  assert.match(out, /areia/i, out.slice(0, 400));
});

// 4 ------------------------------------------------------------------------------------------------------------------
test("4: reclamação que a IA lê como 'quero um atendente' não escala nem cita frase inventada", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "human" }] }));
  const c = await customerWith({ pending: [pend("arroz", [opt("swift-7694", "Arroz Branco Swift 1kg", 4.37, "swift", "Swift")])] }, "choosing");
  const start = outbox.length;
  const out = await send(c.phone, "voces sao uma porcaria, demora demais");
  const all = outbox.slice(start).map((m) => m.text).join("\n");
  assert.doesNotMatch(all, /quero falar com um atendente/i, all.slice(0, 500));
  assert.doesNotMatch(out, /Avisei o responsável|Já avisei o responsável/i, out.slice(0, 300));
  assert.match(out, /Sinto muito[\s\S]*atendente/, out.slice(0, 300));
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.attendance, undefined);
  assert.equal(ctx.pending?.[0]?.query, "arroz", "a escolha continua aberta");
});

test("4: pedido de pessoa pela IA ('me passa pra alguém aí') ainda escala, citando o que o cliente escreveu", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "human" }] }));
  const c = await customerWith({ basket: [bi("swift-7694", "Arroz Branco Swift 1kg", 4.37, { storeKey: "swift", storeLabel: "Swift" })] });
  const start = outbox.length;
  await send(c.phone, "me passa pra alguém aí por favor");
  const all = outbox.slice(start).map((m) => m.text).join("\n");
  assert.doesNotMatch(all, /"quero falar com um atendente"/i, all.slice(0, 500));
  assert.ok((await ctxOf(c.convoId)).attendance, all.slice(0, 500));
});

test("4: 'melhor deixar, não preciso de mais nada disso' com o total na mesa é desistência, não cobrança", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  await send(c.phone, "quero arroz");
  await send(c.phone, "1");
  const quote = await send(c.phone, "só isso");
  assert.match(quote, /Seu pedido/, quote.slice(0, 300));
  const out = await send(c.phone, "melhor deixar, não preciso de mais nada disso, obrigado");
  assert.doesNotMatch(out, /Como prefere pagar|pix/i, out.slice(0, 300));
  assert.match(out, /nada foi cobrado/, out.slice(0, 300));
  const ctx = await ctxOf(c.convoId);
  assert.ok(!ctx.basket?.length && !ctx.deliveryOrderId);
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  assert.notEqual(order?.status, "awaiting_quote_confirmation");
});

// 6 ------------------------------------------------------------------------------------------------------------------
test("6: recomendação + item comum na mesma frase: o item comum é o que sobra", () => {
  assert.deepEqual(recommendationLeftovers("e pomada pra assadura, e um sabonete íntimo", { need: "pomada pra assadura", symptom: "assadura" }), ["sabonete íntimo"]);
  assert.deepEqual(recommendationLeftovers("pomada pra assadura", { need: "pomada pra assadura", symptom: "assadura" }), []);
});

test("6: 'e pomada pra assadura, e um sabonete íntimo' com a IA escolhendo recomendação: o sabonete não some", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({
    actions: [{ type: "recommend", form: "need", need: "pomada pra assadura", symptom: "assadura" }]
  }));
  const c = await customerWith({ basket: [bi("drogal-22572", "Fralda Pampers Super Sequinha Mega M 40 Unidades", 55.87, { storeKey: "drogal", storeLabel: "Drogal", ask: "fralda pampers m" })] });
  const out = await send(c.phone, "e pomada pra assadura, e um sabonete íntimo");
  const ctx = await ctxOf(c.convoId);
  const where = [...(ctx.pending ?? []).map((p) => p.query), ...(ctx.basket ?? []).map((b) => `${b.name} ${b.ask ?? ""}`)].join(" | ");
  assert.ok(/sabonete/i.test(where), `${where}\n${out.slice(0, 600)}`);
  assert.match(out, /Anotei também \*sabonete íntimo\*|sabonete íntimo/i, out.slice(0, 600));
});

test("6: com a IA recusando como remédio, o sabonete segue para a busca (remédio sai com aviso)", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "medicine" }] }));
  const c = await customerWith({ basket: [bi("drogal-22572", "Fralda Pampers Super Sequinha Mega M 40 Unidades", 55.87, { storeKey: "drogal", storeLabel: "Drogal", ask: "fralda pampers m" })] });
  const out = await send(c.phone, "e uma dipirona, e um sabonete íntimo");
  const ctx = await ctxOf(c.convoId);
  const where = [...(ctx.pending ?? []).map((p) => p.query), ...(ctx.basket ?? []).map((b) => `${b.name} ${b.ask ?? ""}`), ...(ctx.listMisses ?? []).map((m) => m.query)].join(" | ");
  assert.ok(/sabonete/i.test(where), `${where}\n${out.slice(0, 600)}`);
});
