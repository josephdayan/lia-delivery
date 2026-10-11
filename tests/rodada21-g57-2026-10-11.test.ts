// Rodada 21, grupo G57 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada21/grupo-b.md (R21-1, R21-3, R21-4, R21-5,
// R21-9, R21-10, B1, B6, B7) e grupo-a.md (R21a-1 a R21a-5).
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import {
  answerOpenQuestion,
  detectIntent,
  isReplySpeedGripe,
  openQuestionYes,
  optionHasAttr,
  parseBasketLines,
  parseEarlierOptionRef,
  parseKeepItem,
  parseOptionAttributeAsk,
  parseStoreSwapAsk,
  readProductEmojis,
  splitKeepAndDone,
  splitQuestionsOnly,
  isGiftFrame
} from "../src/lib/lia-intents";
import { detectRecommendation } from "../src/lib/recommend/detect";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5521${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g57_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});

const BABY_100 = opt("americanas-3982734", "Algodão Higiene Bebê Basic+ Care Baby 100 Unidades", 30.79);
const BELLA_50 = opt("drogariacatarinense-7478", "Algodão Bella Cotton Maxi Bebê Com 50 Unidades", 25.62, "drogariacatarinense", "Drogaria Catarinense");
const BELLA_LINE = bi(BELLA_50.sku, BELLA_50.name, 25.62, { storeKey: "drogariacatarinense", storeLabel: "Drogaria Catarinense", ask: "algodão bebê" });

// ---------------------------------------------------------------- R21-1: correção que aponta pra opção de antes

test("R21-1: 'não, esse é de maquiagem. o de bebê, daquela primeira lista, da americanas' é referência, não 4 itens", () => {
  const ref = parseEarlierOptionRef("não, esse é de maquiagem. o de bebê, daquela primeira lista, da americanas");
  assert.ok(ref);
  assert.deepEqual(ref!.words, ["bebe", "americanas"]);
  assert.equal(ref!.rejectsCurrent, true);
  // Pedido comum não é referência.
  assert.equal(parseEarlierOptionRef("quero algodão e cotonete"), null);
  assert.equal(parseEarlierOptionRef("não, esse é ruim"), null);
});

test("R21-1: na conversa, a correção escolhe o algodão de bebê da Americanas já mostrado e nada vira item", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      basket: [],
      pending: [
        {
          query: "algodão 100 unidades",
          qty: 1,
          options: [opt("americanas-990001", "Disco Demaquilante Choices Beauty 100 Unidades", 12.9), opt("cremer-1", "Algodão Cremer Discos Maquiagem 100 un", 9.9, "drogariacatarinense", "Drogaria Catarinense")],
          swappedOut: [BELLA_LINE]
        }
      ],
      recentShown: [{ sku: BELLA_50.sku, options: [BABY_100, BELLA_50] }]
    },
    "choosing"
  );
  const out = await send(c.phone, "não, esse é de maquiagem. o de bebê, daquela primeira lista, da americanas");
  assert.doesNotMatch(out, /Anotei \*esse|daquela primeira lista\*/i, out);
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b) => b.sku === BABY_100.sku), `${JSON.stringify(ctx.basket)}\n${out}`);
  assert.ok(!(ctx.pending ?? []).some((p) => /maquiagem|lista|americanas/.test(p.query)), JSON.stringify(ctx.pending));
});

// ---------------------------------------------------------------- R21-3: "procura em outra loja", "então" e remoção composta

