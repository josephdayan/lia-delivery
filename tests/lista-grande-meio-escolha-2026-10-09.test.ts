// Teste real pelo WhatsApp (09/10/2026): lista de 6 itens no meio de uma escolha aberta perdia 3 itens sem avisar.
// (cabeçalho herdado) Teste do dono com a lista (08/10/2026, "deu tudo errado"): (1) "falou que não tinha gin e tinha" —
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
import { planActions } from "../src/lib/dialogue/plan";
import { buildDialogueState } from "../src/lib/dialogue/state";
import type { DeliveryContext } from "../src/lib/conversation-types";
import { consolidationYesTitle } from "../src/lib/adapters/whatsapp";
import { detectIntent } from "../src/lib/lia-intents";
import { parseDecision } from "../src/lib/dialogue/model";
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
  await handleDeliveryMessage({ phone, text, messageId: `w09_${RUN}_${++seq}` });
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
const ITEMS_FEIJAO = [{ sku: "swift-7696", name: "Feijão Preto Swift 1kg", qty: 2, unitPrice: 7.67, lineTotal: 15.34, storeKey: "swift", storeLabel: "Swift" }];
const baseCtx = { flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true };
const ITEMS = [{ sku: "CRF-BEB-054", name: "Gin London Dry Tanqueray Garrafa 750ml", qty: 1, unitPrice: 125.89, lineTotal: 125.89, storeKey: "carrefour", storeLabel: "Carrefour" }];


test("09/10: lista grande no meio de uma escolha aberta não perde item: tudo vai pra fila, pra cesta ou pro 'não achei'", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  await setCtx(c.userId, { ...baseCtx });
  await send(c.phone, "arroz integral");
  const first = await ctxOf(c.userId);
  assert.ok(first.pending?.length, "escolha do arroz aberta");
  const reply = await send(c.phone, "leite integral, pão de forma, shampoo, ração de gato, esmalte vermelho, carregador usb");
  const ctx = (await ctxOf(c.userId)) as { pending?: { query: string }[]; basket?: { name: string; ask?: string }[]; notFound?: string[] };
  const seen = [
    ...(ctx.pending ?? []).map((p) => p.query),
    ...(ctx.basket ?? []).map((b) => `${b.ask ?? ""} ${b.name}`),
    ...(ctx.notFound ?? []),
    reply
  ].join(" ").toLowerCase();
  for (const word of ["leite", "pão de forma", "shampoo", "ração", "esmalte", "carregador"]) {
    assert.ok(seen.includes(word), `item sumiu sem aviso: ${word}\n${JSON.stringify({ pending: ctx.pending?.map((p) => p.query), basket: ctx.basket?.map((b) => b.name), notFound: ctx.notFound, reply })}`);
  }
});

test("09/10: 6 buscas do modelo de diálogo não são cortadas em 4; acima do teto a decisão cai pro pipeline determinístico", () => {
  const search = (query: string) => ({ type: "search", query, qty: 1 });
  const six = parseDecision({ actions: ["leite", "pão", "shampoo", "ração", "esmalte", "carregador"].map(search) });
  assert.equal(six?.actions.length, 6);
  const tooMany = parseDecision({ actions: Array.from({ length: 13 }, (_, i) => search(`item ${i}`)) });
  assert.equal(tooMany, null);
});

test("09/10: 'adicionar 1 gin e 1 vodka' com cesta montada soma — não apaga a cesta como lista nova", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  await setCtx(c.userId, { ...baseCtx, step: "collecting", basket: ITEMS_FEIJAO });
  await send(c.phone, "adicionar 1 shampoo e 1 esmalte vermelho");
  const ctx = await ctxOf(c.userId);
  const names = (ctx.basket ?? []).map((b) => b.name).join(" | ");
  assert.match(names, /Feijão Preto/, `a cesta antiga sumiu: ${names}`);
});

test("09/10: modelo devolve 3 buscas para uma lista de 6 -> plano inválido (cai no pipeline determinístico)", () => {
  const state = buildDialogueState({ flow: "delivery", step: "collecting" } as DeliveryContext, { hasAddress: true });
  const search = (query: string) => ({ type: "search" as const, query, qty: 1 });
  const text = "também ração de gato, carregador usb, pilha aa, fita adesiva, sabão em pó, papel higiênico";
  const cut = planActions({ actions: [search("ração gato"), search("carregador usb"), search("pilha aa")] }, state, { text });
  assert.equal(cut.ok, false);
  const whole = planActions({ actions: [search("ração gato"), search("carregador usb"), search("pilha aa")] }, state, { text: "ração de gato, carregador usb e pilha aa" });
  assert.equal(whole.ok, true);
});

test("09/10: 'bolacha maizena' acha Biscoito Maizena (bolacha ≈ biscoito)", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  await setCtx(c.userId, { ...baseCtx });
  const out = await send(c.phone, "quero bolacha maizena");
  const ctx = (await ctxOf(c.userId)) as { pending?: { options?: { name: string }[] }[]; basket?: { name: string }[] };
  const names = [...(ctx.pending ?? []).flatMap((p) => (p.options ?? []).map((o) => o.name)), ...(ctx.basket ?? []).map((b) => b.name)].join(" | ");
  assert.match(names + out, /biscoito[^|]*maizena|maizena[^|]*biscoito/i, `sem biscoito maizena: ${names} :: ${out.slice(0, 200)}`);
});

