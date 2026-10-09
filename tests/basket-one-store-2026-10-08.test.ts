// Uma loja por pedido (dono, 08/10 noite, print: "2 vodkas, 1 suco, 1 gin, 4 red bull" caiu em Santa Luzia,
// Americanas e Mambo; travou no mínimo da Americanas e "Quando chega" voltou "Até agora… diz só isso" duas
// vezes). A compra é por API e fecha UMA loja por pedido: no fechamento a Lia junta a lista na loja que tem
// tudo (mesmo produto, mesma marca e tamanho) e "quando chega?" com a lista na mesa fecha o total, que traz
// o prazo.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import type { BasketItem } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5573${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(basket: BasketItem[]): Promise<{ phone: string; userId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, basket }) }
  });
  return { phone, userId: user.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `b1s_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}

test("lista em 2 lojas + 'quando chega' → junta tudo na loja que tem tudo e manda o total (nunca 'Até agora')", async (t) => {
  if (!dbOk) return t.skip();
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const coca = await item("refrigerante coca cola sem acucar lata", "oba", 2, /Sem Açúcar Lata/i);
  const c = await customerWith([leite, arroz, coca]);
  const out = await send(c.phone, "Quando chega");
  assert.doesNotMatch(out, /Até agora/, out.slice(0, 500));
  assert.match(out, /O prazo é o da loja/, out.slice(0, 500));
  assert.match(out, /Juntei tudo na \*Carrefour\* pra vir num pedido só/, out.slice(0, 800));
  assert.match(out, /Coca-Cola Sem Açúcar/);
  assert.match(out, /Total/, out.slice(0, 800));
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const stores = new Set((order.items as { storeKey: string }[]).map((i) => i.storeKey));
  assert.deepEqual([...stores], ["carrefour"], "um pedido, uma loja");
  const cocaNow = (order.items as { name: string; qty: number }[]).find((i) => /Coca-Cola/i.test(i.name));
  assert.equal(cocaNow?.qty, 2, "quantidade preservada");
  assert.match(cocaNow?.name ?? "", /350/i, "mesmo tamanho");
});

test("nenhuma loja tem tudo (marca só numa loja): não troca nada nem inventa — cesta segue como está", async (t) => {
  if (!dbOk) return t.skip();
  const leite = await item("leite integral jussara", "carrefour", 1, /Jussara/);
  const bananaOba = await item("banana prata organica tamiso", "oba", 1, /Tamiso/);
  const c = await customerWith([leite, bananaOba]);
  const out = await send(c.phone, "só isso");
  assert.doesNotMatch(out, /Juntei tudo/, out.slice(0, 600));
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: c.userId } });
  const ctx = JSON.parse(convo.context ?? "{}");
  assert.ok(ctx.consolidationTried || ctx.deliveryOrderId, "tentou uma vez e seguiu");
});

test("com o que o cliente pediu na linha ('banana prata'): a variante da outra loja serve — junta numa loja só", async (t) => {
  if (!dbOk) return t.skip();
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const banana = { ...(await item("banana prata organica tamiso", "oba", 1, /Tamiso/)), ask: "banana prata" };
  const c = await customerWith([leite, arroz, banana]);
  const out = await send(c.phone, "só isso");
  assert.match(out, /Juntei tudo na \*Carrefour\*/, out.slice(0, 700));
  assert.match(out, /Banana Prata Carrefour/);
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  assert.deepEqual([...new Set((order.items as { storeKey: string }[]).map((i) => i.storeKey))], ["carrefour"]);
});
