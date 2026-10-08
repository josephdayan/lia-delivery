// Agregações do painel /ops/recomendacoes (08/10/2026, plano §1.5 APRENDER): funções PURAS sobre
// as linhas de RecommendLog — sem banco, testáveis. Mostram o que o cliente pede de forma vaga,
// o que converte e onde o mapa de prateleiras/estoque falhou (a fila de revisão do mapa).
// Telefone nunca sai daqui inteiro: só os 4 últimos dígitos.

export type RecommendLogRow = {
  id?: string;
  createdAt: Date | string;
  phone: string;
  source?: string | null;
  form?: string | null;
  need?: string | null;
  product?: string | null;
  symptom?: string | null;
  planSource?: string | null;
  redFlag?: string | null;
  shelfIds?: unknown;
  cardSkus?: unknown;
  emptyShelves?: unknown;
  chosenSku?: string | null;
  outcome?: string | null;
  mapMs?: number | null;
  searchMs?: number | null;
  judgeMs?: number | null;
};

export type RequestKind = "need" | "product" | "symptom";

export type RecommendSummary = {
  total: number;
  // Com cards na tela (shown + chosen) / total.
  shownPct: number;
  // chosen / (shown + chosen): das que mostraram cards, quantas viraram escolha.
  chosenPct: number;
  nonePct: number;
  redFlagPct: number;
  counts: { shown: number; chosen: number; none: number; redFlag: number; pending: number };
  latency: { avgMs: number; p50Ms: number; p95Ms: number };
  planSource: { ai: number; table: number; other: number };
};

export type CountedId = { id: string; count: number };

export type RequestGroup = {
  label: string;
  kinds: RequestKind[];
  count: number;
  customers: number;
  withCards: number;
  chosen: number;
  // chosen / withCards (0 quando nenhuma mostrou cards).
  chosenPct: number;
  topShelves: CountedId[];
  emptyShelves: CountedId[];
  lastAt: string;
};

export type EmptyShelfEntry = { id: string; count: number; requests: string[]; lastAt: string };

export type RecentRow = {
  id: string | null;
  at: string;
  phone: string;
  source: string;
  form: string;
  request: string;
  kind: RequestKind | null;
  shelfIds: string[];
  cards: number;
  outcome: string;
  chosenSku: string | null;
};

export type RedFlagRow = { id: string | null; at: string; phone: string; request: string; reason: string; shelfIds: string[] };

export type RecommendReport = {
  days: number;
  summary: RecommendSummary;
  requests: RequestGroup[];
  emptyShelfQueue: EmptyShelfEntry[];
  recent: RecentRow[];
  redFlags: RedFlagRow[];
};

// ---------------------------------------------------------------- helpers

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
const time = (d: Date | string): number => (d instanceof Date ? d : new Date(d)).getTime();

// Só os 4 últimos dígitos; nunca o número inteiro.
export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "••••";
}

