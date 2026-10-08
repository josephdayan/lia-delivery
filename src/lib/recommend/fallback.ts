// MAPEAR e JULGAR sem IA + orquestração com a IA (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md
// §1.2, §1.4, §1.6). Puro (sem rede, sem banco): as tabelas curadas e o mapa chegam por parâmetro
// (`deps`) ou, por padrão, de tables.ts/shelf-map.ts.
//
// Redes de segurança que valem COM e SEM IA:
//   - sinal de EMERGÊNCIA (dor no peito, falta de ar, desmaio, sangue…) em QUALQUER pedido sai antes de
//     tudo (nem chama a IA); sinal de CONTEXTO (bebê, criança, idoso, gestante, comorbidade, pet doente…)
//     em pedido de saúde, ou quando o plano tem prateleira de remédio (mip): `{ picks: [], redFlag }`
//     (revisão adversarial 08/10, A1–A4);
//   - IA só escolhe remédio dentro da tabela do sintoma; sem sintoma, nenhuma prateleira mip (A5);
//   - sintoma só aceita prateleira mip/care; porta do remédio fechada (LIA_MEDICINE_MIP ou
//     LIA_RECOMMEND_MEDICINE) tira as mip e fica só o cuidado;
//   - restrição dita ("sem lactose", "sem chocolate", "vegano") tira prateleira e candidato por palavra;
//   - o que já está na cesta não é recomendado de novo.
import { medicineEnabled, isMedicineLineExtension } from "../medicine";
import { displayPrice } from "../pricing";
import * as tablesModule from "./tables";
import { SHELF_MAP } from "./shelf-map";
import { judgeFitnessWithAi, planShelvesWithAi, recommendAiEnabled } from "./ai";
import { recommendMedicineEnabled } from "./types";
import { attributeRules, meetsAttributes, parseConstraint, shelfSanityOk, violatesRule, type ConstraintRuleQ } from "./quality";
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
const WIDEN_TO = 5;
export const TYPICAL_FREIGHT = 15;
// Frete desconhecido no orçamento total (corpus difícil h24): R$ 10; frete real (inclusive 0) vale como veio.
export const UNKNOWN_FREIGHT = 10;

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
  // Só os sinais de EMERGÊNCIA (revisão A2, 08/10). Ausente: findRedFlag filtrado por `kind: "emergency"`.
  findEmergency?: (textNorm: string) => RedFlagRule | string | null | undefined;
};

