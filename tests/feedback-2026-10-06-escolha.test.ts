// Varredura de 06/10/2026 (agentes C, B e E): escolher a opção e mexer na cesta. Cada teste
// guarda um defeito reproduzido com a IA de produção e as lojas ao vivo:
//   - item novo depois do total ("e também um sabonete") apagava a cesta anterior;
//   - "tira um" limpava o carrinho; "só 1" tirava o item; "quero 2"/"6x"/"bota 3" depois de
//     escolher viravam saudação ou busca;
//   - "quero 2 do primeiro"/"o 1, duas unidades" ignoravam a quantidade;
//   - "na verdade quero o 2"/"troca pelo 2" não trocavam; "na verdade quero 12" e "pensando
//     bem quero 2 coca" RESSUSCITAVAM um pedido cancelado (Pix de R$ 52,14 por leite);
//   - dois toques no mesmo card viravam 2x calado; "voltar" tirava o item;
//   - "o da Mambo" e "quero o 2 e um sabonete" viravam busca; "quero o 1 e paga no pix"
//     ignorava a escolha; "5" numa lista de 3, "chega hoje?", "oi", "pula" e "qual o mais
//     barato?" tinham respostas erradas; "o mesmo da última vez" comprava a 3ª opção;
//     "quero desodorante" com cervejas na mesa virava "cerveja quero desodorante".
// Puros sempre; conversa com banco local (TEST_DATABASE_URL).
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import {
  asksCheapestQuestion,
  detectIntent,
  parseChoiceCombo,
  parseChoiceEtaAsk,
  parseChoiceReply,
  parseQtyCommand,
  parseStoreReference
} from "../src/lib/lia-intents";
import * as copy from "../src/lib/lia-copy";

// ---------- puros ----------

const OPTS = [
  { name: "Leite A", unitPrice: 5, storeLabel: "Mambo" },
  { name: "Leite B", unitPrice: 4, storeLabel: "Drogaria São Paulo" },
  { name: "Leite C", unitPrice: 7, storeLabel: "Swift" }
];

test("quantidade por texto vira qty_adjust (set/delta); pedido de produto não", () => {
  for (const [input, set] of [
    ["quero 2", 2], ["quero 3", 3], ["quero 2 unidades", 2], ["coloca 2", 2], ["bota 3", 3], ["6x", 6],
    ["quero 6 unidades", 6], ["muda pra 6", 6], ["na verdade quero 12", 12], ["quero só 2", 2], ["só 1", 1], ["quero só 1", 1]
  ] as const) {
    assert.deepEqual(detectIntent(input), { kind: "qty_adjust", set }, input);
  }
  for (const [input, delta] of [["tira um", -1], ["tira 1", -1], ["menos um", -1], ["põe mais um", 1], ["coloca mais 2", 2], ["quero mais 2 desse", 2]] as const) {
    assert.deepEqual(detectIntent(input), { kind: "qty_adjust", delta }, input);
  }
  for (const input of ["quero um", "coloca um", "mais um sabonete", "quero uma coca", "2kg"]) assert.equal(parseQtyCommand(input), null, input);
  assert.deepEqual(detectIntent("tira o leite"), { kind: "remove_item", target: "leite" });
  assert.deepEqual(detectIntent("tira tudo"), { kind: "clear_cart" });
  assert.deepEqual(detectIntent("2"), { kind: "number", value: 2 });
});

test("recuperar compra cancelada só vale sem produto nem número depois do 'quero'", () => {
  assert.deepEqual(detectIntent("na vdd quero sim, ainda dá?"), { kind: "resume_canceled" });
  assert.deepEqual(detectIntent("pensando bem quero sim"), { kind: "resume_canceled" });
  assert.equal(detectIntent("pensando bem quero 2 coca cola 2l").kind, "free_text");
  assert.equal(detectIntent("na verdade quero arroz integral").kind, "free_text");
  assert.equal(detectIntent("na verdade quero 12").kind, "qty_adjust");
  assert.equal(detectIntent("na verdade quero o 2").kind, "switch_choice");
});

