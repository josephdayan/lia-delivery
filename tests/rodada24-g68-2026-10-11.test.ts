// Rodada 24, grupo A, corretor g68 (11/10): achados R24a-1 a R24a-5 de /mnt/project-files/testes-whatsapp/rodada24/grupo-a.md:
//   R24a-1 (N1): "10 pães franceses e leite" virava pão francês + pães franceses (resumo 30x); "uns três limões" virava 6x;
//   R24a-2 (N2): "troca o algodão pelo de 100 unidades" dizia que o de 50 "já é" o de 100 e não trocava;
//   R24a-3 (N3): "tenta de novo" depois da recusa da cesta inteira recomeçava as escolhas do zero;
//   R24a-4 (N4): "o de bebê, o Basic+ Care Baby" somava dois itens fantasmas em vez de corrigir o algodão.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.LIA_ENABLE_MAMBO = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  intents: typeof import("../src/lib/lia-intents");
  pre: typeof import("../src/lib/dialogue/presignup");
  live: typeof import("../src/lib/live-availability");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5524${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
    intents: await import("../src/lib/lia-intents"),
    pre: await import("../src/lib/dialogue/presignup"),
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
  m.live.__setLiveSimulateForTests(null);
  m.live.__clearLiveCheckCacheForTests();
});
after(async () => {
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g68_${RUN}_${++seq}` }));
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
  ({ sku, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100, storeKey, storeLabel, ask });

// ---------------- R24a-1: plural no meio da lista não duplica o item ----------------

test("R24a-1: a linha da IA no singular cobre o plural dito ('10 pães franceses' × 'pão francês', 'uns três limões' × 'limão')", () => {
  const c = (query: string, qty = 1) => ({ query, qty, cheapest: false });
  const pao = m.pre.reconcilePreItems([c("pão francês", 10), c("leite")], "preciso de 10 pães franceses e leite");
  assert.deepEqual(pao.map((i) => `${i.qty}x ${i.query}`), ["10x pão francês", "1x leite"]);
  const limao = m.pre.reconcilePreItems([c("limão", 3), c("laranja 2kg")], "preciso de uns três limões e dois quilos de laranja");
  assert.deepEqual(limao.map((i) => `${i.qty}x ${i.query}`), ["3x limão", "1x laranja 2kg"]);
  const sogra = m.pre.reconcilePreItems(
    [c("pão francês", 10), c("presunto fatiado 300g"), c("leite")],
    "to comprando pra minha sogra, ela ta de cama. preciso de 10 pães franceses, 300 gramas de presunto fatiado, leite"
  );
  assert.equal(sogra.filter((i) => /p[aã]/.test(i.query) && /franc/.test(i.query)).length, 1, JSON.stringify(sogra));
  // O mesmo item, por qualquer das regras de comparação.
  assert.ok(m.intents.sameItemProduct("limões", "limão"));
  assert.ok(m.intents.sharesProductNoun("pães franceses", "pão francês"));
  // Itens diferentes continuam diferentes.
  assert.ok(!m.intents.sameItemProduct("pão de queijo", "queijo"));
});

// ---------------- R24a-2: variante de outro tamanho não "já é" ----------------

test("R24a-2: 'troca o algodão pelo de 100 unidades' com o de 50 na cesta troca (nunca 'já é')", async (t) => {
  if (!dbOk) return t.skip();
  const algodao = item("dsp-1", "Algodão Bella Cotton Maxi Bebê Com 50 Unidades", 25.62, 1, "algodão pra bebê", "drogariasp", "Drogaria São Paulo");
  const termo = item("fi-2", "Termômetro Clínico Digital Multilaser Branco Multi Saúde HC148", 15.29, 1, "termômetro de bebê", "farmaciaindiana", "Farmácia Indiana");
  const phone = await customerWith({ basket: [algodao, termo] });
  const out = await send(phone, "troca o algodão pelo de 100 unidades");
  assert.doesNotMatch(out, /já é/, out.slice(0, 500));
  // No catálogo de teste não há algodão de 100: o que importa é a troca seguir (busca nova), nunca "já é".
  assert.match(out, /Tirei \*Algodão Bella|Troquei Algodão Bella|100 unidades/i, out.slice(0, 500));
});

// ---------------- R24a-4: "o de bebê, o <marca>" é correção de um item ----------------

test("R24a-4: 'o de bebê, o <marca>' corrige o item da cesta que existe com a marca (sem somar itens fantasmas)", async (t) => {
  // Na produção: "o de bebê, o Basic+ Care Baby" com algodão e termômetro. No catálogo de teste, a mesma forma com Huggies.
  const lenco = item("crf-1", "Lenço Umedecido Carrefour Soft 50 Unidades", 9.9, 1, "lenço umedecido", "carrefour", "Carrefour");
  const termo = item("crf-2", "Termômetro Clínico Digital G-Tech", 15.29, 1, "termômetro de bebê", "carrefour", "Carrefour");
  const fix = m.service.articleOnlyCorrection(["o de bebê", "o Huggies"], [termo, lenco]);
  assert.equal(fix?.item.sku, "crf-1");
  assert.match(fix?.to ?? "", /len[cç]o umedecido.*Huggies/);
  // Pedido novo com artigo (sem a elipse "o de …") continua pedido.
  assert.equal(m.service.articleOnlyCorrection(["o leite", "o pão"], [termo, lenco]), null);
  assert.equal(m.service.articleOnlyCorrection(["o Huggies"], [termo, lenco]), null);
  if (!dbOk) return t.skip();
  const phone = await customerWith({ basket: [termo, lenco] });
  const out = await send(phone, "o de bebê, o Huggies");
  assert.doesNotMatch(out, /Somei/, out.slice(0, 500));
  assert.match(out, /Tirei \*Lenço Umedecido Carrefour|Troquei Lenço Umedecido Carrefour/, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.ok(ctx.basket?.some((b) => b.sku === termo.sku), "o termômetro fica");
});

// ---------------- R24a-3: "tenta de novo" reaproveita as escolhas ----------------

test("R24a-3: depois da recusa da cesta inteira, 'tenta de novo' devolve o que a loja confirma agora e só procura o resto", async (t) => {
  if (!dbOk) return t.skip();
  const banana = item("mambo-101", "Banana Prata (unidade ~120 g)", 0.99, 6, "banana prata");
  const tomate = item("mambo-102", "Tomate Italiano (unidade ~150 g)", 1.29, 4, "tomate");
  const frango = item("swift-103", "Frango Inteiro Congelado Swift", 28.99, 1, "frango inteiro", "swift", "Swift");
  const phone = await customerWith({ refusedBasket: { items: [banana, tomate, frango], at: Date.now() } });
  // A Mambo confirma agora (com o preço do momento); a Swift não.
  m.live.__setLiveSimulateForTests(async (storeKey, skus) => new Map(skus.map((sku) => [sku, { sku, available: storeKey === "mambo", ...(sku === "mambo-102" ? { unitPrice: 1.39 } : {}) }])), () => true);
  const out = await send(phone, "tenta de novo");
  assert.match(out, /Voltaram pra cesta, como você escolheu: \*Banana Prata[^*]*\*, \*Tomate Italiano/, out.slice(0, 600));
  assert.match(out, /Procurando de novo: \*frango inteiro\*/, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === banana.sku)?.qty, 6);
  assert.equal(ctx.basket?.find((b) => b.sku === tomate.sku)?.unitPrice, 1.39);
  assert.ok(!ctx.basket?.some((b) => b.sku === frango.sku), "o frango é procurado de novo, não volta calado");
});

// ---------------- R24a-5: baixos baratos ----------------

test("R24a-5 (N6): 'bom dia filha' não vira o item 'filha'", async () => {
  const list = await import("../src/lib/list-items");
  const said = list.resolveListItems("bom dia filha, sou idoso. preciso de banana prata, maçã, mamão, tomate, cenoura, carne moída 500 g e frango inteiro");
  assert.ok(!said.some((l) => /filh/.test(l.phrase)), said.map((l) => l.phrase).join(" | "));
  assert.ok(said.some((l) => /banana prata/.test(l.phrase)));
});

test("R24a-5 (N7): 'são 2 kg mesmo?' sobre a laranja de 2 kg é respondida, e 'sim, deixa 2 kg' não mexe no acém", async (t) => {
  const acem = item("swift-1", "Acém Combo 1kg a 2,1kg (unidade ~2,1 kg)", 59.9, 1, "acém 1,5kg", "swift", "Swift");
  const laranja = item("mambo-2", "Laranja Pêra Alfa Citrus 2kg", 13.18, 1, "laranja 2kg");
  const basket = [acem, laranja];
  assert.deepEqual(m.service.weightQuestionTarget("e as laranjas, são 2 kg mesmo ou ficou mais?", basket), { name: laranja.name, qty: 1, totalKg: 2, askedKg: 2 });
  assert.equal(m.service.weightQuestionTarget("deixa as laranjas em 2 kg", basket), null);
  const q = "Você quer alterar a quantidade de laranjas ou só confirmar o peso da embalagem?";
  assert.deepEqual(m.service.weightAdjustTarget("sim, deixa 2 kg", basket, q), { sku: laranja.sku, units: 1, unitKg: 2, askedKg: 2 });
  // Peso que não fecha em embalagens inteiras não é ajuste da embalagem.
  assert.equal(m.service.weightAdjustTarget("deixa as laranjas em 3 kg", basket), null);
  if (!dbOk) return t.skip();
  const phone = await customerWith({ basket });
  const out = await send(phone, "e as laranjas, são 2 kg mesmo ou ficou mais?");
  assert.match(out, /Sim 🙂 \*1x Laranja Pêra Alfa Citrus 2kg\* dá ~2 kg/, out);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === acem.sku)?.qty, 1);
});
