// Falha parcial (09/10/2026, dono: "se uma loja recusar depois do pagamento, devolver só a parte dela e
// seguir com as outras. Hoje tudo ou nada."). Num pedido de várias lojas, a loja que não fecha devolve
// ao cliente a parte DELA (produtos + margem + frete, `customerShare` gravado na cotação), o trabalho de
// compra dela fecha e as outras lojas seguem compradas, acompanhadas e avisadas normalmente.
//
// Segurança do dinheiro:
//   - Só devolve com o trabalho da loja SEM dinheiro a caminho (nem Pix de saída, nem pedido criado sem
//     conferência); o provedor confere só esse trabalho (`onlyJobId`).
//   - A devolução é reservada ANTES da chamada (tentativa `store_refund`, chave única por trabalho): duas
//     varreduras ao mesmo tempo não devolvem duas vezes; falha do provedor apaga a reserva para tentar de
//     novo. A soma das reservas é o "devolvido esperado" que a compra das outras lojas confere.
//   - Última loja que sobrava sem nada comprado: o pedido inteiro fica estornado, como antes.
import { prisma } from "../prisma";
import { appendOrderNote, PAID_OR_IN_FULFILLMENT_STATUSES, REFUND_CONFIRMED_PREFIX } from "../order-flags";
import { refundOrderViaProvider } from "../payments/ledger";
import { isMultiStoreOrder, orderItems, storeScope, STORE_SHARE_REFUNDED } from "./store-split";

const MONEY_MOVING = ["submitting", "outcome_unknown", "awaiting_owner_confirm", "awaiting_store_number", "pix_captured", "pix_submitted", "pix_paid", "store_confirmed", "completed"];

export type StoreRefundResult =
  | { status: "refunded"; amount: number; reference: string; orderClosed: boolean }
  | { status: "skipped"; reason: string };

