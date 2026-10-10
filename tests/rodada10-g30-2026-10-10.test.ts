// Rodada 10, grupo G30 (10/10): reteste em produção dos achados que "corrigidos" com teste verde voltavam a aparecer. Os
// testes de conversa começam no "oi" e passam pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. o resumo do total não avisava o item que ficou de fora quando a cotação passava pela escolha de entrega barata ×
//      rápida (a escrita do `choosing_freight` não carregava `listMisses`); "tira o gelo" depois caía na IA;
//   2. itens pedidos junto da ideia de presente sumiam; "não achei" falso na lista urgente (o "chega hoje" ficava só com
//      o produto parecido);
//   3. "ops, volta tudo" / "desfaz isso" / "volta tudo como estava"; "orçamento R$ X no total"; "cada um vai pagar o seu …
//      e também quero café"; "CEP X, número Y" com endereço já confirmado; "um par" solto e o blister "2 Peças";
//   4. "aceito a troca" com a oferta de juntar; "cabe?"; lenço duplicado; "tira o arroz" abrindo o total; "o que tem na
//      cesta?" na escolha de entrega; upsell com o orçamento estourado;
//   5. primeiro contato com duas mensagens juntas (o upsert do usuário batia no índice único);
//   6. caixa de sigla ("pilha aaa") e gênero corrigido como erro de digitação ("bolacha Recheado").
// Textos reais de /mnt/project-files/testes-whatsapp/rodada10/grupo-a.md.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { declaredPack, handleDeliveryMessage, isUndoRemovalText, packAdjusted, recommendationLeftovers, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { acceptsSwapOffer, isNonItemSegment, parseOrderBudget, parseSplitOrders, splitOrdersRest } from "../src/lib/lia-intents";
import { reconcileLineCounts, resolveListItems } from "../src/lib/list-items";
import { displayQueryName } from "../src/lib/query-display";
import { getOrCreateConvo } from "../src/lib/turn-runtime";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5530${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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

// ViaCEP e a simulação de checkout das lojas VTEX (frete ao vivo e conferência de estoque) sem rede.
const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  if (/orderForms\/simulation/.test(url)) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { items?: Array<{ id: string; quantity: number }> };
    const items = body.items ?? [];
    return new Response(
      JSON.stringify({
        items: items.map((item, i) => ({ id: item.id, quantity: item.quantity, requestIndex: i, availability: "available", sellingPrice: 1999 })),
        logisticsInfo: items.map((_, i) => ({
          itemIndex: i,
          slas: [
            { id: "Normal", name: "Normal", price: 490, shippingEstimate: "1bd" },
            { id: "Super Expressa", name: "SUPER EXPRESSA", price: 690, shippingEstimate: "60m" }
          ]
        }))
      }),
      { status: 200 }
    );
  }
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g30_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
// Do "oi" até o endereço salvo, como um cliente novo.
async function signedUp(): Promise<string> {
  const phone = newPhone();
  assert.match(await send(phone, "oi"), /endereço completo/i);
  assert.match(await send(phone, ADDRESS_MSG), /Endereço salvo/);
  return phone;
}
// Escolhe a 1ª opção de cada escolha aberta até a cesta fechar a seleção.
async function pickAll(phone: string): Promise<string> {
  let transcript = "";
  for (let i = 0; i < 6 && (await ctxOf(phone)).pending?.length; i++) transcript += `\n---\n${await send(phone, "1")}`;
  return transcript;
}