// Casamento de chave curada contra o texto normalizado: igualdade ou palavra(s) inteira(s) dentro
// do texto; vence a chave mais longa (mais específica).
function bestKeyMatch<T extends { keys: string[] }>(table: readonly T[], textNorm: string, keyOk?: (key: string, text: string) => boolean): T | undefined {
  let best: { entry: T; len: number } | undefined;
  for (const entry of table) {
    for (const key of entry.keys) {
      const k = normRec(key);
      if (!k) continue;
      if (keyOk && !keyOk(k, textNorm)) continue;
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
  findEmergencyFlag: NonNullable<RecommendTableDeps["findEmergency"]>;
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
    findSymptom: (t) => bestKeyMatch(tables.SYMPTOM_TABLE, normRec(t), tablesModule.symptomKeyAllowed),
    findRedFlag: (t) => tables.RED_FLAGS.find((r) => r.pattern.test(t)),
    findEmergency: (t) => tables.RED_FLAGS.find((r) => r.kind === "emergency" && r.pattern.test(t)),
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
    findEmergency: tablesFns.findEmergencyFlag ?? local.findEmergency,
    shelfById: tablesFns.shelfById ?? local.shelfById,
    shelves: SHELF_MAP.shelves
  };
}

function defaultShelvesPrompt(shelves: ShelfNode[]): string {
  return tablesFns.shelvesForPrompt && shelves === SHELF_MAP.shelves ? tablesFns.shelvesForPrompt() : shelvesPromptFrom(shelves);
}

type Flag = { reason: string; kind: "emergency" | "context" };

function flagOf(hit: RedFlagRule | string | null | undefined, fallbackKind: Flag["kind"]): Flag | undefined {
  if (!hit) return undefined;
  if (typeof hit === "string") return { reason: hit.trim() || "sinal de alerta", kind: fallbackKind };
  return { reason: hit.reason || "sinal de alerta", kind: hit.kind ?? fallbackKind };
}

function redFlagPlan(flag: Flag): ShelfPlan {
  return { picks: [], redFlag: flag.reason, redFlagKind: flag.kind, source: "table" };
}

// ---------- restrições ----------
// Rodada de qualidade (08/10, noite): as regras moram em quality.ts. Restrição de dieta é DURA — na
// prateleira de risco o candidato precisa provar no nome ("zero lactose", "sem glúten", "vegano"); "sem X"
// vira a família inteira de X ("sem porco" tira bacon/linguiça/picanha suína; "sem álcool" tira cerveja
// e vinho; "sem dipirona" tira Novalgina/Dorflex). "zero açúcar"/"diet" agora também é corte.

type ConstraintRule = ConstraintRuleQ;

export function constraintRules(constraints: readonly string[], memory?: CustomerMemory): ConstraintRule[] {
  const all = [...constraints, ...(memory?.restrictions ?? []).map((r) => r.text)];
  const out: ConstraintRule[] = [];
  const seen = new Set<string>();
  for (const raw of all) {
    const rule = parseConstraint(raw);
    if (!rule) continue;
    const key = rule.kind === "word" ? `word:${normRec(rule.word)}` : rule.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

// O texto (query de prateleira ou nome de produto) fere a restrição? A versão declarada
// "sem X"/"zero X"/"livre de X" passa ("Leite Zero Lactose" serve para "sem lactose"). Com `shelfId`
// (candidato), prateleira de risco exige a prova no nome.
export function violatesConstraint(textRaw: string, rules: readonly ConstraintRule[], shelfId?: string): boolean {
  return rules.some((rule) => violatesRule(textRaw, rule, shelfId));
}

// Pick com alternativas ("dipirona | paracetamol"): sai só a alternativa que fere; sem nenhuma, ou com a
// prateleira inteira ferindo ("Carne suína e bacon" em "sem porco"), sai a pick.
function pickWithinRules(pick: ShelfPick, shelf: ShelfNode | null | undefined, rules: readonly ConstraintRule[]): ShelfPick | null {
  if (!rules.length) return pick;
  const alts = pick.query.split("|").map((q) => q.trim()).filter(Boolean);
  const kept = alts.filter((q) => !violatesConstraint(q, rules));
  if (!kept.length) return null;
  if (violatesConstraint(`${kept.join(" ")} ${shelf?.label ?? ""}`, rules)) return null;
  return kept.length === alts.length ? pick : { ...pick, query: kept.join(" | ") };
}

function wordRe(word: string): RegExp {
  const stem = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Plural simples ("chocolate" casa "chocolates"; "amendoim" casa "amendoins").
  return new RegExp(`\\b${stem}(s|es)?\\b`);
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
// `tableShelves` (08/10): prateleiras da entrada CURADA do sintoma — o cuidado da tabela (ex.: água mineral
// na dor de cabeça e na ressaca) vale mesmo sem a flag care no mapa; fora dela, sintoma só aceita mip/care.
function filterPicks(picks: ShelfPick[], req: RecommendRequest, deps: RecommendTableDeps, opts: { symptom: boolean; basketNames?: string[]; memory?: CustomerMemory; tableShelves?: Set<string> }): ShelfPick[] {
  const rules = constraintRules(req.constraints, opts.memory);
  const noMedicine = rules.some((r) => r.kind === "no_medicine");
  // Pra pet (corpus difícil h09): só prateleira de pet — repelente/remédio de gente nunca.
  const petOnly = PET_RECIPIENT_RE.test(normRec(req.recipient));
  const seen = new Set<string>();
  const out: ShelfPick[] = [];
  for (const pick of picks) {
    if (seen.has(pick.shelfId)) continue;
    const shelf = deps.shelfById(pick.shelfId);
    const mip = hasFlag(shelf, "mip");
    if (opts.symptom && !mip && !hasFlag(shelf, "care") && !opts.tableShelves?.has(pick.shelfId)) continue;
    if (mip && (!medicineGateOpen() || noMedicine)) continue;
    if (petOnly && shelf && shelf.domain !== "pet") continue;
    const allowed = pickWithinRules(pick, shelf, rules);
    if (!allowed) continue;
    if (inBasket(allowed.query, opts.basketNames)) continue;
    seen.add(pick.shelfId);
    out.push(allowed);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

// Pedido de saúde? (decide se o sinal de alerta de CONTEXTO vale e se o plano fica só em mip/care)
const HEALTH_CUE_RE = /\b(dor|dores|doendo|febre|vomit\w*|enjoo|enjoad\w*|nausea|diarreia|tosse|gripe|gripad\w*|resfriad\w*|azia|colica|ressaca|alergia|coceira|garganta|sangue|sangr\w*|machuc\w*|queimadura|intestino|prisao de ventre|constipad\w*|insonia|mal estar|passando mal|tontura)\b/;

// (08/10, revisão C3) A chave de sintoma de 1 palavra ambígua ("corte", "gás", "afta"…) só conta com
// contexto de saúde: a checagem mora em tables.symptomKeyAllowed (usada por findSymptom e pelo
// casamento local de tableDepsFrom), então "corte de carne pro churrasco" não é mais sintoma.
// Corpus difícil (08/10, h04): "tenho refluxo, o que posso COMER de noite?" é pedido de comida — a condição
// vira restrição (normalizeRecommendRequest), a tabela de sintomas não sequestra o pedido.
const FOOD_ASK_RE = /\b(comer|como|comida|beber|bebo|bebida|jantar|janta|lanchar|lanche|almocar|almoco|cafe da manha|refeicao|refeicoes|cardapio|cozinhar)\b/;
const MEDICINE_ASK_RE = /\b(remedio|remedios|medicamento|tomar|tomo|xarope|comprimido|pomada|pingo|pingar)\b/;
export function isFoodAsk(text: string | undefined): boolean {
  const t = normRec(text);
  return FOOD_ASK_RE.test(t) && !MEDICINE_ASK_RE.test(t);
}

export function isSymptomRequest(req: RecommendRequest, deps: Pick<RecommendTableDeps, "findSymptom">): boolean {
  if (req.form !== "need") return false;
  if (isFoodAsk(req.text)) return false;
  if (req.symptom?.trim()) return true;
  const text = normRec(req.need ?? req.text);
  return Boolean(deps.findSymptom(text)) || HEALTH_CUE_RE.test(text);
}

// Condição de saúde num pedido de comida → o que evitar (corpus difícil h04: refluxo).
const CONDITION_AVOID: Array<{ re: RegExp; avoid: string[] }> = [
  { re: /\b(refluxo|azia|gastrite|queimacao|ulcera)\b/, avoid: ["sem café", "sem chocolate", "sem refrigerante", "sem pimenta", "sem fritura"] }
];

// Ajustes do pedido ANTES de mapear (rodada de qualidade 08/10, corpus difícil). Puro e idempotente:
//   - produto "julgado" que é um sintoma da tabela ("unha encravada doendo") vira necessidade de sintoma;
//   - pedido de comida com condição de saúde perde o sintoma e ganha o que evitar;
//   - "sintoma" que a tabela de sintomas não conhece mas a de necessidades sim (queda de cabelo, dermatite,
//     acne, caspa) vira necessidade comum (cuidado/dermocosmético, nunca remédio);
//   - pet com pulga/carrapato vira a necessidade "pulga" (higiene pet; antipulga é com o veterinário).
export function normalizeRecommendRequest(req: RecommendRequest, deps: Pick<RecommendTableDeps, "findSymptom" | "findNeed"> = defaultTableDeps()): RecommendRequest {
  let out = req;
  const text = normRec(req.text);
  if (petInvolved(req) && /\b(pulgas?|carrapatos?|piolho de cachorro|sarna)\b/.test(text)) {
    const species = /\b(gat[oa]s?|gatinh\w*|felino)\b/.test(`${text} ${normRec(req.recipient)}`) ? "gato" : "cachorro";
    return { ...req, form: "need", need: `pulga no ${species}`, product: undefined, symptom: undefined, recipient: req.recipient ?? species };
  }
  if (out.form === "product_judged") {
    const product = normRec(out.product ?? out.text);
    if (deps.findSymptom(product) && !findShelfForProduct(out.product ?? out.text, defaultTableDeps().shelves ?? [])) {
      out = { ...out, form: "need", need: out.product ?? out.text, symptom: out.product ?? out.text, product: undefined };
    }
  }
  if (out.form === "need" && isFoodAsk(out.text)) {
    const cond = `${text} ${normRec(out.symptom)}`;
    const avoid = CONDITION_AVOID.filter((c) => c.re.test(cond)).flatMap((c) => c.avoid);
    const constraints = [...out.constraints, ...avoid.filter((a) => !out.constraints.includes(a))];
    out = { ...out, symptom: undefined, constraints };
  }
  if (out.form === "need" && out.symptom?.trim()) {
    const s = normRec(out.symptom);
    if (!deps.findSymptom(s) && !deps.findSymptom(text) && (deps.findNeed(s) || deps.findNeed(normRec(out.need)))) out = { ...out, symptom: undefined };
  }
  return out;
}

// Pet envolvido no pedido (revisão A3): pra quem é pet, ou "meu cachorro/gato/pet" no texto.
const PET_RECIPIENT_RE = /^(?:cachorr\w*|cao|caes|cadela|dog|doguinho|catioro|gat[oa]s?|gatinh\w*|felino|bichano|pet|pets|filhote\w*|passar\w*|calopsita|papagaio|periquito|coelh\w*|hamster|peixe\w*|tartaruga)\b/;
const PET_TEXT_RE = /\b(?:meu|minha|o|a|do|da|no|na|pro|pra|nosso|nossa|seu|sua)\s+(?:cachorr\w*|cao|cadela|dog|doguinho|catioro|gat[oa]|gatinh[oa]|pet|filhote|passarinho|passaro|calopsita|papagaio|periquito|coelh\w*|hamster|peixinho|tartaruga)\b/;
function petInvolved(req: Pick<RecommendRequest, "recipient" | "text">): boolean {
  return PET_RECIPIENT_RE.test(normRec(req.recipient)) || PET_TEXT_RE.test(normRec(req.text));
}

// EMERGÊNCIA (revisão A2): vale em QUALQUER forma de pedido e roda antes de tudo, inclusive da IA.
// Pet com sinal de emergência ("meu cachorro tá sangrando") = veterinário, não SAMU.
function checkEmergency(req: RecommendRequest, deps: RecommendTableDeps): Flag | undefined {
  const find =
    deps.findEmergency ??
    ((t: string) => {
      const hit = deps.findRedFlag(t);
      return hit && typeof hit !== "string" && hit.kind === "emergency" ? hit : null;
    });
  for (const t of [req.text, req.symptom, req.need, req.product]) {
    const flag = flagOf(t ? find(normRec(t)) : undefined, "emergency");
    if (flag) return petInvolved(req) ? { reason: tablesModule.PET_SICK_REASON, kind: "emergency" } : { ...flag, kind: "emergency" };
  }
  return undefined;
}

// Emergência numa frase solta (sem contrato de pedido): para o pré-cadastro e a guarda de tela do
// gerente de diálogo, e para quem precisar checar ANTES de pedir o CEP. null = sem emergência.
export function emergencyFlag(text: string | undefined | null, recipient?: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  return checkEmergency({ form: "need", text: raw, criteria: [], constraints: [], source: "regex", ...(recipient ? { recipient } : {}) }, defaultTableDeps())?.reason ?? null;
}

// Alerta completo (emergência + contexto). Só chamado em pedido de saúde ou com prateleira mip no plano.
// Olha também `recipient` ("filho 2 anos", "pai 75 anos", "bebê 6 meses", "cachorro") — revisão A4.
function checkRedFlag(req: RecommendRequest, deps: RecommendTableDeps): Flag | undefined {
  const emergency = checkEmergency(req, deps);
  if (emergency) return emergency;
  if (petInvolved(req)) return { reason: tablesModule.PET_SICK_REASON, kind: "context" };
  // Cuidado TÓPICO de criança/bebê (corpus difícil h11/h27: "bebê de 8 meses com assadura feia", "filha de
  // 10 anos com piolho"): a idade/o "bebê" não alerta — pomada de assadura e shampoo antipiolho são pra
  // eles. Sistêmico (febre, dor, tosse, gripe, vômito, diarreia) continua alertando; os outros sinais
  // (gestante, comorbidade, há dias…) também.
  const all = normRec([req.text, req.symptom, req.need, req.product, req.recipient].filter(Boolean).join(" "));
  const topical = TOPICAL_RE.test(all) && !SYSTEMIC_RE.test(all);
  const scrub = (t: string) => (topical ? t.replace(KID_WORDS_RE, " ").replace(/\s+/g, " ").trim() : t);
  // O pra quem vai junto do texto (as exceções do texto valem: "assadura do bebê" não alerta).
  for (const t of [req.text, req.symptom, req.need, req.product, req.recipient ? `${req.text} ${req.recipient}` : undefined]) {
    const flag = flagOf(t ? deps.findRedFlag(scrub(normRec(t))) : undefined, "context");
    if (flag) return flag;
  }
  return undefined;
}

const TOPICAL_RE = /\b(assadura|assadur\w*|assad[oa]|piolhos?|lendeas?|repelente|protetor solar|hidratante|sabonete|shampoo|brotoeja|picada|picadas)\b/;
const SYSTEMIC_RE = /\b(febre|febril|dor|dores|doendo|doi|tosse|tossindo|gripe|gripad\w*|resfriad\w*|vomit\w*|diarreia|enjoo|nausea|colica|sangue|sangr\w*|convuls\w*|desmai\w*|respir\w*|mancha roxa|inchad\w*|pus)\b/;
const KID_WORDS_RE = /\b(recem nascid[oa]|bebes?|nenem|lactente|filh[oa]s?|filhinh[oa]s?|criancas?|menin[oa]s?|garot[oa]s?|sobrinh[oa]s?|net[oa]s?|entead[oa]s?|afilhad[oa]s?|\d+ (mes|meses|ano|anos)|(um|uma|dois|duas|tres) (mes|meses|ano|anos))\b/g;

// Plano já filtrado com prateleira de remédio num pedido que não passou pela checagem de saúde
// (produto julgado "qual o melhor anti-inflamatório", IA/tabela com mip): a porta do remédio também
// exige o sinal de alerta de contexto (revisão A1).
function guardMip(plan: ShelfPlan, req: RecommendRequest, deps: RecommendTableDeps, alreadyChecked: boolean): ShelfPlan {
  if (alreadyChecked || !plan.picks.some((p) => hasFlag(deps.shelfById(p.shelfId), "mip"))) return plan;
  const flag = checkRedFlag(req, deps);
  return flag ? redFlagPlan(flag) : plan;
}

// ---------- prateleira de um produto nomeado (revisão B1, 08/10) ----------
// Antes: palpite pela 1ª palavra ("ração pro cachorro" → aquário, "areia pra gato" → construção,
// "pomada pra assadura" → analgésico tópico, "algo pra dormir" → pijama, "creme pra espinhas" →
// tratamento capilar). Agora: tokens sem preposição/artigo/possessivo, COBERTURA dos tokens do produto
// no (query + aliases + rótulo) da prateleira, bônus por espécie e domínio, e só aceita cobertura ≥ 2
// ou o substantivo principal do produto sendo o substantivo da prateleira. Sem prateleira → undefined
// (o chamador usa a busca textual "produto"), nunca um palpite de 1ª palavra.
const SHELF_STOP = new Set("a o as os um uma uns umas de do da dos das pra pro pras pros para p por com e em no na nos nas meu minha meus minhas seu sua nosso nossa algo alguma algum coisa que tipo".split(" "));
const SHELF_SYN: Record<string, string> = {
  cao: "cachorro", caes: "cachorro", cadela: "cachorro", cachorra: "cachorro", cachorrinho: "cachorro", cachorrinha: "cachorro", dog: "cachorro", doguinho: "cachorro", catioro: "cachorro", canino: "cachorro",
  gata: "gato", gatinho: "gato", gatinha: "gato", felino: "gato", bichano: "gato",
  passarinho: "passaro", passaros: "passaro", calopsita: "passaro", peixinho: "peixe", peixes: "peixe",
  espinha: "acne", espinhas: "acne", cravo: "acne", cravos: "acne", bombons: "bombom"
};
const SPECIES = ["cachorro", "gato", "peixe", "passaro"];
const PET_WORDS = new Set(["pet", "racao", "petisco", "coleira", "sache", "arranhador", "comedouro", "areia", ...SPECIES]);

function shelfTokens(text: string | undefined): string[] {
  return normRec(text)
    .split(" ")
    .filter((w) => w && !SHELF_STOP.has(w))
    .map((w) => SHELF_SYN[w] ?? w)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .map((w) => SHELF_SYN[w] ?? w);
}

export function findShelfForProduct(product: string, shelves: readonly ShelfNode[]): ShelfNode | undefined {
  const q = shelfTokens(product);
  if (!q.length) return undefined;
  const qset = new Set(q);
  const head = q[0];
  const qSpecies = SPECIES.filter((sp) => qset.has(sp));
  const petQuery = q.some((t) => PET_WORDS.has(t));
  const entries = shelves.map((shelf) => {
    const terms = [shelf.query, ...(shelf.aliases ?? [])].map(shelfTokens).filter((t) => t.length);
    const label = shelfTokens(shelf.label);
    const bag = new Set([...terms.flat(), ...label]);
    const nouns = new Set([...terms.map((t) => t[0]), label[0]].filter(Boolean));
    return { shelf, terms, bag, nouns };
  });
  // O substantivo principal (1ª palavra do produto) manda: só disputam as prateleiras que o têm.
  const withHead = entries.filter((e) => e.bag.has(head));
  const pool = withHead.length ? withHead : entries;
  let best: { shelf: ShelfNode; score: number } | undefined;
  for (const e of pool) {
    const coverage = new Set(q.filter((t) => e.bag.has(t))).size;
    const headNoun = e.nouns.has(head);
    if (coverage < 2 && !(coverage === 1 && headNoun)) continue;
    let score = coverage * 100 + (headNoun ? 40 : 0);
    for (const t of e.terms) {
      if (t.length === qset.size && t.every((w) => qset.has(w))) score += 500;
      else if (t.every((w) => qset.has(w))) score += 30 * t.length;
    }
    const shelfSpecies = SPECIES.filter((sp) => e.bag.has(sp));
    if (qSpecies.length) {
      if (shelfSpecies.some((sp) => qSpecies.includes(sp))) score += 80;
      else if (shelfSpecies.length) score -= 1000;
    }
    if (e.shelf.domain === "pet") score += petQuery ? 30 : -50;
    if (score > 0 && (!best || score > best.score)) best = { shelf: e.shelf, score };
  }
  return best?.shelf;
}

// Entrada da tabela de sintomas do pedido (pelo sintoma, pela necessidade, pelo texto).
function symptomEntry(req: RecommendRequest, deps: RecommendTableDeps): SymptomTableEntry | undefined {
  return deps.findSymptom(normRec(req.symptom ?? req.need ?? req.text)) ?? deps.findSymptom(normRec(req.text)) ?? undefined;
}

// A5 (revisão 08/10): a IA não escolhe classe de remédio fora da tabela. Com entrada da tabela de
// sintomas: só prateleiras da entrada (isentos + cuidado). Sintoma sem entrada: nada de mip (só cuidado).
// Necessidade sem sintoma: nenhuma mip. Produto julgado: mip só se a prateleira do PRÓPRIO produto é mip.
function restrictAiPicks(picks: ShelfPick[], req: RecommendRequest, deps: RecommendTableDeps, symptom: boolean): ShelfPick[] {
  const isMip = (id: string) => hasFlag(deps.shelfById(id), "mip");
  if (req.form === "product_judged") {
    const own = findShelfForProduct(req.product ?? req.text, deps.shelves ?? []);
    const ownMip = Boolean(own && hasFlag(own, "mip"));
    return picks.filter((p) => !isMip(p.shelfId) || (ownMip && p.shelfId === own!.id));
  }
  if (symptom) {
    const entry = symptomEntry(req, deps);
    if (entry) {
      const allowed = new Set([...entry.picks, ...(entry.care ?? [])].map((p) => p.shelfId));
      return picks.filter((p) => allowed.has(p.shelfId));
    }
  }
  return picks.filter((p) => !isMip(p.shelfId));
}

// ---------- MAPEAR sem IA ----------

// Plano só das tabelas curadas. product_judged sem prateleira no mapa: devolve um pick com
// shelfId "produto" e query = o produto (a execução trata como busca textual da prateleira
// "produto" — não existe no mapa de propósito; ela nunca chega à IA).
export function planShelvesFromTables(req: RecommendRequest, deps: RecommendTableDeps, opts: { basketNames?: string[]; memory?: CustomerMemory } = {}): ShelfPlan | null {
  const emergency = checkEmergency(req, deps);
  if (emergency) return redFlagPlan(emergency);
  const symptom = isSymptomRequest(req, deps);
  if (symptom) {
    const flag = checkRedFlag(req, deps);
    if (flag) return redFlagPlan(flag);
  }
  if (req.form === "product_judged") {
    const product = (req.product ?? req.text).trim();
    if (!product) return null;
    const shelf = findShelfForProduct(product, deps.shelves ?? []);
    // why "" de propósito: o juiz escreve o fato do item escolhido ("dos mais vendidos", "o mais em conta").
    const pick: ShelfPick = { shelfId: shelf?.id ?? "produto", query: product, why: "" };
    const picks = shelf ? filterPicks([pick], req, deps, { symptom: false, ...opts }) : [pick];
    return guardMip({ picks, source: "table" }, req, deps, symptom);
  }
  let entryPicks: ShelfPick[] | undefined;
  let tableShelves: Set<string> | undefined;
  if (symptom) {
    const entry = symptomEntry(req, deps);
    if (entry) {
      entryPicks = [...entry.picks, ...(entry.care ?? [])];
      tableShelves = new Set(entryPicks.map((p) => p.shelfId));
    }
  }
  if (!entryPicks) {
    const entry = deps.findNeed(normRec(req.need ?? req.text)) ?? deps.findNeed(normRec(req.text));
    if (entry) entryPicks = entry.picks;
  }
  if (!entryPicks) return null;
  return guardMip({ picks: filterPicks(entryPicks, req, deps, { symptom, ...opts, tableShelves }), source: "table" }, req, deps, symptom);
}

export type PlanShelvesOptions = {
  hour?: number;
  memory?: CustomerMemory;
  basketNames?: string[];
  // Costuras (testes/bench): tabelas e mapa. Padrão: tables.ts + SHELF_MAP.
  deps?: RecommendTableDeps;
  shelvesPrompt?: string;
};

// Orquestra MAPEAR: emergência → alerta de saúde → IA (se ligada) → tabelas. Sempre devolve um plano
// (picks pode ser []).
export async function planShelves(reqIn: RecommendRequest, opts: PlanShelvesOptions = {}): Promise<ShelfPlan> {
  const deps = opts.deps ?? defaultTableDeps();
  const req = normalizeRecommendRequest(reqIn, deps);
  // Emergência em QUALQUER pedido, antes da IA (revisão A2).
  const emergency = checkEmergency(req, deps);
  if (emergency) return redFlagPlan(emergency);
  const symptom = isSymptomRequest(req, deps);
  // Sinal de alerta de saúde SEMPRE antes da IA: não recomenda.
  if (symptom) {
    const flag = checkRedFlag(req, deps);
    if (flag) return redFlagPlan(flag);
  }
  // Rodada de qualidade (08/10): sintoma COM entrada na tabela curada = plano da tabela, sem IA. A IA só
  // podia reordenar/encolher as classes da própria entrada (A5) e, no placar, trazia 1 classe só (pouca
  // variedade) ou classe fora do sintoma; a tabela já está na ordem de indicação e responde em 0 ms.
  if (symptom && symptomEntry(req, deps)) {
    const plan = planShelvesFromTables(req, deps, { basketNames: opts.basketNames, memory: opts.memory });
    if (plan?.picks.length || plan?.redFlag) return plan;
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
    let picks = restrictAiPicks(
      ai.picks.filter((p) => p && shelfIds.has(p.shelfId) && String(p.query ?? "").trim()),
      req,
      deps,
      symptom
    );
    let tableShelves: Set<string> | undefined;
    if (symptom) {
      const entry = symptomEntry(req, deps);
      if (entry) tableShelves = new Set([...entry.picks, ...(entry.care ?? [])].map((p) => p.shelfId));
      const tableClass = new Map([...(entry?.picks ?? []), ...(entry?.care ?? [])].filter((p) => p.mipClass).map((p) => [p.shelfId, p.mipClass!]));
      picks = picks.map((p) => (p.mipClass || !tableClass.has(p.shelfId) ? p : { ...p, mipClass: tableClass.get(p.shelfId) }));
    }
    picks = filterPicks(picks, req, deps, { symptom, basketNames: opts.basketNames, memory: opts.memory, tableShelves });
    // Rodada de qualidade (08/10): produto julgado = só a prateleira do PRÓPRIO produto ("o melhor shampoo"
    // trazia máscara e condicionador, que o juiz do placar marca como card errado). Sem prateleira própria
    // no mapa, fica a 1ª pick da IA.
    if (req.form === "product_judged" && picks.length > 1) {
      const own = findShelfForProduct(req.product ?? req.text, shelves);
      const mine = own ? picks.filter((p) => p.shelfId === own.id) : [];
      picks = mine.length ? mine : picks.slice(0, 1);
    }
    // Rodada de qualidade (08/10): necessidade com entrada curada e plano curto da IA (3 prateleiras) ganha
    // as prateleiras da tabela que faltam, até 5 — prateleira vazia no CEP não deixa o cliente com 1 card.
    // Presente e "pra quem" ficam com o plano da IA: a tabela genérica de presente traria perfume e flores
    // pra criança de 3 anos.
    const giftOrRecipient = Boolean(req.recipient?.trim()) || /\b(presente|presentes|presentear|lembranc\w*|amigo secreto|amigo oculto|aniversario)\b/.test(normRec(`${req.need ?? ""} ${req.text}`));
    // Urgência (placar q1): até 6 prateleiras, pra sobrar o que chega no dia depois do corte de prazo.
    const fastNeed = Boolean(req.urgency) || req.criteria.includes("fast");
    const widenTo = fastNeed ? MAX_PICKS : WIDEN_TO;
    if (req.form === "need" && !symptom && !giftOrRecipient && picks.length && picks.length < widenTo) {
      const entry = deps.findNeed(normRec(req.need ?? req.text)) ?? deps.findNeed(normRec(req.text));
      if (entry) {
        const extra = filterPicks(entry.picks.filter((p) => !picks.some((q) => q.shelfId === p.shelfId)), req, deps, { symptom: false, basketNames: opts.basketNames, memory: opts.memory });
        picks = [...picks, ...extra].slice(0, widenTo);
      }
    }
    if (picks.length) return guardMip({ picks, source: "ai" }, req, deps, symptom);
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
  // Sintoma vindo da IA num produto julgado sem remédio no plano não força o modo "symptom" (revisão 08/10).
  const symptomPlan = input.plan.picks.some((p) => p.mipClass) || (input.request.form === "need" && Boolean(input.request.symptom?.trim()));
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
  const noMedicine = rules.some((r) => r.kind === "no_medicine");
  const budget = input.request.budget;
  const ok = input.candidates.filter((c) => {
    if (!c?.option?.sku) return false;
    if (rules.length && violatesConstraint(`${c.option.name} ${c.option.brand ?? ""}`, rules, c.shelfId)) return false;
    // Orçamento é TOTAL com entrega (corpus difícil h24; placar q1: perfume de R$ 85,99 "até 100"): conta o
    // frete real, ou R$ 10 quando ainda não se sabe.
    if (budget != null && budget > 0 && price(c) + (c.option.freightFee ?? UNKNOWN_FREIGHT) > budget) return false;
    if (c.option.medicine === "mip" && (!medicineGateOpen() || noMedicine)) return false;
    // Rodada de qualidade (08/10): o item tem de ser do tipo da prateleira (Ruffles não é legume).
    if (c.shelfId !== "produto" && !shelfSanityOk(c.shelfId, c.option.name)) return false;
    return true;
  });
  // Produto julgado com atributo dito ("pra cabelo cacheado", "de coador", "dente sensível"): quando algum
  // candidato cumpre no nome, só eles ficam (o juiz do placar reprovava máscara/clareadora/copo).
  if (input.request.form === "product_judged") {
    const attrs = attributeRules(input.request.constraints);
    if (attrs.length) {
      const meeting = ok.filter((c) => meetsAttributes(c.option.name, attrs));
      if (meeting.length) return meeting;
    }
  }
  return ok;
}

// Rodada de qualidade (08/10): o motivo das regras não promete prazo ("chega em 3h" — o card já mostra o
// prazo da loja) nem popularidade que o card não mostra; "o mais em conta" só sobrevive no card que é de
// fato o mais barato (handle.finalizeWhys).
function factWhy(_c: ShelfCandidate, mode: JudgeMode): string | undefined {
  if (mode === "cheap") return "o mais em conta";
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
    const why = pick?.why || fact || "";
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
  // O juiz de IA só vê o que pode virar card (restrição, orçamento, porta do remédio já aplicados).
  const ai = validateVerdict(await judgeFitnessWithAi({ ...input, candidates: eligible }), input);
  if (ai && ai.cards.length) return ai;
  return judgeFitnessByRules(input, deps ?? defaultTableDeps());
}
