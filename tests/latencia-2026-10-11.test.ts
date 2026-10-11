// Latência da busca (11/10, g63): rerank da IA em paralelo com a conferência ao vivo (aprovado pelo dono), busca
// especulativa enquanto a IA pensa, consultas iguais em voo juntas e a geocodificação do CEP antecipada.
// Medição antes/depois: /mnt/project-files/testes-whatsapp/latencia-2026-10-11.md.
import "./helpers/load-env";
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { shapeApproved, __setRerankForTests, type RerankResult } from "../src/lib/adapters/ai";
import { diversifyOptions } from "../src/lib/stores/types";
import { liveSearchItems, __clearLiveSearchCacheForTests, type LiveFetch } from "../src/lib/stores/live-search";

// ---------- unidade ----------

test("shapeApproved: sem 'mais barato' é a diversificação de sempre; com ele, os mais baratos (2+ aprovados)", () => {
  const items = [
    { sku: "a", name: "Arroz Camil 1kg", brand: "Camil", price: 7 },
    { sku: "b", name: "Arroz Camil 1kg Integral", brand: "Camil", price: 9 },
    { sku: "c", name: "Arroz Prato Fino 1kg", brand: "Prato Fino", price: 5 },
    { sku: "d", name: "Arroz Tio João 1kg", brand: "Tio João", price: 6 }
  ];
  assert.deepEqual(shapeApproved("arroz", items, false, 3).items.map((i) => i.sku), diversifyOptions("arroz", items, 3).map((i) => i.sku));
  const cheap = shapeApproved("arroz", items, true, 3);
  assert.equal(cheap.cheapest, true);
  assert.deepEqual(cheap.items.map((i) => i.sku), ["c", "d", "a"]);
  // Com 1 aprovado não há o que ordenar: não é vitrine "do mais barato".
  assert.equal(shapeApproved("arroz", items.slice(0, 1), true, 3).cheapest, false);
});

test("busca ao vivo: a mesma consulta em voo sai UMA vez e as duas chamadas recebem o mesmo resultado", async () => {
  __clearLiveSearchCacheForTests();
  let calls = 0;
  const fetcher: LiveFetch = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return {
      ok: true,
      json: async () => ({
        products: [
          {
            productName: "Ração Golden Adulto 1kg",
            brand: "Golden",
            linkText: "racao-golden-adulto-1kg",
            categories: ["/Cachorro/Ração/"],
            items: [{ itemId: "123", nameComplete: "Ração Golden Adulto 1kg", sellers: [{ sellerId: "1", commertialOffer: { Price: 25.9, AvailableQuantity: 10 } }] }]
          }
        ]
      })
    };
  };
  const [a, b] = await Promise.all([liveSearchItems("cobasi", "ração golden g63", 12, fetcher), liveSearchItems("cobasi", "ração golden g63", 12, fetcher)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a[0]?.sku, "cobasi-123");
  // Terminada, a próxima chamada vem do cache (sem rede).
  await liveSearchItems("cobasi", "ração golden g63", 12, fetcher);
  assert.equal(calls, 1);
  __clearLiveSearchCacheForTests();
});

// ---------- conversa pelo caminho real ----------

