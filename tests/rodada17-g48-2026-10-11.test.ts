// Rodada 17, grupo G48 (11/10): prazo por hora, pergunta no meio da cesta, cadastro + pedido na 1ª mensagem e orçamento,
// de /mnt/project-files/testes-whatsapp/rodada17/grupo-b.md (R17-1, R17-3, R17-4, R17-10, R17-13).
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseBasketLines, parseNeededBy, parseNeededHour } from "../src/lib/lia-intents";
import { deadlineFit, deadlineVerdict, promiseHourFit, promiseMissesDeadline } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import { isRepeatableVerbatim } from "../src/lib/dialogue/repeat";

// 21h10 em SP do sábado 10/10 (a hora da rodada).
const NIGHT = new Date("2026-10-11T00:10:00Z");

test("R17-1: 'antes das 7h' é prazo com hora — a próxima 7h, com o rótulo da hora", () => {
  const d = parseNeededBy("meu bebe acordou sem fralda, preciso fralda G pacote grande, lenço umedecido e uma mamadeira 260ml. tem que chegar antes das 7h", NIGHT);
  assert.deepEqual(d, { date: "2026-10-11", label: "amanhã às 7h", hour: 7 });
  // Com o dia dito ("amanhã cedo preciso…"), a hora entra no dia.
  const lanche = parseNeededBy("Maria Souza 52998224725 Av Paulista 1000 01310-100. amanhã cedo preciso pra lancheira do meu filho: pão de forma, presunto, queijo mussarela fatiado, 6 sucos de caixinha e banana. antes das 7h", NIGHT);
  assert.deepEqual(lanche, { date: "2026-10-11", label: "amanhã às 7h", hour: 7 });
  // De manhã, "até as 10h" ainda é hoje.
  assert.deepEqual(parseNeededBy("pão e leite, até as 10h", new Date("2026-10-11T11:00:00Z")), { date: "2026-10-11", label: "hoje às 10h", hour: 10 });
  assert.equal(parseNeededHour("até as 6 da tarde"), 18);
  // "amanhã cedo" com necessidade é prazo de manhã, mesmo com o "preciso" depois do dia.
  assert.equal(parseNeededBy("amanhã cedo preciso de pão", NIGHT)?.morning, true);
  // Orçamento e horário de funcionamento não são prazo.
  assert.equal(parseNeededHour("arroz até 50 reais"), null);
  assert.equal(parseNeededHour("abre às 7h?"), null);
});

test("R17-1: a hora do prazo nunca vira item", () => {
  const phrases = (t: string) => parseBasketLines(t).map((l) => l.phrase);
  assert.deepEqual(phrases("pão de forma, presunto, queijo mussarela fatiado, 6 sucos de caixinha e banana. antes das 7h"), ["pão de forma", "presunto", "queijo mussarela fatiado", "sucos de caixinha", "banana"]);
  assert.deepEqual(phrases("pão, leite, tem que chegar até as 10h"), ["pão", "leite"]);
  assert.deepEqual(phrases("pão, leite, bem cedo"), ["pão", "leite"]);
  assert.deepEqual(phrases("arroz até 50 reais"), ["arroz até 50 reais"]);
});

