// Rodada 22, grupo G61 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada22/grupo-b.md (A2, A3, A4, M4, B4, B5) e
// grupo-a.md (N1, N2): presente antes do cadastro, presente com teto e itens fantasmas, troca de ração que perdia o "filhote",
// teto "tudo até 150"/"trezentos reais", "vou viajar sexta", carregador de parede primeiro, caneca × caneta e pastilha.
// R22b-1 (basicos-pos-despausa.md): "frango" logo após o cadastro → "não achei em nenhuma loja" com a Swift calada.
import "./helpers/load-env";
import "./helpers/enable-mambo";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, recommendationLeftovers, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, planPreSignup, type PreDecision } from "../src/lib/dialogue/presignup";
import { detectIntent, digitizeSpelledMoney, inheritSwapQualifiers, isGiftFrame, parseNeededBy, parseOrderBudget, parsePriceCap } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { exactTokenHits, typoOnlyTokens, variantPenalty, type CatalogItem } from "../src/lib/stores/types";
import { cleanRefineWant } from "../src/lib/recommend/handle";
import * as copy from "../src/lib/lia-copy";
import type { DeliveryContext } from "../src/lib/conversation-types";
import { __setRerankForTests, type RerankLine } from "../src/lib/adapters/ai";
import { __setPreflightForTests, type LiveItemCheck } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests, __setLiveSimulateForTests } from "../src/lib/live-availability";
import { isRegionalStore } from "../src/lib/store-areas";
import { __resetPausedStoresForTests } from "../src/lib/store-pause";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5561${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, more?: unknown) => {
    outbox.push({ to, text: [text, more].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ") });
    return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
  };
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
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
});
after(async () => {
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g61_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [],
  budget: null,
  answers: [],
  medicine: false,
  outOfScope: false,
  human: false,
  waiting: false,
  farewell: false,
  vague: false,
  ...over
});
const item = (name: string, brand?: string): CatalogItem => ({ sku: `t-${name}`, name, unitPrice: 10, unit: "un", ...(brand ? { brand } : {}) }) as CatalogItem;

const CHEFE = "oi, é pra presente de aniversário da minha chefe, gosto de acertar. ela ama lavanda. quero gastar até 120 reais. pensei num perfume ou num kit de banho";

// ---------------------------------------------------------------- R22-2: presente antes do cadastro

test("R22-2: pedido de presente com a lista na mesma mensagem não é 'é pra outra pessoa' (não pergunta o nome)", () => {
  assert.notEqual(detectIntent(CHEFE).kind, "recipient_other");
  assert.notEqual(detectIntent("é pra presente de aniversário da minha chefe. quero um perfume de lavanda").kind, "recipient_other");
  // A frase curta continua pedindo o nome de quem recebe.
  assert.equal(detectIntent("é pra presente").kind, "recipient_other");
  assert.equal(detectIntent("é pra outra pessoa").kind, "recipient_other");
  assert.equal(detectIntent("entrega pra minha mãe").kind, "recipient_other");
});

test("R22-2: '(é) pra presente de aniversário da minha chefe' é a moldura do presente, não item", () => {
  assert.ok(isGiftFrame("pra presente de aniversário da minha chefe"));
  assert.ok(isGiftFrame("é pra presente da minha mãe"));
  assert.ok(!isGiftFrame("papel de presente"));
});

test("R22-2: antes do cadastro, o presente com ideias vira recomendação guardada (sem pedir o nome, sem itens soltos)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  await send(phone, "oi");
  __setPreSignupModelForTests(async () => D({ recommend: true, budget: 120 }));
  process.env.LIA_DIALOGUE_LLM = "true";
  t.after(() => {
    delete process.env.LIA_DIALOGUE_LLM;
  });
  const out = await send(phone, CHEFE);
  assert.doesNotMatch(out, /nome de quem vai receber/i, out);
  assert.match(out, /recomenda[cç][aã]o de presente/i, out);
  assert.doesNotMatch(out, /acertar|pensei|1x lavanda/i, out);
  const ctx = await ctxOf(phone);
  assert.ok(ctx.pendingRecommend?.includes("lavanda"), JSON.stringify(ctx));
  assert.equal(ctx.pendingRequest, undefined);
});

