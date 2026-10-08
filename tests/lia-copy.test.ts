import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/lib/lia-copy";

const items = [
  { qty: 2, name: "Arroz Tio João 5kg", displayLineTotal: 55.0 },
  { qty: 1, name: "Óleo de Soja Liza 900ml", displayLineTotal: 8.79 }
];

test("concierge: recusa honesta, cotação pedida e resumo manual", () => {
  // Regra 11/08: item sem preço = "não tenho" na hora, nunca "anotei, vou cotar".
  const one = copy.itemsNotAvailable(["vedante de torneira"]);
  assert.match(one, /não achei em nenhuma loja/);
  assert.match(one, /vedante de torneira/);
  const many = copy.itemsNotAvailable(["vedante de torneira", "2x cadernos"]);
  assert.match(many, /não achei em nenhuma loja/);
  assert.match(many, /cadernos/);
  assert.doesNotMatch(many, /vou cotar|garimpar|Anotei/i);
  const noted = many;

  const requested = copy.operatorQuoteRequested(["1x cabo usb-c", "1x vela"]);
  // Explica POR QUE o total não saiu na hora (rodadas 2 e 11, 14/08) e o que acontece.
  assert.match(requested, /conferência|confere/i);
  assert.doesNotMatch(requested, /Total: R\$/); // nunca inventa total antes da cotação

  const summary = copy.manualQuoteSummary({
    items: [
      { qty: 1, name: "cabo usb-c" },
      { qty: 1, name: "vela de aniversário" }
    ],
    produtos: 55,
    frete: 12,
    deliveryPromise: "hoje até 19h",
    total: 67,
    deliveryAddress: "Rua das Flores, 123",
    sameHour: true
  });
  assert.match(summary, /1x cabo usb-c/);
  assert.match(summary, /Total: R\$ 67,00/);
  assert.match(summary, /hoje até 19h/);
  for (const t of [noted, requested, summary, copy.operatorQuoteStillWorking(), copy.conciergeAskWhatYouWant()]) {
    assert.doesNotMatch(t, /undefined|NaN|\[object/);
  }
});

test("summary: mostra itens, frete, total e itens não achados", () => {
  const text = copy.summary({
    items,
    produtos: 63.79,
    frete: 12.5,
    etaMinutes: 38,
    total: 76.29,
    notFound: ["azeite trufado"]
  });
  assert.match(text, /Seu pedido/);
  assert.match(text, /2x Arroz Tio João 5kg — R\$ 55,00/);
  assert.match(text, /R\$ 12,50/);
  assert.match(text, /Total: R\$ 76,29/);
  assert.match(text, /azeite trufado/);
  assert.match(text, /pagar/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test("pedido mínimo: diz quanto falta", () => {
  const text = copy.minimumOrder({ items, produtos: 20, displayMin: 33, falta: 13 });
  assert.match(text, /R\$ 33,00/);
  assert.match(text, /R\$ 13,00/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test("opções: numeradas com preço e instrução de resposta", () => {
  const text = copy.choicesText("leite", [
    { name: "Leite A", displayPrice: 5.99 },
    { name: "Leite B", displayPrice: 4.99 }
  ]);
  assert.match(text, /\*1\)\* Leite A — R\$ 5,99/);
  assert.match(text, /\*2\)\* Leite B — R\$ 4,99/);
  assert.match(text, /Responde \*1\* ou \*2\*/);
});

test("opções: prazo do anúncio aparece quando a vitrine o informa", () => {
  const text = copy.choicesText("cabo usb-c", [
    { name: "Cabo USB-C 2 m", displayPrice: 18.68, delivery: "chega hoje" }
  ]);
  assert.match(text, /chega hoje/);
});

test("pagamento: pix sem taxa, cartão com taxa, totais distintos", () => {
  const text = copy.paymentMethod(100, 105.25);
  assert.match(text, /Pix — R\$ 100,00/);
  assert.match(text, /Cartão — R\$ 105,25/);
  // O código Pix vai em mensagem SEPARADA (copiável) — a intro não o contém.
  const pix = copy.pixInstructions(100, true);
  assert.match(pix, /copia e cola/);
  assert.match(pix, /paguei/); // sandbox hint
  assert.doesNotMatch(pix, /00020126/);
  const pixReal = copy.pixInstructions(100, false);
  assert.doesNotMatch(pixReal, /sandbox/);
  const card = copy.cardInstructions(105.25, "https://mp.com/x", false);
  assert.match(card, /https:\/\/mp\.com\/x/);
  assert.match(card, /taxa/);
});

test("status: uma linha humana por estado do pedido", () => {
  for (const status of [
    "awaiting_payment",
    "paid",
    "retailer_preparing",
    "retailer_out_for_delivery",
    "operator_buying",
    "dispatched",
    "delivered",
    "refund_pending",
    "refunded",
    "canceled"
  ]) {
    const line = copy.orderStatusLine({ shortId: "ABC123", status });
    // Número do pedido não vai pro cliente (dono, 08/10 noite): "Seu pedido", ancorado por data/itens.
    assert.ok(line.startsWith("Seu pedido"), `${status} deve citar o pedido`);
    assert.ok(!line.includes("ABC123"), `${status} não pode mostrar o número`);
    assert.doesNotMatch(line, /undefined/);
  }
  const tracked = copy.orderStatusLine({ shortId: "ABC123", status: "dispatched", trackingUrl: "https://t.co/x" });
  assert.match(tracked, /https:\/\/t\.co\/x/);
  const retailerTracked = copy.orderStatusLine({
    shortId: "ABC123",
    status: "retailer_out_for_delivery",
    trackingUrl: "https://loja.example/rastreio"
  });
  assert.match(retailerTracked, /pela loja/);
  assert.match(retailerTracked, /https:\/\/loja\.example\/rastreio/);
  assert.doesNotMatch(copy.orderStatusLine({ shortId: "ABC123", status: "retailer_preparing" }), /motoboy/i);
});

test("todas as mensagens simples são não-vazias e sem placeholders", () => {
  const texts = [
    copy.greeting(),
    copy.thanks(),
    copy.help(),
    copy.didNotUnderstand(),
    copy.welcomeAskCep(),
    copy.welcomeAskCep(["2x Arroz"]),
    copy.askNewCep(),
    copy.cepNotFound("00000-000"),
    copy.searching(),
    copy.noMedicine(),
    copy.cartCleared(),
    copy.removeNotFound(),
    copy.emptyCartPay(),
    copy.paymentConfirmed(),
    copy.pixNotSeenYet(),
    copy.cardPending(),
    copy.alreadyPaid(),
    copy.noOrdersYet(),
    copy.canceledUnpaid(),
    copy.cancelRequestedPaid(),
    copy.cancelTooLate(),
    copy.nothingToCancel(),
    copy.noPreviousOrder(),
    copy.refundRequested(),
    copy.refundConfirmed(),
    copy.delivered(),
    copy.genericError()
  ];
  for (const t of texts) {
    assert.ok(t.trim().length > 10);
    assert.doesNotMatch(t, /undefined|NaN|\[object/);
  }
});

test("pós-venda: limpa antes do pagamento; pago desiste até a compra (11/09); depois só item faltando", () => {
  const beforePayment = copy.cancelHowTo(false);
  const afterPayment = copy.cancelHowTo(true);
  assert.match(beforePayment, /Antes de pagar/);
  assert.match(afterPayment, /devolvo o valor na hora/);
  assert.match(afterPayment, /não dá mais/);
  // Compra já feita na loja: a regra antiga continua nas duas entradas.
  assert.match(copy.cancelRequestedPaid(), /já foi feita na loja/);
  assert.match(copy.cancelRequestedPaid(), /estorno o valor dele/);
  assert.match(copy.cancelTooLate(), /atras/i);
  // A reclamação continua prometendo o estorno do item que faltou — o que saiu foi só a
  // frase "não fazemos substituições" (revisão de copy 17/08): é regra que só cabe quando
  // o cliente PEDE substituição, não em toda reclamação.
  assert.match(copy.complaintAck(), /estorno o valor dele/);
  assert.doesNotMatch(copy.help(), /cancelar/);
});

test("7º ciclo: confirmação de endereço mostra o CEP quando ele não está no texto", () => {
  assert.match(copy.addressUpdated("Rua Conceição, 233, Centro, Campinas - SP", "13010-050"), /13010-050/);
  // CEP já presente no texto não duplica.
  const dup = copy.addressUpdated("Rua X, 1, Centro, Campinas - SP, 13010-050", "13010-050");
  assert.equal((dup.match(/13010-050/g) ?? []).length, 1);
  // Sem CEP conhecido, mensagem de sempre.
  assert.doesNotMatch(copy.addressUpdated("Rua Y, 2, São Paulo - SP"), /CEP/);
});

test("acompanhamento: link do pedido na loja aparece já no aviso de compra", () => {
  // 17/08 (dono: "ele tem que poder ver e acompanhar"): nos pedidos que a LOJA entrega,
  // o operador não sabe a hora em que o pacote sai — então o rastreio tem que sair já na
  // compra, senão o cliente nunca recebe link nenhum.
  const url = "https://www.mercadolivre.com.br/vendas/123456/detalhe";
  for (const status of ["retailer_preparing", "operator_buying"]) {
    const comLink = copy.orderStatusLine({ shortId: "ABC123", status, trackingUrl: url });
    assert.ok(comLink.includes(url), `${status} devia mostrar o link: ${comLink}`);
    assert.match(comLink, /acompanha/i);
    // Sem link, a mensagem antiga continua valendo (nada de "Acompanha:" vazio).
    const semLink = copy.orderStatusLine({ shortId: "ABC123", status });
    assert.doesNotMatch(semLink, /acompanha|undefined|null/i);
    assert.match(semLink, /aviso quando sair/i);
  }
});

test("escolha de entrega: mostra TOTAL de cada opção com a data, e cobre anúncio sem data", () => {
  // O número que decide é o total (produtos com markup + frete), não o frete solto: é o que
  // sai da conta do cliente (dono, 17/08: perguntar caro-rápido × barato-demorado).
  const texto = copy.shippingSpeedChoice(
    { total: 365.88, estimate: "25/08" },
    { total: 376.88, estimate: "20/08" }
  );
  assert.match(texto, /Mais barata — total R\$ 365,88 · chega até 25\/08/);
  assert.match(texto, /Mais rápida — total R\$ 376,88 · chega até 20\/08/);
  assert.match(texto, /Toca no botão ou responde \*1\* ou \*2\*/);

  // Sem data publicada a Lia não inventa prazo — regra antiga do projeto.
  const semData = copy.shippingSpeedChoice({ total: 100, estimate: "30/08" }, { total: 130 });
  assert.match(semData, /sem data publicada/);
  assert.doesNotMatch(semData, /chega até undefined/);
});

test("cesta otimizada não diz '2 entregas em vez de 2' quando só redistribui lojas", () => {
  const sameCount = copy.bundledDeliveriesNote({
    moves: [{ fromName: "Leite A", fromStore: "Loja A", toName: "Leite B", toStore: "Loja B" }],
    storesBefore: 2,
    storesAfter: 2,
    saved: 6.82
  });
  assert.match(sameCount, /Reorganizei os itens entre as lojas/);
  assert.match(sameCount, /continuam 2 entregas/);
  assert.doesNotMatch(sameCount, /em vez de 2/);

  const reduced = copy.bundledDeliveriesNote({
    moves: [{ fromName: "Leite A", fromStore: "Loja A", toName: "Leite B", toStore: "Loja B" }],
    storesBefore: 2,
    storesAfter: 1,
    saved: 11.38
  });
  assert.match(reduced, /Juntei entregas/);
  assert.match(reduced, /1 entrega em vez de 2/);
});

// Caso real 15/09 (#5GUY4Z, Cobasi): a pergunta do número do pedido dizia "Mercado Livre"
// fixo, para QUALQUER loja. O nome da loja agora vem do job.
test("operador: pergunta do número do pedido nomeia a loja certa, nunca ML fixo", () => {
  const cobasi = copy.operatorAskStoreNumber("5GUY4Z", "Cobasi");
  assert.match(cobasi, /#5GUY4Z/);
  assert.match(cobasi, /Cobasi/);
  assert.doesNotMatch(cobasi, /Mercado Livre/i);
  assert.match(copy.operatorAskStoreNumber("ABC123", "Mercado Livre"), /Mercado Livre/);
  // Sem loja conhecida: nunca inventa um nome.
  assert.doesNotMatch(copy.operatorAskStoreNumber("ABC123"), /Mercado Livre|Cobasi/i);
  const saved = copy.operatorStoreNumberSaved("5GUY4Z", "4321567890", "Cobasi");
  assert.match(saved, /Cobasi/);
  assert.doesNotMatch(saved, /\bML\b|Mercado Livre/i);
});
