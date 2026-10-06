// A Meta mede o corpo do card JÁ HIDRATADO contra 160 e recusa a mensagem inteira:
//   (#132018) Hydrated body length (174) is greater than the limit (160) (for card_index=0)
// Era o que derrubava o carrossel em TODA busca em produção (log de 15/09, 14:22 e 14:27)
// e caía no fallback de cards soltos. Os tetos por variável (nome 90 + prazo 60) somavam
// 150 de parâmetros num orçamento de 86 — este teste mede o que a Meta mede.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAROUSEL_CARD_BODY,
  CAROUSEL_CARD_BODY_LIMIT,
  CAROUSEL_CARD_BODY_V4,
  CAROUSEL_CARD_FIXED_LENGTH,
  CAROUSEL_CARD_MAX_LINE_BREAKS,
  carouselCardBodyFor,
  fitCarouselCardParams,
  hydrateCarouselCardBody
} from "../src/lib/meta-carousel-card";
import { buildCarouselPayload } from "../src/lib/adapters/whatsapp";

// Caso REAL que a Meta recusou: nome longo de ração + prazo.
const REJECTED = {
  name: "Ração Golden Fórmula Cães Adultos Raças Pequenas Carne e Arroz 15kg Premium Especial",
  price: "R$ 189,90",
  delivery: "até 3 dias úteis (contado da compra)"
};

test("o texto fixo do template e o orçamento das variáveis são o que a conta assume", () => {
  assert.equal(CAROUSEL_CARD_FIXED_LENGTH, CAROUSEL_CARD_BODY.replace(/\{\{\d+\}\}/g, "").length);
  // Se alguém reescrever os rótulos, o orçamento muda junto — mas nunca pode zerar.
  assert.ok(CAROUSEL_CARD_BODY_LIMIT - CAROUSEL_CARD_FIXED_LENGTH > 40);
});

test("o caso recusado pela Meta agora cabe", () => {
  const before = hydrateCarouselCardBody(REJECTED).length;
  assert.ok(before > CAROUSEL_CARD_BODY_LIMIT, `o caso de regressão tem que estourar: ${before}`);
  const after = hydrateCarouselCardBody(fitCarouselCardParams(REJECTED)).length;
  assert.ok(after <= CAROUSEL_CARD_BODY_LIMIT, `hidratado ficou em ${after}`);
});

test("preço NUNCA é truncado (preço cortado é preço errado)", () => {
  for (const price of ["R$ 9,90", "R$ 189,90", "R$ 1.299,00", "R$ 12.345,67"]) {
    const fitted = fitCarouselCardParams({ ...REJECTED, price });
    assert.equal(fitted.price, price);
    assert.ok(hydrateCarouselCardBody(fitted).length <= CAROUSEL_CARD_BODY_LIMIT);
  }
});

test("nome curto não é mexido e o prazo inteiro passa", () => {
  const fitted = fitCarouselCardParams({ name: "Ração Golden 15kg", price: "R$ 189,90", delivery: "1 dia útil" });
  assert.equal(fitted.name, "Ração Golden 15kg");
  assert.equal(fitted.delivery, "1 dia útil");
});

test("o corte fica visível e não parte palavra no meio", () => {
  const fitted = fitCarouselCardParams(REJECTED);
  assert.match(fitted.name, /…$/);
  assert.doesNotMatch(fitted.name, /\s…$/);
  // O começo do nome — a identidade do produto — é preservado.
  assert.ok(REJECTED.name.startsWith(fitted.name.replace(/…$/, "")), fitted.name);
});

test("qualquer combinação de nome, preço e prazo cabe no limite (card v3 e v4)", () => {
  const names = ["A", "Ração", "Ração Golden Fórmula Cães Adultos Raças Pequenas Carne e Arroz 15kg Premium", "x".repeat(300)];
  const prices = ["R$ 1,00", "R$ 12.345,67"];
  const deliveries = ["", "1 dia útil", "confirmo na cotação", "y".repeat(200)];
  for (const body of [CAROUSEL_CARD_BODY, CAROUSEL_CARD_BODY_V4]) {
    for (const name of names) {
      for (const price of prices) {
        for (const delivery of deliveries) {
          const hydrated = hydrateCarouselCardBody(fitCarouselCardParams({ name, price, delivery }, CAROUSEL_CARD_BODY_LIMIT, body), body);
          assert.ok(hydrated.length <= CAROUSEL_CARD_BODY_LIMIT, `${hydrated.length}: ${hydrated}`);
        }
      }
    }
  }
});