// ---------------------------------------------------------------- R22-3: frases não viram item; dicas do presente

test("R22-3: 'gosto de acertar' e 'pensei num perfume ou num kit de banho' não viram itens fantasmas", () => {
  const phrases = resolveListItems(CHEFE).map((l) => l.phrase);
  assert.ok(!phrases.some((p) => /acertar|pensei|presente/i.test(p)), JSON.stringify(phrases));
  assert.ok(phrases.some((p) => /perfume/.test(p) && /kit de banho/.test(p)), JSON.stringify(phrases));
  // Intenção de agradar sozinha nunca é produto.
  assert.deepEqual(resolveListItems("quero caprichar, não quero errar").map((l) => l.phrase), []);
  // "pensei em" + produto: o produto fica.
  assert.deepEqual(resolveListItems("pensei em um vinho tinto").map((l) => l.phrase), ["vinho tinto"]);
});

test("R22-3: as dicas do presente ('ela ama lavanda', 'pensei num perfume…') não sobram como itens da recomendação", () => {
  const rest = recommendationLeftovers(CHEFE.replace(/quero gastar até 120 reais\./, ""), { need: "presente de aniversário pra minha chefe" });
  assert.deepEqual(rest, []);
  // Item de verdade junto do presente continua anotado.
  const withCard = recommendationLeftovers("presente pra minha mãe, ela ama lavanda, e um cartão de aniversário", { need: "presente pra minha mãe" });
  assert.ok(withCard.some((p) => /cart[aã]o de anivers/.test(p)), JSON.stringify(withCard));
  assert.ok(!withCard.some((p) => /lavanda/.test(p)), JSON.stringify(withCard));
});

test("R22-3: 'algo mais chique, o kit granado' refina pelo produto (o elogio não vira exigência no nome)", () => {
  assert.equal(cleanRefineWant("algo mais chique, o kit granado"), "kit granado");
  assert.equal(cleanRefineWant("kit granado chique"), "kit granado");
  assert.equal(cleanRefineWant("de morango"), "morango");
  assert.equal(cleanRefineWant(undefined), undefined);
});

test("R22-3: sem nada dentro do teto, a Lia diz o teto (não 'não achei com entrega aí')", () => {
  const msg = copy.recommendNoneInBudget("kit granado", 120);
  assert.match(msg, /Dentro de \*R\$ 120,00\* com a entrega não achei \*kit granado\*/, msg);
});

// ---------------------------------------------------------------- R22-4: troca de medida herda filhote/espécie

test("R22-4: 'troca a ração por uma de 10kg' herda filhote e espécie do pedido anterior", () => {
  assert.equal(inheritSwapQualifiers("ração de 10kg", "ração filhote cachorro"), "ração filhote cachorro de 10kg");
  assert.equal(inheritSwapQualifiers("uma de 10kg, 1kg é pouco", "ração filhote cachorro"), "ração filhote cachorro 10kg");
  // O que o cliente diz na troca vale mais: "de adulto" não herda "filhote".
  assert.doesNotMatch(inheritSwapQualifiers("ração de adulto 10kg", "ração filhote cachorro"), /filhote/);
  // Outro produto não herda nada.
  assert.equal(inheritSwapQualifiers("areia sem cheiro", "ração filhote"), "areia sem cheiro");
});

// ---------------------------------------------------------------- R22-7: teto e prazo

test("R22-7: 'tem como deixar tudo até 150 reais?' e 'limita o total em 150' são o teto do pedido", () => {
  assert.equal(parseOrderBudget("ah to com medo de ficar caro, tem como deixar tudo até 150 reais?")?.cap, 150);
  assert.equal(parseOrderBudget("limita o total em 150")?.cap, 150);
  assert.equal(parseOrderBudget("fecha tudo em até 200 reais")?.cap, 200);
  // Teto colado num item segue do item.
  assert.equal(parseOrderBudget("quero um vinho até 150 reais"), null);
});

