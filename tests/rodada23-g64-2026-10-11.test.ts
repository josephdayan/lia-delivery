// Rodada 23, grupo B, corretor g64 (11/10): quantidades por PESO em compras de mercado (achados R23-1 a R23-5, mais o
// B1/B5 de R23-10), de /mnt/project-files/testes-whatsapp/rodada23/grupo-b.md:
//   R23-1: "300 gramas de presunto" no meio de uma lista virava 50x/75x (o parser lia "300 gramas" como 300 unidades) e o
//          "10 unidades" do pão de "café da manhã: pão…" passava para o café;
//   R23-2: a loja recusava a cesta dela inteira por causa de UM item e pão, ovos, café e mamão saíam calados;
//   R23-3: "sim, deixa 2 kg" respondendo a uma pergunta sobre as laranjas mudava o acém;
//   R23-4: "dois quilos de laranja" virava 2× "laranja 2kg" (pedido de 4 kg);
//   R23-5: "um quilo e meio de acém" virava os itens "quilo" e "meio de acém";
//   B1/B5: a nota "coloquei 1 unidade (~700 g) pro seu pedido de 1 kg" sumia no "o mais barato de cada"; a embalagem de 6
//          ovos não aparecia para "meia dúzia".
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.LIA_ENABLE_MAMBO = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  intents: typeof import("../src/lib/lia-intents");
  list: typeof import("../src/lib/list-items");
  freight: typeof import("../src/lib/live-freight");
  live: typeof import("../src/lib/live-availability");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5523${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
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
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  m = {
    prisma,
    service: await import("../src/lib/delivery-service"),
    intents: await import("../src/lib/lia-intents"),
    list: await import("../src/lib/list-items"),
    freight: await import("../src/lib/live-freight"),
    live: await import("../src/lib/live-availability")
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
afterEach(() => {
  globalThis.fetch = realFetch;
  m.freight.__setPreflightForTests(null);
  m.live.__clearLiveCheckCacheForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
after(async () => {
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g64_${RUN}_${++seq}` }));
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
const item = (sku: string, name: string, unitPrice: number, qty: number, ask: string, storeKey = "mambo", storeLabel = "Mambo") =>
  ({ sku, name, qty, unitPrice, lineTotal: unitPrice * qty, storeKey, storeLabel, ask });
const lines = (text: string) => m.list.resolveListItems(text).map((l) => `${l.qty}x ${l.phrase}`);

// ---------------- R23-1 / R23-4 / R23-5: peso falado nunca é contagem ----------------

test("R23-1: 'N gramas de X' no meio da lista é o peso do item, nunca 50x", () => {
  assert.deepEqual(lines("300 gramas de presunto fatiado e 200 gramas de queijo mussarela fatiado e 1 kg de banana"), [
    "1x presunto fatiado 300g",
    "1x queijo mussarela fatiado 200g",
    "1x banana 1kg"
  ]);
  assert.deepEqual(lines("to com pressa. preciso de 1 kg de banana, meio kg de tomate, 500 gramas de alface crespa, 1 kg de cebola e 2 kg de batata"), [
    "1x banana 1kg",
    "1x tomate 500g",
    "1x alface crespa 500g",
    "1x cebola 1kg",
    "1x batata 2kg"
  ]);
  assert.deepEqual(lines("quero 200 gramas de queijo mussarela fatiado"), ["1x queijo mussarela fatiado 200g"]);
});

test("R23-4/R23-5: número por extenso + quilo, 'quilo e meio', 'meio quilo', '1,5 kg', '1kg e meio', 'duzentos gramas'", () => {
  assert.deepEqual(lines("eu preciso de um quilo e meio de acém, dois quilos de laranja, cheiro verde e uns três limões"), [
    "1x acém 1,5kg",
    "1x laranja 2kg",
    "1x cheiro verde",
    "3x limões"
  ]);
  assert.deepEqual(lines("meio quilo de feijão, 1,5 kg de arroz, 1kg e meio de carne moída, duzentos gramas de queijo, meia dúzia de ovos"), [
    "1x feijão 500g",
    "1x arroz 1,5kg",
    "1x carne moída 1,5kg",
    "1x queijo 200g",
    "6x ovos"
  ]);
  // "1 kg e meio quilo de tomate": o meio quilo é do item seguinte.
  assert.deepEqual(lines("linguiça toscana 1 kg e meio quilo de tomate"), ["1x linguiça toscana 1kg", "1x tomate 500g"]);
  assert.equal(m.intents.normalizeSpokenWeights("duzentos e cinquenta gramas de presunto"), "250g de presunto");
  assert.equal(m.intents.normalizeSpokenWeights("2 quilos e meio de batata"), "2,5kg de batata");
  // Nada de peso: o texto não muda ("uma gata", "dois litros").
  assert.equal(m.intents.normalizeSpokenWeights("ração pra uma gata e dois litros de leite"), "ração pra uma gata e dois litros de leite");
});

test("R23-1/R23-4: a linha da IA não herda contagem do peso nem do item vizinho ('café da manhã: pão francês 10 unidades … café')", () => {
  const said = m.intents.expandShoppingShorthand("café da manhã: pão francês 10 unidades, 300 gramas de presunto fatiado, leite, café, dois quilos de laranja, uns três limões");
  const det = m.list.resolveListItems(said);
  assert.equal(det[0].phrase, "pão francês", "o título 'café da manhã:' não fica na linha do pão");
  // O que a IA devolveu no teste real (11/10).
  const ai = [
    { phrase: "pão francês", qty: 10 },
    { phrase: "presunto fatiado 300g", qty: 1 },
    { phrase: "leite", qty: 1 },
    { phrase: "café", qty: 1 },
    { phrase: "laranja 2kg", qty: 1 },
    { phrase: "limão", qty: 3 }
  ];
  const out = m.list.reconcileLineCounts(m.intents.mergeShoppingLines(ai, det), said).map((l) => `${l.qty}x ${l.phrase}`);
  assert.deepEqual(out, ["10x pão francês", "1x presunto fatiado 300g", "1x leite", "1x café", "1x laranja 2kg", "3x limão"]);
});

test("R23-1: 300 g com unidade de ~200 g = 2 unidades (0,3/0,2 não arredonda para 1), com a nota", () => {
  const adj = m.service.packAdjusted({ name: "Presunto Levíssimo Fatiado Seara (unidade ~200 g)", unitWeightKg: 0.2 }, 1, "presunto fatiado 300g");
  assert.equal(adj.qty, 2);
  assert.match(adj.note ?? "", /2 unidades \(~400 g\) pro seu pedido de 300 g/);
  const linguica = m.service.packAdjusted({ name: "Linguiça Suína Toscana Sadia (unidade ~700 g)", unitWeightKg: 0.7 }, 1, "linguiça toscana 1kg");
  assert.equal(linguica.qty, 1);
  assert.match(linguica.note ?? "", /1 unidade \(~700 g\) pro seu pedido de 1 kg/);
});

// ---------------- R23-3: o peso vai para o item da pergunta ----------------

test("R23-3: 'sim, deixa 2 kg' respondendo a pergunta das laranjas mexe nas laranjas, não no acém", () => {
  const basket = [
    item("mambo-177", "Acém Bovino Resfriado Tradicional Pedaço Bandeja (unidade ~550 g)", 32.98, 3, "acém 1,5kg"),
    item("mambo-1500", "Laranja Pêra (unidade ~280 g)", 2.45, 14, "laranja 2kg")
  ];
  const q = "Você quer que eu ajuste a quantidade de laranjas para chegar a 2 kg?";
  assert.deepEqual(m.service.weightAdjustTarget("sim, deixa 2 kg", basket, q), { sku: "mambo-1500", units: 7, unitKg: 0.28, askedKg: 2 });
  assert.equal(m.service.weightAdjustTarget("deixa as laranjas em 3 kg", basket)?.units, 11);
  assert.equal(m.service.weightAdjustTarget("o acém deixa em dois quilos", basket)?.sku, "mambo-177");
  // Sem item nomeado nem pergunta, pergunta do cliente, pedido novo e "mais": não é ajuste.
  assert.equal(m.service.weightAdjustTarget("sim, deixa 2 kg", basket), null);
  assert.equal(m.service.weightAdjustTarget("e as laranjas, são 2 kg mesmo?", basket), null);
  assert.equal(m.service.weightAdjustTarget("2 kg de batata", basket), null);
  assert.equal(m.service.weightAdjustTarget("mais 1 kg de laranja", basket), null);
});

test("R23-3 (conversa): com a pergunta aberta sobre as laranjas, 'sim, deixa 2 kg' baixa as laranjas para 7 e o acém fica em 3", async (t) => {
  if (!dbOk) return t.skip();
  const acem = item("mambo-177", "Acém Bovino Resfriado Tradicional Pedaço Bandeja (unidade ~550 g)", 32.98, 3, "acém 1,5kg");
  const laranja = item("mambo-1500", "Laranja Pêra (unidade ~280 g)", 2.45, 14, "laranja 2kg");
  const phone = await customerWith({
    basket: [acem, laranja],
    lastChoice: { query: "acém 1,5kg", qty: 3, options: [{ sku: acem.sku, name: acem.name, unitPrice: acem.unitPrice, storeKey: "mambo", storeLabel: "Mambo" }], chosenSku: acem.sku },
    openQuestion: { text: "Você quer que eu ajuste a quantidade de laranjas para chegar a 2 kg?", at: Date.now(), said: "e as laranjas, são 2 kg mesmo ou ficou mais?" }
  });
  const out = await send(phone, "sim, deixa 2 kg");
  assert.match(out, /7 unidades \(~2 kg\) pro seu pedido de 2 kg/, out);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === laranja.sku)?.qty, 7);
  assert.equal(ctx.basket?.find((b) => b.sku === acem.sku)?.qty, 3, "o acém não muda");
  // Já está assim: diz o que tem, sem mexer.
  const again = await send(phone, "deixa as laranjas em 2 kg");
  assert.match(again, /Já está assim[\s\S]*7x Laranja/, again);
});

// ---------------- B1: a nota de peso no "o mais barato de cada" ----------------

test("B1: 'o mais barato de cada' traz a nota de peso de cada item pesado (linguiça 1 un ~700 g pro pedido de 1 kg)", async (t) => {
  if (!dbOk) return t.skip();
  const o = (sku: string, name: string, unitPrice: number, unitWeightKg?: number) => ({ sku, name, unitPrice, storeKey: "mambo", storeLabel: "Mambo", ...(unitWeightKg ? { unitWeightKg } : {}) });
  const phone = await customerWith(
    {
      step: "choosing",
      pending: [
        { query: "picanha 2kg", qty: 1, options: [o("mambo-286338", "Picanha Berkshire Mambo (unidade ~800 g)", 55.98, 0.8)] },
        { query: "linguiça toscana 1kg", qty: 1, options: [o("mambo-555", "Linguiça Suína Toscana Sadia (unidade ~700 g)", 18.18, 0.7)] },
        { query: "presunto fatiado 300g", qty: 1, options: [o("mambo-8158", "Presunto Levíssimo Fatiado Seara (unidade ~200 g)", 9.19, 0.2)] },
        { query: "carvão", qty: 1, options: [o("mambo-900", "Carvão Fogozão Especial Pacote 3kg", 26.99)] }
      ]
    },
    "choosing"
  );
  const out = await send(phone, "o mais barato de cada");
  assert.match(out, /1 unidade \(~700 g\) pro seu pedido de 1 kg/, out);
  assert.match(out, /2 unidades \(~400 g\) pro seu pedido de 300 g/, out);
  assert.match(out, /3 unidades \(~2,4 kg\) pro seu pedido de 2 kg/, out);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === "mambo-8158")?.qty, 2);
});

// ---------------- R23-2: a recusa da loja não leva a cesta inteira ----------------

// Simulação VTEX da Mambo: a cesta com o presunto em quantidade que a loja não tem volta SEM entrega em todas as linhas
// (recusa da cesta inteira); cada item sozinho é confirmado — menos o presunto (a loja devolve menos do que o pedido).
const SHORT_STOCK = new Map([["8158", 5]]);
function mockMambo() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/viacep\.com\.br/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
    if (!url.includes("orderForms/simulation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    const short = body.items.some((i) => (SHORT_STOCK.get(i.id) ?? Infinity) < i.quantity);
    const n = body.items.length;
    return new Response(
      JSON.stringify({
        items: body.items.map((i) => ({ id: i.id, quantity: n === 1 ? Math.min(i.quantity, SHORT_STOCK.get(i.id) ?? i.quantity) : i.quantity, sellingPrice: 1000, availability: "available" })),
        logisticsInfo: body.items.map((_, itemIndex) => ({
          itemIndex,
          slas: n > 1 && short ? [] : [{ id: "Entrega", name: "Entrega", price: Math.round(990 / n), shippingEstimate: "2h" }]
        }))
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

test("R23-2: a Mambo recusa a cesta por causa de UM item — só ele sai, o resto fecha, e o que saiu fica para 'tenta de novo'", async (t) => {
  if (!dbOk) return t.skip();
  setEnv({ LIA_LIVE_FREIGHT_OFF: "false", LIA_CHARGE_ONLY_VERIFIED: "true", LIA_OPERATOR_QUOTE: "false" });
  m.freight.__setPreflightForTests(async () => null);
  mockMambo();
  const pao = item("mambo-11549", "Pão Francês Mambo (unidade ~80 g)", 1.59, 10, "pão francês");
  const presunto = item("mambo-8158", "Presunto Levíssimo Fatiado Seara (unidade ~200 g)", 9.19, 75, "presunto fatiado 300g");
  const ovos = item("mambo-10248", "Ovos Caipira Ito country com 10 Unidades", 13.98, 1, "ovos");
  const mamao = item("mambo-2001", "Mamão Papaya Candy (unidade ~450 g)", 7.64, 1, "mamão");
  const basket = [pao, presunto, ovos, mamao];
  const phone = await customerWith({ basket, consolidationTried: basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|") });
  const out = await send(phone, "só isso");
  assert.match(out, /Presunto/, out.slice(0, 800));
  // O que saiu é oferecido de outra loja na hora (g65) ou fica para "tenta de novo" (g64).
  const offeredElsewhere = /outra loja/i.test(out);
  assert.match(out, /tenta de novo|outra loja/i, out.slice(0, 800));
  if (offeredElsewhere) assert.match(out, /resto da cesta continua \(3 itens\)/, out.slice(0, 800));
  else for (const kept of [pao, ovos, mamao]) assert.match(out, new RegExp(kept.name.split(" ")[0]), `${kept.name} segue no pedido: ${out.slice(0, 800)}`);
  const order = await m.prisma.deliveryOrder.findFirst({ where: { phone, status: { not: "canceled" } }, orderBy: { createdAt: "desc" } });
  const ctx = await ctxOf(phone);
  const skus = [...((order?.items as Array<{ sku: string }> | null) ?? []), ...(ctx.basket ?? [])].map((i) => i.sku);
  for (const kept of [pao, ovos, mamao]) assert.ok(skus.includes(kept.sku), `${kept.sku} no pedido/cesta: ${skus.join(",")}`);
  assert.ok(!skus.includes(presunto.sku), "o presunto sai");
  assert.ok(offeredElsewhere || (ctx.listMisses ?? []).some((miss) => /presunto/.test(miss.query)), "o presunto é oferecido de outra loja ou fica como faltante para 'tenta de novo'");
});
