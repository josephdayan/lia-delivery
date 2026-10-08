// Busca por prateleira (08/10/2026, plano de recomendação, etapa BUSCAR): gatherShelfCandidates
// junta várias consultas (pick "a | b", shelf.query, aliases) e, onde o mapa tem categoryPaths, a
// prateleira inteira da loja pela busca de categoria da VTEX. Sem rede: cópia dos catálogos; o
// ao vivo só é ligado nos testes de categoria, com `fetch` falso.
import "./helpers/load-env";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ShelfNode, ShelfPick } from "../src/lib/recommend/types";

// O helper fixa o elenco de lojas em 5; aqui ligamos as que a prateleira usa ANTES de importar o
// registry (ele é montado no import). ML ligado só para provar que a recomendação não o chama.
for (const store of ["MAMBO", "PREZUNIC", "DROGARIASP", "PAGUEMENOS"]) process.env[`LIA_ENABLE_${store}`] = "true";
process.env.LIA_ENABLE_MERCADOLIVRE = "true";
process.env.APIFY_API_TOKEN = "teste-sem-rede";

let gatherShelfCandidates: typeof import("../src/lib/stores/index").gatherShelfCandidates;
let gatherCrossStoreCandidates: typeof import("../src/lib/stores/index").gatherCrossStoreCandidates;
let shelfQueryAlternatives: typeof import("../src/lib/stores/index").shelfQueryAlternatives;
let mercadoLivreStore: typeof import("../src/lib/stores/mercadolivre").mercadoLivreStore;
let liveSearchByCategory: typeof import("../src/lib/stores/live-search").liveSearchByCategory;
let resolveCategoryPath: typeof import("../src/lib/stores/live-search").resolveCategoryPath;
let clearLiveCache: typeof import("../src/lib/stores/live-search").__clearLiveSearchCacheForTests;

const originalFetch = globalThis.fetch;

before(async () => {
  ({ gatherShelfCandidates, gatherCrossStoreCandidates, shelfQueryAlternatives } = await import("../src/lib/stores/index"));
  ({ mercadoLivreStore } = await import("../src/lib/stores/mercadolivre"));
  ({ liveSearchByCategory, resolveCategoryPath, __clearLiveSearchCacheForTests: clearLiveCache } = await import("../src/lib/stores/live-search"));
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LIA_MEDICINE_MIP;
  process.env.LIA_LIVE_SEARCH = "false";
});

const pick = (query: string, shelfId = "x"): ShelfPick => ({ shelfId, query, why: "teste" });
const shelf = (over: Partial<ShelfNode>): ShelfNode => ({ id: "x", label: "X", domain: "mercado", query: "chocolate", stores: [], ...over });
const dupes = (list: { store: { key: string }; item: { sku: string } }[]) => list.length - new Set(list.map((c) => `${c.store.key}:${c.item.sku}`)).size;

test("shelfQueryAlternatives separa por ' | ', limpa e tira repetidas", () => {
  assert.deepEqual(shelfQueryAlternatives("loperamida | Imosec |  Diasec | imosec"), ["loperamida", "Imosec", "Diasec"]);
  assert.deepEqual(shelfQueryAlternatives("  chocolate  "), ["chocolate"]);
  assert.deepEqual(shelfQueryAlternatives(" | "), []);
});

test("chocolate: só as lojas da prateleira, sem duplicata, dentro do limite", async () => {
  const result = await gatherShelfCandidates(pick("chocolate"), shelf({ stores: ["mambo", "prezunic"] }), { limit: 8 });
  assert.ok(result.length > 0, "a cópia do Mambo tem chocolate");
  assert.ok(result.length <= 8);
  assert.equal(dupes(result), 0);
  for (const c of result) assert.ok(["mambo", "prezunic"].includes(c.store.key), `loja fora da prateleira: ${c.store.key}`);
});

test("CEP do Rio tira a loja regional de SP da prateleira (Mambo não entrega lá)", async () => {
  const result = await gatherShelfCandidates(pick("chocolate"), shelf({ stores: ["mambo", "prezunic"] }), { cep: "22041-001" });
  for (const c of result) assert.equal(c.store.key, "prezunic");
  // CEP de SP capital: Prezunic (RJ) sai, Mambo fica.
  const sp = await gatherShelfCandidates(pick("chocolate"), shelf({ stores: ["mambo", "prezunic"] }), { cep: "01310-100" });
  assert.ok(sp.length > 0);
  for (const c of sp) assert.equal(c.store.key, "mambo");
  // Só lojas regionais do outro estado: nada a buscar.
  assert.deepEqual(await gatherShelfCandidates(pick("chocolate"), shelf({ stores: ["prezunic"] }), { cep: "01310-100" }), []);
});

