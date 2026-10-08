// MAPEAR e JULGAR sem IA + orquestração com a IA (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md
// §1.2, §1.4, §1.6). Puro (sem rede, sem banco): as tabelas curadas e o mapa chegam por parâmetro
// (`deps`) ou, por padrão, de tables.ts/shelf-map.ts.
//
// Redes de segurança que valem COM e SEM IA:
//   - sinal de alerta em pedido de saúde sai ANTES de tudo (nem chama a IA): `{ picks: [], redFlag }`;
//   - sintoma só aceita prateleira mip/care; porta do remédio fechada (LIA_MEDICINE_MIP ou
//     LIA_RECOMMEND_MEDICINE) tira as mip e fica só o cuidado;
//   - restrição dita ("sem lactose", "sem chocolate", "vegano") tira prateleira e candidato por palavra;
//   - o que já está na cesta não é recomendado de novo.
import { medicineEnabled, isMedicineLineExtension } from "../medicine";
import { displayPrice } from "../pricing";
import * as tablesModule from "./tables";
import { SHELF_MAP } from "./shelf-map";
import { etaLabel, judgeFitnessWithAi, planShelvesWithAi, recommendAiEnabled } from "./ai";
import { recommendMedicineEnabled } from "./types";
import type {
  CustomerMemory,
  FitnessInput,
  FitnessVerdict,
  NeedTableEntry,
  RecommendCriterion,
  RecommendRequest,
  RedFlagRule,
  ShelfCandidate,
  ShelfMap,
  ShelfNode,
  ShelfPick,
  ShelfPlan,
  SymptomTableEntry
} from "./types";

export { recommendAiEnabled };

const MAX_PICKS = 6;

export function normRec(input: string | undefined | null): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- dependências (tabelas + mapa) ----------

export type RecommendTableDeps = {
  findNeed: (needNorm: string) => NeedTableEntry | null | undefined;
  findSymptom: (textNorm: string) => SymptomTableEntry | null | undefined;
  // Aceita a regra inteira ou só o motivo (o contrato de tables.ts ainda pode mudar).
  findRedFlag: (textNorm: string) => RedFlagRule | string | null | undefined;
  shelfById: (id: string) => ShelfNode | null | undefined;
  // Mapa inteiro (para achar a prateleira de um produto nomeado). Padrão: SHELF_MAP.shelves.
  shelves?: ShelfNode[];
};

// Casamento de chave curada contra o texto normalizado: igualdade ou palavra(s) inteira(s) dentro
// do texto; vence a chave mais longa (mais específica).
function bestKeyMatch<T extends { keys: string[] }>(table: readonly T[], textNorm: string): T | undefined {
  let best: { entry: T; len: number } | undefined;
  for (const entry of table) {
    for (const key of entry.keys) {
      const k = normRec(key);
      if (!k) continue;
      const hit = textNorm === k || new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(textNorm);
      if (hit && (!best || k.length > best.len)) best = { entry, len: k.length };
    }
  }
  return best?.entry;
}

// Helpers LOCAIS (08/10): tables.ts ainda era placeholder (só os arrays) quando este arquivo foi
// escrito. Se tables.ts exportar findNeed/findSymptom/findRedFlag/shelfById/shelvesForPrompt,
// as dele vencem (lidas em tempo de execução); senão, estas implementações mínimas sobre os arrays.
type TablesFns = Partial<{
  findNeed: RecommendTableDeps["findNeed"];
  findSymptom: RecommendTableDeps["findSymptom"];
  findRedFlag: RecommendTableDeps["findRedFlag"];
  shelfById: RecommendTableDeps["shelfById"];
  shelvesForPrompt: () => string;
}>;
const tablesFns = tablesModule as unknown as TablesFns & { NEED_TABLE?: NeedTableEntry[]; SYMPTOM_TABLE?: SymptomTableEntry[]; RED_FLAGS?: RedFlagRule[] };

export function shelvesPromptFrom(shelves: ShelfNode[]): string {
  return shelves.map((s) => [s.id, s.label, s.query, (s.flags ?? []).join(",")].join(" | ")).join("\n");
}

