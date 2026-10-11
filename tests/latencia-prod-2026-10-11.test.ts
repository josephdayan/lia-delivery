// Latência em PRODUÇÃO (11/10, g66): na Vercel a função roda em iad1 e o banco (Supabase) em us-west-1 — cada ida ao banco
// custa ~0,3 s, e o turno fazia ~16 idas EM SÉRIE (≈ 5 s dos ~13–15 s medidos na linha de teste). As leituras independentes
// do início do turno e dos ajudantes da vitrine agora saem juntas. Diagnóstico: /mnt/project-files/testes-whatsapp/latencia-2026-10-11.md.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { earlierQueuedFromPeek } from "../src/lib/turn-runtime";

// ---------- unidade ----------

test("fila FIFO pelo lote: a mais nova que vem ANTES da nossa decide; empate de milissegundo desempata pelo id", () => {
  const t = new Date("2026-10-11T15:00:00.000Z");
  const ticket = { messageId: "m5", createdAt: t };
  const at = (ms: number) => new Date(t.getTime() + ms);
  // Nada antes da nossa: livre.
  assert.equal(earlierQueuedFromPeek([], ticket, at(-60_000)), false);
  // Mensagem anterior DEPOIS da marca = ainda na fila.
  assert.equal(earlierQueuedFromPeek([{ id: "m4", createdAt: at(-500) }], ticket, at(-60_000)), true);
  // Mensagem anterior ANTES (ou na) marca = já teve turno.
  assert.equal(earlierQueuedFromPeek([{ id: "m4", createdAt: at(-500) }], ticket, at(-500)), false);
  // Mesmo milissegundo: id menor vem antes (fila); id maior não, e a decisão vai para a próxima mais nova.
  assert.equal(earlierQueuedFromPeek([{ id: "m3", createdAt: t }], ticket, at(-1)), true);
  assert.equal(earlierQueuedFromPeek([{ id: "m9", createdAt: t }, { id: "m1", createdAt: at(-90_000) }], ticket, at(-60_000)), false);
  assert.equal(earlierQueuedFromPeek([{ id: "m9", createdAt: t }, { id: "m1", createdAt: at(-10) }], ticket, at(-60_000)), true);
  // Lote cheio só de empates que vêm depois: indefinido (a consulta exata decide).
  const ties = Array.from({ length: 10 }, (_, i) => ({ id: `z${i}`, createdAt: t }));
  assert.equal(earlierQueuedFromPeek(ties, ticket, at(-60_000)), undefined);
});

// ---------- banco ----------

