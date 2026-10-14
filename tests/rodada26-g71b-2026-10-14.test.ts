// Rodada 26, grupo B, corretor g71b (14/10): achados A3, B1, M3 e B3 de /mnt/project-files/testes-whatsapp/rodada26/grupo-b.md:
//   A3: "mano, manda 2 coca 🥤 e 1 salgadinho 🍟 pra hj" virava 3 linhas (o 🥤 somava um "refrigerante" à coca);
//   B1: a linha fantasma (Coca-Cola Café Expresso) puxava "Quem leva café em pó costuma levar filtro de papel";
//   M3: com o carrossel na tela, "o segundo" estreitava, "mostra de novo" perguntava de volta e "qual vinho combina
//       com massa?" caía em "Não peguei qual você quer";
//   B3: "qual endereço você tem cadastrado pra mim?" respondia a apresentação da Lia.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { detectIntent, readProductEmojis } from "../src/lib/lia-intents";
import { suggestComplement } from "../src/lib/recommend/complement";
import * as copy from "../src/lib/lia-copy";
import type { ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5526${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g71b_${RUN}_${++seq}` }));
  const mine = outbox.slice(start).filter((o) => o.to === phone);
  return { text: mine.map((o) => o.text).join("\n---\n"), kinds: mine.map((o) => o.kind) };
}
async function ctxOf(convoId: string) {
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } });
  return JSON.parse(convo.context ?? "{}") as DeliveryContext;
}
const opt = (sku: string, name: string, unitPrice: number, extra: Partial<ChoiceOption> = {}): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", ...extra }) as ChoiceOption;

// ---------------- A3: o emoji que ilustra o item não vira outra linha ----------------

test("A3: '2 coca 🥤 e 1 salgadinho 🍟' não soma um 'refrigerante' à parte (o 🥤 ilustra a coca)", () => {
  assert.deepEqual(readProductEmojis("mano, manda 2 coca 🥤 e 1 salgadinho 🍟 pra hj"), { text: "mano, manda 2 coca e 1 salgadinho pra hj" });
  assert.deepEqual(readProductEmojis("2 skol 🍺 e 1 malbec 🍷"), { text: "2 skol e 1 malbec" });
  assert.deepEqual(readProductEmojis("bombom 🍫"), { text: "bombom" });
  // Emoji de OUTRO produto continua sendo item próprio.
  assert.deepEqual(readProductEmojis("arroz 🥤"), { text: "arroz, refrigerante" });
  assert.deepEqual(readProductEmojis("👶 fralda 🧻"), { text: "fralda, papel higiênico" });
  assert.deepEqual(readProductEmojis("pão 🥛"), { text: "pão, leite" });
});

test("A3: antes do cadastro, 'mano, manda 2 coca 🥤 e 1 salgadinho 🍟 pra hj' anota só coca e salgadinho", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const out = await send(phone, "mano, manda 2 coca 🥤 e 1 salgadinho 🍟 pra hj");
  assert.doesNotMatch(out.text, /refrigerante/i, out.text.slice(0, 600));
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  const ctx = JSON.parse(convo.context ?? "{}") as DeliveryContext;
  assert.doesNotMatch(ctx.pendingRequest ?? "", /refrigerante/i, JSON.stringify(ctx).slice(0, 400));
  assert.match(ctx.pendingRequest ?? "", /coca/, JSON.stringify(ctx).slice(0, 400));
});

// ---------------- B1: refrigerante com "café" no nome não pede filtro de papel ----------------

test("B1: 'Refrigerante Coca-Cola Café Expresso' não dispara o filtro de papel; café em pó continua disparando", () => {
  const shelfById = () => null;
  const soda = suggestComplement([{ name: "Refrigerante Coca-Cola Café Expresso 220ml", sku: "s1" }], { shelfById });
  assert.notEqual(soda?.trigger, "café");
  const coffee = suggestComplement([{ name: "Café em Pó Tradicional Pilão 500g", sku: "c1" }], { shelfById });
  assert.equal(coffee?.trigger, "café");
});

// ---------------- B3: "qual endereço você tem cadastrado pra mim?" ----------------

test("B3: 'qual endereço você tem cadastrado pra mim?' é pergunta do endereço salvo", () => {
  for (const phrase of ["qual endereço você tem cadastrado pra mim?", "qual meu endereço?", "qual o endereço que vc tem?", "qual cep vc tem cadastrado?"]) {
    assert.equal(detectIntent(phrase).kind, "address_question", phrase);
  }
  assert.notEqual(detectIntent("qual o endereço da loja?").kind, "address_question");
  assert.notEqual(detectIntent("Rua Augusta 500, Consolação, São Paulo, 01305-000").kind, "address_question");
});

test("B3: com endereço salvo, a pergunta mostra o endereço e oferece trocar (sem a IA, sem 'atualizado')", async (t) => {
  if (!dbOk) return t.skip();
  let modelCalled = false;
  __setDialogueModelForTests(async () => {
    modelCalled = true;
    return { actions: [{ type: "reply", kind: "unclear", text: "Você quer alterar o endereço cadastrado?" }] } as never;
  });
  const c = await customerWith({});
  const out = await send(c.phone, "qual endereço você tem cadastrado pra mim?");
  assert.match(out.text, /Avenida Paulista, 1000/, out.text);
  assert.match(out.text, /trocar/i, out.text);
  assert.doesNotMatch(out.text, /atualizado|Sou a Lia|quer alterar/i, out.text);
  assert.equal(modelCalled, false, "resposta fixa, sem chamar a IA");
});

// ---------------- M3: ordinal, "mostra de novo" e pergunta de conselho com o carrossel na tela ----------------

function giftCase() {
  return [
    {
      query: "perfume ou kit de beleza",
      qty: 1,
      options: [
        opt("g-1", "Perfume Feminino Floratta Rose 75ml", 89.9, { storeKey: "drogariasp", storeLabel: "Drogaria São Paulo" }),
        opt("g-2", "Kit Nivea Hidratante Corporal + Desodorante", 39.9, { storeKey: "pacheco", storeLabel: "Drogarias Pacheco" }),
        opt("g-3", "Kit Presente Natura Tododia Ameixa", 79.9, { storeKey: "drogariasp", storeLabel: "Drogaria São Paulo" })
      ]
    }
  ];
}

test("M3: 'o segundo' com 3 cards escolhe o 2º card (a IA não estreita pelo 2º tipo do 'perfume ou kit')", async (t) => {
  if (!dbOk) return t.skip();
  let modelCalled = false;
  __setDialogueModelForTests(async () => {
    modelCalled = true;
    return { actions: [{ type: "refine", attribute: "kit de beleza" }] } as never;
  });
  const c = await customerWith({ pending: giftCase() }, "choosing");
  const out = await send(c.phone, "o segundo");
  assert.doesNotMatch(out.text, /Ficou entre essas/i, out.text.slice(0, 600));
  assert.equal(modelCalled, false);
  const after = await ctxOf(c.convoId);
  assert.ok((after.basket ?? []).some((b) => b.sku === "g-2"), JSON.stringify(after).slice(0, 600));
  assert.ok(!(after.basket ?? []).some((b) => b.sku === "g-1" || b.sku === "g-3"));
});

test("M3: 'mostra de novo as ideias de presente' reenvia o carrossel (não pergunta de volta)", async (t) => {
  if (!dbOk) return t.skip();
  __setDialogueModelForTests(async () => ({ actions: [{ type: "reply", kind: "unclear", text: "Você quer ver outras opções de presente ou rever essas três?" }] }) as never);
  for (const phrase of ["mostra de novo as ideias de presente", "mostra de novo", "rever essas três"]) {
    const c = await customerWith({ pending: giftCase() }, "choosing");
    const out = await send(c.phone, phrase);
    assert.doesNotMatch(out.text, /rever essas|outras opções/i, `${phrase}: ${out.text.slice(0, 600)}`);
    assert.match(out.text, /Floratta/, `${phrase}: ${out.text.slice(0, 600)}`);
    assert.match(out.text, /Kit Nivea/, `${phrase}: ${out.text.slice(0, 600)}`);
    const after = await ctxOf(c.convoId);
    assert.equal(after.pending?.[0]?.options.length, 3, phrase);
  }
});

test("M3: 'qual vinho combina com massa?' com o carrossel do jantar responde a dica e mantém as opções", async (t) => {
  if (!dbOk) return t.skip();
  __setDialogueModelForTests(async () => ({ actions: [{ type: "reply", kind: "unclear" }] }) as never);
  const pending = [
    {
      query: "jantar romântico",
      qty: 1,
      options: [
        opt("j-1", "Vinho Tinto Cabernet Sauvignon Finca Magnolia 750ml", 43.97, { storeKey: "swift", storeLabel: "Swift" }),
        opt("j-2", "Taça para Vinho Tinto em Cristal Bohemia 450ml", 34.73, { storeKey: "brinox", storeLabel: "Brinox" }),
        opt("j-3", "Caixa de Bombom Lacta Grandes Sucessos 250,6g", 19.79, { storeKey: "drogal", storeLabel: "Drogal" })
      ]
    }
  ];
  const c = await customerWith({ pending }, "choosing");
  const out = await send(c.phone, "qual vinho combina com massa?");
  assert.doesNotMatch(out.text, /Não peguei/i, out.text.slice(0, 600));
  assert.match(out.text, /tinto/i, out.text.slice(0, 600));
  assert.match(out.text, /Cabernet Sauvignon Finca Magnolia/, out.text.slice(0, 600));
  assert.doesNotMatch(out.text, /\*2\* — Taça/, out.text.slice(0, 600));
  const after = await ctxOf(c.convoId);
  assert.equal(after.pending?.[0]?.options.length, 3, "a escolha continua aberta");
  assert.ok(!(after.basket ?? []).length, "nada escolhido sozinho");
});

