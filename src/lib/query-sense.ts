// Sentido do item pelo CONTEXTO da conversa (11/10, rodada 19 g53).
// - R19-2: "tenho uma gata castrada de 4 anos" e depois "ração pra ela" trazia 3 rações de cachorro na frente. A espécie
//   (e "castrada"/filhote/adulto) dita antes vale para a busca de comida de pet que não diz a espécie.
// - R19-3: "base" num pedido de maquiagem ("make, base, batom e gloss") virava "Base Fortilon Salva Unhas". O contexto da
//   mesma mensagem (ou da conversa) decide: maquiagem → base de rosto; unha → base de unha. Sem contexto, nada muda.
// Funções puras: quem chama passa os textos (mensagem atual primeiro, depois as anteriores, da mais nova à mais velha).
import { normalizeMsg } from "./lia-intents";
import { parseStatements } from "./recommend/memory";

export type PetHint = { species: "gato" | "cachorro"; stage?: "castrado" | "filhote" | "adulto" | "senior" };

const PET_FOOD_HEAD_RE = /^(?:racao|racoes|petiscos?|sache|saches|bifinhos?|patezinho|pate|alimento umido)\b/;
const SPECIES_IN_PHRASE_RE = /\b(gat[oa]s?|gatinh[oa]s?|felin[oa]s?|cat|cachorr[oa]s?|cachorrinh[oa]s?|cao|caes|canin[oa]s?|dog|cadela|filhote de (?:cao|gato)|coelh[oa]s?|roedor(?:es)?|hamster|passar[oa]s?|passarinh[oa]s?|calopsita|periquito|peixes?|aves?|tartaruga)\b/;
const STAGE_IN_PHRASE_RE = /\b(castrad[oa]s?|filhotes?|adult[oa]s?|senior|idos[oa]s?|kitten|puppy)\b/;

function stageOf(n: string): PetHint["stage"] | undefined {
  if (/\bcastrad[oa]s?\b/.test(n)) return "castrado";
  if (/\b(filhote|filhotinh[oa]|\d+ mes(?:es)?|recem nascid[oa])\b/.test(n)) return "filhote";
  if (/\b(idos[oa]|velhinh[oa]|senior)\b/.test(n)) return "senior";
  const years = n.match(/\b(\d{1,2}) anos?\b/);
  if (years) {
    const age = Number(years[1]);
    if (age >= 8) return "senior";
    if (age >= 1) return "adulto";
  }
  return undefined;
}

// A declaração de pet mais recente (texto atual primeiro). "gata" sem contexto de pet continua de fora (parseStatements).
export function petHintFrom(texts: readonly (string | undefined | null)[]): PetHint | null {
  for (const raw of texts) {
    if (!raw) continue;
    const pet = parseStatements(raw).statements.find((st) => st.kind === "pet");
    if (!pet || pet.kind !== "pet" || pet.species === "outro") continue;
    const stage = stageOf(normalizeMsg(raw));
    return { species: pet.species, ...(stage ? { stage } : {}) };
  }
  return null;
}

const CAT_RE = /\b(gat[oa]s?|gatinh[oa]s?|felin[oa]s?)\b/;
const DOG_RE = /\b(cachorr[oa]s?|cachorrinh[oa]s?|cao|caes|canin[oa]s?|dog|cadela)\b/;
// O turno atual manda: pet declarado agora vale; espécie oposta citada agora ("e um petisco pro cachorro") desliga a da
// conversa para este turno inteiro, porque não dá pra saber de qual bicho é cada item.
export function petHintForTurn(current: readonly (string | undefined | null)[], earlier: readonly (string | undefined | null)[]): PetHint | null {
  const hint = petHintFrom([...current, ...earlier]);
  if (!hint) return null;
  const now = current.map((t) => normalizeMsg(t ?? "")).join(" ");
  if ((hint.species === "gato" ? DOG_RE : CAT_RE).test(now)) return null;
  return hint;
}

// "ração" / "petisco" / "sachê" sem espécie: entra a espécie (e a fase) do pet da conversa. Frase que já diz uma
// espécie (qualquer uma) fica como está; a fase só entra quando a frase não diz nenhuma.
export function applyPetHint(phrase: string, hint: PetHint | null | undefined): string {
  if (!hint) return phrase;
  const n = normalizeMsg(phrase);
  if (!PET_FOOD_HEAD_RE.test(n) || SPECIES_IN_PHRASE_RE.test(n)) return phrase;
  const head = /^(?:racao|racoes)\b/.test(n);
  const stage = head && hint.stage && !STAGE_IN_PHRASE_RE.test(n) ? ` ${hint.stage}` : "";
  return `${phrase.trim()} pra ${hint.species}${stage}`;
}

