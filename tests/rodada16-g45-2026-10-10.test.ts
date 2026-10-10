// Rodada 16, grupo G45 (10/10): achados R16a-1..R16a-4 de /mnt/project-files/testes-whatsapp/rodada16/grupo-a.md (e a
// jornada 352 do grupo B). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. (R16a-1, regressão do PR #26) "leite, leite condensado e achocolatado" perdia o leite (arroz/arroz integral,
//      sabonete/sabonete líquido): no merge com a IA (reconcileBySpan) e no "Já anotei" do pré-cadastro (addPendingRequest);
//   2. (R16a-2) "rímel à prova d'água" sem a IA traduzir dava "não achei"; "acabou minha base" virava item fantasma;
//   3. (R16a-3) "1,5kg de linguiça calabresa" com pacote de 400 g entrava 1x sem aviso; "ração de coelho filhote 1,5kg" não
//      achada e pedida de novo sem o peso entrava 1x 500 g (352);
//   4. (R16a-4) "mantém como está"/"não"/"pula" com o resumo na tela recebiam pergunta aberta da IA; na oferta de troca em
//      carrossel "mantém como está" não mantinha.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, packsToReachCount, withPacksToReach } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, reconcilePreItems, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { resolveListItems } from "../src/lib/list-items";
import { inheritMissMeasure, keepsSummaryAsIs, mergeShoppingLines } from "../src/lib/lia-intents";
import { queryAliases } from "../src/lib/stores/types";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5545${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/viacep\.com\.br\/ws\/01310100/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
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
  __setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g45_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => `[${m.kind}] ${m.text}`).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "choosing") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, pendingSince: Date.now(), ...ctxExtra }) }
  });
  return { phone, user, convo };
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery = "1 dia útil"): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, delivery, etaMinutes: 1440 }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, ask?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, delivery: "1 dia útil", ...(ask ? { ask } : {}) }) as BasketItem;
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });

// 1. R16a-1 --------------------------------------------------------------------------------------------------------
const PREFIX_LISTS: Array<[string, string[]]> = [
  ["leite, leite condensado e achocolatado", ["leite", "leite condensado", "achocolatado"]],
  ["arroz, arroz integral e feijão", ["arroz", "arroz integral", "feijão"]],
  ["sabonete, sabonete líquido e shampoo", ["sabonete", "sabonete líquido", "shampoo"]]
];

test("R16a-1: item que é começo do nome de outro não some no merge com a IA", () => {
  for (const [text, ai] of PREFIX_LISTS) {
    const merged = mergeShoppingLines(ai.map((phrase) => ({ phrase, qty: 1 })), resolveListItems(text));
    assert.deepEqual(merged.map((l) => l.phrase), ai, `${text} → ${JSON.stringify(merged.map((l) => l.phrase))}`);
  }
  // O erro de digitação (R15-1) continua sendo uma linha só.
  const lamp = mergeShoppingLines([{ phrase: "lâmpada led 9w", qty: 4 }, { phrase: "pilha aa", qty: 1 }], resolveListItems("lampda led 9w 4 unidades, pilha aa"));
  assert.equal(lamp.filter((l) => /l[aâ]mp/i.test(l.phrase)).length, 1, JSON.stringify(lamp));
  // A raça junto da ração (rodada 15 g42) continua sem ração em dobro.
  const racao = mergeShoppingLines(
    [{ phrase: "ração cachorro sênior shih tzu 1kg", qty: 1 }, { phrase: "tapete higiênico", qty: 1 }],
    resolveListItems("meu cachorro tem 13 anos, um shih tzu, preciso de ração sênior de 1kg e tapete higiênico")
  );
  assert.equal(racao.filter((l) => /ra[cç][aã]o/i.test(l.phrase)).length, 1, JSON.stringify(racao));
});

test("R16a-1: antes do cadastro, o 'Já anotei' traz os 3 itens (leite, leite condensado, achocolatado)", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  for (const [text, ai] of PREFIX_LISTS) {
    __setPreSignupModelForTests(async () => D({ items: ai.map((q) => it(q)) }));
    const pre = reconcilePreItems(ai.map((q) => it(q)), text);
    assert.deepEqual(pre.map((i) => i.query), ai);
    const phone = newPhone();
    const out = await send(phone, text);
    for (const item of ai) assert.match(out, new RegExp(`1x ${item}(?:\\n|$)`, "i"), `${item} sumiu: ${out.slice(0, 600)}`);
    assert.equal((await ctxOf(phone)).pendingRequest?.split(", ").length, 3, (await ctxOf(phone)).pendingRequest);
  }
});

