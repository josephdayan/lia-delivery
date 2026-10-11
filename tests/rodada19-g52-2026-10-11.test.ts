// Rodada 19, grupo G52 (11/10): pedido + cadastro na mesma mensagem, troca qualificada por loja, frases soltas que viravam
// item, recusa da troca de loja, opções que não estavam na tela, "o de 100 folhas", "a dipirona pode ser essa" e "tira
// copo" depois do aviso — de /mnt/project-files/testes-whatsapp/rodada19/grupo-b.md (R19-1, R19-4, R19-5, R19-6, R19-7,
// R19-9, R19-12 parte g52).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { ellipticReplacementQuery, handleDeliveryMessage, runTurnScoped, splitIdentity, storeQualifiedRemoveTarget } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import type { DialogueAction } from "../src/lib/dialogue/types";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { declinesSwapOffer, meaningfulProductTokens, mergeShoppingLines, parseBasketLines, parseNeededBy, parseChoiceReply, parseStoreSwapAsk, replaceRefinedSize, splitLeadingSwapDecline } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { dropAddressOnlyItems, onboardingNote, peelPersonName } from "../src/lib/address-parse";
import type { LiveItemCheck } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5529${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, more?: unknown) => {
    outbox.push({ to, kind: key, text: (typeof text === "string" ? text : JSON.stringify(text)) + (more ? `\n${JSON.stringify(more)}` : "") });
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
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", cpf: "52998224725", cpfName: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g52_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const phrases = (t: string) => parseBasketLines(t).map((l) => l.phrase);

// ---------------------------------------------------------------- R19-1: pedido + "cadastro:" na mesma mensagem

test("R19-1: o ponto e o rótulo 'cadastro:' separam o pedido do nome", () => {
  const taken = splitIdentity("Preciso de uma furadeira e um jogo de brocas. cadastro: João Pereira Souza 529.982.247-25", "52998224725");
  assert.equal(taken.name, "João Pereira Souza");
  assert.match(taken.rest, /furadeira/);
  assert.doesNotMatch(taken.rest, /João|cadastro/);
  assert.equal(onboardingNote(taken.rest).text, "1 furadeira, 1 jogo de brocas");
  const obra = splitIdentity("Preciso pintar a sala. 1 lata de tinta branca 18 litros, 1 rolo de pintura, 1 bandeja, e fita crepe. cadastro: Marcos Oliveira Souza 529.982.247-25", "52998224725");
  assert.equal(obra.name, "Marcos Oliveira Souza");
  assert.equal(onboardingNote(obra.rest).text, "1 lata de tinta branca 18 litros, 1 rolo de pintura, 1 bandeja, fita crepe");
  // O que já funcionava continua: vírgula decimal e o nome colado no CPF.
  assert.equal(splitIdentity("Marta Oliveira, CPF 529.982.247-25, tinta branca 3,6 litros", "52998224725").rest, "tinta branca 3,6 litros");
});

test("R19-1: na conversa, os itens seguem, o cadastro fica salvo e o nome nunca vira item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  const out = await send(phone, "Preciso de uma furadeira e um jogo de brocas. cadastro: João Pereira Souza 529.982.247-25, endereço Avenida Paulista 1000 São Paulo 01310-100");
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.cpfName, "João Pereira Souza");
  assert.match(out, /Endereço salvo/);
  assert.doesNotMatch(out, /\*João Pereira Souza\*|1x João|nome completo/i, out.slice(0, 600));
  assert.match(out, /furadeira/i, out.slice(0, 600));
});

// ---------------------------------------------------------------- R19-5: frases soltas

test("R19-5: 'me cadastra', desabafo de dor, 'tem X?' e o plano da obra não viram item", () => {
  assert.deepEqual(phrases("me cadastra pf"), []);
  assert.equal(onboardingNote("me cadastra pf").text, "");
  assert.deepEqual(
    phrases("to com uma dor de cabeça e uma gripe feia. tem dipirona? e preciso de protetor solar fps 50, absorvente noturno e shampoo anticaspa"),
    ["dipirona", "protetor solar fps 50", "absorvente noturno", "shampoo anticaspa"]
  );
  assert.ok(!phrases("Preciso pintar a sala. 1 lata de tinta branca 18 litros, 1 rolo de pintura").some((p) => /pintar|sala/.test(p)));
  // Produto continua produto.
  assert.deepEqual(phrases("remédio pra gripe forte"), ["remédio pra gripe forte"]);
  assert.deepEqual(phrases("arroz, tem que chegar hoje"), ["arroz"]);
  assert.deepEqual(phrases("tinta pra pintar a sala"), ["tinta pra pintar a sala"]);
});

