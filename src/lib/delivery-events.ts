// Uma etapa só avança com evidência explícita; prazo decorrido nunca é evidência.
import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";
import { appendOrderNote } from "./order-flags";
import { whatsappAdapter } from "./adapters/whatsapp";
import { outsideServiceWindow } from "./turn-runtime";
import * as copy from "./lia-copy";
import {
  aggregateOrderStatus, isMultiStoreOrder, MULTI_STORE_TRACKING_KEY, orderItems, orderStoreKeys, STORE_SHARE_REFUNDED,
  STORE_STAGE_RANK, storeEventKey, storeStageFromKeys, type StoreStage
} from "./purchase/store-split";

// 27/09: "shipped" = a loja despachou (transportadora/rota longa) — NÃO é "saiu pra entrega".
// "out_for_delivery" fica reservado para a última milha (entregador a caminho da casa).
export type DeliveryEventKind = "bought" | "shipped" | "out_for_delivery" | "delivered";
export type DeliveryEvidence = {
  kind: DeliveryEventKind;
  // mailbox_reader (11/09): e-mail transacional da loja lido na caixa operacional; vale
  // as mesmas guardas do leitor de página (loja + número exatos, nunca confirma compra).
  source: "operator" | "tracking_reader" | "mailbox_reader";
  sourceReference: string;
  occurredAt?: Date;
  storeOrderNumber?: string;
  storeKey?: string;
  trackingUrl?: string;
  // Código que o entregador pede na porta (Cobasi, 14/09: e-mail "Código de segurança para
  // recebimento"). Vai junto do aviso "saiu pra entrega"; nunca fica nas notas do pedido.
  deliveryCode?: string;
  purchaseExecution?: { jobId: string; submissionId: string; actualTotal: number };
  // Previsão que a PRÓPRIA loja informa ("até seg., 29/09"), só para o aviso de envio.
  etaText?: string;
};
const TARGET: Record<DeliveryEventKind, string> = {
  bought: "retailer_preparing", shipped: "retailer_out_for_delivery", out_for_delivery: "retailer_out_for_delivery", delivered: "delivered"
};

export function validateTrackingUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("O rastreio precisa ser uma URL https sem credenciais.");
  return url.toString();
}

