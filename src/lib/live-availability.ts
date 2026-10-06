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
import { liveCheckSupported, liveItemAvailability, type LiveItemCheck } from "./live-freight";
import { isRegionalStore, storeServesCep } from "./store-areas";

export type LiveCandidate = { storeKey: string; sku: string };
export type Simulate = (storeKey: string, skus: string[], cep: string) => Promise<Map<string, LiveItemCheck> | null>;

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
  await Promise.all(
    [...byStore].map(async ([storeKey, list]) => {
      const skus = [...new Set(list.map((c) => c.sku))].slice(0, 12);
      try {
        const result = await simulate(storeKey, skus, cep);
        if (!result) return; // loja não respondeu → desconhecido, mantém
        for (const [sku, check] of result) checks.set(liveKey(storeKey, sku), check);
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
