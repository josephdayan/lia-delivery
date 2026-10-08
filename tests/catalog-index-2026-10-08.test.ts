// Índice do catálogo (08/10/2026): `rankCatalog` pontua só os itens que o índice de palavras aponta.
// Este teste é a garantia de que o índice é condição NECESSÁRIA e nunca muda o resultado: para os
// 316 pedidos reais do placar + casos de borda (negação, medida, pack, marca, pet, dose, alias,
// typo, plural), o top-12 indexado é idêntico ao da varredura inteira em 5 catálogos grandes.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setCatalogFullScanForTests, rankCatalog, type CatalogItem } from "../src/lib/stores/types";
import { mamboStore } from "../src/lib/stores/mambo";
import { americanasStore } from "../src/lib/stores/americanas";
import { drogalStore } from "../src/lib/stores/drogal";
import { casaevideoStore } from "../src/lib/stores/casaevideo";
import { carrefourStore } from "../src/lib/stores/carrefour";

const REAL = (JSON.parse(readFileSync(join(__dirname, "..", "evals", "search-requests.json"), "utf8")) as { text: string }[]).map((r) => r.text);
const EDGE = [
  "gin", "vodka absolute", "suco de laranja", "red bull", "2 vodkas absolute", "4 red bull",
  "café sem açúcar", "água sem gás", "leite 2 litros", "coca 2 litros", "arroz 5kg", "água mineral 1,5l",
  "pack de cerveja brahma 12 latas", "fardo de coca", "papel higiênico 12 rolos", "tubo com 4 bolas",
  "ração para cachorro", "ração gato", "shampoo", "perfume", "xampu", "refri", "miojo", "lamen",
  "ibuprofeno 600mg", "dipirona", "carregador usb c", "cabo hdmi", "pilhas recarregáveis",
  "detergnte", "bananna", "escva de dente", "ovos", "frango", "leite", "cotonete", "hidratante",
  "presente pra minha mãe", "sacola presente", "fralda XG", "fralda geriátrica", "Coca-Cola",
  "bombril", "bom dia", "quero um leite", "oi", "", "x", "leite ninho", "Leite Nude",
  "achocolatado em pó", "leite em pó", "leite de coco", "doce de leite", "pão de queijo",
  "vinho tinto até 40 reais", "cerveja heineken lata", "sabão em pó", "lava roupas", "amaciante"
];
const QUERIES = [...new Set([...REAL, ...EDGE])];
const STORES = [mamboStore, americanasStore, drogalStore, casaevideoStore, carrefourStore];

function skus(items: CatalogItem[]): string[] {
  return items.map((i) => i.sku);
}

test("08/10: índice do catálogo devolve EXATAMENTE o mesmo top-12 que a varredura inteira (5 catálogos × ~380 pedidos)", () => {
  let compared = 0;
  for (const store of STORES) {
    const items = store.listCatalog!();
    assert.ok(items.length > 1000, `${store.key}: catálogo pequeno demais para o teste (${items.length})`);
    for (const q of QUERIES) {
      __setCatalogFullScanForTests(true);
      const full = skus(rankCatalog(q, items, 12));
      __setCatalogFullScanForTests(false);
      const indexed = skus(rankCatalog(q, items, 12));
      assert.deepEqual(indexed, full, `${store.key} / "${q}"`);
      compared += 1;
    }
  }
  __setCatalogFullScanForTests(false);
  assert.ok(compared >= 5 * 300, `comparações: ${compared}`);
});

test("08/10: o índice é mais barato que a varredura (4 linhas × 5 catálogos)", () => {
  const lines = ["vodka absolute", "suco de laranja", "gin", "red bull"];
  const run = () => {
    const t = process.hrtime.bigint();
    for (const q of lines) for (const store of STORES) rankCatalog(q, store.listCatalog!(), 4);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  __setCatalogFullScanForTests(true);
  const full = run();
  __setCatalogFullScanForTests(false);
  run(); // aquece o índice e o memo
  const indexed = run();
  console.log(`[catalog-index] varredura=${full.toFixed(0)}ms índice=${indexed.toFixed(0)}ms`);
  assert.ok(indexed < full, `índice (${indexed.toFixed(0)}ms) não ficou mais barato que a varredura (${full.toFixed(0)}ms)`);
});