export async function recordDeliveryEvent(orderId: string, evidence: DeliveryEvidence) {
  // Pedido de várias lojas (09/10): cada loja anda sozinha (comprado, enviado, saiu, entregue).
  const head = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { items: true } });
  if (head && isMultiStoreOrder(head)) return recordMultiStoreEvent(orderId, evidence);
  const reference = evidence.sourceReference.trim();
  if (!reference || reference.length > 300) throw new Error("Informe a referência da evidência da loja.");
  const occurredAt = evidence.occurredAt ?? new Date();
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60_000) throw new Error("Data da evidência inválida.");
  const tracking = validateTrackingUrl(evidence.trackingUrl);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (evidence.purchaseExecution) {
      const proof = evidence.purchaseExecution;
      const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: proof.jobId } });
      if (job.deliveryOrderId !== order.id || job.submissionId !== proof.submissionId || !["submitting", "outcome_unknown", "completed", "awaiting_owner_confirm", "awaiting_store_number", "pix_paid", "store_confirmed"].includes(job.status)) throw new Error("Tentativa de compra incompatível.");
      if (job.status === "completed" && job.storeOrderNumber !== evidence.storeOrderNumber?.trim()) throw new Error("Comprovante duplicado com número diferente.");
    }
    // O leitor não pode associar pedidos por nome, telefone ou produto parecido.
    if (evidence.source === "tracking_reader" || evidence.source === "mailbox_reader") {
      if (evidence.kind === "bought") throw new Error("O leitor de rastreio não confirma compras.");
      const stores = new Set((Array.isArray(order.items) ? order.items : []).flatMap((i) =>
        i && typeof i === "object" && !Array.isArray(i) && typeof i.storeKey === "string" ? [i.storeKey] : []));
      if (stores.size > 1 || (Array.isArray(order.fulfillments) && order.fulfillments.length > 1)) {
        throw new Error("Cesta com múltiplas entregas exige acompanhamento por pacote; revisar no /ops.");
      }
      const actualStore = stores.size === 1 ? [...stores][0] : order.storeKey;
      if (!order.storeOrderNumber || evidence.storeOrderNumber !== order.storeOrderNumber || evidence.storeKey !== actualStore) {
        throw new Error("A evidência não corresponde ao pedido e à loja registrados.");
      }
    }
    if (evidence.kind === "bought" && order.storeOrderNumber && evidence.storeOrderNumber?.trim() !== order.storeOrderNumber) {
      throw new Error("Já existe outro número de compra registrado para este pedido.");
    }
    const key = `${order.id}:${evidence.kind}`;
    const existing = await tx.deliveryEvent.findUnique({ where: { dedupeKey: key } });
    if (existing) {
      // Dois registros concorrentes da mesma compra podem chegar com/sem rastreio.
      // Completar um campo ausente não gera outro evento nem sobrescreve link mais novo.
      const reconciled = tracking && !order.courierTrackingUrl
        ? await tx.deliveryOrder.update({ where: { id: order.id }, data: { courierTrackingUrl: tracking } }) : order;
      if(tracking && !order.courierTrackingUrl) await tx.trackingSubscription.updateMany({where:{deliveryOrderId:order.id},data:{trackingUrl:tracking}});
      return { order: reconciled, eventId: existing.id };
    }
    // Última milha depois de um "enviado": o status já é retailer_out_for_delivery, mas o
    // cliente ainda não ouviu "saiu pra entrega" — esse aviso precisa sair.
    const lastMileAfterShipped = evidence.kind === "out_for_delivery" && order.status === "retailer_out_for_delivery" &&
      Boolean(await tx.deliveryEvent.findUnique({ where: { dedupeKey: `${order.id}:shipped` } }));
    if (order.status === TARGET[evidence.kind] && !lastMileAfterShipped) return { order, eventId: null };
    const allowed = evidence.kind === "bought" ? ["paid"] : evidence.kind === "shipped"
      ? ["retailer_preparing", "operator_buying"]
      : evidence.kind === "out_for_delivery"
      ? ["retailer_preparing", "operator_buying", ...(lastMileAfterShipped ? ["retailer_out_for_delivery"] : [])]
      : evidence.source !== "operator" ? ["retailer_preparing", "retailer_out_for_delivery"] : ["retailer_out_for_delivery", "dispatched"];
    if (!allowed.includes(order.status)) throw new Error("Etapa incompatível com o estado atual do pedido.");
    if (order.paidAt && occurredAt < order.paidAt) throw new Error("Evidência anterior ao pagamento do pedido.");
    const last = await tx.deliveryEvent.findFirst({ where: { deliveryOrderId: order.id }, orderBy: { occurredAt: "desc" } });
    if (last && occurredAt < last.occurredAt) throw new Error("Evidência antiga; o pedido já tem atualização mais recente.");
    const number = evidence.storeOrderNumber?.trim() || order.storeOrderNumber;
    if (evidence.kind === "bought" && !number) throw new Error("Informe o número da compra na loja.");
    const updated = await tx.deliveryOrder.update({ where: { id: order.id }, data: {
      status: TARGET[evidence.kind],
      ...(evidence.kind === "bought" ? { storeOrderNumber: number } : {}),
      ...(tracking ? { courierTrackingUrl: tracking } : {}),
      ...((evidence.kind === "out_for_delivery" || evidence.kind === "shipped") && !order.courierDispatchedAt ? { courierDispatchedAt: occurredAt } : {}),
      ...(evidence.kind === "delivered" ? { deliveredAt: occurredAt } : {}),
      notes: appendOrderNote(order.notes, `🧾 ${evidence.kind} — ${evidence.source}: ${reference.replace(/[\r\n]/g, " ")} (${occurredAt.toISOString()}).`)
    } });
    if (evidence.kind === "bought") {
      await tx.purchaseJob.updateMany({ where: { deliveryOrderId: order.id, status: { in: ["queued", "retrying", "claimed", "needs_review", "awaiting_approval", "approved", "submitting", "outcome_unknown", "manual_queue", "awaiting_owner_confirm", "awaiting_store_number", "pix_paid", "store_confirmed"] } },
        data: { status: "completed", storeOrderNumber: number, lockedAt: null, nextAttemptAt: null, completedAt: new Date() } });
    }
    if (evidence.kind === "bought") {
      if (evidence.purchaseExecution) {
        await tx.purchaseJob.update({ where: { id: evidence.purchaseExecution.jobId }, data: { status: "completed", actualTotal: evidence.purchaseExecution.actualTotal, storeOrderNumber: number, completedAt: new Date(), lockedAt: null } });
        await tx.purchaseAttempt.updateMany({ where: { purchaseJobId: evidence.purchaseExecution.jobId, idempotencyKey: evidence.purchaseExecution.submissionId }, data: { status: "completed", completedAt: new Date() } });
      }
      const stores = new Set((Array.isArray(order.items) ? order.items : []).flatMap(i => i && typeof i === "object" && !Array.isArray(i) && typeof i.storeKey === "string" ? [i.storeKey] : []));
      if (stores.size === 1 && number && (!Array.isArray(order.fulfillments) || order.fulfillments.length <= 1)) {
        await tx.trackingSubscription.upsert({ where: { deliveryOrderId: order.id }, create: { deliveryOrderId: order.id, storeKey: [...stores][0], storeOrderNumber: number, trackingUrl: updated.courierTrackingUrl }, update: { trackingUrl: updated.courierTrackingUrl } });
      }
    }
    if (evidence.kind === "delivered") await tx.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { completedAt: new Date(), lockedAt: null } });
    const shortId = order.id.slice(-6).toUpperCase();
    const text = evidence.kind === "bought" ? copy.orderStatusLine({ shortId, status: updated.status, trackingUrl: updated.courierTrackingUrl })
      : evidence.kind === "shipped"
        ? copy.retailerShipped(updated.courierTrackingUrl, evidence.etaText)
      : evidence.kind === "out_for_delivery"
        ? `${copy.retailerOutForDelivery(updated.courierTrackingUrl)}${evidence.deliveryCode ? `\n${copy.deliveryCode(evidence.deliveryCode)}` : ""}`
        : copy.delivered();
    const event = await tx.deliveryEvent.create({ data: {
      deliveryOrderId: order.id, dedupeKey: key, kind: evidence.kind, source: evidence.source,
      sourceReference: reference, occurredAt, message: text
    } });
    return { order: updated, eventId: event.id };
  });
  // A transação já terminou: rede não segura o lock do pedido e falha não desfaz a etapa.
  if (result.eventId) await dispatchDeliveryEvent(result.eventId).catch((error) => {
    console.warn("[delivery-event:dispatch]", result.eventId, error instanceof Error ? error.message : "failed");
  });
  return result.order;
}

