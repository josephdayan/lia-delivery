// Rodada 8, grupo G24 (10/10): "dá pra fazer dois pedidos?" com pagador diferente (não é dois endereços) e a oferta de
// juntar que sobrevive, orçamento do pedido ("se passar de 100 me avisa"), "vocês são confiáveis?" antes do cadastro,
// "só quero saber quanto tá o leite", "chegar até sexta, dá?", pedido mínimo na oferta de juntar, prazo do resumo ×
// avisos e pomada de assadura de adulto (fralda/lenço infantil e prazo longo).
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { etaChangedSinceChoice, handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { asksMultiAddress, detectIntent, parseBrowseOnly, parseOrderBudget, parseSplitOrders } from "../src/lib/lia-intents";
import { childAudienceMismatch } from "../src/lib/stores/types";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

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

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting", registered = true): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: registered ? { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } : { phone } });
  const base = registered ? { cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true } : {};
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, ...base, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g24_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const line = (sku: string, name: string, unitPrice: number, qty = 1, storeKey = "mambo", storeLabel = "Mambo", delivery?: string): BasketItem =>
  ({ sku, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as BasketItem;
const option = (sku: string, name: string, unitPrice: number, storeKey = "mambo", storeLabel = "Mambo", delivery?: string) => ({ sku, name, unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) });

const TWO_ORDERS = "a fantasia e a abóbora são minhas, as balas e o pirulito são do meu colega que paga separado. dá pra fazer dois pedidos?";

// A2 ------------------------------------------------------------------------------------------------------------------
test("A2: pagador diferente / 'dois pedidos' sem lugar não é pedido de dois endereços; 'juntar em 2 entregas' é a oferta", () => {
  assert.equal(parseSplitOrders(TWO_ORDERS), "payer");
  assert.equal(parseSplitOrders("meu amigo vai pagar a parte dele separado, dá pra fazer assim?"), "payer");
  assert.equal(parseSplitOrders("dá pra fazer dois pedidos?"), "orders");
  assert.equal(parseSplitOrders("dois pedidos: um em casa e um no trabalho"), null);
  assert.deepEqual(detectIntent(TWO_ORDERS), { kind: "split_orders", payer: true });
  assert.deepEqual(detectIntent("meu amigo vai pagar a parte dele separado, dá pra fazer assim?"), { kind: "split_orders", payer: true });
  // O terceiro que paga TUDO continua sendo o "encaminha o Pix".
  assert.equal(detectIntent("meu filho que vai pagar, pode mandar a cobrança pro zap dele?").kind, "third_party_pay");
  assert.equal(asksMultiAddress(TWO_ORDERS), false);
  assert.equal(asksMultiAddress("juntar em 2 entregas"), false);
  assert.equal(asksMultiAddress("oi, preciso de duas entregas: uma em casa e outra no trabalho"), true);
  assert.equal(asksMultiAddress("entrega em dois endereços?"), true);
});

test("A2: 'dois pedidos' do colega com a oferta de juntar na mesa — resposta honesta e a oferta continua valendo", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [
    line("g24-bala", "Bala Gomets Dori 500g", 11.3, 1, "mambo", "Mambo"),
    line("g24-piru", "Pirulito Lollipops 31g", 5.99, 1, "drogal", "Drogal"),
    line("g24-abob", "Abóbora Decorativa Halloween", 4.99, 1, "pbkids", "PBKids")
  ];
  const joined = [line("g24-bala", "Bala Gomets Dori 500g", 11.3, 1, "mambo", "Mambo"), line("g24-piru2", "Pirulito Pop 30g", 4.5, 1, "mambo", "Mambo"), line("g24-abob", "Abóbora Decorativa Halloween", 4.99, 1, "pbkids", "PBKids")];
  const key = basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");
  const offer = { key, basket: joined, storeLabel: "Mambo e PBKids", stores: 3, pairs: [{ fromName: "Pirulito Lollipops 31g", fromPrice: 6.59, toName: "Pirulito Pop 30g", toPrice: 4.95 }], delta: -1.64, joinedTotal: 40.2, keptTotal: 52.1, joinedStores: 2 };
  const c = await customerWith({ basket, consolidationOffer: offer });
  const out = await send(c.phone, TWO_ORDERS);
  assert.match(out, /um pagamento só/, out);
  assert.match(out, /mesmo endereço/, out);
  assert.match(out, /oferta de juntar lojas continua valendo/, out);
  assert.doesNotMatch(out, /trabalho|me manda os itens\./, out);
  const mid = await ctxOf(c.convoId);
  assert.ok(mid.consolidationOffer, "a oferta continua na mesa");
  assert.equal(mid.multiAddressAt, undefined);
  const join = await send(c.phone, "juntar em 2 entregas");
  assert.doesNotMatch(join, /dois pedidos|um endereço/, join);
  const after = await ctxOf(c.convoId);
  const skus = (after.basket?.length ? after.basket : []).map((i) => i.sku).sort();
  if (skus.length) assert.deepEqual(skus, joined.map((i) => i.sku).sort());
  else {
    // A cesta já virou pedido (cotação): os itens do pedido são os da junção.
    const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
    assert.deepEqual(((order?.items as unknown as BasketItem[]) ?? []).map((i) => i.sku).sort(), joined.map((i) => i.sku).sort());
  }
});

// M3 ------------------------------------------------------------------------------------------------------------------
test("M3: orçamento do pedido dito na conversa vira teto do total; o resto da mensagem segue", () => {
  assert.deepEqual(parseOrderBudget("pode fechar. se passar de 100 me avisa"), { cap: 100, rest: "pode fechar." });
  assert.deepEqual(parseOrderBudget("monta pra mim uma cesta básica de uns R$ 100: arroz, feijão, óleo"), { cap: 100, rest: "monta pra mim uma cesta básica: arroz, feijão, óleo" });
  assert.deepEqual(parseOrderBudget("tenho 80 reais pra tudo: arroz e feijão"), { cap: 80, rest: "arroz e feijão" });
  assert.equal(parseOrderBudget("2 vinhos até 40"), null, "teto de item não é orçamento do pedido");
  assert.equal(parseOrderBudget("2 pacotes de arroz 5kg"), null);
  const summary = copy.manualQuoteSummary({ items: [{ qty: 1, name: "Café Pilão 500g", lineTotal: 21.99 }, { qty: 1, name: "Arroz 5kg", lineTotal: 27.9 }], produtos: 70.77, frete: 41.78, total: 112.55, deliveries: 3, overBudget: { cap: 100, priciest: { name: "Arroz 5kg", lineTotal: 27.9 } } });
  assert.match(summary, /Passou do seu limite de \*R\$ 100,00\*: deu \*R\$ 112,55\* \(R\$ 12,55 a mais\)[\s\S]*Arroz 5kg[\s\S]*juntar/, summary);
});

test("M3: 'pode fechar. se passar de 100 me avisa' guarda o teto e fecha; a escolha que estoura avisa na hora", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [line("g24-arroz", "Arroz Tio João 5kg", 25.4), line("g24-feijao", "Feijão Camil 1kg", 8.9)] });
  await send(c.phone, "pode fechar. se passar de 100 me avisa");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.orderBudget?.cap, 100, JSON.stringify(ctx));
  // Escolha que faz o total estimado passar do teto: aviso junto da confirmação (uma vez).
  const d = await customerWith(
    { orderBudget: { cap: 100 }, basket: [line("g24-arroz", "Arroz Tio João 5kg", 25.4)], pending: [{ query: "café", qty: 1, options: [option("g24-cafe", "Café Pilão Torrado 1kg", 89.9)] }, { query: "óleo", qty: 1, options: [option("g24-oleo", "Óleo Soya 900ml", 7.9)] }] },
    "choosing"
  );
  const out = await send(d.phone, "1");
  assert.match(out, /passa do seu limite de \*R\$ 100,00\*/, out);
  assert.equal((await ctxOf(d.convoId)).orderBudget?.warned, true);
});

