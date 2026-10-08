// Repasse das chamadas às lojas por São Paulo (08/10/2026, decisão do dono: "caminho B").
//
// Por quê: a Lia roda na Vercel em Portland (pdx1), perto do banco (Supabase us-west-1). Obramax e Casa &
// Vídeo recusam acesso de fora do Brasil no checkout ("403 country not allowed"), então a Lia nunca
// confirmava frete/estoque nem comprava nelas. Em vez de mover servidor e banco, só as chamadas a essas
// lojas passam por uma rota que roda em São Paulo (src/app/api/store-relay, preferredRegion gru1).
//
// Regras de segurança (não é proxy aberto):
// - só hosts da lista (LIA_STORE_RELAY_HOSTS; padrão Obramax e Casa & Vídeo) e só caminhos de API VTEX
//   de catálogo/busca/checkout;
// - chave derivada de um segredo que já existe no servidor (LIA_STORE_RELAY_KEY ou CRON_SECRET) — nunca
//   sai do servidor; sem segredo, o repasse fica desligado e a chamada vai direto, como antes;
// - fora da Vercel (testes, nuvem do agente) nada muda: chamada direta.
import { createHash, timingSafeEqual } from "node:crypto";

export const RELAY_PATH_RE = /^\/api\/(checkout\/pub\/|io\/_v\/api\/intelligent-search\/|catalog_system\/pub\/)/;
const DEFAULT_HOSTS = ["www.obramax.com.br", "www.casaevideo.com.br"];

export function relayHosts(): Set<string> {
  const raw = process.env.LIA_STORE_RELAY_HOSTS?.trim();
  return new Set((raw ? raw.split(",") : DEFAULT_HOSTS).map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export function relayKey(): string | null {
  const secret = process.env.LIA_STORE_RELAY_KEY || process.env.CRON_SECRET;
  if (!secret) return null;
  return createHash("sha256").update(`lia-store-relay:${secret}`).digest("hex");
}

export function relayKeyMatches(given: string | null | undefined): boolean {
  const expected = relayKey();
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// URL alvo permitida para o repasse? (puro, testável)
export function relayAllowed(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "https:" && relayHosts().has(url.host.toLowerCase()) && RELAY_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function relayEndpoint(): string | null {
  if (process.env.LIA_STORE_RELAY_OFF === "true") return null;
  if (process.env.LIA_STORE_RELAY_URL) return process.env.LIA_STORE_RELAY_URL;
  // Já em São Paulo (a própria rota de repasse) ou fora da Vercel: chamada direta.
  if (!process.env.VERCEL || (process.env.VERCEL_REGION ?? "").startsWith("gru")) return null;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/store-relay` : null;
}

type RelayInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
export type RelayEnvelope = { status: number; contentType?: string; setCookie?: string[]; body: string };

// Mesmo formato do fetch: as lojas da lista vão pelo repasse; o resto, direto.
export async function storeFetch(input: string, init: RelayInit = {}): Promise<Response> {
  const endpoint = relayEndpoint();
  const key = relayKey();
  if (!endpoint || !key || !relayAllowed(input)) return fetch(input, init);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lia-relay-key": key },
    body: JSON.stringify({ url: input, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body }),
    signal: init.signal
  });
  if (!res.ok) return new Response(await res.text().catch(() => ""), { status: res.status });
  const env = (await res.json()) as RelayEnvelope;
  const headers = new Headers();
  if (env.contentType) headers.set("content-type", env.contentType);
  for (const c of env.setCookie ?? []) headers.append("set-cookie", c);
  return new Response(env.body, { status: env.status, headers });
}
