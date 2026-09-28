import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "./prisma";
import { purchaseUrlAllowed, PURCHASE_DOMAINS } from "./purchase-preparation";
import {
  claimNextPurchaseJob,
  purchaseCartHash,
  workerPayload,
} from "./purchase-worker";
import { notifyOperator, notifyOwner } from "./turn-runtime";
import { recordDeliveryEvent } from "./delivery-events";
import { Prisma } from "@prisma/client";
import { automaticPurchaseDecision, automaticPurchaseStores, AUTO_PURCHASE_POLICY, purchaseBudgetDay, MERCADO_LIVRE_STORE_KEY } from "./purchase-policy";
import { createOpsAction, cancelPendingActions, sendOperatorButtons } from "./ops-actions";
import * as copy from "./lia-copy";
import { parsePixEmv, pixCodeHash } from "./pix-emv";
import { promisedMinutes } from "./live-freight";
import { pixOutProvider, PixOutTimeout } from "./payments/pix-out";

export const checkoutEvidenceSchema = z
  .object({
    checkoutUrl: z.string().url(),
    cartHash: z.string().length(64),
    recipientName: z.string().min(1).max(300),
    accountEmail: z.string().email(),
    destination: z.string().min(5).max(1000),
    postalCode: z.string().min(8).max(10),
    deliveryOption: z.string().min(1).max(300),
    deliveryPromise: z.string().max(300),
    // Meio de pagamento observado no checkout. pix_store: a loja gera o Pix e o servidor
    // paga por API bancária (Fase 3); ml_balance: saldo Mercado Pago confirmado pelo dono
    // no app (ML degrau C); card_saved: cartão corporativo salvo (legado, em aposentadoria).
    payment: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pix_store"), paymentSystem: z.literal(125) }).strict(),
      z.object({ kind: z.literal("ml_balance") }).strict(),
      z.object({ kind: z.literal("card_saved"), reference: z.string().length(64) }).strict(),
    ]),
    observedAt: z.string().datetime(),
    items: z
      .array(
        z
          .object({
            sku: z.string().min(1),
            retailerSku: z.string().min(1),
            seller: z.string().min(1),
            name: z.string().min(1).max(300),
            qty: z.number().int().positive(),
            unitPriceCents: z.number().int().positive(),
            lineTotalCents: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    freightCents: z.number().int().nonnegative(),
    // Desconto que a loja dá no meio de pagamento (Pix: Kopenhagen 3%, Ri Happy ~2%, 25/09).
    discountCents: z.number().int().nonnegative().optional(),
    totalCents: z.number().int().positive(),
  })
  .strict();
export type CheckoutEvidence = z.infer<typeof checkoutEvidenceSchema>;
export type CheckoutPayment = CheckoutEvidence["payment"];
export const PAYMENT_KIND_LABEL: Record<CheckoutPayment["kind"], string> = {
  pix_store: "Pix da loja pago pela Lia",
  ml_balance: "Saldo Mercado Pago (confirmação no app)",
  card_saved: "Cartão corporativo salvo",
};
// Evidência gravada antes de 11/09 (paymentLabel literal) não é mais válida: o job vai
// para revisão com motivo legível em vez de derrubar a rota.
export function parseStoredEvidence(value: unknown): CheckoutEvidence {
  const parsed = checkoutEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new Error("Conferência antiga; refaça o carrinho na loja.");
  return parsed.data;
}
export const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\W/g, "");
const dollars = (v: number) => Math.round(v * 100);
export function checkoutDigest(e: CheckoutEvidence) {
  const { observedAt: _observedAt, ...fixed } = e;
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...fixed,
        items: [...fixed.items].sort((a, b) => a.sku.localeCompare(b.sku)),
      }),
    )
    .digest("hex");
}
function promiseOf(value: unknown) {
  return Array.isArray(value)
    ? value
        .flatMap((v) =>
          typeof v?.deliveryPromise === "string" ? [v.deliveryPromise] : [],
        )
        .join(" · ")
    : "";
}
export function checkCheckout(
  order: {
    items: unknown;
    deliveryAddress: string | null;
    customerName?: string | null;
    cep: string | null;
    deliveryFee: number;
    itemsSubtotal: number;
    fulfillments: unknown;
  },
  e: CheckoutEvidence,
) {
  const items = order.items as {
    sku: string;
    qty: number;
    unitPrice: number;
    storeKey: string;
    productUrl?: string;
  }[];
  if (
    !Array.isArray(items) ||
    !items.length ||
    new Set(items.map((i) => i.storeKey)).size !== 1
  )
    throw new Error("Cesta exige conferência manual.");
  if (!purchaseUrlAllowed(items[0].storeKey, e.checkoutUrl))
    throw new Error("Checkout fora da loja do pedido.");
  const hash = purchaseCartHash(
    items.map((i) => ({ ...i, name: "", storeLabel: "" })),
    order.deliveryFee,
    promiseOf(order.fulfillments) || undefined,
    order,
  );
  if (!order.customerName || norm(e.recipientName) !== norm(order.customerName))
    throw new Error("Destinatário mudou.");
  // O job leva o endereço do pedido COMPLETADO com a localidade oficial do CEP (bairro,
  // cidade, UF, CEP anexados ao fim — cep-lookup.ts). O texto do pedido tem de estar
  // inteiro no início; qualquer outra diferença é "mudou".
  const destinationOk = (() => {
    const got = norm(e.destination);
    const want = norm(order.deliveryAddress ?? "");
    return Boolean(want) && (got === want || got.startsWith(want));
  })();
  if (
    e.cartHash !== hash ||
    !destinationOk ||
    norm(e.postalCode) !== norm(order.cep ?? "")
  )
    throw new Error("Endereço ou cesta mudou.");
  if (
    new Set(e.items.map((i) => i.sku)).size !== e.items.length ||
    items.length !== e.items.length ||
    items.some((i) => !e.items.some((j) => j.sku === i.sku && j.qty === i.qty))
  )
    throw new Error("Produtos/quantidades divergentes.");
  if (e.items.some((i) => i.lineTotalCents !== i.unitPriceCents * i.qty))
    throw new Error("Preço por quantidade precisa de revisão.");
  if (
    e.totalCents !==
    e.items.reduce((a, i) => a + i.lineTotalCents, 0) + e.freightCents - (e.discountCents ?? 0)
  )
    throw new Error("Total do checkout não fecha.");
  if (e.totalCents > dollars(order.itemsSubtotal + order.deliveryFee))
    throw new Error("Total da loja acima do teto do pedido.");
  // Prazo da loja igual ou MENOR que o prometido ao cliente serve (15/09: o comprador escolhe
  // a entrega mais barata dentro do prazo; "Econômica 1 dia útil" × promessa "7 dias úteis").
  // Sem prazo legível dos dois lados, vale a igualdade de texto de antes.
  const expectedPromise = promiseOf(order.fulfillments);
  const promisedBudget = promisedMinutes(expectedPromise);
  const actualMinutes = promisedMinutes(e.deliveryPromise);
  const promiseOk = !expectedPromise
    || norm(e.deliveryPromise) === norm(expectedPromise)
    || (promisedBudget != null && actualMinutes != null && actualMinutes <= promisedBudget);
  if (!promiseOk) throw new Error("Modalidade/prazo diferente do escolhido.");
  const age = Date.now() - Date.parse(e.observedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 120_000)
    throw new Error("Conferência do checkout vencida.");
}
async function funding(tx: Prisma.TransactionClient, id: string) {
  const order = await tx.deliveryOrder.findUniqueOrThrow({
    where: { id },
    include: { payments: true, paymentAttempts: true },
  });
  const real = order.payments.filter((p) =>
    ["mercadopago", "pagarme"].includes(p.provider),
  );
  if (
    order.status !== "paid" ||
    order.storeOrderNumber ||
    /🛑|ESTORNO|CANCELAMENTO/.test(order.notes ?? "") ||
    !real.length ||
    real.some((p) => p.status !== "approved" || p.refundedCents !== 0) ||
    real.reduce((a, p) => a + p.amountCents, 0) !== dollars(order.total) ||
    order.paymentAttempts.some((p) => p.status === "unknown_outcome")
  )
    throw new Error("Pagamento/pedido exige revisão antes da compra.");
  return order;
}
async function owned(
  tx: Prisma.TransactionClient,
  jobId: string,
  workerId: string,
  token: string,
) {
  await tx.$queryRaw`SELECT id FROM "PurchaseJob" WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  if (
    !token ||
    job.claimToken !== token ||
    job.browserSessionId !== workerId ||
    !job.lockedAt ||
    job.lockedAt.getTime() < Date.now() - 120_000
  )
    throw new Error("Reserva do comprador vencida ou inválida.");
  return job;
}
export const PURCHASE_AUTH_KINDS = ["none", "email_code", "totp"] as const;
export const PURCHASE_PAYMENT_KINDS = ["card", "pix_out", "ml_balance"] as const;
export async function savePurchaseAccount(input: {
  storeKey: string;
  email?: string;
  loginReady: boolean;
  paymentReady: boolean;
  enabled: boolean;
  authKind?: (typeof PURCHASE_AUTH_KINDS)[number];
  paymentKind?: (typeof PURCHASE_PAYMENT_KINDS)[number];
}) {
  if (!PURCHASE_DOMAINS[input.storeKey])
    throw new Error("Loja ainda não suportada pelo comprador.");
  if (
    input.enabled &&
    (!input.loginReady || !input.paymentReady || !input.email?.trim())
  )
    throw new Error("Conclua login e pagamento da empresa antes de ativar.");
  // O Mercado Livre paga com saldo Mercado Pago; nas VTEX o cartão salvo está em
  // aposentadoria — o meio novo é o Pix da loja pago pela Lia.
  const paymentKind = input.paymentKind ?? (input.storeKey === "mercadolivre" ? "ml_balance" : "card");
  if (input.storeKey === "mercadolivre" && paymentKind !== "ml_balance")
    throw new Error("Mercado Livre só paga com saldo Mercado Pago.");
  const data = { ...input, paymentKind, authKind: input.authKind ?? "none" };
  return prisma.purchaseAccount.upsert({
    where: { storeKey: input.storeKey },
    create: { ...data, label: input.storeKey },
    update: data,
  });
}
export async function claimPurchaseSession(workerId: string, stores: string[]) {
  const automaticStores = automaticPurchaseStores();
  const accounts = await prisma.purchaseAccount.findMany({
    where: {
      storeKey: { in: automaticStores.length ? stores.filter(s => automaticStores.includes(s)) : stores },
      enabled: true,
      loginReady: true,
      paymentReady: true,
    },
  });
  if (!accounts.length) return null;
  const job = await claimNextPurchaseJob(
    workerId,
    accounts.map((a) => a.storeKey),
  );
  if (!job) return null;
  const token = randomUUID();
  await prisma.purchaseJob.update({
    where: { id: job.id },
    data: { claimToken: token, lockedAt: new Date() },
  });
  await prisma.purchaseAccount.update({
    where: { storeKey: job.storeKey },
    data: { lastSeenAt: new Date() },
  });
  const payload = workerPayload(job);
  // 15/09: o cliente digita "Rua X 221 ap 13" e o comprador exige bairro/cidade/UF no texto.
  // Completa só com a localidade oficial do CEP do pedido (ViaCEP); nada de rua/número.
  const { lookupCepLocality, completeAddressWithLocality } = await import("./cep-lookup");
  const locality = await lookupCepLocality(payload.customer.cep ?? "");
  payload.customer.address = completeAddressWithLocality(payload.customer.address ?? "", payload.customer.cep, locality);
  const account = accounts.find((a) => a.storeKey === job.storeKey);
  return {
    ...payload,
    status: job.status,
    claimToken: token,
    accountEmail: account?.email,
    // O comprador escolhe Pix da loja × cartão salvo por aqui (15/09).
    paymentKind: account?.paymentKind,
  };
}
// Desafio humano da loja no clique final (15/09, primeiro pedido real da Cobasi): o comprador
// NUNCA resolve. Avisa o dono uma vez por tentativa; ele resolve na janela do Mac e o mesmo
// fluxo segue. Não mexe no estado do job: a compra continua em `submitting` até o Pix ou o
// vencimento normal, que já vira `outcome_unknown` com revisão.
export async function reportHumanChallenge(
  jobId: string,
  workerId: string,
  token: string,
  waitMinutes: number,
) {
  const job = await prisma.$transaction(async (tx) => {
    const current = await owned(tx, jobId, workerId, token);
    if (!["claimed", "submitting", "pix_captured"].includes(current.status))
      throw new Error("Compra pausada ou encerrada.");
    return tx.purchaseJob.update({ where: { id: current.id }, data: { lockedAt: new Date() } });
  });
  const already = await prisma.purchaseAttempt.findFirst({
    where: { purchaseJobId: jobId, step: "human_challenge", createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
  });
  if (already) return { ok: true as const, notified: false as const };
  await prisma.purchaseAttempt.create({
    data: {
      purchaseJobId: jobId,
      step: "human_challenge",
      status: "completed",
      idempotencyKey: randomUUID(),
      details: { workerId, waitMinutes },
    },
  });
  await notifyOperator(
    copy.operatorHumanChallenge(job.deliveryOrderId.slice(-6).toUpperCase(), job.storeLabel, waitMinutes),
  );
  return { ok: true as const, notified: true as const };
}
export async function purchaseHeartbeat(
  jobId: string,
  workerId: string,
  token: string,
) {
  return prisma.$transaction(async (tx) => {
    const job = await owned(tx, jobId, workerId, token);
    if (
      !["claimed", "awaiting_approval", "approved", "submitting", "pix_captured"].includes(
        job.status,
      )
    )
      throw new Error("Compra pausada ou encerrada.");
    const updated = await tx.purchaseJob.update({
      where: { id: job.id },
      data: { lockedAt: new Date() },
    });
    return {
      status: updated.status,
      checkoutHash: updated.checkoutHash,
      approvalExpiresAt: updated.approvalExpiresAt,
    };
  });
}
export async function stageCheckout(
  jobId: string,
  workerId: string,
  token: string,
  e: CheckoutEvidence,
) {
  const base = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  const staged = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await owned(tx, jobId, workerId, token);
    if (!["claimed", "awaiting_approval", "approved"].includes(job.status))
      throw new Error("Não é possível substituir uma conferência já aprovada.");
    const order = await funding(tx, job.deliveryOrderId);
    checkCheckout(order, e);
    const account = await tx.purchaseAccount.findUnique({
      where: { storeKey: job.storeKey },
    });
    if (
      !account?.enabled || !account.loginReady || !account.paymentReady ||
      account.email?.trim().toLowerCase() !==
        e.accountEmail.trim().toLowerCase()
    )
      throw new Error("Checkout não está na conta operacional configurada.");
    const digest = checkoutDigest(e);
    const automaticReason = await automaticPurchaseDecision(tx, job.storeKey, e.totalCents);
    if (!automaticReason) {
      await tx.purchaseJob.update({
        where: { id: job.id },
        data: {
          status: "approved", checkoutEvidence: e, checkoutHash: digest,
          checkoutExpiresAt: new Date(Date.now() + 120_000),
          approvalStatus: "approved", approvedBy: AUTO_PURCHASE_POLICY,
          approvedAt: new Date(), approvalCartHash: digest,
          approvalMaxTotal: e.totalCents / 100,
          approvalExpiresAt: new Date(Date.now() + 60_000), lockedAt: new Date(),
          lastErrorCode: null, lastErrorMessage: null,
        },
      });
      return { checkoutHash: digest, notify: false, readyToSubmit: true };
    }
    if (
      job.status === "approved" &&
      job.approvedBy !== AUTO_PURCHASE_POLICY &&
      job.approvalStatus === "approved" &&
      job.approvalCartHash === digest
    ) {
      // O tempo curto é da leitura atual da loja, nunca da resposta do operador.
      await tx.purchaseJob.update({
        where: { id: job.id },
        data: {
          checkoutEvidence: e,
          checkoutExpiresAt: new Date(Date.now() + 120_000),
          approvalExpiresAt: new Date(Date.now() + 60_000),
          lockedAt: new Date(),
        },
      });
      return { checkoutHash: digest, notify: false, readyToSubmit: true };
    }

    await tx.purchaseJob.update({
      where: { id: job.id },
      data: {
        status: "awaiting_approval",
        checkoutEvidence: e,
        checkoutHash: digest,
        checkoutExpiresAt: null,
        approvalStatus: "requested",
        approvalCartHash: null,
        approvedBy: null,
        approvedAt: null,
        approvalExpiresAt: null,
        lockedAt: new Date(),
        lastErrorMessage: automaticReason,
      },
    });
    return {
      checkoutHash: digest,
      readyToSubmit: false,
      notify: job.status !== "awaiting_approval" || job.checkoutHash !== digest,
      reason: automaticReason,
    };
  });
  if (staged.notify) {
    // Exceção "acima do teto/loja sem liberação" por um toque (11/09): Autorizar = a
    // mesma aprovação individual do painel; Estornar = compra não realizada.
    const action = await prisma.$transaction((tx) => createOpsAction(tx, {
      kind: "over_limit", purchaseJobId: jobId, deliveryOrderId: base.deliveryOrderId,
      payload: { checkoutHash: staged.checkoutHash, totalCents: e.totalCents },
    }));
    await sendOperatorButtons(
      action,
      copy.operatorOverLimit(base.deliveryOrderId.slice(-6).toUpperCase(), e.totalCents, staged.reason ?? ""),
      [{ choice: "approve", title: "Autorizar" }, { choice: "refund", title: "Estornar" }],
    );
  }
  return {
    checkoutHash: staged.checkoutHash,
    readyToSubmit: staged.readyToSubmit,
  };
}

export async function approveCheckout(jobId: string, hash: string) {
  const base = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await tx.purchaseJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    if (
      job.status !== "awaiting_approval" ||
      !hash ||
      job.checkoutHash !== hash
    )
      throw new Error("O carrinho mudou. Confira o resumo atualizado.");
    const order = await funding(tx, job.deliveryOrderId);
    const evidence = parseStoredEvidence(job.checkoutEvidence);
    checkCheckout(order, { ...evidence, observedAt: new Date().toISOString() });
    return tx.purchaseJob.update({
      where: { id: jobId },
      data: {
        status: "approved",
        approvalStatus: "approved",
        approvedBy: "ops_session",
        approvedAt: new Date(),
        approvalExpiresAt: null,
        approvalCartHash: hash,
        approvalMaxTotal: evidence.totalCents / 100,
      },
    });
  });
}
// Só chamado após o navegador esvaziar o próprio carrinho e fechar o perfil.
// O pedido/aprovação ficam persistidos; outra compra pode usar a conta enquanto espera.
export async function parkCheckout(
  jobId: string,
  workerId: string,
  token: string,
) {
  const base = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await owned(tx, jobId, workerId, token);
    if (
      !["awaiting_approval", "approved"].includes(job.status) ||
      job.submissionId
    )
      throw new Error("Não é possível liberar esta compra.");
    await tx.purchaseJob.update({
      where: { id: jobId },
      data: {
        lockedAt: null,
        browserSessionId: null,
        claimToken: null,
        approvalExpiresAt: null,
      },
    });
    return { ok: true };
  });
}
export async function beginPurchase(
  jobId: string,
  workerId: string,
  token: string,
  evidence: CheckoutEvidence,
) {
  if (process.env.LIA_PURCHASE_SUBMIT_OFF === "true")
    throw new Error("Finalização de compras pausada.");
  const base = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await owned(tx, jobId, workerId, token);
    const order = await funding(tx, job.deliveryOrderId);
    checkCheckout(order, evidence);
    const account = await tx.purchaseAccount.findUnique({
      where: { storeKey: job.storeKey },
    });
    if (
      !account?.enabled ||
      !account.loginReady ||
      !account.paymentReady ||
      account.email?.trim().toLowerCase() !==
        evidence.accountEmail.trim().toLowerCase()
    )
      throw new Error("Conta da loja pausada.");
    if (
      job.status !== "approved" ||
      job.submissionId ||
      job.approvalStatus !== "approved" ||
      !job.approvalExpiresAt ||
      job.approvalExpiresAt < new Date() ||
      checkoutDigest(evidence) !== job.approvalCartHash
    )
      throw new Error("Não há autorização atual para este checkout.");
    // Uma trava GLOBAL serializa a decisão e a reserva entre todas as lojas/processos.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('lia-purchase-daily-budget'))::text`;
    const now = new Date();
    if (job.approvedBy === AUTO_PURCHASE_POLICY) {
      const reason = await automaticPurchaseDecision(tx, job.storeKey, evidence.totalCents, now);
      if (reason) {
        await tx.purchaseJob.update({ where: { id: job.id }, data: {
          status: "awaiting_approval", approvalStatus: "requested", approvedBy: null,
          approvedAt: null, approvalCartHash: null, approvalExpiresAt: null,
          lastErrorMessage: reason,
        } });
        return { submissionId: null, reviewRequired: true, reason };
      }
    }
    const submissionId = randomUUID();
    // Inclusive aprovação individual consome o orçamento. Falha, estorno ou resultado
    // desconhecido não devolvem limite automaticamente nem apagam esta reserva.
    await tx.purchaseSpend.create({ data: {
      submissionId, purchaseJobId: job.id, budgetDay: purchaseBudgetDay(now),
      amountCents: evidence.totalCents, authorization: job.approvedBy ?? "ops_session",
    } });
    await tx.purchaseJob.update({
      where: { id: job.id },
      data: {
        status: "submitting",
        submissionId,
        submitStartedAt: new Date(),
        lockedAt: new Date(),
      },
    });
    await tx.purchaseAttempt.create({
      data: {
        purchaseJobId: job.id,
        step: "submit",
        status: "started",
        idempotencyKey: submissionId,
      },
    });
    return { submissionId };
  });
  if (result.reviewRequired)
    await notifyOperator(`Pedido #${base.deliveryOrderId.slice(-6).toUpperCase()}: ${result.reason} Confira no painel de operações.`);
  return result;
}
// Fechamento por API recusado pela loja ANTES de criar pedido (25/09: ex. `403 CHK0082`
// reCAPTCHA, `400 ORD007` documento). Nada foi criado nem pago: libera a reserva de
// orçamento e devolve o job para revisão com o motivo. Nunca chamado após `transaction` 200.
export async function abortSubmissionBeforeOrder(
  jobId: string, workerId: string, token: string, submissionId: string, code: string, message: string,
) {
  return prisma.$transaction(async (tx) => {
    const job = await owned(tx, jobId, workerId, token);
    if (job.status !== "submitting" || job.submissionId !== submissionId) throw new Error("Tentativa não corresponde à reserva.");
    await tx.purchaseSpend.updateMany({ where: { submissionId, status: "reserved" }, data: { status: "released", releasedAt: new Date(), releaseNote: `loja recusou antes do pedido: ${code}`.slice(0, 200) } });
    await tx.purchaseAttempt.updateMany({ where: { purchaseJobId: job.id, idempotencyKey: submissionId }, data: { status: "rejected", errorCode: code.slice(0, 80), errorMessage: message.slice(0, 500), completedAt: new Date() } });
    return tx.purchaseJob.update({ where: { id: job.id }, data: {
      status: "needs_review", lastErrorCode: code.slice(0, 80), lastErrorMessage: message.slice(0, 500),
      lockedAt: null, browserSessionId: null, claimToken: null,
    } });
  });
}
// Comprador no servidor (sem navegador segurando o modal): quando o recebedor é novo, o
// copia-e-cola fica guardado na tentativa para o toque "Pagar e memorizar" pagar sozinho.
export async function rememberPixCodeForOwnerApproval(jobId: string, submissionId: string, code: string) {
  return prisma.purchaseAttempt.upsert({
    where: { purchaseJobId_idempotencyKey: { purchaseJobId: jobId, idempotencyKey: `pix-code:${submissionId}` } },
    create: { purchaseJobId: jobId, step: "pix_code", status: "held", idempotencyKey: `pix-code:${submissionId}`, details: { code } },
    update: { details: { code } },
  });
}
export async function heldPixCode(jobId: string): Promise<string | null> {
  const job = await prisma.purchaseJob.findUnique({ where: { id: jobId }, select: { submissionId: true } });
  if (!job?.submissionId) return null;
  const attempt = await prisma.purchaseAttempt.findUnique({ where: { purchaseJobId_idempotencyKey: { purchaseJobId: jobId, idempotencyKey: `pix-code:${job.submissionId}` } } });
  const code = (attempt?.details as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}
export async function executionUnknown(
  jobId: string,
  workerId: string,
  token: string,
  code: string,
) {
  // Nunca tornar resultado desconhecido elegível para nova execução. A conta permanece reservada.
  const result = await prisma.purchaseJob.updateMany({
    where: {
      id: jobId,
      browserSessionId: workerId,
      claimToken: token,
      status: {
        in: ["claimed", "awaiting_approval", "approved", "submitting"],
      },
    },
    data: {
      status: "outcome_unknown",
      lastErrorCode: code.slice(0, 80),
      lastErrorMessage:
        "Confira carrinho e histórico da loja antes de liberar a conta.",
    },
  });
  if (!result.count) throw new Error("Reserva inválida.");
  await notifyOperator(
    `Compra interrompida (${code.slice(0, 80)}). Confira o histórico e o carrinho da loja antes de tentar novamente: ${(process.env.LIA_PUBLIC_URL ?? "https://liadelivery.com.br").replace(/\/$/, "")}/ops. Nenhuma nova tentativa será feita automaticamente.`,
  );
}
export async function finishPurchase(
  jobId: string,
  workerId: string,
  token: string,
  input: {
    submissionId: string;
    storeOrderNumber: string;
    actualTotalCents: number;
    trackingUrl?: string;
  },
) {
  const job = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  if (
    job.browserSessionId !== workerId ||
    !token ||
    job.claimToken !== token ||
    job.submissionId !== input.submissionId ||
    !["submitting", "outcome_unknown", "completed", "pix_submitted", "pix_paid", "store_confirmed"].includes(job.status)
  )
    throw new Error("Comprovante não pertence à tentativa.");
  const e = parseStoredEvidence(job.checkoutEvidence);
  if (input.actualTotalCents !== e.totalCents)
    throw new Error("Valor do comprovante diverge do checkout aprovado.");
  return recordDeliveryEvent(job.deliveryOrderId, {
    kind: "bought",
    source: "operator",
    sourceReference: `purchase:${job.submissionId}`,
    storeOrderNumber: input.storeOrderNumber,
    trackingUrl: input.trackingUrl,
    purchaseExecution: {
      jobId: job.id,
      submissionId: input.submissionId,
      actualTotal: input.actualTotalCents / 100,
    },
  });
}

// ---------- Mercado Livre, degrau C (11/09) ----------
// O comprador local monta o carrinho na conta da Lia e para. O dono confirma no app do
// celular (saldo Mercado Pago) e responde o número do pedido. Nenhum clique de compra é
// do robô; o teto e a reserva de orçamento valem do mesmo jeito (canal owner_confirm).
export async function requestOwnerConfirm(
  jobId: string,
  workerId: string,
  token: string,
  e: CheckoutEvidence,
) {
  const base = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  const shortId = base.deliveryOrderId.slice(-6).toUpperCase();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await owned(tx, jobId, workerId, token);
    if (job.status !== "claimed") throw new Error("Carrinho já encaminhado ou encerrado.");
    if (job.storeKey !== MERCADO_LIVRE_STORE_KEY || e.payment.kind !== "ml_balance")
      throw new Error("Confirmação do dono é só para o Mercado Livre com saldo Mercado Pago.");
    const order = await funding(tx, job.deliveryOrderId);
    checkCheckout(order, e);
    const account = await tx.purchaseAccount.findUnique({ where: { storeKey: job.storeKey } });
    if (
      !account?.enabled || !account.loginReady || !account.paymentReady || account.paymentKind !== "ml_balance" ||
      account.email?.trim().toLowerCase() !== e.accountEmail.trim().toLowerCase()
    )
      throw new Error("Conta do Mercado Livre não está pronta para saldo Mercado Pago.");
    const digest = checkoutDigest(e);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('lia-purchase-daily-budget'))::text`;
    const now = new Date();
    const reason = await automaticPurchaseDecision(tx, job.storeKey, e.totalCents, now, "owner_confirm");
    if (reason) {
      await tx.purchaseJob.update({ where: { id: job.id }, data: {
        status: "needs_review", checkoutEvidence: e, checkoutHash: digest, lastErrorCode: "OWNER_CONFIRM_BLOCKED",
        lastErrorMessage: reason, lockedAt: null, browserSessionId: null, claimToken: null,
      } });
      return { ok: false as const, reason };
    }
    const submissionId = randomUUID();
    await tx.purchaseSpend.create({ data: {
      submissionId, purchaseJobId: job.id, budgetDay: purchaseBudgetDay(now),
      amountCents: e.totalCents, authorization: "owner_confirm",
    } });
    const action = await createOpsAction(tx, {
      kind: "ml_cart_ready", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId,
      payload: { totalCents: e.totalCents, items: e.items.map((i) => `${i.qty}× ${i.name}`), recipientName: e.recipientName, destination: e.destination },
    }, now);
    await tx.purchaseJob.update({ where: { id: job.id }, data: {
      status: "awaiting_owner_confirm", checkoutEvidence: e, checkoutHash: digest, checkoutExpiresAt: null,
      submissionId, submitStartedAt: now, approvalStatus: "requested", approvalCartHash: digest,
      approvalMaxTotal: e.totalCents / 100, approvedBy: null, approvedAt: null, approvalExpiresAt: null,
      lockedAt: null, browserSessionId: null, claimToken: null, lastErrorCode: null, lastErrorMessage: null,
    } });
    await tx.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "owner_confirm", status: "requested", idempotencyKey: submissionId } });
    return { ok: true as const, action, summary: { items: e.items.map((i) => `${i.qty}× ${i.name}`), recipient: e.recipientName, destination: e.destination, totalCents: e.totalCents } };
  });
  if (!result.ok) {
    await notifyOperator(copy.operatorMlBlocked(shortId, result.reason));
    return { ok: false as const, reason: result.reason };
  }
  const sent = await sendOperatorButtons(
    result.action,
    copy.operatorMlCartReady(shortId, result.summary.totalCents, result.summary.items, result.summary.recipient, result.summary.destination),
    [{ choice: "bought", title: "Comprei" }, { choice: "failed", title: "Não deu" }],
  );
  return { ok: true as const, actionId: result.action.id, sent };
}

// "Comprei": o dono tocou; falta o número do pedido (próxima mensagem numérica ou /ops).
export async function ownerConfirmCartBought(jobId: string, actionId: string) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== "awaiting_owner_confirm") throw new Error("Este carrinho não está aguardando confirmação.");
    await createOpsAction(tx, { kind: "await_store_number", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId, payload: { from: actionId } });
    await tx.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "owner_confirm", status: "confirmed", idempotencyKey: `owner-bought:${actionId}` } });
    return tx.purchaseJob.update({ where: { id: job.id }, data: { status: "awaiting_store_number", ownerConfirmedAt: new Date() } });
  });
}

// "Não deu": vai para revisão. A reserva de orçamento NÃO é liberada sozinha (11/09).
export async function ownerDeclineCart(jobId: string, actionId: string) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!["awaiting_owner_confirm", "awaiting_store_number"].includes(job.status)) throw new Error("Este carrinho não está aguardando confirmação.");
    await cancelPendingActions(tx, job.id, ["ml_cart_ready", "await_store_number"]);
    await tx.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "owner_confirm", status: "declined", idempotencyKey: `owner-declined:${actionId}` } });
    return tx.purchaseJob.update({ where: { id: job.id }, data: {
      status: "needs_review", lastErrorCode: "OWNER_DECLINED",
      lastErrorMessage: "O dono não concluiu a compra no app. Confira o carrinho do Mercado Livre antes de liberar.",
    } });
  });
}

// Número do pedido do ML: registra a compra (evento bought) e fecha o job.
export async function ownerStoreNumber(jobId: string, storeOrderNumber: string, actionId: string) {
  const number = storeOrderNumber.replace(/\D/g, "");
  if (number.length < 6 || number.length > 20) throw new Error("Número do pedido do Mercado Livre inválido.");
  const job = await prisma.$transaction(async (tx) => {
    const current = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
    // ML (carrinho com o dono) ou VTEX+Pix pago sem comprovante lido: o número vem do dono.
    if (!["awaiting_owner_confirm", "awaiting_store_number", "pix_paid", "store_confirmed"].includes(current.status) || !current.submissionId)
      throw new Error("Este carrinho não está aguardando o número do pedido.");
    await cancelPendingActions(tx, current.id, ["ml_cart_ready", "await_store_number"]);
    return tx.purchaseJob.update({ where: { id: current.id }, data: { ownerConfirmedAt: current.ownerConfirmedAt ?? new Date() } });
  });
  const e = parseStoredEvidence(job.checkoutEvidence);
  await recordDeliveryEvent(job.deliveryOrderId, {
    kind: "bought",
    source: "operator",
    sourceReference: `ml-owner:${actionId}`,
    storeOrderNumber: number,
    purchaseExecution: { jobId: job.id, submissionId: job.submissionId!, actualTotal: e.totalCents / 100 },
  });
  return prisma.purchaseJob.findUniqueOrThrow({ where: { id: job.id } });
}

// ---------- VTEX + Pix da loja pago pela Lia (Fase 3, 11/09) ----------
// O comprador clicou em finalizar (beginPurchase já reservou o orçamento) e capturou o
// copia-e-cola. Aqui: CRC, valor exato, cobrança dinâmica, recebedor na allowlist da loja.
// Recebedor novo pede um toque do dono; aprovado → pagamento ÚNICO por API bancária.
const PIX_SETTLE_STATUSES = ["pix_submitted", "pix_paid", "store_confirmed"];
// `issuedByStoreApi`: o código veio direto da API de checkout da loja para ESTE pedido (não de
// tela raspada). Aí também vale a cobrança no formato chave + valor + txid, que é como o
// Mercado Pago (adquirente da Mambo, 28/09) emite o Pix de cada pedido: sem URL em 26-25.
// Exige valor embutido igual ao conferido e txid real; o pagamento continua sendo do valor
// exato, único, e o recebedor continua na allowlist da loja. Liberado pelo dono em 28/09.
export function storeChargeAccepted(emv: ReturnType<typeof parsePixEmv>, issuedByStoreApi: boolean) {
  if (emv.dynamic) return true;
  return issuedByStoreApi && emv.amountCents != null && Boolean(emv.txid && emv.txid.length >= 8);
}
export async function capturePix(jobId: string, workerId: string, token: string, submissionId: string, code: string, opts: { issuedByStoreApi?: boolean } = {}) {
  if (process.env.LIA_PURCHASE_SUBMIT_OFF === "true") throw new Error("Finalização de compras pausada.");
  const provider = pixOutProvider();
  const emv = parsePixEmv(code);
  if (!emv.valid) throw new Error(`Copia-e-cola inválido (${emv.reason ?? "formato"}).`);
  const storeCharge = !emv.dynamic && storeChargeAccepted(emv, Boolean(opts.issuedByStoreApi));
  if (!emv.dynamic && !storeCharge) throw new Error(`Só pagamos cobrança Pix dinâmica gerada pelo checkout (recebido: chave ${emv.pixKey ? "sim" : "não"}, valor ${emv.amountCents ?? "—"}, txid ${emv.txid ?? "—"}).`);
  const decoded = await provider.decode(code.trim());
  const base = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  const shortId = base.deliveryOrderId.slice(-6).toUpperCase();
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await owned(tx, jobId, workerId, token);
    if (job.status !== "submitting" || job.submissionId !== submissionId) throw new Error("Captura fora da tentativa autorizada.");
    const e = parseStoredEvidence(job.checkoutEvidence);
    if (e.payment.kind !== "pix_store") throw new Error("Este checkout não é Pix da loja.");
    const amount = decoded.amountCents ?? emv.amountCents;
    // Cobrança da loja em formato chave+valor: o banco pode marcar "valor alterável", mas o
    // valor embutido já foi conferido e a Lia paga exatamente ele.
    if (amount !== e.totalCents || (emv.amountCents != null && emv.amountCents !== e.totalCents) || (decoded.canBePaidWithDifferentValue && !storeCharge))
      throw new Error(`Valor do Pix não bate com o checkout conferido (Pix ${amount ?? "—"}, conferido ${e.totalCents}).`);
    if (decoded.type !== "dynamic" && !storeCharge) throw new Error("Só pagamos cobrança Pix dinâmica.");
    if (!/^\d{11}$|^\d{14}$/.test(decoded.receiverDoc)) throw new Error("Recebedor do Pix sem documento legível.");
    const existing = await tx.pixPayout.findUnique({ where: { purchaseJobId: job.id } });
    if (existing) throw new Error("Já existe um pagamento para esta compra; nunca pagar duas vezes.");
    const receiver = await tx.purchaseReceiver.upsert({
      where: { storeKey_receiverDoc: { storeKey: job.storeKey, receiverDoc: decoded.receiverDoc } },
      create: { storeKey: job.storeKey, receiverDoc: decoded.receiverDoc, receiverName: decoded.receiverName || emv.merchantName },
      update: {},
    });
    if (receiver.status === "blocked") {
      await tx.purchaseJob.update({ where: { id: job.id }, data: { status: "needs_review", lastErrorCode: "RECEIVER_BLOCKED", lastErrorMessage: "Recebedor do Pix bloqueado para esta loja." } });
      return { kind: "blocked" as const };
    }
    const payout = await tx.pixPayout.create({ data: {
      purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId, provider: provider.name, idempotencyKey: `payout:${submissionId}`,
      amountCents: e.totalCents, codeHash: pixCodeHash(code), txid: emv.txid, receiverDoc: decoded.receiverDoc,
      receiverName: receiver.receiverName, expiresAt: decoded.expiresAt ? new Date(decoded.expiresAt) : null,
    } });
    await tx.purchaseJob.update({ where: { id: job.id }, data: { status: "pix_captured", lockedAt: new Date() } });
    await tx.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "pix_capture", status: "captured", idempotencyKey: `pix-capture:${submissionId}`, details: { receiverDoc: decoded.receiverDoc, txid: emv.txid } } });
    // Recebedor novo de um Pix emitido pela API de checkout da própria loja, com CNPJ: entra na
    // allowlist sozinho (dono aprovou em 28/09: "quero comprar automático"). O dono é avisado e
    // pode bloquear. Pix raspado de tela (worker) ou recebedor pessoa física pedem o toque.
    let autoApproved = false;
    if (receiver.status === "pending" && opts.issuedByStoreApi && /^\d{14}$/.test(decoded.receiverDoc)) {
      await tx.purchaseReceiver.update({ where: { id: receiver.id }, data: { status: "approved", approvedBy: "auto:store-api", approvedAt: new Date() } });
      autoApproved = true;
    }
    if (receiver.status !== "approved" && !autoApproved) {
      const action = await createOpsAction(tx, { kind: "receiver_new", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId, payload: { receiverName: receiver.receiverName, receiverDoc: decoded.receiverDoc, amountCents: e.totalCents } });
      return { kind: "receiver_new" as const, action, receiver, payout };
    }
    return { kind: "pay" as const, payout, autoApproved, receiverName: receiver.receiverName, receiverDoc: decoded.receiverDoc };
  });
  if (outcome.kind === "blocked") return { status: "blocked" as const };
  if (outcome.kind === "receiver_new") {
    await sendOperatorButtons(outcome.action, copy.operatorReceiverNew(shortId, outcome.receiver.receiverName, outcome.receiver.receiverDoc, outcome.payout.amountCents), [{ choice: "pay", title: "Pagar e memorizar" }, { choice: "refuse", title: "Recusar" }]);
    return { status: "awaiting_receiver" as const, payoutId: outcome.payout.id };
  }
  if (outcome.autoApproved)
    await notifyOwner(`🤖 Recebedor novo aprovado sozinho (#${shortId}, ${base.storeKey}): ${outcome.receiverName} · CNPJ ${outcome.receiverDoc}. Pix emitido pela API da loja; para bloquear, use o /ops.`).catch(() => undefined);
  return executePixPayout(outcome.payout.id, code);
}

// Chamada bancária ÚNICA. O EMV só existe aqui, em memória; timeout = unknown + humano.
async function executePixPayout(payoutId: string, code: string) {
  const provider = pixOutProvider();
  const claimed = await prisma.pixPayout.updateMany({ where: { id: payoutId, status: "created" }, data: { status: "submitting", submittedAt: new Date() } });
  if (!claimed.count) throw new Error("Pagamento já iniciado; nunca repetir.");
  const payout = await prisma.pixPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (pixCodeHash(code) !== payout.codeHash) throw new Error("Copia-e-cola difere do capturado.");
  await prisma.purchaseJob.update({ where: { id: payout.purchaseJobId }, data: { status: "pix_submitted", lockedAt: new Date() } });
  try {
    const result = await provider.pay({ code, amountCents: payout.amountCents, idempotencyKey: payout.id, description: `Lia #${payout.deliveryOrderId.slice(-6).toUpperCase()}` });
    const status = result.status === "paid" ? "paid" : result.status === "refused" ? "refused" : "submitted";
    await prisma.pixPayout.update({ where: { id: payout.id }, data: { status, providerPayoutId: result.providerPayoutId, endToEndId: result.endToEndId ?? undefined, settledAt: status === "paid" ? new Date() : null } });
    await prisma.purchaseReceiver.updateMany({ where: { storeKey: (await prisma.purchaseJob.findUniqueOrThrow({ where: { id: payout.purchaseJobId } })).storeKey, receiverDoc: payout.receiverDoc }, data: { lastUsedAt: new Date(), timesUsed: { increment: 1 } } });
    await applyPayoutStatus(payout.id, status, result.endToEndId ?? null);
    return { status, payoutId: payout.id };
  } catch (error) {
    const timeout = error instanceof PixOutTimeout;
    await prisma.pixPayout.update({ where: { id: payout.id }, data: { status: timeout ? "unknown" : "failed", lastError: (error instanceof Error ? error.message : "falha").slice(0, 300) } });
    if (timeout) {
      // Pode ter saído dinheiro. Nunca segunda chamada: humano concilia pelo extrato.
      await prisma.purchaseJob.update({ where: { id: payout.purchaseJobId }, data: { status: "outcome_unknown", lastErrorCode: "PIX_OUT_TIMEOUT", lastErrorMessage: "Banco não respondeu ao pagamento do Pix; conferir extrato antes de qualquer nova tentativa." } });
      await notifyOperator(copy.operatorPixTimeout(payout.deliveryOrderId.slice(-6).toUpperCase()));
      return { status: "unknown" as const, payoutId: payout.id };
    }
    await applyPayoutStatus(payout.id, "refused", null, error instanceof Error ? error.message : undefined);
    return { status: "refused" as const, payoutId: payout.id };
  }
}

async function applyPayoutStatus(payoutId: string, status: "submitted" | "paid" | "refused" | "expired", endToEndId: string | null, reason?: string) {
  const payout = await prisma.pixPayout.findUniqueOrThrow({ where: { id: payoutId } });
  const job = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: payout.purchaseJobId } });
  const shortId = payout.deliveryOrderId.slice(-6).toUpperCase();
  if (status === "paid") {
    await prisma.pixPayout.update({ where: { id: payoutId }, data: { status: "paid", endToEndId: endToEndId ?? payout.endToEndId, settledAt: payout.settledAt ?? new Date() } });
    if (["pix_submitted", "pix_captured"].includes(job.status)) await prisma.purchaseJob.update({ where: { id: job.id }, data: { status: "pix_paid", lockedAt: new Date() } });
    return;
  }
  if (status === "refused" || status === "expired") {
    await prisma.pixPayout.update({ where: { id: payoutId }, data: { status, lastError: reason?.slice(0, 300) } });
    if (!["needs_review", "completed", "canceled"].includes(job.status)) {
      await prisma.purchaseJob.update({ where: { id: job.id }, data: { status: "needs_review", lastErrorCode: status === "expired" ? "PIX_OUT_EXPIRED" : "PIX_OUT_REFUSED", lastErrorMessage: reason?.slice(0, 200) ?? "Pagamento do Pix recusado pelo banco." } });
      const action = await prisma.$transaction((tx) => createOpsAction(tx, { kind: "pix_failed", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId, payload: { reason: reason ?? status } }));
      await sendOperatorButtons(action, copy.operatorPixFailed(shortId, reason ?? status), [{ choice: "retry", title: "Refazer" }, { choice: "refund", title: "Estornar" }]);
    }
  }
}

