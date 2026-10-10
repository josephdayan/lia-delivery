// Rodada 5, grupo G14 (10/10): item pendente que o cliente quer tirar ou pular (e "fecha" que não prende), troca que
// não some com o item da cesta, juntar lojas por texto, oferta de juntar que sobrevive a uma mensagem no meio, edição
// composta aplicada inteira com um total só no fim e "tira o kuat" que tira o produto todo.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { parseItemQtyEdit, parseJoinStoresAsk, splitCommandClauses } from "../src/lib/lia-intents";
import { gatherCrossStoreCandidates, listStores } from "../src/lib/stores";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";
import type { DialogueAction } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5577${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
    return key === "sendDeliveryChoices" ? false : key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
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
  __setPreflightForTests(async () => null);
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
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
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g14_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
async function catalogOptions(query: string, re: RegExp, n: number, store?: string): Promise<ChoiceOption[]> {
  const cands = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).filter((c) => re.test(c.item.name) && (!store || c.store.key === store)).slice(0, n);
  assert.ok(cands.length >= n, `catálogo de teste sem ${query}`);
  return cands.map((c) => ({ sku: c.item.sku, name: c.item.name, brand: c.item.brand, unitPrice: c.item.unitPrice, storeKey: c.store.key, storeLabel: c.store.label, productUrl: c.item.productUrl }));
}
const asItem = (o: ChoiceOption, ask: string, qty = 1): BasketItem => ({ sku: o.sku, name: o.name, brand: o.brand, qty, unitPrice: o.unitPrice, lineTotal: Math.round(o.unitPrice * qty * 100) / 100, storeKey: o.storeKey ?? "carrefour", storeLabel: o.storeLabel ?? "Carrefour", productUrl: o.productUrl, ask });
const velaOptions: ChoiceOption[] = [
  { sku: "g14-vela-1", name: "Vela de Aniversário Número 8", unitPrice: 6.9, storeKey: "carrefour", storeLabel: "Carrefour" },
  { sku: "g14-vela-2", name: "Vela Palito Colorida 24 Unidades", unitPrice: 4.5, storeKey: "carrefour", storeLabel: "Carrefour" }
];
// "Tenta de novo" de um item que não foi achado, com uma escolha aberta — o caminho de produção de 304 ("só o cartão")
// e 305 ("ração pra gatinho filhote qualquer marca"): a IA manda repetir a busca, que roda fora da escolha.
async function missDuringChoice(phone: string, convoId: string, query = "pneu de trator aro 38"): Promise<string> {
  const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } });
  const ctx = JSON.parse(convo.context ?? "{}");
  ctx.lastMiss = { query, qty: 1, at: Date.now() };
  await prisma.conversation.update({ where: { id: convoId }, data: { context: JSON.stringify(ctx) } });
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "search", query, qty: 1, retry: true }] }));
  try {
    return await send(phone, `tenta de novo o ${query}`);
  } finally {
    __setDialogueModelForTests(null);
    delete process.env.LIA_DIALOGUE_LLM;
  }
}
async function arrozItem(): Promise<BasketItem> {
  const [arroz] = await catalogOptions("arroz branco camil 5kg", /Camil.*5kg/i, 1, "carrefour");
  return asItem(arroz, "arroz camil 5kg");
}

// A1) Item pendente: tirar / esquecer / pular / "fecha" -----------------------------------------------------------------
test("estado da IA: escolha pendente com passo 'collecting' ainda aparece como emEscolha", () => {
  const ctx: DeliveryContext = { step: "collecting", basket: [{ sku: "a", name: "Arroz", qty: 1, unitPrice: 10, lineTotal: 10, storeKey: "carrefour", storeLabel: "Carrefour" }], pending: [{ query: "vela", qty: 1, options: velaOptions }] };
  const state = buildDialogueState(ctx, { hasAddress: true });
  assert.equal(state.passo, "escolhendo_opcao");
  assert.equal(state.emEscolha?.item, "vela");
});

test("busca que não acha nada com a vela em escolha: a escolha continua na mesa e o cliente é lembrado", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [await arrozItem()], pending: [{ query: "vela", qty: 1, options: velaOptions }] }, "choosing");
  const out = await missDuringChoice(c.phone, c.convoId);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.step, "choosing", out.slice(0, 400));
  assert.equal(ctx.pending?.[0]?.query, "vela");
  assert.match(out, /falta escolher \*vela\*/i, out.slice(0, 400));
});