// Chave de agrupamento: minúsculas, sem acento nem pontuação, espaços colapsados.
export function normalizeRequest(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Json de prateleiras/skus vem do banco: aceita só array de strings não vazias.
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

export function requestOf(row: Pick<RecommendLogRow, "need" | "product" | "symptom">): { label: string; kind: RequestKind } | null {
  const pairs: Array<[RequestKind, string | null | undefined]> = [
    ["need", row.need],
    ["product", row.product],
    ["symptom", row.symptom]
  ];
  for (const [kind, value] of pairs) {
    const label = String(value ?? "").trim();
    if (label && normalizeRequest(label)) return { label, kind };
  }
  return null;
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function topCounted(map: Map<string, number>, limit: number): CountedId[] {
  return [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

const isRedFlag = (row: RecommendLogRow): boolean => row.outcome === "red_flag" || Boolean(row.redFlag && row.redFlag.trim());

// ---------------------------------------------------------------- agregações

export function summarize(rows: RecommendLogRow[]): RecommendSummary {
  const counts = { shown: 0, chosen: 0, none: 0, redFlag: 0, pending: 0 };
  const planSource = { ai: 0, table: 0, other: 0 };
  const totals: number[] = [];
  for (const row of rows) {
    if (isRedFlag(row)) counts.redFlag += 1;
    else if (row.outcome === "chosen") counts.chosen += 1;
    else if (row.outcome === "shown") counts.shown += 1;
    else if (row.outcome === "none") counts.none += 1;
    else counts.pending += 1;
    if (row.planSource === "ai") planSource.ai += 1;
    else if (row.planSource === "table") planSource.table += 1;
    else planSource.other += 1;
    totals.push((row.mapMs ?? 0) + (row.searchMs ?? 0) + (row.judgeMs ?? 0));
  }
  const total = rows.length;
  const withCards = counts.shown + counts.chosen;
  const sorted = [...totals].sort((a, b) => a - b);
  const avg = total ? Math.round(totals.reduce((a, b) => a + b, 0) / total) : 0;
  return {
    total,
    shownPct: pct(withCards, total),
    chosenPct: pct(counts.chosen, withCards),
    nonePct: pct(counts.none, total),
    redFlagPct: pct(counts.redFlag, total),
    counts,
    latency: { avgMs: avg, p50Ms: median(sorted), p95Ms: percentile(sorted, 0.95) },
    planSource
  };
}

type GroupAcc = {
  labels: Map<string, number>;
  kinds: Set<RequestKind>;
  count: number;
  customers: Set<string>;
  withCards: number;
  chosen: number;
  shelves: Map<string, number>;
  empty: Map<string, number>;
  lastAt: number;
};

export function groupRequests(rows: RecommendLogRow[], limit = 30): RequestGroup[] {
  const groups = new Map<string, GroupAcc>();
  for (const row of rows) {
    const req = requestOf(row);
    if (!req) continue;
    const key = normalizeRequest(req.label);
    const g: GroupAcc =
      groups.get(key) ??
      { labels: new Map(), kinds: new Set(), count: 0, customers: new Set(), withCards: 0, chosen: 0, shelves: new Map(), empty: new Map(), lastAt: 0 };
    bump(g.labels, req.label);
    g.kinds.add(req.kind);
    g.count += 1;
    g.customers.add(row.phone);
    if (row.outcome === "shown" || row.outcome === "chosen") g.withCards += 1;
    if (row.outcome === "chosen") g.chosen += 1;
    for (const id of new Set(stringList(row.shelfIds))) bump(g.shelves, id);
    for (const id of new Set(stringList(row.emptyShelves))) bump(g.empty, id);
    g.lastAt = Math.max(g.lastAt, time(row.createdAt));
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((g) => ({
      label: topCounted(g.labels, 1)[0]?.id ?? "",
      kinds: [...g.kinds].sort(),
      count: g.count,
      customers: g.customers.size,
      withCards: g.withCards,
      chosen: g.chosen,
      chosenPct: pct(g.chosen, g.withCards),
      topShelves: topCounted(g.shelves, 3),
      emptyShelves: topCounted(g.empty, 3),
      lastAt: new Date(g.lastAt).toISOString()
    }));
}

// Fila de revisão do mapa: prateleiras que o plano escolheu e vieram sem item no CEP/estoque.
export function emptyShelfQueue(rows: RecommendLogRow[], limit = 30): EmptyShelfEntry[] {
  const acc = new Map<string, { count: number; requests: Map<string, number>; lastAt: number }>();
  for (const row of rows) {
    const req = requestOf(row);
    for (const id of new Set(stringList(row.emptyShelves))) {
      const e = acc.get(id) ?? { count: 0, requests: new Map(), lastAt: 0 };
      e.count += 1;
      if (req) bump(e.requests, req.label);
      e.lastAt = Math.max(e.lastAt, time(row.createdAt));
      acc.set(id, e);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, e]) => ({ id, count: e.count, requests: topCounted(e.requests, 3).map((r) => r.id), lastAt: new Date(e.lastAt).toISOString() }));
}

export function recentRows(rows: RecommendLogRow[], limit = 50): RecentRow[] {
  return [...rows]
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))
    .slice(0, limit)
    .map((row) => {
      const req = requestOf(row);
      return {
        id: row.id ?? null,
        at: iso(row.createdAt),
        phone: maskPhone(row.phone),
        source: row.source ?? "",
        form: row.form ?? "",
        request: req?.label ?? "",
        kind: req?.kind ?? null,
        shelfIds: stringList(row.shelfIds),
        cards: stringList(row.cardSkus).length,
        outcome: row.outcome ?? "pending",
        chosenSku: row.chosenSku ?? null
      };
    });
}

export function redFlagRows(rows: RecommendLogRow[], limit = 100): RedFlagRow[] {
  return rows
    .filter(isRedFlag)
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))
    .slice(0, limit)
    .map((row) => ({
      id: row.id ?? null,
      at: iso(row.createdAt),
      phone: maskPhone(row.phone),
      request: requestOf(row)?.label ?? "",
      reason: row.redFlag?.trim() || "(sem motivo registrado)",
      shelfIds: stringList(row.shelfIds)
    }));
}

export function buildRecommendReport(rows: RecommendLogRow[], days: number): RecommendReport {
  return {
    days,
    summary: summarize(rows),
    requests: groupRequests(rows, 30),
    emptyShelfQueue: emptyShelfQueue(rows, 30),
    recent: recentRows(rows, 50),
    redFlags: redFlagRows(rows, 100)
  };
}

export function clampDays(value: unknown, fallback = 30): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(180, Math.round(n)));
}
