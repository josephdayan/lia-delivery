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

test("item do dia a dia sem qualificador: 'óleo' é de cozinha (soja primeiro), 'feijão' é o carioca", async () => {
  const { conciergeMatchIsStrong, variantPenalty, queryAliases: aliases } = await import("../src/lib/stores/types");
  const it = (name: string) => ({ sku: "x", name, unitPrice: 5 }) as never;
  assert.equal(conciergeMatchIsStrong("óleo", it("Óleo Secante Color")), false);
  assert.equal(conciergeMatchIsStrong("óleo", it("Óleo Corporal Paixão Flor de Baunilha 100ml")), false);
  assert.equal(conciergeMatchIsStrong("óleo", it("Oleo Hidratante Corporal Farmax 100ml Girassol")), false);
  assert.equal(conciergeMatchIsStrong("óleo", it("Óleo de Soja Soya 900ml")), true);
  assert.equal(conciergeMatchIsStrong("óleo de coco", it("Óleo de Coco Extra Virgem 200ml")), true, "com qualificador vale o pedido");
  assert.ok(variantPenalty("óleo", "Óleo de Girassol Liza 900ml") > variantPenalty("óleo", "Óleo de Soja Liza 900ml"));
  assert.ok(variantPenalty("feijão", "Feijão Vermelho Urbano 500g") > variantPenalty("feijão", "Feijão Carioca Swift 1kg"));
  assert.ok(variantPenalty("feijão", "Feijão Carioca Pronto Com Tempero Camil 380g") > variantPenalty("feijão", "Feijão Carioca Swift 1kg"));
  assert.deepEqual(aliases("óleo"), ["oleo de soja"]);
});

test("'o sabonete pode ser o mais barato' é pedido do mais barato DAQUELE item da lista", async () => {
  const { parseItemCheapest } = await import("../src/lib/lia-intents");
  assert.equal(parseItemCheapest("o sabonete pode ser o mais barato"), "sabonete");
  assert.equal(parseItemCheapest("troca o shampoo pelo mais barato"), "shampoo");
  assert.equal(parseItemCheapest("pode ser o mais barato do arroz"), "arroz");
  assert.equal(parseItemCheapest("qual o mais barato?"), null);
  assert.equal(parseItemCheapest("pode ser o mais barato"), null);
  assert.match(copy.itemCheapestAnswer({ item: "sabonete", name: "Sabonete Dove 90g", price: 5.71, where: "Americanas · 1 dia útil", already: true }), /já está o mais barato/);
});

test("horário de atendimento não passa pela IA (ela perguntava 'da Lia ou da loja?')", async () => {
  const { dialogueBypassReason } = await import("../src/lib/dialogue");
  const { detectIntent } = await import("../src/lib/lia-intents");
  const text = "qual o horário de vocês?";
  assert.equal(dialogueBypassReason({ text, intent: detectIntent(text), ctx: { step: "choosing" } as never, hasAddress: true, looksLikeList: false }), "intent:hours");
});

test("'a ração tem que ser de 3kg' é troca de tamanho do item da lista", async () => {
  const { parseItemSize } = await import("../src/lib/lia-intents");
  assert.deepEqual(parseItemSize("a ração tem que ser de 3kg"), { item: "racao", size: "3kg" });
  assert.deepEqual(parseItemSize("quero a ração de 3 quilos"), { item: "racao", size: "3kg" });
  assert.deepEqual(parseItemSize("o leite de 2 litros"), { item: "leite", size: "2l" });
  assert.equal(parseItemSize("quero 3kg"), null);
  assert.match(copy.swapRemovedPrefix("Ração Pitukats 1kg", "ração gato 3kg"), /Tirei \*Ração Pitukats 1kg\*.*ração gato 3kg.*no lugar/);
});

test("lista comprida numa mensagem (13 itens, >120 caracteres) é lista — não passa pela IA do diálogo, que corta em 3", async () => {
  const { isPlainShoppingList } = await import("../src/lib/dialogue");
  const t = "petisco pedigree dentastix, lingua de gato kopenhagen, massinha play doh, carrinho hot wheels, esmalte risqué, shampoo seda, sabonete granado, pilha duracell aa, fita isolante, garrafa térmica 1 litro, lasanha swift, tinta guache, azeite andorinha";
  assert.ok(t.length > 120);
  assert.equal(isPlainShoppingList(t), true);
  assert.equal(isPlainShoppingList("ah legal, queria um sabão em pó, pode ser daqueles mais em conta, e também uma esponja e um detergente bom pra louça"), false);
});

test("petisco Pedigree não dispara 'quem leva ração costuma levar um petisco'", async () => {
  const { suggestComplement } = await import("../src/lib/recommend/complement");
  const out = suggestComplement([{ name: "Petisco Pedigree Dentastix Cuidado Oral Cães Adultos 3 unidades" } as never], { shelfById: () => ({ id: "pet.petisco_cachorro" }) as never });
  assert.equal(out, null);
});
