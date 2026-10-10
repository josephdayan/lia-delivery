// Rodada 12, grupo G35 (10/10): achados das jornadas 301/303/304/307/308 (rodada12/grupo-b.md). Os testes de conversa
// passam pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. item pedido some da confirmação ("uns 4 tomates" engolido por "molho de tomate"; "escova de dente" por "fio dental");
//   2. "tem que ser macia" virava item fantasma, e "tira o 'tem que ser macia'" tirava a escova Sensodyne;
//   3. "qual a diferença entre esses dois?" sem resposta; "vocês embrulham pra presente?" sem resposta;
//   4. brinquedo pra 5 anos ignorava a idade; "carrinho ou lego" virava 2 itens; frase de contexto virava item.
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { ageFitsName, askedChildAge, handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests, reconcilePreItems, type PreDecision } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { attributeFragment, detectIntent, mergeShoppingLines, parseBasketLines, sameItemProduct } from "../src/lib/lia-intents";
import { splitAlternativeLine, parseAltAnswer } from "../src/lib/alt-items";
import { compareOptionsAnswer, serviceAnswer } from "../src/lib/lia-copy";
import { parseProductQuestion } from "../src/lib/product-question";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5532${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000 - Bela Vista, São Paulo/SP - CEP 01310-100";
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
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/viacep\.com\.br\/ws\/01310100/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g35_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function ctxOf(phone: string): Promise<DeliveryContext> {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function customerChoosing(extra: Partial<DeliveryContext>) {
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({ flow: "delivery", step: "choosing", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pendingSince: Date.now(), ...extra })
    }
  });
  return phone;
}
const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: false, ...over
});
const it = (query: string, qty = 1) => ({ query, qty, cheapest: false });
const opt = (sku: string, name: string, unitPrice: number) => ({ sku, name, unitPrice, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 });
const items = (xs: { query: string; qty: number }[]) => xs.map((x) => `${x.qty}x ${x.query}`);

// 1 ------------------------------------------------------------------------------------------------------------------
test("1a: item que divide uma palavra com outro ('tomates' × 'molho de tomate', 'escova de dente' × 'fio dental') não some", () => {
  assert.equal(sameItemProduct("tomate", "molho de tomate"), false);
  assert.equal(sameItemProduct("escova de dente", "fio dental"), false);
  assert.equal(sameItemProduct("molho de tomate", "molho de tomate tradicional"), true);
  assert.equal(sameItemProduct("arroz", "arroz branco"), true);
  const said = "vou fazer um jantar rápido pra mim e minha namorada, quero macarrão espaguete, molho de tomate, queijo ralado e uns 4 tomates";
  const merged = mergeShoppingLines(
    [{ phrase: "macarrão espaguete", qty: 1 }, { phrase: "molho de tomate", qty: 1 }, { phrase: "queijo ralado", qty: 1 }, { phrase: "tomate", qty: 4 }],
    parseBasketLines(said)
  );
  assert.ok(merged.some((l) => /^tomates?$/.test(l.phrase) && l.qty === 4), JSON.stringify(merged));
  assert.equal(merged.find((l) => /molho/.test(l.phrase))?.qty, 1, JSON.stringify(merged));
  // A IA que esquece o item: o que a frase pediu volta; contexto ("jantar pra mim e minha namorada") não vira item.
  const pre = items(reconcilePreItems([it("macarrão espaguete"), it("molho de tomate"), it("queijo ralado")], said));
  assert.ok(pre.includes("4x tomates") || pre.includes("4x tomate"), JSON.stringify(pre));
  assert.ok(!pre.some((p) => /jantar|namorada/.test(p)), JSON.stringify(pre));
  const trip = items(reconcilePreItems([it("protetor solar fps 50"), it("fio dental")], "vou viajar amanhã cedo, preciso de protetor solar fps 50, escova de dente e fio dental. preciso receber hoje à noite"));
  assert.ok(trip.some((p) => /escova de dente/.test(p)), JSON.stringify(trip));
  assert.ok(!trip.some((p) => /viajar|receber/.test(p)), JSON.stringify(trip));
});

