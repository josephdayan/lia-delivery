// Resolvedor ÚNICO de "quantos itens o cliente pediu" (Etapa 1, 07/10/2026).
//
// Antes, três contadores discordavam: o parser (parseBasketLines separava em todo " e "), o merge
// com a IA (a IA vencia) e o dialogue (regex própria). "romeu e julieta" virava 2 itens e
// "biscoito de chocolate e morango" também. Agora parseBasketLines continua sendo o TOKENIZADOR
// (separadores duros, quantidade, ruído) e este módulo decide, trecho a trecho, o que fazer com
// "A e B" / "A / B" / "A + B" / "A & B", na ordem (a primeira regra que decide vence):
//
//   0. pedaço sem substantivo ("2 e 3", "um e outro") some; pedaço que o parser sempre descarta
//      (conversa, narrativa, restrição) nunca gruda no vizinho.
//   1. ALWAYS_ONE (nomes compostos curados) e "kit …" → 1 item.
//      Cauda com quantidade própria ("2 coca e 1 ruffles") → 2 itens.
//   2. Cauda SÓ de atributo (cor, sabor, tamanho, marca) → 2 itens, a cauda herda o substantivo:
//      "leite integral e desnatado", "sabonete dove e lux", "pilha aa e aaa".
//      Exceção: o catálogo tem o literal "A e B" e a cauda não acha nada ("tênis preto e branco") → 1.
//   3. Marca compartilhada no fim ("shampoo e condicionador pantene", "…, ambos pantene") → a
//      marca vai para os dois, quando o catálogo confirma "A + marca".
//   4. Evidência de catálogo (catalogProbe, local e sem rede): A e B achados sozinhos → 2; só o
//      literal acha → 1; nenhum acha → 2 (os dois vão para "não encontrei" com o nome do cliente).
//   5. Na dúvida, separa (reason "ambiguo"): separar demais custa um toque ("Não quero este item"),
//      juntar demais perde um item em silêncio.
//
// Cada linha devolvida carrega `decision` e `reason`; o log `[list-split]` registra o que foi feito.
import {
  isNonItemSegment,
  mergeShoppingLines,
  normalizeMsg,
  sharesProductNoun,
  parseBasketLines,
  type ConjunctionPart,
  type ListItemDecision,
  type ParsedLine
} from "@/lib/lia-intents";
import { localCatalogProbe, localIsBrand, localIsConjoinedBrand } from "@/lib/stores/list-probe";

export type CatalogProbe = (phrase: string, opts?: { all?: boolean }) => { strong: boolean };

export type ResolvedListItem = ParsedLine & { decision: ListItemDecision; reason: string; span: string };

export type ResolveListItemsOptions = {
  // Linhas que a IA extraiu (extractShoppingList). Quando vêm, são reconciliadas com as
  // determinísticas trecho a trecho (mergeShoppingLines).
  aiItems?: ParsedLine[];
  // Evidência de catálogo. Padrão: catálogos locais das lojas (stores/list-probe.ts).
  catalogProbe?: CatalogProbe;
  // "Esta palavra é marca?". Padrão: marcas dos catálogos locais.
  isBrand?: (word: string) => boolean;
  // "Estes dois lados formam uma marca com 'e'/'&' no nome?" (Head & Shoulders). Padrão: catálogos locais.
  isConjoinedBrand?: (left: string, right: string) => boolean;
  // Escreve `[list-split]` no log para cada trecho com conjunção.
  log?: boolean;
};

// ---------- vocabulário ----------

// Nomes compostos em que o "e" faz parte do nome. Curto e curado: só entra nome com caso de teste.
// Comparado em forma normalizada; "&" vale como "e".
const ALWAYS_ONE = ["romeu e julieta", "cookies e cream", "black e white", "johnson e johnson", "head e shoulders", "dolce e gabbana", "procter e gamble", "marks e spencer"];

// Cabeça de kit/combo: "kit shampoo e condicionador" é UM produto.
const KIT_HEAD_RE = /^(?:(?:um|uma|o|a)\s+)?(?:kit|combo|conjunto|duo|trio|dupla|par)\b/;