test("R17-1: entrega × prazo com hora — janela, SLA curto e prazo em dias", () => {
  const d = { date: "2026-10-11", hour: 7 };
  // Janela inteira antes da hora, janela que atravessa a hora, janela depois.
  assert.equal(promiseHourFit("Mambo · amanhã, 5h–7h", d, NIGHT), "ok");
  assert.equal(promiseHourFit("Mambo · amanhã, 5h–8h", d, NIGHT), "unsure");
  assert.equal(promiseHourFit("prazo da loja: em até 14h (amanhã, 8h–11h)", d, NIGHT), "late");
  // 60 min às 21h10 chega hoje à noite: a tempo. "1 dia útil" chega amanhã sem hora — antes das 8h a loja não entrega.
  assert.equal(promiseHourFit("Drogaria São Paulo · 60 min", d, NIGHT), "ok");
  assert.equal(promiseHourFit("Casa Santa Luzia · 1 dia útil", d, NIGHT), "late");
  assert.equal(promiseHourFit("Casa Santa Luzia · 1 dia útil", { date: "2026-10-11", hour: 14 }, NIGHT), "unsure");
  // SLA que cairia de madrugada fica pra manhã.
  assert.equal(promiseHourFit("prazo da loja: 6h", d, NIGHT), "late");
  // A API booleana: só "late" é "não chega"; janela incerta é `null`.
  assert.equal(promiseMissesDeadline("Casa Santa Luzia · 1 dia útil", d, NIGHT), true);
  assert.equal(promiseMissesDeadline("Mambo · amanhã, 5h–8h", d, NIGHT), null);
  assert.equal(promiseMissesDeadline("Drogaria São Paulo · 60 min", d, NIGHT), false);
  // Sem hora, o comportamento de antes (só o dia).
  assert.equal(promiseMissesDeadline("Casa Santa Luzia · 1 dia útil", "2026-10-11", NIGHT), false);
  // O resumo: "4 dias úteis" não chega; "1 dia útil" pra "amanhã às 7h" também não; janela é incerta.
  const label = { ...d, label: "amanhã às 7h" };
  assert.equal(deadlineFit("prazo da loja: 4 dias úteis", label, NIGHT), "late");
  assert.equal(deadlineFit("prazo da loja: 1 dia útil", label, NIGHT), "late");
  assert.equal(deadlineFit("prazo da loja: em até 11h (amanhã, 5h–8h)", label, NIGHT), "unsure");
});

test("R17-1: a vitrine separa quem chega, quem pode chegar e quem atrasa; a copy diz a hora", () => {
  const options = [
    { delivery: "Casa Santa Luzia · 4 dias úteis", storeLabel: "Casa Santa Luzia" },
    { delivery: "Mambo · amanhã, 5h–8h", storeLabel: "Mambo" },
    { delivery: "Farmácia Indiana · 4 dias úteis", storeLabel: "Farmácia Indiana" }
  ];
  const v = deadlineVerdict(options, { date: "2026-10-11", hour: 7 }, NIGHT);
  assert.equal(v?.onTime.length, 0);
  assert.equal(v?.late.length, 2);
  assert.deepEqual(v?.unsure?.map((o) => o.storeLabel), ["Mambo"]);
  const note = copy.choicesDeadlineNote("amanhã às 7h", [], { store: "Casa Santa Luzia", promise: "4 dias úteis" }, "pão de forma", ["Mambo"]);
  assert.match(note, /só \*Mambo\* pode chegar a tempo/);
  assert.doesNotMatch(note, /nenhuma opção/);
  // Resumo e pergunta com prazo com hora: o "sem garantia" fala do dia e da hora, nunca "amanhã às 7h, mas sem hora marcada".
  const unsure = copy.deadlineFitNote({ label: "amanhã às 7h" }, "unsure");
  assert.match(unsure, /Chega \*amanhã\*, mas pode não chegar até as 7h/);
  assert.match(copy.deadlineFitNote({ label: "amanhã", morning: true }, "unsure"), /pode não ser de manhã/);
  // Oferta de juntar com janela incerta: "pode chegar", não "chega".
  const join = copy.consolidationDeadlineNote("amanhã às 7h", false, true, "prazo da loja: em até 11h (amanhã, 5h–8h)", "prazo da loja: 2 dias úteis", true);
  assert.match(join ?? "", /juntando pode chegar a tempo/);
  // O aviso de prazo por item é o mesmo modelo para cada item: a guarda anti-repetição não pode reescrever.
  assert.equal(isRepeatableVerbatim("⏰ Você precisa pra *amanhã às 7h*: de *presunto*, só *Mambo* pode chegar a tempo (a janela de entrega começa antes) — as outras opções demoram mais."), true);
});

// ---------------- conversa pelo caminho real ----------------

