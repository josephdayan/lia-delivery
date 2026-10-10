// Rodada 11, grupo G31 (10/10): achados de /mnt/project-files/testes-whatsapp/rodada11/grupo-b.md (jornadas 301, 302, 303,
// 306, 308). Conversas do "oi" pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. "tira o lenço umedecido Huggies" tira só o lenço (nunca a fralda Huggies já escolhida); "lenço da Huggies" com o
//      lenço na fila corrige a linha da fila (sem 2º lenço), também pela IA do diálogo;
//   2. "o pacote maior" escolhe a opção de mais unidades; "tira isso/ele" tira o item citado na frase;
//   3. pedido de bebê não oferece lenço antisséptico; "banana" sem a fruta vira "não achei"; a pomada "bebê" não some no merge;
//   4. "tem dipirona pra eu colocar no kit?" com outro item na tela é recusa de remédio; "antes de eu me cadastrar" não é
//      item; "nenhum, só isso mesmo. quanto fica?" / "não, pode fechar. quanto deu?" fecham com o total.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { babyContextOptions, handleDeliveryMessage, hasBabyContext, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { __clearLiveCheckCacheForTests } from "../src/lib/live-availability";
import { detectIntent, isDiscourseOnly, largestPackIndex, mergeShoppingLines, parseChoiceReply, parsePronounRemove, sharesProductNoun } from "../src/lib/lia-intents";
import { resolveListItems } from "../src/lib/list-items";
import { parsePriceAsk } from "../src/lib/address-parse";
import { conciergeMatchIsStrong } from "../src/lib/stores/types";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5531${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS_MSG = "Avenida Paulista 1000, Bela Vista, São Paulo, 01310-100";
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

// ViaCEP e a simulação de checkout das lojas VTEX (frete ao vivo e conferência de estoque) sem rede.
const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cep = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (cep) return new Response(JSON.stringify(VIACEP[cep[1]] ?? { erro: true }), { status: 200 });
  if (/orderForms\/simulation/.test(url)) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { items?: Array<{ id: string; quantity: number }> };
    const items = body.items ?? [];
    return new Response(
      JSON.stringify({
        items: items.map((item, i) => ({ id: item.id, quantity: item.quantity, requestIndex: i, availability: "available", sellingPrice: 1999 })),
        logisticsInfo: items.map((_, i) => ({
          itemIndex: i,
          slas: [
            { id: "Normal", name: "Normal", price: 490, shippingEstimate: "1bd" },
            { id: "Super Expressa", name: "SUPER EXPRESSA", price: 690, shippingEstimate: "60m" }
          ]
        }))
      }),
      { status: 200 }
    );
  }
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
  process.env.LIA_LIVE_FREIGHT_OFF = "true";
  process.env.LIA_OPERATOR_QUOTE = "true";
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g31_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
// Do "oi" até o endereço salvo, como um cliente novo.
async function signedUp(): Promise<string> {
  const phone = newPhone();
  assert.match(await send(phone, "oi"), /endereço completo/i);
  assert.match(await send(phone, ADDRESS_MSG), /Endereço salvo/);
  return phone;
}
// Escolhe a 1ª opção de cada escolha aberta até a cesta fechar a seleção.
async function pickAll(phone: string): Promise<string> {
  let transcript = "";
  for (let i = 0; i < 6 && (await ctxOf(phone)).pending?.length; i++) transcript += `\n---\n${await send(phone, "1")}`;
  return transcript;
}

const dump = (ctx: DeliveryContext) =>
  JSON.stringify({ step: ctx.step, basket: (ctx.basket ?? []).map((b) => b.name), pending: (ctx.pending ?? []).map((p) => [p.query, p.options.map((o) => o.name)]) });
