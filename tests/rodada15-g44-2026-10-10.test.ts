// Rodada 15, grupo G44 (10/10): achados R15-1..R15-5 de /mnt/project-files/testes-whatsapp/rodada15/grupo-b.md (jornadas
// 301 a 307). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. (R15-1) "lampda led 9w" ao lado de "lâmpada led 9w 4 unidades" virava 2 itens e 8 lâmpadas (306);
//   2. (R15-2) "4 pacotes dão 2 kg" na vitrine da linguiça e 1 pacote na cesta (302);
//   3. (R15-3) "3 de frango e 3 de carne whiskas" com os sachês de filhote na tela virava lista nova sem "filhote"; o nome
//      da loja no refino ("mostra de filhote da cobasi") entrava na busca (305);
//   4. (R15-4) "a da essence mesmo, ta barata" com as máscaras à prova d'água na tela virava item novo sem o atributo; a troca
//      de loja passava de preto para marrom sem avisar (304);
//   5. (R15-5) "gotas não" entrava na busca (307); os itens da 1ª mensagem com o cadastro junto sumiam (303); "se a fralda
//      não servir eu consigo trocar por P?" recebia a resposta de abertura (301).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped, parseVariantSplit, brandOnTable, colorChange } from "../src/lib/delivery-service";
import { swapColorNote } from "../src/lib/lia-copy";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, reconcilePreItems, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { resolveListItems } from "../src/lib/list-items";
import { detectIntent, mergeShoppingLines, splitNegatedTerms, typoTwinLines } from "../src/lib/lia-intents";
import { wantClauseTail } from "../src/lib/address-parse";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5539${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, ...rest: unknown[]) => {
    outbox.push({ to, kind: key, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
    return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
  };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/viacep\.com\.br\/ws\/01310100/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

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
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
afterEach(() => {
  __clearLiveCheckCacheForTests();
  __setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g44_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "choosing") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, pendingSince: Date.now(), ...ctxExtra }) }
  });
  return phone;
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery = "1 dia útil"): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, delivery, etaMinutes: 1440 }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, ask?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, delivery: "1 dia útil", ...(ask ? { ask } : {}) }) as BasketItem;
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });

// 1. R15-1 ---------------------------------------------------------------------------------------------------------
const CASA_306 = "oii, queria umas coisa pra casa nova: lampda led 9w 4 unidades, pilha aa, fita isolante, esponja de aco, saco de lixo 100 litros, veja multiuso e uma vassoura. preciso hj ainda";

test("R15-1 (306): erro de digitação ou acento é a mesma linha, sem somar a quantidade", () => {
  assert.equal(typoTwinLines("lampda led 9w", "lâmpada led 9w"), true);
  assert.equal(typoTwinLines("lampada led 9w", "lâmpada led 9w"), false, "igual não é erro de digitação (a soma do mesmo item segue com o outro caminho)");
  assert.equal(typoTwinLines("cerveja", "cereja"), false, "palavra sozinha não funde");
  assert.equal(typoTwinLines("cerveja lata", "cereja lata"), true);
  assert.equal(typoTwinLines("pilha aa", "pilha aaa"), false, "palavra curta não é erro de digitação");
  assert.equal(typoTwinLines("lâmpada led 9w", "lâmpada led 12w"), false, "medida diferente é outro item");
  assert.equal(typoTwinLines("sabonete dove", "sabonete lux"), false);
  const det = resolveListItems(CASA_306);
  const ai = [
    { phrase: "lâmpada led 9w", qty: 4 },
    { phrase: "pilha aa", qty: 1 },
    { phrase: "fita isolante", qty: 1 },
    { phrase: "esponja de aço", qty: 1 },
    { phrase: "saco de lixo 100 litros", qty: 1 },
    { phrase: "limpador multiuso veja", qty: 1 },
    { phrase: "vassoura", qty: 1 }
  ];
  const merged = mergeShoppingLines(ai, [...det, { phrase: "lampda led 9w", qty: 4, qtyExplicit: true }]);
  const lamps = merged.filter((l) => /l[aâ]mp/i.test(l.phrase));
  assert.equal(lamps.length, 1, JSON.stringify(merged));
  assert.equal(lamps[0].qty, 4);
  // A IA devolvendo as duas grafias também vira uma linha só (não 8).
  const twice = mergeShoppingLines([...ai, { phrase: "lampda led 9w", qty: 4 }], det);
  assert.deepEqual(twice.filter((l) => /l[aâ]mp/i.test(l.phrase)).map((l) => l.qty), [4], JSON.stringify(twice));
  // Antes do cadastro: a lista da mensagem não "resgata" a grafia errada como outro item.
  const pre = reconcilePreItems(ai.map((a) => it(a.phrase, a.qty)), CASA_306);
  assert.equal(pre.filter((i) => /l[aâ]mp/i.test(i.query)).length, 1, JSON.stringify(pre));
});

