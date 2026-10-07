// Rodada 2 do plano de 100% (07/10/2026): atributo pedido violado. Cada teste guarda uma CLASSE de causa
// achada nas conversas do placar (c11, c20, c32, c52, c72, c73): IA lenta que cai no ranking sem juízo,
// retry que perde a exigência do "não achei", recusa seguida de "não achei" que repete o recusado.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __setRerankForTests, hedged, type RerankCandidate, type RerankResult } from "../src/lib/adapters/ai";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { inheritMissQualifiers, stripPreferenceFiller } from "../src/lib/lia-intents";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
(whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `b2_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n");
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
    await prisma.$queryRaw`select 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB) throw error;
  }
});
afterEach(() => __setRerankForTests(null));
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});
async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  return phone;
}
async function ctxOf(phone: string) {
  const convo = await prisma.conversation.findFirst({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo?.context ?? "{}") as { step?: string; pending?: { query: string; options: { name: string }[] }[]; lastMiss?: { query: string } };
}

// ---------- IA lenta: a chamada coberta ----------

test("hedged: a 2ª chamada cobre a 1ª que passou do tempo e vence quem responder primeiro", async () => {
  const calls: number[] = [];
  const result = await hedged(
    async (signal) => {
      const n = calls.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, n === 1 ? 400 : 20));
      return signal.aborted ? null : `resposta ${n}`;
    },
    { hedgeMs: 50, deadlineMs: 1000 }
  );
  assert.equal(result, "resposta 2");
  assert.equal(calls.length, 2);
});

test("hedged: falha cedo tenta de novo na hora; duas falhas = null; prazo encerra tudo", async () => {
  let attempts = 0;
  const retried = await hedged(async () => (++attempts === 1 ? null : "ok"), { hedgeMs: 5000, deadlineMs: 1000 });
  assert.equal(retried, "ok");
  assert.equal(attempts, 2);
  let tries = 0;
  assert.equal(await hedged(async () => (tries++, null), { hedgeMs: 5000, deadlineMs: 1000 }), null);
  assert.equal(tries, 2, "no máximo 2 chamadas");
  const t0 = Date.now();
  const timedOut = await hedged(() => new Promise<string | null>(() => undefined), { hedgeMs: 30, deadlineMs: 120 });
  assert.equal(timedOut, null);
  assert.ok(Date.now() - t0 < 600, "o prazo não espera chamada pendurada");
});

test("hedged: chamada que responde na hora não dispara a 2ª", async () => {
  let calls = 0;
  const value = await hedged(async () => (calls++, "rápido"), { hedgeMs: 40, deadlineMs: 500 });
  assert.equal(value, "rápido");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1);
});

// ---------- retry herda a exigência do "não achei" ----------

test("retry herda o qualificador: 'outro modelo de mouse' depois de 'não achei mouse sem fio' continua 'sem fio'", () => {
  assert.equal(inheritMissQualifiers("Pode tentar outro modelo de mouse? Fico com a 2.", "mouse sem fio"), "Pode tentar outro modelo de mouse sem fio? Fico com a 2.");
  assert.equal(inheritMissQualifiers("tenta outra tinta spray", "tinta spray azul"), "tenta outra tinta spray azul");
  // relaxou o pedido, trocou o atributo ou não pediu para tentar de novo: não herda
  assert.equal(inheritMissQualifiers("tenta um mouse qualquer", "mouse sem fio"), null);
  assert.equal(inheritMissQualifiers("pode ser com fio", "mouse sem fio"), null);
  assert.equal(inheritMissQualifiers("outro mouse sem fio", "mouse sem fio"), null);
  assert.equal(inheritMissQualifiers("quero leite", "leite sem açúcar"), null);
  assert.equal(inheritMissQualifiers("tenta uma bateria", "mouse sem fio"), null);
});

function fakeJudge(judge: (query: string, c: RerankCandidate) => boolean) {
  const queries: string[] = [];
  __setRerankForTests(async (_message, lines): Promise<RerankResult> => {
    for (const l of lines) queries.push(l.query);
    return { lines: lines.map((line) => ({ skus: line.candidates.filter((c) => judge(line.query, c)).map((c) => c.sku), exigencias: [], proximos: [] })) };
  });
  return queries;
}

