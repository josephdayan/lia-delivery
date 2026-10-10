// Rodada 11, grupo G33 (10/10): reteste em produção dos achados R10a-3/4 e R10-1 depois do PR #19. Os testes de conversa
// começam no "oi" e passam pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "esquece tudo" com itens JÁ ESCOLHIDOS e depois "ops, volta tudo" / "volta tudo como estava": a cesta escolhida
//      não voltava (o limpar da cesta ativa não guardava o retrato para o desfazer);
//   2. item da cesta CITADO ("então 3 do arroz mesmo", "o Pilão de 29,48") somava em vez de confirmar; marca/variante do
//      genérico da fila ("6 Piracanjuba desnatado" com *leite* na fila) abria um 2º item; "ovos uma dúzia" da IA ia pra
//      busca com a contagem dentro (o "não achei" intermitente); preço dito que nenhuma opção tem virava "o mais comum";
//   5. "Cabe, sim… uns R$ 0,00" sem nada escolhido; "aniversário hoje" como item.
// Textos reais de /mnt/project-files/testes-whatsapp/rodada11/grupo-a.md.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { citedQty, citesBasketLine, handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { refineByPriceCues, refinesQueuedItem } from "../src/lib/dialogue/execute";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { isNonItemSegment, isOccasionWhen } from "../src/lib/lia-intents";
import { budgetLeftAnswer } from "../src/lib/lia-copy";
import { reconcileLineCounts, resolveListItems } from "../src/lib/list-items";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5531${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
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

const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  return new Response("{}", { status: 404 });
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
beforeEach(() => {
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
afterEach(() => {
  __clearLiveCheckCacheForTests();
  process.env.LIA_LIVE_FREIGHT_OFF = "true";
  process.env.LIA_OPERATOR_QUOTE = "true";
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g33_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
async function signedUp(): Promise<string> {
  const phone = newPhone();
  assert.match(await send(phone, "oi"), /endereço completo/i);
  assert.match(await send(phone, ADDRESS_MSG), /Endereço salvo/);
  return phone;
}
async function pickAll(phone: string): Promise<string> {
  let transcript = "";
  for (let i = 0; i < 6 && (await ctxOf(phone)).pending?.length; i++) transcript += `\n---\n${await send(phone, "1")}`;
  return transcript;
}

// 1 ------------------------------------------------------------------------------------------------------------------
test("1: 'esquece tudo' com os itens JÁ escolhidos e depois 'ops, volta tudo' / 'volta tudo como estava' devolve a cesta", async (t) => {
  if (!dbOk) return t.skip();
  for (const undo of ["ops, volta tudo, continua com a lista", "volta tudo como estava", "desfaz isso, quero a lista de volta"]) {
    const phone = await signedUp();
    await send(phone, "quero arroz e feijão");
    await pickAll(phone);
    const chosen = ((await ctxOf(phone)).basket ?? []).map((b) => b.sku).sort();
    assert.equal(chosen.length, 2, "dois escolhidos");
    assert.match(await send(phone, "esquece tudo"), /Carrinho limpo/);
    assert.equal((await ctxOf(phone)).basket?.length ?? 0, 0, "limpou");
    const out = await send(phone, undo);
    assert.match(out, /não limpei nada: voltei/, `${undo}: ${out.slice(0, 400)}`);
    assert.doesNotMatch(out, /não achei|O que você gostaria/i, out.slice(0, 400));
    assert.deepEqual(((await ctxOf(phone)).basket ?? []).map((b) => b.sku).sort(), chosen, undo);
  }
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: item da cesta citado ('então 3 do arroz mesmo', 'o Pilão de 29,48') confirma ou acerta a quantidade, sem somar", async (t) => {
  assert.equal(citesBasketLine("então 6 do Piracanjuba desnatado mesmo"), true);
  assert.equal(citedQty("então 6 do Piracanjuba desnatado mesmo"), 6);
  assert.equal(citesBasketLine("o Pilão de 29,48"), true);
  assert.equal(citedQty("o Pilão de 29,48"), undefined);
  // Pedido de somar continua somando (M3 da rodada 4).
  for (const add of ["2 refrigerante coca cola sem açúcar lata", "mais um arroz", "outro pilão"]) assert.equal(citesBasketLine(add), false, add);
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero arroz e feijão");
  await pickAll(phone);
  const arroz = ((await ctxOf(phone)).basket ?? []).find((b) => /arroz/i.test(b.name));
  assert.ok(arroz, "arroz escolhido");
  const out = await send(phone, "então 3 do arroz mesmo");
  assert.doesNotMatch(out, /somei na mesma linha/, out.slice(0, 400));
  assert.match(out, /fica em \*3x\*/, out.slice(0, 400));
  const line = ((await ctxOf(phone)).basket ?? []).find((b) => b.sku === arroz!.sku);
  assert.equal(line?.qty, 3);
});

test("2b: marca/variante do genérico da fila substitui o genérico; 'leite condensado' é outro item", () => {
  const piracanjuba = { query: "Piracanjuba desnatado", options: [{ name: "Leite Piracanjuba Desnatado UHT 1L" }, { name: "Leite Desnatado + Cálcio Piracanjuba 1L" }, { name: "Leite Piracanjuba Desnatado Zero Lactose 1L" }] };
  assert.equal(refinesQueuedItem({ query: "leite" }, piracanjuba), true);
  assert.equal(refinesQueuedItem({ query: "arroz" }, piracanjuba), false);
  assert.equal(refinesQueuedItem({ query: "leite" }, { query: "leite condensado", options: [{ name: "Leite Condensado Moça 395g" }] }), false);
});

test("2c: preço dito no desempate filtra as opções; preço que nenhuma tem não vira 'o mais comum'; 'o mais barato' desempata pelo preço", () => {
  const options = [
    { name: "Café Tradicional Pilão 500g Almofada", unitPrice: 44 },
    { name: "Café Tradicional a Vácuo Pilão 500g", unitPrice: 24 },
    { name: "Café Extra Forte a Vácuo Pilão 500g", unitPrice: 23 }
  ];
  assert.equal(refineByPriceCues(["o mais barato de 500g", "o Pilão de 29,48"], options), "price_miss");
  const cheapest = refineByPriceCues(["o mais barato de 500g"], options);
  assert.ok(Array.isArray(cheapest) && cheapest.length === 1 && /Extra Forte/.test(cheapest[0].name), JSON.stringify(cheapest));
});

test("2d: 'uma dúzia' / 'meia dúzia' que a IA deixa dentro da frase sai da busca e vira a quantidade", () => {
  const said = "uma dúzia de ovos";
  for (const ai of [[{ phrase: "ovos uma dúzia", qty: 12 }], [{ phrase: "dúzia de ovos", qty: 1 }], [{ phrase: "ovos (1 dúzia)", qty: 1 }]]) {
    assert.deepEqual(reconcileLineCounts(ai, said).map((l) => [l.phrase, l.qty]), [["ovos", 12]], JSON.stringify(ai));
    assert.deepEqual(resolveListItems(said, { aiItems: ai }).map((l) => [l.phrase, l.qty]), [["ovos", 12]], JSON.stringify(ai));
  }
  assert.deepEqual(reconcileLineCounts([{ phrase: "pão de alho meia dúzia", qty: 1 }], "meia dúzia de pão de alho").map((l) => [l.phrase, l.qty]), [["pão de alho", 6]]);
});

// 5 ------------------------------------------------------------------------------------------------------------------
test("5a: 'vai ficar dentro dos 60 reais com a entrega?' sem nada escolhido não afirma 'Cabe, sim… R$ 0,00'", async (t) => {
  assert.doesNotMatch(budgetLeftAnswer(60, 0, 0, 2), /Cabe, sim|R\$ 0,00/);
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero arroz e feijão");
  const out = await send(phone, "vai ficar dentro dos 60 reais com a entrega?");
  assert.match(out, /teto de \*R\$ 60,00\*/, out.slice(0, 400));
  assert.doesNotMatch(out, /Cabe, sim|R\$ 0,00/, out.slice(0, 400));
});

test("5b: 'aniversário hoje' é ocasião e prazo, não item", async (t) => {
  for (const s of ["aniversário hoje", "é aniversário dela amanhã", "festa sábado"]) assert.equal(isOccasionWhen(s) && isNonItemSegment(s), true, s);
  for (const s of ["vela de aniversário", "bolo de aniversário pra hoje", "chá de bebê"]) assert.equal(isOccasionWhen(s), false, s);
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  const out = await send(phone, "aniversário hoje, quero arroz e feijão");
  assert.doesNotMatch(out, /\*aniversário hoje\*/, out.slice(0, 500));
});
