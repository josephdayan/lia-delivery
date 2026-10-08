// Recomendação de ponta a ponta (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md, etapa
// EXECUTAR + APRENDER): cliente novo com pedido vago guardado até o CEP, cliente cadastrado com produto
// julgado, restrição, remédio isento por sintoma (com copy de cuidado e CPF no fluxo de sempre), sinal de
// alerta, flag desligada, "outras" = prateleiras novas, RecommendLog e "quero chocolate" fora da
// recomendação. Banco real (TEST_DATABASE_URL), WhatsApp mock, sem IA (OPENAI_API_KEY vazia: plano e juiz
// pelas regras). O mapa/tabelas de verdade são gerados e mudam: aqui entra um mapa de teste pequeno pela
// costura __setRecommendTablesForTests, com consultas que a cópia dos catálogos (Carrefour, Oba, Drogaria
// SP) responde.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DeliveryContext, PendingChoice } from "../src/lib/conversation-types";
import type { NeedTableEntry, ShelfNode, SymptomTableEntry } from "../src/lib/recommend/types";

// O registry de lojas lê as flags na importação: Drogaria SP (remédio isento) liga ANTES do import
// dinâmico do cérebro (em `before`).
process.env.LIA_ENABLE_DROGARIASP = "true";

type Brain = typeof import("../src/lib/delivery-service");
let brain: Brain;
let prisma: typeof import("../src/lib/prisma").prisma;
let copy: typeof import("../src/lib/lia-copy");
let setTables: typeof import("../src/lib/recommend/handle").__setRecommendTablesForTests;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5511${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];

const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = global.fetch;