// ---------- pedido de várias lojas (09/10) ----------
// Um evento por loja (dedupe `${pedido}:${loja}:${etapa}`), um aviso por loja com o nome dela, e o
// status do pedido é o da loja mais atrasada entre as que seguem (as devolvidas não contam). A 1ª
// compra grava o número no pedido (as travas de "já comprado" seguem valendo para o pedido inteiro:
// nada de estorno integral nem desistência depois que uma loja comprou).
function activeStores(order: { items: unknown }, jobs: Array<{ storeKey: string; status: string; lastErrorCode: string | null }>): string[] {
  return orderStoreKeys(order.items).filter((storeKey) => !jobs.some((job) => job.storeKey === storeKey && job.status === "canceled" && job.lastErrorCode === STORE_SHARE_REFUNDED));
}

// Recalcula o status do pedido pelas lojas que seguem. Só anda pra frente.
export async function syncMultiStoreStatus(tx: Prisma.TransactionClient, orderId: string, occurredAt = new Date()) {
  const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
  const jobs = await tx.purchaseJob.findMany({ where: { deliveryOrderId: orderId }, select: { storeKey: true, status: true, lastErrorCode: true } });
  const events = await tx.deliveryEvent.findMany({ where: { deliveryOrderId: orderId }, select: { dedupeKey: true } });
  const keys = events.map((e) => e.dedupeKey);
  const stores = activeStores(order, jobs);
  const stages = stores.map((storeKey) => storeStageFromKeys(orderId, storeKey, keys));
  const target = aggregateOrderStatus(stages);
  const progress = ["paid", "retailer_preparing", "retailer_out_for_delivery", "delivered"];
  if (!target || !progress.includes(order.status) || progress.indexOf(target) <= progress.indexOf(order.status)) return { order, stores, stages };
  const updated = await tx.deliveryOrder.update({ where: { id: orderId }, data: {
    status: target,
    ...(target !== "paid" && target !== "retailer_preparing" && !order.courierDispatchedAt ? { courierDispatchedAt: occurredAt } : {}),
    ...(target === "delivered" ? { deliveredAt: occurredAt } : {})
  } });
  if (target === "delivered") await tx.trackingSubscription.updateMany({ where: { deliveryOrderId: orderId }, data: { completedAt: new Date(), lockedAt: null } });
  return { order: updated, stores, stages };
}

