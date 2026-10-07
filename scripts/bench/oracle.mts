// ORÁCULO da busca: o que as lojas REAIS vendem para o pedido, lido ao vivo na busca
// inteligente da própria loja (a mesma que o cliente veria no site) — independente do
// snapshot de catálogo e do ranking da Lia. Só entra o que a própria loja vende (seller "1")
// e tem estoque. É a régua de "existe ou não existe para entregar".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PoolItem = { id: string; storeKey: string; store: string; name: string; brand: string; price: number };
type Store = { key: string; domain: string; label: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CACHE = join(process.cwd(), "evals", "cache");
const TTL_MS = 6 * 3600_000;

async function fetchStore(store: Store, query: string, count: number): Promise<PoolItem[]> {
  const url = `https://${store.domain}/api/io/_v/api/intelligent-search/product_search/?query=${encodeURIComponent(query)}&count=${count}&locale=pt-BR&hideUnavailableItems=true`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { products?: Array<{ productName?: string; brand?: string; items?: Array<{ itemId?: string; name?: string; sellers?: Array<{ sellerId?: string; commertialOffer?: { Price?: number; AvailableQuantity?: number } }> }> }> };
      const out: PoolItem[] = [];
      for (const p of data.products ?? []) {
        for (const item of p.items ?? []) {
          const own = (item.sellers ?? []).find((s) => s.sellerId === "1" && (s.commertialOffer?.AvailableQuantity ?? 0) > 0 && (s.commertialOffer?.Price ?? 0) > 0);
          if (!own) continue;
          out.push({ id: `${store.key}:${item.itemId}`, storeKey: store.key, store: store.label, name: p.productName ?? item.name ?? "", brand: p.brand ?? "", price: own.commertialOffer!.Price! });
          break; // um SKU por produto basta (variações de cor/tamanho não mudam o tipo)
        }
      }
      return out;
    } catch { /* tenta de novo */ }
  }
  return [];
}

export async function oraclePool(query: string, stores: Store[], perStore = 8): Promise<PoolItem[]> {
  mkdirSync(CACHE, { recursive: true });
  const key = createHash("sha1").update(`${query}|${perStore}|${stores.map((s) => s.key).sort().join(",")}`).digest("hex").slice(0, 16);
  const file = join(CACHE, `oracle-${key}.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as { at: number; pool: PoolItem[] };
    if (Date.now() - cached.at < TTL_MS) return cached.pool;
  }
  const pool = (await Promise.all(stores.map((s) => fetchStore(s, query, perStore)))).flat();
  writeFileSync(file, JSON.stringify({ at: Date.now(), pool }));
  return pool;
}