for (const phrase of ["tira a vela", "esquece a vela", "nao quero a vela, tira", "sem vela", "pula essa"]) {
  test(`vela em escolha (passo gravado errado) + "${phrase}": sai a vela, a cesta fica`, async (t) => {
    if (!dbOk) return t.skip();
    const arroz = await arrozItem();
    const c = await customerWith({ basket: [arroz], pending: [{ query: "vela", qty: 1, options: velaOptions }] }, "collecting");
    const out = await send(c.phone, phrase);
    assert.doesNotMatch(out, /Não achei esse item|não vejo|Qual item/i, out.slice(0, 400));
    const ctx = await ctxOf(c.convoId);
    assert.equal((ctx.pending ?? []).length, 0, out.slice(0, 400));
    assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), [arroz.sku]);
  });
}

test("'fecha' com a vela em escolha: oferece fechar sem; 'sim' fecha sem a vela, com o total", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = await arrozItem();
  const c = await customerWith({ basket: [arroz], pending: [{ query: "vela", qty: 1, options: velaOptions }] }, "choosing");
  const ask = await send(c.phone, "fecha");
  assert.match(ask, /Fecho o pedido sem/i, ask.slice(0, 400));
  const out = await send(c.phone, "sim");
  assert.match(out, /Fechei sem \*vela\*/, out.slice(0, 600));
  // Fechou: total ou o aviso de pedido mínimo da loja — nunca de volta à escolha da vela.
  assert.match(out, /Total|pedido mínimo/, out.slice(0, 900));
  assert.doesNotMatch(out, /escolhe uma das opções de \*vela\*/i);
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.pending ?? []).length, 0);
});

test("'só isso' duas vezes com a vela em escolha não prende: a segunda fecha", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [await arrozItem()], pending: [{ query: "vela", qty: 1, options: velaOptions }] }, "choosing");
  await send(c.phone, "só isso");
  const out = await send(c.phone, "só isso");
  assert.doesNotMatch(out, /escolhe uma das opções de \*vela\*/i, out.slice(0, 400));
  assert.match(out, /Fechei sem \*vela\*/, out.slice(0, 600));
});

test("'fecha sem a vela' fecha direto", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({ basket: [await arrozItem()], pending: [{ query: "vela", qty: 1, options: velaOptions }] }, "choosing");
  const out = await send(c.phone, "fecha sem a vela");
  assert.match(out, /Fechei sem \*vela\*/, out.slice(0, 600));
  assert.equal(((await ctxOf(c.convoId)).pending ?? []).length, 0);
});

// A3) Troca que não some com o item da cesta ---------------------------------------------------------------------------
test("dois 'troca X por Y' seguidos e uma busca que falha: as duas escolhas continuam na mesa, o card vale e fechar sem escolher devolve o item", async (t) => {
  if (!dbOk) return t.skip();
  const [leite] = await catalogOptions("leite integral", /leite/i, 1);
  const [shampoo] = await catalogOptions("shampoo", /shampoo/i, 1);
  const arroz = await arrozItem();
  const leiteItem = asItem(leite, "leite integral", 2);
  const shampooItem = asItem(shampoo, "shampoo");
  const c = await customerWith({ basket: [leiteItem, shampooItem, arroz] });
  await send(c.phone, "troca o leite por leite em po");
  await send(c.phone, "troca o shampoo por um condicionador");
  let ctx = await ctxOf(c.convoId);
  assert.equal((ctx.pending ?? []).length, 2, "as duas trocas ficam enfileiradas");
  const miss = await missDuringChoice(c.phone, c.convoId);
  ctx = await ctxOf(c.convoId);
  assert.equal(ctx.step, "choosing", miss.slice(0, 400));
  assert.equal((ctx.pending ?? []).length, 2, miss.slice(0, 400));
  assert.match(miss, /falta escolher/i, miss.slice(0, 400));
  const first = ctx.pending![0];
  // O card da escolha aberta continua valendo (antes: "conversa antiga").
  const tap = await send(c.phone, `optsku:${first.options[0].sku}`);
  assert.doesNotMatch(tap, /conversa antiga/i, tap.slice(0, 400));
  ctx = await ctxOf(c.convoId);
  assert.ok((ctx.basket ?? []).some((b) => b.sku === first.options[0].sku), "a opção tocada entrou");
  // A outra troca ainda aberta: fechar sem escolher devolve o item que tinha saído.
  assert.equal((ctx.pending ?? []).length, 1);
  await send(c.phone, "fecha");
  const out = await send(c.phone, "sim");
  assert.match(out, /mantive/i, out.slice(0, 500));
  ctx = await ctxOf(c.convoId);
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const items = (ctx.basket?.length ? ctx.basket : ((order?.items as unknown as BasketItem[]) ?? [])) as BasketItem[];
  const back = first.query === "leite em po" ? shampooItem : leiteItem;
  assert.ok(items.some((i) => i.sku === back.sku), `o item da troca não escolhida voltou: ${JSON.stringify(items.map((i) => i.name))}`);
});