// ---------- mapa e tabelas de teste ----------
const FOOD = ["carrefour", "oba"];
const SHELVES: ShelfNode[] = [
  { id: "t.chocolate", label: "Chocolates", domain: "mercado", query: "chocolate", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.sorvete", label: "Sorvetes", domain: "mercado", query: "sorvete", stores: FOOD, flags: ["cold"] },
  { id: "t.biscoito", label: "Biscoitos recheados", domain: "mercado", query: "biscoito recheado", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.pudim", label: "Pudins", domain: "mercado", query: "pudim", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.wafer", label: "Wafers", domain: "mercado", query: "wafer", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.geleia", label: "Geleias", domain: "mercado", query: "geleia", stores: FOOD },
  { id: "t.antigases", label: "Antigases", domain: "farmacia", query: "simeticona", stores: ["drogariasp"], flags: ["mip"] },
  { id: "t.antiespasmodico", label: "Antiespasmódicos", domain: "farmacia", query: "buscopan", stores: ["drogariasp"], flags: ["mip"] }
];
const NEEDS: NeedTableEntry[] = [
  {
    keys: ["algo doce", "doce", "alguma coisa doce", "algo gostoso pra comer", "algo gostoso"],
    picks: [
      { shelfId: "t.chocolate", query: "chocolate", why: "doce pronto pra comer" },
      { shelfId: "t.sorvete", query: "sorvete", why: "doce e gelado" },
      { shelfId: "t.biscoito", query: "biscoito recheado", why: "pacote pronto" },
      { shelfId: "t.pudim", query: "pudim", why: "sobremesa pronta" },
      { shelfId: "t.wafer", query: "wafer", why: "crocante pra beliscar" },
      { shelfId: "t.geleia", query: "geleia", why: "doce de fruta" }
    ]
  }
];
const SYMPTOMS: SymptomTableEntry[] = [
  {
    keys: ["dor de barriga"],
    picks: [
      { shelfId: "t.antigases", query: "simeticona | luftal", why: "alivia gases e estufamento", mipClass: "antigases" },
      { shelfId: "t.antiespasmodico", query: "buscopan | butilescopolamina", why: "alivia a cólica abdominal", mipClass: "antiespasmodico" }
    ]
  }
];
const CHOCOLATE_RE = /chocolate|bombom|trufa|cacau|brigadeiro|nutella|kinder|baton|talento|milka|bis\b/i;

// ---------- harness ----------
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await brain.runTurnScoped(() => brain.handleDeliveryMessage({ phone, text, messageId: `rece2e_${RUN}_${++seq}` }));
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  // SHOW_TRANSCRIPT=1 imprime a conversa (inspeção manual da copy).
  if (process.env.SHOW_TRANSCRIPT) console.log(`> ${text}\n${out}\n`);
  return out;
}
const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function registered(over: { cpf?: string | null; cpfName?: string | null; name?: string | null } = {}) {
  const phone = newPhone();
  await prisma.user.create({
    data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva", ...over }
  });
  return phone;
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
const top = (ctx: DeliveryContext): PendingChoice | undefined => ctx.pending?.[0];
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.recommendLog.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  brain = await import("../src/lib/delivery-service");
  ({ prisma } = await import("../src/lib/prisma"));
  copy = await import("../src/lib/lia-copy");
  const handle = await import("../src/lib/recommend/handle");
  setTables = handle.__setRecommendTablesForTests;
  const { tableDepsFrom } = await import("../src/lib/recommend/fallback");
  const { RED_FLAGS } = await import("../src/lib/recommend/tables");
  setTables(tableDepsFrom({ generatedAt: "teste", shelves: SHELVES }, { NEED_TABLE: NEEDS, SYMPTOM_TABLE: SYMPTOMS, RED_FLAGS }));
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
    if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
    (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
      outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
      return key === "sendDeliveryChoices" || key === "sendChoiceFollowUp" ? false : { provider: "test", to };
    };
  }
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
    if (m) return new Response(JSON.stringify(VIACEP[m[1]] ?? { erro: true }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
beforeEach(() => {
  process.env.LIA_RECOMMEND = "all"; // "ligada" (08/10, noite: o padrão de produção é "test", só admins)
  delete process.env.LIA_MEDICINE_MIP;
});
after(async () => {
  setTables?.(null);
  global.fetch = realFetch;
  delete process.env.LIA_MEDICINE_MIP;
  if (dbOk) await wipe();
  await prisma?.$disconnect();
});

// ---------- (1) cliente novo: pedido vago → CEP → 4 cards → "o 2" → cesta → total ----------
test("cliente novo: 'tô com muita fome, quero algo doce' guarda a frase, pede o CEP e depois mostra 4 cards de tipos distintos com motivo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await prisma.user.create({ data: { phone } });
  const text = "tô com muita fome, quero algo doce";
  const first = await send(phone, text);
  assert.match(first, /endere[cç]o|CEP/i, first);
  assert.match(first, /recomenda[cç][aã]o de algo doce/i, "anota a recomendação, não o pedaço da frase");
  assert.doesNotMatch(first, /1x t[oô] com muita fome/i);
  assert.equal((await ctxOf(phone)).pendingRecommend, text, "a frase inteira fica guardada");

  const cards = await send(phone, "Av Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.match(cards, /Pra matar a vontade de doce/, cards);
  const ctx = await ctxOf(phone);
  const p = top(ctx);
  assert.ok(p?.recommendation, "escolha de recomendação na mesa");
  assert.equal(ctx.step, "choosing");
  assert.equal(ctx.pendingRecommend, undefined);
  assert.equal(p!.options.length, 4, `4 cards: ${p!.options.map((o) => o.name).join(" | ")}`);
  assert.equal(new Set(p!.recommendation!.shownShelfIds).size, 4, "um card por prateleira");
  for (const o of p!.options) assert.ok(o.why, `card sem motivo: ${o.name}`);
  assert.match(cards, /· _[^_]+_ —/, "o motivo aparece na lista de texto");
  assert.equal(p!.recommendation!.request.source, "presignup");

  const second = p!.options[1];
  const picked = await send(phone, "o 2");
  assert.match(picked, new RegExp(second.name.slice(0, 15).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const afterPick = await ctxOf(phone);
  assert.ok(afterPick.basket?.some((b) => b.sku === second.sku), "o 2 entrou na cesta");

  // (8) APRENDER: o log fecha com a escolha.
  const log = await prisma.recommendLog.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
  assert.equal(log.outcome, "chosen");
  assert.equal(log.chosenSku, `${second.storeKey}:${second.sku}`);
  assert.equal(log.form, "need");
  assert.equal(log.need, "algo doce");
  assert.equal((log.cardSkus as string[]).length, 4);
  assert.equal(log.planSource, "table");

  const total = await send(phone, "só isso");
  assert.match(total, /R\$/, total);
  assert.notEqual((await ctxOf(phone)).step, "choosing");
});

// ---------- (2) cadastrado: produto julgado → cards → "mais barato" reordena ----------
test("cadastrado: 'me recomenda um chocolate bom' mostra chocolates; 'mais barato' reordena pelo preço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  const out = await send(phone, "me recomenda um chocolate bom");
  assert.match(out, /Chocolate bom\? Separei estes/, out);
  const p = top(await ctxOf(phone))!;
  assert.equal(p.recommendation?.request.form, "product_judged");
  assert.ok(p.options.length >= 2, "produto julgado completa com os próximos melhores da prateleira");
  for (const o of p.options) assert.match(o.name, CHOCOLATE_RE, o.name);
  const minBefore = Math.min(...p.options.map((o) => o.unitPrice));

  const cheaper = await send(phone, "mais barato");
  assert.match(cheaper, /As mais baratas de \*chocolate bom\*/, cheaper);
  const q = top(await ctxOf(phone))!;
  const prices = q.options.map((o) => o.unitPrice);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "do mais barato ao mais caro");
  assert.ok(prices[0] <= minBefore, "o primeiro é o mais barato que havia");
  assert.deepEqual(q.recommendation?.request.criteria, ["cheap"]);
});

// ---------- (3) restrição ----------
test("'algo doce sem chocolate': nenhum card com chocolate", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  await send(phone, "algo doce sem chocolate");
  const p = top(await ctxOf(phone))!;
  assert.ok(p?.recommendation, "recomendou");
  assert.ok(p.options.length >= 2, p.options.map((o) => o.name).join(" | "));
  for (const o of p.options) assert.doesNotMatch(o.name, CHOCOLATE_RE, o.name);
  assert.ok(!p.recommendation!.shownShelfIds.includes("t.chocolate"));
});

// ---------- (4) remédio isento por sintoma ----------
test("'tô com dor de barriga' (LIA_MEDICINE_MIP=true): copy de cuidado antes, só cards de remédio isento; escolher segue para o CPF de sempre", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  const phone = await registered({ cpf: null, cpfName: null, name: "Maria da Silva" });
  const out = await send(phone, "tô com dor de barriga");
  const care = out.indexOf(copy.recommendMedicineCare());
  assert.ok(care >= 0, out);
  assert.ok(care < out.indexOf("Pra dor de barriga"), "cuidado ANTES dos cards");
  const p = top(await ctxOf(phone))!;
  assert.ok(p.options.length >= 1);
  for (const o of p.options) assert.equal(o.medicine, "mip", o.name);
  assert.doesNotMatch(out, /Indicar remédio eu não posso/, "a copy antiga de sintoma saiu de cena");
  await send(phone, "o 1");
  assert.ok((await ctxOf(phone)).basket?.some((b) => b.medicine === "mip"));
  const close = await send(phone, "só isso");
  assert.match(close, /CPF/, close);
  assert.equal((await ctxOf(phone)).step, "need_cpf");
});

// ---------- (5) sinal de alerta ----------
test("'dor de barriga com sangue': alerta, zero card, nada pendente; log red_flag", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  const phone = await registered();
  const out = await send(phone, "dor de barriga com sangue");
  assert.equal(out, copy.recommendRedFlag("sangue"));
  const ctx = await ctxOf(phone);
  assert.ok(!ctx.pending?.length, "nada na mesa");
  const log = await prisma.recommendLog.findFirstOrThrow({ where: { phone } });
  assert.equal(log.outcome, "red_flag");
  assert.equal(log.redFlag, "sangue");
});