const CONNECTORS = new Set(["de", "da", "do", "das", "dos", "com", "sem", "em", "para", "pra", "e", "a", "o", "as", "os"]);
const FILLER = new Set(["um", "uma", "uns", "umas", "outro", "outra", "outros", "outras", "mais", "algum", "alguma", "tambem", "so", "apenas"]);
const QTY_WORDS = new Set(["dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "meia", "duzia", "x", "un", "unidade", "unidades"]);

// Atributos: palavras que qualificam um produto e não são, sozinhas, um produto.
const ATTR_WORDS = new Set(
  [
    // cores
    "preto", "preta", "pretos", "pretas", "branco", "branca", "brancos", "brancas", "azul", "vermelho", "vermelha", "verde", "amarelo", "amarela",
    "rosa", "roxo", "roxa", "cinza", "marrom", "dourado", "dourada", "prata", "prateado", "bege", "lilas",
    // tamanhos
    "pequeno", "pequena", "medio", "media", "grande", "mini", "maxi", "p", "m", "g", "gg", "xg", "pp", "xs", "xl", "xxl", "familia",
    // variantes de dieta e estilo
    "integral", "desnatado", "desnatada", "semidesnatado", "semidesnatada", "zero", "diet", "light", "lactose", "gluten", "acucar", "sal", "gas",
    "natural", "tradicional", "original", "extra", "forte", "suave", "normal", "comum",
    // público
    "masculino", "masculina", "feminino", "feminina", "infantil", "adulto", "adulta",
    // sabores
    "chocolate", "morango", "baunilha", "limao", "uva", "maracuja", "coco", "menta", "hortela", "manga", "abacaxi", "pessego", "maca", "laranja",
    "caramelo", "cereja", "framboesa", "goiaba", "tangerina", "melancia", "amendoa", "avela", "banana",
    // pilhas
    "aa", "aaa", "c", "d"
  ]
);
const MEASURE_RE = /^\d+(?:[.,]\d+)?(?:l|lt|ml|kg|g|mg|un|cm|mm|m|v|w|gb|tb|pol)?$/;

const SHARE_MARK = "\u0006";
const SEP_RE = /(\s+e\s+|\s*\+\s*|\s+\/\s+|\s+&\s+)/i;
const LEADING_QTY_RE = /^(?:\d+\s*(?:x|un|unidades?)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|meia\s+duzia(?:\s+de)?|duzia(?:\s+de)?)(?:\s+|$)/;
const COMMAND_RE = /^(?:esquece|esqueci|tira|corta|cancela|deixa|nao|alias|na verdade|pensando|mais|outr[oa]s?)\b/;

// ---------- utilidades de texto ----------

function plain(s: string): string {
  return s.replace(/§/g, ",").replace(/¤/g, ".");
}
function nrm(s: string): string {
  return normalizeMsg(plain(s)).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function words(s: string): string[] {
  return plain(s).trim().split(/\s+/).filter(Boolean);
}
// Frase sem a quantidade do começo ("3 red bull" → "red bull").
function bare(s: string): string {
  let t = plain(s).trim();
  for (let i = 0; i < 2; i++) {
    const n = nrm(t);
    const m = n.match(LEADING_QTY_RE);
    if (!m || !n.slice(m[0].length).trim()) break;
    // remove o mesmo número de palavras da frase original
    const drop = m[0].trim().split(/\s+/).length;
    t = words(t).slice(drop).join(" ");
  }
  return t.trim();
}
function leadingQtyText(s: string): string {
  const t = plain(s).trim();
  const b = bare(t);
  return b.length < t.length ? t.slice(0, t.length - b.length).trim() : "";
}
function hasLeadingQty(s: string): boolean {
  return LEADING_QTY_RE.test(nrm(s)) && Boolean(nrm(bare(s)));
}

// Palavras que sobram depois de tirar quantidade, conectivos e enchimento. Vazio = pedaço sem produto.
function productWords(s: string): string[] {
  return nrm(s)
    .split(" ")
    .filter((w) => w && !CONNECTORS.has(w) && !FILLER.has(w) && !QTY_WORDS.has(w) && !/^\d+$/.test(w));
}

type Ctx = { probe: CatalogProbe; isBrand: (w: string) => boolean; conjoinedBrand: (left: string, right: string) => boolean };

function isAttrWord(w: string, ctx: Ctx): boolean {
  const n = nrm(w);
  if (!n) return false;
  return ATTR_WORDS.has(n) || MEASURE_RE.test(n) || ctx.isBrand(n);
}
// Cauda que só qualifica: "desnatado", "lux", "sem gás", "de morango", "600ml".
function isAttrOnly(s: string, ctx: Ctx): boolean {
  const ws = nrm(bare(s)).split(" ").filter((w) => w && !CONNECTORS.has(w));
  if (!ws.length) return false;
  if (ws.every((w) => isAttrWord(w, ctx))) return true;
  // marca composta ("oral b", "coca cola")
  return ctx.isBrand(ws.join(" "));
}

type Head = { head: string; connector: string };
// "leite integral" → { head: "leite", attrs começam em "integral" }; "biscoito de chocolate" →
// { head: "biscoito", connector: "de" }. Sem cabeça (1ª palavra já é atributo/marca) ou sem
// atributo nenhum → null: não há o que herdar.
function splitHead(s: string, ctx: Ctx): Head | null {
  const ws = words(bare(s));
  const idx = ws.findIndex((w) => isAttrWord(w, ctx));
  if (idx <= 0) return null;
  let cut = idx;
  let connector = "";
  if (CONNECTORS.has(nrm(ws[cut - 1]))) {
    connector = ws[cut - 1];
    cut -= 1;
  }
  if (cut <= 0) return null;
  return { head: ws.slice(0, cut).join(" "), connector };
}

function inheritText(left: string, right: string, ctx: Ctx): string | null {
  const h = splitHead(left, ctx);
  if (!h) return null;
  const qty = leadingQtyText(right);
  const rest = bare(right);
  const rightStartsWithConnector = CONNECTORS.has(nrm(words(rest)[0] ?? ""));
  const mid = rightStartsWithConnector || !h.connector ? "" : ` ${h.connector}`;
  return `${qty ? `${qty} ` : ""}${h.head}${mid} ${rest}`.replace(/\s+/g, " ").trim();
}

function hasBrand(s: string, ctx: Ctx): boolean {
  const ws = nrm(bare(s)).split(" ").filter(Boolean);
  return ws.some((w) => ctx.isBrand(w)) || (ws.length > 1 && ctx.isBrand(ws.slice(-2).join(" ")));
}
// "condicionador pantene" → { rest: "condicionador", brand: "pantene" }; aceita "da/do/de" antes da marca.
function trailingBrand(s: string, ctx: Ctx): { rest: string; brand: string } | null {
  const ws = words(bare(s));
  if (ws.length < 2) return null;
  for (const take of [2, 1]) {
    if (ws.length <= take) continue;
    const brand = ws.slice(-take).join(" ");
    if (!ctx.isBrand(nrm(brand))) continue;
    let restWords = ws.slice(0, -take);
    if (restWords.length > 1 && ["da", "do", "de"].includes(nrm(restWords[restWords.length - 1]))) restWords = restWords.slice(0, -1);
    const rest = restWords.join(" ");
    // a parte que sobra tem que ser um produto, não outro atributo
    if (!productWords(rest).length || isAttrOnly(rest, ctx)) return null;
    return { rest, brand };
  }
  return null;
}

// ---------- decisão por par ----------

type Pair =
  | { kind: "join"; reason: string }
  | { kind: "split"; reason: string }
  | { kind: "inherit"; reason: string; right: string }
  | { kind: "brand"; reason: string; left: string; right: string };

function decidePair(left: string, leftTail: string, right: string, pieceCount: number, ctx: Ctx): Pair {
  const L = bare(left);
  const R = bare(right);
  if (isNonItemSegment(plain(left)) || isNonItemSegment(plain(right))) return { kind: "split", reason: "nao_item" };
  if (COMMAND_RE.test(nrm(R))) return { kind: "split", reason: "comando" };
  // 1. nome composto curado e kit
  const pairNorm = `${nrm(leftTail)} e ${nrm(R)}`;
  if (ALWAYS_ONE.some((entry) => pairNorm.includes(entry))) return { kind: "join", reason: "nome_composto" };
  // marca composta com "e"/"&" no nome (09/10, rodada 1: "shampoo head e shoulders" virava 2 shampoos)
  if (ctx.conjoinedBrand(L, R)) return { kind: "join", reason: "marca_composta" };
  // cauda com quantidade própria ("2 coca e 1 ruffles"): é outro item, sem dúvida
  if (hasLeadingQty(right)) return { kind: "split", reason: "qty_propria" };
  if (KIT_HEAD_RE.test(nrm(L))) return { kind: "join", reason: "kit" };
  // 2. cauda só de atributo herda o substantivo
  if (isAttrOnly(R, ctx)) {
    const inherited = inheritText(left, right, ctx);
    if (inherited) {
      const literalExists = ctx.probe(`${L} e ${R}`, { all: true }).strong;
      if (literalExists && !ctx.probe(R).strong && !ctx.probe(bare(inherited)).strong) return { kind: "join", reason: "literal_no_catalogo" };
      return { kind: "inherit", reason: "cauda_so_atributo", right: inherited };
    }
  }
  // 3. marca compartilhada no fim (só em pares: com 3+ pedaços a marca pode ser só do último)
  if (pieceCount === 2 && !hasBrand(L, ctx)) {
    const tb = trailingBrand(R, ctx);
    if (tb && ctx.probe(`${L} ${tb.brand}`).strong) {
      const q = leadingQtyText(right);
      return { kind: "brand", reason: "marca_no_fim", left: `${left.trim()} ${tb.brand}`, right: `${q ? `${q} ` : ""}${tb.rest} ${tb.brand}`.trim() };
    }
  }
  // 4. evidência de catálogo
  const a = ctx.probe(L).strong;
  const b = ctx.probe(R).strong;
  if (a && b) return { kind: "split", reason: "catalogo_ambos" };
  if (!a && !b) {
    // 4b. só o literal acha ("mac e cheese")
    if (ctx.probe(`${L} e ${R}`, { all: true }).strong) return { kind: "join", reason: "catalogo_literal" };
    return { kind: "split", reason: "nenhum_acha" };
  }
  if (ctx.probe(`${L} e ${R}`, { all: true }).strong) return { kind: "join", reason: "catalogo_literal" };
  // 5. na dúvida, separa
  return { kind: "split", reason: "ambiguo" };
}

// ---------- o conjunction hook do parseBasketLines ----------

type Item = { text: string; decision?: ListItemDecision; reason?: string };

function makeConjunction(ctx: Ctx, log: boolean): (chunk: string) => ConjunctionPart[] {
  return (chunkRaw: string): ConjunctionPart[] => {
    const forced = chunkRaw.includes(SHARE_MARK);
    const chunk = chunkRaw.replace(SHARE_MARK, forced ? "\u0007" : "");
    const parts = chunk.split(SEP_RE);
    if (parts.length === 1) return [{ text: chunkRaw.replace(SHARE_MARK, "") }];
    const span = plain(chunk.replace("\u0007", "")).replace(/\s+/g, " ").trim();

    // pedaços e separadores; pedaço sem substantivo some (regra 0)
    const pieces: Array<{ text: string; sep: string }> = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i];
      const sep = i === 0 ? "" : parts[i - 1];
      pieces.push({ text, sep });
    }
    // marca declarada para todos ("…, ambos pantene"): a marca vem depois da marca-sentinela
    if (forced) {
      const last = pieces[pieces.length - 1];
      const [before, brandRaw] = last.text.split("\u0007");
      const brand = (brandRaw ?? "").trim();
      if (brand) {
        last.text = before.trim();
        const out = pieces
          .filter((p) => productWords(p.text).length > 0)
          .map((p) => ({ text: `${p.text.trim()} ${brand}`.replace(/\s+/g, " "), decision: "brand_shared" as const, reason: "ambos_marca", span }));
        if (log) console.log("[list-split]", JSON.stringify({ span, out: out.map((o) => o.text), decision: "brand_shared", reason: "ambos_marca" }));
        return out.length > 1 ? out : out.map((o) => ({ text: o.text }));
      }
    }
    const kept = pieces.filter((p) => productWords(p.text).length > 0 || isNonItemSegment(p.text));
    if (!kept.length) return [];
    const items: Item[] = [{ text: kept[0].text.trim() }];
    for (let i = 1; i < kept.length; i++) {
      const left = items[items.length - 1];
      const right = kept[i].text.trim();
      const verdict = decidePair(left.text, kept[i - 1].text, right, kept.length, ctx);
      if (verdict.kind === "join") {
        const sepText = kept[i].sep.trim();
        left.text = `${left.text} ${sepText || "e"} ${right}`.replace(/\s+/g, " ");
        left.decision = "joined";
        left.reason = verdict.reason;
      } else if (verdict.kind === "split") {
        if (!left.decision) {
          left.decision = "split";
          left.reason = verdict.reason;
        }
        items.push({ text: right, decision: "split", reason: verdict.reason });
      } else if (verdict.kind === "inherit") {
        left.decision = "inherited_head";
        left.reason = verdict.reason;
        items.push({ text: verdict.right, decision: "inherited_head", reason: verdict.reason });
      } else {
        left.text = verdict.left;
        left.decision = "brand_shared";
        left.reason = verdict.reason;
        items.push({ text: verdict.right, decision: "brand_shared", reason: verdict.reason });
      }
    }
    if (items.length === 1 && !items[0].decision) return [{ text: items[0].text }];
    if (log) {
      console.log("[list-split]", JSON.stringify({ span, out: items.map((i) => i.text), decisions: items.map((i) => `${i.decision}:${i.reason}`) }));
    }
    return items.map((item) => ({ text: item.text, decision: item.decision ?? "split", reason: item.reason ?? "ambiguo", span }));
  };
}

// "shampoo e condicionador, ambos pantene" / "os dois da pantene": troca a declaração por uma marca
// que o hook entende (a marca vale para todos os pedaços do trecho).
const SHARED_BRAND_RE =
  /([^,;.\n?]*(?:\s+e\s+|\s*\+\s*|\s+\/\s+|\s+&\s+)[^,;.\n?]*?)[,;]?\s+(?:ambos|ambas|os dois|as duas|os 2|as 2)\s+(?:(?:s[aã]o|da|do|de)\s+)*(?:marca\s+)?([\p{L}0-9][\p{L}0-9\- ]{1,30}?)(?=\s*(?:[,;.\n?]|$))/giu;
function markSharedBrand(text: string): string {
  return text.replace(SHARED_BRAND_RE, (_m, list: string, brand: string) => `${list} ${SHARE_MARK}${brand}`);
}

// ---------- API ----------

function withDefaults(line: ParsedLine, aiOnly: boolean): ResolvedListItem {
  return {
    ...line,
    decision: line.decision ?? "single",
    reason: line.reason ?? (aiOnly ? "ia" : "sem_conjuncao"),
    span: line.span ?? line.phrase
  };
}

export function resolveListItems(text: string, opts: ResolveListItemsOptions = {}): ResolvedListItem[] {
  const ctx: Ctx = { probe: opts.catalogProbe ?? localCatalogProbe, isBrand: opts.isBrand ?? localIsBrand, conjoinedBrand: opts.isConjoinedBrand ?? localIsConjoinedBrand };
  const deterministic = parseBasketLines(markSharedBrand(text), { conjunction: makeConjunction(ctx, Boolean(opts.log)) });
  if (!opts.aiItems?.length) return deterministic.map((line) => withDefaults(line, false));
  const detKeys = new Set(deterministic);
  return mergeShoppingLines(opts.aiItems, deterministic).map((line) => withDefaults(line, !detKeys.has(line) && !line.span));
}

// Quantos itens DISTINTOS o texto pede. Fonte única de contagem (sinais multiItem / looksLikeProductList,
// isPlainShoppingList, "Já anotei"); a Etapa 2 usa para decidir entre vitrine e Flow.
export function countDistinctItems(text: string, opts: ResolveListItemsOptions = {}): number {
  return resolveListItems(text, opts).length;
}

// "2x coca zero 2l" — o formato do "Já anotei".
export function notedItemLabels(text: string, opts: ResolveListItemsOptions = {}): string[] {
  return resolveListItems(text, opts).map((line) => `${line.qty}x ${line.phrase}`);
}

// ---------- quantidade × tamanho × contagem (10/10, rodada 9 A1/A2/A4) ----------
// A IA (extração e gerente de diálogo) às vezes lê a quantidade diferente do que a mensagem diz: "um par de pilhas AA"
// virava 1 (ou 2 cartelas), "água sanitária 5 litros" e "sachê gato sênior e areia" viravam 2x sem número nenhum na
// mensagem, e "3 refrigerantes guaraná 2l" perdia o "2l". O parser determinístico lê a contagem da própria frase; aqui as
// linhas da IA se acertam com ele:
//   1. contagem dita por palavra (par, dúzia, "duas") que a IA deixou em 1 → vale a do parser;
//   2. quantidade > 1 sem NENHUM número/palavra de contagem na mensagem (tamanho, preço, idade e índice de lista não
//      contam) → 1, a IA inventou;
//   3. tamanho dito ("2l", "5 litros", "3kg") que a IA tirou da busca → volta para a frase.
const SIZE_TOKEN_RE = /\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|mg|ml|l|lt|lts|litros?|cm|mm|m|w|v|mah|gb|tb|polegadas?|pol)\b/gi;
const COUNT_WORD_RE = /\b(?:\d+|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|duzias?|dezenas?|pares|par)\b/;
export function textHasCount(text: string): boolean {
  const n = normalizeMsg(text)
    .replace(SIZE_TOKEN_RE, " ")
    .replace(/r\$\s*\d+(?:[.,]\d+)?/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:reais|real|conto|contos|pila|anos?|meses|mes|dias?|horas?|h|min)\b/g, " ")
    .replace(/(?:^|\s)\d{1,2}\s*[).:-](?=\s|$)/g, " ")
    .replace(/\b\d{5}-?\d{3}\b/g, " ");
  return COUNT_WORD_RE.test(n);
}
function sizeTokens(phrase: string): string[] {
  return (phrase.match(SIZE_TOKEN_RE) ?? []).map((t) => t.trim());
}
export function reconcileLineCounts<T extends { phrase: string; qty: number; qtyExplicit?: boolean }>(lines: T[], said: string): T[] {
  if (!said.trim() || !lines.length) return lines;
  const det = resolveListItems(said);
  const hasCount = textHasCount(said);
  return lines.map((line) => {
    const twins = det.filter((d) => sharesProductNoun(d.phrase, line.phrase));
    // Só gêmeo de um para um: a lista numerada que o parser não separou ("1) 2x carvão 3kg 2) …") casa com toda linha
    // da IA e não diz nada sobre nenhuma.
    const twin = twins.length === 1 && lines.filter((l) => sharesProductNoun(twins[0].phrase, l.phrase)).length === 1 ? twins[0] : undefined;
    let out = line;
    if (twin?.qtyExplicit && twin.qty > 1 && line.qty === 1) out = { ...out, qty: twin.qty, qtyExplicit: true };
    // (O parser soma a linha repetida, "arroz, feijão, arroz" = 2x arroz: aí o gêmeo dele também diz 2.)
    else if (line.qty > 1 && !hasCount && (!twin || twin.qty === 1)) out = { ...out, qty: 1, qtyExplicit: false };
    if (twin) {
      const have = sizeTokens(out.phrase);
      const missing = sizeTokens(twin.phrase);
      if (missing.length && !have.length) out = { ...out, phrase: `${out.phrase} ${missing.join(" ")}` };
    }
    return out;
  });
}

// "presente pra um menino de 7 anos até R$ 80. Também um cartão de aniversário e embalagem de presente" (10/10, rodada 9
// A3): a recomendação levava a mensagem inteira e o cartão e a embalagem sumiam calados. O que vem depois de "também"
// (ou "além disso") é pedido à parte: os itens desse trecho, no formato de busca ("2 pilhas, cartão"), ou null.
export function itemsAfterAlso(text: string): string | null {
  const m = text.match(/(?:^|[.,;!?]\s*|\s)(?:e\s+)?(?:tamb[eé]m|al[eé]m disso)\b[,:]?\s+(.+)$/i);
  if (!m || m.index === 0) return null;
  const rest = m[1].replace(/^(?:quero|queria|preciso(?:\s+de)?|vou querer|me (?:v[eê]|manda))\s+/i, "").trim();
  const lines = resolveListItems(rest).filter((line) => !isNonItemSegment(line.phrase));
  return lines.length ? lines.map((line) => (line.qty > 1 ? `${line.qty} ${line.phrase}` : line.phrase)).join(", ") : null;
}