test("R22-7: 'no máximo uns trezentos reais' (por extenso) vira 💰 R$ 300", () => {
  assert.equal(digitizeSpelledMoney("no máximo uns trezentos reais"), "no máximo uns 300 reais");
  assert.equal(digitizeSpelledMoney("cento e cinquenta reais"), "150 reais");
  assert.equal(digitizeSpelledMoney("duas pilhas"), "duas pilhas");
  const b = parseOrderBudget("casa nova: quatro ou cinco lâmpadas, uma vassoura e um rodo, no máximo uns trezentos reais");
  assert.equal(b?.cap, 300);
  assert.equal(parsePriceCap("até cento e cinquenta reais"), 150);
});

test("R22-7: 'vou viajar sexta' é prazo (o resumo confronta a sexta)", () => {
  const now = new Date("2026-10-11T12:00:00-03:00");
  assert.equal(parseNeededBy("vou viajar sexta, preciso de protetor solar fps 50, repelente e shampoo pequeno", now)?.label, "sexta");
  assert.equal(parseNeededBy("viajo sábado e preciso de uma mala", now)?.label, "sábado");
});

test("R22-7: com o pedido andando, 'tem como deixar tudo até 150 reais?' anota o teto (sem perguntar de novo)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const basket = [{ sku: "americanas-1", name: "Repelente Spray Above Protect 200ml", qty: 1, unitPrice: 13.92, lineTotal: 13.92, storeKey: "americanas", storeLabel: "Americanas" }];
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", basket }) }
  });
  const out = await send(phone, "ah to com medo de ficar caro, tem como deixar tudo até 150 reais?");
  assert.match(out, /R\$ 150,00\* no total/, out);
  assert.equal((await ctxOf(phone)).orderBudget?.cap, 150);
});

// ---------------------------------------------------------------- R22-9: carregador de parede primeiro

test("R22-9: carregador veicular/power bank pesa contra quando o pedido não diz o tipo", () => {
  const q = "carregador de celular usb c";
  assert.ok(variantPenalty(q, "Carregador Veicular ELG CC2STC 2.1A USB-C e USB-A") > variantPenalty(q, "Carregador de Parede Multilaser 20W USB-C"));
  assert.ok(variantPenalty(q, "Power Bank Carregador Portátil 10000mAh USB-C") > variantPenalty(q, "Carregador de Parede Multilaser 20W USB-C"));
  // Pedido do veicular: o veicular não perde.
  assert.equal(variantPenalty("carregador veicular usb c", "Carregador Veicular ELG CC2STC 2.1A USB-C"), 0);
});

// ---------------------------------------------------------------- R22a-5: caneca × caneta

test("R22a-5: 'caneca' só casa 'Caneta' por erro de digitação — e a caneca de verdade casa exato", () => {
  assert.deepEqual(typoOnlyTokens("caneca", item("Caneta Esferográfica 0.7mm Brownie Dog Tilibra")), ["caneca"]);
  assert.deepEqual(typoOnlyTokens("caneca", item("Caneca Cerâmica 330ml Casual Home")), []);
  assert.deepEqual(exactTokenHits("caneca", item("Caneca Cerâmica 330ml Casual Home")), ["caneca"]);
  // Erro de digitação de verdade ("detergnte") segue sendo tolerado — ninguém tem a palavra exata.
  assert.deepEqual(exactTokenHits("detergnte", item("Detergente Líquido Ypê 500ml")), []);
  // Singular × plural não é erro de digitação ("adulto" × "Cães Adultos": a ração de 15 kg não pode sair da vitrine).
  assert.deepEqual(typoOnlyTokens("ração cachorro adulto", item("Ração para Cães Adultos Golden 15kg")), []);
});

// ---------------------------------------------------------------- R22a-6: pastilha para garganta antes do cadastro