export function tableDepsFrom(map: ShelfMap, tables: { NEED_TABLE: readonly NeedTableEntry[]; SYMPTOM_TABLE: readonly SymptomTableEntry[]; RED_FLAGS: readonly RedFlagRule[] }): RecommendTableDeps {
  const byId = new Map(map.shelves.map((s) => [s.id, s]));
  return {
    findNeed: (t) => bestKeyMatch(tables.NEED_TABLE, normRec(t)),
    findSymptom: (t) => bestKeyMatch(tables.SYMPTOM_TABLE, normRec(t)),
    findRedFlag: (t) => tables.RED_FLAGS.find((r) => r.pattern.test(t)),
    shelfById: (id) => byId.get(id),
    shelves: map.shelves
  };
}

export function defaultTableDeps(): RecommendTableDeps {
  const local = tableDepsFrom(SHELF_MAP, {
    NEED_TABLE: tablesFns.NEED_TABLE ?? [],
    SYMPTOM_TABLE: tablesFns.SYMPTOM_TABLE ?? [],
    RED_FLAGS: tablesFns.RED_FLAGS ?? []
  });
  return {
    findNeed: tablesFns.findNeed ?? local.findNeed,
    findSymptom: tablesFns.findSymptom ?? local.findSymptom,
    findRedFlag: tablesFns.findRedFlag ?? local.findRedFlag,
    shelfById: tablesFns.shelfById ?? local.shelfById,
    shelves: SHELF_MAP.shelves
  };
}

function defaultShelvesPrompt(shelves: ShelfNode[]): string {
  return tablesFns.shelvesForPrompt && shelves === SHELF_MAP.shelves ? tablesFns.shelvesForPrompt() : shelvesPromptFrom(shelves);
}

function redFlagReason(hit: RedFlagRule | string | null | undefined): string | undefined {
  if (!hit) return undefined;
  if (typeof hit === "string") return hit.trim() || "sinal de alerta";
  return hit.reason || "sinal de alerta";
}

// ---------- restrições ----------

const DAIRY_RE = /\b(leite|queijo|queijos|iogurte|iogurtes|requeijao|manteiga|laticinio|laticinios|sorvete|sorvetes|creme de leite|chantilly|doce de leite|nata|coalhada|petit suisse|achocolatado|ao leite|bombom|bombons|trufa|trufas)\b/;
const GLUTEN_RE = /\b(pao|paes|biscoito|biscoitos|bolacha|bolachas|bolo|bolos|macarrao|massa|massas|torrada|torradas|cerveja|cervejas|wafer|salgado|salgados|pizza|lasanha|bisnaguinha|cereal|cereais|granola)\b/;
const ANIMAL_RE = /\b(carne|carnes|picanha|frango|linguica|bacon|presunto|salame|peixe|atum|sardinha|camarao|leite|queijo|queijos|iogurte|requeijao|manteiga|ovo|ovos|mel|hamburguer|salsicha|mortadela|peito de peru|sorvete|ao leite|chocolate ao leite|bombom|bombons)\b/;
const CHOCOLATE_RE = /\b(chocolate|chocolates|bombom|bombons|trufa|trufas|cacau|brigadeiro|nutella|ovomaltine|achocolatado|lacta|garoto|kitkat|kit kat|bis|prestigio|sonho de valsa|ouro branco|talento|baton|twix|snickers|ferrero|lindt|hershey|hersheys|toblerone|laka|diamante negro|alpino|galak|suflair|charge|chokito|milka|kinder|negresco|trento)\b/;

type ConstraintRule = { kind: "lactose" | "gluten" | "vegan" | "word"; word?: string };

