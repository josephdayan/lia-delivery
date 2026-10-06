// Testers reais em 06/10/2026 (dono compartilhou a Lia com ~10 pessoas). A vitrine:
//   1. Opção que a loja não confirmou para o CEP ("Pilha AAA" da Casa & Vídeo, fita isolante
//      da Obramax) entrava na vitrine; no "pagar" a cotação instantânea abortava
//      ("sem confirmação ao vivo") e, sem operador, o cliente caía num beco.
//   2. O frete da vitrine vinha de UMA simulação com todos os candidatos juntos — o VTEX
//      rateia o frete entre os itens (Drogal: vitrine R$2,03, total R$4,90).
// Banco local + WhatsApp mock + simulação VTEX mockada (fetch). Dados sintéticos.
import "./helpers/load-env";

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { liveItemAvailability } from "../src/lib/live-freight";
import { buyableWithoutOperator, liveConfirmationRequired } from "../src/lib/live-availability";

// As lojas do caso real ficam ligadas só neste arquivo (o registry lê as flags na importação,
// por isso o cérebro é importado DEPOIS, dentro do before).
process.env.LIA_ENABLE_DROGAL = "true";
process.env.LIA_ENABLE_CASAEVIDEO = "true";
process.env.LIA_MANUAL_CONCIERGE = "true";

const realFetch = globalThis.fetch;
const STRICT_ENV = { LIA_LIVE_FREIGHT_OFF: "false", LIA_CHARGE_ONLY_VERIFIED: "true", LIA_OPERATOR_QUOTE: "false" } as const;
const savedEnv: Record<string, string | undefined> = {};
function strictMode() {
  for (const [k, v] of Object.entries(STRICT_ENV)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Simulação VTEX com o comportamento real medido em 06/10: o frete do carrinho (R$4,90) é
// RATEADO entre os itens da mesma simulação. `down` = lojas que não respondem (503).
let simulationCalls: string[] = [];
function mockVtex(opts: { down?: string[]; freightCents?: number } = {}) {
  simulationCalls = [];
  const freight = opts.freightCents ?? 490;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("orderForms/simulation")) return realFetch(url as string, init);
    const host = new URL(u).host;
    simulationCalls.push(host);
    if ((opts.down ?? []).some((d) => host.includes(d))) return new Response("blocked", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    const n = body.items.length;
    // Rateio do VTEX: a soma das linhas é o frete do carrinho.
    const shares = body.items.map((_, i) => (i === 0 ? freight - Math.floor(freight / n) * (n - 1) : Math.floor(freight / n)));
    return new Response(
      JSON.stringify({
        items: body.items.map((i) => ({ id: i.id, quantity: i.quantity, sellingPrice: 1115, availability: "available" })),
        logisticsInfo: body.items.map((_, itemIndex) => ({ itemIndex, slas: [{ name: "Econômica", price: shares[itemIndex], shippingEstimate: "3h" }] }))
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

// ---------------- frete da vitrine = frete da cotação ----------------

test("06/10: frete por item vem de simulação SOZINHA (o VTEX rateia o frete entre os itens)", async () => {
  strictMode();
  mockVtex();
  const result = await liveItemAvailability("drogal", ["drogal-15085", "drogal-202", "drogal-190"], "01310-100");
  assert.ok(result);
  for (const sku of ["drogal-15085", "drogal-202", "drogal-190"]) {
    assert.equal(result!.get(sku)?.fee, 4.9, `${sku}: o card tem que mostrar o frete que a cotação cobra por 1 unidade`);
  }
  assert.equal(simulationCalls.length, 3, "uma simulação por sku");
});

test("06/10: uma loja que não responde não derruba as respostas das outras simulações", async () => {
  strictMode();
  let n = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    n++;
    if (n === 1) return new Response("x", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    return new Response(JSON.stringify({ items: body.items.map((i) => ({ ...i, availability: "available" })), logisticsInfo: [{ itemIndex: 0, slas: [{ name: "N", price: 0, shippingEstimate: "1bd" }] }] }), { status: 200 });
  }) as typeof fetch;
  const result = await liveItemAvailability("drogal", ["drogal-1", "drogal-2"], "01310-100");
  assert.equal(result?.has("drogal-1"), false, "a que falhou fica desconhecida");
  assert.equal(result?.get("drogal-2")?.fee, 0);
});

// ---------------- só entra na vitrine o que a loja confirmou ----------------

test("06/10: regra de compra sozinha — sem operador e cobrando só o confirmado, vitrine exige confirmação ao vivo", () => {
  strictMode();
  assert.equal(liveConfirmationRequired(), true);
  assert.equal(buyableWithoutOperator("casaevideo", undefined), false, "loja não respondeu = não confirmado");
  assert.equal(buyableWithoutOperator("drogal", { sku: "drogal-1", available: true, fee: 4.9 }), true);
  assert.equal(buyableWithoutOperator("mercadolivre", undefined), true, "Mercado Livre segue como antes (frete do anúncio, compra do dono)");
  process.env.LIA_OPERATOR_QUOTE = "true";
  assert.equal(liveConfirmationRequired(), false, "com operador, a cotação manual cobre o não confirmado");
  process.env.LIA_OPERATOR_QUOTE = "false";
  process.env.LIA_CHARGE_ONLY_VERIFIED = "false";
  assert.equal(liveConfirmationRequired(), false, "aceitando a tabela, a cotação não aborta");
});

// ---------------- E2E (banco local) ----------------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5501${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}6`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
let prisma: typeof import("../src/lib/prisma").prisma;
let handleDeliveryMessage: typeof import("../src/lib/delivery-service").handleDeliveryMessage;

async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(3, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS } });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, step: "collecting", storeKey: "concierge" })
    }
  });
  const send = async (text: string) => {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `vitrine06_${RUN}_${++seq}` });
    return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  };
  return { phone, userId: user.id, send };
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
  ({ prisma } = await import("../src/lib/prisma"));
  ({ handleDeliveryMessage } = await import("../src/lib/delivery-service"));
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  (whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
    outbox.push({ to, text });
    return { provider: "test", to, text };
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  if (!dbOk) return;
  await wipe();
  await prisma.$disconnect();
});