test("R22a-6: 'pastilha para garganta' antes do cadastro não recebe a recusa de receita (o isento segue para a busca)", () => {
  const prev = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const plan = planPreSignup(D({ medicine: true }), { text: "pastilha para garganta" });
    assert.deepEqual(plan, { ok: false, reason: "remedio_isento" });
    // Insistência logo depois de uma recusa continua recusada pela IA.
    assert.equal(planPreSignup(D({ medicine: true }), { text: "pastilha para garganta", recentRefusal: true }).ok, true);
    // Remédio de receita nomeado continua recusado.
    assert.equal(planPreSignup(D({ medicine: true }), { text: "amoxicilina" }).ok, true);
  } finally {
    if (prev === undefined) delete process.env.LIA_MEDICINE_MIP;
    else process.env.LIA_MEDICINE_MIP = prev;
  }
});

// ---------------------------------------------------------------- R22b-1: "frango" com a loja calada

// Cliente cadastrado pede um básico; a Mambo (regional, como a Swift do "frango" em produção) não responde à conferência ao
// vivo e o que sobra confirmado de outra loja a IA recusa. No catálogo dos testes não há a Swift nem frango comum, então o
// básico é "arroz" (Mambo + Oba + Carrefour).
async function frangoWithSilentSwift(t: { after: (fn: () => void) => void }, approve: (call: number, line: RerankLine) => string[]) {
  // Pausa de loja deixada no banco por outro teste (store-stall) tiraria a Mambo da vitrine.
  await prisma.appFlag.deleteMany({ where: { key: "store_paused:mambo" } });
  __resetPausedStoresForTests();
  delete process.env.LIA_LIVE_FREIGHT_OFF;
  process.env.LIA_OPERATOR_QUOTE = "false";
  process.env.LIA_CHARGE_ONLY_VERIFIED = "true";
  __setPreflightForTests(async () => null);
  __setLiveSimulateForTests(async (storeKey, skus) => (storeKey === "mambo" ? null : new Map<string, LiveItemCheck>(skus.map((sku) => [sku, { sku, available: true, fee: 9.9, estimate: "hoje", etaMinutes: 240 }]))), () => true);
  let calls = 0;
  __setRerankForTests(async (_message, lines) => {
    calls++;
    return { lines: lines.map((line) => ({ skus: approve(calls, line), exigencias: [] })) };
  });
  t.after(() => {
    process.env.LIA_LIVE_FREIGHT_OFF = "true";
    process.env.LIA_OPERATOR_QUOTE = "true";
    process.env.LIA_CHARGE_ONLY_VERIFIED = "false";
    __setPreflightForTests(null);
    __setLiveSimulateForTests(null);
    __setRerankForTests(null);
    __clearLiveCheckCacheForTests();
  });
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Ana Souza" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", basket: [] }) }
  });
  return { phone, calls: () => calls };
}

test("R22b-1: básico com a loja que tem o produto calada não vira 'não achei em nenhuma loja'", async (t) => {
  if (!dbOk) return t.skip();
  assert.ok(isRegionalStore("mambo"));
  // A IA só aprovaria o frango da Mambo — que não chegou a ela.
  const { phone } = await frangoWithSilentSwift(t, (_call, line) => line.candidates.filter((c) => c.sku.startsWith("mambo-")).map((c) => c.sku));
  const out = await send(phone, "arroz");
  assert.doesNotMatch(out, /não achei/i, out.slice(0, 600));
  assert.match(out, /não responderam a tempo/, out.slice(0, 600));
});

test("R22b-1: linha única zerada pela IA com o produto exato nos candidatos ganha a 2ª chance", async (t) => {
  if (!dbOk) return t.skip();
  // 1ª chamada zera (a IA ora escolhia, ora zerava); a 2ª aprova o que tem "frango".
  const { phone, calls } = await frangoWithSilentSwift(t, (call, line) => (call === 1 ? [] : line.candidates.filter((c) => /arroz/i.test(c.name)).slice(0, 3).map((c) => c.sku)));
  const out = await send(phone, "arroz");
  assert.equal(calls(), 2);
  assert.doesNotMatch(out, /não achei|não responderam/i, out.slice(0, 600));
  assert.ok((await ctxOf(phone)).pending?.[0]?.options.length, out.slice(0, 600));
});
