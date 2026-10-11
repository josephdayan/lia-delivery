// Rodada 22, grupo G60 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada22/grupo-b.md (A1, M1, M2, M3, M5, M6,
// B1, B2, B6) e grupo-a.md (R21a-5 pergunta composta, R21-3, R21-9, N4, N5).
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, planPreSignup, reconcilePreItems, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { detectIntent, parseItemAtStore } from "../src/lib/lia-intents";
import { applyPendingCorrection, parsePendingCorrection } from "../src/lib/pending-edits";
import { splitAddressAndItems } from "../src/lib/address-parse";
import { suggestComplement } from "../src/lib/recommend/complement";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5522${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
after(async () => {
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting", opts: { address?: boolean } = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const withAddress = opts.address !== false;
  const user = await prisma.user.create({ data: { phone, ...(withAddress ? { cep: "01310-100", defaultAddress: ADDRESS } : {}), name: "Maria da Silva" } });
  const base = withAddress ? { flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true } : { flow: "delivery", step };
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ ...base, ...ctxExtra }) } });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g60_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});

// ---------------------------------------------------------------- R22-1 (A1): correção antes do cadastro

const SAID = "ah espera, o amaciente nao, deixa so o sabao e a esponja";

test("R22-1: 'o amaciente nao, deixa so o sabao e a esponja' tira o amaciante (e o gêmeo com erro) e mantém o sabão em pó", () => {
  assert.deepEqual(parsePendingCorrection(SAID), { remove: ["amaciente"], keep: ["sabao", "esponja"] });
  const out = applyPendingCorrection(["sabão em pó", "amaciante", "esponja pra lavar a louça", "amaciente"], SAID);
  assert.deepEqual(out?.segments, ["sabão em pó", "esponja pra lavar a louça"]);
  assert.deepEqual(out?.removed, ["amaciante", "amaciente"]);
  // Outras formas de tirar.
  assert.deepEqual(applyPendingCorrection(["arroz", "amaciante"], "sem amaciante")?.segments, ["arroz"]);
  assert.deepEqual(applyPendingCorrection(["arroz", "amaciante"], "amaciante eu ja disse que nao quero")?.segments, ["arroz"]);
  // Não é correção: pedido novo junto, ou item mantido que não está na lista, ou frases que não citam item.
  assert.equal(applyPendingCorrection(["arroz", "amaciante"], "o amaciante não, põe um detergente"), null);
  assert.equal(applyPendingCorrection(["arroz", "amaciante"], "deixa só o feijão e o arroz"), null);
  assert.equal(parsePendingCorrection("só quero 1 desodorante, o roll-on. tira os outros dois"), null);
  assert.equal(parsePendingCorrection("fica só o aerosol"), null);
  assert.equal(parsePendingCorrection("café sem açúcar"), null);
});

test("R22-1: na conversa, a correção antes do cadastro tira o amaciante sem item fantasma", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pendingRequest: "sabão em pó, amaciante, esponja pra lavar a louça, amaciente" }, "need_address", { address: false });
  const out = await send(c.phone, SAID);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.pendingRequest, "sabão em pó, esponja pra lavar a louça");
  assert.match(out, /Tirei \*amaciante\*/);
  assert.doesNotMatch(out, /espera amaciente/);
  // O amaciante tirado não volta como complemento no fechamento (R22-5 M1).
  assert.ok(ctx.complementDeclined?.includes("amaciante"), JSON.stringify(ctx.complementDeclined));
});

test("R22-1: erro de digitação de uma vogal não duplica o item, e 'quanto custa mais ou menos' não vira item", () => {
  const items = reconcilePreItems(
    [{ query: "sabão em pó", qty: 1, cheapest: false }, { query: "amaciante", qty: 1, cheapest: false }, { query: "esponja pra lavar a louça", qty: 1, cheapest: false }],
    "preciso de sabaão em po, um amaciente e uma esponja pra lavar a louça"
  );
  assert.deepEqual(items.map((i) => i.query), ["sabão em pó", "amaciante", "esponja pra lavar a louça"]);
  const asked = reconcilePreItems([{ query: "papel higiênico", qty: 1, cheapest: false }], "e tem papel higenico tambem? quanto custa mais ou menos");
  assert.deepEqual(asked.map((i) => i.query), ["papel higiênico"]);
  // A pergunta de preço junto do item é do item, não "vocês comparam preços?".
  const plan = planPreSignup(D({ items: [{ query: "papel higiênico", qty: 1, cheapest: false }], answers: ["price_compare"] }), { text: "e tem papel higenico tambem? quanto custa mais ou menos" });
  assert.ok(plan.ok && !plan.steps.some((s) => s.type === "answer"), JSON.stringify(plan));
});

