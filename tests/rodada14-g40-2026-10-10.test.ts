// Rodada 14, grupo G40 (10/10): achados de /mnt/project-files/testes-whatsapp/rodada14/grupo-b.md (A1, M4, M6, M8, M11)
// e dois resíduos da rodada 13 (R13a-7, R13a-8). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage):
//   1. (A1) "bolacha de água e sal" virava "bolacha de água" + "sal" (sal marinho de R$ 60); "pode tirar o sal" tirava
//      também o biscoito já escolhido; "coloca de novo a bolacha de água e sal Aymoré" dividia de novo;
//   2. (M6/M8) frase de contexto virava item: "meu cachorro tem 13 anos", "ah, na real vou pedir pra entregar na casa da
//      minha sogra: Rua…" (fantasma "na real vou pra" até o resumo);
//   3. (M8) "ração sênior cachorro shih tzu 1kg" não achava a ração sênior de porte pequeno;
//   4. (M11) "só 1 caixa de 10 mesmo" em resposta a "Levo 2 embalagens (20 un)?" virava busca nova;
//   5. (R13a-8) "Teste Silva, Avenida Paulista 1000…" no cadastro: "não achei Teste Silva";
//   6. (R13a-7) "o da telhanorte" com o card da Telhanorte na tela.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, reconcilePreItems, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { resolveListItems } from "../src/lib/list-items";
import { isNonItemSegment } from "../src/lib/lia-intents";
import { peelPersonName, splitAddressAndItems } from "../src/lib/address-parse";
import { dialogueBypassReason } from "../src/lib/dialogue";
import { conciergeMatchIsStrong, queryAliases, rankCatalog, satisfiesNegation, type CatalogItem } from "../src/lib/stores/types";
import type { BasketItem, ChoiceOption, DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5540${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
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
const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" },
  "05422001": { logradouro: "Rua dos Pinheiros", bairro: "Pinheiros", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  return new Response("{}", { status: 404 });
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
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
afterEach(() => {
  __clearLiveCheckCacheForTests();
});
after(async () => {
  __setPreflightForTests(null);
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g40_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "choosing") {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, pendingSince: Date.now(), ...ctxExtra }) }
  });
  return phone;
}
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, delivery = "1 dia útil"): ChoiceOption =>
  ({ sku, name, unitPrice, storeKey, storeLabel, delivery, etaMinutes: 1440 }) as ChoiceOption;
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, ask?: string): BasketItem =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, delivery: "1 dia útil", ...(ask ? { ask } : {}) }) as BasketItem;
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });
const item = (name: string): CatalogItem => ({ sku: name, name, unitPrice: 10 }) as CatalogItem;

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: 'bolacha de água e sal' é um item só; 'água e sal grosso' continua dois", () => {
  const lanche = resolveListItems("barra de cereal, bolacha de água e sal, suco de caixinha, pasta de amendoim e um pote de granola").map((l) => l.phrase);
  assert.ok(lanche.includes("bolacha de água e sal"), JSON.stringify(lanche));
  assert.ok(!lanche.includes("sal") && !lanche.includes("bolacha de água"), JSON.stringify(lanche));
  assert.deepEqual(resolveListItems("biscoito aymoré água e sal e pão").map((l) => l.phrase), ["biscoito aymoré água e sal", "pão"]);
  assert.deepEqual(resolveListItems("bolacha de água e sal Aymoré").map((l) => l.phrase), ["bolacha de água e sal Aymoré"]);
  assert.equal(resolveListItems("água e sal grosso").length, 2);
});

test("1b: antes do cadastro, o 'Anotei' traz a bolacha de água e sal inteira e nenhum 'sal' solto (com e sem IA)", async (t) => {
  if (!dbOk) return t.skip();
  const msg = "preciso fazer o lanche da semana pro trabalho e receber até segunda de manhã: barra de cereal, bolacha de água e sal, suco de caixinha, pasta de amendoim e um pote de granola";
  for (const llm of [false, true]) {
    if (llm) {
      process.env.LIA_DIALOGUE_LLM = "true";
      __setPreSignupModelForTests(async () => D({ items: [it("barra de cereal"), it("bolacha de água e sal"), it("suco de caixinha"), it("pasta de amendoim"), it("granola")] }));
    }
    const phone = newPhone();
    await send(phone, "oi");
    const out = await send(phone, msg);
    assert.match(out, /1x bolacha de [aá]gua e sal/i, out.slice(0, 600));
    assert.doesNotMatch(out, /•\s*1x sal\b/i, out.slice(0, 600));
  }
});

