import { test } from "node:test";
import assert from "node:assert/strict";

import { queryAliases } from "../src/lib/stores/types";

// Rodada 2, g4 (09/10/2026): o cliente escreve o termo popular, o catálogo usa outro. Medido na busca real:
// "cerva", "cervejinha", "breja", "req", "ph", "omoo", "colgat", "gilette" davam "não achei"; "yogurte" trazia bala
// de iogurte; "papel filme" trazia papel alumínio; "manteiga" abria com manteiga de cacau (protetor labial);
// "ovo" abria com Kinder Ovo; "calabresa" com pimenta/snack; "pampers" com lenço umedecido.

const casos: Array<[string, string]> = [
  ["cerva", "cerveja"],
  ["2 cervas", "2 cerveja"],
  ["cervejinha", "cerveja"],
  ["breja gelada", "cerveja gelada"],
  ["req", "requeijao"],
  ["req vigor", "requeijao vigor"],
  ["ph", "papel higienico"],
  ["omoo", "omo"],
  ["colgat", "colgate"],
  ["pasta colgat", "pasta colgate"],
  ["gilette", "gillette"],
  ["yogurte", "iogurte"],
  ["yogurtes", "iogurte"],
  ["papel filme", "filme pvc"],
  ["calabresa", "linguica calabresa"],
  ["manteiga", "manteiga com sal"],
  ["ovo", "ovos"],
  ["sal", "sal refinado"],
  ["pampers", "fralda pampers"],
  ["huggies", "fralda huggies"],
  ["toddy", "achocolatado toddy"],
  ["nescau", "achocolatado nescau"]
];

for (const [pedido, esperado] of casos) {
  test(`sinônimo: "${pedido}" também busca "${esperado}"`, () => {
    assert.ok(queryAliases(pedido).includes(esperado), `${pedido} -> ${JSON.stringify(queryAliases(pedido))}`);
  });
}

test("sinônimos não viram produto errado: frases específicas e termos ambíguos ficam como o cliente escreveu", () => {
  for (const frase of [
    "massa", // pode ser massa de pastel, de lasanha ou corrida
    "massa corrida",
    "massa de lasanha",
    "cerveja skol",
    "manteiga de cacau",
    "manteiga com sal",
    "sal grosso",
    "ovos",
    "ovo de páscoa",
    "ph da piscina",
    "pampers premium care",
    "fralda pampers",
    "papel alumínio",
    "papel higiênico",
    "papel toalha",
    "calabresa defumada",
    "iogurte natural",
    "toddynho",
    "nescau cereal"
  ]) {
    assert.deepEqual(queryAliases(frase), [], `"${frase}" não deveria ganhar alias: ${JSON.stringify(queryAliases(frase))}`);
  }
});

test("coca continua virando coca cola e não quebra outra busca", () => {
  assert.ok(queryAliases("coca").includes("coca cola"));
  assert.ok(queryAliases("coca zero").includes("coca cola zero"));
  assert.deepEqual(queryAliases("arroz"), []);
  assert.deepEqual(queryAliases("sabonete"), []);
});
