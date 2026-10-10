// Rodada 15, grupo G42 (10/10): achados R15a-1..R15a-3 de /mnt/project-files/testes-whatsapp/rodada15/grupo-a.md (R14-1,
// R14-2, R14-7). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. (R15a-1) "pode tirar o sal" com o "Biscoito Água e Sal" e nenhum sal na cesta tirava o biscoito;
//   2. (R15a-2) "meu filho tem 5 anos, …" criava o item "tem 5 anos"; "café da manhã domingo, …" virava item; "meu cachorro
//      tem 13 anos, um shih tzu, preciso de ração sênior…" dava a ração em dobro; "Meu nome é João Pereira, CPF …, moro
//      na …" não guardava o nome;
//   3. (R15a-3) "quero a ração hoje e o resto outro dia, dá pra fazer dois pedidos?" falava em "outra pessoa"; "então
//      fecha tudo junto" numa loja só respondia "Já está tudo numa loja só" sem fechar.
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
  freight: typeof import("../src/lib/live-freight");
  clearLive: typeof import("../src/lib/live-availability").__clearLiveCheckCacheForTests;
  presignup: typeof import("../src/lib/dialogue/presignup");
  address: typeof import("../src/lib/address-parse");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5541${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
// Simulação VTEX: toda linha tem entrega, frete R$ 12,90 por loja em 2 dias úteis.
function mockVtex() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/viacep\.com\.br/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
    if (!url.includes("orderForms/simulation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    const n = body.items.length;
    return new Response(
      JSON.stringify({
        items: body.items.map((i) => ({ id: i.id, quantity: i.quantity, sellingPrice: 1000, availability: "available" })),
        logisticsInfo: body.items.map((_i, itemIndex) => ({ itemIndex, slas: [{ id: "Entrega", name: "Entrega", price: Math.round(1290 / n), shippingEstimate: "2bd" }] }))
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
    freight,
    clearLive: live.__clearLiveCheckCacheForTests,
    presignup: await import("../src/lib/dialogue/presignup"),
    address: await import("../src/lib/address-parse")
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
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g42_${RUN}_${++seq}` }));
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

// ---------------- 1. R15a-1: "tira o sal" com o sal só dentro do nome do biscoito ----------------

test("R15a-1: 'pode tirar o sal' com só o 'Biscoito Água e Sal' na cesta não tira nada e pergunta", async (t) => {
  if (!dbOk) return t.skip();
  const biscoito = line("farmaciaindiana-169115", "Biscoito Aymoré Água e Sal 164g", 4.94, "farmaciaindiana", "Farmácia Indiana", { ask: "bolacha de água e sal" });
  const barra = line("paguemenos-34937", "Barra de Cereais Nutry Bolo de Chocolate 22g", 2.85, "paguemenos", "Pague Menos", { ask: "barra de cereal" });
  for (const text of ["não pedi sal, era a bolacha de água e sal. pode tirar o sal", "tira o sal", "pode tirar o sal"]) {
    const phone = await customerWith({ basket: [biscoito, barra] });
    const out = await send(phone, text);
    assert.doesNotMatch(out, /Tirei/, `${text}: ${out}`);
    assert.match(out, /Não tem \*sal\* separado[\s\S]*Biscoito Aymoré Água e Sal 164g[\s\S]*Não tirei nada/, `${text}: ${out}`);
    assert.match(out, /tira o biscoito/, out);
    const ctx = await ctxOf(phone);
    assert.equal(ctx.basket?.length, 2, `${text}: a cesta continua com os 2 itens`);
  }
});

test("R15a-1: o resto da remoção segue igual (palavra que é o produto, item pedido com a palavra, sal grosso)", async (t) => {
  if (!dbOk) return t.skip();
  const condensado = line("mambo-1", "Leite Condensado Moça 395g", 7.9, "mambo", "Mambo", { ask: "leite condensado" });
  const biscoito = line("mambo-2", "Biscoito Água e Sal Adria 170g", 4.06, "mambo", "Mambo", { ask: "bolacha de água e sal" });
  const salGrosso = line("mambo-3", "Sal Grosso Cisne 1kg", 3.49, "mambo", "Mambo", { ask: "sal grosso" });
  let phone = await customerWith({ basket: [condensado, biscoito] });
  let out = await send(phone, "tira o leite");
  assert.match(out, /Tirei Leite Condensado Moça 395g/, out);
  phone = await customerWith({ basket: [biscoito, salGrosso] });
  out = await send(phone, "tira o sal grosso");
  assert.match(out, /Tirei Sal Grosso Cisne 1kg/, out);
  assert.equal((await ctxOf(phone)).basket?.map((b) => b.sku).join(","), "mambo-2");
  // Com um sal de verdade na cesta, "tira o sal" tira o sal e deixa o biscoito.
  phone = await customerWith({ basket: [biscoito, line("mambo-4", "Sal Refinado Cisne 1kg", 2.99, "mambo", "Mambo", { ask: "sal" })] });
  out = await send(phone, "tira o sal");
  assert.match(out, /Tirei Sal Refinado Cisne 1kg/, out);
  assert.equal((await ctxOf(phone)).basket?.map((b) => b.sku).join(","), "mambo-2");
  // O biscoito pedido pelo nome sai normalmente.
  phone = await customerWith({ basket: [biscoito, condensado] });
  out = await send(phone, "tira o biscoito");
  assert.match(out, /Tirei Biscoito Água e Sal Adria 170g/, out);
});

// ---------------- 2. R15a-2: itens fantasma e o nome perdido ----------------

const FILHO = "meu filho tem 5 anos, preciso de um brinquedo e um caderno de desenho, minha sogra chega amanhã";
const CAFE = "café da manhã domingo, 6 caixas de leite, uma dúzia de ovos, pão de forma, 200g de presunto, 200g de queijo mussarela fatiado, no máximo uns 100 reais";
const CAO = "meu cachorro tem 13 anos, um shih tzu, preciso de ração sênior de 1kg e tapete higiênico";

test("R15a-2: 'tem 5 anos' e 'café da manhã domingo' não são item; 'café' sozinho e 'café da manhã' sem dia seguem", () => {
  for (const phrase of ["tem 5 anos", "meu filho tem 5 anos", "café da manhã domingo", "almoço de domingo", "jantar sábado"]) {
    assert.equal(m.intents.isNonItemSegment(phrase), true, phrase);
  }
  for (const phrase of ["café", "café em pó", "café 500g", "pão de forma", "brinquedo"]) assert.equal(m.intents.isNonItemSegment(phrase), false, phrase);
  const phrases = m.intents.parseBasketLines(FILHO).map((l) => l.phrase).join(" | ");
  assert.doesNotMatch(phrases, /anos/, phrases);
});

test("R15a-2: a ração do shih tzu não sai em dobro quando a IA junta a raça na ração", async () => {
  const { resolveListItems } = await import("../src/lib/list-items");
  const det = resolveListItems(CAO);
  const merged = m.intents.mergeShoppingLines([{ phrase: "ração cachorro sênior shih tzu 1kg", qty: 1 }, { phrase: "tapete higiênico", qty: 1 }], det);
  assert.deepEqual(merged.map((l) => l.phrase), ["ração cachorro sênior shih tzu 1kg", "tapete higiênico"], JSON.stringify(merged));
  // A IA também pode deixar a raça de fora da ração: o trecho "um shih tzu" é o pet, não volta como item.
  const merged3 = m.intents.mergeShoppingLines([{ phrase: "ração cachorro sênior 1kg", qty: 1 }, { phrase: "tapete higiênico", qty: 1 }], det);
  assert.deepEqual(merged3.map((l) => l.phrase), ["ração cachorro sênior 1kg", "tapete higiênico"], JSON.stringify(merged3));
  for (const phrase of ["um shih tzu", "é um poodle", "shih tzu"]) assert.equal(m.intents.isNonItemSegment(phrase), true, phrase);
  for (const phrase of ["ração shih tzu", "petisco pro poodle", "salsicha"]) assert.equal(m.intents.isNonItemSegment(phrase), false, phrase);
  // A regra do trecho vizinho continua (rodada 6 A3): ração de outro trecho não troca de lugar.
  const det2 = resolveListItems("tenho um cachorro labrador e uma gata castrada. preciso de ração pro labrador 15kg e ração pra gata castrada");
  const merged2 = m.intents.mergeShoppingLines([{ phrase: "ração cachorro labrador 15kg", qty: 1 }, { phrase: "ração gato castrado", qty: 1 }], det2);
  assert.equal(merged2.filter((l) => /ra[cç][aã]o/i.test(l.phrase)).length, 2, JSON.stringify(merged2));
});

test("R15a-2: depois do cadastro, a lista com 'meu filho tem 5 anos' e com 'café da manhã domingo' não cria item fantasma", async (t) => {
  if (!dbOk) return t.skip();
  for (const [text, ghost] of [[FILHO, /tem 5 anos|\b5 anos\b/], [CAFE, /caf[eé] da manh[aã]/i], [CAO, /(^|\| )shih tzu( \||$)|anos/]] as const) {
    const phone = await customerWith({});
    const out = await send(phone, text);
    const ctx = await ctxOf(phone);
    const asked = [...(ctx.pending ?? []).map((p) => p.query), ...(ctx.basket ?? []).map((b) => b.ask ?? b.name), ...(ctx.notFound ?? [])].join(" | ");
    assert.doesNotMatch(asked, ghost, `${asked}\n${out.slice(0, 600)}`);
    // O que a Lia diz que não achou nunca é a frase de contexto (o catálogo do teste pode não ter algum produto).
    const missed = out.split("\n").filter((l) => /não achei|ficou de fora/i.test(l)).join("\n");
    assert.doesNotMatch(missed, /anos|caf[eé] da manh[aã]|shih tzu/i, out.slice(0, 600));
  }
});

test("R15a-2: 'Meu nome é João Pereira, CPF …, moro na …' guarda o nome e o CPF e não pede de novo", async (t) => {
  if (!dbOk) return t.skip();
  mockVtex();
  // O cadastro só pede nome + CPF com o remédio isento ligado (como em produção).
  const mip = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  t.after(() => {
    if (mip === undefined) delete process.env.LIA_MEDICINE_MIP;
    else process.env.LIA_MEDICINE_MIP = mip;
  });
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "Meu nome é João Pereira, CPF 529.982.247-25, moro na Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.match(out, /Endereço salvo/, out);
  assert.doesNotMatch(out, /nome completo|CPF/, out);
  const user = await m.prisma.user.findFirstOrThrow({ where: { phone } });
  assert.equal(user.cpfName, "João Pereira");
  assert.equal(user.cpf, "52998224725");
  assert.equal(m.address.introducedName("Meu nome é Maria da Silva e quero arroz"), "Maria da Silva");
  assert.equal(m.address.introducedName("me chamo Ana"), undefined);
});

// ---------------- 3. R15a-3: entrega em dois momentos e "fecha tudo junto" ----------------

test("R15a-3: 'a ração hoje e o resto outro dia, dá pra fazer dois pedidos?' é pergunta de prazo; pagador continua pagador", () => {
  for (const ask of [
    "quero a ração hoje e o resto outro dia, dá pra fazer dois pedidos?",
    "quero a ração hoje e o resto outro dia",
    "dá pra mandar o shampoo amanhã e a ração hoje, no mesmo endereço?",
    "não, é o mesmo endereço, só quero receber a ração antes"
  ]) {
    assert.equal(m.intents.asksSplitDeliveryByTime(ask), true, ask);
  }
  assert.equal(m.intents.asksSplitDeliveryByTime("cada um paga o seu, dá pra fazer dois pedidos?"), false);
  assert.equal(m.intents.asksSplitDeliveryByTime("dá pra entregar antes das 18h?"), false);
  assert.equal(m.intents.asksSplitDeliveryByTime("duas entregas: uma em casa e outra no trabalho"), false);
  assert.equal(m.intents.parseJoinStoresAsk("então fecha tudo junto"), null);
  assert.deepEqual(m.intents.parseJoinStoresAsk("junta tudo numa loja só e fecha"), {});
});

test("R15a-3: na cesta, 'dois pedidos' com o dia de cada parte responde o prazo das lojas, sem 'outra pessoa'", async (t) => {
  if (!dbOk) return t.skip();
  const racao = line("cobasi-1", "Ração Origens Cães Adultos 1kg", 30.69, "cobasi", "Cobasi", { ask: "ração cachorro 1kg", delivery: "1 dia útil" });
  const shampoo = line("cobasi-2", "Shampoo Neutro para Cachorro MyHug 500 ml", 25.08, "cobasi", "Cobasi", { ask: "shampoo cachorro", delivery: "1 dia útil" });
  for (const text of ["quero a ração hoje e o resto outro dia, dá pra fazer dois pedidos?", "dá pra mandar o shampoo amanhã e a ração hoje, no mesmo endereço?", "não, é o mesmo endereço, só quero receber a ração antes"]) {
    const phone = await customerWith({ basket: [racao, shampoo] });
    const out = await send(phone, text);
    assert.match(out, /Não consigo dividir a entrega de uma mesma loja/, `${text}: ${out}`);
    assert.match(out, /tudo vem pela \*Cobasi\*/, out);
    assert.doesNotMatch(out, /outra pessoa|Agendar hor[aá]rio/i, out);
  }
});

test("R15a-3: 'então fecha tudo junto' com a cesta numa loja só fecha e mostra o total", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  const racao = line("mambo-11", "Ração Origens Cães Adultos 1kg", 30.69, "mambo", "Mambo", { ask: "ração cachorro 1kg", delivery: "1 dia útil" });
  const shampoo = line("mambo-12", "Shampoo Neutro para Cachorro MyHug 500 ml", 25.08, "mambo", "Mambo", { ask: "shampoo cachorro", delivery: "1 dia útil" });
  const phone = await customerWith({ basket: [racao, shampoo] });
  const close = await send(phone, "então fecha tudo junto");
  assert.doesNotMatch(close, /Já está tudo numa loja só/, close.slice(0, 600));
  assert.match(close, /Seu pedido|Total/, close.slice(0, 900));
});
