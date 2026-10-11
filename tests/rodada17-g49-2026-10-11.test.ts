// Rodada 17, grupo G49 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada17/grupo-b.md e achados R16-10/R16-11.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, measureChange, runTurnScoped } from "../src/lib/delivery-service";
import { conciergeMatchIsStrong, rankCatalog, variantPenalty } from "../src/lib/stores/types";
import { answerProductQuestion, parseProductQuestion } from "../src/lib/product-question";
import { findShelfForProduct } from "../src/lib/recommend/fallback";
import { SHELF_MAP } from "../src/lib/recommend/shelf-map";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __setLiveSimulateForTests, __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { detectIntent, parseBasketLines } from "../src/lib/lia-intents";
import { isVetMedicineAsk } from "../src/lib/medicine";
import * as copy from "../src/lib/lia-copy";
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g49_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });
const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});

const cat = (rows: Array<[string, string?]>) => rows.map(([name, brand], i) => ({ sku: `s${i}`, name, brand: brand ?? "", unitPrice: 10, category: "" }));
const names = (q: string, items: ReturnType<typeof cat>) => rankCatalog(q, items as never, 10).map((it) => it.name);

// ---------------------------------------------------------------- R17-2: oração explicativa não é 2ª remoção

test("R17-2: 'tira o perfume, ela gosta é de chá mesmo' tira só o perfume", () => {
  assert.deepEqual(detectIntent("tira o perfume, ela gosta é de chá mesmo"), { kind: "remove_item", target: "perfume" });
  assert.deepEqual(detectIntent("tira o arroz, porque já tenho"), { kind: "remove_item", target: "arroz" });
  // Lista de remoção e "tira X, quero Y" continuam.
  assert.equal((detectIntent("tira o arroz, o feijão") as { target: string }).target, "arroz, feijao");
  assert.deepEqual(detectIntent("tira o café, quero chá"), { kind: "remove_item", target: "cafe", andAdd: "cha" });
});

test("R17-2: na conversa, o chá fica na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [bi("bot-1", "Perfume Feminino Parfum Brasil Escandalo 100ml", 94.59), bi("drogal-1", "Chá Leão Camomila 10 sachês", 6.5)] });
  const out = await send(c.phone, "tira o perfume, ela gosta é de chá mesmo");
  const basket = (await ctxOf(c.convoId)).basket ?? [];
  assert.deepEqual(basket.map((b) => b.sku), ["drogal-1"], out);
});

// ---------------------------------------------------------------- R17-9: "ideia de presente" é moldura

test("R17-9: 'uma ideia de presente… ela gosta de chá e chocolate' anota chá e chocolate, sem item de presente", () => {
  const lines = parseBasketLines("preciso de uma ideia de presente de aniversario pra minha sogra, ela gosta de cha e chocolate, ate 80 reais");
  assert.deepEqual(lines.map((l) => l.phrase.replace(/ até 80 reais$/, "")), ["cha", "chocolate"]);
  assert.deepEqual(parseBasketLines("uma sugestão de presente pra minha mãe, ela gosta de vinho").map((l) => l.phrase), ["vinho"]);
});

// ---------------------------------------------------------------- R17-5: remédio de bicho

test("R17-5: vermífugo e remédio pro cachorro são remédio veterinário, com copy própria", () => {
  assert.equal(isVetMedicineAsk("vcs vendem vermifugo?"), true);
  assert.equal(isVetMedicineAsk("remédio pro cachorro com diarreia"), true);
  assert.equal(isVetMedicineAsk("antipulgas pra gato"), true);
  assert.equal(isVetMedicineAsk("ração pro cachorro"), false);
  assert.equal(isVetMedicineAsk("dipirona"), false);
  assert.match(copy.vetMedicineRefusal(), /veterin/i);
  assert.doesNotMatch(copy.vetMedicineRefusal(), /dipirona/);
});

test("R17-5: 'vcs vendem vermifugo?' recebe a recusa veterinária (com e sem o isento ligado)", async (t) => {
  if (!dbOk) return t.skip();
  for (const mip of [false, true]) {
    if (mip) process.env.LIA_MEDICINE_MIP = "true";
    try {
      const c = await customerWith({});
      const out = await send(c.phone, "vcs vendem vermifugo?");
      assert.match(out, /veterin/i, out);
      assert.doesNotMatch(out, /dipirona/i, out);
    } finally {
      delete process.env.LIA_MEDICINE_MIP;
    }
  }
});

// ---------------------------------------------------------------- R17-6: "2" solto e "30 unidades"

