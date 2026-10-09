// Rodada 4, grupo g10 (09/10): com a cesta ativa, mensagem que não é lista nova SOMA (ou nem mexe), em vez de cair em
// "Comecei uma lista nova" e apagar as escolhas (A1 reclamação, A2 "tbm"; 4ª rodada da mesma família). Só recomeça com
// intenção explícita ("nova lista", "esquece tudo e…", "na verdade quero só…") ou lista que repete e reformula a atual.
// M3: item repetido ("latão de Skol" e depois "cerveja skol latão") vira uma linha com a quantidade somada.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { splitRestartCue } from "../src/lib/lia-intents";
import * as copy from "../src/lib/lia-copy";
import type { BasketItem } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5510${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
  if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
  (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
    outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
    return key === "sendDeliveryChoices" ? false : { provider: "test", to };
  };
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g10_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function item(query: string, qty: number, nameRe: RegExp, ask?: string): Promise<BasketItem> {
  const c = (await gatherCrossStoreCandidates(query, 40, 4, { noLongTail: true })).find((x) => nameRe.test(x.item.name));
  assert.ok(c, `catálogo de teste sem ${query}`);
  return {
    sku: c!.item.sku, name: c!.item.name, brand: c!.item.brand, qty, unitPrice: c!.item.unitPrice,
    lineTotal: Math.round(c!.item.unitPrice * qty * 100) / 100, storeKey: c!.store.key, storeLabel: c!.store.label, productUrl: c!.item.productUrl,
    ...(ask ? { ask } : {})
  };
}
async function registered(basket: BasketItem[]) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, basket }) }
  });
  return phone;
}
async function held(phone: string): Promise<string> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  const ctx = JSON.parse(convo.context ?? "{}");
  return [...(ctx.basket ?? []).map((i: { qty: number; name: string }) => `${i.qty}x ${i.name}`), ...(ctx.pending ?? []).map((p: { query: string }) => `?${p.query}`)].join(" | ");
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
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

test("splitRestartCue: só intenção explícita de recomeçar", () => {
  assert.equal(splitRestartCue("nova lista: 2 leites e 1 arroz")?.rest, "2 leites e 1 arroz");
  assert.equal(splitRestartCue("esquece tudo e manda 1 coca e 1 guaraná")?.rest, "1 coca e 1 guaraná");
  assert.equal(splitRestartCue("na verdade quero só 1 coca e 1 guaraná")?.rest, "1 coca e 1 guaraná");
  assert.equal(splitRestartCue("começar de novo")?.rest, "");
  assert.equal(splitRestartCue("Começa do zero, 2 cervejas e 1 gelo")?.rest, "2 cervejas e 1 gelo");
  for (const no of ["vcs sao lentas, ja faz 5 min", "areia pra gato tbm, a da cobasi mesmo, 2 pacotes", "não, quero o nivea de antes", "sim, juntar na Carrefour", "o integral mesmo, e o pão de forma", "2 leites, 1 arroz", "só isso"]) {
    assert.equal(splitRestartCue(no), null, no);
  }
});

test("copy: aviso de soma cita o que entrou e ensina *nova lista*", () => {
  const m = copy.summedToBasket(["2x leite", "1x arroz"]);
  assert.match(m, /Somei \*2x leite\*, \*1x arroz\* ao que você já tinha/);
  assert.match(m, /\*nova lista\*/);
});

for (const complaint of ["vcs sao lentas, ja faz 5 min", "ta demorando mt hein", "que lerdeza, ja faz 10 min e nada"]) {
  test(`A1: '${complaint}' com a cesta montada não mexe na cesta`, async (t) => {
    if (!dbOk) return t.skip();
    const cafe = await item("cafe 3 coracoes 500g", 1, /3 Cora/i);
    const pao = await item("pao de forma", 1, /Pão de Forma/i);
    const phone = await registered([cafe, pao]);
    const out = await send(phone, complaint);
    assert.doesNotMatch(out, /lista nova|deixei de fora|Somei/i, out.slice(0, 400));
    const now = await held(phone);
    assert.match(now, new RegExp(cafe.name.slice(0, 12)), now);
    assert.match(now, /Pão de Forma/i, now);
  });
}

test("A2: 'areia pra gato tbm, a da cobasi mesmo, 2 pacotes' soma à ração escolhida", async (t) => {
  if (!dbOk) return t.skip();
  const racao = await item("racao golden caes adultos", 1, /Golden/i);
  const phone = await registered([racao]);
  const out = await send(phone, "areia pra gato tbm, a da cobasi mesmo, 2 pacotes");
  assert.doesNotMatch(out, /lista nova|deixei de fora/i, out.slice(0, 400));
  assert.match(await held(phone), /Golden/i);
});

