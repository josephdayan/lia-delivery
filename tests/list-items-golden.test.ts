// Tabela-ouro da Etapa 1 (07/10/2026): quantos itens o cliente pediu. Entrada → itens esperados
// (quantidade, frase, decisão). A evidência de catálogo é um probe FAKE e determinístico; assim a
// tabela prova as regras 0–5 de src/lib/list-items.ts sem depender dos catálogos reais. Os poucos
// casos "smoke" no fim usam o probe real. Regra do projeto: contagem ruim vira caso aqui ANTES do conserto.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeShoppingLines, normalizeMsg, sharesProductNoun } from "../src/lib/lia-intents";
import { countDistinctItems, notedItemLabels, resolveListItems, type CatalogProbe } from "../src/lib/list-items";

const norm = (s: string) => normalizeMsg(s).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Frases que "acham produto forte" no catálogo fake.
const STRONG = new Set(
  [
    "arroz", "feijao", "cafe", "agua com gas", "agua sem gas", "sal", "pimenta", "coca", "fanta", "gelo", "red bull", "vodka", "vodkas",
    "suco de laranja", "shampoo", "condicionador", "shampoo pantene", "condicionador pantene", "tenis preto", "banana", "maca", "leite",
    "pao", "pao de queijo", "macarrao", "molho de tomate", "pizza", "refri", "cerveja", "sabao em po", "amaciante", "racao pra gato",
    "areia", "papel higienico", "papel toalha", "escova de dente", "pasta de dente", "pasta de dentii", "iscova de dente", "ruffles",
    "espeto de bambu", "sal grosso", "guardanapo", "copo descartavel", "cerveja skol", "cerveja brahma", "cebola", "tomate", "skol", "brahma"
  ].map(norm)
);
// Frases cujo LITERAL "A e B" existe como nome de produto no catálogo fake.
const LITERAL = new Set(["tenis preto e branco", "mac e cheese"].map(norm));

const probe: CatalogProbe = (phrase, opts) => {
  const n = norm(phrase);
  return { strong: opts?.all ? LITERAL.has(n) : STRONG.has(n) };
};
const BRANDS = new Set(["pantene", "dove", "lux", "fanta", "coca", "skol", "brahma", "colgate", "oral b", "rexona", "ruffles", "heineken"]);
const isBrand = (w: string) => BRANDS.has(norm(w));
const opts = { catalogProbe: probe, isBrand };

type Expected = [qty: number, phrase: string, decision?: string];
type Case = { input: string; items: Expected[]; reason?: string };

