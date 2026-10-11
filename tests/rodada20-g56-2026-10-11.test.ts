// Rodada 20, grupo G56 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada20/grupo-b.md (R20-3, R20-6, R20-8, R20-9)
// e grupo-a.md (R20a-5).
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedBrandFirst, packAdjusted } from "../src/lib/delivery-service";
import { christmasOffSeason, conciergeMatchIsStrong, productKindConflict, queryAliases, scoreCatalogMatch, stapleFor, unaskedChristmas, variantPenalty, type CatalogItem } from "../src/lib/stores/types";
import { tidyRepeatedName } from "../src/lib/stores/live-search";
import { CATALOG as COBASI } from "../src/lib/stores/cobasi-catalog";
import * as copy from "../src/lib/lia-copy";

const item = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({ sku: `t-${name}`, name, unitPrice: 10, unit: "un", ...extra }) as CatalogItem;

// ---------------------------------------------------------------- R20-3: troca da oferta de juntar mantém espécie

test("R20-3: Pedigree é ração de cachorro mesmo sem 'cães' no nome; a troca da ração de gato não a aceita", () => {
  const pedigree = item("Ração Seca Adulto Raças Pequenas e Mini Sabor Carne e Vegetais Pedigree 900g");
  const whiskas = item("Ração Seca para Gatos Adultos Sabor Carne Whiskas 900g");
  assert.equal(scoreCatalogMatch("ração gato adulto pequena", pedigree), 0);
  assert.ok(scoreCatalogMatch("ração gato adulto pequena", whiskas) > 0);
  // A checagem de tipo/espécie da oferta (offerCostlyDeliverySwap) usa o item da cesta + o pedido.
  assert.equal(productKindConflict("Ração Golden Gatos Adultos Carne 1 kg ração gato adulto pequena", pedigree.name), true);
  assert.equal(productKindConflict("Ração Golden Gatos Adultos Carne 1 kg ração gato adulto pequena", whiskas.name), false);
  // Marca de gato do lado do produto também; marca de cão e gato (Golden) e a areia Keldog Pipicat não ganham espécie.
  assert.equal(scoreCatalogMatch("ração cachorro adulto", item("Ração Friskies Adultos Carne 1kg")), 0);
  assert.ok(scoreCatalogMatch("areia gato", item("Areia Higiênica Keldog Pipicat Granulado Classic 4kg")) > 0);
  assert.equal(productKindConflict("Ração Golden Gatos Adultos", "Ração Golden Fórmula Adultos Frango 1kg"), false);
});

// ---------------------------------------------------------------- R20-6: mordedor e comedouro

test("R20-6: 'brinquedo de morder' e 'mordedor de borracha pra cachorro' acham o Mordedor do Cobasi", () => {
  const mordedor = COBASI.find((i) => i.sku === "cobasi-913111");
  assert.ok(mordedor, "catálogo Cobasi tem o Mordedor Abacaxi");
  for (const q of ["brinquedo de morder", "brinquedo de morder filhote de golden", "mordedor de borracha cachorro"]) {
    assert.ok(scoreCatalogMatch(q, mordedor!) > 0, q);
    assert.equal(conciergeMatchIsStrong(q, mordedor!), true, q);
  }
  // "filhote de golden" é o cachorro, não a ração Golden.
  assert.ok(queryAliases("brinquedo de morder filhote de golden").some((a) => a === "brinquedo mordedor filhote cachorro"));
});

test("R20-6: comedouro de pet não traz a tigela infantil de personagem; o de pet com personagem continua", () => {
  assert.equal(scoreCatalogMatch("comedouro", item("Comedouro - DC Comics - Tigela Melamina - Mulher Maravilha - Freefaro")), 0);
  assert.equal(scoreCatalogMatch("comedouro cachorro", item("Comedouro - DC Comics - Tigela Melamina - Mulher Maravilha - Freefaro")), 0);
  assert.ok(scoreCatalogMatch("comedouro", item("Comedouro ZC Pets Tamanho G Garfield")) > 0);
  assert.ok(scoreCatalogMatch("comedouro", item("Comedouro Alumínio Pesado NF Pet 150 ml")) > 0);
  // Quem pede o personagem recebe.
  assert.ok(scoreCatalogMatch("comedouro mulher maravilha", item("Comedouro - DC Comics - Tigela Melamina - Mulher Maravilha - Freefaro")) > 0);
});

// ---------------------------------------------------------------- R20-8: parafuso comum e marca pedida

