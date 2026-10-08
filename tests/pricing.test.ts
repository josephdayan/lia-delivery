import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { displayPrice, markupAmount, serviceFeeForItems, serviceFeeForSubtotal } from "../src/lib/pricing";

// Markup progressivo por faixa MARGINAL (decisão do dono, 23/08): 10% até 200, 6% de
// 200–500, 4% de 500–1000, 3% acima. Marginal = contínuo: subir R$1 de preço nunca
// derruba a margem em R$.

// Estes testes são do modelo antigo (margem embutida no preço); o modelo service_fee (08/10) tem
// teste próprio em service-fee-mode.test.ts.
process.env.LIA_PRICING_MODE = "markup";
afterEach(() => {
  delete process.env.LIA_MARKUP_TIERS;
  delete process.env.LIA_PRICE_MARKUP;
});

test("faixas: 10% até 200, depois 6/4/3 marginais", () => {
  assert.equal(displayPrice(100), 110);
  assert.equal(displayPrice(200), 220);
  // 300 → 20 + 100*0.06 = 26
  assert.equal(displayPrice(300), 326);
  // 800 → 20 + 18 + 300*0.04 = 50
  assert.equal(displayPrice(800), 850);
  // 1389 (violão real) → 20 + 18 + 20 + 389*0.03 = 69.67
  assert.equal(displayPrice(1389), 1458.67);
  // 3000 → 20 + 18 + 20 + 2000*0.03 = 118
  assert.equal(displayPrice(3000), 3118);
});

test("continuidade: R$201 nunca tem margem menor que R$199 (sem degrau seco)", () => {
  for (const [a, b] of [[199, 201], [499, 501], [999, 1001]] as const) {
    assert.ok(markupAmount(b) > markupAmount(a), `margem(${b}) tem que superar margem(${a})`);
  }
});

test("cesta com itens: serviceFee bate com a soma dos preços exibidos", () => {
  const items = [
    { unitPrice: 80.93, qty: 1 },
    { unitPrice: 4.39, qty: 2 }
  ];
  const display = items.reduce((s, i) => s + Math.round(displayPrice(i.unitPrice) * i.qty * 100) / 100, 0);
  const real = items.reduce((s, i) => s + Math.round(i.unitPrice * i.qty * 100) / 100, 0);
  assert.equal(serviceFeeForItems(items), Math.round((display - real) * 100) / 100);
  // item barato segue nos 10% cheios
  assert.equal(serviceFeeForItems([{ unitPrice: 50, qty: 1 }]), 5);
});

test("subtotal sem itens (cotação manual): as mesmas faixas sobre o subtotal", () => {
  assert.equal(serviceFeeForSubtotal(150), 15);
  assert.equal(serviceFeeForSubtotal(1000), 58);
});

test("env calibra sem deploy: base por LIA_PRICE_MARKUP, faixas por LIA_MARKUP_TIERS", () => {
  process.env.LIA_PRICE_MARKUP = "1.15";
  assert.equal(displayPrice(100), 115);
  process.env.LIA_MARKUP_TIERS = "100:0.05";
  // 200 → 100*0.15 + 100*0.05 = 20
  assert.equal(displayPrice(200), 220);
});

// ---- entrada de dinheiro digitada (revisão 01/09: "12,90" virava frete R$ 0) ----
import { parseMoneyInput } from "../src/lib/pricing";

test("parseMoneyInput: vírgula, R$, milhar à brasileira e ponto decimal", () => {
  assert.equal(parseMoneyInput("12,90"), 12.9);
  assert.equal(parseMoneyInput("R$ 1.290,00"), 1290);
  assert.equal(parseMoneyInput("12.90"), 12.9);
  assert.equal(parseMoneyInput("1.290"), 1290, "ponto + 3 dígitos sem vírgula = milhar");
  assert.equal(parseMoneyInput("1.234.567"), 1234567);
  assert.equal(parseMoneyInput("1.234,56"), 1234.56);
  assert.equal(parseMoneyInput("1,234.56"), 1234.56);
  assert.equal(parseMoneyInput("27"), 27);
  assert.equal(parseMoneyInput(" 0,5 "), 0.5);
  assert.equal(parseMoneyInput(27.5), 27.5);
});

test("parseMoneyInput: lixo vira null, nunca zero silencioso", () => {
  assert.equal(parseMoneyInput(""), null);
  assert.equal(parseMoneyInput("   "), null);
  assert.equal(parseMoneyInput("abc"), null);
  assert.equal(parseMoneyInput("1,2,3"), null);
  assert.equal(parseMoneyInput(undefined), null);
  assert.equal(parseMoneyInput(null), null);
  assert.equal(parseMoneyInput(Number.NaN), null);
});