// ---------------------------------------------------------------- R19-4: troca qualificada por loja

const GLITTER = bi("americanas-6915738", "Cola com Glitter Kit 4 Unidades School Basics Secagem Rápida", 10.99, { ask: "cola com glitter" });
const LEONORA = bi("casaevideo-1", "Cola Bastão 10G Leonora", 4.49, { storeKey: "casaevideo", storeLabel: "Casa & Vídeo", ask: "cola bastão" });
const CANETINHA = bi("americanas-787974", "Canetinha Hidrocor Classic 12 cores Bazze", 10.99, { ask: "canetinha hidrocor" });

test("R19-4: 'a cola da casa e vídeo' acha só a cola daquela loja; 'a da cis' vira a busca da cola", () => {
  assert.deepEqual(storeQualifiedRemoveTarget("cola da casa e video", [GLITTER, LEONORA, CANETINHA]), { skus: [LEONORA.sku] });
  assert.deepEqual(storeQualifiedRemoveTarget("a cola da americanas", [GLITTER, LEONORA, CANETINHA]), { skus: [GLITTER.sku] });
  assert.equal(storeQualifiedRemoveTarget("cola", [GLITTER, LEONORA]), undefined);
  assert.equal(ellipticReplacementQuery("poe a da cis da americanas", [LEONORA]), "cola bastão cis");
  assert.equal(ellipticReplacementQuery("da cis da americanas", [LEONORA]), "cola bastão cis");
  assert.equal(ellipticReplacementQuery("poe 2 leites", [LEONORA]), null);
});

test("R19-4: na conversa, sai só a Leonora e a busca é da cola Cis (não da canetinha)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    basket: [CANETINHA, GLITTER, LEONORA],
    lastChoice: { query: "canetinha hidrocor", qty: 1, options: [opt(CANETINHA.sku, CANETINHA.name, 10.99)], chosenSku: CANETINHA.sku }
  });
  const out = await send(c.phone, "tira a cola da casa e vídeo e põe a da cis da americanas");
  const ctx = await ctxOf(c.convoId);
  const skus = (ctx.basket ?? []).map((b) => b.sku);
  assert.ok(skus.includes(GLITTER.sku), out.slice(0, 500));
  assert.ok(skus.includes(CANETINHA.sku), out.slice(0, 500));
  assert.ok(!skus.includes(LEONORA.sku), out.slice(0, 500));
  assert.doesNotMatch(out, /video\* não está|canetinha hidrocor cis|Tirei Cola com Glitter/i, out.slice(0, 500));
  assert.match(out, /Tirei Cola Bastão 10G Leonora/, out.slice(0, 500));
});

// ---------------------------------------------------------------- R19-6: recusa da troca de loja

test("R19-6: 'não quero trocar de loja' é recusa (com ou sem resto) e nunca pedido de troca", () => {
  assert.equal(declinesSwapOffer("não quero trocar de loja"), true);
  assert.equal(declinesSwapOffer("prefiro não trocar"), true);
  assert.equal(declinesSwapOffer("pode trocar de loja"), false);
  assert.equal(splitLeadingSwapDecline("não quero trocar de loja. põe de volta o papel de presente, o mais barato"), "põe de volta o papel de presente, o mais barato");
  assert.equal(splitLeadingSwapDecline("não quero trocar de loja"), null);
  assert.equal(parseStoreSwapAsk("não quero trocar de loja"), null);
  assert.deepEqual(parseStoreSwapAsk("pode trocar de loja"), {});
  assert.deepEqual(phrases("não quero trocar de loja"), []);
});