test("conversa: 'tenta outra ração' com a escolha de outro item aberta busca 'ração … salmão', não só 'ração'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  // O desodorante é achado (fica em escolha); a ração de salmão ninguém tem.
  const queries = fakeJudge((q, c) => (/desodorante/i.test(q) ? /desodorante/i.test(c.name) : false));
  await send(phone, "desodorante colônia e ração de cachorro sabor salmão");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.step, "choosing", "o desodorante ficou em escolha e a ração de salmão não foi achada");
  assert.match(ctx.lastMiss?.query ?? "", /salm[aã]o/i);
  queries.length = 0;
  await send(phone, "tenta outra ração de cachorro");
  assert.ok(queries.some((q) => /salm[aã]o/i.test(q)), `a busca nova perdeu o sabor: ${queries.join(" | ")}`);
});

// ---------- recusou as opções e o refino não achou nada ----------

test("recusou as opções ('tem que ser sabor salmão') e nada foi achado: não repete o que ele dispensou", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  fakeJudge((q, c) => (/salm[aã]o/i.test(q) ? /salm[aã]o/i.test(c.name) : /ra[cç][aã]o/i.test(c.name)));
  const first = await send(phone, "ração de cachorro");
  assert.match(first, /\*1\)\*/, first.slice(0, 300));
  const out = await send(phone, "Nenhuma dessas, tem que ser sabor salmão. Vê outras opções.");
  assert.match(out, /n[aã]o achei/i, out);
  assert.doesNotMatch(out, /\*1\)\*/, `as opções recusadas voltaram: ${out.slice(0, 400)}`);
  assert.match(out, /pula/i, "devolve o caminho ao cliente");
  assert.equal((await ctxOf(phone)).step, "choosing", "a escolha continua aberta (pula/1 ainda funcionam)");
});

test("pergunta simples de atributo sem resultado ('tem de salmão?') ainda mostra as opções que existem", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  fakeJudge((q, c) => (/salm[aã]o/i.test(q) ? /salm[aã]o/i.test(c.name) : /ra[cç][aã]o/i.test(c.name)));
  await send(phone, "ração de cachorro");
  const out = await send(phone, "tem de salmão?");
  assert.doesNotMatch(out, /Não vou te mostrar de novo/, out);
});

test("'outras' julga com o contexto do pedido (óleo numa lista de mercado não é óleo lubrificante)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const messages: string[] = [];
  __setRerankForTests(async (message, lines): Promise<RerankResult> => {
    messages.push(message);
    return { lines: lines.map((line) => ({ skus: line.candidates.map((c) => c.sku), exigencias: [], proximos: [] })) };
  });
  await send(phone, "desodorante colônia e ração de cachorro");
  messages.length = 0;
  await send(phone, "outras");
  assert.ok(messages.some((m) => /pedido junto com/i.test(m) && /ra[cç][aã]o/i.test(m)), `sem contexto do pedido: ${messages.join(" || ")}`);
});

test("'outras' esgotado: a re-busca relaxada também passa pelo juízo da IA (não volta o que ele reprovaria)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  // O juiz só aprova Pedigree: se a re-busca de resgate pulasse o juiz, entrariam rações de outras marcas.
  fakeJudge((_q, c) => /pedigree/i.test(c.name));
  const shown: string[] = [];
  let reply = await send(phone, "ração de cachorro");
  shown.push(reply);
  for (let i = 0; i < 6; i++) {
    reply = await send(phone, "outras");
    shown.push(reply);
  }
  const optionLines = shown.join("\n").split("\n").filter((l) => /^\*\d\)\*/.test(l));
  assert.ok(optionLines.length >= 1, shown.join("\n---\n").slice(0, 400));
  assert.ok(optionLines.every((l) => /pedigree/i.test(l)), `opção que a IA não aprovou foi mostrada: ${optionLines.filter((l) => !/pedigree/i.test(l)).join(" | ")}`);
});

test("refino: 'qualquer marca' e 'comum' não são palavras do produto", () => {
  assert.equal(stripPreferenceFiller("procura óleo de soja comum, qualquer marca"), "procura óleo de soja");
  assert.equal(stripPreferenceFiller("azul, qualquer marca"), "azul");
  for (const text of ["qualquer marca", "comum", "pode ser qualquer um", "tem de soja?"]) assert.equal(stripPreferenceFiller(text), text);
});

// ---------- IA sem resposta no prazo: o ranking sem juízo prefere quem tem TODAS as palavras do pedido ----------

test("IA fora do ar: quem traz todas as palavras do pedido (marca, atributo) vem antes do que só se parece", async (t) => {
  if (!dbOk) return t.skip();
  __setRerankForTests(async () => null);
  const phone = await customer();
  const out = await send(phone, "sabonete dove");
  const ctx = await ctxOf(phone);
  const names = (ctx.pending?.[0]?.options ?? []).map((o) => o.name);
  assert.ok(names.length >= 1, out);
  assert.ok(names.every((n) => /dove/i.test(n)), `sem a marca 'dove': ${names.join(" | ")}`);
});
