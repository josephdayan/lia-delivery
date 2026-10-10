// Rodada 6, grupo G19 (10/10): prazo dito ("pra amanhã") na vitrine e na oferta de juntar, juntar lojas por texto,
// "40 copos" contra pacote de 50, "só o cartão, sem vela", quantidade na troca, teto em busca nova, "a fralda de
// antes", "o que tem na minha cesta" e polimentos.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, declaredPack, packAdjusted } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { deadlineVerdict, type LiveItemCheck } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import { detectIntent, parseDropClause } from "../src/lib/lia-intents";
import { planActions } from "../src/lib/dialogue/plan";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { dialogueBypassReason } from "../src/lib/dialogue";
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
afterEach(() => {
  __setLiveSimulateForTests(null);
  __clearLiveCheckCacheForTests();
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
  // Como o webhook de produção: o turno roda dentro de runTurnScoped (turnMeta ligado).
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g19_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const allSlow = (estimate: string) => async (_store: string, skus: string[]) =>
  new Map<string, LiveItemCheck>(skus.map((sku) => [sku, { sku, available: true, fee: 9.9, estimate, etaMinutes: 3 * 1440, fastFee: 9.9, fastEstimate: estimate, fastEtaMinutes: 3 * 1440 }]));

// 1) Prazo dito: a VITRINE avisa quando as opções não chegam a tempo (antes só o resumo do operador lia o prazo) ----
test("deadlineVerdict: separa as que chegam a tempo e acha a mais rápida das atrasadas", () => {
  const now = new Date("2026-10-09T15:00:00Z"); // sexta
  const v = deadlineVerdict([{ delivery: "prazo da loja: 8 dias úteis" }, { delivery: "prazo da loja: 3 dias úteis" }, { delivery: undefined }], "2026-10-10", now);
  assert.equal(v?.onTime.length, 0);
  assert.equal(v?.late.length, 2);
  assert.equal(v?.fastest?.delivery, "prazo da loja: 3 dias úteis");
  const mixed = deadlineVerdict([{ delivery: "prazo da loja: 3h" }, { delivery: "prazo da loja: 3 dias úteis" }], "2026-10-10", now);
  assert.equal(mixed?.onTime.length, 1);
  assert.equal(deadlineVerdict([{ delivery: undefined }], "2026-10-10", now), null);
  assert.match(copy.choicesDeadlineNote("amanhã", [], { store: "Drogal", promise: "prazo da loja: 3 dias úteis" }), /Pra \*amanhã\* não chega.*o mais rápido é \*3 dias úteis\* \(Drogal\)/);
  assert.match(copy.choicesDeadlineNote("amanhã", ["Drogal"]), /chega a tempo só pela \*Drogal\*/);
});

test("'preciso de arroz pra amanhã' com tudo em 3 dias úteis: a vitrine diz que não chega e o mais rápido", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(allSlow("3bd"), () => true);
  const c = await customerWith({});
  const out = await send(c.phone, "preciso de arroz pra amanhã");
  assert.match(out, /Pra \*amanhã\* não chega.*o mais rápido é \*3 dias úteis\*/, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.neededBy?.label, "amanhã");
});

test("sem prazo dito, nada de aviso de prazo na vitrine", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(allSlow("3bd"), () => true);
  const c = await customerWith({});
  const out = await send(c.phone, "arroz");
  assert.doesNotMatch(out, /não chega|a tempo/, out.slice(0, 400));
});

test("oferta de juntar com prazo dito: a forma que não chega a tempo é dita na oferta", () => {
  assert.match(copy.consolidationDeadlineNote("amanhã", true, false, "prazo da loja: 4 dias úteis", "prazo da loja: 1 dia útil") ?? "", /juntando não chega a tempo \(4 dias úteis\) — mantendo como está, chega/);
  assert.equal(copy.consolidationDeadlineNote("amanhã", false, false), null);
  const body = copy.consolidationOffer({ storeLabel: "Drogal", joinedTotal: 80, keptTotal: 90, keptStores: 2, pairs: [], joinedEta: "prazo da loja: 4 dias úteis", keptEta: "prazo da loja: 1 dia útil", deadlineNote: copy.consolidationDeadlineNote("amanhã", true, false, "prazo da loja: 4 dias úteis") });
  assert.match(body, /não chega a tempo[\s\S]*Qual prefere/);
});