test("sem lista de lojas na prateleira (ou sem prateleira) busca em todas", async () => {
  const all = await gatherShelfCandidates(pick("chocolate"), shelf({ stores: [] }), { limit: 12 });
  assert.ok(new Set(all.map((c) => c.store.key)).size >= 2, "várias lojas");
  const orphan = await gatherShelfCandidates(pick("chocolate"), undefined, { limit: 12 });
  assert.ok(orphan.length > 0);
  assert.equal(dupes(orphan), 0);
});

test("pick com ' | ' faz a união das alternativas, na ordem da pick", async () => {
  const names = (list: { item: { name: string } }[]) => list.map((c) => c.item.name);
  const result = await gatherShelfCandidates(pick("chocolate | biscoito"), shelf({ stores: ["mambo", "prezunic", "carrefour"] }), { limit: 40, perStore: 6 });
  assert.equal(dupes(result), 0);
  const n = names(result);
  const firstBiscoito = n.findIndex((name) => /biscoito/i.test(name));
  const lastChocolate = n.map((name, index) => (/chocolate/i.test(name) && !/biscoito/i.test(name) ? index : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(firstBiscoito >= 0 && lastChocolate >= 0, `faltou uma das alternativas: ${n.join(" / ")}`);
  assert.ok(/chocolate/i.test(n[0]), "o primeiro candidato é da primeira alternativa");
  // O que a 2ª consulta sozinha acha está na união.
  const second = await gatherCrossStoreCandidates("biscoito", 12, 4, { noLongTail: true, onlyStores: ["mambo", "prezunic", "carrefour"] });
  const have = new Set(result.map((c) => `${c.store.key}:${c.item.sku}`));
  assert.ok(second.some((c) => have.has(`${c.store.key}:${c.item.sku}`)));
});

test("aliases da prateleira entram quando a pick não os cobre, depois dos itens da pick", async () => {
  const s = shelf({ query: "chocolate", aliases: ["biscoito"], stores: ["mambo", "carrefour"] });
  const only = await gatherShelfCandidates(pick("chocolate ao leite"), s, { limit: 40, perStore: 6 });
  assert.ok(only.some((c) => /biscoito/i.test(c.item.name) && !/chocolate/i.test(c.item.name)), "alias 'biscoito' não foi buscado");
  const idxPick = only.findIndex((c) => /chocolate/i.test(c.item.name));
  const idxAlias = only.findIndex((c) => /biscoito/i.test(c.item.name) && !/chocolate/i.test(c.item.name));
  assert.ok(idxPick >= 0 && idxPick < idxAlias, "itens da pick vêm antes dos do alias");
});

test("prateleira SEM mip nunca devolve remédio, nem com a porta do remédio ligada", async () => {
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    // Controle: a busca comum acha o isento (a porta está aberta)...
    const control = await gatherCrossStoreCandidates("dipirona", 12, 4, { noLongTail: true, onlyStores: ["drogariasp", "paguemenos"] });
    assert.ok(control.some((c) => c.item.medicine === "mip"), "controle: dipirona isenta existe na cópia");
    // ...e a prateleira comum não a deixa passar.
    for (const sh of [shelf({ id: "farmacia.higiene", domain: "farmacia", query: "dipirona", stores: ["drogariasp", "paguemenos"] }), undefined]) {
      const result = await gatherShelfCandidates(pick("dipirona"), sh, { limit: 12 });
      assert.equal(result.filter((c) => c.item.medicine).length, 0);
      assert.equal(result.length, 0, `devolveu: ${result.map((c) => c.item.name).join(" / ")}`);
    }
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});

test("prateleira mip devolve só medicine: 'mip', união das alternativas; sem a flag, nada", async () => {
  const mipShelf = shelf({ id: "farmacia.analgesico", domain: "farmacia", query: "dipirona", flags: ["mip"], stores: ["drogariasp", "paguemenos"] });
  assert.deepEqual(await gatherShelfCandidates(pick("dipirona | Novalgina"), mipShelf), [], "LIA_MEDICINE_MIP desligado");
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    const result = await gatherShelfCandidates(pick("dipirona | Novalgina"), mipShelf, { limit: 12 });
    assert.ok(result.length > 0);
    assert.equal(dupes(result), 0);
    for (const c of result) {
      assert.equal(c.item.medicine, "mip", `não-isento passou: ${c.item.name}`);
      assert.ok(["drogariasp", "paguemenos"].includes(c.store.key));
    }
    assert.ok(result.some((c) => /novalgina/i.test(c.item.name)), "alternativa 'Novalgina'");
    assert.ok(result.some((c) => /dipirona/i.test(c.item.name)), "alternativa 'dipirona'");
    // Loja que não é farmácia não devolve MIP, e prateleira mip em loja comum fica vazia.
    const mercado = await gatherShelfCandidates(pick("dipirona"), { ...mipShelf, stores: ["mambo"] });
    assert.deepEqual(mercado, []);
  } finally {
    delete process.env.LIA_MEDICINE_MIP;
  }
});

test("Mercado Livre nunca roda na recomendação (mesmo sem nada local e com ML na vitrine)", async () => {
  let calls = 0;
  const original = mercadoLivreStore.searchItems;
  mercadoLivreStore.searchItems = async () => {
    calls += 1;
    return [];
  };
  try {
    const nonsense = "zzqxwv produto inexistente";
    // Controle: o caminho da lista de itens chamaria o ML aqui.
    await gatherCrossStoreCandidates(nonsense, 12, 4);
    assert.ok(calls >= 1, "controle: a busca comum aciona a cauda longa");
    calls = 0;
    await gatherShelfCandidates(pick(nonsense), shelf({ stores: [] }));
    await gatherShelfCandidates(pick(nonsense), undefined);
    await gatherShelfCandidates(pick(nonsense), shelf({ stores: ["mercadolivre"] }));
    assert.equal(calls, 0, "ML foi chamado pela recomendação");
    // forceLongTail também é ignorado quando noLongTail é pedido.
    await gatherCrossStoreCandidates(nonsense, 12, 4, { noLongTail: true, forceLongTail: true });
    assert.equal(calls, 0);
  } finally {
    mercadoLivreStore.searchItems = original;
  }
});

// ---------- categoria (ao vivo, com fetch falso) ----------

const isProduct = (id: string, name: string, categories: string[]) => ({
  productName: name,
  brand: "Marca",
  link: `/${id}/p`,
  categories,
  items: [{ itemId: id, name, images: [{ imageUrl: "https://img/x.jpg" }], sellers: [{ sellerId: "1", commertialOffer: { Price: 12.5, AvailableQuantity: 5 } }] }]
});

function fakeFetch(handler: (url: string) => unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

test("liveSearchByCategory monta o caminho com category-N, usa o funil de filtros e nunca lança", async () => {
  clearLiveCache();
  const urls = fakeFetch(() => ({
    products: [
      isProduct("9001", "Chocolate Barra Teste 80g", ["/Mambo/Mercearia/Doces e Chocolates/"]),
      isProduct("9002", "Dipirona 1g 10 comprimidos", ["/Mambo/Saúde/Remédios/"]) // remédio fora da porta: some
    ]
  }));
  const items = await liveSearchByCategory("mambo", "mambo/mercearia/doces-e-chocolates", 12);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/www\.mambo\.com\.br\/api\/io\/_v\/api\/intelligent-search\/product_search\/category-1\/mambo\/category-2\/mercearia\/category-3\/doces-e-chocolates\?/);
  assert.match(urls[0], /hideUnavailableItems=true/);
  assert.deepEqual(items.map((i) => i.sku), ["mambo-9001"]);
  // cache: segunda chamada não vai à rede
  await liveSearchByCategory("mambo", "mambo/mercearia/doces-e-chocolates", 12);
  assert.equal(urls.length, 1);
  // caminho inválido / loja desconhecida: [] sem rede
  assert.deepEqual(await liveSearchByCategory("mambo", "../etc/passwd"), []);
  assert.deepEqual(await liveSearchByCategory("mambo", "a/b/c/d/e"), []);
  assert.deepEqual(await liveSearchByCategory("loja-que-nao-existe", "a/b"), []);
  assert.equal(urls.length, 1);
  // erro de rede / HTTP != 200: [] e não lança
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  assert.deepEqual(await liveSearchByCategory("mambo", "mambo/mercearia/biscoito"), []);
  globalThis.fetch = (async () => new Response("x", { status: 500 })) as typeof fetch;
  assert.deepEqual(await liveSearchByCategory("mambo", "mambo/mercearia/bebidas"), []);
});

test("resolveCategoryPath desce pelas facetas enquanto uma categoria domina; ambígua = null", async () => {
  clearLiveCache();
  const facet = (level: number, values: [string, number][]) => ({ key: `category-${level}`, values: values.map(([value, quantity]) => ({ value, quantity })) });
  const urls = fakeFetch((url) => {
    if (url.includes("query=chocolate")) {
      if (url.includes("category-2/mercearia")) return { facets: [facet(3, [["doces-e-chocolates", 548], ["biscoito", 192], ["suplemento", 62]])] };
      if (url.includes("category-1/mambo")) return { facets: [facet(2, [["mercearia", 929], ["saude-e-bem-estar", 176]])] };
      return { facets: [facet(1, [["mambo", 1100]])] };
    }
    // consulta ambígua: nenhum departamento passa de 25%
    return { facets: [facet(1, [["a", 30], ["b", 30], ["c", 30], ["d", 30], ["e", 30]])] };
  });
  assert.equal(await resolveCategoryPath("mambo", "chocolate"), "mambo/mercearia/doces-e-chocolates");
  assert.match(urls[0], /\/intelligent-search\/facets\/\?query=chocolate/);
  assert.match(urls[2], /\/facets\/category-1\/mambo\/category-2\/mercearia\?query=chocolate/);
  const n = urls.length;
  assert.equal(await resolveCategoryPath("mambo", "chocolate"), "mambo/mercearia/doces-e-chocolates");
  assert.equal(urls.length, n, "cache");
  assert.equal(await resolveCategoryPath("mambo", "coisa vaga"), null);
  assert.equal(await resolveCategoryPath("mambo", "chocolate", { maxDepth: 1 }), "mambo");
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  assert.equal(await resolveCategoryPath("mambo", "outra"), null);
  assert.equal(await resolveCategoryPath("loja-que-nao-existe", "chocolate"), null);
});

test("categoryPaths da prateleira trazem a prateleira inteira da loja (ao vivo), sem duplicata", async () => {
  clearLiveCache();
  process.env.LIA_LIVE_SEARCH = "true";
  try {
    const urls = fakeFetch((url) =>
      url.includes("category-1/mambo/category-2/mercearia/category-3/doces-e-chocolates")
        ? {
            products: [
              isProduct("7001", "Tablete Sabor Intenso Marca X 90g", ["/Mambo/Mercearia/Doces e Chocolates/"]),
              isProduct("7002", "Bombom Caixa Presente Marca Y 250g", ["/Mambo/Mercearia/Doces e Chocolates/"]),
              isProduct("7001", "Tablete Sabor Intenso Marca X 90g", ["/Mambo/Mercearia/Doces e Chocolates/"])
            ]
          }
        : { products: [] }
    );
    const withPath = shelf({ stores: ["mambo", "prezunic"], categoryPaths: { mambo: "mambo/mercearia/doces-e-chocolates", prezunic: "nao-existe/x" } });
    const result = await gatherShelfCandidates(pick("chocolate"), withPath, { limit: 12 });
    assert.ok(urls.some((u) => u.includes("product_search/category-1/mambo/")), "a busca por categoria não foi feita");
    const skus = result.map((c) => c.item.sku);
    assert.ok(skus.includes("mambo-7001") && skus.includes("mambo-7002"), `itens da prateleira ausentes: ${skus.join(",")}`);
    assert.equal(dupes(result), 0);
    assert.ok(result.length <= 12);
    // Sem caminho no mapa: nenhuma chamada de categoria.
    urls.length = 0;
    clearLiveCache();
    await gatherShelfCandidates(pick("chocolate"), shelf({ stores: ["mambo"] }));
    assert.ok(!urls.some((u) => /product_search\/category-1/.test(u)));
  } finally {
    process.env.LIA_LIVE_SEARCH = "false";
    globalThis.fetch = originalFetch;
  }
});