async function patchCtx(phone: string, fn: (ctx: DeliveryContext) => void) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  const ctx = JSON.parse(convo.context ?? "{}") as DeliveryContext;
  fn(ctx);
  await prisma.conversation.update({ where: { id: convo.id }, data: { context: JSON.stringify(ctx) } });
}
const queries = (ctx: DeliveryContext) => (ctx.pending ?? []).map((p) => p.query);
// A fralda escolhida, como em produção (303): mesma marca do lenço que o cliente quer tirar.
const FRALDA_HUGGIES = "Fraldas Huggies Rápida Absorção Mega M com 42 unidades";

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: 'tira o lenço umedecido Huggies' tira só o lenço Huggies — a fralda Huggies escolhida e o outro lenço ficam", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "fralda, lenço umedecido e sabonete");
  await send(phone, "1");
  await patchCtx(phone, (ctx) => {
    ctx.basket![0].name = FRALDA_HUGGIES;
    const lenco = ctx.pending!.find((p) => p.query === "lenço umedecido")!;
    ctx.pending!.push({ ...lenco, query: "lenço umedecido Huggies" });
  });
  const before = await ctxOf(phone);
  assert.deepEqual(queries(before).sort(), ["lenço umedecido", "lenço umedecido Huggies", "sabonete"].sort(), dump(before));
  const out = await send(phone, "tira o lenço umedecido Huggies");
  const ctx = await ctxOf(phone);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.name), [FRALDA_HUGGIES], `${out}\n${dump(ctx)}`);
  assert.deepEqual(queries(ctx).sort(), ["lenço umedecido", "sabonete"].sort(), dump(ctx));
  assert.doesNotMatch(out, /Tirei[^\n]*Fralda/i, out);
});

test("1b: 'lenço da Huggies, o mais barato' com o lenço na FILA corrige a linha da fila (caminho da IA do diálogo)", async (t) => {
  if (!dbOk) return t.skip();
  for (const withModel of [true]) {
    process.env.LIA_DIALOGUE_LLM = withModel ? "true" : "false";
    __setDialogueModelForTests(async (input) => (withModel && /huggies/i.test(input.text) ? { actions: [{ type: "search", query: "lenço umedecido Huggies" }] } : null));
    const phone = await signedUp();
    await send(phone, "fralda e lenço umedecido");
    assert.deepEqual(queries(await ctxOf(phone)), ["fralda", "lenço umedecido"]);
    const out = await send(phone, "lenço da Huggies, o mais barato");
    const ctx = await ctxOf(phone);
    const lencos = queries(ctx).filter((q) => /len[cç]o/i.test(q));
    assert.equal(lencos.length, 1, `IA=${withModel}: ${out}\n${dump(ctx)}`);
    assert.match(lencos[0], /huggies/i, dump(ctx));
    assert.ok(ctx.pending![1].options.every((o) => /huggies/i.test(o.name)), dump(ctx));
    assert.doesNotMatch(out, /Anotei \*len/i, out);
  }
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: 'o pacote maior' / 'a Huggies M mesmo, mas o pacote maior' escolhem a opção de mais unidades", async (t) => {
  const prod = [
    "Fralda Descartável Huggies Máxima Proteção 40un Tamanho M 5 a 9kg",
    "Fralda Pampers Pants Ajuste Total Tamanho M 30 Unidades",
    "Fralda Pampers Confort Sec Tamanho M 108 Unidades",
    "Fralda Roupinha Tamanho M Huggies Supreme Care com 36 Unidades",
    "Fraldas Huggies Rápida Absorção Mega M com 42 unidades"
  ].map((name) => ({ name, unitPrice: 10 }));
  assert.deepEqual(parseChoiceReply("a Huggies M mesmo, mas o pacote maior", prod), { type: "pick", index: 4 });
  assert.deepEqual(parseChoiceReply("o pacote maior", prod), { type: "pick", index: 2 });
  assert.equal(largestPackIndex("quero a Huggies", prod), null);
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "fralda");
  const options = (await ctxOf(phone)).pending![0].options;
  const units = (name: string) => Number(name.match(/(\d+)\s*(?:un|unidades)\b/i)?.[1] ?? 0);
  const biggest = options.reduce((best, o) => (units(o.name) > units(best.name) ? o : best));
  const out = await send(phone, "o pacote maior");
  const ctx = await ctxOf(phone);
  assert.deepEqual((ctx.basket ?? []).map((b) => b.name), [biggest.name], `${out}\n${dump(ctx)}`);
});