test("R15-1 (306): antes do cadastro, o 'Já anotei' traz uma lâmpada só, 4x", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ items: [it("lâmpada led 9w", 4), it("pilha aa"), it("fita isolante"), it("esponja de aço"), it("saco de lixo 100 litros"), it("veja multiuso"), it("vassoura")] }));
  const phone = newPhone();
  const out = await send(phone, CASA_306);
  assert.match(out, /4x l[aâ]mpada led 9w/i, out.slice(0, 700));
  assert.doesNotMatch(out, /lampda/i, out.slice(0, 700));
  assert.equal((out.match(/l[aâ]mp/gi) ?? []).length, 1, out.slice(0, 700));
});

// 2. R15-2 ---------------------------------------------------------------------------------------------------------
test("R15-2 (302): a vitrine diz '4 pacotes dão 2 kg' e a escolha põe 4 pacotes na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const linguica: PendingChoice = {
    query: "linguiça toscana 2kg",
    qty: 1,
    closestFalta: "é de 500 g — 4 pacotes dão 2 kg",
    options: [opt("santaluzia-160139", "Linguiça Toscana Grossa Frigorífico Salerno – 500g", 24.09, "santaluzia", "Casa Santa Luzia", "4 dias úteis")]
  };
  const carvao = line("farmaciaindiana-27641", "Carvão Fogozão Especial Pacote 3kg", 29.69, "farmaciaindiana", "Farmácia Indiana", "carvão");
  const phone = await customerWith({ basket: [carvao], pending: [linguica] });
  const out = await send(phone, "optsku:santaluzia-160139");
  assert.match(out, /✅ 4x Lingui/, out.slice(0, 500));
  assert.match(out, /4 pacotes de 500 g/, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === "santaluzia-160139")?.qty, 4, JSON.stringify(ctx.basket));
  // Com a quantidade dita pelo cliente, vale a dele.
  const phone2 = await customerWith({ basket: [carvao], pending: [{ ...linguica, qty: 2, qtyExplicit: true }] });
  await send(phone2, "optsku:santaluzia-160139");
  assert.equal((await ctxOf(phone2)).basket?.find((b) => b.sku === "santaluzia-160139")?.qty, 2);
});

// 3. R15-3 ---------------------------------------------------------------------------------------------------------
const SACHES: ChoiceOption[] = [
  opt("cobasi-796875", "Ração Úmida Whiskas Sachê Frango ao Molho Gatos Filhotes 85 g", 3.29, "cobasi", "Cobasi"),
  opt("cobasi-948888", "Ração Úmida Optimum Sachê Gatos Filhotes Frango 85 g", 4.06, "cobasi", "Cobasi"),
  opt("cobasi-821217", "Ração Úmida Sheba Gatos Filhotes Sachê Atum Marinado 85 g", 6.04, "cobasi", "Cobasi"),
  opt("farmaciaindiana-204218", "Ração Úmida para Gato Filhote Friskies Sachê Sabor Carne Ao Molho 85g", 3.4, "farmaciaindiana", "Farmácia Indiana")
];
const SACHE_PENDING: PendingChoice = { query: "sachê gato filhote", qty: 6, qtyExplicit: true, options: SACHES };