const CASES: Case[] = [
  // --- regra 1: nomes compostos e kits
  { input: "romeu e julieta", items: [[1, "romeu e julieta", "joined"]], reason: "nome_composto" },
  { input: "johnson & johnson", items: [[1, "johnson & johnson", "joined"]] },
  { input: "kit shampoo e condicionador", items: [[1, "kit shampoo e condicionador", "joined"]], reason: "kit" },
  { input: "cookies and cream", items: [[1, "cookies and cream", "single"]] },
  { input: "romeu e julieta e coca", items: [[1, "romeu e julieta", "joined"], [1, "coca", "split"]] },
  // --- sem conjunção
  { input: "pão de queijo", items: [[1, "pão de queijo", "single"]] },
  { input: "leite integral", items: [[1, "leite integral", "single"]] },
  // --- regra 4: dois produtos diferentes
  { input: "arroz e feijão", items: [[1, "arroz", "split"], [1, "feijão", "split"]], reason: "catalogo_ambos" },
  { input: "Arroz E Feijão", items: [[1, "Arroz", "split"], [1, "Feijão", "split"]] },
  { input: "água com gás e café", items: [[1, "água com gás", "split"], [1, "café", "split"]] },
  { input: "coca e fanta", items: [[1, "coca", "split"], [1, "fanta", "split"]] },
  { input: "sal e pimenta", items: [[1, "sal", "split"], [1, "pimenta", "split"]] },
  { input: "banana e maçã", items: [[1, "banana", "split"], [1, "maçã", "split"]] },
  { input: "pizza + coca", items: [[1, "pizza", "split"], [1, "coca", "split"]] },
  { input: "macarrão e molho de tomate", items: [[1, "macarrão", "split"], [1, "molho de tomate", "split"]] },
  { input: "sabão em pó e amaciante", items: [[1, "sabão em pó", "split"], [1, "amaciante", "split"]] },
  { input: "papel higiênico e papel toalha", items: [[1, "papel higiênico", "split"], [1, "papel toalha", "split"]] },
  { input: "ração pra gato e areia", items: [[1, "ração pra gato", "split"], [1, "areia", "split"]] },
  { input: "shampoo & condicionador", items: [[1, "shampoo", "split"], [1, "condicionador", "split"]] },
  { input: "pão de queijo e coca", items: [[1, "pão de queijo", "split"], [1, "coca", "split"]] },
  { input: "cerveja e refri", items: [[1, "cerveja", "split"], [1, "refri", "split"]] },
  // --- regra 4: nenhum acha / só um acha / só o literal acha / dúvida
  { input: "xyz e abc", items: [[1, "xyz", "split"], [1, "abc", "split"]], reason: "nenhum_acha" },
  { input: "pão e manteiga", items: [[1, "pão", "split"], [1, "manteiga", "split"]], reason: "ambiguo" },
  { input: "mac e cheese", items: [[1, "mac e cheese", "joined"]], reason: "catalogo_literal" },
  // --- regra 2: cauda só de atributo herda o substantivo
  { input: "leite integral e desnatado", items: [[1, "leite integral", "inherited_head"], [1, "leite desnatado", "inherited_head"]], reason: "cauda_so_atributo" },
  { input: "sabonete dove e lux", items: [[1, "sabonete dove", "inherited_head"], [1, "sabonete lux", "inherited_head"]] },
  { input: "biscoito de chocolate e morango", items: [[1, "biscoito de chocolate", "inherited_head"], [1, "biscoito de morango", "inherited_head"]] },
  { input: "suco de laranja e maçã", items: [[1, "suco de laranja", "inherited_head"], [1, "suco de maçã", "inherited_head"]] },
  { input: "pilha aa e aaa", items: [[1, "pilha aa", "inherited_head"], [1, "pilha aaa", "inherited_head"]] },
  { input: "pilha aaa e aa", items: [[1, "pilha aaa", "inherited_head"], [1, "pilha aa", "inherited_head"]] },
  { input: "tinta branca e preta", items: [[1, "tinta branca", "inherited_head"], [1, "tinta preta", "inherited_head"]] },
  { input: "fralda m e g", items: [[1, "fralda m", "inherited_head"], [1, "fralda g", "inherited_head"]] },
  { input: "cerveja skol e brahma", items: [[1, "cerveja skol", "inherited_head"], [1, "cerveja brahma", "inherited_head"]] },
  { input: "pasta de dente colgate e oral b", items: [[1, "pasta de dente colgate", "inherited_head"], [1, "pasta de dente oral b", "inherited_head"]] },
  { input: "água com gás e sem gás", items: [[1, "água com gás", "inherited_head"], [1, "água sem gás", "inherited_head"]] },
  { input: "3 leite integral e desnatado", items: [[3, "leite integral", "inherited_head"], [1, "leite desnatado", "inherited_head"]] },
  // exceção: o catálogo tem o literal e a cauda sozinha não acha nada
  { input: "tênis preto e branco", items: [[1, "tênis preto e branco", "joined"]], reason: "literal_no_catalogo" },
  // --- regra 3: marca compartilhada no fim
  { input: "shampoo e condicionador pantene", items: [[1, "shampoo pantene", "brand_shared"], [1, "condicionador pantene", "brand_shared"]], reason: "marca_no_fim" },
  { input: "shampoo e condicionador da pantene", items: [[1, "shampoo pantene", "brand_shared"], [1, "condicionador pantene", "brand_shared"]] },
  { input: "shampoo e condicionador, ambos pantene", items: [[1, "shampoo pantene", "brand_shared"], [1, "condicionador pantene", "brand_shared"]], reason: "ambos_marca" },
  { input: "quero shampoo e condicionador, os dois da pantene", items: [[1, "shampoo pantene", "brand_shared"], [1, "condicionador pantene", "brand_shared"]] },
  { input: "shampoo pantene e condicionador pantene", items: [[1, "shampoo pantene", "split"], [1, "condicionador pantene", "split"]] },
  // --- regra 0: pedaços sem substantivo
  { input: "2 e 3", items: [] },
  { input: "um e outro", items: [] },
  { input: "oi lia, bom dia e tudo bem", items: [] },
  // restrições e conversa nunca grudam num vizinho nem viram item
  { input: "arroz e se tiver feijão", items: [[1, "arroz"]] },
  { input: "arroz e pra hoje", items: [[1, "arroz"]] },
  // --- quantidade própria na cauda
  { input: "2 leites e 3 pães", items: [[2, "leites", "split"], [3, "pães", "split"]], reason: "qty_propria" },
  { input: "dois pães e um café", items: [[2, "pães", "split"], [1, "café", "split"]] },
  { input: "2 coca / 1 shampoo / 2 sabonete", items: [[2, "coca"], [1, "shampoo"], [2, "sabonete"]] },
  // --- limpezas de gíria e orçamento
  { input: "mn qro 2 coca zero de 2l e 1 ruffles", items: [[2, "coca zero 2l", "split"], [1, "ruffles", "split"]] },
  { input: "mn kero 3 skol e 2 brahma", items: [[3, "skol", "split"], [2, "brahma", "split"]] },
  { input: "kero pasta de dentii e uma iscova de dente", items: [[1, "pasta de dentii", "split"], [1, "iscova de dente", "split"]] },
  { input: "tenho 150 reais, quero 2 cervejas", items: [[2, "cervejas"]] },
  { input: "quero 2 vodkas tenho uns 120 reais 3 sucos", items: [[2, "vodkas até 120 reais"], [3, "sucos"]] },
  { input: "quero dar um presente pra minha mãe, tenho uns 120 reais no total com a entrega", items: [[1, "dar um presente pra minha mãe até 120 reais"]] },
  // --- lista longa e narrada
  { input: "2 vodkas, 3 sucos de laranja, 3 red bull e gelo", items: [[2, "vodkas"], [3, "sucos de laranja"], [3, "red bull", "split"], [1, "gelo", "split"]] },
  {
    // c94: churrasco narrado — só os 4 produtos, nenhuma frase-lixo ("uns 20 convidados", "nao esquece nada", "minha mulher…")
    input:
      "galera vou fazer um churrasco no domingo com a familia toda aqui em casa, uns 20 convidados. preciso comprar espeto de bambu, sal grosso, guardanapo e copo descartavel pra todo mundo. nao esquece nada pfv, minha mulher vai me matar se faltar alguma coisa",
    items: [[1, "espeto de bambu"], [1, "sal grosso"], [1, "guardanapo"], [1, "copo descartavel"]]
  }
];

