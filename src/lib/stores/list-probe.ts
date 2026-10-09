// Evidência de catálogo para o resolvedor de lista (src/lib/list-items.ts). Sem rede, sem banco,
// barato: olha só os catálogos LOCAIS das lojas ligadas, com um índice por prefixo de 3 letras
// montado uma vez. Responde duas perguntas:
//   - localCatalogProbe(frase): algum item do catálogo responde por esta frase? (mesma régua do
//     piso do concierge: conciergeMatchIsStrong)
//   - localIsBrand(palavra): esta palavra é marca de algum item do catálogo?
import { listStores } from "./index";
import { conciergeMatchIsStrong, normalizeText, queryTokens, type CatalogItem } from "./types";

type Index = {
  byPrefix: Map<string, CatalogItem[]>;
  // marcas de uma palavra só (já filtradas das palavras genéricas) e marcas compostas inteiras
  singleBrands: Set<string>;
  multiBrands: Set<string>;
};

let index: Index | null = null;
const cache = new Map<string, boolean>();
const MAX_CANDIDATES = 4000;

function prefixKey(word: string): string {
  return word.length >= 3 ? word.slice(0, 3) : word;
}

// Palavras que aparecem no campo "marca" dos catálogos mas não são marca de verdade.
const NOT_A_BRAND = new Set(["sem marca", "generico", "natural", "tradicional", "original", "kids", "baby", "pet", "premium", "gold", "mini", "max"]);

function build(): Index {
  const byPrefix = new Map<string, CatalogItem[]>();
  const inName = new Map<string, number>(); // itens cujo NOME tem a palavra, mas a marca não
  const inBrand = new Map<string, number>(); // itens cuja MARCA tem a palavra
  const multiBrands = new Set<string>();
  const brandWordsSeen = new Set<string>();
  for (const store of listStores()) {
    for (const item of store.listCatalog()) {
      const seen = new Set<string>();
      const brand = normalizeText(item.brand ?? "");
      const brandWords = new Set(brand.split(" ").filter(Boolean));
      const text = `${item.name} ${item.brand ?? ""} ${item.category ?? ""}`;
      for (const word of normalizeText(text).split(" ")) {
        if (!word) continue;
        const key = prefixKey(word);
        if (seen.has(key)) continue;
        seen.add(key);
        const list = byPrefix.get(key);
        if (list) list.push(item);
        else byPrefix.set(key, [item]);
      }
      if (brand.length >= 3 && !NOT_A_BRAND.has(brand)) {
        for (const w of brandWords) {
          inBrand.set(w, (inBrand.get(w) ?? 0) + 1);
          brandWordsSeen.add(w);
        }
        if (brandWords.size > 1) multiBrands.add(brand);
      }
      for (const w of new Set(normalizeText(item.name).split(" "))) {
        if (w && !brandWords.has(w)) inName.set(w, (inName.get(w) ?? 0) + 1);
      }
    }
  }
  // Palavra de marca só se ela raramente aparece em nome de produto de OUTRA marca: "pantene",
  // "dove", "fanta" passam; "leite", "café", "suco" (que aparecem no campo marca de alguns itens
  // mas são o próprio produto) ficam de fora.
  const singleBrands = new Set<string>();
  for (const w of brandWordsSeen) {
    if (w.length < 3 || NOT_A_BRAND.has(w)) continue;
    const generic = inName.get(w) ?? 0;
    const branded = inBrand.get(w) ?? 0;
    if (generic <= Math.max(1, branded * 0.25)) singleBrands.add(w);
  }
  return { byPrefix, singleBrands, multiBrands };
}

function ensureIndex(): Index {
  if (!index) index = build();
  return index;
}

// Marca conhecida? Aceita a marca inteira ("oral b") ou a 1ª palavra de marca composta ("coca" de
// "coca cola"). Palavras curtas e genéricas nunca contam.
export function localIsBrand(word: string): boolean {
  const w = normalizeText(word);
  if (w.length < 3 || NOT_A_BRAND.has(w)) return false;
  const idx = ensureIndex();
  return w.includes(" ") ? idx.multiBrands.has(w) : idx.singleBrands.has(w);
}

export type ProbeResult = { strong: boolean };

// Algum item de algum catálogo local responde pela frase? `all` = cobertura total das palavras
// (usado para provar que o literal "A e B" existe como nome de produto).
export function localCatalogProbe(phrase: string, opts?: { all?: boolean }): ProbeResult {
  const key = `${opts?.all ? "1" : "0"}|${normalizeText(phrase)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return { strong: hit };
  const result = computeStrong(phrase, opts);
  if (cache.size > 2000) cache.clear();
  cache.set(key, result);
  return { strong: result };
}

function computeStrong(phrase: string, opts?: { all?: boolean }): boolean {
  const tokens = queryTokens(phrase).filter((t) => !/^\d+$/.test(t));
  if (!tokens.length) return false;
  const idx = ensureIndex();
  // Candidatos = postings do token mais raro: todo item que cobre a frase tem uma palavra com esse prefixo.
  let best: CatalogItem[] | null = null;
  for (const token of tokens) {
    const list = idx.byPrefix.get(prefixKey(token));
    if (!list) return false;
    if (!best || list.length < best.length) best = list;
  }
  if (!best) return false;
  const limit = Math.min(best.length, MAX_CANDIDATES);
  for (let i = 0; i < limit; i++) {
    if (conciergeMatchIsStrong(phrase, best[i], opts?.all ? { allTokens: true } : undefined)) return true;
  }
  return false;
}

// Marcas escritas com "e"/"&" no nome ("Head & Shoulders", "Johnson & Johnson", "Dolce & Gabbana", "Tom e Jerry")
// (09/10, rodada 1): o cliente digita "head e shoulders" e o "e" não pode virar separador de itens. Vem do
// campo marca dos catálogos (regra geral, sem lista fixa): guarda o lado esquerdo → lados direitos possíveis.
let conjoined: Map<string, Set<string>> | null = null;
function ensureConjoined(): Map<string, Set<string>> {
  if (conjoined) return conjoined;
  const map = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const store of listStores()) {
    for (const item of store.listCatalog()) {
      const brand = item.brand;
      if (!brand || seen.has(brand) || !/&|\s(?:e|and)\s/i.test(brand)) continue;
      seen.add(brand);
      const [a, b, ...more] = brand.split(/\s*&\s*|\s+(?:e|and)\s+/i).map((p) => normalizeText(p));
      if (!a || !b || more.length || a.length < 2 || b.length < 2) continue;
      const rights = map.get(a) ?? new Set<string>();
      rights.add(b);
      map.set(a, rights);
    }
  }
  conjoined = map;
  return map;
}
// `left` termina e `right` começa com os dois lados de uma marca composta conhecida?
export function localIsConjoinedBrand(left: string, right: string): boolean {
  const l = normalizeText(left).split(" ").filter(Boolean);
  const r = normalizeText(right).split(" ").filter(Boolean);
  if (!l.length || !r.length) return false;
  const map = ensureConjoined();
  for (let i = 1; i <= Math.min(3, l.length); i++) {
    const rights = map.get(l.slice(-i).join(" "));
    if (!rights) continue;
    for (let j = 1; j <= Math.min(3, r.length); j++) if (rights.has(r.slice(0, j).join(" "))) return true;
  }
  return false;
}

// Só para testes: descarta o índice e o cache.
export function resetListProbe(): void {
  index = null;
  conjoined = null;
  cache.clear();
}
