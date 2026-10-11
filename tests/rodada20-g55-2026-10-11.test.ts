// Rodada 20, grupo G55 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada20/grupo-b.md e grupo-a.md (R20-*, R20a-*).
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, movedLineQty, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { asksFreightPriceDiff, isOccasionWhen, parseAvailabilityAsk, parseBasketLines, parseNeededBy, refineBaseQuery, splitCommandClauses, splitNegatedTerms } from "../src/lib/lia-intents";
import { nameScent, parseChosenItemTrait, parseProductQuestion } from "../src/lib/product-question";
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
    outbox.push({ to, kind: key, text: [text, more].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ") });
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
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g55_${RUN}_${++seq}` }));
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

// ---------------------------------------------------------------- R20-1: troca de pacote por avulso mantém as unidades

const PACK = bi("rihappy-100161271", "Canetas Esferográficas - Cristal Fina - 3 Unidades - Azul - BIC", 6.99, {
  storeKey: "rihappy",
  storeLabel: "Ri Happy",
  ask: "caneta bic azul",
  askedUnits: { units: 3, packs: 1 }
});

test("R20-1: a linha que muda de produto leva as unidades pedidas (1 pacote de 3 → 3 avulsas; outro pacote de 3 → 1)", () => {
  assert.equal(movedLineQty(PACK, { name: "Caneta Esferográfica Azul Cristal Bic" }), 3);
  assert.equal(movedLineQty(PACK, { name: "Caneta Esferográfica Cristal Fashion 3 Unidades Bic Azul" }), 1);
  // Sem a conversão de embalagem registrada, a quantidade da linha vale como antes.
  assert.equal(movedLineQty({ ...PACK, askedUnits: undefined, qty: 2 }, { name: "Caneta Esferográfica Azul Cristal Bic" }), 2);
});

test("R20-1: escolher a caneta avulsa na troca do pacote de 3 põe 3 canetas na cesta, e o resto fica", async (t) => {
  if (!dbOk) return t.skip();
  const caderno = bi("livrariascuritiba-365305", "Caderno Universitário 10 Matérias 160 Folhas Pepper Capa Dura", 17.76, { storeKey: "livrariascuritiba", storeLabel: "Livrarias Curitiba" });
  const c = await customerWith(
    {
      basket: [caderno, PACK],
      pending: [{ query: "caneta bic azul", qty: 1, replaceSku: PACK.sku, options: [opt("livrariascuritiba-116047", "Caneta Esferográfica Azul Cristal Bic", 1.33, "livrariascuritiba", "Livrarias Curitiba")] }],
      closeAfterChoices: true,
      costlySwapOffered: true
    },
    "choosing"
  );
  await send(c.phone, "optsku:livrariascuritiba-116047");
  const basket = (await ctxOf(c.convoId)).basket ?? [];
  assert.equal(basket.find((b) => b.sku === "livrariascuritiba-116047")?.qty, 3, JSON.stringify(basket));
  assert.ok(basket.some((b) => b.sku === caderno.sku));
  assert.ok(!basket.some((b) => b.sku === PACK.sku));
});

// ---------------------------------------------------------------- R20-2: autocorreção na mesma frase

test("R20-2: 'nao, espera, em vez de alcool em gel quero alcool 70 liquido' troca o gel e 'espera' nunca é item", () => {
  const out = phrases("preciso de curativo, termometro e alcool em gel. nao, espera, em vez de alcool em gel quero alcool 70 liquido. ah e band-aid nao curativo grande");
  assert.ok(!out.some((p) => /espera|em vez/.test(p)), out.join(" | "));
  assert.ok(!out.some((p) => /gel/.test(p)), out.join(" | "));
  assert.ok(out.includes("alcool 70 liquido"), out.join(" | "));
  assert.ok(out.includes("termometro"), out.join(" | "));
  // "band-aid nao curativo grande": o band-aid entra no lugar do curativo dito antes.
  assert.ok(out.includes("band-aid") && !out.includes("curativo"), out.join(" | "));
});

test("R20-2: outras formas da correção ('Y em vez de X', 'não quero X, quero Y', 'pera aí')", () => {
  assert.deepEqual(phrases("arroz, feijao, macarrao ao inves de feijao"), ["arroz", "macarrao"]);
  assert.deepEqual(phrases("nao quero gel, quero alcool 70 liquido"), ["alcool 70 liquido"]);
  assert.deepEqual(phrases("pera ai, quero 2 coca"), ["coca"]);
  // "leite nao desnatado" sem desnatado antes continua como está (não é troca).
  assert.deepEqual(phrases("leite nao desnatado"), ["leite nao desnatado"]);
});

test("R20-2/R20-7: refino com a escolha na tela tira o que foi negado e troca a medida do produto dito de novo", () => {
  const neg = (t: string) => splitNegatedTerms(t).excluded;
  assert.equal(refineBaseQuery("álcool em gel", "nao quero gel, quero alcool 70 liquido", neg("nao quero gel, quero alcool 70 liquido")), "alcool");
  assert.equal(refineBaseQuery("bucha 6", "bucha s6 de nylon", []), "bucha");
  // Sem negação nem produto dito de novo, a base fica.
  assert.equal(refineBaseQuery("fralda pampers", "tamanho p", []), "fralda pampers");
  assert.equal(refineBaseQuery("leite integral", "sem lactose", []), "leite integral");
});

// ---------------------------------------------------------------- R20-4: tira e coloca na mesma frase

test("R20-4: 'tira a esponja de aco coloca uma esponja amarela' são duas ordens", () => {
  assert.deepEqual(splitCommandClauses("tira a esponja de aco coloca uma esponja comum dessas amarela"), ["tira a esponja de aco", "coloca uma esponja comum dessas amarela"]);
  // Troca com "por" continua uma ordem só; nada muda sem o "tira" na frente.
  assert.deepEqual(splitCommandClauses("troca o arroz por integral"), ["troca o arroz por integral"]);
  assert.deepEqual(splitCommandClauses("coloca uma esponja amarela"), ["coloca uma esponja amarela"]);
});

test("R20-4: na conversa, tira a esponja de aço da fila e procura a amarela", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    {
      pending: [
        { query: "água sanitária", qty: 1, options: [opt("americanas-801", "Água Sanitária Qboa 1L", 5.17)] },
        { query: "esponja de aço", qty: 1, options: [opt("americanas-802", "Esponja de Aço Bombril 8 Unidades", 4.5)] }
      ]
    },
    "choosing"
  );
  const out = await send(c.phone, "tira a esponja de aco coloca uma esponja comum dessas amarela");
  assert.match(out, /Tirei/i, out);
  const ctx = await ctxOf(c.convoId);
  const queries = (ctx.pending ?? []).map((p) => p.query);
  assert.ok(!queries.includes("esponja de aço"), queries.join(" | "));
  assert.ok(queries.some((q) => /esponja/.test(q)) || /esponja/i.test(out.split("Tirei")[1] ?? ""), `${queries.join(" | ")}\n${out}`);
});

// ---------------------------------------------------------------- R20-5: perguntas de produto no meio

test("R20-5: 'tendi tem caderno 10 materias?' é pergunta de disponibilidade; antes do cadastro a Lia responde", () => {
  assert.equal(parseAvailabilityAsk("tendi tem caderno universitario 10 materias?"), "caderno universitario 10 materias");
  assert.match(copy.availabilityAfterAddress("caderno universitario 10 materias"), /Se tem \*caderno universitario 10 materias\*/);
});

test("R20-5: 'o termometro é digital mesmo?' pelo nome do item da cesta; 'qual a diferença de preço?' na entrega", () => {
  const names = ["Termômetro Clínico Digital G-tech Branco 1 Unidade termometro", "Álcool Líquido 70% Farmax 50ml álcool 70 líquido"];
  assert.deepEqual(parseChosenItemTrait("e o termometro é digital mesmo?", names), { index: 0, trait: "digital", known: true });
  assert.deepEqual(parseChosenItemTrait("o termometro é de mercurio?", names), { index: 0, trait: "mercurio", known: false });
  // Sem item da cesta citado, ou pergunta de outro tipo: não é esta pergunta.
  assert.equal(parseChosenItemTrait("o sabonete é de glicerina?", names), null);
  assert.equal(parseChosenItemTrait("qual é o prazo?", names), null);
  assert.ok(asksFreightPriceDiff("qual a diferença de preço?"));
  assert.ok(!asksFreightPriceDiff("qual a diferença entre o 1 e o 2?"));
  assert.match(copy.freightPriceDifference(2), /R\$ 2,00\* a mais/);
});

test("R20-5: na escolha da entrega, as duas perguntas têm resposta (diferença e 'digital' pelo nome)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({}, "collecting");
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: c.userId,
      phone: c.phone,
      cep: "01310-100",
      status: "awaiting_operator_quote",
      storeKey: "drogariasp",
      storeLabel: "Drogaria São Paulo",
      items: [{ sku: "dsp-711080", name: "Termômetro Clínico Digital G-tech Branco 1 Unidade", qty: 1, unitPrice: 13.99, lineTotal: 13.99, storeKey: "drogariasp", storeLabel: "Drogaria São Paulo" }],
      itemsSubtotal: 13.99,
      deliveryFee: 0,
      serviceFee: 1.4,
      total: 15.39,
      deliveryAddress: ADDRESS
    }
  });
  await prisma.conversation.update({
    where: { id: c.convoId },
    data: {
      currentStep: "choosing_freight",
      context: JSON.stringify({ flow: "delivery", step: "choosing_freight", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, deliveryOrderId: order.id, freightChoice: { orderId: order.id, itemsSubtotal: 13.99, serviceFee: 1.4, stores: 1, kind: "store", quotedAt: Date.now(), barato: { fee: 6.9, estimate: "1bd" }, rapido: { fee: 8.9, estimate: "10h" } } })
    }
  });
  const out = await send(c.phone, "qual a diferença de preço? e o termometro é digital mesmo?");
  assert.match(out, /R\$ 2,00\* a mais/, out);
  assert.match(out, /Sim — o da sua cesta é \*Termômetro Clínico Digital/, out);
  assert.match(out, /Escolhe a entrega/, out);
});

test("R20-5: 'o segundo tem cheiro de quê?' diz o que o nome informa, ou que não sabe", () => {
  const options = [
    { name: "Kit Hidratante Corporal Nivea Q10 2 Unidades", price: 75.66 },
    { name: "Kit Hidratante Corporal Nivea Milk Pele Seca 2 Unidades", price: 41.58 },
    { name: "Hidratante Corporal Lavanda Suave 400ml", price: 20 }
  ];
  const q = parseProductQuestion("o segundo tem cheiro de que? ela gosta de coisa suave", options.length, options.map((o) => o.name));
  assert.deepEqual(q, { kind: "scent", n: 2, mild: true });
  assert.equal(nameScent(options[1].name), undefined);
  assert.equal(nameScent(options[2].name), "lavanda, suave");
});

test("R20-5: 'tem a vela numero 6?' com a vela na tela procura o número 6 (o dígito não some do refino)", async (t) => {
  if (!dbOk) return t.skip();
  // Sem rede de lojas aqui: basta que o refino peça o 6 (a busca e o "não achei" dizem *número 6*).
  const c = await customerWith({ pending: [{ query: "vela de aniversário", qty: 1, options: [opt("americanas-701", "Vela de Aniversário Número 1", 7), opt("americanas-702", "Vela de Aniversário Número 8", 7)] }] }, "choosing");
  __setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "numero 6" }] }) as never);
  process.env.LIA_DIALOGUE_LLM = "true";
  const out = await send(c.phone, "ela faz 6 anos tem a vela numero 6");
  assert.match(out, /n[uú]mero 6/i, out);
});

test("R20-5: 'festa da minha filha hoje as 17h' é a ocasião, não item", () => {
  assert.ok(isOccasionWhen("festa da minha filha hoje as 17h"));
  assert.ok(!isOccasionWhen("bolo pra festa de hoje"));
});

// ---------------------------------------------------------------- R20-9: aviso de prazo por item consolidado

test("R20-9: o 'também não chega pra hoje às 17h' sai uma vez; do item seguinte em diante fica calado", async (t) => {
  if (!dbOk) return t.skip();
  const neededBy = parseNeededBy("pra hoje às 17h");
  if (!neededBy) return t.skip();
  const late = (sku: string, name: string, price: number): ChoiceOption => ({ ...opt(sku, name, price), delivery: "3 dias úteis" });
  const pend = (query: string, sku: string) => ({ query, qty: 1, options: [late(`${sku}-1`, `${query} A`, 5), late(`${sku}-2`, `${query} B`, 6)] });
  const c = await customerWith({ neededBy, pending: [pend("vela", "americanas-901"), pend("balão", "americanas-902"), pend("guardanapo", "americanas-903"), pend("copo descartável", "americanas-904"), pend("prato descartável", "americanas-905")] }, "choosing");
  const outs: string[] = [];
  for (const sku of ["americanas-901-1", "americanas-902-1", "americanas-903-1", "americanas-904-1"]) outs.push(await send(c.phone, `optsku:${sku}`));
  const also = outs.map((o) => (o.match(/também não chega pra/g) ?? []).length);
  assert.equal(also.reduce((a, b) => a + b, 0), 1, outs.join("\n=====\n"));
  // Os dois últimos itens não repetem nada sobre o prazo.
  assert.doesNotMatch(outs[2] + outs[3], /⏰/, outs.join("\n=====\n"));
});