// 1 ------------------------------------------------------------------------------------------------------------------
test("1: com a escolha de entrega (barata × rápida) no caminho, o resumo ainda diz o que ficou de fora; 'o que tem na cesta?' e 'tira o gelo' respondem certo", async (t) => {
  if (!dbOk) return t.skip();
  // Loja com checkout consultável e SUPER EXPRESSA: a cotação para na escolha de entrega antes do resumo.
  delete process.env.LIA_LIVE_FREIGHT_OFF;
  process.env.LIA_OPERATOR_QUOTE = "false";
  const phone = await signedUp();
  const listed = await send(phone, "quero 3 feijão preto oba bem querer e kryptonita azul");
  assert.match(listed, /kryptonita azul/i, listed.slice(0, 600));
  await pickAll(phone);
  const closing = await send(phone, "só isso");
  assert.match(closing, /duas formas de entrega|Mais rápida/i, closing.slice(0, 800));
  assert.equal((await ctxOf(phone)).step, "choosing_freight");
  assert.ok(((await ctxOf(phone)).listMisses ?? []).some((m) => /kryptonita/.test(m.query)), "a faltante sobrevive à escolha de entrega");
  const contents = await send(phone, "o que tem na cesta?");
  assert.match(contents, /No seu pedido[\s\S]*Feijão Preto Oba/i, contents.slice(0, 600));
  assert.doesNotMatch(contents, /quer saber o total/i);
  const quote = await send(phone, "1");
  assert.match(quote, /Seu pedido/, quote.slice(0, 600));
  assert.match(quote, /Ficou de fora \(não achei\): \*kryptonita azul\*/i, quote.slice(0, 900));
  const drop = await send(phone, "tira a kryptonita");
  assert.match(drop, /já tinha ficado de fora/, drop.slice(0, 300));
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: 'ops, volta tudo', 'desfaz isso, quero a lista de volta' e 'volta tudo como estava' desfazem o 'esquece tudo'", async (t) => {
  if (!dbOk) return t.skip();
  for (const undo of ["ops, volta tudo, continua com a lista", "desfaz isso, quero a lista de volta", "volta tudo como estava"]) {
    const phone = await signedUp();
    await send(phone, "quero arroz e feijão");
    assert.ok((await ctxOf(phone)).pending?.length, "lista aberta");
    await send(phone, "esquece tudo");
    assert.ok(!(await ctxOf(phone)).pending?.length, "limpou");
    const out = await send(phone, undo);
    assert.match(out, /não limpei nada: voltei/, `${undo}: ${out.slice(0, 300)}`);
    assert.doesNotMatch(out, /não achei/i);
    const ctx = await ctxOf(phone);
    assert.deepEqual((ctx.pending ?? []).map((p) => p.query).sort(), ["arroz", "feijão"], undo);
  }
  // Pedido normal não vira desfazer.
  for (const text of ["põe o papel de volta", "volta o sabonete", "quero tudo de limpeza"]) assert.equal(isUndoRemovalText(text), false, text);
});

test("3b: 'orçamento R$ 15 no total' vira o teto do pedido e o resumo avisa; sem upsell com o teto estourado", async (t) => {
  if (!dbOk) return t.skip();
  assert.equal(parseOrderBudget("orçamento R$ 150 no total, tem que chegar até sexta")?.cap, 150);
  assert.equal(parseOrderBudget("orçamento R$ 60 no total. quero carvão 3kg, sal grosso e guaraná 2l")?.rest, "quero carvão 3kg, sal grosso e guaraná 2l");
  assert.equal(parseOrderBudget("tlgd q eu so tenho 50 conto kkk. quero 2 pizza congelada")?.cap, 50);
  assert.equal(parseOrderBudget("quero um caderno pequeno"), null);
  process.env.LIA_RECOMMEND_COMPLEMENT = "true";
  try {
    const phone = await signedUp();
    await send(phone, "orçamento R$ 15 no total. quero arroz e feijão");
    assert.equal((await ctxOf(phone)).orderBudget?.cap, 15);
    await pickAll(phone);
    let quote = await send(phone, "só isso");
    // Oferta de juntar numa loja só vem antes do resumo: aceita e segue.
    if (/Dá pra juntar tudo/.test(quote)) quote += `\n---\n${await send(phone, "1")}`;
    assert.doesNotMatch(quote, /costuma levar|Quer adicionar/i, "sem complemento com o orçamento estourado");
    assert.match(quote, /Passou do seu limite de \*R\$ 15,00\*/, quote.slice(0, 900));
  } finally {
    process.env.LIA_RECOMMEND_COMPLEMENT = "false";
  }
});

test("3c: 'cada um vai pagar o seu, somos 4 na casa. e também quero café' responde os dois pedidos E anota o café", async (t) => {
  if (!dbOk) return t.skip();
  const said = "cada um vai pagar o seu, somos 4 na casa. e também quero café";
  assert.equal(parseSplitOrders(said), "payer");
  assert.equal(splitOrdersRest(said), "e também quero café");
  const phone = await signedUp();
  await send(phone, "quero arroz e feijão");
  const out = await send(phone, said);
  assert.match(out, /dois pedidos/i, out.slice(0, 500));
  assert.match(out, /café/i, out.slice(0, 800));
  const ctx = await ctxOf(phone);
  const queries = [...(ctx.pending ?? []).map((p) => p.query), ...(ctx.basket ?? []).map((b) => b.name)].join(" | ");
  assert.match(queries, /caf[eé]/i, queries);
});

test("3d: 'CEP 01310-100, número 1578' no meio da escolha troca o número do endereço confirmado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero arroz e feijão");
  const out = await send(phone, "CEP 01310-100, número 1578");
  assert.match(out, /Endereço atualizado: Avenida Paulista, 1578/, out.slice(0, 300));
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.match(user.defaultAddress ?? "", /1578/);
  assert.match((await ctxOf(phone)).deliveryAddress ?? "", /1578/);
  assert.ok((await ctxOf(phone)).pending?.length, "a escolha continua aberta");
});

