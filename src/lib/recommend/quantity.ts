// QUANTIDADE por número de pessoas (rodada de qualidade q9, 08/10/2026). O placar reprovava "churrasco pra 12"
// com 2,1 kg de carne e "festa pra 15" com bolo de 300 g: o card mostrava 1 unidade de tudo. Aqui a
// quantidade sai de TABELA CURADA por prateleira (g, ml ou unidades por pessoa) e do tamanho que o NOME do
// produto declara; sem tamanho no nome, não sugere (nunca chuta). Puro: sem rede, sem banco.
//
// O card passa a levar `suggestedQty` e o motivo "sugestão: 3x pra 12 pessoas"; escolher o card já põe essa
// quantidade na cesta (delivery-service.confirmChosenOption). O teto de orçamento do pedido vale pro TOTAL
// (quantidade × preço): se estoura, as quantidades encolhem antes de sair card.
import type { ChoiceOption } from "../conversation-types";
import { normQ } from "./quality";
import type { RecommendRequest } from "./types";

const NUMBER_WORDS: Record<string, number> = {
  tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14,
  quinze: 15, dezesseis: 16, dezoito: 18, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;
// "pra 12", "pra uns 15 amigos", "12 pessoas", "somos 8"; "pra 3 anos"/"pra 20 reais" não é gente.
const NOT_PEOPLE = "(?!\\s*(?:anos?|aninhos?|meses|mes|horas?|h|min|minutos|dias?|reais|real|conto|contos|kg|g|litros?|l|ml)\\b)";
const PEOPLE_RES: RegExp[] = [
  new RegExp(`\\b(?:pra|para|pro|p)\\s+(?:umas?\\s+|uns\\s+|mais ou menos\\s+|tipo\\s+)?${NUM}${NOT_PEOPLE}(?:\\s+(?:pessoas?|convidad[oa]s?|adultos?|criancas?|amig[oa]s?|gente|familiares|parentes))?\\b`),
  new RegExp(`\\b${NUM}\\s+(?:pessoas?|convidad[oa]s?|adultos?|criancas?|amig[oa]s?|familiares|parentes)\\b`),
  new RegExp(`\\bsomos\\s+(?:uns\\s+)?${NUM}${NOT_PEOPLE}\\b`),
  new RegExp(`\\b(?:vao|vem|virao)\\s+(?:umas?\\s+|uns\\s+)?${NUM}\\s+(?:pessoas?|convidad[oa]s?|amig[oa]s?)\\b`)
];

export function headcountOf(text: string | undefined | null): number | undefined {
  const t = normQ(text);
  if (!t) return undefined;
  for (const re of PEOPLE_RES) {
    const m = t.match(re);
    if (!m) continue;
    const raw = m[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (n && n >= 3 && n <= 200) return n;
  }
  return undefined;
}

// Pedido de ocasião com número de gente (churrasco, festa, reunião…) — nunca presente, sintoma ou pet.
export function requestHeadcount(req: RecommendRequest): number | undefined {
  if (req.form !== "need" || req.symptom?.trim()) return undefined;
  const all = normQ(`${req.need ?? ""} ${req.text}`);
  if (/\b(presente|presentear|lembranc\w*|amigo secreto|amigo oculto)\b/.test(all)) return undefined;
  return headcountOf(req.need) ?? headcountOf(req.text);
}

type Unit = "g" | "ml" | "un" | "pack";
type Rule = {
  shelf: RegExp;
  unit: Unit;
  // Quantidade por pessoa (g, ml ou unidades); em "pack", pessoas por embalagem.
  per: (ctx: Ctx) => number;
  // Teto de unidades sugeridas (carne por peça, cerveja por lata…).
  cap: number;
  // O nome do produto precisa casar (carvão, não acendedor).
  name?: RegExp;
  // Prefere a embalagem MAIOR da prateleira (bolo/salgadinho pra festa).
  bigger?: boolean;
  noun: string;
};
type Ctx = { people: number; churrasco: boolean; withLinguica: boolean };

const RULES: Rule[] = [
  // Churrasco: ~400 g de carne por pessoa (300 g da carne principal + 100 g de linguiça quando há as duas).
  { shelf: /^carnes\.linguica$/, unit: "g", per: (c) => (c.churrasco ? 100 : 150), cap: 8, noun: "pacotes" },
  { shelf: /^carnes\.(?!linguica$|hamburguer$)/, unit: "g", per: (c) => (c.churrasco ? (c.withLinguica ? 300 : 400) : 200), cap: 8, noun: "peças" },
  // Carvão: 1 saco de 5 kg pra cada 6 pessoas (~700 g por pessoa).
  { shelf: /^casa\.churrasco$/, unit: "g", per: () => 700, cap: 6, name: /\bcarvao\b/, noun: "sacos" },
  // Pão de alho: 1 pacote pra cada 5 pessoas.
  { shelf: /^padaria\.pao_de_alho$/, unit: "pack", per: () => 5, cap: 8, noun: "pacotes" },
  // Refrigerante: 2 L pra cada 4 pessoas (500 ml por pessoa); cerveja ~600 ml por pessoa.
  { shelf: /^bebidas\.refrigerante$/, unit: "ml", per: () => 500, cap: 12, bigger: true, noun: "unidades" },
  { shelf: /^bebidas\.cerveja$/, unit: "ml", per: () => 600, cap: 24, noun: "unidades" },
  { shelf: /^bebidas\.(suco|agua)$/, unit: "ml", per: () => 400, cap: 12, bigger: true, noun: "unidades" },
  // Salgadinho: ~40 g por pessoa (1 pacote grande pra 5). Bolo: 1 kg pra ~10 pessoas (100 g por pessoa).
  { shelf: /^snacks\.salgadinho$/, unit: "g", per: () => 40, cap: 10, bigger: true, noun: "pacotes" },
  { shelf: /^snacks\.amendoim_castanhas$/, unit: "g", per: () => 30, cap: 8, noun: "pacotes" },
  { shelf: /^congelados\.salgados$/, unit: "g", per: () => 120, cap: 8, bigger: true, noun: "pacotes" },
  { shelf: /^doces\.bolo$/, unit: "g", per: () => 100, cap: 8, bigger: true, noun: "bolos" },
  { shelf: /^doces\.(balas)$/, unit: "g", per: () => 30, cap: 6, bigger: true, noun: "pacotes" },
  { shelf: /^doces\.(doces|chocolate)$/, unit: "g", per: () => 40, cap: 8, noun: "unidades" },
  // Copos/pratos: 1 por pessoa (a embalagem declara quantas unidades traz).
  { shelf: /^casa\.descartaveis$/, unit: "un", per: () => 1, cap: 6, noun: "pacotes" }
];

const num = (s: string) => Number(s.replace(",", "."));
// Minúsculas sem acento, mas COM vírgula, ponto e "~" (normQ os tira e "2,1 kg" viraria "2 1 kg").
const flat = (s: string | undefined | null) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

// Tamanho de UMA embalagem na unidade da regra (g, ml ou unidades); undefined = o nome não diz.
export function sizeOf(option: Pick<ChoiceOption, "name" | "unitWeightKg">, unit: Unit): number | undefined {
  if (unit === "pack") return 1;
  const name = flat(option.name);
  if (unit === "g") {
    if (option.unitWeightKg && option.unitWeightKg > 0) return option.unitWeightKg * 1000;
    const approx = name.match(/~\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\b/);
    const kitMul = name.match(/\b(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr)\b/);
    if (kitMul) return Number(kitMul[1]) * num(kitMul[2]) * (kitMul[3] === "kg" ? 1000 : 1);
    // "~2,1 kg" manda; sem ele, o ÚLTIMO peso do nome ("Picanha 1,1kg a 2,1kg" é faixa — não entra aqui).
    const hit = approx ?? [...name.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr)\b/g)].pop();
    if (!hit) return undefined;
    const v = num(hit[1]) * (hit[2] === "kg" ? 1000 : 1);
    return v > 0 ? v : undefined;
  }
  if (unit === "ml") {
    const vol = [...name.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(ml|l|lt|litros?)\b/g)].pop();
    if (!vol) return undefined;
    const one = num(vol[1]) * (vol[2] === "ml" ? 1 : 1000);
    const count = name.match(/\b(\d+)\s*(?:x|un|und|unid\w*|latas?|garrafas?|long necks?)\s*(?:de\s*)?\d/) ?? name.match(/\b(?:pack|c|cx|caixa|fardo)\s*(?:com\s*)?(\d+)\b/) ?? name.match(/\b(\d+)\s*(?:latas?|garrafas?|unidades|un)\b/);
    const n = count ? Number(count[1]) : 1;
    return one * (n >= 2 && n <= 48 ? n : 1);
  }
  // unidades na embalagem ("Copo 200ml 50 un", "Prato descartável 20 unidades")
  const count = name.match(/\b(\d+)\s*(?:un|und|unid\w*|unidades|copos|pratos|talheres|guardanapos|pecas)\b/);
  return count ? Number(count[1]) : undefined;
}

