// Rodada 26, grupo B, corretor g71c (14/10): endereço "só desta vez" durante a oferta de juntar (M1), prazo do card × resumo
// (M2), "quando chega?" antes e depois do total (M4) e pergunta no meio de uma oferta sim/não / duas perguntas seguidas sobre
// o mesmo item (M7).
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { basketEtaByStore, etaChangedSinceChoice, handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { isOneTimeAddress, keepsOneTimeAddress } from "../src/lib/address-parse";
import type { BasketItem, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5571${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
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

const VIACEP: Record<string, unknown> = {
  "01305000": { logradouro: "Rua Augusta", bairro: "Consolação", localidade: "São Paulo", uf: "SP" },
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  return realFetch(input, init);
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
after(async () => {
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting"): Promise<{ phone: string; userId: string; convoId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", cpf: "52998224725", cpfName: "Maria da Silva" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", city: "São Paulo", uf: "SP", deliveryAddress: ADDRESS, deliveryAddressVerified: true, ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g71c_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(convoId: string): Promise<DeliveryContext> {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}");
}
const line = (sku: string, name: string, unitPrice: number, qty = 1, storeKey = "mambo", storeLabel = "Mambo", delivery?: string, extra: Partial<BasketItem> = {}): BasketItem =>
  ({ sku, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100, storeKey, storeLabel, ...(delivery ? { delivery } : {}), ...extra }) as BasketItem;
const sig = (basket: BasketItem[]) => basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");

// M1 ------------------------------------------------------------------------------------------------------------------
test("M1: 'só desta vez' / 'só hoje' / 'só nesse pedido' é endereço do pedido; 'salva esse endereço' torna definitivo", () => {
  assert.equal(isOneTimeAddress("entrega na casa da minha mãe só desta vez: Rua Augusta 500, Consolação, São Paulo, 01305-000"), true);
  assert.equal(isOneTimeAddress("só hoje manda pra Rua Augusta 500, 01305-000"), true);
  assert.equal(isOneTimeAddress("esse vai pra Rua Augusta 500 só nesse pedido"), true);
  assert.equal(isOneTimeAddress("dessa vez só, entrega na Rua Augusta 500"), true);
  assert.equal(isOneTimeAddress("meu endereço novo é Rua Augusta 500, 01305-000"), false);
  assert.equal(keepsOneTimeAddress("salva esse endereço"), true);
  assert.equal(keepsOneTimeAddress("pode deixar esse como meu endereço"), true);
  assert.equal(keepsOneTimeAddress("quero 1 sabonete"), false);
});

test("M1: endereço 'só desta vez' com a oferta de juntar aberta não troca o cadastro para sempre nem resolve a oferta em 'manter'", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const basket = [line("g71c-cafe", "Café Tradicional Seleto 500g", 28.49, 1, "santaluzia", "Casa Santa Luzia", "prazo da loja: 3 dias úteis"), line("g71c-acucar", "Açúcar Refinado Guarani 1kg", 4.39, 1, "mambo", "Mambo", "prazo da loja: amanhã, 6h–9h")];
  const joined = [basket[0], line("g71c-acucar2", "Açúcar Refinado da Barra 1kg", 6.27, 1, "santaluzia", "Casa Santa Luzia", "prazo da loja: 1 dia útil")];
  const c = await customerWith({
    basket,
    consolidationTried: sig(basket),
    consolidationOffer: { key: sig(basket), basket: joined, storeLabel: "Casa Santa Luzia", stores: 2, pairs: [{ fromName: "Açúcar Refinado Guarani 1kg", fromPrice: 4.39, toName: "Açúcar Refinado da Barra 1kg", toPrice: 6.27 }], delta: 1.88, joinedTotal: 51.5, keptTotal: 62.23 }
  });
  const out = await send(c.phone, "entrega na casa da minha mãe só desta vez: Rua Augusta 500, Consolação, São Paulo, 01305-000");
  assert.match(out, /Só neste pedido, a entrega vai pra: Rua Augusta, 500/, out);
  assert.match(out, /volto pro seu endereço de cadastro \(Avenida Paulista, 1000/, out);
  assert.doesNotMatch(out, /Endereço atualizado|mantenho as 2 lojas/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.addressOnce?.address, ADDRESS);
  assert.equal(ctx.addressOnce?.seenOrder, true);
  // A decisão de juntar não ficou como "já tentada" na cesta de antes do endereço novo — ela é refeita com o frete novo.
  assert.ok(!ctx.consolidationParked, "a oferta antiga não fica guardada como resposta pendente");

  // Pedido terminou (contexto limpo, como depois do pago/cancelado): o cadastro volta, com aviso.
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ flow: "delivery", cep: ctx.cep, deliveryAddress: ctx.deliveryAddress, deliveryAddressVerified: true, addressOnce: ctx.addressOnce }) } });
  const next = await send(c.phone, "oi");
  assert.match(next, /Voltei pro seu endereço de cadastro: Avenida Paulista, 1000/, next);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
  assert.equal(user.defaultAddress, ADDRESS);
  assert.equal(user.cep?.replace(/\D/g, ""), "01310100");
  const after2 = await ctxOf(c.convoId);
  assert.equal(after2.addressOnce, undefined);
  assert.equal(after2.deliveryAddress, ADDRESS);
});

