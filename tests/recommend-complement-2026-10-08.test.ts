// Complemento no fechamento (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.5, fase 4):
// "quem leva carvão costuma levar pão de alho". Parte PURA (tabela de pares: 1 só, nunca item da cesta,
// nunca recusado, nunca com remédio) e E2E com banco real: cesta com carvão → "só isso" → oferta de pão
// de alho → "sim" entra no total; "não" segue sem; outra mensagem desarma e o próximo "só isso" não
// pergunta de novo; flag desligada não pergunta. RecommendLog com source "complement".
//
// A suíte antiga roda com LIA_RECOMMEND_COMPLEMENT=false (tests/helpers/load-env.ts); aqui liga. Covabra
// (que tem pão de alho na cópia do catálogo e entrega no CEP de teste) liga antes do import do cérebro.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";
import { COMPLEMENT_PAIRS, suggestComplement, type ComplementBasketItem } from "../src/lib/recommend/complement";
import type { ShelfNode } from "../src/lib/recommend/types";

process.env.LIA_ENABLE_COVABRA = "true";

// ---------------------------------------------------------------- puro

const noShelf = () => undefined;
const item = (name: string, extra: Partial<ComplementBasketItem> = {}): ComplementBasketItem => ({ name, sku: name.toLowerCase().replace(/\W+/g, "-"), storeKey: "x", ...extra });

test("tabela tem 40+ pares e cada um aponta pra uma consulta não vazia", () => {
  assert.ok(COMPLEMENT_PAIRS.length >= 40, String(COMPLEMENT_PAIRS.length));
  for (const p of COMPLEMENT_PAIRS) assert.ok(p.query.trim() && p.why.trim() && p.shelfId.trim(), p.trigger);
  assert.ok(!COMPLEMENT_PAIRS.some((p) => /\bgelo\b/.test(p.query)), "gelo não existe nos catálogos");
});

test("pares clássicos", () => {
  const cases: [string, RegExp][] = [
    ["Carvão Vegetal 5kg", /pao de alho/],
    ["Picanha Bovina Resfriada kg", /carvao/],
    ["Macarrão Espaguete Barilla 500g", /molho de tomate/],
    ["Café Pilão Torrado e Moído 500g", /filtro/],
    ["Pão de Forma Seven Boys 450g", /manteiga/],
    ["Ração Pedigree Adulto Carne 10kg", /petisco cachorro/],
    ["Ração Whiskas Gatos Adultos 1kg", /petisco gato/],
    ["Shampoo Seda Ceramidas 325ml", /condicionador/],
    ["Fralda Pampers Confort Sec G 46un", /lenco umedecido/],
    ["Sabão em Pó Omo Lavagem Perfeita 1,6kg", /amaciante/],
    ["Escova de Dente Colgate Classic", /creme dental/],
    ["Vinho Tinto Casillero del Diablo 750ml", /queijo/],
    ["Leite Integral Piracanjuba 1 Litro", /achocolatado/],
    ["Arroz Branco Tipo 1 Camil 1kg", /feijao/],
    ["Pizza Congelada Sadia Calabresa 460g", /refrigerante/]
  ];
  for (const [name, want] of cases) {
    const s = suggestComplement([item(name)], { shelfById: noShelf });
    assert.ok(s, name);
    assert.match(s!.query, want, `${name} → ${s!.query}`);
    assert.ok(s!.why.length > 10);
  }
});

test("nunca oferece o que já está na cesta; passa pro próximo par", () => {
  assert.equal(suggestComplement([item("Carvão Vegetal 5kg"), item("Pão de Alho Santa Massa 400g")], { shelfById: noShelf }), null);
  const s = suggestComplement([item("Macarrão Penne 500g"), item("Molho de Tomate Pomarola 340g"), item("Arroz Tipo 1 5kg")], { shelfById: noShelf });
  assert.match(s!.query, /feijao/);
});

