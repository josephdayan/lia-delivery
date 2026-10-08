// MEMÓRIA DO CLIENTE (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md, fase 2): o que a Lia
// lembra de cada cliente para MAPEAR e JULGAR (CustomerMemory em types.ts). Duas fontes, nunca palpite:
//   (a) o que o cliente DISSE sobre si (User.preferences): restrições ("sou intolerante a lactose",
//       "sou vegano", "meu filho é diabético"), pet ("tenho um cachorro grande") e casa ("somos 4 em
//       casa") — cada uma com a data em que foi dita;
//   (b) o que ele COMPROU (DeliveryOrder pago/entregue): marcas escolhidas 2+ vezes por prateleira e as
//       prateleiras recentes.
//
// Regras:
//   - extração PURA e conservadora (regex sobre o texto normalizado), só declaração explícita: "sem
//     lactose" sozinho é exigência do pedido, não fato sobre o cliente; "não sou vegano" não grava;
//     "você é vegano?" não grava; saúde que o cliente não disse nunca é inferida;
//   - restrição de ALGUÉM DA CASA ("meu filho é diabético", "minha esposa é celíaca") vale como a do
//     cliente (decisão 08/10: ele compra pra casa; filtrar só tira opção, nunca põe), marcada com
//     `who: "household"` e quem é ("seu filho") — a copy diz de quem é;
//   - restrição de PET ("meu cachorro é diabético") não é restrição de gente: não grava;
//   - nunca lança: erro de banco = memória vazia (a recomendação segue sem ela).
//
// Prateleira de um item comprado: `findShelfForProduct` (fallback.ts) sobre o mapa passado (o de
// verdade por padrão; o de teste quando a costura de tabelas está ligada). Barato: só os 20 pedidos
// mais recentes, cache de 5 min por cliente.
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { REPEATABLE_DELIVERY_ORDER_STATUSES } from "../order-flags";
import { findShelfForProduct } from "./fallback";
import { SHELF_MAP } from "./shelf-map";
import type { CustomerMemory, ShelfNode } from "./types";

// ---------------------------------------------------------------- tipos

export type Who = "self" | "household";

// Restrição como fica guardada: `key` estável (dedupe e "não sou mais X"), `label` legível pro cliente.
export type StoredRestriction = { key: string; label: string; who: Who; whoLabel?: string; at: string };
export type PetSpecies = "cachorro" | "gato" | "outro";
export type StoredPreferences = {
  v: 1;
  restrictions: StoredRestriction[];
  pet?: { species: PetSpecies; size?: string; at: string };
  household?: { people?: number; at: string };
};

export type Statement =
  | { kind: "restriction"; key: string; label: string; who: Who; whoLabel?: string }
  | { kind: "pet"; species: PetSpecies; size?: string }
  | { kind: "household"; people: number };

// O que a execução recebe: o contrato (CustomerMemory) + o que foi DITO, com os textos de filtro de
// cada restrição (para a nota "lembrei que…" só sair quando a restrição de fato tirou algo).
export type LoadedMemory = CustomerMemory & {
  said: { key: string; label: string; who: Who; whoLabel?: string; filters: string[] }[];
};

export const EMPTY_MEMORY: LoadedMemory = { restrictions: [], brands: [], recentShelves: [], said: [] };

// ---------------------------------------------------------------- normalização

export function normMem(input: string | undefined | null): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- restrições: chaves e filtros

type RestrictionDef = { label: string; filters: string[]; sugar?: boolean };

const MEAT = ["carne", "picanha", "alcatra", "fraldinha", "costela", "linguica", "bacon", "presunto", "salame", "mortadela", "salsicha", "hamburguer de carne"];
const POULTRY_FISH = ["frango", "peixe", "atum", "sardinha", "camarao", "salmao", "bacalhau"];
const PORK = ["porco", "suino", "bacon", "presunto", "salame", "lombo", "pernil", "toucinho", "torresmo", "copa"];
const SEAFOOD = ["camarao", "frutos do mar", "marisco", "lula", "polvo", "siri", "caranguejo", "lagosta"];

