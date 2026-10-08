// Memória do cliente (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md, fase 2) + o tom do alerta
// por tipo (revisão de segurança 08/10). Parte PURA (extração conservadora do que o cliente disse sobre
// si, fusão sem duplicar, marcas 2+ por prateleira, copy do alerta) e E2E com banco real: "sou intolerante
// a lactose" → "Anotado"; depois "tô com fome, quero algo doce" → nenhum card de laticínio + a nota de
// memória; 2 pedidos pagos da marca X → "me recomenda um chocolate bom" mostra X primeiro com o motivo;
// emergência sai antes de pedir o CEP. Mapa/tabelas de teste pela costura (como o E2E da recomendação).
//
// Decisão documentada (08/10): restrição de ALGUÉM DA CASA ("meu filho é diabético") vale como a do
// cliente (ele compra pra casa; filtrar só tira opção), marcada `who: "household"` + quem é. Restrição de
// pet ("meu cachorro é diabético") não é restrição de gente e não grava.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { DeliveryContext } from "../src/lib/conversation-types";
import type { NeedTableEntry, ShelfNode } from "../src/lib/recommend/types";
import { buildMemory, extractStatements, isStatementOnly, mergeStatements, parseForget, type Statement } from "../src/lib/recommend/memory";
import { recommendRedFlag } from "../src/lib/lia-copy";

// ---------------------------------------------------------------- puro

const POSITIVE: [string, Partial<Statement>][] = [
  ["sou intolerante a lactose", { kind: "restriction", key: "lactose", who: "self" }],
  ["tenho intolerância à lactose", { kind: "restriction", key: "lactose" }],
  ["sou diabético", { kind: "restriction", key: "diabetes" }],
  ["sou diabética, tem chocolate diet?", { kind: "restriction", key: "diabetes" }],
  ["sou vegano", { kind: "restriction", key: "vegano" }],
  ["sou vegetariana", { kind: "restriction", key: "vegetariano" }],
  ["sou celíaco", { kind: "restriction", key: "gluten" }],
  ["tenho doença celíaca", { kind: "restriction", key: "gluten" }],
  ["sou alérgico a amendoim", { kind: "restriction", key: "amendoim" }],
  ["sou alérgica a camarão", { kind: "restriction", key: "frutos_do_mar" }],
  ["não como carne", { kind: "restriction", key: "carne" }],
  ["eu não como carne de porco", { kind: "restriction", key: "porco" }],
  ["tenho alergia a dipirona", { kind: "restriction", key: "alergia:dipirona" }],
  ["meu filho é diabético", { kind: "restriction", key: "diabetes", who: "household", whoLabel: "seu filho" }],
  ["minha esposa é celíaca", { kind: "restriction", key: "gluten", who: "household", whoLabel: "sua esposa" }],
  ["meu marido tem intolerância a lactose", { kind: "restriction", key: "lactose", who: "household" }],
  ["minha filha não come glúten", { kind: "restriction", key: "gluten", who: "household" }],
  ["tenho um cachorro grande", { kind: "pet", species: "cachorro", size: "grande" }],
  ["tenho uma gata", { kind: "pet", species: "gato" }],
  ["meu cachorro é pequeno", { kind: "pet", species: "cachorro", size: "pequeno" }],
  ["somos 4 em casa", { kind: "household", people: 4 }],
  ["moro sozinho", { kind: "household", people: 1 }],
  ["aqui em casa somos 3", { kind: "household", people: 3 }]
];

const NEGATIVE = [
  "sem lactose",
  "quero leite sem lactose",
  "não sou vegano",
  "você é vegano?",
  "tem sem glúten?",
  "tenho um amigo vegano",
  "tô com fome",
  "sou de são paulo",
  "presente pra minha gata",
  "sou alérgico a poeira",
  "quero chocolate diet",
  "esse é vegano?",
  "não tenho intolerância",
  "somos 8 no churrasco",
  "tenho que comprar ração",
  "me recomenda algo vegano",
  "eu sou o joão",
  "meu gato chegou atrasado"
];

test("extractStatements: declarações explícitas sobre si (e quem é da casa) viram memória", () => {
  assert.ok(POSITIVE.length >= 20);
  for (const [text, want] of POSITIVE) {
    const got = extractStatements(text);
    assert.equal(got.length, 1, `${text} → ${JSON.stringify(got)}`);
    for (const [k, v] of Object.entries(want)) assert.equal((got[0] as Record<string, unknown>)[k], v, `${text}: ${k}`);
  }
});

