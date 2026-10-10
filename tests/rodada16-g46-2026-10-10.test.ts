// Rodada 16, grupo G46 (10/10): prazo, troca de loja e copy de /mnt/project-files/testes-whatsapp/rodada16 (R16-2, R16a-5,
// R16-6, R16-8). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage):
//   1. (R16-2, 356) "tenho 250 reais, preciso até sábado": "até sábado" virava item não achado; "6 dias úteis" num sábado dizia
//      "✅ Chega a tempo pra sábado"; os ovos sem produto sumiam do "Ficou de fora" porque o "Macarrão … com Ovos" os cobria;
//   2. (R16a-5) cards da Casa Santa Luzia (guardanapo, café Apuí) em 4 dias úteis com a Expressa de 1 dia por R$ 2,22/R$ 3,59
//      a mais; a troca de loja que piora o prazo de quem disse "sábado" não dizia o que acontece com o dia;
//   3. (R16-6, 354) "troca por outra loja" com o mínimo da Americanas perguntava da esponja; "troca o tapete por outro de outra
//      loja" trocava pelo mesmo tapete;
//   4. (R16-8) "Não achei exatamente 2l" com cards de 2 L; "zona leste/tatuapé" recebia a resposta dos estados; "opções de
//      novo" perdia o "branca fria".
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.LIA_ENABLE_AMERICANAS = "true";
process.env.LIA_ENABLE_MAMBO = "true";
process.env.LIA_ENABLE_SANTALUZIA = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  intents: typeof import("../src/lib/lia-intents");
  copy: typeof import("../src/lib/lia-copy");
  freight: typeof import("../src/lib/live-freight");
  misses: typeof import("../src/lib/list-misses");
  clearLive: typeof import("../src/lib/live-availability").__clearLiveCheckCacheForTests;
};
let m: Mods;

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5546${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const realFetch = globalThis.fetch;

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
  const live = await import("../src/lib/live-availability");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  m = {
    prisma,
    service: await import("../src/lib/delivery-service"),
    intents: await import("../src/lib/lia-intents"),
    copy: await import("../src/lib/lia-copy"),
    freight: await import("../src/lib/live-freight"),
    misses: await import("../src/lib/list-misses"),
    clearLive: live.__clearLiveCheckCacheForTests
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
beforeEach(() => m.freight.__setPreflightForTests(async () => null));
afterEach(() => {
  globalThis.fetch = realFetch;
  m.clearLive();
});
after(async () => {
  m.freight.__setPreflightForTests(null);
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g46_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function ctxOf(phone: string) {
  const convo = await m.prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}") as import("../src/lib/conversation-types").DeliveryContext;
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", cpf: "52998224725", cpfName: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", pendingSince: Date.now(), ...ctxExtra }) }
  });
  return phone;
}
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, extra: Record<string, unknown> = {}) =>
  ({ sku, name, qty: 1, unitPrice, lineTotal: unitPrice, storeKey, storeLabel, ...extra });
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, extra: Record<string, unknown> = {}) => ({ sku, name, unitPrice, storeKey, storeLabel, ...extra });

// ---------------- 1. R16-2 ----------------

const MSG_356 = "arroz 5kg, feijão carioca, 1 dúzia de ovos, 6 caixas de leite, café 500g, açúcar, óleo, macarrão, papel higiênico, 3 detergente, sabão em pó. tenho 250 reais, preciso até sábado";

test("R16-2 (356): 'preciso até sábado' depois do orçamento é prazo, nunca item", () => {
  const now = new Date("2026-10-10T15:00:00Z"); // sábado
  assert.deepEqual(m.intents.parseNeededBy(MSG_356, now), { date: "2026-10-17", label: "sábado" });
  const budget = m.intents.parseOrderBudget(MSG_356);
  assert.equal(budget?.cap, 250);
  const phrases = m.intents.parseBasketLines(budget!.rest).map((l) => l.phrase);
  assert.ok(!phrases.some((p) => /s[aá]bado/.test(p)), JSON.stringify(phrases));
  assert.equal(phrases.length, 11, JSON.stringify(phrases));
  for (const seg of ["até sábado", "preciso até sexta-feira", "só até amanhã", "até quarta que vem"]) assert.ok(m.intents.isNonItemSegment(seg), seg);
  // Item com "até" que não é dia segue item; teto segue teto.
  assert.ok(!m.intents.isNonItemSegment("fita até 5 metros"));
  assert.equal(m.intents.parseOrderBudget("ovos e leite, até 20 reais")?.cap, 20);
});