test("recusado nesta conversa não volta", () => {
  const first = suggestComplement([item("Carvão Vegetal 5kg"), item("Arroz 5kg")], { shelfById: noShelf })!;
  assert.match(first.query, /pao de alho/);
  const second = suggestComplement([item("Carvão Vegetal 5kg"), item("Arroz 5kg")], { shelfById: noShelf, recentlyDeclined: [first.query, first.shelfId] });
  assert.match(second!.query, /feijao/);
});

test("remédio na cesta: nunca complementa (nem o resto)", () => {
  assert.equal(suggestComplement([item("Carvão Vegetal 5kg"), item("Dipirona 500mg 10 comprimidos", { medicine: "mip" })], { shelfById: noShelf }), null);
  assert.equal(suggestComplement([item("Arroz 5kg"), item("Neosaldina 20 drágeas")], { shelfById: noShelf }), null);
  // Prateleira de remédio nunca é o complemento.
  const mipShelf = (id: string): ShelfNode | undefined => (id === "padaria.pao_de_alho" ? { id, label: "x", domain: "farmacia", query: "x", stores: [], flags: ["mip"] } : undefined);
  assert.equal(suggestComplement([item("Carvão Vegetal 5kg")], { shelfById: mipShelf }), null);
});

test("uma sugestão só, determinística; cesta sem par = nada", () => {
  const basket = [item("Carvão Vegetal 5kg"), item("Macarrão 500g"), item("Shampoo Seda 325ml")];
  const a = suggestComplement(basket, { shelfById: noShelf });
  const b = suggestComplement(basket, { shelfById: noShelf });
  assert.deepEqual(a, b);
  assert.equal(typeof a!.query, "string");
  assert.equal(suggestComplement([item("Lâmpada LED 9W")], { shelfById: noShelf }), null);
  assert.equal(suggestComplement([], { shelfById: noShelf }), null);
  // Gatilho com exceção: leite condensado não é leite.
  assert.notEqual(suggestComplement([item("Leite Condensado Moça 395g")], { shelfById: noShelf })?.query, "achocolatado");
});

// ---------------------------------------------------------------- E2E

type Brain = typeof import("../src/lib/delivery-service");
let brain: Brain;
let prisma: typeof import("../src/lib/prisma").prisma;
let copy: typeof import("../src/lib/lia-copy");

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5511${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];