// 2) Juntar lojas pedido no meio das escolhas: anota e junta no fechamento (antes: pergunta aberta da IA) -------------
test("'tudo numa loja so' com item ainda em escolha: anota o pedido de juntar e mantém a escolha na tela", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const pending = [{ query: "feijão", qty: 1, options: [{ sku: "x1", name: "Feijão Carioca 1kg", unitPrice: 8, storeKey: "carrefour", storeLabel: "Carrefour" }, { sku: "x2", name: "Feijão Preto 1kg", unitPrice: 9, storeKey: "carrefour", storeLabel: "Carrefour" }] }];
  for (const msg of ["tudo numa loja so", "tudo na mesma loja"]) {
    const c = await customerWith({ basket: [arroz], pending }, "choosing");
    const out = await send(c.phone, msg);
    assert.match(out, /quando terminar de escolher, eu junto tudo/, `${msg} :: ${out.slice(0, 400)}`);
    assert.match(out, /feijão/i);
    const ctx = await ctxOf(c.convoId);
    assert.ok(ctx.joinWanted, msg);
    assert.equal(ctx.pending?.length, 1);
  }
});

test("'junta tudo na X' sem os outros itens na X: diz quais itens a loja não tem", () => {
  assert.match(copy.joinTargetLacksOthers("Cobasi", ["Sabonete Dove", "Protetor FPS 30"], 3), /A \*Cobasi\* não tem \*Sabonete Dove\*, \*Protetor FPS 30\*.*mantive as 3 lojas/);
});

test("'sim' puro na oferta de juntar: diz o que trocou antes de qualquer pagamento", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const sab = { sku: "g19-sab", name: "Sabonete Dove 90g", qty: 1, unitPrice: 7.14, lineTotal: 7.14, storeKey: "mambo", storeLabel: "Mambo" } as BasketItem;
  const swapped = { ...sab, sku: "g19-sab2", name: "Sabonete Dove Pele Sensível 90g", unitPrice: 5.71, lineTotal: 5.71, storeKey: "carrefour", storeLabel: "Carrefour" } as BasketItem;
  const basket = [arroz, sab];
  const key = basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");
  const offer = { key, basket: [arroz, swapped], storeLabel: "Carrefour", stores: 2, pairs: [{ fromName: sab.name, fromPrice: 7.14, toName: swapped.name, toPrice: 5.71 }], delta: -1.43, joinedTotal: 30, keptTotal: 40 };
  const c = await customerWith({ basket, consolidationOffer: offer });
  const out = await send(c.phone, "sim");
  assert.match(out, /Juntei tudo na \*Carrefour\*[\s\S]*Sabonete Dove 90g[\s\S]*Pele Sensível/, out.slice(0, 600));
  const juntei = out.indexOf("Juntei");
  const pay = out.search(/Como prefere pagar|Escolhe abaixo como quer pagar/);
  assert.ok(pay < 0 || juntei < pay, out.slice(0, 600));
});

// 3) "40 copos descartáveis" contra "Copo ... C/50": unidades pedidas viram pacotes (ou pergunta), nunca 40 pacotes --
test("declaredPack/packAdjusted: 'C/50' é a contagem do pacote; 40 copos = 1 pacote", () => {
  assert.equal(declaredPack("Copo Descartável Rosa Regina C/50"), 50);
  assert.equal(declaredPack("Prato Descartável 15cm c/ 10"), 10);
  assert.equal(declaredPack("Arroz Tipo 1 c/5kg"), 0);
  assert.equal(declaredPack("Guardanapo de Papel 50 Guardanapos"), 50);
  assert.equal(packAdjusted("Copo Descartável Rosa Regina C/50", 40, "copos descartaveis").qty, 1);
  assert.equal(packAdjusted("Copo Descartável Rosa Regina C/50", 120, "copos descartaveis").qty, 3);
  assert.equal(packAdjusted("Copo Descartável Rosa Regina C/50", 2, "pacotes de copo descartavel").qty, 2, "pacotes pedidos ficam");
});

test("escolher o copo C/50 com '40 copos' pergunta a embalagem antes de pôr na cesta; 'sim' leva 1 pacote", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    { sku: "g19-copo50", name: "Copo Descartável Rosa Regina C/50", unitPrice: 14.28, storeKey: "carrefour", storeLabel: "Carrefour" },
    { sku: "g19-copo100", name: "Copo Descartável Transparente 200ml C/100", unitPrice: 9.9, storeKey: "carrefour", storeLabel: "Carrefour" }
  ];
  const c = await customerWith({ pending: [{ query: "copos descartaveis", qty: 40, qtyExplicit: true, options }] }, "choosing");
  const out = await send(c.phone, "1");
  assert.match(out, /50 unidades[\s\S]*pediu \*40\*[\s\S]*Levo 1 embalagem/, out.slice(0, 500));
  assert.doesNotMatch(out, /40x/);
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.basket ?? []).length, 0, "nada na cesta antes da confirmação");
  await send(c.phone, "sim");
  const after = await ctxOf(c.convoId);
  const line = (after.basket ?? []).find((b: BasketItem) => b.sku === "g19-copo50");
  assert.equal(line?.qty, 1, JSON.stringify(after.basket));
});

