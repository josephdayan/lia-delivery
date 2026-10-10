// Rodada 11, grupo G32 (10/10): teto, prazo e "o mais barato" com o pedido em vista. Conversas pelo caminho real
// (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. o orçamento dito no meio do áudio ("...e uns iogurte também mas assim eu só tenho uns 80 reais viu") sumia antes do
//      cadastro e "tá dentro?" voltava "Dentro de qual valor ou orçamento?";
//   2. "o mais barato" ignorava o prazo dito ("até amanhã de manhã", classificado como agendamento antes do cadastro) e
//      puxava uma loja nova por centavos (4 entregas para R$ 37 de produtos); o aviso de prazo da vitrine seguinte parecia
//      ser do item recém-escolhido;
//   3. a oferta de juntar levava o pedido a 8 dias úteis para poupar R$ 5,90 sem destaque; o pedido mínimo da loja nova
//      só aparecia no "só isso".
// Textos reais de /mnt/project-files/testes-whatsapp/rodada11/grupo-b.md (jornadas 301, 302, 305, 306, 307).
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, slowerJoinNotWorth } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import { asksBudgetLeft, parseOrderBudget } from "../src/lib/lia-intents";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5532${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista 1000, Bela Vista, São Paulo";
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
  delete process.env.LIA_DIALOGUE_LLM;
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria Teste" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address" }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g32_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery?: string): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as BasketItem;
const decision = (d: Partial<PreDecision>): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...d });
const tomorrow = () => new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

// 1 ------------------------------------------------------------------------------------------------------------------
const AUDIO = "então é pro lanche das crianças, quero suquinho de caixinha, uns 10 biscoitos recheados, achocolatado e uns iogurte também mas assim eu só tenho uns 80 reais viu";

test("1a: 'mas assim eu só tenho uns 80 reais viu' no meio do áudio é o teto do pedido; 'tá dentro?' pergunta pelo teto", () => {
  const parsed = parseOrderBudget(AUDIO);
  assert.equal(parsed?.cap, 80);
  assert.doesNotMatch(parsed?.rest ?? "", /80|reais|viu/, parsed?.rest);
  assert.match(parsed?.rest ?? "", /iogurte também$/);
  assert.equal(parseOrderBudget("quero um caderno pequeno"), null);
  assert.equal(parseOrderBudget("e mais 2 pacotes de biscoito mas sem recheio")?.cap, undefined);
  for (const ask of ["tá dentro?", "eu falei, tá dentro?", "fica dentro do orçamento?", "e isso ainda cabe?"]) assert.equal(asksBudgetLeft(ask), true, ask);
  for (const other of ["o leite tá dentro da geladeira?", "tá dentro", "quero o que tá dentro da caixa"]) assert.equal(asksBudgetLeft(other), false, other);
});

test("1b: o teto dito antes do cadastro sobrevive ao endereço e 'eu falei que tenho 80 reais, tá dentro?' responde com ele", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer();
  const noted = await send(c.phone, AUDIO);
  assert.match(noted, /Até \*R\$ 80,00\* no total/, noted);
  assert.doesNotMatch(noted, /80 reais|1x viu/i, noted);
  assert.equal((await ctxOf(c.convoId)).orderBudget?.cap, 80);
  await send(c.phone, `${ADDRESS}, 01310-100`);
  assert.equal((await ctxOf(c.convoId)).orderBudget?.cap, 80, "o teto passa pelo cadastro");
  const ask = await send(c.phone, "eu falei que tenho 80 reais, tá dentro?");
  assert.match(ask, /do seu teto de \*R\$ 80,00\*/i, ask);
  assert.doesNotMatch(ask, /Dentro de qual valor|não sei responder/i, ask);
});

test("1c: 'tá dentro?' estima a entrega com o frete que a loja respondeu no card (o mesmo do resumo), não a tabela", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [
    { ...line("oba-g32a", "Suco Del Valle 200ml", 10, "oba", "Oba", "hoje"), freightFee: 4.9 },
    { ...line("carrefour-g32b", "Achocolatado Nescau 350g", 10, "carrefour", "Carrefour", "hoje"), freightFee: 4.9 }
  ];
  const c = await customerWith({ basket, orderBudget: { cap: 35 } });
  const out = await send(c.phone, "tá dentro?");
  assert.match(out, /Cabe, sim/, out);
  assert.match(out, /R\$ 31,80/, out);
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: prazo dito junto da lista antes do cadastro, classificado como agendamento, vira o prazo do pedido", async (t) => {
  if (!dbOk) return t.skip();
  __setPreSignupModelForTests(async () =>
    decision({ items: ["carvão", "linguiça toscana", "pão de alho", "sal grosso", "guaraná 2 litros"].map((query) => ({ query, qty: query.startsWith("guaraná") ? 2 : 1, cheapest: false })), answers: ["scheduling"] })
  );
  const c = await newcomer();
  const out = await send(c.phone, "vou fazer um churrasco, preciso que chegue até amanhã de manhã: carvão, linguiça toscana, pão de alho, sal grosso e 2 guaranás de 2 litros");
  assert.match(out, /Pra chegar até \*amanhã de manhã\*/, out);
  assert.doesNotMatch(out, /Agendar horário certinho/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.neededBy?.label, "amanhã", JSON.stringify(ctx.neededBy));
});