// Filtros = textos que `constraintRules` (fallback.ts) entende: "sem lactose", "sem glúten", "vegano",
// "alérgico a leite" (→ laticínio) e "sem X" (palavra). Diabetes/açúcar não corta nada (é preferência:
// a execução pede o critério "healthy" e a IA vê a restrição dita).
const RESTRICTIONS: Record<string, RestrictionDef> = {
  lactose: { label: "sem lactose", filters: ["sem lactose"] },
  leite: { label: "alergia a leite", filters: ["alérgico a leite", "sem leite"] },
  gluten: { label: "sem glúten", filters: ["sem glúten"] },
  vegano: { label: "vegano", filters: ["vegano"] },
  vegetariano: { label: "vegetariano", filters: [...MEAT, ...POULTRY_FISH].map((w) => `sem ${w}`) },
  carne: { label: "sem carne", filters: MEAT.map((w) => `sem ${w}`) },
  carne_vermelha: { label: "sem carne vermelha", filters: ["sem carne bovina", "sem picanha", "sem alcatra", "sem fraldinha", "sem costela", "sem carne moida", "sem contra file"] },
  porco: { label: "sem carne de porco", filters: PORK.map((w) => `sem ${w}`) },
  frutos_do_mar: { label: "sem frutos do mar", filters: SEAFOOD.map((w) => `sem ${w}`) },
  peixe: { label: "sem peixe", filters: ["sem peixe", "sem atum", "sem sardinha", "sem salmao", "sem bacalhau", "sem tilapia"] },
  frango: { label: "sem frango", filters: ["sem frango"] },
  amendoim: { label: "alergia a amendoim", filters: ["sem amendoim", "sem pacoca", "sem pe de moleque"] },
  castanha: { label: "alergia a castanhas", filters: ["sem castanha", "sem castanhas", "sem nozes", "sem amendoa", "sem amendoas", "sem avela", "sem pistache", "sem macadamia"] },
  ovo: { label: "sem ovo", filters: ["sem ovo", "sem ovos"] },
  soja: { label: "sem soja", filters: ["sem soja"] },
  diabetes: { label: "diabético", filters: [], sugar: true },
  acucar: { label: "sem açúcar", filters: [], sugar: true }
};

// Alergias de nome livre aceitas (curadas: comida, aditivo, remédio comum). Fora daqui não grava —
// "alérgico a poeira/gato/sol" não é coisa de prateleira.
const ALLERGY_FREE = new Set([
  "morango", "kiwi", "abacaxi", "banana", "chocolate", "cacau", "mel", "gergelim", "mostarda", "corante", "corantes", "trigo", "aveia",
  "dipirona", "ibuprofeno", "paracetamol", "aspirina", "aas", "penicilina", "amoxicilina", "sulfa", "latex", "perfume", "fragrancia", "lanolina", "niquel"
]);

export function restrictionDef(key: string): RestrictionDef {
  if (RESTRICTIONS[key]) return RESTRICTIONS[key];
  const m = key.match(/^alergia:(.+)$/);
  if (m) return { label: `alergia a ${m[1]}`, filters: [`sem ${m[1]}`] };
  return { label: key, filters: [] };
}

export function restrictionMeansSugar(key: string): boolean {
  return Boolean(RESTRICTIONS[key]?.sugar);
}

// Palavra de comida dita depois de intolerante/alérgico/"não como" → chave.
function foodKey(raw: string, mode: "intolerance" | "allergy" | "noeat"): string | null {
  const x = raw.trim();
  if (/^(lactose|laticinios?|derivados de leite|derivados do leite)$/.test(x)) return mode === "allergy" ? "leite" : "lactose";
  if (/^(leite|leite de vaca|proteina do leite)$/.test(x)) return mode === "allergy" ? "leite" : "lactose";
  if (/^(gluten|trigo e gluten)$/.test(x)) return "gluten";
  if (/^(amendoim|amendoins)$/.test(x)) return "amendoim";
  if (/^(castanhas?|nozes|oleaginosas|castanha de caju|amendoas?)$/.test(x)) return "castanha";
  if (/^(ovos?|clara de ovo)$/.test(x)) return "ovo";
  if (/^soja$/.test(x)) return "soja";
  if (/^(camarao|camaroes|frutos do mar|mariscos?|crustaceos?)$/.test(x)) return "frutos_do_mar";
  if (/^(peixes?)$/.test(x)) return "peixe";
  if (mode === "noeat") {
    if (/^(carnes?|carne animal|proteina animal|bicho|carne nenhuma|nenhuma carne)$/.test(x)) return "carne";
    if (/^(carne vermelha|carne de vaca|carne bovina|boi)$/.test(x)) return "carne_vermelha";
    if (/^(porco|carne de porco|carne suina|suino)$/.test(x)) return "porco";
    if (/^(frango|galinha)$/.test(x)) return "frango";
    if (/^(acucar|doce|doces)$/.test(x)) return "acucar";
    return null;
  }
  if (mode === "allergy" && ALLERGY_FREE.has(x)) return `alergia:${x}`;
  return null;
}

