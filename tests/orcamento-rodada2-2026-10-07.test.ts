// Rodada 2 do plano de 100% (07/10/2026): orçamento. O teto do cliente é reconhecido em todas as formas de
// dizer, vale para o TOTAL (produto + entrega) e a Lia avisa antes de cobrar. Testes por CLASSE de frase.
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { parsePriceCap, splitPriceCap, parseBudgetStatement, parseBasketLines, isRequestModifier } from "../src/lib/lia-intents";
import * as copy from "../src/lib/lia-copy";
import { cheapestDelivery } from "../src/lib/live-freight";

test("teto reconhecido em todas as formas de dizer", () => {
  const forms: Array<[string, number]> = [
    ["vinho até uns R$60", 60],
    ["vinho até 60 reais", 60],
    ["vinho cerca de 60", 60],
    ["vinho cerca de 60 reais", 60],
    ["ventilador por volta de R$150", 150],
    ["ventilador por volta de 150", 150],
    ["ventilador no máximo 150", 150],
    ["ventilador no máximo R$ 150,00", 150],
    ["tenho uns 120 reais no total com entrega", 120],
    ["R$120 no total com entrega", 120],
    ["120 reais no total com a entrega", 120],
    ["meu limite é 150", 150],
    ["orçamento de 200 com frete", 200],
    ["não passa de 80 reais", 80],
    ["vinho 60 reais", 60],
    ["vinho tinto até 60 com frete incluso", 60],
    ["até sessenta reais", 60]
  ];
  for (const [text, cap] of forms) assert.equal(parsePriceCap(text), cap, text);
});

test("números que não são orçamento continuam fora", () => {
  for (const text of ["arroz 5kg", "uns 12 ovos", "até 3 unidades", "coca 2 litros", "entrega até 12", "mais 5 reais", "pizza de 40 reais", "no máximo 3", "quero 2 caixas"]) {
    assert.equal(parsePriceCap(text), null, text);
  }
});

test("o trecho do orçamento sai da frase de busca, com os marcadores de total", () => {
  assert.equal(splitPriceCap("vinho tinto até uns R$60 no total com entrega").phrase, "vinho tinto");
  assert.equal(splitPriceCap("ventilador cerca de 150 reais").phrase, "ventilador");
  assert.equal(splitPriceCap("perfume ate 130 reais no total com entrega").cap, 130);
});

test("orçamento solto numa linha de lista gruda no item anterior e nunca vira produto", () => {
  const lines = parseBasketLines("quero dar um perfume pra minha namorada, ate 130 reais no total com entrega");
  assert.equal(lines.length, 1);
  assert.equal(parsePriceCap(lines[0].phrase), 130);
  const withFrete = parseBasketLines("vinho no maximo 60 reais, mas com o frete");
  assert.equal(withFrete.length, 1);
  assert.equal(parsePriceCap(withFrete[0].phrase), 60);
  assert.equal(isRequestModifier("no maximo 60 reais com a entrega"), true);
  assert.equal(isRequestModifier("cerca de 60 reais"), true);
  assert.equal(isRequestModifier("vinho tinto"), false);
});

test("mensagem que é só o orçamento (dito depois do pedido)", () => {
  const statements: Array<[string, number]> = [
    ["até uns R$60", 60],
    ["cerca de 60", 60],
    ["por volta de R$150", 150],
    ["no máximo 150 com a entrega", 150],
    ["R$120 no total com entrega", 120],
    ["meu limite é 150", 150],
    ["quero gastar no máximo 80 reais", 80],
    ["ah, até 50", 50]
  ];
  for (const [text, cap] of statements) assert.equal(parseBudgetStatement(text), cap, text);
  for (const text of ["vinho tinto", "arroz 5kg", "2 caixas", "uns 12 ovos", "3 reais", "pode ser o 2"]) assert.equal(parseBudgetStatement(text), null, text);
});

test("escolha de entrega marca a opção que passa do limite do cliente", () => {
  const text = copy.shippingSpeedChoice({ total: 59.87, estimate: "1 dia útil" }, { total: 61.87, estimate: "em até 2h" }, "store", 60);
  const [barata, rapida] = text.split("\n").filter((l) => /^\*[12]\)/.test(l));
  assert.ok(!/passa do seu limite/.test(barata), barata);
  assert.match(rapida, /passa do seu limite de R\$\s?60,00/);
  assert.ok(!/limite/.test(copy.shippingSpeedChoice({ total: 59.87 }, { total: 61.87 }, "store")));
});

test("entrega mais barata de um item desempata pelo menor prazo (card e resumo dizem o mesmo)", () => {
  const picked = cheapestDelivery([
    { price: 790, shippingEstimate: "7bd" },
    { price: 790, shippingEstimate: "1bd" },
    { price: 990, shippingEstimate: "4h" }
  ]);
  assert.equal(picked.shippingEstimate, "1bd");
  assert.equal(cheapestDelivery([{ price: 500, shippingEstimate: "3bd" }, { price: 790, shippingEstimate: "4h" }]).shippingEstimate, "3bd");
});

// ---------- conversa (banco local, IA desligada) ----------

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
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `o2_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
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
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

test("vitrine com teto: só ficam as opções que cabem com a entrega (preço + frete da loja)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, "quero um desodorante colônia até R$ 55 no total com entrega");
  const ctx = await context(phone);
  const options = (ctx.pending?.[0]?.options ?? []) as { name: string; unitPrice: number }[];
  assert.ok(options.length >= 1, out);
  assert.equal(ctx.pending[0].cap, 55);
  assert.equal(ctx.pending[0].capTotal, true, "teto de um item só vale para o total");
  assert.ok(options.every((o) => /Celebre Agora/.test(o.name)), `a de R$54,99 + entrega estoura: ${options.map((o) => o.name).join(" | ")}`);
});

test("teto dito em mensagem separada, com o item na cesta, vale para o total e a Lia avisa antes de cobrar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia");
  await send(phone, "2");
  const noted = await send(phone, "cerca de 55 reais");
  assert.match(noted, /Anotado: \*R\$\s?55,00\* no total/, noted);
  assert.deepEqual((await context(phone)).budget?.cap, 55);
  const out = await send(phone, "só isso");
  assert.match(out, /passou do seu limite de \*R\$\s?55,00\*/, out);
  assert.doesNotMatch(out, /Escolhe abaixo como quer pagar/, "nenhum total estourado é apresentado");
});

test("teto dito com opções na mesa (\"no máximo 45\") filtra pelo total e acompanha a escolha", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia");
  const out = await send(phone, "no máximo 45 reais com a entrega");
  const ctx = await context(phone);
  assert.equal(ctx.pending?.[0]?.cap, 45, out);
  assert.equal(ctx.pending?.[0]?.capTotal, true);
  assert.doesNotMatch(out, /não achei/i, out);
});

test("CEP/endereço: 'R$' do orçamento não é abreviação de rua", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const out = await send(phone, "vinho tinto até uns R$60");
  assert.doesNotMatch(out, /Endereço salvo|Falta o \*CEP\*/, out);
});