const PREFIX = `+5547${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  rt: typeof import("../src/lib/turn-runtime");
};
let m: Mods;

// Registro das consultas (modelo.ação, início, fim) com atraso artificial por consulta — simula a distância até o banco.
type Q = { op: string; start: number; end: number };
let recording: Q[] | null = null;
let delayMs = 0;

async function wipe() {
  const users = await m.prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await m.prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await m.prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.user.deleteMany({ where: { id: { in: ids } } });
}
before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  m = { prisma, service: await import("../src/lib/delivery-service"), rt: await import("../src/lib/turn-runtime") };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string) => (key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null);
  }
  (prisma as unknown as { $use: (mw: (params: { model?: string; action: string }, next: (p: unknown) => Promise<unknown>) => Promise<unknown>) => void }).$use(async (params, next) => {
    const log = recording;
    const start = Date.now();
    if (log && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await next(params);
    } finally {
      log?.push({ op: `${params.model ?? ""}.${params.action}`, start, end: Date.now() });
    }
  });
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
  await m.prisma.$disconnect();
});

async function customer(context: Record<string, unknown> = {}): Promise<{ phone: string; convoId: string; userId: string }> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  const convo = await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...context }) }
  });
  return { phone, convoId: convo.id, userId: user.id };
}

// Consultas que começaram juntas (dentro de metade do atraso) formam uma "onda"; o turno custa ~ondas × atraso.
function waves(log: Q[], delay: number): string[][] {
  const sorted = [...log].sort((a, b) => a.start - b.start);
  const out: Array<{ at: number; ops: string[] }> = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last && q.start - last.at < delay / 2) last.ops.push(q.op);
    else out.push({ at: q.start, ops: [q.op] });
  }
  return out.map((w) => w.ops);
}

test("getOrCreateConvo: cliente que já existe — usuário e conversa lidos JUNTOS (1 ida); cliente novo continua ganhando conversa", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  recording = [];
  delayMs = 60;
  try {
    const { user, convo } = await m.rt.getOrCreateConvo(c.phone);
    assert.equal(user.id, c.userId);
    assert.equal(convo.id, c.convoId);
    const w = waves(recording, delayMs);
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.deepEqual([...w[0]].sort(), ["Conversation.findFirst", "User.upsert"]);
  } finally {
    recording = null;
    delayMs = 0;
  }
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const fresh = await m.rt.getOrCreateConvo(phone, "Novo");
  assert.equal(fresh.convo.userId, fresh.user.id);
  assert.equal(fresh.convo.status, "active");
});

test("ajudante da vitrine dentro do turno: usa a conversa já conhecida (sem upsert do usuário) e ainda avança o snapshot do CAS", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await m.rt.runTurnScoped(async () => {
    const { convo } = await m.rt.getOrCreateConvo(c.phone);
    // Outro processo grava o contexto no meio do turno (o getOrCreateConvo dos ajudantes sempre adotava o contexto do banco).
    const external = JSON.stringify({ ...JSON.parse(String(convo.context)), note: "externo" });
    await m.prisma.conversation.update({ where: { id: convo.id }, data: { context: external } });
    recording = [];
    delayMs = 60;
    let seen = "";
    try {
      await m.rt.withTurnConvo(c.phone, async (convoId) => {
        seen = convoId;
        return m.prisma.message.findFirst({ where: { conversationId: convoId } });
      });
      const w = waves(recording, delayMs);
      assert.equal(w.length, 1, JSON.stringify(w));
      assert.ok(!w.flat().includes("User.upsert"));
    } finally {
      recording = null;
      delayMs = 0;
    }
    assert.equal(seen, convo.id);
    // Snapshot avançado: a escrita do turno não colide com a gravação externa (comportamento de antes).
    await m.rt.writeCtx(convo.id, { ...m.rt.readCtx(external), step: "collecting" });
  });
  // Fora de um turno: o caminho de sempre.
  const id = await m.rt.withTurnConvo(c.phone, async (convoId) => convoId);
  assert.equal(id, c.convoId);
});

test("relógio de inatividade antecipado: consumido uma vez; a 2ª leitura do turno vai ao banco de novo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const first = await m.prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "oi" } });
  const inbound = await m.prisma.message.create({ data: { conversationId: c.convoId, sender: "user", text: "arroz" } });
  await m.rt.runTurnScoped(async () => {
    m.rt.prefetchLastActivityAt(c.convoId, inbound.id);
    // Mensagem nova depois da antecipação: a leitura antecipada não a vê; a seguinte, sim.
    await new Promise((r) => setTimeout(r, 30));
    const later = await m.prisma.message.create({ data: { conversationId: c.convoId, sender: "lia", text: "Oi!" } });
    assert.equal((await m.rt.lastActivityAt(c.convoId, inbound.id))?.getTime(), first.createdAt.getTime());
    assert.equal((await m.rt.lastActivityAt(c.convoId, inbound.id))?.getTime(), later.createdAt.getTime());
  });
});

test("últimas falas da Lia: grava pelo snapshot do turno em 1 ida; contexto mudado por baixo cai na leitura de sempre", async (t) => {
  if (!dbOk) return t.skip();
  // A guarda é ligada por LIA_DIALOGUE_LLM (desligada na suíte): liga só aqui.
  const prevFlag = process.env.LIA_DIALOGUE_LLM;
  process.env.LIA_DIALOGUE_LLM = "true";
  t.after(() => {
    if (prevFlag === undefined) delete process.env.LIA_DIALOGUE_LLM;
    else process.env.LIA_DIALOGUE_LLM = prevFlag;
  });
  const c = await customer();
  await m.rt.runTurnScoped(async () => {
    await m.rt.getOrCreateConvo(c.phone);
    m.rt.turnMeta.getStore()!.sent = ["Achei os 2 itens."];
    recording = [];
    try {
      await m.rt.persistSentTexts(c.convoId);
      assert.deepEqual(recording.map((q) => q.op), ["Conversation.updateMany"]);
    } finally {
      recording = null;
    }
  });
  let row = await m.prisma.conversation.findUnique({ where: { id: c.convoId } });
  assert.deepEqual(m.rt.readCtx(row!.context).lastSent?.texts, ["Achei os 2 itens."]);

  await m.rt.runTurnScoped(async () => {
    const { convo } = await m.rt.getOrCreateConvo(c.phone);
    await m.prisma.conversation.update({ where: { id: convo.id }, data: { context: JSON.stringify({ ...m.rt.readCtx(convo.context), note: "externo" }) } });
    m.rt.turnMeta.getStore()!.sent = ["Qual endereço?"];
    await m.rt.persistSentTexts(c.convoId);
  });
  row = await m.prisma.conversation.findUnique({ where: { id: c.convoId } });
  const ctx = m.rt.readCtx(row!.context) as { lastSent?: { texts: string[] }; note?: string };
  assert.equal(ctx.note, "externo");
  assert.deepEqual(ctx.lastSent?.texts, ["Achei os 2 itens.", "Qual endereço?"]);
});

test("turno inteiro com o banco 'longe': as leituras do início saem em ondas (usuário+conversa, trava+fila, recarga+falas+relógio+compras)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  recording = [];
  delayMs = 80;
  try {
    await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone: c.phone, text: "oi" }));
  } finally {
    delayMs = 0;
  }
  const log = recording;
  recording = null;
  const w = waves(log, 80);
  const waveOf = (op: string) => w.findIndex((ops) => ops.includes(op));
  // 1ª onda: usuário e conversa juntos (a leitura das lojas pausadas, quando vence o cache, também).
  assert.ok(w[0].includes("User.upsert") && w[0].includes("Conversation.findFirst"), JSON.stringify(w));
  // A trava lê o estado e a fila juntos.
  const lockWave = w.findIndex((ops) => ops.includes("Conversation.findUnique") && ops.includes("Message.findMany"));
  assert.ok(lockWave > 0, JSON.stringify(w));
  const claim = w.findIndex((ops, i) => i > lockWave && ops.includes("Conversation.updateMany"));
  assert.ok(claim > lockWave, JSON.stringify(w));
  // Depois da trava, as leituras do turno saem numa onda só.
  const after = w[claim + 1];
  for (const op of ["Conversation.findUnique", "Message.findMany", "Message.findFirst", "DeliveryOrder.findMany"]) assert.ok(after.includes(op), `${op} fora da onda: ${JSON.stringify(w)}`);
  assert.ok(waveOf("Message.create") < lockWave);
  // Antes eram 9 idas em série até a IA/regras; agora 5 (usuário+conversa, mensagem, trava, reivindicação, leituras).
  assert.ok(claim + 1 <= 4, JSON.stringify(w));
});
