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
import { isAttendanceFollowUp, looksLikePharmacyPartnerAsk, parseOptionSwitchRef, parseChoiceCombo, stripAdditiveLead } from "../src/lib/lia-intents";
import { __setRouterInterpreterForTests } from "../src/lib/adapters/ai";

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

test("c31: 'cadê meu pedido de ontem?' sem pedido nenhum — avisa o dono já na 1ª vez, depois confirmação curta sem pedir endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const before = ownerAlerts();
  const first = await send(phone, "cadê meu pedido de ontem?");
  assert.match(first, /não achei nenhum pedido/i, first);
  assert.match(first, /avisei o responsável/i, first);
  assert.match(first, /9h/, first);
  assert.equal(ownerAlerts() - before, 1, "reclamação concreta de pedido sumido avisa o dono na hora");
  const second = await send(phone, "Mas eu já fiz o pedido ontem, queria saber onde tá.");
  assert.doesNotMatch(second, /endere[cç]o|CEP|cadastro/i, second);
  assert.notEqual(second, first);
  const third = await send(phone, "Não tenho o código, mas conseguem procurar pelo meu CPF?");
  assert.doesNotMatch(third, /endere[cç]o|CEP|cadastro/i, third);
  assert.notEqual(third, second);
  const fourth = await send(phone, "Quero que confiram o pedido de ontem, ele não chegou.");
  assert.doesNotMatch(fourth, /endere[cç]o|CEP|cadastro/i, fourth);
  assert.notEqual(fourth, third);
  assert.equal(ownerAlerts() - before, 1, "dono avisado uma vez só");
});

test("c31: 'cadê meu pedido?' simples — 1ª só registra, a 2ª avisa o dono (estado no contexto, não na memória do processo)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const before = ownerAlerts();
  const first = await send(phone, "cadê meu pedido?");
  assert.match(first, /ainda não tem pedidos/i, first);
  assert.equal(ownerAlerts() - before, 0);
  assert.equal((await context(phone)).attendance?.notifiedAt, 0);
  const second = await send(phone, "e meu pedido?");
  assert.match(second, /avisei o responsável/i, second);
  assert.equal(ownerAlerts() - before, 1);
  assert.ok((await context(phone)).attendance?.notifiedAt > 0);
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

// ---------- 5. quantidade relativa / item adicionado no meio da escolha ----------

test("c09: '1. também 3 sacos de ração de gato' escolhe o 1 E enfileira o item novo — a escolha em aberto não some", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const list = await send(phone, "quero ração de cachorro");
  assert.match(list, /Olha o que achei|Responde \*1\*/i, list.slice(0, 300));
  const before = await context(phone);
  const firstQuery = before.pending[0].query as string;
  const out = await send(phone, "1. também 3 sacos de ração de gato");
  const ctx = await context(phone);
  assert.equal((ctx.basket ?? []).length, 1, `a ração do 1 entrou na cesta: ${out.slice(0, 300)}`);
  assert.equal(ctx.basket[0].qty, 1, "1 unidade da ração escolhida");
  assert.ok((ctx.pending ?? []).length >= 1, "o item novo ficou na fila");
  assert.doesNotMatch((ctx.pending ?? []).map((p: { query: string }) => p.query).join("|"), new RegExp(`^${firstQuery}$`), "a fila não repete a escolha já feita");
});

test("c09: durante a escolha, 'adicionar também 3 rações de cachorro' enfileira em vez de reformular (não troca a quantidade nem apaga a escolha)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero ração de cachorro");
  const first = (await context(phone)).pending[0];
  const out = await send(phone, "adicionar também 3 rações de cachorro");
  const ctx = await context(phone);
  assert.ok((ctx.pending ?? []).length >= 2, `escolha antiga + item novo na fila: ${JSON.stringify((ctx.pending ?? []).map((p: { query: string }) => p.query))} / ${out.slice(0, 200)}`);
  assert.equal(ctx.pending[0].query, first.query, "a escolha em aberto continua em primeiro");
  assert.ok(!ctx.pending[0].qtyExplicit || ctx.pending[0].qty === first.qty, "a quantidade da escolha antiga não virou 3");
});

test("c09: 'vamos adicionar mais 3 rações' depois de escolher soma ao item da cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero ração de cachorro");
  await send(phone, "1");
  const before = (await context(phone)).basket[0];
  await send(phone, "vamos adicionar mais 3 rações de cachorro");
  const ctx = await context(phone);
  const total = (ctx.basket ?? []).reduce((sum: number, i: { qty: number }) => sum + i.qty, 0);
  assert.ok((ctx.basket ?? []).some((i: { sku: string }) => i.sku === before.sku), "o primeiro item continua na cesta");
  assert.ok(total === 4 || (ctx.pending ?? []).length > 0, `soma 3 ao existente (cesta=${total}) ou pergunta qual produto (pending=${(ctx.pending ?? []).length})`);
});