test("R15-3 (305): 'N de X e N de Y' com o item na tela é a divisão dele por variante", () => {
  const split = parseVariantSplit("3 de frango e 3 de carne whiskas", SACHE_PENDING);
  assert.deepEqual(split, [{ qty: 3, words: ["frango", "whiskas"] }, { qty: 3, words: ["carne", "whiskas"] }]);
  assert.equal(parseVariantSplit("2 do primeiro e 1 do segundo", SACHE_PENDING), null);
  assert.equal(parseVariantSplit("3 de frango e 2 areias", SACHE_PENDING), null, "produto que não está na tela não é variante");
  assert.equal(parseVariantSplit("frango e carne", SACHE_PENDING), null, "sem quantidade, não divide");
  assert.equal(parseVariantSplit("tira 3 de frango e 3 de carne", SACHE_PENDING), null);
});

test("R15-3 (305): '3 de frango e 3 de carne whiskas' divide o sachê de filhote, sem lista nova nem item repetido", async (t) => {
  if (!dbOk) return t.skip();
  const areia = line("cobasi-203580", "Areia Pipicat Classic para Gatos 4 kg", 16.49, "cobasi", "Cobasi", "areia de gato 4kg");
  const arranhador: PendingChoice = { query: "arranhador", qty: 1, options: [opt("cobasi-1", "Arranhador para Gatos Poste", 39.9, "cobasi", "Cobasi")] };
  const phone = await customerWith({ basket: [{ ...areia, qty: 2, lineTotal: 32.98 }], pending: [SACHE_PENDING, arranhador] });
  const out = await send(phone, "3 de frango e 3 de carne whiskas");
  assert.doesNotMatch(out, /Somei/, out.slice(0, 600));
  assert.match(out, /Dividi \*sachê gato filhote\*/, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  const queries = (ctx.pending ?? []).map((p) => `${p.qty}x ${p.query}`);
  assert.ok(!queries.includes("6x sachê gato filhote"), `o sachê original continua na fila: ${JSON.stringify(queries)}`);
  const frango = (ctx.pending ?? []).find((p) => /frango/.test(p.query));
  assert.ok(frango, JSON.stringify(queries));
  assert.match(frango!.query, /filhote/);
  assert.equal(frango!.qty, 3);
  assert.deepEqual(frango!.options.map((o) => o.sku), ["cobasi-796875"]);
  // O de carne não está na tela com Whiskas: vai para a busca com o "filhote" junto (ou entra como não achado com ele).
  const carne = (ctx.pending ?? []).find((p) => /carne/.test(p.query));
  const carneMiss = JSON.stringify(ctx.listMisses ?? []).match(/[^"]*carne[^"]*/)?.[0] ?? (out.match(/\*[^*]*carne[^*]*\*/)?.[0] ?? "");
  assert.ok((carne && /filhote/.test(carne.query)) || /filhote/.test(carneMiss), `${JSON.stringify(queries)} | ${carneMiss} | ${out.slice(0, 600)}`);
  if (carne) assert.ok(!carne.options.some((o) => /adult/i.test(o.name)), `carne de filhote não mostra adulto: ${carne.options.map((o) => o.name).join(" | ")}`);
  assert.ok((ctx.pending ?? []).some((p) => p.query === "arranhador"), "o resto da fila continua");
});

test("R15-3 (305): o nome da loja no refino é filtro de loja, não palavra da busca", async (t) => {
  if (!dbOk) return t.skip();
  const carne: PendingChoice = {
    query: "sachê gato filhote carne whiskas",
    qty: 3,
    qtyExplicit: true,
    options: [opt("farmaciaindiana-81100", "Ração Úmida para Gato Whiskas Sabor Carne Sachê 85g", 2.74, "farmaciaindiana", "Farmácia Indiana", "3 dias úteis")]
  };
  // A Cobasi fica desligada na suíte; a Petz é a loja de pet ligada.
  const phone = await customerWith({ pending: [carne] });
  const out = await send(phone, "outras, mostra de filhote da petz mesmo");
  assert.doesNotMatch(out, /N[aã]o achei \*[^*]*petz/i, out.slice(0, 600));
  assert.doesNotMatch(out, /mostra de filhote/i, "o pedido não vira item novo");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.length, 1, JSON.stringify(ctx.pending?.map((p) => p.query)));
  const p = ctx.pending![0];
  assert.doesNotMatch(p.query, /petz|mostra/i, p.query);
  assert.ok(p.options.length && p.options.every((o) => o.storeKey === "petz"), `só opções da Petz: ${p.options.map((o) => `${o.storeKey}:${o.name}`).join(" | ")}`);
  assert.ok(p.options.some((o) => /filhote/i.test(o.name) && /carne/i.test(o.name)), p.options.map((o) => o.name).join(" | "));
  // Loja que não tem: diz qual loja, e as opções de antes continuam.
  const phone2 = await customerWith({ pending: [carne] });
  const miss = await send(phone2, "tem da boticário?");
  assert.match(miss, /Na \*(?:O )?Botic[aá]rio\* n[aã]o achei \*[^*]*\*/i, miss.slice(0, 400));
  assert.doesNotMatch(miss, /\*[^*]*botic[aá]rio[^*]*\*(?! n)/i, miss.slice(0, 400));
  assert.equal((await ctxOf(phone2)).pending?.[0]?.options[0]?.sku, "farmaciaindiana-81100");
});

