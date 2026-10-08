// Modelo de preço "service_fee" (dono, 08/10/2026): o cliente vê o PREÇO DA LOJA em cada item, a
// margem da Lia sai na linha "Taxa de serviço da Lia", a compra na loja sai no CPF do cliente e a
// nota fiscal no nome dele (como o remédio isento já fazia desde 29/09). LIA_PRICING_MODE=markup
// volta ao modelo antigo. A margem em R$ é a mesma nos dois modelos.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter, type WhatsAppFlowInput } from "../src/lib/adapters/whatsapp";
import { __setRerankForTests, type RerankCandidate, type RerankResult } from "../src/lib/adapters/ai";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { displayPrice, markedPrice, pricingMode, serviceFeeForItems, serviceLineForItems } from "../src/lib/pricing";
import { display } from "../src/lib/conversation-types";
import { customerBuyerFor } from "../src/lib/purchase-worker";
import * as copy from "../src/lib/lia-copy";

process.env.LIA_PRICING_MODE = "service_fee";

test("preço: no modelo service_fee o item sai pelo preço da loja e a margem vira a linha de taxa", () => {
  assert.equal(pricingMode(), "service_fee");
  assert.equal(displayPrice(100), 100);
  assert.equal(display(100), 100);
  assert.equal(markedPrice(100), 110, "a margem continua existindo");
  const items = [{ unitPrice: 100, qty: 1 }, { unitPrice: 4.39, qty: 2 }];
  assert.equal(serviceFeeForItems(items), 10.88, "mesma margem do modelo antigo (10% até R$200)");
  assert.equal(serviceLineForItems(items), 10.88, "a linha da cotação mostra a margem inteira");
  // Remédio isento continua sem margem e com a taxa fixa, somada à linha.
  assert.equal(serviceLineForItems([{ unitPrice: 10, qty: 1, medicine: "mip" }, { unitPrice: 20, qty: 1 }]), 6.9);
});

test("preço: LIA_PRICING_MODE=markup volta ao modelo antigo (margem embutida, linha só do remédio)", () => {
  process.env.LIA_PRICING_MODE = "markup";
  try {
    assert.equal(displayPrice(100), 110);
    assert.equal(serviceFeeForItems([{ unitPrice: 100, qty: 1 }]), 10);
    assert.equal(serviceLineForItems([{ unitPrice: 100, qty: 1 }]), 0);
    assert.equal(serviceLineForItems([{ unitPrice: 10, qty: 1, medicine: "mip" }]), 4.9);
  } finally {
    process.env.LIA_PRICING_MODE = "service_fee";
  }
});

test("textos: taxa de serviço declarada e nota fiscal no nome do cliente", () => {
  assert.match(copy.serviceAnswer("service_fee", "SP"), /taxa de serviço/i);
  assert.match(copy.serviceAnswer("service_fee", "SP"), /preço da loja/);
  assert.doesNotMatch(copy.serviceAnswer("service_fee", "SP"), /embutido/);
  assert.match(copy.fiscalAnswer("nf"), /no seu nome e CPF/);
  assert.match(copy.fiscalAnswer("nf"), /Sem CPF cadastrado, ela sai no nome da Lia Delivery/);
  assert.match(copy.whyCpf(), /nota fiscal da loja sai no seu CPF/);
  process.env.LIA_PRICING_MODE = "markup";
  try {
    assert.match(copy.serviceAnswer("service_fee", "SP"), /embutido no preço/);
    assert.match(copy.fiscalAnswer("nf"), /nome da \*Lia Delivery\*/);
  } finally {
    process.env.LIA_PRICING_MODE = "service_fee";
  }
});

test("comprador: com CPF no pedido, TODA loja compra no nome do cliente (modelo markup: só a do remédio)", () => {
  const job = {
    deliveryOrder: { buyerDocument: "52998224725", buyerName: "Maria da Silva", items: [{ sku: "mambo-1" }, { sku: "dsp-mip-9", medicine: "mip" }] },
    items: [{ requestedSku: "mambo-1" }]
  };
  assert.deepEqual(customerBuyerFor(job), { document: "52998224725", name: "Maria da Silva" });
  assert.equal(customerBuyerFor({ ...job, deliveryOrder: { ...job.deliveryOrder, buyerDocument: null } }), null, "sem CPF = CNPJ da Lia");
  process.env.LIA_PRICING_MODE = "markup";
  try {
    assert.equal(customerBuyerFor(job), null, "modelo antigo: loja sem remédio compra no CNPJ");
    assert.deepEqual(customerBuyerFor({ ...job, items: [{ requestedSku: "dsp-mip-9" }] }), { document: "52998224725", name: "Maria da Silva" });
  } finally {
    process.env.LIA_PRICING_MODE = "service_fee";
  }
});

