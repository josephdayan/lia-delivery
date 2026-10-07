// Retorno do teste adversarial de 06/10 (busca, quantidade e frete). Cada caso aqui falhava
// no código anterior; os nomes citam o código do achado no relatório (M2, A3, A8…).
// Banco local (TEST_DATABASE_URL) para os casos de conversa; WhatsApp mock; simulação VTEX
// mockada por teste (fetch). Nenhuma chamada real a loja.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

// O registry de lojas lê as flags na importação: as lojas dos casos reais ligam aqui, antes
// de qualquer import do cérebro (que é dinâmico, dentro dos testes).
for (const store of ["MAMBO", "SWIFT", "DROGAL", "PAGUEMENOS", "DROGARIASP", "COBASI", "RIHAPPY", "EPOCACOSMETICOS"]) process.env[`LIA_ENABLE_${store}`] = "true";
process.env.LIA_MANUAL_CONCIERGE = "true";

import { liveStoreFreight, pickCartSla } from "../src/lib/live-freight";

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

type Body = { items: { id: string; quantity: number }[] };
function mockSimulation(respond: (body: Body, call: number) => unknown) {
  strictMode();
  let call = 0;
  const calls: Body[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    calls.push(body);
    return new Response(JSON.stringify(respond(body, call++)), { status: 200 });
  }) as typeof fetch;
  return calls;
}
const dock = [{ warehouseId: "1_5093", dockId: "2_5093", courierId: "5093_9" }];
const agendada = (price: number) => ({ id: "Entrega agendada", name: "Entrega agendada", price, shippingEstimate: "5h", deliveryIds: dock });
const umDia = (price: number) => ({ id: "Receba em 1 dia útil", name: "Receba em 1 dia útil", price, shippingEstimate: "1bd", deliveryIds: dock });
const ARROZ_FEIJAO = [{ sku: "swift-7694", qty: 1 }, { sku: "swift-7695", qty: 1 }];

// ---------- M2: frete dobrado na mesma loja ----------
test("M2: arroz + feijão Swift com rateio normal = UM frete (8,89 + 9,01 = 17,90)", async () => {
  mockSimulation(() => ({
    items: [{ id: "7694", quantity: 1, availability: "available" }, { id: "7695", quantity: 1, availability: "available" }],
    logisticsInfo: [{ itemIndex: 0, slas: [agendada(889)] }, { itemIndex: 1, slas: [agendada(901), umDia(800)] }]
  }));
  const out = await liveStoreFreight("swift", ARROZ_FEIJAO, "01233020");
  assert.equal(out.kind, "ok");
  // Antes: arroz na agendada (8,89) + feijão no "1 dia útil" (8,00) = duas entregas.
  assert.equal(out.kind === "ok" && out.fee, 17.9);
});

test("M2: resposta SEM rateio (17,90 em cada linha, mesmo armazém) vira um frete só, conferido com o item sozinho", async () => {
  const calls = mockSimulation((body) =>
    body.items.length === 1
      ? { items: [{ id: body.items[0].id, quantity: 1, availability: "available" }], logisticsInfo: [{ itemIndex: 0, slas: [agendada(1790)] }] }
      : {
          items: [{ id: "7694", quantity: 1, availability: "available" }, { id: "7695", quantity: 1, availability: "available" }],
          logisticsInfo: [{ itemIndex: 0, slas: [agendada(1790)] }, { itemIndex: 1, slas: [agendada(1790), umDia(1590)] }]
        }
  );
  const out = await liveStoreFreight("swift", ARROZ_FEIJAO, "01233020");
  assert.equal(out.kind === "ok" && out.fee, 17.9, "era R$ 35,80 (16,90+17,90 ou 17,90+17,90)");
  assert.equal(calls.length, 2, "uma simulação extra, só porque a resposta era ambígua");
});

