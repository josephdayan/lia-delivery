// Fallback MERCADO LIVRE da troca de pedido mínimo (dono, 25/08): item preso no mínimo
// do Carrefour sem equivalente em vitrine local sem mínimo → o ML resolve (cada anúncio
// é um checkout, mínimo zero). Farmácias ficam DESLIGADAS (default do load-env) pra
// forçar o fallback; o ML responde do CACHE semeado no banco — zero rede, zero actor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

let prisma: typeof import("../src/lib/prisma").prisma;
let handleDeliveryMessage: typeof import("../src/lib/delivery-service").handleDeliveryMessage;
let queryTokens: typeof import("../src/lib/stores/types").queryTokens;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5503${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let phoneSeq = 0;
let msgSeq = 0;
let dbOk = false;
const CACHE_KEYS: string[] = [];

const outbox: { to: string; text: string }[] = [];

function newPhone(): string {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  return `${PREFIX}${digits}`;
}

function driver(phone: string) {
  async function send(text: string): Promise<string> {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `msml_${RUN}_${++msgSeq}` });
    return outbox
      .slice(start)
      .filter((m) => m.to === phone)
      .map((m) => m.text)
      .join("\n---\n");
  }
  return { send };
}

before(async () => {
  await import("./helpers/load-env");
  process.env.LIA_MANUAL_CONCIERGE = "true";
  process.env.LIA_ENABLE_MERCADOLIVRE = "true";
  process.env.LIA_LONGTAIL_OPTIN = "false"; // este teste cobre o resgate AUTOMÁTICO
  // mercadoLivreEnabled exige o token do actor mesmo quando o cache resolve tudo; um
  // valor fake basta — o teste nunca vai à rede (cache semeado + frete grátis).
  process.env.APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "apify_test_token";
  // Frete por anúncio fora: o anúncio semeado declara frete grátis e fecha sem consulta.
  process.env.LIA_ML_LIVE_FREIGHT_OFF = "true";
  ({ prisma } = await import("../src/lib/prisma"));
  ({ queryTokens } = await import("../src/lib/stores/types"));
  const adapters = await import("../src/lib/adapters/whatsapp");
  const service = await import("../src/lib/delivery-service");
  handleDeliveryMessage = service.handleDeliveryMessage;
  (adapters.whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
    outbox.push({ to, text });
    return { provider: "test", to, text };
  };
  (adapters.whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
    outbox.push({ to, text });
    return { provider: "test", to, text };
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
    dbOk = false;
    console.warn("⚠️  Banco indisponível — teste de troca via ML será pulado.");
    return;
  }
  // Cache do ML pro nome do item preso (as duas larguras de query que o swap tenta).
  const stuckName = "Creme Dental Familiar Colgate Máxima Proteção Anticáries Sabor Menta Refrescante 120g";
  const tokens = queryTokens(stuckName);
  const mlItem = {
    sku: "ml-MLB999000111",
    name: "Creme Dental Familiar Colgate Máxima Proteção Anticáries 120g",
    unitPrice: 7.9,
    productUrl: "https://produto.mercadolivre.com.br/MLB-999000111-creme-dental-colgate",
    imageUrl: "https://http2.mlstatic.com/foto.jpg",
    freeShipping: true,
    mlPosition: 1
  };
  for (const take of [4, 3]) {
    const q = tokens.slice(0, take).join(" ").trim().toLowerCase().replace(/\s+/g, " ");
    if (!q) continue;
    const key = `ml:v2:${q}`;
    CACHE_KEYS.push(key);
    await prisma.searchCache.upsert({
      where: { queryKey: key },
      create: { queryKey: key, query: q, source: "mercado_livre", items: [mlItem] as unknown as object },
      update: { items: [mlItem] as unknown as object }
    });
  }
});

after(async () => {
  if (!dbOk) return;
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
    await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (CACHE_KEYS.length) await prisma.searchCache.deleteMany({ where: { queryKey: { in: CACHE_KEYS } } });
  await prisma.$disconnect();
});

test("mínimo sem alternativa local: o MERCADO LIVRE entra na troca e fecha na hora (25/08)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  const c = { userId: user.id, ...driver(phone) };
  await c.send("quero creme dental colgate máxima proteção do carrefour");
  const afterChoice = await c.send("1");
  if (/quantas unidades/i.test(afterChoice)) await c.send("1");
  const wall = await c.send("pagar");
  assert.match(wall, /pedido mínimo/i, wall.slice(0, 300));
  assert.match(wall, /outra loja SEM pedido mínimo|Trocar de loja/i, `sem oferta (ML deveria cobrir): ${wall.slice(0, 400)}`);
  const done = await c.send("minswap:yes");
  assert.match(done, /Troquei de loja/i, done.slice(0, 300));
  assert.match(done, /Como prefere pagar/i, `não fechou: ${done.slice(0, 400)}`);
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const items = (order!.items as Array<{ storeKey?: string; sku?: string }>) ?? [];
  assert.ok(items.length > 0, "pedido criado");
  assert.ok(items.every((i) => i.storeKey === "mercadolivre"), `itens deveriam ser do ML: ${JSON.stringify(items.map((i) => i.sku))}`);
  // Anúncio com frete grátis declarado: entrega sai R$0 (nunca tarifa fantasma).
  assert.equal(order!.deliveryFee, 0, `frete deveria ser grátis: ${order!.deliveryFee}`);
});
