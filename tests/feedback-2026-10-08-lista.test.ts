// Teste do dono com a lista (08/10/2026, "deu tudo errado"): (1) "falou que não tinha gin e tinha" —
// 4 linhas disparavam ~150 chamadas às lojas de uma vez e todas as buscas ao vivo do "gin" estouravam
// o timeout (a Mambo sozinha responde em 0,8 s); (2) "mandou os cards e também a lista" — a mesma
// lista chegou duas vezes em 23 s (reenvio enquanto o 1º turno buscava) e o 2º turno virou edição com
// três carrosséis; (3) "falou que o pedido tava cancelado" — quem parou na compra ontem e hoje pede
// outra coisa só quer a coisa nova: nada de "cancelei por inatividade", nada de fundir.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { storeSlotsInFlight, withStoreSlot } from "../src/lib/store-throttle";
import { __clearLiveSearchCacheForTests, liveSearchItems, type LiveFetch } from "../src/lib/stores/live-search";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5573${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
adapter.sendDeliveryCarousel = async () => null;
adapter.sendDeliveryChoices = async (to: string, choices: { id: string; name: string; displayPrice: number }[]) => {
  outbox.push({ to, text: choices.map((c, i) => `*${i + 1})* ${c.name} — R$ ${c.displayPrice.toFixed(2)}`).join("\n") });
  return { messageId: "choices" };
};
adapter.sendChoiceFollowUp = async (to: string, body: string) => {
  outbox.push({ to, text: body });
  return { messageId: "followup" };
};

const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) return new Response("", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

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
afterEach(() => {
  delete process.env.LIA_STORE_FETCH_CONCURRENCY;
  delete process.env.LIA_LIVE_SEARCH_TIMEOUT_MS;
});
after(async () => {
  if (dbOk) await wipe();
  global.fetch = realFetch;
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customer(): Promise<{ phone: string; userId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return { phone, userId: user.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `l08_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(userId: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}") as { step?: string; deliveryOrderId?: string; basket?: { name: string }[]; pending?: { query: string }[] };
}
async function setCtx(userId: string, ctx: Record<string, unknown>) {
  await prisma.conversation.upsert({
    where: { id: `conv_${userId}` },
    update: { context: JSON.stringify(ctx), status: "active" },
    create: { id: `conv_${userId}`, userId, status: "active", currentStep: "delivery", context: JSON.stringify(ctx) }
  });
}
const baseCtx = { flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true };
const ITEMS = [{ sku: "CRF-BEB-054", name: "Gin London Dry Tanqueray Garrafa 750ml", qty: 1, unitPrice: 125.89, lineTotal: 125.89, storeKey: "carrefour", storeLabel: "Carrefour" }];

// Total na mesa (cotação instantânea publicada) há `minutesAgo` minutos.
async function quoteOnTable(c: { phone: string; userId: string }, minutesAgo: number) {
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: c.userId,
      conversationId: `conv_${c.userId}`,
      phone: c.phone,
      storeKey: "carrefour",
      storeLabel: "Carrefour",
      status: "awaiting_quote_confirmation",
      items: ITEMS,
      itemsSubtotal: 125.89,
      deliveryFee: 15.9,
      serviceFee: 12.59,
      total: 154.38,
      cep: "01310-100",
      deliveryAddress: ADDRESS,
      courierKey: "retailer_delivery",
      quoteExpiresAt: new Date(Date.now() + 60 * 60_000),
      notes: "Cotação instantânea (vitrine, entrega pelo site)."
    }
  });
  await setCtx(c.userId, { ...baseCtx, step: "awaiting_quote_confirmation", deliveryOrderId: order.id, basket: ITEMS });
  // Prisma regrava updatedAt em todo update: o relógio da cotação só envelhece por SQL.
  await prisma.$executeRaw`UPDATE "DeliveryOrder" SET "updatedAt" = NOW() - (${minutesAgo} || ' minutes')::interval WHERE id = ${order.id}`;
  return order;
}

// ---------- (1) fila de chamadas às lojas ----------

test("08/10: a fila limita as chamadas simultâneas às lojas e entrega o slot de mão em mão", async () => {
  process.env.LIA_STORE_FETCH_CONCURRENCY = "2";
  let peak = 0;
  const done: number[] = [];
  const job = (i: number) =>
    withStoreSlot(async () => {
      peak = Math.max(peak, storeSlotsInFlight());
      await new Promise((r) => setTimeout(r, 15));
      done.push(i);
    });
  await Promise.all([1, 2, 3, 4, 5, 6].map(job));
  assert.equal(peak, 2, `pico de ${peak} chamadas em voo`);
  assert.equal(done.length, 6);
  assert.equal(storeSlotsInFlight(), 0, "fila vazia no fim");
  // Erro dentro do slot também libera.
  await assert.rejects(withStoreSlot(async () => Promise.reject(new Error("loja caiu"))));
  assert.equal(storeSlotsInFlight(), 0);
});

test("08/10: o timeout da busca ao vivo conta da SAÍDA da fila — 5 lojas lentas numa fila de 1 respondem todas (antes: todas estouravam)", async () => {
  __clearLiveSearchCacheForTests();
  process.env.LIA_STORE_FETCH_CONCURRENCY = "1";
  process.env.LIA_LIVE_SEARCH_TIMEOUT_MS = "500";
  const stores = ["mambo", "covabra", "santaluzia", "swift", "americanas"];
  const product = (key: string) => ({
    productName: `Gin ${key}`,
    brand: "Apogee",
    link: `/gin-${key}/p`,
    categories: ["/Bebidas/Destilados/Gin/"],
    items: [{ itemId: "6693", name: `Gin ${key} 1L`, images: [{ imageUrl: "https://x/y.jpg" }], sellers: [{ sellerId: "1", commertialOffer: { Price: 45.99, AvailableQuantity: 3 } }] }]
  });
  // Cada loja demora 300 ms: em fila de 1 a 5ª só SAI aos ~1,2 s — bem depois do timeout de 500 ms
  // contado da chegada; contado da saída, todas passam. O signal chega abortado se o relógio
  // começou antes da hora.
  const slow: LiveFetch = async (url, init) => {
    const key = stores.find((s) => url.includes(s)) ?? "?";
    await new Promise((r) => setTimeout(r, 300));
    if (init.signal.aborted) throw new Error(`timeout em ${key}`);
    return { ok: true, json: async () => ({ products: [product(key)] }) };
  };
  const started = Date.now();
  const results = await Promise.all(stores.map((key) => liveSearchItems(key, "gin", 12, slow)));
  assert.ok(Date.now() - started >= 1400, "a fila de 1 serializa as 5 chamadas");
  results.forEach((items, i) => {
    assert.equal(items.length, 1, `${stores[i]} sem resultado (estourou o timeout na fila)`);
    assert.match(items[0].name, /^Gin /);
  });
});

// ---------- (2) lista reenviada ----------

test("08/10: a mesma lista reenviada em segundos não refaz a busca (o 1º turno já respondeu); minutos depois volta a valer", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const list = "2 leites, arroz e feijão";
  const first = await send(c.phone, list);
  assert.ok(first.length > 0, "o 1º envio responde");
  const ctxBefore = JSON.stringify(await ctxOf(c.userId));

  const again = await send(c.phone, list);
  // Rodada 2 (09/10): o reenvio não refaz a busca, mas também não fica mudo — reapresenta onde a conversa parou.
  assert.match(again, /Já tinha recebido isso|Já estou nisso/, `o reenvio idêntico tem que avisar, respondeu: ${again.slice(0, 200)}`);
  assert.equal(JSON.stringify(await ctxOf(c.userId)), ctxBefore, "o reenvio não mexe no contexto");

  // 5 min depois não é impaciência: é pedido de novo.
  await prisma.$executeRaw`UPDATE "Message" SET "createdAt" = NOW() - INTERVAL '5 minutes' WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId" = ${c.userId})`;
  const later = await send(c.phone, list);
  assert.ok(later.length > 0, "a lista reenviada 5 min depois é processada");
});

test("08/10: mensagem curta repetida ('ok', número) NÃO é dedupe — só pedido de produto", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await send(c.phone, "quero 2 cocas");
  const a = await send(c.phone, "1");
  const b = await send(c.phone, "1");
  assert.ok(a.length > 0);
  assert.ok(b.length > 0, "'1' repetido continua tendo resposta");
});

// ---------- (3) pedido parado + pedido novo ----------

test("08/10: total na mesa há 20 min + 'preciso de um shampoo' = pedido NOVO em silêncio (sem 'cancelei', sem fundir)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const old = await quoteOnTable(c, 20);
  const out = await send(c.phone, "preciso de um shampoo");
  assert.doesNotMatch(out, /[Cc]ancelei|inatividade/, `anunciou o cancelamento: ${out.slice(0, 300)}`);
  assert.doesNotMatch(out, /total anterior não vale|Atualizei seu pedido/, `fundiu com o pedido velho: ${out.slice(0, 300)}`);
  assert.doesNotMatch(out, /juntar|pedido novo\?/i, `perguntou: ${out.slice(0, 300)}`);
  assert.match(out, /opç|shampoo/i, `não buscou o item novo: ${out.slice(0, 400)}`);
  assert.doesNotMatch(out, /[Gg]in /, "o gin do pedido velho não aparece no resumo novo");
  const after = await prisma.deliveryOrder.findUnique({ where: { id: old.id } });
  assert.equal(after?.status, "canceled", "o pedido velho morre em silêncio (nada cobrado)");
  const ctx = await ctxOf(c.userId);
  assert.notEqual(ctx.deliveryOrderId, old.id);
  assert.ok(!(ctx.basket ?? []).some((i) => /gin/i.test(i.name)), "a cesta velha não volta");
});

test("08/10: total na mesa há 2 min + item novo = ainda é o MESMO pedido (reabre e refaz o total)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const old = await quoteOnTable(c, 2);
  const out = await send(c.phone, "preciso de um shampoo");
  assert.match(out, /total anterior não vale/, `não reabriu o pedido: ${out.slice(0, 300)}`);
  assert.match(out, /opç|shampoo/i, out.slice(0, 400));
  const after = await prisma.deliveryOrder.findUnique({ where: { id: old.id } });
  assert.equal(after?.status, "canceled", "reabrir cancela a cotação antiga (o total será refeito)");
  const ctx = await ctxOf(c.userId);
  assert.ok((ctx.basket ?? []).some((i) => /gin/i.test(i.name)), "a cesta do pedido reaberto continua");
});

test("08/10: pergunta com o total na mesa não vira pedido novo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const old = await quoteOnTable(c, 20);
  await send(c.phone, "qual o prazo de entrega?");
  const after = await prisma.deliveryOrder.findUnique({ where: { id: old.id } });
  assert.equal(after?.status, "awaiting_quote_confirmation", "pergunta não cancela nada");
});
