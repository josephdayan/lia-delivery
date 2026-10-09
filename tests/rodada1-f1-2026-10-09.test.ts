// Rodada 1 de testes no WhatsApp (09/10, grupo f1): limpar a lista inteira, repetir pedido, "cancela" ambíguo,
// "muda pra N" depois do resumo, "mais um" e "troca X pelo mais barato". A IA do diálogo é SIMULADA: onde a frase tem
// resposta inequívoca, o código decide sem ela (a simulada responde "unclear" para provar que não é consultada).
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { detectIntent, isExplicitClearAll, isExplicitRepeatOrder, parseQtyCommand } from "../src/lib/lia-intents";
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
  await handleDeliveryMessage({ phone, text, messageId: `r1f1_${RUN}_${++seq}` });
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

// ---------------------------------------------------------------- 1. esvaziar a lista inteira

test("frases de desistência da lista inteira são clear_cart e não consultam a IA", () => {
  for (const t of ["na verdade não quero nada disso", "não quero nada disso", "esquece tudo", "deixa pra lá tudo", "deixa tudo pra lá", "na verdade esquece tudo isso", "desisto de tudo"]) {
    assert.equal(detectIntent(t).kind, "clear_cart", t);
    assert.ok(isExplicitClearAll(t) || /^esquece tudo$/.test(t), t);
    const bypass = dialogueBypassReason({ text: t, intent: detectIntent(t), ctx: { step: "choosing", pending: [{ query: "x", qty: 1, options: [{ sku: "a" }] }] } as never, hasAddress: true, looksLikeList: false });
    assert.ok(bypass, `${t}: não pode ir pra IA`);
  }
  // não são desistência da lista: continuam como antes
  assert.equal(detectIntent("não quero mais nada").kind, "done");
  assert.notEqual(detectIntent("não quero esse, quero outro").kind, "clear_cart");
});

test("'na verdade não quero nada disso' no meio da escolha esvazia tudo (nada de feijão na fila)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  const reply = await send(phone, "na verdade não quero nada disso");
  assert.match(reply, /Carrinho limpo|esvaziei/i);
  assert.doesNotMatch(reply, /feij|Deixei|Tirei/i);
  const ctx = await context(phone);
  assert.equal(ctx.pending?.length ?? 0, 0);
  assert.equal(ctx.basket?.length ?? 0, 0);
  assert.match(await send(phone, "pagar"), /vazia|o que você/i);
  assert.equal(modelCalls, 0);
});

// ---------------------------------------------------------------- 2. repetir pedido

test("'repete meu último pedido' / 'o mesmo de ontem' / 'o mesmo da última vez' chegam ao ramo de repetir, sem IA", () => {
  for (const t of ["repete meu último pedido", "quero o mesmo de ontem", "o mesmo da última vez", "repete o último pedido", "manda o mesmo pedido de ontem", "quero o mesmo da última vez, por favor"]) {
    assert.equal(detectIntent(t).kind, "repeat_last", t);
    assert.ok(isExplicitRepeatOrder(t), t);
    assert.ok(dialogueBypassReason({ text: t, intent: detectIntent(t), ctx: {} as never, hasAddress: true, looksLikeList: false }), `${t}: não pode ir pra IA`);
  }
  // com produto no meio é busca (com o ⭐ "você já pediu"), não repetição do pedido todo
  assert.notEqual(detectIntent("quero o mesmo shampoo da outra vez").kind, "repeat_last");
  assert.equal(isExplicitRepeatOrder("repete o leite"), false);
});

test("sem pedido anterior: diz que não há pedido pra repetir", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  assert.match(await send(phone, "quero o mesmo de ontem"), /não tem um pedido pra repetir/);
  assert.match(await send(phone, "repete meu último pedido"), /pedido pra repetir/i);
  assert.equal(modelCalls, 0);
});

test("com pedido anterior: remonta pra conferência e o 'sim' fecha o total (não vira agradecimento)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const o = OPTIONS[0];
  await prisma.deliveryOrder.create({
    data: {
      userId: user.id,
      phone,
      storeKey: "carrefour",
      storeLabel: "Carrefour",
      items: [{ sku: o.sku, name: o.name, qty: 2, unitPrice: o.unitPrice, lineTotal: o.unitPrice * 2, storeKey: "carrefour", storeLabel: "Carrefour" }],
      status: "delivered"
    }
  });
  const first = await send(phone, "repete meu último pedido");
  assert.match(first, /Leite UHT Integral Carrefour Classic/);
  assert.equal((await context(phone)).repeatConfirm, true);
  const yes = await send(phone, "sim");
  assert.doesNotMatch(yes, /Imagina/);
  assert.match(yes, /R\$/);
});

// ---------------------------------------------------------------- 3. "cancela" ambíguo

