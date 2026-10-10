// Rodada 5, grupo G16 (10/10): "mais barato" que ignora o carrossel já mostrado, prazo "amanhã", nome + CPF + CEP na
// mesma mensagem, "quero a fralda de antes" respondendo "De qual item?", "pode ser o X e adiciona Y", "total" com
// cesta vazia/pergunta pendente, "sem perfume" no ranking e alerta da linha de teste.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, cheaperSwapPool, splitIdentity } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { satisfiesNegation } from "../src/lib/stores/types";
import { __setPreflightForTests, estimateDay } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem, ChoiceOption } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5577${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;

async function item(query: string, store: string, qty: number, nameRe: RegExp): Promise<BasketItem> {
  const c = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).find((x) => x.store.key === store && nameRe.test(x.item.name));
  assert.ok(c, `catálogo de teste sem ${query} em ${store}`);
  return { sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, qty, unitPrice: c!.item.unitPrice, lineTotal: Math.round(c!.item.unitPrice * qty * 100) / 100, storeKey: store, storeLabel: c!.store.label, productUrl: c!.item.productUrl };
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
after(async () => {
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g16_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}


const bi = (sku: string, name: string, unitPrice: number, extra: Partial<BasketItem> = {}): BasketItem => ({
  sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey: "americanas", storeLabel: "Americanas", ...extra
});
const opt = (sku: string, name: string, unitPrice: number, storeKey = "americanas", storeLabel = "Americanas"): ChoiceOption => ({ sku, name, unitPrice, storeKey, storeLabel });

// 1) "troca o protetor por um mais barato": as opções JÁ MOSTRADAS daquele item entram na comparação -----------------
test("cheaperSwapPool: opção já mostrada entra; mesmo tamanho primeiro; FPS pedido vem antes", () => {
  const cur = bi("cur", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99, { ask: "protetor solar fps 30" });
  const pool = cheaperSwapPool(
    cur,
    [opt("a", "Protetor Solar Corporal FPS 30 Basic+ 100ml", 22.99), opt("b", "Protetor Solar FPS 50 Suncare 30ml", 30), opt("c", "Protetor Solar Facial FPS 30 40ml", 20)],
    [opt("oaz", "Protetor Solar OAZ FPS 30 200ml", 41.99), opt("cb", "Protetor Solar Cenoura e Bronze FPS 30 200ml", 33.99), opt("cur", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99)]
  );
  assert.deepEqual(pool.map((o) => o.sku), ["cb", "oaz", "a", "b"]);
});

test("'troca o protetor por um mais barato': o 200 ml mais barato do carrossel mostrado entra no lugar", async (t) => {
  if (!dbOk) return t.skip();
  const cur = bi("americanas-2708695", "Protetor Solar FPS 30 Sundown Praia e Piscina 200ml", 44.99, { ask: "protetor solar fps 30" });
  const shown = [
    opt("americanas-2708695", cur.name, 44.99),
    opt("g16-oaz-200", "Protetor Solar OAZ FPS 30 Corporal 200ml", 14.19),
    opt("g16-cenoura-200", "Protetor Solar Cenoura e Bronze FPS 30 Frasco 200ml", 12.39)
  ];
  const c = await customerWith({ basket: [cur], lastChoice: { query: "protetor solar fps 30", qty: 1, options: shown, chosenSku: cur.sku } });
  const out = await send(c.phone, "troca o protetor por um mais barato");
  assert.doesNotMatch(out, /já é o mais barato|já está o mais barato/i, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  const skus = [...(ctx.basket ?? []).map((b: BasketItem) => b.sku), ...((ctx.pending?.[0]?.options ?? []) as ChoiceOption[]).map((o) => o.sku)];
  assert.ok(skus.includes("g16-cenoura-200"), `${skus.join(",")} :: ${out.slice(0, 400)}`);
});

// 2) Prazo: "aniversário amanhã" chega ao resumo; "urgente" com janela de amanhã não diz "Chega hoje" ----------------
test("estimateDay: janela agendada de amanhã é 'amanhã'; SLA em horas segue 'hoje'", () => {
  const now = new Date("2026-10-10T02:00:00Z"); // 23h de 09/10 em SP
  assert.equal(estimateDay("9h@2026-10-10T09:00:00+00:00~2026-10-10T11:00:59+00:00", now), "amanhã");
  assert.equal(estimateDay("9h@2026-10-10T00:30:00+00:00~2026-10-10T01:30:59+00:00", now), "hoje");
  assert.equal(estimateDay("2h", now), "hoje");
  assert.equal(estimateDay("30m", now), "hoje");
  assert.equal(estimateDay("0bd", now), "hoje");
  assert.equal(estimateDay("2bd", now), null);
  assert.doesNotMatch(copy.choicesHeaderToday("arroz", "amanha"), /hoje/i);
  assert.match(copy.choicesHeaderToday("arroz"), /Chega hoje/);
});

test("prazo dito ('amanhã') sobrevive ao fechamento: o resumo avisa que a entrega não chega a tempo", async (t) => {
  if (!dbOk) return t.skip();
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const c = await customerWith({ basket: [leite, arroz], neededBy: { date: tomorrow, label: "amanhã" } });
  const out = await send(c.phone, "só isso");
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual(ctx.neededBy, { date: tomorrow, label: "amanhã" }, out.slice(0, 600));
  if (/Total/.test(out) && /dias? úte/.test(out)) assert.match(out, /precisa pra \*amanhã\*/, out.slice(0, 600));
});

// 3) Nome + CPF + CEP + número na mesma mensagem, em qualquer ordem ------------------------------------------------
test("splitIdentity: nome e CPF saem em qualquer ordem; produto não vira nome", () => {
  const cpf = "52998224725";
  assert.deepEqual(splitIdentity("Rafael Torres, 529.982.247-25, CEP 01310-100 número 1000", cpf), { name: "Rafael Torres", rest: "CEP 01310-100 número 1000" });
  assert.deepEqual(splitIdentity("cpf 529.982.247-25 Rafael Torres cep 01310-100 numero 500", cpf), { name: "Rafael Torres", rest: "cep 01310-100 numero 500" });
  assert.deepEqual(splitIdentity("numero 500 Rafael Torres 529.982.247-25", cpf), { name: "Rafael Torres", rest: "numero 500" });
  assert.deepEqual(splitIdentity("leite ninho, Carolina Mendes cpf 52998224725", cpf), { name: "Carolina Mendes", rest: "leite ninho" });
  assert.deepEqual(splitIdentity("meu nome é Joana Prado e meu cpf é 529.982.247-25", cpf), { name: "Joana Prado", rest: "" });
  assert.deepEqual(splitIdentity("2 sabonetes dove, cpf 52998224725", cpf), { name: null, rest: "2 sabonetes dove" });
});

test("cadastro: 'Rafael Torres, 529.982.247-25, CEP 01310-100 número 1000' salva tudo e não vira item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address" }) } });
  const out = await send(phone, "Rafael Torres, 529.982.247-25, CEP 01310-100 número 1000");
  assert.doesNotMatch(out, /1x Rafael|Rafael Torres\* eu não achei|Anotei/i, out.slice(0, 500));
  const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(saved.cpf, "52998224725", out.slice(0, 500));
  assert.equal(saved.cpfName, "Rafael Torres");
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id } });
  assert.doesNotMatch(convo.context ?? "", /Rafael/, "o nome não ficou na lista de itens");
});

