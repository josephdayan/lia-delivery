// Rodada 16, grupo G47 (10/10): embalagem "Com 3 Unidades" (3 escovas viravam 9), troca de cor das canetas que perdia a
// quantidade e herdava o nome do produto anterior, oferta de troca de loja que voltava à cor antiga / punha grampeador de
// chaveiro, apresentação + história do pet que viravam item, faltantes desatualizadas e perguntas sobre o card ("o primeiro
// serve pro rosto?", "o primeiro é 75g?"). Textos de /mnt/project-files/testes-whatsapp/rodada16/grupo-b.md (352, 355, 357).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { byColor, colorRefine, handleDeliveryMessage, packAdjusted, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { isNonItemSegment } from "../src/lib/lia-intents";
import { parseProductQuestion, answerProductQuestion } from "../src/lib/product-question";
import { variantPenalty } from "../src/lib/stores/types";
import { planActions } from "../src/lib/dialogue/plan";
import type { DialogueState } from "../src/lib/dialogue/types";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5527${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown) => {
    outbox.push({ to, kind: key, text: typeof text === "string" ? text : JSON.stringify(text) });
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
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
afterEach(() => {
  __setLiveSimulateForTests(null);
  __clearLiveCheckCacheForTests();
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  delete process.env.LIA_DIALOGUE_LLM;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function newcomer(pendingRequest?: string) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address", ...(pendingRequest ? { pendingRequest } : {}) }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g47_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});

// ---------------------------------------------------------------- R16-1: kit "Com 3 Unidades"

test("A1: '3 escovas' com o kit 'Com 3 Unidades' é 1 kit (não 3 kits = 9 escovas)", () => {
  const jadepro = "Escova Dental Jadepro Pop Max Macia Com 3 Unidades";
  assert.equal(packAdjusted(jadepro, 3, "escova de dente macia").qty, 1);
  assert.match(packAdjusted(jadepro, 3, "escova de dente macia").note ?? "", /Cada embalagem tem 3 unidades/);
  assert.equal(packAdjusted(jadepro, 6, "escova de dente macia").qty, 2);
  // O nome que declara o conjunto vale também fora da lista de produtos contáveis: "Kit 3", "Kit com 3", "c/ 3", "3 Un".
  assert.equal(packAdjusted("Sabonete Dove Original Kit com 3 90g", 3, "sabonete dove").qty, 1);
  assert.equal(packAdjusted("Escova de Dente Dental Clear Classic Macia Kit 3 Unidades", 3, "escova dental").qty, 1);
  assert.equal(packAdjusted("Escova de Dente Oral Nexter Orbit Macia Adulto 3 Un", 3, "escova de dente").qty, 1);
  // Embalagens pedidas continuam embalagens; kit sem "com"/"kit" (avulso) não muda (rodada 12/9).
  assert.equal(packAdjusted(jadepro, 3, "pacotes de escova de dente").qty, 3);
  assert.equal(packAdjusted("Desodorante Rexona 2 unidades", 2, "desodorante").qty, 2);
  // Escova avulsa: 3 escovas = 3.
  assert.equal(packAdjusted("Escova de Dente Sanifill Pocket Macia 1 Unidade", 3, "escova de dente macia").qty, 3);
});

test("A1: escolher o kit de 3 para '3 escova de dente macia' põe 1 kit na cesta, com o aviso", async (t) => {
  if (!dbOk) return t.skip();
  const kit = opt("drogariaspacheco-892696", "Escova Dental Jadepro Pop Max Macia Com 3 Unidades", 8.79, "drogariaspacheco", "Drogarias Pacheco");
  const avulsa = opt("drogal-5274", "Escova de Dente Sanifill Pocket Macia 1 Unidade", 6.59, "drogal", "Drogal");
  const c = await customerWith({ pending: [{ query: "escova de dente macia", qty: 3, qtyExplicit: true, options: [kit, avulsa] }] }, "choosing");
  const out = await send(c.phone, "optsku:drogariaspacheco-892696");
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.basket?.find((b) => b.sku === kit.sku)?.qty, 1, out);
  assert.match(out, /Cada embalagem tem 3 unidades/, out);
  assert.doesNotMatch(out, /3x Escova/, out);
});

// ---------------------------------------------------------------- R16-7: perguntas sobre o card

test("M5/M6: 'o primeiro serve pro rosto?' e 'o primeiro é 75g?' respondem com o nome do card", () => {
  const protetores = [
    { name: "Protetor Solar Corporal Helioderm Suncare FPS50 200ml", price: 34.86 },
    { name: "Protetor Solar Facial Nivea FPS50 50g", price: 40 },
    { name: "Protetor Solar Spray FPS50 200ml", price: 43 }
  ];
  const rosto = parseProductQuestion("o primeiro serve pro rosto também?", 3, protetores.map((o) => o.name));
  assert.equal(rosto?.kind, "spec");
  const ans = answerProductQuestion(rosto!, protetores, "protetor solar fps50");
  assert.match(ans, /\*corporal\*/);
  assert.match(ans, /Pro rosto o indicado é um \*facial\*/);
  assert.match(ans, /opção \*2\*/, "aponta a opção facial da tela");
  // Nome que não diz: honesto, sem chute.
  const spray = answerProductQuestion(parseProductQuestion("o terceiro serve pro rosto?", 3, protetores.map((o) => o.name))!, protetores, "protetor solar fps50");
  assert.match(spray, /não diz se serve pro rosto/);

  const papel = [
    { name: "Papel Sulfite Report 75g A4 500 Folhas Resma", price: 29.37 },
    { name: "Papel Sulfite Chamex A4 Resma 500 Folhas", price: 31.04 }
  ];
  const g75 = parseProductQuestion("o primeiro é 75g?", 2, papel.map((o) => o.name));
  assert.match(answerProductQuestion(g75!, papel, "papel A4"), /^Sim: .*\*75 g\*/);
  assert.match(answerProductQuestion(parseProductQuestion("o segundo é 75g?", 2, papel.map((o) => o.name))!, papel, "papel A4"), /não diz se é de 75 g/);
  assert.match(answerProductQuestion(parseProductQuestion("o primeiro é 90g?", 2, papel.map((o) => o.name))!, papel, "papel A4"), /^Não: .*\*75 g\*, não de 90 g/);
  const escovas = [{ name: "Escova 1 Unidade", price: 6 }, { name: "Escova Macia 3 Unidades", price: 16 }];
  assert.match(answerProductQuestion(parseProductQuestion("o segundo tem 3 unidades?", 2, escovas.map((o) => o.name))!, escovas, "escova"), /^Sim: /);
  // Pergunta sem medida nem uso continua com quem já respondia.
  assert.equal(parseProductQuestion("o segundo é bom?", 2, papel.map((o) => o.name)), null);
});

test("M5/M6: na escolha aberta, a pergunta sobre o card é respondida (não a apresentação da Lia)", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("li-435292", "Papel Sulfite Report 75g A4 500 Folhas Resma", 29.37), opt("li-116505", "Papel Sulfite Chamex A4 Resma 500 Folhas", 31.04)];
  const c = await customerWith({ pending: [{ query: "papel A4", qty: 1, options }] }, "choosing");
  const out = await send(c.phone, "o primeiro é 75g?");
  assert.match(out, /Sim: pelo nome/, out);
  assert.doesNotMatch(out, /Eu procuro o que você pedir/, out);
  const protetor = await customerWith({ pending: [{ query: "protetor solar fps50", qty: 1, options: [opt("fi-187469", "Protetor Solar Corporal Helioderm Suncare FPS50 200ml", 34.86), opt("pm-54707", "Protetor Solar Nivea Ph Fps50 200ml", 52.69)] }] }, "choosing");
  const rosto = await send(protetor.phone, "o primeiro serve pro rosto também?");
  assert.match(rosto, /corporal/, rosto);
  assert.equal((await ctxOf(protetor.convoId)).pending?.length, 1, "a escolha continua aberta");
});

