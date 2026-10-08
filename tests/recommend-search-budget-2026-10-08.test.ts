// Etapa BUSCAR da recomendação, 3 correções do placar de 08/10/2026 (sem banco, sem rede):
// 1. TRAVAMENTO — sob o agente de proxy do Node, a leitura do corpo de uma resposta abortada pode
//    ficar pendente para sempre; `withDeadline` + prazo duro em `fetchLiveProducts`, orçamento por
//    prateleira (`gatherShelfCandidates`) e por pick/busca inteira (`recommendForBench`).
// 2. PISO pelo substantivo-cabeça (`shelfHeadMatch`): "bolo pronto" aceita "Bolo de Chocolate Ana
//    Maria" e recusa uva e esmalte; os termos são os da prateleira REAL do mapa (copiados aqui).
// 3. CACHE da cópia em `searchStoreItems`: a 2ª busca igual não varre o catálogo de novo.
import "./helpers/load-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogItem } from "../src/lib/stores/types";
import type { NeedTableEntry, ShelfNode, ShelfPick } from "../src/lib/recommend/types";
import type { ChoiceOption } from "../src/lib/conversation-types";

let withDeadline: typeof import("../src/lib/stores/live-search").withDeadline;
let liveSearchItems: typeof import("../src/lib/stores/live-search").liveSearchItems;
let clearLiveCache: typeof import("../src/lib/stores/live-search").__clearLiveSearchCacheForTests;
let shelfHeadMatch: typeof import("../src/lib/stores/types").shelfHeadMatch;
let shelfHeadNoun: typeof import("../src/lib/stores/types").shelfHeadNoun;
let stores: typeof import("../src/lib/stores/index");
let handle: typeof import("../src/lib/recommend/handle");

const realFetch = global.fetch;

before(async () => {
  ({ withDeadline, liveSearchItems, __clearLiveSearchCacheForTests: clearLiveCache } = await import("../src/lib/stores/live-search"));
  ({ shelfHeadMatch, shelfHeadNoun } = await import("../src/lib/stores/types"));
  stores = await import("../src/lib/stores/index");
  handle = await import("../src/lib/recommend/handle");
});

after(() => {
  global.fetch = realFetch;
  process.env.LIA_LIVE_SEARCH = "false";
  delete process.env.LIA_LIVE_SEARCH_TIMEOUT_MS;
  delete process.env.LIA_RECOMMEND_SEARCH_BUDGET_MS;
  handle.__setRecommendTablesForTests(null);
});

// ---------------------------------------------------------------- 1. travamento

test("withDeadline: valor no prazo, fallback no estouro e na rejeição; nunca lança", async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 0), 7);
  let fired = 0;
  const t0 = Date.now();
  // Promessa que NUNCA resolve e sem nenhum handle vivo: o timer próprio do prazo segura o processo.
  assert.deepEqual(await withDeadline(new Promise<number[]>(() => {}), 150, [], () => fired++), []);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fired, 1);
  assert.equal(await withDeadline(Promise.reject(new Error("x")), 1000, -1), -1);
});

test("liveSearchItems: corpo que nunca chega vira lista vazia no prazo (e não entra no cache)", async () => {
  process.env.LIA_LIVE_SEARCH_TIMEOUT_MS = "500";
  clearLiveCache();
  let calls = 0;
  const hangingBody = async () => {
    calls++;
    return { ok: true, json: () => new Promise<unknown>(() => {}) };
  };
  const t0 = Date.now();
  assert.deepEqual(await liveSearchItems("mambo", "chocolate", 12, hangingBody), []);
  const ms = Date.now() - t0;
  assert.ok(ms >= 450 && ms < 2500, `prazo duro ~1 s, levou ${ms} ms`);
  // Falha não fica no cache: a próxima chamada tenta de novo.
  await liveSearchItems("mambo", "chocolate", 12, hangingBody);
  assert.equal(calls, 2);
  delete process.env.LIA_LIVE_SEARCH_TIMEOUT_MS;
});

test("gatherShelfCandidates: rede travada não segura a prateleira além do orçamento", async () => {
  process.env.LIA_LIVE_SEARCH = "true";
  process.env.LIA_LIVE_SEARCH_TIMEOUT_MS = "20000";
  clearLiveCache();
  stores.__clearSnapshotSearchCacheForTests();
  // Todo fetch fica pendente para sempre (o caso do placar).
  global.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  try {
    const shelf: ShelfNode = { id: "t.chocolate", label: "Chocolates", domain: "mercado", query: "chocolate", stores: ["mambo", "carrefour"] };
    const t0 = Date.now();
    const list = await stores.gatherShelfCandidates({ shelfId: "t.chocolate", query: "chocolate", why: "" }, shelf, { limit: 8, perStore: 3, cep: "01310100", budgetMs: 800 });
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `orçamento de 800 ms, levou ${ms} ms`);
    assert.ok(Array.isArray(list));
  } finally {
    global.fetch = realFetch;
    process.env.LIA_LIVE_SEARCH = "false";
    delete process.env.LIA_LIVE_SEARCH_TIMEOUT_MS;
  }
});