export type HeadcountPlan = { people: number; churrasco: boolean; withLinguica: boolean };

export function headcountPlan(req: RecommendRequest, shelfIds: readonly string[]): HeadcountPlan | undefined {
  const people = requestHeadcount(req);
  if (!people) return undefined;
  const all = normQ(`${req.need ?? ""} ${req.text}`);
  return { people, churrasco: /\b(churrasc\w*|churras|grelha)\b/.test(all), withLinguica: shelfIds.includes("carnes.linguica") };
}

function ruleFor(shelfId: string, name: string): Rule | undefined {
  const rule = RULES.find((r) => r.shelf.test(shelfId));
  if (!rule) return undefined;
  if (rule.name && !rule.name.test(normQ(name))) return undefined;
  return rule;
}

export type Suggested = { qty: number; text: string; total?: string };

const fmtKg = (g: number) => `${(g / 1000).toFixed(1).replace(".", ",")} kg`;

// Quantidade pra `people` com a embalagem desta opção; null = sem sugestão (1 basta, ou o nome não diz o tamanho).
export function suggestQuantity(shelfId: string, option: Pick<ChoiceOption, "name" | "unitWeightKg">, plan: HeadcountPlan): Suggested | null {
  const rule = ruleFor(shelfId, option.name);
  if (!rule) return null;
  const size = sizeOf(option, rule.unit);
  if (!size || size <= 0) return null;
  const ctx: Ctx = plan;
  const need = rule.unit === "pack" ? Math.ceil(plan.people / rule.per(ctx)) : plan.people * rule.per(ctx);
  // 90% da necessidade já fecha a conta (picanha de 2,1 kg: 2 peças = 4,2 kg pra 12 é pouco, 3 é o certo).
  const raw = rule.unit === "pack" ? need : Math.ceil((need * 0.9) / size);
  const qty = Math.max(1, Math.min(rule.cap, raw));
  if (qty <= 1) return null;
  const total = rule.unit === "g" && qty * size >= 1000 ? `~${fmtKg(qty * size)} no total` : rule.unit === "ml" && qty * size >= 2000 ? `~${(Math.round((qty * size) / 100) / 10).toString().replace(".", ",")} L no total` : undefined;
  return { qty, text: `pra ${plan.people} pessoas, ${qty}x${total ? ` (${total})` : ""}`, ...(total ? { total } : {}) };
}