test("R17-6: '2' solto com o item já convertido em embalagens não muda a quantidade", async (t) => {
  if (!dbOk) return t.skip();
  const tapete = bi("cobasi-1", "Tapete Higiênico Go Pads Slim 80x60cm 30 unidades", 50, { askedUnits: { units: 30, packs: 1 } });
  const c = await customerWith({ basket: [tapete] });
  const out = await send(c.phone, "2");
  assert.equal((await ctxOf(c.convoId)).basket?.[0].qty, 1, out);
  assert.match(out, /põe 2/, out);
  // Sem conversão, o número solto continua ajustando (rodada 13 de 14/08).
  const d = await customerWith({ basket: [bi("x-1", "Arroz Camil 5kg", 30)] });
  await send(d.phone, "2");
  assert.equal((await ctxOf(d.convoId)).basket?.[0].qty, 2);
});

test("R17-6: 'tapete higiênico 30 unidades' anota 30 unidades, não 30x tapete", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newcomer();
  const out = await send(c.phone, "tapete higienico 30 unidades");
  assert.doesNotMatch(out, /30x/, out);
  assert.match(out, /tapete higienico, 30 unidades/i, out);
  assert.equal(parseBasketLines("tapete higienico 30 unidades")[0].qty, 30);
});

// ---------------------------------------------------------------- R17-7: medida na troca de loja

test("R17-7: a troca que perde ou muda a medida avisa", () => {
  assert.deepEqual(measureChange('Flexível de Inox Trançado Esteves 1/2" x 40cm', "Engate Flexível Metálico Macho Fêmea Wog"), { from: "40 cm" });
  assert.deepEqual(measureChange("Papel Higiênico Neve Folha Dupla 12 rolos", "Papel Higiênico Folha Dupla Fofinho 30m"), { from: "12 rolos" });
  assert.deepEqual(measureChange("Papel Higiênico Neve 12 rolos", "Papel Higiênico Personal 4 rolos"), { from: "12 rolos", to: "4 rolos" });
  assert.equal(measureChange("Refrigerante Coca-Cola 2L", "Coca Cola Original 2 litros"), null);
  assert.equal(measureChange("Fita Isolante 3M", "Fita Isolante Tigre"), null);
  // A medida dita no pedido também vale.
  assert.deepEqual(measureChange("Flexível Esteves Inox", "Engate Flexível Wog", "flexivel 40cm"), { from: "40 cm" });
  assert.match(copy.swapMeasureNote("40 cm"), /não confirmei a medida \(era 40 cm\)/);
});

// ---------------------------------------------------------------- R17-8: chá

const TEAS = cat([["Chá Matte Leão Natural 450ml", "Leão"], ["Chá Mamãe Weleda 22,5g", "Weleda"], ["Chá Matte Ice Tea Leão Pêssego 450ml", "Leão"], ["Chá Leão Camomila 10 sachês", "Leão"], ["Chá Sortido Basilur 80g", "Basilur"]]);
test("R17-8: 'chá' solto é a infusão (sachê/folha) antes da bebida pronta e do chá de lactante", () => {
  const top = names("chá", TEAS);
  assert.ok(top.indexOf("Chá Leão Camomila 10 sachês") < top.indexOf("Chá Matte Leão Natural 450ml"), top.join(" | "));
  assert.ok(top.indexOf("Chá Sortido Basilur 80g") < top.indexOf("Chá Mamãe Weleda 22,5g"), top.join(" | "));
  assert.equal(names("chá de camomila", TEAS)[0], "Chá Leão Camomila 10 sachês");
  assert.ok(variantPenalty("chá", "Chá Matte Ice Tea Leão Pêssego 450ml") > variantPenalty("chá", "Chá Leão Camomila 10 sachês"));
  // Quem pede o pronto/gelado não é penalizado.
  assert.match(names("chá gelado 450ml", TEAS)[0], /450ml/);
});

test("R17-8: 'põe o chá de volta, de camomila' busca chá de camomila", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [bi("x-1", "Chocolate Lindt 100g", 20)], lastRemoved: { items: [], queries: ["chá"], at: Date.now() } });
  const out = await send(c.phone, "põe o chá de volta, de camomila");
  assert.match(out, /camomila/i, out);
});

// ---------------------------------------------------------------- R17-11: Coca-Cola