// 4) "De qual item?" + "não, quero a fralda de antes": recusa, não alvo -------------------------------------------
async function catalogOptions(query: string, re: RegExp, n: number): Promise<ChoiceOption[]> {
  const cands = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).filter((c) => re.test(c.item.name)).slice(0, n);
  assert.ok(cands.length >= n, `catálogo de teste sem ${query}`);
  return cands.map((c) => ({ sku: c.item.sku, name: c.item.name, brand: c.item.brand, unitPrice: c.item.unitPrice, storeKey: c.store.key, storeLabel: c.store.label }));
}
const asItem = (o: ChoiceOption, ask: string): BasketItem => ({ ...o, storeKey: o.storeKey ?? "", storeLabel: o.storeLabel ?? "", qty: 1, lineTotal: o.unitPrice, ask });

for (const decline of ["não, quero a fralda de antes", "deixa, fica com essa mesmo", "não, deixa como está"]) {
  test(`'De qual item?' + "${decline}": a cesta fica e a pergunta fecha`, async (t) => {
    if (!dbOk) return t.skip();
    const [prot] = await catalogOptions("protetor solar", /protetor/i, 1);
    const fraldas = await catalogOptions("fralda", /fralda/i, 2);
    const basket = [asItem(prot, "protetor solar"), asItem(fraldas[1], "fralda")];
    const c = await customerWith({ basket, cheaperAsk: { at: Date.now() } });
    const out = await send(c.phone, decline);
    assert.doesNotMatch(out, /Troquei|mais barat|De qual item/i, out.slice(0, 400));
    const ctx = await ctxOf(c.convoId);
    assert.equal(ctx.cheaperAsk, undefined);
    assert.deepEqual((ctx.basket ?? []).map((b: BasketItem) => b.sku).sort(), basket.map((b) => b.sku).sort(), out.slice(0, 400));
    assert.equal((ctx.pending ?? []).length, 0);
  });
}

test("'De qual item?' + 'a fralda' segue trocando pela mais barata", async (t) => {
  if (!dbOk) return t.skip();
  const [prot] = await catalogOptions("protetor solar", /protetor/i, 1);
  const fraldas = await catalogOptions("fralda", /fralda/i, 2);
  const c = await customerWith({ basket: [asItem(prot, "protetor solar"), asItem(fraldas[1], "fralda")], cheaperAsk: { at: Date.now() } });
  const out = await send(c.phone, "a fralda");
  assert.doesNotMatch(out, /mantenho|não troco nada/i, out.slice(0, 400));
});

