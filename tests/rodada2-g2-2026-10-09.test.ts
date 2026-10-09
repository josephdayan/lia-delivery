// Rodada 2, grupo G2 (09/10): oferta de juntar sem a loja confirmar, queixa de demora virando item, complemento
// fora de categoria, troca por "outra marca", aviso de remédio sem remédio tirado, "mais barato" dentro do item
// e empate de preço na escolha.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, someRequestDropped } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { isWaitGripe } from "../src/lib/lia-intents";
import { onboardingNote } from "../src/lib/address-parse";
import { suggestComplement } from "../src/lib/recommend/complement";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5574${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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

async function item(query: string, store: string, qty: number, nameRe: RegExp): Promise<BasketItem> {
  const c = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).find((x) => x.store.key === store && nameRe.test(x.item.name));
  assert.ok(c, `catálogo de teste sem ${query} em ${store}`);
  return { sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, qty, unitPrice: c!.item.unitPrice, lineTotal: Math.round(c!.item.unitPrice * qty * 100) / 100, storeKey: store, storeLabel: c!.store.label, productUrl: c!.item.productUrl };
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
after(async () => {
  __setPreflightForTests(null);
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
  await handleDeliveryMessage({ phone, text, messageId: `g2_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}

// 1) Oferta de juntar -------------------------------------------------------------------------------
async function twoStoreBasket() {
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const coca = await item("refrigerante coca cola sem acucar lata", "oba", 2, /Sem Açúcar Lata/i);
  return [leite, arroz, coca];
}

test("juntar: a loja recusa a cesta junta → a oferta nem é feita e a cesta original fica", async (t) => {
  if (!dbOk) return t.skip();
  __setPreflightForTests(async (items) => ({ storeKey: items[0].storeKey, kind: "item-unavailable", skus: items.map((i) => i.sku) }));
  try {
    const c = await customerWith({ basket: await twoStoreBasket() });
    const out = await send(c.phone, "só isso");
    assert.doesNotMatch(out, /Dá pra juntar|Juntei tudo/, out.slice(0, 500));
    assert.doesNotMatch(out, /Não tenho estes itens/, out.slice(0, 500));
    const ctx = await ctxOf(c.convoId);
    assert.equal(ctx.consolidationOffer, undefined);
  } finally {
    __setPreflightForTests(null);
  }
});

test("juntar: 'ok' solto não escolhe entre juntar e manter; 'juntar' aceita", async (t) => {
  if (!dbOk) return t.skip();
  __setPreflightForTests(async () => null);
  try {
    const c = await customerWith({ basket: await twoStoreBasket() });
    const offer = await send(c.phone, "só isso");
    assert.match(offer, /Dá pra juntar tudo/, offer.slice(0, 500));
    const vague = await send(c.phone, "ok");
    assert.match(vague, /juntar\* ou \*manter/, vague.slice(0, 400));
    assert.doesNotMatch(vague, /Juntei tudo/);
    assert.ok((await ctxOf(c.convoId)).consolidationOffer, "a oferta continua na mesa");
    const joined = await send(c.phone, "juntar");
    assert.match(joined, /Juntei tudo/, joined.slice(0, 400));
  } finally {
    __setPreflightForTests(null);
  }
});

// 2) Queixa de demora nunca vira item ------------------------------------------------------------------
test("queixa de demora sem produto: nunca é item", () => {
  for (const t of ["que demora", "vcs são lentos", "que lerdeza", "tá demorando", "muito lento"]) {
    assert.ok(isWaitGripe(t), t);
    assert.equal(onboardingNote(t).text, "", t);
  }
  for (const t of ["quanto tempo demora?", "qual o prazo", "quando chega", "leite 2 litros"]) assert.equal(isWaitGripe(t), false, t);
  assert.equal(onboardingNote("2 shampoos e um café, que demora").text.includes("demora"), false);
});

test("'que demora' antes do endereço: pede desculpa e não entra na lista", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await send(phone, "oi quero 2 shampoos e um pacote de cafe");
  const out = await send(phone, "que demora");
  assert.match(out, /Desculpa a espera/, out);
  assert.doesNotMatch(out, /que demora/i);
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  assert.doesNotMatch(convo.context ?? "", /que demora/i);
});

// 3) Complemento respeita a categoria -------------------------------------------------------------------
test("complemento: ração 'Carne e Arroz' não pede feijão; petisco não é oferecido a quem já tem petisco", () => {
  const opts = { shelfById: () => null };
  const racao = { sku: "a", name: "Ração GranPlus Menu Carne e Arroz para Cães Adultos de porte Médio e Grande 3 kg" };
  const sug = suggestComplement([racao], opts);
  assert.notEqual(sug?.trigger, "arroz");
  assert.ok(!sug || sug.shelfId.startsWith("pet."), JSON.stringify(sug));
  assert.equal(suggestComplement([racao, { sku: "b", name: "Petisco Dentastix Cuidado Oral para Cães Raças Pequenas" }], opts), null);
  assert.equal(suggestComplement([racao, { sku: "c", name: "Petisco Joy Beef Carne para Cães 65 g" }], opts), null);
  // item humano continua com o complemento de sempre
  assert.equal(suggestComplement([{ sku: "d", name: "Arroz Branco Swift 1kg" }], opts)?.trigger, "arroz");
});

// 4) Trocar por outra marca substitui -------------------------------------------------------------------
test("'troca a ração por outra marca': tira a atual, mostra outras marcas e a escolhida substitui", async (t) => {
  if (!dbOk) return t.skip();
  const cands = await gatherCrossStoreCandidates("racao cachorro adulto", 40, 4, { noLongTail: true });
  const first = cands.find((x) => /ra[cç][aã]o/i.test(x.item.name));
  if (!first) return t.skip("sem ração com marca no catálogo de teste");
  const racao: BasketItem = { sku: first.item.sku, name: first.item.name, brand: first.item.brand, qty: 1, unitPrice: first.item.unitPrice, lineTotal: first.item.unitPrice, storeKey: first.store.key, storeLabel: first.store.label, ask: "ração cachorro adulto" };
  const c = await customerWith({ basket: [racao] });
  const out = await send(c.phone, "troca a ração por outra marca");
  assert.doesNotMatch(out, /não achei em nenhuma loja|Qual marca/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.pending?.[0]?.options?.length, "mostra opções");
  assert.ok(ctx.pending[0].options.every((o: ChoiceOption) => o.sku !== racao.sku), "não repete a atual");
  assert.equal((ctx.basket ?? []).length, 0, "a atual saiu");
  await send(c.phone, "1");
  const after = await ctxOf(c.convoId);
  assert.equal((after.basket ?? []).length, 1, "uma ração só, não duas");
  assert.notEqual(after.basket[0].sku, racao.sku);
});

// 5) Aviso de remédio concorda com a cesta -----------------------------------------------------------------
test("aviso de remédio só vale se algum pedido saiu de verdade da lista", () => {
  const requested = ["fralda pampers tam M", "lenço umedecido", "pomada pra assadura"];
  assert.equal(someRequestDropped(requested, ["fralda pampers tam M", "lenço umedecido", "pomada para assadura"]), false, "pomada ficou na lista");
  assert.equal(someRequestDropped(requested, ["fralda pampers tam M", "lenço umedecido"]), true, "pomada saiu");
});

// 6) "mais barato" dentro do item ----------------------------------------------------------------------------
test("'troca o lenço pelo mais barato': o mais barato do mesmo item, sem sub-tipo (íntimo) que o atual não tinha", async (t) => {
  if (!dbOk) return t.skip();
  const cands = await gatherCrossStoreCandidates("lenco umedecido", 40, 4, { noLongTail: true });
  const cur = cands.filter((x) => /len[cç]os? umedecidos?/i.test(x.item.name) && !/[ií]ntim/i.test(x.item.name)).sort((a, b) => b.item.unitPrice - a.item.unitPrice)[0];
  if (!cur) return t.skip("sem lenço no catálogo de teste");
  const lenco: BasketItem = { sku: cur.item.sku, name: cur.item.name, qty: 1, unitPrice: cur.item.unitPrice, lineTotal: cur.item.unitPrice, storeKey: cur.store.key, storeLabel: cur.store.label, ask: "lenço umedecido" };
  const c = await customerWith({ basket: [lenco] });
  const out = await send(c.phone, "troca o lenço pelo mais barato");
  assert.doesNotMatch(out, /[ií]ntim/i, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  for (const o of (ctx.pending?.[0]?.options ?? []) as ChoiceOption[]) assert.doesNotMatch(o.name, /[ií]ntim/i);
  for (const b of (ctx.basket ?? []) as BasketItem[]) assert.doesNotMatch(b.name, /[ií]ntim/i);
});

// 7) Empate de preço na escolha -----------------------------------------------------------------------------
test("'pode ser o mais baratinho' com empate: escolhe a de melhor relevância e diz que estavam empatadas", async (t) => {
  if (!dbOk) return t.skip();
  const opt = (sku: string, name: string, unitPrice: number): ChoiceOption => ({ sku, name, unitPrice, storeKey: "carrefour", storeLabel: "Carrefour" });
  const options = [opt("t-1", "Papel Higiênico Deluxe 12 Rolos", 12), opt("t-2", "Papel Higiênico Neve 4 Rolos", 14), opt("t-3", "Papel Higiênico Sublime 12 Un", 11), opt("t-4", "Papel Higiênico Fofinho 30m", 12), opt("t-5", "Papel Higiênico Personal 12 Un", 11)];
  const c = await customerWith({ pending: [{ query: "papel higiênico", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "pode ser o mais baratinho");
  assert.doesNotMatch(out, /a 1 ou a 5/i, out.slice(0, 400));
  assert.match(out, /empatadas/, out.slice(0, 500));
  assert.match(out, /Sublime/, out.slice(0, 500));
  assert.match(copy.cheapestTieNote([1, 5], 13.19, 1), /opções 1 e 5 estavam empatadas em R\$ ?13,19/);
});