// ---------- ponta a ponta (banco local): cotação com a linha de taxa e pedido com o CPF ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5572${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
adapter.sendFlowMessage = async (_to: string, _input: WhatsAppFlowInput) => ({ messageId: "flow" });
adapter.sendChoiceFollowUp = async (to: string, body: string) => {
  outbox.push({ to, text: body });
  return { messageId: "followup" };
};
adapter.sendDeliveryCarousel = async () => null;
adapter.sendDeliveryChoices = async (to: string, choices: { name: string; displayPrice: number }[]) => {
  outbox.push({ to, text: choices.map((c, i) => `*${i + 1})* ${c.name} — R$ ${c.displayPrice.toFixed(2)}`).join("\n") });
  return { messageId: "choices" };
};
const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) return new Response("", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

function installJudge() {
  __setRerankForTests(async (_message, lines): Promise<RerankResult> => ({
    lines: lines.map((line) => {
      const q = line.query.toLowerCase();
      const ok = (c: RerankCandidate) => {
        if (/leite/.test(q)) return /\bleite\b/i.test(c.name) && !/aveia|coco|chocolate|condensado|em p[oó]/i.test(c.name);
        if (/arroz/.test(q)) return /\barroz\b/i.test(c.name);
        if (/feij[aã]o/.test(q)) return /feij[aã]o/i.test(c.name);
        return false;
      };
      return { skus: line.candidates.filter(ok).map((c) => c.sku), exigencias: [], proximos: [] };
    })
  }));
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
  process.env.LIA_PRICING_MODE = "service_fee";
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.LIA_LIST_FLOW = "true";
  process.env.LIA_FLOW_LIST_ID = "999000222";
  installJudge();
});
afterEach(() => {
  process.env.WHATSAPP_PROVIDER = "mock";
  delete process.env.LIA_LIST_FLOW;
  delete process.env.LIA_FLOW_LIST_ID;
  __setRerankForTests(null);
});
after(async () => {
  if (dbOk) await wipe();
  global.fetch = realFetch;
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customer(withCpf: boolean): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({
    data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", ...(withCpf ? { cpf: "52998224725", cpfName: "Maria da Silva" } : {}) }
  });
  return phone;
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `sfm_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}

test("cotação: produtos pelo preço da loja + 'Taxa de serviço da Lia' + total igual ao do modelo antigo; pedido com o CPF do cliente", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer(true);
  await send(phone, "2 leites, arroz e feijão");
  const out = await send(phone, "pagar");
  assert.match(out, /Taxa de serviço da Lia: R\$/, out.slice(0, 600));
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { user: { phone } }, orderBy: { createdAt: "desc" } });
  const items = order.items as Array<{ unitPrice: number; qty: number }>;
  const storeSubtotal = Math.round(items.reduce((s, i) => s + i.unitPrice * i.qty, 0) * 100) / 100;
  assert.equal(order.itemsSubtotal, storeSubtotal);
  assert.equal(order.serviceFee, serviceFeeForItems(items), "margem = as mesmas faixas de sempre");
  assert.ok(order.serviceFee > 0);
  assert.equal(Math.round((order.itemsSubtotal + order.serviceFee + order.deliveryFee) * 100) / 100, order.total);
  assert.match(out, new RegExp(`Produtos: R\\$ ${storeSubtotal.toFixed(2).replace(".", ",")}`), "o resumo mostra o subtotal da loja");
  assert.equal(order.buyerDocument, "52998224725", "a compra sai no CPF do cliente");
  assert.equal(order.buyerName, "Maria da Silva");
});

test("sem CPF cadastrado: a cotação sai igual e a compra fica no CNPJ da Lia (nada trava)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer(false);
  await send(phone, "2 leites, arroz e feijão");
  const out = await send(phone, "pagar");
  assert.match(out, /Taxa de serviço da Lia: R\$/, out.slice(0, 600));
  assert.doesNotMatch(out, /CPF/, "não pede CPF para compra comum");
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { user: { phone } }, orderBy: { createdAt: "desc" } });
  assert.equal(order.buyerDocument, null);
});
