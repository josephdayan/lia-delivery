// Leitor de e-mails transacionais das lojas NO SERVIDOR (25/09/2026): substitui o
// `mailLoop` do comprador do Mac. Gmail somente-leitura por refresh token (envs
// LIA_GMAIL_CLIENT_ID / LIA_GMAIL_CLIENT_SECRET / LIA_GMAIL_REFRESH_TOKEN), classificação
// pura em mailbox-policy.ts e veredito para tracking-worker.reportMail. O corpo do e-mail
// nunca é gravado; só o id da mensagem (StoreMailSeen) para não reportar duas vezes.
import { prisma } from "./prisma";
import { classifyStoreMail, STORE_MAIL_RULES } from "./mailbox-policy";
import { reportMail } from "./tracking-worker";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; internalDate?: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } };

export function storeMailReaderConfigured() {
  return Boolean(process.env.LIA_GMAIL_CLIENT_ID?.trim() && process.env.LIA_GMAIL_CLIENT_SECRET?.trim() && process.env.LIA_GMAIL_REFRESH_TOKEN?.trim());
}
function decode(part?: GmailPart): string {
  if (!part) return "";
  const own = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
  const children = (part.parts ?? []).map(decode).join("\n");
  return `${own}\n${children}`;
}
export function messageText(payload?: GmailPart): string {
  return decode(payload)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
// Link da nota fiscal num e-mail de faturamento (29/09, remédio no CPF do cliente): o
// cliente recebe a nota que saiu no nome dele. Procura no HTML CRU (href) e no texto, e
// só aceita link com cara de NF-e/DANFE — nunca "acompanhe seu pedido" ou descadastro.
const INVOICE_LINK_RE = /(nf-?e|nfc-?e|danfe|nota[-_ ]?fiscal|notafiscal|invoice|sefaz|fazenda\.|consultadfe|nfce)/i;
const NOT_INVOICE_RE = /(unsubscribe|descadastr|optout|opt-out|preferenc|privacidade|facebook|instagram|twitter|youtube|whatsapp|\.(png|jpe?g|gif|svg)(\?|$))/i;
export function invoiceLinkFrom(raw: string): string | undefined {
  const urls = [
    ...[...(raw ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...((raw ?? "").match(/https?:\/\/[^\s"'<>)]+/gi) ?? []),
  ].map((u) => u.replace(/&amp;/g, "&").trim());
  return urls.find((u) => /^https:\/\//i.test(u) && INVOICE_LINK_RE.test(u) && !NOT_INVOICE_RE.test(u));
}
function header(m: GmailMessage, name: string) {
  return (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export class GmailStoreMailReader {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private readonly fetchImpl: FetchLike = fetch) {}
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const r = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, cache: "no-store",
      body: new URLSearchParams({ client_id: process.env.LIA_GMAIL_CLIENT_ID!, client_secret: process.env.LIA_GMAIL_CLIENT_SECRET!, refresh_token: process.env.LIA_GMAIL_REFRESH_TOKEN!, grant_type: "refresh_token" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!r.ok || !body.access_token) throw new Error(`Gmail: refresh token recusado (${r.status} ${body.error ?? ""} ${body.error_description ?? ""}).`.replace(/\s+/g, " "));
    if (body.scope && !/gmail/i.test(body.scope)) console.warn("[store-mail] token sem escopo Gmail:", body.scope);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  private async gmail<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    // `cache: "no-store"` + Headers explícito: o fetch remendado do Next na Vercel devolvia 401
    // UNAUTHENTICATED com token válido (25/09) — cabeçalho de autorização não chegava ao Gmail.
    const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
    const r = await this.fetchImpl(`https://gmail.googleapis.com${path}`, { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
      throw new Error(`Gmail ${r.status} em ${path.split("?")[0]}: ${detail.error?.status ?? ""} ${detail.error?.message ?? ""}`.replace(/\s+/g, " ").trim());
    }
    return (await r.json()) as T;
  }
  // Lista mensagens recentes de TODAS as lojas com regra, numa consulta só.
  async listRecent(days = 2, maxResults = 40) {
    const domains = [...new Set(Object.values(STORE_MAIL_RULES).flatMap((r) => [...r.domains, ...(r.senders ?? []).map((s) => s.domain)]))];
    const q = `newer_than:${days}d (${domains.map((d) => `from:${d}`).join(" OR ")})`;
    const listed = await this.gmail<{ messages?: { id: string }[] }>(`/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(q)}`);
    return (listed.messages ?? []).map((m) => m.id);
  }
  async read(id: string) {
    const m = await this.gmail<GmailMessage>(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    return { id, from: header(m, "from"), subject: header(m, "subject"), text: messageText(m.payload).slice(0, 20_000), receivedAt: Number(m.internalDate) || Date.now(), invoiceUrl: invoiceLinkFrom(decode(m.payload)) };
  }
}

// Uma passada: lê, classifica por loja, reporta o veredito e marca a mensagem como vista.
export async function readStoreMailOnce(reader = new GmailStoreMailReader(), days = 2) {
  const report = { listed: 0, alreadySeen: 0, checked: 0, reported: 0, matched: 0, verdicts: [] as string[], errors: [] as string[] };
  if (!storeMailReaderConfigured()) return { ...report, configured: false };
  const ids = await reader.listRecent(days);
  const seen = new Set((await prisma.storeMailSeen.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } })).map((s) => s.messageId));
  report.listed = ids.length;
  report.alreadySeen = ids.filter((id) => seen.has(id)).length;
  for (const id of ids) {
    if (seen.has(id)) continue;
    report.checked += 1;
    try {
      const mail = await reader.read(id);
      let verdictStore: string | null = null;
      let matched = false;
      for (const storeKey of Object.keys(STORE_MAIL_RULES)) {
        const verdict = classifyStoreMail(storeKey, mail);
        if (!verdict) continue;
        verdictStore = storeKey;
        const result = await reportMail({
          storeKey, storeOrderNumber: verdict.storeOrderNumber, kind: verdict.kind, messageId: id, receivedAt: new Date(mail.receivedAt).toISOString(),
          ...(verdict.trackingUrl ? { trackingUrl: verdict.trackingUrl } : {}), ...(verdict.deliveryCode ? { deliveryCode: verdict.deliveryCode } : {}),
          ...(verdict.kind === "invoiced" && (mail as { invoiceUrl?: string }).invoiceUrl ? { invoiceUrl: (mail as { invoiceUrl?: string }).invoiceUrl } : {}),
        });
        report.reported += 1;
        report.verdicts.push(`${storeKey}:${verdict.kind}:${result.matched ? "ok" : result.reason}`);
        if (result.matched) { matched = true; report.matched += 1; }
        break;
      }
      await prisma.storeMailSeen.create({ data: { messageId: id, storeKey: verdictStore, kind: verdictStore ? "reported" : "ignored", matched } }).catch(() => undefined);
    } catch (error) {
      report.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...report, configured: true };
}
