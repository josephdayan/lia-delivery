import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBasketLines, parseChoiceCombo } from "../src/lib/lia-intents";

const omo = [
  { name: "Lava Roupas em Pó Lavagem Perfeita Omo 1,4kg", unitPrice: 20.79 },
  { name: "Lava Roupas em Pó Primavera Tixan Ypê 1,6kg", unitPrice: 28.58 }
];

test("c34: ' / ' separa itens e cada um mantém a SUA quantidade", () => {
  const lines = parseBasketLines("2 coca cola / 1 shampoo / 2 sabonete");
  assert.deepEqual(lines.map((l) => [l.phrase, l.qty]), [["coca cola", 2], ["shampoo", 1], ["sabonete", 2]]);
  // fração e medida não são separador
  assert.deepEqual(parseBasketLines("1/2 litro de leite").map((l) => l.qty), [1]);
});

test("c12: 'vou no 1, Omo 1,4kg' é escolha com eco do nome — não um item novo", () => {
  const combo = parseChoiceCombo("Acho que vou no 1, Omo 1,4kg.", omo);
  assert.equal(combo?.reply.index, 0);
  assert.equal(combo?.rest, undefined);
  assert.equal(combo?.pay, undefined);
});

test("escolha + item NOVO continua somando o item (regressão da varredura de 06/10)", () => {
  const combo = parseChoiceCombo("quero o 2 e um sabonete", omo);
  assert.equal(combo?.reply.index, 1);
  assert.match(combo?.rest ?? "", /sabonete/);
  assert.equal(parseChoiceCombo("o 1, pode pagar no pix", omo)?.pay, true);
});

test("c28/c40: depois de 'não achei', 'tenta de novo' refaz e 'uma Wilson' é fragmento do pedido anterior", async () => {
  const { parseMissFollowUp } = await import("../src/lib/lia-intents");
  for (const t of ["tenta de novo", "Pode ser qualquer marca, tenta de novo.", "outra marca", "procura de novo por favor", "tanto faz a marca"]) {
    assert.deepEqual(parseMissFollowUp(t), { kind: "retry" }, t);
  }
  assert.deepEqual(parseMissFollowUp("Pode tentar uma Wilson?"), { kind: "fragment", words: "wilson" });
  assert.deepEqual(parseMissFollowUp("e da Babolat?"), { kind: "fragment", words: "babolat" });
  // pedido novo, número, frase longa: nunca é continuação
  for (const t of ["quero leite", "2 leites", "pode cancelar", "oi", "status do pedido", "Uma bola de tênis Wilson de 4 unidades por favor"]) {
    assert.equal(parseMissFollowUp(t), null, t);
  }
  const { missStillNone } = await import("../src/lib/lia-copy");
  assert.match(missStillNone("bola de tênis"), /Procurei de novo.*bola de tênis/);
});

test("c38: lugar de entrega no pedido não vira item", () => {
  assert.deepEqual(parseBasketLines("quero escova de dente, entrega em belo horizonte").map((l) => l.phrase), ["escova de dente"]);
  assert.deepEqual(parseBasketLines("2 coca, 1 sabonete, entregar na minha casa").map((l) => [l.phrase, l.qty]), [["coca", 2], ["sabonete", 1]]);
  // produto que contém a palavra continua produto
  assert.deepEqual(parseBasketLines("quero uma caixa de entrega").map((l) => l.phrase), ["caixa de entrega"]);
});

test("c23: o orçamento da mensagem sobrevive quando a IA troca 'presente' pelo produto", async () => {
  const { mergeShoppingLines, splitPriceCap } = await import("../src/lib/lia-intents");
  const det = parseBasketLines("quero dar um presente pra minha mãe, uns 100 reais");
  const merged = mergeShoppingLines([{ phrase: "perfume feminino", qty: 1 }], det);
  assert.equal(merged.length, 1);
  assert.deepEqual(splitPriceCap(merged[0].phrase), { phrase: "perfume feminino", cap: 100 });
  // várias linhas dos dois lados: o teto só vai pra linha gêmea, nunca é espalhado
  const two = mergeShoppingLines([{ phrase: "arroz", qty: 1 }, { phrase: "feijão", qty: 1 }], parseBasketLines("arroz até 30 reais, feijão"));
  assert.equal(splitPriceCap(two[1].phrase).cap, null);
});

test("c10: 'por favor' não é cláusula de comando ('tira a fita crepe, por favor' é UMA ordem)", async () => {
  const { splitCommandClauses } = await import("../src/lib/lia-intents");
  assert.deepEqual(splitCommandClauses("Tira a fita crepe, por favor."), ["tira a fita crepe, por favor."]);
  assert.deepEqual(splitCommandClauses("tira o arroz, por enquanto"), ["tira o arroz, por enquanto"]);
  // ordens compostas de verdade continuam separadas
  assert.deepEqual(splitCommandClauses("tira o café e bota 2 leites"), ["tira o cafe", "bota 2 leites"]);
  assert.equal(splitCommandClauses("troca o arroz por integral, tira o café, por favor").length, 2);
});

test("c13: 'vou aguardar essas informações' não é pedido", async () => {
  const { detectIntent } = await import("../src/lib/lia-intents");
  for (const t of ["vou aguardar essas informações", "Ok, vou esperar o responsável", "fico aguardando"]) assert.deepEqual(detectIntent(t), { kind: "thanks" }, t);
  for (const t of ["vou querer arroz", "vou esperar chegar pra pedir o leite?"]) assert.notDeepEqual(detectIntent(t), { kind: "thanks" }, t);
});

test("c14: 'o mais barato que tiver' é pedido, não pergunta de comparação de preço", async () => {
  const { detectIntent, parseBasketLines } = await import("../src/lib/lia-intents");
  assert.equal(detectIntent("Um desodorante, o mais barato que tiver.").kind, "free_text");
  assert.deepEqual(parseBasketLines("Um desodorante, o mais barato que tiver.").map((l) => l.phrase), ["desodorante"]);
  // a pergunta de comparação de verdade continua
  assert.deepEqual(detectIntent("você faz comparativo de preços?"), { kind: "service_question", topic: "price_compare" });
  const { priceCompareAnswer } = await import("../src/lib/lia-copy");
  assert.doesNotMatch(priceCompareAnswer(false), /Responde \*mais barato\*/);
  assert.match(priceCompareAnswer(true), /Responde \*mais barato\*/);
});

test("c02: 'pode tentar procurar em outra loja' depois de 'não achei' é retry, não produto", async () => {
  const { parseMissFollowUp } = await import("../src/lib/lia-intents");
  assert.deepEqual(parseMissFollowUp("Pode tentar procurar em outra loja?"), { kind: "retry" });
  assert.deepEqual(parseMissFollowUp("procura em outro site"), { kind: "retry" });
});
