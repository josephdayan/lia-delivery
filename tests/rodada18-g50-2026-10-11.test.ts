// Rodada 18, grupo G50 (11/10): remoção por loja, quantidade vizinha, prazo com hora, contexto e medida decimal, pergunta
// sobre o item escolhido, "mostra as opções", cadastro, endereço e avisos repetidos —
// de /mnt/project-files/testes-whatsapp/rodada18/grupo-b.md (R18-1, R18-2, R18-3, R18-4, R18-9, R18-12, R18-14).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, splitIdentity } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { parseBasketLines, parseMeasureMixup, parseNeededBy, parseStoreRemoval } from "../src/lib/lia-intents";
import * as copy from "../src/lib/lia-copy";
import { canonicalTypedAddress } from "../src/lib/address-parse";
import { nameColor, nameSize, parseChosenItemQuestion } from "../src/lib/product-question";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5528${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown) => {
    outbox.push({ to, kind: key, text: typeof text === "string" ? text : JSON.stringify(text) });
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
  delete process.env.LIA_DIALOGUE_LLM;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g50_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const phrases = (t: string) => parseBasketLines(t).map((l) => l.phrase);

// 23h30 em SP do sábado 10/10 (a hora da rodada).
const NIGHT = new Date("2026-10-11T02:30:00Z");

// ---------------------------------------------------------------- R18-1: remoção por loja

test("R18-1: 'tira tudo da americanas e fecha o resto' é remoção por loja com fechamento", () => {
  assert.deepEqual(parseStoreRemoval("tira tudo da americanas e fecha o resto"), { store: "americanas", close: true });
  assert.deepEqual(parseStoreRemoval("remove os itens da Cobasi"), { store: "cobasi", close: false });
  assert.deepEqual(parseStoreRemoval("esquece o que é da Drogaria São Paulo, pode fechar"), { store: "drogaria sao paulo", close: true });
  // Sem "tudo/os itens/o que é" é item ("tira o da americanas"); "tira tudo" sozinho segue sendo a lista nova.
  assert.equal(parseStoreRemoval("tira o da americanas"), null);
  assert.equal(parseStoreRemoval("tira tudo"), null);
});

test("R18-1: na conversa, só os itens da Americanas saem e o resto fecha", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [
      bi("americanas-1", "Lápis de Cor Resina Eco Sextavado 24 Cores Leo&Leo", 14.29),
      bi("americanas-2", "Tesoura Escolar 1 un School Basics", 5.49),
      bi("livrariascuritiba-1", "Cola Bastão 20g", 2.72, { storeKey: "livrariascuritiba", storeLabel: "Livrarias Curitiba" }),
      bi("livrariascuritiba-2", "Caderno Universitário 1x1 Zip Rosa Tilibra", 17.86, { storeKey: "livrariascuritiba", storeLabel: "Livrarias Curitiba" })
    ]
  });
  const out = await send(c.phone, "tira tudo da americanas e fecha o resto");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), ["livrariascuritiba-1", "livrariascuritiba-2"], out);
  assert.doesNotMatch(out, /lista nova|Vale-Presente|Opções de \*da americanas/i);
  assert.match(out, /Tirei .*Lápis de Cor/);
});

// ---------------------------------------------------------------- R18-2: quantidade não vaza

test("R18-2: 'uns 5 pacotes' é do macarrão; o papel higiênico fica 1x", () => {
  const lines = parseBasketLines("gente tipo assim preciso de macarrão instantâneo uns 5 pacotes é energetico 4 latas papel higienico e detergente e saco de lixo urgente to sem nada em casa kkk");
  assert.deepEqual(
    lines.map((l) => [l.phrase, l.qty]),
    [["macarrão instantâneo", 5], ["energetico lata", 4], ["papel higienico", 1], ["detergente", 1], ["saco de lixo", 1]]
  );
  // A contagem com "de <medida>" e a marca colada continuam no mesmo item.
  assert.deepEqual(parseBasketLines("macarrão 3 pacotes de 500g").map((l) => [l.phrase, l.qty]), [["macarrão 500g", 3]]);
  assert.deepEqual(parseBasketLines("cerveja 12 latas heineken").map((l) => [l.phrase, l.qty]), [["cerveja lata heineken", 12]]);
});

// ---------------------------------------------------------------- R18-4: prazo com hora, contexto e decimal

