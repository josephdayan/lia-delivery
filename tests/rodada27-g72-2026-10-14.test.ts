// Rodada 27, grupo A, corretor g72 (14/10): achados M3, B3 e N1 de /mnt/project-files/testes-whatsapp/rodada27/grupo-a.md:
//   M3: com 5 cards de "perfume ou kit de beleza" na tela, "o segundo" estreitava em "kit de beleza" (o 2º LADO do "ou")
//       em vez de escolher o 2º card;
//   B3: com endereço "só desta vez" ativo, "qual endereço você tem cadastrado?" respondia o temporário como cadastrado;
//   N1: endereço "só desta vez" com a troca da entrega mais cara na mesa: a oferta antiga seguia aberta ("continuam aí em
//       cima") e "manter como está" fechava com o frete calculado para o endereço antigo.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreflightForTests } from "../src/lib/live-freight";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5572${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
const AUGUSTA = "Rua Augusta, 500, Consolação, São Paulo - SP";
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
beforeEach(() => {
  __setDialogueModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
});

async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting", userExtra: Record<string, unknown> = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", cpf: "52998224725", cpfName: "Maria da Silva", ...userExtra } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", city: "São Paulo", uf: "SP", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return { phone, userId: user.id, convoId: convo.id };
}
async function send(phone: string, text: string) {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g72_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function ctxOf(convoId: string) {
  return JSON.parse((await prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })).context ?? "{}") as DeliveryContext;
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, freightFee: number): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, freightFee }) as BasketItem;

// M3 ------------------------------------------------------------------------------------------------------------------
test("M3: 'o segundo' com 5 cards de 'perfume ou kit de beleza' escolhe o 2º card (não estreita no 2º lado do 'ou')", async (t) => {
  if (!dbOk) return t.skip();
  const pending = [
    {
      query: "perfume ou kit de beleza",
      qty: 1,
      options: [
        opt("g72-1", "Colônia Seiva de Alfazema Lavanda Feminina 118ml", 24.19, "paguemenos", "Pague Menos"),
        opt("g72-2", "Kit Loção Corporal Hidratante Nivea Beleza Radiante Cuidado Intenso 2 Unidades 400ml", 47.84, "americanas", "Americanas"),
        opt("g72-3", "Colônia Granado Terrapeutics Bergamota e Flor de Laranjeira 230ml", 90.19, "paguemenos", "Pague Menos"),
        opt("g72-4", "Kit de Beleza - Fanfun", 48.39, "rihappy", "Ri Happy"),
        opt("g72-5", "Desodorante Colônia Feminino Phytoderm Águas Perfumadas Apaixonada 250ml", 23.09, "americanas", "Americanas")
      ]
    }
  ];
  for (const [phrase, sku] of [["o segundo", "g72-2"], ["quero a quarta", "g72-4"], ["o primeiro", "g72-1"]] as const) {
    const c = await customerWith({ pending: structuredClone(pending) }, "choosing");
    const out = await send(c.phone, phrase);
    assert.doesNotMatch(out, /Ficou entre essas/i, `${phrase}: ${out.slice(0, 600)}`);
    const after = await ctxOf(c.convoId);
    assert.deepEqual((after.basket ?? []).map((b) => b.sku), [sku], `${phrase}: ${JSON.stringify(after).slice(0, 600)}`);
  }
  // Dizer o LADO continua estreitando nos cards já mostrados.
  const c = await customerWith({ pending: structuredClone(pending) }, "choosing");
  const out = await send(c.phone, "o kit");
  assert.match(out, /Ficou entre essas de \*kit de beleza\*/, out.slice(0, 600));
});

// B3 ------------------------------------------------------------------------------------------------------------------
test("B3: com endereço 'só desta vez' ativo, 'qual endereço você tem cadastrado?' diz o cadastro e para onde vai este pedido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customerWith(
    { basket: [line("g72-omo", "Lava Roupas em Pó Lavagem Perfeita Omo 800g", 9.79, "mambo", "Mambo", 15.9)], deliveryAddress: AUGUSTA, cep: "01305-000", addressOnce: { cep: "01310-100", address: ADDRESS, at: Date.now(), seenOrder: true } },
    "collecting",
    { cep: "01305-000", defaultAddress: AUGUSTA }
  );
  const out = await send(c.phone, "qual endereço você tem cadastrado?");
  assert.match(out, /Seu endereço cadastrado: Avenida Paulista, 1000/, out);
  assert.match(out, /Este pedido vai pra Rua Augusta, 500/, out);
  assert.doesNotMatch(out, /cadastrado: Rua Augusta/, out);
  // Nada muda: o temporário segue valendo para o pedido e o cadastro volta depois.
  const after = await ctxOf(c.convoId);
  assert.equal(after.addressOnce?.address, ADDRESS);
  assert.equal(after.deliveryAddress, AUGUSTA);
});

// N1 ------------------------------------------------------------------------------------------------------------------
test("N1: endereço 'só desta vez' com a troca da entrega mais cara aberta tira a oferta antiga e refaz o fechamento", async (t) => {
  if (!dbOk) return t.skip();
  const basket = [
    line("g72-omo", "Lava Roupas em Pó Lavagem Perfeita Omo 800g", 9.79, "mambo", "Mambo", 15.9),
    line("g72-amac", "Amaciante Mais Cuidado Mon Bijou + Perfume - 1,7L", 14.74, "santaluzia", "Casa Santa Luzia", 16.74)
  ];
  const pending = [
    {
      query: "amaciante",
      qty: 1,
      qtyExplicit: true,
      replaceSku: "g72-amac",
      costlySwap: true,
      options: [opt("g72-ype", "Amaciante Tradicional Ultra Aconchego Ypê 2L", 16.48, "mambo", "Mambo"), opt("g72-ype2", "Amaciante Concentrado Ypê 1L", 18.59, "mambo", "Mambo")]
    }
  ];
  const c = await customerWith({ basket, pending, closeAfterChoices: true, costlySwapOffered: true, consolidationTried: "g72-amacx1|g72-omox1" }, "choosing");
  const out = await send(c.phone, "entrega na casa da minha mãe só desta vez: Rua Augusta 500, Consolação, São Paulo, 01305-000");
  assert.match(out, /Só neste pedido, a entrega vai pra: Rua Augusta, 500/, out);
  assert.doesNotMatch(out, /continuam aí em cima/, out);
  const after = await ctxOf(c.convoId);
  assert.equal(after.cep, "01305-000");
  // A oferta velha (calculada com o frete da Paulista) não fica na mesa: ou foi refeita agora (costlySwapOffered de novo), ou
  // o fechamento seguiu para o total.
  assert.ok(!(after.pending ?? []).some((p) => p.options.some((o) => o.sku === "g72-ype" || o.sku === "g72-ype2")), `a oferta antiga saiu: ${JSON.stringify(after).slice(0, 800)}`);
  assert.ok(after.step !== "choosing" || after.costlySwapOffered, `oferta refeita ou fechamento: ${after.step} ${JSON.stringify(after).slice(0, 800)}`);
  assert.equal(after.basket?.length, 2, "a cesta segue igual");
});