test("R20-8: 'parafuso' solto prefere o de uso geral ao de vaso sanitário/telha, também com a IA (lead)", () => {
  const staple = stapleFor("parafuso");
  assert.equal(staple?.lead, true);
  const common = "Parafuso Atarraxante Phillips Cabeça Panela 3,9x32 Fixtil";
  assert.ok(staple!.prefer.test("parafuso atarraxante phillips cabeca panela 3 9x32 fixtil"));
  assert.equal(staple!.prefer.test("parafuso para vaso sanitario e bide b10 80mm inox"), false);
  assert.equal(staple!.prefer.test("parafuso para lavatorio e coluna com bucha"), false);
  assert.ok(variantPenalty("parafuso", "Parafuso Para Telha 5/16\" X 110mm 4 Peças Fixtil") > variantPenalty("parafuso", common));
  // Pedido com qualificador não é o básico solto.
  assert.equal(stapleFor("parafuso para telha"), undefined);
});

test("R20-8: 'sabonete Dove' abre com Dove mesmo quando a IA pôs o Nivea na frente", () => {
  const opts = [
    { item: { name: "Sabonete Pure Milk Fresh Nivea 90g", brand: "Nivea" } },
    { item: { name: "Sabonete em Barra Pele Sensível Dove 90g" } },
    { item: { name: "Sabonete Palmolive Naturals 85g", brand: "Palmolive" } },
    { item: { name: "Sabonete Orginal Cremoso 90g", brand: "Dove" } }
  ];
  const sorted = askedBrandFirst("sabonete Dove", opts).map((o) => o.item.name);
  assert.deepEqual(sorted, ["Sabonete em Barra Pele Sensível Dove 90g", "Sabonete Orginal Cremoso 90g", "Sabonete Pure Milk Fresh Nivea 90g", "Sabonete Palmolive Naturals 85g"]);
  // Sem marca no pedido, a ordem fica.
  assert.deepEqual(askedBrandFirst("sabonete", opts), opts);
});

// ---------------------------------------------------------------- R20-9: nome repetido e frete da oferta

test("R20-9: nome de catálogo com a 2ª descrição repetida sai uma vez (guardanapo Snob)", () => {
  assert.equal(tidyRepeatedName("Guardanapo Papel 33x33cm Snob 50 Unidades Folha Simples Macio Guardanapo Folha Simples Snob 33×33 cm 50 Unidades"), "Guardanapo Papel 33x33cm Snob 50 Unidades Folha Simples Macio");
  assert.equal(tidyRepeatedName("Barra de Chocolate Garoto Ao Leite 80g Clássico Barra de Chocolate ao Leite Garoto 80g"), "Barra de Chocolate Garoto Ao Leite 80g Clássico");
  // Nome sem repetição fica igual.
  for (const n of ["Leite em Pó Integral Ninho 380g Lata Instantâneo Enriquecido", "Kit Sabonete Dove 90g 3 unidades + Kit Shampoo Seda 325ml"]) assert.equal(tidyRepeatedName(n), n);
});

test("R20-9: o cabeçalho da oferta de juntar diz o frete que recebe (o do checkout, quando há)", () => {
  const header = copy.costlyDeliverySwapHeader("Ração Golden Gatos Adultos Carne 1 kg", "Cobasi", 7.9, 2, 25.6);
  assert.match(header, /~R\$ 25,60 de frete/);
  assert.match(header, /custa ~R\$ 7,90/);
});

// ---------------------------------------------------------------- R20a-5: Natal, apontador, aviso de frete

test("R20a-5: Natal fora de época é tema não pedido; novembro e dezembro são a época", () => {
  assert.equal(christmasOffSeason(new Date(2026, 9, 11)), true);
  assert.equal(christmasOffSeason(new Date(2026, 10, 5)), false);
  assert.equal(christmasOffSeason(new Date(2026, 11, 20)), false);
  assert.equal(unaskedChristmas("papel de presente", "Papel de Presente Natal 70x100cm Cromus Couchê 80g"), true);
  assert.equal(unaskedChristmas("papel de presente de natal", "Papel de Presente Natal 70x100cm Cromus Couchê 80g"), false);
  assert.equal(unaskedChristmas("papel de presente", "Papel Presente Diver 70x100 cm 100 Folhas Cromus Sortido"), false);
});

test("R20a-5: '2 apontadores' com o pacote de 2 vira 1 pacote, com o aviso", () => {
  const adjusted = packAdjusted("Apontador Simples Faber Castel 2 Unidades", 2, "apontador");
  assert.equal(adjusted.qty, 1);
  assert.match(adjusted.note ?? "", /Cada embalagem tem 2 unidades/);
  assert.equal(packAdjusted("Apontador com Depósito - Faber Castell - Azul", 2, "apontador").qty, 2);
});

test("R20a-5: frete acima da metade dos produtos avisa também com uma entrega só (911: R$ 22,45 para R$ 44,22)", () => {
  const note = copy.expensiveShippingNote(44.22, 22.45, 1);
  assert.equal(note.length, 1);
  assert.match(note[0], /passa da metade/);
  assert.equal(copy.expensiveShippingNote(100, 40, 1).length, 0);
  assert.match(copy.expensiveShippingNote(10, 15)[0], /entrega sai mais cara/);
});