// ---------------------------------------------------------------- R22-5 (M1, M2, M5)

test("R22-5: item tirado não volta como complemento", () => {
  const item = (name: string) => ({ name, sku: name, storeKey: "x" });
  const shelf = () => undefined;
  assert.equal(suggestComplement([item("Sabão em Pó Surf 800g")], { shelfById: shelf })?.query, "amaciante");
  assert.notEqual(suggestComplement([item("Sabão em Pó Surf 800g")], { shelfById: shelf, recentlyDeclined: ["amaciante"] })?.query, "amaciante");
  assert.notEqual(suggestComplement([item("Sabão em Pó Surf 800g")], { shelfById: shelf, recentlyDeclined: ["Amaciante Concentrado Comfort 1L"] })?.query, "amaciante");
});

test("R22-5: 'isso eh tudo, quanto deu?' fecha a lista", () => {
  assert.equal(detectIntent("isso eh tudo, quanto deu?").kind, "done");
  assert.equal(detectIntent("isso é tudo, quanto fica?").kind, "done");
  assert.equal(detectIntent("era isso, quanto deu?").kind, "done");
  assert.equal(detectIntent("não era isso").kind, "reject");
});

test("R22-5: 'o sabão em pó da farmácia indiana' é item + loja", () => {
  assert.deepEqual(parseItemAtStore("o sabão em pó da farmácia indiana", ["Farmácia Indiana", "Americanas"]), { item: "sabao em po", store: "Farmácia Indiana" });
  assert.equal(parseItemAtStore("quero arroz e feijão", ["Farmácia Indiana"]), null);
  assert.equal(parseItemAtStore("da farmácia indiana", ["Farmácia Indiana"]), null);
});

// ---------------------------------------------------------------- R22-6 (M3): endereço de outra pessoa por texto

test("R22-6: 'o endereço é da minha mae, não o meu: Rua…' não deixa item", () => {
  const split = splitAddressAndItems("o endereço é da minha mae, não o meu: Rua Augusta 1500, Consolação, São Paulo, 01304-001");
  assert.ok(split);
  assert.equal(split!.items, undefined);
  // Pedido junto continua sendo pedido.
  assert.match(splitAddressAndItems("quero 2 sabonetes, Rua Augusta 1500, Consolação, São Paulo, 01304-001")?.items ?? "", /sabonetes/);
});

// ---------------------------------------------------------------- R22-8 (M6): volta com mudanças

test("R22-8: 'oi voltei! esqueci de falar, tira X e põe Y' é a ordem, não só a volta", () => {
  const intent = detectIntent("oi voltei! esqueci de falar, tira a fita adesiva que eu já tenho e põe também um cabo usb c de 2 metros");
  assert.equal(intent.kind, "remove_item");
  assert.equal(detectIntent("pronto voltei, onde a gente tava?").kind, "resume_where");
  assert.doesNotMatch(copy.resumeHeader(), /Bem-vind[ao]/);
});

test("R22-8: 'tira a fita adesiva, eu já tenho' tira e não pergunta o que ele já tem", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "pilha AA", qty: 1, options: [opt("drogal-1", "Pilha Rayovac AA 4 Unidades", 13.96, "drogal", "Drogal"), opt("drogal-2", "Pilha Panasonic AA 4 unidades", 12.09, "drogal", "Drogal")] },
        { query: "fita adesiva", qty: 1, options: [opt("am-fita", "Fita Adesiva Transparente 45mm", 8.99)] }
      ]
    },
    "choosing"
  );
  let asked = false;
  __setDialogueModelForTests(async () => {
    asked = true;
    return null;
  });
  process.env.LIA_DIALOGUE_LLM = "true";
  const out = await send(c.phone, "tira a fita adesiva, eu já tenho");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["pilha AA"]);
  assert.match(out, /Tirei/);
  assert.equal(asked, false, "a IA não é chamada pro motivo");
});

// ---------------------------------------------------------------- R22-9 (B1, B2)

test("R22-9: antes do cadastro, 'deixa essa mesmo, vlw' com a lista anotada não se despede", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ farewell: true }));
  const c = await customerWith({ pendingRequest: "caderno 10 materias, 3 canetas azuis, mochila preta" }, "need_address", { address: false });
  const out = await send(c.phone, "ah sei la deixa essa mesmo, vlw");
  assert.ok(out.includes(copy.notedListKept()), out);
  assert.ok(!out.includes(copy.medicineFarewell()), out);
  // Ir embora de verdade continua sendo despedida.
  const c2 = await customerWith({ pendingRequest: "caderno 10 materias" }, "need_address", { address: false });
  const bye = await send(c2.phone, "obrigado, vou procurar em outro lugar");
  assert.ok(bye.includes(copy.medicineFarewell()), bye);
});

