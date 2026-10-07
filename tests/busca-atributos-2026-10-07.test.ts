// Fase 3 do plano (07/10/2026): a busca CONFERE o que o cliente pediu. O juízo (tipo certo +
// cada exigência) é da IA; aqui o rerank é substituído por um juiz determinístico para provar o
// que o CÓDIGO faz com o veredito: aprovado entra; "mais próximo" vira escolha avisada (nunca
// cesta, nunca modo lista, nunca plano B); "outras"/refino passam pelo mesmo juízo.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __setRerankForTests, type RerankCandidate, type RerankResult } from "../src/lib/adapters/ai";
import { handleDeliveryMessage, searchOptionsForPlanB, searchOptionsForBench } from "../src/lib/delivery-service";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5506${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  await handleDeliveryMessage({ phone, text, messageId: `ba_${RUN}_${++seq}` });
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
afterEach(() => {
  __setRerankForTests(null);
  cheapestAsked = false;
});
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});
async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  return phone;
}
async function ctxOf(phone: string) {
  const convo = await prisma.conversation.findFirst({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo?.context ?? "{}") as {
    step?: string;
    basket?: { name: string }[];
    pending?: { query: string; closestFalta?: string; options: { name: string }[] }[];
  };
}

type Verdict = { ok: boolean } | { near: string } | null;
let cheapestAsked = false;
// Juiz determinístico no lugar da IA: `judge(query, candidato)` diz se serve, se é o "mais perto"
// (com a diferença) ou se não é o produto. Registra cada chamada para os testes inspecionarem.
function fakeJudge(judge: (query: string, c: RerankCandidate) => Verdict) {
  const calls: { message: string; queries: string[] }[] = [];
  __setRerankForTests(async (message, lines): Promise<RerankResult> => {
    calls.push({ message, queries: lines.map((l) => l.query) });
    return {
      lines: lines.map((line) => {
        const verdicts = line.candidates.map((c) => ({ c, v: judge(line.query, c) }));
        const skus = verdicts.filter((x) => x.v && "ok" in x.v).map((x) => x.c.sku);
        const proximos = skus.length ? [] : verdicts.filter((x) => x.v && "near" in x.v).map((x) => ({ sku: x.c.sku, falta: (x.v as { near: string }).near }));
        return { skus, exigencias: [], proximos, ...(cheapestAsked && skus.length ? { maisBarato: true } : {}) };
      })
    };
  });
  return calls;
}
const optionLines = (reply: string) => reply.split("\n").filter((l) => /^\*\d\)\*/.test(l));

test("nada cumpre o tamanho pedido: mostra o mais perto AVISANDO a diferença, sem pôr na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  // Ninguém tem 5 kg; os arrozes de tipo certo são de outro tamanho.
  fakeJudge((_q, c) => (/\barroz\b/i.test(c.name) && !/carreteiro|risoto|arbório/i.test(c.name) ? { near: "é de 1 kg" } : null));
  const reply = await send(phone, "arroz 5kg");
  assert.match(reply, /Não achei \*arroz 5kg\* exatamente\. O mais perto que tenho é de 1 kg:/, reply.slice(0, 400));
  assert.ok(optionLines(reply).length >= 1, reply);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.step, "choosing");
  assert.equal(ctx.basket?.length ?? 0, 0, "o mais perto NUNCA entra na cesta sem o cliente escolher");
  assert.equal(ctx.pending?.[0].closestFalta, "é de 1 kg");
});

test("sem tipo certo nenhum, segue o 'não achei' honesto (não inventa 'mais perto')", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  fakeJudge(() => null);
  const reply = await send(phone, "arroz 5kg");
  assert.doesNotMatch(reply, /O mais perto que tenho/);
  assert.match(reply, /n[aã]o achei/i, reply.slice(0, 300));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.length ?? 0, 0);
  assert.equal(ctx.basket?.length ?? 0, 0);
});

test("lista com 3+ linhas: a linha 'mais perto' não entra sozinha na cesta (modo lista) e as demais entram", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  fakeJudge((q, c) => {
    if (/arroz/i.test(q)) return /\barroz\b/i.test(c.name) && !/carreteiro|risoto/i.test(c.name) ? { near: "é de 1 kg" } : null;
    return { ok: true };
  });
  const reply = await send(phone, "arroz 5kg\nfeijão\nleite\ncafé");
  const ctx = await ctxOf(phone);
  assert.ok(!ctx.basket?.some((i) => /arroz/i.test(i.name)), `arroz do tamanho errado foi pra cesta: ${ctx.basket?.map((i) => i.name).join(" | ")}`);
  const arroz = ctx.pending?.find((p) => /arroz/i.test(p.query));
  assert.ok(arroz?.closestFalta, `arroz não ficou como escolha avisada: ${reply.slice(0, 500)}`);
  assert.match(reply, /O mais perto que tenho é de 1 kg/);
});

test("plano B e placar não contam o 'mais perto' como opção; o placar o devolve à parte", async (t) => {
  if (!dbOk) return t.skip();
  fakeJudge((_q, c) => (/\barroz\b/i.test(c.name) && !/carreteiro|risoto|arbório/i.test(c.name) ? { near: "é de 1 kg" } : null));
  const planB = await searchOptionsForPlanB("arroz 5kg", "01229000");
  assert.deepEqual(planB, []);
  const bench = await searchOptionsForBench("arroz 5kg", "01229000").catch(() => null);
  if (bench) {
    assert.deepEqual(bench.options, []);
    assert.ok(bench.closest.length >= 1);
  }
});

test("'outras opções' passa pelo mesmo juízo: o que a IA reprova não volta na paginação", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const calls = fakeJudge((_q, c) => (/\barroz\b/i.test(c.name) && !/carreteiro|risoto|arbório|brócolis/i.test(c.name) ? { ok: true } : null));
  const first = await send(phone, "arroz");
  assert.ok(optionLines(first).length >= 1, first);
  const more = await send(phone, "outras opções");
  assert.doesNotMatch(more, /carreteiro|risoto|arbório|brócolis/i, more.slice(0, 500));
  assert.ok(calls.length >= 2, "a paginação também consultou o juízo");
  assert.ok(calls.at(-1)!.queries.every((q) => /arroz/i.test(q)));
});

test("'a mais barata' no pedido: vitrine ordenada do mais barato, cabeçalho diz isso, 'outras' segue o preço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  cheapestAsked = true;
  // A IA devolve fora de ordem de preço; quem ordena é o código.
  fakeJudge((_q, c) => (/papel higi[eê]nico/i.test(c.name) ? { ok: true } : null));
  const reply = await send(phone, "papel higiênico, a mais barata");
  assert.match(reply, /Separei as mais baratas de \*papel higi[eê]nico\*, da mais barata pra mais cara/i, reply.slice(0, 300));
  const prices = optionLines(reply).map((l) => Number((l.match(/R\$\s*([\d.]+,\d{2})/)?.[1] ?? "0").replace(".", "").replace(",", ".")));
  assert.ok(prices.length >= 2, reply);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), `fora de ordem de preço: ${prices.join(", ")}`);
  const ctx = await ctxOf(phone);
  assert.equal((ctx.pending?.[0] as { cheapestFirst?: boolean }).cheapestFirst, true);
});

test("sem preferência de preço o cabeçalho de sempre fica", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  fakeJudge((_q, c) => (/papel higi[eê]nico/i.test(c.name) ? { ok: true } : null));
  const reply = await send(phone, "papel higiênico");
  assert.doesNotMatch(reply, /Separei as mais baratas/);
});