// ---------------------------------------------------------------- R16-3: troca de cor

test("A2/M8: troca só de cor busca o pedido do cliente com a cor nova (não o nome do produto anterior)", () => {
  const azul = bi("rihappy-100161271", "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", 7.69, { ask: "caneta bic azul" });
  assert.deepEqual(colorRefine(azul, "canetas esferográficas Cristal Fina 3 unidades BIC preta"), { phrase: "caneta bic preta", color: "preto" });
  assert.deepEqual(colorRefine(azul, "preta"), { phrase: "caneta bic preta", color: "preto" });
  assert.deepEqual(colorRefine(azul, "canetas esferográficas pretas"), { phrase: "caneta bic preta", color: "preto" });
  // Outro produto não é troca de cor.
  assert.equal(colorRefine(azul, "lápis preto"), null);
  // Kits coloridos só quando não há caneta de uma cor só.
  const opts = [
    { name: "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul e Preta - BIC" },
    { name: "Caneta Esferográfica Cristal Dura Mais 4 Unidades BIC 2 Azuis 1 Vermelha e Preta" },
    { name: "Caneta Esferográfica Preta Cristal Bic" }
  ];
  assert.deepEqual(byColor(opts, "preto").map((o) => o.name), ["Caneta Esferográfica Preta Cristal Bic"]);
  assert.equal(byColor(opts.slice(0, 2), "preto").length, 2);
});