// M4 ------------------------------------------------------------------------------------------------------------------
test("M4: 'vocês são confiáveis?' é confiança (antes do cadastro também); consulta de preço não é cancelamento", async (t) => {
  assert.equal(detectIntent("vocês são confiáveis? como eu sei que vai chegar mesmo?").kind, "trust_question");
  assert.equal(parseBrowseOnly("só quero saber quanto tá o leite, não vou comprar agora"), "quanto tá o leite");
  assert.notEqual(detectIntent("só quero saber quanto tá o leite, não vou comprar agora").kind, "cancel");
  assert.equal(detectIntent("não vou comprar agora").kind, "cancel");
  if (!dbOk) return t.skip();
  const pre = await customerWith({}, "collecting", false);
  const trust = await send(pre.phone, "vocês são confiáveis? como eu sei que vai chegar mesmo?");
  assert.equal(trust, copy.trustAnswer(), "só a resposta de confiança (sem \"Você ainda não tem pedidos\")");
  const c = await customerWith({});
  const out = await send(c.phone, "só quero saber quanto tá o leite, não vou comprar agora");
  assert.doesNotMatch(out, /cancelar/i, out);
  assert.match(out, /Sem compromisso/, out);
});

test("M4: 'preciso que chegue até sexta, dá?' com a cesta montada responde sim/não e diz qual loja atrasa", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [line("g24-pao", "Pão de Forma Wickbold", 9.9, 1, "mambo", "Mambo", "prazo da loja: hoje"), line("g24-kit", "Kit Festa Junina", 10.99, 1, "santaluzia", "Casa Santa Luzia", "prazo da loja: 9 dias úteis")] });
  const out = await send(c.phone, "preciso que chegue até sexta, dá?");
  assert.match(out, /Até \*sexta\* não chega tudo: a \*Casa Santa Luzia\* entrega depois/, out);
  const d = await customerWith({ basket: [line("g24-pao", "Pão de Forma Wickbold", 9.9, 1, "mambo", "Mambo", "prazo da loja: hoje")] });
  assert.match(await send(d.phone, "preciso que chegue até sexta, dá?"), /Dá, chega até \*sexta\*/);
});

