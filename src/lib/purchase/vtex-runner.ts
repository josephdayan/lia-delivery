// Comprador VTEX no SERVIDOR (25/09/2026): substitui o comprador do Mac nas lojas com
// checkout por API. Chama, em processo, as mesmas funções que o Mac chamava pela rota
// /api/purchase-worker/session — a máquina de estados, o teto, a reserva de orçamento, a
// allowlist de recebedor e o pagamento pela Asaas continuam sendo a autoridade.
//
//   claim → prepare (cesta/perfil/endereço/entrega/Pix) → stage (auto-aprova na política)
//   → begin (reserva) → placeOrder (transaction/vault/callback → EMV) → capturePix (Asaas)
//   → finishPurchase (número do pedido = orderGroup-01, cliente avisado).
// Falha ANTES do `transaction`: cesta esvaziada, job para revisão/retry, orçamento livre.
// Falha DEPOIS: `outcome_unknown` (pedido pode existir na loja) — nunca repetir sozinho.
import { prisma } from "../prisma";
import {
  abortSubmissionBeforeOrder, beginPurchase, capturePix, claimPurchaseSession, executionUnknown, finishPurchase,
  parkCheckout, rememberPixCodeForOwnerApproval, stageCheckout,
} from "../purchase-execution";
import { reportPurchaseJobFailure } from "../purchase-worker";
import { resolveVtexAddress } from "./vtex-address";
import { VTEX_API_STORE_KEYS, VtexCheckoutRejected, VtexCheckoutSession, vtexOrderId, type FetchLike, type VtexBuyerProfile } from "./vtex-checkout";

export const SERVER_BUYER_ID = "server-vtex-api";

