// Rodada 7, grupo G21 (10/10): quantidade dobrada sem pedir (reenvio na linha de teste e escolha repetida), "entregam
// domingo? qual o horário?", "pode ser em 3 dias", "10h" ambíguo, "põe o papel de volta", total parcial e "quantas
// canetas vem?", refino de tamanho e dois carrosséis, duas entregas, "6 refrigerantes, coca cola", "3 pacotes" e
// "caneta ou caderninho até 50 no total".
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, qualifierOptions, runTurnScoped, saidPackageCount } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { asksMultiAddress, detectIntent, parseChoiceEtaAsk, parsePackCountAsk, parsePlaceLabel, replaceRefinedSize } from "../src/lib/lia-intents";
import { variantPenalty } from "../src/lib/stores/types";
import { dialogueBypassReason } from "../src/lib/dialogue";
import { isInFlightResend, isKnownMessageId, testLineMessageId } from "../src/lib/test-line-resend";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5579${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g21_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const line = (sku: string, name: string, unitPrice: number, qty = 1, storeKey = "mambo", storeLabel = "Mambo"): BasketItem =>
  ({ sku, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100, storeKey, storeLabel }) as BasketItem;
const option = (sku: string, name: string, unitPrice: number, storeKey = "mambo", storeLabel = "Mambo") => ({ sku, name, unitPrice, storeKey, storeLabel });

// A3 ------------------------------------------------------------------------------------------------------------------
test("A3: escolher de novo um produto que JÁ está na cesta (sem quantidade dita) não vira 2x", async (t) => {
  if (!dbOk) return t.skip();
  const sab = option("g21-sab", "Sabonete Em Barra Para Bebê Protex Baby Glicerina Natural 85g", 3.07, "extrafarma", "Extrafarma");
  // Outra linha da lista que trouxe o mesmo sabonete (ou card revivido): a fila tem uma escolha com o mesmo sku.
  const c = await customerWith(
    { basket: [line(sab.sku, sab.name, sab.unitPrice, 1, "extrafarma", "Extrafarma")], pending: [{ query: "sabonete de bebê", qty: 1, options: [sab, option("g21-sab2", "Sabonete Huggies 75g", 5.49)] }] },
    "choosing"
  );
  const out = await send(c.phone, `optsku:${sab.sku}`);
  assert.match(out, /já está na cesta/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((b) => b.sku === sab.sku)?.qty, 1, JSON.stringify(ctx.basket));
});

test("A3: linha de teste — mesmo messageId e reenvio idêntico com o turno ainda rodando não viram um 2º turno", async (t) => {
  if (!dbOk) return t.skip();
  assert.equal(testLineMessageId("abc"), "testline_abc");
  assert.match(testLineMessageId(undefined), /^testline_[0-9a-f-]{36}$/);
  const c = await customerWith({});
  await prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "optsku:extrafarma-94888", metadata: "testline_g21-retry-1" } });
  assert.equal(await isKnownMessageId(c.phone, "testline_g21-retry-1"), true);
  assert.equal(await isKnownMessageId(c.phone, "testline_g21-retry-2"), false);
  // Turno livre: repetir a mesma mensagem é intencional ("1" num carrossel e "1" no seguinte).
  assert.equal(await isInFlightResend(c.phone, "optsku:extrafarma-94888"), false);
  // Turno da mesma mensagem ainda rodando (a conexão do testador caiu no meio): o reenvio é o mesmo envio.
  await prisma.conversation.update({ where: { id: c.convoId }, data: { turnLock: "g21", turnLockAt: new Date() } });
  assert.equal(await isInFlightResend(c.phone, "optsku:extrafarma-94888"), true);
  assert.equal(await isInFlightResend(c.phone, "só isso"), false);
});

// M1 ------------------------------------------------------------------------------------------------------------------
test("M1: 'vocês entregam domingo? qual o horário?' é pergunta de dia/horário, não a lista de prazos das opções", () => {
  for (const t of ["vocês entregam domingo? qual o horário?", "qual o horário de vocês? entregam domingo?", "entregam no domingo?"]) {
    assert.deepEqual(detectIntent(t), { kind: "service_question", topic: "hours" }, t);
    assert.equal(parseChoiceEtaAsk(t), null, t);
  }
  assert.ok(parseChoiceEtaAsk("o 2 chega hoje?"), "prazo das opções continua");
  assert.notEqual((detectIntent("que horas chega?") as { topic?: string }).topic, "hours");
  assert.match(copy.serviceAnswer("hours", "SP"), /qualquer hora[\s\S]*domingo[\s\S]*antes de você pagar/);
});