test("1b: pré-cadastro com a IA esquecendo os tomates anota os 4 tomates, sem frase de contexto", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ items: [it("macarrão espaguete"), it("molho de tomate"), it("queijo ralado")] }));
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "vou fazer um jantar rápido pra mim e minha namorada, quero macarrão espaguete, molho de tomate, queijo ralado e uns 4 tomates");
  assert.match(out, /4x tomates?/i, out.slice(0, 600));
  assert.match(out, /1x molho de tomate/i, out.slice(0, 600));
  assert.doesNotMatch(out, /\*[^*]*(jantar|namorada)[^*]*\*/i, out.slice(0, 600));
});

// 2 ------------------------------------------------------------------------------------------------------------------
test("2a: 'tem que ser macia' é atributo do item anterior, não item", () => {
  for (const s of ["tem que ser macia", "precisa ser sem lactose", "que seja grande"]) assert.ok(attributeFragment(s), s);
  for (const s of ["escova de dente", "fio dental", "macia"]) assert.equal(attributeFragment(s), null, s);
  const lines = parseBasketLines("faltou a escova de dente, tem que ser macia");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0].phrase, /escova de dente.*macia/);
  const pre = items(reconcilePreItems([it("escova de dente"), it("tem que ser macia")], "faltou a escova de dente, tem que ser macia"));
  assert.deepEqual(pre, ["1x escova de dente macia"]);
});

test("2b: escolhendo fio dental, 'faltou a escova de dente, tem que ser macia' anota a escova macia sem item fantasma", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerChoosing({
    pending: [{ query: "fio dental", qty: 1, options: [opt("FD-1", "Fio Dental Colgate Total 50m", 12.9), opt("FD-2", "Fio Dental Oral-B Essential 50m", 10.5)] }]
  });
  const out = await send(phone, "faltou a escova de dente, tem que ser macia");
  assert.doesNotMatch(out, /\*tem que ser macia\*/i, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  const queries = [...(ctx.pending ?? []).map((p) => p.query), ...JSON.stringify(ctx).matchAll(/"(?:query|phrase)":"([^"]+)"/g)].map((q) => (typeof q === "string" ? q : q[1]));
  assert.ok(queries.some((q) => /fio dental/.test(q)), `fio dental mantido: ${JSON.stringify(queries)}`);
  assert.ok(!queries.some((q) => /^tem que ser/.test(q)), JSON.stringify(queries));
});

test("2c: 'tira o \"tem que ser macia\"' tira só a linha citada, não a escova da cesta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerChoosing({
    basket: [{ sku: "ESC-1", name: "Escova Dental Sensodyne Macia", qty: 1, unitPrice: 19.9, storeKey: "carrefour", ask: "escova de dente" }],
    pending: [{ query: "tem que ser macia", qty: 1, options: [opt("ESC-2", "Escova Dental Curaprox Macia", 39.9)] }]
  } as Partial<DeliveryContext>);
  await send(phone, "tira o 'tem que ser macia'");
  const ctx = await ctxOf(phone);
  assert.ok((ctx.basket ?? []).some((b) => b.sku === "ESC-1"), `escova mantida: ${JSON.stringify(ctx.basket)}`);
  assert.ok(!(ctx.pending ?? []).some((p) => p.query === "tem que ser macia"), JSON.stringify(ctx.pending));
});

// 3 ------------------------------------------------------------------------------------------------------------------
test("3a: 'qual a diferença entre esses dois?' compara as opções da tela; por nome também", () => {
  const names = ["Molho de Tomate Heinz Tradicional 300g", "Molho de Tomate Heinz Bolonhesa 300g"];
  assert.deepEqual(parseProductQuestion("qual a diferença entre esses dois?", 2, names), { kind: "compare_all" });
  assert.equal(parseProductQuestion("qual a diferença?", 2), null, "sem nomes, comportamento antigo");
  const named = parseProductQuestion("qual a diferença entre o bolonhesa e o tradicional?", 2, names);
  assert.equal(named?.kind, "compare", JSON.stringify(named));
  assert.equal(parseProductQuestion("qual a diferença do frete?", 2, names)?.kind === "compare_all", false);
  const answer = compareOptionsAnswer([
    { n: 1, name: names[0], price: 6.5, storeLabel: "Carrefour", delivery: "1 dia útil" },
    { n: 2, name: names[1], price: 7.2, storeLabel: "Carrefour", delivery: "1 dia útil" }
  ]);
  assert.match(answer, /Tradicional/);
  assert.match(answer, /Bolonhesa/);
  assert.match(answer, /por 100 g/);
  assert.match(answer, /Qual você quer\?/);
});

