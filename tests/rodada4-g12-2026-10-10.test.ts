// Rodada 4, grupo G12 (10/10): recusa da oferta de juntar com outras palavras, "mais barato" que ignora o
// carrossel mostrado, escolha + item novo no carrossel, volta atrás sem marca, "mais em conta" sem alvo
// com 2+ itens e desistência total com outras palavras.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, sameSubtypeForCheaper } from "../src/lib/delivery-service";
import { isKeepSeparateReply, isExplicitClearAll } from "../src/lib/lia-intents";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5576${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `g12_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}

// A1) Recusa da oferta de juntar = manter separado ----------------------------------------------------
async function twoStoreBasket() {
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const coca = await item("refrigerante coca cola sem acucar lata", "oba", 2, /Sem Açúcar Lata/i);
  return [leite, arroz, coca];
}

for (const refusal of ["prefiro deixar separado mesmo", "não, deixa como está", "quero manter separado", "não quero juntar, manda separado", "não", "nao precisa, obrigado"]) {
  test(`juntar: recusa "${refusal}" mantém separado com o resumo`, async (t) => {
    if (!dbOk) return t.skip();
    __setPreflightForTests(async () => null);
    try {
      const basket = await twoStoreBasket();
      const c = await customerWith({ basket });
      const offer = await send(c.phone, "só isso");
      assert.match(offer, /Dá pra juntar tudo/, offer.slice(0, 500));
      const out = await send(c.phone, refusal);
      assert.match(out, /mantenho as 2 lojas/, out.slice(0, 600));
      assert.match(out, /Total/, out.slice(0, 600));
      assert.doesNotMatch(out, /não achei|Não achei esse item|Me diz de outro jeito|Você prefere/i, out.slice(0, 600));
      const ctx = await ctxOf(c.convoId);
      assert.equal(ctx.consolidationOffer, undefined);
      // A cesta segue nas 2 lojas (fechou o pedido com as mesmas linhas).
      const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
      const lines = ((ctx.basket ?? ((order?.items as unknown as BasketItem[]) ?? [])) as BasketItem[]).map((i) => `${i.sku}x${i.qty}`).sort();
      assert.deepEqual(lines, basket.map((i) => `${i.sku}x${i.qty}`).sort());
    } finally {
      __setPreflightForTests(null);
    }
  });
}

test("isKeepSeparateReply: recusa é manter; aceite e pedido de item no meio não", () => {
  for (const s of ["prefiro deixar separado mesmo", "não, deixa como está", "quero manter separado", "não quero juntar, manda separado", "não", "nao precisa, obrigado", "melhor não", "pode deixar assim mesmo", "sem juntar"]) assert.equal(isKeepSeparateReply(s), true, s);
  for (const s of ["juntar", "sim, juntar na Mambo", "pode juntar", "não, quero manteiga também", "e uma coca", "manteiga", "ok"]) assert.equal(isKeepSeparateReply(s), false, s);
});

// A3) Carrossel aberto + "o desnatado, e um pacote de bolacha maizena": escolhe/refina o leite e soma a bolacha -----
async function leiteOptions() {
  const cands = await gatherCrossStoreCandidates("leite", 40, 4, { noLongTail: true });
  const pick = (re: RegExp) => cands.find((c) => re.test(c.item.name));
  const chosen = [pick(/semidesnatad/i), pick(/integral/i), pick(/\bdesnatad/i)].filter(Boolean);
  assert.ok(chosen.length >= 2, "catálogo de teste sem leites");
  return chosen.map((c) => ({ sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, unitPrice: c!.item.unitPrice, storeKey: c!.store.key, storeLabel: c!.store.label }));
}

test("carrossel de leite aberto: 'o desnatado, e um arroz camil' responde ao leite e soma o arroz", async (t) => {
  if (!dbOk) return t.skip();
  const deterg = bi("deterg-1", "Detergente Líquido Ype Neutro 500ml", 3.84, { ask: "detergente" });
  const c = await customerWith({ basket: [deterg], pending: [{ query: "leite", qty: 1, options: await leiteOptions() }] }, "choosing");
  const out = await send(c.phone, "o desnatado, e um arroz camil");
  t.diagnostic(out.slice(0, 800));
  assert.doesNotMatch(out, /Comecei uma lista nova|deixei de fora|Somei \*1x o desnatado/i, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const basketNames = (ctx.basket ?? []).map((b: BasketItem) => b.name).join(" | ");
  const pendingQ = (ctx.pending ?? []).map((p: { query: string }) => p.query).join(" | ");
  assert.match(basketNames, /Detergente/, "a cesta ficou");
  assert.match(`${basketNames} | ${pendingQ}`, /arroz/i, "o arroz entrou");
  assert.match(`${basketNames} | ${pendingQ}`, /leite|desnatad/i, "o leite segue (escolhido ou na mesa)");
  assert.doesNotMatch(pendingQ, /o desnatado/i, "'o desnatado' não vira item");
});

// A2) "troca por um mais barato": mais barato só em outro tamanho não é "já está o mais barato" -------------------
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", ...extra
});

test("sameSubtypeForCheaper: corporal é a zona padrão; facial continua separando", () => {
  assert.equal(sameSubtypeForCheaper("Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", "Protetor Solar Corporal FPS 30 Basic + Care 100ml"), true);
  assert.equal(sameSubtypeForCheaper("Protetor Solar Facial Nivea FPS 30 40ml", "Protetor Solar Corporal FPS 30 Basic + Care 100ml"), false);
  assert.equal(sameSubtypeForCheaper("Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", "Protetor Solar Facial Acnezil FPS 30 60g"), false);
});

test("'troca o protetor por um mais barato' com mais barato só em outro tamanho: mostra as opções e avisa", async (t) => {
  if (!dbOk) return t.skip();
  const cur = bi("cur-sundown", "Protetor Solar FPS 30 Sundown Praia e Piscina 777ml", 499.9, { ask: "protetor solar fps 30" });
  const c = await customerWith({ basket: [cur] });
  const out = await send(c.phone, "troca o protetor por um mais barato");
  assert.doesNotMatch(out, /já está o mais barato que achei: \*Protetor Solar FPS 30 Sundown/, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  const pend = ctx.pending?.[0];
  assert.ok(pend, out.slice(0, 500));
  assert.match(out, /outro tamanho/i, out.slice(0, 500));
  assert.equal(pend.replaceSku, "cur-sundown");
  assert.ok((ctx.basket ?? []).some((b: BasketItem) => b.sku === "cur-sundown"), "o atual fica até escolher");
  for (const o of pend.options) assert.ok(o.unitPrice < 499.9);
  await send(c.phone, "1");
  const after = await ctxOf(c.convoId);
  assert.ok(!(after.basket ?? []).some((b: BasketItem) => b.sku === "cur-sundown"), "a escolha substitui");
  assert.equal((after.basket ?? []).length, 1);
});

// M3) Desistência total com outras palavras encerra a escolha pendente -------------------------------------------------
test("isExplicitClearAll: 'melhor deixar, não preciso de mais nada disso, obrigado' é desistência total; 'não quero mais nada' segue sendo fim de lista", () => {
  for (const s of ["melhor deixar, não preciso de mais nada disso, obrigado", "deixa pra lá, não quero mais nada", "deixa, não quero nada disso, valeu", "não quero mais nada disso"]) assert.equal(isExplicitClearAll(s), true, s);
  for (const s of ["não quero mais nada", "não preciso de mais nada, obrigado", "só isso, obrigado", "deixa o leite"]) assert.equal(isExplicitClearAll(s), false, s);
});

test("lista em escolha + 'melhor deixar, não preciso de mais nada disso, obrigado': nada fica pendente", async (t) => {
  if (!dbOk) return t.skip();
  const leites = await catalogOptions("leite integral", /leite/i, 2);
  const paes = await catalogOptions("pão de forma", /p[aã]o/i, 2);
  const manteigas = await catalogOptions("manteiga", /manteiga/i, 2);
  const c = await customerWith(
    { pending: [{ query: "leite integral", qty: 1, options: leites }, { query: "pão de forma", qty: 1, options: paes }, { query: "manteiga", qty: 1, options: manteigas }] },
    "choosing"
  );
  const out = await send(c.phone, "melhor deixar, não preciso de mais nada disso, obrigado");
  assert.doesNotMatch(out, /Deixei \*leite integral\* de fora|Tirei manteiga/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.pending ?? []).length, 0, out.slice(0, 400));
  assert.equal((ctx.basket ?? []).length, 0);
});

// M2) "mais em conta" sem nome com 2+ itens pergunta qual; volta atrás sem marca recupera o item anterior -------------
async function catalogOptions(query: string, re: RegExp, n: number) {
  const cands = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).filter((c) => re.test(c.item.name)).slice(0, n);
  assert.ok(cands.length >= n, `catálogo de teste sem ${query}`);
  return cands.map((c) => ({ sku: c.item.sku, name: c.item.name, brand: c.item.brand, unitPrice: c.item.unitPrice, storeKey: c.store.key, storeLabel: c.store.label }));
}
const asItem = (o: { sku: string; name: string; unitPrice: number; storeKey: string; storeLabel: string }, ask: string): BasketItem => ({ ...o, qty: 1, lineTotal: o.unitPrice, ask });

test("'tem um mais em conta?' sem nome com 2 itens: pergunta qual; 'o protetor' mexe só no protetor", async (t) => {
  if (!dbOk) return t.skip();
  const [prot] = await catalogOptions("protetor solar", /protetor/i, 1);
  const fraldas = await catalogOptions("fralda", /fralda/i, 2);
  const protItem = asItem(prot, "protetor solar");
  const fraldaItem = asItem(fraldas[1], "fralda");
  const c = await customerWith({
    basket: [protItem, fraldaItem],
    lastChoice: { query: "fralda", qty: 1, options: fraldas, chosenSku: fraldaItem.sku }
  });
  const ask = await send(c.phone, "tem um mais em conta?");
  assert.match(ask, /De qual item/, ask.slice(0, 400));
  let ctx = await ctxOf(c.convoId);
  assert.ok(ctx.cheaperAsk);
  assert.equal(ctx.pending, undefined, "nenhuma escolha reaberta sem saber o item");
  const out = await send(c.phone, "o protetor");
  assert.doesNotMatch(out, /De qual item/, out.slice(0, 400));
  ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b: BasketItem) => b.sku === fraldaItem.sku), "a fralda não foi tocada");
  assert.ok(!(ctx.pending ?? []).some((p: { query: string }) => /fralda/i.test(p.query)), "a fralda não foi reaberta");
});

test("escolha reaberta que substitui a fralda: 'não, quero a fralda de antes' volta a anterior", async (t) => {
  if (!dbOk) return t.skip();
  const [prot] = await catalogOptions("protetor solar", /protetor/i, 1);
  const fraldas = await catalogOptions("fralda", /fralda/i, 2);
  const old = asItem(fraldas[0], "fralda");
  const c = await customerWith(
    { basket: [asItem(prot, "protetor solar"), old], pending: [{ query: "fralda", qty: 1, qtyExplicit: true, options: fraldas, replaceSku: old.sku }] },
    "choosing"
  );
  await send(c.phone, "2");
  let ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b: BasketItem) => b.sku === fraldas[1].sku), "a nova entrou");
  assert.ok(!(ctx.basket ?? []).some((b: BasketItem) => b.sku === old.sku), "a antiga saiu");
  const out = await send(c.phone, "não, quero a fralda de antes");
  assert.doesNotMatch(out, /já é o que está na sua cesta/i, out.slice(0, 400));
  ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b: BasketItem) => b.sku === old.sku), out.slice(0, 400));
  assert.ok(!(ctx.basket ?? []).some((b: BasketItem) => b.sku === fraldas[1].sku), "a do meio saiu");
});