test("M2: rateio IGUAL de verdade (dois itens de mesmo valor, Pacheco 345 + 345) continua somado", async () => {
  const normal = (price: number) => ({ id: "NORMAL", name: "NORMAL", price, shippingEstimate: "1bd" });
  mockSimulation((body) =>
    body.items.length === 1
      ? { items: [{ id: body.items[0].id, quantity: 1, availability: "available" }], logisticsInfo: [{ itemIndex: 0, slas: [normal(690)] }] }
      : {
          items: [{ id: "1", quantity: 1, availability: "available" }, { id: "2", quantity: 1, availability: "available" }],
          logisticsInfo: [{ itemIndex: 0, slas: [normal(345)] }, { itemIndex: 1, slas: [normal(345)] }]
        }
  );
  const out = await liveStoreFreight("drogariaspacheco", [{ sku: "drogariaspacheco-1", qty: 1 }, { sku: "drogariaspacheco-2", qty: 1 }], "01233020");
  assert.equal(out.kind === "ok" && out.fee, 6.9);
});

test("M2 (puro): sem SLA em comum, cada linha na sua e o frete soma (duas entregas de verdade)", () => {
  const pick = pickCartSla(
    [
      { sku: "a", slas: [{ id: "X", price: 490, shippingEstimate: "1bd" }] },
      { sku: "b", slas: [{ id: "Y", price: 690, shippingEstimate: "3bd" }] }
    ],
    (a, b) => a.fee < b.fee
  );
  assert.equal(pick?.fee, 1180);
  assert.equal(pick?.estimate, "3bd");
});

// ---------- A3: produto vendido por peso ----------
test("A3: simulação com measurementUnit kg + unitMultiplier vira peso da unidade no check", async () => {
  const { liveItemAvailability } = await import("../src/lib/live-freight");
  mockSimulation(() => ({
    items: [{ id: "1260", quantity: 1, availability: "available", sellingPrice: 179, measurementUnit: "kg", unitMultiplier: 0.18 }],
    logisticsInfo: [{ itemIndex: 0, slas: [{ id: "Normal", name: "Normal", price: 1290, shippingEstimate: "1bd" }] }]
  }));
  const check = (await liveItemAvailability("mambo", ["mambo-1260"], "01233020"))?.get("mambo-1260");
  assert.equal(check?.unitPrice, 1.79);
  assert.equal(check?.unitWeightKg, 0.18);
});

test("A3: nome diz o peso da unidade e o pedido em kg/g vira número de unidades", async () => {
  const copy = await import("../src/lib/lia-copy");
  const { packAdjusted, parseWeightAskKg } = await import("../src/lib/delivery-service");
  assert.equal(copy.soldByWeightName("Banana Nanica Kg", 0.18), "Banana Nanica (unidade ~180 g)");
  assert.equal(copy.soldByWeightName("Pão Francês Mambo Kg", 0.08), "Pão Francês Mambo (unidade ~80 g)");
  assert.equal(parseWeightAskKg("banana 2kg"), 2);
  assert.equal(parseWeightAskKg("presunto fatiado 500g"), 0.5);
  assert.equal(parseWeightAskKg("meio quilo de queijo mussarela"), 0.5);
  const banana = { name: "Banana Nanica (unidade ~180 g)", unitWeightKg: 0.18 };
  // "2kg de banana" comprava 1 unidade (180 g).
  const two = packAdjusted(banana, 1, "banana 2kg", { assumedOne: true });
  assert.equal(two.qty, 11);
  assert.match(two.note ?? "", /11 unidades \(~2 kg\)/);
  // "10 pães" continua 10 unidades (o nome é que diz ~80 g cada).
  assert.equal(packAdjusted({ name: "Pão Francês Mambo (unidade ~80 g)", unitWeightKg: 0.08 }, 10, "pães franceses").qty, 10);
  assert.equal(packAdjusted({ name: "Presunto (unidade ~100 g)", unitWeightKg: 0.1 }, 1, "presunto fatiado 500g", { assumedOne: true }).qty, 5);
});