test("2b: com prazo dito, 'o mais barato' escolhe entre as opções que chegam a tempo e diz por quê", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    opt("santaluzia-130304", "Refrigerante Guaraná Antarctica Original - 2L", 12.1, "santaluzia", "Casa Santa Luzia", "1 dia útil"),
    opt("farmaciaindiana-172226", "Refrigerante Guaraná Antártica 2l", 9.99, "farmaciaindiana", "Farmácia Indiana", "8 dias úteis"),
    opt("americanas-887081", "Refrigerante Guaraná Antarctica 2L Pet Original", 11.99, "americanas", "Americanas", "hoje")
  ];
  const c = await customerWith({ neededBy: { date: tomorrow(), label: "amanhã", morning: true }, pending: [{ query: "guaraná 2 litros", qty: 2, qtyExplicit: true, options }] }, "choosing");
  const out = await send(c.phone, "o mais barato");
  const basket = (await ctxOf(c.convoId)).basket ?? [];
  assert.notEqual(basket[0]?.sku, "farmaciaindiana-172226", out);
  assert.equal(basket[0]?.sku, "americanas-887081", JSON.stringify(basket));
  assert.match(out, /etiqueta mais baixa é \*Refrigerante Guaraná Antártica 2l\*[\s\S]*não chega até \*amanhã\*/, out);
});