// 4. R15-4 ---------------------------------------------------------------------------------------------------------
const MASCARAS: ChoiceOption[] = [
  opt("dsp-556734", "Máscara de Cílios Maybelline The Colossal Volum' Express à Prova D'água Preto 9,2ml", 60.49, "drogariasp", "Drogaria São Paulo"),
  opt("drogariaspacheco-796247", "Máscara de Cílios Maybelline NY Lash Sensational Sky High À Prova D'Água 7,2ml", 113.29, "drogariaspacheco", "Drogarias Pacheco"),
  opt("epoca-74340", "Máscara de Cílios Essence I Love Extreme Crazy Volume à Prova D’água Preto", 30.69, "epocacosmeticos", "Época Cosméticos", "2 dias úteis"),
  opt("farmaciaindiana-70000", "Máscara de Cílios Loreal The Colossal Volum' Express à Prova D'Água 9,2ml", 57.08, "farmaciaindiana", "Farmácia Indiana", "3 dias úteis"),
  opt("cea-5691525", "máscara de cílios maybelline ny lash sensational sky high à prova d'água Único", 76.99, "cea", "C&A", "3 dias úteis")
];
const MASCARA_PENDING: PendingChoice = { query: "máscara de cílios à prova d'água", qty: 1, options: MASCARAS };
const DEMAQ: PendingChoice = { query: "demaquilante", qty: 1, options: [opt("dsp-312525", "Demaquilante Nivea Bifásico 125ml", 30.79, "drogariasp", "Drogaria São Paulo")] };

test("R15-4 (304): 'a da essence mesmo, ta barata' fica na máscara à prova d'água da tela (sem item novo)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({ pending: [MASCARA_PENDING, DEMAQ] });
  const out = await send(phone, "a da essence mesmo, ta barata");

  assert.doesNotMatch(out, /Anotei|N[aã]o achei/i, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  const inBasket = ctx.basket?.find((b) => b.sku === "epoca-74340");
  const top = ctx.pending?.[0];
  assert.ok(inBasket || (top?.query === MASCARA_PENDING.query && top.options.map((o) => o.sku).join() === "epoca-74340"), `${JSON.stringify(ctx.pending?.map((p) => [p.query, p.options.map((o) => o.sku)]))}`);
  assert.ok(!(ctx.pending ?? []).some((p) => /barata/i.test(p.query)), JSON.stringify(ctx.pending?.map((p) => p.query)));
  assert.ok((ctx.pending ?? []).some((p) => p.query === "demaquilante"), "o demaquilante continua na fila");
});