// ---------- A4/M6: ovos e outros conteúdos de embalagem ----------
test("A4/M6: '6 ovos'/'meia dúzia' com caixa de 10 = 1 caixa; 12 ovos = 2 caixas (cobre o pedido)", async () => {
  const { packAdjusted } = await import("../src/lib/delivery-service");
  const caixa10 = "Ovos Jumbo Brancos Queen Eggs Graciana com 10 Unidades";
  assert.equal(packAdjusted(caixa10, 6, "ovos").qty, 1);
  assert.equal(packAdjusted(caixa10, 12, "ovos").qty, 2, "antes: 1 caixa (10) para 12 pedidos");
  assert.equal(packAdjusted(caixa10, 24, "ovos").qty, 3);
  assert.equal(packAdjusted(caixa10, 30, "ovos").qty, 3);
  assert.equal(packAdjusted(caixa10, 6, "caixas de ovos").qty, 6, "6 CAIXAS são 6 caixas");
  assert.equal(packAdjusted("Fralda Pampers Confort Sec M 40 Unidades", 2, "pacotes de fralda pampers M").qty, 2);
  assert.equal(packAdjusted("Fralda Pampers Confort Sec M 40 Unidades", 2, "fralda pampers M").qty, 2, "2 fraldas = 2 pacotes (número pequeno)");
  assert.equal(packAdjusted("Pack 12 Latas - Coca-Cola Lata 350ml", 6, "latas de coca").qty, 1);
});

// ---------- A8: remédio errado por dose ----------
test("A8: dose sozinha não segura relevância; remédio com outra dose sai, a dose certa sobe", async () => {
  const { scoreCatalogMatch } = await import("../src/lib/stores/types");
  const sku = (name: string) => ({ sku: name, name, unitPrice: 10, medicine: "mip" as const });
  // Os candidatos vão para o rerank por IA: com score > 0, a IA escolheu o Sintocalmy.
  assert.equal(scoreCatalogMatch("ibuprofeno 600mg", sku("Sintocalmy 600mg 30 Comprimidos Revestidos")), 0);
  assert.equal(scoreCatalogMatch("ibuprofeno 600mg", sku("Ibuprofeno 100mg/ml Suspensão Oral Gotas 20ml Genérico Cimed")), 0);
  const right = scoreCatalogMatch("ibuprofeno 400mg", sku("Ibuprofeno 400mg 10 Comprimidos Genérico Neo Química"));
  assert.ok(right > scoreCatalogMatch("ibuprofeno", sku("Ibuprofeno 400mg 10 Comprimidos Genérico Neo Química")));
});

// ---------- A7: presente ----------
test("A7: a sacola de presente (com a marca na frente) nunca é o presente", async () => {
  const { scoreCatalogMatch } = await import("../src/lib/stores/types");
  const item = (name: string) => ({ sku: name, name, unitPrice: 5 });
  assert.equal(scoreCatalogMatch("presente feminino", item("Época Cosméticos Sacola Presenteável P")), 0);
  assert.equal(scoreCatalogMatch("presente", item("Sacola Para Presentes Flamengo 33x27cm")), 0);
  assert.ok(scoreCatalogMatch("sacola de presente", item("Sacola Para Presentes Flamengo 33x27cm")) > 0, "pedida, a embalagem continua achável");
  assert.ok(scoreCatalogMatch("kit presente", item("Kit Presentável Lola Cosmetics – Cronograma Capilar + Sacola Presenteável Kit")) > 0);
});

test("A7: presente sem produto vira a categoria comum de presente para quem recebe", async () => {
  const { giftSearchPhrase } = await import("../src/lib/delivery-service");
  assert.equal(giftSearchPhrase("presente para mae de 60 anos"), "perfume feminino");
  assert.equal(giftSearchPhrase("um presente pra minha mãe"), "perfume feminino");
  assert.equal(giftSearchPhrase("presente pro meu pai"), "perfume masculino");
  assert.equal(giftSearchPhrase("presente de aniversário pra menino de 5 anos"), "brinquedo menino 5 anos");
  assert.equal(giftSearchPhrase("presente pra minha filha de 8 anos"), "brinquedo menina 8 anos");
  assert.equal(giftSearchPhrase("perfume de presente pra minha mãe"), null, "com produto, o pedido fica como está");
  assert.equal(giftSearchPhrase("arroz"), null);
});

