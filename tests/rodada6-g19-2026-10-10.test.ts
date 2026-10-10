// Rodada 6, grupo G19 (10/10): prazo dito ("pra amanhã") na vitrine e na oferta de juntar, juntar lojas por texto,
// "40 copos" contra pacote de 50, "só o cartão, sem vela", quantidade na troca, teto em busca nova, "a fralda de
// antes", "o que tem na minha cesta" e polimentos.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { deadlineVerdict, type LiveItemCheck } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem } from "../src/lib/conversation-types";

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