test("R21-3: 'isso, procura em outra loja' é pedido de troca de loja; 'então' não gruda no item removido", () => {
  assert.deepEqual(parseStoreSwapAsk("isso, procura em outra loja"), {});
  assert.deepEqual(parseStoreSwapAsk("busca a caneca em outra loja"), { item: "caneca" });
  assert.deepEqual(parseStoreSwapAsk("pode trocar a caneca e o chocolate por outra loja"), { item: "caneca e o chocolate" });
  assert.deepEqual(parseStoreSwapAsk("busca a caneca e o chocolate em outras lojas"), { item: "caneca e o chocolate" });
  assert.equal(parseStoreSwapAsk("não quero trocar de loja"), null);
  const intent = detectIntent("tira a caneca e o chocolate então, e coloca um chocolate lindt da farmácia");
  assert.equal(intent.kind, "remove_item");
  assert.equal(intent.kind === "remove_item" && intent.target, "caneca e chocolate");
  // "Você quer buscar a caneca e o chocolate em outras lojas?" + "isso, procura em outra loja" = a própria pergunta.
  assert.equal(openQuestionYes("Você quer buscar a caneca e o chocolate em outras lojas?"), "busca a caneca e o chocolate em outras lojas");
});

test("R21-3: 'tenta de novo'/'procura em outra loja' sem item a refazer nunca vira item", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("americanas-7907243", "Caneca Cerâmica 220ml Casual Home Diamante Café e Chá", 10.99, { ask: "caneca" }),
      bi("drogariaspacheco-760935", "Creme Hidratante para Mãos Monange 75g", 15.28, { storeKey: "drogariaspacheco", storeLabel: "Drogarias Pacheco", ask: "creme para mãos" })
    ]
  });
  const out = await send(c.phone, "tenta de novo");
  assert.doesNotMatch(out, /\*tenta de novo\*/i, out);
  const ctx = await ctxOf(c.convoId);
  assert.ok(!(ctx.pending ?? []).some((p) => /tenta|novo/.test(p.query)), JSON.stringify(ctx.pending));
  assert.ok(!(ctx.listMisses ?? []).some((m) => /tenta/.test(m.query)), JSON.stringify(ctx.listMisses));
});

test("R21-3: 'tira a caneca e o chocolate então, e coloca um chocolate lindt' tira os dois e procura o Lindt", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("americanas-7907243", "Caneca Cerâmica 220ml Casual Home Diamante Café e Chá", 10.99, { ask: "caneca" }),
      bi("americanas-166771", "Caixa Sonho de Valsa e Ouro Branco Sortidos Lacta Sabor Chocolate 220g", 23.64, { ask: "caixa de chocolate" }),
      bi("drogariaspacheco-760935", "Creme Hidratante para Mãos Monange 75g", 15.28, { storeKey: "drogariaspacheco", storeLabel: "Drogarias Pacheco", ask: "creme para mãos" })
    ]
  });
  const out = await send(c.phone, "tira a caneca e o chocolate então, e coloca um chocolate lindt da farmácia");
  assert.doesNotMatch(out, /chocolate entao|não está na sua cesta/i, out);
  const ctx = await ctxOf(c.convoId);
  const skus = (ctx.basket ?? []).map((b) => b.sku);
  assert.ok(!skus.includes("americanas-7907243") && !skus.includes("americanas-166771"), skus.join(","));
  assert.ok(skus.includes("drogariaspacheco-760935"));
  // O Lindt foi procurado: virou escolha, entrou na cesta ou ficou como "não achei" — nunca sumiu calado.
  const lindt = (ctx.basket ?? []).some((b) => /lindt/i.test(b.name)) || (ctx.pending ?? []).some((p) => /lindt/i.test(p.query)) || /lindt/i.test(out);
  assert.ok(lindt, `${JSON.stringify(ctx.pending)}\n${out}`);
});

// ---------------------------------------------------------------- R21-4 / B6: emoji