async function recordMultiStoreEvent(orderId: string, evidence: DeliveryEvidence) {
  const reference = evidence.sourceReference.trim();
  if (!reference || reference.length > 300) throw new Error("Informe a referência da evidência da loja.");
  const occurredAt = evidence.occurredAt ?? new Date();
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60_000) throw new Error("Data da evidência inválida.");
  const tracking = validateTrackingUrl(evidence.trackingUrl);
  // A loja do evento: a do trabalho de compra, a que o leitor informou ou — passo do operador sem
  // loja (ex.: "entregue" no /ops) — todas as lojas compradas que ainda não chegaram nessa etapa.
  let storeKeys: string[];
  if (evidence.purchaseExecution) {
    storeKeys = [(await prisma.purchaseJob.findUniqueOrThrow({ where: { id: evidence.purchaseExecution.jobId } })).storeKey];
  } else if (evidence.storeKey) {
    storeKeys = [evidence.storeKey];
  } else {
    if (evidence.kind === "bought") throw new Error("Pedido com várias lojas: registre a compra de cada loja no trabalho de compra dela.");
    if (evidence.source !== "operator") throw new Error("Cesta com múltiplas entregas exige acompanhamento por pacote; revisar no /ops.");
    storeKeys = orderStoreKeys((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: orderId }, select: { items: true } })).items);
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (!["paid", "retailer_preparing", "retailer_out_for_delivery", "delivered"].includes(order.status)) throw new Error("Etapa incompatível com o estado atual do pedido.");
    if (order.paidAt && occurredAt < order.paidAt) throw new Error("Evidência anterior ao pagamento do pedido.");
    const jobs = await tx.purchaseJob.findMany({ where: { deliveryOrderId: order.id }, orderBy: { createdAt: "desc" } });
    const keys = (await tx.deliveryEvent.findMany({ where: { deliveryOrderId: order.id }, select: { dedupeKey: true } })).map((e) => e.dedupeKey);
    const active = activeStores(order, jobs);
    const created: string[] = [];
    for (const storeKey of storeKeys) {
      if (!active.includes(storeKey)) {
        if (storeKeys.length === 1) throw new Error("A parte desta loja já foi devolvida ao cliente.");
        continue;
      }
      const job = jobs.find((j) => j.storeKey === storeKey);
      const stage = storeStageFromKeys(order.id, storeKey, keys);
      const key = storeEventKey(order.id, storeKey, evidence.kind);
      if (keys.includes(key)) continue;
      if (evidence.purchaseExecution) {
        const proof = evidence.purchaseExecution;
        if (!job || job.id !== proof.jobId || job.submissionId !== proof.submissionId || !["submitting", "outcome_unknown", "completed", "awaiting_owner_confirm", "awaiting_store_number", "pix_paid", "store_confirmed"].includes(job.status)) throw new Error("Tentativa de compra incompatível.");
        if (job.status === "completed" && job.storeOrderNumber !== evidence.storeOrderNumber?.trim()) throw new Error("Comprovante duplicado com número diferente.");
      }
      if (evidence.source === "tracking_reader" || evidence.source === "mailbox_reader") {
        if (evidence.kind === "bought") throw new Error("O leitor de rastreio não confirma compras.");
        if (!job?.storeOrderNumber || evidence.storeOrderNumber !== job.storeOrderNumber) throw new Error("Cesta com múltiplas lojas: a evidência não corresponde à compra registrada desta loja.");
      }
      const rank = STORE_STAGE_RANK[evidence.kind as StoreStage];
      if (evidence.kind === "bought") {
        if (stage !== "paid" || order.status !== "paid") throw new Error("Etapa incompatível com o estado atual do pedido.");
      } else if (stage === "paid") {
        if (storeKeys.length === 1) throw new Error("Etapa incompatível com o estado atual do pedido.");
        continue;
      } else if (rank <= STORE_STAGE_RANK[stage]) {
        continue;
      }
      const number = evidence.kind === "bought" ? evidence.storeOrderNumber?.trim() : job?.storeOrderNumber ?? undefined;
      if (evidence.kind === "bought" && !number) throw new Error("Informe o número da compra na loja.");
      const storeLabel = orderItems(order.items).find((i) => i.storeKey === storeKey)?.storeLabel ?? storeKey;
      if (evidence.kind === "bought") {
        if (job) {
          await tx.purchaseJob.update({ where: { id: job.id }, data: {
            status: "completed", storeOrderNumber: number, lockedAt: null, nextAttemptAt: null, completedAt: new Date(),
            ...(evidence.purchaseExecution ? { actualTotal: evidence.purchaseExecution.actualTotal } : {})
          } });
          if (evidence.purchaseExecution) await tx.purchaseAttempt.updateMany({ where: { purchaseJobId: job.id, idempotencyKey: evidence.purchaseExecution.submissionId }, data: { status: "completed", completedAt: new Date() } });
        }
        await tx.trackingSubscription.upsert({
          where: { deliveryOrderId: order.id },
          create: { deliveryOrderId: order.id, storeKey: MULTI_STORE_TRACKING_KEY, storeOrderNumber: number!, ...(tracking ? { trackingUrl: tracking } : {}) },
          update: { completedAt: null, nextCheckAt: new Date() }
        });
      }
      const stagesAfter = active.map((s) => (s === storeKey ? (evidence.kind as StoreStage) : storeStageFromKeys(order.id, s, keys)));
      const labelOf = (s: string) => orderItems(order.items).find((i) => i.storeKey === s)?.storeLabel ?? s;
      const text = evidence.kind === "bought"
        ? copy.storePartBought({
            storeLabel,
            items: orderItems(order.items).filter((i) => i.storeKey === storeKey).map((i) => (i.qty > 1 ? `${i.qty}x ${i.name}` : i.name)),
            waitingStores: active.filter((s, i) => stagesAfter[i] === "paid").map(labelOf),
            trackingUrl: tracking
          })
        : evidence.kind === "shipped"
          ? copy.storePartShipped(storeLabel, tracking, evidence.etaText)
          : evidence.kind === "out_for_delivery"
            ? `${copy.storePartOutForDelivery(storeLabel, tracking)}${evidence.deliveryCode ? `\n${copy.deliveryCode(evidence.deliveryCode)}` : ""}`
            : copy.storePartDelivered(storeLabel, active.filter((s, i) => stagesAfter[i] !== "delivered").map(labelOf));
      const event = await tx.deliveryEvent.create({ data: {
        deliveryOrderId: order.id, dedupeKey: key, kind: evidence.kind, source: evidence.source,
        sourceReference: reference, occurredAt, message: text
      } });
      keys.push(key);
      created.push(event.id);
      await tx.deliveryOrder.update({ where: { id: order.id }, data: {
        ...(evidence.kind === "bought" && !order.storeOrderNumber ? { storeOrderNumber: number } : {}),
        notes: appendOrderNote((await tx.deliveryOrder.findUniqueOrThrow({ where: { id: order.id }, select: { notes: true } })).notes, `🧾 ${evidence.kind} (${storeLabel}${number ? ` nº ${number}` : ""}) — ${evidence.source}: ${reference.replace(/[\r\n]/g, " ")} (${occurredAt.toISOString()}).`)
      } });
      if (evidence.kind === "bought" && !order.storeOrderNumber) order.storeOrderNumber = number!;
    }
    const synced = await syncMultiStoreStatus(tx, order.id, occurredAt);
    return { order: synced.order, eventIds: created };
  });
  for (const id of result.eventIds) {
    await dispatchDeliveryEvent(id).catch((error) => {
      console.warn("[delivery-event:dispatch]", id, error instanceof Error ? error.message : "failed");
    });
  }
  return result.order;
}