// A4) Juntar lojas por texto --------------------------------------------------------------------------------------------
test("parseJoinStoresAsk: pedidos de juntar (com e sem loja) e o que não é", () => {
  const labels = listStores().map((s) => s.label);
  labels.push("Mambo", "Casa Santa Luzia");
  for (const s of ["sim junta", "sim junta em menos lojas", "junta", "junta em menos lojas pra mim", "tudo na mesma loja", "TEM COMO JUNTAR TUDO NUMA LOJA SO PRA FICAR MAIS BARATO O FRETE?"]) assert.deepEqual(parseJoinStoresAsk(s, labels), {}, s);
  assert.deepEqual(parseJoinStoresAsk("junta tudo na mambo", labels), { store: "Mambo" });
  assert.deepEqual(parseJoinStoresAsk("quero trocar tudo pelos equivalentes da mambo", labels), { store: "Mambo" });
  for (const s of ["não precisa juntar", "prefiro separado", "manda junto com o arroz", "arroz da mambo", "leite e pão"]) assert.equal(parseJoinStoresAsk(s, labels), null, s);
});

async function twoStoreBasket() {
  const [leite] = await catalogOptions("leite integral piracanjuba", /Piracanjuba/, 1, "carrefour");
  const [arroz] = await catalogOptions("arroz branco camil 5kg", /Camil.*5kg/i, 1, "carrefour");
  const [coca] = await catalogOptions("refrigerante coca cola sem acucar lata", /Sem Açúcar Lata/i, 1, "oba");
  return [asItem(leite, "leite integral piracanjuba", 2), asItem(arroz, "arroz branco camil 5kg"), asItem(coca, "refrigerante coca cola sem acucar lata", 2)];
}