const COCAS = cat([["Refrigerante Coca-Cola Sem Açúcar Garrafa Pet 2 Litro", "Coca-Cola"], ["Refrigerante Coca Cola Original - 2 litros", "Coca-Cola"], ["Refrigerante Coca-Cola Zero 2L", "Coca-Cola"], ["Refrigerante Sprite Limão 2L", "Coca-Cola"]]);
test("R17-11: 'normal' / 'não a zero' tiram Zero e Sem Açúcar; sem qualificador a original vem antes no desempate", () => {
  for (const q of ["Coca-Cola normal 2 litros", "coca cola 2 litros, não a zero", "a coca original 2l"]) {
    const top = names(q, COCAS);
    assert.ok(!top.some((n) => /zero|sem a/i.test(n)), `${q}: ${top.join(" | ")}`);
    assert.equal(top[0], "Refrigerante Coca Cola Original - 2 litros", q);
  }
  assert.ok(variantPenalty("coca cola 2L", "Refrigerante Coca Cola Original - 2 litros") < variantPenalty("coca cola 2L", "Refrigerante Coca-Cola Sem Açúcar Garrafa Pet 2 Litro"));
  // Pedir zero / sem açúcar continua trazendo.
  assert.match(names("coca zero 2l", COCAS)[0], /Zero/);
  assert.match(names("coca sem açúcar", COCAS)[0], /Sem Açúcar/);
});

// ---------------------------------------------------------------- R16-10 / R16-11

test("R16-10: ração de coelho filhote não traz ração de cachorro; prateleira não vira 'alimento para pássaros'", () => {
  const items = cat([["Ração Golden Cães Filhotes 1kg", "Golden"], ["Ração Nutrópica Coelho Filhote 1,5kg", "Nutrópica"], ["Ração Megazoo Coelhos Adultos 500g", "Megazoo"]]);
  const top = names("ração pra coelho filhote", items);
  assert.ok(!top.some((n) => /Cães/.test(n)), top.join(" | "));
  assert.equal(top[0], "Ração Nutrópica Coelho Filhote 1,5kg");
  const shelf = findShelfForProduct("ração pra coelho filhote", SHELF_MAP.shelves);
  assert.ok(!shelf || !/cachorro|gato|passaro|peixe/.test(shelf.query), shelf?.query);
  assert.equal(findShelfForProduct("ração pro cachorro", SHELF_MAP.shelves)?.id, "pet.racao_cachorro");
});

test("R16-11: 'copo descartável' traz o copo, não o copo de inalador", () => {
  const items = cat([["Copo Inalador Descartável NS 20 Unidades", "NS"], ["Copo Descartável 200ml 100 unidades", "Copobras"]]);
  assert.equal(names("copo descartável", items)[0], "Copo Descartável 200ml 100 unidades");
  assert.ok(variantPenalty("copo descartável", "Copo Inalador Descartável NS 20 Unidades") > variantPenalty("copo descartável", "Copo Descartável 200ml 100 unidades"));
});

// ---------------------------------------------------------------- R17a-4: perguntas sobre o card / marca solta

test("R17a-4: 'o primeiro é de quantas escovas?' e 'o segundo é integral?' respondem pelo nome do card", () => {
  const escovas = [{ name: "Escova de Dente Oral Nexter Orbit Macia Adulto 3 Unidades", price: 9.9 }, { name: "Escova Dental Colgate Classic", price: 5 }];
  const q1 = parseProductQuestion("o primeiro é de quantas escovas?", 2, escovas.map((o) => o.name));
  assert.deepEqual(q1, { kind: "spec_count", n: 1 });
  assert.match(answerProductQuestion(q1!, escovas, "escova de dente"), /3 unidades/);
  assert.match(answerProductQuestion({ kind: "spec_count", n: 2 }, escovas, "escova de dente"), /não diz quantas/);
  const leites = [{ name: "Leite Integral Piracanjuba 1L", price: 6 }, { name: "Leite Leitíssimo 1L", price: 6.5 }];
  const q2 = parseProductQuestion("o segundo é integral?", 2, leites.map((o) => o.name));
  assert.deepEqual(q2, { kind: "spec_word", n: 2, word: "integral" });
  const a2 = answerProductQuestion(q2!, leites, "leite");
  assert.match(a2, /não diz \*integral\*/);
  assert.match(a2, /opção \*1\*/);
  assert.match(answerProductQuestion({ kind: "spec_word", n: 1, word: "integral" }, leites, "leite"), /^Sim/);
  // O que já era respondido continua: medida e uso; juízo ("é bom?") não vira palavra do nome.
  assert.equal(parseProductQuestion("o primeiro é 75g?", 2, ["Papel 75g", "Papel 90g"])?.kind, "spec");
  assert.equal(parseProductQuestion("o primeiro é bom?", 2, ["A", "B"]), null);
  assert.notEqual(parseProductQuestion("o primeiro serve pra filhote?", 2, ["Ração Filhote", "Ração Adulto"])?.kind, "spec_word");
});

