// Registro do que o cliente pediu e a Lia não achou (07/10, Etapa 3). Alimenta /ops/faltantes:
// demanda real para escolher lojas e catálogo. Gravação best-effort — nunca quebra o turno.
import { prisma } from "@/lib/prisma";
import { sha256Hex } from "@/lib/sha256";

export type SearchMissInput = { query: string; reason: string };

function normQuery(query: string): string {
  return query
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function missPhoneHash(phone: string): string {
  return sha256Hex(`search-miss:${phone.replace(/\D/g, "")}`).slice(0, 16);
}

export async function recordSearchMisses(phone: string, cep: string | null | undefined, misses: SearchMissInput[]): Promise<void> {
  const rows = misses.map((m) => ({ query: m.query.trim().slice(0, 120), reason: m.reason })).filter((m) => m.query);
  if (!rows.length) return;
  try {
    const cepPrefix = (cep ?? "").replace(/\D/g, "").slice(0, 5) || null;
    const phoneHash = missPhoneHash(phone);
    await prisma.searchMiss.createMany({ data: rows.map((m) => ({ ...m, phoneHash, cepPrefix })) });
  } catch (error) {
    console.warn("[search-miss:record-failed]", error instanceof Error ? error.message : error);
  }
}

export type SearchMissGroup = { query: string; count: number; customers: number; reasons: string[]; lastAt: string };

export async function loadSearchMisses(opts: { days?: number } = {}): Promise<{ total: number; groups: SearchMissGroup[] }> {
  const days = Math.max(1, Math.min(180, opts.days ?? 30));
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const rows = await prisma.searchMiss.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 5000 });
  const groups = new Map<string, { query: string; count: number; customers: Set<string>; reasons: Set<string>; lastAt: Date }>();
  for (const row of rows) {
    const key = normQuery(row.query);
    const group = groups.get(key) ?? { query: row.query, count: 0, customers: new Set<string>(), reasons: new Set<string>(), lastAt: row.createdAt };
    group.count += 1;
    group.customers.add(row.phoneHash);
    group.reasons.add(row.reason);
    if (row.createdAt > group.lastAt) group.lastAt = row.createdAt;
    groups.set(key, group);
  }
  const list = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime())
    .map((g) => ({ query: g.query, count: g.count, customers: g.customers.size, reasons: [...g.reasons].sort(), lastAt: g.lastAt.toISOString() }));
  return { total: rows.length, groups: list };
}