// ---------------------------------------------------------------- EXTRAÇÃO (pura)

const NUM: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s] ?? NaN);
const NUM_RE = "(?:\\d{1,2}|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)";

// Quem da casa ("meu filho", "minha esposa"): vira `whoLabel` ("seu filho", "sua esposa").
const HH_RE = "(?:meu|minha|meus|minhas) (?:filh[oa]s?|marido|esposa|mulher|namorad[oa]|noiv[oa]|mae|pai|irma|irmao|irmaos|irmas|avo|sogr[oa]|bebe|companheir[oa]|entead[oa]|net[oa]|crianca|criancas)";
function whoLabelOf(hh: string): string {
  const [pos, ...rest] = hh.split(" ");
  const who = rest.join(" ");
  const fem = /^(minha|minhas)$/.test(pos);
  const plural = /^(meus|minhas)$/.test(pos);
  const pretty = who.replace(/^mae$/, "mãe").replace(/^irma$/, "irmã").replace(/^irmas$/, "irmãs").replace(/^avo$/, fem ? "avó" : "avô").replace(/^bebe$/, "bebê").replace(/^crianca/, "criança");
  return `${plural ? (fem ? "suas" : "seus") : fem ? "sua" : "seu"} ${pretty}`;
}

// Verbos por sujeito. Eu: sou/tô/tenho/não como. Casa: é/tá/tem/não come.
const SELF_BE = "(?:eu )?(?:sou|to|tou|estou|fiquei|virei)";
const HH_BE = "(?:e|eh|ta|esta|ficou|virou|sao)";
const SELF_HAVE = "(?:eu )?(?:tenho|descobri que tenho|tenho uma)";
const HH_HAVE = "(?:tem|descobriu que tem)";
const SELF_NOEAT = "(?:eu )?nao (?:como|posso comer|consumo|bebo|tomo|posso tomar|como mais|posso mais comer|ingiro)";
const HH_NOEAT = "nao (?:come|pode comer|consome|bebe|toma|pode tomar|come mais|ingere)";
const FOOD_WORDS = "(?:lactose|laticinios?|derivados d[eo] leite|leite de vaca|proteina do leite|leite|gluten|amendoins?|castanhas?|castanha de caju|nozes|oleaginosas|amendoas?|ovos?|clara de ovo|soja|camaroes|camarao|frutos do mar|mariscos?|crustaceos?|peixes?|carne vermelha|carne de vaca|carne bovina|carne de porco|carne suina|carnes?|proteina animal|porco|suino|frango|galinha|acucar|[a-z]{3,14})";
const DIET_BE = "(diabetic[oa]s?|pre diabetic[oa]|celiac[oa]s?|vegan[oa]s?|vegetarian[oa]s?|intolerantes? a lactose|intolerantes? ao gluten)";
const DIET_HAVE = "(diabetes|doenca celiaca|celiaquia|intolerancia a lactose|intolerancia ao gluten|intolerancia a gluten)";

function dietKey(raw: string): string | null {
  if (/diabet/.test(raw)) return "diabetes";
  if (/celiac|celiaquia|gluten/.test(raw)) return "gluten";
  if (/vegan/.test(raw)) return "vegano";
  if (/vegetarian/.test(raw)) return "vegetariano";
  if (/lactose/.test(raw)) return "lactose";
  return null;
}

// Negação logo antes ("não sou", "nunca fui", "eu não tenho") → não é declaração.
function negatedBefore(n: string, index: number): boolean {
  return /\b(nao|nunca|nem|jamais)\s+(?:eu\s+)?$/.test(n.slice(Math.max(0, index - 14), index));
}

