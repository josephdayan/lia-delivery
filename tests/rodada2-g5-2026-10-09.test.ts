// Rodada 2 de testes no WhatsApp (09/10, grupo g5): as correções da rodada 1 só pegavam a frase exata. "1"/"2" em
// qualquer pergunta sim/não, "1" repetido, "deixa pra lá, não quero mais nada", repetir pedido, abreviações, "n 1000". A IA do diálogo é SIMULADA: onde a frase tem
// resposta inequívoca, o código decide sem ela (a simulada responde "unclear" para provar que não é consultada).
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { detectIntent, expandShoppingShorthand, isExplicitClearAll, isExplicitRepeatOrder } from "../src/lib/lia-intents";
import { extractLabeledHouseNumber } from "../src/lib/address-parse";
import type { DeliveryContext } from "../src/lib/conversation-types";

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
let modelCalls = 0;
// IA simulada que sempre "não entende": se o código dependesse dela, a resposta seria a pergunta genérica.
function dumbModel() {
  modelCalls = 0;
  __setDialogueModelForTests(async () => {
    modelCalls++;
    return { actions: [{ type: "unclear" }] };
  });
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `r2g5_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string): Promise<DeliveryContext> {
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
beforeEach(() => {
  process.env.LIA_DIALOGUE_LLM = "true";
  dumbModel();
});
after(async () => {
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

const OPTIONS = [
  { sku: "CRF-PAD-003", name: "Leite UHT Integral Carrefour Classic 1L", unitPrice: 5.38, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 },
  { sku: "MB-LEITE-1", name: "Leite Integral Italac 1L", unitPrice: 6.04, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje", etaMinutes: 120 },
  { sku: "CRF-PAD-027", name: "Leite Integral Jussara Max 1L", unitPrice: 5.71, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }
];
const ARROZ = [{ sku: "CRF-ARROZ-1", name: "Arroz Branco Tio João 5kg", unitPrice: 30.5, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }];
async function withChoice(phone: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        step: "choosing",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        storeKey: "concierge",
        pending: [{ query: "arroz 5kg", qty: 1, options: ARROZ }, { query: "feijão", qty: 1, options: OPTIONS }, { query: "açúcar", qty: 1, options: OPTIONS }],
        pendingSince: Date.now(),
        ...extra
      })
    }
  });
}


const line = (o: (typeof OPTIONS)[number], qty: number) => ({ sku: o.sku, name: o.name, qty, unitPrice: o.unitPrice, lineTotal: o.unitPrice * qty, storeKey: o.storeKey, storeLabel: o.storeLabel });
async function withCtx(phone: string, extra: Record<string, unknown>) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  await prisma.conversation.create({
    data: { userId: user.id, context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...extra }) }
  });
}

// ---------------------------------------------------------------- puros

test("desistência com 'deixa pra lá' + 'não quero mais nada' esvazia tudo; 'não quero mais nada' sozinho continua fechando", () => {
  for (const t of ["deixa pra lá, não quero mais nada", "deixa pra lá não quero nada", "esquece, não quero mais nada", "deixa quieto, não preciso de mais nada"]) {
    assert.equal(detectIntent(t).kind, "clear_cart", t);
    assert.ok(isExplicitClearAll(t), t);
  }
  assert.equal(detectIntent("não quero mais nada").kind, "done");
});

test("repetir o pedido: variações caem no mesmo caminho de 'repete meu último pedido'", () => {
  for (const t of ["me manda o mesmo de sempre", "faz de novo aquele pedido", "pede de novo o que eu pedi semana passada", "o de sempre", "quero o mesmo de ontem", "repete meu último pedido"]) {
    assert.equal(detectIntent(t).kind, "repeat_last", t);
    assert.ok(isExplicitRepeatOrder(t), t);
  }
  assert.ok(!isExplicitRepeatOrder("quero o mesmo shampoo da outra vez"));
});

test("abreviações com ponto viram a palavra inteira", () => {
  assert.equal(expandShoppingShorthand("queijo mussarela e pres. sadia"), "queijo mussarela e presunto sadia");
  assert.equal(expandShoppingShorthand("ref. coca zero 2l, mac. espaguete barilla, det. ypê"), "refrigerante coca zero 2l, macarrão espaguete barilla, detergente ypê");
  assert.equal(expandShoppingShorthand("mac book"), "mac book");
});

test("número da casa rotulado com 'n', 'n.', 'nº', 'num'", () => {
  for (const t of ["n 1000 e quero leite", "n. 1000 e quero leite", "nº 1000 e quero leite", "num 1000 e quero leite"]) {
    assert.deepEqual(extractLabeledHouseNumber(t), { numero: "1000", rest: "e quero leite" }, t);
  }
  assert.equal(extractLabeledHouseNumber("quero leite"), null);
  assert.equal(extractLabeledHouseNumber("pão n"), null);
});

// ---------------------------------------------------------------- conversa

test("'1'/'2' na oferta de complemento é sim/não e não mexe na quantidade", async (t) => {
  if (!dbOk) return t.skip();
  for (const [answer, added] of [["1", true], ["2", false]] as const) {
    const phone = await customer();
    const o = OPTIONS[0];
    await withCtx(phone, {
      basket: [line(o, 1)],
      lastChoice: { query: "leite", qty: 1, options: OPTIONS, chosenSku: o.sku },
      complementOffer: { at: Date.now(), query: "achocolatado", shelfId: "achocolatado", why: "x", trigger: "t", option: { ...OPTIONS[1], sku: "MB-NESCAU", name: "Nescau 400g" } }
    });
    const reply = await send(phone, answer);
    assert.doesNotMatch(reply, /✅ \d+x Leite/, reply);
    const basket = (await context(phone)).basket ?? [];
    assert.equal(basket.find((i) => i.sku === o.sku)?.qty, 1);
    assert.equal(basket.some((i) => i.sku === "MB-NESCAU"), added, `resposta ${answer}`);
  }
});

test("'1' repetido sem escolha pendente não reescreve a quantidade pedida", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const o = OPTIONS[0];
  await withCtx(phone, { basket: [line(o, 12)], lastChoice: { query: "leite", qty: 12, options: OPTIONS, chosenSku: o.sku } });
  const reply = await send(phone, "1");
  assert.match(reply, /12x/);
  assert.equal((await context(phone)).basket?.[0].qty, 12);
  // Um número maior logo depois da escolha continua sendo o ajuste de quantidade, uma vez.
  assert.match(await send(phone, "4"), /4x/);
  assert.equal((await context(phone)).basket?.[0].qty, 4);
  await send(phone, "7");
  assert.equal((await context(phone)).basket?.[0].qty, 4, "o segundo número solto não reescreve");
  await send(phone, "só 2");
  assert.equal((await context(phone)).basket?.[0].qty, 2, "com verbo continua valendo");
});

test("'deixa pra lá, não quero mais nada' esvazia a fila toda", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  assert.match(await send(phone, "deixa pra lá, não quero mais nada"), /Carrinho limpo/);
  const ctx = await context(phone);
  assert.equal(ctx.pending?.length ?? 0, 0);
  assert.equal(ctx.basket?.length ?? 0, 0);
});

test("'faz de novo aquele pedido' sem pedido anterior responde como 'repete meu último pedido'", async (t) => {
  if (!dbOk) return t.skip();
  const a = await customer();
  const ref = await send(a, "repete meu último pedido");
  for (const t2 of ["me manda o mesmo de sempre", "faz de novo aquele pedido", "pede de novo o que eu pedi semana passada"]) {
    const phone = await customer();
    assert.equal(await send(phone, t2), ref, t2);
  }
});

test("CEP + 'n 1000' + pedido salva o número da casa", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  const out = await send(phone, "01310-100 n 1000 e quero leite");
  assert.match((await context(phone)).deliveryAddress ?? "", /1000/);
  assert.doesNotMatch(out, /falta só o \*número\*/);
});

test("botão antigo reenviado como texto não vira busca de produto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const o = OPTIONS[0];
  await withCtx(phone, { basket: [line(o, 1)] });
  for (const id of ["complemento_nao", "longtail_sim"]) {
    const out = await send(phone, id);
    assert.match(out, /conversa antiga/, id);
    assert.doesNotMatch(out, /eu não achei|Opções de/i, id);
  }
  assert.equal((await context(phone)).basket?.length, 1);
});
