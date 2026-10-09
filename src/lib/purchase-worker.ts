import { preparationStores, purchaseUrlAllowed } from "./purchase-preparation";
import { customerInvoiceEnabled } from "./pricing";
import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { isRetailerDeliveryOrder } from "@/lib/order-flags";
import { hasCancelRequest, hasPendingRefund } from "@/lib/order-flags";

type OrderItem = {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal?: number;
  storeKey: string;
  storeLabel: string;
  productUrl?: string;
};

const CLAIMABLE = ["queued", "retrying"];

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function leaseMs(): number {
  const configured = Number(process.env.LIA_PURCHASE_WORKER_LEASE_MS ?? 15 * 60_000);
  return Number.isFinite(configured) ? Math.max(60_000, Math.min(60 * 60_000, configured)) : 15 * 60_000;
}

function busyHorizonMs(): number {
  const hours = Number(process.env.LIA_PURCHASE_BUSY_HOURS ?? 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}
function retryMs(): number {
  const configured = Number(process.env.LIA_PURCHASE_WORKER_RETRY_MS ?? 5 * 60_000);
  return Number.isFinite(configured) ? Math.max(60_000, Math.min(60 * 60_000, configured)) : 5 * 60_000;
}

export function purchaseCartHash(items: OrderItem[], deliveryFee: number, promise?: string, destination?: { cep?: string | null; deliveryAddress?: string | null }): string {
  const canonical = {
    items: items
      .map((item) => ({ storeKey: item.storeKey, sku: item.sku, qty: item.qty, unitPrice: money(item.unitPrice), productUrl: item.productUrl ?? null }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    deliveryFee: money(deliveryFee),
    promise: promise ?? null,
    destination: { cep: destination?.cep ?? null, address: destination?.deliveryAddress ?? null }
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function deliveryPromise(fulfillments: unknown): string | undefined {
  if (!Array.isArray(fulfillments)) return undefined;
  const values = fulfillments
    .map((entry) => (entry && typeof entry === "object" ? (entry as { deliveryPromise?: unknown }).deliveryPromise : undefined))
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return values.length ? values.join(" · ") : undefined;
}

// Pedido de várias lojas (09/10): prazo e frete da LOJA do trabalho; uma loja só: os do pedido.
function multiStore(items: unknown): boolean {
  return new Set((Array.isArray(items) ? items : []).map((i) => (i as { storeKey?: unknown })?.storeKey).filter(Boolean)).size > 1;
}
function ownFulfillment(fulfillments: unknown, storeKey: string): { deliveryPromise?: unknown; deliveryFee?: unknown } | undefined {
  return Array.isArray(fulfillments) ? fulfillments.find((f) => f && typeof f === "object" && (f as { storeKey?: unknown }).storeKey === storeKey) : undefined;
}
function storePromise(order: { items: unknown; fulfillments: unknown }, storeKey: string): string | undefined {
  if (!multiStore(order.items)) return deliveryPromise(order.fulfillments);
  const own = ownFulfillment(order.fulfillments, storeKey)?.deliveryPromise;
  return typeof own === "string" && own.trim() ? own : undefined;
}
function storeFee(order: { items: unknown; fulfillments: unknown; deliveryFee: number }, storeKey: string): number {
  if (!multiStore(order.items)) return order.deliveryFee;
  const fee = Number(ownFulfillment(order.fulfillments, storeKey)?.deliveryFee);
  return Number.isFinite(fee) ? fee : 0;
}

function preparationEligible(storeKey: string, items: OrderItem[], configured = false): boolean {
  return (configured || preparationStores().includes(storeKey)) && items.length > 0 && items.every((item) => item.storeKey === storeKey &&
    Number.isInteger(item.qty) && item.qty > 0 && Number.isFinite(item.unitPrice) && item.unitPrice > 0 &&
    purchaseUrlAllowed(storeKey, item.productUrl ?? ""));
}

// Dinheiro do cliente íntegro para comprar: pagamento real aprovado no valor do pedido, sem resultado
// desconhecido, e nenhuma devolução além das partes de loja devolvidas por falha só daquela loja
// (pedido de várias lojas, 09/10). Pedido de uma loja: nenhuma devolução, como sempre.
export function purchaseFundsIntact(
  order: { total: number; payments: Array<{ provider: string; status: string; amountCents: number; refundedCents: number }>; paymentAttempts: Array<{ status: string }> },
  refundedShareCents = 0
): boolean {
  const real = order.payments.filter((p) => ["mercadopago", "pagarme"].includes(p.provider));
  if (!real.length || order.paymentAttempts.some((a) => a.status === "unknown_outcome")) return false;
  if (real.reduce((sum, p) => sum + p.amountCents, 0) !== Math.round(order.total * 100)) return false;
  const refunded = real.reduce((sum, p) => sum + p.refundedCents, 0);
  if (refunded !== refundedShareCents) return false;
  return real.every((p) => p.status === "approved" || (refundedShareCents > 0 && p.status === "partially_refunded"));
}

// Soma das partes de loja já devolvidas ao cliente (tentativa `store_refund` gravada ANTES da chamada
// ao provedor e apagada se ela falhar — conta mesmo enquanto a devolução está em curso).
export async function refundedShareCents(orderId: string, db: Pick<typeof prisma, "purchaseAttempt"> = prisma): Promise<number> {
  const rows = await db.purchaseAttempt.findMany({ where: { step: "store_refund", purchaseJob: { deliveryOrderId: orderId } }, select: { details: true } });
  return rows.reduce((sum, row) => sum + Number((row.details as { amountCents?: unknown } | null)?.amountCents ?? 0), 0);
}

// Um trabalho de compra POR LOJA do pedido (09/10). Pedido de uma loja: um trabalho, como sempre.
// Loja sem compra automática fica sem trabalho aqui (a fila manual cobre).
export async function ensurePurchaseJobsForPaidOrder(orderId: string) {
  // 15/09/2026 — operador humano contratado. Antes, `LIA_AUTO_PURCHASE_OFF` só barrava o
  // clique final: o job nascia assim mesmo e o pedido saía da fila manual, então o
  // operador não via "COMPRA MANUAL" e ninguém comprava. Com o kill-switch ligado nenhum
  // job automático nasce e todo pedido pago cai na fila do /ops, que é a rota decidida.
  // A conta salva da loja (a Cobasi está pronta) deixa de puxar o pedido sozinha.
  if (process.env.LIA_AUTO_PURCHASE_OFF === "true") return [];
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, include: { purchaseJobs: true, payments: true, paymentAttempts: { select: { status: true } } } });
  if (!order || order.status !== "paid" || !isRetailerDeliveryOrder(order)) return [];
  if (order.storeOrderNumber || hasCancelRequest(order.notes) || hasPendingRefund(order.notes) || (order.notes ?? "").includes("🛑 COMPRA BLOQUEADA:")) return [];
  if (!purchaseFundsIntact(order)) return [];
  const items = ((order.items as unknown as OrderItem[]) ?? []).filter(Boolean);
  const { orderStoreKeys, perStoreQuoteReady, storeScope, storeCartHash } = await import("./purchase/store-split");
  const stores = orderStoreKeys(items);
  // Cesta de várias lojas só vira compra automática quando a cotação foi feita por loja.
  if (!stores.length || !perStoreQuoteReady(order)) return [];
  const jobs = [];
  for (const storeKey of stores) {
    const scope = storeScope(order, storeKey);
    if (!scope) continue;
    // Lojas precisam de habilitação explícita para preparação. Linhas livres e checkout final
    // continuam fora deste executor.
    const account = await prisma.purchaseAccount.findUnique({ where: { storeKey } });
    if (!preparationEligible(storeKey, scope.items as OrderItem[], Boolean(account?.enabled && account.loginReady && account.paymentReady))) continue;
    const existing = order.purchaseJobs.find((job) => job.fulfillmentKey === storeKey);
    if (existing) { jobs.push(existing); continue; }
    const expectedTotal = money(scope.ceilingCents / 100);
    const hash = storeCartHash(order, scope);
    try {
      jobs.push(await prisma.purchaseJob.create({
        data: {
          deliveryOrderId: order.id,
          fulfillmentKey: storeKey,
          storeKey,
          storeLabel: scope.storeLabel,
          status: "queued",
          expectedTotal,
          approvalMaxTotal: expectedTotal,
          approvalCartHash: hash,
          cartHash: hash,
          cartSnapshot: { deliveryFee: money(scope.deliveryFee), deliveryPromise: scope.promise ?? null, ...(scope.multi ? { customerShareCents: scope.shareCents, stores } : {}) },
          items: {
            create: scope.items.map((item) => ({
              requestedSku: item.sku,
              requestedName: item.name,
              requestedQty: Math.max(1, Math.round(item.qty)),
              requestedUnitPrice: money(item.unitPrice),
              productUrl: item.productUrl,
              expectedUnitPrice: money(item.unitPrice),
              status: "resolved"
            }))
          }
        }
      }));
    } catch (error) {
      // Payment webhooks may race. The unique (order, fulfillment) constraint is the
      // authority, so the loser returns the row created by the winner.
      const raced = await prisma.purchaseJob.findUnique({
        where: { deliveryOrderId_fulfillmentKey: { deliveryOrderId: order.id, fulfillmentKey: storeKey } }
      });
      if (!raced) throw error;
      jobs.push(raced);
    }
  }
  return jobs;
}

export async function ensurePurchaseJobForPaidOrder(orderId: string) {
  return (await ensurePurchaseJobsForPaidOrder(orderId))[0] ?? null;
}

// O trabalho ainda pode ser comprado AGORA? Mesmas regras de quando nasceu, olhando só a parte da loja:
// pedido pago, sem cancelamento/estorno/bloqueio, dinheiro íntegro, loja habilitada e carrinho igual
// ao do trabalho (cesta, frete, prazo e endereço). Pedido de várias lojas: as outras lojas podem já
// ter sido compradas (o pedido tem número) ou devolvidas — o que vale é esta loja não ter compra.
export async function purchaseJobStillValid(jobId: string): Promise<boolean> {
  if (process.env.LIA_AUTO_PURCHASE_OFF === "true") return false;
  const job = await prisma.purchaseJob.findUnique({ where: { id: jobId }, include: { deliveryOrder: { include: { payments: true, paymentAttempts: { select: { status: true } } } } } });
  if (!job || job.storeOrderNumber) return false;
  const order = job.deliveryOrder;
  if (order.status !== "paid" || !isRetailerDeliveryOrder(order)) return false;
  if (hasCancelRequest(order.notes) || hasPendingRefund(order.notes) || (order.notes ?? "").includes("🛑 COMPRA BLOQUEADA:")) return false;
  const { isMultiStoreOrder, storeScope, storeCartHash } = await import("./purchase/store-split");
  const multi = isMultiStoreOrder(order);
  if (!multi && order.storeOrderNumber) return false;
  if (!purchaseFundsIntact(order, multi ? await refundedShareCents(order.id) : 0)) return false;
  const scope = storeScope(order, job.storeKey);
  if (!scope) return false;
  const account = await prisma.purchaseAccount.findUnique({ where: { storeKey: job.storeKey } });
  if (!preparationEligible(job.storeKey, scope.items as OrderItem[], Boolean(account?.enabled && account.loginReady && account.paymentReady))) return false;
  return storeCartHash(order, scope) === job.cartHash;
}

// Pedido pago cuja loja NÃO tem execução automática (cesta mista, linha livre, loja sem
// conta/allowlist): cria um job `manual_queue` para o /ops mostrar explicitamente "compra
// manual", em vez de deixar o pedido `paid` sem sinal (decisão 11/09). Nunca é reivindicado
// por nenhum comprador (CLAIMABLE não o inclui); fecha quando o operador registra a compra.
export const MANUAL_QUEUE_STATUS = "manual_queue";
export async function manualQueueJobForPaidOrder(orderId: string) {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, include: { purchaseJobs: true } });
  if (!order || order.status !== "paid" || order.storeOrderNumber) return null;
  const items = ((order.items as unknown as OrderItem[]) ?? []).filter(Boolean);
  const storeKeys = [...new Set(items.map((i) => i.storeKey).filter(Boolean))];
  const { perStoreQuoteReady } = await import("./purchase/store-split");
  // Várias lojas cotadas por loja (09/10): só a loja que ficou sem trabalho automático vai para a
  // fila manual, com a parte dela; as outras seguem compradas sozinhas.
  if (storeKeys.length > 1 && perStoreQuoteReady(order) && order.purchaseJobs.length) {
    const missing = storeKeys.filter((key) => !order.purchaseJobs.some((job) => job.fulfillmentKey === key));
    let created = null;
    for (const storeKey of missing) {
      const own = items.filter((i) => i.storeKey === storeKey);
      try {
        created = await prisma.purchaseJob.create({
          data: {
            deliveryOrderId: order.id, fulfillmentKey: storeKey, storeKey, storeLabel: own[0]?.storeLabel ?? storeKey,
            status: MANUAL_QUEUE_STATUS,
            expectedTotal: money(own.reduce((sum, i) => sum + money(i.unitPrice * i.qty), 0)),
            lastErrorMessage: "Loja sem compra automática: compra manual desta parte no /ops.",
            items: { create: own.map((item) => ({ requestedSku: item.sku, requestedName: item.name, requestedQty: Math.max(1, Math.round(item.qty)), requestedUnitPrice: money(item.unitPrice), productUrl: item.productUrl, expectedUnitPrice: money(item.unitPrice), status: "manual" })) }
          }
        });
      } catch { /* corrida: o outro criou */ }
    }
    return created;
  }
  if (order.purchaseJobs.length) return order.purchaseJobs[0];
  const storeKey = storeKeys.length === 1 ? storeKeys[0] : order.storeKey;
  const storeLabel = storeKeys.length === 1 ? items[0].storeLabel ?? storeKey : order.storeLabel;
  try {
    return await prisma.purchaseJob.create({
      data: {
        deliveryOrderId: order.id,
        fulfillmentKey: storeKey,
        storeKey,
        storeLabel,
        status: MANUAL_QUEUE_STATUS,
        expectedTotal: money(order.itemsSubtotal + order.deliveryFee),
        lastErrorMessage: storeKeys.length > 1 ? "Cesta com mais de uma loja: compra manual." : "Loja sem compra automática: compra manual no /ops.",
        items: {
          create: items.map((item) => ({
            requestedSku: item.sku,
            requestedName: item.name,
            requestedQty: Math.max(1, Math.round(item.qty)),
            requestedUnitPrice: money(item.unitPrice),
            productUrl: item.productUrl,
            expectedUnitPrice: money(item.unitPrice),
            status: "manual"
          }))
        }
      }
    });
  } catch {
    return prisma.purchaseJob.findFirst({ where: { deliveryOrderId: order.id } });
  }
}

// Comprador local sem heartbeat há N min com pedido pago esperando: avisa o dono uma vez
// por hora (OpsAction buyer_silent como marcador, sem botão).
export async function alertSilentBuyer(now = new Date()) {
  const minutes = Number(process.env.LIA_BUYER_SILENT_MIN ?? 10);
  const accounts = await prisma.purchaseAccount.findMany({ where: { enabled: true } });
  const silent = accounts.filter((a) => !a.lastSeenAt || a.lastSeenAt.getTime() < now.getTime() - minutes * 60_000);
  if (!silent.length) return "none";
  const waiting = await prisma.purchaseJob.findMany({ where: { storeKey: { in: silent.map((a) => a.storeKey) }, status: { in: CLAIMABLE } }, select: { storeKey: true } });
  if (!waiting.length) return "none";
  const open = await prisma.opsAction.findFirst({ where: { kind: "buyer_silent", status: "pending", expiresAt: { gt: now } } });
  if (open) return "already";
  await prisma.opsAction.create({ data: { kind: "buyer_silent", expiresAt: new Date(now.getTime() + 60 * 60_000) } });
  const { notifyOwner } = await import("./turn-runtime");
  const copy = await import("./lia-copy");
  await notifyOwner(copy.operatorBuyerSilent(minutes, [...new Set(waiting.map((w) => w.storeKey))]));
  return "alerted";
}

export async function backfillPaidPurchaseJobs(limit = 25) {
  let cursor: string | undefined;
  let created = 0;
  const max = Math.max(1, Math.min(100, limit));
  // Cestas ficam frequentemente com storeKey=concierge no cabeçalho. A loja real
  // vem dos itens. Percorrer páginas evita que pedidos antigos inelegíveis escondam novos.
  for (;;) {
    const orders = await prisma.deliveryOrder.findMany({
      where: { status: "paid", storeOrderNumber: null, purchaseJobs: { none: {} },
        payments: { some: { provider: { in: ["mercadopago", "pagarme"] }, status: "approved", refundedCents: 0 } } },
      orderBy: { id: "asc" }, take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true }
    });
    if (!orders.length) break;
    for (const order of orders) {
      if (await ensurePurchaseJobForPaidOrder(order.id)) created += 1;
      else if (await manualQueueJobForPaidOrder(order.id)) created += 1;
      if (created >= max) return created;
    }
    cursor = orders[orders.length - 1].id;
    if (orders.length < 50) break;
  }
  return created;
}

