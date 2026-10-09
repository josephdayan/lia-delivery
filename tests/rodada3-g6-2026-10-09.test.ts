// Rodada 3, grupo G6 (09/10): resposta natural à oferta de juntar, cadastro por texto, CPF inválido,
// "manter como está" que não avança, preço/total no meio da escolha, aviso de frete caro.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, sameSpecAsOriginal } from "../src/lib/delivery-service";
import { parseProductQuestion, answerProductQuestion } from "../src/lib/product-question";
import * as copy from "../src/lib/lia-copy";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5576${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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
async function twoStoreBasket() {
  const leite = await item("leite integral piracanjuba", "carrefour", 2, /Piracanjuba/);
  const arroz = await item("arroz branco camil 5kg", "carrefour", 1, /Camil.*5kg/i);
  const coca = await item("refrigerante coca cola sem acucar lata", "oba", 2, /Sem Açúcar Lata/i);
  return [leite, arroz, coca];
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
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting", userExtra: Record<string, unknown> = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", ...userExtra } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `g6_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}

// 1) resposta natural à oferta de juntar ---------------------------------------------------------------
for (const phrase of ["sim", "sim, juntar", "sim, juntar na Mambo", "pode juntar", "junta na Mambo", "ok junta", "sim junta", "pode juntar tudo na Mambo"]) {
  test(`oferta de juntar: "${phrase}" junta e não apaga a cesta`, async (t) => {
    if (!dbOk) return t.skip();
    __setPreflightForTests(async () => null);
    try {
      const c = await customerWith({ basket: await twoStoreBasket() });
      const offer = await send(c.phone, "só isso");
      assert.match(offer, /Dá pra juntar tudo/, offer.slice(0, 500));
      const out = await send(c.phone, phrase);
      assert.doesNotMatch(out, /Comecei uma lista nova|não achei em nenhuma loja/, out.slice(0, 500));
      assert.match(out, /Juntei tudo/, out.slice(0, 500));
    } finally {
      __setPreflightForTests(null);
    }
  });
}
test("oferta de juntar: 'manter como está' já segue para o próximo passo (sem repetir 'só isso')", async (t) => {
  if (!dbOk) return t.skip();
  __setPreflightForTests(async () => null);
  try {
    const c = await customerWith({ basket: await twoStoreBasket() });
    await send(c.phone, "só isso");
    const out = await send(c.phone, "manter como está");
    assert.match(out, /mantenho as 2 lojas/i, out.slice(0, 500));
    assert.match(out, /Total|Pix|pagamento|cart[aã]o/i, out.slice(0, 800));
  } finally {
    __setPreflightForTests(null);
  }
});

// 2) cadastro por texto ----------------------------------------------------------------------------------
async function newPhone() {
  return `${PREFIX}${String(++seq).padStart(4, "0")}`;
}
test("cadastro por texto: nome + CPF + endereço numa mensagem preenchem o cadastro e nunca viram item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newPhone();
  await send(phone, "oi");
  const out = await send(phone, "Carla Mendes, CPF 529.982.247-25, Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.doesNotMatch(out, /1x Carla|CPF 529|não achei/, out.slice(0, 500));
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.cpfName, "Carla Mendes");
  assert.ok(user.defaultAddress);
});
// 1b) número na oferta de juntar; substituto fiel; item trocado por ele mesmo ------------------------------
test("oferta de juntar: '2' mantém e '1' junta, sem mexer na quantidade", async (t) => {
  if (!dbOk) return t.skip();
  __setPreflightForTests(async () => null);
  try {
    const a = await customerWith({ basket: await twoStoreBasket() });
    await send(a.phone, "só isso");
    const kept = await send(a.phone, "2");
    assert.match(kept, /mantenho as 2 lojas/i, kept.slice(0, 300));
    const b = await customerWith({ basket: await twoStoreBasket() });
    await send(b.phone, "só isso");
    const joined = await send(b.phone, "1");
    assert.match(joined, /Juntei tudo/, joined.slice(0, 300));
  } finally {
    __setPreflightForTests(null);
  }
});
test("substituto da consolidação mantém tamanho, embalagem, voltagem e subtipo", () => {
  assert.equal(sameSpecAsOriginal("Feijão Carioca Swift 1kg", "feijao", "Feijão Carioca Camil 1kg"), true);
  assert.equal(sameSpecAsOriginal("Feijão Carioca Swift 1kg", "feijao", "Feijão Carioca Temperado Camil 380g"), false);
  assert.equal(sameSpecAsOriginal("Feijão Carioca Swift 1kg", "feijao", "Feijão Carioca Temperado Camil 1kg"), false);
  assert.equal(sameSpecAsOriginal("Fralda Pampers Confort Sec G 60 un", "fralda", "Fralda Pampers Confort Sec G 92 un"), false);
  assert.equal(sameSpecAsOriginal("Fralda Pampers Confort Sec G 60 un", "fralda", "Fralda Pampers Confort Sec G 60 unidades"), true);
  assert.equal(sameSpecAsOriginal("Ventilador Maxx Force 60W 127V", "ventilador", "Ventilador Britânia BVT400 220V"), false);
  assert.equal(sameSpecAsOriginal("Ventilador Maxx Force 60W 127V", "ventilador", "Ventilador Britânia BVT400 127V"), true);
});
test("copy: troca do item por ele mesmo não é listada; frete maior que produtos avisa", () => {
  const same = { fromName: "Protetor Bastão", fromPrice: 54.89, toName: "Protetor Bastão", toPrice: 54.89 };
  const other = { fromName: "Arroz A", fromPrice: 5, toName: "Arroz B", toPrice: 6 };
  const body = copy.consolidationOffer({ storeLabel: "Mambo", joinedTotal: 10, keptTotal: 12, keptStores: 2, pairs: [same, other] });
  assert.doesNotMatch(body, /Protetor Bastão/);
  assert.match(body, /Arroz B/);
  assert.equal(copy.expensiveShippingNote(10, 15).length, 1);
  assert.match(copy.expensiveShippingNote(10, 15)[0], /entrega sai mais cara/);
  assert.equal(copy.expensiveShippingNote(30, 15).length, 0);
});
test("pergunta de preço com opções na tela responde o preço da citada", () => {
  const q = parseProductQuestion("qual o preço do primeiro?", 3);
  assert.deepEqual(q, { kind: "price", n: 1 });
  const answer = answerProductQuestion(q!, [{ name: "Leite X 1L", price: 5.49, storeLabel: "Mambo" }, { name: "B", price: 1 }, { name: "C", price: 2 }], "leite");
  assert.match(answer, /R\$ 5,49/);
  assert.deepEqual(parseProductQuestion("quanto custa o 2?", 3), { kind: "price", n: 2 });
  assert.equal(parseProductQuestion("qual o preço?", 3), null);
});
test("cadastro com CEP do Rio avisa que fora de SP o prazo é mais longo", () => {
  assert.match(copy.signupSavedAskItems("Paulo", "Praça Pio X, 10, Centro, Rio de Janeiro - RJ", "RJ"), /Fora de SP/);
  assert.doesNotMatch(copy.signupSavedAskItems("Paulo", "Av Paulista, 1000, São Paulo - SP", "SP"), /Fora de SP/);
});

// 3) CPF inválido no formulário não some ---------------------------------------------------------------
test("CPF inválido no formulário: pede de novo antes do total e só segue com CPF válido", async (t) => {
  if (!dbOk) return t.skip();
  __setPreflightForTests(async () => null);
  try {
    const phone = await newPhone();
    await send(phone, "oi");
    const start = outbox.length;
    await handleDeliveryMessage({
      phone,
      text: "",
      messageId: `g6f_${RUN}_${++seq}`,
      flowResponse: { nome: "Paulo Lima", cpf: "12345678900", cep: "01310100", numero: "1000", complemento: "", flow_token: "lia-cadastro-test" }
    });
    const formOut = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n");
    assert.match(formOut, /CPF/, formOut);
    const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
    const ctx = JSON.parse(convo.context ?? "{}");
    ctx.basket = [await item("arroz branco camil 5kg", "carrefour", 3, /Camil.*5kg/i)];
    await prisma.conversation.update({ where: { id: convo.id }, data: { context: JSON.stringify(ctx) } });
    const closing = await send(phone, "só isso");
    assert.match(closing, /CPF/, closing.slice(0, 500));
    assert.doesNotMatch(closing, /Pix|cart[aã]o/i, closing.slice(0, 500));
    const again = await send(phone, "Paulo Lima 123.456.789-00");
    assert.match(again, /CPF/, again.slice(0, 400));
    const ok = await send(phone, "Paulo Lima 529.982.247-25");
    assert.match(ok, /Pix|cart[aã]o|Total/i, ok.slice(0, 600));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { phone } })).cpf, "52998224725");
  } finally {
    __setPreflightForTests(null);
  }
});

test("cadastro por texto: nome e CPF sozinhos (sem endereço) também não viram item", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith({}, "collecting");
  const out = await send(c.phone, "Carla Mendes 529.982.247-25");
  assert.doesNotMatch(out, /não achei/, out.slice(0, 400));
  const user = await prisma.user.findUniqueOrThrow({ where: { phone: c.phone } });
  assert.equal(user.cpf, "52998224725");
});