test("1c: 'pode tirar o sal' tira só o 'sal' fantasma; o Biscoito Água e Sal escolhido fica", async (t) => {
  if (!dbOk) return t.skip();
  const biscoito = line("mambo-22566", "Biscoito Água e Sal Adria 170g", 4.06, "mambo", "Mambo", "bolacha de água e sal");
  const barra = line("mambo-286349", "Barra Cereais Cranbery Nuts &Joy 30g", 5.05, "mambo", "Mambo", "barra de cereal");
  const suco = { query: "suco de caixinha", qty: 1, options: [opt("mambo-14220", "Suco Kapo Sabor Maracujá Del Valle 200ml", 3.62, "mambo", "Mambo")] };
  const sal = { query: "sal", qty: 1, options: [opt("santaluzia-1", "Sal Marinho de Guérande La Baleine 800g", 60.39, "santaluzia", "Casa Santa Luzia")] };
  const phone = await customerWith({ basket: [barra, biscoito], pending: [suco, sal] });
  const out = await send(phone, "não pedi sal, era a bolacha de água e sal. pode tirar o sal");
  const ctx = await ctxOf(phone);
  assert.ok(ctx.basket?.some((b) => b.sku === biscoito.sku), `o biscoito sumiu: ${out.slice(0, 300)}`);
  assert.ok(!(ctx.pending ?? []).some((p) => p.query === "sal"), out.slice(0, 300));
  assert.ok((ctx.pending ?? []).some((p) => /suco/.test(p.query)), "o suco continua em escolha");
  // "tira o biscoito" continua tirando o biscoito.
  const phone2 = await customerWith({ basket: [barra, biscoito], pending: [suco] });
  await send(phone2, "tira o biscoito");
  assert.ok(!(await ctxOf(phone2)).basket?.some((b) => b.sku === biscoito.sku));
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: idade de quem o pedido atende e a troca de endereço contada não são item", () => {
  for (const s of ["meu cachorro tem 13 anos", "minha filha tem 5 anos", "ele tem 2 anos", "o meu gato já tem 15 anos", "na real vou pra", "vou pedir pra entregar no trabalho", "ah na real vou pedir pra"]) {
    assert.ok(isNonItemSegment(s), s);
  }
  for (const s of ["ração sênior de 1kg", "quero mandar flores", "fralda pra bebê de 2 anos", "vela de 13 anos"]) assert.ok(!isNonItemSegment(s), s);
  assert.equal(splitAddressAndItems("ah, na real vou pedir pra entregar na casa da minha sogra: Rua dos Pinheiros 600, Pinheiros, São Paulo, 05422-001")?.items, undefined);
});

test("2b: 'meu cachorro tem 13 anos' não entra no pedido guardado (a IA anotou só os produtos)", async (t) => {
  if (!dbOk) return t.skip();
  const msg = "meu cachorro tem 13 anos, um shih tzu, preciso de ração sênior de 1kg, tapete higiênico, shampoo neutro e uma caminha";
  const items = reconcilePreItems([it("ração sênior 1kg cachorro shih tzu"), it("tapete higiênico"), it("shampoo neutro"), it("caminha cachorro shih tzu")], msg);
  assert.ok(!items.some((i) => /13 anos/.test(i.query)), JSON.stringify(items));
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ items: [it("ração sênior 1kg cachorro shih tzu"), it("tapete higiênico"), it("shampoo neutro"), it("caminha cachorro shih tzu")] }));
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, msg);
  assert.match(out, /tapete/i, out.slice(0, 600));
  assert.doesNotMatch(out, /meu cachorro tem 13 anos/i, out.slice(0, 600));
});

