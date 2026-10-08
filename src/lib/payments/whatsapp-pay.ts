import { orderHasMedicine } from "@/lib/medicine-orders";
import { prisma } from "@/lib/prisma";
import { whatsappAdapter, type PaymentConfirmation, type WhatsAppOrderDetailsInput } from "@/lib/adapters/whatsapp";
import { checkoutAdapter } from "@/lib/payments/mercadopago";
import { pagarmeAdapter } from "@/lib/payments/pagarme";
import * as copy from "@/lib/lia-copy";

const ATTEMPT_TTL_MS = 60 * 60 * 1000;
import { displayPrice } from "@/lib/pricing";

type CardOrder = {
  id: string;
  userId: string;
  phone: string;
  total: number;
  deliveryFee: number;
  // Opcionais (pedidos antigos/testes podem não trazer): com os dois, o que não está nos itens exibidos
  // nem no frete soma na entrega (nunca uma linha de taxa).
  itemsSubtotal?: number;
  serviceFee?: number;
  items: unknown;
  status: string;
};

type StoredBasketItem = {
  sku?: string;
  name?: string;
  qty?: number;
  lineTotal?: number;
};

function money(value: number) {
  return Math.round(Number(value.toFixed(2)) * 100) / 100;
}

function toCents(value: number) {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function fromCents(value: number) {
  return value / 100;
}

function normalizedPhone(value?: string | null) {
  return (value ?? "").replace(/\D/g, "").replace(/^55/, "");
}

function samePhone(left?: string | null, right?: string | null) {
  const a = normalizedPhone(left);
  const b = normalizedPhone(right);
  return Boolean(a && b && a === b);
}

function paymentFeatureEnabled() {
  return process.env.LIA_ENABLE_WA_PAYMENTS === "true" && process.env.WHATSAPP_PROVIDER === "meta" && pagarmeAdapter.isAvailable();
}

// Cartão salvo SEM a Payments API da Meta (que segue em beta fechado): mesma
// tokenização/cobrança Pagar.me, mas a recompra é confirmada por botões comuns do
// WhatsApp em vez do order_details nativo. Flag independente para o sandbox validar
// antes de ligar em produção.
function savedCardModeEnabled() {
  return process.env.LIA_ENABLE_SAVED_CARD === "true" && pagarmeAdapter.isAvailable();
}

// Qualquer modo de cartão salvo ativo (nativo Meta OU botões comuns). É o gate único
// para buscar credencial e oferecer o cadastro do cartão — chave Pagar.me configurada
// sem flag nenhuma NÃO pode mudar o caminho de checkout sozinha.
export function cardOnFileEnabled() {
  return paymentFeatureEnabled() || savedCardModeEnabled();
}

function basketItems(items: unknown): StoredBasketItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is StoredBasketItem => {
    return Boolean(item) && typeof item === "object" && typeof (item as StoredBasketItem).name === "string";
  });
}

function orderDetailsInput(order: CardOrder, credential: { id: string; last4: string }): WhatsAppOrderDetailsInput {
  const detailedItems = basketItems(order.items)
    .map((item, index) => {
      const quantity = Math.max(1, Math.floor(Number(item.qty ?? 1)));
      const rawLineTotal = Number(item.lineTotal ?? 0);
      const rawUnit = rawLineTotal > 0 ? rawLineTotal / quantity : 0;
      return {
        retailerId: String(item.sku ?? `${order.id}-${index + 1}`),
        name: String(item.name),
        quantity,
        unitAmount: money(displayPrice(rawUnit))
      };
    })
    .filter((item) => item.unitAmount > 0);
  const items = detailedItems.length
    ? detailedItems
    : [{ retailerId: order.id, name: "Pedido Lia", quantity: 1, unitAmount: money(order.total - order.deliveryFee) }];
  const subtotal = money(items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0));
  // Taxa da Lia nunca vira linha (dono, 08/10 noite): o que o pedido cobra além dos itens exibidos e do
  // frete (taxa fixa do remédio; a margem com LIA_PRICING_MODE=service_fee) soma na entrega, como no resumo
  // — em "tax" pareceria imposto. "tax" fica só com a taxa da maquininha (total − base do pedido).
  const base = order.itemsSubtotal != null ? money(order.itemsSubtotal + (order.serviceFee ?? 0) + order.deliveryFee) : null;
  const shipping = detailedItems.length && base != null ? money(Math.max(order.deliveryFee, base - subtotal)) : money(order.deliveryFee);
  // Any line rounding difference is absorbed in the disclosed card fee so Meta's
  // invariant remains exact: subtotal + shipping + tax = total.
  const tax = money(order.total - subtotal - shipping);
  if (tax < 0) throw new Error("Payment order total is lower than its itemized total");

  return {
    referenceId: "",
    body: copy.orderDetailsBody(order.total, credential.last4),
    // Meta only echoes this opaque identifier in its confirmation. Keep the PSP
    // card ID inside our backend so changing provider never changes the WhatsApp
    // contract or exposes an unnecessary gateway identifier to the client.
    credentialId: credential.id,
    last4: credential.last4,
    total: order.total,
    subtotal,
    shipping,
    tax,
    items
  };
}

