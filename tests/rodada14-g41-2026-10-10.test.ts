// Rodada 14, grupo G41 (10/10): achados R14-5..R14-8 de /mnt/project-files/testes-whatsapp/rodada14/grupo-b.md (jornadas
// 302 a 308). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. (R14-5) "..., no máximo uns 100 reais" no fim da lista não virava orçamento (308) e o resumo de R$ 138,50 saía sem
//      aviso; com o limite estourado e o frete maior que os produtos (304), o resumo oferecia "juntar as lojas" logo depois
//      de a Lia dizer que não dava;
//   2. (R14-6) "hoje a gente vai fazer pizza" e "café da manhã ... domingo" não eram prazo (305/308); o carrossel com prazo
//      dito abria com opção que não chega (307);
//   3. (R14-7) "dá pra separar em duas entregas? a ração hoje e o resto outro dia" virava "um pedido por endereço"; "então
//      deixa tudo junto, fecha" virava pedido de juntar lojas e não fechava (306);
//   4. (R14-8) faxina em 4 entregas (303): a troca da entrega cara só conferia as 2 lojas de frete mais alto.
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
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g41_${RUN}_${++seq}` }));
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

const CAFE_308 = "queria fazer um café da manhã bom pra família domingo: 6 caixas de leite, uma dúzia de ovos, pão de forma, 200g de presunto e 200g de queijo mussarela fatiado, no máximo uns 100 reais";
const PIZZA_305 = "hoje a gente vai fazer pizza em casa: massa de pizza, molho de tomate, queijo mussarela, calabresa e azeitona";

// ---------------- 1. R14-5 / R14-6: orçamento e prazo ditos na lista ----------------

test("R14-5 (308): '..., no máximo uns 100 reais' no fim da lista é o orçamento do pedido; teto colado no item segue do item", () => {
  const found = m.intents.parseOrderBudget(CAFE_308);
  assert.equal(found?.cap, 100);
  assert.doesNotMatch(found?.rest ?? "", /maximo|máximo|100/i, found?.rest);
  assert.match(found?.rest ?? "", /queijo mussarela fatiado$/);
  assert.equal(m.intents.parseOrderBudget("arroz, feijão e vinho até 40 reais"), null, "teto colado no último item é do item");
  assert.equal(m.intents.parseOrderBudget("2 vinhos até 40"), null);
  assert.equal(m.intents.parseOrderBudget("arroz, feijão, óleo de soja, até 50 reais")?.cap, 50);
});

test("R14-6 (305/308): 'hoje a gente vai fazer pizza' e 'café da manhã ... domingo' são prazo; sem dia, não", () => {
  const now = new Date("2026-10-10T15:00:00Z"); // sábado
  assert.deepEqual(m.intents.parseNeededBy(PIZZA_305, now), { date: "2026-10-10", label: "hoje" });
  assert.deepEqual(m.intents.parseNeededBy(CAFE_308, now), { date: "2026-10-11", label: "domingo" });
  assert.equal(m.intents.parseNeededBy("domingo vamos receber a família: carne e carvão", now)?.label, "domingo");
  assert.equal(m.intents.parseNeededBy("massa de pizza, molho e calabresa", now), null);
  assert.equal(m.intents.parseNeededBy("hoje não vou fazer nada, só quero arroz e feijão", now), null);
  assert.equal(m.intents.parseNeededBy("quero fazer um bolo: farinha, ovos e açúcar", now), null);
});

test("R14-5/6 (308): antes do cadastro, o 'Anotei' mostra o orçamento e o dia (com e sem a IA do pré-cadastro)", async (t) => {
  if (!dbOk) return t.skip();
  for (const llm of [false, true]) {
    if (llm) {
      process.env.LIA_DIALOGUE_LLM = "true";
      const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });
      m.presignup.__setPreSignupModelForTests(async () => ({ items: [it("leite", 6), it("ovos", 12), it("pão de forma"), it("presunto 200g"), it("queijo mussarela fatiado 200g")], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false }));
    }
    const phone = newPhone();
    await send(phone, "oi");
    const out = await send(phone, CAFE_308);
    assert.match(out, /💰 Até \*R\$ 100,00\*/, `llm=${llm}: ${out.slice(0, 700)}`);
    assert.match(out, /⏰[^\n]*\*domingo\*/, `llm=${llm}: ${out.slice(0, 700)}`);
    assert.doesNotMatch(out, /no m[aá]ximo/i, "o teto não vira item");
    const ctx = await ctxOf(phone);
    assert.equal(ctx.orderBudget?.cap, 100);
    assert.equal(ctx.neededBy?.label, "domingo");
  }
});

test("R14-5 (304): resumo acima do limite com frete maior que os produtos e juntar descartado — diz o frete e não oferece juntar", () => {
  const base = { items: [{ qty: 2, name: "Caderno Universitário Stiff", lineTotal: 26.38 }, { qty: 1, name: "Tesoura Escolar 14cm Leonora", lineTotal: 8.79 }], produtos: 51.62, frete: 52.1, total: 103.72, deliveries: 2, overBudget: { cap: 80, priciest: { name: "Caderno Universitário Stiff", lineTotal: 26.38 } } };
  const ruled = m.copy.manualQuoteSummary({ ...base, joinRuledOut: true });
  assert.match(ruled, /Passou do seu limite de \*R\$ 80,00\*: deu \*R\$ 103,72\*/, ruled);
  assert.match(ruled, /A entrega \(R\$ 52,10, 2 lojas\) ficou maior que os produtos \(R\$ 51,62\)/, ruled);
  assert.doesNotMatch(ruled, /juntar|junto em menos/i, ruled);
  assert.match(ruled, /tirar \*Caderno Universitário Stiff\*[\s\S]*trocar um item por uma opção de loja que já está no pedido/, ruled);
  assert.doesNotMatch(ruled, /somar mais coisa/, "com o limite estourado não sugere somar item");
  // Sem a junção descartada, a oferta de juntar continua (rodada 8).
  assert.match(m.copy.manualQuoteSummary(base), /\*juntar\* as lojas/);
  // 303: 3+ entregas, juntar já descartado no fechamento — o aviso de frete não promete "junto em menos lojas".
  const many = m.copy.expensiveShippingNote(52, 25.15, 3, true)[0];
  assert.match(many, /São 3 entregas/);
  assert.doesNotMatch(many, /junto em menos lojas/);
  assert.match(m.copy.expensiveShippingNote(52, 25.15, 3)[0], /junto em menos lojas/);
});

test("R14-5 (304): 'junta as lojas' sem como juntar e o resumo acima do limite não oferecem juntar de novo", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  // Nenhuma junção que a loja confirme.
  m.setPreflight(async (items) => ({ storeKey: items[0].storeKey, kind: "no-delivery", skus: [items[0].sku] }));
  const caderno = line("americanas-6397588", "Caderno Universitário Color Neon 10 Matérias", 34.99, "americanas", "Americanas", { ask: "caderno universitário", delivery: "2 dias úteis" });
  const leite = line("mambo-8057", "Leite Semidesnatado Longa Vida Parmalat 1 Litro", 35.49, "mambo", "Mambo", { ask: "leite", delivery: "amanhã" });
  const phone = await customerWith({ basket: [caderno, leite], orderBudget: { cap: 40 } });
  const join = await send(phone, "junta as lojas pra baixar o frete");
  assert.match(join, /Não achei os mesmos itens em menos lojas/, join.slice(0, 500));
  const out = await send(phone, "só isso");
  assert.match(out, /Passou do seu limite de \*R\$ 40,00\*[^\n]*A entrega \(R\$ [\d,]+, 2 lojas\) ficou maior que os produtos/, out.slice(0, 1200));
  assert.doesNotMatch(out.slice(out.indexOf("Passou do seu limite")), /juntar|junto em menos/i, out.slice(0, 1200));
});

test("R14-6 (307): com prazo dito, as opções que chegam a tempo vêm primeiro (ordem estável no resto)", () => {
  const now = new Date("2026-10-10T15:00:00Z"); // sábado; segunda = 2 dias
  const monday = { date: "2026-10-12", label: "segunda", morning: true };
  const opts = [
    { sku: "a", delivery: "Farmácia Indiana · 3 dias úteis" },
    { sku: "b", delivery: "Mambo · amanhã, 5h–8h" },
    { sku: "c", delivery: "Santa Luzia · 4 dias úteis" },
    { sku: "d", delivery: "Americanas · 2 dias úteis" }
  ];
  assert.deepEqual(m.service.onTimeFirst(opts, monday, now).map((o) => o.sku), ["b", "d", "a", "c"]);
  assert.deepEqual(m.service.onTimeFirst(opts, undefined, now).map((o) => o.sku), ["a", "b", "c", "d"], "sem prazo, nada muda");
  // 305: "amanhã, 5h–8h" não chega pra hoje (contava como "chega a tempo pra hoje").
  const today = { date: "2026-10-10", label: "hoje" };
  assert.deepEqual(m.service.onTimeFirst([{ sku: "m", delivery: "Mambo · amanhã, 5h–8h" }, { sku: "s", delivery: "Swift · 5h" }], today, now).map((o) => o.sku), ["s", "m"]);
  assert.equal(m.freight.promiseMissesDeadline("amanhã, 5h–8h", "2026-10-10", now), true);
  assert.equal(m.freight.promiseMissesDeadline("amanhã, 5h–8h", "2026-10-11", now), false);
  assert.equal(m.freight.promiseMissesDeadline("hoje, 12h–15h", "2026-10-10", now), false);
  const allLate = [{ sku: "x", delivery: "8 dias úteis" }, { sku: "y", delivery: "3 dias úteis" }];
  assert.deepEqual(m.service.onTimeFirst(allLate, monday, now).map((o) => o.sku), ["x", "y"]);
});

// ---------------- 2. R14-8: faxina em várias entregas ----------------

test("R14-8 (303): a troca da entrega cara confere TODAS as lojas de um item só — vale a 3ª quando as 2 de frete mais alto não têm troca", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  m.setPreflight(async (items) => ({ storeKey: items[0].storeKey, kind: "no-delivery", skus: [items[0].sku] }));
  // As 2 de frete mais alto só têm produto que as outras lojas não vendem; o guardanapo da Mambo (frete mais baixo) tem.
  const vela = { ...line("americanas-8817266", "Vela de Aniversário Treze Estrelas Nº 4", 38.99, "americanas", "Americanas", { ask: "vela de aniversário" }), freightFee: 20 };
  const ventosa = { ...line("drogariaspacheco-990001", "Ventosa Terapêutica Kit 12 Copos", 31.99, "drogariaspacheco", "Drogarias Pacheco", { ask: "ventosa terapêutica" }), freightFee: 18 };
  const guardanapo = { ...line("mambo-6911", "Guardanapo Kitchen 22,7cm x 22,8cm com 50 unidades", 3.62, "mambo", "Mambo", { ask: "guardanapo" }), freightFee: 15.9 };
  const phone = await customerWith({ basket: [vela, ventosa, guardanapo] });
  const out = await send(phone, "só isso");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[0]?.replaceSku, "mambo-6911", out.slice(0, 900));
  assert.match(out, /A da \*Mambo\* é só pro \*Guardanapo Kitchen/, out.slice(0, 900));
  // As opções são o mesmo produto (núcleo "guardanapo"), nunca algo só parecido.
  assert.ok((ctx.pending?.[0]?.options ?? []).every((o) => /guardanapo/i.test(o.name) && o.storeKey !== "mambo"), (ctx.pending?.[0]?.options ?? []).map((o) => o.name).join(" | "));
});

// ---------------- 3. R14-7: separar a entrega no tempo ----------------

test("R14-7 (306): 'separar em duas entregas, a ração hoje e o resto outro dia' é o mesmo endereço em dois momentos", () => {
  const ask = "dá pra separar em duas entregas? a ração hoje e o resto outro dia";
  assert.equal(m.intents.asksSplitDeliveryByTime(ask), true);
  assert.equal(m.intents.asksMultiAddress(ask), false);
  assert.equal(m.intents.asksSplitDeliveryByTime("só quero receber a ração antes e o resto depois"), true);
  // Dois lugares continuam pedido de dois endereços.
  assert.equal(m.intents.asksSplitDeliveryByTime("duas entregas: uma em casa e outra no trabalho"), false);
  assert.equal(m.intents.asksMultiAddress("duas entregas: uma em casa e outra no trabalho"), true);
  // "deixa tudo junto" é manter como está; "junta tudo numa loja só" segue pedido de juntar.
  assert.equal(m.intents.parseJoinStoresAsk("então deixa tudo junto, fecha"), null);
  assert.deepEqual(m.intents.parseJoinStoresAsk("junta tudo numa loja só"), {});
  assert.deepEqual(m.intents.parseJoinStoresAsk("manda tudo junto numa loja só"), {});
});

test("R14-7 (306): a resposta diz que cada loja entrega no prazo dela; 'então deixa tudo junto, fecha' fecha", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  const racao = line("mambo-286349", "Ração Origens Cães Senior Mini e Pequeno 1kg", 45.23, "mambo", "Mambo", { ask: "ração sênior", delivery: "amanhã" });
  const tapete = line("americanas-6397588", "Tapete Higiênico para Cães 7 unidades", 40.89, "americanas", "Americanas", { ask: "tapete higiênico", delivery: "3 dias úteis" });
  const phone = await customerWith({ basket: [racao, tapete] });
  const out = await send(phone, "dá pra separar em duas entregas? a ração hoje e o resto outro dia");
  assert.match(out, /Não consigo dividir a entrega de uma mesma loja/, out);
  assert.match(out, /\*Mambo\*[^\n]*\*amanhã\*[\s\S]*\*Americanas\*[^\n]*3 dias úteis/, out);
  assert.doesNotMatch(out, /dois pedidos|endereço só|trabalho/i, out);
  const close = await send(phone, "então deixa tudo junto, fecha");
  assert.doesNotMatch(close, /menos lojas/i, close.slice(0, 600));
  assert.match(close, /Seu pedido|Total/, close.slice(0, 900));
});

// ---------------- 4. Reteste da rodada 14 (grupo A): R14a-1, R14a-3, R14a-6 ----------------

const VISITA = "papel higiênico e 2 sabonetes de jasmim, a visita chega hoje";

test("R14a-1: lista com 'a visita chega hoje' é pedido com prazo, não pergunta de prazo", () => {
  for (const t of [VISITA, "preciso de papel higiênico e 2 sabonetes de jasmim, a visita chega hoje"]) {
    assert.equal(m.intents.deadlineWithItems(t), true, t);
    assert.equal(m.intents.asksDeadline(t), null, t);
    assert.equal(m.intents.asksDeliveryToday(t), false, t);
    assert.equal(m.intents.isOrderWithDeadline(t), true, t);
    assert.notEqual(m.intents.detectIntent(t), "status", t);
  }
  // Pergunta de prazo sem produto continua pergunta.
  for (const t of ["chega hoje?", "entrega hoje?", "consegue chegar até amanhã?"]) assert.equal(m.intents.deadlineWithItems(t), false, t);
  assert.equal(m.intents.asksDeliveryToday("entrega hoje?"), true);
  assert.ok(m.intents.asksDeadline("consegue chegar até amanhã?"));
  // A fala da ocasião não vira item.
  assert.ok(m.intents.parseBasketLines(VISITA).every((l) => !/visita/.test(l.phrase)), JSON.stringify(m.intents.parseBasketLines(VISITA)));
});

test("R14a-1: depois do cadastro, 'preciso de ..., a visita chega hoje' guarda o prazo E busca os itens", async (t) => {
  if (!dbOk) return t.skip();
  for (const text of ["preciso de papel higiênico e 2 sabonetes de jasmim, a visita chega hoje", VISITA]) {
    const phone = await customerWith({});
    const out = await send(phone, text);
    assert.doesNotMatch(out, /^Anotado: precisa chegar/m, out.slice(0, 600));
    const ctx = await ctxOf(phone);
    assert.equal(ctx.neededBy?.label, "hoje", out.slice(0, 600));
    const asked = [...(ctx.basket ?? []).map((b) => `${b.ask ?? ""} ${b.name}`), ...(ctx.pending ?? []).map((p) => p.query)].join(" | ");
    assert.match(`${asked} ${out}`, /papel higi[eê]nico/i, `${asked}\n${out.slice(0, 600)}`);
    assert.match(`${asked} ${out}`, /sabonete/i, `${asked}\n${out.slice(0, 600)}`);
    assert.doesNotMatch(asked, /visita/i, asked);
  }
});

test("R14a-3 (110): 'dia dos professores amanhã, ..., até 50 reais' guarda o prazo e o orçamento", () => {
  const now = new Date("2026-10-10T15:00:00Z");
  const text = "dia dos professores amanhã, uma caixa de bombom e um cartão de agradecimento ou vela, algo pequeno, até 50 reais";
  assert.deepEqual(m.intents.parseNeededBy(text, now), { date: "2026-10-11", label: "amanhã" });
  assert.equal(m.intents.parseOrderBudget(text)?.cap, 50);
  assert.equal(m.intents.parseNeededBy("dia das mães domingo: um vaso de flor", now)?.label, "domingo");
});

test("R14a-3 (110): depois de 'me manda o de sempre' sem histórico, o pedido seguinte guarda 💰 e ⏰", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  await send(phone, "me manda o de sempre");
  const out = await send(phone, "dia dos professores amanhã, uma caixa de bombom e um cartão de agradecimento ou vela, algo pequeno, até 50 reais");
  assert.match(out, /💰 Até \*R\$ 50,00\*/, out.slice(0, 700));
  assert.match(out, /⏰[^\n]*\*amanhã\*/, out.slice(0, 700));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.orderBudget?.cap, 50);
  assert.equal(ctx.neededBy?.label, "amanhã");
});

test("R14a-6: troca com nome bem diferente não diz 'outra versão do mesmo produto'; juntar mais lento é dito no resumo", () => {
  const note = m.copy.swapChangeNote("versao");
  assert.doesNotMatch(note, /outra versão do mesmo produto/, note);
  assert.match(note, /não é o mesmo produto/);
  assert.match(m.copy.swapChangeNote("marca", "Coca-Cola"), /muda a marca: não achei Coca-Cola/);
  // 3 lojas: juntar existe mas atrasa — a oferta não saiu sozinha, então o resumo diz como pedir.
  const slow = m.copy.expensiveShippingNote(60, 30, 3, false, { eta: "3 dias úteis", saving: 7.92 })[0];
  assert.match(slow, /dá pra juntar em menos lojas \(~R\$ 7,92 a menos\), mas chega em \*3 dias úteis\* — se quiser, diz \*junta\*/, slow);
  const summary = m.copy.manualQuoteSummary({ items: [{ qty: 1, name: "Vela", lineTotal: 20 }], produtos: 60, frete: 30, total: 90, deliveries: 3, joinSlower: { eta: "3 dias úteis", saving: 7.92 } });
  assert.match(summary, /diz \*junta\*/, summary);
});