// ---------- 3. orçamento = TOTAL com entrega ----------

async function openOrders(phone: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return prisma.deliveryOrder.findMany({ where: { userId: user.id, status: { in: ["awaiting_quote_confirmation", "awaiting_payment"] } } });
}

test("c23: 'até R$55' vale para o TOTAL — passou por R$3,79, avisa e oferece o que cabe ANTES de mostrar o total/cobrar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia até R$ 55");
  await send(phone, "2");
  const out = await send(phone, "só isso");
  assert.match(out, /passou do seu limite de \*R\$ 55,00\* por R\$ 3,79/, out);
  assert.match(out, /Celebre Agora Masculino/, "a opção que cabe é oferecida");
  assert.doesNotMatch(out, /Escolhe abaixo como quer pagar|Total: R\$ 58,79/, "nenhum total estourado é apresentado");
  assert.equal((await openOrders(phone)).length, 0, "nada foi cotado nem cobrado");
  const pick = await send(phone, "1");
  assert.match(pick, /Celebre Agora/, pick);
  const total = await send(phone, "só isso");
  assert.match(total, /Total: R\$ 53,29/, total);
});

test("c23: nada cabe no teto — a Lia diz isso, não cobra e só segue com o 'pode' do cliente", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia até R$ 45");
  await send(phone, "2");
  const out = await send(phone, "só isso");
  assert.match(out, /passou do seu limite de \*R\$ 45,00\*/, out);
  assert.match(out, /nenhuma das opções que achei cabe/i, out);
  assert.equal((await openOrders(phone)).length, 0);
  const go = await send(phone, "pode");
  assert.match(go, /Total: R\$ 58,79/, go);
});

test("c23: nada cabe e o cliente diz 'não' — o item sai da lista", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia até R$ 45");
  await send(phone, "2");
  await send(phone, "só isso");
  const out = await send(phone, "não");
  assert.match(out, /tirei da lista/i, out);
  assert.equal(((await context(phone)).basket ?? []).length, 0);
});

test("c24: o teto dito só na tela do total ('fique até R$55 com a entrega') reabre e oferece o que cabe", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia");
  await send(phone, "2");
  const total = await send(phone, "só isso");
  assert.match(total, /Total: R\$ 58,79/, total);
  const out = await send(phone, "Tem alguma opção que fique até R$ 55 com a entrega?");
  assert.match(out, /passou do seu limite de \*R\$ 55,00\*/, out);
  assert.match(out, /Celebre Agora Masculino/, out);
});

test("c24: 'troca pelo de R$ 38,39' na tela do total troca de verdade e mostra o total novo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia");
  await send(phone, "2");
  await send(phone, "só isso");
  const out = await send(phone, "Dá pra trocar pelo de R$ 38,39 pra ficar mais barato?");
  assert.match(out, /Celebre Agora Masculino/, out);
  assert.match(out, /Total: R\$ 53,29/, out);
  const orders = await openOrders(phone);
  assert.equal(orders.length, 1, "um pedido cotado só");
  const items = orders[0].items as unknown as { name: string; qty: number }[];
  assert.equal(items.length, 1);
  assert.match(items[0].name, /Celebre Agora/);
});

test("c24: apontar a opção pelo preço ou por 'o outro' (puro)", () => {
  const options = [
    { name: "A", price: 34.09 },
    { name: "B", price: 76.99 },
    { name: "C", price: 142.99 }
  ];
  assert.deepEqual(parseOptionSwitchRef("Dá pra trocar pelo de R$ 34,09 pra tentar ficar até R$ 80?", options, 1), { index: 0 });
  assert.deepEqual(parseOptionSwitchRef("quero o de 34,09", options, 1), { index: 0 });
  assert.equal(parseOptionSwitchRef("Tem alguma opção que fique até R$ 80 com a entrega?", options, 1), null, "pergunta de orçamento não é troca");
  assert.equal(parseOptionSwitchRef("troca pelo de R$ 76,99", options, 1), null, "a opção já escolhida não é troca");
  assert.deepEqual(parseOptionSwitchRef("prefiro o outro", options.slice(0, 2), 1), { index: 0 });
  assert.equal(parseOptionSwitchRef("prefiro o outro", options.slice(0, 2), 1, { priceOnly: true }), null);
});

// ---------- 4. embalagem diferente da pedida ----------

