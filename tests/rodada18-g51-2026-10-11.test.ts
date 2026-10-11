// Rodada 18, grupo G51 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada18/grupo-b.md e grupo-a.md (R18-*, R18a-*).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, optionNamedOnTable, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { planActions } from "../src/lib/dialogue/plan";
import { __setPreSignupModelForTests, planPreSignup, type PreDecision } from "../src/lib/dialogue/presignup";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { parseAvailabilityAsk } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import type { ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5528${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, more?: unknown) => {
    outbox.push({ to, kind: key, text: [text, more].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ") });
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
  delete process.env.LIA_MEDICINE_MIP;
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
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g51_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const PASTILHAS: ChoiceOption[] = [
  opt("dsp-312983", "Pastilhas para Garganta Strepsils Mel e Limão 8 Unidades", 17.69, "drogariasp", "Drogaria São Paulo"),
  opt("drogal-12571", "Pastilha para Garganta Flogoral Sabor Menta 8 Unidades", 15.17, "drogal", "Drogal"),
  opt("paguemenos-36595", "Pastilhas para Garganta Strepsils Sabor Mel e Limão 8 Pastilhas", 13.99, "paguemenos", "Pague Menos"),
  opt("paguemenos-36596", "Pastilhas para garganta Strepsils Sabor Mel e Limão - Caixa 16 Pastilhas", 28.99, "paguemenos", "Pague Menos"),
  opt("dsp-312991", "Pastilhas para garganta Strepsils Mel e Limão 16 Unidades", 27.2, "drogariasp", "Drogaria São Paulo")
];
const pending = (query: string, options: ChoiceOption[]): PendingChoice => ({ query, qty: 1, options } as PendingChoice);
const D = (over: Partial<PreDecision> = {}): PreDecision =>
  ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, smalltalk: false, ...over }) as PreDecision;

// ---------------------------------------------------------------- R18-7: pastilha não é remédio de receita

const GARGANTA = "to com dor de garganta, preciso de pastilha pra garganta, soro fisiologico e um termometro. precisa chegar hoje até as 18h";

test("R18-7: com o isento ligado, a IA marcar a pastilha como remédio não gera a recusa de receita (antes do cadastro)", () => {
  process.env.LIA_MEDICINE_MIP = "true";
  const items = [{ query: "soro fisiologico", qty: 1, cheapest: false }, { query: "termometro", qty: 1, cheapest: false }];
  const plan = planPreSignup(D({ medicine: true, items }), { text: GARGANTA });
  assert.ok(plan.ok && !plan.steps.some((s) => s.type === "medicine"), JSON.stringify(plan));
  // Remédio de receita nomeado ainda recusa; insistência logo depois de uma recusa também.
  const rx = planPreSignup(D({ medicine: true, items: [{ query: "band-aid", qty: 1, cheapest: false }] }), { text: "amoxicilina e band-aid" });
  assert.ok(rx.ok && rx.steps.some((s) => s.type === "medicine"), JSON.stringify(rx));
  const again = planPreSignup(D({ medicine: true, items: [{ query: "band-aid", qty: 1, cheapest: false }] }), { text: "mas é urgente, e um band-aid", recentRefusal: true });
  assert.ok(again.ok && again.steps.some((s) => s.type === "medicine"), JSON.stringify(again));
  // Desligado, nada muda.
  delete process.env.LIA_MEDICINE_MIP;
  const off = planPreSignup(D({ medicine: true, items }), { text: GARGANTA });
  assert.ok(off.ok && off.steps.some((s) => s.type === "medicine"));
});

test("R18-7: depois do cadastro, 'pastilha para garganta' com a ação medicine da IA vai para a busca", () => {
  process.env.LIA_MEDICINE_MIP = "true";
  const state = buildDialogueState({ flow: "delivery", step: "collecting" } as DeliveryContext, { hasAddress: true });
  assert.deepEqual(planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "pastilha para garganta" }), { ok: false, reason: "remedio_isento" });
  // Insistência depois da recusa ("mas é urgente") segue com a recusa da IA.
  assert.equal(planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "mas é urgente", recentRefusal: true }).ok, true);
  assert.equal(planActions({ actions: [{ type: "medicine" }] } as never, state, { text: "rivotril" }).ok, true);
});