// 2. R16a-2 --------------------------------------------------------------------------------------------------------
test("R16a-2: 'rímel' também busca 'máscara de cílios' (com e sem apóstrofo no d'água)", () => {
  assert.ok(queryAliases("rímel à prova d'água").includes("mascara de cilios a prova d agua"), JSON.stringify(queryAliases("rímel à prova d'água")));
  assert.ok(queryAliases("rimel a prova dagua").includes("mascara de cilios a prova d agua"), JSON.stringify(queryAliases("rimel a prova dagua")));
  assert.ok(queryAliases("rímel").includes("mascara de cilios"));
  assert.deepEqual(queryAliases("máscara de cílios"), []);
});

test("R16a-2: 'acabou minha base' é pedido de base, não item fantasma", () => {
  assert.deepEqual(resolveListItems("acabou minha base, batom vermelho e demaquilante").map((l) => l.phrase), ["base", "batom vermelho", "demaquilante"]);
  assert.deepEqual(resolveListItems("acabou o café, açúcar").map((l) => l.phrase), ["café", "açúcar"]);
  assert.deepEqual(resolveListItems("hoje acabou tudo aqui, arroz").map((l) => l.phrase), ["arroz"]);
  const text = "acabou minha base, base clara, batom vermelho, rímel à prova d'água, demaquilante, até 200 reais";
  const merged = mergeShoppingLines(["base clara", "batom vermelho", "rímel à prova d'água", "demaquilante"].map((phrase) => ({ phrase, qty: 1 })), resolveListItems(text));
  assert.ok(!merged.some((l) => /acabou/i.test(l.phrase)), JSON.stringify(merged.map((l) => l.phrase)));
  assert.equal(merged.length, 4, JSON.stringify(merged.map((l) => l.phrase)));
});

// 3. R16a-3 --------------------------------------------------------------------------------------------------------
test("R16a-3: 1,5 kg com pacote de 400 g dá 4 pacotes (1,6 kg); conta que passa muito segue sem conversão", () => {
  assert.deepEqual(packsToReachCount("linguiça calabresa 1,5kg", "Linguiça Calabresa Curada Perdigão – 400g"), { packs: 4, askedLabel: "1,5 kg", eachLabel: "400 g", totalLabel: "1,6 kg" });
  assert.equal(withPacksToReach("linguiça calabresa 1,5kg", "é de 400 g", "Linguiça Calabresa Curada Perdigão – 400g"), "é de 400 g — 4 pacotes dão 1,6 kg");
  assert.equal(withPacksToReach("linguiça toscana 2kg", "é de 500 g", "Linguiça Toscana 500g"), "é de 500 g — 4 pacotes dão 2 kg");
  assert.equal(packsToReachCount("ração coelho 1,5kg", "Ração para Coelhos Ornamentais Filhotes Megazoo 500 g")?.packs, 3);
  assert.equal(withPacksToReach("café em pó 2kg", "é de 750 g", "Café 750g"), "é de 750 g", "3 x 750 g = 2,25 kg passa de 10%");
});

test("R16a-3 (352): o peso do item não achado vale quando o cliente pede o mesmo produto de novo", () => {
  const misses = ["ração coelho filhote 1,5kg", "bebedouro de bico"];
  const text = inheritMissMeasure("e ração pra coelho então? tem alguma que sirva pra filhote?", misses);
  assert.equal(text, "e ração 1,5kg pra coelho então? tem alguma que sirva pra filhote?");
  assert.equal(inheritMissMeasure("e o bebedouro de bico?", misses), null, "faltante sem medida não muda nada");
  assert.equal(inheritMissMeasure("ração 3kg pra coelho", misses), null, "medida dita vale a dita");
  assert.equal(inheritMissMeasure("feno pra coelho", misses), null, "outro produto não herda");
});

test("R16a-3: a escolha do pacote de 400 g para '1,5kg' põe 4 pacotes, com o aviso", async (t) => {
  if (!dbOk) return t.skip();
  const calabresa: PendingChoice = {
    query: "linguiça calabresa 1,5kg",
    qty: 1,
    closestFalta: "é de 400 g — 4 pacotes dão 1,6 kg",
    options: [opt("santaluzia-1", "Linguiça Calabresa Curada Perdigão – 400g", 22.66, "santaluzia", "Casa Santa Luzia")]
  };
  const carvao = line("farmaciaindiana-27641", "Carvão Fogozão Especial Pacote 3kg", 29.69, "farmaciaindiana", "Farmácia Indiana", "carvão");
  const { phone } = await customerWith({ basket: [carvao], pending: [calabresa] });
  const out = await send(phone, "o primeiro");
  assert.match(out, /✅ 4x Lingui/, out.slice(0, 500));
  assert.match(out, /4 pacotes de 400 g \(1,6 kg\) pra dar os 1,5 kg/, out.slice(0, 500));
  assert.equal((await ctxOf(phone)).basket?.find((b) => b.sku === "santaluzia-1")?.qty, 4);
});