// ---------- (6) flag desligada ----------
test("LIA_RECOMMEND=false: pedido vago recebe a copy de sempre; ligada, vira cards", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_RECOMMEND = "false";
  const off = await registered();
  const out = await send(off, "algo gostoso pra comer");
  assert.equal(out, copy.vagueRequestAnswer());
  assert.ok(!top(await ctxOf(off))?.recommendation);
  assert.equal(await prisma.recommendLog.count({ where: { phone: off } }), 0);
  process.env.LIA_RECOMMEND = "all"; // "ligada" (08/10, noite: o padrão de produção é "test", só admins)
  const on = await registered();
  await send(on, "algo gostoso pra comer");
  assert.ok(top(await ctxOf(on))?.recommendation, "com a flag ligada, recomenda");
});

// ---------- (7) "outras" ----------
test("'outras' sobre a recomendação mostra prateleiras que ainda não apareceram", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  await send(phone, "quero algo doce");
  const before = top(await ctxOf(phone))!;
  const shelvesBefore = [...before.recommendation!.shownShelfIds];
  assert.equal(shelvesBefore.length, 4);
  const more = await send(phone, "outras");
  assert.match(more, /Mais opções de \*algo doce\*/, more);
  const after = top(await ctxOf(phone))!;
  assert.ok(after.options.length >= 1);
  const skusBefore = new Set(before.options.map((o) => o.sku));
  for (const o of after.options) assert.ok(!skusBefore.has(o.sku), `repetiu ${o.name}`);
  const fresh = after.recommendation!.shownShelfIds.filter((id) => !shelvesBefore.includes(id));
  assert.ok(fresh.length >= 1, "prateleira nova");
  // Escolher um card antigo (de antes do "outras") ainda funciona pelo histórico.
  assert.ok(after.shownOptions?.some((o) => o.sku === before.options[0].sku));
});