export async function refundStoreShare(
  jobId: string,
  // `storeCanceled` (09/10): a loja cancelou DEPOIS da compra (status "canceled" ou e-mail). A compra
  // desta loja está registrada (Pix pago à loja, a recuperar com ela); a parte do cliente volta mesmo assim.
  input: { reason: string; internalReason?: string; origin: "auto" | "ops"; storeCanceled?: { storeOrderNumber: string } }
): Promise<StoreRefundResult> {
  const reservation = await prisma.$transaction(async (tx) => {
    const base = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId }, select: { deliveryOrderId: true } });
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
    const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: job.deliveryOrderId } });
    if (!isMultiStoreOrder(order)) return { skip: "pedido de uma loja só (estorno do pedido inteiro)" };
    if (!PAID_OR_IN_FULFILLMENT_STATUSES.includes(order.status)) return { skip: `pedido em ${order.status}` };
    if (input.storeCanceled) {
      if (job.status !== "completed" || job.storeOrderNumber !== input.storeCanceled.storeOrderNumber) return { skip: `compra desta loja em ${job.status}` };
    } else {
      if (job.storeOrderNumber || MONEY_MOVING.includes(job.status)) return { skip: `compra desta loja em ${job.status}` };
      if (await tx.pixPayout.findUnique({ where: { purchaseJobId: job.id } })) return { skip: "Pix de saída registrado; conciliar antes" };
    }
    const existing = await tx.purchaseAttempt.findUnique({ where: { purchaseJobId_idempotencyKey: { purchaseJobId: job.id, idempotencyKey: `store-refund:${job.id}` } } });
    if (existing) return { skip: "parte desta loja já devolvida" };
    const scope = storeScope(order, job.storeKey);
    if (!scope || scope.shareCents <= 0) return { skip: "pedido sem a parte da loja cotada" };
    await tx.purchaseAttempt.create({ data: {
      purchaseJobId: job.id, step: "store_refund", status: "started", idempotencyKey: `store-refund:${job.id}`,
      details: { amountCents: scope.shareCents, origin: input.origin, reason: (input.internalReason ?? input.reason).slice(0, 300) }
    } });
    // Fecha a compra desta loja antes do dinheiro voltar: nenhum comprador pega o trabalho no meio.
    await tx.purchaseJob.update({ where: { id: job.id }, data: {
      status: "canceled", lockedAt: null, claimToken: null, browserSessionId: null, nextAttemptAt: null,
      lastErrorCode: STORE_SHARE_REFUNDED, lastErrorMessage: `Parte da loja devolvida ao cliente: ${(input.internalReason ?? input.reason).slice(0, 300)}`
    } });
    if (job.submissionId && !input.storeCanceled) await tx.purchaseSpend.updateMany({ where: { submissionId: job.submissionId, status: "reserved" }, data: { status: "released", releasedAt: new Date(), releaseNote: "parte da loja devolvida ao cliente" } });
    return { order, job, scope, previous: { status: job.status, code: job.lastErrorCode, message: job.lastErrorMessage } };
  });
  if ("skip" in reservation) return { status: "skipped", reason: reservation.skip! };
  const { order, job, scope, previous } = reservation;
  let result;
  try {
    result = await refundOrderViaProvider(order.id, scope.shareCents / 100, { onlyJobId: job.id });
  } catch (error) {
    // Nada devolvido: desfaz a reserva e o trabalho volta como estava (a varredura tenta de novo).
    await prisma.$transaction([
      prisma.purchaseAttempt.deleteMany({ where: { purchaseJobId: job.id, idempotencyKey: `store-refund:${job.id}`, status: "started" } }),
      prisma.purchaseJob.update({ where: { id: job.id }, data: { status: previous.status, lastErrorCode: previous.code, lastErrorMessage: previous.message } })
    ]);
    throw error;
  }
  await prisma.purchaseAttempt.update({
    where: { purchaseJobId_idempotencyKey: { purchaseJobId: job.id, idempotencyKey: `store-refund:${job.id}` } },
    data: { status: "completed", completedAt: new Date(), details: { amountCents: scope.shareCents, origin: input.origin, reason: (input.internalReason ?? input.reason).slice(0, 300), reference: result.reference } }
  });

  // Status do pedido pelas lojas que seguem. Nenhuma segue: pedido estornado (só pode acontecer sem
  // nenhuma loja comprada, porque loja comprada nunca é devolvida por aqui).
  const closed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${order.id} FOR UPDATE`;
    const { syncMultiStoreStatus } = await import("../delivery-events");
    const synced = await syncMultiStoreStatus(tx, order.id);
    const note = `↩️ Parte da ${scope.storeLabel} devolvida ao cliente (R$ ${(scope.shareCents / 100).toFixed(2).replace(".", ",")}): ${(input.internalReason ?? input.reason).replace(/[\r\n]/g, " ").slice(0, 200)} — ${result.reference} (${new Date().toISOString()}).`;
    const current = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (!synced.stores.length) {
      await tx.deliveryOrder.update({ where: { id: order.id }, data: {
        status: "refunded",
        notes: appendOrderNote(appendOrderNote(current.notes, note), `${REFUND_CONFIRMED_PREFIX} integral — por loja (todas as lojas devolvidas)`)
      } });
      await tx.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { completedAt: new Date(), lockedAt: null } });
      return { closed: true, otherStores: [] as string[] };
    }
    await tx.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(current.notes, note) } });
    const labels = synced.stores.map((key) => orderItems(current.items).find((i) => i.storeKey === key)?.storeLabel ?? key);
    return { closed: false, otherStores: labels };
  });

  const { deliverNotice, notifyOwner, resetConversationForClosedOrder } = await import("../turn-runtime");
  const copy = await import("../lia-copy");
  if (closed.closed) {
    const fresh = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } });
    await resetConversationForClosedOrder(fresh, "refund").catch(() => undefined);
  }
  const items = scope.items.map((i) => (i.qty > 1 ? `${i.qty}x ${i.name}` : i.name));
  const delivered = await deliverNotice(order.phone, copy.storePartRefunded({ storeLabel: scope.storeLabel, items, amount: result.amount, reason: input.reason, otherStores: closed.otherStores }), { items: order.items }).catch(() => "failed" as const);
  if (delivered === "skipped") {
    const current = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id }, select: { notes: true } });
    await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(current.notes, "⚠️ Aviso da devolução da parte da loja NÃO enviado: cliente fora da janela de 24h e sem template. Avisar por outro canal.") } });
  }
  await notifyOwner(copy.operatorStoreShareRefunded(order.id.slice(-6).toUpperCase(), scope.storeLabel, result.amount, input.internalReason ?? input.reason, input.origin), order.phone).catch(() => undefined);
  return { status: "refunded", amount: result.amount, reference: result.reference, orderClosed: closed.closed };
}
