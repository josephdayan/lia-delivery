// Rodada 12, grupo G36 (10/10): reteste em produção da rodada 12, grupo A (/mnt/project-files/testes-whatsapp/rodada12/
// grupo-a.md). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "peraí, açúcar não, esquece isso" com o açúcar PENDENTE respondia "te espero" (ou somava "1x leite não");
//   2. "pode levar as 2 embalagens de ovos" com "Levo 2 embalagens?" E "Fecho sem ovos?" abertos fechava SEM os ovos;
//   3. antes do cadastro, "presente pra um menino de 7 anos" sumia do "Já anotei" quando vinha com cartão/embalagem;
//   4. "o mais barato de novo" ia pra IA, que pegava a etiqueta mais baixa sem o frete da loja nova; lenço antisséptico
//      no pedido do bebê; pedido mínimo da 1ª loja só no fechamento; nota "somava mais uma entrega" quando as duas somavam;
//   5. "essa estoura meus 100 reais, tem uma mais em conta ou de 3kg?" recebia a resposta genérica do teto;
//   6. baixos: remédio isento nomeado na escolha, "barato" no refino, oferta cruzada cara, troca em aberto como item
//      faltando, link do produto com várias variações.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, planPreSignup, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import * as copy from "../src/lib/lia-copy";
import { detectIntent, parseBasketLines } from "../src/lib/lia-intents";
import { parseLiveProducts } from "../src/lib/stores/live-search";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5536${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
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

const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g36_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
async function signedUp(): Promise<string> {
  const phone = newPhone();
  assert.match(await send(phone, "oi"), /endereço completo/i);
  assert.match(await send(phone, ADDRESS_MSG), /Endereço salvo/);
  return phone;
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return phone;
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery?: string): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...(delivery ? { delivery } : {}) }) as BasketItem;
const decision = (d: Partial<PreDecision>): PreDecision => ({ items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...d });

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: 'peraí, X não, esquece isso' é ordem de tirar, não pausa; pausa de verdade continua pausa", () => {
  for (const t of ["peraí, açúcar não, esquece isso", "pera, esquece o leite", "peraí, desconsidera o açúcar", "pera, não quero mais o café"]) {
    assert.notEqual(detectIntent(t).kind, "hold", t);
  }
  for (const t of ["pera aí", "peraí, meu filho chegou", "pera, já volto"]) assert.equal(detectIntent(t).kind, "hold", t);
});