test("troca de opção e 'voltar' têm intent próprio", () => {
  assert.deepEqual(detectIntent("na verdade quero o 2"), { kind: "switch_choice", index: 1 });
  assert.deepEqual(detectIntent("troca pelo 2"), { kind: "switch_choice", index: 1 });
  assert.deepEqual(detectIntent("troca pelo outro"), { kind: "switch_choice", other: true });
  assert.deepEqual(detectIntent("pensando bem quero o 1"), { kind: "switch_choice", index: 0 });
  assert.deepEqual(detectIntent("quero o 2 na verdade"), { kind: "switch_choice", index: 1 });
  assert.equal(detectIntent("quero o 2").kind, "free_text", "sem marca de correção é escolha comum");
  assert.deepEqual(detectIntent("voltar"), { kind: "back" });
  assert.deepEqual(detectIntent("quero voltar pra lista"), { kind: "back" });
});

test("escolha + quantidade na mesma mensagem; 'última vez' não é ordinal", () => {
  assert.deepEqual(parseChoiceReply("quero 2 do primeiro", OPTS), { type: "pick", index: 0, qty: 2 });
  assert.deepEqual(parseChoiceReply("2 do primeiro", OPTS), { type: "pick", index: 0, qty: 2 });
  assert.deepEqual(parseChoiceReply("o 1, duas unidades", OPTS), { type: "pick", index: 0, qty: 2 });
  assert.deepEqual(parseChoiceReply("2x o terceiro", OPTS), { type: "pick", index: 2, qty: 2 });
  assert.deepEqual(parseChoiceReply("quero 2 do mais barato", OPTS), { type: "pick", index: 1, qty: 2 });
  assert.deepEqual(parseChoiceReply("quero o mesmo da última vez", OPTS), { type: "previous" });
  assert.deepEqual(parseChoiceReply("igual da outra vez", OPTS), { type: "previous" });
  assert.deepEqual(parseChoiceReply("o último", OPTS), { type: "pick", index: 2 });
  assert.deepEqual(parseChoiceReply("2", OPTS), { type: "pick", index: 1 });
});

test("escolha + pagamento e escolha + item novo; loja citada; perguntas sobre as opções", () => {
  assert.deepEqual(parseChoiceCombo("quero o 1 e paga no pix", OPTS), { reply: { type: "pick", index: 0 }, pay: true });
  assert.deepEqual(parseChoiceCombo("o 1, pode pagar no pix", OPTS), { reply: { type: "pick", index: 0 }, pay: true });
  assert.deepEqual(parseChoiceCombo("quero o 2 e um sabonete", OPTS), { reply: { type: "pick", index: 1 }, rest: "um sabonete" });
  assert.equal(parseChoiceCombo("leite e pão", OPTS), null);
  assert.deepEqual(parseStoreReference("o da Mambo", OPTS), { label: "Mambo", indices: [0] });
  assert.deepEqual(parseStoreReference("a da drogaria são paulo", OPTS), { label: "Drogaria São Paulo", indices: [1] });
  assert.deepEqual(parseStoreReference("o do carrefour", OPTS, ["Carrefour"]), { label: "Carrefour", indices: [] });
  assert.equal(parseStoreReference("o de 2 litros", OPTS, ["Carrefour"]), null);
  assert.deepEqual(parseChoiceEtaAsk("chega hoje?"), { today: true });
  assert.deepEqual(parseChoiceEtaAsk("o 2 chega hoje?"), { option: 2, today: true });
  assert.equal(parseChoiceEtaAsk("leite"), null);
  assert.equal(asksCheapestQuestion("qual o mais barato?"), "cheapest");
  assert.equal(asksCheapestQuestion("o mais barato"), null);
  assert.match(copy.choiceOutOfRange(3), /São só 3 opções/);
  assert.match(copy.choiceEtaAnswer([{ n: 1, name: "A", delivery: "Swift · hoje", today: true }, { n: 2, name: "B", delivery: "Mambo · 1 dia útil" }], true), /Chega hoje: \*1\*/);
});