export async function claimNextPurchaseJob(workerId: string, allowedStores?: string[]) {
  await backfillPaidPurchaseJobs();
  const now = new Date();
  // Cada consulta do comprador é sinal de vida das contas que ele atende (o /ops mostra
  // "visto há X min" e o alarme de silêncio só dispara com job esperando e sem sinal).
  if (allowedStores?.length)
    await prisma.purchaseAccount.updateMany({ where: { storeKey: { in: allowedStores }, enabled: true }, data: { lastSeenAt: now } });
  const stale = new Date(now.getTime() - leaseMs());
  // Lease vencido é resultado desconhecido: nunca entregar o mesmo checkout a outro robô.
  await prisma.purchaseJob.updateMany({
    where: { status: "claimed", lockedAt: { lt: stale } },
    data: { status: "needs_review", lastErrorCode: "WORKER_LEASE_EXPIRED", lastErrorMessage: "Executor interrompido. Reconciliar carrinho/pedido na loja antes de liberar nova tentativa." }
  });

  await prisma.purchaseJob.updateMany({ where: { status: "submitting", lockedAt: { lt: stale } }, data: { status: "outcome_unknown", lastErrorCode: "SUBMIT_INTERRUPTED", lastErrorMessage: "Confira histórico da loja; não repetir compra." } });
  await prisma.purchaseJob.updateMany({ where: { status: { in: ["awaiting_approval", "approved"] }, lockedAt: { lt: stale } }, data: { status: "needs_review", lastErrorCode: "WORKER_LEASE_EXPIRED" } });
  const configuredAccounts=allowedStores?[]:await prisma.purchaseAccount.findMany({where:{enabled:true},select:{storeKey:true}});
  const claimStores=allowedStores??preparationStores().filter(store=>!configuredAccounts.some(a=>a.storeKey===store));
  const blockedStores: string[] = [];
  for (let attempt = 0; attempt < preparationStores().length + 5; attempt += 1) {
    const candidate = await prisma.purchaseJob.findFirst({
      where: {
        status: { in: allowedStores ? [...CLAIMABLE,"approved"] : CLAIMABLE },
        storeKey: { notIn: blockedStores, in: claimStores },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        AND: [{ OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }] }],
        deliveryOrder: { status: "paid" }
      },
      orderBy: [{approvedAt:{sort:"asc",nulls:"last"}},{createdAt:"asc"}],
      select: { id: true, status: true }
    });
    if (!candidate) return null;
    const full = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: candidate.id }, include: { deliveryOrder: true } });
    // Revalida SÓ a parte desta loja (09/10): num pedido de várias lojas as outras podem já estar
    // compradas ou devolvidas sem invalidar esta.
    if (!(await purchaseJobStillValid(full.id))) {
      await prisma.purchaseJob.updateMany({ where: { id: full.id, status: candidate.status }, data: { status: "needs_review", lastErrorCode: "ORDER_CHANGED", lastErrorMessage: "Pagamento, cesta ou endereço mudou. Revalidar antes de comprar." } });
      continue;
    }
    const claimed = await prisma.$transaction(async (tx) => {
      // Hoje existe uma conta operacional por loja. A trava cobre o carrinho físico,
      // não apenas o pedido: dois clientes jamais montam a mesma sacola em paralelo.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase-account:${full.storeKey}`}))::text`;
      // Carrinho nas mãos do dono (ML) ou Pix em curso também ocupam a conta da loja.
      // Trabalho parado há mais de um dia não ocupa mais a conta (09/10: um Pix da Cobasi de 15/09
      // sem desfecho travou toda compra nova da loja); ele segue no /ops para conferência.
      const busy = await tx.purchaseJob.findFirst({ where: { storeKey: full.storeKey, updatedAt: { gt: new Date(Date.now() - busyHorizonMs()) }, OR: [
        { status: { in: ["claimed", "submitting", "outcome_unknown", "awaiting_owner_confirm", "awaiting_store_number", "pix_captured", "pix_submitted", "pix_paid"] } }, {status:{in:["awaiting_approval","approved"]},lockedAt:{not:null}}, { status: "needs_review", lockedAt: { not: null } }
      ] }, select: { id: true } });
      const trackingBusy = await tx.trackingSubscription.findFirst({where:{storeKey:full.storeKey,lockedAt:{gt:new Date(Date.now()-5*60_000)}}});
      if (busy || trackingBusy) return { count: 0 };
      // Pedido de uma loja: número da loja no pedido = já comprado. Várias lojas: o número do pedido
      // é o da 1ª loja comprada; o que vale é ESTE trabalho não ter número.
      const current = await tx.deliveryOrder.findUniqueOrThrow({ where: { id: full.deliveryOrderId }, select: { storeOrderNumber: true, items: true } });
      const { isMultiStoreOrder } = await import("./purchase/store-split");
      if (current.storeOrderNumber && !isMultiStoreOrder(current)) return { count: 0 };
      return tx.purchaseJob.updateMany({
      where: { id: candidate.id, status: candidate.status, storeOrderNumber: null, deliveryOrder: { status: "paid" }, OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }] },
      data: { status: candidate.status==="approved"?"approved":"claimed", lockedAt: now, browserSessionId: workerId, nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null }
      });
    });
    if (!claimed.count) { blockedStores.push(full.storeKey); continue; }
    return prisma.purchaseJob.findUnique({
      where: { id: candidate.id },
      include: { items: true, deliveryOrder: true }
    });
  }
  return null;
}