test("R16-2 (356): '6 dias úteis' num sábado não é '✅ Chega a tempo pra sábado' — conta só dia útil", () => {
  const now = new Date("2026-10-10T15:00:00Z"); // sábado; 12/10 é feriado
  const saturday = { date: "2026-10-17", label: "sábado" };
  assert.equal(m.freight.businessDaysArrival("2026-10-10", 6), "2026-10-20");
  assert.equal(m.freight.deadlineFit("prazo da loja: 6 dias úteis", saturday, now), "maybe");
  assert.equal(m.freight.deadlineFit("4 entregas · prazo da loja: 6 dias úteis", saturday, now), "maybe");
  assert.equal(m.freight.deadlineFit("prazo da loja: 4 dias úteis", saturday, now), "ok");
  assert.equal(m.freight.deadlineFit("prazo da loja: 8 dias úteis", saturday, now), "late");
  const summary = m.copy.manualQuoteSummary({ items: [{ qty: 1, name: "Arroz" }], produtos: 200, frete: 52, total: 252, deliveryPromise: "prazo da loja: 6 dias úteis", deadlineFit: { ...saturday, fit: "maybe" } });
  assert.doesNotMatch(summary, /Chega a tempo/, summary);
  assert.match(summary, /Pode não chegar até \*sábado\*/, summary);
  assert.match(m.copy.orderDeadlineAnswer(saturday, "maybe", "prazo da loja: 6 dias úteis"), /pode não chegar/);
});

test("R16-2 (356): item sem produto continua no 'Ficou de fora' mesmo com outro item que cita o nome dele", () => {
  const at = Date.now();
  const ctx = { listMisses: [{ query: "ovos", qty: 12, reason: "not_found" as const, at }] };
  assert.deepEqual(m.misses.leftOutForSummary(ctx, [{ name: "Macarrão Espaguete com Ovos Renata 500g", ask: "macarrão" }]), ["ovos"]);
  assert.deepEqual(m.misses.leftOutForSummary(ctx, [{ name: "Ovos Brancos Grandes 12 unidades", ask: "ovos" }]), []);
  const gelo = { listMisses: [{ query: "gelo", qty: 1, reason: "not_found" as const, at }] };
  assert.deepEqual(m.misses.leftOutForSummary(gelo, [{ name: "Gelo em Cubos 5kg", ask: "gelo em cubo" }]), []);
});

test("R16-2 (356): com o pedido na conversa, 'até sábado' não entra em 'não achei' e o prazo fica guardado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({});
  const out = await send(phone, MSG_356);
  assert.doesNotMatch(out, /s[aá]bado\*? — n[aã]o achei|n[aã]o achei[^\n]*s[aá]bado/i, out.slice(0, 900));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.neededBy?.label, "sábado");
  assert.ok(!(ctx.listMisses ?? []).some((miss) => /s[aá]bado/.test(miss.query)), JSON.stringify(ctx.listMisses));
});

// ---------------- 2. R16a-5 ----------------

test("R16a-5: card da Santa Luzia mostra a Expressa quando o extra é pouco pelos dias poupados", () => {
  const now = new Date("2026-10-13T15:00:00Z");
  const base = { available: true, estimate: "4bd", etaMinutes: 4 * 24 * 60, fastEstimate: "1bd", fastEtaMinutes: 24 * 60, fastFee: 16.04 };
  assert.equal(m.service.cardUsesFastDelivery({ ...base, sku: "santaluzia-110119", fee: 13.82 }, false, undefined, now), true, "guardanapo: +R$ 2,22");
  assert.equal(m.service.cardUsesFastDelivery({ ...base, sku: "santaluzia-152429", fee: 12.45 }, false, undefined, now), true, "café Apuí: +R$ 3,59");
  assert.equal(m.service.cardUsesFastDelivery({ ...base, sku: "x", fee: 11.88 }, false, undefined, now), false, "+R$ 4,16 por 3 dias segue na mais barata");
  assert.equal(m.service.cardUsesFastDelivery({ ...base, sku: "y", fee: 13.82, estimate: "2bd", etaMinutes: 2 * 24 * 60 }, false, undefined, now), false, "+R$ 2,22 por 1 dia: mais barata");
});

test("R16a-5: troca que piora o prazo de quem disse um dia diz o que acontece com o dia", () => {
  const sat = { label: "sábado" };
  assert.match(m.copy.swapEtaNote("4 dias úteis", "6 dias úteis", { ...sat, miss: false, maybe: true }) ?? "", /passa de \*4 dias úteis\* para \*6 dias úteis\* e pode não chegar até \*sábado\*/);
  assert.match(m.copy.swapEtaNote("1 dia útil", "2 dias úteis", { ...sat, miss: false, fits: true }) ?? "", /ainda chega até \*sábado\*/);
  assert.match(m.copy.swapEtaNote("1 dia útil", "8 dias úteis", { ...sat, miss: true }) ?? "", /não chega até \*sábado\*/);
});

