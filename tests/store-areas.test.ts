import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRegionalStore, noteShopperCep, runShopperScoped, storeServesCep, storesForShopper } from "../src/lib/store-areas";
import { checkCandidatesLive } from "../src/lib/live-availability";
import { __setPreflightForTests, liveStoreFreight, preflightBasket } from "../src/lib/live-freight";

// Expansão RJ (06/10): "só mostrar e aceitar compra se tiver perto".
const PAULISTA = "01310-100";
const GUARULHOS = "07023000";
const RIBEIRAO = "14010000";
const COPACABANA = "22041-001";
const BH = "30130010";

test("loja regional só serve a própria área; nacional serve todo CEP", () => {
  assert.equal(storeServesCep("mambo", PAULISTA), true);
  assert.equal(storeServesCep("mambo", GUARULHOS), false, "Mambo é só capital");
  assert.equal(storeServesCep("mambo", COPACABANA), false);
  assert.equal(storeServesCep("savegnago", RIBEIRAO), true);
  assert.equal(storeServesCep("savegnago", PAULISTA), false);
  assert.equal(storeServesCep("zonasul", COPACABANA), true);
  assert.equal(storeServesCep("prezunic", COPACABANA), true);
  assert.equal(storeServesCep("zonasul", PAULISTA), false);
  assert.equal(storeServesCep("swift", COPACABANA), false);
  for (const cep of [PAULISTA, COPACABANA, BH]) assert.equal(storeServesCep("americanas", cep), true);
  // Sem CEP não dá pra provar que é perto: regional fica fora, nacional segue.
  assert.equal(storeServesCep("mambo", null), false);
  assert.equal(storeServesCep("zonasul", "123"), false);
  assert.equal(storeServesCep("drogariasp", null), true);
  assert.equal(isRegionalStore("mambo"), true);
  assert.equal(isRegionalStore("drogariaspacheco"), false);
});

test("busca do turno: filtra pela área do cliente; fora de turno não filtra", async () => {
  const stores = [{ key: "mambo" }, { key: "zonasul" }, { key: "americanas" }];
  assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "zonasul", "americanas"]);
  await runShopperScoped(async () => {
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["americanas"], "turno sem CEP: só nacional");
    noteShopperCep(COPACABANA);
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["zonasul", "americanas"]);
    noteShopperCep(PAULISTA); // trocou de endereço no meio do turno
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "americanas"]);
    noteShopperCep(null); // CEP vazio não apaga o que já se sabe
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "americanas"]);
  });
});

test("vitrine ao vivo: regional fora da área sai sem consultar; regional sem resposta sai; nacional sem resposta fica", async () => {
  const consulted: string[] = [];
  const candidates = [
    { storeKey: "mambo", sku: "mambo-1" },
    { storeKey: "zonasul", sku: "zonasul-1" },
    { storeKey: "prezunic", sku: "prezunic-1" },
    { storeKey: "americanas", sku: "americanas-1" }
  ];
  const result = await checkCandidatesLive(
    candidates,
    COPACABANA,
    async (storeKey, skus) => {
      consulted.push(storeKey);
      if (storeKey === "zonasul") return new Map([[skus[0], { sku: skus[0], available: true, estimate: "0d", etaMinutes: 0 }]]);
      return null; // Prezunic e Americanas fora do ar
    },
    () => true
  );
  assert.ok(!consulted.includes("mambo"), "Mambo nem é consultado para o Rio");
  assert.deepEqual(result.kept.map((c) => c.storeKey), ["zonasul", "americanas"]);
  assert.deepEqual(result.dropped.map((c) => c.storeKey).sort(), ["mambo", "prezunic"]);
});

test("cotação e cobrança: loja regional fora da área nunca passa, nem com simulação injetada", async () => {
  assert.deepEqual(await liveStoreFreight("mambo", [{ sku: "mambo-1", qty: 1 }], COPACABANA), { kind: "no-delivery" });
  let called = false;
  __setPreflightForTests(async () => {
    called = true;
    return null;
  });
  try {
    const failure = await preflightBasket(
      [
        { sku: "americanas-1", qty: 1, storeKey: "americanas" },
        { sku: "mambo-1", qty: 2, storeKey: "mambo" }
      ],
      COPACABANA
    );
    assert.deepEqual(failure, { storeKey: "mambo", kind: "no-delivery", skus: ["mambo-1"] });
    assert.equal(called, false);
    assert.equal(await preflightBasket([{ sku: "zonasul-1", qty: 1, storeKey: "zonasul" }], COPACABANA), null);
    assert.equal(called, true);
  } finally {
    __setPreflightForTests(null);
  }
});

test("vitrine só com loja de compra automática: fora de LIA_AUTO_PURCHASE_STORES não aparece (dono 06/10)", async () => {
  const old = process.env.LIA_AUTO_PURCHASE_STORES;
  const stores = [{ key: "mambo" }, { key: "drogariasp" }, { key: "mercadolivre" }];
  try {
    process.env.LIA_AUTO_PURCHASE_STORES = "mambo,drogariasp";
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "drogariasp"]);
    await runShopperScoped(async () => {
      noteShopperCep(PAULISTA);
      assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "drogariasp"]);
      noteShopperCep(COPACABANA); // Mambo é só SP capital
      assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["drogariasp"]);
    });
    delete process.env.LIA_AUTO_PURCHASE_STORES; // lista vazia (dev/testes) não filtra
    assert.deepEqual(storesForShopper(stores).map((s) => s.key), ["mambo", "drogariasp", "mercadolivre"]);
  } finally {
    if (old === undefined) delete process.env.LIA_AUTO_PURCHASE_STORES; else process.env.LIA_AUTO_PURCHASE_STORES = old;
  }
});