test("3e: 'um par' solto é a quantidade do item anterior; blister '2 Peças' fecha o par", async (t) => {
  const line = (text: string) => resolveListItems(text).map((l) => [l.phrase, l.qty]);
  assert.deepEqual(line("preciso de pilhas AAA, um par"), [["pilhas AAA", 2]]);
  assert.deepEqual(line("ovos, meia dúzia"), [["ovos", 6]]);
  assert.deepEqual(line("arroz, feijão"), [["arroz", 1], ["feijão", 1]]);
  assert.deepEqual(reconcileLineCounts([{ phrase: "pilha AAA", qty: 1 }, { phrase: "par", qty: 1 }], "preciso de pilhas AAA, um par").map((l) => [l.phrase, l.qty]), [["pilha AAA", 2]]);
  assert.equal(declaredPack("Pilha Alcalina - AA - Blister Com 2 Peças - Elgin"), 2);
  assert.equal(packAdjusted("Pilha Alcalina - AA - Blister Com 2 Peças - Elgin", 2, "pilhas AA").qty, 1);
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  const out = await send(phone, "preciso de pilhas AAA, um par");
  assert.doesNotMatch(out, /\*par\*/, out.slice(0, 400));
  const ctx = await ctxOf(phone);
  assert.ok(!(ctx.listMisses ?? []).some((m) => m.query === "par"), "'par' não é faltante");
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2: cartão de aniversário, embalagem e papel de presente pedidos junto da ideia de presente não somem", () => {
  const rec = { need: "presente de aniversário para menino de 7 anos", product: "presente" };
  assert.deepEqual(
    recommendationLeftovers("preciso de presente de aniversário pra um menino de 7 anos, gasto no máximo R$ 80. Também um cartão de aniversário e embalagem de presente", rec),
    ["cartão de aniversário", "embalagem de presente"]
  );
  assert.deepEqual(
    recommendationLeftovers("preciso de presente de aniversário pra um menino de 7 anos, gasto no máximo R$ 80. Também um cartão de aniversário, mais um papel de presente e uma vela de aniversário", rec),
    ["cartão de aniversário", "papel de presente", "vela de aniversário"]
  );
});

// 4 ------------------------------------------------------------------------------------------------------------------
test("4a: 'tira o arroz' com a cesta montada (sem resumo) confirma e não abre o total", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero arroz e feijão");
  await pickAll(phone);
  assert.equal((await ctxOf(phone)).basket?.length, 2);
  const out = await send(phone, "tira o arroz");
  assert.match(out, /Tirei/i, out.slice(0, 300));
  assert.doesNotMatch(out, /Seu pedido|Total:/, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.length, 1);
  assert.equal(ctx.deliveryOrderId, undefined);
});

test("4b: 'cabe?' no fim da lista não vira item; 'aceito a troca, pode ser' é aceite; lenço não duplica", () => {
  assert.equal(isNonItemSegment("cabe?"), true);
  assert.equal(isNonItemSegment("chega?"), true);
  assert.equal(acceptsSwapOffer("aceito a troca, pode ser"), true);
  const ai = [
    { phrase: "fralda recém-nascido", qty: 1 },
    { phrase: "lenço umedecido recém-nascido", qty: 1 },
    { phrase: "lenço umedecido pra recém-nascido", qty: 1 },
    { phrase: "pomada para assadura", qty: 1 }
  ];
  const lines = reconcileLineCounts(ai, "fralda recém-nascido, lenço umedecido pra recém-nascido e pomada pra assadura");
  assert.equal(lines.filter((l) => /len[cç]o/.test(l.phrase)).length, 1, JSON.stringify(lines));
});

// 5 ------------------------------------------------------------------------------------------------------------------
test("5: duas mensagens do 1º contato ao mesmo tempo não derrubam o turno (corrida no cadastro do usuário)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const results = await Promise.allSettled([getOrCreateConvo(phone), getOrCreateConvo(phone), getOrCreateConvo(phone)]);
  assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.status)));
  const ids = new Set(results.map((r) => (r.status === "fulfilled" ? r.value.user.id : "")));
  assert.equal(ids.size, 1);
});

// 6 ------------------------------------------------------------------------------------------------------------------
test("6: sigla volta em maiúscula e gênero não é tratado como erro de digitação", () => {
  assert.equal(displayQueryName("pilha aaa", [{ name: "Pilha Alcalina AAA Duracell 2 Unidades" }]), "pilha AAA");
  assert.equal(displayQueryName("bolacha recheada", [{ name: "Biscoito Recheado Chocolate Bauducco 140g" }]), "bolacha recheada");
  assert.equal(displayQueryName("sabão em pó omu", [{ name: "Sabão em Pó Omo Lavagem Perfeita 800g" }]), "sabão em pó Omo");
});