test("R18-4: 'preciso até sexta às 19h' é prazo com hora, nunca item", () => {
  const text = "quero dar um presente pra minha namorada, um perfume floral até 150 reais e um hidratante corporal. preciso até sexta às 19h";
  assert.deepEqual(parseNeededBy(text, NIGHT), { date: "2026-10-16", label: "sexta às 19h", hour: 19 });
  assert.ok(!phrases(text).some((p) => /sexta|19h/.test(p)), JSON.stringify(phrases(text)));
  assert.deepEqual(parseNeededBy("pão e leite, tem que chegar amanhã às 10h", NIGHT), { date: "2026-10-11", label: "amanhã às 10h", hour: 10 });
  // Sem prazo dito, horário solto com dia não é prazo.
  assert.equal(parseNeededBy("a loja abre sexta às 7h?", NIGHT), null);
});

test("R18-4: 'Vou pintar o quarto sábado de manhã' é contexto; '3,6 litros' fica 3,6", () => {
  const text = "Vou pintar o quarto sábado de manhã e preciso de tinta branca 3,6 litros, um rolo de pintura, fita crepe e lixa. Tenho até 200 reais";
  const got = phrases(text);
  assert.ok(!got.some((p) => /pintar o quarto/i.test(p)), JSON.stringify(got));
  assert.equal(got[0], "tinta branca 3,6 litros");
  // O cadastro na mesma mensagem (nome + CPF) sai sem quebrar a vírgula decimal.
  const taken = splitIdentity("Marta Oliveira, CPF 529.982.247-25, tinta branca 3,6 litros, um rolo de pintura", "52998224725");
  assert.equal(taken.name, "Marta Oliveira");
  assert.equal(taken.rest, "tinta branca 3,6 litros, um rolo de pintura");
});

// ---------------------------------------------------------------- R18-3: pergunta sobre o item escolhido

const VASO = bi("telhanorte-2503735", "Vaso De Plástico Cone Baixo Pote 28 Argila Vasap", 82.39, { storeKey: "telhanorte", storeLabel: "Telhanorte", ask: "vaso grande para jardim" });
const TERRA = bi("cobasi-1011200", "Terra Vegetal Adubada para Jardinagem Terral 2 kg", 20.89, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "terra adubada" });
const REGADOR = { query: "regador", qty: 1, options: [opt("cobasi-561592", "Regador Plástico com Bico Regaplan 2 L", 25.85, "cobasi", "Cobasi"), opt("telhanorte-1629247", "Regador 3,0L Verde Nutriplan", 29.59, "telhanorte", "Telhanorte")] };

test("R18-3: 'o vaso ficou de que cor? e o tamanho' é pergunta sobre o vaso da cesta", () => {
  assert.deepEqual(parseChosenItemQuestion("o vaso ficou de que cor? e o tamanho", [VASO.name, TERRA.name]), { index: 0, aspects: ["cor", "tamanho"] });
  assert.equal(nameColor(VASO.name), "Argila");
  assert.equal(nameSize(VASO.name), "Pote 28");
  // Pedido de outra cor é refinamento; item que não está na cesta não é esta pergunta.
  assert.equal(parseChosenItemQuestion("quero o vaso de outra cor", [VASO.name]), null);
  assert.equal(parseChosenItemQuestion("o regador é de que cor?", [VASO.name, TERRA.name]), null);
});

test("R18-3: na conversa, a pergunta não vira item e 'esquece isso, era pergunta' não tira a terra", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [VASO, TERRA], pending: [REGADOR] }, "choosing");
  const out = await send(c.phone, "o vaso ficou de que cor? e o tamanho");
  let ctx = await ctxOf(c.convoId);
  assert.match(out, /Argila/);
  assert.match(out, /Pote 28/);
  assert.doesNotMatch(out, /Somei|não achei|Opções de \*o vaso/i);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["regador"], out);
  const out2 = await send(c.phone, "esquece isso, não é item, era pergunta. o que tem na minha cesta?");
  ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), [VASO.sku, TERRA.sku], out2);
  assert.doesNotMatch(out2, /Tirei/);
  assert.match(out2, /Terra Vegetal/);
});

// ---------------------------------------------------------------- R18-12: "mostra as opções de novo"

test("R18-12: 'mostra as opções do vaso de novo' reenvia o cartão e não escolhe sozinha", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ pending: [{ query: "vaso grande para jardim", qty: 1, options: [opt(VASO.sku, VASO.name, 82.39, "telhanorte", "Telhanorte")] }] }, "choosing");
  // A IA de produção escolhia a opção única ("Fiquei com o Vaso…"): o reenvio vem antes dela.
  __setDialogueModelForTests(async () => ({ actions: [{ type: "pick", option: 1 }] }) as never);
  const start = outbox.length;
  const out = await send(c.phone, "mostra as opções do vaso de novo");
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.basket ?? []).length, 0, out);
  assert.doesNotMatch(out, /Fiquei com|✅/);
  assert.ok(outbox.slice(start).some((m) => m.to === c.phone && /Carousel|Choices/.test(m.kind)) || /Vaso De Plástico/.test(out), out);
});