test("R21-4: emoji de produto vira a palavra; o ambíguo sozinho vira pergunta; 🙏/👍 seguem como antes", () => {
  assert.deepEqual(readProductEmojis("🍼"), { text: "mamadeira" });
  assert.deepEqual(readProductEmojis("👶 fralda 🧻"), { text: "fralda, papel higiênico" });
  assert.deepEqual(readProductEmojis("🍼🧻"), { text: "mamadeira, papel higiênico" });
  assert.deepEqual(readProductEmojis("🧴"), { ask: { emoji: "🧴", options: ["hidratante", "shampoo", "protetor solar"] } });
  // A palavra já dita não duplica; emoji sem produto não mexe.
  assert.deepEqual(readProductEmojis("papel higiênico 🧻"), { text: "papel higiênico" });
  assert.equal(readProductEmojis("🙏"), null);
  assert.equal(readProductEmojis("👍"), null);
  assert.equal(readProductEmojis("arroz e feijão"), null);
  assert.match(copy.emojiAsk("🧴", ["hidratante", "shampoo", "protetor solar"]), /\*hidratante\*, \*shampoo\* ou \*protetor solar\*/);
});

test("R21-4/B6: na conversa, '🍼' é anotado como mamadeira e '🙏' sem nada pra agradecer não é 'Imagina!'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({}, "need_address", { address: false });
  const out = await send(c.phone, "🍼");
  assert.match(out, /mamadeira/i, out);
  const thanks = await send(c.phone, "🙏");
  assert.doesNotMatch(thanks, /Imagina/i, thanks);
  const ask = await send(c.phone, "🧴");
  assert.match(ask, /hidratante/i, ask);
});

// ---------------------------------------------------------------- R21-5: atributo das opções e pedido mínimo

test("R21-5: 'qual dessas é preta e de 20 metros?' lê cor e medida", () => {
  assert.deepEqual(parseOptionAttributeAsk("qual dessas é preta e de 20 metros?"), ["preta", "20m"]);
  assert.ok(optionHasAttr("Fita Isolante PVC 18mm 20 Metros DNI Preta", "20m"));
  assert.ok(optionHasAttr("Fita Isolante PVC Fiteck 18mm X 20m Steck", "20m"));
  assert.ok(optionHasAttr("Fita Isolante PVC 18mm 20 Metros DNI Preta", "preta"));
  assert.ok(!optionHasAttr("Fita Isolante 3M 18mmx5m", "20m"));
  assert.ok(!optionHasAttr("Fita Isolante 3M 200m", "20m"));
  assert.equal(parseOptionAttributeAsk("qual o prazo?"), null);
});

test("R21-5: na conversa, a pergunta responde a opção da tela que é preta e de 20 metros", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        {
          query: "fita isolante",
          qty: 1,
          options: [opt("obramax-1", "Fita Isolante 3M 18mmx5m", 7.25, "obramax", "Obramax"), opt("obramax-2", "Fita Isolante PVC 18mm 20 Metros DNI Preta", 6.49, "obramax", "Obramax"), opt("obramax-3", "Fita Isolante Pvc Vermelha 5M Dni", 5.49, "obramax", "Obramax")]
        }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "qual dessas é preta e de 20 metros?");
  assert.match(out, /opção 2/, out);
  assert.match(out, /20 Metros DNI Preta/, out);
  assert.doesNotMatch(out, /Eu procuro o que você pedir/, out);
});

test("R21-5: 'tem pedido mínimo? e quanto tempo demora?' responde as duas", () => {
  assert.deepEqual(detectIntent("tem pedido mínimo?"), { kind: "service_question", topic: "minimum" });
  const asks = splitQuestionsOnly("tem pedido mínimo? e quanto tempo demora em média?");
  assert.deepEqual(asks?.map((a) => (a.kind === "service_question" ? a.topic : a.kind)), ["minimum", "eta"]);
  assert.match(copy.serviceAnswer("minimum", "São Paulo"), /depende da loja/);
});

// ---------------------------------------------------------------- R21-9: "pelo outro" usa a opção já mostrada

