// Busca AO VIVO na prateleira da loja (07/10/2026). Até aqui a Lia procurava só numa cópia do
// catálogo colhida semanas antes (top-vendas + alguns termos): produto fora da cópia nunca
// aparecia ("bola de tênis" na Casa & Vídeo existe e a Lia mostrava bola inflável). Agora, em
// paralelo à cópia, cada loja VTEX responde à busca inteligente do próprio site — a mesma que o
// cliente veria — e o resultado entra no mesmo funil (ranking → checagem ao vivo → rerank). A
// cópia continua como rede de segurança quando a loja não responde a tempo.
//
// Regras que não mudam:
// - só o que a PRÓPRIA loja vende (seller "1") e tem estoque — marketplace de terceiros não é comprável;
// - o SKU tem o mesmo formato da cópia (`<prefixo>-<itemId>`), então checagem de frete/estoque,
//   cesta e compra por API funcionam sem saber de onde o item veio;
// - remédio de receita nunca entra: prateleira de medicamento da loja só passa pela porta do
//   remédio isento (abaixo), e as guardas ANVISA de runtime (anvisa.ts) valem para o resto;
// - farmácia amplia em QUALQUER categoria (08/10, placar r4): a allowlist "só categorias da cópia"
//   escondia teste de gravidez, Havaianas e vitamina C da Drogaria SP e pilhas da Pague Menos —
//   o que barra remédio é a lista de bloqueio (categoria + ANVISA), não a cópia;
// - nunca lança: falha/timeout = lista vazia, e a cópia responde sozinha.
//
// Remédio isento AO VIVO (08/10): com LIA_MEDICINE_MIP=true, a prateleira de medicamento das
// farmácias que vendem MIP pela Lia (Drogaria SP, Pague Menos) devolve item marcado `medicine:
// "mip"` com a MESMA lista positiva da colheita (scripts/harvest-mip-catalog.mts): Drogaria SP =
// prateleira "Remédios" (isentos) ou "Medicamentos" marcado "Sem Tarja" sem retenção de receita;
// Pague Menos = código de barras de um MIP da Drogaria SP e sem marca de antibiótico/controlado/
// restrito. Tudo passa ainda por `mipOnly` (guarda de prescrição por nome). Fora dessa prateleira,
// item com cara de remédio (comprimido, princípio ativo) nessas duas lojas também sai pela porta
// do MIP — nunca como produto comum. Com a flag desligada, nada muda: remédio fica fora.
import { VTEX_API_STORES } from "../purchase/vtex-checkout";
import { storeFetch } from "../store-relay";
import { isMedicine, mipOnly, withoutMedicine, withoutVeterinaryMedicine } from "./anvisa";
import { MIP_STORE_KEYS, isPrescriptionDrugName, isPrescriptionText, isValidGtin, medicineEnabled, onlyDigits } from "../medicine";
import { MIP_CATALOG as DSP_MIP_CATALOG } from "./drogariasp-mip-catalog";
import type { CatalogItem } from "./types";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 600;

// Padrão LIGADO desde o placar de 07/10 (cobertura 85,8% → 92,6% com a mesma precisão); desliga
// com `LIA_LIVE_SEARCH=false`. Testes e golden desligam em tests/helpers (sem rede).
export function liveSearchEnabled(): boolean {
  return process.env.LIA_LIVE_SEARCH !== "false";
}

