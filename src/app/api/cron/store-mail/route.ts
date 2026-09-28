import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { readStoreMailOnce } from "@/lib/store-mail-reader";
import { pollVtexOrderStatuses } from "@/lib/purchase/vtex-status";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return !process.env.VERCEL;
  const received = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Leitor de e-mails das lojas (25/09): confirma pagamento/faturamento/entrega sem humano.
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const report = await readStoreMailOnce().catch((error) => ({ configured: true, errors: [error instanceof Error ? error.message : String(error)] }) as Awaited<ReturnType<typeof readStoreMailOnce>>);
  // 27/09: status direto no pedido da loja (faturado / enviado / saiu / entregue).
  const status = await pollVtexOrderStatuses({ limit: 10 }).catch((error) => ({ checked: 0, notices: 0, events: 0, errors: [error instanceof Error ? error.message : String(error)] }));
  console.log("[cron:store-mail]", { ...report, errors: report.errors.length }, "[store-status]", { ...status, errors: status.errors.length });
  if (report.errors.length || status.errors.length) console.warn("[cron:store-mail:errors]", report.errors, status.errors);
  return NextResponse.json({ mail: report, status });
}