test("M1: com os cards na tela, a resposta de horário volta ao ponto (lembra a escolha aberta)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [{ query: "shampoo anticaspa", qty: 1, options: [option("g21-sh1", "Shampoo Head & Shoulders 400ml", 19.4), option("g21-sh2", "Shampoo Clear 400ml", 29.69)] }] }, "choosing");
  const out = await send(c.phone, "vocês entregam domingo? qual o horário?");
  assert.match(out, /domingo/, out);
  assert.doesNotMatch(out, /Prazo de cada opção/, out);
  assert.match(out, /shampoo anticaspa/, out);
});

// M2/M3 ---------------------------------------------------------------------------------------------------------------
test("M2: 'pode ser em 3 dias então' e 'me entrega no sábado' são agendamento (resposta fixa, sem IA)", () => {
  for (const t of ["pode ser em 3 dias então", "então me entrega no sábado", "me entrega na sexta"]) {
    assert.deepEqual(detectIntent(t), { kind: "scheduling_question" }, t);
    assert.equal(dialogueBypassReason({ text: t, intent: detectIntent(t), ctx: { step: "collecting" } as never, hasAddress: true, looksLikeList: false }), "intent:scheduling_question", t);
  }
  assert.notEqual(detectIntent("chega em 3 dias?").kind, "scheduling_question");
  assert.match(copy.schedulingAnswer(), /ainda não consigo/);
});

test("M3: '10h' do prazo da loja vira 'em até 10 horas' (resumo e escolha de entrega); faixa de horário fica", () => {
  assert.equal(copy.spellStoreHours("10h"), "em até 10 horas");
  assert.equal(copy.spellStoreHours("prazo da loja: 10h"), "prazo da loja: em até 10 horas");
  assert.equal(copy.spellStoreHours("hoje, 12h–15h"), "hoje, 12h–15h");
  assert.equal(copy.spellStoreHours("1 dia útil"), "1 dia útil");
  const resumo = copy.summary({ items: [], produtos: 47.1, frete: 8.9, deliveryPromise: "pela própria loja · prazo da loja: 10h", total: 56 } as never);
  assert.match(resumo, /Entrega: R\$ 8,90 · em até 10 horas/, resumo);
  assert.match(copy.shippingSpeedChoice({ total: 54, estimate: "prazo da loja: 1 dia útil" }, { total: 56, estimate: "prazo da loja: 10h" }, "store"), /Mais rápida — total R\$ 56,00 · prazo da loja: em até 10 horas/);
  assert.match(copy.freightTotalHeader(), /total depende da entrega/);
});

// M5 ------------------------------------------------------------------------------------------------------------------
test("M5: 'põe o papel de volta' depois de 'tira o papel' devolve o MESMO item (sem nova busca)", async (t) => {
  if (!dbOk) return t.skip();
  const papel = line("g21-papel", "Papel Sulfite Report 75g A4 500 Folhas Resma", 29.37, 1, "livrariascuritiba", "Livrarias Curitiba");
  const caneta = option("g21-can", "Caneta Esferográfica Cristal 3 Unidades Bic", 8.79, "americanas", "Americanas");
  const c = await customerWith({ basket: [papel], pending: [{ query: "caneta esferográfica azul caixa", qty: 1, options: [caneta] }] }, "choosing");
  const removed = await send(c.phone, "tira o papel");
  assert.match(removed, /Tirei Papel Sulfite/, removed);
  const out = await send(c.phone, "põe o papel de volta");
  assert.match(out, /Voltei \*Papel Sulfite Report 75g A4 500 Folhas Resma\* pra cesta/, out);
  assert.doesNotMatch(out, /Não achei/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((b) => b.sku === "g21-papel")?.qty, 1);
  assert.equal(ctx.pending?.[0]?.query, "caneta esferográfica azul caixa");
});

// M6 ------------------------------------------------------------------------------------------------------------------
test("M6/N4: 'quanto ta?'/'total' com carrossel aberto vão direto pro parcial (sem IA)", async (t) => {
  for (const text of ["quanto ta?", "total"]) {
    const ctx = { step: "choosing", basket: [line("x", "Papel", 10)], pending: [{ query: "caneta", qty: 1, options: [] }] } as unknown as DeliveryContext;
    assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false }), "intent:running_total", text);
  }
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [line("g21-p2", "Papel Sulfite Report 75g A4", 29.37)], pending: [{ query: "grampeador", qty: 1, options: [option("g21-g1", "Mini Grampeador Escolar", 10.99)] }] }, "choosing");
  const out = await send(c.phone, "quanto ta?");
  assert.match(out, /Até agora[\s\S]*Papel Sulfite[\s\S]*Falta escolher: grampeador/, out);
});