// 4. R16a-4 --------------------------------------------------------------------------------------------------------
test("R16a-4: 'fica assim' com o resumo na tela", () => {
  for (const s of ["mantém como está", "mantem assim", "tá bom assim", "ta bom", "pode deixar assim", "deixa como está", "não", "Não, obrigado", "pula", "assim mesmo", "não precisa"]) {
    assert.equal(keepsSummaryAsIs(s), true, s);
  }
  for (const s of ["não, quero trocar o leite", "tira o leite", "pix", "não quero mais", "mantém o leite e tira o ovo", "pula o leite"]) {
    assert.equal(keepsSummaryAsIs(s), false, s);
  }
});

test("R16a-4: 'mantém como está', 'não' e 'pula' no resumo voltam a escolha de pagamento", async (t) => {
  if (!dbOk) return t.skip();
  const leite = line("mambo-8040", "Leite Integral Longa Vida Parmalat 1 Litro", 5.49, "mambo", "Mambo", "leite");
  const { phone, user, convo } = await customerWith({ basket: [leite] }, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, conversationId: convo.id, phone, status: "awaiting_quote_confirmation", storeKey: "mambo", storeLabel: "Mambo",
      items: [leite] as unknown as object[], itemsSubtotal: 6.04, deliveryFee: 15.9, serviceFee: 0, total: 21.94, cep: "01310-100",
      deliveryAddress: ADDRESS, courierKey: "retailer_delivery", quoteExpiresAt: new Date(Date.now() + 30 * 60_000)
    }
  });
  const ctx = await ctxOf(phone);
  await prisma.conversation.update({ where: { id: convo.id }, data: { context: JSON.stringify({ ...ctx, deliveryOrderId: order.id }) } });
  for (const said of ["mantém como está", "não", "pula", "tá bom assim"]) {
    const out = await send(phone, said);
    assert.match(out, /pedido fica assim ✅ Total: \*R\$ 21,94\*/, `${said}: ${out.slice(0, 400)}`);
    assert.match(out, /\[sendPaymentChoices\]|Como prefere pagar/, `${said}: ${out.slice(0, 400)}`);
    assert.doesNotMatch(out, /O que você (?:quer|gostaria)/, `${said}: ${out.slice(0, 400)}`);
  }
  assert.match(await send(phone, "pula"), /No resumo não tem nada pra pular/);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "awaiting_quote_confirmation", "nada é cobrado nem cancelado");
});

test("R16a-4: na oferta de juntar em carrossel, 'mantém como está' recusa a troca e mantém o item", async (t) => {
  if (!dbOk) return t.skip();
  const ovos = line("santaluzia-158422", "Ovos Vermelho Caipira Mantiqueira Grandes - 10 un", 18.37, "santaluzia", "Casa Santa Luzia", "ovos");
  const leite = line("mambo-8040", "Leite Integral Longa Vida Parmalat 1 Litro", 5.49, "mambo", "Mambo", "leite");
  const swap: PendingChoice = { query: "ovos", qty: 1, qtyExplicit: true, replaceSku: ovos.sku, options: [opt("mambo-10248", "Ovos Caipira Ito country com 10 Unidades", 15.38, "mambo", "Mambo")] };
  const { phone } = await customerWith({ basket: [ovos, leite], pending: [swap], closeAfterChoices: true, costlySwapOffered: true });
  const out = await send(phone, "mantém como está");
  assert.match(out, /mantive \*Ovos Vermelho Caipira Mantiqueira Grandes - 10 un\* na cesta/, out.slice(0, 500));
  const after = await ctxOf(phone);
  assert.ok(!(after.pending ?? []).length, JSON.stringify(after.pending));
  const basket = after.basket ?? ((await prisma.deliveryOrder.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } }))?.items as unknown as BasketItem[]) ?? [];
  assert.deepEqual(basket.map((b) => b.sku).sort(), [leite.sku, ovos.sku].sort(), JSON.stringify(basket.map((b) => b.sku)));
});
