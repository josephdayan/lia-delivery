// Varredura de 06/10/2026 (tarde), depois do retorno dos testadores: cada teste guarda um
// defeito reproduzido com a IA de produção e as lojas ao vivo.
//   - "12 ovos" escolhido na caixa de 10 virava 12 caixas (R$ 92 de ovo); "1 dúzia de banana"
//     virava 1× "dúzia de banana".
//   - "pix" respondido na pergunta do destinatário virava "Entrega em nome de *Pix*".
//   - "tem açaí?" antes do cadastro recebia a explicação do serviço e o açaí sumia.
//   - "cartão" com a escolha aberta virava busca de "Cartão Sem Parar".
//   - "quanto fica o frete?" respondia "depende da distância 🛵" com o frete ao vivo na mão.
//   - nome + CPF mandados fora da hora viravam busca ("não achei *Maria Souza 529…*").
//   - Asaas recusando o Pix de saída: a Lia cobrava e estornava; agora não cobra.
// Puros sempre; conversa com banco local (npm run test:local).
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, looksLikeOnboardingName, parseRecipientName } from "../src/lib/delivery-service";
import { detectIntent, parseAvailabilityAsk, parseBasketLines } from "../src/lib/lia-intents";
import { pixOutReadiness, resetPixOutProbeCache } from "../src/lib/payments/pix-out/readiness";
import * as copy from "../src/lib/lia-copy";

// ---------- puros ----------

test("dúzia multiplica a quantidade e não vira produto", () => {
  const lines = (t: string) => parseBasketLines(t).map((l) => [l.qty, l.phrase]);
  assert.deepEqual(lines("1 dúzia de banana"), [[12, "banana"]]);
  assert.deepEqual(lines("2 duzias de ovos"), [[24, "ovos"]]);
  assert.deepEqual(lines("uma dúzia de ovos"), [[12, "ovos"]]);
  assert.deepEqual(lines("12 ovos"), [[12, "ovos"]]);
});

test("'tem X?' antes do cadastro é pedido; pergunta do serviço não é", () => {
  for (const [input, item] of [
    ["tem açaí?", "açaí"],
    ["vcs tem fralda?", "fralda"],
    ["vocês vendem ração?", "ração"],
    ["oi, tem pilha AA?", "pilha AA"],
    ["consegue comprar um lego?", "lego"]
  ] as const) {
    assert.equal(parseAvailabilityAsk(input), item, input);
  }
  for (const input of ["tem como pagar no cartão?", "tem frete grátis?", "entrega em Campinas?", "vcs entregam hoje?", "tem desconto?", "como funciona?", "tem algo pra comer?", "tem loja física?"]) {
    assert.equal(parseAvailabilityAsk(input), null, input);
  }
});

test("palavra de comando nunca vira nome do destinatário", () => {
  for (const input of ["pix", "Pix", "cartão", "no cartão", "cancelar", "sim", "ok", "quero pagar"]) {
    assert.equal(parseRecipientName(input), null, input);
  }
  assert.equal(parseRecipientName("maria souza"), "Maria Souza");
  assert.equal(parseRecipientName("é pra Joana Dias"), "Joana Dias");
});

test("frete por loja diz o número e não fala de motoboy", () => {
  const text = copy.feeByStore([{ storeLabel: "Mambo", fee: 15.9 }, { storeLabel: "Drogal", fee: 0 }]);
  assert.match(text, /\*Mambo\*: R\$ 15,90/);
  assert.match(text, /\*Drogal\*: grátis/);
  for (const topic of ["fee"] as const) {
    for (const ctx of [{}, { hasCep: true }, { hasBasket: true }]) {
      assert.doesNotMatch(copy.serviceAnswer(topic, "SP", ctx), /🛵|distância/);
    }
  }
});

test("trava do Pix de saída: saldo do Asaas menor que o pedido não cobra; desligada passa", async () => {
  const env = { ...process.env };
  const realFetch = global.fetch;
  try {
    process.env.LIA_PIX_OUT_PROVIDER = "asaas";
    process.env.ASAAS_API_KEY = "teste";
    delete process.env.LIA_PIX_OUT_OFF;
    delete process.env.LIA_PIX_OUT_PREFLIGHT_OFF;
    resetPixOutProbeCache();
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/finance\/balance$/.test(url)) return new Response(JSON.stringify({ balance: 20 }), { status: 200 });
      throw new Error(`rede inesperada: ${url}`);
    }) as typeof fetch;
    assert.deepEqual(await pixOutReadiness(4666), { ok: false, reason: "saldo" });
    process.env.LIA_PIX_OUT_PREFLIGHT_OFF = "true";
    assert.deepEqual(await pixOutReadiness(4666), { ok: true });
    delete process.env.LIA_PIX_OUT_PREFLIGHT_OFF;
    process.env.LIA_PIX_OUT_PROVIDER = "mock";
    assert.deepEqual(await pixOutReadiness(4666), { ok: true }, "sem Asaas não há o que travar");
  } finally {
    global.fetch = realFetch;
    process.env = env;
  }
});

