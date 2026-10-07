// Rodada 3 (07/10/2026): BUSCA, "não achei" e fora de escopo. Uma classe de causa por teste:
//  - exigência de USO e de DESTINATÁRIO no juízo da IA (isqueiro "pra charuto", perfume "pra namorada");
//  - espécie do pet / público não se perdem na query ("ração pro meu cachorro");
//  - "não achei" não manda o cliente trocar o que ele exigiu (Yorgus 14g) nem promete busca de móvel grande;
//  - recusa de cidade fora da área não promete aviso que o sistema não faz.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __setRerankForTests, __setMissJudgeForTests, RERANK_SYSTEM_PROMPT, sanitizeRouterReply, type RerankResult } from "../src/lib/adapters/ai";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { DIALOGUE_SYSTEM_PROMPT } from "../src/lib/dialogue/model";
import { PRESIGNUP_SYSTEM_PROMPT } from "../src/lib/dialogue/presignup";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
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
  await handleDeliveryMessage({ phone, text, messageId: `r3_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
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
  __setMissJudgeForTests(null);
});
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});
async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01229-000", defaultAddress: TEST_ADDRESS } });
  return phone;
}

// ---------- juízo da IA: uso e destinatário ----------

test("rerank: o juízo cobra USO ('pra charuto') e DESTINATÁRIO (gênero/idade) como exigência", () => {
  const prompt = RERANK_SYSTEM_PROMPT(3);
  assert.match(prompt, /USO/);
  assert.match(prompt, /isqueiro 'pra charuto'/);
  assert.match(prompt, /DESTINAT[ÁA]RIO/);
  assert.match(prompt, /namorada/);
  // sem "mais perto" para uso/destinatário: o isqueiro comum não volta como "o que tenho"
  assert.match(prompt, /Nunca para espécie\/porte do pet, público ou destinatário[^.]*uso/);
});

test("conversa: o juízo recebe o destinatário do pedido ('perfume pra minha namorada'), não só a palavra 'perfume'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const messages: string[] = [];
  __setRerankForTests(async (message, lines): Promise<RerankResult> => {
    messages.push(message);
    return { lines: lines.map(() => ({ skus: [], exigencias: ["feminino"], proximos: [] })) };
  });
  await send(phone, "perfume pra minha namorada");
  assert.ok(messages.some((m) => /namorada|feminin/i.test(m)), `o destinatário se perdeu antes do juízo: ${messages.join(" || ")}`);
});

test("espécie do pet e público ficam na query: prompts do cadastro e do gerente mandam manter", () => {
  for (const prompt of [PRESIGNUP_SYSTEM_PROMPT, DIALOGUE_SYSTEM_PROMPT]) {
    assert.match(prompt, /ra[cç][aã]o pro meu cachorro/i);
    assert.match(prompt, /ra[cç][aã]o cachorro/i);
    assert.match(prompt, /perfume feminino/i);
  }
});

// ---------- texto do "não achei" ----------

test("não achei: cliente EXIGENTE (marca/versão/uso) não é mandado trocar o que exigiu", () => {
  const single = copy.itemsNotAvailable(["cottage yorgus 14g"], [{ fora: "nenhum", exigente: true }]);
  assert.match(single, /cottage yorgus 14g/);
  assert.doesNotMatch(single, /outra marca|outras marcas|vers[aã]o|tento de novo/i, single);
  const many = copy.itemsNotAvailable(["cottage yorgus 14g", "isqueiro tocha"], [{ fora: "nenhum", exigente: true }, { fora: "nenhum", exigente: true }]);
  assert.doesNotMatch(many, /outra marca|outras marcas|vers[oõ]es/i, many);
  const still = copy.missStillNone("cottage yorgus 14g", { fora: "nenhum", exigente: true });
  assert.doesNotMatch(still, /parecido|outra marca|vers[aã]o/i, still);
});

test("não achei: cliente SEM exigência mantém o texto de sempre (outra marca ou versão)", () => {
  assert.match(copy.itemsNotAvailable(["vedante de torneira"]), /outra marca ou versão/);
  assert.match(copy.itemsNotAvailable(["vedante de torneira"], [{ fora: "nenhum", exigente: false }]), /outra marca ou versão/);
  assert.match(copy.missStillNone("bola de tênis"), /produto parecido/);
});

test("fora do que a Lia compra (sofá): diz que não compra, sem prometer nova tentativa", () => {
  for (const out of [
    copy.itemsNotAvailable(["sofá 3 lugares"], [{ fora: "moveis_grandes", exigente: false }]),
    copy.missStillNone("sofá retrátil 3 lugares", { fora: "moveis_grandes", exigente: true })
  ]) {
    assert.match(out, /n[aã]o consigo comprar/i, out);
    assert.match(out, /m[oó]veis grandes/i, out);
    assert.doesNotMatch(out, /tento de novo|outra marca|vers[aã]o|agora\./i, out);
  }
  const mixed = copy.itemsNotAvailable(["sofá 3 lugares", "cottage yorgus"], [{ fora: "moveis_grandes" }, { fora: "nenhum", exigente: true }]);
  assert.match(mixed, /n[aã]o consigo comprar \*sofá 3 lugares\*/i, mixed);
  assert.match(mixed, /cottage yorgus/i);
});

test("conversa: 'não achei' usa o juízo — exigente não ouve 'outra marca'; móvel grande ouve que não é comprado", async (t) => {
  if (!dbOk) return t.skip();
  __setRerankForTests(async (_m, lines): Promise<RerankResult> => ({ lines: lines.map(() => ({ skus: [], exigencias: [], proximos: [] })) }));
  const asked: string[][] = [];
  __setMissJudgeForTests(async (_message, queries) => {
    asked.push(queries);
    return queries.map((q) => (/sof[aá]/i.test(q) ? { fora: "moveis_grandes" as const, exigente: false } : { fora: "nenhum" as const, exigente: true }));
  });
  const exigent = await send(await customer(), "cottage yorgus 14g proteína");
  assert.match(exigent, /n[aã]o achei/i, exigent);
  assert.doesNotMatch(exigent, /outra marca|vers[aã]o/i, exigent);
  const sofa = await send(await customer(), "queria um sofá de 3 lugares");
  assert.match(sofa, /n[aã]o consigo comprar/i, sofa);
  assert.match(sofa, /m[oó]veis grandes/i, sofa);
  assert.ok(asked.length >= 2);
});

test("conversa: juízo da IA fora do ar → o 'não achei' de sempre (nada quebra)", async (t) => {
  if (!dbOk) return t.skip();
  __setRerankForTests(async (_m, lines): Promise<RerankResult> => ({ lines: lines.map(() => ({ skus: [], exigencias: [], proximos: [] })) }));
  __setMissJudgeForTests(async () => null);
  const out = await send(await customer(), "cottage yorgus 14g proteína");
  assert.match(out, /n[aã]o achei/i, out);
  assert.match(out, /outra marca ou versão/i, out);
});

// ---------- recusa de cidade fora da área ----------

test("fora da área: a recusa não promete aviso nem chamada que o sistema não faz", () => {
  const out = copy.outsideCoverage("Belo Horizonte", "os estados de São Paulo e Rio de Janeiro");
  assert.match(out, /Ainda n[aã]o chego em Belo Horizonte/);
  assert.doesNotMatch(out, /te chamo|te aviso|te chamar|vou te/i, out);
  assert.match(out, /sem (data|previs[aã]o)|n[aã]o tenho (data|previs[aã]o)/i, out);
});

test("IA livre não promete 'aviso quando chegar' (filtro do roteador e da guarda anti-repetição)", () => {
  for (const bad of ["Claro! Te aviso quando chegar por aí 🙂", "Pode deixar, vou te avisar assim que a Lia chegar na sua cidade.", "Combinado, te chamo quando eu atender sua região"]) {
    assert.equal(sanitizeRouterReply(bad), undefined, bad);
  }
  assert.ok(sanitizeRouterReply("Anotei sua cidade pra priorizar, mas ainda não tenho data. 🙂"));
});