test("R19-6: a recusa com outro pedido junto vale, a oferta sai e não volta no fechamento", async (t) => {
  if (!dbOk) return t.skip();
  // Nos testes só as lojas da semente existem: o Carrefour faz o papel da loja com mínimo, o Oba o da loja sem.
  const caneta = bi("carrefour-caneta", "Caneta Esferográfica Cristal Fashion 3 Unidades Bic", 8.79, { storeKey: "carrefour", storeLabel: "Carrefour", ask: "caneta azul" });
  const cola = bi("oba-cola", "Cola Bastão 20g", 2.72, { storeKey: "oba", storeLabel: "Oba Hortifruti", ask: "cola bastão" });
  const alt = opt("rihappy-100161271", "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", 7.69, "rihappy", "Ri Happy");
  const basket = [caneta, cola];
  const sig = basket.map((i) => `${i.sku}:${i.qty}`).sort().join("|");
  const c = await customerWith({ basket, minSwap: { fromStoreKey: "carrefour", key: sig, replacements: [{ fromSku: caneta.sku, qty: 1, option: alt }] } });
  const out = await send(c.phone, "não quero trocar de loja. tira a cola");
  let ctx = await ctxOf(c.convoId);
  assert.match(out, /mantenho na \*Carrefour\*/, out.slice(0, 500));
  assert.equal(ctx.minSwap, undefined);
  assert.deepEqual(ctx.minSwapDeclined, ["carrefour"]);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), [caneta.sku], out.slice(0, 500));
  assert.doesNotMatch(out, /não trocar de loja|Consigo em outra loja/i, out.slice(0, 500));
  // Fechamento abaixo do mínimo: o mínimo e os botões de tirar/completar, sem a mesma oferta de novo.
  const close = await send(c.phone, "pagar");
  ctx = await ctxOf(c.convoId);
  assert.match(close, /pedido mínimo/, close.slice(0, 500));
  assert.doesNotMatch(close, /Consigo em outra loja/, close.slice(0, 500));
  assert.ok(ctx.minimumButtonsAt, close.slice(0, 500));
});

// ---------------------------------------------------------------- R19-7: opções que não estavam na tela

const CADERNO = { query: "caderno de unicórnio", qty: 1, options: [opt("zonacriativa-1", "Caderno Pocket Unicórnio", 115.39, "zonacriativa", "Zona Criativa")] };
const PAPEIS = [
  opt("americanas-3982830", "Papel Presente Diver 70x100 cm 100 Folhas Cromus Sortido Estampado", 7.69),
  opt("americanas-2", "Papel de Presente Kraft 60x80cm 5 Folhas", 6.29),
  opt("americanas-3", "Papel de Presente Aniversário 48x60cm 10 Folhas", 9.49)
];

test("R19-7: a pergunta de escolha sobre o item que acabou de virar a vez manda as opções", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "unclear", text: "Qual opção de papel de presente você prefere: 1, 2, 3, 4 ou 5?" }] as DialogueAction[] }));
  const c = await customerWith({ pending: [CADERNO, { query: "papel de presente", qty: 1, options: PAPEIS }] }, "choosing");
  const out = await send(c.phone, "esquece o caderno então, vamos pro papel de presente");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["papel de presente"], out.slice(0, 500));
  assert.match(out, /Papel Presente Diver/, out.slice(0, 600));
  assert.doesNotMatch(out, /1, 2, 3, 4 ou 5\?/, out.slice(0, 600));
});

test("R19-7: 'o de 100 folhas' com um único card que casa escolhe; o nome solto continua só estreitando", async (t) => {
  if (!dbOk) return t.skip();
  assert.deepEqual(parseChoiceReply("o de 100 folhas", PAPEIS), { type: "name", index: 0 });
  const c = await customerWith({ pending: [{ query: "papel de presente", qty: 1, options: PAPEIS }] }, "choosing");
  const out = await send(c.phone, "o de 100 folhas");
  const ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b) => b.sku === PAPEIS[0].sku), out.slice(0, 500));
  assert.doesNotMatch(out, /Ficou entre essas/, out.slice(0, 500));
});

// ---------------------------------------------------------------- R19-9: "pode ser essa" com um card

test("R19-9: 'a dipirona pode ser essa' / 'pode ser essa' confirmam o único card", () => {
  const one = [opt("dsp-900702", "Analgésico Aspdip Dipirona 500mg 20ml Gotas", 10.26, "dsp", "Drogaria São Paulo")];
  for (const t of ["a dipirona pode ser essa", "pode ser essa", "pode ser essa dipirona", "essa dipirona mesmo", "quero essa"]) {
    assert.deepEqual(parseChoiceReply(t, one), { type: "pick", index: 0 }, t);
  }
  // Com várias opções, "pode ser essa" não adivinha; com outro produto citado, não confirma.
  assert.equal(parseChoiceReply("pode ser essa", [...one, opt("dsp-2", "Dipirona Monoidratada 1g 10 Comprimidos", 9.9, "dsp", "Drogaria São Paulo")]), null);
  assert.notDeepEqual(parseChoiceReply("o shampoo pode ser esse", one), { type: "pick", index: 0 });
});

