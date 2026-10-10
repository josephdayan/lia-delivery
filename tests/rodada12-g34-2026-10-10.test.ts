// Rodada 12, grupo G34 (10/10): quantidade que migra de item e correção com "pera" (jornadas 301, 302 e 306 de
// /mnt/project-files/testes-whatsapp/rodada12/grupo-b.md), e o aceite natural da troca de loja (M5). Conversas pelo
// caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "uns 4 tomates" ao lado de "molho de tomate" dobrava no molho (5x molho, sem tomates); "3 canetas" com o pacote de 3
//      virava 3 pacotes (9 canetas); a quantidade da IA numa escolha sem número ia para o item da vez; a troca de opção
//      depois de "só 1" voltava à quantidade original;
//   2. "peraí, é só 1" / "pera, melhor só 1 pacote mesmo" eram lidos como pausa ("te espero");
//   3. "pode ser na outra" / "deixa, esquece a vela. pode trocar de loja" não aceitavam a troca de loja.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, packAdjusted, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { planActions } from "../src/lib/dialogue/plan";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { acceptsSwapOffer, detectIntent, mergeShoppingLines, parseBasketLines, splitTrailingSwapAccept } from "../src/lib/lia-intents";
import { completeName } from "../src/lib/stores/live-search";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";
import type { DialogueState } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5532${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g34_${RUN}_${++seq}` }));
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
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return phone;
}

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: 'uns 4 tomates' é item próprio com 4 — nunca dobra no 'molho de tomate' (5x molho)", () => {
  const said = "vou fazer um jantar rápido pra mim e minha namorada, quero macarrão espaguete, molho de tomate, queijo ralado e uns 4 tomates";
  const det = parseBasketLines(said);
  assert.deepEqual(det.find((l) => /tomates/.test(l.phrase) && !/molho/.test(l.phrase))?.qty, 4, JSON.stringify(det));
  const ai = [{ phrase: "macarrão espaguete", qty: 1 }, { phrase: "molho de tomate", qty: 1 }, { phrase: "queijo ralado", qty: 1 }, { phrase: "tomates", qty: 4 }];
  const merged = mergeShoppingLines(ai, det).map((l) => [l.phrase, l.qty]);
  assert.deepEqual(merged.find(([p]) => p === "molho de tomate"), ["molho de tomate", 1], JSON.stringify(merged));
  assert.deepEqual(merged.find(([p]) => p === "tomates"), ["tomates", 4], JSON.stringify(merged));
  // Ordem invertida: o gêmeo do molho é o molho, não "4 tomates".
  const inv = mergeShoppingLines([{ phrase: "tomates", qty: 4 }, { phrase: "molho de tomate", qty: 1 }], parseBasketLines("uns 4 tomates e molho de tomate"));
  assert.deepEqual(inv.map((l) => [l.phrase, l.qty]), [["tomates", 4], ["molho de tomate", 1]]);
  // O caso que a dobra existe para cobrir continua: "leite sem lactose; mais dois leites" = 3x na linha rica.
  const leite = mergeShoppingLines([{ phrase: "leite sem lactose", qty: 1 }, { phrase: "leite", qty: 2, qtyExplicit: true }], parseBasketLines("Leite sem lactose, qualquer marca; mais dois leites."));
  assert.equal(leite.length, 1);
  assert.equal(leite[0].qty, 3);
  // Dinheiro continua orçamento.
  assert.equal(parseBasketLines("quero um perfume, tenho uns 120 reais").some((l) => /^120/.test(l.phrase)), false);
});

test("1b: '3 canetas' com a opção 'Caneta ... 3 Unidades' = 1 pacote (nunca 3 pacotes = 9 canetas)", () => {
  const caneta = "Caneta Esferográfica Cristal Fashion 3 Unidades Bic Ponta 1.2mm Média Azul Tampa Ventilada";
  assert.equal(packAdjusted(caneta, 3, "canetas azuis").qty, 1);
  assert.equal(packAdjusted(caneta, 6, "canetas azuis").qty, 2);
  // Pacote dito é pacote.
  assert.equal(packAdjusted(caneta, 3, "pacotes de caneta azul").qty, 3);
  // Kit de produto avulso continua sem converter (rodada 9 g27).
  assert.equal(packAdjusted("Desodorante Rexona 2 unidades", 2, "desodorante").qty, 2);
  // Nome repetido da VTEX (produto + SKU que redescreve o produto) sai enxuto (B4).
  const prod = "Caneta Esferográfica Cristal Fashion 3 Unidades Bic Ponta 1.2mm";
  const sku = "Caneta Esferográfica BIC Cristal Fashion Ponta Média 1.2mm Azul Tampa Ventilada 3 Unidades";
  assert.equal(completeName(`${prod} ${sku}`, prod, sku), caneta);
  assert.equal(completeName("Leite Integral Italac 1L Caixa", "Leite Integral Italac", "1L Caixa"), "Leite Integral Italac 1L Caixa");
});

test("1c: quantidade da IA numa escolha sem número na fala não vale ('o de salmão da Dreamies' → 2x)", () => {
  const state = {
    passo: "escolhendo_opcao",
    emEscolha: { item: "petisco gato", qtdPedida: 1, qtdDita: false, opcoes: [{ n: 1, nome: "Petisco Nugget Salmão" }, { n: 2, nome: "Petisco Dreamies Salmão 40g" }] },
    ultimaEscolha: null, naoAcheiRecente: null, totalNaMesa: null, cobrancaAberta: false, opcoesDeFrete: null
  } as unknown as DialogueState;
  const pick = (text: string, qty?: number) => {
    const plan = planActions({ actions: [{ type: "pick", option: 2, ...(qty ? { qty } : {}) }] } as never, state, { text });
    assert.ok(plan.ok, JSON.stringify(plan));
    return (plan as { steps: Array<{ qty?: number }> }).steps[0].qty;
  };
  assert.equal(pick("o de salmão da Dreamies", 2), undefined);
  assert.equal(pick("quero o 2", 2), undefined);
  assert.equal(pick("2 do de salmão da Dreamies", 2), 2);
  assert.equal(pick("o Dreamies, só um", 1), 1);
});

test("1d: escolha depois de outro item com 2x: a quantidade não migra; 'peraí, é só 1 arroz' corrige o arroz", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero 2 arroz, feijão e açúcar");
  let ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[0]?.qty, 2, JSON.stringify(ctx.pending?.map((p) => [p.query, p.qty])));
  await send(phone, "1");
  ctx = await ctxOf(phone);
  const arroz = ctx.basket?.find((b) => /arroz/i.test(b.name));
  assert.equal(arroz?.qty, 2);
  await send(phone, "1");
  ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => /feij/i.test(b.name))?.qty, 1, "o 2 do arroz não passa pro feijão");
  // Com o açúcar na tela, a correção do arroz vale para o arroz (nunca "te espero", nunca busca de arroz de novo).
  const out = await send(phone, "peraí, é só 1 arroz, não 2");
  assert.doesNotMatch(out, /te espero|Olha o que achei/i, out.slice(0, 400));
  ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === arroz!.sku)?.qty, 1, out.slice(0, 400));
  assert.match(ctx.pending?.[0]?.query ?? "", /a[cç][uú]car/, "o açúcar continua na tela");
});

test("1e: 'só 1' depois da escolha e troca pela outra opção: a nova vem com 1, não com a quantidade original", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero 2 arroz");
  await send(phone, "1");
  let ctx = await ctxOf(phone);
  const first = ctx.basket?.[0];
  assert.equal(first?.qty, 2);
  await send(phone, "pera, melhor só 1 mesmo");
  ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.[0]?.qty, 1);
  assert.equal(ctx.lastChoice?.qty, 1, "a escolha lembra a quantidade corrigida");
  const out = await send(phone, "na verdade quero o 2");
  ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.length, 1, out.slice(0, 400));
  assert.notEqual(ctx.basket?.[0]?.sku, first?.sku, out.slice(0, 400));
  assert.equal(ctx.basket?.[0]?.qty, 1, out.slice(0, 400));
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: 'peraí/pera' + quantidade é correção, não pausa; pausa de verdade continua pausa", () => {
  assert.deepEqual(detectIntent("pera, melhor só 1 pacote mesmo"), { kind: "qty_adjust", set: 1 });
  assert.deepEqual(detectIntent("peraí, é só 1"), { kind: "qty_adjust", set: 1 });
  assert.notEqual(detectIntent("peraí, é só 1 molho, não 5").kind, "hold");
  for (const t of ["pera aí", "peraí, meu filho chegou", "pera, já volto", "pera um pouco", "pera, um minuto", "espera 5 minutos", "espera aí que tô com 2 crianças aqui"]) {
    assert.equal(detectIntent(t).kind, "hold", t);
  }
});

test("2b: 'pera, melhor só 1 pacote mesmo' na conversa ajusta o item escolhido", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero 2 arroz e feijão");
  await send(phone, "1");
  const out = await send(phone, "pera, melhor só 1 pacote mesmo");
  assert.doesNotMatch(out, /te espero/i, out.slice(0, 400));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => /arroz/i.test(b.name))?.qty, 1, out.slice(0, 400));
  assert.equal(ctx.pending?.[0]?.qty, 1, "o feijão continua 1");
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: aceite natural da troca de loja; edição + aceite na mesma mensagem separa a edição", () => {
  for (const t of ["pode trocar", "troca sim", "pode ser na outra", "pode ser na outra loja", "manda da outra loja", "prefiro a outra loja", "vai na outra loja"]) {
    assert.equal(acceptsSwapOffer(t), true, t);
  }
  for (const t of ["pode ser na outra cor", "quero a outra", "pode ser o outro", "quero o outro sabor"]) assert.equal(acceptsSwapOffer(t), false, t);
  assert.equal(splitTrailingSwapAccept("deixa, esquece a vela. pode trocar de loja"), "deixa, esquece a vela");
  assert.equal(splitTrailingSwapAccept("pode trocar de loja"), null);
  assert.equal(splitTrailingSwapAccept("esquece a vela"), null);
});

const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const sig = (basket: BasketItem[]) => basket.map((i) => `${i.sku}:${i.qty}`).sort().join("|");

test("3b: 'pode ser na outra' com a oferta de troca na mesa aplica a troca", async (t) => {
  if (!dbOk) return t.skip();
  const caneta = bi("americanas-3982722", "Caneta Esferográfica Cristal Fashion 3 Unidades Bic", 8.79, { ask: "caneta azul" });
  const alt = opt("rihappy-100161271", "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", 7.69, "rihappy", "Ri Happy");
  const basket = [caneta];
  const phone = await customerWith({ basket, minSwap: { fromStoreKey: "americanas", key: sig(basket), replacements: [{ fromSku: caneta.sku, qty: 1, option: alt }] } });
  const out = await send(phone, "pode ser na outra");
  const ctx = await ctxOf(phone);
  assert.ok(ctx.basket?.some((b) => b.sku === alt.sku), out.slice(0, 400));
  assert.ok(!ctx.basket?.some((b) => b.sku === caneta.sku), out.slice(0, 400));
  assert.equal(ctx.minSwap, undefined);
});

test("2c: moldura de correção (isQtyCorrectionCue) não pega pedido de quantidade comum", async () => {
  const { isQtyCorrectionCue } = await import("../src/lib/lia-intents");
  for (const t of ["pera, melhor só 1 pacote mesmo", "na verdade era só 1", "errei, é 2", "só 1 mesmo"]) assert.equal(isQtyCorrectionCue(t), true, t);
  for (const t of ["quero 3 mesmo", "quero 2", "melhor o 2", "3 unidades"]) assert.equal(isQtyCorrectionCue(t), false, t);
});