test("extractStatements: pedido, pergunta, negação, terceiro de fora da casa e gíria nunca viram memória", () => {
  assert.ok(NEGATIVE.length >= 15);
  for (const text of NEGATIVE) assert.deepEqual(extractStatements(text), [], text);
  // Pet doente é do pet: nenhuma restrição de gente (só a espécie, que é fato).
  assert.ok(!extractStatements("meu cachorro é diabético").some((s) => s.kind === "restriction"));
});

test("isStatementOnly: só a declaração (com enfeite) responde 'Anotado'; junto de pedido, não", () => {
  assert.equal(isStatementOnly("sou intolerante a lactose"), true);
  assert.equal(isStatementOnly("oi, só pra você saber: sou vegano"), true);
  assert.equal(isStatementOnly("sou diabética, tem chocolate diet?"), false);
  assert.equal(isStatementOnly("ração pro meu cachorro"), false);
});

test("parseForget: 'esquece minhas preferências' apaga tudo; 'não sou mais vegano' tira uma", () => {
  assert.deepEqual(parseForget("esquece minhas preferências"), { all: true });
  assert.deepEqual(parseForget("não sou mais vegano"), { keys: ["vegano"] });
  assert.ok((parseForget("voltei a comer carne") as { keys: string[] }).keys.includes("carne"));
  assert.equal(parseForget("quero carne"), null);
});

test("mergeStatements: não duplica; pet/casa novos substituem; devolve só o que é novo", () => {
  const a = mergeStatements({ v: 1, restrictions: [] }, extractStatements("sou intolerante a lactose"), "2026-10-08T10:00:00Z");
  assert.deepEqual(a.saved, ["sem lactose"]);
  const b = mergeStatements(a.prefs, extractStatements("tenho intolerância à lactose"), "2026-10-09T10:00:00Z");
  assert.deepEqual(b.saved, []);
  assert.equal(b.prefs.restrictions.length, 1);
  assert.equal(b.prefs.restrictions[0].at, "2026-10-08T10:00:00Z", "a data é a de quando disse a 1ª vez");
  const c = mergeStatements(b.prefs, extractStatements("meu filho é diabético"));
  assert.deepEqual(c.saved, ["diabético (seu filho)"]);
});

test("buildMemory: marca de 2+ pedidos por prateleira; filtros das restrições ditas", () => {
  const shelves: ShelfNode[] = [
    { id: "t.chocolate", label: "Chocolates", domain: "mercado", query: "chocolate", stores: ["oba"] },
    { id: "t.cafe", label: "Café", domain: "mercado", query: "cafe", stores: ["oba"] }
  ];
  const mem = buildMemory(
    {
      prefs: { v: 1, restrictions: [{ key: "lactose", label: "sem lactose", who: "self", at: "x" }] },
      items: [
        { name: "Chocolate Milka Oreo 100g", brand: "MILKA", at: "2026-10-01", orderId: "o1" },
        { name: "Chocolate ao Leite Milka 90g", brand: "MILKA", at: "2026-09-01", orderId: "o2" },
        { name: "Café Melitta 500g", brand: "MELITTA", at: "2026-09-01", orderId: "o2" }
      ]
    },
    shelves
  );
  assert.deepEqual(mem.brands, [{ shelfId: "t.chocolate", brand: "MILKA", count: 2 }]);
  assert.deepEqual(mem.recentShelves.map((s) => s.shelfId), ["t.chocolate", "t.cafe"]);
  assert.ok(mem.restrictions.some((r) => r.text === "sem lactose"));
});

test("alerta por tipo: emergência → SAMU 192; contexto → médico/pediatra + compra se nomear; pet → veterinário, sem SAMU", () => {
  const emergency = recommendRedFlag("dor no peito");
  assert.match(emergency, /192/);
  assert.match(emergency, /pronto-socorro/);
  assert.equal(recommendRedFlag("sangue"), recommendRedFlag("sangue", "emergency"), "sem kind, o tipo sai do motivo");
  const context = recommendRedFlag("gestante ou amamentando", "context");
  assert.match(context, /m[ée]dico|farmac[eê]utico/);
  assert.match(context, /sem receita\*?, me diz o nome que eu compro/);
  assert.doesNotMatch(context, /192/);
  assert.match(recommendRedFlag("bebê ou criança pequena"), /pediatra/);
  const pet = recommendRedFlag("pet doente: só veterinário", "context");
  assert.match(pet, /veterin[áa]rio/);
  assert.match(pet, /n[ãa]o indico/);
  assert.doesNotMatch(pet, /192|SAMU/);
});