// Pet: espécie pela palavra. "gata"/"gato"/"gatinha" também é gíria (namorada/namorado): fora de
// "tenho um/uma", só conta com contexto de pet na mesma frase.
const PET_WORD = "(cachorr[oa]s?|cachorrinh[oa]s?|cadela|cao|caes|dog|doguinho|catioro|gat[oa]s?|gatinh[oa]s?|felino|passarinho|passaros?|calopsita|periquito|papagaio|coelh[oa]s?|hamster|peixinhos?|tartaruga|porquinho da india)";
const PET_CONTEXT_RE = /\b(racao|areia|petisco|sache|coleira|veterinari\w*|vet|vacina|pulga|castrad\w*|filhote|arranhador|caminha|tapete higienico|banho e tosa|mia|miau|late|pet|bichano|felino)\b/;
function speciesOf(word: string): PetSpecies {
  if (/^(cachorr|cadela|cao|caes|dog|doguinho|catioro)/.test(word)) return "cachorro";
  if (/^(gat|felino)/.test(word)) return "gato";
  return "outro";
}
function sizeOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^(grande|gigante|grandao)$/.test(raw)) return "grande";
  if (/^(pequen[oa]|mini|pequenininh[oa])$/.test(raw)) return "pequeno";
  if (/^(medi[oa])$/.test(raw)) return "médio";
  if (/^filhote$/.test(raw)) return "filhote";
  if (/^(idos[oa]|velhinh[oa]|senior)$/.test(raw)) return "idoso";
  return undefined;
}
const SIZE_WORD = "(grande|gigante|grandao|pequen[oa]|pequenininh[oa]|mini|medi[oa]|filhote|idos[oa]|velhinh[oa]|senior)";

type Hit = { start: number; end: number; st: Statement };

function pushRestriction(hits: Hit[], m: RegExpExecArray, key: string | null, hh?: string) {
  if (!key) return;
  const def = restrictionDef(key);
  hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "restriction", key, label: def.label, who: hh ? "household" : "self", ...(hh ? { whoLabel: whoLabelOf(hh) } : {}) } });
}

function scan(re: RegExp, n: string, fn: (m: RegExpExecArray) => void) {
  re.lastIndex = 0;
  for (let m = re.exec(n); m; m = re.exec(n)) {
    fn(m);
    if (m[0].length === 0) re.lastIndex++;
  }
}