function timeoutMs(): number {
  const value = Number(process.env.LIA_LIVE_SEARCH_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 500 ? value : 3000;
}

// Farmácias (a cópia delas foi colhida com allowlist de categoria; o ao vivo não precisa dela).
const PHARMACY_STORES = new Set(["drogariasp", "paguemenos", "drogal", "extrafarma", "farmaciaindiana", "drogariaspacheco", "drogariacatarinense"]);
const MEDICINE_CATEGORY_RE = /(medicament|rem[eé]dio|prescri|tarja|isent|gen[eé]ric|controlad|manipula)/i;

type IsProduct = {
  productName?: string;
  brand?: string;
  link?: string;
  linkText?: string;
  categories?: string[];
  // Especificações da loja ("Classificação": "Sem Tarja", "Antibiotico": "Sim"…), como a busca
  // inteligente da VTEX as expõe.
  properties?: Array<{ name?: string; values?: string[] }>;
  items?: Array<{
    itemId?: string;
    ean?: string;
    name?: string;
    nameComplete?: string;
    images?: Array<{ imageUrl?: string }>;
    sellers?: Array<{ sellerId?: string; commertialOffer?: { Price?: number; AvailableQuantity?: number } }>;
  }>;
};

const norm = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
function property(product: IsProduct, name: string): string {
  const key = norm(name);
  return (product.properties ?? []).filter((p) => norm(p.name ?? "") === key).flatMap((p) => p.values ?? []).join(" ");
}

// Códigos de barras dos isentos da Drogaria SP (a lista positiva que a Pague Menos herda na
// colheita). Montado na primeira prateleira de medicamento que chegar ao vivo.
let dspMipEans: Set<string> | null = null;
function dspMipEanSet(): Set<string> {
  if (!dspMipEans) dspMipEans = new Set(DSP_MIP_CATALOG.map((item) => item.ean).filter((ean): ean is string => Boolean(ean)));
  return dspMipEans;
}

export function liveMipStore(storeKey: string): boolean {
  return medicineEnabled() && MIP_STORE_KEYS.includes(storeKey);
}

// Lista positiva da farmácia para um produto da prateleira de medicamento (puro, testável).
// Espelha scripts/harvest-mip-catalog.mts: nunca por palavra nossa, sempre pela marcação da loja.
export function liveMipAllowed(storeKey: string, product: IsProduct, item: { ean?: string }): boolean {
  if (!liveMipStore(storeKey)) return false;
  const path = (product.categories ?? []).join(" ");
  if (storeKey === "drogariasp") {
    // As mesmas três checagens da colheita valem em QUALQUER prateleira: classificação preenchida
    // tem que ser "Sem Tarja", prescrição não pode exigir receita/retenção, classe não pode ser de receita.
    const classification = norm(property(product, "Classificação"));
    const prescription = norm(property(product, "Prescrição Médica"));
    const klass = property(product, "Classe dos Remédios") || property(product, "Classe do Medicamento");
    if (classification && classification !== "sem tarja") return false;
    if (/com retencao|com receita|sob prescricao/.test(prescription)) return false;
    if (isPrescriptionText(`${klass} ${path}`)) return false;
    // Prateleira própria dos isentos (C:/868/ "Remédios") passa; a de tarja ("Medicamentos",
    // C:/800/) só com "Sem Tarja" explícito.
    if (/rem[eé]dios?/i.test(path) && !/medicamentos?/i.test(path)) return true;
    return classification === "sem tarja";
  }
  if (storeKey === "paguemenos") {
    const ean = isValidGtin(item.ean) ? onlyDigits(item.ean!) : "";
    if (!ean || !dspMipEanSet().has(ean)) return false;
    return !["Antibiotico", "MedicamentoControlado", "TemRestricao"].some((key) => /sim/i.test(property(product, key)));
  }
  return false;
}

export function categorySlug(categories: string[] | undefined): string {
  return (categories?.[0] ?? "")
    .split("/")
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Produto da busca inteligente → item de catálogo (puro, testável).
export function parseLiveProducts(storeKey: string, products: IsProduct[]): CatalogItem[] {
  const store = VTEX_API_STORES[storeKey];
  if (!store) return [];
  const plain: CatalogItem[] = [];
  const mip: CatalogItem[] = [];
  const seen = new Set<string>();
  const mipStore = liveMipStore(storeKey);
  for (const product of products) {
    const categoryPath = (product.categories ?? []).join(" ");
    const medicineShelf = MEDICINE_CATEGORY_RE.test(categoryPath);
    if (medicineShelf && !mipStore) continue;
    for (const item of product.items ?? []) {
      const own = (item.sellers ?? []).find((s) => s.sellerId === "1" && (s.commertialOffer?.AvailableQuantity ?? 0) > 0 && (s.commertialOffer?.Price ?? 0) > 0);
      if (!item.itemId || !own || seen.has(item.itemId)) continue;
      const link = product.link ?? (product.linkText ? `/${product.linkText}/p` : undefined);
      if (!link) continue;
      seen.add(item.itemId);
      const base: CatalogItem = {
        sku: `${store.skuPrefix}${item.itemId}`,
        name: (item.nameComplete || item.name || product.productName || `Produto ${item.itemId}`).replace(/\s+/g, " ").trim(),
        brand: product.brand || undefined,
        unitPrice: Math.round(own.commertialOffer!.Price! * 100) / 100,
        unit: "un",
        category: categorySlug(product.categories),
        imageUrl: item.images?.[0]?.imageUrl,
        productUrl: new URL(link, `https://${store.domain}`).toString()
      };
      if (medicineShelf) {
        // Prateleira de medicamento: só pela lista positiva da própria farmácia, marcado MIP.
        if (liveMipAllowed(storeKey, product, item)) mip.push({ ...base, medicine: "mip", ...(isValidGtin(item.ean) ? { ean: onlyDigits(item.ean!) } : {}) });
      } else if (isPrescriptionDrugName(base.name)) {
        // Remédio de receita pelo nome numa prateleira comum ("Isotretinoína" em "Pele"): nunca.
        continue;
      } else if (mipStore && isMedicine(base)) {
        // Fora da prateleira de medicamento mas com cara de remédio (dexpantenol, "comprimidos"):
        // a loja guarda remédio em categoria cosmética (anvisa.ts), então só entra como MIP se o
        // código de barras é de um isento da lista positiva da Drogaria SP; senão sai, como antes.
        const ean = isValidGtin(item.ean) ? onlyDigits(item.ean!) : "";
        if (ean && dspMipEanSet().has(ean)) mip.push({ ...base, medicine: "mip", ean });
      } else {
        plain.push(base);
      }
      break; // um SKU por produto: cor/tamanho extra não muda o tipo e a checagem ao vivo é por SKU
    }
  }
  return [...withoutVeterinaryMedicine(withoutMedicine(plain)), ...mipOnly(mip)];
}

const cache = new Map<string, { at: number; items: CatalogItem[] }>();

// Prazo DURO para qualquer promessa (08/10/2026, placar: 9 de 31 pedidos estouravam 150 s). Sob o
// agente de proxy do Node (`NODE_USE_ENV_PROXY=1`, undici EnvHttpProxyAgent), a leitura do CORPO de
// uma resposta cujo `AbortSignal.timeout` disparou no meio pode ficar pendente para sempre — sem timer
// nem socket vivo (sonda de 08/10: 6 `res.json()` de Mambo/Swift/Pague Menos/Drogal parados 40 s+,
// cabeçalho já recebido). O `AbortSignal` não basta, então todo caminho que espera rede tem um prazo
// próprio: passado `ms`, devolve `fallback`; rejeição também vira `fallback` (nunca lança). O timer é
// ref'd de propósito (segura o processo vivo até resolver) e sempre limpo no fim.
export async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([promise.catch(() => fallback), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Folga do prazo duro sobre o timeout da requisição (o AbortSignal tem a vez primeiro).
const HARD_DEADLINE_SLACK_MS = 500;

export type LiveFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const IS_BASE = "/api/io/_v/api/intelligent-search";

// Mesmo funil para a busca textual e a por categoria: cache, timeout, parse (seller próprio,
// estoque, filtros de remédio) e "nunca lança".
async function fetchLiveProducts(storeKey: string, url: string, key: string, fetcher: LiveFetch): Promise<CatalogItem[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  // Requisição + leitura do corpo sob o MESMO prazo duro (o corpo é que travava, ver withDeadline).
  const work = (async (): Promise<CatalogItem[] | null> => {
    const res = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs()) });
    if (!res.ok) return null;
    const data = (await res.json()) as { products?: IsProduct[] };
    return parseLiveProducts(storeKey, data.products ?? []);
  })();
  const items = await withDeadline(work, timeoutMs() + HARD_DEADLINE_SLACK_MS, null);
  if (!items) return []; // falha/timeout não entra no cache: a próxima tentativa pode dar certo
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), items });
  return items;
}