// 4) "só o cartão, sem vela", "2 latas" na troca, teto em busca nova, "tem um mais em conta?" sem IA ----------------
test("parseDropClause e 'cartão de aniversário' não é forma de pagamento", () => {
  assert.deepEqual(parseDropClause("so o cartao, sem vela"), { drop: "vela", rest: "cartao" });
  assert.deepEqual(parseDropClause("sem a vela, so o cartao"), { drop: "vela", rest: "cartao" });
  assert.equal(parseDropClause("arroz sem gluten"), null);
  assert.equal(detectIntent("cartão de aniversário").kind, "free_text");
  assert.equal(detectIntent("um cartão de presente pra minha mãe").kind, "free_text");
  assert.equal(detectIntent("cartão").kind, "choose_payment");
  assert.equal(detectIntent("cartão de crédito").kind, "choose_payment");
});

test("'so o cartao, sem vela' com o sabonete na tela e a vela na fila: tira a vela e volta ao cartão não achado", async (t) => {
  if (!dbOk) return t.skip();
  const opts = [{ sku: "s1", name: "Sabonete Dove 90g", unitPrice: 7, storeKey: "carrefour", storeLabel: "Carrefour" }, { sku: "s2", name: "Sabonete Lux 85g", unitPrice: 3, storeKey: "carrefour", storeLabel: "Carrefour" }];
  const velas = [{ sku: "v1", name: "Vela de Aniversário Número 5", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour" }, { sku: "v2", name: "Vela Palito Colorida", unitPrice: 4, storeKey: "carrefour", storeLabel: "Carrefour" }];
  const c = await customerWith({
    pending: [{ query: "sabonetes", qty: 2, qtyExplicit: true, options: opts }, { query: "vela", qty: 1, options: velas }],
    listMisses: [{ query: "cartão de aniversário", qty: 1, reason: "not_found", at: Date.now() }]
  }, "choosing");
  const out = await send(c.phone, "so o cartao, sem vela");
  assert.match(out, /Tirei vela/, out.slice(0, 500));
  assert.doesNotMatch(out, /Não peguei qual|so o cartao sem vela|Antes de pagar/, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  assert.ok(!(ctx.pending ?? []).some((p: { query: string }) => p.query === "vela"), JSON.stringify(ctx.pending?.map((p: { query: string }) => p.query)));
  assert.equal(ctx.pending?.[0]?.query, "sabonetes", "a escolha na tela continua");
});

test("troca com '2 latas' leva a quantidade; busca com teto mantém o teto que a IA tirou", () => {
  const state = buildDialogueState(
    { flow: "delivery", step: "collecting", basket: [{ sku: "l1", name: "Leite Integral Ninho 1L", qty: 1, unitPrice: 7, lineTotal: 7, storeKey: "mambo", storeLabel: "Mambo" }] } as unknown as DeliveryContext,
    { hasAddress: true }
  );
  const swap = planActions({ actions: [{ type: "swap" as const, from: 1, to: "leite Ninho em pó" }] }, state, { text: "o leite ninho eu quis dizer o leite em po, 2 latas" });
  assert.equal((swap as { steps: { to: string }[] }).steps[0].to, "2 leite Ninho em pó");
  const empty = buildDialogueState({ flow: "delivery", step: "collecting" } as DeliveryContext, { hasAddress: true });
  const search = planActions({ actions: [{ type: "search" as const, query: "perfume feminino", qty: 1 }] }, empty, { text: "perfume feminino ate 60 reais" });
  assert.match((search as { steps: { lines: { query: string }[] }[] }).steps[0].lines[0].query, /perfume feminino até 60 reais/);
});

test("'tem um mais em conta?' não passa pela IA (caminho fixo pergunta de qual item)", () => {
  const ctx = { flow: "delivery", step: "collecting", basket: [{ sku: "a", name: "Fralda", qty: 1, unitPrice: 50 }, { sku: "b", name: "Protetor", qty: 1, unitPrice: 40 }] } as unknown as DeliveryContext;
  for (const text of ["tem um mais em conta?", "tem algum mais barato?"]) {
    assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false }) !== null, true, text);
  }
});