// O texto inteiro → declarações + o que sobra (para saber se a mensagem era SÓ a declaração).
export function parseStatements(text: string): { statements: Statement[]; rest: string } {
  const n = normMem(text);
  const hits: Hit[] = [];
  if (!n || n.length > 400) return { statements: [], rest: n };
  // Pergunta sobre o produto ("é vegano?", "tem lactose?") nunca é declaração: as regras exigem sujeito.
  // ---- restrições do próprio cliente e de quem é da casa
  for (const [subject, hh] of [
    [`(?<![a-z])(${SELF_BE})`, false],
    [`(${HH_RE}) ${HH_BE}`, true]
  ] as const) {
    scan(new RegExp(`${subject} (?:muito |bem |super )?(intolerantes?|alergic[oa]s?) (?:a |ao |as |aos |com |de )?(${FOOD_WORDS})`, "g"), n, (m) => {
      if (negatedBefore(n, m.index)) return;
      const food = m[m.length - 1];
      pushRestriction(hits, m, foodKey(food, /alergic/.test(m[0]) ? "allergy" : "intolerance"), hh ? m[1] : undefined);
    });
    scan(new RegExp(`${subject} ${DIET_BE}\\b`, "g"), n, (m) => {
      if (negatedBefore(n, m.index)) return;
      pushRestriction(hits, m, dietKey(m[m.length - 1]), hh ? m[1] : undefined);
    });
  }
  for (const [subject, hh] of [
    [`(?<![a-z])(${SELF_HAVE})`, false],
    [`(${HH_RE}) ${HH_HAVE}`, true]
  ] as const) {
    scan(new RegExp(`${subject} (?:uma |um )?${DIET_HAVE}\\b`, "g"), n, (m) => {
      if (negatedBefore(n, m.index)) return;
      pushRestriction(hits, m, dietKey(m[m.length - 1]), hh ? m[1] : undefined);
    });
    scan(new RegExp(`${subject} (?:uma |um )?(?:leve |forte |grave )?(intolerancia|alergia) (?:a |ao |as |aos |de |com )?(${FOOD_WORDS})`, "g"), n, (m) => {
      if (negatedBefore(n, m.index)) return;
      const food = m[m.length - 1];
      pushRestriction(hits, m, foodKey(food, m[m.length - 2] === "alergia" ? "allergy" : "intolerance"), hh ? m[1] : undefined);
    });
  }
  scan(new RegExp(`(?<![a-z])${SELF_NOEAT} (?:nada de |nenhum tipo de |nenhuma )?(${FOOD_WORDS})\\b`, "g"), n, (m) => {
    pushRestriction(hits, m, foodKey(m[m.length - 1], "noeat"));
  });
  scan(new RegExp(`(${HH_RE}) ${HH_NOEAT} (?:nada de |nenhum tipo de )?(${FOOD_WORDS})\\b`, "g"), n, (m) => {
    pushRestriction(hits, m, foodKey(m[m.length - 1], "noeat"), m[1]);
  });

  // ---- pet
  scan(new RegExp(`(?<![a-z])(?:eu )?(?:tenho|temos|adotei|adotamos) (?:um |uma |dois |duas |tres |\\d+ )?${PET_WORD}(?: (?:de )?(?:porte )?${SIZE_WORD})?\\b`, "g"), n, (m) => {
    if (negatedBefore(n, m.index)) return;
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "pet", species: speciesOf(m[1]), ...(sizeOf(m[2]) ? { size: sizeOf(m[2]) } : {}) } });
  });
  scan(new RegExp(`(?:meu|minha|meus|minhas|o meu|a minha|nosso|nossa) ${PET_WORD} (?:e|eh|ta|sao|esta) (?:de )?(?:porte )?(?:bem |muito )?${SIZE_WORD}\\b`, "g"), n, (m) => {
    const species = speciesOf(m[1]);
    if (species === "gato" && /^gat[ao]s?$|^gatinh/.test(m[1]) && !PET_CONTEXT_RE.test(n) && !/castrad|filhote|idos|velhinh|senior/.test(m[0])) return;
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "pet", species, ...(sizeOf(m[2]) ? { size: sizeOf(m[2]) } : {}) } });
  });
  // Menção possessiva ("ração pro meu cachorro", "minha cachorra"): só espécie; gato só com contexto de pet.
  scan(new RegExp(`(?:meu|minha|meus|minhas|nosso|nossa) ${PET_WORD}\\b`, "g"), n, (m) => {
    if (hits.some((h) => h.st.kind === "pet")) return;
    const species = speciesOf(m[1]);
    if (species === "outro" && !PET_CONTEXT_RE.test(n)) return;
    if (species === "gato" && !PET_CONTEXT_RE.test(n)) return;
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "pet", species } });
  });

  // ---- casa
  scan(new RegExp(`(?:(?:aqui )?(?:em|na) casa )?somos (${NUM_RE}) (?:pessoas )?(?:em casa|aqui em casa|na casa|aqui|morando juntos)\\b`, "g"), n, (m) => {
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "household", people: toNum(m[1]) } });
  });
  scan(new RegExp(`(?:aqui )?em casa (?:somos|sao|moram) (${NUM_RE})(?: pessoas)?\\b`, "g"), n, (m) => {
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "household", people: toNum(m[1]) } });
  });
  scan(/(?<![a-z])(?:eu )?(?:moro|vivo) sozinh[oa]\b/g, n, (m) => {
    if (negatedBefore(n, m.index)) return;
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "household", people: 1 } });
  });
  scan(new RegExp(`(?<![a-z])moramos (?:em )?(${NUM_RE})(?: pessoas)?\\b`, "g"), n, (m) => {
    hits.push({ start: m.index, end: m.index + m[0].length, st: { kind: "household", people: toNum(m[1]) } });
  });

  // Dedupe (a mesma declaração casada por duas regras) e corte de pessoas absurdas.
  const statements: Statement[] = [];
  const seen = new Set<string>();
  for (const h of hits.sort((a, b) => a.start - b.start)) {
    if (h.st.kind === "household" && !(h.st.people >= 1 && h.st.people <= 20)) continue;
    const id = h.st.kind === "restriction" ? `r:${h.st.key}:${h.st.whoLabel ?? ""}` : h.st.kind;
    if (seen.has(id)) continue;
    seen.add(id);
    statements.push(h.st);
  }
  // O que sobra: máscara dos trechos casados (regras diferentes podem casar trechos sobrepostos).
  const covered = new Array<boolean>(n.length).fill(false);
  for (const h of hits) for (let i = h.start; i < h.end; i++) covered[i] = true;
  const rest = [...n].map((ch, i) => (covered[i] ? " " : ch)).join("");
  return { statements, rest: rest.replace(/\s+/g, " ").trim() };
}

