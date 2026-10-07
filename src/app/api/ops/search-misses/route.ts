import { NextResponse } from "next/server";
import { requireOpsKey } from "@/lib/auth";
import { loadSearchMisses } from "@/lib/search-misses";

export const dynamic = "force-dynamic";

// Itens que o cliente pediu e a Lia não achou (07/10), agrupados por pedido. Demanda real para
// escolher lojas e catálogo; vale para dono e operador (não tem dinheiro nem credencial).
export async function GET(request: Request) {
  const denied = requireOpsKey(request, { allowQuery: true });
  if (denied) return denied;
  const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
  return NextResponse.json(await loadSearchMisses({ days: Number.isFinite(days) ? days : 30 }));
}
