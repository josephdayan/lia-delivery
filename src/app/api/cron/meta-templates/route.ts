import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ensureCarouselV4, ensureSignupFlow } from "@/lib/meta-setup";

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
// Cadastro (06/10): garante o Flow de cadastro publicado; o primeiro contato passa a usá-lo
// sozinho (activeSignupFlowId). Erro de validação da Meta aparece no log abaixo.
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.WHATSAPP_PROVIDER !== "meta") return NextResponse.json({ skipped: "sem Meta" });
  const failed = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
  const status = await ensureCarouselV4().catch(failed);
  const signup = await ensureSignupFlow().catch(failed);
  console.log("[cron:meta-templates]", status);
  console.log("[cron:meta-templates:signup-flow]", JSON.stringify(signup).slice(0, 1500));
  return NextResponse.json({ ...status, signupFlow: signup });
}
