import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ensureCarouselV4 } from "@/lib/meta-setup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return !process.env.VERCEL;
  const received = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Carrossel v4 (28/09): cria na Meta os templates que faltam e registra o status; o envio
// troca para v4 sozinho quando a Meta aprova (activeCarouselPrefix).
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.WHATSAPP_PROVIDER !== "meta") return NextResponse.json({ skipped: "sem Meta" });
  const status = await ensureCarouselV4().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  console.log("[cron:meta-templates]", status);
  return NextResponse.json(status);
}