// "sem lactose" → lactose; "sem glúten" → glúten; "vegano"/"vegana" → vegan; "sem X"/"nada de X"/
// "não quero X" → palavra X. "zero açúcar"/"diet"/"light" é PREFERÊNCIA (ordem), não corte.
export function constraintRules(constraints: readonly string[], memory?: CustomerMemory): ConstraintRule[] {
  const all = [...constraints, ...(memory?.restrictions ?? []).map((r) => r.text)];
  const out: ConstraintRule[] = [];
  for (const raw of all) {
    const c = normRec(raw);
    if (!c) continue;
    if (/\blactose\b/.test(c) || /\b(intolerante|alergi\w*) (a |ao )?leite\b/.test(c)) out.push({ kind: "lactose" });
    else if (/\bgluten\b/.test(c) || /\bceliac[oa]\b/.test(c)) out.push({ kind: "gluten" });
    else if (/\b(vegan[oa]?s?|vegetarian[oa]s? estrit[oa]s?)\b/.test(c)) out.push({ kind: "vegan" });
    else {
      const m = c.match(/^(?:sem|nada de|nao quero|nao pode ter|tirar?|tira|exceto|menos)\s+(.+)$/);
      const word = m?.[1]?.replace(/^(o|a|os|as)\s+/, "").trim();
      if (word && !/^(acucar|sal|gordura|conservantes?|corante|pressa)$/.test(word)) out.push({ kind: "word", word });
    }
  }
  return out;
}

function wordRe(word: string): RegExp {
  const stem = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Plural simples ("chocolate" casa "chocolates"; "amendoim" casa "amendoins").
  return new RegExp(`\\b${stem}(s|es)?\\b`);
}

// O texto (query de prateleira ou nome de produto) fere a restrição? A versão declarada
// "sem X"/"zero X"/"livre de X" passa ("Leite Zero Lactose" serve para "sem lactose").
export function violatesConstraint(textRaw: string, rules: readonly ConstraintRule[]): boolean {
  const text = normRec(textRaw);
  if (!text) return false;
  for (const rule of rules) {
    if (rule.kind === "lactose") {
      if (/\b(zero|sem|livre de|0%?) lactose\b|\blac free\b|\bvegan[oa]?\b|\bvegetal\b/.test(text)) continue;
      if (DAIRY_RE.test(text) || (/\bchocolate\b/.test(text) && !/\b(amargo|70%|80%|meio amargo)\b/.test(text))) return true;
    } else if (rule.kind === "gluten") {
      if (/\b(sem|zero|livre de) gluten\b|\bgluten free\b/.test(text)) continue;
      if (GLUTEN_RE.test(text)) return true;
    } else if (rule.kind === "vegan") {
      if (/\b(vegan[oa]?|vegetal|plant|nao contem (ingredientes de )?origem animal)\b/.test(text)) continue;
      if (ANIMAL_RE.test(text)) return true;
    } else if (rule.word) {
      const w = normRec(rule.word);
      if (new RegExp(`\\b(sem|zero|livre de) ${w}`).test(text)) continue;
      if (/^chocolates?$/.test(w) ? CHOCOLATE_RE.test(text) : wordRe(w).test(text)) return true;
    }
  }
  return false;
}

// Já está na cesta? Cada trecho da query (separado por "|") cujas palavras (≥3 letras) estão
// TODAS num nome da cesta conta como repetido.
function inBasket(query: string, basketNames: readonly string[] | undefined): boolean {
  if (!basketNames?.length) return false;
  const names = basketNames.map(normRec);
  return query.split("|").some((segment) => {
    const tokens = normRec(segment).split(" ").filter((t) => t.length >= 3);
    return tokens.length > 0 && names.some((n) => tokens.every((t) => wordRe(t).test(n)));
  });
}

function medicineGateOpen(): boolean {
  return medicineEnabled() && recommendMedicineEnabled();
}

function hasFlag(shelf: ShelfNode | null | undefined, flag: string): boolean {
  return Boolean(shelf?.flags?.includes(flag as never));
}