test("R15-4 (304): com o gerente de diálogo pedindo a busca 'máscara Essence barata', a escolha fica na máscara da tela", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query: "máscara Essence barata" }] }));
  const phone = await customerWith({ pending: [MASCARA_PENDING, DEMAQ] });
  const out = await send(phone, "a da essence mesmo, ta barata");
  assert.doesNotMatch(out, /Anotei/i, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[0]?.query, MASCARA_PENDING.query, JSON.stringify(ctx.pending?.map((p) => p.query)));
  assert.deepEqual(ctx.pending?.[0]?.options.map((o) => o.sku), ["epoca-74340"]);
  assert.equal(ctx.pending?.length, 2, JSON.stringify(ctx.pending?.map((p) => p.query)));
});

test("R15-4 (304): marca que só um card tem é escolha; palavra de outro produto não é", () => {
  assert.deepEqual(brandOnTable("a da essence mesmo, ta barata", MASCARA_PENDING), [2]);
  assert.deepEqual(brandOnTable("máscara Essence barata", MASCARA_PENDING), [2]);
  assert.deepEqual(brandOnTable("a maybelline", MASCARA_PENDING), [0, 1, 4]);
  assert.deepEqual(brandOnTable("delineador essence", MASCARA_PENDING), [], "outro produto com a marca não é escolha");
  assert.deepEqual(brandOnTable("a de cílios", MASCARA_PENDING), [], "palavra de todos os cards não discrimina");
});

test("R15-4 (304): a troca de loja que muda a cor avisa (preto → marrom)", () => {
  assert.deepEqual(colorChange("Máscara de Cílios Essence I Love Extreme Crazy Volume à Prova D’água Preto", "máscara de cílios essence i love extreme crazy volume á prova d água marrom UNICO"), { from: "preto", to: "marrom" });
  assert.equal(colorChange("Máscara Lash Princess Essence Black", "Máscara Lash Princess Essence Preta"), null, "black = preto");
  assert.equal(colorChange("Arroz Tio João 5kg", "Arroz Camil 5kg"), null);
  assert.match(swapColorNote("preto", "marrom"), /muda a cor: era preto, essa é marrom/);
});

// 5. R15-5 ---------------------------------------------------------------------------------------------------------
const DIPIRONA: PendingChoice = {
  query: "dipirona",
  qty: 1,
  options: [
    { ...opt("paguemenos-1", "Dipirona Sódica 500mg/ml Gotas 20ml Genérico", 6.99, "paguemenos", "Pague Menos"), medicine: "mip" },
    { ...opt("paguemenos-2", "Dipirona Monoidratada 500mg/ml Solução Oral Gotas 10ml", 8.49, "paguemenos", "Pague Menos"), medicine: "mip" }
  ]
};

test("R15-5 (307): 'gotas não' exclui, não entra na busca", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const phone = await customerWith({ pending: [DIPIRONA] });
    const out = await send(phone, "tem em comprimido? gotas não");

    assert.doesNotMatch(out, /\*[^*\n]*comprimido[^*\n]*gotas[^*\n]*\*/i, out.slice(0, 600));
    assert.doesNotMatch(out, /\*[^*\n]*gotas n[aã]o[^*\n]*\*/i, out.slice(0, 600));
    const ctx = await ctxOf(phone);
    assert.ok(!(ctx.pending ?? []).some((p) => /gotas/i.test(p.query)), JSON.stringify(ctx.pending?.map((p) => p.query)));
    assert.ok(!(ctx.pending?.[0]?.options ?? []).some((o) => /gotas/i.test(o.name) && ctx.pending?.[0]?.query !== "dipirona"), "opção em gotas não volta como refino");
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});