test("'cancela' com 2+ itens em escolha pergunta antes de apagar; 'não' mantém, 'sim' esvazia", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  const ask = await send(phone, "cancela");
  assert.match(ask, /Cancelar a cesta toda\?/);
  assert.equal((await context(phone)).pending?.length, 3, "nada foi apagado ainda");
  const kept = await send(phone, "não");
  assert.match(kept, /mantive/i);
  const ctx = await context(phone);
  assert.equal(ctx.pending?.length, 3);
  assert.equal(ctx.clearAllConfirm, undefined);
  await send(phone, "cancela");
  assert.match(await send(phone, "sim"), /Carrinho limpo/);
  assert.equal((await context(phone)).pending?.length ?? 0, 0);
});

test("'cancela' com um item só em escolha continua limpando direto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone, { pending: [{ query: "leite", qty: 1, options: OPTIONS }] });
  assert.match(await send(phone, "cancela"), /Carrinho limpo/);
});

test("'cancela' com a oferta de complemento na tela recusa a oferta e mantém a cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const o = OPTIONS[0];
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        step: "collecting",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        storeKey: "concierge",
        basket: [{ sku: o.sku, name: o.name, qty: 2, unitPrice: o.unitPrice, lineTotal: o.unitPrice * 2, storeKey: "carrefour", storeLabel: "Carrefour" }],
        complementOffer: { at: Date.now(), query: "achocolatado", shelfId: "achocolatado", option: { ...OPTIONS[1], sku: "MB-NESCAU" } }
      })
    }
  });
  const reply = await send(phone, "cancela");
  assert.doesNotMatch(reply, /Tudo bem, cancelado|Carrinho limpo/);
  assert.equal((await context(phone)).basket?.length, 1, "a cesta de 2 leites continua");
});

// ---------------------------------------------------------------- 4/5. quantidade: "muda pra 6", "mais um"

test("'mais um' logo depois de escolher soma 1 ao item recém-escolhido (nada de 'mais leite ou outro produto?')", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const [a, b] = OPTIONS;
  const line = (o: (typeof OPTIONS)[number], qty: number) => ({ sku: o.sku, name: o.name, qty, unitPrice: o.unitPrice, lineTotal: o.unitPrice * qty, storeKey: o.storeKey, storeLabel: o.storeLabel });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        step: "collecting",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        storeKey: "concierge",
        basket: [line(a, 1), line(b, 3)],
        lastChoice: { query: "leite", qty: 3, options: OPTIONS, chosenSku: b.sku }
      })
    }
  });
  const reply = await send(phone, "mais um");
  assert.match(reply, /4x Leite Integral Italac/);
  assert.equal(modelCalls, 0);
  const basket = (await context(phone)).basket ?? [];
  assert.equal(basket.find((i) => i.sku === b.sku)?.qty, 4);
  assert.equal(basket.find((i) => i.sku === a.sku)?.qty, 1, "o outro item não muda");
});

test("'muda pra 6' / 'põe 6' / 'quero 6' com o resumo na tela são quantidade, nunca a opção 6 da lista", () => {
  for (const t of ["muda pra 6", "põe 6", "quero 6", "muda para 6"]) {
    assert.equal(detectIntent(t).kind, "qty_adjust", t);
    assert.deepEqual(parseQtyCommand(t), { set: 6 }, t);
  }
  // trocar pela OPÇÃO continua sendo troca
  assert.equal(detectIntent("troca pelo 2").kind, "switch_choice");
  assert.equal(parseQtyCommand("troca pelo 2"), null);
});

test("'muda pra 6' com o resumo na tela muda a quantidade e reenvia o resumo (não vira 'só N opções')", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const o = OPTIONS[0];
  const item = { sku: o.sku, name: o.name, qty: 1, unitPrice: o.unitPrice, lineTotal: o.unitPrice, storeKey: "carrefour", storeLabel: "Carrefour" };
  const order = await prisma.deliveryOrder.create({
    data: { userId: user.id, phone, storeKey: "carrefour", storeLabel: "Carrefour", items: [item], total: 23, status: "awaiting_quote_confirmation" }
  });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        step: "awaiting_quote_confirmation",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        storeKey: "concierge",
        deliveryOrderId: order.id,
        basket: [item],
        lastChoice: { query: "leite", qty: 1, options: OPTIONS, chosenSku: o.sku }
      })
    }
  });
  const reply = await send(phone, "muda pra 6");
  assert.doesNotMatch(reply, /opções|Voltei pras opções|São só/);
  assert.match(reply, /6x/);
  const latest = await prisma.deliveryOrder.findFirstOrThrow({ where: { userId: user.id, status: { not: "canceled" } }, orderBy: { createdAt: "desc" } });
  assert.equal((latest.items as unknown as { qty: number }[])[0].qty, 6);
});
