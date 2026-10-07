// Faltantes de uma lista (07/10, Etapa 3): puro, sem DB nem rede. O cérebro guarda em
// `ctx.listMisses` cada linha que terminou "não achei" / "sem entrega no CEP" e este módulo
// cuida do prazo (20 min), da fusão sem duplicar e de casar uma resposta curta com a faltante
// certa ("gelo em cubo", "tenta Wilson").
import type { DeliveryContext, ListMiss } from "@/lib/conversation-types";
import { scoreCatalogMatch } from "@/lib/stores/types";

export const LIST_MISS_TTL_MS = 20 * 60_000;
export const LIST_MISS_MAX = 8;

const norm = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Faltantes ainda válidas. `lastMiss` (contexto antigo e o módulo dialogue, que ainda o grava)
// entra como "not_found" quando a lista não o conhece.
export function freshListMisses(ctx: Pick<DeliveryContext, "listMisses" | "lastMiss">, now = Date.now()): ListMiss[] {
  const out = (ctx.listMisses ?? []).filter((m) => now - m.at < LIST_MISS_TTL_MS);
  const legacy = ctx.lastMiss;
  if (legacy && now - legacy.at < LIST_MISS_TTL_MS && !out.some((m) => norm(m.query) === norm(legacy.query))) {
    out.push({ query: legacy.query, qty: legacy.qty, reason: "not_found", at: legacy.at, ...(legacy.retried ? { retried: true } : {}) });
  }
  return out;
}

// Grava a lista no contexto e espelha a mais recente em `lastMiss` (leitores antigos).
export function applyListMisses(ctx: DeliveryContext, misses: ListMiss[]): void {
  ctx.listMisses = misses.length ? misses : undefined;
  const last = misses[misses.length - 1];
  ctx.lastMiss = last ? { query: last.query, qty: last.qty, at: last.at, ...(last.retried ? { retried: true } : {}) } : undefined;
}

// A mesma query não aparece duas vezes (a mais nova vence); no máximo LIST_MISS_MAX.
export function mergeListMisses(carry: ListMiss[], added: ListMiss[]): ListMiss[] {
  const out = new Map<string, ListMiss>();
  for (const miss of [...carry, ...added]) out.set(norm(miss.query), miss);
  return [...out.values()].slice(-LIST_MISS_MAX);
}

export function missLabel(miss: Pick<ListMiss, "query" | "qty">): string {
  return miss.qty > 1 ? `${miss.qty} ${miss.query}` : miss.query;
}

// Qual faltante a resposta curta quer dizer? `replaces` = o cliente reescreveu o nome do item
// ("gelo em cubo" para "gelo"): a busca usa só o que ele escreveu. Sem replaces é uma marca/
// atributo a SOMAR ao pedido ("Wilson" para "bola de tênis"), só quando há uma única faltante.
export function pickMissForFragment(misses: ListMiss[], words: string): { miss: ListMiss; replaces: boolean } | null {
  if (!misses.length) return null;
  const asItem = { sku: "miss", name: words, unitPrice: 0 };
  let best: { miss: ListMiss; score: number } | null = null;
  for (const miss of misses) {
    const forward = scoreCatalogMatch(miss.query, asItem);
    const backward = scoreCatalogMatch(words, { sku: "miss", name: miss.query, unitPrice: 0 });
    const score = Math.max(forward, backward);
    if (score > 0 && (!best || score > best.score)) best = { miss, score };
  }
  if (best) return { miss: best.miss, replaces: true };
  return misses.length === 1 ? { miss: misses[0], replaces: false } : null;
}