// ---------- (9) produto nomeado sem julgamento ----------
test("'quero chocolate' NÃO vira recomendação (busca de sempre)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  const out = await send(phone, "quero chocolate");
  const ctx = await ctxOf(phone);
  assert.ok(!top(ctx)?.recommendation, "sem recomendação");
  assert.doesNotMatch(out, /Separei estes|matar a vontade/);
  assert.equal(await prisma.recommendLog.count({ where: { phone } }), 0);
  assert.ok(ctx.pending?.length || ctx.basket?.length, out);
});

// ---------- refino sobre a recomendação ----------
test("refino na tela: 'sem chocolate' refaz a recomendação sem chocolate; 'de morango' exige a palavra", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  const first = await send(phone, "quero algo doce");
  const out = await send(phone, "sem chocolate");
  const p = top(await ctxOf(phone))!;
  assert.ok(p.recommendation?.request.constraints.includes("sem chocolate"), JSON.stringify(p.recommendation?.request));
  for (const o of p.options) assert.doesNotMatch(o.name, CHOCOLATE_RE, o.name);
  assert.ok(!(await ctxOf(phone)).basket?.length, "não virou remoção da cesta");
  const flavor = await send(phone, "tem de morango?");
  const q = top(await ctxOf(phone))!;
  assert.ok(q.recommendation, "continua sendo recomendação");
  assert.ok(q.options.length >= 1, flavor);
  for (const o of q.options) assert.match(o.name, /morango/i, "todo card tem a palavra pedida");
  for (const o of q.options) assert.doesNotMatch(o.name, CHOCOLATE_RE, "a restrição anterior continua valendo");
  assert.equal(q.query, "algo doce de morango");
});