// Compra no CPF/nome do cliente (08/10, modelo service_fee): TODA loja do pedido que carrega o
// CPF compra no nome dele (nota fiscal dele). No modelo markup vale a regra de 29/09: só a loja
// que tem o REMÉDIO; as outras seguem no CNPJ. Não depende da flag de remédio: pedido pago com
// remédio compra no CPF mesmo que ela seja desligada depois.
export function customerBuyerFor(job: { deliveryOrder: { buyerDocument: string | null; buyerName: string | null; items: unknown }; items: Array<{ requestedSku: string }> }): { document: string; name: string } | null {
  const order = job.deliveryOrder;
  if (!order.buyerDocument || !order.buyerName) return null;
  if (customerInvoiceEnabled()) return { document: order.buyerDocument, name: order.buyerName };
  const items = Array.isArray(order.items) ? (order.items as Array<{ sku?: unknown; medicine?: unknown }>) : [];
  const mipSkus = new Set(items.flatMap((i) => (i && i.medicine === "mip" && typeof i.sku === "string" ? [i.sku] : [])));
  return job.items.some((item) => mipSkus.has(item.requestedSku)) ? { document: order.buyerDocument, name: order.buyerName } : null;
}

export function workerPayload(job: NonNullable<Awaited<ReturnType<typeof claimNextPurchaseJob>>>) {
  return {
    jobId: job.id,
    orderId: job.deliveryOrderId,
    shortOrderId: job.deliveryOrderId.slice(-6).toUpperCase(),
    storeKey: job.storeKey,
    storeLabel: job.storeLabel,
    deliveryPromise: storePromise(job.deliveryOrder, job.storeKey),
    expectedTotal: job.expectedTotal,
    maximumTotal: job.approvalMaxTotal,
    cartHash: job.cartHash,
    // Sem clique automático fora do comprador local: ML = confirmação do dono; VTEX = Pix.
    mode: "cart_only",
    canSubmitPurchase: false,
    // Frete cotado ao cliente (o ML não expõe frete no carrinho antes do endereço).
    deliveryFeeCents: Math.round(money(storeFee(job.deliveryOrder, job.storeKey)) * 100),
    customer: {
      name: job.deliveryOrder.customerName,
      phone: job.deliveryOrder.phone,
      cep: job.deliveryOrder.cep,
      address: job.deliveryOrder.deliveryAddress
    },
    // Remédio isento (29/09): esta compra sai no CPF/nome do cliente (nulo = CNPJ da Lia).
    buyer: customerBuyerFor(job),
    items: job.items.map((item) => ({
      sku: item.requestedSku,
      name: item.requestedName,
      quantity: item.requestedQty,
      expectedUnitPrice: item.expectedUnitPrice,
      productUrl: item.productUrl
    }))
  };
}

export async function reportPurchaseJobFailure(jobId: string, workerId: string, input: { code: string; message: string; retryable?: boolean }) {
  const status = input.retryable ? "retrying" : "needs_review";
  const updated = await prisma.purchaseJob.updateMany({
    where: { id: jobId, status: "claimed", browserSessionId: workerId },
    data: {
      status,
      lockedAt: null,
      nextAttemptAt: input.retryable ? new Date(Date.now() + retryMs()) : null,
      lastErrorCode: input.code.slice(0, 80),
      lastErrorMessage: input.message.slice(0, 500)
    }
  });
  if (!updated.count) throw new Error("Purchase job is not claimed by this worker.");
  await prisma.purchaseAttempt.create({
    data: { purchaseJobId: jobId, step: "worker", status, browserSessionId: workerId, errorCode: input.code.slice(0, 80), errorMessage: input.message.slice(0, 500), completedAt: new Date() }
  });
}