const PREFIX = `+5548${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const RUN = `${Date.now().toString(36)}${process.pid}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  live: typeof import("../src/lib/live-availability");
  stores: typeof import("../src/lib/stores");
  freight: typeof import("../src/lib/live-freight");
};
let m: Mods;
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
  m = { prisma, service: await import("../src/lib/delivery-service"), live: await import("../src/lib/live-availability"), stores: await import("../src/lib/stores"), freight: await import("../src/lib/live-freight") };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string, ...rest: unknown[]) => {
      outbox.push({ to, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
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
  m.live.__setLiveSimulateForTests(null);
  m.freight.__setPreflightForTests(null);
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text, messageId: `g48_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function customer(ctxExtra: Record<string, unknown> = {}, step = "collecting"): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva", cpf: "52998224725", cpfName: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return phone;
}

// Na produção foi o açúcar 2kg (as de 2 kg caíam na conferência da loja); no catálogo de teste, o arroz tem 2, 1 e 5 kg.
test("R17-3: 'arroz 2kg' com o de 2 kg indisponível no CEP oferece o tamanho vizinho (o mais perto), nunca 'não achei'", async (t) => {
  if (!dbOk) return t.skip();
  m.freight.__setPreflightForTests(async () => null);
  const pool = await m.stores.gatherCrossStoreCandidates("arroz 2kg", 12, 4);
  const twoKg = new Set(pool.filter((c) => /\b2\s?kg\b/i.test(c.item.name)).map((c) => c.item.sku));
  if (!twoKg.size || !pool.some((c) => /\b1\s?kg\b/i.test(c.item.name))) return t.skip("catálogo sem arroz de 1 e 2 kg");
  m.live.__setLiveSimulateForTests(
    async (_store, skus) => new Map(skus.map((sku) => [sku, twoKg.has(sku) ? { sku, available: false } : { sku, available: true, estimate: "1bd", etaMinutes: 1440, fee: 9.9 }])),
    () => true
  );
  try {
    const phone = await customer();
    const out = await send(phone, "arroz 2kg");
    assert.doesNotMatch(out, /n[aã]o achei em nenhuma|não consigo comprar/i, out.slice(0, 900));
    assert.match(out, /mais perto que tenho é de (?:1|5) kg/i, out.slice(0, 900));
    assert.doesNotMatch(out, /2\s?kg"/i, "nenhum card de 2 kg (indisponível)");
  } finally {
    m.live.__setLiveSimulateForTests(null);
    m.live.__clearLiveCheckCacheForTests();
  }
});

test("R17-3: 'tem X e Y?' no meio da escolha responde 'Tem sim' antes de anotar", () => {
  assert.match(copy.queuedItemsNote(["açúcar", "sabão em pó"], true), /^Tem sim! Anotei \*açúcar\*, \*sabão em pó\*/);
  assert.match(copy.queuedItemsNote(["açúcar"]), /^Anotei \*açúcar\*/);
});

test("R16a-6/R17a-1: na escolha da entrega, 'mantém como está'/'não'/'pula'/'ok' reenviam a escolha — sem IA, sem 'pula esse item'", async (t) => {
  if (!dbOk) return t.skip();
  const { __setDialogueModelForTests } = await import("../src/lib/dialogue");
  const prevLlm = process.env.LIA_DIALOGUE_LLM;
  process.env.LIA_DIALOGUE_LLM = "true";
  let llmCalls = 0;
  __setDialogueModelForTests(async () => {
    llmCalls += 1;
    return { actions: [{ type: "reply", kind: "unclear", text: "Qual opção de frete você prefere: a barata ou a rápida?" }] } as never;
  });
  try {
    const freightChoice = { orderId: "x", itemsSubtotal: 150, serviceFee: 10, stores: 1, kind: "store" as const, quotedAt: Date.now(), barato: { fee: 12.19, estimate: "1bd" }, rapido: { fee: 25.1, estimate: "60m" } };
    const phone = await customer({ freightChoice }, "choosing_freight");
    for (const said of ["mantém como está", "não", "pula", "ok"]) {
      const out = await send(phone, said);
      assert.match(out, /Tem duas formas de entrega/, `${said}: ${out.slice(0, 300)}`);
      if (said !== "ok") assert.match(out, /Escolhe a entrega: responde \*1\* \(mais barata\) ou \*2\* \(mais rápida\)/, `${said}: ${out.slice(0, 300)}`);
      assert.doesNotMatch(out, /seguir sem esse item|Qual opção de frete/, `${said}: ${out.slice(0, 300)}`);
    }
    assert.match(await send(phone, "pula"), /A entrega não dá pra pular/);
    assert.equal(llmCalls, 0);
  } finally {
    __setDialogueModelForTests(null);
    if (prevLlm === undefined) delete process.env.LIA_DIALOGUE_LLM;
    else process.env.LIA_DIALOGUE_LLM = prevLlm;
  }
});

test("R17a-1: 'não' seco no resumo fica assim, mas pergunta o que mudar", () => {
  assert.match(copy.summaryKeptAsIs(21.94, false, true), /pedido fica assim ✅ Total: \*R\$ 21,94\*\.\nSe era pra mudar alguma coisa, me diz o quê/);
  assert.doesNotMatch(copy.summaryKeptAsIs(21.94), /mudar/);
});

test("R17-10: limite do pedido no 'Até agora' e na oferta de juntar; corte sugerido é o menor que resolve", async () => {
  const items = [{ qty: 12, name: "Leite Integral 1L", displayLineTotal: 108.24 }, { qty: 1, name: "Arroz 5kg", displayLineTotal: 265.71 }];
  const over = copy.partialTotal(items as never, 373.95, 0, [], [], 300);
  assert.match(over, /Só nos produtos já passou do seu limite de \*R\$ 300,00\* \(R\$ 73,95 a mais\)/, over);
  assert.match(copy.partialTotal(items.slice(0, 1) as never, 108.24, 1, [], [], 300), /Do seu limite de \*R\$ 300,00\*, sobram R\$ 191,76/);
  assert.doesNotMatch(copy.partialTotal(items as never, 373.95, 0), /limite/);
  assert.match(copy.consolidationBudgetNote(300, 371.76, 380.85) ?? "", /Dos dois jeitos passa do seu limite de \*R\$ 300,00\*/);
  assert.match(copy.consolidationBudgetNote(300, 290, 310) ?? "", /Juntando fica dentro do seu limite/);
  assert.equal(copy.consolidationBudgetNote(300, 290, 295), null);
  assert.match(copy.consolidationOffer({ storeLabel: "Santa Luzia", joinedTotal: 371.76, keptTotal: 380.85, keptStores: 2, pairs: [], budgetNote: copy.consolidationBudgetNote(300, 371.76, 380.85) }), /passa do seu limite/);
  // R$ 317,64 com limite de 300 (R$ 17,64 a mais): baixar o leite de 6 para 4 resolve; tirar o molho de R$ 79,20 é demais.
  const { overBudgetSummaryInput } = await import("../src/lib/ops-lifecycle");
  const b = (sku: string, name: string, unitPrice: number, qty: number) => ({ sku, name, unitPrice, qty, lineTotal: unitPrice * qty, storeKey: "santaluzia", storeLabel: "Casa Santa Luzia" });
  const basket = [b("1", "Leite Integral Piracanjuba 1L", 8.2, 6), b("2", "Molho de Tomate Genovese 340g", 18, 4), b("3", "Arroz Camil 5kg", 30, 1), b("4", "Papel Higiênico 12 rolos", 20, 1)];
  const cut = overBudgetSummaryInput(300, basket as never, true, 317.64).priciest;
  assert.equal(cut?.reduceTo, 4, JSON.stringify(cut));
  assert.match(copy.overBudgetSummaryNote(300, 317.64, cut), /baixar \*Leite Integral Piracanjuba 1L\* de 6 para 4/);
  // Sem o total, como antes: a linha mais cara.
  assert.equal(overBudgetSummaryInput(300, basket as never, true).priciest?.name, "Molho de Tomate Genovese 340g");
});