// ---------------- 3. R16-6 ----------------

test("R16-6: pedido de troca de loja sem oferta na mesa é lido (com e sem item citado)", () => {
  assert.deepEqual(m.intents.parseStoreSwapAsk("troca por outra loja"), {});
  assert.deepEqual(m.intents.parseStoreSwapAsk("troca de loja"), {});
  assert.deepEqual(m.intents.parseStoreSwapAsk("tem em outra loja?"), {});
  assert.deepEqual(m.intents.parseStoreSwapAsk("não, o tapete. troca o tapete por outro de outra loja"), { item: "tapete" });
  assert.deepEqual(m.intents.parseStoreSwapAsk("troca o tapete de loja"), { item: "tapete" });
  assert.equal(m.intents.parseStoreSwapAsk("troca o arroz pelo feijão"), null);
  assert.equal(m.intents.parseStoreSwapAsk("troca o tapete por outro"), null);
});

const TAPETE = line("americanas-7962001", "Tapete Antiderrapante PVC Casual Home 100x30cm Sortido", 17.59, "americanas", "Americanas", { ask: "tapete antiderrapante" });
const ESPONJA = line("mambo-90001", "Esponja Multiuso Scotch-Brite 4 Unidades", 9.9, "mambo", "Mambo", { ask: "esponja", qty: 2, lineTotal: 19.8 });

test("R16-6 (354): 'troca por outra loja' com o mínimo da Americanas trata do tapete, nunca da esponja", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({ basket: [TAPETE, ESPONJA] });
  const out = await send(phone, "troca por outra loja");
  assert.doesNotMatch(out, /esponja/i, out.slice(0, 900));
  assert.match(out, /tapete/i, out.slice(0, 900));
  const ctx = await ctxOf(phone);
  // Oferta de troca do tapete (minSwap) ou "não achei em outra loja sem mínimo" — nunca outra loja com o mesmo tapete.
  if (ctx.minSwap) assert.ok(ctx.minSwap.replacements.every((r) => r.option.storeKey !== "americanas"), JSON.stringify(ctx.minSwap));
  else assert.match(out, /Procurei \*[^*]*tapete[^*]*\* em outra loja sem pedido mínimo/i, out.slice(0, 900));
});

test("R16-6 (354): 'troca o tapete por outro de outra loja' nunca oferece o tapete da mesma loja", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({ basket: [TAPETE, ESPONJA] });
  const out = await send(phone, "não, o tapete. troca o tapete por outro de outra loja");
  assert.doesNotMatch(out, /Troquei \*?Tapete Antiderrapante PVC Casual Home[^\n]*por \*?Tapete Antiderrapante PVC Casual Home/i, out.slice(0, 900));
  assert.doesNotMatch(out, /de outra loja\*/, out.slice(0, 900));
  const ctx = await ctxOf(phone);
  const offered = [...(ctx.pending?.[0]?.options ?? []), ...(ctx.basket ?? []).filter((b) => b.sku !== ESPONJA.sku && b.sku !== TAPETE.sku)];
  assert.ok(offered.every((o) => o.storeKey !== "americanas"), JSON.stringify(offered.map((o) => `${o.storeKey}:${o.name}`)));
  if (!offered.length) {
    assert.ok((ctx.basket ?? []).some((b) => b.sku === TAPETE.sku), "sem troca, o tapete fica");
    assert.match(out, /Procurei/, out.slice(0, 900));
  }
});

// ---------------- 4. R16-8 ----------------

test("R16-8 (354): 'vcs entregam na zona leste? moro no tatuape' responde a capital e pede o CEP", async (t) => {
  assert.equal(m.intents.spCapitalPlace("vcs entregam na zona leste? moro no tatuape"), "Tatuapé (zona leste)");
  assert.equal(m.intents.spCapitalPlace("entrega em pinheiros?"), "Pinheiros");
  assert.equal(m.intents.spCapitalPlace("arroz e feijão"), undefined);
  const answer = m.copy.serviceAnswer("area", "os estados de São Paulo e Rio de Janeiro", { place: "Tatuapé (zona leste)" });
  assert.match(answer, /cidade de São Paulo[^\n]*Tatuapé[^\n]*CEP/, answer);
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const out = await send(phone, "vcs entregam na zona leste? moro no tatuape");
  assert.match(out, /Tatuapé/, out.slice(0, 600));
  assert.match(out, /CEP/, out.slice(0, 600));
});