test("A2/M8: troca de cor na cesta só mostra a cor pedida", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "swap", from: 1, to: "Bebedouro Fonte Spike para Cães e Gatos rosa" }] }));
  const azul = bi("petz-fonte-azul", "Bebedouro Fonte Spike Azul para Cães e Gatos", 59.9, { storeKey: "petz", storeLabel: "Petz", ask: "bebedouro fonte azul" });
  const c = await customerWith({ basket: [azul] });
  const out = await send(c.phone, "melhor a rosa");
  assert.match(out, /Bebedouro Fonte Spike Rosa/, out.slice(0, 400));
  const after = out.split(/Seu pedido|Opções de/i)[1] ?? "";
  assert.doesNotMatch(after, /Spike (Azul|Verde|Branco)/, out.slice(0, 600));
});

test("A2: '5 escovas' em 2 kits de 3 trocadas por outra marca continuam 5 unidades (não 'você pediu 2')", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "swap", from: 1, to: "escova de dente oral-b" }] }));
  const colgate = bi("carrefour-colgate-3", "Escova de Dente Colgate Classic Clean 3 unidades", 12.9, {
    qty: 2, lineTotal: 25.8, storeKey: "carrefour", storeLabel: "Carrefour", ask: "escova de dente", askedUnits: { units: 5, packs: 2 }
  });
  const c = await customerWith({ basket: [colgate] });
  const out = await send(c.phone, "troca a escova por oral-b");
  const ctx = await ctxOf(c.convoId);
  const p = ctx.pending?.[0];
  if (p) {
    assert.equal(p.qty, 5, "a troca guarda as 5 unidades pedidas, não os 2 kits");
    const four = p.options.find((o) => /4 unidades/i.test(o.name));
    if (four) {
      const pick = await send(c.phone, `optsku:${four.sku}`);
      assert.doesNotMatch(pick, /pediu \*2\*/, pick);
      assert.match(pick, /pediu \*5\*|5\b/, pick);
    }
  } else {
    const line = ctx.basket?.find((b) => /oral-b/i.test(b.name));
    assert.ok(line, out.slice(0, 400));
    assert.ok(line!.qty >= 2, `${line!.qty}x ${line!.name}`);
  }
});

test("M7: grampeador de chaveiro não é o básico", () => {
  assert.ok(variantPenalty("mini grampeador escolar", "Mini Grampeador 3.7x1.6mm Chaveiro Loffice") > variantPenalty("mini grampeador escolar", "Mini Grampeador Escolar 26/6 School Basics"));
});

