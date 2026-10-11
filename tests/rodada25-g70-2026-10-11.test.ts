// Rodada 25, grupo A, corretor g70 (11/10): achados R25a-1 a R25a-4 de /mnt/project-files/testes-whatsapp/rodada25/grupo-a.md:
//   R25a-1 (N1): "sim, deixa 2 kg" sobre a laranja (na fila) com a banana na tela virava 2 unidades de banana 1 kg (fechou 11x);
//   R25a-2 (N2): "o mais barato de cada" sem nada pendente perguntava de volta; "toca em Pagar" antes de existir total;
//   R25a-3: frete com o endereço na pergunta pedia o endereço de novo; "quanto tá dando o frango?" sem escolha não dava preço;
//   R25a-4: "qual ficou o total?" com o mínimo da loja aberto pedia "só isso"; "te mando o novo" depois do novo;
//           "amaciante 2 litros"/"leite 2 L" lidos como "1 litro"; "Pampers M 40 unidades" sem "1x".
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.LIA_ENABLE_MAMBO = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  copy: typeof import("../src/lib/lia-copy");
  plan: typeof import("../src/lib/dialogue/plan");
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5525${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];

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
  m = {
    prisma,
    service: await import("../src/lib/delivery-service"),
    copy: await import("../src/lib/lia-copy"),
    plan: await import("../src/lib/dialogue/plan")
  };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string, ...rest: unknown[]) => {
      outbox.push({ to, kind: key, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
      return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
    };
  }
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

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g70_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function ctxOf(phone: string) {
  const convo = await m.prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}") as import("../src/lib/conversation-types").DeliveryContext;
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return phone;
}
const item = (sku: string, name: string, unitPrice: number, qty: number, ask: string, storeKey = "mambo", storeLabel = "Mambo") =>
  ({ sku, name, qty, unitPrice, lineTotal: Math.round(unitPrice * qty * 100) / 100, storeKey, storeLabel, ask });
const opt = (sku: string, name: string, unitPrice: number, extra: Record<string, unknown> = {}) => ({ sku, name, unitPrice, storeKey: "mambo", storeLabel: "Mambo", ...extra });

const banana = { query: "banana 1kg", qty: 1, qtyExplicit: true, options: [opt("mambo-1260", "Banana Nanica (unidade ~180 g)", 1.79, { unitWeightKg: 0.18 })] };
const alface = { query: "alface crespa 500g", qty: 1, options: [opt("mambo-1300", "Alface Crespa Hidropônica 300g", 7.89)] };
const laranja = { query: "laranja 2kg", qty: 1, options: [opt("mambo-1400", "Laranja Pêra (unidade ~280 g)", 1.39, { unitWeightKg: 0.28 }), opt("mambo-1401", "Laranja Pêra Alfa Citrus 2kg", 11.98)] };

// ---------------- R25a-1: peso dito vale para o item certo, nunca vira unidades ----------------

test("R25a-1: peso de um item da fila — pergunta confere, 'sim, deixa 2 kg' confirma a laranja; sem alvo dito, vale o da tela", () => {
  const pending = [banana, alface, laranja];
  const q = m.service.weightPendingTarget("e as laranjas, são 2 kg mesmo ou ficou mais?", pending);
  assert.deepEqual(q && { i: q.index, q: q.question, kg: q.currentKg, label: q.label }, { i: 2, q: true, kg: 2, label: "laranja" });
  const answer = m.copy.pendingWeightAnswer("laranja", 2, 2, false);
  const yes = m.service.weightPendingTarget("sim, deixa 2 kg", pending, answer);
  assert.deepEqual(yes && { i: yes.index, q: yes.question, kg: yes.askedKg }, { i: 2, q: false, kg: 2 });
  // Sem pergunta aberta nem item dito: o peso é do item da tela (banana 2 kg, nunca "2 unidades de banana 1kg").
  assert.equal(m.service.weightPendingTarget("deixa 2 kg", pending)?.index, 0);
  assert.equal(m.service.weightPendingTarget("deixa 3 kg de laranja", pending)?.index, 2);
  // Pedido novo não é ajuste.
  assert.equal(m.service.weightPendingTarget("e mais 2 kg de batata", pending), null);
  // Repetir o pedido com o peso não é ajuste; item cujo peso não existe (o "mais perto") fica com o caminho dele.
  assert.equal(m.service.weightPendingTarget("laranja 2kg", pending), null);
  assert.equal(m.service.weightPendingTarget("deixa 3 kg de laranja", [banana, { ...laranja, closestFalta: "é de 1 kg" }]), null);
  assert.equal(m.service.withAskedWeight("laranja 2kg", 3), "laranja 3kg");
  assert.equal(m.service.withAskedWeight("banana 1kg", 0.5), "banana 500g");
});

