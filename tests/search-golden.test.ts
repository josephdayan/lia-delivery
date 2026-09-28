import "./helpers/golden-env";
import { test } from "node:test";
import assert from "node:assert/strict";

import { gatherCrossStoreCandidates, listStores } from "../src/lib/stores";
import { conciergeMatchIsStrong, diversifyOptions, normalizeText, sameProductVariant, type CatalogItem } from "../src/lib/stores/types";
import { GOLDEN_CASES } from "./helpers/search-golden";

// Piso de regressão da busca: o pipeline determinístico (sem OpenAI) tem que passar
// todos os casos `deterministic: true` do golden. Espelha o fallback do buildChoices
// do concierge: candidatos largos em todas as vitrines → top-3 diversificado → piso
// de relevância. Se mudar lá, mude aqui.
async function deterministicOptions(query: string): Promise<CatalogItem[]> {
  const candidates = await gatherCrossStoreCandidates(query, 12);
  const top3 = diversifyOptions(query, candidates.map((c) => c.item), 3);
  return top3.filter((item) => conciergeMatchIsStrong(query, item));
}

for (const c of GOLDEN_CASES.filter((c) => c.deterministic)) {
  test(`golden determinístico: ${c.name}`, async () => {
    const items = await deterministicOptions(c.query);
    const shown = items.map((item) => normalizeText(item.name));
    if (c.none) {
      assert.deepEqual(shown, [], `"${c.query}" deveria ser linha livre, mas mostrou: ${shown.join(" | ")}`);
      return;
    }
    assert.ok(shown.length > 0, `"${c.query}" não mostrou nenhuma opção`);
    if (c.top1Include) {
      assert.match(shown[0], c.top1Include, `1ª opção de "${c.query}" foi: ${shown[0]}`);
    }
    if (c.top1Exclude) {
      assert.doesNotMatch(shown[0], c.top1Exclude, `1ª opção de "${c.query}" foi: ${shown[0]}`);
    }
    if (c.allExclude) {
      for (const name of shown) {
        assert.doesNotMatch(name, c.allExclude, `"${c.query}" mostrou opção proibida: ${name}`);
      }
    }
    if (c.distinctOptions) {
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          assert.ok(
            !sameProductVariant(c.query, items[i], items[j]),
            `"${c.query}" mostrou quase o mesmo produto duas vezes: ${items[i].name} | ${items[j].name}`
          );
        }
      }
    }
  });
}

test("golden: as 3 opções não são o mesmo produto em cores diferentes", async () => {
  // Caso real: "carregador usb" genérico mostrava Branco/Preto/Rosa do MESMO carregador.
  const candidates = await gatherCrossStoreCandidates("carregador usb", 12);
  const top3 = diversifyOptions("carregador usb", candidates.map((c) => c.item), 3);
  const stripped = top3.map((item) =>
    normalizeText(item.name)
      .split(" ")
      .filter((w) => !["branco", "branca", "preto", "preta", "rosa", "vermelho", "vermelha", "azul"].includes(w))
      .join(" ")
  );
  assert.equal(new Set(stripped).size, stripped.length, `opções repetidas: ${top3.map((i) => i.name).join(" | ")}`);
});

test("golden: sku é único em TODAS as vitrines (o rerank resolve a escolha por sku)", () => {
  // buildChoices manda os candidatos pra IA identificados por sku e resolve a resposta
  // por sku. Se duas vitrines usassem o mesmo sku, a escolha da IA cairia no produto da
  // loja errada — com preço e loja errados na mensagem, sem erro nenhum aparecer.
  const owners = new Map<string, string[]>();
  for (const store of listStores()) {
    for (const item of store.listCatalog()) {
      owners.set(item.sku, [...(owners.get(item.sku) ?? []), store.key]);
    }
  }
  const repeated = [...owners.entries()].filter(([, keys]) => keys.length > 1);
  assert.deepEqual(
    repeated.slice(0, 5).map(([sku, keys]) => `${sku} em ${keys.join(",")}`),
    [],
    `${repeated.length} sku(s) repetidos`
  );
});

test("golden: pedir uma COR específica desliga a diversificação", () => {
  // 27/09: o elenco de produção não tem mais o carregador em 3 cores; o comportamento é
  // provado com itens sintéticos (a regra é do diversificador, não do catálogo).
  const items = [
    { sku: "a", name: "Carregador Veicular I2GO 2 Saídas USB Branco", unitPrice: 30 },
    { sku: "b", name: "Carregador Veicular I2GO 2 Saídas USB Preto", unitPrice: 30 },
    { sku: "c", name: "Carregador Veicular I2GO 2 Saídas USB Rosa", unitPrice: 30 },
  ] as CatalogItem[];
  const colorAsked = diversifyOptions("carregador veicular rosa", [items[2], items[0], items[1]], 3);
  assert.match(normalizeText(colorAsked[0].name), /rosa/);
  assert.equal(colorAsked.length, 3, "pedindo cor, as variantes de cor continuam na lista");
  // Sem cor pedida, um produto DIFERENTE ganha a 2ª vaga antes da 2ª cor do mesmo.
  const other = { sku: "d", name: "Carregador de Tomada Leve-Me PD", unitPrice: 25 } as CatalogItem;
  const generic = diversifyOptions("carregador veicular", [...items, other], 3);
  assert.equal(generic[1].sku, "d", `sem cor pedida: ${generic.map((i) => i.name).join(" | ")}`);
});
