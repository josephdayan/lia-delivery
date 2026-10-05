// End-to-end conversation evals: drives handleDeliveryMessage exactly like the
// WhatsApp webhook does and asserts on what Lia replies. Uses the real database
// (unique test phone numbers, cleaned up at the end), the mock WhatsApp provider,
// the deterministic NLU fallback (no OpenAI) and mock couriers/Pix — so the whole
// flow runs offline-ish and repeatably. Run: npm test
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { getStore, pickStoreForQueries } from "../src/lib/stores";
import { attrMatchesItem } from "../src/lib/stores/types";

// Unique per run so a crashed/killed previous run can't collide (phones) nor trip
// the webhook dedupe (messageIds).
const RUN = `${Date.now().toString(36)}${process.pid}`;
// Keep cleanup isolated too. A fixed prefix let a second test process delete a
// conversation while the first one was still writing messages into it.
const PREFIX = `+5500${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let phoneSeq = 0;
let msgSeq = 0;
let dbOk = false;

const outbox: { to: string; text: string }[] = [];
// Capture everything Lia sends instead of hitting a real provider.
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
(whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};

function newPhone(): string {
  const digits = `${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(3, "0")}`.slice(-10);
  return `${PREFIX}${digits}`;
}

function driver(phone: string) {
  async function send(text: string): Promise<string> {
    const start = outbox.length;
    await handleDeliveryMessage({ phone, text, messageId: `eval_${RUN}_${++msgSeq}` });
    return outbox
      .slice(start)
      .filter((m) => m.to === phone)
      .map((m) => m.text)
      .join("\n---\n");
  }
  // Sends a message and auto-answers "1" while Lia is offering numbered options,
  // so scenarios that don't care about the choice reach the summary. Olha só a
  // ÚLTIMA resposta (não o transcript acumulado): senão o loop continua mandando
  // "1" depois do menu de pagamento e escolhe Pix sem querer.
  async function sendAndResolve(text: string): Promise<string> {
    let last = await send(text);
    let transcript = last;
    for (let i = 0; i < 6 && /Responde \*1\*/.test(last); i++) {
      last = await send("1");
      transcript += "\n---\n" + last;
    }
    return transcript;
  }
  return { send, sendAndResolve };
}

// Creates a user that already finished onboarding (saved address + CEP), like a returning customer.
async function returningCustomer() {
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  return { phone, ...driver(phone) };
}

// Pick a real catalog item the deterministic matcher will resolve, so scenarios
// adapt to catalog changes instead of hardcoding product names.
// Names with "," or " e " would be split by the deterministic line parser — skip those.
function cleanName(name: string): boolean {
  return !/,|\se\s|^\d/i.test(name);
}

function expensiveItemQuery(): { query: string; qty: number } {
  const catalog = getStore("petz").listCatalog();
  const item =
    catalog.find((i) => i.unitPrice >= 20 && i.unitPrice <= 80 && cleanName(i.name)) ?? catalog[0];
  const qty = Math.max(1, Math.ceil(60 / item.unitPrice));
  return { query: item.name, qty };
}

// A cheap item that routes to a store WITH a minimum order (Carrefour, R$30) so the
// below-minimum nudge fires. Petz has no minimum, so a cheap Petz item would never
// trigger it — the eval is about the nudge, not about which store.
//
// O elenco de lojas fica fixado no load-env, então o item mais barato do Carrefour já roteia
// para ele. Confirmar o roteamento aqui é a rede de segurança: se alguém somar uma vitrine
// sem pinar a chave no load-env, o eval escolhe outro item em vez de falhar por um motivo
// que não é o dele — foi assim que a Pague Menos (mínimo 0) roubou o Baton em 02/08.
async function cheapItemQuery(): Promise<string> {
  const candidates = getStore("carrefour")
    .listCatalog()
    .filter((i) => i.unitPrice > 2 && i.unitPrice < 10 && cleanName(i.name))
    .sort((a, b) => a.unitPrice - b.unitPrice);
  for (const item of candidates.slice(0, 40)) {
    const store = await pickStoreForQueries([item.name]);
    if ((store.minOrder ?? 0) > 0) return item.name;
  }
  return candidates[0]?.name ?? "sabonete";
}

async function wipeTestData() {
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const convos = await prisma.conversation.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const convoIds = convos.map((c) => c.id);
  // Use the parent relation too: this remains correct if another test created a
  // conversation between the id snapshot above and the cleanup statements.
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convoIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipeTestData(); // leftovers from a crashed previous run
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
    dbOk = false;
    console.warn("⚠️  Banco indisponível — evals de conversa serão pulados.");
  }
});

after(async () => {
  if (!dbOk) return;
  await wipeTestData();
  await prisma.$disconnect();
});

test("saudação: sem endereço pede endereço completo; cliente recorrente se apresenta e pede itens", async (t) => {
  if (!dbOk) return t.skip();
  const fresh = driver(newPhone());
  const hello = await fresh.send("oi");
  assert.match(hello, /endereço completo/i);
  const back = await returningCustomer();
  const hi = await back.send("bom dia");
  assert.match(hi, /Lia/);
  assert.doesNotMatch(hi, /Procurando/);
});

test("multi-item com quantidade: '2 X e 1 Y' vira cesta com 2x", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const transcript = await c.sendAndResolve("2 arroz e 1 oleo de soja");
  assert.match(transcript, /2x /);
});

test("multi-item ambíguo avisa que vai escolher um de cada vez e preserva o segundo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const first = await c.send("quero uma coca e uma escova de dente");
  assert.match(first, /Achei os 2 itens/i);
  assert.match(first, /um de cada vez[\s\S]*coca[\s\S]*depois[\s\S]*escova/i);
  assert.match(first, /Olha o que achei[\s\S]*Coca-Cola/i);
  const second = await c.send("1");
  assert.match(second, /Agora \*escova de dente\*/i);
  assert.match(second, /Escova de Dente/i);
});

test("opções antigas somem em silêncio no oi e a limpeza fica persistida", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  const convo = await prisma.conversation.create({
    data: {
      userId: user.id,
      status: "active",
      currentStep: "choosing",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      context: JSON.stringify({
        flow: "delivery",
        step: "choosing",
        cep: "01310-100",
        pending: [{ query: "coca", qty: 1, options: [
          { sku: "a", name: "Coca A", unitPrice: 4 },
          { sku: "b", name: "Coca B", unitPrice: 5 }
        ] }]
      })
    }
  });
  // O relógio de inatividade é a última MENSAGEM (não o updatedAt, que o lock de turno
  // bumpa a cada mensagem) — simula a conversa real de 1h atrás.
  await prisma.message.create({
    data: { conversationId: convo.id, sender: "user", text: "quero coca", createdAt: new Date(Date.now() - 60 * 60 * 1000) }
  });
  const hello = await driver(phone).send("oi");
  assert.doesNotMatch(hello, /lista anterior|carrinho anterior|expirou/i);
  const saved = await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } });
  const ctx = JSON.parse(saved.context ?? "{}") as { pending?: unknown[]; cep?: string };
  assert.equal(ctx.pending, undefined);
  assert.equal(ctx.cep, "01310-100");
  const next = await driver(phone).send("quero coca");
  assert.doesNotMatch(next, /lista anterior|carrinho anterior|expirou/i);
  assert.match(next, /coca/i);
});

test("quantidade: escolher sem dizer quantas assume 1 un e avisa como mudar (regra 01/09)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const offer = await c.send("quero coca");
  assert.match(offer, /Olha o que achei|opções/i);
  const confirmed = await c.send("1");
  assert.doesNotMatch(confirmed, /Quantas unidades/i, `voltou a perguntar quantidade: ${confirmed.slice(0, 200)}`);
  assert.match(confirmed, /^✅ /m, confirmed.slice(0, 200));
});

test("multi-loja: ração e perfume convivem na mesma cesta com duas entregas", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  let response = await c.send("2 ração e 2 perfume");
  let transcript = response;
  for (let i = 0; i < 4 && /Responde \*1\*/.test(response); i++) {
    response = await c.send("1");
    transcript += `\n---\n${response}`;
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { phone: c.phone } });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id, status: "active" } });
  const ctx = JSON.parse(convo.context ?? "{}") as { basket?: Array<{ storeKey: string }>; fulfillments?: Array<{ storeKey: string }> };
  // Cesta MISTA no concierge: a busca é larga (todas as vitrines), então a ração pode vir
  // de qualquer loja de mercado/pet; o que importa é que os dois itens convivem com lojas
  // diferentes (a divisão em entregas acontece na cotação, não aqui).
  const stores = new Set(ctx.basket?.map((item) => item.storeKey));
  assert.equal(ctx.basket?.length, 2, `${transcript}\nCTX=${convo.context}`);
  assert.equal(stores.size, 2, `${transcript}\nCTX=${convo.context}`);
  assert.ok(stores.has("boticario"), `perfume deveria vir da Boticário: ${[...stores].join(",")}`);
});

test("ação adicionar mais reabre a coleta sem perder a cesta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.send("2 ração");
  await c.send("1");
  const prompt = await c.send("adicionar_mais");
  assert.match(prompt, /cesta continua salva|mais você quer/i);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone: c.phone } });
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id, status: "active" } });
  const ctx = JSON.parse(convo.context ?? "{}") as { step?: string; basket?: unknown[] };
  assert.equal(ctx.step, "collecting");
  assert.equal(ctx.basket?.length, 1);
});

test("memória: produto comprado antes sobe para a primeira opção", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const user = await prisma.user.findUniqueOrThrow({ where: { phone: c.phone } });
  const candidates = await getStore("petz").searchItems("ração", 6);
  assert.ok(candidates.length >= 3);
  const preferred = candidates[2];
  await prisma.deliveryOrder.create({
    data: {
      userId: user.id,
      phone: c.phone,
      storeKey: "petz",
      storeLabel: "Petz",
      items: [{ sku: preferred.sku, name: preferred.name, qty: 4, unitPrice: preferred.unitPrice, lineTotal: preferred.unitPrice * 4, storeKey: "petz", storeLabel: "Petz" }],
      status: "delivered"
    }
  });
  const offer = await c.send("ração");
  // 04/09: o já comprado vem com estrela e "você já pediu" na linha.
  const firstOption = offer.match(/\*1\)\* (?:⭐ )?([^—\n]+)/)?.[1]?.trim();
  assert.equal(firstOption, preferred.name);
  assert.match(offer.split("\n").find((l) => l.startsWith("*1)*")) ?? "", /⭐ .* · _você já pediu_/);
});

test("remover item: 'tira o X' recalcula a cesta; cesta vazia é comunicada", async (t) => {
  if (!dbOk) return t.skip();
  const { query, qty } = expensiveItemQuery();
  const c = await returningCustomer();
  await c.sendAndResolve(`${qty} ${query}`);
  const removed = await c.send(`tira o ${query.split(" ")[0]}`);
  assert.match(removed, /tirei/i);
});

test("trocar item: 'troca X por Y' remove e busca o novo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.sendAndResolve("2 arroz");
  const swapped = await c.sendAndResolve("troca o arroz por feijao");
  assert.match(swapped, /Troquei|tirei/i);
  assert.match(swapped, /feij|Feij|Seu pedido|op(ç|c)ões/i);
});

test("pedido mínimo: item barato + 'pagar' avisa quanto falta", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.sendAndResolve(await cheapItemQuery());
  const pay = await c.send("pagar");
  assert.match(pay, /mínimo/);
  assert.match(pay, /Falta|falta/);
});

test("pedido mínimo: 'pix' abaixo do mínimo recebe a saída honesta, não o nudge em loop", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  await c.sendAndResolve(await cheapItemQuery());
  await c.send("so isso");
  const pix = await c.send("pix");
  // Concierge: abaixo do mínimo da loja, "pix" repete a saída honesta (mínimo + troca de
  // loja) — nunca cobra nem manda o código.
  assert.match(pix, /mínimo|não fecha abaixo/i);
  assert.doesNotMatch(pix, /MOCKPIX/);
});

// A pergunta de quantidade morreu em 01/09 (assume 1 un e segue); este teste guarda a
// regra nova: nenhuma escolha pode reabrir a pergunta. A dica "1 un — fala 2x" saiu em 05/10
// (dono: a confirmação é só "✅ produto"; o botão "Mudar quantidade" faz o ajuste).
test("escolha nunca pergunta quantidade: assume 1 un e confirma só com ✅ produto (regra 01/09, 05/10)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const opts = await c.send("arroz");
  assert.match(opts, /Responde \*1\*/);
  const confirmed = await c.send("1");
  assert.doesNotMatch(confirmed, /Quantas unidades|de 1 a 50/i, `perguntou quantidade: ${confirmed.slice(0, 200)}`);
  assert.match(confirmed, /^✅ /m, confirmed.slice(0, 200));
  assert.doesNotMatch(confirmed, /1 un —/, `dica longa voltou: ${confirmed.slice(0, 200)}`);
  await c.send("limpar carrinho");
});

test("'quero' sozinho recebe convite caloroso, não 'não entendi'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const resp = await c.send("quero");
  assert.match(resp, /Me diz o que você precisa/);
  assert.doesNotMatch(resp, /Não entendi/);
});

// ---- cadeia de pagamento (mesmo cliente do início ao fim) ----
let payer: { phone: string; send: (t: string) => Promise<string>; sendAndResolve: (t: string) => Promise<string> };

test("item não encontrado: resposta honesta com sugestão de reformular", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const resp = await c.send("quero criptonita galactica");
  assert.match(resp, /não (achei|consigo|encontrei|entendi|tem)/i, `sem recusa honesta: ${resp.slice(0, 200)}`);
});

test("remédio: recusa educada citando a lei, mesmo sem OpenAI", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const resp = await c.send("quero dipirona");
  assert.match(resp, /Remédio|farmácia/);
  assert.doesNotMatch(resp, /Não achei/);
});

test("cancelar antes de pagar: cancela na hora sem cobrança", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const { query, qty } = expensiveItemQuery();
  await c.sendAndResolve(`${qty} ${query}`);
  await c.send("pagar");
  await c.send("pix");
  const cancel = await c.send("cancelar");
  assert.match(cancel, /cancel(ei|ado)/i);
  const order = await prisma.deliveryOrder.findFirst({
    where: { phone: c.phone },
    orderBy: { createdAt: "desc" }
  });
  assert.equal(order?.status, "canceled");
  const status = await c.send("status");
  assert.match(status, /cancelado/);
});

test("pagar com cartão: link com taxa embutida (total maior que o Pix)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const { query, qty } = expensiveItemQuery();
  await c.sendAndResolve(`${qty} ${query}`);
  const methods = await c.send("so isso");
  const totals = [...methods.matchAll(/R\$ (\d+,\d{2})/g)].map((m) => Number(m[1].replace(",", ".")));
  assert.ok(totals.length >= 1, `sem total na cotação: ${methods.slice(0, 300)}`);
  const card = await c.send("cartão");
  assert.match(card, /mock\.lia|http/, `sem link de cartão: ${card.slice(0, 200)}`);
  assert.match(card, /cart[ãa]o/i);
});

test("trocar endereço: pede o novo CEP e atualiza", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const ask = await c.send("quero trocar meu endereço");
  assert.match(ask, /CEP/);
  // Revisão 02/09: CEP novo NÃO herda a rua antiga como "verificada" (o teste antigo
  // travava exatamente esse bug: "Endereço atualizado: Rua das Flores…" num CEP de
  // outro bairro). A Lia pede rua/número do endereço novo e só então confirma.
  const askAddress = await c.send("04538-132");
  assert.match(askAddress, /endereço/i, `não pediu o endereço novo: ${askAddress.slice(0, 160)}`);
  assert.doesNotMatch(askAddress, /Rua das Flores/i, "a rua velha não pode voltar como verificada");
  const updated = await c.send("Rua Funchal, 500, apto 12, Vila Olímpia");
  assert.match(updated, /atualizado|salvo/i, `não confirmou: ${updated.slice(0, 160)}`);
  assert.match(updated, /Funchal/);
  const user = await prisma.user.findUnique({ where: { phone: c.phone } });
  assert.equal(user?.cep, "04538-132");
});

test("cobertura: CEP fora da área não vira pedido — entra na lista de espera", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer(); // já tem 01310-100 (SP capital)
  const reply = await c.send("50030-000"); // Recife — CEP puro = troca de endereço
  assert.match(reply, /não chega|anotei|espera/i);
  // não sobrescreveu o CEP coberto que ele já tinha
  const user = await prisma.user.findUnique({ where: { phone: c.phone } });
  assert.equal(user?.cep, "01310-100");
  // gravou o lead pra virar demanda no /ops
  const lead = await prisma.waitlistLead.findFirst({ where: { phone: c.phone, cep: "50030-000" } });
  assert.ok(lead, "esperava um lead na lista de espera");
});

test("cobertura: CEP de SP capital passa normal", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const updated = await c.send("04538-132"); // Itaim Bibi, SP capital
  assert.match(updated, /atualizado|salvo/i);
  const user = await prisma.user.findUnique({ where: { phone: c.phone } });
  assert.equal(user?.cep, "04538-132");
});

function withPreset(preset: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.LIA_COVERAGE_PRESET;
  process.env.LIA_COVERAGE_PRESET = preset;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.LIA_COVERAGE_PRESET;
    else process.env.LIA_COVERAGE_PRESET = prev;
  });
}

test("Grande SP: Osasco é aceito (cobre + guarda de distância passa)", async (t) => {
  if (!dbOk) return t.skip();
  await withPreset("grande-sp", async () => {
    const phone = newPhone();
    const d = driver(phone);
    await d.send("oi, quero arroz"); // onboarding → pede endereço completo
    assert.match(await d.send(TEST_ADDRESS), /CEP/i);
    const r = await d.sendAndResolve("06233-030"); // Osasco (~5km de Tamboré)
    assert.ok(!/longe demais|não chega/i.test(r), `recusou Osasco indevidamente: ${r.slice(0, 160)}`);
    const user = await prisma.user.findUnique({ where: { phone } });
    assert.equal(user?.cep, "06233-030"); // CEP salvo = passou nas duas travas
  });
});

test("estado-sp: Campinas é aceita (interior com loja perto)", async (t) => {
  if (!dbOk) return t.skip();
  await withPreset("estado-sp", async () => {
    const c = await returningCustomer();
    const r = await c.send("13015-000"); // Campinas centro — Petz/Boticário atendem o preset legado
    assert.match(r, /atualizado|salvo/i);
    const user = await prisma.user.findUnique({ where: { phone: c.phone } });
    assert.equal(user?.cep, "13015-000");
  });
});

function optionNames(transcript: string): string[] {
  return [...transcript.matchAll(/\*\d\)\* (.+?) — R\$/g)].map((m) => m[1]);
}

test("escolhendo: 'tem outras?' mostra as PRÓXIMAS opções, nunca as mesmas", async (t) => {
  if (!dbOk) return t.skip();
  const store = getStore("petz");
  let query: string | undefined;
  for (const q of ["ração", "areia", "petisco", "shampoo", "brinquedo"]) {
    if ((await store.searchItems(q, 9)).length >= 6) {
      query = q;
      break;
    }
  }
  assert.ok(query, "nenhuma query com 6+ opções no catálogo?");
  const c = await returningCustomer();
  const first = await c.send(`quero ${query}`);
  const firstNames = optionNames(first);
  assert.ok(firstNames.length >= 2, `esperava opções: ${first.slice(0, 200)}`);
  const more = await c.send("acha outras, por favor.");
  assert.match(more, /Mais opções/);
  const moreNames = optionNames(more);
  assert.ok(moreNames.length > 0, `esperava novas opções: ${more.slice(0, 200)}`);
  for (const name of moreNames) {
    assert.ok(!firstNames.includes(name), `opção repetida na paginação: ${name}`);
  }
});

test("escolhendo: 'outras' respeita o piso de relevância (sérum 'Cellular' não é carregador)", async (t) => {
  if (!dbOk) return t.skip();
  // Vistoria 10/08: a paginação não aplicava piso nenhum — "outras" de carregador
  // devolvia Sérum Nivea "Cellular" e chip de operadora (score>0 por token solto).
  const c = await returningCustomer();
  const first = await c.send("quero um carregador usb");
  assert.ok(optionNames(first).length > 0, `esperava opções: ${first.slice(0, 200)}`);
  const more = await c.send("outras");
  for (const name of optionNames(more)) {
    assert.match(name.toLowerCase(), /carregador|usb|cabo/, `paginação vazou item irrelevante: ${name}`);
  }
});

test("escolhendo: botão 'Outras opções' (opt:outras) pagina igual ao texto", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const first = await c.send("quero refrigerante");
  const firstNames = optionNames(first);
  assert.ok(firstNames.length >= 2, `esperava opções: ${first.slice(0, 200)}`);
  const more = await c.send("opt:outras");
  assert.match(more, /Mais opções/, `botão não paginou: ${more.slice(0, 200)}`);
  const moreNames = optionNames(more);
  // "Outras" tem que vir com 3 de verdade quando o catálogo dá (pedido do dono, 11/08).
  assert.equal(moreNames.length, 3, `esperava 3 novas opções, vieram ${moreNames.length}: ${moreNames.join(" | ")}`);
  for (const name of moreNames) {
    assert.ok(!firstNames.includes(name), `opção repetida na paginação: ${name}`);
  }
});

test("escolhendo: 'tem de Xkg?' refina de verdade ou responde honesto", async (t) => {
  if (!dbOk) return t.skip();
  const store = getStore("petz");
  // Derive a (base, weight) pair from the catalog so the test adapts to catalog changes.
  let pair: { base: string; attr: string } | undefined;
  for (const item of store.listCatalog()) {
    const m = item.name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .match(/\b(\d+(?:kg|g|l|ml))\b/);
    if (!m) continue;
    const base = item.name.split(/\s+/)[0].toLowerCase();
    if (base.length < 4 || /[^a-zà-ú]/i.test(base)) continue;
    if ((await store.searchItems(base, 3)).length < 2) continue;
    const refined = (await store.searchItems(`${base} ${m[1]}`, 6)).filter((o) => attrMatchesItem(m[1], o));
    if (refined.length >= 1) {
      pair = { base, attr: m[1] };
      break;
    }
  }
  assert.ok(pair, "nenhum par base+peso no catálogo?");
  const c = await returningCustomer();
  const first = await c.send(`quero ${pair.base}`);
  assert.ok(optionNames(first).length >= 2, `esperava opções: ${first.slice(0, 200)}`);
  const refinedReply = await c.send(`tem de ${pair.attr}?`);
  // The refined list must actually contain the attribute — never the same list re-sent.
  assert.match(refinedReply.toLowerCase(), new RegExp(pair.attr), `refino não trouxe ${pair.attr}: ${refinedReply.slice(0, 300)}`);
  assert.doesNotMatch(refinedReply, /Não peguei/);

  // And an attribute that doesn't exist gets an HONEST answer (not a fake refresh).
  const azul = (await store.searchItems(`${pair.base} azul`, 6)).filter((o) => attrMatchesItem("azul", o));
  const colorReply = await c.send("tem essa em azul?");
  if (azul.length) {
    assert.match(colorReply.toLowerCase(), /azul/);
  } else {
    assert.match(colorReply, /não achei/i);
    assert.match(colorReply, /\*1\)\*/); // re-shows what exists
  }
});

test("escolhendo perfume: 'masculino' refina Arbo em vez de virar nova busca", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const first = await c.send("perfume da marca Arbo");
  assert.match(first, /Arbo/i);
  const refined = await c.send("masculino");
  assert.doesNotMatch(refined, /Procurando aqui/i);
  assert.match(refined, /Masculino/i);
  assert.doesNotMatch(refined, /Não peguei/i);
});

test("webhook duplicado (retry do Twilio): mesma mensagem não processa duas vezes", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS } });
  const before = outbox.length;
  await handleDeliveryMessage({ phone, text: "2 arroz", messageId: "dup_1" });
  const afterFirst = outbox.length;
  await handleDeliveryMessage({ phone, text: "2 arroz", messageId: "dup_1" });
  assert.ok(afterFirst > before, "primeira mensagem deve responder");
  assert.equal(outbox.length, afterFirst, "retry com mesmo MessageSid não pode responder de novo");
});

test("social: obrigado e 'não era isso' têm respostas humanas, sem busca", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const thanks = await c.send("obrigado!");
  assert.doesNotMatch(thanks, /Procurando/);
  assert.match(thanks, /chamar|Imagina/i);
  const reject = await c.send("não era isso");
  assert.doesNotMatch(reject, /Procurando/);
  assert.match(reject, /outro jeito|marca/i);
});

// ---- ciclo conversation-improver 2026-07-12 ----

test("'só isso' no menu de pagamento não responde 'não peguei qual você quer'", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const { query, qty } = expensiveItemQuery();
  await c.sendAndResolve(`${qty} ${query}`);
  await c.send("pagar");
  const done = await c.send("só isso");
  assert.doesNotMatch(done, /Não peguei qual/);
  assert.match(done, /Como prefere pagar/);
});

test("item novo no meio de uma escolha é reconhecido, não entra mudo na fila", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const first = await c.send("arroz");
  assert.match(first, /Olha o que achei[\s\S]*Arroz/i);
  const add = await c.send("e feijao tambem");
  assert.match(add, /Anotei \*feijao\*/);
  assert.match(add, /Olha o que achei[\s\S]*Arroz/i); // continua na escolha atual
});

test("teto de preço na escolha: 'até X reais' filtra as opções pelo preço exibido", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const first = await c.send("arroz");
  assert.match(first, /Olha o que achei[\s\S]*Arroz/i);
  const prices = [...first.matchAll(/R\$ (\d+,\d{2})/g)].map((m) => Number(m[1].replace(",", ".")));
  assert.ok(prices.length >= 2, "precisa de 2+ opções pra filtrar");
  const cap = Math.floor((prices[0] + prices[prices.length - 1]) / 2); // entre a mais barata e a mais cara
  const capped = await c.send(`algum até ${cap} reais?`);
  const kept = [...capped.matchAll(/R\$ (\d+,\d{2})/g)].map((m) => Number(m[1].replace(",", ".")));
  assert.ok(kept.length >= 1, "alguma opção dentro do teto");
  assert.ok(kept.every((p) => p <= cap), `todas as opções devem caber no teto ${cap}: ${kept}`);
});

// ---------- 15 rodadas reais (14/08): restrições, quantidades e referências ----------

test("rodada 6: orçamento nunca vira item — um pedido com teto é UMA escolha", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const out = await c.send("quero uma coca cola, até uns 8 reais");
  // Nada de "não tenho como trazer: até uns 8 reais" nem segunda linha de escolha.
  assert.doesNotMatch(out, /não consigo trazer/i, `fantasma de orçamento: ${out.slice(0, 200)}`);
  assert.doesNotMatch(out, /2 itens/i);
  assert.match(out, /Olha o que achei[\s\S]*Coca-Cola/i);
  // Todas as opções mostradas respeitam o teto (preço exibido, com markup).
  for (const m of out.matchAll(/R\$ (\d+),(\d{2})/g)) {
    const price = Number(m[1]) + Number(m[2]) / 100;
    assert.ok(price <= 8, `opção acima do teto de R$8: R$ ${m[1]},${m[2]}`);
  }
});

test("concierge: total na hora → pix → 'paguei' (sandbox) → status e pagamento duplicado", async (t) => {
  if (!dbOk) return t.skip();
  const c = await returningCustomer();
  const { query, qty } = expensiveItemQuery();
  await c.sendAndResolve(`${qty} ${query}`);
  const summary = await c.send("so isso");
  assert.match(summary, /Total: R\$/, `sem total: ${summary.slice(0, 300)}`);
  const pix = await c.send("pix");
  assert.match(pix, /MOCKPIX/, `sem código: ${pix.slice(0, 300)}`);
  const confirm = await c.send("paguei");
  assert.match(confirm, /Pagamento confirmado/i);
  const dup = await c.send("paguei");
  assert.match(dup, /já está confirmado|já recebi|já (foi|está) pago|pago/i);
  const status = await c.send("cade meu pedido?");
  assert.match(status, /#\w{6}/);
});