export async function getOneClickCredential(userId: string) {
  if (!cardOnFileEnabled()) return null;
  return prisma.paymentCredential.findFirst({
    where: { userId, provider: "pagarme", status: "active" },
    orderBy: { createdAt: "desc" }
  });
}

// Todos os cartões salvos ativos (pedido do dono, 26/08: dava pra guardar vários mas a
// Lia só oferecia o mais recente — agora o cliente escolhe pelo número).
export async function listOneClickCredentials(userId: string) {
  return prisma.paymentCredential.findMany({
    where: { userId, provider: "pagarme", status: "active" },
    orderBy: { createdAt: "desc" },
    take: 5
  });
}

export async function isOneClickAvailable(userId: string) {
  return Boolean(await getOneClickCredential(userId));
}

export async function expireOpenPaymentAttempts(deliveryOrderId: string) {
  await prisma.paymentAttempt.updateMany({
    where: { deliveryOrderId, status: "pending" },
    data: { status: "expired", error: "Replaced by a newer payment attempt" }
  });
}

export async function getConfirmedPaymentAttempt(deliveryOrderId: string) {
  return prisma.paymentAttempt.findFirst({
    where: { deliveryOrderId, status: "confirmed", expiresAt: { gt: new Date() } },
    orderBy: { confirmedAt: "desc" }
  });
}

// Guarda de cancelamento/reabertura: uma tentativa CONFIRMADA (cliente tocou "Pagar",
// workflow cobrando) bloqueia qualquer saída de awaiting_payment — sem o filtro de
// expiresAt, porque uma cobrança de desfecho desconhecido não deixa de existir aos
// 60 min (revisão 01/09).
export async function hasInFlightCardAttempt(deliveryOrderId: string) {
  return Boolean(await prisma.paymentAttempt.findFirst({ where: { deliveryOrderId, status: "confirmed" }, select: { id: true } }));
}

export async function createCardAttempt(order: CardOrder, credential: { id: string; last4: string }) {
  if (order.status !== "awaiting_payment") throw new Error("Can only send a card attempt for an awaiting payment order");
  if (await getConfirmedPaymentAttempt(order.id)) {
    throw new Error("A card payment is already being processed for this order");
  }
  await expireOpenPaymentAttempts(order.id);
  const attempt = await prisma.paymentAttempt.create({
    data: {
      deliveryOrderId: order.id,
      credentialId: credential.id,
      amountCents: toCents(order.total),
      expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS)
    }
  });
  try {
    // Remédio isento (29/09): nada de order_details (pagamento nativo da Meta) — cai nos botões.
    if (paymentFeatureEnabled() && !(await orderHasMedicine(order.id))) {
      const input = orderDetailsInput(order, credential);
      await whatsappAdapter.sendOrderDetailsCard(order.phone, { ...input, referenceId: attempt.id });
      return attempt;
    }
    // Modo cartão salvo sem Meta Payments: botões comuns. O toque volta como
    // `cardpay:<attemptId>` e só então a cobrança acontece — o envio não cobra nada.
    const interactive = await whatsappAdapter.sendSavedCardButtons(order.phone, {
      attemptId: attempt.id,
      last4: credential.last4,
      total: order.total
    });
    if (!interactive) {
      await whatsappAdapter.sendMessage(order.phone, copy.savedCardOffer(order.total, credential.last4));
    }
    // Mais de um cartão salvo: lista os outros com número — responder "2" troca o
    // cartão da cobrança (26/08; o botão continua cobrando o oferecido).
    const others = (await listOneClickCredentials(order.userId)).filter((c) => c.id !== credential.id);
    if (others.length) {
      await whatsappAdapter.sendMessage(
        order.phone,
        copy.savedCardMoreOptions(others.map((c, i) => ({ index: i + 2, last4: c.last4, brand: c.brand ?? undefined })))
      );
    }
    return attempt;
  } catch (error) {
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Unable to send card confirmation" }
    });
    throw error;
  }
}

