// Rodada 13, grupo G39 (10/10): reteste da rodada 13, grupo A (/mnt/project-files/testes-whatsapp/rodada13/grupo-a.md).
// Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "macarrão, molho de tomate e uns 4 tomates" perdia os tomates em 1 de 6 (a IA devolvia "tomate" no singular e o
//      pedido guardado fundia "4 tomate" no "molho de tomate" por palavra em comum);
//   2. aceite de troca de loja em frase natural trocava OUTRO item / entrava em loop;
//   3. refino preso: marca/loja das opções originais e "o lego" depois de "carrinho ou lego";
//   4. pergunta comparativa sobre as opções da tela caía no FAQ / listava os 5 cards;
//   5. "meia dúzia de pão de alho", "um par de pilhas", "não tenho escova macia", "o que você esqueceu de incluir?".
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { acceptsSwapOffer } from "../src/lib/lia-intents";
import { parseProductQuestion } from "../src/lib/product-question";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5533${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000 - Bela Vista, São Paulo/SP - CEP 01310-100";
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g39_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerChoosing(extra: Partial<DeliveryContext>) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", step: "choosing", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pendingSince: Date.now(), ...extra })
    }
  });
  return phone;
}
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });
const opt = (sku: string, name: string, unitPrice: number, storeKey = "carrefour", storeLabel = "Carrefour") => ({ sku, name, unitPrice, storeKey, storeLabel, delivery: "1 dia útil", etaMinutes: 1440 });
void customerChoosing;
void opt;
void ctxOf;

// 1 ------------------------------------------------------------------------------------------------------------------
test("1: pré-cadastro com a IA devolvendo 'tomate' no singular anota os 4 tomates ao lado do molho", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  for (const tomato of ["tomate", "tomates", "tomate italiano"]) {
    __setPreSignupModelForTests(async () => D({ items: [it("macarrão"), it("molho de tomate"), it(tomato, 4)] }));
    const phone = newPhone();
    await send(phone, "oi");
    const out = await send(phone, "quero macarrão, molho de tomate e uns 4 tomates");
    assert.match(out, /1x molho de tomate/i, out.slice(0, 600));
    assert.match(out, new RegExp(`4x ${tomato}`, "i"), out.slice(0, 600));
  }
  // Ordem invertida (tomate antes do molho) também não funde.
  __setPreSignupModelForTests(async () => D({ items: [it("tomate", 4), it("molho de tomate")] }));
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "uns 4 tomates e molho de tomate");
  assert.match(out, /4x tomate/i, out.slice(0, 600));
  assert.match(out, /1x molho de tomate/i, out.slice(0, 600));
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: aceite da troca de loja em frase natural; citar o item da oferta confirma, citar outro não", () => {
  const offer = ["Caneta Esferográfica Cristal Fashion 3 Unidades Bic", "caneta azul"];
  for (const s of ["pode trocar de loja então, sem problema", "aceito, pode trocar a caneta de loja", "pode trocar de loja, tranquilo", "ok, troca a caneta de loja por favor", "pode trocar de loja"]) {
    assert.equal(acceptsSwapOffer(s, offer), true, s);
  }
  assert.equal(acceptsSwapOffer("pode trocar o post-it de loja", offer), false);
  assert.equal(acceptsSwapOffer("aceito, pode trocar a caneta de loja"), false, "sem a oferta, o item citado não é aceite");
  assert.equal(acceptsSwapOffer("troca a caneta por uma preta"), false);
});