// M5 ------------------------------------------------------------------------------------------------------------------
test("M5: a oferta de juntar diz o pedido mínimo da forma que não fecha", () => {
  const note = copy.consolidationMinimumNote([{ store: "Americanas", min: 33, falta: 22.01 }], []);
  assert.match(note, /Mantendo como está, a \*Americanas\* tem pedido mínimo de \*R\$ 33,00\* \(faltam R\$ 22,01\)/, note);
  const offer = copy.consolidationOffer({ storeLabel: "Mambo", joinedTotal: 59.02, keptTotal: 70.48, keptStores: 4, pairs: [], minimumNote: note });
  assert.match(offer, /manter como está por R\$ 70,48[\s\S]*pedido mínimo[\s\S]*Responde \*1\*/, offer);
});

// M8 ------------------------------------------------------------------------------------------------------------------
test("M8: prazo confirmado no fechamento diferente do aviso da escolha é explicado antes do resumo", () => {
  const basket = [line("g24-p1", "Pão Francês 480g", 9.79, 4, "santaluzia", "Casa Santa Luzia", "prazo da loja: 4 dias úteis"), line("g24-p2", "Leite 1l", 5.5, 1, "mambo", "Mambo", "prazo da loja: hoje")];
  const changes = etaChangedSinceChoice(basket, new Map([["santaluzia", "3bd"], ["mambo", "0bd"]]));
  assert.deepEqual(changes, [{ store: "Casa Santa Luzia", before: "prazo da loja: 4 dias úteis", now: "prazo da loja: 3 dias úteis" }]);
  assert.match(copy.etaUpdatedByStore(changes), /Casa Santa Luzia\* confirmou \*3 dias úteis\* \(antes aparecia 4 dias úteis\)/);
  assert.deepEqual(etaChangedSinceChoice(basket, new Map([["santaluzia", "4bd"]])), []);
});

// M9 ------------------------------------------------------------------------------------------------------------------
test("M9: pomada de assadura sem falar de criança não puxa fralda/lenço infantil da prateleira", () => {
  assert.equal(childAudienceMismatch("pomada pra assadura", "Fralda Huggies Roupinha Supreme Care Pants XG 80 Unidades"), true);
  assert.equal(childAudienceMismatch("pomada pra assadura", "Lenço Umedecido Huggies Puro e Natural 48 Unidades"), true);
  assert.equal(childAudienceMismatch("pomada pra assadura", "Desitin Creme Para Assaduras 57g"), false);
  assert.equal(childAudienceMismatch("pomada pra assadura de bebê", "Fralda Huggies Pants XG"), false);
  assert.equal(childAudienceMismatch("fralda xg", "Fralda Huggies Pants XG"), false);
  assert.equal(childAudienceMismatch("pomada pra assadura", "Fralda Geriátrica Bigfral Plus G"), false);
});

test("M9: 1º item com prazo longo (9 dias úteis) avisa já na escolha", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [{ query: "pomada pra assadura", qty: 1, options: [option("g24-hipo", "Creme Para Assadura Hipoglós 40g", 29.5, "drogal", "Drogal", "prazo da loja: 9 dias úteis")] }, { query: "sabonete íntimo", qty: 1, options: [option("g24-sab", "Sabonete Íntimo Dermacyd 200ml", 15.9)] }] }, "choosing");
  const out = await send(c.phone, "1");
  assert.match(out, /só entrega em \*9 dias úteis\* — é um prazo longo/, out);
});
