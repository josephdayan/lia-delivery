// Rodada de cliente (dono, 09/10: "os detalhes óbvios já eram pra ter sido corrigidos"): roteiro com lojas reais
// pelo fluxo inteiro (lista → formulário → prazo → pagar → Pix/cartão → status → cancelar; recomendação; cadastro).
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/lib/lia-copy";
import { parseHouseNumberReply } from "../src/lib/address-parse";
import { queryAliases } from "../src/lib/stores/types";
import { dedupeProductName } from "../src/lib/delivery-service";

test("prazo como o cliente lê: sem 'pela própria loja · prazo da loja: em até 9h (…)'", () => {
  assert.equal(copy.promiseForCustomer("pela própria loja · prazo da loja: em até 9h (hoje, 12h–15h)"), "hoje, 12h–15h");
  assert.equal(copy.promiseForCustomer("pela própria loja (2 entregas) · prazo da loja: 1 dia útil"), "2 entregas · 1 dia útil");
  assert.equal(copy.promiseForCustomer("pela própria loja · prazo da loja: 30 min"), "30 min");
  const s = copy.summary({ items: [{ qty: 1, name: "Chocolate", displayLineTotal: 5.6 }], produtos: 5.6, frete: 6.9, total: 12.5, deliveryPromise: "pela própria loja · prazo da loja: 30 min" });
  assert.match(s, /Entrega: R\$ ?6,90 · 30 min/);
  assert.doesNotMatch(s, /prazo da loja|pela própria loja/);
  assert.equal(copy.basketEtaAnswer([{ store: "Mambo", when: "em até 9h (hoje, 12h–15h)" }]).split("\n")[0], "A *Mambo* entrega *hoje, 12h–15h* pro seu endereço, contado da compra.");
  assert.equal(copy.basketEtaAnswer([{ store: "Drogal", when: "3h" }]).split("\n")[0], "A *Drogal* entrega em *3h* pro seu endereço, contado da compra.");
  assert.equal(copy.orderDeliveryInfo({ stores: ["Drogal"], promise: "pela própria loja · prazo da loja: 30 min" }), "🚚 Loja *Drogal* · 30 min");
});

test("troca cartão→Pix depois do aviso: a 2ª mensagem não repete 'troquei'", () => {
  assert.equal(copy.paymentSwitched("pix", 12.5, false, true), "Total *R$ 12,50* no Pix, sem taxa. Segue o código 👇");
  assert.match(copy.paymentSwitched("pix", 12.5), /Troquei pra Pix/);
});

test("endereço: rua do CEP reconhecida com 1 letra de diferença e abreviação (Souza × Sousa, Eng)", () => {
  const place = { street: "Rua Engenheiro Edgar Egídio de Sousa", district: "Santa Cecília", city: "São Paulo" };
  assert.deepEqual(parseHouseNumberReply("rua engenheiro edgar egidio de souza 221 ap 13", place), { numero: "221", complemento: "ap 13" });
  assert.deepEqual(parseHouseNumberReply("Rua Eng Edgar Egidio de Souza, 221", place), { numero: "221" });
  assert.equal(parseHouseNumberReply("rua augusta 100", place), null, "outra rua não casa");
});

test("marca escrita do jeito que se fala acha o produto: red bul, absolute, cocas", () => {
  assert.deepEqual(queryAliases("red bul"), ["red bull"]);
  assert.deepEqual(queryAliases("vodka absolute"), ["vodka absolut"]);
  assert.deepEqual(queryAliases("cocas"), ["coca cola"]);
});

test("nome de produto repetido pela loja é limpo; nome normal fica igual", () => {
  assert.equal(dedupeProductName("Energético Energy Drink Red Bull 250ml Energético Red Bull Energy Drink 250ml"), "Energético Energy Drink Red Bull 250ml");
  assert.equal(dedupeProductName("Kit Shampoo Kit Condicionador"), "Kit Shampoo Kit Condicionador");
  assert.equal(dedupeProductName("Leite Integral Piracanjuba 1 Litro"), "Leite Integral Piracanjuba 1 Litro");
});

test("acessório com nome de marca não é o produto ('2 cocas' → nunca 'Copo Vidro Coca-Cola')", async () => {
  const { conciergeMatchIsStrong } = await import("../src/lib/stores/types");
  const it = (name: string) => ({ sku: "x", name, unitPrice: 5 }) as never;
  assert.equal(conciergeMatchIsStrong("coca cola", it("Copo Vidro 345ml Americano Coca-Cola Nadir Colecionável")), false);
  assert.equal(conciergeMatchIsStrong("coca cola", it("Coca Cola 220ml")), true);
  assert.equal(conciergeMatchIsStrong("copo coca cola", it("Copo Vidro 345ml Americano Coca-Cola Nadir Colecionável")), true, "pediu o copo: vale");
  assert.equal(conciergeMatchIsStrong("shampoo", it("Kit Shampoo e Condicionador Seda")), true, "kit continua valendo");
});

test("'cancela o pedido que paguei' é cancelamento (não 'seu pagamento já está confirmado')", async () => {
  const { detectIntent } = await import("../src/lib/lia-intents");
  for (const t of ["cancela o pedido que paguei", "paguei mas quero cancelar", "desisti do pedido que paguei"]) {
    assert.deepEqual(detectIntent(t), { kind: "cancel", explicitOrder: true }, t);
  }
  assert.equal(detectIntent("já paguei").kind, "paid_claim");
});

test("horário de atendimento não é prazo de entrega; 'que horas chega' continua prazo", async () => {
  const { detectIntent } = await import("../src/lib/lia-intents");
  for (const t of ["qual o horário de vocês?", "vcs abrem que horas?", "vocês funcionam domingo?", "até que horas vocês atendem?"]) {
    assert.deepEqual(detectIntent(t), { kind: "service_question", topic: "hours" }, t);
  }
  assert.notEqual((detectIntent("que horas chega?") as { topic?: string }).topic, "hours");
  assert.match(copy.serviceAnswer("hours", "SP"), /qualquer hora/);
});

test("'vocês entregam no rio?' com opções na tela é pergunta de área, não prazo das opções", async () => {
  const { detectIntent, parseChoiceEtaAsk } = await import("../src/lib/lia-intents");
  assert.equal(parseChoiceEtaAsk("vocês entregam no rio?"), null);
  assert.equal(parseChoiceEtaAsk("entrega em campinas?"), null);
  assert.deepEqual(detectIntent("vocês entregam no rio?"), { kind: "service_question", topic: "area" });
  assert.deepEqual(parseChoiceEtaAsk("o 2 chega hoje?"), { option: 2, today: true });
  assert.ok(parseChoiceEtaAsk("vocês entregam em quanto tempo?"));
});

test("pergunta de lado com os cards na tela: uma linha lembra a escolha (sem reenviar o carrossel)", () => {
  const t = copy.choicesStillOpen("sabonete dove");
  assert.match(t, /sabonete dove/);
  assert.doesNotMatch(t, /Olha o que achei/);
});
