// Fase 1 do plano de 100% (docs/plano-conversa-100.md, 07/10/2026): consertos por CLASSE dos defeitos
// medidos no placar de conversas (c06, c08, c09, c13, c23, c24, c28, c30, c31, c35). Cada teste guarda
// uma classe de mensagem, não uma frase. Conversa com banco local; IA desligada (parser determinístico).
import "./helpers/load-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import * as copy from "../src/lib/lia-copy";
import { isAttendanceFollowUp, looksLikePharmacyPartnerAsk } from "../src/lib/lia-intents";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const OWNER = "+5511900000777";
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
  await handleDeliveryMessage({ phone, text, messageId: `f1_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
const ownerAlerts = () => outbox.filter((m) => m.to === OWNER).length;
function newPhone() {
  return `${PREFIX}${String(++seq).padStart(4, "0")}`;
}
async function customer() {
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
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
  process.env.LIA_OWNER_PHONE = OWNER;
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

// ---------- 1. textos honestos ----------

test("textos: saudação e apresentação não prometem 'qualquer coisa'", () => {
  for (const text of [copy.greeting(), copy.welcomeAskCep(), copy.welcomeAskFullDeliveryAddress(["1x leite"]), copy.signupFormBody(["1x leite"]), copy.serviceAnswer("generic", "SP e RJ"), copy.storesAnswer([])]) {
    assert.doesNotMatch(text, /qualquer coisa que eu compro|dezenas de lojas|sempre uma que entrega|trago de tudo/i, text);
  }
  assert.match(copy.noMedicine(), /Remédio eu não posso vender/);
  assert.doesNotMatch(copy.noMedicine(), /de tudo/);
});

test("c08: remédio pelo nome (Euthyrox) antes do cadastro — só a recusa, sem pedir endereço nem 'anotei'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "Ola quero 2 cxs de Euthyrox 50mg");
  assert.match(out, /Remédio eu não posso vender/, out);
  assert.doesNotMatch(out, /endere[cç]o|anotei|CEP/i, out);
  assert.equal((await context(phone)).pendingRequest, undefined, "remédio não fica guardado como pedido");
});

test("c08: remédio pelo nome depois do cadastro — nunca 'não achei em nenhuma loja / outra marca'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero 2 caixas de Euthyrox 50mg");
  assert.match(first, /Remédio eu não posso vender/, first);
  assert.doesNotMatch(first, /não achei|outra marca|em nenhuma loja/i, first);
  const second = await send(phone, "Pode tentar Puran T4 50 mcg? 2 caixas.");
  assert.doesNotMatch(second, /não achei|outra marca|em nenhuma loja/i, second);
  assert.match(second, /remédio/i, second);
  assert.notEqual(first, second, "a 2ª recusa não repete o mesmo texto");
});

test("c08: remédio de nome desconhecido que ninguém tem ('mg') também só recebe a recusa", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, "quero 1 caixa de Xablaurex 25 mg");
  assert.match(out, /Remédio eu não posso vender/, out);
  assert.doesNotMatch(out, /não achei|outra marca/i, out);
});

test("c35: 'tem farmácia parceira que venda?' tem resposta honesta, sem pedir endereço; a insistência muda de texto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const first = await send(phone, "quero dipirona");
  assert.match(first, /Remédio eu não posso vender/, first);
  assert.doesNotMatch(first, /endere[cç]o|trago de tudo/i, first);
  const ask = await send(phone, "tem alguma farmácia parceira que venda?");
  assert.match(ask, /Não tenho farmácia parceira/, ask);
  assert.doesNotMatch(ask, /endere[cç]o|CEP|compara preços/i, ask);
  const again = await send(phone, "Quero dipirona, vê se tem em alguma farmácia por favor.");
  assert.match(again, /continua a mesma/, again);
  assert.doesNotMatch(again, /endere[cç]o/i, again);
  assert.notEqual(first, again);
});

test("c35: a pergunta sobre farmácia parceira é reconhecida (puro)", () => {
  assert.equal(looksLikePharmacyPartnerAsk("tem alguma farmácia parceira que venda?"), true);
  assert.equal(looksLikePharmacyPartnerAsk("vocês vendem em farmácia?"), true);
  assert.equal(looksLikePharmacyPartnerAsk("quero shampoo da farmácia"), false);
});

// ---------- 2. modo atendimento ----------

test("c30: atendente — confirma com prazo, avisa o dono UMA vez e cada resposta seguinte é diferente e curta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const before = ownerAlerts();
  const replies = [await send(phone, "quero falar com uma pessoa")];
  assert.match(replies[0], /Avisei o responsável/);
  assert.match(replies[0], /9h/, "prazo honesto na primeira confirmação");
  for (const text of ["ok, fico no aguardo do atendente.", "vou esperar", "e aí?", "preciso falar com alguém mesmo", "Preciso só falar com um atendente, pode pedir pra ele me chamar assim que puder?"]) {
    const out = await send(phone, text);
    assert.doesNotMatch(out, /endere[cç]o|CEP|o que você precisa|não achei|Olha o que achei/i, `${text}: ${out}`);
    assert.match(out, /9h/, `${text}: ${out}`);
    assert.ok(out.length < 230, `${text}: confirmação curta, veio ${out.length} caracteres`);
    replies.push(out);
  }
  for (let i = 1; i < replies.length; i++) assert.notEqual(replies[i], replies[i - 1], `resposta ${i} repete a anterior`);
  assert.equal(ownerAlerts() - before, 1, "o dono é avisado uma vez só dentro de 30 min");
  assert.equal((await context(phone)).attendance?.kind, "human");
});

test("c30: no modo atendimento, pedido de produto volta ao fluxo normal", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero falar com um atendente");
  const out = await send(phone, "quero arroz");
  assert.match(out, /Arroz/i, out);
  assert.doesNotMatch(out, /avisei o responsável/i, out);
});

test("c31: pedido que não existe — 1ª pergunta registra, 2ª avisa o dono, depois confirmação curta sem pedir endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const before = ownerAlerts();
  const first = await send(phone, "cadê meu pedido de ontem?");
  assert.match(first, /ainda não tem pedidos/i, first);
  assert.equal(ownerAlerts() - before, 0, "1ª pergunta não avisa ninguém");
  const second = await send(phone, "Mas eu já fiz o pedido ontem, queria saber onde tá.");
  assert.match(second, /avisei o responsável/i, second);
  assert.match(second, /9h/, second);
  assert.equal(ownerAlerts() - before, 1);
  const third = await send(phone, "Não tenho o código, mas conseguem procurar pelo meu CPF?");
  assert.doesNotMatch(third, /endere[cç]o|CEP|cadastro/i, third);
  assert.notEqual(third, second);
  const fourth = await send(phone, "Quero que confiram o pedido de ontem, ele não chegou.");
  assert.doesNotMatch(fourth, /endere[cç]o|CEP|cadastro/i, fourth);
  assert.notEqual(fourth, third);
  assert.equal(ownerAlerts() - before, 1, "dono avisado uma vez só");
});

test("c13: CNPJ sem LIA_BUSINESS_INFO — resposta com prazo, dono avisado uma vez e a espera não repete o texto", async (t) => {
  if (!dbOk) return t.skip();
  const prev = process.env.LIA_BUSINESS_INFO;
  delete process.env.LIA_BUSINESS_INFO;
  try {
    const phone = await customer();
    const before = ownerAlerts();
    const first = await send(phone, "Antes de seguir, me passa o CNPJ da Lia Delivery pra eu conferir?");
    assert.match(first, /CNPJ/, first);
    assert.match(first, /9h/, first);
    const wait = await send(phone, "Tá, vou aguardar o CNPJ e o nome que aparece no Pix pra conferir.");
    assert.notEqual(wait, first);
    assert.doesNotMatch(wait, /MEI/i, wait);
    assert.equal(ownerAlerts() - before, 1);
  } finally {
    if (prev === undefined) delete process.env.LIA_BUSINESS_INFO;
    else process.env.LIA_BUSINESS_INFO = prev;
  }
});

test("modo atendimento: o léxico pega espera/cobrança e deixa passar pedido de produto (puro)", () => {
  for (const x of ["vou esperar", "ok, fico no aguardo do atendente.", "e aí?", "preciso falar com alguém mesmo", "conseguem procurar pelo meu CPF?", "ok", "quanto tempo ele demora?"]) {
    assert.equal(isAttendanceFollowUp(x), true, x);
  }
  for (const x of ["quero arroz", "2 leites", "leite e pão", "preciso de shampoo", "quero um presente pra alguém de 5 anos", "adiciona mais um leite no meu pedido"]) {
    assert.equal(isAttendanceFollowUp(x), false, x);
  }
});

// ---------- 6. pedido feito antes do cadastro ----------

test("c06: pedido + 'como vc funciona? de onde vc compra?' junto do endereço — responde, salva o endereço e busca o pedido guardado (sem duplicar)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const first = await send(phone, "oii quero pedir leite");
  assert.match(first, /anotei/i, first);
  const out = await send(phone, "Av. Brigadeiro Faria Lima, 1500, apto 82, Pinheiros, São Paulo, 01451-001. E como vc funciona? De onde vc compra?");
  assert.match(out, /lojas online/i, "responde a pergunta");
  assert.match(out, /Endereço salvo|Cadastro|CPF/i, `salva o endereço: ${out.slice(0, 400)}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.ok(user.defaultAddress, "endereço gravado");
  const ctx = await context(phone);
  const stillQueued = ctx.pendingRequest as string | undefined;
  const searched = (ctx.pending ?? []).some((p: { query: string }) => /leite/i.test(p.query)) || /Leite/i.test(out);
  assert.ok(searched || /leite/i.test(stillQueued ?? ""), `o leite não se perdeu: ${JSON.stringify({ stillQueued, out: out.slice(0, 300) })}`);
  assert.notEqual(ctx.step, "need_address", "o passo do endereço acabou");
});

test("c06: refinar o pedido guardado ('leite' → 'leite integral sem açúcar') substitui em vez de somar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oii quero pedir leite");
  await send(phone, "como funciona pra fechar o pedido?");
  await send(phone, "Quero um leite integral de caixinha");
  const queued = ((await context(phone)).pendingRequest ?? "") as string;
  assert.equal(queued.split(", ").filter((x) => /leite/i.test(x)).length, 1, `leite duplicado em: ${queued}`);
});