for (const c of CASES) {
  test(`lista: "${c.input.slice(0, 70)}"`, () => {
    const got = resolveListItems(c.input, opts);
    assert.deepEqual(
      got.map((l) => [l.qty, norm(l.phrase)]),
      c.items.map(([q, p]) => [q, norm(p)]),
      `itens de "${c.input}": ${JSON.stringify(got.map((l) => `${l.qty}x ${l.phrase} [${l.decision}:${l.reason}]`))}`
    );
    c.items.forEach(([, , decision], i) => {
      if (decision) assert.equal(got[i].decision, decision, `decisão do item ${i + 1} de "${c.input}" (${got[i].reason})`);
    });
    if (c.reason) assert.ok(got.some((l) => l.reason === c.reason), `motivo esperado ${c.reason}, veio ${got.map((l) => l.reason).join(",")}`);
    assert.equal(countDistinctItems(c.input, opts), c.items.length);
  });
}

test("toda linha carrega decision, reason e span", () => {
  for (const c of CASES) {
    for (const line of resolveListItems(c.input, opts)) {
      assert.ok(line.decision && line.reason && line.span, `${c.input} → ${JSON.stringify(line)}`);
    }
  }
});

test("quantidades explícitas do trecho são preservadas e o rótulo do 'Já anotei' sai no formato 2x frase", () => {
  assert.deepEqual(notedItemLabels("2 vodkas, 3 sucos de laranja, 3 red bull e gelo", opts), ["2x vodkas", "3x sucos de laranja", "3x red bull", "1x gelo"]);
});

