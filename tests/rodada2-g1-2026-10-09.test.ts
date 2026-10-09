// Rodada 2 (09/10/2026), grupo g1: pergunta sobre o produto na tela de escolha, "👍/obrigado/ok" com escolha aberta, mensagem
// idêntica repetida (nunca silêncio) e "fecha/pagar/quanto tá" dizendo QUAIS itens faltam. A IA é SIMULADA (e contada).
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setRepeatModelForTests } from "../src/lib/dialogue/repeat";
import * as copy from "../src/lib/lia-copy";
import { answerProductQuestion, parseProductQuestion } from "../src/lib/product-question";
import type { DialogueAction, ModelInput } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
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

process.env.LIA_DIALOGUE_LLM = "true";

let calls: ModelInput[] = [];
function mainModel(script: (input: ModelInput) => DialogueAction[] | null) {
  calls = [];
  __setDialogueModelForTests(async (input) => {
    calls.push(input);
    const actions = script(input);
    return actions ? { actions } : null;
  });
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g1_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
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
  process.env.LIA_DIALOGUE_LLM = "true";
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
});
after(async () => {
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

const OPTS = [
  { sku: "cobasi-1", name: "Ração Golden Power Training Cães Adultos Frango, Arroz e Vegetais 15 kg", unitPrice: 180, storeKey: "cobasi", storeLabel: "Cobasi" },
  { sku: "cobasi-2", name: "Ração Golden Mega para Cães Adultos Raças Grandes Frango, Arroz e Vegetais 15 kg", unitPrice: 190, storeKey: "cobasi", storeLabel: "Cobasi" },
  { sku: "cobasi-3", name: "Ração Golden Fórmula Cães Filhotes Frango 15 kg", unitPrice: 200, storeKey: "cobasi", storeLabel: "Cobasi" }
];
const shown = OPTS.map((o) => ({ name: o.name, price: o.unitPrice, storeLabel: o.storeLabel }));
const NO_FILHOTE = shown.slice(0, 2);

// ---------------------------------------------------------------- puros

test("pergunta de produto: público, original, validade, diferença entre N e M, 'o que é o dois'", () => {
  assert.deepEqual(parseProductQuestion("essa ração serve pra filhote?", 3), { kind: "audience", tag: "filhote" });
  assert.deepEqual(parseProductQuestion("é boa pra gato?", 3), { kind: "audience", tag: "gato" });
  assert.deepEqual(parseProductQuestion("é original?", 3), { kind: "original" });
  assert.deepEqual(parseProductQuestion("qual a validade?", 3), { kind: "expiry" });
  assert.deepEqual(parseProductQuestion("qual a diferença entre o 1 e o 2?", 3), { kind: "compare", a: 1, b: 2 });
  assert.deepEqual(parseProductQuestion("qual a diferença entre o primeiro e o terceiro", 3), { kind: "compare", a: 1, b: 3 });
  assert.deepEqual(parseProductQuestion("nao sei o que e o dois", 3), { kind: "explain", n: 2 });
  assert.deepEqual(parseProductQuestion("o que é o 3?", 3), { kind: "explain", n: 3 });
  assert.deepEqual(parseProductQuestion("tem sem lactose?", 3), { kind: "dietary", term: "lactose" });
  // não sequestra pedido/refino/escolha
  for (const t of ["quero o original", "o 2", "tem de filhote?", "mais barato", "quero uma ração para filhote", "qual a diferença?"]) {
    assert.equal(parseProductQuestion(t, 3), null, t);
  }
  assert.equal(parseProductQuestion("o que é o 5?", 3), null, "opção que não existe");
});

test("resposta sobre o produto usa nome/preço/loja e diz com honestidade o que não sabe", () => {
  const filhote = answerProductQuestion({ kind: "audience", tag: "filhote" }, NO_FILHOTE, "ração golden 15kg");
  assert.match(filhote, /cães adultos/);
  assert.match(filhote, /nenhuma diz ser pra filhotes/);
  assert.match(filhote, /ração golden filhotes/, "oferece a alternativa, sem o tamanho");
  const some = answerProductQuestion({ kind: "audience", tag: "filhote" }, shown, "ração golden");
  assert.match(some, /\*3\*/);
  const cmp = answerProductQuestion({ kind: "compare", a: 1, b: 2 }, shown, "ração");
  assert.match(cmp, /Power Training/);
  assert.match(cmp, /Mega/);
  assert.match(cmp, /R\$ 10,00 mais barata/);
  assert.match(answerProductQuestion({ kind: "original" }, shown, "ração"), /Cobasi/);
  assert.match(answerProductQuestion({ kind: "expiry" }, shown, "ração"), /não aparece no cadastro/);
  assert.match(answerProductQuestion({ kind: "explain", n: 2 }, shown, "ração"), /Quer essa\? Responde \*2\*/);
});

test("copy: fecha/pagar/quanto tá dizem quais faltam; o reconhecimento varia e a repetição muda a redação", () => {
  assert.match(copy.finishChoiceFirst(["leite", "macarrão", "fralda G"]), /\*leite\*, \*macarrão\* e \*fralda G\*/);
  const first = copy.finishChoiceFirst(["leite", "macarrão"]);
  const second = copy.finishChoiceFirst(["leite", "macarrão"], [first]);
  assert.notEqual(first, second);
  assert.match(second, /\*leite\* e \*macarrão\*/);
  assert.match(copy.partialTotal([], 0, 3, [], ["leite", "macarrão", "fralda G"]), /\*leite\*, \*macarrão\* e \*fralda G\*/);
  assert.match(copy.partialTotal([{ qty: 1, name: "Arroz", displayLineTotal: 5 }], 5, 2, [], ["leite", "macarrão"]), /Falta escolher: leite, macarrão/);
  const a = copy.choiceAck("arroz", false, true);
  assert.match(a, /continuam aí em cima/);
  const b = copy.choiceAck("arroz", false, false, [a]);
  assert.doesNotMatch(b, /continuam aí em cima/);
  const c = copy.choiceAck("arroz", false, false, []);
  assert.notEqual(c, copy.choiceAck("arroz", false, false, [c]));
});

// ---------------------------------------------------------------- fluxo (banco)

async function choosing(phone: string, extra: Record<string, unknown> = {}) {
  await setCtx(phone, { step: "choosing", pending: [{ query: "ração golden 15kg", qty: 1, options: OPTS }], ...extra });
}

test("perguntas sobre o produto na escolha: respondidas sobre o produto, sem IA, escolha continua aberta", async () => {
  if (!dbOk) return;
  mainModel(() => {
    throw new Error("a IA não deveria ser consultada");
  });
  const phone = await registered();
  await choosing(phone);
  const filhote = await send(phone, "essa ração serve pra filhote?");
  assert.match(filhote, /\*3\*/);
  assert.match(filhote, /continuam aí em cima/);
  assert.doesNotMatch(filhote, /Você só paga DEPOIS|Eu compro em várias/);
  const orig = await send(phone, "é original?");
  assert.match(orig, /site oficial/);
  assert.doesNotMatch(orig, /continuam aí em cima/, "lembrete não repete em falas seguidas");
  const diff = await send(phone, "qual a diferença entre o 1 e o 2?");
  assert.match(diff, /Power Training/);
  assert.match(diff, /Mega/);
  const what = await send(phone, "nao sei o que e o dois");
  assert.match(what, /A opção \*2\* é/);
  assert.equal(calls.length, 0);
  const ctx = await context(phone);
  assert.equal(ctx.step, "choosing", "a escolha segue aberta");
  assert.equal(ctx.pending[0].options.length, 3);
  const pick = await send(phone, "2");
  assert.doesNotMatch(pick, /não peguei/i);
});

test("👍, ok, obrigado e valeu com escolha aberta: curto, sem IA, lembra o item e não repete o lembrete", async () => {
  if (!dbOk) return;
  mainModel(() => {
    throw new Error("a IA não deveria ser consultada");
  });
  const phone = await registered();
  await choosing(phone);
  const thumbs = await send(phone, "👍");
  assert.match(thumbs, /ração golden 15kg/);
  assert.doesNotMatch(thumbs, /Não peguei/);
  const thanks = await send(phone, "obrigado");
  assert.doesNotMatch(thanks, /Qualquer coisa é só chamar/, "não soa como encerramento");
  assert.doesNotMatch(thanks, /continuam aí em cima/, "o lembrete acabou de sair");
  const valeu = await send(phone, "valeu");
  assert.match(valeu, /continuam aí em cima|número/);
  assert.notEqual(valeu, thanks);
  assert.equal(calls.length, 0);
  assert.equal((await context(phone)).step, "choosing");
});

test("fecha/pagar/quanto tá com itens sem escolher: diz quais faltam", async () => {
  if (!dbOk) return;
  mainModel(() => null);
  const phone = await registered();
  await choosing(phone, {
    pending: [
      { query: "leite", qty: 1, options: OPTS },
      { query: "macarrão", qty: 1, options: OPTS },
      { query: "fralda G", qty: 1, options: OPTS }
    ]
  });
  const fecha = await send(phone, "fecha");
  assert.match(fecha, /\*leite\*, \*macarrão\* e \*fralda G\*/);
  const pagar = await send(phone, "pagar");
  assert.match(pagar, /leite/);
  assert.match(pagar, /macarrão/);
  assert.match(pagar, /fralda G/);
  const quanto = await send(phone, "quanto ta ate agora?");
  assert.match(quanto, /leite/);
  assert.match(quanto, /fralda G/);
});

test("mensagem idêntica repetida: turno rodando = 'já estou nisso'; turno terminado = reapresenta as opções; nunca silêncio", async () => {
  if (!dbOk) return;
  mainModel(() => null);
  const phone = await registered();
  await choosing(phone);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "quero 2 leites integrais", metadata: `g1_prev_${RUN}_1` } });
  // 1º turno ainda rodando: o lock está preso
  await prisma.conversation.update({ where: { id: convo.id }, data: { turnLock: "outro-turno", turnLockAt: new Date() } });
  const running = await send(phone, "quero 2 leites integrais");
  assert.match(running, /Já estou nisso, as opções chegam aqui em seguida/);
  // 1º turno terminou: reapresenta a escolha pendente, sem refazer a busca
  await prisma.conversation.update({ where: { id: convo.id }, data: { turnLock: null, turnLockAt: null } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "quero 2 leites integrais", metadata: `g1_prev_${RUN}_2` } });
  const before = outbox.length;
  const done = await send(phone, "quero 2 leites integrais");
  assert.match(done, /Já tinha recebido isso/);
  assert.ok(outbox.slice(before).length >= 2, "o aviso e as opções");
  assert.equal(calls.length, 0);
  const ctx = await context(phone);
  assert.equal(ctx.pending.length, 1, "a busca não foi refeita");
});