test("R17a-4: 'vcs tem johnson?' sem nada na mesa busca a marca", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const out = await send(c.phone, "vcs tem johnson?");
  assert.doesNotMatch(out, /compro em várias lojas/i, out);
  assert.match(out, /johnson/i, out);
});

// ---------------------------------------------------------------- R17a-5

test("R17a-5: 'e ração pra coelho então? tem alguma que sirva pra filhote?' é um item só, sem o 'então'", () => {
  assert.deepEqual(parseBasketLines("e ração pra coelho então? tem alguma que sirva pra filhote?").map((l) => l.phrase), ["ração pra coelho filhote"]);
  assert.deepEqual(parseBasketLines("ração pra coelho, tem pra filhote?").map((l) => l.phrase), ["ração pra coelho filhote"]);
});

test("R17a-5: 'pula' na oferta de juntar por texto mantém as lojas (não busca 'pula')", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [bi("carrefour-1", "Leite Integral Piracanjuba 1L", 6, { storeKey: "carrefour", storeLabel: "Carrefour" }), bi("oba-1", "Arroz Camil 5kg", 30, { storeKey: "oba", storeLabel: "Oba" })];
  const key = basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");
  const c = await customerWith({ basket, consolidationOffer: { key, basket, storeLabel: "Carrefour", stores: 2, pairs: [], delta: 0 } });
  const out = await send(c.phone, "pula");
  assert.match(out, /mantenho as 2 lojas/i, out.slice(0, 500));
  assert.doesNotMatch(out, /Opções de \*pula\*/i, out.slice(0, 500));
});

test("R17a-5: 'escolhe o mais barato de cada' vale para todos os itens em escolha", async (t) => {
  if (!dbOk) return t.skip();
  const pend = (q: string, a: ChoiceOption, b: ChoiceOption) => ({ query: q, qty: 1, options: [a, b] });
  const c = await customerWith({
    pending: [
      pend("leite", opt("x-l1", "Leite Integral A 1L", 7), opt("x-l2", "Leite Integral B 1L", 5)),
      pend("leite condensado", opt("x-c1", "Leite Condensado A", 8), opt("x-c2", "Leite Condensado B", 6)),
      pend("achocolatado", opt("x-a1", "Achocolatado A", 9), opt("x-a2", "Achocolatado B", 4))
    ]
  }, "choosing");
  const out = await send(c.phone, "escolhe o mais barato de cada");
  const skus = ((await ctxOf(c.convoId)).basket ?? []).map((b) => b.sku).sort();
  assert.deepEqual(skus, ["x-a2", "x-c2", "x-l2"], out.slice(0, 600));
});

// ---------------------------------------------------------------- R17a-6: coca durante a escolha do guaraná

test("R17a-6: 'dois de coca cola' depois de 'dois litros de guaraná' é a coca de 2 litros", () => {
  const lines = parseBasketLines("um refrigerante de dois litros de guaraná e dois de coca cola");
  assert.deepEqual(lines[1], { phrase: "coca cola 2l", qty: 1 });
  // Sem medida antes, "dois de" continua quantidade.
  assert.equal(parseBasketLines("dois de coca cola")[0].qty, 2);
});

test("R17a-6: com o guaraná na mesa, 'quero a coca de 2 litros, 2 garrafas' não refina o guaraná", async (t) => {
  if (!dbOk) return t.skip();
  const gua = [opt("x-g1", "Refrigerante Guaraná Antarctica 2L", 9), opt("x-g2", "Refrigerante Guaraná Kuat 2L", 8)];
  const c = await customerWith({ pending: [{ query: "refrigerante de guaraná 2 litros", qty: 1, options: gua }] }, "choosing");
  const out = await send(c.phone, "quero a coca de 2 litros, 2 garrafas");
  assert.doesNotMatch(out, /guaran[aá] 2 litros coca|unidades de \*refrigerante de guaran/i, out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const guarana = ctx.pending?.find((p) => /guaran/.test(p.query));
  const coca = ctx.pending?.find((p) => /coca/.test(p.query));
  assert.equal(guarana?.qty, 1, out.slice(0, 600));
  assert.ok(coca, out.slice(0, 600));
  assert.equal(coca?.qty, 2, out.slice(0, 600));
});

// ---------------------------------------------------------------- R17a-7

test("R17a-7: 'grampeador de escritório' acha o grampeador comum", () => {
  const items = cat([["Grampeador 26/6 Cis Metal", "Cis"], ["Grampo para Grampeador 26/6", "Cis"]]);
  assert.equal(conciergeMatchIsStrong("grampeador de escritório", items[0] as never), true);
  assert.equal(names("grampeador de escritório", items)[0], "Grampeador 26/6 Cis Metal");
});