const SWAP_BASKET = [
  { sku: "americanas-3982722", name: "Caneta Esferográfica Cristal Fashion 3 Unidades Bic Ponta 1.2mm Média Azul", brand: "Bic", qty: 1, unitPrice: 7.99, lineTotal: 7.99, storeKey: "americanas", storeLabel: "Americanas", ask: "caneta azul", delivery: "prazo da loja: 2 dias úteis", freightFee: 12.9 },
  { sku: "dsp-813494", name: "Bloco De Notas Adesivas Post-it 3M Amarelo Neon 76mm X 76mm 45 Folhas", brand: "3M", qty: 1, unitPrice: 10.54, lineTotal: 10.54, storeKey: "drogariasp", storeLabel: "Drogaria São Paulo", ask: "bloco de post-it", delivery: "prazo da loja: 1 dia útil", freightFee: 6.9 }
];
const SWAP_OFFER = {
  fromStoreKey: "americanas",
  key: "americanas-3982722:1|dsp-813494:1",
  replacements: [{ fromSku: "americanas-3982722", qty: 1, option: { sku: "rihappy-100161271", name: "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", brand: "Bic", unitPrice: 6.99, storeKey: "rihappy", storeLabel: "Ri Happy", delivery: "prazo da loja: 4 dias úteis", verified: true, etaMinutes: 5760, freightFee: 9.94 } }]
};
for (const said of ["pode trocar de loja então, sem problema", "aceito, pode trocar a caneta de loja"]) {
  test(`2b: com a oferta da caneta aberta, '${said}' troca a CANETA (o post-it fica)`, async (t) => {
    if (!dbOk) return t.skip();
    const phone = await customerChoosing({ step: "collecting", basket: SWAP_BASKET, minSwap: SWAP_OFFER } as unknown as Partial<DeliveryContext>);
    const out = await send(phone, said);
    const ctx = await ctxOf(phone);
    const skus = (ctx.basket ?? []).map((b) => b.sku);
    assert.ok(skus.includes("rihappy-100161271"), `caneta trocada: ${JSON.stringify(skus)}\n${out.slice(0, 500)}`);
    assert.ok(skus.includes("dsp-813494"), `post-it mantido: ${JSON.stringify(skus)}`);
    assert.ok(!skus.includes("americanas-3982722"), JSON.stringify(skus));
    assert.doesNotMatch(out, /Qual op[cç][aã]o/i, out.slice(0, 500));
  });
}

// 3 ------------------------------------------------------------------------------------------------------------------
const FIO_ORIGINAL = [
  opt("drogariaspacheco-343820", "Fio Dental Extrafino Hillo 100m", 6.79, "drogariaspacheco", "Drogarias Pacheco"),
  opt("americanas-3658532", "Fio Dental Higiene Bucal Dental Clear Basic + Clear Blister 125m Mentol", 5.99, "americanas", "Americanas"),
  opt("drogal-5437", "Fio Dental Premium Oral Nexter Extra Fino Menta 100m", 6.99, "drogal", "Drogal"),
  opt("drogal-4556", "Fio Dental Premium Oral Nexter Fino Sabor Menta 125m", 7.99, "drogal", "Drogal")
];
const FIODENT = opt("farmaciaindiana-9685", "Fio Dental Fiodent Extra Fino 100m", 4.99, "farmaciaindiana", "Farmácia Indiana");
const refinedFio = () =>
  customerChoosing({
    pending: [{ query: "fio dental fiodent extra fino 100m", baseQuery: "fio dental", qty: 1, options: [FIODENT], shownOptions: [...FIO_ORIGINAL, FIODENT], shownSkus: [...FIO_ORIGINAL, FIODENT].map((o) => o.sku) }]
  } as Partial<DeliveryContext>);
