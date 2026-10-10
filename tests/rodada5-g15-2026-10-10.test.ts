// Rodada 5, grupo G15 (10/10): pedido antes do cadastro (A2), frase de contexto/pressa que vira item, "brigadeiro"
// lido como agradecimento, quantidade na escolha, preferência de loja da lista toda, teto de preço, rejeição de
// opção, "qualquer marca" e perguntas de frete por loja.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { detectIntent, isQuestion, isNonItemSegment, parseAvailabilityAsk } from "../src/lib/lia-intents";
import { onboardingNote, parsePriceAsk } from "../src/lib/address-parse";
import { preSignupBypassReason } from "../src/lib/dialogue/presignup";
import * as copy from "../src/lib/lia-copy";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5577${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g15_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxByPhone(phone: string) {
  const user = await prisma.user.findFirstOrThrow({ where: { phone } });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}

// A2 ---------------------------------------------------------------------------------------------------------
test("A2: 'qto custa X' é pergunta de preço (com abreviação) e não passa pela IA do pré-cadastro", () => {
  assert.equal(parsePriceAsk("qto custa ração golden 15kg"), "ração golden 15kg");
  assert.equal(parsePriceAsk("qnto ta o leite ninho?"), "leite ninho");
  assert.equal(parsePriceAsk("quanto custa a entrega?"), null);
  const base = { intent: { kind: "free_text" } as const, ctx: { flow: "delivery", step: "need_address" } as never, hasAddress: false, addressLike: false };
  assert.equal(preSignupBypassReason({ ...base, text: "qto custa ração golden 15kg", priceAsk: true }), "pergunta_preco");
});

test("A2: pressa e pergunta sobre o serviço nunca viram item do pedido guardado", () => {
  for (const s of ["rapido pfv", "rapido", "bem rapido por favor", "agiliza ai", "tenho pressa"]) {
    assert.equal(onboardingNote(s).text, "", s);
    assert.equal(isNonItemSegment(s), true, s);
  }
  assert.equal(parseAvailabilityAsk("tem q dar cep antes?"), null);
  assert.equal(parseAvailabilityAsk("tem que pagar antes?"), null);
  assert.equal(parseAvailabilityAsk("tem ração golden?"), "ração golden");
  assert.equal(isQuestion("oq vcs vendem"), true);
  assert.equal(isQuestion("o que voces vendem"), true);
  assert.equal(onboardingNote("ração golden 15kg, rapido").text, "ração golden 15kg");
});

test("A2: antes do cadastro, 'qto custa ração golden 15kg' guarda o item e diz que o preço sai com o CEP", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "ola");
  const out = await send(phone, "qto custa ração golden 15kg");
  assert.match(out, /ração golden 15kg/i, out);
  assert.match(out, /assim que tiver o CEP/i, out);
  for (const msg of ["oq vcs vendem", "rapido pfv", "tem q dar cep antes?"]) {
    const o = await send(phone, msg);
    assert.doesNotMatch(o, /1x (rapido|q dar|oq)/i, `${msg}: ${o}`);
  }
  const ctx = await ctxByPhone(phone);
  assert.match(ctx.pendingRequest ?? "", /ração golden 15kg/i);
  assert.doesNotMatch(ctx.pendingRequest ?? "", /rapido|cep|vendem/i, ctx.pendingRequest);
});

// M8 ---------------------------------------------------------------------------------------------------------
test("M8: 'brigadeiro' não é agradecimento; 'brigado'/'obrigadão' continuam sendo", () => {
  assert.notEqual(detectIntent("brigadeiro").kind, "thanks");
  assert.notEqual(detectIntent("brigadeiros").kind, "thanks");
  for (const s of ["brigado", "brigada", "obrigado", "obrigadão", "muito obrigada", "obrigadinho"]) assert.equal(detectIntent(s).kind, "thanks", s);
});

// Cliente já cadastrado, com contexto pronto.
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "mambo", storeLabel = "Mambo") => ({ sku, name, unitPrice, storeKey, storeLabel });

// M3 ---------------------------------------------------------------------------------------------------------
test("M3: evento que o cliente organiza e idade do aniversariante não viram itens", () => {
  for (const s of ["to organizando o aniversario da minha filha", "8 anos", "estou preparando uma festa", "vou fazer um churrasco"]) assert.equal(isNonItemSegment(s), true, s);
  for (const s of ["whisky 12 anos", "kit festa", "bolo de aniversario"]) assert.equal(isNonItemSegment(s), false, s);
});

// M4 ---------------------------------------------------------------------------------------------------------
test("M4: quantidade dita junto da escolha pelo nome ('o bolo gotas de chocolate, 3') é aplicada", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("mambo-b1", "Bolo Gotas de Chocolate Ana Maria 70g", 3.49), opt("mambo-b2", "Bolo de Laranja Bauducco 250g", 9.9), opt("mambo-b3", "Kit Bolo de Aniversário Fleischmann", 19.9)];
  const c = await customerWith({ basket: [], pending: [{ query: "bolo", qty: 1, options }] }, "choosing");
  let out = await send(c.phone, "o bolo gotas de chocolate, 3");
  t.diagnostic(out.slice(0, 600));
  // O nome estreita para uma opção e o cliente confirma (04/09); a quantidade dita tem que sobreviver.
  if (!(await ctxOf(c.convoId)).basket?.length) out = await send(c.phone, "1");
  const ctx = await ctxOf(c.convoId);
  const line = (ctx.basket ?? []).find((b: { sku: string }) => b.sku === "mambo-b1");
  assert.ok(line, `bolo não entrou: ${out.slice(0, 400)}`);
  assert.equal(line.qty, 3, out.slice(0, 400));
});