test("09/10: 'troca por X e coloca 3' leva a quantidade junto na busca da troca", () => {
  const state = buildDialogueState(
    { flow: "delivery", step: "awaiting_quote_confirmation", basket: [{ sku: "m1", name: "Biscoito de Maizena Bauducco 170g", qty: 1, unitPrice: 4.06, lineTotal: 4.06, storeKey: "mambo", storeLabel: "Mambo" }] } as unknown as DeliveryContext,
    { hasAddress: true }
  );
  const swap = (text: string) => planActions({ actions: [{ type: "swap" as const, from: 1, to: "bolacha agua e sal" }] }, state, { text });
  const withQty = swap("troca por bolacha agua e sal e coloca 3");
  assert.equal(withQty.ok, true);
  assert.equal((withQty as { steps: { to: string }[] }).steps[0].to, "3 bolacha agua e sal");
  const noQty = swap("troca por bolacha agua e sal");
  assert.equal((noQty as { steps: { to: string }[] }).steps[0].to, "bolacha agua e sal");
});

test("09/10: título do botão 'juntar' cabe em 20 caracteres sem cortar o nome da loja no meio", () => {
  assert.equal(consolidationYesTitle("Mambo"), "Juntar na Mambo");
  assert.equal(consolidationYesTitle("Farmácia Indiana"), "Juntar numa loja");
  for (const label of ["Mambo", "Farmácia Indiana", "Drogarias Pacheco", "Casa Santa Luzia"]) assert.ok(consolidationYesTitle(label).length <= 20);
});

test("09/10: 'esvazia tudo, quero recomeçar' com a oferta de troca de loja aberta esvazia a cesta (não vira busca)", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  const basket = [
    { sku: "americanas-1", name: "Sabonete em Barra Dove 90g", qty: 2, unitPrice: 5.71, lineTotal: 11.42, storeKey: "carrefour", storeLabel: "Carrefour" },
    { sku: "farmaciaindiana-1", name: "Creme Dental Colgate 50g", qty: 1, unitPrice: 4.39, lineTotal: 4.39, storeKey: "farmaciaindiana", storeLabel: "Farmácia Indiana" }
  ];
  await setCtx(c.userId, { ...baseCtx, step: "collecting", basket, minSwap: { fromStoreKey: "americanas", replacements: [] } });
  const out = await send(c.phone, "esvazia tudo, quero recomeçar");
  assert.doesNotMatch(out, /não achei/i, out.slice(0, 300));
  const ctx = (await ctxOf(c.userId)) as { basket?: unknown[] };
  assert.equal((ctx.basket ?? []).length, 0, out.slice(0, 200));
});

test("09/10: 'esvazia tudo' / 'esvaziar carrinho' / 'começar do zero' são pedido de esvaziar a cesta", () => {
  for (const phrase of ["esvazia tudo", "esvazia a cesta", "esvaziar carrinho", "começa de novo", "começar do zero", "recomeça tudo"]) {
    assert.equal(detectIntent(phrase).kind, "clear_cart", phrase);
  }
});

test("09/10: 'não, deixa' / 'deixa assim' são recusa (não busca de produto)", () => {
  for (const phrase of ["não, deixa", "nao deixa", "deixa assim", "não, deixa quieto", "deixa como está"]) {
    assert.equal(detectIntent(phrase).kind, "reject", phrase);
  }
  assert.notEqual(detectIntent("deixa o arroz de 5kg").kind, "reject");
});

test("09/10: botão 'Tirar' do pedido mínimo remove só o item da loja abaixo do mínimo e segue com o resto", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  const basket = [
    { sku: "americanas-9", name: "Detergente Líquido Limpol Neutro 500ml", qty: 1, unitPrice: 2.9, lineTotal: 2.9, storeKey: "carrefour", storeLabel: "Carrefour" },
    { sku: "mambo-1", name: "Arroz Polido Tipo 1 Tio João 1kg", qty: 1, unitPrice: 7.6, lineTotal: 7.6, storeKey: "mambo", storeLabel: "Mambo" }
  ];
  await setCtx(c.userId, { ...baseCtx, step: "collecting", basket });
  const out = await send(c.phone, "minimo:tirar");
  assert.match(out, /Tirei Detergente/i, out.slice(0, 300));
  const ctx = (await ctxOf(c.userId)) as { basket?: { name: string }[] };
  const names = (ctx.basket ?? []).map((b) => b.name).join("|");
  assert.doesNotMatch(names, /Detergente/);
  assert.match(names, /Arroz/);
});

test("09/10: botão 'Completar' do pedido mínimo pede um item da loja e diz quanto falta", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customer();
  const basket = [{ sku: "americanas-9", name: "Detergente Líquido Limpol Neutro 500ml", qty: 1, unitPrice: 2.9, lineTotal: 2.9, storeKey: "carrefour", storeLabel: "Carrefour" }];
  await setCtx(c.userId, { ...baseCtx, step: "collecting", basket });
  const out = await send(c.phone, "minimo:completar");
  assert.match(out, /Carrefour.*faltam R\$/i, out.slice(0, 300));
  const ctx = (await ctxOf(c.userId)) as { basket?: unknown[] };
  assert.equal(ctx.basket?.length, 1, "completar não mexe na cesta");
});