test("3a: depois do refino 'Fiodent', 'o Hillo extrafino 100m da Pacheco' acha o Hillo das opções originais", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await refinedFio();
  const out = await send(phone, "o Hillo extrafino 100m da Pacheco");
  assert.doesNotMatch(out, /N[aã]o achei/i, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  const inBasket = (ctx.basket ?? []).some((b) => b.sku === "drogariaspacheco-343820");
  const narrowed = (ctx.pending?.[0]?.options ?? []).map((o) => o.sku);
  assert.ok(inBasket || (narrowed.length === 1 && narrowed[0] === "drogariaspacheco-343820"), `${JSON.stringify(narrowed)}\n${out.slice(0, 600)}`);
});
test("3b: 'mostra as opções de fio dental de novo' depois do refino volta às opções originais", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await refinedFio();
  const out = await send(phone, "mostra as opções de fio dental de novo");
  assert.match(out, /Hillo/, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  assert.ok((ctx.pending?.[0]?.options ?? []).some((o) => o.sku === "drogariaspacheco-343820"), JSON.stringify(ctx.pending?.[0]?.options?.map((o) => o.name)));
});
test("3c: 'o lego' com 'carrinho ou lego pra 5 anos' na tela filtra as opções mostradas, sem busca nova", async (t) => {
  if (!dbOk) return t.skip();
  const toys = [
    opt("drogal-23055", "Carrinho City Police Car 1 Unidade", 8.99, "drogal", "Drogal"),
    opt("americanas-8872076", "Blocos de Montar Infantil Lego Pokémon Bola Presenteada 30729 46 Peças 5 a 7 Anos", 49.99, "americanas", "Americanas"),
    opt("drogal-23048", "Carrinho Royal Toys Speed Turbo 1 Unidade", 9.99, "drogal", "Drogal"),
    opt("americanas-8872077", "Blocos de Montar Infantil Lego Pokémon Suprimentos para Treinadores 30730 56 Peças 5 a 7 Anos", 49.99, "americanas", "Americanas")
  ];
  const phone = await customerChoosing({ pending: [{ query: "carrinho ou lego para 5 anos", qty: 1, options: toys, shownOptions: toys, shownSkus: toys.map((o) => o.sku) }] } as Partial<DeliveryContext>);
  const out = await send(phone, "o lego");
  const ctx = await ctxOf(phone);
  const left = (ctx.pending?.[0]?.options ?? []).map((o) => o.sku);
  assert.deepEqual(left, ["americanas-8872076", "americanas-8872077"], out.slice(0, 600));
  // "mostra as opções de novo" volta às de antes (carrinho incluído; a vitrine sem carrossel mostra 3).
  await send(phone, "mostra as opções de novo");
  const again = (await ctxOf(phone)).pending?.[0]?.options ?? [];
  assert.ok(again.length >= 3 && again.some((o) => /Carrinho/.test(o.name)) && again.some((o) => /Lego/.test(o.name)), JSON.stringify(again.map((o) => o.name)));
});

// 4 ------------------------------------------------------------------------------------------------------------------
const PAPEL = [
  opt("mambo-19878", "Papel Higiênico Folha Dupla Personal Vip Leve 18 Pague 16", 19.9, "mambo", "Mambo"),
  opt("drogariaspacheco-888516", "Papel Higiênico Deluxe Cotton Folha Dupla 20m 12 Rolos", 11.99, "drogariaspacheco", "Drogarias Pacheco"),
  opt("americanas-1571777", "Papel Higiênico Folha Dupla Personal Vip Neutro 20m 12 Unidades", 12.99, "americanas", "Americanas"),
  opt("americanas-8770556", "Papel Higiênico Folha Dupla 30m 12 Rolos Personal VIP Neutro Macio", 19.99, "americanas", "Americanas"),
  opt("americanas-8779158", "Papel Higiênico Folha Dupla 30m 12 Rolos Familiar Macio e Resistente", 21.99, "americanas", "Americanas")
];
test("4a: pergunta comparativa usa só as opções citadas; produto fora da tela é dito", () => {
  const names = PAPEL.map((o) => o.name);
  const set = parseProductQuestion("qual a diferença entre o Deluxe Cotton e o Personal Vip?", 5, names);
  assert.equal(set?.kind, "compare_set", JSON.stringify(set));
  assert.ok(set?.kind === "compare_set" && !set.ns.includes(5), JSON.stringify(set));
  assert.deepEqual(parseProductQuestion("e o Fofinho, é melhor que esses?", 5, names), { kind: "not_shown", term: "fofinho" });
  const soap = ["Sabonete em Barra Lux Botanicals Flor de Lótus 85g", "Sabonete Líquido Lux Orquídea Negra 250ml", "Sabonete Dove Original 90g"];
  assert.deepEqual(parseProductQuestion("o Lux em barra é diferente do líquido?", 3, soap), { kind: "compare_set", ns: [1, 2] });
  assert.deepEqual(parseProductQuestion("qual a diferença entre esses dois?", 2, names.slice(0, 2)), { kind: "compare_all" });
  // Pedido de produto com o carrossel aberto continua não sendo pergunta comparativa.
  assert.equal(parseProductQuestion("quero um maior", 5, names), null);
  assert.equal(parseProductQuestion("tem um melhor que esse?", 5, names), null);
});
test("4b: na escolha, 'qual a diferença entre o Deluxe Cotton e o Personal Vip?' não lista o Familiar; 'e o Fofinho...' não cai na FAQ", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerChoosing({ pending: [{ query: "papel higiênico folha dupla", qty: 1, options: PAPEL }] } as Partial<DeliveryContext>);
  const out = await send(phone, "qual a diferença entre o Deluxe Cotton e o Personal Vip?");
  assert.match(out, /Deluxe Cotton/, out);
  assert.doesNotMatch(out, /Familiar/, out);
  const fof = await send(phone, "e o Fofinho, é melhor que esses?");
  assert.match(fof, /Fofinho\* não está entre as opções/, fof);
  assert.doesNotMatch(fof, /procuro o produto em várias lojas/i, fof);
});

