// Rodada 1 de testes de WhatsApp (09/10), grupo f2: número da casa junto do CEP, "1" como "sim", cesta vencida,
// "pix" sem pedido, "pagar" com endereço incompleto, endereço que vira item. Conversa de ponta a ponta + peças puras.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { dropAddressOnlyItems, extractLabeledHouseNumber, onboardingNote, parseHouseNumberReply } from "../src/lib/address-parse";
import { __setRepeatModelForTests, rewriteRepeated } from "../src/lib/dialogue/repeat";
import * as copy from "../src/lib/lia-copy";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
  if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
  (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
    outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
    return key === "sendDeliveryChoices" ? false : { provider: "test", to };
  };
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `f2_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  return phone;
}
async function registered() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function setCtx(phone: string, ctx: Record<string, unknown>) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const convo = await prisma.conversation.findFirst({ where: { userId: user.id } });
  const data = JSON.stringify({ flow: "delivery", ...ctx });
  if (convo) await prisma.conversation.update({ where: { id: convo.id }, data: { context: data } });
  else await prisma.conversation.create({ data: { userId: user.id, context: data } });
}
async function age(phone: string, hours: number) {
  await prisma.$executeRaw`UPDATE "Message" SET "createdAt" = "createdAt" - (${hours} * interval '1 hour') WHERE "conversationId" IN (SELECT c.id FROM "Conversation" c JOIN "User" u ON u.id = c."userId" WHERE u.phone = ${phone})`;
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
  __setRepeatModelForTests(null);
});
after(async () => {
  __setRepeatModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------- puros

test("número rotulado junto do pedido: sai do texto e nunca vira item", () => {
  assert.deepEqual(extractLabeledHouseNumber(", número 1000, quero pão de forma e manteiga"), { numero: "1000", rest: "quero pão de forma e manteiga" });
  assert.deepEqual(extractLabeledHouseNumber("nº 221 ap 13, quero leite"), { numero: "221", complemento: "ap 13", rest: "quero leite" });
  assert.equal(extractLabeledHouseNumber("quero 2 pacotes de arroz"), null);
  assert.equal(extractLabeledHouseNumber("número 0"), null);
  assert.equal(onboardingNote("número 1000").text, "");
});

test("número 0 e rua sem nome não são endereço", () => {
  assert.equal(parseHouseNumberReply("0", { street: "Rua A" }), null);
  assert.equal(onboardingNote("rua sem nome 0").text, "");
});

test("sobra de endereço (mudei, nome da cidade) não vira item", () => {
  assert.equal(dropAddressOnlyItems("mudei", { city: "São Paulo" }), undefined);
  assert.equal(dropAddressOnlyItems("Rio de Janeiro", { city: "Rio de Janeiro" }), undefined);
  assert.equal(dropAddressOnlyItems("mudei, arroz", { city: "São Paulo" }), "arroz");
  assert.equal(dropAddressOnlyItems("leite e pão", { city: "São Paulo" }), "leite e pão");
});

test("repetição sem IA: só agradecimento/despedida ganha '👍'; '1' e 'pagar' repetem a pergunta", async () => {
  process.env.LIA_DIALOGUE_LLM = "true";
  const recent = ["Quer trocar? Responde *sim*."];
  assert.equal(await rewriteRepeated({ customer: "1", said: recent[0], recent }), null);
  assert.equal(await rewriteRepeated({ customer: "pagar", said: recent[0], recent }), null);
  assert.ok(await rewriteRepeated({ customer: "valeu", said: recent[0], recent }));
});

// ---------------------------------------------------------------- conversa

test("CEP + número + pedido na mesma mensagem: salva o número e segue com os itens", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await newcomer();
  const out = await send(phone, "meu cep é 01310-100, número 1000, quero pão de forma e manteiga");
  const ctx = await context(phone);
  assert.match(ctx.deliveryAddress, /1000/);
  assert.equal(ctx.deliveryAddressVerified, true);
  assert.doesNotMatch(out, /falta só o \*número\*/);
  assert.doesNotMatch(out, /número 1000/i);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.match(user.defaultAddress ?? "", /1000/);
});

test("'1' à pergunta de trocar o endereço é 'sim', não o número da casa", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  await setCtx(phone, { step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true });
  const ask = await send(phone, "04538-132");
  assert.match(ask, /Responde \*sim\*/);
  const out = await send(phone, "1");
  assert.match(out, /falta só o \*número\*/, "trocou e pediu o número");
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.doesNotMatch(user.defaultAddress ?? "", /Faria Lima, 1\b/);
});

test("'1' à pergunta de embalagem é 'sim' (não trava em 👍/'Por nada!')", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  const option = { sku: "x-1", name: "Ovos 10 un", unitPrice: 10, storeKey: "mambo", storeLabel: "Mambo" };
  await setCtx(phone, {
    step: "choosing",
    cep: "01310-100",
    deliveryAddress: ADDRESS,
    deliveryAddressVerified: true,
    pending: [{ query: "uma dúzia de ovos", qty: 12, qtyExplicit: true, options: [option] }],
    packConfirm: { sku: "x-1", askedQty: 12 }
  });
  const out = await send(phone, "1");
  assert.doesNotMatch(out, /^(👍|Tudo certo|Por nada)/);
  const ctx = await context(phone);
  assert.equal(ctx.packConfirm, undefined);
});

test("cesta vencida: quem volta é avisado e retoma com 'sim'; 'pagar' não cai em cesta vazia sem contexto", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  const item = (name: string, sku: string) => ({ sku, name, ask: name, qty: 1, unitPrice: 5, lineTotal: 5, storeKey: "mambo", storeLabel: "Mambo" });
  await setCtx(phone, { step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, basket: [item("arroz", "a"), item("feijão", "b")] });
  await send(phone, "e aí");
  await age(phone, 8);
  const hello = await send(phone, "oi");
  assert.match(hello, /Sua cesta de 2 itens \(arroz, feijão\) expirou/);
  assert.match(hello, /\*sim\*/);
  const again = await send(phone, "pagar");
  assert.doesNotMatch(again, /cesta está vazia/);
  assert.match(again, /expirou/);
  const resumed = await send(phone, "sim");
  assert.doesNotMatch(resumed, /cesta está vazia|Não entendi/);
  assert.equal((await context(phone)).expiredCart, undefined);
});

test("cesta vencida: pedido novo segue direto, sem aviso", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  const item = { sku: "a", name: "arroz", ask: "arroz", qty: 1, unitPrice: 5, lineTotal: 5, storeKey: "mambo", storeLabel: "Mambo" };
  await setCtx(phone, { step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, basket: [item] });
  await send(phone, "e aí");
  await age(phone, 8);
  const out = await send(phone, "quero leite");
  assert.doesNotMatch(out, /expirou/);
  assert.equal((await context(phone)).expiredCart, undefined);
});

test("'pix'/'cartão' sem pedido aberto: resposta curta, sem busca nem FAQ", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  await setCtx(phone, { step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true });
  const started = Date.now();
  const out = await send(phone, "pix");
  assert.equal(out, copy.noOpenOrderToPay());
  assert.ok(Date.now() - started < 3000, "sem busca de produto");
  assert.doesNotMatch(await send(phone, "cartão"), /não achei/i);
});

test("'pagar' com o endereço sem número diz o que falta (não manda só 👍)", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  await setCtx(phone, {
    step: "need_address",
    cep: "22041-001",
    deliveryAddress: "Avenida Atlântica, Copacabana, Rio de Janeiro",
    deliveryAddressVerified: false,
    cepPlace: { street: "Avenida Atlântica", district: "Copacabana" }
  });
  const out = await send(phone, "pagar");
  assert.match(out, /preciso do \*número\*/);
  assert.match(out, /Avenida Atlântica/);
});

test("'mudei, entrega na <rua>' atualiza o endereço sem tratar 'mudei' como item", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await registered();
  await setCtx(phone, { step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true });
  const out = await send(phone, "mudei, entrega na Rua Joaquim Floriano 466, 04534-002");
  assert.match(out, /Endereço atualizado/);
  assert.doesNotMatch(out, /\*mudei\*/);
});

test("'rua sem nome 0' não vira endereço salvo nem item", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = await newcomer();
  const out = await send(phone, "rua sem nome 0");
  assert.doesNotMatch(out, /Endereço salvo/);
  assert.doesNotMatch(out, /Já anotei/);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.defaultAddress, null);
});