test("R19-9: na conversa, 'a dipirona pode ser essa' escolhe o único card", async (t) => {
  if (!dbOk) return t.skip();
  const prev = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const c = await customerWith({ pending: [{ query: "dipirona", qty: 1, options: [opt("dsp-900702", "Analgésico Aspdip Dipirona 500mg 20ml Gotas", 10.26, "dsp", "Drogaria São Paulo")] }] }, "choosing");
    const out = await send(c.phone, "a dipirona pode ser essa");
    const ctx = await ctxOf(c.convoId);
    assert.ok((ctx.basket ?? []).some((b) => b.sku === "dsp-900702"), out.slice(0, 500));
    assert.doesNotMatch(out, /já são/, out.slice(0, 500));
  } finally {
    if (prev === undefined) delete process.env.LIA_MEDICINE_MIP;
    else process.env.LIA_MEDICINE_MIP = prev;
  }
});

// ---------------------------------------------------------------- R19-12 (g52): "tira copo" depois do aviso

test("R19-12: 'tira copo' depois de 'diz tira copo que eu fecho o resto' tira e mostra o resumo", async (t) => {
  if (!dbOk) return t.skip();
  const copo = bi("carrefour-copo", "Copo Descartável Bello Festas 200ml 100 Unidades", 9.99, { storeKey: "carrefour", storeLabel: "Carrefour", ask: "copo descartável" });
  const carvao = bi("oba-carvao", "Carvão Vegetal 5kg", 32.9, { storeKey: "oba", storeLabel: "Oba Hortifruti", ask: "carvão" });
  const c = await customerWith({ basket: [copo, carvao] });
  const first = await send(c.phone, "pagar");
  assert.match(first, /pedido mínimo/, first.slice(0, 500));
  const out = await send(c.phone, "tira copo");
  assert.match(out, /Tirei Copo/, out.slice(0, 500));
  // O resumo vem no mesmo turno, só com o carvão.
  const summary = out.split("---").slice(1).join("---");
  assert.match(summary, /\*Total: R\$/, out.slice(0, 800));
  assert.match(summary, /Carvão Vegetal/, out.slice(0, 800));
  assert.doesNotMatch(summary, /Copo Descartável/, out.slice(0, 800));
});

// ---------------------------------------------------------------- R19a-1: "3,6 litros" no cadastro junto

test("R19a-1: a vírgula decimal sobrevive ao cadastro na mesma mensagem (não vira '6 litros')", () => {
  assert.equal(dropAddressOnlyItems("tinta branca 3,6 litros, 1 rolo de pintura, fita crepe", { city: "São Paulo" }), "tinta branca 3,6 litros, 1 rolo de pintura, fita crepe");
  assert.equal(peelPersonName("tinta branca 3,6 litros, um rolo de pintura").rest, "tinta branca 3,6 litros, um rolo de pintura");
  const taken = splitIdentity("CPF 529.982.247-25, Vou pintar o quarto sábado de manhã e preciso de tinta branca 3,6 litros, um rolo de pintura, fita crepe e lixa. Tenho até 200 reais", "52998224725");
  // O ponto volta como ponto (o teto é da frase, não da lixa).
  assert.equal(taken.rest, "Vou pintar o quarto sábado de manhã e preciso de tinta branca 3,6 litros, um rolo de pintura, fita crepe e lixa. Tenho até 200 reais");
  assert.equal(phrases(onboardingNote(taken.rest).text)[0], "tinta branca 3,6 litros");
});

// ---------------------------------------------------------------- R19a-2: cor nova substitui a anterior

test("R19a-2: 'melhor preta' com caneta azul busca caneta preta (não 'caneta azul preta')", () => {
  // A base perde a cor antiga; quem chama soma a cor nova ("caneta" + "preta").
  assert.equal(replaceRefinedSize("caneta azul", ["preta"]), "caneta");
  assert.equal(replaceRefinedSize("canetas azuis", ["pretas"]), "canetas");
  // Sem cor dita, nada muda.
  assert.equal(replaceRefinedSize("caneta azul", ["ponta fina"]), "caneta azul");
});

// ---------------------------------------------------------------- R19a-3: "2 apontadores" não duplica

