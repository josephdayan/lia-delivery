// Rodada 1 de testes de WhatsApp (09/10), grupo f4 (achados do grupo-d): mensagens seguidas do
// mesmo cliente saem na ORDEM de chegada, e a vitrine recém-enviada não é reenviada inteira.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { asksToSeeChoicesAgain } from "../src/lib/lia-intents";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5504${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
let phoneSeq = 0;
let msgSeq = 0;
let dbOk = false;

type Out = { to: string; kind: string; text: string };
const outbox: Out[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const originals: Record<string, unknown> = {};
for (const name of Object.keys(adapter)) {
  if (!name.startsWith("send") || typeof adapter[name] !== "function") continue;
  originals[name] = adapter[name];
  adapter[name] = async (to: string, first?: unknown) => {
    outbox.push({ to, kind: name, text: typeof first === "string" ? first : JSON.stringify(first ?? "") });
    return { provider: "test", to, messages: [{ id: `wamid.f4_${RUN}_${outbox.length}` }], messageId: `wamid.f4_${RUN}_${outbox.length}` };
  };
}
adapter.markReadWithTyping = async () => undefined;

async function customer() {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  const phone = `${PREFIX}${digits}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: "Avenida Paulista, 1000, Bela Vista, São Paulo - SP" } });
  return phone;
}

const send = (phone: string, text: string) =>
  runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `f4_${RUN}_${++msgSeq}` }));
const outFor = (phone: string, start = 0) => outbox.slice(start).filter((m) => m.to === phone);

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
  for (const [name, fn] of Object.entries(originals)) adapter[name] = fn;
  if (!dbOk) return;
  await wipe();
  await prisma.$disconnect();
});

test("pedido explícito de rever as opções é reconhecido; conversa comum não", () => {
  for (const t of ["mostra as opções de novo", "não apareceram os cards", "quais as opções?", "manda as fotos de novo"]) {
    assert.equal(asksToSeeChoicesAgain(t), true, t);
  }
  for (const t of ["e feijão também", "oi?", "alô, tá aí?", "o primeiro", "pagar"]) assert.equal(asksToSeeChoicesAgain(t), false, t);
});

// Achado 1/2 (grupo-d): "arroz", "feijão", "macarrão" com 1 a 2 s de diferença saíam fora de ordem
// (o lock era polling sem fila: quem acordava primeiro ganhava).
test("mensagens concorrentes do mesmo cliente são processadas na ordem de chegada (FIFO)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "oi");
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  // Um turno "longo" segura a conversa enquanto as mensagens chegam, como uma busca fria.
  await prisma.conversation.update({ where: { id: convo.id }, data: { turnLock: "turno-longo", turnLockAt: new Date() } });
  const items = ["arroz", "feijão", "macarrão", "leite", "café"];
  const start = outbox.length;
  const jobs: Promise<unknown>[] = [];
  for (const item of items) {
    jobs.push(send(phone, item));
    // Espera a mensagem ser gravada antes de mandar a seguinte (ordem de chegada conhecida).
    const count = jobs.length;
    for (let i = 0; i < 100; i++) {
      const n = await prisma.message.count({ where: { conversationId: convo.id, sender: "user", text: { in: items } } });
      if (n >= count) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 90));
  }
  await new Promise((r) => setTimeout(r, 300));
  // Solta como o releaseTurnLock do turno longo (o do "oi"): a marca é a mensagem dele.
  const oi = await prisma.message.findFirstOrThrow({ where: { conversationId: convo.id, sender: "user", text: "oi" } });
  await prisma.conversation.update({ where: { id: convo.id }, data: { turnLock: null, turnLockAt: oi.createdAt } });
  await Promise.all(jobs);
  const text = outFor(phone, start).map((m) => m.text).join("\n");
  const order = items.map((item) => ({ item, at: text.search(new RegExp(item, "i")) }));
  for (const o of order) assert.ok(o.at >= 0, `sem resposta para ${o.item}: ${text.slice(0, 600)}`);
  const seen = [...order].sort((a, b) => a.at - b.at).map((o) => o.item);
  assert.deepEqual(seen, items, `ordem das respostas: ${seen.join(" → ")}`);
  const after = await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } });
  assert.equal(after.turnLock, null, "a trava fica livre no fim");
});

// Achado 1 (carrossel duplicado): "arroz" + "e feijão também" mandavam a vitrine de arroz duas vezes.
test("item novo ou 'oi?' durante a escolha lembra a vitrine em vez de reenviar os cards", async (t) => {
  if (!dbOk) return t.skip();
  const previous = process.env.WHATSAPP_PROVIDER;
  process.env.WHATSAPP_PROVIDER = "meta";
  try {
    const phone = await customer();
    let start = outbox.length;
    await send(phone, "arroz");
    const first = outFor(phone, start).filter((m) => m.kind === "sendDeliveryChoices");
    assert.equal(first.length, 1, `vitrine de arroz: ${JSON.stringify(outFor(phone, start)).slice(0, 400)}`);

    for (const msg of ["e feijão também", "oi?"]) {
      start = outbox.length;
      await send(phone, msg);
      const out = outFor(phone, start);
      assert.equal(out.filter((m) => m.kind === "sendDeliveryChoices" || m.kind === "sendDeliveryCarousel").length, 0, `${msg}: reenviou a vitrine: ${JSON.stringify(out).slice(0, 500)}`);
      assert.match(out.map((m) => m.text).join("\n"), /continuam aí em cima/, msg);
    }

    // Pedido explícito volta a mostrar.
    start = outbox.length;
    await send(phone, "mostra as opções de novo");
    assert.equal(outFor(phone, start).filter((m) => m.kind === "sendDeliveryChoices").length, 1, "pedido explícito reenvia");

    // A escolha continua funcionando.
    start = outbox.length;
    await send(phone, "1");
    assert.match(outFor(phone, start).map((m) => m.text).join("\n"), /arroz/i);
  } finally {
    process.env.WHATSAPP_PROVIDER = previous;
  }
});
