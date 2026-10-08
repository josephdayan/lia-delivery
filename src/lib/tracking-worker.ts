import { randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma";
import { recordDeliveryEvent } from "./delivery-events";
import { trackingPageAllowed, explicitTrackingStatus } from "./tracking-policy";
export { trackingPageAllowed, explicitTrackingStatus } from "./tracking-policy";
export function trackingWorkerAuthorized(request: Request) {
  const expected = process.env.LIA_TRACKING_WORKER_TOKEN?.trim();
  const supplied = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected),
    b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Pedidos já comprados antes da migration também entram no acompanhamento.
async function backfillTrackingSubscriptions(stores: string[]) {
  let cursor: string | undefined;
  for (;;) {
    const orders = await prisma.deliveryOrder.findMany({
      where: {
        status: { in: ["retailer_preparing", "retailer_out_for_delivery"] },
        storeOrderNumber: { not: null },
        trackingSubscription: { is: null },
      },
      orderBy: { id: "asc" },
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        items: true,
        fulfillments: true,
        storeOrderNumber: true,
        courierTrackingUrl: true,
      },
    });
    for (const order of orders) {
      const keys = new Set(
        (Array.isArray(order.items) ? order.items : []).flatMap((i) =>
          i &&
          typeof i === "object" &&
          !Array.isArray(i) &&
          typeof i.storeKey === "string"
            ? [i.storeKey]
            : [],
        ),
      );
      if (
        keys.size !== 1 ||
        !stores.includes([...keys][0]) ||
        (Array.isArray(order.fulfillments) && order.fulfillments.length > 1) ||
        !order.storeOrderNumber?.trim()
      )
        continue;
      await prisma.trackingSubscription.upsert({
        where: { deliveryOrderId: order.id },
        create: {
          deliveryOrderId: order.id,
          storeKey: [...keys][0],
          storeOrderNumber: order.storeOrderNumber,
          trackingUrl: order.courierTrackingUrl,
        },
        update: {},
      });
    }
    if (orders.length < 50) return;
    cursor = orders[orders.length - 1].id;
  }
}
export async function claimTracking(workerId: string, stores: string[]) {
  await backfillTrackingSubscriptions(stores);
  const now = new Date();
  const candidates = await prisma.trackingSubscription.findMany({
    where: {
      storeKey: { in: stores },
      completedAt: null,
      nextCheckAt: { lte: now },
      OR: [
        { lockedAt: null },
        { lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      ],
      deliveryOrder: {
        status: { in: ["retailer_preparing", "retailer_out_for_delivery"] },
        purchaseJobs: {
          none: {
            status: {
              in: ["claimed", "submitting"],
            },
          },
        },
      },
    },
    orderBy: { nextCheckAt: "asc" },
    take: 10,
  });
  for (const row of candidates) {
    const token = randomUUID();
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase-account:${row.storeKey}`}))::text`;
      const busy = await tx.purchaseJob.findFirst({
        where: {
          storeKey: row.storeKey,
          OR: [
            {
              status: { in: ["awaiting_approval", "approved"] },
              lockedAt: { not: null },
            },
            {
              status: {
                in: ["claimed", "submitting", "outcome_unknown"],
              },
            },
            { status: "needs_review", lockedAt: { not: null } },
          ],
        },
      });
      const reading = await tx.trackingSubscription.findFirst({
        where: {
          storeKey: row.storeKey,
          lockedAt: { gt: new Date(Date.now() - 5 * 60_000) },
        },
      });
      if (busy || reading) return { count: 0 };
      return tx.trackingSubscription.updateMany({
        where: {
          id: row.id,
          nextCheckAt: row.nextCheckAt,
          OR: [
            { lockedAt: null },
            { lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        data: { workerId, claimToken: token, lockedAt: now },
      });
    });
    if (claimed.count)
      return {
        id: row.id,
        storeKey: row.storeKey,
        storeOrderNumber: row.storeOrderNumber,
        trackingUrl: row.trackingUrl,
        claimToken: token,
      };
  }
  return null;
}
// E-mail transacional da loja (Fase 4): o leitor local já classificou (mailbox-policy) e
// manda só o veredito. Correlação exclusivamente por loja + número exato; e-mail repetido é
// inofensivo (dedupe por pedido:etapa). "Criado/pago" fecha a etapa do Pix da loja.
export async function reportMail(input: {
  storeKey: string;
  storeOrderNumber: string;
  kind: "created" | "paid" | "invoiced" | "shipped" | "out_for_delivery" | "delivered" | "canceled" | "delivery_code";
  messageId: string;
  receivedAt: string;
  trackingUrl?: string;
  deliveryCode?: string;
  // Link da NF no e-mail de faturamento (29/09): vai ao cliente quando a compra saiu no CPF dele.
  invoiceUrl?: string;
}) {
  const number = input.storeOrderNumber.trim();
  const receivedAtCode = new Date(input.receivedAt);
  if (!Number.isFinite(receivedAtCode.getTime())) throw new Error("Data do e-mail inválida.");
  // Código de recebimento (Cobasi, 14/09): o e-mail não traz número. Só entrega ao cliente
  // quando há exatamente UM pedido da loja em andamento nos últimos 7 dias; senão, o operador
  // decide. O código nunca vai para as notas do pedido.
  if (input.kind === "delivery_code") {
    const code = input.deliveryCode?.trim();
    if (!code) return { matched: false as const, reason: "sem código" };
    const candidates = await prisma.deliveryOrder.findMany({
      where: {
        status: { in: ["retailer_preparing", "retailer_out_for_delivery"] },
        updatedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        ...(number ? { storeOrderNumber: number } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    const ofStore = candidates.filter((o) => {
      const stores = new Set((Array.isArray(o.items) ? o.items : []).flatMap((i) =>
        i && typeof i === "object" && !Array.isArray(i) && typeof (i as { storeKey?: unknown }).storeKey === "string" ? [(i as { storeKey: string }).storeKey] : []));
      return (stores.size === 1 ? [...stores][0] : o.storeKey) === input.storeKey;
    });
    const { notifyOperator } = await import("./turn-runtime");
    if (ofStore.length !== 1) {
      await notifyOperator(`🔐 ${input.storeKey}: chegou um código de recebimento (${code}) por e-mail e ${ofStore.length === 0 ? "não achei pedido em andamento dessa loja" : `há ${ofStore.length} pedidos em andamento dessa loja`}. Mande o código pro cliente certo pelo /ops.`);
      return { matched: false as const, reason: ofStore.length === 0 ? "pedido não encontrado" : "pedidos ambíguos" };
    }
    const order = ofStore[0];
    if (!order.storeOrderNumber) return { matched: false as const, reason: "pedido sem número da loja" };
    if (order.status === "retailer_preparing") {
      // O pedido foi escolhido por exclusão (único da loja em andamento); a guarda do evento
      // continua exigindo loja + número exatos, então passamos os do próprio pedido.
      await recordDeliveryEvent(order.id, {
        kind: "out_for_delivery", source: "mailbox_reader", sourceReference: `mail:${input.messageId}`.slice(0, 300),
        occurredAt: receivedAtCode, storeKey: input.storeKey, storeOrderNumber: order.storeOrderNumber, deliveryCode: code,
      });
    } else {
      // Já estava "saiu pra entrega": manda só o código, sem evento novo.
      const { whatsappAdapter } = await import("./adapters/whatsapp");
      const { deliveryCode } = await import("./lia-copy");
      await whatsappAdapter.sendMessage(order.phone, `Pedido #${order.id.slice(-6).toUpperCase()}: ${deliveryCode(code)}`);
    }
    return { matched: true as const, orderId: order.id, kind: input.kind };
  }
  const order = await prisma.deliveryOrder.findFirst({
    where: { storeOrderNumber: number, status: { in: ["retailer_preparing", "retailer_out_for_delivery"] } },
    orderBy: { updatedAt: "desc" },
  });
  const job = order ? null : await prisma.purchaseJob.findFirst({ where: { storeKey: input.storeKey, storeOrderNumber: number } });
  const receivedAt = new Date(input.receivedAt);
  if (!Number.isFinite(receivedAt.getTime())) throw new Error("Data do e-mail inválida.");
  if (input.kind === "shipped" || input.kind === "out_for_delivery" || input.kind === "delivered") {
    if (!order) return { matched: false as const, reason: "pedido não encontrado" };
    const stores = new Set((Array.isArray(order.items) ? order.items : []).flatMap((i) =>
      i && typeof i === "object" && !Array.isArray(i) && typeof (i as { storeKey?: unknown }).storeKey === "string" ? [(i as { storeKey: string }).storeKey] : []));
    const actualStore = stores.size === 1 ? [...stores][0] : order.storeKey;
    if (actualStore !== input.storeKey) return { matched: false as const, reason: "loja não confere" };
    await recordDeliveryEvent(order.id, {
      kind: input.kind, source: "mailbox_reader", sourceReference: `mail:${input.messageId}`.slice(0, 300),
      occurredAt: receivedAt, storeKey: input.storeKey, storeOrderNumber: number, trackingUrl: input.trackingUrl,
    });
    return { matched: true as const, orderId: order.id, kind: input.kind };
  }
  // Etapas sem aviso ao cliente: fecham o Pix da loja (store_confirmed) ou viram nota.
  const target = order ?? (job ? await prisma.deliveryOrder.findUnique({ where: { id: job.deliveryOrderId } }) : null);
  if (!target) return { matched: false as const, reason: "pedido não encontrado" };
  if (input.kind === "created" || input.kind === "paid") {
    await prisma.purchaseJob.updateMany({ where: { deliveryOrderId: target.id, status: { in: ["pix_paid"] } }, data: { status: "store_confirmed", storeOrderNumber: number } });
  }
  const { appendOrderNote } = await import("./order-flags");
  let invoiceNote = "";
  // Compra no CPF do cliente (remédio desde 29/09; tudo desde 08/10): a nota é DELE — a Lia
  // encaminha o link (ou avisa que saiu, quando o e-mail não traz link).
  if (input.kind === "invoiced" && target.buyerDocument) {
    const { deliverNotice } = await import("./turn-runtime");
    const { medicineInvoiceNotice } = await import("./lia-copy");
    const { VTEX_API_STORES } = await import("./purchase/vtex-checkout");
    const storeLabel = job?.storeLabel ?? VTEX_API_STORES[input.storeKey]?.label ?? "loja";
    const shortId = target.id.slice(-6).toUpperCase();
    const sent = await deliverNotice(target.phone, medicineInvoiceNotice(shortId, storeLabel, input.invoiceUrl), { shortId }).catch(() => "skipped" as const);
    invoiceNote = sent === "skipped" ? " ⚠️ Nota do cliente NÃO enviada (fora da janela sem template) — encaminhe pelo /ops." : ` 🧾 Nota encaminhada ao cliente (${sent}${input.invoiceUrl ? ", com link" : ", sem link"}).`;
  }
  await prisma.deliveryOrder.update({ where: { id: target.id }, data: { notes: appendOrderNote(target.notes, `📧 ${input.kind} — e-mail da loja ${number} (${receivedAt.toISOString()}).${invoiceNote}`) } });
  return { matched: true as const, orderId: target.id, kind: input.kind };
}
export async function reportTracking(
  id: string,
  workerId: string,
  token: string,
  input: {
    pageUrl?: string;
    storeOrderNumber?: string;
    statusText?: string;
    observedAt?: string;
    wholeOrder?: boolean;
    error?: string;
  },
) {
  const row = await prisma.trackingSubscription.findUniqueOrThrow({
    where: { id },
  });
  if (
    row.workerId !== workerId ||
    !token ||
    row.claimToken !== token ||
    !row.lockedAt ||
    row.lockedAt.getTime() < Date.now() - 5 * 60_000
  )
    throw new Error("Consulta vencida ou de outro leitor.");
  let issue = input.error;
  const kind = explicitTrackingStatus(input.statusText ?? "");
  if (!issue) {
    const age = Date.now() - Date.parse(input.observedAt ?? "");
    if (
      !input.pageUrl ||
      !trackingPageAllowed(row.storeKey, input.pageUrl, row.trackingUrl) ||
      input.storeOrderNumber !== row.storeOrderNumber ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > 120_000
    )
      issue = "Página, número ou horário não confere com o pedido.";
    else if (kind && !input.wholeOrder)
      issue = "Status de um pacote não confirma o pedido inteiro.";
    else if (kind)
      await recordDeliveryEvent(row.deliveryOrderId, {
        kind,
        source: "tracking_reader",
        sourceReference: input.pageUrl,
        occurredAt: new Date(input.observedAt!),
        storeKey: row.storeKey,
        storeOrderNumber: row.storeOrderNumber,
      });
  }
  const delay = issue ? Math.min(60, 5 * 2 ** Math.min(row.failures, 4)) : 2;
  await prisma.trackingSubscription.updateMany({
    where: { id, claimToken: token },
    data: {
      lockedAt: null,
      claimToken: null,
      workerId: null,
      lastCheckedAt: new Date(),
      lastError: issue?.slice(0, 200) ?? null,
      failures: issue ? { increment: 1 } : 0,
      nextCheckAt: new Date(Date.now() + delay * 60_000),
    },
  });
  return { ok: !issue, changed: Boolean(kind && !issue) };
}