export function extractStatements(text: string): Statement[] {
  return parseStatements(text).statements;
}

// Enfeite que pode sobrar numa mensagem que é SÓ a declaração ("oi, só pra você saber: sou vegano").
const FILLER = new Set(
  "oi ola opa e eu ah ahh hmm bom boa entao ok okay ta so pra para voce vc te lembrar lembra lembre saber sabe que alias tambem tb viu ne isso aqui anota anote ai pfv pf por favor obrigado obrigada valeu so um uma a o os as de do da dos das no na nos nas mais muito bem dia tarde noite tudo blz beleza informacao info importante detalhe nao esquece esqueca disso fica dica sempre lia".split(" ")
);
export function isStatementOnly(text: string): boolean {
  const { statements, rest } = parseStatements(text);
  if (!statements.length) return false;
  return rest.split(" ").filter((w) => w && !FILLER.has(w)).length === 0;
}

// "esquece minhas preferências" (tudo) ou "não sou mais vegano" / "voltei a comer carne" (uma chave).
export function parseForget(text: string): { all: true } | { keys: string[]; pet?: boolean } | null {
  const n = normMem(text);
  if (!n || n.length > 120) return null;
  if (/\b(esquece|esqueca|apaga|apague|limpa|limpe|zera|zere|remove|remova|tira|tire|reseta)\b.{0,25}\b(preferencias|restricoes|minhas restricoes|o que eu (te )?(disse|falei)( sobre mim)?|tudo (que|o que) eu (te )?(disse|falei)|meus dados de preferencia)\b/.test(n)) return { all: true };
  const keys: string[] = [];
  let pet = false;
  const notAnymore = n.match(/\bnao sou mais (diabetic[oa]|celiac[oa]|vegan[oa]|vegetarian[oa]|intolerante a lactose|intolerante ao gluten)\b/);
  if (notAnymore) {
    const k = dietKey(notAnymore[1]);
    if (k) keys.push(k);
  }
  const eatsAgain = n.match(/\b(?:voltei a|ja posso|agora posso|posso voltar a) (?:comer|tomar|consumir) (lactose|leite|gluten|carne|carnes|carne vermelha|porco|peixe|frango|acucar|doce|amendoim|ovo|ovos|soja|camarao|frutos do mar)\b/);
  if (eatsAgain) {
    const k = foodKey(eatsAgain[1], "noeat") ?? foodKey(eatsAgain[1], "intolerance");
    if (k) keys.push(k, ...(k === "carne" ? ["vegetariano", "vegano"] : []));
  }
  if (/\bnao tenho mais (?:o |a |um |uma )?(cachorr\w*|gat[oa]s?|pet|bicho)\b/.test(n)) pet = true;
  return keys.length || pet ? { keys, ...(pet ? { pet } : {}) } : null;
}

// ---------------------------------------------------------------- banco

function readPrefs(raw: unknown): StoredPreferences {
  const p = raw && typeof raw === "object" ? (raw as Partial<StoredPreferences>) : {};
  return {
    v: 1,
    restrictions: Array.isArray(p.restrictions) ? p.restrictions.filter((r) => r && typeof r.key === "string") : [],
    ...(p.pet?.species ? { pet: p.pet } : {}),
    ...(p.household ? { household: p.household } : {})
  };
}