test("3b: 'vocês embrulham pra presente?' tem resposta própria; 'papel de embrulho' continua sendo item", () => {
  for (const s of ["vocês embrulham pra presente?", "vem embalado pra presente?", "da pra mandar um cartão junto?"]) {
    assert.deepEqual(detectIntent(s), { kind: "service_question", topic: "gift_wrap" }, s);
  }
  assert.notDeepEqual(detectIntent("papel de embrulho"), { kind: "service_question", topic: "gift_wrap" });
  assert.match(serviceAnswer("gift_wrap", "São Paulo"), /própria loja/);
});

test("3c: durante a escolha, comparação e embrulho respondem sem perder a escolha", async (t) => {
  if (!dbOk) return t.skip();
  const options = [opt("MT-1", "Molho de Tomate Heinz Tradicional 300g", 6.5), opt("MT-2", "Molho de Tomate Heinz Bolonhesa 300g", 7.2)];
  const phone = await customerChoosing({ pending: [{ query: "molho de tomate", qty: 1, options }] });
  const cmp = await send(phone, "qual a diferença entre esses dois?");
  assert.match(cmp, /Bolonhesa/, cmp.slice(0, 600));
  assert.match(cmp, /Tradicional/, cmp.slice(0, 600));
  assert.match(cmp, /Qual você quer\?/, cmp.slice(0, 600));
  const wrap = await send(phone, "vocês embrulham pra presente?");
  assert.match(wrap, /própria loja/, wrap.slice(0, 600));
  assert.equal((await ctxOf(phone)).pending?.[0]?.query, "molho de tomate");
});

// 4 ------------------------------------------------------------------------------------------------------------------
test("4a: 'carrinho ou lego pra 5 anos' é UM item com duas buscas; variação do mesmo produto não divide", () => {
  // (o catálogo da suíte não tem a loja de brinquedos; "lego" foi provado no talk-prod com as lojas reais)
  assert.deepEqual(splitAlternativeLine("quero coca ou guaraná pra festa"), ["coca pra festa", "guarana pra festa"]);
  for (const s of ["ração gato castrado ou filhote", "tênis preto ou branco"]) assert.equal(splitAlternativeLine(s), null, s);
  const one = items(reconcilePreItems([it("arroz"), it("coca"), it("guaraná")], "quero arroz e coca ou guaraná"));
  assert.equal(one.length, 2, JSON.stringify(one));
  assert.ok(one.some((l) => /coca ou guaran/.test(l)), JSON.stringify(one));
  assert.equal(parseAltAnswer("os dois", ["coca", "guaraná"]), "both");
  assert.equal(parseAltAnswer("tanto faz", ["coca", "guaraná"]), "either");
});

test("4a': pré-cadastro com a IA dividindo 'coca ou guaraná' anota UM item", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "true";
  __setPreSignupModelForTests(async () => D({ items: [it("arroz"), it("coca"), it("guaraná")] }));
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "quero arroz e coca ou guaraná");
  assert.match(out, /coca ou guaran/i, out.slice(0, 600));
  assert.doesNotMatch(out, /•\s*1x\s*coca\s*\n/i, out.slice(0, 600));
});

test("4b: a idade dita filtra a faixa etária do nome", () => {
  assert.equal(askedChildAge("brinquedo pro meu sobrinho de 5 anos"), 5);
  assert.equal(askedChildAge("arroz 5kg"), undefined);
  assert.equal(ageFitsName("Dinossauro T-Rex Bebê 6 a 18 meses", 5), false);
  assert.equal(ageFitsName("Lego Duplo 2+ anos", 5), true);
  assert.equal(ageFitsName("Lego Technic +10 anos", 5), false);
  assert.equal(ageFitsName("Carrinho Hot Wheels", 5), undefined);
});

test("4c: frase de contexto antes do pedido não vira item ('to querendo cuidar mais da minha pele')", () => {
  const said = "to querendo cuidar mais da minha pele, pele meio oleosa. um sabonete facial, um hidratante e um protetor solar facial. não tenho marca preferida";
  const out = items(reconcilePreItems([it("sabonete facial"), it("hidratante"), it("protetor solar facial")], said));
  assert.deepEqual(out, ["1x sabonete facial", "1x hidratante", "1x protetor solar facial"]);
});
