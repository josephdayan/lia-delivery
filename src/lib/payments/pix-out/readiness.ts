import { prisma } from "@/lib/prisma";
import { pixAdapter } from "@/lib/payments/mercadopago";
import { asaasBalanceCents, asaasPixOut } from "./asaas";
import { pixOutEnabled } from "./index";

// Trava antes de cobrar (06/10): com o Asaas recusando o Pix de saída ("Assim que você tiver
// sua conta aprovada…"), TODO pedido pago virava estorno — o cliente pagava, esperava e
// recebia "não consegui comprar". Agora a Lia confere ANTES de cobrar:
//  1. saldo do Asaas ≥ valor do pedido;
//  2. houve recusa do Pix de saída nas últimas 6h sem nenhum pagamento depois → testa de
//     novo (cobrança Pix de R$1 no Mercado Pago da Lia + decode no Asaas; o decode não paga
//     nada e a cobrança expira sozinha), no máximo a cada 10 min por instância.
// Falha da própria consulta NÃO trava venda (fail-open): só um "não" do Asaas trava.
// LIA_PIX_OUT_PREFLIGHT_OFF=true desliga a trava.
export type PixOutReadiness = { ok: true } | { ok: false; reason: "saldo" | "conta" };

const PROBE_TTL_MS = 10 * 60_000;
const BREAKER_WINDOW_MS = 6 * 3_600_000;
let probeCache: { at: number; ok: boolean } | null = null;

export function resetPixOutProbeCache() {
  probeCache = null;
}

async function probeDecode(): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.ok;
  let ok = true;
  try {
    const charge = await pixAdapter.createPix({ orderId: `pixout-probe-${Date.now()}`, amount: 1, description: "Lia teste Pix de saida", payerEmail: "lia@liadelivery.com.br" });
    await asaasPixOut.decode(charge.copiaECola);
  } catch (error) {
    // Só a recusa do Asaas conta como "não"; erro do Mercado Pago ou de rede não trava venda.
    ok = !(error instanceof Error && /^Asaas 4\d\d/.test(error.message));
  }
  probeCache = { at: Date.now(), ok };
  return ok;
}

export async function pixOutReadiness(amountCents: number): Promise<PixOutReadiness> {
  if (process.env.LIA_PIX_OUT_PREFLIGHT_OFF === "true") return { ok: true };
  if (!pixOutEnabled() || process.env.LIA_PIX_OUT_PROVIDER?.trim() !== "asaas") return { ok: true };
  try {
    if ((await asaasBalanceCents()) < amountCents) return { ok: false, reason: "saldo" };
  } catch (error) {
    console.warn("[pix-out:readiness:balance-error]", error instanceof Error ? error.message : error);
  }
  // (08/10 noite) Sem janela de 6h: a última recusa do Asaas (06/10, "conta não aprovada") saía da janela
  // e a trava abria sem testar — cobrança → compra recusada → estorno. Vale a ÚLTIMA recusa, de quando for,
  // sem nenhum Pix pago depois dela: aí testa de novo (no máximo a cada 10 min).
  const refusal = await prisma.purchaseAttempt.findFirst({
    where: { step: "pix_capture", status: "refused", ...(process.env.LIA_PIX_OUT_BREAKER_WINDOW === "6h" ? { createdAt: { gte: new Date(Date.now() - BREAKER_WINDOW_MS) } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!refusal) return { ok: true };
  const paidAfter = await prisma.pixPayout.findFirst({ where: { status: "paid", updatedAt: { gt: refusal.createdAt } }, select: { id: true } });
  if (paidAfter) return { ok: true };
  return (await probeDecode()) ? { ok: true } : { ok: false, reason: "conta" };
}