async function sendOrderStatus(
  phone: string,
  referenceId: string,
  input: { body: string; orderStatus?: "processing" | "canceled"; paymentStatus: "captured" | "failed" }
): Promise<boolean> {
  try {
    if (paymentFeatureEnabled()) {
      await whatsappAdapter.sendOrderStatus(phone, { referenceId, ...input });
      return true;
    }
    // Sem a Payments API nativa não existe mensagem de order_status: o desfecho vai
    // como texto comum, com o mesmo conteúdo.
    await whatsappAdapter.sendMessage(phone, input.body);
    return true;
  } catch (error) {
    // Payment state is authoritative. Retrying Meta's notification must never retry
    // the card charge, which is protected separately by Pagar.me idempotency.
    console.error("[whatsapp-pay:order-status]", error);
    return false;
  }
}

async function sendCardFallback(order: CardOrder, last4: string) {
  let link;
  try {
    link = await checkoutAdapter.createLink({
      orderId: order.id,
      amount: order.total,
      description: `Lia · pedido ${order.id.slice(-6)}`,
      method: "card"
    });
  } catch (error) {
    // Mercado Pago fora do ar (com credencial real, não existe link mock). A recusa em
    // si já foi avisada logo acima e o texto dela ("responde *pix*, ou *cartão*") é a
    // saída — só o link novo é que não sai agora.
    console.error("[whatsapp-pay:card-fallback:link-failed]", order.id, error instanceof Error ? error.message : error);
    return;
  }
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { pixId: link.preferenceId, pixCopiaECola: link.initPoint }
  });
  await whatsappAdapter.sendMessage(order.phone, `${copy.cardChargeFailed(last4)}\n\n${copy.cardInstructions(order.total, link.initPoint, link.mock)}`);
}

type ClaimResult =
  | { claimed: true; attemptId: string }
  | { claimed: false; handled: boolean; reason: "unknown_attempt" | "credential_mismatch" | "phone_mismatch" | "expired" | "duplicate" };

// The claim is deliberately separated from the PSP call. The durable workflow can
// retry a crashed charge step with the same idempotency key without re-accepting a
// second Meta tap.
export async function claimPaymentConfirmation(confirmation: PaymentConfirmation): Promise<ClaimResult> {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: confirmation.referenceId },
    include: { deliveryOrder: true, credential: true }
  });
  if (!attempt) {
    console.warn("[whatsapp-pay:unknown-attempt]", confirmation.referenceId);
    return { claimed: false, handled: false, reason: "unknown_attempt" };
  }
  if (confirmation.credentialId && confirmation.credentialId !== attempt.credentialId) {
    console.warn("[whatsapp-pay:credential-mismatch]", { attemptId: attempt.id, credentialId: confirmation.credentialId });
    return { claimed: false, handled: false, reason: "credential_mismatch" };
  }
  if (confirmation.last4 && confirmation.last4 !== attempt.credential.last4) {
    console.warn("[whatsapp-pay:last4-mismatch]", { attemptId: attempt.id, last4: confirmation.last4 });
    return { claimed: false, handled: false, reason: "credential_mismatch" };
  }
  if (confirmation.phone && !samePhone(confirmation.phone, attempt.deliveryOrder.phone)) {
    console.warn("[whatsapp-pay:phone-mismatch]", { attemptId: attempt.id });
    return { claimed: false, handled: false, reason: "phone_mismatch" };
  }

  const order = attempt.deliveryOrder;
  if (attempt.expiresAt <= new Date() || order.status !== "awaiting_payment") {
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: { in: ["pending", "confirmed"] } },
      data: { status: "expired", error: "Payment confirmation arrived after the order expired or changed state" }
    });
    await sendOrderStatus(order.phone, attempt.id, {
      body: copy.cardAttemptExpired(),
      orderStatus: "canceled",
      paymentStatus: "failed"
    });
    return { claimed: false, handled: false, reason: "expired" };
  }

  const claimed = await prisma.paymentAttempt.updateMany({
    where: { id: attempt.id, status: "pending" },
    data: { status: "confirmed", confirmedAt: new Date() }
  });
  if (claimed.count !== 1) return { claimed: false, handled: true, reason: "duplicate" };
  return { claimed: true, attemptId: attempt.id };
}