test("2b: 'peraí, banana chips não... tira isso' tira o item citado; 'esse lenço da Huggies repetiu, tira ele' tira o lenço Huggies", async (t) => {
  assert.deepEqual(parsePronounRemove("peraí, banana chips não, eu queria banana mesmo, fruta. tira isso"), { context: "perai, banana chips nao, eu queria banana mesmo, fruta", rest: "" });
  assert.notEqual(detectIntent("peraí, banana chips não, eu queria banana mesmo, fruta. tira isso").kind, "hold");
  assert.equal(detectIntent("pera, meu neto tá chorando").kind, "hold");
  if (!dbOk) return t.skip();
  const phone = await signedUp();
  await send(phone, "leite e banana");
  await pickAll(phone);
  await patchCtx(phone, (ctx) => {
    ctx.basket!.find((b) => /banana/i.test(b.name))!.name = "Banana Chips Kodilar 100g";
  });
  const out = await send(phone, "peraí, banana chips não, eu queria banana mesmo, fruta. tira isso");
  assert.doesNotMatch(out, /te espero/i, out);
  assert.match(out, /Tirei[^\n]*Banana Chips/i, out);
  const ctx = await ctxOf(phone);
  assert.ok((ctx.basket ?? []).some((b) => /leite/i.test(b.name)) && !(ctx.basket ?? []).some((b) => /banana/i.test(b.name)), dump(ctx));

  const p2 = await signedUp();
  await send(p2, "fralda, lenço umedecido e sabonete");
  await patchCtx(p2, (c) => {
    const lenco = c.pending!.find((p) => p.query === "lenço umedecido")!;
    c.pending!.push({ ...lenco, query: "lenço umedecido Huggies" });
  });
  const out2 = await send(p2, "esse lenço da Huggies repetiu, tira ele");
  const c2 = await ctxOf(p2);
  assert.deepEqual(queries(c2).sort(), ["fralda", "lenço umedecido", "sabonete"].sort(), `${out2}\n${dump(c2)}`);
  assert.doesNotMatch(out2, /Não achei: tira ele/i, out2);
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: pedido de bebê não oferece lenço antisséptico/íntimo; 'banana' solta não aceita produto feito com banana", () => {
  assert.ok(hasBabyContext("preciso de fralda tamanho M, lenço umedecido e pomada para assadura pro meu bebê"));
  assert.ok(!hasBabyContext("lenço umedecido e álcool em gel"));
  const opts = [
    { name: "Lenços Umedecidos Intimus Defesa Natural 16 Unidades" },
    { name: "Lenço Umedecido Free Wipes Antisséptico 20 Unidades" },
    { name: "Lenço Umedecido Amorável Baby Aloe Vera 48 Unidades" },
    { name: "Lenço Umedecido Turma da Mônica Huggies com 48 unidades" },
    { name: "Lenço Umedecido Piquitucho Premium Capim Limão 60 Unidades" }
  ];
  const kept = babyContextOptions("lenço umedecido", opts).map((o) => o.name);
  assert.ok(!kept.some((n) => /Antiss|Intimus/.test(n)), kept.join(" | "));
  assert.equal(kept.length, 3);
  // A fralda não é item com versão adulta: nada muda.
  assert.equal(babyContextOptions("fralda tamanho M", opts).length, opts.length);
  const item = (name: string) => ({ sku: name, name, unitPrice: 5 });
  for (const name of ["Banana Chips Kodilar 100g", "Ensure Banana 400g", "Banana Liofilizada 20g", "Bananas 90g Fini"]) assert.equal(conciergeMatchIsStrong("banana", item(name)), false, name);
  for (const name of ["Banana Nanica Carrefour Aprox. 600g", "Banana Prata 1kg"]) assert.equal(conciergeMatchIsStrong("banana", item(name)), true, name);
  assert.equal(conciergeMatchIsStrong("banana chips", item("Banana Chips Kodilar 100g")), true);
  // "pomada para assadura bebê" não é o "lenço umedecido" (o alias bebê→umedecido só vale para lenço): a IA que deixa a
  // pomada de fora não apaga a linha do parser.
  assert.equal(sharesProductNoun("pomada para assadura bebê", "lenço umedecido"), false);
  assert.equal(sharesProductNoun("lenço de bebê", "lenço umedecido"), true);
  const merged = mergeShoppingLines([{ phrase: "fralda tamanho M", qty: 1 }, { phrase: "lenço umedecido", qty: 1 }], resolveListItems("fralda tamanho M, lenço umedecido, pomada para assadura bebê"));
  assert.deepEqual(merged.map((l) => l.phrase), ["fralda tamanho M", "lenço umedecido", "pomada para assadura bebê"]);
});