// ---------------------------------------------------------------- E2E

type Brain = typeof import("../src/lib/delivery-service");
let brain: Brain;
let prisma: typeof import("../src/lib/prisma").prisma;
let copy: typeof import("../src/lib/lia-copy");
let setTables: typeof import("../src/lib/recommend/handle").__setRecommendTablesForTests;
let fallback: typeof import("../src/lib/recommend/fallback");

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5511${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];

const FOOD = ["carrefour", "oba"];
const SHELVES: ShelfNode[] = [
  { id: "t.chocolate", label: "Chocolates", domain: "mercado", query: "chocolate", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.sorvete", label: "Sorvetes", domain: "mercado", query: "sorvete", stores: FOOD, flags: ["cold"] },
  { id: "t.biscoito", label: "Biscoitos recheados", domain: "mercado", query: "biscoito recheado", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.pudim", label: "Pudins", domain: "mercado", query: "pudim", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.wafer", label: "Wafers", domain: "mercado", query: "wafer", stores: FOOD, flags: ["ready_to_eat"] },
  { id: "t.geleia", label: "Geleias", domain: "mercado", query: "geleia", stores: FOOD }
];
const NEEDS: NeedTableEntry[] = [
  {
    keys: ["algo doce", "doce"],
    picks: [
      { shelfId: "t.chocolate", query: "chocolate", why: "o doce mais pedido" },
      { shelfId: "t.sorvete", query: "sorvete", why: "doce e gelado" },
      { shelfId: "t.biscoito", query: "biscoito recheado", why: "pacote pronto" },
      { shelfId: "t.pudim", query: "pudim", why: "sobremesa pronta" },
      { shelfId: "t.wafer", query: "wafer", why: "crocante pra beliscar" },
      { shelfId: "t.geleia", query: "geleia", why: "doce de fruta" }
    ]
  }
];

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await brain.runTurnScoped(() => brain.handleDeliveryMessage({ phone, text, messageId: `recmem_${RUN}_${++seq}` }));
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  if (process.env.SHOW_TRANSCRIPT) console.log(`> ${text}\n${out}\n`);
  return out;
}
const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function registered(over: Record<string, unknown> = {}) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva", ...over } });
  return { phone, userId: user.id };
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
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
  fallback = await import("../src/lib/recommend/fallback");
  const handle = await import("../src/lib/recommend/handle");
  setTables = handle.__setRecommendTablesForTests;
  const { RED_FLAGS } = await import("../src/lib/recommend/tables");
  setTables(fallback.tableDepsFrom({ generatedAt: "teste", shelves: SHELVES }, { NEED_TABLE: NEEDS, SYMPTOM_TABLE: [], RED_FLAGS }));
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
    if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
    (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
      outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
      return key === "sendDeliveryChoices" || key === "sendChoiceFollowUp" ? false : { provider: "test", to };
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
  setTables?.(null);
  if (dbOk) await wipe();
  await prisma?.$disconnect();
});

test("E2E: 'sou intolerante a lactose' → Anotado; 'tô com fome, quero algo doce' → nenhum laticínio + nota de memória", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, userId } = await registered();
  const saved = await send(phone, "sou intolerante a lactose");
  assert.equal(saved, copy.preferenceSaved(["sem lactose"]));
  const prefs = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).preferences as { restrictions: { key: string; at: string }[] };
  assert.equal(prefs.restrictions[0].key, "lactose");
  assert.ok(prefs.restrictions[0].at, "com a data");
  // Repetir não duplica.
  await send(phone, "tenho intolerância à lactose");
  assert.equal(((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).preferences as { restrictions: unknown[] }).restrictions.length, 1);

  const out = await send(phone, "tô com fome, quero algo doce");
  assert.ok(out.includes(copy.recommendMemoryNote(["sem lactose"])), out);
  const p = (await ctxOf(phone)).pending?.[0];
  assert.ok(p?.recommendation, out);
  assert.ok(p!.options.length >= 1);
  const rules = fallback.constraintRules(["sem lactose"]);
  for (const o of p!.options) assert.equal(fallback.violatesConstraint(`${o.name} ${o.brand ?? ""}`, rules), false, `laticínio na tela: ${o.name}`);
  assert.ok(!p!.recommendation!.shownShelfIds.includes("t.sorvete"));
});