test("2c: trocar o endereço no meio da escolha com 'na real vou pedir pra entregar…' não cria item fantasma", async (t) => {
  if (!dbOk) return t.skip();
  const massa = { query: "massa de pizza", qty: 1, options: [opt("mambo-23311", "Massa Pizza Brotinho Massa Leve 300g", 10.88, "mambo", "Mambo")] };
  const phone = await customerWith({ pending: [massa] });
  const out = await send(phone, "ah, na real vou pedir pra entregar na casa da minha sogra: Rua dos Pinheiros 600, Pinheiros, São Paulo, 05422-001");
  assert.match(out, /Rua dos Pinheiros/i, out.slice(0, 500));
  assert.doesNotMatch(out, /na real|n[aã]o achei/i, out.slice(0, 500));
  const ctx = await ctxOf(phone);
  assert.ok(!JSON.stringify(ctx.listMisses ?? []).includes("real"), JSON.stringify(ctx.listMisses));
  assert.ok(!(ctx.pending ?? []).some((p) => /real/.test(p.query)), JSON.stringify(ctx.pending?.map((p) => p.query)));
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3: raça pequena casa com a ração de porte pequeno ('ração sênior cachorro shih tzu 1kg')", () => {
  const q = "ração sênior cachorro shih tzu 1kg";
  const senior = item("Ração Origens Cães Senior Mini e Pequeno Frango e Cereais 1kg");
  const porte = item("Ração Premier Ambientes Internos Cães Sênior Porte Pequeno Frango e Salmão 1 kg");
  const grande = item("Ração Origens Cães Senior Raças Grandes Frango 15kg");
  assert.ok(conciergeMatchIsStrong(q, senior));
  assert.ok(conciergeMatchIsStrong(q, porte));
  assert.ok(!conciergeMatchIsStrong(q, grande));
  const ranked = rankCatalog(q, [grande, item("Ração Premier Raças Específicas Cães Adultos Shih Tzu Frango 1 kg"), senior], 3).map((i) => i.name);
  assert.equal(ranked[0], senior.name, JSON.stringify(ranked));
  // "mini" sozinho (boneca, brinquedo) não é porte pequeno.
  assert.ok(!conciergeMatchIsStrong("caminha cachorro shih tzu", item("Mini Boneca para Brincar de Casinha com Carro e Cachorro")));
  // O nome com a raça continua casando direto.
  assert.ok(conciergeMatchIsStrong("ração shih tzu", item("Ração Premier Raças Específicas Cães Adultos Shih Tzu Frango 1 kg")));
});

test("3b: 'tesoura sem ponta' também busca 'tesoura escolar' (o nome da prateleira)", () => {
  assert.ok(queryAliases("tesoura sem ponta").includes("tesoura escolar"), JSON.stringify(queryAliases("tesoura sem ponta")));
  assert.ok(queryAliases("tesoura de ponta redonda").includes("tesoura escolar"));
  assert.deepEqual(queryAliases("tesoura de cozinha"), []);
  // "Ponta Arredondada" no nome É a tesoura sem ponta.
  assert.equal(satisfiesNegation("tesoura sem ponta", "Tesoura Escolar Leonora Lâmina Aço Inox Ponta Arredondada Rosa 5cm"), true);
  assert.equal(satisfiesNegation("tesoura sem ponta", "Tesoura Multiuso Brinox 7\" Aço Inox"), false);
});

// 4 ------------------------------------------------------------------------------------------------------------------
test("4: 'só 1 caixa de 10 mesmo' responde 'Levo 2 embalagens?': 1 embalagem na cesta, sem busca nova", async (t) => {
  if (!dbOk) return t.skip();
  const ovos = opt("santaluzia-158422", "Ovos Vermelho Caipira Mantiqueira Grandes - 10 un", 18.37, "santaluzia", "Casa Santa Luzia");
  for (const reply of ["só 1 caixa de 10 mesmo", "só uma mesmo", "não, só 1"]) {
    const phone = await customerWith({ pending: [{ query: "ovos", qty: 12, qtyExplicit: true, options: [ovos] }], packConfirm: { sku: ovos.sku, askedQty: 12 } });
    const out = await send(phone, reply);
    assert.doesNotMatch(out, /Op[cç][oõ]es de/i, `${reply}: ${out.slice(0, 300)}`);
    const ctx = await ctxOf(phone);
    assert.equal(ctx.basket?.find((b) => b.sku === ovos.sku)?.qty, 1, `${reply}: ${out.slice(0, 300)}`);
  }
  // "sim" continua levando as 2 embalagens.
  const phone = await customerWith({ pending: [{ query: "ovos", qty: 12, qtyExplicit: true, options: [ovos] }], packConfirm: { sku: ovos.sku, askedQty: 12 } });
  await send(phone, "sim");
  assert.equal((await ctxOf(phone)).basket?.find((b) => b.sku === ovos.sku)?.qty, 2);
});

// 5 ------------------------------------------------------------------------------------------------------------------
test("5a: nome antes da rua sai da lista e volta à parte; nome que é produto fica", () => {
  assert.deepEqual(peelPersonName("Teste Silva"), { name: "Teste Silva" });
  assert.deepEqual(peelPersonName("Fulano Silva, quero arroz"), { name: "Fulano Silva", rest: "quero arroz" });
  assert.deepEqual(peelPersonName("Coca Cola"), { rest: "Coca Cola" });
  assert.equal(splitAddressAndItems("Teste Silva, Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100")?.items, "Teste Silva");
});