test("recommendForBench: prateleira que não responde conta como vazia e as outras viram cards no prazo", async () => {
  const { tableDepsFrom } = await import("../src/lib/recommend/fallback");
  const { RED_FLAGS } = await import("../src/lib/recommend/tables");
  const FOOD = ["carrefour", "oba"];
  const shelves: ShelfNode[] = [
    { id: "t.chocolate", label: "Chocolates", domain: "mercado", query: "chocolate", stores: FOOD, flags: ["ready_to_eat"] },
    { id: "t.sorvete", label: "Sorvetes", domain: "mercado", query: "sorvete", stores: FOOD, flags: ["cold"] },
    { id: "t.biscoito", label: "Biscoitos recheados", domain: "mercado", query: "biscoito recheado", stores: FOOD, flags: ["ready_to_eat"] }
  ];
  const needs: NeedTableEntry[] = [
    {
      keys: ["algo doce"],
      picks: [
        { shelfId: "t.chocolate", query: "chocolate", why: "o doce mais pedido" },
        { shelfId: "t.sorvete", query: "sorvete", why: "doce e gelado" },
        { shelfId: "t.biscoito", query: "biscoito recheado", why: "pacote pronto" }
      ]
    }
  ];
  handle.__setRecommendTablesForTests(tableDepsFrom({ generatedAt: "teste", shelves }, { NEED_TABLE: needs, SYMPTOM_TABLE: [], RED_FLAGS }));
  // Costuras do delivery-service: a conferência ao vivo do sorvete nunca responde.
  handle.setRecommendDeps({
    searchOptions: async () => [],
    sendChoices: async () => {},
    advancePending: async () => {},
    toChoiceOption: (item: CatalogItem, ref) => ({ sku: item.sku, name: item.name, brand: item.brand, unitPrice: item.unitPrice, storeKey: ref.storeKey, storeLabel: ref.storeLabel }),
    confirmOptionsLive: (pool: ChoiceOption[]) =>
      pool.some((o) => /sorvete/i.test(o.name)) ? new Promise<ChoiceOption[]>(() => {}) : Promise.resolve(pool.map((o) => ({ ...o, verified: true })))
  });
  process.env.LIA_RECOMMEND_SEARCH_BUDGET_MS = "1500";
  try {
    const t0 = Date.now();
    const out = await handle.recommendForBench({ form: "need", text: "quero algo doce", need: "algo doce", criteria: [], constraints: [], source: "regex" }, "01310100");
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `orçamento de 1,5 s, levou ${ms} ms`);
    assert.ok(out.emptyShelves.includes("t.sorvete"), `sorvete devia contar como vazia: ${out.emptyShelves}`);
    assert.ok(out.cards.length >= 1, "as prateleiras que responderam viram cards");
    assert.ok(out.cards.every((c) => c.shelfId !== "t.sorvete"));
  } finally {
    delete process.env.LIA_RECOMMEND_SEARCH_BUDGET_MS;
    handle.__setRecommendTablesForTests(null);
  }
});

// ---------------------------------------------------------------- 2. piso pelo substantivo-cabeça

const item = (name: string, brand?: string): CatalogItem => ({ sku: `t-${name}`, name, ...(brand ? { brand } : {}), unitPrice: 10, unit: "un" });
// Termos = consulta da pick + consulta e aliases da prateleira REAL do mapa (shelf-map.ts, 08/10).
const SHELF_TERMS: Record<string, { query: string; aliases: string[] }> = {
  "doces.bolo": { query: "bolo pronto", aliases: ["bolinho", "torta doce", "panetone", "rocambole", "brownie", "waffle"] },
  "lanches.sanduiche": { query: "sanduiche pronto", aliases: ["sanduiche natural", "lanche pronto", "pao recheado", "wrap"] },
  "beleza.perfume_feminino": { query: "perfume feminino", aliases: ["colonia feminina", "eau de parfum feminino", "body splash"] },
  "snacks.salgadinho": { query: "salgadinho", aliases: ["batata chips", "doritos", "ruffles", "cheetos", "batata palha", "fandangos", "pipoca de micro-ondas", "milho de pipoca"] },
  "congelados.pratos_prontos": { query: "lasanha congelada", aliases: ["prato pronto", "marmita congelada", "escondidinho", "refeicao congelada"] }
};
function floor(shelfId: string, pickQuery: string, it: CatalogItem): boolean {
  return handle.shelfFloorTerms({ query: pickQuery }, SHELF_TERMS[shelfId]).some((term) => shelfHeadMatch(term, it));
}

test("substantivo-cabeça da consulta: 1ª palavra de conteúdo, sem estado, no singular", () => {
  assert.equal(shelfHeadNoun("bolo pronto"), "bolo");
  assert.equal(shelfHeadNoun("salgados congelados"), "salgado");
  assert.equal(shelfHeadNoun("prato pronto congelado"), "prato");
  assert.equal(shelfHeadNoun("sanduiche pronto"), "sanduiche");
  assert.equal(shelfHeadNoun("pronto"), null);
});