// Filtro comum aos planos (IA e tabela): restrição, cesta, porta do remédio; e, em sintoma, só mip/care.
function filterPicks(picks: ShelfPick[], req: RecommendRequest, deps: RecommendTableDeps, opts: { symptom: boolean; basketNames?: string[]; memory?: CustomerMemory }): ShelfPick[] {
  const rules = constraintRules(req.constraints, opts.memory);
  const seen = new Set<string>();
  const out: ShelfPick[] = [];
  for (const pick of picks) {
    if (seen.has(pick.shelfId)) continue;
    const shelf = deps.shelfById(pick.shelfId);
    const mip = hasFlag(shelf, "mip");
    if (opts.symptom && !mip && !hasFlag(shelf, "care")) continue;
    if (mip && !medicineGateOpen()) continue;
    if (rules.length && violatesConstraint(`${pick.query} ${shelf?.label ?? ""}`, rules)) continue;
    if (inBasket(pick.query, opts.basketNames)) continue;
    seen.add(pick.shelfId);
    out.push(pick);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

// Pedido de saúde? (decide se o sinal de alerta vale e se o plano fica só em mip/care)
const HEALTH_CUE_RE = /\b(dor|dores|doendo|febre|vomit\w*|enjoo|enjoad\w*|nausea|diarreia|tosse|gripe|gripad\w*|resfriad\w*|azia|colica|ressaca|alergia|coceira|garganta|sangue|sangr\w*|machuc\w*|queimadura|intestino|prisao de ventre|constipad\w*|insonia|mal estar|passando mal|tontura)\b/;

export function isSymptomRequest(req: RecommendRequest, deps: Pick<RecommendTableDeps, "findSymptom">): boolean {
  if (req.form !== "need") return false;
  if (req.symptom?.trim()) return true;
  const text = normRec(req.need ?? req.text);
  return Boolean(deps.findSymptom(text)) || HEALTH_CUE_RE.test(text);
}

function checkRedFlag(req: RecommendRequest, deps: RecommendTableDeps): string | undefined {
  for (const t of [req.text, req.symptom, req.need]) {
    const reason = redFlagReason(t ? deps.findRedFlag(normRec(t)) : undefined);
    if (reason) return reason;
  }
  return undefined;
}

// Prateleira de um produto nomeado: query igual > query dentro do produto (a mais longa) > alias >
// produto dentro da query/rótulo.
export function findShelfForProduct(product: string, shelves: readonly ShelfNode[]): ShelfNode | undefined {
  const p = normRec(product);
  if (!p) return undefined;
  let best: { shelf: ShelfNode; score: number } | undefined;
  const consider = (shelf: ShelfNode, score: number) => {
    if (!best || score > best.score) best = { shelf, score };
  };
  for (const shelf of shelves) {
    const terms = [shelf.query, ...(shelf.aliases ?? [])].map(normRec).filter(Boolean);
    for (const [i, term] of terms.entries()) {
      const alias = i > 0 ? 0 : 0.5;
      if (term === p) consider(shelf, 1000 + alias);
      else if (wordRe(term).test(p) || new RegExp(`(^| )${term}( |$)`).test(p)) consider(shelf, 500 + term.length + alias);
      else if (new RegExp(`(^| )${p}( |$)`).test(term)) consider(shelf, 200 - term.length + alias);
    }
    const label = normRec(shelf.label);
    if (label && new RegExp(`(^| )${p.split(" ")[0]}(s|es)?( |$)`).test(label)) consider(shelf, 50);
  }
  return best?.shelf;
}

// ---------- MAPEAR sem IA ----------

// Plano só das tabelas curadas. product_judged sem prateleira no mapa: devolve um pick com
// shelfId "produto" e query = o produto (a execução trata como busca textual da prateleira
// "produto" — não existe no mapa de propósito; ela nunca chega à IA).
export function planShelvesFromTables(req: RecommendRequest, deps: RecommendTableDeps, opts: { basketNames?: string[]; memory?: CustomerMemory } = {}): ShelfPlan | null {
  const symptom = isSymptomRequest(req, deps);
  if (symptom) {
    const redFlag = checkRedFlag(req, deps);
    if (redFlag) return { picks: [], redFlag, source: "table" };
  }
  if (req.form === "product_judged") {
    const product = (req.product ?? req.text).trim();
    if (!product) return null;
    const shelf = findShelfForProduct(product, deps.shelves ?? []);
    // why "" de propósito: o juiz escreve o fato do item escolhido ("dos mais vendidos", "o mais em conta").
    const pick: ShelfPick = { shelfId: shelf?.id ?? "produto", query: product, why: "" };
    const picks = shelf ? filterPicks([pick], req, deps, { symptom: false, ...opts }) : [pick];
    return { picks, source: "table" };
  }
  let entryPicks: ShelfPick[] | undefined;
  if (symptom) {
    const entry = deps.findSymptom(normRec(req.symptom ?? req.need ?? req.text)) ?? deps.findSymptom(normRec(req.text));
    if (entry) entryPicks = [...entry.picks, ...(entry.care ?? [])];
  }
  if (!entryPicks) {
    const entry = deps.findNeed(normRec(req.need ?? req.text)) ?? deps.findNeed(normRec(req.text));
    if (entry) entryPicks = entry.picks;
  }
  if (!entryPicks) return null;
  return { picks: filterPicks(entryPicks, req, deps, { symptom, ...opts }), source: "table" };
}

export type PlanShelvesOptions = {
  hour?: number;
  memory?: CustomerMemory;
  basketNames?: string[];
  // Costuras (testes/bench): tabelas e mapa. Padrão: tables.ts + SHELF_MAP.
  deps?: RecommendTableDeps;
  shelvesPrompt?: string;
};

// Orquestra MAPEAR: alerta → IA (se ligada) → tabelas. Sempre devolve um plano (picks pode ser []).
export async function planShelves(req: RecommendRequest, opts: PlanShelvesOptions = {}): Promise<ShelfPlan> {
  const deps = opts.deps ?? defaultTableDeps();
  const symptom = isSymptomRequest(req, deps);
  // Sinal de alerta SEMPRE primeiro, com ou sem IA: não recomenda.
  if (symptom) {
    const redFlag = checkRedFlag(req, deps);
    if (redFlag) return { picks: [], redFlag, source: "table" };
  }
  const shelves = deps.shelves ?? [];
  const shelfIds = new Set(shelves.map((s) => s.id));
  // planShelvesWithAi devolve null sozinha sem chave ou com LIA_RECOMMEND_AI=false (a costura de
  // teste passa por cima disso de propósito).
  const ai = shelfIds.size
    ? await planShelvesWithAi(req, { shelvesPrompt: opts.shelvesPrompt ?? defaultShelvesPrompt(shelves), shelfIds, hour: opts.hour, memory: opts.memory, basketNames: opts.basketNames })
    : null;
  if (ai?.picks?.length) {
    // Revalida (a costura/IA pode trazer id fora do mapa) e aplica as redes de segurança.
    let picks = ai.picks.filter((p) => p && shelfIds.has(p.shelfId) && String(p.query ?? "").trim());
    if (symptom) {
      const entry = deps.findSymptom(normRec(req.symptom ?? req.need ?? req.text)) ?? deps.findSymptom(normRec(req.text));
      const tableClass = new Map([...(entry?.picks ?? []), ...(entry?.care ?? [])].filter((p) => p.mipClass).map((p) => [p.shelfId, p.mipClass!]));
      picks = picks.map((p) => (p.mipClass || !tableClass.has(p.shelfId) ? p : { ...p, mipClass: tableClass.get(p.shelfId) }));
    }
    picks = filterPicks(picks, req, deps, { symptom, basketNames: opts.basketNames, memory: opts.memory });
    if (picks.length) return { picks, source: "ai" };
  }
  return planShelvesFromTables(req, deps, { basketNames: opts.basketNames, memory: opts.memory }) ?? { picks: [], source: "table" };
}

// ---------- JULGAR sem IA ----------

const HEALTHY_RE = /\b(integral|integrais|zero|light|diet|natural|naturais|organic[oa]s?|sem acucar|sem lactose|fit|proteic[oa]|whey|aveia|granola|castanhas?|frutas?)\b/;
// Extensões de linha que o cliente não pediu (regra do remédio de 08/10, sem depender da query).
const LINE_EXTENSION_RE = /\b(sinus|dc|pm|max|composto|plus|duo|noite|dia e noite|extra|ultra|forte|flu|gripe|12h|24h|8h|cold|rapid[oa]?)\b/;

function isLineExtension(c: ShelfCandidate, pick: ShelfPick | undefined): boolean {
  const name = c.option.name;
  if (LINE_EXTENSION_RE.test(normRec(name))) return true;
  const queries = [c.option.brand ?? "", ...(pick?.query.split("|") ?? [])].map((q) => q.trim()).filter(Boolean);
  return queries.some((q) => isMedicineLineExtension(q, name));
}

const eta = (c: ShelfCandidate) => c.option.etaMinutes ?? Number.POSITIVE_INFINITY;
const pop = (c: ShelfCandidate) => c.popularity ?? Number.POSITIVE_INFINITY;
const price = (c: ShelfCandidate) => displayPrice(c.option.unitPrice);
type Cmp = (a: ShelfCandidate, b: ShelfCandidate) => number;

function byNumber(f: (c: ShelfCandidate) => number): Cmp {
  return (a, b) => {
    const x = f(a);
    const y = f(b);
    if (x === y) return 0;
    if (x === Number.POSITIVE_INFINITY) return 1;
    if (y === Number.POSITIVE_INFINITY) return -1;
    return x - y;
  };
}
const byFlag = (f: (c: ShelfCandidate) => boolean): Cmp => (a, b) => Number(f(b)) - Number(f(a));

// "Bom" sem popularidade conhecida: marca declarada e preço perto do percentil 65 da prateleira
// (média-alta), nunca o mais barato só por ser barato.
function goodCmp(group: ShelfCandidate[]): Cmp {
  const prices = group.map(price).sort((a, b) => a - b);
  const target = prices.length ? prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.65))] : 0;
  return (a, b) => byNumber(pop)(a, b) || byFlag((c) => Boolean(c.option.brand?.trim()))(a, b) || Math.abs(price(a) - target) - Math.abs(price(b) - target) || price(b) - price(a);
}

