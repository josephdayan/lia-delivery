import "./helpers/golden-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __clearLiveSearchCacheForTests, categorySlug, isPharmacyStore, liveSearchEnabled, liveSearchItems, mergeLiveWithSnapshot, parseLiveProducts } from "../src/lib/stores/live-search";
import type { CatalogItem } from "../src/lib/stores/types";

const product = (over: Record<string, unknown> = {}) => ({
  productName: "Bola De Tenis Championship Bolsa 12 Bolinhas Verde Werkon",
  brand: "Werkon",
  link: "/bola-de-tenis-championship/p",
  categories: ["/Esportes/Tenis/"],
  items: [{ itemId: "4163487", nameComplete: "Bola De Tenis Championship Bolsa 12 Bolinhas Verde Werkon", images: [{ imageUrl: "https://img/x.jpg" }], sellers: [{ sellerId: "1", commertialOffer: { Price: 89.9, AvailableQuantity: 10000 } }] }],
  ...over
});

test("produto da prateleira vira item com SKU no formato da cópia", () => {
  const [item] = parseLiveProducts("casaevideo", [product()]);
  assert.equal(item.sku, "casaevideo-4163487");
  assert.equal(item.unitPrice, 89.9);
  assert.equal(item.productUrl, "https://www.casaevideo.com.br/bola-de-tenis-championship/p");
  assert.equal(item.category, "esportes tenis");
});

test("só o que a própria loja vende e tem estoque entra", () => {
  const offered = (sellerId: string, qty: number) => product({ items: [{ itemId: "9", nameComplete: "Item", sellers: [{ sellerId, commertialOffer: { Price: 10, AvailableQuantity: qty } }] }] });
  assert.equal(parseLiveProducts("casaevideo", [offered("lojista-3p", 5)]).length, 0);
  assert.equal(parseLiveProducts("casaevideo", [offered("1", 0)]).length, 0);
  assert.equal(parseLiveProducts("casaevideo", [offered("1", 3)]).length, 1);
});

test("remédio nunca entra: categoria da loja e guardas ANVISA", () => {
  const named = (name: string, categories: string[]) => product({ productName: name, categories, items: [{ itemId: "55", nameComplete: name, sellers: [{ sellerId: "1", commertialOffer: { Price: 10, AvailableQuantity: 5 } }] }] });
  const byCategory = named("Algo Qualquer", ["/Medicamentos/"]);
  const byName = named("Dipirona Monoidratada 1g Genérico Cimed", ["/Higiene/"]);
  assert.equal(parseLiveProducts("drogariasp", [byCategory, byName]).length, 0);
});

test("farmácia só amplia dentro das categorias que a colheita liberou", () => {
  const snapshot: CatalogItem[] = [{ sku: "dsp-1", name: "Shampoo A", unitPrice: 10, category: "dermocosmeticos shampoo", popularity: 3 }];
  const live: CatalogItem[] = [
    { sku: "dsp-2", name: "Shampoo B", unitPrice: 12, category: "dermocosmeticos shampoo" },
    { sku: "dsp-3", name: "Coisa de categoria nova", unitPrice: 9, category: "outra categoria" }
  ];
  const cats = new Set(snapshot.map((i) => i.category ?? ""));
  assert.deepEqual(mergeLiveWithSnapshot("drogariasp", snapshot, live, cats).map((i) => i.sku), ["dsp-1", "dsp-2"]);
  // loja que não é farmácia: tudo entra
  assert.deepEqual(mergeLiveWithSnapshot("casaevideo", snapshot, live).map((i) => i.sku), ["dsp-1", "dsp-2", "dsp-3"]);
  assert.equal(isPharmacyStore("drogariasp"), true);
  assert.equal(isPharmacyStore("mambo"), false);
});

test("o ao vivo atualiza preço/nome da cópia e preserva a popularidade", () => {
  const snapshot: CatalogItem[] = [{ sku: "mambo-1", name: "Leite velho", unitPrice: 5, popularity: 7, category: "x" }];
  const live: CatalogItem[] = [{ sku: "mambo-1", name: "Leite novo", unitPrice: 6.5, category: "x" }];
  const [merged] = mergeLiveWithSnapshot("mambo", snapshot, live);
  assert.equal(merged.unitPrice, 6.5);
  assert.equal(merged.name, "Leite novo");
  assert.equal(merged.popularity, 7);
});

test("busca ao vivo: falha ou timeout = lista vazia (a cópia responde sozinha); sucesso vai pro cache", async () => {
  __clearLiveSearchCacheForTests();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => ({ products: [product()] }) }; };
  assert.equal((await liveSearchItems("casaevideo", "bola de tenis", 12, ok)).length, 1);
  assert.equal((await liveSearchItems("casaevideo", "Bola de Tenis", 12, ok)).length, 1);
  assert.equal(calls, 1, "segunda busca igual vem do cache");
  const boom = async () => { throw new Error("rede"); };
  assert.deepEqual(await liveSearchItems("mambo", "leite", 12, boom), []);
  const http500 = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(await liveSearchItems("swift", "leite", 12, http500), []);
  assert.deepEqual(await liveSearchItems("loja-que-nao-existe", "leite", 12, ok), []);
});

test("opt-in: só liga com LIA_LIVE_SEARCH=true", () => {
  const saved = process.env.LIA_LIVE_SEARCH;
  try {
    delete process.env.LIA_LIVE_SEARCH;
    assert.equal(liveSearchEnabled(), false);
    process.env.LIA_LIVE_SEARCH = "false";
    assert.equal(liveSearchEnabled(), false);
    process.env.LIA_LIVE_SEARCH = "true";
    assert.equal(liveSearchEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.LIA_LIVE_SEARCH; else process.env.LIA_LIVE_SEARCH = saved;
  }
  assert.equal(categorySlug(["/Dermocosméticos/Shampoo/"]), "dermocosmeticos shampoo");
});