test("M1: 'salva esse endereço' depois do 'só desta vez' deixa o novo como cadastro", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const c = await customerWith({ deliveryAddress: "Rua Augusta, 500, Consolação, São Paulo - SP", cep: "01305-000", addressOnce: { cep: "01310-100", address: ADDRESS, at: Date.now(), seenOrder: true } });
  await prisma.user.update({ where: { id: c.userId }, data: { cep: "01305-000", defaultAddress: "Rua Augusta, 500, Consolação, São Paulo - SP" } });
  const out = await send(c.phone, "salva esse endereço");
  assert.match(out, /esse passa a ser o seu endereço: Rua Augusta, 500/, out);
  assert.equal((await ctxOf(c.convoId)).addressOnce, undefined);
  assert.doesNotMatch(await send(c.phone, "oi"), /Voltei pro seu endereço/);
});

// M2 ------------------------------------------------------------------------------------------------------------------
test("M2: card de HOJE (60 min) e loja confirmando dias no fechamento é avisado antes do resumo", () => {
  const basket = [line("g71c-kit", "Kit Nivea", 49.9, 1, "drogariaspacheco", "Drogarias Pacheco", "60 min"), line("g71c-bombom", "Bombons", 19.9, 1, "paguemenos", "Pague Menos", "60 min")];
  const changes = etaChangedSinceChoice(basket, new Map([["drogariaspacheco", "1bd"], ["paguemenos", "60m"]]));
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].store, "Drogarias Pacheco");
  assert.match(copy.etaUpdatedByStore(changes), /Drogarias Pacheco\* confirmou \*1 dia útil\* \(antes aparecia 60 min\)/);
  // Horas × janela de amanhã continua sem aviso (varia com o relógio).
  assert.deepEqual(etaChangedSinceChoice([line("g71c-x", "X", 5, 1, "mambo", "Mambo", "3h")], new Map([["mambo", "24h@2026-10-15T10:00:00+00:00~2026-10-15T13:00:59+00:00"]])), []);
});

// M4 ------------------------------------------------------------------------------------------------------------------
test("M4: 'quando chega?' antes do total diz qual entrega (rápida × barata) e, com várias lojas, o prazo que o resumo vai usar", async (t) => {
  assert.match(copy.basketEtaAnswer([{ store: "Cobasi", when: "22h", slow: "1 dia útil" }]), /\*Cobasi\* entrega em \*22h\* pela entrega mais rápida, ou em \*1 dia útil\* pela mais barata/);
  const rows = basketEtaByStore([line("g71c-r", "Ração", 69.29, 1, "cobasi", "Cobasi", "22h", { slowDelivery: "1 dia útil" })]).rows;
  assert.deepEqual(rows, [{ store: "Cobasi", when: "22h", slow: "1 dia útil" }]);
  if (!dbOk) return t.skip("sem banco");
  const basket = [line("g71c-kit", "Kit Nivea", 49.9, 1, "drogariaspacheco", "Drogarias Pacheco", "60 min", { slowDelivery: "1 dia útil" }), line("g71c-bombom", "Bombons", 19.9, 1, "paguemenos", "Pague Menos", "60 min")];
  const c = await customerWith({ basket });
  const out = await send(c.phone, "quando chega?");
  assert.match(out, /\*Drogarias Pacheco\* em \*1 dia útil\*/, out);
  assert.match(out, /\*Pague Menos\* em \*60 min\*/, out);
});

test("M4: 'quando chega?' depois do total responde o prazo primeiro, antes do lembrete da cobrança", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const items = [line("g71c-r2", "Ração Golden Filhotes 3kg", 69.29, 1, "cobasi", "Cobasi", "1 dia útil")];
  const c = await customerWith({}, "awaiting_quote_confirmation");
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: c.userId, conversationId: c.convoId, phone: c.phone, status: "awaiting_quote_confirmation", storeKey: "concierge", storeLabel: "Lia", items: items as unknown as object,
      fulfillments: [{ storeKey: "concierge", storeLabel: "Lia", deliveryFee: 7.9, deliveryMode: "retailer_delivery", deliveryPromise: "pela própria loja · prazo da loja: 1 dia útil" }] as unknown as object,
      itemsSubtotal: 69.29, deliveryFee: 7.9, total: 77.19, cep: "01310-100", deliveryAddress: ADDRESS
    }
  });
  await prisma.conversation.update({ where: { id: c.convoId }, data: { context: JSON.stringify({ flow: "delivery", step: "awaiting_quote_confirmation", deliveryOrderId: order.id, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true }) } });
  const out = await send(c.phone, "quando chega?");
  // O teste antigo (feedback-2026-10-06-pos-pagamento A5) exige o lembrete da cobrança e a linha "*Loja* · prazo": ficam, mas o
  // prazo abre a resposta.
  assert.match(out, /^🚚 Loja \*Cobasi\* · 1 dia útil\nAinda não gerei a cobrança/, out);
});