// ---------- conversa (banco local) ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `esc_${RUN}_${++seq}` });
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
type Line = { sku: string; name: string; qty: number };
async function basket(phone: string): Promise<Line[]> {
  return ((await context(phone)).basket ?? []) as Line[];
}
// Escolha aberta montada à mão: duas lojas e prazos conhecidos (o seed de teste é uma loja só).
async function withChoice(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const options = [
    { sku: "CRF-PAD-003", name: "Leite UHT Integral Carrefour Classic 1L", unitPrice: 5.38, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 },
    { sku: "MB-LEITE-1", name: "Leite Integral Italac 1L", unitPrice: 6.04, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje", etaMinutes: 120 },
    { sku: "CRF-PAD-027", name: "Leite Integral Jussara Max 1L", unitPrice: 5.71, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }
  ];
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", step: "choosing", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pending: [{ query: "leite", qty: 1, options }], pendingSince: Date.now() })
    }
  });
  return options;
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

test("A1: item novo depois do total (roteador da IA) reabre o pedido e soma, não apaga", async (t) => {
  if (!dbOk) return t.skip();
  const { __setRouterInterpreterForTests } = await import("../src/lib/adapters/ai");
  __setRouterInterpreterForTests(async (input) =>
    /também um sabonete/.test(input.text)
      ? { action: "product_request", productRequest: "sabonete" }
      : /esqueci o sabonete/.test(input.text)
        ? { action: "basket_edit", editCommand: "adiciona sabonete" }
        : null
  );
  try {
    for (const phrase of ["e também um sabonete", "esqueci o sabonete"]) {
      const phone = await customer();
      await send(phone, "quero arroz");
      await send(phone, "1");
      const quote = await send(phone, "pagar");
      assert.match(quote, /Seu pedido/, quote.slice(0, 300));
      const ctx = await context(phone);
      await send(phone, phrase);
      await send(phone, "1");
      const items = await basket(phone);
      assert.ok(items.some((i) => /arroz/i.test(i.name)), `${phrase}: o arroz sumiu (${JSON.stringify(items)})`);
      assert.ok(items.some((i) => /sabonete/i.test(i.name)), `${phrase}: o sabonete não entrou`);
      const old = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: ctx.deliveryOrderId } });
      assert.equal(old.status, "canceled", "a cotação velha não fica órfã");
    }
  } finally {
    __setRouterInterpreterForTests(null);
  }
});

test("A2: 'tira um' baixa uma unidade; 'só 1' volta para 1 — nunca esvazia", async (t) => {
  if (!dbOk) return t.skip();
  for (const [phrase, expected] of [["tira um", 1], ["só 1", 1], ["quero só 1", 1], ["tira 1", 1]] as const) {
    const phone = await customer();
    await send(phone, "quero leite");
    await send(phone, "1");
    await send(phone, "2");
    const out = await send(phone, phrase);
    assert.doesNotMatch(out, /Carrinho limpo|cesta ficou vazia/, `${phrase}: ${out}`);
    const items = await basket(phone);
    assert.equal(items.length, 1, phrase);
    assert.equal(items[0].qty, expected, phrase);
  }
});

test("A3: escolha + quantidade na mesma mensagem", async (t) => {
  if (!dbOk) return t.skip();
  for (const phrase of ["quero 2 do primeiro", "2 do primeiro", "o 1, duas unidades"]) {
    const phone = await customer();
    await send(phone, "quero leite");
    const out = await send(phone, phrase);
    assert.match(out, /✅ 2x/, `${phrase}: ${out.slice(0, 200)}`);
    const items = await basket(phone);
    assert.equal(items[0]?.qty, 2, phrase);
  }
});

