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
// - remédio fica de fora em duas camadas: categoria (a própria loja classifica "Medicamentos") e
//   as guardas ANVISA de runtime (anvisa.ts); farmácia só amplia dentro das categorias que a
//   colheita já tinha liberado;
// - nunca lança: falha/timeout = lista vazia, e a cópia responde sozinha.
import { VTEX_API_STORES } from "../purchase/vtex-checkout";
import { withoutMedicine, withoutVeterinaryMedicine } from "./anvisa";
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
  return Number.isFinite(value) && value >= 500 ? value : 2000;
}

// Farmácias: o produto ao vivo só entra se estiver numa categoria que a colheita liberou.
const PHARMACY_STORES = new Set(["drogariasp", "paguemenos", "drogal", "extrafarma", "farmaciaindiana", "drogariaspacheco", "drogariacatarinense"]);
const MEDICINE_CATEGORY_RE = /(medicament|rem[eé]dio|prescri|tarja|isent|gen[eé]ric|controlad|manipula)/i;

type IsProduct = {
  productName?: string;
  brand?: string;
  link?: string;
  linkText?: string;
  categories?: string[];
  items?: Array<{
    itemId?: string;
    name?: string;
    nameComplete?: string;
    images?: Array<{ imageUrl?: string }>;
    sellers?: Array<{ sellerId?: string; commertialOffer?: { Price?: number; AvailableQuantity?: number } }>;
  }>;
};

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
  const out: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    const categoryPath = (product.categories ?? []).join(" ");
    if (MEDICINE_CATEGORY_RE.test(categoryPath)) continue;
    for (const item of product.items ?? []) {
      const own = (item.sellers ?? []).find((s) => s.sellerId === "1" && (s.commertialOffer?.AvailableQuantity ?? 0) > 0 && (s.commertialOffer?.Price ?? 0) > 0);
      if (!item.itemId || !own || seen.has(item.itemId)) continue;
      const link = product.link ?? (product.linkText ? `/${product.linkText}/p` : undefined);
      if (!link) continue;
      seen.add(item.itemId);
      out.push({
        sku: `${store.skuPrefix}${item.itemId}`,
        name: (item.nameComplete || item.name || product.productName || `Produto ${item.itemId}`).replace(/\s+/g, " ").trim(),
        brand: product.brand || undefined,
        unitPrice: Math.round(own.commertialOffer!.Price! * 100) / 100,
        unit: "un",
        category: categorySlug(product.categories),
        imageUrl: item.images?.[0]?.imageUrl,
        productUrl: new URL(link, `https://${store.domain}`).toString()
      });
      break; // um SKU por produto: cor/tamanho extra não muda o tipo e a checagem ao vivo é por SKU
    }
  }
  return withoutVeterinaryMedicine(withoutMedicine(out));
}

const cache = new Map<string, { at: number; items: CatalogItem[] }>();

export type LiveFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function liveSearchItems(storeKey: string, query: string, count = 12, fetcher: LiveFetch = fetch as unknown as LiveFetch): Promise<CatalogItem[]> {
  const store = VTEX_API_STORES[storeKey];
  if (!store || !query.trim()) return [];
  const key = `${storeKey}|${query.trim().toLowerCase()}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  const url = `https://${store.domain}/api/io/_v/api/intelligent-search/product_search/?query=${encodeURIComponent(query)}&count=${count}&locale=pt-BR&hideUnavailableItems=true`;
  let items: CatalogItem[] = [];
  try {
    const res = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs()) });
    if (!res.ok) return [];
    const data = (await res.json()) as { products?: IsProduct[] };
    items = parseLiveProducts(storeKey, data.products ?? []);
  } catch {
    return []; // falha não entra no cache: a próxima tentativa pode dar certo
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), items });
  return items;
}

export function isPharmacyStore(storeKey: string): boolean {
  return PHARMACY_STORES.has(storeKey);
}

// Mescla a cópia com o ao vivo de uma loja. O ao vivo vence no preço/nome (fresco); a
// popularidade da cópia é preservada. Farmácia: o ao vivo só entra nas categorias da cópia.
export function mergeLiveWithSnapshot(storeKey: string, snapshot: CatalogItem[], live: CatalogItem[], snapshotCategories?: Set<string>): CatalogItem[] {
  const allowed = isPharmacyStore(storeKey) && snapshotCategories ? snapshotCategories : null;
  const bySku = new Map(snapshot.map((item) => [item.sku, item]));
  const merged = [...snapshot];
  for (const item of live) {
    if (allowed && !allowed.has(item.category ?? "")) continue;
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
}