// M7 ------------------------------------------------------------------------------------------------------------------
test("M7: 'quando chega?' no meio da oferta de complemento responde e retoma; o 'não' seguinte recusa a oferta", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const basket = [line("g71c-mac", "Macarrão Espaguete 500g", 5.49, 1, "santaluzia", "Casa Santa Luzia", "prazo da loja: 1 dia útil")];
  const offer = { option: { sku: "g71c-molho", name: "Molho de Tomate Heinz 240g", unitPrice: 2.49, storeKey: "santaluzia", storeLabel: "Casa Santa Luzia" }, query: "molho de tomate", shelfId: "molho", why: "Quem leva macarrão costuma levar molho de tomate 🍝", trigger: "macarrao", at: Date.now() };
  const c = await customerWith({ basket, complementOffer: offer, complementAsked: { skus: ["g71c-mac"], at: Date.now() } });
  const out = await send(c.phone, "quando chega?");
  assert.match(out, /\*Casa Santa Luzia\* entrega em \*1 dia útil\*/, out);
  assert.match(out, /Voltando: quer adicionar o \*Molho de Tomate Heinz 240g\*/, out);
  assert.doesNotMatch(out, /Diz \*pagar\*/, out);
  assert.ok((await ctxOf(c.convoId)).complementOffer, "a oferta continua na mesa");
  const no = await send(c.phone, "não");
  assert.doesNotMatch(no, /Voltando|tirar algum item/, no);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.complementOffer, undefined);
  assert.ok(!(ctx.basket ?? []).some((b) => b.sku === "g71c-molho"), "o 'não' não pôs o molho");
});

test("M7: 'quando chega?' com a oferta de juntar na mesa responde e retoma a oferta (o '1' depois ainda junta)", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const basket = [line("g71c-c2", "Café Seleto 500g", 28.49, 1, "santaluzia", "Casa Santa Luzia", "prazo da loja: 3 dias úteis"), line("g71c-a2", "Açúcar Guarani 1kg", 4.39, 1, "mambo", "Mambo", "prazo da loja: amanhã, 6h–9h")];
  const joined = [basket[0], line("g71c-a3", "Açúcar da Barra 1kg", 6.27, 1, "santaluzia", "Casa Santa Luzia")];
  const c = await customerWith({ basket, consolidationTried: sig(basket), consolidationOffer: { key: sig(basket), basket: joined, storeLabel: "Casa Santa Luzia", stores: 2, pairs: [], delta: 1.88, joinedTotal: 51.5, keptTotal: 61.79 } });
  const out = await send(c.phone, "quando chega?");
  assert.match(out, /contado da compra/, out);
  assert.match(out, /Voltando: junto tudo na \*Casa Santa Luzia\* por R\$ 51,50, ou mantenho como está por R\$ 61,79 com 2 entregas\?/, out);
  const ctx = await ctxOf(c.convoId);
  assert.equal(ctx.consolidationOffer?.key, sig(basket));
});

test("M7: 'só isso' com a pergunta da embalagem aberta não encadeia 'Fecho sem esse item?'; o 'sim' leva os ovos", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const ovos = { sku: "g71c-ovos", name: "Ovos Brancos com 20 Unidades", unitPrice: 14.28, storeKey: "mambo", storeLabel: "Mambo", delivery: "amanhã, 6h–9h" };
  const c = await customerWith(
    {
      basket: [line("g71c-mant", "Manteiga com Sal 200g", 11.65, 1, "mambo", "Mambo", "prazo da loja: amanhã, 6h–9h")],
      pending: [{ query: "ovos", qty: 12, qtyExplicit: true, options: [ovos] }],
      packConfirm: { sku: "g71c-ovos", askedQty: 12 }
    },
    "choosing"
  );
  const out = await send(c.phone, "só isso");
  assert.match(out, /Antes de fechar, falta responder sobre \*ovos\*: levo 1 embalagem \(20 un\)/, out);
  assert.doesNotMatch(out, /Fecho o pedido sem esse item/, out);
  assert.equal((await ctxOf(c.convoId)).packConfirm?.closeAfter, true);
  const yes = await send(c.phone, "sim");
  assert.match(yes, /✅ Ovos Brancos com 20 Unidades/, yes);
  assert.doesNotMatch(yes, /Fechei sem/, yes);
});
