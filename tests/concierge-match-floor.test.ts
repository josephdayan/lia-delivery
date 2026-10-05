import { test } from "node:test";
import assert from "node:assert/strict";

import { conciergeMatchIsStrong, scoreCatalogMatch } from "../src/lib/stores/types";
import type { CatalogItem } from "../src/lib/stores/types";

// Piso de relevância do concierge. Existe porque, no concierge, um palpite errado é PIOR
// que nenhum palpite: quando a Lia não sugere nada, a linha vira livre e o operador
// garimpa — que é o resultado certo. O caso que motivou a regra é real: "conserto de
// torneira" casava com "Espumante Argentino Concerto Brut" (o fuzzy trata conserto≈concerto)
// e o cliente recebia vinho como resposta a um problema de encanamento.

const item = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  sku: `t-${name}`,
  name,
  unitPrice: 10,
  unit: "un",
  category: "geral",
  ...extra
});

const ESPUMANTE = item("Espumante Argentino Concerto Brut", { category: "vinhos espumantes" });

test("concierge: match fraco por fuzzy é recusado (conserto ≠ concerto)", () => {
  // O scorer legado aceita — é o piso permissivo dele que a regra nova corrige.
  assert.ok(scoreCatalogMatch("conserto torneira", ESPUMANTE) > 0, "premissa: o legado aceita");
  assert.equal(conciergeMatchIsStrong("conserto torneira", ESPUMANTE), false);
});

test("concierge: consulta curta exige cobertura total", () => {
  assert.equal(conciergeMatchIsStrong("vedante torneira", ESPUMANTE), false);
  assert.equal(conciergeMatchIsStrong("pilha aa", ESPUMANTE), false);
  // Uma palavra que É o produto passa.
  assert.equal(conciergeMatchIsStrong("arroz", item("Arroz Camil Tipo 1 1kg")), true);
  assert.equal(conciergeMatchIsStrong("coca cola", item("Refrigerante Coca Cola Lata 350ml")), true);
});

test("concierge: consulta longa tolera UM qualificador sem correspondência", () => {
  // "macia" não está no nome — o produto ainda é a escova de dente pedida.
  assert.equal(conciergeMatchIsStrong("escova de dente macia", item("Escova de Dente Colgate Twister")), true);
  assert.equal(
    conciergeMatchIsStrong("papel higienico folha dupla", item("Papel Higiênico Neve Folha Dupla 12 rolos")),
    true
  );
  // Mas duas palavras soltas já descaracterizam o pedido.
  assert.equal(conciergeMatchIsStrong("escova de limpar piscina funda", item("Escova de Dente Colgate Twister")), false);
});

test("concierge: erra para o lado seguro quando o nome da loja usa outra derivação", () => {
  // "dente" não casa com "Dental" no matcher, então sobram 2 palavras sem correspondência
  // e a opção não é mostrada. O item vira linha livre e o operador compra a escova macia —
  // resultado pior que sugerir, porém melhor que sugerir errado. Se um dia o matcher
  // aprender essa derivação, este teste passa a esperar `true`.
  assert.equal(conciergeMatchIsStrong("escova de dente macia", item("Escova Dental Colgate Twister")), false);
});

test("concierge: token de tamanho não conta como palavra sem correspondência", () => {
  // Pedir "2 litros" e receber 600ml é decisão de variante, não de identidade: o item
  // continua sendo a coca pedida, então a opção pode ser mostrada.
  assert.equal(conciergeMatchIsStrong("coca cola 2 litros", item("Refrigerante Coca Cola 600ml")), true);
});

test("concierge: marca conta como cobertura", () => {
  const racao = item("Ração Fórmula para Cães Adultos Frango", { brand: "Premier", category: "cachorro" });
  assert.equal(conciergeMatchIsStrong("racao premier", racao), true);
});

test("concierge: o piso nunca aceita o que o scorer já rejeitou (guardas de espécie/negação)", () => {
  const racaoGato = item("Ração para Gatos Adultos Salmão", { category: "gatos" });
  assert.equal(scoreCatalogMatch("racao para cachorro", racaoGato), 0);
  assert.equal(conciergeMatchIsStrong("racao para cachorro", racaoGato), false);
});

test("05/10: 'advil' prefere o Advil comum ao 'Advil Mulher' (variante de público só quando pedida)", async () => {
  const { scoreCatalogMatch } = await import("../src/lib/stores/types");
  const comum = { sku: "a", name: "Analgésico e Anti-inflamatório Advil 12h 600mg 2 Comprimidos", brand: "Advil", unitPrice: 8.65 };
  const mulher = { sku: "b", name: "Advil Mulher 400mg 2 Cápsulas Moles", brand: "Advil", unitPrice: 5.99 };
  assert.ok(scoreCatalogMatch("advil", comum) > scoreCatalogMatch("advil", mulher));
  assert.ok(scoreCatalogMatch("advil mulher", mulher) > scoreCatalogMatch("advil mulher", comum));
});