test("R19a-3: 'e 2 apontadores' (det no plural) e 'apontador' (IA no singular) são uma linha só, 2x", () => {
  assert.deepEqual(meaningfulProductTokens("apontadores"), meaningfulProductTokens("apontador"));
  const raw = "lápis de cor 24 cores, tesora, cola bastão, caderno universitário e 2 apontadores";
  const ai = [
    { phrase: "lápis de cor 24 cores", qty: 1 },
    { phrase: "tesoura", qty: 1 },
    { phrase: "cola bastão", qty: 1 },
    { phrase: "caderno universitário", qty: 1 },
    { phrase: "apontador", qty: 2 },
  ];
  const merged = mergeShoppingLines(ai, resolveListItems(raw));
  const sharpeners = merged.filter((l) => /apontador/i.test(l.phrase));
  assert.equal(sharpeners.length, 1, JSON.stringify(merged));
  assert.equal(sharpeners[0].qty, 2);
  assert.equal(merged.length, 5);
});

// ---------------------------------------------------------------- R19a-5: prazo com hora, prazo no turno do cadastro, urgente

const allSlow = (estimate: string) => async (_store: string, skus: string[]) =>
  new Map<string, LiveItemCheck>(skus.map((sku) => [sku, { sku, available: true, fee: 9.9, estimate, etaMinutes: 3 * 1440, fastFee: 9.9, fastEstimate: estimate, fastEtaMinutes: 3 * 1440 }]));

test("R19a-5: 'amanhã às 10h' no fim da lista é prazo (e 'abre/pago amanhã às 10h' não é)", () => {
  const now = new Date("2026-10-11T15:00:00Z");
  const d = parseNeededBy("preciso de arroz 5kg e feijão carioca amanhã às 10h", now);
  assert.equal(d?.label, "amanhã às 10h");
  assert.equal(d?.date, "2026-10-12");
  assert.equal(d?.hour, 10);
  assert.equal(parseNeededBy("a loja abre amanhã às 7h", now), null);
  assert.equal(parseNeededBy("eu pago amanhã às 10h, preciso de arroz", now), null);
});

test("R19a-5: prazo dito antes do cadastro vale na 1ª vitrine (turno do formulário)", async (t) => {
  if (!dbOk) return t.skip();
  __setLiveSimulateForTests(allSlow("3bd"), () => true);
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  await send(phone, "vou fazer um churrasco amanha, preciso de arroz e feijão");
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text: "", messageId: `g52_${RUN}_${++seq}`, flowResponse: { nome: "Teste Silva", cpf: "52998224725", cep: "01310100", numero: "1000", complemento: "", flow_token: "lia-cadastro" } } as Parameters<typeof handleDeliveryMessage>[0]));
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  assert.match(out, /Cadastro feito/);
  assert.match(out, /Pra \*amanhã\* não chega/, out.slice(0, 900));
});

test("R19a-5: 'urgente' sem dia e entrega que não é hoje — o resumo repete o aviso", () => {
  const base = { items: [{ qty: 5, name: "Macarrão Instantâneo", lineTotal: 20 }], produtos: 20, frete: 9.9, deliveryPromise: "prazo da loja: 3 dias úteis", total: 29.9 };
  assert.match(copy.manualQuoteSummary({ ...base, urgentMiss: true }), /é urgente, mas essa entrega não chega hoje \(prazo: \*3 dias úteis\*\)/);
  assert.doesNotMatch(copy.manualQuoteSummary(base), /urgente/);
  // Com prazo dito, quem fala é o aviso do prazo (uma linha só).
  assert.doesNotMatch(copy.manualQuoteSummary({ ...base, urgentMiss: true, deadlineMiss: { label: "amanhã" } }), /urgente/);
});

// ---------------------------------------------------------------- R19a-6: pastilha do cartão do sintoma fecha o item da fila