type JudgeMode = "symptom" | RecommendCriterion | "default";

function judgeModes(input: FitnessInput): JudgeMode[] {
  const symptomPlan = input.plan.picks.some((p) => p.mipClass) || Boolean(input.request.symptom?.trim());
  if (symptomPlan) return ["symptom"];
  const modes: JudgeMode[] = [];
  // Preço pedido explicitamente vence; urgência implica "rápido".
  if (input.request.criteria.includes("cheap")) modes.push("cheap");
  if (input.request.criteria.includes("fast") || input.request.urgency) modes.push("fast");
  if (input.request.criteria.includes("healthy")) modes.push("healthy");
  if (input.request.criteria.includes("good")) modes.push("good");
  return modes.length ? modes : ["default"];
}

function comparatorFor(modes: JudgeMode[], group: ShelfCandidate[], pick: ShelfPick | undefined): Cmp {
  const chain: Cmp[] = [];
  for (const mode of modes) {
    if (mode === "symptom") chain.push(byFlag((c) => !isLineExtension(c, pick)), byNumber(pop), byNumber(price));
    else if (mode === "fast") chain.push(byNumber(eta), byFlag((c) => Boolean(c.option.verified)));
    else if (mode === "cheap") chain.push(byNumber(price));
    else if (mode === "healthy") chain.push(byFlag((c) => HEALTHY_RE.test(normRec(c.option.name))), byNumber(pop));
    else chain.push(goodCmp(group)); // good e default
  }
  chain.push(byFlag((c) => Boolean(c.option.verified)), byNumber(pop), byNumber(price));
  return (a, b) => {
    for (const cmp of chain) {
      const r = cmp(a, b);
      if (r) return r;
    }
    return 0;
  };
}