test("R21-9: 'troca o algodão pelo outro, o de 100 unidades' põe o de 100 un já mostrado, sem busca nova", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [BELLA_LINE],
    // A escolha concluída ainda aponta pro de 100 un (o "mais barato" trocou depois).
    lastChoice: { query: "algodão bebê", qty: 1, options: [BABY_100, BELLA_50], chosenSku: BABY_100.sku },
    lastSwap: { removed: [bi(BABY_100.sku, BABY_100.name, 30.79, { ask: "algodão bebê" })], to: "algodão bebê", addedSku: BELLA_50.sku, at: Date.now() }
  });
  const out = await send(c.phone, "troca o algodão pelo outro, o de 100 unidades");
  assert.doesNotMatch(out, /Não tenho uma lista aberta/, out);
  // A cesta vira pedido na cotação: confere pela mensagem (troca + pedido só com o de 100 un).
  assert.match(out, /Troquei Algodão Bella Cotton[^\n]* por Algodão Higiene Bebê Basic\+ Care Baby 100 Unidades/, out);
  assert.doesNotMatch(out.split("Seu pedido")[1] ?? "", /Bella Cotton/, out);
  assert.doesNotMatch(copy.orderReopened(), /segue o novo/);
});

// ---------------------------------------------------------------- R21-10: manter durante a troca + fechar

test("R21-10: 'deixa o creme que já tinha. só isso' mantém e fecha", () => {
  assert.deepEqual(splitKeepAndDone("deixa o creme que já tinha. só isso"), { keep: "deixa o creme que já tinha.", done: true });
  assert.equal(parseKeepItem("deixa o creme que já tinha."), "creme");
  assert.equal(parseKeepItem("mantém o creme de antes"), "creme");
});

test("R21-10: na conversa, a troca aberta sai, o creme fica e a lista fecha", async (t) => {
  if (!dbOk) return t.skip();
  const creme = bi("drogariaspacheco-760935", "Creme Hidratante para Mãos Monange Anti-Idade 75g", 15.28, { storeKey: "drogariaspacheco", storeLabel: "Drogarias Pacheco", ask: "creme para mãos" });
  const c = await customerWith(
    {
      basket: [creme],
      pending: [{ query: "creme para mãos", qty: 1, replaceSku: creme.sku, options: [opt("dsp-760935", "Creme Hidratante para Mãos Monange Anti-Idade 75g", 15.28, "drogariasp", "Drogaria São Paulo")] }]
    },
    "choosing"
  );
  const out = await send(c.phone, "deixa o creme que já tinha. só isso");
  assert.match(out, /mantive/i, out);
  assert.doesNotMatch(out, /Ficou entre essas/, out);
  const ctx = await ctxOf(c.convoId);
  assert.ok(!(ctx.pending ?? []).length, JSON.stringify(ctx.pending));
  assert.ok((ctx.basket ?? []).some((b) => b.sku === creme.sku) || Boolean(ctx.deliveryOrderId), JSON.stringify(ctx));
});

// ---------------------------------------------------------------- B1 / B7

test("B1: queixa da demora da resposta não é pergunta de prazo", async (t) => {
  assert.ok(isReplySpeedGripe("vocês demoram demais pra responder né, to com pressa"));
  assert.ok(!isReplySpeedGripe("quanto tempo demora a entrega?"));
  assert.ok(!isReplySpeedGripe("demora pra responder, quero arroz"));
  if (!dbOk) return t.skip();
  const c = await customerWith({}, "need_address", { address: false });
  const out = await send(c.phone, "vocês demoram demais pra responder né, to com pressa");
  assert.match(out, /Desculpa a demora/, out);
  assert.doesNotMatch(out, /prazo depende da loja/, out);
});

test("B7: 'osso de couro, não tem mesmo? pode ser osso de roer' não deixa 'sem' sobrando", () => {
  const lines = parseBasketLines("e osso de couro, não tem mesmo? pode ser osso de roer").map((l) => l.phrase);
  assert.ok(!lines.some((p) => /\bsem\b/.test(p)), lines.join(" | "));
  assert.ok(lines.includes("osso de roer"), lines.join(" | "));
});

// ---------------------------------------------------------------- R21a-1: edição não responde a pergunta aberta