// Recebedor novo aprovado pelo dono → memoriza e paga (uma vez). Recusado → revisão.
export async function approveReceiverAndPay(jobId: string, code: string, by = "ops_session") {
  const job = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  const payout = await prisma.pixPayout.findUniqueOrThrow({ where: { purchaseJobId: jobId } });
  if (job.status !== "pix_captured" || payout.status !== "created") throw new Error("Pagamento não está aguardando o recebedor.");
  await prisma.purchaseReceiver.updateMany({ where: { storeKey: job.storeKey, receiverDoc: payout.receiverDoc, status: "pending" }, data: { status: "approved", approvedBy: by, approvedAt: new Date() } });
  return executePixPayout(payout.id, code);
}
export async function refuseReceiver(jobId: string, by = "ops_session") {
  const job = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  const payout = await prisma.pixPayout.findUniqueOrThrow({ where: { purchaseJobId: jobId } });
  if (job.status !== "pix_captured" || payout.status !== "created") throw new Error("Pagamento não está aguardando o recebedor.");
  await prisma.purchaseReceiver.updateMany({ where: { storeKey: job.storeKey, receiverDoc: payout.receiverDoc }, data: { status: "blocked", approvedBy: by } });
  await prisma.pixPayout.update({ where: { id: payout.id }, data: { status: "refused", lastError: "recebedor recusado pelo dono" } });
  return prisma.purchaseJob.update({ where: { id: job.id }, data: { status: "needs_review", lastErrorCode: "RECEIVER_REFUSED", lastErrorMessage: "Recebedor do Pix recusado pelo dono; conferir a loja." } });
}