async function markAttemptCaptured(attemptId: string, provider: { orderId?: string; chargeId?: string }) {
  const changed = await prisma.paymentAttempt.updateMany({
    where: { id: attemptId, status: "confirmed" },
    data: {
      status: "charged",
      providerPaymentId: provider.chargeId ?? provider.orderId,
      providerOrderId: provider.orderId,
      providerChargeId: provider.chargeId,
      error: null
    }
  });
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { deliveryOrder: true, credential: true }
  });
  if (!attempt) return { handled: false };
  // UMA confirmação só (dono, 04/09: "me deu duas msgs"): o status nativo atualiza o
  // card de pagamento e já leva o texto de confirmado; markDeliveryOrderPaid não repete.
  let statusSent = false;
  if (changed.count === 1) {
    statusSent = await sendOrderStatus(attempt.deliveryOrder.phone, attempt.id, {
      body: copy.paymentConfirmed(),
      orderStatus: "processing",
      paymentStatus: "captured"
    });
  }
  const { markDeliveryOrderPaid } = await import("@/lib/delivery-service");
  // Com evidência: um cartão capturado em pedido que já saiu de awaiting_payment (ops
  // cancelou, cliente reabriu no exato instante) vira nota + alerta, não silêncio.
  await markDeliveryOrderPaid(
    attempt.deliveryOrderId,
    {
      provider: "pagarme",
      paymentId: provider.chargeId ?? provider.orderId ?? null,
      amount: fromCents(attempt.amountCents)
    },
    { notifyCustomer: !statusSent }
  );
  return { handled: true, charged: true };
}

async function markAttemptFailed(attemptId: string, error: string | undefined) {
  const changed = await prisma.paymentAttempt.updateMany({
    where: { id: attemptId, status: "confirmed" },
    data: { status: "failed", error: error?.slice(0, 700) ?? "Saved card was declined" }
  });
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { deliveryOrder: true, credential: true }
  });
  if (!attempt) return { handled: false };
  if (changed.count === 1) {
    await sendOrderStatus(attempt.deliveryOrder.phone, attempt.id, {
      body: copy.cardChargeFailed(attempt.credential.last4),
      paymentStatus: "failed"
    });
    await sendCardFallback(attempt.deliveryOrder, attempt.credential.last4);
  }
  return { handled: true, charged: false };
}

export async function chargeConfirmedPaymentAttempt(attemptId: string) {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { deliveryOrder: true, credential: true }
  });
  if (!attempt) return { handled: false, reason: "unknown_attempt" as const };
  if (attempt.status !== "confirmed") return { handled: true, duplicate: true as const };
  // Última checagem ANTES do PSP (revisão 01/09): o claim conferiu o pedido, mas o
  // step de cobrança roda depois (retries de até 5×30s) — se o pedido saiu de
  // awaiting_payment ou o total mudou nesse meio-tempo, não se cobra o cartão.
  const liveOrder = await prisma.deliveryOrder.findUnique({
    where: { id: attempt.deliveryOrderId },
    select: { status: true, total: true }
  });
  if (!liveOrder || liveOrder.status !== "awaiting_payment" || attempt.amountCents !== toCents(liveOrder.total)) {
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: "confirmed" },
      data: { status: "expired", error: "Order left awaiting_payment (or its total changed) before the charge was captured" }
    });
    console.warn("[whatsapp-pay:charge-skipped:order-changed]", { attemptId: attempt.id, status: liveOrder?.status });
    return { handled: true, expired: true as const };
  }

  const charge = await pagarmeAdapter.chargeSavedCard({
    orderId: attempt.deliveryOrderId,
    attemptId: attempt.id,
    amountCents: attempt.amountCents,
    customerId: attempt.credential.providerCustomerId,
    cardId: attempt.credential.providerCardId,
    description: `Lia · pedido ${attempt.deliveryOrderId.slice(-6)}`
  });

  if (charge.status === "captured") {
    return markAttemptCaptured(attempt.id, { orderId: charge.providerOrderId, chargeId: charge.providerChargeId });
  }
  if (charge.status === "pending") {
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerOrderId: charge.providerOrderId, providerChargeId: charge.providerChargeId, providerPaymentId: charge.providerChargeId ?? charge.providerOrderId }
    });
    return { handled: true, pending: true as const };
  }
  if (charge.status === "unavailable") {
    // Do not replace a potentially accepted payment with a Checkout Pro fallback.
    // The durable step retries the same attempt id, and Pagar.me returns the same
    // order for its Idempotency-Key once the original request completes.
    await prisma.paymentAttempt.updateMany({
      where: { id: attempt.id, status: "confirmed" },
      data: { error: charge.error?.slice(0, 700) ?? "Pagar.me temporarily unavailable" }
    });
    throw new Error(`Pagar.me charge outcome is unknown for attempt ${attempt.id}`);
  }
  return markAttemptFailed(attempt.id, charge.error);
}