test("R15-5 (307): com o gerente de diálogo refinando 'comprimido gotas não', a busca sai sem 'gotas'", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "comprimido gotas não" }] } as never));
  try {
    const phone = await customerWith({ pending: [DIPIRONA] });
    const out = await send(phone, "tem em comprimido? gotas não");
    assert.doesNotMatch(out, /\*[^*\n]*gotas[^*\n]*\*/i, out.slice(0, 600));
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});

test("R15-5 (307): negação só vale como exclusão de característica das opções", () => {
  assert.deepEqual(splitNegatedTerms("tem em comprimido? gotas não"), { text: "tem em comprimido?", excluded: ["gotas"] });
  assert.deepEqual(splitNegatedTerms("comprimido, não quero gotas").excluded, ["gotas"]);
  assert.deepEqual(splitNegatedTerms("esse não").excluded, []);
  assert.deepEqual(splitNegatedTerms("eu não sei").excluded, []);
  assert.deepEqual(splitNegatedTerms("sem lactose").excluded, [], "'sem X' continua atributo");
});

test("R15-5 (301): 'se a fralda não servir eu consigo trocar por P?' é pergunta de troca, com o carrossel aberto", async (t) => {
  assert.equal(detectIntent("se a fralda não servir no meu bebê eu consigo trocar por P?").kind, "return_question");
  assert.equal(detectIntent("se vier errado eu posso devolver?").kind, "return_question");
  assert.equal(detectIntent("troca a fralda por P").kind, "swap_item", "troca de item da cesta continua troca");
  if (!dbOk) return t.skip();
  const lenco: PendingChoice = { query: "lenço umedecido", qty: 1, options: [opt("dsp-1", "Lenço Umedecido Huggies Puro e Natural 48 unidades", 12.9, "drogariasp", "Drogaria São Paulo")] };
  const fralda = line("dsp-2", "Fralda Pampers Confort Sec M 46 unidades", 79.9, "drogariasp", "Drogaria São Paulo", "fralda M");
  const phone = await customerWith({ basket: [fralda], pending: [lenco] });
  const out = await send(phone, "se a fralda não servir no meu bebê eu consigo trocar por P?");
  assert.match(out, /[Tt]roca e devolu[cç][aã]o/, out.slice(0, 600));
  assert.doesNotMatch(out, /Eu procuro o que você pedir/, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === "dsp-2")?.qty, 1, "a fralda continua na cesta");
});

const AUDIO_303 = "oi lia tudo bem então eu sou a Marina Souza meu cpf é 529.982.247-25 e meu endereço é avenida paulista mil bela vista são paulo cep 01310-100 eu preciso de um shampoo anticaspa um fio dental uma escova de dente macia e um protetor solar fator cinquenta ponto";

test("R15-5 (303): cadastro e lista na mesma mensagem — os itens ficam guardados até o endereço fechar", async (t) => {
  assert.equal(wantClauseTail("e meu endereço é avenida paulista mil bela vista são paulo eu preciso de um shampoo anticaspa"), "eu preciso de um shampoo anticaspa");
  assert.equal(wantClauseTail("avenida paulista mil bela vista"), undefined);
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const first = await send(phone, AUDIO_303);
  assert.match(first, /n[uú]mero/i, first.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.match(ctx.pendingRequest ?? "", /shampoo anticaspa/i, JSON.stringify(ctx.pendingRequest));
  assert.match(ctx.pendingRequest ?? "", /protetor solar/i, JSON.stringify(ctx.pendingRequest));
  assert.doesNotMatch(ctx.pendingRequest ?? "", /paulista|marina|cpf/i, JSON.stringify(ctx.pendingRequest));
  const next = await send(phone, "1000");
  assert.doesNotMatch(next, /O que você (quer|precisa)\?\s*$/, next.slice(0, 700));
  assert.match(next, /shampoo/i, next.slice(0, 700));
});
