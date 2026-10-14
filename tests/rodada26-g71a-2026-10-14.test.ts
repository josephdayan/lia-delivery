// Rodada 26, grupo B, corretor g71a (14/10): achados A1, A2 e M6 de /mnt/project-files/testes-whatsapp/rodada26/grupo-b.md:
//   A1: "eae, 1 dúzia de ovos e 1 manteiga. quando chega?" — a pergunta de prazo vencia e os itens sumiam (nem pedia cadastro);
//   A2: "quero sabão em pó e amaciante, o que estiver em promoção" virava a resposta de cupom e descartava os itens;
//   M6: "e o pó de fada, ficou de fora?" depois do total virava busca, invalidava o total e poluía os não achados.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  copy: typeof import("../src/lib/lia-copy");
  intents: typeof import("../src/lib/lia-intents");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5526${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];

async function wipe() {
  const users = await m.prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await m.prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await m.prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  m = {
    prisma,
    service: await import("../src/lib/delivery-service"),
    copy: await import("../src/lib/lia-copy"),
    intents: await import("../src/lib/lia-intents")
  };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string, ...rest: unknown[]) => {
      outbox.push({ to, kind: key, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
      return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
    };
  }
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
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g71a_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function ctxOf(phone: string) {
  const convo = await m.prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}") as import("../src/lib/conversation-types").DeliveryContext;
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return phone;
}

// ---------------- A1: pedido + "quando chega?" na mesma mensagem ----------------

test("A1: pergunta de prazo como frase própria do lado do pedido não apaga os itens", () => {
  const { detectIntent, splitEtaAsk } = m.intents;
  assert.equal(detectIntent("eae, 1 dúzia de ovos e 1 manteiga. quando chega?").kind, "free_text");
  assert.equal(detectIntent("arroz e feijão, qual o prazo?").kind, "free_text");
  const rest = splitEtaAsk("eae, 1 dúzia de ovos e 1 manteiga. quando chega?") ?? "";
  assert.match(rest, /ovos/);
  assert.match(rest, /manteiga/);
  assert.doesNotMatch(rest, /quando chega/);
  // Sem item, segue status/prazo como antes.
  assert.equal(detectIntent("quando chega?").kind, "status");
  assert.equal(splitEtaAsk("quando chega?"), null);
  assert.equal(detectIntent("e o meu pedido de arroz, quando chega?").kind, "status");
  assert.equal(splitEtaAsk("ok, quando chega?"), null);
});

test("A1: conversa — telefone novo anota ovos e manteiga, pede o cadastro e diz que o prazo vem no total", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "eae, 1 dúzia de ovos e 1 manteiga. quando chega?");
  assert.ok(out.includes(m.copy.etaWithTotalNote()), out);
  assert.match(out, /ovos/, out);
  assert.match(out, /manteiga/, out);
  assert.match(out, /cadastro|endereço/i, out);
  const ctx = await ctxOf(phone);
  assert.match(ctx.pendingRequest ?? "", /ovos/);
  assert.match(ctx.pendingRequest ?? "", /manteiga/);
  assert.doesNotMatch(ctx.pendingRequest ?? "", /quando|chega/);
});

// ---------------- A2: pedido + "o que estiver em promoção" ----------------

test("A2: promoção dita junto dos itens não vira resposta de cupom; vale o mais barato de cada", () => {
  const { detectIntent, splitPromoAsk, wantsCheapestEach } = m.intents;
  const said = "quero sabão em pó e amaciante, o que estiver em promoção";
  assert.equal(detectIntent(said).kind, "free_text");
  assert.match(splitPromoAsk(said) ?? "", /sabão em pó e amaciante/);
  assert.equal(wantsCheapestEach(said), true);
  // Sem item, a resposta honesta de cupom/promoção continua.
  assert.equal(detectIntent("tem alguma coisa em promoção hoje?").kind, "coupon_promo");
  assert.equal(detectIntent("tem cupom de desconto?").kind, "coupon_promo");
  assert.equal(splitPromoAsk("tem alguma coisa em promoção hoje?"), null);
});

test("A2: conversa — cliente cadastrado recebe a linha de promoção e os itens são buscados", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({});
  const out = await send(phone, "quero sabão em pó e amaciante, o que estiver em promoção");
  assert.ok(out.startsWith(m.copy.promoCheapestNote()), out);
  assert.ok(!out.includes(m.copy.couponPromoAnswer()), out);
  const ctx = await ctxOf(phone);
  const seen = [...(ctx.basket ?? []).map((b) => `${b.ask ?? ""} ${b.name}`), ...(ctx.pending ?? []).map((p) => p.query), ...(ctx.listMisses ?? []).map((x) => x.query)].join(" | ");
  assert.match(seen, /sab[aã]o|lava/i, seen);
  assert.match(seen, /amaciante/i, seen);
  assert.doesNotMatch(seen, /promo/i, seen);
  const bare = await send(phone, "tem alguma coisa em promoção hoje?");
  assert.ok(bare.includes(m.copy.couponPromoAnswer()), bare);
});

// ---------------- M6: pergunta sobre item já dado como não achado ----------------

test("M6: 'e o pó de fada, ficou de fora?' cita o item", () => {
  const { parseMissStatusAsk } = m.intents;
  assert.equal(parseMissStatusAsk("e o pó de fada, ficou de fora?"), "po de fada");
  assert.equal(parseMissStatusAsk("o unicórnio não veio?"), "unicornio");
  assert.equal(parseMissStatusAsk("cadê o pó de fada?"), "po de fada");
  assert.equal(parseMissStatusAsk("ficou de fora alguma coisa do pedido?"), null);
  assert.equal(parseMissStatusAsk("quero 2 arroz e feijão"), null);
});

test("M6: conversa — com o total na mesa, confirma que ficou de fora sem mexer na cesta nem nos não achados", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [{ sku: "mambo-813", name: "Arroz Polido Longo Fino Tipo 1 Camil 5kg", qty: 1, unitPrice: 31.49, lineTotal: 31.49, storeKey: "mambo", storeLabel: "Mambo", ask: "arroz 5kg" }];
  const listMisses = [{ query: "pó de fada", qty: 1, reason: "not_found", at: Date.now() }];
  const phone = await customerWith({ basket, listMisses }, "awaiting_quote_confirmation");
  const out = await send(phone, "e o pó de fada, ficou de fora?");
  assert.equal(out, m.copy.missStillOut("pó de fada", true));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.step, "awaiting_quote_confirmation");
  assert.deepEqual(ctx.basket?.map((b) => b.sku), ["mambo-813"]);
  assert.deepEqual(ctx.listMisses?.map((x) => x.query), ["pó de fada"]);
});
