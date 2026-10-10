// Rodada 5, grupo G16 (10/10): "mais barato" que ignora o carrossel já mostrado, prazo "amanhã", nome + CPF + CEP na
// mesma mensagem, "quero a fralda de antes" respondendo "De qual item?", "pode ser o X e adiciona Y", "total" com
// cesta vazia/pergunta pendente, "sem perfume" no ranking e alerta da linha de teste.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, cheaperSwapPool } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem, ChoiceOption } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5577${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;

async function item(query: string, store: string, qty: number, nameRe: RegExp): Promise<BasketItem> {
  const c = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).find((x) => x.store.key === store && nameRe.test(x.item.name));
  assert.ok(c, `catálogo de teste sem ${query} em ${store}`);
  return { sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, qty, unitPrice: c!.item.unitPrice, lineTotal: Math.round(c!.item.unitPrice * qty * 100) / 100, storeKey: store, storeLabel: c!.store.label, productUrl: c!.item.productUrl };
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
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g16_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}


const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });

// 1) "troca o protetor por um mais barato": as opções JÁ MOSTRADAS daquele item entram na comparação -----------------
test("cheaperSwapPool: opção já mostrada entra; mesmo tamanho primeiro; FPS pedido vem antes", () => {
  const cur = bi("cur", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99, { ask: "protetor solar fps 30" });
  const pool = cheaperSwapPool(
    cur,
    [opt("a", "Protetor Solar Corporal FPS 30 Basic+ 100ml", 22.99), opt("b", "Protetor Solar FPS 50 Suncare 30ml", 30), opt("c", "Protetor Solar Facial FPS 30 40ml", 20)],
    [opt("oaz", "Protetor Solar OAZ FPS 30 200ml", 41.99), opt("cb", "Protetor Solar Cenoura e Bronze FPS 30 200ml", 33.99), opt("cur", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99)]
  );
  assert.deepEqual(pool.map((o) => o.sku), ["cb", "oaz", "a", "b"]);
});

test("'troca o protetor por um mais barato': o 200 ml mais barato do carrossel mostrado entra no lugar", async (t) => {
  if (!dbOk) return t.skip();
  const cur = bi("americanas-2708695", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99, { ask: "protetor solar fps 30" });
  const shown = [
    opt("americanas-2708695", cur.name, 44.99),
    opt("g16-oaz-200", "Protetor Solar OAZ FPS 30 Corporal 200ml", 14.19),
    opt("g16-cenoura-200", "Protetor Solar Cenoura e Bronze FPS 30 Frasco 200ml", 12.39)
  ];
  const c = await customerWith({ basket: [cur], lastChoice: { query: "protetor solar fps 30", qty: 1, options: shown, chosenSku: cur.sku } });
  const out = await send(c.phone, "troca o protetor por um mais barato");
  assert.doesNotMatch(out, /já é o mais barato|já está o mais barato/i, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  const skus = [...(ctx.basket ?? []).map((b: BasketItem) => b.sku), ...((ctx.pending?.[0]?.options ?? []) as ChoiceOption[]).map((o) => o.sku)];
  assert.ok(skus.includes("g16-cenoura-200"), `${skus.join(",")} :: ${out.slice(0, 400)}`);
});