const CARVAO: BasketItem = { sku: "TEST-CARVAO-5KG", name: "Carvão Vegetal Churrasco 5kg", qty: 1, unitPrice: 40, lineTotal: 40, storeKey: "covabra", storeLabel: "Covabra" };

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await brain.runTurnScoped(() => brain.handleDeliveryMessage({ phone, text, messageId: `reccomp_${RUN}_${++seq}` }));
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  if (process.env.SHOW_TRANSCRIPT) console.log(`> ${text}\n${out}\n`);
  return out;
}
// Cliente cadastrado com a cesta já montada (carvão) e o endereço confirmado.
async function withBasket(basket: BasketItem[] = [CARVAO], extra: Partial<DeliveryContext> = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, name: "Maria da Silva", cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  const ctx: DeliveryContext = { flow: "delivery", step: "collecting", basket, cep: "01310100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...extra };
  await prisma.conversation.create({ data: { id: `conv_${user.id}`, userId: user.id, status: "active", currentStep: "delivery", context: JSON.stringify(ctx) } });
  return { phone, userId: user.id };
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
const offerRe = /Quem leva carv[ãa]o costuma levar p[ãa]o de alho/;
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.recommendLog.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  brain = await import("../src/lib/delivery-service");
  ({ prisma } = await import("../src/lib/prisma"));
  copy = await import("../src/lib/lia-copy");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
    if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
    (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
      outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
      return key === "sendDeliveryChoices" || key === "sendChoiceFollowUp" ? false : { provider: "test", to };
    };
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
beforeEach(() => {
  process.env.LIA_RECOMMEND_COMPLEMENT = "true";
});
after(async () => {
  process.env.LIA_RECOMMEND_COMPLEMENT = "false";
  if (dbOk) await wipe();
  await prisma?.$disconnect();
});

test("E2E: carvão → 'só isso' → oferta de pão de alho → 'sim' → entra na cesta e no total", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await withBasket();
  const offer = await send(phone, "só isso");
  assert.match(offer, offerRe, offer);
  assert.match(offer, /Responde \*sim\* ou \*não\*/);
  const ctx = await ctxOf(phone);
  assert.ok(ctx.complementOffer, "oferta na mesa");
  assert.match(ctx.complementOffer!.option.name, /p[ãa]o de alho/i);
  assert.equal(ctx.basket?.length, 1, "ainda não entrou");
  const log = await prisma.recommendLog.findFirstOrThrow({ where: { phone } });
  assert.equal(log.source, "complement");
  assert.equal(log.outcome, "shown");

  const name = ctx.complementOffer!.option.name;
  const total = await send(phone, "sim");
  assert.ok(total.includes(copy.complementAdded(name)), total);
  assert.doesNotMatch(total, offerRe, "não pergunta de novo");
  assert.match(total, /1x P[ãa]o de Alho/i, "o resumo do fechamento lista o pão de alho");
  assert.equal((await ctxOf(phone)).complementOffer, undefined);
  // O fechamento seguiu: o pedido (aqui, para conferência) leva os dois itens.
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
  const items = order.items as unknown as BasketItem[];
  assert.ok(items.some((i) => /p[ãa]o de alho/i.test(i.name)), "o pedido inclui o pão de alho");
  assert.ok(items.some((i) => i.sku === CARVAO.sku));
  const accepted = await prisma.recommendLog.findFirstOrThrow({ where: { phone } });
  assert.equal(accepted.outcome, "accepted");
  assert.ok(accepted.chosenSku);
});

test("E2E: carvão → 'só isso' → 'não' → total sem o pão de alho; log declined", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await withBasket();
  assert.match(await send(phone, "só isso"), offerRe);
  const total = await send(phone, "não");
  assert.doesNotMatch(total, offerRe);
  const ctx = await ctxOf(phone);
  assert.ok(ctx.complementDeclined?.includes("pao de alho"));
  assert.doesNotMatch(total, /P[ãa]o de Alho/i);
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
  assert.deepEqual((order.items as unknown as BasketItem[]).map((i) => i.sku), [CARVAO.sku], `seguiu pro fechamento sem o pão: ${total.slice(0, 200)}`);
  assert.equal((await prisma.recommendLog.findFirstOrThrow({ where: { phone } })).outcome, "declined");
});

test("E2E: outra mensagem desarma a oferta e o próximo 'só isso' (mesmo pedido) não pergunta de novo", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await withBasket();
  assert.match(await send(phone, "só isso"), offerRe);
  await send(phone, "hmm deixa eu pensar aqui");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.complementOffer, undefined);
  assert.ok(ctx.complementAsked?.skus.includes(CARVAO.sku));
  const again = await send(phone, "só isso");
  assert.doesNotMatch(again, offerRe, again);
  assert.equal(await prisma.recommendLog.count({ where: { phone } }), 1, "uma oferta só");
});

test("E2E: flag desligada não pergunta; remédio na cesta não pergunta", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_RECOMMEND_COMPLEMENT = "false";
  const off = await withBasket();
  const out = await send(off.phone, "só isso");
  assert.doesNotMatch(out, offerRe);
  assert.equal((await ctxOf(off.phone)).complementOffer, undefined);
  assert.equal(await prisma.recommendLog.count({ where: { phone: off.phone } }), 0);
  process.env.LIA_RECOMMEND_COMPLEMENT = "true";
  const med = await withBasket([CARVAO, { sku: "TEST-DIPI", name: "Dipirona 500mg 10 comprimidos", qty: 1, unitPrice: 8, lineTotal: 8, storeKey: "drogariasp", storeLabel: "Drogaria SP", medicine: "mip" }]);
  const medOut = await send(med.phone, "só isso");
  assert.doesNotMatch(medOut, offerRe);
});