test("1b: item PENDENTE (o da tela e o da fila) sai com 'peraí, X não, esquece isso' — sem 'te espero' nem 'Somei 1x X não'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "quero arroz, feijão e açúcar");
  await send(phone, "1");
  let ctx = await ctxOf(phone);
  assert.match(ctx.pending?.[0]?.query ?? "", /feij/);
  // O açúcar está na FILA (o feijão na tela).
  let out = await send(phone, "peraí, açúcar não, esquece isso");
  assert.doesNotMatch(out, /te espero|Somei/i, out.slice(0, 400));
  ctx = await ctxOf(phone);
  assert.ok(!(ctx.pending ?? []).some((p) => /a[cç][uú]car/.test(p.query)), out.slice(0, 400));
  assert.ok((ctx.pending ?? []).some((p) => /feij/.test(p.query)), "o feijão continua em escolha");
  // O feijão está NA TELA.
  out = await send(phone, "peraí, feijão não, esquece isso");
  assert.doesNotMatch(out, /te espero|Somei/i, out.slice(0, 400));
  ctx = await ctxOf(phone);
  assert.ok(!(ctx.pending ?? []).some((p) => /feij/.test(p.query)), out.slice(0, 400));
  assert.ok(ctx.basket?.some((b) => /arroz/i.test(b.name)), "o arroz escolhido fica");
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2: 'pode levar as 2 embalagens de ovos' responde a pergunta da embalagem, não o 'Fecho sem ovos?'", async (t) => {
  if (!dbOk) return t.skip();
  const ovos = opt("oba-ovos10", "Ovos Brancos Grandes 10 Unidades", 15.38, "oba", "Oba", "hoje");
  const pao = line("oba-pao", "Pão de Forma Tradicional 390g", 6.59, "oba", "Oba", "hoje");
  const base = { basket: [pao], pending: [{ query: "ovos", qty: 12, qtyExplicit: true, options: [ovos] }], packConfirm: { sku: ovos.sku, askedQty: 12 }, closeWithoutOffer: { queries: ["ovos"], at: Date.now() } };
  const phone = await customerWith(base, "choosing");
  const out = await send(phone, "pode levar as 2 embalagens de ovos");
  assert.doesNotMatch(out, /Fechei sem/i, out.slice(0, 400));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === ovos.sku)?.qty, 2, out.slice(0, 400));
  // "sim" puro continua respondendo a última pergunta (fechar sem); "pode fechar sem os ovos" também.
  const phone2 = await customerWith(base, "choosing");
  const out2 = await send(phone2, "pode fechar sem os ovos");
  assert.match(out2, /Fechei sem \*?ovos/i, out2.slice(0, 400));
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: o pedido de presente com acessórios da ocasião (cartão, embalagem, papel) continua item", () => {
  const said = "preciso de um presente de aniversário pra um menino de 7 anos, um cartão de aniversário, embalagem de presente e papel de presente";
  const lines = parseBasketLines(said).map((l) => l.phrase);
  assert.ok(lines.some((p) => /presente de anivers[aá]rio pra um menino de 7 anos/.test(p)), JSON.stringify(lines));
  assert.equal(lines.length, 4, JSON.stringify(lines));
  // Com produto de verdade na frase, a moldura do presente continua sendo o motivo (rodada 10 g29).
  const g29 = parseBasketLines("presente pra minha amiga que faz aniversário hoje, ela gosta de chocolate e de creme pras mãos").map((l) => l.phrase);
  assert.deepEqual(g29, ["chocolate", "creme pras mãos"]);
  // A IA do pré-cadastro marca o presente como recomendação e anota só os acessórios: o presente entra como item.
  const plan = planPreSignup(decision({ recommend: true, items: [{ query: "cartão de aniversário", qty: 1, cheapest: false }, { query: "embalagem de presente", qty: 1, cheapest: false }, { query: "papel de presente", qty: 1, cheapest: false }] }), { text: said });
  assert.ok(plan.ok, JSON.stringify(plan));
  const steps = (plan as { steps: Array<{ type: string; text?: string }> }).steps;
  assert.ok(!steps.some((s) => s.type === "medicine"), JSON.stringify(steps));
  assert.match(steps.find((s) => s.type === "items")?.text ?? "", /presente de anivers[aá]rio pra um menino de 7 anos/, JSON.stringify(steps));
});

test("3b: antes do cadastro, 'Já anotei' traz o presente junto do cartão, embalagem e papel", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  __setPreSignupModelForTests(async () => decision({ recommend: true, items: [{ query: "cartão de aniversário", qty: 1, cheapest: false }, { query: "embalagem de presente", qty: 1, cheapest: false }, { query: "papel de presente", qty: 1, cheapest: false }] }));
  const out = await send(phone, "preciso de um presente de aniversário pra um menino de 7 anos, um cartão de aniversário, embalagem de presente e papel de presente");
  assert.match(out, /presente de anivers[aá]rio pra um menino de 7 anos/i, out.slice(0, 500));
  assert.match(out, /cart[aã]o de anivers[aá]rio/i, out.slice(0, 500));
  assert.doesNotMatch(out, /Remédio/i, out.slice(0, 500));
});

// 4 ------------------------------------------------------------------------------------------------------------------
test("4a: 'o mais barato de novo/também' com a tela aberta não vai pra IA (que ignorava o frete da loja nova)", () => {
  const options = [opt("oba-1", "Iogurte Grego 90g", 4.39, "oba", "Oba"), opt("carrefour-1", "Iogurte Morango 100g", 3.41, "carrefour", "Carrefour")];
  const ctx = { step: "choosing", pending: [{ query: "iogurte", qty: 1, options }], basket: [line("oba-pao", "Pão", 6.59, "oba", "Oba")] } as unknown as DeliveryContext;
  for (const text of ["o mais barato de novo", "o mais barato também", "o mais barato desse também", "pode ser o mais barato"]) {
    assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false }), "intent:cheapest_pick", text);
  }
  assert.equal(dialogueBypassReason({ text: "qual o mais barato?", intent: detectIntent("qual o mais barato?"), ctx, hasAddress: true, looksLikeList: false }), "pergunta_menor_preco");
});