export async function liveSearchItems(storeKey: string, query: string, count = 12, fetcher: LiveFetch = storeFetch as unknown as LiveFetch): Promise<CatalogItem[]> {
  const store = VTEX_API_STORES[storeKey];
  if (!store || !query.trim()) return [];
  const key = `${storeKey}|${query.trim().toLowerCase()}|${count}`;
  const url = `https://${store.domain}${IS_BASE}/product_search/?query=${encodeURIComponent(query)}&count=${count}&locale=pt-BR&hideUnavailableItems=true`;
  return fetchLiveProducts(storeKey, url, key, fetcher);
}

// ---------- Busca por CATEGORIA (08/10/2026, recomendação por prateleira) ----------
// A busca inteligente da VTEX aceita o caminho de facetas no lugar da consulta:
// `product_search/category-1/<dep>/category-2/<cat>/category-3/<sub>` devolve a PRATELEIRA
// inteira da loja (todos os chocolates, todos os antidiarreicos), não os poucos itens que casam
// com uma palavra. Medido em 08/10 em Mambo, Drogaria SP e Cobasi (caminho certo = 126 a 737
// itens da prateleira; caminho inexistente = 0 itens, 200 OK). Atenção: o caminho SEM o prefixo
// `category-N` (`product_search/mercearia/chocolates`) NÃO filtra — a loja ignora ou devolve 0.
// Aqui o caminho é só a lista de slugs por nível ("mambo/mercearia/doces-e-chocolates"); o
// prefixo é montado abaixo. Slugs inválidos = [] sem rede.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CATEGORY_DEPTH = 4;

export function categorySegments(categoryPath: string): string[] | null {
  const parts = categoryPath.split("/").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.length > MAX_CATEGORY_DEPTH || !parts.every((part) => SLUG_RE.test(part))) return null;
  return parts;
}

function facetPath(parts: string[]): string {
  return parts.map((part, index) => `category-${index + 1}/${part}`).join("/");
}