// Funde declarações novas nas guardadas: restrição repetida não duplica (só a data antiga fica);
// pet/casa novos substituem os antigos. Devolve os rótulos do que é NOVO.
export function mergeStatements(prefs: StoredPreferences, statements: Statement[], at = new Date().toISOString()): { prefs: StoredPreferences; saved: string[] } {
  const next: StoredPreferences = { ...prefs, restrictions: [...prefs.restrictions] };
  const saved: string[] = [];
  for (const st of statements) {
    if (st.kind === "restriction") {
      if (next.restrictions.some((r) => r.key === st.key && (r.whoLabel ?? "") === (st.whoLabel ?? ""))) continue;
      next.restrictions.push({ key: st.key, label: st.label, who: st.who, ...(st.whoLabel ? { whoLabel: st.whoLabel } : {}), at });
      saved.push(st.whoLabel ? `${st.label} (${st.whoLabel})` : st.label);
    } else if (st.kind === "pet") {
      const same = next.pet && next.pet.species === st.species && (!st.size || next.pet.size === st.size);
      if (same) continue;
      next.pet = { species: st.species, ...(st.size ? { size: st.size } : next.pet?.species === st.species && next.pet.size ? { size: next.pet.size } : {}), at };
      saved.push(petLabel(next.pet));
    } else if (st.kind === "household") {
      if (next.household?.people === st.people) continue;
      next.household = { people: st.people, at };
      saved.push(st.people === 1 ? "mora sozinho(a)" : `${st.people} pessoas em casa`);
    }
  }
  return { prefs: next, saved };
}

function petLabel(pet: { species: PetSpecies; size?: string }): string {
  const name = pet.species === "outro" ? "pet" : pet.species;
  return pet.size ? `${name} ${pet.size === "filhote" || pet.size === "idoso" ? pet.size : `de porte ${pet.size}`}` : name;
}

type RawMemory = { prefs: StoredPreferences; items: { name: string; brand?: string; at: string; orderId: string }[] };
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; raw: RawMemory }>();

export function invalidateMemory(userId: string): void {
  cache.delete(userId);
}

async function loadRaw(userId: string): Promise<RawMemory> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.raw;
  const [user, orders] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } }),
    prisma.deliveryOrder.findMany({
      where: { userId, status: { in: REPEATABLE_DELIVERY_ORDER_STATUSES } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, items: true, createdAt: true }
    })
  ]);
  const items: RawMemory["items"] = [];
  for (const order of orders) {
    const list = Array.isArray(order.items) ? (order.items as { name?: unknown; brand?: unknown }[]) : [];
    for (const item of list) {
      if (!item || typeof item.name !== "string") continue;
      items.push({ name: item.name, ...(typeof item.brand === "string" && item.brand.trim() ? { brand: item.brand.trim() } : {}), at: order.createdAt.toISOString(), orderId: order.id });
    }
  }
  const raw = { prefs: readPrefs(user?.preferences), items };
  cache.set(userId, { at: Date.now(), raw });
  return raw;
}