for (const phrase of ["sim junta em menos lojas", "tem como juntar tudo numa loja so?", "tudo na mesma loja"]) {
  test(`total na mesa com 2 lojas + "${phrase}": sai a oferta numerada; "1" junta`, async (t) => {
    if (!dbOk) return t.skip();
    // Cesta que já passou pela tentativa automática (como em 307, onde a oferta não veio no resumo).
    const basket = await twoStoreBasket();
    const c = await customerWith({ basket, consolidationTried: basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|") });
    const summary = await send(c.phone, "só isso");
    assert.match(summary, /Total/, summary.slice(0, 600));
    assert.doesNotMatch(summary, /Dá pra juntar/);
    const offer = await send(c.phone, phrase);
    assert.match(offer, /Dá pra juntar/, offer.slice(0, 600));
    assert.doesNotMatch(offer, /Como prefere pagar|Você quer seguir/i);
    const out = await send(c.phone, "1");
    assert.match(out, /Juntei/, out.slice(0, 600));
    const ctx = await ctxOf(c.convoId);
    const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
    const items = (ctx.basket?.length ? ctx.basket : ((order?.items as unknown as BasketItem[]) ?? [])) as BasketItem[];
    assert.equal(new Set(items.map((i) => i.storeKey)).size, 1, JSON.stringify(items.map((i) => i.storeKey)));
  });
}

test("'junta tudo na <loja>' aplica direto na loja nomeada", async (t) => {
  if (!dbOk) return t.skip();
  const probe = await customerWith({ basket: await twoStoreBasket() });
  const offer = await send(probe.phone, "junta");
  const label = offer.match(/juntar tudo na \*([^*]+)\*/)?.[1];
  assert.ok(label, offer.slice(0, 500));
  const c = await customerWith({ basket: await twoStoreBasket() });
  const out = await send(c.phone, `junta tudo na ${label}`);
  assert.match(out, new RegExp(`Juntei tudo na \\*${label}\\*`), out.slice(0, 600));
  const ctx = await ctxOf(c.convoId);
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const items = (ctx.basket?.length ? ctx.basket : ((order?.items as unknown as BasketItem[]) ?? [])) as BasketItem[];
  assert.deepEqual([...new Set(items.map((i) => i.storeLabel))], [label]);
});

test("cesta numa loja só + 'junta tudo': diz que já é uma entrega, sem mexer", async (t) => {
  if (!dbOk) return t.skip();
  const arroz = await arrozItem();
  const c = await customerWith({ basket: [arroz] });
  const out = await send(c.phone, "junta tudo numa loja so");
  assert.match(out, /Já está tudo numa loja só/, out.slice(0, 400));
  assert.deepEqual(((await ctxOf(c.convoId)).basket ?? []).map((b) => b.sku), [arroz.sku]);
});

// M1) Oferta de juntar sobrevive a uma mensagem no meio que não muda a cesta ----------------------------------------------
test("oferta de juntar + mensagem no meio sem mudar a cesta + '1': junta (não vira quantidade)", async (t) => {
  if (!dbOk) return t.skip();
  // Item que já é o mais barato: "troca por um mais barato" responde sem mexer na cesta.
  const cheap: BasketItem = { sku: "g14-arroz-barato", name: "Arroz Branco Tipo 1 Marca Teste 5kg", qty: 1, unitPrice: 0.99, lineTotal: 0.99, storeKey: "carrefour", storeLabel: "Carrefour", ask: "arroz" };
  const basket = [...(await twoStoreBasket()), cheap];
  const c = await customerWith({ basket });
  const offer = await send(c.phone, "só isso");
  assert.match(offer, /Dá pra juntar/, offer.slice(0, 500));
  const middle = await send(c.phone, "troca o arroz marca teste por um mais barato");
  assert.doesNotMatch(middle, /Dá pra juntar|Total/, middle.slice(0, 400));
  const out = await send(c.phone, "1");
  assert.doesNotMatch(out, /Pra mudar a quantidade|como estava/i, out.slice(0, 500));
  assert.match(out, /Juntei/, out.slice(0, 500));
});

// M5) Edição composta aplicada inteira -----------------------------------------------------------------------------------
test("splitCommandClauses/parseItemQtyEdit: 'tira X e Y, e muda Z pra 4' são duas cláusulas; quantidade nomeada", () => {
  assert.deepEqual(splitCommandClauses("tira os baloes e o salgadinho, e muda o guardanapo pra 4"), ["tira os baloes e o salgadinho", "muda o guardanapo pra 4"]);
  assert.deepEqual(parseItemQtyEdit("muda o guardanapo pra 4"), { phrase: "guardanapo", qty: 4 });
  assert.deepEqual(parseItemQtyEdit("na real a fralda e so 1 pacote"), { phrase: "fralda", qty: 1 });
  assert.deepEqual(parseItemQtyEdit("o bolo eram 3"), { phrase: "bolo", qty: 3 });
  assert.equal(parseItemQtyEdit("leite pra viagem"), null);
  assert.equal(parseItemQtyEdit("arroz e feijão"), null);
});

test("'tira os balões e o salgadinho, e muda o guardanapo pra 4': tira o salgadinho, guardanapo vira 4, avisa do balão", async (t) => {
  if (!dbOk) return t.skip();
  const [guard] = await catalogOptions("guardanapo", /guardanapo/i, 1);
  const [salg] = await catalogOptions("salgadinho", /salgadinho|batata|elma|doritos|cheetos/i, 1);
  const arroz = await arrozItem();
  const c = await customerWith({ basket: [asItem(guard, "guardanapo", 2), asItem(salg, "salgadinho"), arroz] });
  const out = await send(c.phone, "tira os baloes e o salgadinho, e muda o guardanapo pra 4");
  const ctx = await ctxOf(c.convoId);
  const order = await prisma.deliveryOrder.findFirst({ where: { userId: c.userId }, orderBy: { createdAt: "desc" } });
  const items = (ctx.basket?.length ? ctx.basket : ((order?.items as unknown as BasketItem[]) ?? [])) as BasketItem[];
  assert.ok(!items.some((i) => i.sku === salg.sku), out.slice(0, 600));
  assert.equal(items.find((i) => i.sku === guard.sku)?.qty, 4, out.slice(0, 600));
  assert.match(out, /bal[oõ]es\*? não est/i, out.slice(0, 600));
});

// M7) "tira o kuat" tira o produto todo (cesta e escolha) -------------------------------------------------------------------
test("2x Kuat na cesta + Kuat em escolha + 'tira o kuat, ja tenho': nenhum Kuat fica", async (t) => {
  if (!dbOk) return t.skip();
  const kuats = await catalogOptions("refrigerante guarana", /guaran/i, 1);
  const arroz = await arrozItem();
  const c = await customerWith({ basket: [asItem(kuats[0], "guarana", 2), arroz], pending: [{ query: "guarana", qty: 2, qtyExplicit: true, options: kuats }] }, "choosing");
  const out = await send(c.phone, "tira o guarana, ja tenho");
  const ctx = await ctxOf(c.convoId);
  assert.equal((ctx.pending ?? []).length, 0, out.slice(0, 400));
  assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), [arroz.sku], out.slice(0, 400));
});