test("R25a-1: a IA não transforma peso dito em número de unidades (set_qty com 'kg' cai no caminho determinístico)", () => {
  const state = {
    passo: "escolhendo_opcao" as const,
    enderecoSalvo: true,
    cesta: [],
    fila: [{ n: 1, item: "laranja 2kg", qtd: 1 }],
    emEscolha: { item: "banana 1kg", qtdPedida: 1, qtdDita: true, opcoes: [{ n: 1, nome: "Banana Nanica (unidade ~180 g)", preco: 1.97 }] },
    ultimaEscolha: null,
    naoAcheiRecente: null,
    totalNaMesa: null,
    cobrancaAberta: false,
    opcoesDeFrete: null
  };
  const kg = m.plan.planActions({ actions: [{ type: "set_qty", target: 0, qty: 2 }] }, state, { text: "sim, deixa 2 kg" });
  assert.equal(kg.ok, false);
  const units = m.plan.planActions({ actions: [{ type: "set_qty", target: 0, qty: 2 }] }, state, { text: "deixa 2 unidades" });
  assert.equal(units.ok, true);
});

test("R25a-1: conversa — pergunta sobre a laranja e 'sim, deixa 2 kg' não mexem na banana da tela", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({ pending: [banana, alface, laranja] }, "choosing");
  const q = await send(phone, "e as laranjas, são 2 kg mesmo ou ficou mais?");
  assert.match(q, /anotei \*2 kg\* de \*laranja\*/, q);
  const out = await send(phone, "sim, deixa 2 kg");
  assert.match(out, /Fica \*2 kg\* de \*laranja\*/, out);
  assert.doesNotMatch(out, /banana/i, out);
  let ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[0].query, "banana 1kg");
  assert.equal(ctx.pending?.[0].qty, 1);
  assert.equal(ctx.pending?.[2].query, "laranja 2kg");
  const three = await send(phone, "deixa 3 kg de laranja");
  assert.match(three, /Anotei \*3 kg\* de \*laranja\*/, three);
  ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[2].query, "laranja 3kg");
  assert.equal(ctx.pending?.[0].qty, 1);
});

// ---------------- R25a-2 ----------------

test("R25a-2: o fim da escolha não manda 'pra fechar, toca em Pagar' sem total; 'o mais barato de cada' sem pendência explica", async (t) => {
  assert.doesNotMatch(m.copy.conciergeChooseNext(), /Pra fechar/);
  assert.match(m.copy.conciergeChooseNext(), /total com a entrega/);
  if (!dbOk) return t.skip();
  const shampoo = item("mambo-9", "Shampoo Elseve Longo dos Sonhos 200ml", 18.9, 1, "shampoo");
  const lar = item("mambo-2", "Laranja Pêra Alfa Citrus 2kg", 13.18, 1, "laranja 2kg");
  const phone = await customerWith({ basket: [shampoo, lar] });
  const out = await send(phone, "o mais barato de cada");
  assert.match(out, /Não tem nenhum item esperando escolha/, out);
  assert.match(out, /troca o shampoo pelo mais barato/, out);
  assert.doesNotMatch(out, /Você quer trocar cada item/, out);
});

// ---------------- R25a-3 ----------------

test("R25a-3: o endereço dito na pergunta do frete é guardado (só falta o CEP)", async (t) => {
  assert.equal(m.service.embeddedQuestionAddress("quanto custa o frete pra Avenida Paulista 1000, São Paulo? tem pedido mínimo?"), "Avenida Paulista 1000, São Paulo");
  assert.equal(m.service.embeddedQuestionAddress("quanto custa o frete? tem pedido mínimo?"), null);
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "quanto custa o frete pra Avenida Paulista 1000, São Paulo? tem pedido mínimo?");
  assert.match(out, /Falta o \*CEP\*/, out);
  assert.doesNotMatch(out, /me manda seu \*endereço com CEP\*/, out);
  assert.equal(out.split("\n---\n").length, 1, out);
  const ctx = await ctxOf(phone);
  assert.match(ctx.deliveryAddress ?? "", /Paulista 1000/);
});