// ---------------------------------------------------------------- R18-9: "o que são esses 6 litros? eu pedi 3,6"

test("R18-9: a medida trocada é reconhecida e corrigida com a unidade da busca", () => {
  assert.deepEqual(parseMeasureMixup("o da universo, mas o que são esses 6 litros? eu pedi 3,6", "tinta branca 6 litros"), { wrong: "6 litros", want: "3,6 litros" });
  assert.deepEqual(parseMeasureMixup("eu pedi 2 kg", "arroz 5kg"), { wrong: "5 kg", want: "2 kg" });
  // Escolha comum e a mesma medida não são engano.
  assert.equal(parseMeasureMixup("o primeiro", "tinta branca 6 litros"), null);
  assert.equal(parseMeasureMixup("eu pedi 6 litros", "tinta branca 6 litros"), null);
  assert.match(copy.measureMixupFixed("6 litros", "3,6 litros"), /anotei \*6 litros\*, mas você pediu \*3,6 litros\*/);
});

// ---------------------------------------------------------------- R18-14 (g50): cadastro, endereço e avisos

test("R18-14: endereço digitado com a rua do CEP sai no formato do cadastro", () => {
  const paulista = { street: "Avenida Paulista", district: "Bela Vista", city: "São Paulo", uf: "SP" };
  assert.equal(canonicalTypedAddress("av paulista 1000", paulista), "Avenida Paulista, 1000, Bela Vista, São Paulo - SP");
  assert.equal(canonicalTypedAddress("Avenida Paulista 1000 apto 52", paulista), "Avenida Paulista, 1000, apto 52, Bela Vista, São Paulo - SP");
  assert.equal(
    canonicalTypedAddress("Rua Augusta 1500, Consolação, São Paulo", { street: "Rua Augusta", district: "Consolação", city: "São Paulo", uf: "SP" }),
    "Rua Augusta, 1500, Consolação, São Paulo - SP"
  );
  // Rua diferente da do CEP, ou resto desconhecido: o texto do cliente fica.
  assert.equal(canonicalTypedAddress("Rua Augusta 1500", paulista), null);
  assert.equal(canonicalTypedAddress("Avenida Paulista 1000 fundos do mercado", paulista), null);
});

test("R18-14: formulário de cadastro já mandado vira lembrete; avisos de prazo repetidos encurtam", () => {
  const body = copy.signupFormBody(["1x peito de frango 1kg", "1x batata doce"], false);
  const reminder = copy.signupFormReminder(body);
  assert.match(reminder, /✅ Anotei:\n• 1x peito de frango 1kg\n• 1x batata doce/);
  assert.match(reminder, /botão \*Fazer cadastro\* da mensagem acima/);
  assert.doesNotMatch(reminder, /É uma vez só 👇/);
  assert.match(copy.choicesDeadlineAlsoLate("hoje às 18h", "soro fisiológico"), /^⏰ \*soro fisiológico\* também não chega pra \*hoje às 18h\*/);
});

test("R18-14: o formulário de cadastro sai uma vez; as linhas seguintes do pedido só anotam", async (t) => {
  if (!dbOk) return t.skip();
  const prev = { provider: process.env.WHATSAPP_PROVIDER, flow: process.env.LIA_FLOW_SIGNUP_ID };
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.LIA_FLOW_SIGNUP_ID = "flow-test";
  const sendFlow = adapter.sendFlowMessage;
  adapter.sendFlowMessage = async (to: string, input: { body?: string }) => {
    outbox.push({ to, kind: "sendFlowMessage", text: input.body ?? "" });
    return { provider: "test", to };
  };
  try {
    const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
    await prisma.user.create({ data: { phone } });
    await send(phone, "oi");
    await send(phone, "peito de frango 1kg");
    const third = await send(phone, "batata doce");
    const forms = outbox.filter((m) => m.to === phone && m.kind === "sendFlowMessage");
    assert.equal(forms.length, 1, JSON.stringify(outbox.filter((m) => m.to === phone)));
    assert.match(third, /batata doce/);
    assert.match(third, /Fazer cadastro\* da mensagem acima/);
  } finally {
    adapter.sendFlowMessage = sendFlow;
    if (prev.provider === undefined) delete process.env.WHATSAPP_PROVIDER;
    else process.env.WHATSAPP_PROVIDER = prev.provider;
    if (prev.flow === undefined) delete process.env.LIA_FLOW_SIGNUP_ID;
    else process.env.LIA_FLOW_SIGNUP_ID = prev.flow;
  }
});
