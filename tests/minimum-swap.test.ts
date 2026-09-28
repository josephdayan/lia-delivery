// E2E do 2º testador externo (24/08): a pasta de R$6 presa no mínimo de R$30 do
// Carrefour. A saída é a OFERTA DE TROCA pra loja sem mínimo — que precisa da Pague
// Menos LIGADA, então este arquivo religa a vitrine ANTES de importar o cérebro
// (o registry de lojas é montado no import; o load-env desliga as farmácias).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// O tsx IÇA os requires: um `import` estático do cérebro rodaria ANTES de qualquer
// flip de env e o registry nasceria sem a Pague Menos. Por isso o bootstrap é 100%
// dinâmico, dentro do before(): load-env primeiro (pina o mundo dos testes), flip da
// Pague Menos depois, e SÓ ENTÃO o cérebro é importado.
let prisma: typeof import("../src/lib/prisma").prisma;
let handleDeliveryMessage: typeof import("../src/lib/delivery-service").handleDeliveryMessage;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5502${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let phoneSeq = 0;
let msgSeq = 0;
let dbOk = false;

const outbox: { to: string; text: string }[] = [];

function newPhone(): string {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  return `${PREFIX}${digits}`;
}

function driver(phone: string) {
  async function send(text: string): Promise<string> {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `ms_${RUN}_${++msgSeq}` });
    return outbox
      .slice(start)
      .filter((m) => m.to === phone)
      .map((m) => m.text)
      .join("\n---\n");
  }
  return { send };
}

async function returningCustomer() {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  return { phone, userId: user.id, ...driver(phone) };
}

async function wipeTestData() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  await import("./helpers/load-env");
  process.env.LIA_ENABLE_PAGUEMENOS = "true";
  process.env.LIA_MANUAL_CONCIERGE = "true";
  ({ prisma } = await import("../src/lib/prisma"));
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
    await wipeTestData();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
    dbOk = false;
    console.warn("⚠️  Banco indisponível — testes de troca de mínimo serão pulados.");
  }
});

after(async () => {
  if (!dbOk) return;
  await wipeTestData();
  await prisma.$disconnect();
});

// Os preços se atualizam toda semana (refresh 27/09): a opção do Carrefour nem sempre é a 1ª.
// O teste é sobre o MÍNIMO do Carrefour, então escolhe a opção dele pela loja no contexto.
async function carrefourPick(userId: string): Promise<string> {
  const convo = await prisma.conversation.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  const ctx = JSON.parse(convo?.context ?? "{}") as { pending?: Array<{ options?: Array<{ storeKey?: string }> }> };
  const options = ctx.pending?.[0]?.options ?? [];
  const idx = options.findIndex((o) => o.storeKey === "carrefour");
  assert.ok(idx >= 0, `nenhuma opção do Carrefour entre ${options.map((o) => o.storeKey).join(",")}`);
  return String(idx + 1);
}

test("pedido mínimo oferece TROCA DE LOJA e o aceite fecha na hora (2º testador, 24/08)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.send("quero creme dental colgate máxima proteção do carrefour");
  const afterChoice = await c.send(await carrefourPick(c.userId));
  if (/quantas unidades/i.test(afterChoice)) await c.send("1");
  const wall = await c.send("pagar");
  assert.match(wall, /pedido mínimo/i, wall.slice(0, 300));
  assert.match(wall, /outra loja SEM pedido mínimo|Trocar de loja/i, `sem oferta de troca: ${wall.slice(0, 400)}`);
  // 27/08 S1/S2/S5: a troca nunca é silenciosa — a oferta nomeia cada antigo → novo.
  assert.match(wall, /→/, `oferta sem os pares antigo→novo: ${wall.slice(0, 400)}`);
  // "quanto falta?" responde o mínimo — nunca vira busca (o testador caiu no beco).
  const gap = await c.send("quanto falta?");
  assert.match(gap, /faltam/i, gap.slice(0, 300));
  assert.doesNotMatch(gap, /não consigo trazer|Opções de \*quanto/i);
  // Aceite: troca pra loja sem mínimo e fecha com total NA HORA.
  const done = await c.send("minswap:yes");
  assert.match(done, /Troquei de loja/i, done.slice(0, 300));
  assert.match(done, /→/, `aceite sem os pares antigo→novo: ${done.slice(0, 400)}`);
  assert.match(done, /Preço garantido|Como prefere pagar/i, `não fechou: ${done.slice(0, 400)}`);
  // A cesta virou PEDIDO no fechamento: a prova da troca mora nos itens do pedido.
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const items = (order!.items as Array<{ storeKey?: string }>) ?? [];
  assert.ok(items.length > 0, "pedido criado com itens");
  assert.ok(items.every((i) => i.storeKey !== "carrefour"), `os itens saíram do Carrefour: ${JSON.stringify(items)}`);
});

test("'Deixar como está' (minswap:no) mantém a cesta intacta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.send("quero creme dental colgate máxima proteção do carrefour");
  const afterChoice = await c.send(await carrefourPick(c.userId));
  if (/quantas unidades/i.test(afterChoice)) await c.send("1");
  await c.send("pagar");
  const declined = await c.send("minswap:no");
  assert.match(declined, /pedido mínimo/i);
  const convo = await prisma.conversation.findFirst({ where: { userId: c.userId } });
  const basket = JSON.parse(convo!.context ?? "{}").basket as Array<{ name: string }>;
  assert.equal(basket.length, 1, "a cesta continua intacta");
});