test("c28: '12 ovos' com embalagem de 10 — avisa a quantidade real e pergunta ANTES de pôr na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "12 ovos");
  const ctx0 = await context(phone);
  const idx = (ctx0.pending[0].options as { name: string }[]).findIndex((o) => /\b(10|20)\s*(un|unidades)/i.test(o.name));
  assert.ok(idx >= 0, "o catálogo de teste tem embalagem de 10/20 ovos");
  const ask = await send(phone, String(idx + 1));
  assert.match(ask, /vem com \*(10|20) unidades\* por embalagem e você pediu \*12\*/, ask);
  assert.equal(((await context(phone)).basket ?? []).length, 0, "nada na cesta antes do sim");
  assert.equal((await context(phone)).step, "choosing", "a escolha continua aberta");
  const yes = await send(phone, "sim");
  assert.match(yes, /✅/, yes);
  assert.equal(((await context(phone)).basket ?? []).length, 1);
});

test("c28: 'não' na pergunta de embalagem volta às opções sem pôr nada na cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "12 ovos");
  const idx = ((await context(phone)).pending[0].options as { name: string }[]).findIndex((o) => /\b(10|20)\s*(un|unidades)/i.test(o.name));
  await send(phone, String(idx + 1));
  const out = await send(phone, "não");
  assert.match(out, /escolhe outra opção/i, out);
  assert.equal(((await context(phone)).basket ?? []).length, 0);
  assert.equal((await context(phone)).step, "choosing");
});

test("c28: embalagem que fecha o número pedido não pergunta nada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "20 ovos");
  const idx = ((await context(phone)).pending[0].options as { name: string }[]).findIndex((o) => /\b20\s*(un|unidades)/i.test(o.name));
  if (idx < 0) return t.skip("sem embalagem de 20 no catálogo de teste");
  const out = await send(phone, String(idx + 1));
  assert.doesNotMatch(out, /mesmo assim/, out);
  assert.equal(((await context(phone)).basket ?? []).length, 1);
});

// ---------- rodada 2 (placar real, mesmo dia) ----------

test("c35/c08: pedir indicação/contato de farmácia — resposta fixa honesta, sem pedir endereço, mesmo com o remédio na frase", async (t) => {
  if (!dbOk) return t.skip();
  for (const ask of ["ah, não consegue indicar uma farmácia que entregue?", "Consegue me passar o contato de alguma farmácia?", "consegue indicar uma farmácia que entregue dipirona nesse endereço?"]) {
    assert.equal(looksLikePharmacyPartnerAsk(ask), true, ask);
    const phone = newPhone();
    await send(phone, "quero dipirona");
    const out = await send(phone, ask);
    assert.match(out, /Não tenho farmácia parceira/, `${ask}: ${out}`);
    assert.doesNotMatch(out, /endere[cç]o|CEP|Atendo os estados/i, `${ask}: ${out}`);
  }
});

test("c13: a nota fiscal não promete CPF de remédio quando o remédio isento está desligado", () => {
  assert.doesNotMatch(copy.fiscalAnswer("nf"), /remédio|CPF/i);
  assert.match(copy.fiscalAnswer("nf", undefined, true, true), /remédio sem receita sai no seu CPF/);
});

test("c09: 'vamos adicionar outro produto, pode ser 3 rações' — o enquadramento sai e só o item vai à busca (puro)", () => {
  assert.equal(stripAdditiveLead("vamos adicionar outro produto, pode ser 3 racoes de cachorro?"), "3 racoes de cachorro?");
  assert.equal(stripAdditiveLead("quero 3 rações"), "quero 3 rações");
  const combo = parseChoiceCombo("2, e vamos adicionar outro produto, pode ser 3 rações de cachorro", [
    { name: "Ração A", unitPrice: 10 },
    { name: "Ração B", unitPrice: 20 }
  ]);
  assert.equal(combo?.reply.index, 1);
  assert.equal(combo?.rest, "3 racoes de cachorro");
});

test("c30: no modo atendimento, o que o léxico não pega é decidido pela classificação (suporte = espera; produto = fluxo normal)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero falar com uma pessoa");
  __setRouterInterpreterForTests(async () => ({ action: "support" }) as never);
  try {
    const out = await send(phone, "Não tenho mais detalhes, só preciso que fulano me retorne agora");
    assert.doesNotMatch(out, /endere[cç]o|anotei|Oi! Sou a Lia/i, out);
    assert.match(out, /9h/, out);
  } finally {
    __setRouterInterpreterForTests(null as never);
  }
  const product = await send(phone, "quero arroz");
  assert.match(product, /Arroz/i, product);
});

test("c23: nada cabe e o cliente pede outro produto — o item que estourou sai da cesta e o teto acompanha a busca nova", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero um desodorante colônia até R$ 45");
  await send(phone, "2");
  await send(phone, "só isso");
  const out = await send(phone, "quero outro desodorante colônia");
  const ctx = await context(phone);
  assert.equal((ctx.basket ?? []).length, 0, "o item que estourou não fica na cesta");
  assert.equal(ctx.pending?.[0]?.cap, 45, `o teto de R$45 acompanha a busca nova: ${out.slice(0, 200)}`);
});