// ---------------- conversa (banco local) ----------------
// Loja VTEX de mentira por sku: `drop` = sem entrega no CEP; `weight` = vendido por peso;
// `down` = loja não responde; `slow` = simulação que estoura o tempo na 1ª tentativa.
type SkuRule = { drop?: boolean; weightKg?: number; priceCents?: number; maxQty?: number };
let simulatedSkus: string[] = [];
function mockStores(rules: Record<string, SkuRule> = {}, opts: { down?: string[]; slowOnce?: string[]; dropFirst?: number; slowAllOnce?: boolean } = {}) {
  strictMode();
  simulatedSkus = [];
  const slowSeen = new Set<string>();
  const firstWave = new Set<string>();
  const laterWave = new Set<string>();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("orderForms/simulation")) return new Response("{}", { status: 404 });
    const host = new URL(u).host;
    if ((opts.down ?? []).some((d) => host.includes(d))) return new Response("blocked", { status: 503 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const store = host.replace(/^(www|loja)\./, "").split(".")[0];
    const items = body.items.map((i) => {
      const key = `${store}:${i.id}`;
      simulatedSkus.push(`${key}x${i.quantity}`);
      const rule = rules[key] ?? {};
      if (opts.dropFirst && !firstWave.has(key) && firstWave.size < opts.dropFirst && !laterWave.has(key)) firstWave.add(key);
      else laterWave.add(key);
      const unavailable = rule.drop || firstWave.has(key) || (rule.maxQty != null && i.quantity > rule.maxQty);
      return {
        id: i.id,
        quantity: i.quantity,
        sellingPrice: rule.priceCents ?? 500,
        availability: unavailable ? "cannotBeDelivered" : "available",
        ...(rule.weightKg ? { measurementUnit: "kg", unitMultiplier: rule.weightKg } : { measurementUnit: "un", unitMultiplier: 1 })
      };
    });
    if (body.items.some((i) => (opts.slowAllOnce || (opts.slowOnce ?? []).includes(`${store}:${i.id}`)) && !slowSeen.has(`${store}:${i.id}`))) {
      body.items.forEach((i) => slowSeen.add(`${store}:${i.id}`));
      return new Response("timeout", { status: 504 });
    }
    return new Response(
      JSON.stringify({
        items,
        logisticsInfo: items.map((item, itemIndex) => ({ itemIndex, slas: item.availability === "available" ? [{ id: "Normal", name: "Normal", price: 1290, shippingEstimate: "1bd" }] : [] }))
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5501${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}7`;
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
    await handleDeliveryMessage({ phone, text, messageId: `busca06_${RUN}_${++seq}` });
    return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  };
  const context = async () => {
    const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
    return JSON.parse(convo.context ?? "{}") as { basket?: { sku: string; name: string; qty: number }[]; pending?: { query: string; qty: number; options: { sku: string; name: string }[] }[] };
  };
  return { phone, userId: user.id, send, context };
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

test("A3 (conversa): '2kg de banana' mostra a unidade de ~180 g e a escolha vira 11 unidades", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({ "mambo:1260": { weightKg: 0.18, priceCents: 179 }, "mambo:1272": { weightKg: 0.15, priceCents: 150 } });
  const c = await customer();
  const vitrine = await c.send("2kg de banana");
  assert.match(vitrine, /Banana Nanica \(unidade ~180 g\)/, vitrine);
  assert.doesNotMatch(vitrine, /Banana Nanica Kg/, vitrine);
  const pending = (await c.context()).pending?.[0];
  const idx = pending!.options.findIndex((o) => o.sku === "mambo-1260");
  assert.ok(idx >= 0, JSON.stringify(pending?.options.map((o) => o.name)));
  const chosen = await c.send(String(idx + 1));
  const basket = (await c.context()).basket ?? [];
  assert.equal(basket.find((i) => i.sku === "mambo-1260")?.qty, 11, chosen);
  assert.match(chosen, /11 unidades/, chosen);
});

test("A9 (conversa): a loja derruba os primeiros candidatos → a Lia confere os próximos antes de dizer 'não achei'", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({}, { dropFirst: 12 });
  const c = await customer();
  const reply = await c.send("açúcar");
  assert.doesNotMatch(reply, /não achei|Não consigo comprar/i, reply);
  assert.match(reply, /Açúcar/i, reply);
  const pending = (await c.context()).pending?.[0];
  assert.ok(pending?.options.length, reply);
  assert.ok(simulatedSkus.length > 12, "conferiu candidatos além dos 12 primeiros");
});

test("M4 (conversa): loja que não responde na 1ª consulta ganha nova tentativa (não vira 'nenhuma loja confirmou')", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({}, { slowAllOnce: true });
  const c = await customer();
  const reply = await c.send("detergente");
  assert.doesNotMatch(reply, /nenhuma loja confirmou/i, reply);
  assert.ok((await c.context()).pending?.[0]?.options.length, reply);
});

test("M3 (conversa): a vitrine confere a QUANTIDADE pedida — '3 cocas' não mostra loja que só tem 1", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({});
  const c = await customer();
  await c.send("3 cocas");
  assert.ok(simulatedSkus.some((k) => /x3$/.test(k)), `simulou com qty 3: ${simulatedSkus.slice(0, 5).join(",")}`);
});

test("A6/A9 (conversa): '2 litros de leite' sem caixa de 2 L vira 2× leite 1 L", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({});
  const c = await customer();
  const reply = await c.send("2 litros de leite");
  const pending = (await c.context()).pending?.[0];
  assert.ok(pending, reply);
  assert.equal(pending!.qty, 2, reply);
  assert.ok(pending!.options.every((o) => /1\s?(l|litro)\b/i.test(o.name)), pending!.options.map((o) => o.name).join(" | "));
});

test("A5 (puro): pack/fardo sai da busca e volta como identidade da embalagem", async () => {
  const { parsePackAsk } = await import("../src/lib/delivery-service");
  assert.deepEqual(parsePackAsk("pack de cerveja brahma 12 latas"), { core: "cerveja brahma", brand: "brahma", count: 12 });
  assert.deepEqual(parsePackAsk("fardo de cerveja heineken"), { core: "cerveja heineken", brand: "heineken" });
  assert.deepEqual(parsePackAsk("fardo de água"), { core: "agua" });
  assert.equal(parsePackAsk("cerveja heineken"), null);
});

test("A5 (conversa): 'fardo de cerveja heineken' mostra só packs, nunca a lata solta", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({});
  const c = await customer();
  const reply = await c.send("fardo de cerveja heineken");
  const names = ((await c.context()).pending?.[0]?.options ?? []).map((o) => o.name);
  assert.ok(names.length, reply);
  assert.ok(names.every((n) => /pack|fardo|\d+\s*(latas|unidades|un)\b/i.test(n)), names.join(" | "));
  assert.ok(names.some((n) => /heineken/i.test(n)), names.join(" | "));
});

test("A5 (conversa): pack que a loja não confirma → latas soltas, nunca 'não achei'", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({ "swift:4684": { drop: true } });
  const c = await customer();
  const reply = await c.send("fardo de cerveja heineken");
  const names = ((await c.context()).pending?.[0]?.options ?? []).map((o) => o.name);
  assert.ok(names.some((n) => /heineken/i.test(n)), reply);
});

test("A5 (conversa): sem pack na vitrine, 'N latas' vira N unidades", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({});
  const c = await customer();
  const reply = await c.send("pack de guaraná antarctica 6 latas");
  const pending = (await c.context()).pending?.[0];
  assert.ok(pending, reply);
  const allPacks = pending!.options.every((o) => /pack|fardo|\d+\s*(latas|unidades|un)\b/i.test(o.name));
  assert.ok(allPacks || pending!.qty === 6, `${pending!.qty}x ${pending!.options.map((o) => o.name).join(" | ")}`);
});

test("A6 (conversa): '1kg de tomate' mostra o tomate vendido por kg, não só o orgânico de 1 kg", async (t) => {
  if (!dbOk) return t.skip();
  mockStores({});
  const c = await customer();
  const reply = await c.send("1kg de tomate");
  const names = ((await c.context()).pending?.[0]?.options ?? []).map((o) => o.name);
  // Antes: só o que tinha "1kg" no nome (o orgânico de R$30); o tomate vendido por kg sumia.
  assert.ok(names.some((n) => /tomate/i.test(n) && /\bkg\b|unidade/i.test(n) && !/org[aâ]nico|1\s?kg/i.test(n)), `${names.join(" | ")}\n${reply}`);
});