test("2c: 'o mais barato' conta a entrega de uma loja nova: centavos a menos em outra loja não abrem mais uma entrega", async (t) => {
  if (!dbOk) return t.skip();
  // Lojas ligadas no ambiente de teste: Oba (sem mínimo) já na cesta; Carrefour (mínimo de R$ 30) com a etiqueta mais baixa.
  const basket = [line("oba-1", "Detergente Líquido Ype Neutro 500ml", 2.19, "oba", "Oba", "3 dias úteis")];
  const options = [
    opt("carrefour-safi", "Desinfetante Bactericida Safi Líquido Eucalipto 2L", 4.09, "carrefour", "Carrefour", "hoje"),
    opt("oba-bak", "Desinfetante Ypê Bak Floral 500ml", 4.59, "oba", "Oba", "3 dias úteis")
  ];
  const c = await customerWith({ basket, pending: [{ query: "desinfetante", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "o mais barato");
  const after = (await ctxOf(c.convoId)).basket ?? [];
  assert.ok(after.some((i) => i.sku === "oba-bak"), JSON.stringify(after));
  assert.ok(!after.some((i) => i.sku === "carrefour-safi"), JSON.stringify(after));
  assert.match(out, /etiqueta mais baixa é \*Desinfetante Bactericida Safi[\s\S]*somava mais uma entrega[\s\S]*pedido mínimo/, out);
  assert.doesNotMatch(out, /2 entregas/, out);

  // Etiqueta mais baixa já numa loja da cesta: escolha de sempre, sem nota.
  const c2 = await customerWith({ basket, pending: [{ query: "desinfetante", qty: 1, options: [options[1], { ...options[0], sku: "oba-safi", storeKey: "oba", storeLabel: "Oba" }] }] }, "choosing");
  const out2 = await send(c2.phone, "o mais barato");
  assert.ok(((await ctxOf(c2.convoId)).basket ?? []).some((i) => i.sku === "oba-safi"), out2);
  assert.doesNotMatch(out2, /etiqueta mais baixa/, out2);
});

test("2e: 'o mais barato' de prazo longo (9 dias úteis) por centavos não puxa o pedido: fica a que chega antes", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    opt("oba-bandaid9", "Band-aid Transparente Com 10 Unidades", 4.79, "oba", "Oba", "prazo da loja: 9 dias úteis"),
    opt("carrefour-bandaid1", "Curativos Band Aid Transparente 10 Unidades", 5.49, "carrefour", "Carrefour", "prazo da loja: 1 dia útil")
  ];
  const c = await customerWith({ pending: [{ query: "band-aid", qty: 2, qtyExplicit: true, options }] }, "choosing");
  const out = await send(c.phone, "o mais barato");
  assert.equal((await ctxOf(c.convoId)).basket?.[0]?.sku, "carrefour-bandaid1", out);
  assert.match(out, /só chega em \*9 dias úteis\*[\s\S]*chega antes/, out);
  // Diferença grande: a mais barata fica (com o aviso de prazo longo de sempre).
  const far = [options[0], { ...options[1], unitPrice: 19.9 }];
  const c2 = await customerWith({ pending: [{ query: "band-aid", qty: 2, qtyExplicit: true, options: far }] }, "choosing");
  const out2 = await send(c2.phone, "o mais barato");
  assert.equal((await ctxOf(c2.convoId)).basket?.[0]?.sku, "oba-bandaid9", out2);
});

test("2d: o aviso de prazo da vitrine seguinte nomeia o item (não parece ser do que acabou de ser escolhido)", () => {
  const note = copy.choicesDeadlineNote("amanhã", [], { store: "Casa Santa Luzia", promise: "4 dias úteis" }, "sal grosso");
  assert.match(note, /Pra \*amanhã\* não chega: nenhuma opção de \*sal grosso\* entrega a tempo/, note);
  assert.match(copy.choicesDeadlineNote("amanhã", ["Mambo"], undefined, "sal grosso"), /de \*sal grosso\*, chega a tempo só pela \*Mambo\*/);
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: escolher item de loja nova com pedido mínimo avisa o mínimo na hora, junto do frete", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [line("oba-1", "Manteiga com Sal 200g", 14.9, "oba", "Oba", "1 dia útil")];
  const options = [opt("carrefour-pao", "Pão de Forma Tradicional 400g", 6.99, "carrefour", "Carrefour", "hoje")];
  const c = await customerWith({ basket, pending: [{ query: "pão de forma", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "1");
  assert.match(out, /vem da \*Carrefour\*[\s\S]*2 entregas[\s\S]*A \*Carrefour\* tem pedido mínimo de \*R\$ [\d,]+\* — faltam \*R\$ [\d,]+\*/, out);
});

test("3b: juntar que atrasa: sem oferta quando o prazo piora muito por pouca economia ou com prazo dito; em destaque quando sai", () => {
  // Kit de primeiros socorros (306): 1 dia útil → 8 dias úteis para poupar R$ 5,90.
  assert.equal(slowerJoinNotWorth({ slowerByDays: 7, saving: 5.9, keptTotal: 69.3, deadline: false, keptBelowMinimum: false }), true);
  assert.equal(slowerJoinNotWorth({ slowerByDays: 1, saving: 3, keptTotal: 60, deadline: true, keptBelowMinimum: false }), true);
  assert.equal(slowerJoinNotWorth({ slowerByDays: 7, saving: 40, keptTotal: 150, deadline: false, keptBelowMinimum: false }), false, "economia grande: oferta sai");
  assert.equal(slowerJoinNotWorth({ slowerByDays: 7, saving: 2, keptTotal: 60, deadline: false, keptBelowMinimum: true }), false, "manter não fecha o mínimo");
  assert.equal(slowerJoinNotWorth({ slowerByDays: 0, saving: 2, keptTotal: 60, deadline: true, keptBelowMinimum: false }), false, "não atrasa");
  const etaNote = copy.consolidationSlowerNote("prazo da loja: 1 dia útil", "prazo da loja: 8 dias úteis", 5.9);
  assert.match(etaNote, /Atenção ao prazo.*economiza \*R\$ 5,90\*, mas o pedido passa de \*1 dia útil\* para \*8 dias úteis\*/, etaNote);
  const body = copy.consolidationOffer({
    storeLabel: "Farmácia Indiana",
    joinedTotal: 63.4,
    keptTotal: 69.3,
    keptStores: 2,
    pairs: [{ fromName: "Água Oxigenada 10v Ever Care 100ml", fromPrice: 3.95, toName: "Água Oxigenada Triane 100ml", toPrice: 4.39 }],
    joinedEta: "prazo da loja: 8 dias úteis",
    keptEta: "prazo da loja: 1 dia útil",
    etaNote
  });
  const lines = body.split("\n");
  assert.match(lines[1], /Atenção ao prazo/, body);
  assert.ok(body.indexOf("Atenção ao prazo") < body.indexOf("Pra juntar, troco"), body);
});
