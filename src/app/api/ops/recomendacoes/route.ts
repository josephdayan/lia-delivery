import { NextResponse } from "next/server";
import { requireOpsKey } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildRecommendReport, clampDays } from "@/lib/recommend-ops";

export const dynamic = "force-dynamic";

// Painel de recomendações (08/10): o que o cliente pede de forma vaga, o que converte e onde o
// mapa de prateleiras falhou. Mesma proteção de /api/ops/search-misses (OPS_TOKEN: dono e
// operador). O telefone sai mascarado (4 últimos dígitos); a agregação é pura (recommend-ops.ts).
export async function GET(request: Request) {
  const denied = requireOpsKey(request, { allowQuery: true });
  if (denied) return denied;
  const days = clampDays(new URL(request.url).searchParams.get("days") ?? 30);
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const rows = await prisma.recommendLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      id: true,
      createdAt: true,
      phone: true,
      source: true,
      form: true,
      need: true,
      product: true,
      symptom: true,
      planSource: true,
      redFlag: true,
      shelfIds: true,
      cardSkus: true,
      emptyShelves: true,
      chosenSku: true,
      outcome: true,
      mapMs: true,
      searchMs: true,
      judgeMs: true
    }
  });
  return NextResponse.json(buildRecommendReport(rows, days));
}