// Used in unit tests and as a safe synchronous fallback. Production webhooks start
// the durable workflow defined in src/workflows/charge-whatsapp-card.ts instead.
export async function handlePaymentConfirmation(confirmation: PaymentConfirmation) {
  const claim = await claimPaymentConfirmation(confirmation);
  if (!claim.claimed) return { handled: claim.handled, reason: claim.reason };
  return chargeConfirmedPaymentAttempt(claim.attemptId);
}

export async function reconcilePagarmeOrder(input: { providerOrderId?: string; attemptId?: string }) {
  const attempt = input.attemptId
    ? await prisma.paymentAttempt.findUnique({ where: { id: input.attemptId } })
    : input.providerOrderId
      ? await prisma.paymentAttempt.findFirst({ where: { providerOrderId: input.providerOrderId } })
      : null;
  if (!attempt) return { handled: false, reason: "unknown_attempt" as const };
  const providerOrderId = attempt.providerOrderId ?? input.providerOrderId;
  if (!providerOrderId) return { handled: false, reason: "missing_provider_order" as const };
  const charge = await pagarmeAdapter.getOrder(providerOrderId);
  if (charge.status === "captured") return markAttemptCaptured(attempt.id, { orderId: charge.providerOrderId, chargeId: charge.providerChargeId });
  if (charge.status === "declined") return markAttemptFailed(attempt.id, charge.error);
  return { handled: true, pending: true as const };
}

// Desfecho desconhecido (revisão 02/09): retries esgotados, ou 1h sem id do provedor.
// Antes a tentativa ficava `confirmed` para sempre e ninguém era avisado; o cliente ouvia
// "Cobrando no cartão…" e depois silêncio. Não cobra de novo, não expira: marca, anota
// no pedido e alerta o operador, que confere no painel Pagar.me.
export async function reportCardChargeOutcomeUnknown(attemptId: string, detail: string) {
  const changed = await prisma.paymentAttempt.updateMany({
    where: { id: attemptId, status: "confirmed" },
    data: { status: "unknown_outcome", error: detail.slice(0, 700) }
  });
  if (changed.count !== 1) return { flagged: false };
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptId }, select: { deliveryOrderId: true } });
  if (attempt) {
    const { flagCardOutcomeUnknown } = await import("@/lib/delivery-service");
    await flagCardOutcomeUnknown(attempt.deliveryOrderId, attemptId, detail);
  }
  return { flagged: true };
}

export function attemptTotal(attempt: { amountCents: number }) {
  return fromCents(attempt.amountCents);
}

// Última tentativa pendente de um pedido — resolve o toque "usar cartão" por texto,
// quando o cliente responde sem o id do botão.
export async function findPendingSavedCardAttempt(deliveryOrderId: string) {
  return prisma.paymentAttempt.findFirst({
    where: { deliveryOrderId, status: "pending", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { credential: true }
  });
}

// Toque no botão "Pagar •••• 1234" (modo sem Meta Payments). Mesmo contrato do webhook
// nativo: o workflow durável faz claim + cobrança idempotente; se o control plane
// estiver indisponível, uma tentativa síncrona única cobre o caso (idempotência
// Pagar.me pelo attemptId protege contra replay). Em teste, vai direto no síncrono.
export async function confirmSavedCardTap(attemptId: string, phone: string) {
  const confirmation: PaymentConfirmation = { referenceId: attemptId, phone, status: "captured" };
  if (process.env.NODE_ENV === "production") {
    try {
      const { startWhatsAppCardChargeWorkflow } = await import("@/lib/payments/whatsapp-pay-dispatch");
      const runId = await startWhatsAppCardChargeWorkflow(confirmation);
      return { started: true as const, runId };
    } catch (error) {
      console.error("[whatsapp-pay:saved-card-workflow-start]", error);
    }
  }
  const result = await handlePaymentConfirmation(confirmation);
  return { started: false as const, result };
}
