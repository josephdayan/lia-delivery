// Livro-razão do dinheiro (revisão 02/09). Uma linha `Payment` por pagamento conhecido no
// provedor; o estorno por API grava aqui quanto voltou e com que referência. Este módulo
// não fala com o cliente nem com o operador — só provedor + banco. Quem avisa é o
// cérebro (delivery-service), que chama estas funções.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PaymentProviderError, getMercadoPagoPayment, refundMercadoPagoPayment } from "./mercadopago";
import { pagarmeAdapter } from "./pagarme";

export type LedgerProvider = "mercadopago" | "pagarme" | "mock";

export type RecordPaymentInput = {
  deliveryOrderId: string;
  provider: LedgerProvider;
  providerPaymentId: string;
  method: "pix" | "card";
  amountCents: number;
  status: "approved" | "unexpected";
  rawStatus?: string | null;
  // Financeiro (23/09): taxa do provedor e líquido, em centavos. Só gravam quando vêm
  // preenchidos — um replay sem eles nunca apaga o que já foi lido.
  feeCents?: number | null;
  netCents?: number | null;
};

function toCents(value: number) {
  return Math.round(Number(value.toFixed(2)) * 100);
}

// Idempotente por (provedor, id): o replay do webhook não duplica linha.
export async function recordPayment(input: RecordPaymentInput, db: Prisma.TransactionClient = prisma) {
  const payment = await db.payment.upsert({
    where: { provider_providerPaymentId: { provider: input.provider, providerPaymentId: input.providerPaymentId } },
    create: {
      deliveryOrderId: input.deliveryOrderId,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      method: input.method,
      amountCents: input.amountCents,
      status: input.status,
      rawStatus: input.rawStatus ?? null,
      feeCents: input.feeCents ?? null,
      netCents: input.netCents ?? null
    },
    // Um "unexpected" que depois se confirma como o pagamento certo pode virar approved;
    // o contrário nunca (approved não regride).
    update: {
      rawStatus: input.rawStatus ?? null,
      ...(input.feeCents != null ? { feeCents: input.feeCents } : {}),
      ...(input.netCents != null ? { netCents: input.netCents } : {})
    }
  });
  if (payment.deliveryOrderId !== input.deliveryOrderId || payment.amountCents !== input.amountCents) {
    throw new Error("Pagamento já vinculado a outro pedido ou valor.");
  }
  if (input.status === "approved") {
    await db.payment.updateMany({ where: { id: payment.id, status: "unexpected", refundedCents: 0 }, data: { status: "approved" } });
  }
  return db.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

export async function paymentsForOrder(deliveryOrderId: string) {
  return prisma.payment.findMany({ where: { deliveryOrderId }, orderBy: { createdAt: "desc" } });
}

// Backfill das taxas (23/09): pagamentos do MP gravados antes da coluna existir, ou cujo
// webhook chegou sem `fee_details`, ganham taxa/líquido lidos do provedor. Roda no cron
// de reconciliação, poucos por vez, e nunca lança — sem credencial é um no-op.
export async function backfillPaymentFees(limit = 20): Promise<{ checked: number; filled: number; errors: string[] }> {
  const report = { checked: 0, filled: 0, errors: [] as string[] };
  const pending = await prisma.payment.findMany({
    where: { provider: "mercadopago", feeCents: null, status: { in: ["approved", "partially_refunded", "refunded"] } },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(100, limit))
  });
  for (const payment of pending) {
    report.checked += 1;
    try {
      const details = await getMercadoPagoPayment(payment.providerPaymentId);
      if (!details || details.feeAmount == null) continue;
      await prisma.payment.update({
        where: { id: payment.id },
        data: { feeCents: toCents(details.feeAmount), netCents: details.netAmount != null ? toCents(details.netAmount) : null }
      });
      report.filled += 1;
    } catch (error) {
      report.errors.push(`fee ${payment.providerPaymentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

export type RefundResult = {
  provider: LedgerProvider;
  providerPaymentId: string;
  amount: number;
  reference: string;
  total: boolean;
};

// Estorna pelo provedor o pagamento aprovado mais recente do pedido (total ou parcial) e
// atualiza o razão. Lança Error com mensagem legível quando não há o que estornar ou o
// provedor recusa — o /ops mostra a mensagem.
// `onlyJobId` (09/10, pedido de várias lojas): devolução da parte de UMA loja — só o trabalho de compra
// dela precisa estar sem dinheiro a caminho; as outras lojas podem estar comprando.
export async function refundOrderViaProvider(deliveryOrderId: string, amount?: number, opts: { onlyJobId?: string } = {}): Promise<RefundResult> {
  const payment = await prisma.payment.findFirst({
    where: { deliveryOrderId, status: { in: ["approved", "partially_refunded"] } },
    orderBy: { createdAt: "desc" }
  });
  if (!payment) {
    throw new Error("Nenhum pagamento aprovado registrado no provedor para este pedido — confirme o estorno manualmente.");
  }
  const remainingCents = payment.amountCents - payment.refundedCents;
  const requestedCents = amount == null ? remainingCents : toCents(amount);
  if (!Number.isFinite(requestedCents) || requestedCents <= 0) throw new Error("Valor do estorno inválido.");
  if (requestedCents > remainingCents) {
    throw new Error(`Valor acima do que resta estornar (R$ ${(remainingCents / 100).toFixed(2).replace(".", ",")}).`);
  }
  const total = requestedCents === remainingCents;

  // O lock também serializa cron, plano B e /ops. A chamada externa usa uma chave
  // estável desta parcela: se o banco falhar depois do provedor, o retry a reutiliza.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${deliveryOrderId} FOR UPDATE`;
    // Depois que a compra foi encaminhada (clique, Pix da loja ou carrinho nas mãos do
    // dono), o dinheiro pode já ter saído: reconciliar antes de devolver ao cliente.
    const purchase = await tx.purchaseJob.findFirst({ where: { deliveryOrderId, ...(opts.onlyJobId ? { id: opts.onlyJobId } : {}), status: { in: ["submitting", "outcome_unknown", "awaiting_owner_confirm", "awaiting_store_number", "pix_captured", "pix_submitted", "pix_paid", "store_confirmed"] }, submissionId: { not: null } } });
    if (purchase) throw new Error("Compra enviada ou com resultado desconhecido. Reconcilie a loja antes de estornar.");
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (current.refundedCents !== payment.refundedCents || current.status !== payment.status) {
      throw new Error("Pagamento mudou durante o estorno. Recarregue antes de continuar.");
    }
    const idempotencyKey = `refund:${payment.id}:${payment.refundedCents}:${requestedCents}`;

    let reference: string;
    if (payment.provider === "mercadopago") {
      const refund = await refundMercadoPagoPayment(payment.providerPaymentId, requestedCents / 100, idempotencyKey);
      if (refund.status !== "approved" || !refund.refundId || Math.round((refund.amount ?? 0) * 100) !== requestedCents) {
        throw new Error("Estorno ainda não confirmado pelo Mercado Pago. Reconciliar antes de informar o cliente.");
      }
      reference = `MP refund ${refund.refundId || "?"} (pagamento ${payment.providerPaymentId})`;
    } else if (payment.provider === "pagarme") {
      const refund = await pagarmeAdapter.refundCharge(payment.providerPaymentId, requestedCents, idempotencyKey);
      if (!["refunded", "partial_refunded", "canceled"].includes(refund.status)) {
        throw new Error("Estorno ainda não confirmado pela Pagar.me. Reconciliar antes de informar o cliente.");
      }
      reference = `Pagar.me ${refund.reference} (${refund.status})`;
    } else if (payment.provider === "mock") {
      reference = `mock refund ${payment.providerPaymentId}`;
    } else {
      throw new PaymentProviderError(`provedor desconhecido: ${payment.provider}`);
    }

    const refundedCents = payment.refundedCents + requestedCents;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedCents,
        refundReference: reference,
        status: refundedCents >= payment.amountCents ? "refunded" : "partially_refunded"
      }
    });
    return { provider: payment.provider as LedgerProvider, providerPaymentId: payment.providerPaymentId, amount: requestedCents / 100, reference, total };
  }, { timeout: 20_000, maxWait: 5_000 });
}