const LAMPADAS = [
  opt("telhanorte-2588242", "Lâmpada Led 9W Branca E27 Bivolt Ledvance", 4.17, "telhanorte", "Telhanorte"),
  opt("americanas-126896", "Lâmpada LED 9W Kian Branca Morna Bivolt E27", 4.39, "americanas", "Americanas"),
  opt("americanas-4062114", "Lâmpada LED Kian A60 9W Bivolt E27 6500K Branca Fria", 4.39, "americanas", "Americanas"),
  opt("telhanorte-2582708", "Lâmpada LED Bulbo A60 9W 6500K Bivolt Black Decker", 4.29, "telhanorte", "Telhanorte")
];

test("R16-8 (351): 'me mostra as opções de novo' depois de 'pode ser branca fria' mantém o branca fria", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith({ pending: [{ query: "lâmpada LED 9W", qty: 1, options: LAMPADAS, shownOptions: LAMPADAS, shownSkus: LAMPADAS.map((o) => o.sku) }] }, "choosing");
  await send(phone, "a lampada pode ser branca fria");
  const refined = (await ctxOf(phone)).pending?.[0];
  assert.ok(refined && refined.options.every((o) => /fria/i.test(o.name)), JSON.stringify(refined?.options.map((o) => o.name)));
  const out = await send(phone, "me mostra as opções de novo");
  const again = (await ctxOf(phone)).pending?.[0];
  assert.ok(again && again.options.every((o) => /fria/i.test(o.name)), `${JSON.stringify(again?.options.map((o) => o.name))}\n${out.slice(0, 500)}`);
});

test("R16-8 (351): 'chega hoje?' com a fita em escolha responde numa mensagem só, sem o 'escolhe essa aqui'", async (t) => {
  if (!dbOk) return t.skip();
  const lamp = line("telhanorte-2588242", "Lâmpada Led 9W Branca E27 Bivolt Ledvance", 4.17, "telhanorte", "Telhanorte", { ask: "lâmpada LED 9W", delivery: "prazo da loja: 2 dias úteis" });
  const fitas = [
    opt("mambo-282625", "Fita Isolante 3M 18mmx5m", 7.25, "mambo", "Mambo", { delivery: "prazo da loja: 1 dia útil", verified: true }),
    opt("telhanorte-2389525", "Fita Isolante Pvc Preta 5M Dni", 5.49, "telhanorte", "Telhanorte", { delivery: "prazo da loja: 2 dias úteis", verified: true })
  ];
  const phone = await customerWith({ basket: [lamp], pending: [{ query: "fita isolante preta", qty: 2, options: fitas, shownOptions: fitas, shownSkus: fitas.map((o) => o.sku) }] }, "choosing");
  const start = outbox.length;
  const out = await send(phone, "chega hoje?");
  const texts = outbox.slice(start).filter((o) => o.to === phone && o.kind === "sendMessage");
  assert.ok(texts.length <= 1, `${texts.length} mensagens:\n${out.slice(0, 900)}`);
  assert.doesNotMatch(out, /escolhe essa aqui que eu fecho/, out.slice(0, 900));
  assert.match(out, /hoje/i, out.slice(0, 900));
});

test("R16-6: 'troca o tapete por outro de outra loja' com os tapetes em escolha tira da vitrine a loja que trava o mínimo", async (t) => {
  if (!dbOk) return t.skip();
  const guardanapo = line("americanas-8835705", "Guardanapo de Papel Folha Simples Santher 24x22cm 50 Unidades", 2.74, "americanas", "Americanas", { ask: "guardanapo de papel" });
  const tapetes = [
    opt("americanas-8779155", "Tapete de Banheiro Remix Popcorn Sortido Camesa Antiderrapante", 17.59, "americanas", "Americanas"),
    opt("tokstok-434019", "Tapete para Box 69 cm x 39 cm Non-Slip", 52.69, "tokstok", "Tok&Stok"),
    opt("telhanorte-1355783", "Tapete para box com ventosas antiderrapantes Arthi", 54.89, "telhanorte", "Telhanorte")
  ];
  const phone = await customerWith({ basket: [guardanapo], pending: [{ query: "tapete antiderrapante para banheiro", qty: 1, options: tapetes, shownOptions: tapetes, shownSkus: tapetes.map((o) => o.sku) }] }, "choosing");
  const out = await send(phone, "troca o tapete por outro de outra loja");
  const left = (await ctxOf(phone)).pending?.[0]?.options ?? [];
  assert.ok(left.length > 0 && left.every((o) => o.storeKey !== "americanas"), `${JSON.stringify(left.map((o) => o.storeKey))}\n${out.slice(0, 500)}`);
});