test("R19a-6: a pastilha escolhida no cartão 'Pra dor de garganta' fecha a 'pastilha para garganta' da fila", async (t) => {
  if (!dbOk) return t.skip();
  const recommendation = { request: { form: "symptom", symptom: "dor de garganta" }, plan: { shelves: [] }, shownShelfIds: [], emptyShelves: [] } as unknown as NonNullable<DeliveryContext["pending"]>[number]["recommendation"];
  const c = await customerWith({
    pending: [
      { query: "dor de garganta", qty: 1, recommendation, options: [opt("g52-strep", "Pastilhas para Garganta Strepsils Mel e Limão 8 Unidades", 17.69, "carrefour", "Carrefour"), opt("g52-ibu", "Ibuprofeno 400mg 10 Cápsulas", 12.5, "carrefour", "Carrefour")] },
      { query: "pastilha para garganta", qty: 1, options: [opt("g52-strep2", "Pastilhas Strepsils Laranja 8 Unidades", 15.9, "carrefour", "Carrefour")] },
      { query: "termômetro", qty: 1, options: [opt("g52-termo", "Termômetro Digital G-Tech", 19.9, "carrefour", "Carrefour")] },
    ],
  }, "choosing");
  const out = await send(c.phone, "1");
  assert.match(out, /Strepsils Mel e Limão/);
  assert.match(out, /Já conta como \*pastilha para garganta\*/, out.slice(0, 600));
  assert.match(out, /termômetro/i);
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual((ctx.pending ?? []).map((p) => p.query), ["termômetro"]);
  // Escolher o ibuprofeno no cartão NÃO tira a pastilha da fila.
  const d = await customerWith({
    pending: [
      { query: "dor de garganta", qty: 1, recommendation, options: [opt("g52-ibu", "Ibuprofeno 400mg 10 Cápsulas", 12.5, "carrefour", "Carrefour")] },
      { query: "pastilha para garganta", qty: 1, options: [opt("g52-strep2", "Pastilhas Strepsils Laranja 8 Unidades", 15.9, "carrefour", "Carrefour")] },
    ],
  }, "choosing");
  await send(d.phone, "1");
  assert.deepEqual(((await ctxOf(d.convoId)).pending ?? []).map((p) => p.query), ["pastilha para garganta"]);
});

test("R19a-6: 'oi, antes: tem X?' com outro cartão aberto responde 'Tem sim!' antes de anotar", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({
    pending: [{ query: "arroz", qty: 1, options: [opt("g52-arroz", "Arroz Branco Tipo 1 5kg", 25.9, "carrefour", "Carrefour")] }],
  }, "choosing");
  const out = await send(c.phone, "oi, antes: tem açúcar?");
  assert.match(out, /Tem sim! Anotei \*açúcar\*/i, out.slice(0, 500));
});

// ---------------------------------------------------------------- R19a-9: teto do item que a IA deixou de fora

test("R19a-9: o teto dito colado no item volta pra busca quando a IA o omite", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query: "arroz branco tipo 1" }, { type: "search", query: "feijão carioca" }] as DialogueAction[] }));
  const c = await customerWith({ pending: [{ query: "café", qty: 1, options: [opt("g52-cafe", "Café Torrado e Moído 500g", 18.9, "carrefour", "Carrefour")] }] }, "choosing");
  const out = await send(c.phone, "e também um arroz até 10 reais e um feijão carioca");
  const ctx = await ctxOf(c.convoId);
  const arroz = (ctx.pending ?? []).find((p) => /arroz/.test(p.query));
  assert.ok(arroz, out.slice(0, 600));
  assert.equal(arroz.cap, 10);
  assert.ok(arroz.options.every((o) => o.unitPrice * 1.1 <= 10.5), JSON.stringify(arroz.options.map((o) => [o.name, o.unitPrice])));
  // O feijão (sem teto dito) não herda o teto do arroz.
  const feijao = (ctx.pending ?? []).find((p) => /feij/.test(p.query));
  assert.equal(feijao?.cap ?? null, null);
});

test("R19a-9: 'o papel higiênico mais barato' com o papel na fila não diz 'Tirei' e 'Anotei' juntos", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "remove", target: 1 }, { type: "search", query: "papel higiênico mais barato" }] as DialogueAction[] }));
  const c = await customerWith({
    pending: [
      { query: "macarrão instantâneo", qty: 5, qtyExplicit: true, options: [opt("g52-mac", "Macarrão Instantâneo Nissin 85g", 3.5, "carrefour", "Carrefour")] },
      { query: "papel higiênico", qty: 1, options: [opt("g52-ph", "Papel Higiênico Neve 4 Rolos", 12.9, "carrefour", "Carrefour")] },
    ],
  }, "choosing");
  const out = await send(c.phone, "o papel higienico mais barato");
  assert.doesNotMatch(out, /Tirei/, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const queries = (ctx.pending ?? []).map((p) => p.query);
  assert.equal(queries[0], "macarrão instantâneo");
  assert.equal(queries.filter((q) => /papel/.test(q)).length, 1, JSON.stringify(queries));
});