// ---------- "base": maquiagem × unha ----------
const MAKEUP_CONTEXT_RE =
  /\b(make|makes|maquiagem|maquiagens|maquiage|maquia|batom|batons|gloss|rimel|mascara de cilios|cilios|sombras?|blush|corretivos?|po compacto|po facial|delineador|iluminador|contorno|bronzer|primer facial|pincel|pinceis|beauty blender|esponja de maquiagem|rosto|facial|pele (?:oleosa|seca|mista|clara|morena|negra)|bb cream|cc cream|labial|lapis de olho)\b/;
const NAIL_CONTEXT_RE = /\b(unhas?|esmaltes?|acetona|alicate|manicure|cuticula|lixa de unha|removedor de esmalte|top coat|extra brilho)\b/;
// Nome de base que não é de rosto: unha, móvel/luminária, carregador, livro.
const NOT_FACE_BASE_RE =
  /\b(unhas?|esmaltes?|fortalecedor\w*|endurecedor\w*|nail|antifung\w*|risque|impala|colorama|dailus|fortilon|top coat|casco de cavalo|cobertura brilhante|extra brilho|base coat|luminaria|mesa|cama|box|carregador|wireless|conhecimento|suporte|bolo|pizza|tomate)\b/;
const NOT_NAIL_BASE_RE =
  /\b(facial|rosto|liquida|maquiagem|makeup|bb|cc|cushion|stick|compacta|mousse|serum|fps|luminaria|mesa|cama|box|carregador|wireless|conhecimento|suporte|bolo|pizza|tomate)\b/;

// Só "base" solta (com cor/preço no máximo): "base de unha", "base líquida", "base boca rosa" já dizem o tipo.
const BARE_BASE_RE = /^bases?(?: (?:clara|media|escura|bege|nude|barata|baratinha|mais barata|mais barato|boa|de cor clara|tom claro|tom medio|tom escuro))?$/;

export type BaseSense = { kind: string; extraQueries: string[]; rejects: (name: string) => boolean; searchAs?: string };

// ---------- outros itens que o contexto decide (11/10, rodada 21 g58, R21-11) ----------
// B3: "vela" na festa de aniversário trazia "Vela Copo Kosher" / "Vela Castiçal"; B4: "luva de borracha" na faxina trazia
// "Luva Segurança Tricô ... Borracha". Mesma forma do "base": buscas extras do tipo certo e o outro tipo sai (quem chama
// mantém as opções de antes se nada sobrar).
const PARTY_CONTEXT_RE = /\b(aniversarios?|niver|festa|festinha|parabens|bolo|mesversario|anos d[oa] (?:meu|minha))\b/;
const CLEANING_CONTEXT_RE = /\b(faxina|limpeza|limpar|desinfetante|agua sanitaria|detergente|pano de chao|rodo|vassoura|saco de lixo|lavar louca|banheiro)\b/;
// `explicit` = a frase já diz o tipo e vale sem contexto ("luva de borracha", "tesoura escolar").
type ContextRule = { item: RegExp; explicit?: RegExp; context?: RegExp; kind: string; extraQueries: string[]; reject: RegExp; searchAs?: string };
const SCHOOL_CONTEXT_RE = /\b(escola|escolar|material escolar|caderno|cadernos|lapis|apontador(?:es)?|borracha escolar|mochila|estojo|cola (?:branca|bastao)|giz de cera|regua)\b/;
const CONTEXT_RULES: ContextRule[] = [
  {
    item: /^velas?(?: (?:de )?(?:numero|n)?\s*\d+| colorid[ao]s?| pequen[ao]s?| comum| simples)?$/,
    context: PARTY_CONTEXT_RE,
    kind: "vela de aniversário",
    extraQueries: ["vela de aniversario", "vela numero", "vela para bolo"],
    reject: /\b(kosher|castical|7 dias|sete dias|votiva|aromatica|aromatizada|perfumada|rechaud|copo|massagem|massageadora|religios\w*|filtro|igreja|santo|ignifug\w*|lamparina|pote|lata)\b/
  },
  {
    item: /^luvas?(?: de)? (?:borracha|latex|limpeza)(?: (?:p|m|g|gg|tamanho \w+))?$|^luvas?$/,
    // "luva de borracha" sozinha já é a de limpeza; "luva" solta só com contexto de faxina.
    explicit: /\b(?:borracha|latex|limpeza)\b/,
    context: CLEANING_CONTEXT_RE,
    kind: "luva de limpeza",
    searchAs: "luva",
    extraQueries: ["luva de limpeza", "luva latex multiuso"],
    reject: /\b(seguranca|trico|anticorte|soldador|raspa|vaqueta|epi|pigmentad\w*|motociclista|ciclismo|boxe|goleiro|termica|procedimento|cirurgic\w*|nitrilica descartavel)\b/
  },
  {
    // R21a-6 (11/10, rodada 21 g58): "tesoura" na lista da escola abria com a multiuso de inox da Obramax/Brinox.
    item: /^tesouras?(?: (?:escolar|sem ponta|ponta redonda|infantil|pequena))?$/,
    explicit: /\b(?:escolar|sem ponta|ponta redonda|infantil)\b/,
    context: SCHOOL_CONTEXT_RE,
    kind: "tesoura escolar",
    extraQueries: ["tesoura escolar", "tesoura sem ponta"],
    reject: /\b(multiuso|vonder|poda|jardim|cozinha|costura|cabelo|cabeleireiro|profissional|aves|frango|chapa|funileiro|picotar|alfaiate)\b/
  }
];
export function contextSenseFor(phrase: string, texts: readonly (string | undefined | null)[]): BaseSense | null {
  const p = normalizeMsg(phrase).replace(/\s+/g, " ").trim();
  for (const rule of CONTEXT_RULES) {
    if (!rule.item.test(p)) continue;
    const explicit = Boolean(rule.explicit?.test(p));
    if (!explicit && rule.context && !texts.some((raw) => raw && rule.context!.test(normalizeMsg(raw)))) continue;
    return { kind: rule.kind, extraQueries: rule.extraQueries, rejects: (name) => rule.reject.test(normalizeMsg(name)), ...(rule.searchAs ? { searchAs: rule.searchAs } : {}) };
  }
  return null;
}