test("'cartão' e 'pix' continuam sendo forma de pagamento", () => {
  assert.deepEqual(detectIntent("cartão"), { kind: "choose_payment", method: "card" });
  assert.deepEqual(detectIntent("pix"), { kind: "choose_payment", method: "pix" });
});

test("nome sozinho no cadastro é nome; pedido não é", () => {
  for (const input of ["Maria Oliveira Santos", "joana dias", "Teste Silva"]) assert.ok(looksLikeOnboardingName(input), input);
  for (const input of ["quero leite ninho", "tem açaí?", "oi tudo bem", "pra que cpf?", "Rua Augusta 1500", "sim"]) assert.ok(!looksLikeOnboardingName(input), input);
});

// ---------- conversa (banco local) ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `vr_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer(extra: Record<string, unknown> = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva", ...extra } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
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

test("'12 ovos' escolhido numa caixa vira caixas, não 12 caixas", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero 12 ovos");
  const options = first.split("\n").filter((line) => /^\*\d\)\*/.test(line));
  const boxIndex = options.findIndex((line) => /\b(\d{1,2})\s*(un|unidades|ovos)\b/i.test(line));
  if (boxIndex < 0) return t.skip(`catálogo de teste sem caixa de ovos: ${options.join(" | ")}`);
  const pack = Number(options[boxIndex].match(/\b(\d{1,2})\s*(?:un|unidades|ovos)\b/i)![1]);
  const out = await send(phone, String(boxIndex + 1));
  const ctx = await context(phone);
  const eggs = (ctx.basket ?? []).find((i: { name: string }) => /ovo/i.test(i.name));
  assert.ok(eggs, out.slice(0, 300));
  assert.equal(eggs.qty, pack >= 4 && 12 >= pack ? Math.max(1, Math.round(12 / pack)) : 12, `caixa de ${pack}: ${out.slice(0, 300)}`);
  if (pack >= 4 && pack <= 12) assert.match(out, /Cada embalagem tem/);
});

test("'cartão' com a escolha aberta pede para escolher, não busca cartão", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero arroz");
  assert.match(first, /Responde \*1\*/, first.slice(0, 300));
  const out = await send(phone, "cartão");
  assert.match(out, /Antes de pagar, escolhe uma das opções/);
  assert.doesNotMatch(out, /Sem Parar|Cartão (Pré|Pós)/i, out.slice(0, 300));
  const ctx = await context(phone);
  assert.match(ctx.pending?.[0]?.query ?? "", /arroz/i, "a escolha do arroz continua aberta");
});

test("nome + CPF no meio da escolha vão pro cadastro e as opções voltam", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer({ cpf: null, cpfName: null });
  await send(phone, "quero arroz");
  const out = await send(phone, "Joana Dias 529.982.247-25");
  assert.match(out, /Anotado/);
  assert.match(out, /Responde \*1\*/, "a escolha aberta volta");
  assert.doesNotMatch(out, /não achei/i);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.cpfName, "Joana Dias");
});

test("'tem açaí?' antes do cadastro fica anotado e é buscado depois do endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const first = await send(phone, "tem açaí?");
  assert.match(first, /açaí/i, first.slice(0, 300));
  assert.doesNotMatch(first, /Eu compro o que você precisar/);
  const ctx = await context(phone);
  assert.match(ctx.pendingRequest ?? "", /açaí/i, "o açaí ficou guardado para depois do cadastro");
});

test("cadastro: nome numa mensagem e CPF na outra ficam guardados; 'pra que cpf?' tem resposta fixa", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
    await send(phone, "oi");
    const asked = await send(phone, "Avenida Paulista 1000, 01310-100");
    assert.match(asked, /nome completo[\s\S]*CPF/i, asked.slice(0, 300));
    const why = await send(phone, "pra que cpf?");
    assert.match(why, /no seu nome/);
    const name = await send(phone, "Maria Oliveira Santos");
    assert.match(name, /Agora o \*CPF\*/);
    const cpf = await send(phone, "529.982.247-25");
    assert.match(cpf, /Anotado/);
    assert.doesNotMatch(cpf, /não achei/i);
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    assert.equal(user.cpfName, "Maria Oliveira Santos");
    assert.equal(user.cpf, "52998224725");
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});