test("A4: quantidade por texto depois de escolher muda o item, e o 'pagar' segue", async (t) => {
  if (!dbOk) return t.skip();
  for (const [phrase, expected] of [
    ["quero 2", 2], ["quero 3", 3], ["quero 2 unidades", 2], ["coloca 2", 2], ["põe mais um", 2], ["6x", 6],
    ["quero 6 unidades", 6], ["muda pra 6", 6], ["coloca mais 2", 3], ["bota 3", 3], ["na verdade quero 12", 12]
  ] as const) {
    const phone = await customer();
    await send(phone, "quero leite");
    await send(phone, "1");
    const out = await send(phone, phrase);
    assert.doesNotMatch(out, /Sou a Lia|Olha o que achei|não achei/i, `${phrase}: ${out.slice(0, 200)}`);
    const items = await basket(phone);
    assert.equal(items.length, 1, phrase);
    assert.equal(items[0].qty, expected, phrase);
    const ctx = await context(phone);
    assert.ok(!ctx.pending?.length, `${phrase}: nenhuma escolha nova aberta`);
  }
  const phone = await customer();
  await send(phone, "quero leite");
  await send(phone, "1");
  await send(phone, "quero 2 unidades");
  const pay = await send(phone, "pagar");
  assert.doesNotMatch(pay, /Antes de pagar, escolhe/, pay.slice(0, 200));
});

test("A4/B-A1: 'na verdade quero 12' e 'pensando bem quero 2 coca' não ressuscitam pedido cancelado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  await prisma.deliveryOrder.create({
    data: { userId: user.id, phone, status: "canceled", total: 52.14, itemsSubtotal: 44, serviceFee: 0, deliveryFee: 8.14, items: [{ sku: "CRF-PAD-003", name: "Leite UHT Integral Carrefour Classic 1L", qty: 6, unitPrice: 5.38, lineTotal: 32.28, storeKey: "carrefour", storeLabel: "Carrefour" }], storeKey: "concierge", cep: "01310-100", deliveryAddress: ADDRESS }
  });
  await send(phone, "quero arroz");
  await send(phone, "1");
  const out = await send(phone, "na verdade quero 12");
  assert.doesNotMatch(out, /Recuperei/, out.slice(0, 200));
  const items = await basket(phone);
  assert.equal(items.length, 1);
  assert.match(items[0].name, /arroz/i);
  assert.equal(items[0].qty, 12);
  const coca = await send(phone, "pensando bem quero 2 coca cola 2l");
  assert.doesNotMatch(coca, /Recuperei/, coca.slice(0, 200));
  assert.ok((await basket(phone)).some((i) => /arroz/i.test(i.name)), "a cesta atual continua");
});

test("A5: 'na verdade quero o 2' / 'troca pelo 3' trocam pela opção da última lista e mantêm a quantidade", async (t) => {
  if (!dbOk) return t.skip();
  const a = await customer();
  const list = await send(a, "quero leite");
  const second = list.split("\n").find((l) => /^\*2\)\*/.test(l)) ?? "";
  await send(a, "1");
  const first = (await basket(a))[0];
  const out = await send(a, "na verdade quero o 2");
  assert.match(out, /Troquei: saiu/, out);
  const items = await basket(a);
  assert.equal(items.length, 1);
  assert.notEqual(items[0].sku, first.sku);
  assert.ok(second.includes(items[0].name), `${second} × ${items[0].name}`);

  const b = await customer();
  await send(b, "quero leite");
  await send(b, "1");
  await send(b, "2");
  await send(b, "troca pelo 3");
  const swapped = await basket(b);
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0].qty, 2, "a quantidade passa para o novo");

  const c = await customer();
  await send(c, "quero leite");
  await send(c, "1");
  const other = await send(c, "troca pelo outro");
  assert.match(other, /Voltei pras opções/, other.slice(0, 200));
  assert.equal((await basket(c)).length, 1, "o item fica até escolher outro");

  const d = await customer();
  await send(d, "quero leite");
  const picked = await send(d, "na verdade quero o 3");
  assert.doesNotMatch(picked, /retomar/, picked);
  assert.equal((await basket(d)).length, 1);
});

test("A6: tocar duas vezes no mesmo card não soma", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero leite");
  const ctx = await context(phone);
  const sku = ctx.pending[0].options[0].sku;
  await send(phone, `optsku:${sku}`);
  const again = await send(phone, `optsku:${sku}`);
  assert.match(again, /já está na cesta/, again);
  const items = await basket(phone);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 1);
});