// Embalagem maior da mesma prateleira (bolo/torta de 1 kg no lugar do bolinho de 300 g; salgadinho grande).
// Só vale se for ao menos 1,8× maior e o preço por grama/ml não passar de 2× o da opção mais barata por
// grama — nunca o "kit premium" só por ser grande.
export function biggerPackIndex<T extends { option: Pick<ChoiceOption, "name" | "unitWeightKg" | "unitPrice"> }>(shelfId: string, chosen: T, pool: readonly T[]): T | undefined {
  const rule = ruleFor(shelfId, chosen.option.name);
  if (!rule?.bigger) return undefined;
  const sizeChosen = sizeOf(chosen.option, rule.unit);
  if (!sizeChosen) return undefined;
  const sized = pool.map((c) => ({ c, size: sizeOf(c.option, rule.unit) })).filter((x): x is { c: T; size: number } => Boolean(x.size) && x.size! > 0);
  if (!sized.length) return undefined;
  const perUnit = (x: { c: T; size: number }) => x.c.option.unitPrice / x.size;
  const cheapest = Math.min(...sized.map(perUnit));
  const better = sized
    .filter((x) => x.size >= sizeChosen * 1.8 && perUnit(x) <= cheapest * 2 && !/\b(kit|presente|caixa presente)\b/.test(normQ(x.c.option.name)))
    // Grande demais não ajuda a fechar a conta com o frete: o maior que cabe em 3× a necessidade típica.
    .sort((a, b) => b.size - a.size);
  return better[0]?.c;
}

export function suggestedWhy(existing: string | undefined, s: Suggested): string {
  const base = (existing ?? "").trim().replace(/[.;]+$/, "");
  const sug = `sugestão: ${s.text}`;
  return base ? `${base} — ${sug}` : sug.charAt(0).toUpperCase() + sug.slice(1);
}