test("R25a-3: 'quanto tá dando o frango?' com o frango ainda sem escolha dá a faixa de preço", async (t) => {
  if (!dbOk) return t.skip();
  const frango = { query: "frango inteiro", qty: 1, options: [opt("swift-1", "Frango Inteiro Congelado Swift", 28.99), opt("swift-2", "Frango Inteiro Temperado Swift", 34.5)] };
  const phone = await customerWith({ pending: [banana, frango] }, "choosing");
  const out = await send(phone, "quanto ta dando o frango?");
  assert.match(out, /\*frango inteiro\* ainda não está escolhido: vai de \*R\$ [\d,]+\* a \*R\$ [\d,]+\*/, out);
  assert.doesNotMatch(out, /Ainda não escolhi nada/, out);
});

// ---------------- R25a-4 ----------------

test("R25a-4: 'qual ficou o total?' com o mínimo da loja em aberto diz que falta essa decisão", async (t) => {
  assert.match(m.copy.partialTotal([{ name: "Arroz", qty: 1, displayLineTotal: 7 } as never], 7, 0, [], [], undefined, undefined, "o pedido mínimo da *Americanas*"), /Falta só você decidir o pedido mínimo da \*Americanas\*/);
  assert.doesNotMatch(m.copy.orderReopened(), /te mando o novo/i);
  assert.match(m.copy.orderReopened(), /total anterior não vale mais/);
  if (!dbOk) return t.skip();
  const agua = item("americanas-1", "Água Sanitária Ypê 2L", 5.49, 1, "água sanitária", "americanas", "Americanas");
  const arroz = item("mambo-3", "Arroz Camil 1kg", 7.14, 1, "arroz");
  const phone = await customerWith({ basket: [agua, arroz], minSwap: { fromStoreKey: "americanas", replacements: [{ fromSku: "americanas-1", qty: 2, option: opt("mambo-4", "Água Sanitária Ypê 1L", 2.99) }] } });
  const out = await send(phone, "qual ficou o total?");
  assert.match(out, /Falta só você decidir o pedido mínimo da \*Americanas\*/, out);
  assert.doesNotMatch(out, /Diz \*"só isso"\*/, out);
});

test("R25a-4: 'leite 2 L' sem a caixa de 2 L segue lido como o cliente pediu e o cabeçalho explica as de 1 litro", async (t) => {
  assert.match(m.copy.sizeSplitHeader("amaciante Comfort 2 litros", "amaciante Comfort 1 litro", 2), /Não achei \*amaciante Comfort 2 litros\* numa embalagem só — separei as de \*1 litro\* \(2 embalagens/);
  const split = { sizeSplitFrom: { asked: "leite 2 L", shown: "leite 1 litro" }, query: "leite 1 litro", qty: 2 };
  assert.match(m.copy.nextChoiceHeader("leite 2 L", 2, undefined, split), /Agora \*leite 2 L\* — depois falta 1\.\nNão achei \*leite 2 L\* numa embalagem só/);
  // Query refinada depois (não é mais a reescrita): o aviso some.
  assert.doesNotMatch(m.copy.nextChoiceHeader("leite integral", 2, undefined, { ...split, query: "leite integral" }), /numa embalagem só/);
  if (!dbOk) return t.skip();
  const leite = { query: "leite 1 litro", qty: 2, qtyExplicit: true, sizeSplitFrom: { asked: "leite 2 L", shown: "leite 1 litro" }, options: [opt("mambo-5", "Leite Integral Parmalat 1 Litro", 5.29), opt("mambo-6", "Leite Integral Italac 1 Litro", 4.99)] };
  const phone = await customerWith({ pending: [banana, leite] }, "choosing");
  const out = await send(phone, "quanto ta dando o leite?");
  assert.match(out, /\*leite 2 L\* ainda não está escolhido/, out);
});