function messageIdFrom(result: unknown): string | undefined {
  const value = result as { payload?: unknown; messages?: Array<{ id?: string }> } | undefined;
  if (value?.payload) return messageIdFrom(value.payload);
  return value?.messages?.[0]?.id;
}

export async function dispatchDeliveryEvent(id: string) {
  const now = new Date();
  const event = await prisma.deliveryEvent.findUniqueOrThrow({ where: { id }, include: { deliveryOrder: { select: { phone: true, status: true, items: true } } } });
  if (event.deliveryStatus !== "pending" || (event.nextAttemptAt && event.nextAttemptAt > now)) return;
  // Não mandar "saiu" atrasado depois de "entregue", nem "comprado" depois de estorno.
  const obsolete = ["canceled", "refunded", "refund_pending"].includes(event.deliveryOrder.status) ||
    (event.kind !== "delivered" && event.deliveryOrder.status === "delivered") ||
    (event.kind === "bought" && event.deliveryOrder.status === "retailer_out_for_delivery");
  if (obsolete) {
    await prisma.deliveryEvent.updateMany({ where: { id, deliveryStatus: "pending" }, data: { deliveryStatus: "suppressed", lastError: "Pedido avançou; aviso antigo suprimido." } });
    return;
  }
  const outside = await outsideServiceWindow(event.deliveryOrder.phone);
  const template = process.env.LIA_TEMPLATE_ORDER_UPDATE?.trim();
  if (outside && !template) {
    await prisma.deliveryEvent.updateMany({ where: { id, deliveryStatus: "pending" }, data: { lastError: "Fora da janela de 24h e sem template aprovado", nextAttemptAt: new Date(Date.now() + 10 * 60_000) } });
    return;
  }
  const claimed = await prisma.deliveryEvent.updateMany({ where: { id, deliveryStatus: "pending" }, data: { deliveryStatus: "sending", attempts: { increment: 1 }, lockedAt: now, nextAttemptAt: null } });
  if (!claimed.count) return;
  try {
    const result = outside
      ? await whatsappAdapter.sendTemplateMessage(event.deliveryOrder.phone, { name: template!, bodyParams: [copy.orderTemplateLabel(event.deliveryOrder.items), event.message] }, id)
      : await whatsappAdapter.sendMessage(event.deliveryOrder.phone, event.message, { noticeId: id });
    const providerMessageId = messageIdFrom(result);
    if (process.env.WHATSAPP_PROVIDER === "meta" && !providerMessageId) throw new Error("Meta não devolveu o id da mensagem");
    await prisma.deliveryEvent.updateMany({ where: { id, deliveryStatus: "sending" }, data: {
      deliveryStatus: "accepted", providerMessageId: providerMessageId ?? null, lockedAt: null, lastError: null
    } });
  } catch (error) {
    // Não repetir um envio cuja aceitação é desconhecida. Recibo por callback ainda
    // pode reconciliar; sem recibo, a pendência fica visível para revisão.
    await prisma.deliveryEvent.updateMany({ where: { id, deliveryStatus: "sending" }, data: {
      deliveryStatus: "unknown", lockedAt: null, lastError: error instanceof Error ? error.message.slice(0, 300) : "Resultado do envio desconhecido"
    } });
  }
}

