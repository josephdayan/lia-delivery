// Markup PROGRESSIVO por faixa marginal do preço unitário (decisão do dono, 23/08):
// 10% até R$200, 6% de 200 a 500, 4% de 500 a 1000, 3% acima — como imposto de renda,
// marginal por construção: um item de R$201 nunca custa menos de margem que um de R$199.
// A 1ª faixa continua vindo de LIA_PRICE_MARKUP (1.1 = 10%), então o env antigo segue
// mandando na base; as faixas de cima vêm de LIA_MARKUP_TIERS
// ("200:0.06,500:0.04,1000:0.03" = acima de 200 cobra 6% naquela fatia, e assim por
// diante), tudo calibrável sem deploy.

import { hasMip, isMipItem, medicineServiceFee } from "./medicine";

// MODELO DE PREÇO (dono, 08/10/2026): "service_fee" (padrão) = o cliente vê o PREÇO DA LOJA em
// cada item e a margem da Lia sai numa linha própria ("Taxa de serviço da Lia"), igual ao que o
// remédio isento já fazia; a compra na loja sai no CPF do cliente e a nota fiscal no nome dele.
// "markup" = modelo antigo (margem embutida no preço, nota no nome da Lia). A margem em R$ é a
// MESMA nos dois (as faixas abaixo); muda só onde ela aparece. LIA_PRICING_MODE=markup volta.
export type PricingMode = "service_fee" | "markup";
export function pricingMode(): PricingMode {
  return process.env.LIA_PRICING_MODE === "markup" ? "markup" : "service_fee";
}
// Nota e compra no nome do cliente (quando ele cadastrou CPF) — vale no modelo service_fee.
export function customerInvoiceEnabled(): boolean {
  return pricingMode() === "service_fee";
}

type Tier = { above: number; rate: number };

function baseRate(): number {
  const markup = Number(process.env.LIA_PRICE_MARKUP ?? 1.1);
  return Number.isFinite(markup) && markup > 1 ? markup - 1 : 0.1;
}

const DEFAULT_TIERS: Tier[] = [
  { above: 200, rate: 0.06 },
  { above: 500, rate: 0.04 },
  { above: 1000, rate: 0.03 }
];

function tiers(): Tier[] {
  const raw = process.env.LIA_MARKUP_TIERS;
  if (!raw) return DEFAULT_TIERS;
  const parsed = raw
    .split(",")
    .map((part) => {
      const [above, rate] = part.split(":").map(Number);
      return { above, rate };
    })
    .filter((t) => Number.isFinite(t.above) && t.above > 0 && Number.isFinite(t.rate) && t.rate >= 0)
    .sort((a, b) => a.above - b.above);
  return parsed.length ? parsed : DEFAULT_TIERS;
}

// Margem em R$ sobre um preço, somando fatia a fatia.
export function markupAmount(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  let fee = 0;
  let floor = 0;
  let rate = baseRate();
  for (const tier of tiers()) {
    const slice = Math.min(price, tier.above) - floor;
    if (slice > 0) fee += slice * rate;
    if (price <= tier.above) return fee;
    floor = tier.above;
    rate = tier.rate;
  }
  fee += (price - floor) * rate;
  return fee;
}

// Preço com a margem embutida (modelo antigo; e a base da taxa no modelo novo).
export function markedPrice(price: number): number {
  return Math.round((price + markupAmount(price)) * 100) / 100;
}

// Preço EXIBIDO ao cliente (o único ponto de markup de todos os caminhos vivos). No modelo
// service_fee é o preço da loja: a margem vai para a linha de taxa (serviceLineForItems).
export function displayPrice(price: number): number {
  return pricingMode() === "markup" ? markedPrice(price) : Math.round(price * 100) / 100;
}

// Margem de uma cesta COM itens: soma linha a linha (unidade com markup × qty) menos o
// custo real — é o serviceFee exato que bate com os preços que o cliente viu nos cards.
// Remédio isento (29/09) não leva markup: a margem da cesta soma só os outros itens, e o
// pedido com remédio ganha a taxa fixa da Lia (medicineServiceFee), mostrada em linha própria.
export function serviceFeeForItems(items: { unitPrice: number; qty: number; medicine?: string }[]): number {
  const marked = items.filter((i) => !isMipItem(i));
  const display = marked.reduce((sum, i) => sum + Math.round(markedPrice(i.unitPrice) * i.qty * 100) / 100, 0);
  const real = marked.reduce((sum, i) => sum + Math.round(i.unitPrice * i.qty * 100) / 100, 0);
  return Math.round((display - real + medicineFeeForItems(items)) * 100) / 100;
}

// Parte da margem que é a taxa do remédio (0 sem remédio na cesta). A cotação usa para
// mostrar "Taxa de serviço da Lia" separada dos produtos.
export function medicineFeeForItems(items: ReadonlyArray<{ medicine?: string }>): number {
  return hasMip(items) ? medicineServiceFee() : 0;
}

// O que aparece na linha "Taxa de serviço da Lia" do resumo: no modelo service_fee, a margem
// inteira (os produtos saem pelo preço da loja); no modelo markup, só a taxa do remédio.
export function serviceLineForItems(items: { unitPrice: number; qty: number; medicine?: string }[]): number {
  return pricingMode() === "markup" ? medicineFeeForItems(items) : serviceFeeForItems(items);
}

// Margem quando só existe o SUBTOTAL (cotação manual do /ops, sem custo por item):
// as mesmas faixas, aplicadas ao subtotal inteiro.
export function serviceFeeForSubtotal(subtotal: number): number {
  return Math.round(markupAmount(subtotal) * 100) / 100;
}

// Entrada de dinheiro digitada por gente (campos do /ops): aceita "12,90", "R$ 1.290,00",
// "12.90" e número. Revisão 01/09: `Number("12,90")` é NaN e `NaN || 0` virava frete
// R$ 0 cobrado do cliente — o teclado decimal do iPhone em pt-BR mostra vírgula.
// Regra do ponto sozinho: "1.290" (ponto seguido de exatamente 3 dígitos, sem vírgula)
// é milhar à brasileira; "12.90" é decimal.
export function parseMoneyInput(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value !== "string") return null;
  let s = value.replace(/r\$/gi, "").replace(/\s+/g, "").trim();
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // O último separador é o decimal; o outro é milhar.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    if ((s.match(/,/g) ?? []).length > 1) return null;
    s = s.replace(",", ".");
  } else if (hasDot) {
    const dots = (s.match(/\./g) ?? []).length;
    if (dots > 1) s = s.replace(/\./g, "");
    else if (/^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(".", "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
