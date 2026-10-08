import { test } from "node:test";
import assert from "node:assert/strict";

import { conciergeMatchIsStrong, queryAliases, scoreCatalogMatch, singularPt } from "../src/lib/stores/types";
import type { CatalogItem } from "../src/lib/stores/types";

// Placar r4 (08/10/2026). Dois buracos do matcher que o placar de busca mostrou:
//  - plural irregular: "pilhas recarregáveis" nunca casava com "Pilha Recarregável" (-eis ≠ -el), então
//    toda pilha recarregável pontuava como pilha comum e caía fora do top-12 (s189, miss em 5 rodadas);
//  - "leite em pó para bebê" é o que o cliente fala; a farmácia vende "Fórmula Infantil" (s141).

const item = (name: string): CatalogItem => ({ sku: `t-${name}`, name, unitPrice: 10, unit: "un", category: "geral" });

test("singularPt: sufixos regulares do português; palavra curta não muda", () => {
  assert.equal(singularPt("recarregaveis"), "recarregavel");
  assert.equal(singularPt("papeis"), "papel");
  assert.equal(singularPt("lencois"), "lencol");
  assert.equal(singularPt("naturais"), "natural");
  assert.equal(singularPt("limoes"), "limao");
  assert.equal(singularPt("batons"), "batom");
  assert.equal(singularPt("flores"), "flor");
  assert.equal(singularPt("pilhas"), "pilha");
  assert.equal(singularPt("sais"), "sais", "curta: 'sais' não vira 'sal'");
  assert.equal(singularPt("pais"), "pais");
  assert.equal(singularPt("maes"), "maes", "curta e -ães: não muda");
  assert.notEqual(singularPt("capitaes"), "capitao", "-ães nunca vira -ão");
});

test("plural irregular do pedido casa com o singular do catálogo (e vice-versa)", () => {
  const recarregavel = item("Pilha Recarregável 1000MHA Tipo AAA Elgin");
  const alcalina = item("Pilha Alcalina 1,5V Tipo AAA Elgin");
  assert.ok(scoreCatalogMatch("pilhas recarregáveis", recarregavel) > scoreCatalogMatch("pilhas recarregáveis", alcalina), "a recarregável tem que vencer a comum");
  assert.equal(conciergeMatchIsStrong("pilhas recarregáveis", recarregavel), true);
  assert.equal(conciergeMatchIsStrong("pilhas recarregáveis", alcalina), false);
  assert.ok(scoreCatalogMatch("papéis", item("Papel Higiênico Neve Folha Dupla")) > 0);
  assert.ok(scoreCatalogMatch("lençóis", item("Lençol de Elástico Casal 400 Fios")) > 0);
  assert.ok(scoreCatalogMatch("limões", item("Limão Tahiti Kg")) > 0);
  assert.ok(scoreCatalogMatch("batons", item("Batom Matte Vermelho Vult")) > 0);
  assert.ok(scoreCatalogMatch("pilha recarregável", item("Pilhas Recarregáveis AA Rayovac 2 Unidades")) > 0);
});

test("o plural não cria falso positivo em palavra curta nem em -ães", () => {
  assert.equal(scoreCatalogMatch("sal", item("Sais de Banho Lavanda 500g")), 0);
  assert.equal(scoreCatalogMatch("sais de banho", item("Sal Grosso Cisne 1kg")), 0);
  assert.equal(scoreCatalogMatch("presente dia das mães", item("Creme para Mãos Nivea 75ml")), scoreCatalogMatch("presente dia das", item("Creme para Mãos Nivea 75ml")), "'mães' não pontua em 'Mãos'");
});

test("alias: 'leite em pó para bebê' / 'leite infantil' buscam também 'fórmula infantil'; 'leite em pó' sozinho não", () => {
  assert.deepEqual(queryAliases("leite em pó para bebê"), ["formula infantil"]);
  assert.deepEqual(queryAliases("leite pra bebê"), ["formula infantil"]);
  assert.deepEqual(queryAliases("leite infantil"), ["formula infantil"]);
  assert.deepEqual(queryAliases("leite em pó de bebê Aptamil"), ["formula infantil aptamil"]);
  assert.deepEqual(queryAliases("leite em pó"), []);
  assert.deepEqual(queryAliases("leite ninho"), []);
});
