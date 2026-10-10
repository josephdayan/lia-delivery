// Rodada 15, grupo G43 (10/10): achados de orçamento/prazo de /mnt/project-files/testes-whatsapp/rodada15 (grupo A: R14-5,
// R14-6, R14-8, R14a-1; grupo B: jornadas 302, 306 e 308). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage):
//   1. (R15a-4 / R15-6) "até N reais", "no máximo N", "não passo de 40" no fim de uma lista de 2 itens, "uns 30 reais no
//      máximo" e "…castanha de caju. no máximo 200 reais" eram ignorados (sem 💰, sem aviso no resumo);
//   2. (R15-6) "preciso hj ainda" não era prazo de hoje (306);
//   3. (R15a-5 / R15-7) o card da Casa Santa Luzia dizia "4 dias úteis" (entrega Econômica) e o fechamento "confirmou 1 dia
//      útil" (Expressa, centavos a mais); "o mais barato" pra "hoje", sem nada que chegue, pegava o de 4 dias;
//   4. (R15a-6) lista dita antes do cadastro + "hoje" perdia o modo do dia depois do cadastro;
//   5. (R15a-7) cesta em 3 entregas com 8 dias úteis saía sem aviso de qual loja segura o pedido.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.LIA_ENABLE_AMERICANAS = "true";
process.env.LIA_ENABLE_MAMBO = "true";
process.env.LIA_ENABLE_SANTALUZIA = "true";
process.env.LIA_ENABLE_DROGARIASPACHECO = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  intents: typeof import("../src/lib/lia-intents");
  copy: typeof import("../src/lib/lia-copy");
  setPreflight: typeof import("../src/lib/live-freight").__setPreflightForTests;
  clearLive: typeof import("../src/lib/live-availability").__clearLiveCheckCacheForTests;
  presignup: typeof import("../src/lib/dialogue/presignup");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5543${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const realFetch = globalThis.fetch;
const STRICT_ENV = { LIA_LIVE_FREIGHT_OFF: "false", LIA_CHARGE_ONLY_VERIFIED: "true", LIA_OPERATOR_QUOTE: "false" } as const;
const savedEnv: Record<string, string | undefined> = {};
function strictMode() {
  for (const [k, v] of Object.entries(STRICT_ENV)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}
type Sla = { id: string; price: number; shippingEstimate: string };
// Simulação VTEX: cada linha recebe as SLAs que `slasFor(domínio)` devolve.
function mockVtex(slasFor: (url: string) => Sla[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/viacep\.com\.br/.test(url)) return new Response(JSON.stringify({ cep: "01310-100", logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
    if (!url.includes("orderForms/simulation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    return new Response(
      JSON.stringify({
        items: body.items.map((i) => ({ id: i.id, quantity: i.quantity, sellingPrice: 1000, availability: "available" })),
        logisticsInfo: body.items.map((_i, itemIndex) => ({ itemIndex, slas: slasFor(url).map((s) => ({ ...s, name: s.id })) }))
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

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
  const freight = await import("../src/lib/live-freight");
  const live = await import("../src/lib/live-availability");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  m = {
    prisma,
    service: await import("../src/lib/delivery-service"),
    intents: await import("../src/lib/lia-intents"),
    copy: await import("../src/lib/lia-copy"),
    setPreflight: freight.__setPreflightForTests,
    clearLive: live.__clearLiveCheckCacheForTests,
    presignup: await import("../src/lib/dialogue/presignup")
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
beforeEach(() => {
  m.setPreflight(async () => null);
  m.presignup.__setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  m.clearLive();
  m.presignup.__setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
after(async () => {
  m.setPreflight(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g43_${RUN}_${++seq}` }));
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
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, extra: Record<string, unknown> = {}) =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...extra });
const spToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

// ---------------- 1. R15a-4 / R15-6: orçamento no fim de lista curta ----------------

test("R15a-4/R15-6: teto em oração própria no fim de lista de 2+ itens é do pedido; colado no item segue do item", () => {
  const order: Array<[string, number, string]> = [
    ["quero ovos e leite, até 20 reais", 20, "quero ovos e leite"],
    ["ovos e leite, até 20 reais", 20, "ovos e leite"],
    ["quero pão e café, até 30 reais", 30, "quero pão e café"],
    ["quero ovos e leite, no máximo 100 reais", 100, "quero ovos e leite"],
    ["quero ovos e leite, no máximo uns 100 reais", 100, "quero ovos e leite"],
    ["ovos e leite, no máximo uns 20 reais", 20, "ovos e leite"],
    ["preciso de ovos e leite, não passo de 40 reais", 40, "preciso de ovos e leite"],
    ["quero uma pizza congelada, um refrigerante 2L e um sorvete, uns 30 reais no máximo", 30, "quero uma pizza congelada, um refrigerante 2L e um sorvete"],
    ["peito de frango, batata doce, whey, aveia e castanha de caju. no máximo 200 reais", 200, "peito de frango, batata doce, whey, aveia e castanha de caju"]
  ];
  for (const [text, cap, rest] of order) {
    const found = m.intents.parseOrderBudget(text);
    assert.equal(found?.cap, cap, text);
    assert.equal(found?.rest, rest, text);
  }
  // Teto do item (sem vírgula, um item só, valor por item) continua fora do orçamento do pedido.
  for (const text of ["arroz e um feijão até 20 reais", "arroz, feijão e vinho até 40 reais", "2 vinhos até 40", "whey, banana e aveia, uns 70 reais cada", "quero uma coca cola, até uns 8 reais", "quero um vinho, até 40 reais"]) {
    assert.equal(m.intents.parseOrderBudget(text), null, text);
  }
});

test("R15a-4: antes do cadastro, 'quero ovos e leite, até 20 reais' anota o 💰; depois do cadastro guarda o teto do pedido", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "quero ovos e leite, até 20 reais");
  assert.match(out, /💰 Até \*R\$ 20,00\*/, out.slice(0, 600));
  assert.match(out, /1x ovos[\s\S]*1x leite/, out.slice(0, 600));
  assert.equal((await ctxOf(phone)).orderBudget?.cap, 20);
  const after = await customerWith({});
  await send(after, "preciso de ovos e leite, não passo de 40 reais");
  assert.equal((await ctxOf(after)).orderBudget?.cap, 40);
});

// ---------------- 2. R15-6: "hj ainda" ----------------

test("R15-6 (306): 'preciso hj ainda' é prazo de hoje e não vira item", async (t) => {
  const now = new Date("2026-10-10T15:00:00Z");
  for (const text of ["preciso hj ainda", "lâmpada led 9w, rodo e uma vassoura. preciso hj ainda", "é pra hj", "preciso hoje ainda"]) {
    assert.deepEqual(m.intents.parseNeededBy(text, now), { date: "2026-10-10", label: "hoje" }, text);
  }
  assert.ok(m.intents.hasUrgencySignal("preciso hj ainda"));
  assert.deepEqual(m.intents.parseBasketLines("lâmpada led 9w, rodo e uma vassoura. preciso hj ainda").map((l) => l.phrase), ["lâmpada led 9w", "rodo", "vassoura"]);
  if (!dbOk) return t.skip();
  const phone = await customerWith({});
  await send(phone, "lâmpada led 9w, rodo e uma vassoura. preciso hj ainda");
  assert.equal((await ctxOf(phone)).neededBy?.label, "hoje");
});

// ---------------- 3. R15a-5 / R15-7: prazo do card = o da cotação ----------------

test("R15a-5: o card mostra a entrega rápida quando custa quase o mesmo ou quando é ela que cumpre o prazo", () => {
  const now = new Date("2026-10-13T15:00:00Z"); // terça
  const santaLuzia = { sku: "santaluzia-159483", available: true, fee: 15.99, estimate: "4bd", etaMinutes: 4 * 24 * 60, fastFee: 16.74, fastEstimate: "1bd", fastEtaMinutes: 24 * 60 };
  assert.equal(m.service.cardUsesFastDelivery(santaLuzia, false, undefined, now), true, "R$ 0,75 a mais por 3 dias a menos");
  const pricier = { ...santaLuzia, fee: 11.88, fastFee: 16.04 };
  assert.equal(m.service.cardUsesFastDelivery(pricier, false, undefined, now), false, "R$ 4,16 a mais sem prazo dito: fica a mais barata");
  assert.equal(m.service.cardUsesFastDelivery(pricier, false, { date: "2026-10-14" }, now), true, "com prazo de amanhã, a que chega a tempo");
  assert.equal(m.service.cardUsesFastDelivery(pricier, false, { date: "2026-10-30" }, now), false, "as duas cumprem: a mais barata");
  assert.equal(m.service.cardUsesFastDelivery(pricier, true, undefined, now), true, "urgência: sempre a mais rápida");
  assert.equal(m.service.cardUsesFastDelivery({ sku: "x", available: true, fee: 9.9, estimate: "1bd", etaMinutes: 1440 }, false, undefined, now), false);
});

test("R15-7: o 'conferi o prazo' do fechamento não contradiz o card quando a entrega rápida é a que a escolha oferece", () => {
  const basket = [line("santaluzia-1", "Leite Italac", 8.2, "santaluzia", "Casa Santa Luzia", { delivery: "1 dia útil" })] as never[];
  assert.deepEqual(m.service.etaChangedSinceChoice(basket, new Map([["santaluzia", "4bd"]]), new Map([["santaluzia", "1bd"]])), []);
  assert.equal(m.service.etaChangedSinceChoice(basket, new Map([["santaluzia", "4bd"]])).length, 1, "sem a opção rápida, a mudança é dita");
});

test("R15a-5 (j88): card da loja com Econômica 4 dias e Expressa 1 dia (centavos a mais) mostra 1 dia útil", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex(() => [{ id: "Econômica", price: 1599, shippingEstimate: "4bd" }, { id: "Expressa", price: 1674, shippingEstimate: "1bd" }]);
  const phone = await customerWith({});
  const out = await send(phone, "leite integral");
  assert.match(out, /1 dia útil/, out.slice(0, 900));
  assert.doesNotMatch(out, /4 dias úteis/, out.slice(0, 900));
});

test("R15a-5 (j06): 'o mais barato' pra hoje, sem nada que chegue, pega o que chega antes por pouca diferença", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    { sku: "santaluzia-seara", name: "Linguiça Calabresa Seara 400g", unitPrice: 14.0, storeKey: "santaluzia", storeLabel: "Casa Santa Luzia", delivery: "4 dias úteis" },
    { sku: "santaluzia-perdigao", name: "Linguiça Calabresa Perdigão 400g", unitPrice: 16.2, storeKey: "santaluzia", storeLabel: "Casa Santa Luzia", delivery: "1 dia útil" },
    { sku: "americanas-sadia", name: "Linguiça Calabresa Sadia 400g", unitPrice: 15.0, storeKey: "americanas", storeLabel: "Americanas", delivery: "6 dias úteis" }
  ];
  const phone = await customerWith({ neededBy: { date: spToday(), label: "hoje" }, pending: [{ query: "calabresa", qty: 1, options }] }, "choosing");
  const out = await send(phone, "o mais barato");
  const basket = (await ctxOf(phone)).basket ?? [];
  assert.equal(basket[0]?.sku, "santaluzia-perdigao", out.slice(0, 600));
  assert.match(out, /Nenhuma opção chega até \*hoje\*[\s\S]*Linguiça Calabresa Seara[\s\S]*chega antes \(\*1 dia útil\*\)/, out.slice(0, 600));
  // Diferença grande: fica o mais barato.
  const far = [options[0], { ...options[1], unitPrice: 40 }];
  const phone2 = await customerWith({ neededBy: { date: spToday(), label: "hoje" }, pending: [{ query: "calabresa", qty: 1, options: far }] }, "choosing");
  await send(phone2, "o mais barato");
  assert.equal((await ctxOf(phone2)).basket?.[0]?.sku, "santaluzia-seara");
});

// ---------------- 4. R15a-6: "hoje" dito antes do cadastro ----------------

test("R15a-6: lista com 'hoje' antes do cadastro mantém o modo do dia depois do endereço", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex(() => [{ id: "Normal", price: 990, shippingEstimate: "1bd" }, { id: "Turbo", price: 1490, shippingEstimate: "2h" }]);
  const phone = newPhone();
  await send(phone, "oi");
  const noted = await send(phone, "papel higiênico e 2 sabonetes de jasmim, a visita chega hoje");
  assert.match(noted, /⏰[^\n]*\*hoje\*/, noted.slice(0, 600));
  const out = await send(phone, "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.doesNotMatch(out, /Pra \*hoje\* não chega/, out.slice(0, 1200));
  assert.match(out, /Chega hoje/, out.slice(0, 1200));
});

// ---------------- 5. R15a-7: cesta lenta em várias entregas ----------------

test("R15a-7: resumo de várias entregas com uma de 5+ dias úteis diz qual loja segura o pedido", () => {
  const base = { items: [{ qty: 1, name: "Detergente Ypê 500ml", lineTotal: 2.99 }, { qty: 1, name: "Pano de Prato Tok&Stok", lineTotal: 29.9 }], produtos: 32.89, frete: 25.15, total: 58.04, deliveries: 2, deliveryPromise: "8 dias úteis" };
  const slow = m.copy.manualQuoteSummary({ ...base, slowDelivery: { store: "Tok&Stok", promise: "8 dias úteis" } });
  assert.match(slow, /⏳ A parte da \*Tok&Stok\* leva \*8 dias úteis\*/, slow);
  assert.doesNotMatch(m.copy.manualQuoteSummary(base), /⏳/);
});

test("R15a-7 (j08): no fechamento com 2 lojas e uma em 8 dias úteis, o resumo traz a linha da loja lenta", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex((url) => (/americanas/.test(url) ? [{ id: "Normal", price: 1290, shippingEstimate: "8bd" }] : [{ id: "Normal", price: 990, shippingEstimate: "1bd" }]));
  const detergente = line("mambo-8057", "Detergente Líquido Ypê Neutro 500ml", 2.99, "mambo", "Mambo", { ask: "detergente", delivery: "1 dia útil" });
  // Sem junção que a loja confirme (o fechamento não oferece juntar).
  m.setPreflight(async (items) => ({ storeKey: items[0].storeKey, kind: "no-delivery", skus: [items[0].sku] }));
  const pano = line("americanas-6397588", "Pano de Prato Kit 3 unidades", 39.9, "americanas", "Americanas", { ask: "pano de prato", delivery: "8 dias úteis" });
  const phone = await customerWith({ basket: [detergente, pano] });
  let out = await send(phone, "só isso");
  // A troca da entrega cara (rodada 14) pode vir antes: "pula" mantém as duas lojas.
  if (!/Seu pedido/.test(out)) out = await send(phone, "pula");
  assert.match(out, /⏳ A parte da \*Americanas\* leva \*8 dias úteis\*/, out.slice(0, 1500));
});