export async function liveSearchByCategory(storeKey: string, categoryPath: string, count = 12, fetcher: LiveFetch = storeFetch as unknown as LiveFetch): Promise<CatalogItem[]> {
  const store = VTEX_API_STORES[storeKey];
  const parts = categorySegments(categoryPath);
  if (!store || !parts) return [];
  const key = `${storeKey}|cat:${parts.join("/")}|${count}`;
  const url = `https://${store.domain}${IS_BASE}/product_search/${facetPath(parts)}?count=${count}&locale=pt-BR&hideUnavailableItems=true`;
  return fetchLiveProducts(storeKey, url, key, fetcher);
}

type FacetValue = { value?: string; quantity?: number };
type Facet = { key?: string; values?: FacetValue[] };

const pathCache = new Map<string, { at: number; path: string | null }>();
const PATH_TTL_MS = 60 * 60_000;

// Caminho de categoria dominante de uma consulta ("chocolate" → "mambo/mercearia/doces-e-chocolates"),
// descendo nível a nível pelas facetas da própria loja: em cada nível pega o valor mais forte e só
// segue se ele concentra pelo menos `minShare` do nível pai (no 1º nível, metade disso: a consulta
// pode espalhar entre departamentos). Consulta ambígua (sem categoria dominante) = null. Nunca
// lança; falha de rede não entra no cache. Serve ao gerador do mapa para preencher `categoryPaths`.
export async function resolveCategoryPath(
  storeKey: string,
  query: string,
  opts: { maxDepth?: number; minShare?: number; fetcher?: LiveFetch } = {}
): Promise<string | null> {
  const store = VTEX_API_STORES[storeKey];
  const q = query.trim();
  if (!store || !q) return null;
  const maxDepth = Math.min(MAX_CATEGORY_DEPTH, Math.max(1, opts.maxDepth ?? 3));
  const minShare = opts.minShare ?? 0.5;
  const fetcher = opts.fetcher ?? (storeFetch as unknown as LiveFetch);
  const key = `${storeKey}|${q.toLowerCase()}|${maxDepth}|${minShare}`;
  const hit = pathCache.get(key);
  if (hit && Date.now() - hit.at < PATH_TTL_MS) return hit.path;
  const parts: string[] = [];
  let parentQuantity = 0;
  try {
    for (let level = 1; level <= maxDepth; level++) {
      const url = `https://${store.domain}${IS_BASE}/facets/${facetPath(parts)}?query=${encodeURIComponent(q)}&locale=pt-BR&hideUnavailableItems=true`;
      const data = await withDeadline(
        (async () => {
          const res = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs()) });
          return res.ok ? ((await res.json()) as { facets?: Facet[] }) : null;
        })(),
        timeoutMs() + HARD_DEADLINE_SLACK_MS,
        null
      );
      if (!data) return null;
      const facet = (data.facets ?? []).find((f) => f.key === `category-${level}`);
      const values = (facet?.values ?? []).filter((v) => v.value && SLUG_RE.test(v.value) && (v.quantity ?? 0) > 0);
      if (!values.length) break;
      const top = values.reduce((best, v) => ((v.quantity ?? 0) > (best.quantity ?? 0) ? v : best));
      const total = level === 1 ? values.reduce((sum, v) => sum + (v.quantity ?? 0), 0) : parentQuantity;
      const share = total > 0 ? (top.quantity ?? 0) / total : 0;
      if (share < (level === 1 ? minShare / 2 : minShare)) break;
      parts.push(top.value!);
      parentQuantity = top.quantity ?? 0;
    }
  } catch {
    return null;
  }
  const path = parts.length ? parts.join("/") : null;
  if (pathCache.size >= CACHE_MAX) pathCache.delete(pathCache.keys().next().value as string);
  pathCache.set(key, { at: Date.now(), path });
  return path;
}

export function isPharmacyStore(storeKey: string): boolean {
  return PHARMACY_STORES.has(storeKey);
}

// Mescla a cópia com o ao vivo de uma loja. O ao vivo vence no preço/nome (fresco); a
// popularidade da cópia é preservada. Vale para toda loja, farmácia inclusive: o que barra
// remédio já aconteceu em parseLiveProducts (lista de bloqueio), não aqui.
export function mergeLiveWithSnapshot(_storeKey: string, snapshot: CatalogItem[], live: CatalogItem[]): CatalogItem[] {
  const bySku = new Map(snapshot.map((item) => [item.sku, item]));
  const merged = [...snapshot];
  for (const item of live) {
    const old = bySku.get(item.sku);
    if (old) {
      const index = merged.indexOf(old);
      merged[index] = { ...old, name: item.name, unitPrice: item.unitPrice, productUrl: item.productUrl ?? old.productUrl, imageUrl: item.imageUrl ?? old.imageUrl };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export function __clearLiveSearchCacheForTests() {
  cache.clear();
  pathCache.clear();
}