test("M6: 'quantas canetas vem?' responde as unidades do produto escolhido", async (t) => {
  assert.deepEqual(parsePackCountAsk("quantas canetas vem?"), { noun: "canetas" });
  assert.deepEqual(parsePackCountAsk("quantas unidades tem?"), { noun: "" });
  assert.deepEqual(parsePackCountAsk("vem quantas?"), { noun: "" });
  assert.equal(parsePackCountAsk("quantos dias demora?"), null);
  assert.equal(parsePackCountAsk("quanto tem?"), null);
  if (!dbOk) return t.skip();
  const name = "Caneta Esferográfica Cristal Fashion 3 Unidades Bic Ponta 1.2mm";
  const c = await customerWith({ basket: [line("g21-can3", name, 8.79)], lastChoice: { query: "caneta azul", qty: 1, options: [], chosenSku: "g21-can3" } });
  const out = await send(c.phone, "quantas canetas vem?");
  assert.match(out, /vem com \*3 unidades\*/, out);
});

// M7 ------------------------------------------------------------------------------------------------------------------
test("M7: refino de tamanho substitui o anterior ('fralda RN' + 'tamanho P' não busca 'RN tamanho p')", () => {
  assert.equal(replaceRefinedSize("fralda RN pacote grande", ["tamanho p"]), "fralda pacote grande");
  assert.equal(replaceRefinedSize("fralda RN pacote grande", ["p"]), "fralda pacote grande");
  assert.equal(replaceRefinedSize("fralda tamanho m", ["tamanho g"]), "fralda");
  assert.equal(replaceRefinedSize("fralda RN pacote grande", ["pampers"]), "fralda RN pacote grande", "refino que não é tamanho não mexe");
  assert.equal(replaceRefinedSize("queijo 500 g", ["fatiado"]), "queijo 500 g");
});

test("M7: 'tira a fralda RN e põe fralda P' não manda o carrossel da próxima escolha junto com o novo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "fralda RN pacote grande", qty: 1, options: [option("g21-f1", "Fralda Huggies RN 34 Unidades", 58.19), option("g21-f2", "Fralda Pampers RN 36 Unidades", 63.13)] },
        { query: "lenço umedecido", qty: 1, options: [option("g21-l1", "Lenço Umedecido Huggies 48 unidades", 14.19)] }
      ]
    },
    "choosing"
  );
  const sentBefore = outbox.length;
  const carousels: string[] = [];
  const restore = adapter.sendDeliveryCarousel;
  adapter.sendDeliveryCarousel = async (to: string, header: string) => {
    if (to === c.phone) carousels.push(String(header));
    return { messageId: undefined };
  };
  try {
    await send(c.phone, "tira a fralda RN e põe fralda Pampers tamanho P");
  } finally {
    adapter.sendDeliveryCarousel = restore;
  }
  const out = outbox.slice(sentBefore).filter((m) => m.to === c.phone).map((m) => m.text).join("\n");
  assert.match(out, /Tirei fralda RN/, out);
  const lencoShown = [...carousels, out].some((x) => /Opções de \*lenço umedecido\*/.test(x));
  assert.equal(lencoShown, false, `carrosséis: ${carousels.join(" | ")} :: ${out.slice(0, 400)}`);
});

// M11 -----------------------------------------------------------------------------------------------------------------
test("M11: 'duas entregas, casa e trabalho' — um pedido por endereço, dito com clareza; 'no trabalho:' não entra no de casa", async (t) => {
  assert.equal(asksMultiAddress("oi, preciso de duas entregas: uma em casa e outra no trabalho"), true);
  assert.equal(asksMultiAddress("entrega em dois endereços?"), true);
  assert.equal(asksMultiAddress("duas pizzas"), false);
  assert.deepEqual(parsePlaceLabel("no trabalho: resma de papel A4 e canetas azuis"), { place: "trabalho", home: false, rest: "resma de papel A4 e canetas azuis" });
  assert.deepEqual(parsePlaceLabel("em casa: ração e shampoo pet"), { place: "casa", home: true, rest: "ração e shampoo pet" });
  assert.equal(parsePlaceLabel("arroz e feijão"), null);
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const first = await send(c.phone, "oi, preciso de duas entregas: uma em casa e outra no trabalho");
  assert.match(first, /dois pedidos[\s\S]*um endereço só[\s\S]*trocar endereço/, first);
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.multiAddressAt);
  // Com a cesta de casa montada, os itens do trabalho ficam pro 2º pedido (não somam calados).
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ ...ctx, basket: [line("g21-r", "Ração Filhote 3kg", 73.59)] }) } });
  const work = await send(c.phone, "no trabalho: resma de papel A4 e canetas azuis");
  assert.match(work, /2º pedido[\s\S]*trocar endereço/, work);
  const after = await ctxOf(c.convoId);
  assert.equal(after.basket?.length, 1);
  assert.equal(after.pending, undefined);
});

