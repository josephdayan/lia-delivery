// Miniaturas das opções do Flow da lista (07/10): 96x96 JPEG q70 em base64 (~3–6 KB cada).
// Baixa em paralelo com timeout curto, reduz com sharp e guarda num cache LRU pequeno.
// Falha de qualquer tipo (rede, formato, sharp ausente) = opção sem imagem; nunca lança.
import { safeMediaLink } from "@/lib/adapters/whatsapp";

export const THUMB_SIZE = 96;
const THUMB_QUALITY = 70;
const MAX_SOURCE_BYTES = 3_000_000;
const CACHE_MAX = 300;
const FAIL_TTL_MS = 5 * 60_000;

type ThumbOption = { sku: string; imageUrl?: string };
type CacheEntry = { base64: string | null; at: number };

// Map preserva ordem de inserção: apagar e reinserir na leitura dá o LRU.
const cache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (hit.base64 === null && Date.now() - hit.at > FAIL_TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

function cacheSet(url: string, base64: string | null) {
  cache.delete(url);
  cache.set(url, { base64, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearThumbCache() {
  cache.clear();
}

async function makeThumb(url: string, timeoutMs: number): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_SOURCE_BYTES) return null;
  const source = Buffer.from(await res.arrayBuffer());
  if (!source.length || source.length > MAX_SOURCE_BYTES) return null;
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp(source, { failOn: "none" })
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();
  return jpeg.toString("base64");
}

async function thumbFor(url: string, timeoutMs: number): Promise<string | null> {
  const hit = cacheGet(url);
  if (hit) return hit.base64;
  try {
    // Teto do conjunto (download + sharp), além do timeout do fetch.
    const base64 = await Promise.race([
      makeThumb(url, timeoutMs),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs + 500).unref?.())
    ]);
    cacheSet(url, base64);
    return base64;
  } catch {
    cacheSet(url, null);
    return null;
  }
}

// sku → base64 (só os que deram certo). `budgetBytes` limita a soma, na ordem das opções.
export async function fetchThumbs(
  options: ThumbOption[],
  opts: { timeoutMs?: number; budgetBytes?: number } = {}
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const timeoutMs = opts.timeoutMs ?? 1500;
    const wanted = options.filter((o, i, all) => o.imageUrl && /^https?:\/\//i.test(o.imageUrl) && all.findIndex((x) => x.sku === o.sku) === i);
    const results = await Promise.all(wanted.map((o) => thumbFor(safeMediaLink(o.imageUrl as string), timeoutMs).catch(() => null)));
    let total = 0;
    wanted.forEach((option, i) => {
      const base64 = results[i];
      if (!base64) return;
      if (opts.budgetBytes !== undefined && total + base64.length > opts.budgetBytes) return;
      total += base64.length;
      out.set(option.sku, base64);
    });
  } catch {
    // nunca lança: sem miniaturas, o Flow segue só com texto
  }
  return out;
}