test("piso 'bolo pronto': bolo de verdade passa; uva e esmalte 'Bolo de Chocolate' não", () => {
  // A consulta decorada sozinha já basta para o bolo (antes caía por faltar "pronto").
  assert.equal(shelfHeadMatch("bolo pronto", item("Bolo de Chocolate Ana Maria 70g", "Ana Maria")), true);
  assert.equal(shelfHeadMatch("bolo pronto", item("Bolinho Bauducco Duplo Chocolate", "Bauducco")), true, "diminutivo = mesmo substantivo");
  assert.equal(shelfHeadMatch("bolo pronto", item("Esmalte Dailus Bolo de Chocolate", "Dailus")), false);
  assert.equal(shelfHeadMatch("bolo pronto", item("Esmalte Cremoso Dailus Queridinhos Bolo de Chocolate", "Dailus")), false);
  assert.equal(shelfHeadMatch("bolo pronto", item("Uva Sugar Crisp Doce")), false);
  assert.equal(floor("doces.bolo", "bolo pronto", item("Bolo de Chocolate Ana Maria 70g", "Ana Maria")), true);
  assert.equal(floor("doces.bolo", "bolo pronto", item("Bolinho Bauducco")), true);
  assert.equal(floor("doces.bolo", "bolo pronto", item("Esmalte Dailus Bolo de Chocolate", "Dailus")), false);
  assert.equal(floor("doces.bolo", "bolo pronto", item("Uva Sugar Crisp Doce")), false);
});

test("piso 'sanduiche pronto': sanduíche passa; suco e pão de queijo não", () => {
  assert.equal(floor("lanches.sanduiche", "sanduiche pronto", item("Sanduíche Hot Pocket X-Burguer Sadia", "Sadia")), true);
  assert.equal(floor("lanches.sanduiche", "sanduiche pronto", item("Suco Natural One 900ml", "Natural One")), false);
  // "lanche" está no nome, mas depois de "Pão de Queijo" (não é a cabeça); "pao recheado" pede "recheado".
  assert.equal(floor("lanches.sanduiche", "sanduiche pronto", item("Pão de Queijo Lanche Congelado")), false);
});

test("piso 'perfume feminino': perfume passa (inclusive 'Desodorante Colônia'); absorvente não", () => {
  assert.equal(floor("beleza.perfume_feminino", "perfume feminino", item("Perfume Natura Kaiak Feminino", "Natura")), true);
  assert.equal(floor("beleza.perfume_feminino", "perfume feminino", item("Kaiak Feminino Desodorante Colônia 100ml", "Natura")), true);
  assert.equal(floor("beleza.perfume_feminino", "perfume feminino", item("Absorvente Always Noturno", "Always")), false);
  // Produto humano × pet continua valendo (guarda dura do ranking).
  assert.equal(floor("beleza.perfume_feminino", "perfume feminino", item("Perfume Pet Feminino para Cães")), false);
});

test("piso 'salgadinho': salgadinho e as marcas da prateleira passam; castanha não (a prateleira real não tem alias de castanha)", () => {
  assert.equal(floor("snacks.salgadinho", "salgadinho", item("Salgadinho Doritos Queijo Nacho 140g", "Doritos")), true);
  assert.equal(floor("snacks.salgadinho", "salgadinho", item("Batata Ruffles Original 115g", "Ruffles")), true);
  assert.equal(floor("snacks.salgadinho", "salgadinho", item("Chips de Batata Pringles Original", "Pringles")), true, "todas as palavras + uma em título");
  assert.equal(floor("snacks.salgadinho", "salgadinho", item("Castanha de Caju Torrada")), false);
});

test("piso de pratos prontos: a consulta da prateleira cobre o que a IA decorou", () => {
  assert.equal(floor("congelados.pratos_prontos", "prato pronto congelado", item("Lasanha Bolonhesa Sadia 600g", "Sadia")), true);
  assert.equal(floor("congelados.pratos_prontos", "prato pronto congelado", item("Molho de Tomate Pronto")), false);
});

// ---------------------------------------------------------------- 3. cache da cópia

test("cache da cópia: a mesma busca não varre o catálogo de novo e devolve o mesmo resultado", async () => {
  stores.__clearSnapshotSearchCacheForTests();
  const carrefour = stores.listStores().find((s) => s.key === "carrefour");
  assert.ok(carrefour, "carrefour no elenco de teste");
  const original = carrefour.searchItems;
  let calls = 0;
  carrefour.searchItems = async (q: string, limit?: number) => {
    calls++;
    return original.call(carrefour, q, limit);
  };
  try {
    const first = await stores.gatherCrossStoreCandidates("chocolate", 8, 3, { noLongTail: true, onlyStores: ["carrefour"] });
    const afterFirst = calls;
    const second = await stores.gatherCrossStoreCandidates("Chocolate ", 8, 3, { noLongTail: true, onlyStores: ["carrefour"] });
    assert.ok(afterFirst >= 1);
    assert.equal(calls, afterFirst, "2ª busca (mesma consulta normalizada) sai do cache");
    assert.deepEqual(second.map((c) => c.item.sku), first.map((c) => c.item.sku));
  } finally {
    carrefour.searchItems = original;
    stores.__clearSnapshotSearchCacheForTests();
  }
});
