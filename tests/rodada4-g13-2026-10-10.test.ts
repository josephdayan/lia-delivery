import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { liveStoreFreight } from "../src/lib/live-freight";
import { cartridgeForPrinter, combineSpecQuery } from "../src/lib/spec-ask";
import { displayQueryName } from "../src/lib/query-display";
import { queryAliases } from "../src/lib/stores/types";
import * as copy from "../src/lib/lia-copy";

// Rodada 4, g13 (10/10): M1 cartucho incompatível, M5 brinde da loja derruba o item escolhido, B1 "sem cheiro", B2 textos.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// M1 ---------------------------------------------------------------------------------------------------------
test("M1: impressora conhecida vira o cartucho certo; modelo desconhecido ou número próprio não mexe", () => {
  assert.equal(cartridgeForPrinter("cartucho para HP DeskJet 2774"), "cartucho hp 667");
  assert.equal(cartridgeForPrinter("tinta pra impressora hp deskjet 2376"), "cartucho hp 667");
  assert.equal(cartridgeForPrinter("cartucho hp deskjet 2135"), "cartucho hp 664");
  assert.equal(cartridgeForPrinter("tinta epson l3250"), "refil tinta epson 544");
  // sem certeza: não chuta
  assert.equal(cartridgeForPrinter("cartucho para hp deskjet 9999"), null);
  assert.equal(cartridgeForPrinter("cartucho hp 667"), null);
  assert.equal(cartridgeForPrinter("impressora hp deskjet 2774"), null);
});

test("M1: resposta à pergunta do modelo usa a tabela; fora dela mantém o modelo na busca", () => {
  const ask = { kind: "cartucho" as const, query: "tinta pra impressora", qty: 1 };
  assert.equal(combineSpecQuery(ask, "hp deskjet 2774"), "cartucho hp 667");
  assert.equal(combineSpecQuery({ ...ask, qty: 2 }, "hp deskjet 2774"), "2 cartucho hp 667");
  assert.equal(combineSpecQuery(ask, "hp 664"), "cartucho hp 664");
});

// M5 ---------------------------------------------------------------------------------------------------------
test("M5: brinde que a loja injeta na simulação não derruba a confirmação do item pedido", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        items: [
          { id: "90239", requestIndex: 0, quantity: 1, sellingPrice: 3100, availability: "available" },
          { id: "188377", requestIndex: null, quantity: 1, sellingPrice: 0, availability: "available" }
        ],
        logisticsInfo: [
          { itemIndex: 0, slas: [{ name: "Econômica", price: 780, shippingEstimate: "2bd" }] },
          { itemIndex: 1, slas: [{ name: "Econômica", price: 0, shippingEstimate: "2bd" }] }
        ]
      }),
      { status: 200 }
    )) as typeof fetch;
  const outcome = await liveStoreFreight("epocacosmeticos", [{ sku: "epoca-90239", qty: 1 }], "01310-100");
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.fee, 7.8);
    assert.equal(outcome.unitPrices?.["epoca-90239"], 31);
  }
});

test("M5: item pedido que a loja devolve com outro id continua não confirmado", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        items: [{ id: "555", requestIndex: 0, quantity: 1, sellingPrice: 3100, availability: "available" }],
        logisticsInfo: [{ itemIndex: 0, slas: [{ name: "Econômica", price: 780, shippingEstimate: "2bd" }] }]
      }),
      { status: 200 }
    )) as typeof fetch;
  const outcome = await liveStoreFreight("epocacosmeticos", [{ sku: "epoca-90239", qty: 1 }], "01310-100");
  assert.equal(outcome.kind, "unavailable");
});

// B1 ---------------------------------------------------------------------------------------------------------
test("B1: 'sem' não vira 'Ser' no cabeçalho e 'sem cheiro' também busca 'sem perfume'", () => {
  const options = [{ name: "Areia Biodegradável Cansei de Ser Gato 4 kg" }];
  assert.equal(displayQueryName("areia higiênica para gatos sem cheiro 4kg", options), "areia higiênica para gatos sem cheiro 4kg");
  assert.ok(queryAliases("shampoo sem cheiro").includes("shampoo sem perfume"));
  assert.ok(queryAliases("areia sem aroma 4kg").includes("areia sem perfume 4kg"));
});

// B2 ---------------------------------------------------------------------------------------------------------
test("B2: oferta de juntar mostra os dois totais e o prazo de cada forma; o aceite mostra a economia no total", () => {
  const offer = copy.consolidationOffer({
    storeLabel: "Farmácia Indiana",
    joinedTotal: 194.9,
    keptTotal: 237.32,
    keptStores: 3,
    pairs: [],
    joinedEta: "prazo da loja: 8 dias úteis",
    keptEta: "prazo da loja: 3 dias úteis"
  });
  assert.match(offer, /8 dias úteis/);
  assert.match(offer, /3 dias úteis/);
  const done = copy.basketConsolidated("Farmácia Indiana", [], -4.72, { saved: 42.42, eta: "prazo da loja: 8 dias úteis" });
  assert.match(done, /R\$ 42,42 a menos no total/);
  assert.match(done, /8 dias úteis/);
  assert.doesNotMatch(done, /4,72/);
  // sem os totais (oferta antiga): mantém o texto de antes
  assert.match(copy.basketConsolidated("Mambo", [], -4.72), /R\$ 4,72 a menos/);
});

test("B2: aviso de frete cobre a soma de fretes de várias lojas", () => {
  const note = copy.expensiveShippingNote(150, 118, 5);
  assert.equal(note.length, 1);
  assert.match(note[0], /5 entregas/);
  assert.match(note[0], /44%/);
  assert.equal(copy.expensiveShippingNote(150, 20, 5).length, 0);
  assert.equal(copy.expensiveShippingNote(100, 40, 1).length, 0);
  assert.match(copy.expensiveShippingNote(10, 15)[0], /entrega sai mais cara/);
});