// M10 --------------------------------------------------------------------------------------------------------
async function perfumeLine() {
  const { gatherCrossStoreCandidates } = await import("../src/lib/stores");
  const cands = (await gatherCrossStoreCandidates("perfume feminino", 40, 4, { noLongTail: true })).sort((a, b) => b.item.unitPrice - a.item.unitPrice);
  if (cands.length < 2) return null;
  const top = cands[0];
  return { sku: top.item.sku, name: top.item.name, qty: 1, unitPrice: top.item.unitPrice, lineTotal: top.item.unitPrice, storeKey: top.store.key, storeLabel: top.store.label, ask: "perfume feminino" };
}

test("M10: 'troca o perfume por um mais barato, até 5 reais' sem nada no teto não troca calado acima do valor", async (t) => {
  if (!dbOk) return t.skip();
  const line = await perfumeLine();
  if (!line) return t.skip("catálogo de teste sem perfumes");
  const c = await customerWith({ basket: [line] });
  const out = await send(c.phone, "troca o perfume por um mais barato, ate 5 reais");
  t.diagnostic(out.slice(0, 600));
  assert.doesNotMatch(out, /Troquei/i, out.slice(0, 400));
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b: { sku: string }) => b.sku === line.sku), "o original fica até o cliente decidir");
  assert.match(out, /Até R\$\s?5,00 não achei|já está o mais barato/i, out.slice(0, 400));
});

// M11 --------------------------------------------------------------------------------------------------------
test("M11: 'não quero essa, quero com coco' quando nenhuma opção tem coco diz que não achei e dá a saída", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("mambo-t1", "Tapioca Pronta Da Terrinha 500g", 8.9)];
  const c = await customerWith({ basket: [], pending: [{ query: "tapioca pronta de coco congelada", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "nao quero essa, quero com coco");
  t.diagnostic(out.slice(0, 600));
  assert.doesNotMatch(out, /continuam aí em cima/i, out.slice(0, 400));
  assert.match(out, /Não achei \*tapioca pronta de coco congelada\*/i, out.slice(0, 400));
  assert.match(out, /pula/i);
});

// M12 + troca indevida da tela ----------------------------------------------------------------------------------
test("M12: 'qualquer marca' depois do 'não achei' busca a frase do cliente, não refaz a busca perdida", async () => {
  const { planActions } = await import("../src/lib/dialogue/plan");
  const { buildDialogueState } = await import("../src/lib/dialogue/state");
  const state = buildDialogueState({ flow: "delivery", step: "collecting", lastMiss: { query: "ração Whiskas gatinho 1kg", qty: 1, at: Date.now() } } as never, { hasAddress: true });
  const text = "ração pra gatinho filhote qualquer marca";
  for (const action of [{ type: "search", query: "ração Whiskas gatinho 1kg", retry: true }, { type: "search", query: "ração whiskas gatinho 1kg" }]) {
    const plan = planActions({ actions: [action as never] }, state, { text });
    assert.ok(plan.ok);
    const step = plan.ok ? (plan.steps[0] as { type: string; lines: { query: string }[]; retry?: boolean }) : null;
    assert.equal(step?.lines[0].query, text);
    assert.ok(!step?.retry);
  }
});

test("busca no meio da escolha: 'replace' da IA só troca o item da tela se for o mesmo produto ou houver correção", async () => {
  const { planActions } = await import("../src/lib/dialogue/plan");
  const { buildDialogueState } = await import("../src/lib/dialogue/state");
  const state = buildDialogueState(
    { flow: "delivery", step: "choosing", pending: [{ query: "arroz camil 5kg", qty: 1, options: [opt("a1", "Arroz Camil 5kg", 30), opt("a2", "Arroz Camil Parboilizado 5kg", 31)] }] } as never,
    { hasAddress: true }
  );
  const step = (text: string, query: string) => {
    const plan = planActions({ actions: [{ type: "search", query, replace: true } as never] }, state, { text });
    return plan.ok ? (plan.steps[0] as { replace?: boolean }) : null;
  };
  assert.ok(!step("ração pra gatinho filhote qualquer marca", "ração gatinho filhote")?.replace);
  assert.ok(step("na verdade quero feijão", "feijão")?.replace);
  assert.ok(step("arroz tio joão 5kg", "arroz tio joão 5kg")?.replace);
});

test("M11: 'Não achei X' com a vitrine ainda na tela é uma mensagem só, sem 'O que eu tenho é isso:' no ar", () => {
  const t = copy.refineNoResultAbove("perfume feminino nivea", "perfume feminino");
  assert.match(t, /Não achei \*perfume feminino nivea\*/);
  assert.match(t, /aí em cima/);
  assert.doesNotMatch(t, /O que eu tenho é isso:$/);
});
