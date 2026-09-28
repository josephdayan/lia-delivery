// Corpo do CARD do carrossel e o ajuste dos 3 parâmetros ao limite da Meta (15/09).
//
// A Meta valida o corpo do card JÁ HIDRATADO (texto fixo + variáveis substituídas) contra
// 160 caracteres, e recusa a mensagem inteira com
//   (#132018) Hydrated body length (174) is greater than the limit (160) (for card_index=0)
// Os tetos por variável (nome 90, prazo 60) somavam bem mais que o orçamento real: o texto
// fixo do template come 74 caracteres, então as TRÊS variáveis juntas têm ~86. Em produção
// isso recusava o carrossel em toda busca e caía no fallback de cards soltos — uma ida à
// Graph jogada fora por pedido (log de 15/09, 14:22 e 14:27).
//
// Este módulo é folha (não importa nada) porque os dois lados precisam dele e não podem se
// importar: `meta-setup` CRIA o template com este texto, `adapters/whatsapp` ENVIA os
// parâmetros que precisam caber nele.

// A Meta exige proporção de palavras fixas por variável ("Params Words Ratio Exceeds
// Limit", 1ª tentativa 07/09): o card precisa de rótulos, não só as 3 variáveis.
export const CAROUSEL_CARD_BODY = "Produto: {{1}}\nPreço do item: *{{2}}*\nPrazo de entrega da loja: {{3}} (contado da compra)";
// v4 (28/09, dono: "esse contado da compra pode tirar"): o texto não pode terminar em variável,
// então fecha com uma instrução útil. Criado e ativado sozinho quando a Meta aprovar
// (src/lib/meta-setup.ts ensureCarouselV4 + activeCarouselPrefix).
export const CAROUSEL_CARD_BODY_V4 = "Produto: {{1}}\nPreço: *{{2}}*\nEntrega pela loja: {{3}}\nToque abaixo para adicionar.";
export function carouselCardBodyFor(prefix: string): string {
  return /_v4$/.test(prefix) ? CAROUSEL_CARD_BODY_V4 : CAROUSEL_CARD_BODY;
}
// Prazo no card, curto: janela agendada vira só a janela ("amanhã, 12h–15h"); o resto sem o
// rótulo "prazo da loja:" (o template já tem o rótulo).
export function compactCardDelivery(text: string): string {
  const t = text.replace(/^prazo da loja:\s*/i, "").trim();
  const windowed = /^em até \d+h \((.+)\)$/.exec(t);
  return windowed ? windowed[1] : t;
}

// Limite da Meta para o corpo hidratado de um card.
export const CAROUSEL_CARD_BODY_LIMIT = 160;

// Quanto o texto FIXO do template consome — derivado do próprio texto, para o dia em que
// alguém reescrever os rótulos e o orçamento mudar junto.
export const CAROUSEL_CARD_FIXED_LENGTH = CAROUSEL_CARD_BODY.replace(/\{\{\d+\}\}/g, "").length;
function fixedLengthOf(body: string): number {
  return body.replace(/\{\{\d+\}\}/g, "").length;
}

// O prazo é curto por natureza ("1 dia útil", "até 3 dias úteis"); o nome é a identidade do
// produto e fica com o que sobrar. Quando o orçamento aperta, encurta o prazo primeiro.
const DELIVERY_CAP = 22;
const NAME_MIN = 28;

// Corta no limite tentando não partir palavra, e deixa o corte VISÍVEL ("…") para ninguém
// confundir nome truncado com nome do produto.
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  const hard = text.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(" ");
  const body = lastSpace >= Math.floor(hard.length * 0.6) ? hard.slice(0, lastSpace) : hard;
  return `${body.trimEnd()}…`;
}

// Devolve os 3 parâmetros do card garantindo que o corpo hidratado caiba no limite. O PREÇO
// nunca é truncado: preço cortado é preço errado.
export function fitCarouselCardParams(
  input: { name: string; price: string; delivery: string },
  limit = CAROUSEL_CARD_BODY_LIMIT,
  body = CAROUSEL_CARD_BODY
): { name: string; price: string; delivery: string } {
  const price = input.price;
  const fixed = fixedLengthOf(body);
  const budget = limit - fixed - price.length;
  if (budget <= 0) return { name: truncate(input.name, Math.max(0, limit - fixed)), price, delivery: "" };

  let delivery = truncate(input.delivery, Math.min(DELIVERY_CAP, budget));
  let nameBudget = budget - delivery.length;
  // Nome abaixo do mínimo legível: o prazo cede espaço até desaparecer.
  if (nameBudget < NAME_MIN) {
    delivery = truncate(input.delivery, Math.max(0, budget - NAME_MIN));
    nameBudget = budget - delivery.length;
  }
  return { name: truncate(input.name, nameBudget), price, delivery };
}

// O corpo como a Meta vai medir: usado pelos testes e pelo diagnóstico.
export function hydrateCarouselCardBody(params: { name: string; price: string; delivery: string }, body = CAROUSEL_CARD_BODY): string {
  return body.replace("{{1}}", params.name).replace("{{2}}", params.price).replace("{{3}}", params.delivery);
}
