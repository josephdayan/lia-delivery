// Rota de repasse às lojas que bloqueiam acesso de fora do Brasil — roda em São Paulo (gru1).
// Ver src/lib/store-relay.ts para o porquê e as regras de segurança.
import { NextResponse } from "next/server";
import { relayAllowed, relayKeyMatches, type RelayEnvelope } from "@/lib/store-relay";

export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FORWARD_HEADERS = new Set(["accept", "content-type", "cookie", "user-agent"]);

// Diagnóstico sem chave e sem entrada livre: uma simulação FIXA (1 SKU, CEP da Av. Paulista) para conferir
// a região e se a loja responde daqui. Devolve só status e disponibilidade.
const PROBES: Record<string, { domain: string; sku: string }> = {
  obramax: { domain: "www.obramax.com.br", sku: "75310" },
  casaevideo: { domain: "www.casaevideo.com.br", sku: "3217200" }
};

export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe") ?? "";
  const target = PROBES[probe];
  if (!target) return NextResponse.json({ region: process.env.VERCEL_REGION ?? null });
  try {
    const res = await fetch(`https://${target.domain}/api/checkout/pub/orderForms/simulation?sc=1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      body: JSON.stringify({ items: [{ id: target.sku, quantity: 1, seller: "1" }], postalCode: "01310100", country: "BRA" }),
      signal: AbortSignal.timeout(8000)
    });
    const data = res.ok ? ((await res.json()) as { items?: Array<{ availability?: string }> }) : null;
    return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, store: probe, status: res.status, availability: data?.items?.[0]?.availability ?? null });
  } catch (error) {
    return NextResponse.json({ region: process.env.VERCEL_REGION ?? null, store: probe, error: String(error).slice(0, 120) });
  }
}

export async function POST(req: Request) {
  if (!relayKeyMatches(req.headers.get("x-lia-relay-key"))) return new NextResponse("forbidden", { status: 403 });
  let payload: { url?: string; method?: string; headers?: Record<string, string>; body?: string };
  try {
    payload = await req.json();
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  const url = String(payload.url ?? "");
  const method = String(payload.method ?? "GET").toUpperCase();
  if (!relayAllowed(url) || !["GET", "POST", "PUT", "PATCH"].includes(method)) return new NextResponse("not allowed", { status: 403 });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.headers ?? {})) if (FORWARD_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : payload.body, signal: AbortSignal.timeout(25_000) });
    const envelope: RelayEnvelope = {
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      setCookie: res.headers.getSetCookie?.() ?? [],
      body: await res.text()
    };
    return NextResponse.json(envelope);
  } catch (error) {
    return NextResponse.json({ status: 504, body: String(error).slice(0, 200) } satisfies RelayEnvelope);
  }
}