test("R18-7: 'oi, antes: tem ibuprofeno?' é a pergunta de disponibilidade do ibuprofeno", () => {
  assert.equal(parseAvailabilityAsk("oi, antes: tem ibuprofeno?"), "ibuprofeno");
  assert.equal(parseAvailabilityAsk("só uma pergunta, vcs tem fralda?"), "fralda");
  assert.equal(parseAvailabilityAsk("antes de tudo, tem como"), null);
});

// O catálogo de teste não tem o ibuprofeno: a mesma pergunta com um produto que ele tem.
test("R18-7: com o soro na tela, 'oi, antes: tem termômetro?' entra na fila em vez de 'Não peguei qual você quer'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  const soro = [opt("dsp-719595", "Soro Fisiológico Ever Care Bico Dosador 100ml", 8.35, "drogariasp", "Drogaria São Paulo"), opt("mambo-24621", "Soro Fisiológico LBS 100ml", 5.27, "mambo", "Mambo")];
  const c = await customerWith({ pending: [pending("soro fisiologico", soro)] }, "choosing");
  const out = await send(c.phone, "oi, antes: tem termômetro?");
  assert.doesNotMatch(out, /Não peguei qual você quer/, out);
  const ctx = await ctxOf(c.convoId);
  assert.ok(
    (ctx.pending ?? []).some((p) => /term[oô]metro/i.test(p.query)) || (ctx.basket ?? []).some((b) => /term[oô]metro/i.test(b.name)),
    out
  );
  assert.equal(ctx.pending?.[0].query, "soro fisiologico", out);
});

// ---------------------------------------------------------------- R18-6 / R18-13: escolha por descrição e pela contagem

test("R18-6: 'a de mel e limão da drogaria são paulo' aponta os cards de mel e limão daquela loja", () => {
  const p = pending("pastilha para garganta", PASTILHAS);
  assert.deepEqual(optionNamedOnTable("a de mel e limão da drogaria são paulo", p), [0, 4]);
  assert.deepEqual(optionNamedOnTable("a de mel e limão da pague menos", p), [2, 3]);
  assert.deepEqual(optionNamedOnTable("a de mel e limão", p), [0, 2, 3, 4]);
  // Sem nome de card, nada ("o 2", um item novo, uma pergunta).
  assert.deepEqual(optionNamedOnTable("o 2", p), []);
  assert.deepEqual(optionNamedOnTable("e um termometro", p), []);
});

test("R18-13: 'a de 8' depois da pergunta da caixa de 8 ou 16 aponta as caixas de 8", () => {
  const p = pending("pastilha strepsils mel e limão", PASTILHAS);
  assert.deepEqual(optionNamedOnTable("a de 8", p), [0, 1, 2]);
  assert.deepEqual(optionNamedOnTable("a com 16", p), [3, 4]);
  assert.deepEqual(optionNamedOnTable("a de 16 da pague menos", p), [3]);
  // Número que pode ser a opção ("o de 2" com 5 cards) não é contagem.
  assert.deepEqual(optionNamedOnTable("o de 2", p), []);
});

test("R18-6: 'pastilha strepsils mel e limão' é um item só; 'mel e limão' soltos continuam 2", () => {
  assert.equal(resolveListItems("pastilha strepsils mel e limão").length, 1);
  assert.equal(resolveListItems("chá de mel e limão").length, 1);
  assert.equal(resolveListItems("mel e limão").length, 2);
  assert.equal(resolveListItems("pastilha de mel e limão e um termometro").length, 2);
});

test("R18-6: na conversa, a descrição do card estreita as opções sem abrir itens novos", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [{ sku: "dsp-719595", name: "Soro Fisiológico Ever Care 100ml", qty: 1, unitPrice: 8.35, lineTotal: 8.35, storeKey: "drogariasp", storeLabel: "Drogaria São Paulo" }];
  const c = await customerWith({ basket, pending: [pending("pastilha para garganta", PASTILHAS)] }, "choosing");
  const out = await send(c.phone, "a de mel e limão da drogaria são paulo");
  const ctx = await ctxOf(c.convoId);
  assert.doesNotMatch(out, /Somei|Vamos um de cada vez/, out);
  assert.equal(ctx.pending?.length, 1, out);
  assert.deepEqual(ctx.pending?.[0].options.map((o) => o.sku), ["dsp-312983", "dsp-312991"], out);
  assert.equal(ctx.basket?.length, 1);
  const eight = await send(c.phone, "a de 8");
  assert.deepEqual((await ctxOf(c.convoId)).pending?.[0].options.map((o) => o.sku), ["dsp-312983"], eight);
});
