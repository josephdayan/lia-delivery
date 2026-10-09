// Verificação AO VIVO antes dos cards (03/09/2026). Regra do dono depois do chá pago sem
// estoque: "se ele quer um chá, tem que dar em um lugar que tenha chá, que esteja
// disponível e que chegue rápido". Antes de mostrar opções, cada candidato de loja com
// checkout consultável é simulado no site da própria loja para o CEP do cliente:
// sem estoque ou sem entrega no endereço → sai da vitrine; disponível → carrega o prazo
// REAL daquele CEP (o que a regra de 17/08 exige para mostrar prazo). Lojas que não
// permitem consulta ficam como "não verificadas" e vão para o operador na cotação.
//
// Puro: recebe a função de simulação (injetável nos testes) e nunca lança — falha de
// rede mantém os candidatos como estavam (não inventa indisponibilidade).
import { PER_AD_FREIGHT_STORES } from "./instant-quote";
import { liveCheckSupported, liveFreightEnabled, liveItemAvailability, type LiveItemCheck } from "./live-freight";
import { isRegionalStore, storeServesCep } from "./store-areas";

// `qty` (06/10, M3): a vitrine confere a QUANTIDADE pedida — conferir 1 unidade e cobrar 3
// fazia "3 cocas" falhar no "pagar" (estoque menor que o pedido).
export type LiveCandidate = { storeKey: string; sku: string; qty?: number };

// 06/10 (teste real: "Pilha AAA" da Casa & Vídeo, fita isolante da Obramax): a vitrine
// mostrava opção que a loja NÃO tinha confirmado para o CEP; no "pagar" a cotação
// instantânea abortava ("sem confirmação ao vivo") e, sem operador (25/09), o cliente
// caía num beco. A regra da cobrança é a mesma da vitrine: sem operador e cobrando só o
// confirmado, só entra na vitrine o que a loja confirmou ao vivo (estoque + entrega +
// frete) — ou anúncio do Mercado Livre, que tem frete próprio e compra do dono.
export function liveConfirmationRequired(): boolean {
  return process.env.LIA_OPERATOR_QUOTE !== "true" && process.env.LIA_CHARGE_ONLY_VERIFIED !== "false" && liveFreightEnabled();
}

export function buyableWithoutOperator(storeKey: string | undefined, check: LiveItemCheck | undefined): boolean {
  return PER_AD_FREIGHT_STORES.has(storeKey ?? "") || check?.available === true;
}
export type Simulate = (storeKey: string, skus: string[], cep: string, qtys?: Record<string, number>) => Promise<Map<string, LiveItemCheck> | null>;

// Cache de conferência ao vivo. Só resultado DEFINITIVO da loja entra (sem resposta nunca é guardado).
const liveCache = new Map<string, { check: LiveItemCheck; at: number }>();
function liveCacheMs(): number {
  const value = Number(process.env.LIA_LIVE_CHECK_CACHE_MS);
  return Number.isFinite(value) && value >= 0 ? value : 180_000;
}
function liveCacheKey(storeKey: string, sku: string, cep: string, qty: number): string {
  return `${storeKey}|${sku}|${cep.replace(/\D/g, "")}|${qty}`;
}
function readLiveCache(storeKey: string, sku: string, cep: string, qty: number, into: Map<string, LiveItemCheck>): boolean {
  const hit = liveCache.get(liveCacheKey(storeKey, sku, cep, qty));
  if (!hit) return false;
  if (Date.now() - hit.at > liveCacheMs()) {
    liveCache.delete(liveCacheKey(storeKey, sku, cep, qty));
    return false;
  }
  into.set(liveKey(storeKey, sku), hit.check);
  return true;
}
export function __clearLiveCheckCacheForTests() {
  liveCache.clear();
}

export function liveKey(storeKey: string, sku: string): string {
  return `${storeKey}:${sku}`;
}

// Simulação padrão injetável nos testes (o cérebro chama checkCandidatesLive sem deps).
let simulateOverride: Simulate | null = null;
let supportedOverride: ((storeKey: string) => boolean) | null = null;
export function __setLiveSimulateForTests(simulate: Simulate | null, supported?: ((storeKey: string) => boolean) | null) {
  simulateOverride = simulate;
  supportedOverride = supported ?? null;
}