test("A7: 'voltar' depois de escolher reabre a lista sem tirar o item; escolher outro substitui", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero leite");
  await send(phone, "1");
  const back = await send(phone, "voltar");
  assert.match(back, /Voltei pras opções de \*leite\*/, back.slice(0, 200));
  assert.doesNotMatch(back, /Tirei/);
  assert.equal((await basket(phone)).length, 1, "o item continua");
  await send(phone, "2");
  const items = await basket(phone);
  assert.equal(items.length, 1, "o 2 substituiu o 1");
  assert.equal(items[0].qty, 1);
});

test("A8: 'o da Mambo' estreita pela loja; 'quero o 2 e um sabonete' escolhe e enfileira", async (t) => {
  if (!dbOk) return t.skip();
  const a = await customer();
  await withChoice(a);
  const out = await send(a, "o da Mambo");
  assert.match(out, /Da \*Mambo\*/, out.slice(0, 200));
  const ctx = await context(a);
  assert.deepEqual(ctx.pending[0].options.map((o: { sku: string }) => o.sku), ["MB-LEITE-1"]);

  const b = await customer();
  await send(b, "quero leite");
  const combo = await send(b, "quero o 2 e um sabonete");
  assert.doesNotMatch(combo, /leite quero o 2/i, combo.slice(0, 200));
  assert.equal((await basket(b)).length, 1, "o leite 2 entrou");
  const next = await context(b);
  assert.match(next.pending?.[0]?.query ?? "", /sabonete/, "o sabonete está na fila");
});

test("M1: 'quero o 1 e paga no pix' escolhe e segue para o total", async (t) => {
  if (!dbOk) return t.skip();
  for (const phrase of ["quero o 1 e paga no pix", "o 1, pode pagar no pix"]) {
    const phone = await customer();
    await send(phone, "quero arroz");
    const out = await send(phone, phrase);
    assert.doesNotMatch(out, /Não peguei|Antes de pagar, escolhe/, `${phrase}: ${out.slice(0, 200)}`);
    assert.match(out, /Seu pedido|Produtos/, `${phrase}: ${out.slice(0, 300)}`);
  }
});

test("M2, M7, M8, M9: número fora da lista, 'oi', 'pula' e 'qual o mais barato?'", async (t) => {
  if (!dbOk) return t.skip();
  const a = await customer();
  await send(a, "quero leite");
  assert.match(await send(a, "5"), /São só 3 opções/);
  const hi = await send(a, "oi");
  assert.match(hi, /Ainda tô com as opções de \*leite\*/, hi.slice(0, 200));
  const cheap = await send(a, "qual o mais barato?");
  assert.match(cheap, /O mais barato é o \*\d\*/, cheap);
  assert.equal((await basket(a)).length, 0, "pergunta não põe na cesta");
  const skip = await send(a, "pula");
  assert.match(skip, /Deixei \*leite\* de fora/);
  assert.doesNotMatch(skip, /Não entendi/, skip);
});

test("M5: 'chega hoje?' com as opções na tela responde com os prazos", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  const all = await send(phone, "chega hoje?");
  assert.match(all, /Chega hoje: \*2\*/, all);
  assert.doesNotMatch(all, /Falta você escolher/);
  const one = await send(phone, "o 1 chega hoje?");
  assert.match(one, /Hoje não/, one);
});

test("E: 'o mesmo da última vez' não compra a última opção; produto de outro tipo vai pra fila", async (t) => {
  if (!dbOk) return t.skip();
  const a = await customer();
  await send(a, "quero leite");
  const out = await send(a, "quero o mesmo da última vez");
  assert.doesNotMatch(out, /✅/, out.slice(0, 200));
  assert.equal((await basket(a)).length, 0);

  const b = await customer();
  await send(b, "quero cerveja");
  const deo = await send(b, "quero desodorante");
  assert.doesNotMatch(deo, /cerveja quero desodorante/i, deo.slice(0, 200));
  const ctx = await context(b);
  assert.ok(ctx.pending.some((p: { query: string }) => /desodorante/.test(p.query)), "desodorante entrou na fila");
  assert.match(ctx.pending[0].query, /^cerveja$/);
});