// 5) Carrossel de leite aberto + "pode ser o semidesnatado e adiciona uma manteiga": escolhe e soma ------------------
async function leiteOptions(): Promise<ChoiceOption[]> {
  const cands = await gatherCrossStoreCandidates("leite", 40, 4, { noLongTail: true });
  const pick = (re: RegExp) => cands.find((c) => re.test(c.item.name));
  const chosen = [pick(/semidesnatad/i), pick(/integral/i), pick(/\bdesnatad/i)].filter(Boolean);
  assert.ok(chosen.length === 3, "catálogo de teste sem os 3 leites");
  return chosen.map((c) => ({ sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, unitPrice: c!.item.unitPrice, storeKey: c!.store.key, storeLabel: c!.store.label }));
}

for (const msg of ["pode ser o semidesnatado e adiciona uma manteiga", "pode ser o semidesnatado, e coloca uma manteiga"]) {
  test(`carrossel de leite aberto: "${msg}" escolhe o semidesnatado e soma a manteiga`, async (t) => {
    if (!dbOk) return t.skip();
    const leites = await leiteOptions();
    const deterg = bi("deterg-1", "Detergente Líquido Ype Neutro 500ml", 3.84, { ask: "detergente", storeKey: "carrefour", storeLabel: "Carrefour" });
    const c = await customerWith({ basket: [deterg], pending: [{ query: "leite", qty: 1, options: leites }] }, "choosing");
    const out = await send(c.phone, msg);
    const ctx = await ctxOf(c.convoId);
    const basketSkus = (ctx.basket ?? []).map((b: BasketItem) => b.sku);
    const pending = (ctx.pending ?? []) as Array<{ query: string; options: ChoiceOption[] }>;
    assert.ok(basketSkus.includes("deterg-1"), "a cesta ficou");
    // Regra do dono (04/09): nome digitado estreita para a opção do carrossel e o cliente confirma; nunca refaz a busca.
    const leitePend = pending.find((p) => /leite/i.test(p.query));
    const leiteOk = basketSkus.includes(leites[0].sku) || (leitePend && leitePend.options.length === 1 && leitePend.options[0].sku === leites[0].sku);
    assert.ok(leiteOk, `${basketSkus.join(",")} :: ${JSON.stringify(leitePend?.options.map((o) => o.sku))} :: ${out.slice(0, 500)}`);
    assert.doesNotMatch(leitePend?.query ?? "", /semidesnatad/i, "não refez a busca do leite");
    const names = `${(ctx.basket ?? []).map((b: BasketItem) => b.name).join(" | ")} | ${pending.map((p) => p.query).join(" | ")}`;
    assert.match(names, /manteiga/i, out.slice(0, 500));
  });
}

// 6) "total" com cesta vazia / com a pergunta da embalagem aberta; "sem perfume" no ranking ----------------------
test("'total' com a cesta vazia diz que está vazia", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({});
  const out = await send(c.phone, "total");
  assert.match(out, /cesta está vazia/i, out.slice(0, 300));
  assert.doesNotMatch(out, /não sei responder/i);
});

test("'total' com a pergunta 'sim ou outras' aberta: mostra o parcial e repete a pergunta", async (t) => {
  if (!dbOk) return t.skip();
  const option = { sku: "g16-ovos-10", name: "Ovos Vermelhos 10 un", unitPrice: 10, storeKey: "mambo", storeLabel: "Mambo" };
  const c = await customerWith({ pending: [{ query: "uma dúzia de ovos", qty: 12, qtyExplicit: true, options: [option] }], packConfirm: { sku: option.sku, askedQty: 12 } }, "choosing");
  const out = await send(c.phone, "total");
  assert.match(out, /10 unidades.*pediu \*12\*/s, out.slice(0, 500));
  const ctx = await ctxOf(c.convoId);
  assert.deepEqual(ctx.packConfirm, { sku: option.sku, askedQty: 12 }, "a pergunta segue aberta");
  const yes = await send(c.phone, "sim");
  assert.doesNotMatch(yes, /não entendi/i, yes.slice(0, 300));
  const after = await ctxOf(c.convoId);
  assert.ok((after.basket ?? []).some((b: BasketItem) => b.sku === option.sku), yes.slice(0, 300));
});

test("satisfiesNegation: 'sem cheiro' aceita 'sem perfume'/'sem fragrância'; sem 'sem' no pedido é null", () => {
  assert.equal(satisfiesNegation("areia sem cheiro 4kg", "Areia Higiênica Kets Gatíssimo sem Perfume 4 kg"), true);
  assert.equal(satisfiesNegation("shampoo sem perfume", "Shampoo Infantil Sem Fragrância 200ml"), true);
  assert.equal(satisfiesNegation("areia sem cheiro 4kg", "Areia Pipicat Classic 4kg"), false);
  assert.equal(satisfiesNegation("cafe sem acucar", "Café Solúvel Zero Açúcar"), true);
  assert.equal(satisfiesNegation("areia 4kg", "Areia Pipicat Classic 4kg"), null);
});