test("lista de 2 itens sem pista de recomeço: SOMA e avisa numa linha", async (t) => {
  if (!dbOk) return t.skip();
  const banana = await item("banana prata organica tamiso", 1, /Tamiso/);
  const phone = await registered([banana]);
  const out = await send(phone, "2 leites integral piracanjuba, 1 arroz camil 5kg");
  assert.doesNotMatch(out, /lista nova|deixei de fora/i, out.slice(0, 400));
  assert.match(out, /Somei .*ao que você já tinha.*\*nova lista\*/, out.slice(0, 400));
  const now = await held(phone);
  assert.match(now, /Tamiso/, now);
  assert.match(now, /leite|arroz/i, now);
});

for (const restart of ["nova lista: 2 leites integral piracanjuba e 1 arroz camil 5kg", "esquece tudo e manda 2 leites integral piracanjuba e 1 arroz camil 5kg", "na verdade quero só 2 leites integral piracanjuba e 1 arroz camil 5kg"]) {
  test(`recomeço explícito '${restart.slice(0, 22)}…' troca a lista e avisa o que saiu`, async (t) => {
    if (!dbOk) return t.skip();
    const banana = await item("banana prata organica tamiso", 1, /Tamiso/);
    const phone = await registered([banana]);
    const out = await send(phone, restart);
    assert.match(out, /Comecei uma lista nova/, out.slice(0, 400));
    const now = await held(phone);
    assert.doesNotMatch(now, /Tamiso/, now);
    assert.match(now, /leite|arroz/i, now);
  });
}

test("'nova lista' sozinha limpa a cesta", async (t) => {
  if (!dbOk) return t.skip();
  const banana = await item("banana prata organica tamiso", 1, /Tamiso/);
  const phone = await registered([banana]);
  await send(phone, "nova lista");
  assert.doesNotMatch(await held(phone), /Tamiso/);
});

test("lista longa que repete e reformula a atual substitui (não duplica)", async (t) => {
  if (!dbOk) return t.skip();
  const leite = await item("leite integral piracanjuba", 2, /Piracanjuba/, "leite integral piracanjuba");
  const arroz = await item("arroz branco camil 5kg", 1, /Camil.*5kg/i, "arroz camil 5kg");
  const phone = await registered([leite, arroz]);
  const out = await send(phone, "3 leites integral piracanjuba, 2 arroz camil 5kg, 1 feijão carioca");
  assert.match(out, /Comecei uma lista nova/, out.slice(0, 400));
  const now = await held(phone);
  assert.doesNotMatch(now, /2x Leite/i, now);
});

test("M3: item pedido de novo com outras palavras ('coca zero lata' e depois 'refrigerante coca cola sem açúcar lata') vira uma linha com a quantidade somada", async (t) => {
  if (!dbOk) return t.skip();
  const coca = await item("refrigerante coca cola sem acucar lata", 2, /Sem Açúcar Lata/i, "coca zero lata");
  const banana = await item("banana prata organica tamiso", 1, /Tamiso/);
  const phone = await registered([coca, banana]);
  const out = await send(phone, "2 refrigerante coca cola sem açúcar lata");
  assert.match(out, /já estava na cesta/i, out.slice(0, 400));
  const now = await held(phone);
  assert.match(now, /4x [^|]*Coca-Cola/i, now);
  assert.equal((now.match(/Coca/gi) ?? []).length, 1, now);
  // Repetido dentro de uma lista também: soma a linha e só busca o que é novo.
  const phone2 = await registered([coca, banana]);
  const out2 = await send(phone2, "1 coca zero lata, 2 leites integral piracanjuba");
  assert.match(out2, /já estava na cesta/i, out2.slice(0, 400));
  const now2 = await held(phone2);
  assert.match(now2, /3x [^|]*Coca-Cola/i, now2);
  assert.equal((now2.match(/Coca/gi) ?? []).length, 1, now2);
  assert.match(now2, /leite/i, now2);
  // Outro tamanho NÃO é repetição: "coca cola 2l" não soma na lata.
  const phone3 = await registered([coca, banana]);
  const out3 = await send(phone3, "1 coca cola sem açúcar 2l");
  assert.doesNotMatch(out3, /já estava na cesta/i, out3.slice(0, 400));
});
