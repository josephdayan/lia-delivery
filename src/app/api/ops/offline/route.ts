import { NextResponse } from "next/server";
import { requireOpsOwner } from "@/lib/auth";
import { isOfflineMode, setOfflineMode } from "@/lib/offline-mode";

export const dynamic = "force-dynamic";

// Interruptor do modo offline (06/10): GET lê, POST {on: boolean} liga/desliga. Só o dono.
export async function GET(request: Request) {
  const unauthorized = requireOpsOwner(request, { allowQuery: true });
  if (unauthorized) return unauthorized;
  return NextResponse.json({ offline: await isOfflineMode(), forcedByEnv: process.env.LIA_OFFLINE === "true" });
}

export async function POST(request: Request) {
  const unauthorized = requireOpsOwner(request, { allowQuery: true });
  if (unauthorized) return unauthorized;
  const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ error: "envie {on: true|false}" }, { status: 400 });
  await setOfflineMode(body.on, "ops");
  return NextResponse.json({ offline: await isOfflineMode(), forcedByEnv: process.env.LIA_OFFLINE === "true" });
}