// Candidato que fere restrição, orçamento ou porta do remédio → fora.
export function eligibleCandidates(input: FitnessInput): ShelfCandidate[] {
  const rules = constraintRules(input.request.constraints, input.memory);
  const budget = input.request.budget;
  return input.candidates.filter((c) => {
    if (!c?.option?.sku) return false;
    if (rules.length && violatesConstraint(`${c.option.name} ${c.option.brand ?? ""}`, rules)) return false;
    if (budget != null && budget > 0 && price(c) + (c.option.freightFee ?? 0) > budget) return false;
    if (c.option.medicine === "mip" && !medicineGateOpen()) return false;
    return true;
  });
}

function factWhy(c: ShelfCandidate, mode: JudgeMode): string | undefined {
  const minutes = c.option.etaMinutes;
  if (mode === "fast" && minutes != null && minutes < 24 * 60) return `chega em ${etaLabel(minutes)}`;
  if (mode === "cheap") return "o mais em conta";
  if ((mode === "good" || mode === "default") && c.popularity != null && c.popularity <= 3) return "dos mais vendidos";
  if (minutes != null && minutes < 24 * 60) return `chega em ${etaLabel(minutes)}`;
  return undefined;
}

export function judgeFitnessByRules(input: FitnessInput, deps: Pick<RecommendTableDeps, "shelfById"> = defaultTableDeps()): FitnessVerdict {
  const modes = judgeModes(input);
  const primary = modes[0];
  const eligible = eligibleCandidates(input);
  const groups = new Map<string, ShelfCandidate[]>();
  for (const c of eligible) {
    if (!groups.has(c.shelfId)) groups.set(c.shelfId, []);
    groups.get(c.shelfId)!.push(c);
  }
  const planOrder = input.plan.picks.map((p) => p.shelfId);
  const shelves = [...planOrder.filter((id) => groups.has(id)), ...[...groups.keys()].filter((id) => !planOrder.includes(id))];
  const chosen: { shelfId: string; c: ShelfCandidate; why: string; rank: number }[] = [];
  for (const [rank, shelfId] of shelves.entries()) {
    const group = groups.get(shelfId)!;
    const pick = input.plan.picks.find((p) => p.shelfId === shelfId);
    const best = [...group].sort(comparatorFor(modes, group, pick))[0];
    if (!best) continue;
    const fact = factWhy(best, primary);
    // Rápido: o prazo real é o motivo; nos outros, o motivo do plano (tabela/IA) e o fato se faltar.
    const why = primary === "fast" ? fact ?? pick?.why ?? "" : pick?.why || fact || "";
    chosen.push({ shelfId, c: best, why, rank });
  }
  if (primary === "fast") {
    // Fome/urgência: pronto-pra-comer antes, depois o menor prazo; empate fica na ordem do plano.
    const ready = (id: string) => hasFlag(deps.shelfById(id), "ready_to_eat");
    chosen.sort((a, b) => Number(ready(b.shelfId)) - Number(ready(a.shelfId)) || byNumber(eta)(a.c, b.c) || a.rank - b.rank);
  }
  return {
    cards: chosen.map(({ shelfId, c, why }) => ({ shelfId, sku: c.option.sku, storeKey: c.option.storeKey ?? "", why })),
    source: "rule"
  };
}