// M6/M2) Várias edições numa mensagem: um resumo só, no fim, com o total certo ------------------------------------------------
test("IA com 3 edições (quantidade, tirar, quantidade): o resumo com botões sai uma vez, depois da última", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  const [fralda] = await catalogOptions("fralda", /fralda/i, 1);
  const [shampoo] = await catalogOptions("shampoo", /shampoo/i, 1);
  const [geleia] = await catalogOptions("geleia", /geleia/i, 1);
  const basket = [asItem(fralda, "fralda", 3), asItem(shampoo, "shampoo"), asItem(geleia, "geleia")];
  const c = await customerWith({ basket });
  const act = (type: DialogueAction["type"], rest: Partial<DialogueAction> = {}): DialogueAction => ({ type, ...rest });
  __setDialogueModelForTests(async () => ({ actions: [act("set_qty", { target: 1, qty: 1 }), act("remove", { target: 2 }), act("set_qty", { target: 3, qty: 2 })] }));
  try {
    const start = outbox.length;
    await send(c.phone, "na real a fralda e so 1 pacote, e tira o shampoo, e poe 2 geleias");
    const sent = outbox.slice(start).filter((m) => m.to === c.phone);
    const totals = sent.map((m, i) => ({ i, m })).filter(({ m }) => /🛒/.test(m.text));
    assert.equal(totals.length, 1, sent.map((m) => `${m.kind}: ${m.text.slice(0, 80)}`).join("\n"));
    const lastEdit = sent.map((m, i) => ({ i, m })).filter(({ m }) => /Geleia/.test(m.text) && !/🛒/.test(m.text)).pop();
    if (lastEdit) assert.ok(totals[0].i > lastEdit.i, "o resumo sai depois da última edição");
    assert.match(totals[0].m.text, /2x Geleia|2x .*Geleia/i, totals[0].m.text);
    assert.doesNotMatch(totals[0].m.text, /Shampoo/i);
  } finally {
    __setDialogueModelForTests(null);
    delete process.env.LIA_DIALOGUE_LLM;
  }
});

test("com a IA ligada (que tirava só o pendente), 'tira o guarana, ja tenho' tira também o 2x da cesta", async (t) => {
  if (!dbOk) return t.skip();
  const kuats = await catalogOptions("refrigerante guarana", /guaran/i, 1);
  const arroz = await arrozItem();
  const c = await customerWith({ basket: [asItem(kuats[0], "guarana", 2), arroz], pending: [{ query: "guarana", qty: 2, qtyExplicit: true, options: kuats }] }, "choosing");
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async () => ({ actions: [{ type: "remove", target: 0 }] }));
  try {
    const out = await send(c.phone, "tira o guarana, ja tenho");
    const ctx = await ctxOf(c.convoId);
    assert.equal((ctx.pending ?? []).length, 0, out.slice(0, 400));
    assert.deepEqual((ctx.basket ?? []).map((b) => b.sku), [arroz.sku], out.slice(0, 400));
  } finally {
    __setDialogueModelForTests(null);
    delete process.env.LIA_DIALOGUE_LLM;
  }
});