test("E2E: sem memória não há nota; 'esquece minhas preferências' apaga e a nota some", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, userId } = await registered();
  await send(phone, "sou vegano");
  const forgot = await send(phone, "esquece minhas preferências");
  assert.equal(forgot, copy.preferencesForgotten(["vegano"]));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).preferences, null);
  const out = await send(phone, "quero algo doce");
  assert.doesNotMatch(out, /Lembrei/);
});

test("E2E: declaração junto do pedido grava sem resposta extra e já vale no mesmo turno", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, userId } = await registered();
  const out = await send(phone, "sou intolerante a lactose, me indica algo doce");
  assert.doesNotMatch(out, /Anotado/);
  assert.ok(((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).preferences as { restrictions: unknown[] })?.restrictions.length === 1);
  const p = (await ctxOf(phone)).pending?.[0];
  if (p?.recommendation) {
    const rules = fallback.constraintRules(["sem lactose"]);
    for (const o of p.options) assert.equal(fallback.violatesConstraint(o.name, rules), false, o.name);
  }
});

test("E2E: 2 pedidos pagos da marca X → 'me recomenda um chocolate bom' mostra X primeiro, com o motivo", async (t) => {
  if (!dbOk) return t.skip();
  const { phone, userId } = await registered();
  // Sem memória: qual seria o 1º? (a marca escolhida tem que ser outra, pra o teste provar algo).
  const control = await registered();
  await send(control.phone, "me recomenda um chocolate bom");
  const shown = (await ctxOf(control.phone)).pending?.[0]?.options ?? [];
  const usual = shown.slice(1).find((o) => o.brand) ?? shown.find((o) => o.brand && o !== shown[0]);
  assert.ok(usual?.brand, `precisa de um chocolate com marca fora do 1º: ${shown.map((o) => `${o.name} [${o.brand}]`).join(" | ")}`);
  for (const id of ["a", "b"]) {
    await prisma.deliveryOrder.create({
      data: {
        userId,
        phone,
        storeKey: usual!.storeKey ?? "oba",
        storeLabel: usual!.storeLabel ?? "Oba",
        items: [{ sku: `${usual!.sku}-${id}`, name: `Chocolate ${usual!.brand} ${id}`, brand: usual!.brand, qty: 1, unitPrice: 10, lineTotal: 10, storeKey: usual!.storeKey ?? "oba", storeLabel: "Oba" }],
        status: "delivered"
      }
    });
  }
  await send(phone, "me recomenda um chocolate bom");
  const p = (await ctxOf(phone)).pending?.[0];
  assert.ok(p?.recommendation);
  assert.equal(p!.options[0].brand, usual!.brand, p!.options.map((o) => `${o.name} [${o.brand}]`).join(" | "));
  assert.equal(p!.options[0].why, copy.usualBrandWhy());
  // "mais barato" (critério preço) não força a marca.
  await send(phone, "mais barato");
  const q = (await ctxOf(phone)).pending?.[0];
  const prices = q!.options.map((o) => o.unitPrice);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test("E2E: emergência sai na hora, antes de pedir o CEP (cliente sem CEP)", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await registered({ cep: null });
  const { handleRecommend } = await import("../src/lib/recommend/handle");
  const ctx: DeliveryContext = {};
  const start = outbox.length;
  await brain.runTurnScoped(() =>
    handleRecommend({ phone, convoId: "sem-conversa", userCep: null, ctx }, { form: "need", text: "tô com dor no peito, me indica algo", need: "dor no peito", criteria: [], constraints: [], source: "regex" })
  );
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n");
  assert.equal(out, copy.recommendRedFlag("dor no peito", "emergency"));
  assert.equal(ctx.step, undefined, "não pediu CEP");
  assert.equal(ctx.pendingRecommend, undefined);
  const log = await prisma.recommendLog.findFirstOrThrow({ where: { phone } });
  assert.equal(log.outcome, "red_flag");
});