test("span guarda o trecho original do cliente nos dois itens separados", () => {
  const got = resolveListItems("leite integral e desnatado", opts);
  assert.deepEqual(got.map((l) => l.span), ["leite integral e desnatado", "leite integral e desnatado"]);
});

// ---------- IA × determinístico: no mesmo trecho, quem decide é a evidência do catálogo ----------

test("IA separa 'romeu e julieta', o catálogo/dicionário diz 1: vale 1", () => {
  const det = resolveListItems("romeu e julieta", opts);
  const merged = mergeShoppingLines([{ phrase: "romeu", qty: 1 }, { phrase: "julieta", qty: 1 }], det);
  assert.deepEqual(merged.map((l) => l.phrase), ["romeu e julieta"]);
});

test("IA junta 'suco de laranja e maçã' em 1 linha, o determinístico enxerga 2: vale 2", () => {
  const det = resolveListItems("suco de laranja e maçã", opts);
  const merged = mergeShoppingLines([{ phrase: "suco de laranja e maçã", qty: 1 }], det);
  assert.deepEqual(merged.map((l) => l.phrase), ["suco de laranja", "suco de maçã"]);
});

test("IA concorda na contagem: continua canonizando sinônimos ('creme dental')", () => {
  const det = resolveListItems("pasta de dente e escova de dente", opts);
  const merged = mergeShoppingLines([{ phrase: "creme dental", qty: 1 }, { phrase: "escova de dente", qty: 1 }], det);
  assert.deepEqual(merged.map((l) => l.phrase), ["creme dental", "escova de dente"]);
});

test("resolveListItems com aiItems reconcilia no mesmo caminho", () => {
  const got = resolveListItems("sal e pimenta", { ...opts, aiItems: [{ phrase: "sal", qty: 1 }] });
  assert.deepEqual(got.map((l) => [l.qty, l.phrase]), [[1, "sal"], [1, "pimenta"]]);
});

test("palavra curta ('sal', 'mel') não entra duplicada nem é coberta por outro produto", () => {
  assert.equal(sharesProductNoun("sal", "sal"), true);
  assert.equal(sharesProductNoun("mel", "mel"), true);
  assert.equal(sharesProductNoun("pão de sal", "sal"), false);
  assert.equal(sharesProductNoun("sal", "mel"), false);
  // determinístico tem "sal" e "pimenta", a IA devolveu só "sal grosso": o "sal" curto já está coberto
  const merged = mergeShoppingLines([{ phrase: "sal grosso", qty: 1 }], [{ phrase: "sal", qty: 1 }, { phrase: "pimenta", qty: 1 }]);
  assert.deepEqual(merged.map((l) => l.phrase), ["sal grosso", "pimenta"]);
});

// ---------- smoke com o probe REAL (catálogos locais) ----------

test("smoke com catálogos reais: nome composto, dois produtos, cauda de atributo e marca no fim", () => {
  const phrases = (t: string) => resolveListItems(t).map((l) => l.phrase);
  assert.deepEqual(phrases("romeu e julieta"), ["romeu e julieta"]);
  assert.equal(countDistinctItems("arroz e feijão"), 2);
  assert.equal(countDistinctItems("pão de queijo"), 1);
  assert.deepEqual(phrases("leite integral e desnatado"), ["leite integral", "leite desnatado"]);
  assert.equal(countDistinctItems("2 e 3"), 0);
  assert.equal(countDistinctItems("2 vodkas, 3 sucos de laranja, 3 red bull e gelo"), 4);
});