// Memória pronta pra cadeia: restrições ditas (rótulo + filtros), pet, casa, marcas 2+ por prateleira e
// prateleiras recentes. `shelves` = o mapa que a execução usa (o de verdade por padrão).
export function buildMemory(raw: RawMemory, shelves: readonly ShelfNode[] = SHELF_MAP.shelves): LoadedMemory {
  const said = raw.prefs.restrictions.map((r) => ({ key: r.key, label: r.label, who: r.who, ...(r.whoLabel ? { whoLabel: r.whoLabel } : {}), filters: restrictionDef(r.key).filters }));
  const restrictions: CustomerMemory["restrictions"] = [];
  const at = new Map(raw.prefs.restrictions.map((r) => [r.key, r.at]));
  const texts = new Set<string>();
  for (const s of said) {
    // O rótulo vai pra IA ("sem lactose", "diabético (seu filho)"); os filtros, pras regras.
    for (const text of [s.whoLabel ? `${s.label} (${s.whoLabel})` : s.label, ...s.filters]) {
      if (texts.has(text)) continue;
      texts.add(text);
      restrictions.push({ text, at: at.get(s.key) ?? "" });
    }
  }
  // Marcas: por (prateleira, marca), contando PEDIDOS distintos.
  const shelfOf = new Map<string, string | undefined>();
  const shelfFor = (name: string) => {
    if (!shelfOf.has(name)) shelfOf.set(name, findShelfForProduct(name, shelves)?.id);
    return shelfOf.get(name);
  };
  const groups = new Map<string, { shelfId?: string; brand: string; orders: Set<string> }>();
  const recent: CustomerMemory["recentShelves"] = [];
  for (const item of raw.items) {
    const shelfId = shelfFor(item.name);
    if (shelfId && !recent.some((r) => r.shelfId === shelfId) && recent.length < 10) recent.push({ shelfId, at: item.at });
    if (!item.brand) continue;
    const key = `${shelfId ?? ""}|${normMem(item.brand)}`;
    const g = groups.get(key) ?? { ...(shelfId ? { shelfId } : {}), brand: item.brand, orders: new Set<string>() };
    g.orders.add(item.orderId);
    groups.set(key, g);
  }
  const brands = [...groups.values()]
    .filter((g) => g.orders.size >= 2)
    .map((g) => ({ ...(g.shelfId ? { shelfId: g.shelfId } : {}), brand: g.brand, count: g.orders.size }))
    .sort((a, b) => b.count - a.count);
  return {
    restrictions,
    ...(raw.prefs.pet ? { pet: raw.prefs.pet } : {}),
    ...(raw.prefs.household ? { household: raw.prefs.household } : {}),
    brands,
    recentShelves: recent,
    said
  };
}

export async function loadCustomerMemory(userId: string | undefined | null, opts: { shelves?: readonly ShelfNode[] } = {}): Promise<LoadedMemory> {
  if (!userId) return EMPTY_MEMORY;
  try {
    return buildMemory(await loadRaw(userId), opts.shelves);
  } catch (error) {
    console.warn("[memory:load:error]", error instanceof Error ? error.message : error);
    return EMPTY_MEMORY;
  }
}

// Grava o que o cliente declarou sobre si nesta mensagem. Nada declarado = nada gravado. Nunca lança.
export async function rememberStatement(userId: string, text: string): Promise<{ saved: string[] }> {
  try {
    const statements = extractStatements(text);
    if (!statements.length) return { saved: [] };
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
    const { prefs, saved } = mergeStatements(readPrefs(user?.preferences), statements);
    if (saved.length) {
      await prisma.user.update({ where: { id: userId }, data: { preferences: prefs as unknown as Prisma.InputJsonValue } });
      invalidateMemory(userId);
    }
    return { saved };
  } catch (error) {
    console.warn("[memory:remember:error]", error instanceof Error ? error.message : error);
    return { saved: [] };
  }
}

// "esquece minhas preferências" (sem `keys`) apaga tudo; com `keys` tira só aquelas restrições.
export async function forgetPreferences(userId: string, opts: { keys?: string[]; pet?: boolean } = {}): Promise<{ removed: string[] }> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
    const prefs = readPrefs(user?.preferences);
    let removed: string[];
    let next: StoredPreferences | null;
    if (!opts.keys && !opts.pet) {
      removed = [...prefs.restrictions.map((r) => r.label), ...(prefs.pet ? [petLabel(prefs.pet)] : [])];
      next = null;
    } else {
      const drop = new Set(opts.keys ?? []);
      removed = prefs.restrictions.filter((r) => drop.has(r.key)).map((r) => r.label);
      next = { ...prefs, restrictions: prefs.restrictions.filter((r) => !drop.has(r.key)) };
      if (opts.pet && prefs.pet) {
        removed.push(petLabel(prefs.pet));
        delete next.pet;
      }
    }
    await prisma.user.update({ where: { id: userId }, data: { preferences: next === null ? Prisma.DbNull : (next as unknown as Prisma.InputJsonValue) } });
    invalidateMemory(userId);
    return { removed };
  } catch (error) {
    console.warn("[memory:forget:error]", error instanceof Error ? error.message : error);
    return { removed: [] };
  }
}

// Alguma restrição dita pede o critério "saudável" (diabetes, "não como açúcar")?
export function memoryWantsHealthy(memory: LoadedMemory | undefined): boolean {
  return Boolean(memory?.said.some((s) => restrictionMeansSugar(s.key)));
}