test("3b: 'tem dipirona pra eu colocar no kit?' com outro item na tela recusa remédio e a escolha continua", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setDialogueModelForTests(async (input) => (/dipirona/i.test(input.text) ? { actions: [{ type: "refine", attribute: "dipirona pra eu colocar no kit" }] } : null));
  const phone = await signedUp();
  await send(phone, "lenço umedecido e sabonete");
  const out = await send(phone, "tem dipirona pra eu colocar no kit?");
  assert.match(out, /rem[eé]dio/i, out);
  assert.doesNotMatch(out, /Não achei \*len/i, out);
  const ctx = await ctxOf(phone);
  assert.deepEqual(queries(ctx), ["lenço umedecido", "sabonete"], dump(ctx));
});

test("3c: 'quanto custa o sabão em pó omo? antes de eu me cadastrar' anota só o sabão", async (t) => {
  assert.equal(parsePriceAsk("quanto custa o sabão em pó omo? antes de eu me cadastrar"), "sabão em pó omo");
  assert.equal(parsePriceAsk("quanto custa o café pilão hoje"), "café pilão");
  assert.ok(isDiscourseOnly("antes de eu me cadastrar"));
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "quanto custa o sabão em pó omo? antes de eu me cadastrar");
  assert.doesNotMatch(out, /cadastrar\*/i, out);
  assert.doesNotMatch(out, /• 1x antes/i, out);
  const after = await send(phone, ADDRESS_MSG);
  assert.doesNotMatch(after, /antes de eu me cadastrar/i, after);
});

test("3d: 'nenhum, só isso mesmo. quanto fica?' depois de 'De qual item…?' e 'não, pode fechar. quanto deu?' fecham com o total", async (t) => {
  for (const said of ["nenhum, só isso mesmo. quanto fica?", "não, pode fechar. quanto deu?", "nenhum, só isso"]) assert.equal(detectIntent(said).kind, "done", said);
  if (!dbOk) return t.skip();
  for (const closing of ["nenhum, só isso mesmo. quanto fica?", "não, pode fechar. quanto deu?"]) {
    const phone = await signedUp();
    await send(phone, "leite e arroz");
    await pickAll(phone);
    const ask = await send(phone, "o mais barato");
    assert.match(ask, /De qual item/i, ask);
    const out = await send(phone, closing);
    assert.doesNotMatch(out, /não troco nada|Até agora/i, `${closing}: ${out.slice(0, 500)}`);
    assert.match(out, /Total|Seu pedido|juntar|formas de entrega|pedido mínimo/i, `${closing}: ${out.slice(0, 800)}`);
  }
});