function senseOfText(n: string): "maquiagem" | "unha" | null {
  // A palavra "base" em si não é contexto; sobra o resto da frase.
  const rest = n.replace(/\bbases?\b/g, " ");
  const makeup = MAKEUP_CONTEXT_RE.test(rest);
  const nail = NAIL_CONTEXT_RE.test(rest);
  if (makeup === nail) return null;
  return makeup ? "maquiagem" : "unha";
}

export function baseSenseFor(phrase: string, texts: readonly (string | undefined | null)[]): BaseSense | null {
  const p = normalizeMsg(phrase).replace(/\s+/g, " ").trim();
  if (!BARE_BASE_RE.test(p)) return null;
  let kind: "maquiagem" | "unha" | null = null;
  for (const raw of texts) {
    if (!raw) continue;
    kind = senseOfText(normalizeMsg(raw));
    if (kind) break;
  }
  if (!kind) return null;
  if (kind === "maquiagem") {
    return {
      kind,
      extraQueries: ["base liquida", "base facial", "bb cream"],
      rejects: (name) => NOT_FACE_BASE_RE.test(normalizeMsg(name))
    };
  }
  return {
    kind,
    extraQueries: ["base para unhas", "base fortalecedora"],
    rejects: (name) => NOT_NAIL_BASE_RE.test(normalizeMsg(name))
  };
}

// Frase de item com cara de pergunta ("tem poleiro de qualquer material então", 11/10, rodada 19 g53, R19a-10): o "tem" do
// começo, a indiferença ("de qualquer material") e o "então" do fim não são palavras do produto — a busca era "tem poleiro"
// e dava "não achei". Só limpa quando sobra produto.
export function cleanAskPhrase(phrase: string): string {
  const cleaned = phrase
    .replace(/^\s*(?:e\s+)?(?:(?:voc[eê]s?|vcs?)\s+)?(?:tem|t[eê]m|teria|tens)\s+(?=\S)/i, "")
    .replace(/\s+(?:de|em|com|d[ao])\s+qualquer\s+(?:material|tamanho|formato|estilo|jeito|tipo|marca|cor|modelo|sabor)\b/gi, " ")
    .replace(/\s+(?:ent[aã]o|a[ií]|mesmo)\s*[?!.]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[a-zà-ú]{3,}/i.test(cleaned) ? cleaned : phrase;
}

// Nome que o cliente fala × nome da prateleira (11/10, rodada 21 g58, R21-8): "hidratante de mão" dava "não achei" e
// "creme pra mãos" trazia 5 opções. A frase vira o nome do catálogo; o resto dela (marca, tamanho) fica.
const PHRASE_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(?:hidratantes?|cremes?(?:\s+hidratantes?)?)\s+(?:de|da|das|para|pra|p\/)\s+(?:as\s+)?m[aã]os?\b/i, "creme para mãos"]
];
export function applyPhraseSynonyms(phrase: string): string {
  for (const [re, to] of PHRASE_SYNONYMS) if (re.test(phrase)) return phrase.replace(re, to).replace(/\s+/g, " ").trim();
  return phrase;
}
