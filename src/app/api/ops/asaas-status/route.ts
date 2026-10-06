import { NextResponse } from "next/server";
import { requireOpsOwner } from "@/lib/auth";
import { pixAdapter } from "@/lib/payments/mercadopago";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Diagnóstico do Pix de saída (06/10): o Asaas passou a recusar o decode com "Assim que você
// tiver sua conta aprovada, você poderá utilizar o Pix" com o painel mostrando conta aprovada.
// Só leitura: status cadastral da conta pela API, saldo e um decode de uma cobrança Pix de R$1
// criada no Mercado Pago da Lia (decode não paga nada; a cobrança expira sozinha).
const base = () => (process.env.ASAAS_ENV === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3");

async function asaas(path: string, init: { method?: string; body?: unknown } = {}) {
  try {
    const response = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers: { access_token: process.env.ASAAS_API_KEY?.trim() ?? "", "content-type": "application/json", "user-agent": "lia-pix-out" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    return { http: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { http: 0, body: error instanceof Error ? error.message : "sem resposta" };
  }
}

export async function GET(request: Request) {
  const unauthorized = requireOpsOwner(request, { allowQuery: true });
  if (unauthorized) return unauthorized;
  if (!process.env.ASAAS_API_KEY?.trim()) return NextResponse.json({ error: "ASAAS_API_KEY ausente." }, { status: 409 });
  const report: Record<string, unknown> = { env: process.env.ASAAS_ENV ?? "sandbox", at: new Date().toISOString() };
  report.accountStatus = await asaas("/myAccount/status");
  report.balance = await asaas("/finance/balance");
  try {
    const charge = await pixAdapter.createPix({ orderId: `diag-${Date.now()}`, amount: 1, description: "Lia diagnostico Asaas", payerEmail: "lia@liadelivery.com.br" });
    const decoded = await asaas("/pix/qrCodes/decode", { method: "POST", body: { payload: charge.copiaECola } });
    const receiver = (decoded.body as { receiver?: { cpfCnpj?: string } } | null)?.receiver;
    if (receiver?.cpfCnpj) receiver.cpfCnpj = receiver.cpfCnpj.replace(/^(\d{3})\d+(\d{2})$/, "$1…$2");
    report.decode = decoded;
  } catch (error) {
    report.decode = { error: error instanceof Error ? error.message : "erro" };
  }
  console.log("[ops:asaas-status]", JSON.stringify(report).slice(0, 600));
  return NextResponse.json(report);
}