// 5 ------------------------------------------------------------------------------------------------------------------
test("5a: 'meia dúzia de pão de alho' com pacote de 400g pergunta antes de pôr 6 pacotes; 'só 1' leva 1", async (t) => {
  if (!dbOk) return t.skip();
  const pao = opt("swift-1", "Pão de Alho Baguete Tradicional Swift 400g", 12.9, "swift", "Swift");
  const phone = await customerChoosing({ pending: [{ query: "pão de alho", qty: 6, qtyExplicit: true, options: [pao, opt("swift-2", "Pão de Alho Picante Swift 400g", 19.9, "swift", "Swift")] }] } as Partial<DeliveryContext>);
  const out = await send(phone, "1");
  assert.match(out, /Levo \*6 pacotes\*/, out);
  assert.ok(!(await ctxOf(phone)).basket?.length, "nada na cesta antes do sim");
  await send(phone, "só 1");
  const basket = (await ctxOf(phone)).basket ?? [];
  assert.equal(basket.find((b) => b.sku === "swift-1")?.qty, 1, JSON.stringify(basket));
});
test("5b: pré-cadastro com a IA lendo 'um par de pilhas AA' como 1 anota 2", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ items: [it("pilhas AA")] }));
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "um par de pilhas AA");
  assert.match(out, /2x pilhas AA/i, out);
});
test("5c: 'a escova tem que ser macia' com escovas macias na tela não diz 'não tenho'", async (t) => {
  if (!dbOk) return t.skip();
  const brushes = [
    opt("ESC-1", "Escova Dental Colgate Classic Clean Cerdas Macia 3 Unidades", 9.9),
    opt("ESC-2", "Escova Dental Oral-B Indicator Macia", 7.9),
    opt("ESC-3", "Escova Dental Curaprox 5460 Ultra Soft Macia", 29.9)
  ];
  const phone = await customerChoosing({ pending: [{ query: "escova de dente macia", qty: 1, options: brushes }, { query: "fio dental", qty: 1, options: [opt("FD-1", "Fio Dental Hillo 100m", 6.9)] }] } as Partial<DeliveryContext>);
  const out = await send(phone, "a escova tem que ser macia, e uma observação: pode ser de qualquer marca");
  assert.doesNotMatch(out, /N[aã]o tenho \*escova/i, out);
  assert.equal((await ctxOf(phone)).pending?.[0]?.options.length, 3);
});