// M8 ------------------------------------------------------------------------------------------------------------------
test("M8: '3 pacotes' dito pelo cliente vale como embalagens; coca sem pedir zero não é a Sem Açúcar", async (t) => {
  assert.equal(saidPackageCount("esse de 100 unidades 200ml, preciso de 3 pacotes"), 3);
  assert.equal(saidPackageCount("duas caixas"), 2);
  assert.equal(saidPackageCount("12 ovos"), null);
  assert.ok(variantPenalty("refrigerante coca cola 2l", "Refrigerante Sem Açúcar Coca-Cola Garrafa 2L") > variantPenalty("refrigerante coca cola 2l", "Refrigerante Coca-Cola Garrafa 2L"));
  assert.equal(variantPenalty("coca cola sem açúcar", "Refrigerante Sem Açúcar Coca-Cola Garrafa 2L"), 0);
  if (!dbOk) return t.skip();
  const options = [option("g21-copo50", "Copo Descartável Azul Regina 200ml com 50 Unidades", 14.28), option("g21-copo100", "Copo Descartável Transparente Copobras 200ml com 100 unidades", 20.34)];
  const c = await customerWith({ pending: [{ query: "copos descartáveis", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "o 2, preciso de 3 pacotes");
  assert.doesNotMatch(out, /Levo 1 embalagem/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((b) => b.sku === "g21-copo100")?.qty, 3, `${out} :: ${JSON.stringify(ctx.basket)}`);
});

test("M8: 'quero 6 refrigerantes de 2 litros, coca cola' com 'refrigerante 2 litros' na fila corrige o item da fila (sem 2ª linha)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "carvão 3kg", qty: 1, options: [option("g21-carv", "Carvão Vegetal Mambo 3kg", 37.38)] },
        { query: "refrigerante 2 litros", qty: 6, qtyExplicit: true, options: [option("g21-pepsi", "Refrigerante Pepsi 2 Litros", 10.77)] }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "quero 6 refrigerantes de 2 litros, coca cola");
  const ctx = await ctxOf(c.convoId);
  // O catálogo de teste chama a Coca de "Coca-Cola Lata 350 ml" (sem "Refrigerante"): aqui só a correção da fila vale.
  const refris = (ctx.pending ?? []).filter((p) => /refrigerante/i.test(p.query));
  assert.equal(refris.length, 1, `${out} :: ${JSON.stringify((ctx.pending ?? []).map((p) => p.query))}`);
  assert.equal(refris[0].qty, 6);
  assert.match(out, /Corrigi para \*refrigerantes? 2 litros/, out);
  assert.doesNotMatch(out, /Somei/, out);
  // Nas lojas reais as opções da marca dizem o tipo ("Refrigerante Coca-Cola Garrafa 2L"): ", coca cola" é a marca.
  const coca = [{ name: "Refrigerante Coca-Cola Garrafa 2L" }, { name: "Refrigerante Coca-Cola Sem Açúcar 2L" }, { name: "Coca-Cola Lata 350ml" }];
  assert.equal(qualifierOptions("refrigerantes 2 litros", coca)?.length, 2);
  assert.equal(qualifierOptions("refrigerantes 2 litros", [{ name: "Pão Francês 1kg" }, { name: "Pão de Forma" }]), null);
});

// M10 -----------------------------------------------------------------------------------------------------------------
test("M10: 'e uma caneta bonita ou caderninho que fique até 50 no total' separa o 'ou' e o teto (descontando a cesta)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [line("g21-bomb", "Caixa de Bombom Lacta 250g", 25.28)] });
  const out = await send(c.phone, "e uma caneta bonita ou caderninho que fique até 50 no total");
  assert.match(out, /\*caneta bonita\* ou \*caderninho\*[\s\S]*Procuro até \*R\$ 2\d,\d\d\*/, out);
  assert.doesNotMatch(out, /material escolar|Não achei/, out);
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.askEither?.cap ?? 0) > 0 && (ctx.askEither?.cap ?? 0) < 25, String(ctx.askEither?.cap));
});