// O navegador pergunta o estado do pagamento enquanto segura o modal do Pix aberto.
export async function pixPayoutStatus(jobId: string, workerId: string, token: string, submissionId: string) {
  const job = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.browserSessionId !== workerId || job.claimToken !== token || job.submissionId !== submissionId) throw new Error("Reserva inválida.");
  const payout = await prisma.pixPayout.findUnique({ where: { purchaseJobId: jobId } });
  if (!payout) return { status: "none" as const, jobStatus: job.status };
  if (payout.status === "submitted" && payout.providerPayoutId) await settlePayout(payout.id);
  const fresh = await prisma.pixPayout.findUniqueOrThrow({ where: { id: payout.id } });
  await prisma.purchaseJob.updateMany({ where: { id: jobId, status: { in: ["pix_captured", "pix_submitted", "pix_paid"] } }, data: { lockedAt: new Date() } });
  return { status: fresh.status, jobStatus: (await prisma.purchaseJob.findUniqueOrThrow({ where: { id: jobId } })).status, endToEndId: fresh.endToEndId };
}

async function settlePayout(payoutId: string) {
  const payout = await prisma.pixPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status !== "submitted" || !payout.providerPayoutId) return;
  const status = await pixOutProvider().status(payout.providerPayoutId);
  if (status.status === "paid") await applyPayoutStatus(payoutId, "paid", status.endToEndId ?? null);
  else if (status.status === "refused" || status.status === "expired") await applyPayoutStatus(payoutId, status.status, null, status.reason);
}