test("5b: 'Teste Silva, Avenida Paulista 1000…' no cadastro: o nome não vira item e vale com o CPF que chega sozinho", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  await send(phone, "quero arroz e feijão");
  const out = await send(phone, "Teste Silva, Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.match(out, /Endere[cç]o salvo/i, out.slice(0, 400));
  assert.doesNotMatch(out, /Teste Silva/i, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  assert.ok(!JSON.stringify(ctx).includes("Teste Silva"), JSON.stringify(ctx.listMisses ?? ctx.pendingRequest));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { phone } })).cpfName, "Teste Silva");
  // Só o endereço (sem pedido): "1x Fulano Silva" não aparece; o CPF sozinho fecha o cadastro com o nome dito antes.
  const p2 = newPhone();
  await send(p2, "oi");
  const out2 = await send(p2, "Fulano Silva, Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100");
  assert.doesNotMatch(out2, /Fulano/i, out2.slice(0, 600));
  const out3 = await send(p2, "529.982.247-25");
  assert.doesNotMatch(out3, /nome completo|n[aã]o achei|\*{4}/i, out3.slice(0, 400));
  const u = await prisma.user.findUniqueOrThrow({ where: { phone: p2 } });
  assert.equal(u.cpf, "52998224725");
  assert.equal(u.cpfName, "Fulano Silva");
});

test("5c: com o CPF anotado e o nome pedido, o nome sozinho fecha o cadastro e nunca vira busca", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "need_cpf", context: JSON.stringify({ flow: "delivery", step: "need_cpf", cpfOnboarding: true, cpfDraft: { cpf: "52998224725" }, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true }) }
  });
  const out = await send(phone, "Fulano Silva");
  assert.doesNotMatch(out, /n[aã]o achei/i, out.slice(0, 400));
  const u = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(u.cpfName, "Fulano Silva");
});

// 6 ------------------------------------------------------------------------------------------------------------------
test("6: 'o da telhanorte' com o card da Telhanorte na tela escolhe/estreita, nunca 'não entendi'", async (t) => {
  if (!dbOk) return t.skip();
  const options = [
    opt("mambo-1", "Desengordurante Cozinha Limpol 500ml", 15.07, "mambo", "Mambo"),
    opt("telhanorte-2589737", "Desengordurante Multiuso 300Ml Super Dom", 19.69, "telhanorte", "Telhanorte"),
    opt("americanas-1", "Desengordurante Multiuso Mr Músculo Cozinha 500ml", 17.59, "americanas", "Americanas")
  ];
  for (const reply of ["o da telhanorte", "quero o da Telhanorte", "o da telha norte"]) {
    const phone = await customerWith({ pending: [{ query: "desengordurante", qty: 1, options }] });
    const out = await send(phone, reply);
    assert.doesNotMatch(out, /n[aã]o entendi|me perdi/i, `${reply}: ${out.slice(0, 300)}`);
    const ctx = await ctxOf(phone);
    const chosen = ctx.basket?.some((b) => b.sku === "telhanorte-2589737");
    const narrowed = ctx.pending?.[0]?.options.length === 1 && ctx.pending[0].options[0].sku === "telhanorte-2589737";
    assert.ok(chosen || narrowed, `${reply}: ${out.slice(0, 300)}`);
  }
});

// 7 ------------------------------------------------------------------------------------------------------------------
test("7: 'o primeiro' em resposta a 'Levo 6 pacotes?' repete a pergunta com o valor (não fecha 6x calado)", async (t) => {
  if (!dbOk) return t.skip();
  const pao = opt("santaluzia-pao", "Pão de Alho Baguete Tradicional 400g", 20.35, "santaluzia", "Casa Santa Luzia");
  const base = { pending: [{ query: "pão de alho", qty: 6, qtyExplicit: true, options: [pao] }], packConfirm: { sku: pao.sku, askedQty: 6, kind: "count" } };
  const phone = await customerWith(base);
  const out = await send(phone, "o primeiro");
  assert.match(out, /6 pacotes/i, out.slice(0, 400));
  assert.match(out, /R\$/, out.slice(0, 400));
  let ctx = await ctxOf(phone);
  assert.ok(!ctx.basket?.some((b) => b.sku === pao.sku), out.slice(0, 400));
  assert.ok(ctx.packConfirm, "a pergunta continua aberta");
  await send(phone, "só 1");
  ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.find((b) => b.sku === pao.sku)?.qty, 1);
  // A IA não decide essa resposta (a pergunta é do cérebro).
  for (const text of ["o primeiro", "só uma mesmo", "só 1 caixa de 10 mesmo"]) {
    assert.equal(dialogueBypassReason({ text, ctx: { ...base, step: "choosing" } as never, hasAddress: true } as never), "pergunta_embalagem", text);
  }
});