// Veredito da IA → só cards de candidatos elegíveis (sku + loja + prateleira), 1 por prateleira.
function validateVerdict(verdict: FitnessVerdict | null, input: FitnessInput): FitnessVerdict | null {
  if (!verdict || !Array.isArray(verdict.cards)) return null;
  const eligible = eligibleCandidates(input);
  const seen = new Set<string>();
  const cards: FitnessVerdict["cards"] = [];
  for (const card of verdict.cards) {
    const match = eligible.find((c) => c.option.sku === card?.sku && c.shelfId === card.shelfId && (c.option.storeKey ?? "") === (card.storeKey ?? ""));
    if (!match || seen.has(match.shelfId)) continue;
    seen.add(match.shelfId);
    const pickWhy = input.plan.picks.find((p) => p.shelfId === match.shelfId)?.why ?? "";
    cards.push({ shelfId: match.shelfId, sku: match.option.sku, storeKey: match.option.storeKey ?? "", why: String(card.why ?? "").trim() || pickWhy });
  }
  return { cards, source: verdict.source ?? "ai" };
}

// Orquestra JULGAR: IA (se ligada) validada; IA fora, inválida ou sem cards com candidatos → regras.
export async function judgeFitness(input: FitnessInput, deps?: Pick<RecommendTableDeps, "shelfById">): Promise<FitnessVerdict> {
  const eligible = eligibleCandidates(input);
  if (!eligible.length) return { cards: [], source: "rule" };
  const ai = validateVerdict(await judgeFitnessWithAi(input), input);
  if (ai && ai.cards.length) return ai;
  return judgeFitnessByRules(input, deps ?? defaultTableDeps());
}
