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
