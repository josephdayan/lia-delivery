// Rodada 25, grupo B, corretor g69 (11/10): achados R25-1 a R25-6 de /mnt/project-files/testes-whatsapp/rodada25/grupo-b.md:
//   R25-1 (A1): "qual a diferença entre o shampoo de 17,15 e o de 23,09?" com a oferta de juntar na mesa abria carrossel;
//               "manter como está" depois dizia "Deixei shampoo de fora" + "toca em Pagar" sem total;
//   R25-2 (M1): "quanto compro por convidado?" ignorada;
//   R25-3 (M2): "o mais barato" de café virava sachê de 10 g com entrega de 9 dias;
//   R25-4 (M3): "na verdade volta com o feijão" buscava de novo em vez de devolver o item tirado;
//   R25-5 (M4): "sem ser Dove" ignorado.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { cheapestForOrder, handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { parseGuestQtyAsk } from "../src/lib/lia-intents";
import { perGuestGuide } from "../src/lib/recommend/quantity";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5569${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
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
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
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
  __setPreSignupModelForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string) {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g69_${RUN}_${++seq}` }));
  const mine = outbox.slice(start).filter((o) => o.to === phone);
  return { text: mine.map((o) => o.text).join("\n---\n"), kinds: mine.map((o) => o.kind) };
}
async function ctxOf(convoId: string) {
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } });
  return JSON.parse(convo.context ?? "{}") as DeliveryContext;
}
const bi = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, extra: Partial<BasketItem> = {}): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...extra }) as BasketItem;
const opt = (sku: string, name: string, unitPrice: number, extra: Partial<ChoiceOption> = {}): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", ...extra }) as ChoiceOption;
const keyOf = (basket: BasketItem[]) => basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");

// ---------------- R25-1: pergunta de diferença com a oferta de juntar na mesa ----------------

function joinOfferCase() {
  const sabonete = bi("crf-sab", "Sabonete em Barra Hidratante Dove Original 90g", 5.71, "carrefour", "Carrefour", { ask: "sabonete dove" });
  const shampoo = bi("dsp-sh", "Shampoo Head & Shoulders Anticaspa Limpeza Refrescante 200ml", 17.15, "drogariasp", "Drogaria São Paulo", { ask: "shampoo head shoulders" });
  const deso = bi("pm-deso", "Desodorante Antitranspirante Rexona Sem Perfume 48h Roll-On 50ml", 9.78, "paguemenos", "Pague Menos", { ask: "desodorante rexona sem perfume" });
  const basket = [sabonete, shampoo, deso];
  const joined = [
    bi("pm-sab", "Sabonete em Barra Dove Original Hidratante 90g", 5.93, "paguemenos", "Pague Menos"),
    bi("pm-sh", "Shampoo Anticaspa Head & Shoulders Limpeza Refrescante 200ml", 23.09, "paguemenos", "Pague Menos"),
    deso
  ];
  const offer = {
    key: keyOf(basket),
    basket: joined,
    storeLabel: "Pague Menos",
    stores: 3,
    pairs: [
      { fromName: sabonete.name, fromPrice: 5.71, toName: joined[0].name, toPrice: 5.93 },
      { fromName: shampoo.name, fromPrice: 17.15, toName: joined[1].name, toPrice: 23.09 }
    ],
    delta: 6.16,
    joinedTotal: 43.7,
    keptTotal: 57.23
  };
  return { basket, offer };
}

test("R25-1: 'qual a diferença entre o shampoo de 17,15 e o de 23,09?' com a oferta de juntar é respondida sem carrossel", async (t) => {
  if (!dbOk) return t.skip();
  const { basket, offer } = joinOfferCase();
  const c = await customerWith({ basket, consolidationOffer: offer });
  const out = await send(c.phone, "qual a diferença entre o shampoo de 17,15 e o de 23,09?");
  assert.ok(!out.kinds.includes("sendDeliveryCarousel"), out.text.slice(0, 600));
  assert.doesNotMatch(out.text, /Opções de \*shampoo/i, out.text.slice(0, 600));
  assert.match(out.text, /mesmo/i, out.text.slice(0, 600));
  assert.match(out.text, /17,15/, out.text.slice(0, 600));
  assert.match(out.text, /23,09/, out.text.slice(0, 600));
  assert.match(out.text, /Pague Menos/, out.text.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  assert.ok(ctx.consolidationOffer, "a oferta continua na mesa");
  assert.ok(!(ctx.pending?.length), "nada em escolha");
  // "manter como está" responde à oferta: mantém as lojas e o shampoo continua na cesta.
  const kept = await send(c.phone, "manter como está");
  assert.match(kept.text, /mantenho as 3 lojas/i, kept.text.slice(0, 600));
  assert.doesNotMatch(kept.text, /Deixei \*shampoo/i, kept.text.slice(0, 600));
  const after = await ctxOf(c.convoId);
  assert.ok((after.basket ?? []).some((b) => b.sku === "dsp-sh") || after.deliveryOrderId, JSON.stringify(after).slice(0, 400));
});

test("R25-1: carrossel aberto por fala lateral com a oferta guardada: 'manter como está' responde à oferta (não pula o item)", async (t) => {
  if (!dbOk) return t.skip();
  const { basket, offer } = joinOfferCase();
  const pending = [{ query: "shampoo", qty: 1, options: [opt("x-1", "Shampoo Elseve 200ml", 15.29), opt("x-2", "Shampoo Pantene 200ml", 22.99)] }];
  const c = await customerWith({ basket, consolidationParked: offer, pending }, "choosing");
  const out = await send(c.phone, "manter como está");
  assert.doesNotMatch(out.text, /Deixei \*shampoo/i, out.text.slice(0, 600));
  assert.match(out.text, /mantenho as 3 lojas/i, out.text.slice(0, 600));
  const after = await ctxOf(c.convoId);
  assert.ok(!(after.pending?.length), "a busca lateral sai da mesa");
});

// ---------------- R25-2: "quanto compro por convidado?" ----------------

test("R25-2: 'quanto compro por convidado?' é reconhecida e a conta sai pela tabela por pessoa", () => {
  const ask = parseGuestQtyAsk("Vou fazer festa de aniversário do meu filho, 20 crianças. Preciso de refrigerante, salgadinho, bolo, brigadeiro e copo descartável. Quanto compro por convidado?");
  assert.ok(ask);
  assert.match(ask!.rest, /refrigerante, salgadinho/);
  assert.equal(parseGuestQtyAsk("quanto eu compro de refrigerante pra 20 crianças?")?.item, "refrigerante");
  // Não é pergunta de festa.
  assert.equal(parseGuestQtyAsk("quanto custa o refrigerante?"), null);
  assert.equal(parseGuestQtyAsk("quero 2 refrigerantes pra festa"), null);
  assert.equal(parseGuestQtyAsk("quanto fica o total da festa pra 20 pessoas?"), null);
  assert.match(parseGuestQtyAsk("quantos pacotes de copo eu levo pra 20 pessoas?")?.item ?? "", /copo/);
  const rows = perGuestGuide(["refrigerante", "salgadinho", "bolo", "brigadeiro", "copo descartável", "vela de aniversário"], 20);
  assert.deepEqual(rows.map((r) => r.noun), ["refrigerante", "salgadinho", "bolo", "docinhos", "copo"]);
  const text = copy.perGuestAnswer(rows, 20);
  assert.match(text, /refrigerante: ~500 ml por pessoa → pra 20, uns 10 L \(5 garrafas de 2 L\)/);
  assert.match(text, /bolo: ~100 g por pessoa \(uma fatia\) → pra 20, uns 2 kg/);
});

test("R25-2: com o carrossel de refrigerante, 'quanto eu compro de refrigerante pra 20 crianças?' responde (nunca 'Não peguei')", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [{ query: "refrigerante", qty: 1, options: [opt("r-1", "Refrigerante Coca-Cola 2L", 11.9), opt("r-2", "Refrigerante Guaraná Antarctica 2L", 8.9)] }];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "quanto eu compro de refrigerante pra 20 crianças?");
  assert.doesNotMatch(out.text, /Não peguei/i, out.text.slice(0, 600));
  assert.match(out.text, /5 garrafas de 2 L/, out.text.slice(0, 600));
  const after = await ctxOf(c.convoId);
  assert.equal(after.pending?.[0]?.query, "refrigerante", "a escolha continua aberta");
  assert.equal(after.guests, 20);
});

test("R25-2: lista + 'quanto compro por convidado?' antes do cadastro anota a lista E responde a conta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const out = await send(phone, "Vou fazer festa de aniversário do meu filho, 20 crianças. Preciso de refrigerante, salgadinho, bolo, brigadeiro e copo descartável. Quanto compro por convidado?");
  assert.match(out.text, /por pessoa/, out.text.slice(0, 900));
  assert.match(out.text, /refrigerante/i, out.text.slice(0, 900));
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  const ctx = JSON.parse(convo.context ?? "{}") as DeliveryContext;
  assert.match(ctx.pendingRequest ?? "", /brigadeiro/, JSON.stringify(ctx).slice(0, 400));
});

// ---------------- R25-3: "o mais barato" não é a porção individual ----------------

test("R25-3: 'o mais barato' de café não pega o sachê de 10 g quando há pacote normal (e avisa)", () => {
  const options = [
    opt("c-1", "Café Pilão Tradicional 500g", 24.9),
    opt("c-2", "Cafe Drip Coffee 3 Coracoes 10gr Tradicional", 3.58, { storeKey: "drogariacatarinense", storeLabel: "Drogaria Catarinense", delivery: "9 dias úteis" }),
    opt("c-3", "Café Melitta Tradicional 250g", 14.5),
    opt("c-4", "Café 3 Corações Extraforte 500g", 26.9)
  ];
  const p = { query: "café", qty: 1, options };
  const ctx = { flow: "delivery", step: "choosing", pending: [p] } as unknown as DeliveryContext;
  const r = cheapestForOrder(ctx, p as never);
  assert.equal(options[r.index].sku, "c-3");
  assert.match(r.note ?? "", /porção individual/);
  // Sem palavra de porção, o tamanho 5× menor que o do meio também é porção.
  const sizes = [opt("s-1", "Açúcar Refinado União 1kg", 5.49), opt("s-2", "Açúcar Refinado União 5g", 0.2), opt("s-3", "Açúcar Cristal Caravelas 1kg", 4.99), opt("s-4", "Açúcar Refinado Da Barra 2kg", 10.9)];
  const ps = { query: "açúcar", qty: 1, options: sizes };
  assert.equal(sizes[cheapestForOrder({ flow: "delivery", pending: [ps] } as unknown as DeliveryContext, ps as never).index].sku, "s-3");
  // Pedido de sachê/tamanho pequeno: a porção vale.
  const asked = { query: "café em sachê", qty: 1, options };
  assert.equal(options[cheapestForOrder({ flow: "delivery", pending: [asked] } as unknown as DeliveryContext, asked as never).index].sku, "c-2");
});

test("R25-6 (B3): o mais barato que pula a versão premium diz por quê (não 'somava mais uma entrega')", () => {
  const options = [opt("a-1", "Arroz Polido Longo Fino Tipo 1 Camil 5kg", 34.64), opt("a-2", "Arroz Premium Brejeiro 5kg", 31.13), opt("a-3", "Arroz Tio João Tipo 1 5kg", 36.9)];
  const p = { query: "arroz 5kg", qty: 1, options };
  const r = cheapestForOrder({ flow: "delivery", pending: [p] } as unknown as DeliveryContext, p as never);
  if (options[r.index].sku === "a-1") assert.match(r.note ?? "", /versão diferente/);
  else assert.equal(options[r.index].sku, "a-2");
  assert.doesNotMatch(r.note ?? "", /somava mais uma entrega/);
});

// ---------------- R25-5: "sem ser Dove" com o carrossel de Dove na tela ----------------

test("R25-5: 'e o sabonete que tem outra opção sem ser Dove?' com cards só de Dove busca sabonete de outra marca", async (t) => {
  if (!dbOk) return t.skip();
  const dove = (sku: string, name: string, price: number) => opt(sku, name, price, { brand: "Dove" });
  const pending = [{ query: "sabonete dove", qty: 1, options: [dove("d-1", "Sabonete em Barra Dove Original 90g", 5.71), dove("d-2", "Sabonete Dove Karité 90g", 6.2), dove("d-3", "Sabonete Líquido Dove Original 250ml", 18.9)] }];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "e o sabonete que tem outra opção sem ser Dove?");
  assert.doesNotMatch(out.text, /continuam a[ií] em cima/i, out.text.slice(0, 600));
  const after = await ctxOf(c.convoId);
  const shown = after.pending?.[0]?.options ?? [];
  // Nenhum card de Dove: ou mostra outra marca, ou diz que não achou.
  assert.ok(!shown.some((o) => /dove/i.test(o.name)), out.text.slice(0, 600));
});

// ---------------- R25-4: "volta com o feijão" devolve o item tirado ----------------

test("R25-4: 'na verdade volta com o feijão' logo depois de 'tira o feijão' devolve o mesmo feijão (sem busca nova)", async (t) => {
  if (!dbOk) return t.skip();
  const leite = bi("crf-leite", "Leite Integral Piracanjuba 1L", 6.49, "carrefour", "Carrefour", { ask: "leite" });
  const macarrao = bi("crf-mac", "Macarrão Espaguete Renata 500g", 5.29, "carrefour", "Carrefour", { ask: "macarrão" });
  const feijao = bi("crf-fei", "Feijão Carioca Swift 1kg", 9.32, "carrefour", "Carrefour", { ask: "feijão" });
  for (const phrase of ["na verdade volta com o feijão", "pode voltar o feijão"]) {
    const c = await customerWith({ basket: [leite, macarrao], lastRemoved: { items: [feijao], queries: [], at: Date.now() } });
    const out = await send(c.phone, phrase);
    assert.ok(!out.kinds.includes("sendDeliveryCarousel"), `${phrase}: ${out.text.slice(0, 500)}`);
    const after = await ctxOf(c.convoId);
    assert.ok((after.basket ?? []).some((b) => b.sku === "crf-fei"), `${phrase}: ${out.text.slice(0, 500)}`);
  }
});