export async function recordDeliveryReceipt(input: { id?: unknown; status?: unknown; biz_opaque_callback_data?: unknown; timestamp?: unknown; errors?: unknown }) {
  if (typeof input.id !== "string" || !["sent", "delivered", "read", "failed"].includes(String(input.status))) return;
  const callbackId = typeof input.biz_opaque_callback_data === "string" ? input.biz_opaque_callback_data : undefined;
  const event = await prisma.deliveryEvent.findFirst({ where: { OR: [
    { providerMessageId: input.id }, ...(callbackId ? [{ id: callbackId }] : [])
  ] } });
  if (!event) return;
  if (event.providerMessageId && event.providerMessageId !== input.id) return;
  // Recibo atrasado de falha/sent jamais apaga delivered/read.
  const allowed = input.status === "read" ? ["sending", "unknown", "accepted", "delivered", "failed"]
    : input.status === "delivered" ? ["sending", "unknown", "accepted", "failed"] : ["sending", "unknown", "accepted"];
  const timestamp = Number(input.timestamp) * 1000;
  await prisma.deliveryEvent.updateMany({ where: { id: event.id, deliveryStatus: { in: allowed } }, data: {
    providerMessageId: input.id, deliveryStatus: input.status === "sent" ? "accepted" : String(input.status),
    receiptAt: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date(), lockedAt: null,
    lastError: input.status === "failed" ? JSON.stringify(input.errors ?? "Meta recusou o envio").slice(0, 300) : null
  } });
}

export async function flushDeliveryEvents() {
  await prisma.deliveryEvent.updateMany({ where: { deliveryStatus: "sending", lockedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
    data: { deliveryStatus: "unknown", lastError: "Executor interrompido durante o envio; aguardar recibo ou revisar.", lockedAt: null } });
  const rows = await prisma.deliveryEvent.findMany({ where: { deliveryStatus: "pending", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: "asc" }, take: 20, select: { id: true } });
  // Lotes de quatro limitam pressão na Meta e cabem no orçamento do cron.
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.allSettled(rows.slice(i, i + 4).map((row) => dispatchDeliveryEvent(row.id)));
  }
  return rows.length;
}