test("06/10: 'pilha aaa' — Casa & Vídeo sem confirmação sai da vitrine; a Drogal fecha no 'pagar' com o frete da vitrine", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex({ down: ["casaevideo"] });
  const c = await customer();
  const vitrine = await c.send("pilha aaa");
  assert.match(vitrine, /Rayovac|\*1\)\*/, vitrine);
  assert.doesNotMatch(vitrine, /Alfacell|Maxprint|Casa & Vídeo/, `opção não confirmada pela loja não pode aparecer:\n${vitrine}`);
  const quote = await c.send("1");
  const paid = quote + (await c.send("pagar"));
  const orders = await prisma.deliveryOrder.findMany({ where: { userId: c.userId } });
  assert.equal(orders.length, 1, paid.slice(0, 400));
  assert.doesNotMatch(orders[0].notes ?? "", /abortada|Sem cotação automática/, orders[0].notes ?? "");
  assert.notEqual(orders[0].status, "canceled");
  assert.equal(orders[0].deliveryFee, 4.9, "o frete cobrado é o mesmo do card");
});

test("06/10: nada confirmado → 'não consigo comprar agora', nunca um beco no 'pagar'", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex({ down: ["casaevideo", "drogal"] });
  const c = await customer();
  const reply = await c.send("pilha aaa");
  assert.match(reply, /Não consigo comprar \*pilha aaa\* agora: nenhuma loja confirmou entrega no seu endereço\./, reply);
  assert.doesNotMatch(reply, /Responde \*1\*/, "sem opções que não fecham");
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone: c.phone } } });
  assert.ok(!JSON.parse(convo.context ?? "{}").pending?.length, "nenhuma escolha aberta");
});