test("4b: 'o mais barato de novo' conta a entrega da loja nova (fica na loja da cesta)", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [line("oba-1", "Detergente Líquido Ype Neutro 500ml", 2.19, "oba", "Oba", "3 dias úteis")];
  const options = [
    opt("carrefour-safi", "Desinfetante Bactericida Safi Líquido Eucalipto 2L", 4.09, "carrefour", "Carrefour", "hoje"),
    opt("oba-bak", "Desinfetante Ypê Bak Floral 500ml", 4.59, "oba", "Oba", "3 dias úteis")
  ];
  const phone = await customerWith({ basket, pending: [{ query: "desinfetante", qty: 1, options }] }, "choosing");
  const out = await send(phone, "o mais barato de novo");
  const after = (await ctxOf(phone)).basket ?? [];
  assert.ok(after.some((i) => i.sku === "oba-bak"), out.slice(0, 400));
  assert.doesNotMatch(out, /2 entregas/, out);
});

test("4c: bebê citado em outra parte do pedido: 'o mais barato' do lenço nunca é o antisséptico", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "bebê de 3 meses: preciso de fralda tamanho P, lenço umedecido e pomada pra assadura");
  const ctx = await ctxOf(phone);
  const lenco = ctx.pending?.find((p) => /len[cç]o/.test(p.query));
  assert.ok(lenco, JSON.stringify(ctx.pending?.map((p) => p.query)));
  assert.equal(lenco!.babyContext, true);
  // Mesmo com o antisséptico mais barato numa vitrine curta (sem 2 opções de bebê para o filtro da vitrine).
  const options = [opt("oba-anti", "Lenço Umedecido Free Wipes Antisséptico 20 Unidades", 3.5, "oba", "Oba"), opt("oba-baby", "Lenço Umedecido Bebê Limpinho 140 Unidades", 9.9, "oba", "Oba")];
  const phone2 = await customerWith({ pending: [{ query: "lenço umedecido", qty: 1, babyContext: true, options }] }, "choosing");
  const out = await send(phone2, "o mais barato");
  assert.equal((await ctxOf(phone2)).basket?.[0]?.sku, "oba-baby", out.slice(0, 400));
  assert.doesNotMatch(out, /etiqueta mais baixa/, out);
});

test("4d: a 1ª escolha numa loja com pedido mínimo já avisa o mínimo (não só no fechamento)", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("carrefour-pao", "Pão de Forma Tradicional 400g", 6.99, "carrefour", "Carrefour", "hoje")];
  const phone = await customerWith({ pending: [{ query: "pão de forma", qty: 1, options }, { query: "leite", qty: 1, options: [opt("oba-leite", "Leite Integral 1L", 5.49, "oba", "Oba")] }] }, "choosing");
  const out = await send(phone, "1");
  assert.match(out, /A \*Carrefour\* tem pedido mínimo de \*R\$ [\d,]+\* — faltam \*R\$ [\d,]+\*/, out);
  assert.doesNotMatch(out, /Essa escolha \./, out);
});

test("4e: a nota do 'o mais barato' não diz 'somava mais uma entrega' quando a escolhida também abre entrega", () => {
  const note = copy.cheapestForOrderNote({ name: "Suco Kapo 200ml", price: 3.62, store: "Mambo", pricierDelivery: { theirs: 15.9, ours: 6.9 } });
  assert.match(note, /entrega de lá sai ~R\$ 15,90 e a deste, ~R\$ 6,90/, note);
  assert.doesNotMatch(note, /somava mais uma entrega/, note);
});

