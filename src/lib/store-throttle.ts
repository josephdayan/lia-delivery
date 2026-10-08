// Fila de chamadas às lojas (08/10/2026, teste do dono: "falou que não tinha gin e tinha").
//
// Lista de 4 itens = ~150 chamadas ao mesmo tempo num processo só (busca ao vivo em ~40 lojas ×
// 4 linhas + simulação de frete por SKU). Cada uma ganhava uma fatia da conexão e TODAS as 39
// buscas ao vivo da linha "gin" estouravam o timeout de 3 s (medido no repro local); a Mambo
// sozinha responde em 0,8 s. Como a cópia local não tem os gins da Mambo, a linha virou "não
// achei" — e um turno depois, com uma linha só, a mesma busca achou Seagers e Apogee.
//
// Regra: no máximo LIA_STORE_FETCH_CONCURRENCY chamadas em voo (32; medido 24 × 32 no repro: mesmo
// resultado, 32 um pouco mais rápido); o relógio do timeout de cada chamada só começa quando ela SAI
// da fila (o chamador cria o AbortSignal dentro de `withStoreSlot`).
// O slot é passado de mão em mão (quem libera entrega ao próximo da fila), então `active` nunca
// passa do teto. Puro, sem rede; teste em tests/feedback-2026-10-08-lista.test.ts.
const DEFAULT_CONCURRENCY = 32;

let active = 0;
const waiting: Array<() => void> = [];

export function storeFetchConcurrency(): number {
  const value = Number(process.env.LIA_STORE_FETCH_CONCURRENCY);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_CONCURRENCY;
}

async function acquire(): Promise<void> {
  if (active < storeFetchConcurrency()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // o slot muda de dono sem passar por `active`
  else active -= 1;
}

export async function withStoreSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// Só para testes e diagnóstico.
export function storeSlotsInFlight(): number {
  return active;
}