// ---------------------------------------------------------------- R16-5: apresentação + história do pet

test("M1: história do pet na apresentação não vira item", () => {
  assert.equal(isNonItemSegment("Meu coelhinho mini lion chegou semana passada"), true);
  assert.equal(isNonItemSegment("minha gata persa branca chegou ontem"), true);
  assert.equal(isNonItemSegment("feno 1kg"), false);
  assert.equal(isNonItemSegment("ração coelho filhote 1,5kg"), false);
});

const miss = (query: string) => ({ query, qty: 1, reason: "not_found" as const, at: Date.now() });

test("M2/M3: depois do 'não achei', a frase nova de produto é buscada e a lista não traz o que já entrou na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const racao = bi("cobasi-842915", "Ração para Coelhos Ornamentais Filhotes Megazoo 500 g", 50.59, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "ração coelho filhote", qty: 3, lineTotal: 151.77 });
  const c = await customerWith({
    basket: [racao],
    listMisses: [miss("ração coelho filhote 1,5kg"), miss("bebedouro de bico"), miss("Meu coelhinho mini lion chegou semana passada")]
  });
  const out = await send(c.phone, "bebedouro de bico para roedores");
  assert.doesNotMatch(out, /ração coelho filhote/i, out.slice(0, 500));
  assert.doesNotMatch(out, /coelhinho mini lion/i, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  const misses = (ctx.listMisses ?? []).map((m) => m.query);
  assert.ok(!misses.some((m) => /ração/i.test(m)), misses.join(" | "));
  // A frase nova foi buscada: ou virou opção, ou é ela que aparece como "não achei".
  const searched = (ctx.pending ?? []).some((p) => /bebedouro/i.test(p.query)) || /bebedouro de bico para roedores/i.test(out);
  assert.ok(searched, out.slice(0, 500));
});

test("M2: 'esquece o bebedouro' tira o bebedouro das faltantes (não volta no resumo)", async (t) => {
  if (!dbOk) return t.skip();
  const feno = bi("cobasi-1203150", "Feno Tifton para Roedores e Lagomorfos Lory Pet 500 g", 28.49, { storeKey: "cobasi", storeLabel: "Cobasi", ask: "feno 1kg", qty: 2, lineTotal: 56.98 });
  const c = await customerWith({ basket: [feno], listMisses: [miss("bebedouro de bico"), miss("bebedouro coelho")] });
  const out = await send(c.phone, "esquece o bebedouro");
  const ctx = await ctxOf(c.convoId);
  assert.ok(!(ctx.listMisses ?? []).some((m) => /bebedouro/i.test(m.query)), `${out.slice(0, 300)} :: ${JSON.stringify(ctx.listMisses)}`);
  assert.doesNotMatch(out, /Ficou de fora[^\n]*bebedouro/i, out);
});

test("M3: reformular o item que faltou é busca nova, não 'tenta de novo' da frase antiga", () => {
  const state = {
    passo: "montando", emEscolha: null, ultimaEscolha: null,
    naoAcheiRecente: { pedido: "bebedouro de bico", jaTentouDeNovo: false }, totalNaMesa: null, cobrancaAberta: false, opcoesDeFrete: null
  } as unknown as DialogueState;
  const run = (text: string) => {
    const plan = planActions({ actions: [{ type: "search", query: "bebedouro de bico", retry: true }] } as never, state, { text });
    assert.ok(plan.ok, JSON.stringify(plan));
    return (plan as { steps: Array<{ retry?: boolean; lines: { query: string }[] }> }).steps[0];
  };
  const novo = run("bebedouro de bico para roedores");
  assert.equal(novo.retry, undefined);
  assert.equal(novo.lines[0].query, "bebedouro de bico para roedores");
  // "tenta de novo o bebedouro" continua sendo a 2ª tentativa.
  assert.equal(run("tenta de novo o bebedouro").retry, true);
});