// 5 ------------------------------------------------------------------------------------------------------------------
test("5: 'essa estoura meus 100 reais, tem uma mais em conta ou de 3kg?' é pedido de opção, não a resposta do teto", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("oba-gato1", "Ração Golden Gatos Castrados Salmão 1 kg", 37.39, "oba", "Oba"), opt("oba-gato2", "Ração Whiskas Gatos Castrados 900g", 28.04, "oba", "Oba")];
  const phone = await customerWith({ pending: [{ query: "ração gato castrado", qty: 1, options }] }, "choosing");
  const out = await send(phone, "essa estoura meus 100 reais, tem uma mais em conta ou de 3kg?");
  assert.doesNotMatch(out, /ainda não tem nada escolhido pra eu somar/, out.slice(0, 400));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.orderBudget?.cap, 100, "o teto dito fica guardado");
  assert.ok(!(ctx.pending ?? []).some((p) => /cachorro/.test(p.query)), JSON.stringify(ctx.pending?.map((p) => p.query)));
});

// 6 ------------------------------------------------------------------------------------------------------------------
test("6a: troca em aberto não aparece como item faltando no parcial", async (t) => {
  if (!dbOk) return t.skip();
  const caderno = line("oba-cad", "Caderno Brochura 48 Folhas", 7.22, "oba", "Oba");
  const options = [opt("carrefour-cad", "Caderno Tilibra 96 folhas", 15.94, "carrefour", "Carrefour")];
  const phone = await customerWith({ basket: [caderno], pending: [{ query: "caderno", qty: 1, replaceSku: caderno.sku, options }] }, "choosing");
  const out = await send(phone, "o que tem na cesta?");
  assert.doesNotMatch(out, /Falta escolher: caderno\b/, out);
  assert.match(out, /troca de caderno/, out);
});

test("6b: produto com várias variações (paracetamol 10 × 20 comprimidos): o link do card abre a variação do card (skuId)", () => {
  const product = {
    productName: "Pilha Alcalina AA Duracell",
    link: "/pilha-alcalina-aa-duracell-4-unidades/p",
    categories: ["/Eletroportáteis/"],
    items: [
      { itemId: "111", nameComplete: "Pilha Alcalina AA Duracell 2 Unidades", images: [], sellers: [{ sellerId: "1", commertialOffer: { Price: 5.9, AvailableQuantity: 5 } }] },
      { itemId: "222", nameComplete: "Pilha Alcalina AA Duracell 4 Unidades", images: [], sellers: [{ sellerId: "1", commertialOffer: { Price: 9.9, AvailableQuantity: 5 } }] }
    ]
  };
  const items = parseLiveProducts("casaevideo", [product] as never);
  const ten = items.find((i) => /2 Unidades/.test(i.name));
  assert.ok(ten, JSON.stringify(items));
  assert.match(ten!.productUrl ?? "", /[?&]skuId=111\b/);
  const single = parseLiveProducts("casaevideo", [{ ...product, items: [product.items[0]] }] as never);
  assert.doesNotMatch(single[0]?.productUrl ?? "", /skuId/);
});

test("6c: remédio isento ligado: 'tem dipirona pra eu colocar no kit?' com outro item na tela procura a dipirona (não 'me diz o nome')", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  try {
    __setDialogueModelForTests(async (input) => (/dipirona/i.test(input.text) ? { actions: [{ type: "refine", attribute: "dipirona" }] } : null));
    const phone = await signedUp();
    await send(phone, "lenço umedecido e sabonete");
    assert.match((await ctxOf(phone)).pending?.[0]?.query ?? "", /len[cç]o/);
    process.env.LIA_MEDICINE_MIP = "true";
    const out = await send(phone, "tem dipirona pra eu colocar no kit?");
    assert.doesNotMatch(out, /Me diz o nome/i, out);
    assert.doesNotMatch(out, /Não achei \*len/i, out);
    const ctx = await ctxOf(phone);
    assert.match(ctx.pending?.[0]?.query ?? "", /len[cç]o/, `o lenço continua na tela: ${out.slice(0, 600)} :: ${JSON.stringify(ctx.pending?.map((p) => p.query))}`);
    assert.ok((ctx.pending ?? []).some((p) => /dipirona/.test(p.query)) || (ctx.listMisses ?? []).some((m) => /dipirona/.test(m.query)) || /dipirona/i.test(out), out);
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});
