import { PixOutTimeout, type PixDecode, type PixOutProvider, type PixPayResult, type PixPayStatus } from "./types";

// Asaas (docs.asaas.com): POST /v3/pix/qrCodes/decode, POST /v3/pix/qrCodes/pay,
// GET /v3/pix/transactions/{id}. Sem campo de idempotência no request: o fluxo grava o
// PixPayout antes da chamada e jamais repete o pay após timeout.
const base = () => (process.env.ASAAS_ENV === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3");
function key() {
  const k = process.env.ASAAS_API_KEY?.trim();
  if (!k) throw new Error("ASAAS_API_KEY ausente.");
  return k;
}
async function call(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers: { access_token: key(), "content-type": "application/json", "user-agent": "lia-pix-out" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new PixOutTimeout(error instanceof Error ? error.message : "sem resposta");
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errors = json.errors as { description?: string }[] | undefined;
    throw new Error(`Asaas ${response.status}: ${errors?.[0]?.description ?? "erro"}`);
  }
  return json;
}
function mapStatus(status: unknown): PixPayStatus["status"] {
  const s = String(status ?? "");
  if (s === "DONE") return "paid";
  if (["REFUSED", "CANCELLED", "ERROR"].includes(s)) return "refused";
  if (["SCHEDULED", "REQUESTED", "AWAITING_BALANCE_VALIDATION", "AWAITING_CRITICAL_ACTION_AUTHORIZATION", "AWAITING_CHECKOUT_RISK_ANALYSIS_REQUEST", "AWAITING_INSTANT_PAYMENT_TRANSACTION_PROCESSING", "AWAITING_REQUEST"].includes(s)) return "submitted";
  return "unknown";
}
// Saldo disponível para Pix de saída, em centavos (GET /v3/finance/balance).
export async function asaasBalanceCents(): Promise<number> {
  const r = await call("/finance/balance", { timeoutMs: 5_000 });
  return Math.round(Number(r.balance ?? 0) * 100);
}
export const asaasPixOut: PixOutProvider = {
  name: "asaas",
  async decode(code): Promise<PixDecode> {
    const r = await call("/pix/qrCodes/decode", { method: "POST", body: { payload: code } });
    const receiver = (r.receiver ?? {}) as { name?: string; cpfCnpj?: string };
    const value = Number(r.value ?? r.totalValue);
    return {
      type: String(r.type ?? "").startsWith("DYNAMIC") ? "dynamic" : "static",
      receiverName: String(receiver.name ?? "").trim(),
      receiverDoc: String(receiver.cpfCnpj ?? "").replace(/\D/g, ""),
      amountCents: Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null,
      canBePaidWithDifferentValue: Boolean(r.canBePaidWithDifferentValue),
      expiresAt: typeof r.expirationDate === "string" ? r.expirationDate : null,
    };
  },
  async pay(input): Promise<PixPayResult> {
    const r = await call("/pix/qrCodes/pay", {
      method: "POST", timeoutMs: 20_000,
      body: { qrCode: { payload: input.code }, value: input.amountCents / 100, description: input.description.slice(0, 100) },
    });
    const id = String(r.id ?? "");
    if (!id) throw new PixOutTimeout("Asaas sem id na resposta.");
    const status = mapStatus(r.status);
    return { providerPayoutId: id, status: status === "paid" ? "paid" : status === "refused" ? "refused" : "submitted", endToEndId: (r.endToEndIdentifier as string | undefined) ?? null };
  },
  async status(providerPayoutId): Promise<PixPayStatus> {
    const r = await call(`/pix/transactions/${encodeURIComponent(providerPayoutId)}`);
    return { status: mapStatus(r.status), endToEndId: (r.endToEndIdentifier as string | undefined) ?? null, reason: typeof r.refusalReason === "string" ? r.refusalReason : String(r.status ?? "") };
  },
};