// Cron: concilia pagamentos enviados e avisa loja em silêncio depois do Pix pago.
export async function settlePixPayouts(now = new Date()) {
  const report = { settled: 0, silent: 0, errors: [] as string[] };
  if (!process.env.LIA_PIX_OUT_PROVIDER) return report;
  const pending = await prisma.pixPayout.findMany({ where: { status: "submitted", providerPayoutId: { not: null }, submittedAt: { lt: new Date(now.getTime() - 20_000) } }, take: 50 });
  for (const payout of pending) {
    try { await settlePayout(payout.id); report.settled += 1; } catch (error) { report.errors.push(`payout ${payout.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const minutes = Number(process.env.LIA_PIX_STORE_CONFIRM_MIN ?? 30);
  const silent = await prisma.purchaseJob.findMany({ where: { status: "pix_paid", updatedAt: { lt: new Date(now.getTime() - minutes * 60_000) } }, take: 50 });
  for (const job of silent) {
    const open = await prisma.opsAction.findFirst({ where: { purchaseJobId: job.id, kind: "store_silent", status: "pending" } });
    if (open) continue;
    const action = await prisma.$transaction((tx) => createOpsAction(tx, { kind: "store_silent", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId }));
    await sendOperatorButtons(action, copy.operatorStoreSilent(job.deliveryOrderId.slice(-6).toUpperCase(), minutes), [{ choice: "confirm", title: "Confirmar" }, { choice: "refund", title: "Estornar" }]);
    report.silent += 1;
  }
  return report;
}

// "Refazer" após Pix recusado: libera a reserva daquela tentativa e volta à fila.
export async function retryAfterPixFailure(jobId: string, by = "ops_session") {
  return prisma.$transaction(async (tx) => {
    const job = await tx.purchaseJob.findUniqueOrThrow({ where: { id: jobId } });
    const payout = await tx.pixPayout.findUnique({ where: { purchaseJobId: jobId } });
    if (job.status !== "needs_review" || !payout || !["refused", "expired", "failed"].includes(payout.status)) throw new Error("Só é possível refazer depois de um Pix recusado ou vencido.");
    if (job.submissionId) await tx.purchaseSpend.updateMany({ where: { submissionId: job.submissionId, status: "reserved" }, data: { status: "released", releasedAt: new Date(), releaseNote: `pix ${payout.status}; refazer por ${by}` } });
    await tx.pixPayout.delete({ where: { id: payout.id } });
    await tx.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "pix_retry", status: "requested", idempotencyKey: `pix-retry:${payout.id}`, details: { by, previous: payout.providerPayoutId } } });
    return tx.purchaseJob.update({ where: { id: job.id }, data: {
      status: "queued", submissionId: null, submitStartedAt: null, lockedAt: null, claimToken: null, browserSessionId: null,
      checkoutEvidence: Prisma.JsonNull, checkoutHash: null, approvalStatus: "not_requested", approvalCartHash: null, approvalExpiresAt: null, approvedAt: null, lastErrorCode: null, lastErrorMessage: null,
    } });
  });
}

// A confirmação humana é auditada. Não libera uma sessão ainda ativa no navegador.
export async function reconcileEmptyPurchase(jobId: string, note: string) {
  const base = await prisma.purchaseJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${base.deliveryOrderId} FOR UPDATE`;
    const job = await tx.purchaseJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    if (
      !["outcome_unknown", "needs_review"].includes(job.status) ||
      (job.lockedAt && job.lockedAt.getTime() > Date.now() - 120_000)
    )
      throw new Error(
        "Encerre o comprador e aguarde dois minutos antes de liberar.",
      );
    const order = await tx.deliveryOrder.findUniqueOrThrow({
      where: { id: job.deliveryOrderId },
    });
    if (order.storeOrderNumber)
      throw new Error(
        "Compra já registrada; não liberar para outra tentativa.",
      );
    await tx.purchaseAttempt.create({
      data: {
        purchaseJobId: job.id,
        step: "reconcile_empty",
        status: "completed",
        idempotencyKey: randomUUID(),
        details: {
          operator: "ops_session",
          note: note.slice(0, 500),
          previousSubmissionId: job.submissionId,
        },
      },
    });
    return tx.purchaseJob.update({
      where: { id: jobId },
      data: {
        status: order.status === "paid" ? "queued" : "canceled",
        lockedAt: null,
        browserSessionId: null,
        claimToken: null,
        submissionId: null,
        submitStartedAt: null,
        checkoutEvidence: Prisma.JsonNull,
        checkoutHash: null,
        checkoutExpiresAt: null,
        approvalStatus: "not_requested",
        approvalCartHash: null,
        approvalExpiresAt: null,
        approvedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });
}