test("o payload enviado à Meta respeita o limite em todos os cards (v2/v3, v4 e v5)", () => {
  const options = [
    { id: "optsku:a", sku: "a", name: REJECTED.name, displayPrice: 189.9, imageUrl: "https://example.com/a.jpg", delivery: "prazo da loja: até 3 dias úteis" },
    { id: "optsku:b", sku: "b", name: "Ração Premier Adulto 15kg Raças Médias Frango e Arroz Selecionado", displayPrice: 210, imageUrl: "https://example.com/b.jpg", badge: "Você já pediu este" },
    { id: "optsku:c", sku: "c", name: "Ração Royal Canin 15kg", displayPrice: 320.5, imageUrl: "https://example.com/c.jpg" }
  ];
  for (const template of ["vitrine_carrossel_v2_3", "vitrine_carrossel_v4_3", "vitrine_carrossel_v5_3"]) {
    const body = carouselCardBodyFor(template.replace(/_\d+$/, ""));
    const payload = buildCarouselPayload("+5511999999999", template, "Olha o que achei:", options) as any;
    // v5 não manda o componente de corpo: o carrossel é achado pelo tipo.
    const cards = payload.template.components.find((c: any) => c.type === "carousel").cards;
    assert.equal(cards.length, 3);
    for (const card of cards) {
      const params = card.components[1].parameters.map((p: any) => p.text);
      assert.equal(params.length, 3, "o template tem 3 variáveis no corpo do card");
      for (const text of params) assert.ok(text.length > 0, "variável vazia é recusada pelo template");
      const hydrated = hydrateCarouselCardBody({ name: params[0], price: params[1], delivery: params[2] }, body);
      assert.ok(hydrated.length <= CAROUSEL_CARD_BODY_LIMIT, `${template} card_index ${card.card_index}: ${hydrated.length}`);
    }
  }
});

test("06/10: card com no máximo 2 quebras de linha (a Meta recusava os 8 templates v4/v5)", () => {
  for (const body of [CAROUSEL_CARD_BODY, CAROUSEL_CARD_BODY_V4]) {
    const breaks = (body.match(/\n/g) ?? []).length;
    assert.ok(breaks <= CAROUSEL_CARD_MAX_LINE_BREAKS, `${breaks} quebras: ${JSON.stringify(body)}`);
    assert.ok(CAROUSEL_CARD_BODY_LIMIT - body.replace(/\{\{\d+\}\}/g, "").length > 40, "sobra orçamento para as variáveis");
  }
  assert.equal(carouselCardBodyFor("vitrine_carrossel_v5"), CAROUSEL_CARD_BODY_V4, "v5 usa o card do v4");
  assert.equal(carouselCardBodyFor("vitrine_carrossel_v3"), CAROUSEL_CARD_BODY);
  const hydrated = hydrateCarouselCardBody({ name: "Lenço Huggies 48 un", price: "R$ 15,29", delivery: "amanhã, 12h–15h" }, CAROUSEL_CARD_BODY_V4);
  assert.equal(hydrated, "Produto: Lenço Huggies 48 un\nPreço: *R$ 15,29*\nEntrega pela loja: amanhã, 12h–15h. Toque abaixo para adicionar.");
});

test("28/09: prazo agendado vai compacto no card e o template v4 não diz 'contado da compra'", async () => {
  const { compactCardDelivery, carouselCardBodyFor, CAROUSEL_CARD_BODY_V4, fitCarouselCardParams, hydrateCarouselCardBody } = await import("../src/lib/meta-carousel-card");
  assert.equal(compactCardDelivery("prazo da loja: em até 16h (amanhã, 12h–15h)"), "amanhã, 12h–15h");
  assert.equal(compactCardDelivery("prazo da loja: 2 dias úteis"), "2 dias úteis");
  assert.equal(carouselCardBodyFor("vitrine_carrossel_v4"), CAROUSEL_CARD_BODY_V4);
  assert.doesNotMatch(CAROUSEL_CARD_BODY_V4, /contado da compra/);
  assert.doesNotMatch(CAROUSEL_CARD_BODY_V4, /\{\{3\}\}$/, "a Meta recusa corpo terminando em variável");
  const params = fitCarouselCardParams({ name: "Lenço Umedecido Turma da Mônica Huggies com 48 unidades", price: "R$ 15,29", delivery: "amanhã, 12h–15h" }, 160, CAROUSEL_CARD_BODY_V4);
  const hydrated = hydrateCarouselCardBody(params, CAROUSEL_CARD_BODY_V4);
  assert.ok(hydrated.length <= 160, `${hydrated.length}`);
  assert.match(hydrated, /Entrega pela loja: amanhã, 12h–15h/);
  assert.match(hydrated, /Lenço Umedecido Turma da Mônica Huggies com 48 unidades/, "com o v4 o nome inteiro cabe");
});