export async function checkCandidatesLive<T extends LiveCandidate>(
  candidates: T[],
  cep: string | null | undefined,
  simulate: Simulate = simulateOverride ?? liveItemAvailability,
  supported: (storeKey: string) => boolean = supportedOverride ?? liveCheckSupported
): Promise<{ kept: T[]; dropped: T[]; checks: Map<string, LiveItemCheck> }> {
  const checks = new Map<string, LiveItemCheck>();
  if (!cep || !candidates.length) return { kept: candidates, dropped: [], checks };

  // Loja regional fora da área do CEP (06/10, expansão RJ): sai sem consultar ninguém.
  const outOfArea = candidates.filter((c) => !storeServesCep(c.storeKey, cep));
  if (outOfArea.length) candidates = candidates.filter((c) => storeServesCep(c.storeKey, cep));

  const byStore = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (!supported(candidate.storeKey)) continue;
    byStore.set(candidate.storeKey, [...(byStore.get(candidate.storeKey) ?? []), candidate]);
  }
  const cacheOn = !simulateOverride && simulate === liveItemAvailability && liveCacheMs() > 0;
  await Promise.all(
    [...byStore].map(async ([storeKey, list]) => {
      const allSkus = [...new Set(list.map((c) => c.sku))].slice(0, 12);
      const qtys: Record<string, number> = {};
      for (const c of list) if (c.qty && c.qty > 1) qtys[c.sku] = Math.max(qtys[c.sku] ?? 1, Math.round(c.qty));
      // Cache curto (09/10, latência): a mesma loja/SKU/CEP/quantidade conferida há poucos minutos não vai de novo à loja
      // ("outras opções" e refino repetiam as mesmas simulações). A cotação e o "pagar" reconferem na hora da compra.
      const skus = cacheOn ? allSkus.filter((sku) => !readLiveCache(storeKey, sku, cep, qtys[sku] ?? 1, checks)) : allSkus;
      if (!skus.length) return;
      try {
        const subQtys: Record<string, number> = {};
        for (const sku of skus) if (qtys[sku]) subQtys[sku] = qtys[sku];
        const result = await simulate(storeKey, skus, cep, Object.keys(subQtys).length ? subQtys : undefined);
        if (!result) return; // loja não respondeu → desconhecido, mantém
        for (const [sku, check] of result) {
          checks.set(liveKey(storeKey, sku), check);
          if (cacheOn) liveCache.set(liveCacheKey(storeKey, sku, cep, qtys[sku] ?? 1), { check, at: Date.now() });
        }
      } catch {
        /* desconhecido, mantém */
      }
    })
  );

  const kept: T[] = [];
  const dropped: T[] = [...outOfArea];
  for (const candidate of candidates) {
    const check = checks.get(liveKey(candidate.storeKey, candidate.sku));
    if (check && !check.available) dropped.push(candidate);
    // Loja REGIONAL consultável que não confirmou (fora do ar, timeout, item sem eco):
    // falha FECHADA — "só mostra se tiver perto" exige a confirmação da própria loja.
    // Loja nacional sem resposta continua (entrega no país todo; a cotação reconfere).
    else if (!check && isRegionalStore(candidate.storeKey) && supported(candidate.storeKey)) dropped.push(candidate);
    else kept.push(candidate);
  }
  // Confirmado pela loja vem antes do não-verificável; entre confirmados, o que chega
  // antes vem primeiro. Estável: quem empata mantém a ordem de relevância.
  kept.sort((a, b) => {
    const ca = checks.get(liveKey(a.storeKey, a.sku));
    const cb = checks.get(liveKey(b.storeKey, b.sku));
    const va = ca?.available ? 1 : 0;
    const vb = cb?.available ? 1 : 0;
    if (va !== vb) return vb - va;
    return (ca?.etaMinutes ?? Number.MAX_SAFE_INTEGER) - (cb?.etaMinutes ?? Number.MAX_SAFE_INTEGER);
  });
  return { kept, dropped, checks };
}