const PREFIX = `+5546${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const RUN = `${Date.now().toString(36)}${process.pid}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  service: typeof import("../src/lib/delivery-service");
  live: typeof import("../src/lib/live-availability");
  freight: typeof import("../src/lib/live-freight");
  stores: typeof import("../src/lib/stores");
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
  m = { prisma, service: await import("../src/lib/delivery-service"), live: await import("../src/lib/live-availability"), freight: await import("../src/lib/live-freight"), stores: await import("../src/lib/stores") };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string) => (key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null);
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
afterEach(() => {
  __setRerankForTests(null);
  m.live.__setLiveSimulateForTests(null);
  m.live.__clearLiveCheckCacheForTests();
  m.freight.__setPreflightForTests(null);
});
after(async () => {
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});
async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge" }) }
  });
  return phone;
}
async function shown(phone: string): Promise<{ query: string; options: { sku: string }[] }[]> {
  const convo = await m.prisma.conversation.findFirst({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  const ctx = JSON.parse(String(convo?.context ?? "{}")) as { pending?: { query: string; options: { sku: string }[] }[] };
  return ctx.pending ?? [];
}

test("rerank em paralelo: a IA julga os candidatos da BUSCA enquanto a loja confere; o derrubado sai e o próximo da IA entra, sem 2ª chamada", async (t) => {
  if (!dbOk) return t.skip();
  m.freight.__setPreflightForTests(async () => null);
  const pool = await m.stores.gatherCrossStoreCandidates("arroz", 12, 4);
  if (pool.length < 4) return t.skip("catálogo de teste sem arroz suficiente");
  let simDone = 0;
  let rerankCalls = 0;
  let rerankStartedBeforeSim = false;
  let iaOrder: string[] = [];
  // A conferência demora e derruba o 1º que a IA aprovar.
  m.live.__setLiveSimulateForTests(async (_store, skus) => {
    await new Promise((r) => setTimeout(r, 120));
    simDone += 1;
    return new Map(skus.map((sku) => [sku, sku === iaOrder[0] ? { sku, available: false } : { sku, available: true, estimate: "1bd", etaMinutes: 1440, fee: 9.9 }]));
  }, () => true);
  __setRerankForTests(async (_message, lines): Promise<RerankResult> => {
    rerankCalls += 1;
    if (simDone === 0) rerankStartedBeforeSim = true;
    // A IA aprova todos, na ordem inversa da busca (uma ordem que só ela daria).
    iaOrder = [...lines[0].candidates].reverse().map((c) => c.sku);
    return { lines: lines.map((l) => ({ skus: [...l.candidates].reverse().map((c) => c.sku), exigencias: [], proximos: [] })) };
  });
  const phone = await customer();
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text: "arroz", messageId: `g63_${RUN}_${++seq}` }));
  assert.equal(rerankCalls, 1, "a queda do 1º não refaz o rerank");
  assert.equal(rerankStartedBeforeSim, true, "a IA começou antes de a conferência terminar");
  const [arroz] = await shown(phone);
  assert.ok(arroz?.options.length, "vitrine do arroz");
  const skus = arroz.options.map((o) => o.sku);
  assert.ok(!skus.includes(iaOrder[0]), "o derrubado pela loja não aparece");
  // Os cards são aprovados pela IA (o 1º derrubado fica de fora e os seguintes ocupam as vagas). A ordem final ainda passa
  // pelas regras de sempre (versão básica, prazo), como antes.
  assert.ok(skus.every((sku) => iaOrder.slice(1).includes(sku)), `só aprovados da IA: ${skus.join(",")} × ${iaOrder.join(",")}`);
});

test("rerank em paralelo: conferência que derruba TODOS os aprovados e traz reserva que a IA não viu julga só a reserva", async (t) => {
  if (!dbOk) return t.skip();
  m.freight.__setPreflightForTests(async () => null);
  const calls: string[][] = [];
  let firstSeen = new Set<string>();
  // A conferência espera a IA ter visto os candidatos (as duas correm juntas; aqui a ordem é fixada para o teste).
  let judged!: () => void;
  const ready = new Promise<void>((r) => (judged = r));
  m.live.__setLiveSimulateForTests(async (_store, skus) => {
    await Promise.race([ready, new Promise((r) => setTimeout(r, 2000))]);
    return new Map(skus.map((sku) => [sku, firstSeen.has(sku) ? { sku, available: false } : { sku, available: true, estimate: "1bd", etaMinutes: 1440, fee: 9.9 }]));
  }, () => true);
  __setRerankForTests(async (_message, lines): Promise<RerankResult> => {
    const skus = lines[0].candidates.map((c) => c.sku);
    calls.push(skus);
    if (calls.length === 1) {
      firstSeen = new Set(skus);
      judged();
    }
    return { lines: lines.map((l) => ({ skus: l.candidates.map((c) => c.sku).slice(0, 5), exigencias: [], proximos: [] })) };
  });
  const phone = await customer();
  await m.service.runTurnScoped(() => m.service.handleDeliveryMessage({ phone, text: "arroz", messageId: `g63_${RUN}_${++seq}` }));
  const [arroz] = await shown(phone);
  if (calls.length < 2) {
    // Sem reserva mais funda no catálogo de teste: nada sobra e não há 2ª chamada.
    assert.ok(!arroz?.options.length);
    return;
  }
  assert.ok(calls[1].every((sku) => !firstSeen.has(sku)), "a 2ª chamada só leva o que a IA não tinha visto");
  assert.ok(arroz?.options.length && arroz.options.every((o) => !firstSeen.has(o.sku)));
});

test("busca especulativa: só aquece a conferência — nunca chama a IA", async (t) => {
  if (!dbOk) return t.skip();
  m.freight.__setPreflightForTests(async () => null);
  let sims = 0;
  let reranks = 0;
  m.live.__setLiveSimulateForTests(async (_store, skus) => {
    sims += 1;
    return new Map(skus.map((sku) => [sku, { sku, available: true, estimate: "1bd", etaMinutes: 1440, fee: 9.9 }]));
  }, () => true);
  __setRerankForTests(async (_m, lines): Promise<RerankResult> => {
    reranks += 1;
    return { lines: lines.map(() => ({ skus: [], exigencias: [], proximos: [] })) };
  });
  await m.service.runTurnScoped(() => m.service.speculateChoicesNow("arroz", "01310-100"));
  assert.ok(sims > 0, "conferiu na loja");
  assert.equal(reranks, 0, "nenhuma chamada de IA na especulação");
});