test("R22-9: 'q mochila cara, tem outra mais baratinha?' antes de mostrar opções diz isso e guarda o mais barato", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pendingRequest: "caderno 10 materias, mochila preta" }, "need_address", { address: false });
  const out = await send(c.phone, "mano q mochila cara, tem outra mais baratinha?");
  assert.ok(out.includes(copy.noPricesShownYet("mochila preta")), out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.pendingRequest, "caderno 10 materias, mochila preta mais barato");
});

// ---------------------------------------------------------------- R22a-1: pergunta composta com item da fila

test("R22a-1: 'qual a diferença de preço? e o termometro é digital mesmo?' compara a tela e responde o termômetro à parte", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "caderno universitário 10 matérias", qty: 1, options: [opt("am-cad-1", "Caderno Universitário 10 Matérias 160 Folhas Tilibra", 27.39), opt("am-cad-2", "Caderno Universitário 10 Matérias 160 Folhas Jandaia", 24.19)] },
        { query: "termômetro", qty: 1, options: [opt("dsp-1", "Termômetro Clínico Digital G-Tech", 15.39, "dsp", "Drogaria São Paulo")] }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "qual a diferença de preço? e o termometro é digital mesmo?");
  assert.ok(out.includes(copy.queuedItemAskedLater(["termômetro"])), out);
  assert.doesNotMatch(out, /não está entre as opções/);
  assert.match(out, /Jandaia/);
});

// ---------------------------------------------------------------- R22a-2: tirar o item que está em troca aberta

test("R22a-2: 'tira a caneca e o chocolate' tira a caneca e a troca aberta do chocolate", async (t) => {
  if (!dbOk) return t.skip();
  const choc = bi("am-choc", "Caixa de Bombom Trento Momentos Chocolate ao Leite 168g", 14.29, { ask: "caixa de chocolate" });
  const c = await customerWith(
    {
      basket: [bi("am-caneca", "Caneca Cerâmica 220ml Casual Home", 10.99, { ask: "caneca" }), bi("cea-creme", "creme para mãos cereja 45 ML", 18.69, { storeKey: "cea", storeLabel: "C&A", ask: "creme para mãos" })],
      pending: [{ query: "caixa de chocolate", qty: 1, options: [opt("mambo-lindt", "Caixa de Bombons Lindt Lindor 75g", 32.98, "mambo", "Mambo")], swappedOut: [choc] }]
    },
    "choosing"
  );
  const out = await send(c.phone, "tira a caneca e o chocolate então");
  assert.doesNotMatch(out, /não está na sua cesta/);
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), ["cea-creme"]);
  assert.equal(ctx.pending?.length ?? 0, 0);
});

// ---------------------------------------------------------------- R22a-7 (N4, N5)

test("R22a-7: 🧻 com o papel higiênico já na lista diz que já está", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "mamadeira", qty: 1, options: [opt("drogal-387", "Mamadeira Kuka Aquarela 250ml", 17.7, "drogal", "Drogal"), opt("dsp-2", "Mamadeira João e Maria 240ml", 23.67, "dsp", "Drogaria São Paulo")] },
        { query: "fralda", qty: 1, options: [opt("am-fr", "Fralda Pampers G", 47.29)] },
        { query: "papel higiênico", qty: 1, options: [opt("am-ph", "Papel Higiênico Neve 12 rolos", 19.9)] }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "🧻");
  assert.ok(out.includes(copy.emojiAlreadyListed(["papel higiênico"])), out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.length ?? 0, 0, "nada foi escolhido");
  assert.equal(ctx.pending?.length, 3);
});

test("R22a-7: 'só isso' com só a troca aberta (o item atual na cesta) fecha mantendo o item", async (t) => {
  if (!dbOk) return t.skip();
  const creme = bi("cea-creme", "creme para mãos cereja 45 ML", 18.69, { storeKey: "cea", storeLabel: "C&A", ask: "creme para mãos" });
  const c = await customerWith(
    {
      basket: [bi("am-caneca", "Caneca Cerâmica 220ml", 10.99, { ask: "caneca" }), creme],
      pending: [{ query: "creme para mãos", qty: 1, options: [opt("am-creme", "Creme para Mãos Nivea 75g", 12.9)], replaceSku: creme.sku }]
    },
    "choosing"
  );
  const out = await send(c.phone, "só isso");
  assert.doesNotMatch(out, /Ainda falta/);
  assert.ok(out.includes(copy.itemKept(creme.name)), out);
});