// Recusa da loja ANTES de existir pedido nela (25/09, dono: "nesses casos tem que estornar
// direto"): item sem estoque/entrega, janela, conferência, fechamento 4xx. O cliente recebe o
// dinheiro de volta na hora e o dono um aviso. Fora desta lista, nunca: pedido velho
// (STALE_PAID_ORDER, pode ter sido comprado à mão), queda depois do pedido (outcome_unknown) e
// falha passageira (retrying) não estornam sozinhos.
export function refundableServerFailure(code: string | null | undefined): boolean {
  if (!code) return false;
  if (code === "STALE_PAID_ORDER") return false;
  return /^VTEX_/.test(code) || ["CHECKOUT_MISMATCH", "BEGIN_REFUSED", "ADDRESS_MISSING", "ACCOUNT_EMAIL_MISSING", "BUYER_DOCUMENT"].includes(code);
}
function customerReason(code: string): string {
  if (/^VTEX_(ITEMS|SLA|SHIPPINGDATA|SELLER)/.test(code)) return "a loja não tem esse item para entrega no seu endereço agora";
  if (code === "PIX_CAPTURE_REFUSED" || code === "VTEX_ORDER_WITHOUT_PAYMENT") return "não consegui concluir o pagamento na loja";
  return "a loja não confirmou a compra agora";
}
export async function refundServerFailure(orderId: string, code: string, detail: string) {
  const { opsPurchaseFailedRefund } = await import("../ops-lifecycle");
  const { notifyOwner } = await import("../turn-runtime");
  const copy = await import("../lia-copy");
  const order = await opsPurchaseFailedRefund(orderId, customerReason(code), { origin: "auto", internalReason: `${code}: ${detail}`.slice(0, 200) });
  await notifyOwner(copy.operatorAutoRefundAlert(order.id.slice(-6).toUpperCase(), Number(order.total), `${code} — ${detail}`), order.phone).catch(() => undefined);
  return order;
}
// Varre jobs do comprador do servidor que ficaram em revisão por recusa ANTES do pedido e
// estorna (cobre também quem caiu em revisão antes desta regra existir).
export async function refundRejectedServerJobs(limit = 10) {
  const jobs = await prisma.purchaseJob.findMany({
    where: { status: "needs_review", storeKey: { in: VTEX_API_STORE_KEYS }, updatedAt: { gte: new Date(Date.now() - 48 * 3_600_000) }, deliveryOrder: { status: "paid", storeOrderNumber: null } },
    select: { id: true, deliveryOrderId: true, lastErrorCode: true, lastErrorMessage: true }, take: limit,
  });
  let refunded = 0;
  const errors: string[] = [];
  // Pedido criado na loja, mas a Lia NUNCA pagou o Pix dela (conferência recusou antes de
  // qualquer PixPayout; 28/09, 1º pedido real do Mambo): nenhum dinheiro saiu, o pedido da
  // loja vence sem pagamento — o cliente é estornado já, sem esperar a loja cancelar.
  const unpaidPlaced = await prisma.purchaseJob.findMany({
    where: { status: "outcome_unknown", lastErrorCode: { in: ["PIX_CAPTURE_REFUSED", "VTEX_ORDER_WITHOUT_PAYMENT"] }, storeKey: { in: VTEX_API_STORE_KEYS }, updatedAt: { gte: new Date(Date.now() - 48 * 3_600_000) }, deliveryOrder: { status: "paid", storeOrderNumber: null } },
    select: { id: true, deliveryOrderId: true, lastErrorCode: true, submissionId: true }, take: limit,
  });
  for (const job of unpaidPlaced) {
    const payout = await prisma.pixPayout.findFirst({ where: { purchaseJobId: job.id }, select: { id: true } });
    if (payout) continue; // dinheiro pode ter saído: humano
    const refusal = await prisma.purchaseAttempt.findFirst({ where: { purchaseJobId: job.id, step: { in: ["pix_capture", "vtex_order"] } }, orderBy: { createdAt: "desc" } });
    const why = refusal?.errorMessage ?? "a Lia não conseguiu pagar o Pix da loja";
    try {
      await prisma.purchaseJob.update({ where: { id: job.id }, data: { status: "canceled", lockedAt: null, claimToken: null, lastErrorMessage: `Pedido criado na loja e NÃO pago pela Lia (${why}); vence sem pagamento. Cliente estornado.`.slice(0, 500) } });
      if (job.submissionId) await prisma.purchaseSpend.updateMany({ where: { submissionId: job.submissionId, status: "reserved" }, data: { status: "released", releasedAt: new Date(), releaseNote: "Pix da loja não pago; pedido vence sozinho" } });
      await refundServerFailure(job.deliveryOrderId, job.lastErrorCode ?? "PIX_CAPTURE_REFUSED", why);
      refunded += 1;
    } catch (error) {
      errors.push(`${job.deliveryOrderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const job of jobs) {
    if (!refundableServerFailure(job.lastErrorCode)) continue;
    // Tentativa de pedido que chegou a existir na loja nunca estorna sozinha.
    const placed = await prisma.purchaseAttempt.findFirst({ where: { purchaseJobId: job.id, step: "vtex_order" }, select: { id: true } });
    if (placed) continue;
    try {
      await refundServerFailure(job.deliveryOrderId, job.lastErrorCode!, job.lastErrorMessage ?? "");
      await prisma.purchaseJob.update({ where: { id: job.id }, data: { status: "canceled", lastErrorMessage: `${job.lastErrorMessage ?? ""} — estornado automaticamente.`.slice(0, 500) } });
      refunded += 1;
    } catch (error) {
      errors.push(`${job.deliveryOrderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refunded, errors };
}
export type RunResult = { jobId: string; storeKey: string; status: string; detail?: string };

export function maxPaidAgeHours() {
  const v = Number(process.env.LIA_SERVER_BUYER_MAX_AGE_HOURS ?? 24);
  return Number.isFinite(v) && v > 0 ? v : 24;
}
export function serverBuyerEnabled() {
  return process.env.LIA_AUTO_PURCHASE_OFF !== "true" && process.env.LIA_SERVER_BUYER_OFF !== "true";
}
// Telefone do perfil: o da empresa (LIA_BUYER_PHONE) ou, sem ele, o do cliente (contato da entrega).
export function buyerPhone(customerPhone?: string | null): string | undefined {
  const raw = (process.env.LIA_BUYER_PHONE ?? customerPhone ?? "").replace(/[^\d+]/g, "");
  if (!raw) return undefined;
  return raw.startsWith("+") ? raw : `+${raw.replace(/^0+/, "")}`;
}
export function buyerProfile(email: string, customerPhone?: string | null): VtexBuyerProfile {
  const document = (process.env.LIA_BUYER_DOCUMENT ?? "").replace(/\D/g, "");
  if (document.length !== 11 && document.length !== 14) throw new Error("LIA_BUYER_DOCUMENT ausente ou inválido (CPF 11 / CNPJ 14 dígitos).");
  return {
    email,
    firstName: process.env.LIA_BUYER_FIRST_NAME?.trim() || "Lia",
    lastName: process.env.LIA_BUYER_LAST_NAME?.trim() || "Delivery",
    document,
    documentType: document.length === 14 ? "cnpj" : "cpf",
    corporateName: process.env.LIA_BUYER_CORPORATE_NAME?.trim() || "Lia Delivery",
    phone: buyerPhone(customerPhone),
  };
}

// Um job, do claim ao Pix pago. `fetchImpl` só existe para os testes.
export async function executeVtexJob(
  payload: NonNullable<Awaited<ReturnType<typeof claimPurchaseSession>>>,
  fetchImpl: FetchLike = fetch,
): Promise<RunResult> {
  const ids = [payload.jobId, SERVER_BUYER_ID, payload.claimToken] as const;
  const base = { jobId: payload.jobId, storeKey: payload.storeKey };
  const session = new VtexCheckoutSession(payload.storeKey, fetchImpl);
  const fail = async (code: string, message: string, retryable = false) => {
    await session.clearCart().catch(() => undefined);
    await reportPurchaseJobFailure(payload.jobId, SERVER_BUYER_ID, { code, message, retryable }).catch(() => undefined);
    return { ...base, status: retryable ? "retrying" : "needs_review", detail: message } as RunResult;
  };
  // Pedido pago há muito tempo (padrão 24h) nunca é comprado sozinho: quase sempre já foi
  // comprado à mão sem registrar o número, e comprar de novo é dinheiro perdido. Vai para
  // revisão com o motivo; o /ops registra o número ou estorna.
  const order = await prisma.deliveryOrder.findUnique({ where: { id: payload.orderId }, select: { paidAt: true, createdAt: true } });
  const paidAt = order?.paidAt ?? order?.createdAt ?? null;
  const ageHours = paidAt ? (Date.now() - paidAt.getTime()) / 3_600_000 : null;
  if (ageHours != null && ageHours > maxPaidAgeHours()) {
    await reportPurchaseJobFailure(payload.jobId, SERVER_BUYER_ID, { code: "STALE_PAID_ORDER", message: `Pedido pago há ${Math.round(ageHours)}h; confira se já foi comprado à mão e registre o número, ou estorne.`, retryable: false }).catch(() => undefined);
    return { ...base, status: "needs_review", detail: `pago há ${Math.round(ageHours)}h` };
  }
  if (!payload.accountEmail) return fail("ACCOUNT_EMAIL_MISSING", "Conta da loja sem e-mail no /ops.");
  if (!payload.customer.cep || !payload.customer.address || !payload.customer.name) return fail("ADDRESS_MISSING", "Pedido sem nome, CEP ou endereço.");
  let profile: VtexBuyerProfile;
  try { profile = buyerProfile(payload.accountEmail, payload.customer.phone); } catch (error) { return fail("BUYER_DOCUMENT", error instanceof Error ? error.message : "documento"); }

  // ---- preparação (nada criado na loja) ----
  let evidence;
  try {
    const address = await resolveVtexAddress({ receiverName: payload.customer.name, cep: payload.customer.cep, addressText: payload.customer.address, fetchImpl });
    await session.prepare({
      items: payload.items.map((i) => ({ sku: i.sku, qty: i.quantity })),
      profile, address, deliveryPromise: payload.deliveryPromise,
    });
    evidence = session.snapshot({ cartHash: payload.cartHash!, customerAddress: payload.customer.address, items: payload.items });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage = error instanceof VtexCheckoutRejected ? error.stage : "prepare";
    // Loja fora do ar / timeout: vale tentar de novo sozinho. Item, entrega ou endereço: humano.
    const retryable = !(error instanceof VtexCheckoutRejected) && /timeout|fetch failed|ECONN|socket/i.test(message);
    return fail(`VTEX_${stage.toUpperCase()}`.slice(0, 80), message, retryable);
  }
  let staged;
  try { staged = await stageCheckout(...ids, evidence); } catch (error) {
    return fail("CHECKOUT_MISMATCH", error instanceof Error ? error.message : "conferência");
  }
  if (!staged.readyToSubmit) {
    await session.clearCart().catch(() => undefined);
    await parkCheckout(...ids).catch(() => undefined);
    return { ...base, status: "awaiting_approval", detail: staged.checkoutHash };
  }
  const fresh = session.snapshot({ cartHash: payload.cartHash!, customerAddress: payload.customer.address, items: payload.items });
  let permit;
  try { permit = await beginPurchase(...ids, fresh); } catch (error) {
    return fail("BEGIN_REFUSED", error instanceof Error ? error.message : "autorização");
  }
  if (!permit.submissionId) {
    await session.clearCart().catch(() => undefined);
    await parkCheckout(...ids).catch(() => undefined);
    return { ...base, status: "awaiting_approval", detail: permit.reason };
  }
  const submissionId = permit.submissionId;

  // ---- fechamento REAL ----
  let pix;
  try { pix = await session.placeOrder(); } catch (error) {
    if (error instanceof VtexCheckoutRejected) {
      const code = error.status === 403 ? "VTEX_RECAPTCHA_REQUIRED" : `VTEX_${error.stage.toUpperCase()}_${error.status}`;
      await abortSubmissionBeforeOrder(...ids, submissionId, code.slice(0, 80), error.message).catch(() => undefined);
      return { ...base, status: "needs_review", detail: error.message };
    }
    await executionUnknown(...ids, "VTEX_ORDER_WITHOUT_PAYMENT").catch(() => undefined);
    return { ...base, status: "outcome_unknown", detail: error instanceof Error ? error.message : String(error) };
  }
  await prisma.purchaseAttempt.create({ data: {
    purchaseJobId: payload.jobId, step: "vtex_order", status: "placed", idempotencyKey: `vtex-order:${submissionId}`,
    details: { orderGroup: pix.orderGroup, storeOrderNumber: vtexOrderId(pix.orderGroup), transactionId: pix.transactionId, pixExpiresAt: pix.expiresAt ?? null, paymentId: pix.paymentId ?? null, cookies: session.cookies() },
  } }).catch(() => undefined);

  // ---- Pix da loja pago pela Lia ----
  let captured;
  try { captured = await capturePix(...ids, submissionId, pix.code, { issuedByStoreApi: true }); } catch (error) {
    // Pedido criado e Pix em mãos, mas a conferência do Pix falhou (valor, dinâmico, banco).
    // Nenhum dinheiro saiu (o PixPayout nasce só depois da conferência): o motivo fica gravado
    // e a varredura estorna o cliente; o pedido na loja vence sozinho sem pagamento.
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[vtex-runner:pix-capture-refused]", payload.jobId, payload.storeKey, reason);
    await prisma.purchaseAttempt.create({ data: { purchaseJobId: payload.jobId, step: "pix_capture", status: "refused", idempotencyKey: `pix-capture-refused:${submissionId}`, errorCode: "PIX_CAPTURE_REFUSED", errorMessage: reason.slice(0, 500), details: { orderGroup: pix.orderGroup, pixExpiresAt: pix.expiresAt ?? null } } }).catch(() => undefined);
    await executionUnknown(...ids, "PIX_CAPTURE_REFUSED").catch(() => undefined);
    return { ...base, status: "outcome_unknown", detail: reason };
  }
  if (captured.status === "awaiting_receiver") {
    await rememberPixCodeForOwnerApproval(payload.jobId, submissionId, pix.code);
    return { ...base, status: "awaiting_receiver", detail: vtexOrderId(pix.orderGroup) };
  }
  if (captured.status === "paid") {
    await finishPurchase(...ids, { submissionId, storeOrderNumber: vtexOrderId(pix.orderGroup), actualTotalCents: fresh.totalCents }).catch((error) =>
      console.error("[vtex-runner:finish-failed]", payload.jobId, error instanceof Error ? error.message : error));
    return { ...base, status: "completed", detail: vtexOrderId(pix.orderGroup) };
  }
  // submitted/unknown/refused/blocked: o cron de conciliação (settlePixPayouts) e os botões do
  // dono cuidam; `finishPendingVtexOrders` fecha quando virar pago.
  return { ...base, status: `pix_${captured.status}`, detail: vtexOrderId(pix.orderGroup) };
}

// Pix pago depois (conciliado pelo cron) ou recebedor aprovado pelo dono: registra a compra
// com o número do pedido guardado na tentativa `vtex_order`.
export async function finishPendingVtexOrders(limit = 20) {
  const jobs = await prisma.purchaseJob.findMany({
    where: { status: { in: ["pix_paid", "store_confirmed"] }, storeKey: { in: VTEX_API_STORE_KEYS }, browserSessionId: SERVER_BUYER_ID, submissionId: { not: null }, deliveryOrder: { storeOrderNumber: null } },
    take: limit,
  });
  let finished = 0;
  for (const job of jobs) {
    const placed = await prisma.purchaseAttempt.findUnique({ where: { purchaseJobId_idempotencyKey: { purchaseJobId: job.id, idempotencyKey: `vtex-order:${job.submissionId}` } } });
    const number = (placed?.details as { storeOrderNumber?: unknown } | null)?.storeOrderNumber;
    const total = (job.checkoutEvidence as { totalCents?: unknown } | null)?.totalCents;
    if (typeof number !== "string" || typeof total !== "number" || !job.claimToken) continue;
    try {
      await finishPurchase(job.id, SERVER_BUYER_ID, job.claimToken, { submissionId: job.submissionId!, storeOrderNumber: number, actualTotalCents: total });
      finished += 1;
    } catch (error) {
      console.error("[vtex-runner:finish-pending]", job.id, error instanceof Error ? error.message : error);
    }
  }
  return finished;
}

// Loop do cron: reivindica e executa até `maxJobs` pedidos pagos das lojas VTEX por API.
export async function runVtexApiPurchases(input: { maxJobs?: number; fetchImpl?: FetchLike } = {}) {
  const report = { enabled: serverBuyerEnabled(), runs: [] as RunResult[], finishedPending: 0, errors: [] as string[] };
  if (!report.enabled) return report;
  const max = Math.max(1, Math.min(10, input.maxJobs ?? 3));
  for (let i = 0; i < max; i += 1) {
    let payload;
    try { payload = await claimPurchaseSession(SERVER_BUYER_ID, VTEX_API_STORE_KEYS); } catch (error) {
      report.errors.push(`claim: ${error instanceof Error ? error.message : String(error)}`); break;
    }
    if (!payload) break;
    try { report.runs.push(await executeVtexJob(payload, input.fetchImpl)); } catch (error) {
      report.errors.push(`job ${payload.jobId}: ${error instanceof Error ? error.message : String(error)}`);
      await executionUnknown(payload.jobId, SERVER_BUYER_ID, payload.claimToken, "SERVER_BUYER_CRASH").catch(() => undefined);
    }
  }
  try {
    const r = await refundRejectedServerJobs();
    (report as { refunded?: number }).refunded = r.refunded;
    report.errors.push(...r.errors.map((e) => `refund ${e}`));
  } catch (error) {
    report.errors.push(`refund: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { report.finishedPending = await finishPendingVtexOrders(); } catch (error) {
    report.errors.push(`finish: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}