test("R21a-1: 'ah espera, o sabonete eu quero o Dove Original mesmo, tira o shampoo' não responde 'Qual papel higiênico?'", () => {
  assert.equal(answerOpenQuestion("Qual papel higiênico você quer?", "ah espera, o sabonete eu quero o Dove Original mesmo, tira o shampoo"), null);
  // Resposta de verdade continua valendo, com ou sem interjeição.
  assert.equal(answerOpenQuestion("Qual leite você quer?", "ah, o integral mesmo, e o pão de forma"), "adiciona leite integral, pão de forma");
  assert.equal(answerOpenQuestion("Qual leite você quer?", "o integral mesmo, e o pão de forma"), "adiciona leite integral, pão de forma");
});

test("R21a-1: na conversa, tirar o shampoo não some com o papel higiênico da fila", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      basket: [bi("santaluzia-25386", "Sabonete em Barra Pele Sensível Dove 90g", 5.99, { storeKey: "santaluzia", storeLabel: "Casa Santa Luzia", ask: "sabonete Dove" })],
      pending: [
        { query: "shampoo", qty: 1, options: [opt("santaluzia-152773", "Shampoo L'Oréal Paris Elseve Longo dos Sonhos 200ml", 15.29, "santaluzia", "Casa Santa Luzia")] },
        { query: "papel higiênico", qty: 1, options: [opt("santaluzia-1", "Papel Higiênico Neve Folha Dupla 12 Rolos", 19.9, "santaluzia", "Casa Santa Luzia")] },
        { query: "creme dental", qty: 1, options: [opt("santaluzia-2", "Creme Dental Colgate 90g", 4.9, "santaluzia", "Casa Santa Luzia")] }
      ],
      openQuestion: { text: "Qual papel higiênico você quer?", at: Date.now() }
    },
    "choosing"
  );
  await send(c.phone, "ah espera, o sabonete eu quero o Dove Original mesmo, tira o shampoo");
  const ctx = await ctxOf(c.convoId);
  const queries = (ctx.pending ?? []).map((p) => p.query);
  assert.ok(!queries.includes("shampoo"), queries.join(" | "));
  assert.ok(queries.includes("papel higiênico"), queries.join(" | "));
});

// ---------------------------------------------------------------- R21a-3 / R21a-5

test("R21a-3: 'sim' à pergunta que oferece um item adiciona o item", () => {
  assert.equal(openQuestionYes("Você quer uma pastilha para garganta de mel e limão da Drogaria São Paulo?"), "adiciona uma pastilha para garganta de mel e limao da drogaria sao paulo");
  // As de antes continuam.
  assert.equal(openQuestionYes("Você quer que eu procure um lápis mais barato?"), "procura um lapis mais barato");
});

test("R21a-5: 'pode ser essa' com UM card só escolhe o card", async (t) => {
  if (!dbOk) return t.skip();
  // (Remédio fica desligado nos testes; o mesmo caminho vale pra "a dipirona pode ser essa".)
  const only = opt("americanas-fita-1", "Fita Adesiva Transparente 45mm x 45m Adelbras", 8.99);
  const c = await customerWith({ pending: [{ query: "fita adesiva", qty: 1, options: [only] }] }, "choosing");
  const out = await send(c.phone, "a fita pode ser essa");
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b) => b.sku === only.sku), `${JSON.stringify(ctx.basket)}\n${out}`);
});

// ---------------------------------------------------------------- g58/talk-prod: "montar um presente de amigo secreto"

test("g58: 'preciso montar um presente de amigo secreto, máximo 60 reais' é pedido de sugestão com teto, não item", () => {
  const req = detectRecommendation("preciso montar um presente de amigo secreto, máximo 60 reais");
  assert.ok(req, "era null: 'montar' sobrava e a frase virava item");
  assert.equal(req!.form, "need");
  assert.equal(req!.budget, 60);
  assert.equal(isGiftFrame("montar um presente de amigo secreto"), true);
  // Produto de verdade com "montar" não vira presente.
  assert.equal(isGiftFrame("montar um guarda-roupa"), false);
});
