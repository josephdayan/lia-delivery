import { orderHasMedicine } from "@/lib/medicine-orders";
import type { Prisma } from "@prisma/client";
// Dinheiro do pedido (revisão 02/09): emissão de Pix/cartão, troca de método,
// cartão salvo, saída de awaiting_payment, evidência de pagamento e marcação de pago.
import { whatsappAdapter } from "@/lib/adapters/whatsapp";
import { Intent } from "@/lib/lia-intents";
import { AWAITING_OPERATOR_QUOTE_STATUS, PAID_OR_IN_FULFILLMENT_STATUSES, appendOrderNote, isCardCharge, paymentNote, withPaymentNote } from "@/lib/order-flags";
import { createCardEnrollmentSession, isCardEnrollmentAvailable } from "@/lib/payments/card-enrollment";
import { recordPayment } from "@/lib/payments/ledger";
import { PaymentProviderError, cancelMercadoPagoPayment, checkoutAdapter, pixAdapter } from "@/lib/payments/mercadopago";
import { cardOnFileEnabled, confirmSavedCardTap, createCardAttempt as createCardAttemptRaw, expireOpenPaymentAttempts, findPendingSavedCardAttempt, getConfirmedPaymentAttempt, getOneClickCredential, hasInFlightCardAttempt } from "@/lib/payments/whatsapp-pay";
import { prisma } from "@/lib/prisma";
import { preflightBasket } from "./live-freight";
import { rehearsePurchase, type RehearsalFailure } from "./purchase/rehearsal";
import { pixOutReadiness } from "@/lib/payments/pix-out/readiness";
import { automaticPurchaseStores, MERCADO_LIVRE_STORE_KEY } from "@/lib/purchase-policy";
import * as copy from "@/lib/lia-copy";
import { BasketItem, DeliveryContext, cardTotal, roundMoney } from "./conversation-types";
import { addressOnlyCtx, markTurnReplied, mergeDecisionRequestFor, notifyOperator, readCtx, reply, resetConversationForClosedOrder, writeCtx, notifyOwner, operatorIsHired, withinOperatorHours } from "./turn-runtime";

// createCardAttempt envia os botões do cartão salvo DIRETO pelo adapter (fora do
// reply()) — sem esta marca a rede anti-silêncio achava o turno mudo e mandava
// "Me perdi aqui 😅" logo depois dos botões (caso real, 01/09 #GAS8P9).
export async function createCardAttempt(
  order: Parameters<typeof createCardAttemptRaw>[0],
  credential: Parameters<typeof createCardAttemptRaw>[1]
) {
  const attempt = await createCardAttemptRaw(order, credential);
  markTurnReplied();
  return attempt;
}

// Keep the store locked once the order has items from it.
// The card is entered exactly once in Pagar.me's tokenization form. Once stored, every
// later card payment is confirmed in-chat (Meta order_details when enabled, common
// reply buttons otherwise). Gated on cardOnFileEnabled: a configured Pagar.me key with
// no flag must never silently change the checkout path away from Checkout Pro.
export async function sendFirstCardEnrollment(order: { id: string; userId: string; phone: string; total: number }) {
  if (!cardOnFileEnabled() || !isCardEnrollmentAvailable()) return false;
  const enrollment = await createCardEnrollmentSession({ orderId: order.id, userId: order.userId });
  await reply(order.phone, copy.cardEnrollmentInstructions(order.total, enrollment.url, process.env.PAGARME_MOCK === "true"));
  return true;
}

// Toque em "Pagar •••• 1234" (ou o texto "usar cartão"). O attemptId do botão localiza a
// tentativa exata; a forma por texto resolve pela última pendente do pedido em aberto.
export async function handleSavedCardPay(phone: string, userId: string, attemptId?: string) {
  let resolved = attemptId;
  let last4: string | undefined;
  if (!resolved) {
    const order = await prisma.deliveryOrder.findFirst({
      where: { userId, status: "awaiting_payment" },
      orderBy: { createdAt: "desc" }
    });
    const pending = order ? await findPendingSavedCardAttempt(order.id) : null;
    if (!pending) {
      await reply(phone, copy.savedCardNothingPending());
      return;
    }
    resolved = pending.id;
    last4 = pending.credential.last4;
  }
  if (!last4) {
    // Toque no botão: só o attemptId vem. Responde "Cobrando…" aqui mesmo — em produção
    // o workflow durável devolve o desfecho FORA deste turno, e um turno mudo fazia a
    // rede anti-silêncio mandar "Me perdi aqui 😅" logo depois do toque (revisão 01/09).
    // Replay de tentativa já cobrada: nada a dizer, mas o turno conta como respondido.
    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: resolved }, include: { credential: true } });
    if (attempt?.status === "pending") last4 = attempt.credential?.last4;
  }
  if (last4) await reply(phone, copy.savedCardCharging(last4));
  else markTurnReplied();
  // Claim + cobrança idempotente acontecem no pipeline (workflow ou fallback síncrono);
  // o desfecho volta por mensagem própria (aprovado / recusado + fallback de link).
  await confirmSavedCardTap(resolved, phone);
}

// "Outro cartão": expira a cobrança pendente e manda um link novo de cadastro — o
// cartão anterior deixa de ser cobrado e a credencial é substituída no submit.
export async function handleSavedCardOther(phone: string, userId: string) {
  const order = await prisma.deliveryOrder.findFirst({
    where: { userId, status: "awaiting_payment" },
    orderBy: { createdAt: "desc" }
  });
  if (!order || !isCardCharge(order)) {
    await reply(phone, copy.savedCardNothingPending());
    return;
  }
  if (await getConfirmedPaymentAttempt(order.id)) {
    await reply(phone, copy.cardPaymentProcessing());
    return;
  }
  await expireOpenPaymentAttempts(order.id);
  if (await sendFirstCardEnrollment(order)) return;
  // Sem cadastro disponível → link Checkout Pro, o fallback permanente de cartão.
  let link;
  try {
    link = await checkoutAdapter.createLink({
      orderId: order.id,
      amount: order.total,
      description: `Lia · pedido ${order.id.slice(-6)}`,
      method: "card"
    });
  } catch (error) {
    await reportChargeIssueFailure(phone, order, error);
    return;
  }
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { pixId: link.preferenceId, pixCopiaECola: link.initPoint }
  });
  await reply(phone, copy.cardInstructions(order.total, link.initPoint, link.mock));
}

// Which payment method (if any) an intent unambiguously names.
export function methodFromIntent(intent: Intent): "pix" | "card" | undefined {
  if (intent.kind === "choose_payment") return intent.method;
  if (intent.kind === "pay") return intent.method;
  if (intent.kind === "number") return intent.value === 1 ? "pix" : intent.value === 2 ? "card" : undefined;
  return undefined;
}

// Mercado Pago com credencial real caiu na hora de emitir a cobrança. Com o fallback
// mock removido, o pedido fica SEM cobrança em vez de ganhar um Pix falso que o
// "paguei" aprovaria de graça. O pedido continua aguardando (o cliente repete
// *pix*/*cartão* e a Lia tenta de novo), a falha vira nota no /ops e o operador é
// avisado na hora. Nunca lança — a conversa não pode morrer por causa do aviso.
export async function reportChargeIssueFailure(
  phone: string,
  order: { id: string; notes?: string | null },
  error: unknown
) {
  const detail = error instanceof Error ? error.message.slice(0, 180) : "erro desconhecido";
  console.error("[payment:issue:failed]", order.id, detail);
  try {
    await prisma.deliveryOrder.update({
      where: { id: order.id },
      data: { notes: appendOrderNote(order.notes ?? null, `⚠️ Falha ao gerar a cobrança: ${detail}`) }
    });
  } catch (err) {
    console.error("[payment:issue:failed:note]", err);
  }
  await reply(phone, copy.paymentIssueFailed());
  await notifyOwner(copy.operatorPaymentFailedAlert(order.id.slice(-6).toUpperCase(), detail), phone);
}

// Emite a cobrança de um pedido JÁ criado e aguardando pagamento (Pix copia-e-cola ou
// link de cartão). Usada na criação e na RETENTATIVA — quando o Mercado Pago falha, o
// pedido fica sem `pixCopiaECola` e o próximo "pagar" volta aqui em vez de reenviar um
// código que não existe. Devolve false quando a cobrança não saiu (cliente já avisado).
export async function issueChargeForOrder(
  phone: string,
  order: {
    id: string;
    userId: string;
    phone: string;
    total: number;
    deliveryFee: number;
    items: unknown;
    status: string;
    notes?: string | null;
  },
  method: "pix" | "card",
  total: number
): Promise<boolean> {
  const description = `Lia · pedido ${order.id.slice(-6)}`;
  if (method === "card") {
    const credential = await getOneClickCredential(order.userId);
    if (credential) {
      try {
        await createCardAttempt(order, credential);
        return true;
      } catch (error) {
        // The order itself is already durable. If Meta refuses the native payload,
        // retain the well-tested Checkout Pro route instead of leaving it unpaid.
        console.warn("[whatsapp-pay:create:fallback-checkout]", error instanceof Error ? error.message : error);
      }
    }
    if (await sendFirstCardEnrollment(order)) return true;
    // Card → a Checkout Pro link (MP-hosted card page). Reuse the nullable columns:
    // pixId = preference id, pixCopiaECola = the link. Webhook reconciles by order id.
    let link;
    try {
      link = await checkoutAdapter.createLink({ orderId: order.id, amount: total, description, method: "card" });
    } catch (error) {
      await reportChargeIssueFailure(phone, order, error);
      return false;
    }
    await prisma.deliveryOrder.update({
      where: { id: order.id },
      data: { pixId: link.preferenceId, pixCopiaECola: link.initPoint }
    });
    await reply(phone, copy.cardInstructions(total, link.initPoint, link.mock));
    return true;
  }

  // Pix → the raw copia-e-cola generated ON THE SPOT, paid inside the bank app (no
  // leaving WhatsApp for a hosted page). Webhook reconciles by external_reference = order id.
  let charge;
  try {
    charge = await pixAdapter.createPix({ orderId: order.id, amount: total, description });
  } catch (error) {
    await reportChargeIssueFailure(phone, order, error);
    return false;
  }
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { pixId: charge.pixId, pixCopiaECola: charge.copiaECola }
  });
  // V2 (01/09, "veio os dois"): a bolha nativa vai PRIMEIRO; quando a Graph aceita,
  // ela substitui o texto de instruções e só o código sai depois (fallback universal
  // pra WhatsApp Web/cliente antigo — e o copia-e-cola precisa ser mensagem SOZINHA:
  // com prosa junto, não cola no banco). Bolha recusada → as duas mensagens de sempre.
  const bubbleSent = await maybeSendNativePixBubble(phone, order.id, charge.pixId, total, charge.copiaECola, charge.mock);
  if (!bubbleSent) await reply(phone, copy.pixInstructions(total, charge.mock));
  await reply(phone, charge.copiaECola);
  return true;
}

// Bolha nativa de pagamento (order_details + pix_dynamic_code): total e botão
// "Pagar com Pix" dentro do chat, como nos bots grandes. Experimento atrás de
// LIA_NATIVE_PIX=1 porque a doc da Meta não exige allowlist para Pix (o cartão
// One-Click exigia e foi negado em 08/2026) — só o teste real confirma. ADITIVA por
// desenho: sai DEPOIS dos textos de sempre, então se a Graph rejeitar (ou aceitar e
// descartar assíncrono, lição dos cards) o cliente já tem o copia-e-cola. Falha aqui
// NUNCA bloqueia a cobrança.
export async function maybeSendNativePixBubble(
  phone: string,
  orderId: string,
  pixId: string,
  total: number,
  pixCode: string,
  mock: boolean
): Promise<boolean> {
  if (process.env.LIA_NATIVE_PIX !== "1" || mock || !pixCode) return false;
  // Remédio isento (29/09): a Meta proíbe pagamento nativo para remédio — só o copia-e-cola.
  if (await orderHasMedicine(orderId)) return false;
  const merchantName = process.env.LIA_PIX_MERCHANT_NAME;
  const key = process.env.LIA_PIX_KEY;
  const keyType = process.env.LIA_PIX_KEY_TYPE;
  const validKeyType = keyType === "CPF" || keyType === "CNPJ" || keyType === "EMAIL" || keyType === "PHONE";
  if (!merchantName || !key || !validKeyType) {
    console.warn("[whatsapp:native-pix] flag ligada sem LIA_PIX_MERCHANT_NAME/LIA_PIX_KEY/LIA_PIX_KEY_TYPE — pulando bolha");
    return false;
  }
  const orderRef = `#${orderId.slice(-6).toUpperCase()}`;
  try {
    await whatsappAdapter.sendPixOrderDetails(phone, {
      // reference_id precisa ser único por bolha; o pixId do Mercado Pago é único por
      // cobrança (o mesmo pedido pode reemitir Pix ao trocar de forma de pagamento).
      referenceId: `pix-${pixId}`,
      body: copy.nativePixBody(orderRef),
      itemName: copy.nativePixItemName(orderRef),
      total,
      pixCode,
      merchantName,
      key,
      keyType
    });
    return true;
  } catch (error) {
    console.warn("[whatsapp:native-pix] bolha rejeitada, cliente segue com o texto:", error instanceof Error ? error.message : error);
    return false;
  }
}

// Re-send the open charge (card link or Pix code) for an awaiting_payment order.
export async function resendCharge(phone: string, order: {
  id: string;
  userId: string;
  phone: string;
  total: number;
  deliveryFee: number;
  items: unknown;
  status: string;
  notes?: string | null;
  pixCopiaECola?: string | null;
}) {
  if (isCardCharge(order)) {
    if (await getConfirmedPaymentAttempt(order.id)) {
      await reply(phone, copy.cardPaymentProcessing());
      return;
    }
    const credential = await getOneClickCredential(order.userId);
    if (credential) {
      await createCardAttempt(order, credential);
      return;
    }
    if (await sendFirstCardEnrollment(order)) return;
    // Sem link salvo = a emissão anterior falhou (Mercado Pago fora do ar). Emitir de
    // novo, em vez de reenviar um link vazio.
    if (!order.pixCopiaECola) {
      await issueChargeForOrder(phone, order, "card", order.total);
      return;
    }
    await reply(phone, copy.resendCard(order.pixCopiaECola));
    return;
  }
  if (!order.pixCopiaECola) {
    await issueChargeForOrder(phone, order, "pix", order.total);
    return;
  }
  // Pix: intro + código em mensagem SEPARADA — copiar a mensagem inteira tem que colar.
  await reply(phone, copy.resendPix());
  await reply(phone, order.pixCopiaECola);
}

// Anota um aviso do cliente (reclamação / pedido de humano) no pedido mais recente,
// pra aparecer no /ops. Nunca lança — é acessório da conversa.
export async function flagLatestOrder(userId: string, note: string) {
  try {
    const order = await prisma.deliveryOrder.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    if (!order) return;
    await prisma.deliveryOrder.update({
      where: { id: order.id },
      data: { notes: order.notes ? `${order.notes}\n${note}` : note }
    });
  } catch (err) {
    console.error("[flagLatestOrder]", err);
  }
}

// Cotação enviada/cobrança aberta + cliente pediu MUDANÇA na cesta: reabre o pedido
// (cancela a cotação/cobrança não paga), restaura a cesta no contexto e avisa — a
// edição segue no fluxo normal (28/08 S18: "adiciona um óleo" com o total na mesa
// batia no menu de pagamento em loop; troca e remoção idem).
export async function reopenOrderForEdit(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  userCep: string | null | undefined
): Promise<boolean> {
  if (!ctx.deliveryOrderId) return false;
  if (ctx.step !== "awaiting_quote_confirmation" && ctx.step !== "awaiting_payment" && ctx.step !== "choosing_freight") {
    return false;
  }
  const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
  if (!order) return false;
  let reopened = false;
  if (order.status === "awaiting_quote_confirmation" || order.status === "awaiting_supplier_validation") {
    reopened = await cancelPendingRetailerQuote(order.id);
  } else if (order.status === "awaiting_payment") {
    reopened = (await closeUnpaidOrder(order, "reaberto pelo cliente (ajuste na cesta)")) === "closed";
  } else if (order.status === AWAITING_OPERATOR_QUOTE_STATUS) {
    const updated = await prisma.deliveryOrder.updateMany({
      where: { id: order.id, status: AWAITING_OPERATOR_QUOTE_STATUS },
      data: { status: "canceled", notes: appendOrderNote(order.notes, "reaberto pelo cliente (ajuste na cesta antes da cotação)") }
    });
    reopened = updated.count > 0;
  }
  if (!reopened) return false;
  if (!ctx.basket?.length) {
    ctx.basket = ((order.items as unknown as BasketItem[]) ?? []).filter((i) => i.unitPrice > 0);
  }
  ctx.deliveryOrderId = undefined;
  ctx.freightChoice = undefined;
  ctx.step = "collecting";
  ctx.cep = ctx.cep ?? userCep ?? undefined;
  await writeCtx(convoId, ctx);
  await reply(phone, copy.orderReopened());
  return true;
}

export async function cancelPendingRetailerQuote(orderId: string): Promise<boolean> {
  const canceled = await prisma.deliveryOrder.updateMany({
    where: { id: orderId, status: { in: ["awaiting_supplier_validation", "awaiting_quote_confirmation"] } },
    data: { status: "canceled" }
  });
  if (!canceled.count) return false;
  await prisma.purchaseJob.updateMany({
    where: { deliveryOrderId: orderId, status: { in: ["preflight_queued", "preflighting", "cart_ready"] } },
    data: { status: "canceled", lastErrorCode: "QUOTE_CANCELED", lastErrorMessage: "Cotação cancelada antes do pagamento." }
  });
  return true;
}

// Volta a conversa pro menu de pagamento da cotação depois de uma falha ao emitir a
// cobrança: sem isso o contexto fica em awaiting_payment (passo do pedido já cobrado)
// enquanto o pedido voltou pra awaiting_quote_confirmation, e o cliente não consegue
// repetir *pix*/*cartão*.
export async function setQuoteConversationAwaitingConfirmation(order: { id: string; conversationId?: string | null }) {
  if (!order.conversationId) return;
  const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
  if (!convo) return;
  const ctx = readCtx(convo.context);
  if (ctx.deliveryOrderId === order.id) await writeCtx(convo.id, { ...ctx, step: "awaiting_quote_confirmation" });
}

export async function setQuoteConversationAwaitingPayment(order: { id: string; conversationId?: string | null }) {
  if (!order.conversationId) return;
  const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
  if (!convo) return;
  const ctx = readCtx(convo.context);
  if (ctx.deliveryOrderId === order.id) {
    await writeCtx(convo.id, { ...addressOnlyCtx(ctx), deliveryOrderId: order.id, step: "awaiting_payment", paymentIssuedAt: Date.now() });
  }
}

export type CloseUnpaidResult = "closed" | "card_processing" | "paid" | "gone";

// Saída ÚNICA de `awaiting_payment` sem dinheiro (cancelar, reabrir pra editar, juntar/
// pedido novo). Revisão 01/09: (1) guarda de status no próprio UPDATE — um Pix pago no
// mesmo instante não vira "cancelado" com paidAt preenchido; (2) cartão salvo já
// confirmado (workflow cobrando) BLOQUEIA — antes o cliente ouvia "nada foi cobrado" e o
// cartão era capturado em seguida num pedido cancelado; (3) a cobrança Pix antiga é
// cancelada no Mercado Pago (best-effort) pra bolha/código velho no chat não continuar
// pagável por 60 min.
export async function closeUnpaidOrder(
  order: { id: string; notes: string | null; pixId: string | null },
  note: string
): Promise<CloseUnpaidResult> {
  if (await hasInFlightCardAttempt(order.id)) return "card_processing";
  const closed = await prisma.deliveryOrder.updateMany({
    where: { id: order.id, status: "awaiting_payment" },
    data: { status: "canceled", notes: appendOrderNote(order.notes, note) }
  });
  if (closed.count === 0) {
    const now = await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { status: true, paidAt: true } });
    return now && (now.paidAt || PAID_OR_IN_FULFILLMENT_STATUSES.includes(now.status)) ? "paid" : "gone";
  }
  await expireOpenPaymentAttempts(order.id);
  await supersedePixCharge(order.pixId);
  return "closed";
}

// Cancela no provedor a cobrança Pix que deixou de valer. Nunca lança, nunca bloqueia.
export async function supersedePixCharge(pixId: string | null | undefined) {
  if (!pixId || !/^\d{1,20}$/.test(pixId)) return;
  try {
    const ok = await cancelMercadoPagoPayment(pixId);
    if (!ok) console.warn("[pix:supersede:not-cancelled]", pixId);
  } catch (error) {
    console.warn("[pix:supersede:failed]", pixId, error instanceof Error ? error.message : error);
  }
}

// `intro` (08/10 noite): texto próprio quando o motivo não é "a loja ficou sem o item" (cesta de 2 lojas, loja fora da API).
export type PreflightUnavailable = { storeKey: string; storeLabel: string; items: BasketItem[]; remaining: BasketItem[]; intro?: string };
// Ensaio da compra recusou a ENTREGA prometida, o endereço ou o PREÇO (08/10 noite): nada cobrado; a cesta
// inteira volta pro cliente e a Lia refaz a cotação na hora com o que a loja confirma de verdade.
export type DeliveryNotConfirmed = { storeKey: string; storeLabel: string; promise?: string; kind: Exclude<RehearsalFailure["kind"], "store" | "split">; basket: BasketItem[] };
export type ChargeBlock = { unavailable: PreflightUnavailable; note: string } | { deliveryNotConfirmed: DeliveryNotConfirmed; note: string; ownerAlert: string };

type ChargeableOrder = {
  id: string;
  phone: string;
  cep: string | null;
  deliveryAddress: string | null;
  customerName: string | null;
  buyerDocument: string | null;
  buyerName: string | null;
  items: unknown;
  fulfillments: unknown;
  itemsSubtotal: number;
  deliveryFee: number;
};

// O que impede de cobrar AGORA, consultando a loja de novo (nada gravado aqui — quem chama fecha o pedido
// com `note`). Dois degraus, os mesmos em toda cobrança (cotação aceita, troca de forma, Pix vencido):
// 1. Pré-voo (04/09): a simulação da loja, cesta inteira, para o CEP. "Não" definitivo = sem estoque/entrega.
// 2. ENSAIO DA COMPRA (08/10 noite, purchase/rehearsal.ts): os mesmos passos da compra automática, sem
//    fechar o pedido — entrega prometida, endereço, Pix e preço. Recusa da loja = nada é cobrado (o cliente
//    não paga pra depois receber estorno).
export async function findChargeBlock(order: ChargeableOrder): Promise<ChargeBlock | null> {
  const basket = ((order.items as unknown as BasketItem[]) ?? []).filter(Boolean);
  const failure = await preflightBasket(basket.map((i) => ({ sku: i.sku, qty: i.qty, storeKey: i.storeKey })), order.cep);
  if (failure) {
    const failed = basket.filter((i) => failure.skus.includes(i.sku));
    const storeLabel = failed[0]?.storeLabel ?? failure.storeKey;
    return {
      unavailable: { storeKey: failure.storeKey, storeLabel, items: failed, remaining: basket.filter((i) => !failure.skus.includes(i.sku)) },
      note: `🛫 PRÉ-VOO (${new Date().toISOString()}): ${storeLabel} ${failure.kind === "no-delivery" ? "sem entrega no CEP" : "sem estoque"} para ${failed.map((i) => i.name).join(", ")}. Nada cobrado; cliente redirecionado para alternativas.`
    };
  }
  const rehearsal = await rehearsePurchase({
    id: order.id,
    cep: order.cep,
    deliveryAddress: order.deliveryAddress,
    customerName: order.customerName,
    phone: order.phone,
    buyerDocument: order.buyerDocument,
    buyerName: order.buyerName,
    items: basket.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, storeKey: i.storeKey, storeLabel: i.storeLabel, unitPrice: i.unitPrice, ...(i.productUrl ? { productUrl: i.productUrl } : {}), ...(i.medicine ? { medicine: i.medicine } : {}) })),
    fulfillments: order.fulfillments,
    itemsSubtotal: order.itemsSubtotal,
    deliveryFee: order.deliveryFee
  }).catch((error) => {
    console.warn("[purchase-rehearsal:error]", order.id, error instanceof Error ? error.message : error);
    return null;
  });
  if (!rehearsal) return null;
  const note = `🎭 ENSAIO DA COMPRA (${new Date().toISOString()}): ${rehearsal.storeLabel} recusou (${rehearsal.kind}): ${rehearsal.detail}. Nada cobrado.`;
  if (rehearsal.kind === "items" || rehearsal.kind === "store" || rehearsal.kind === "split") {
    const failed = basket.filter((i) => rehearsal.skus.includes(i.sku));
    const remaining = basket.filter((i) => !rehearsal.skus.includes(i.sku));
    // Toda compra é por API: loja que a Lia não compra ou cesta de 2 lojas (a compra fecha uma loja por
    // pedido) nunca é cobrada — os itens saem e são procurados/fechados de novo.
    const intro = rehearsal.kind === "store"
      ? copy.storeNotPurchasable(rehearsal.storeLabel, failed.map((i) => i.name))
      : rehearsal.kind === "split"
        ? copy.oneStorePerOrder(rehearsal.storeLabel, remaining.map((i) => i.name), failed.map((i) => i.name))
        : undefined;
    return { unavailable: { storeKey: rehearsal.storeKey, storeLabel: rehearsal.storeLabel, items: failed, remaining, ...(intro ? { intro } : {}) }, note: rehearsal.kind === "items" ? note : `${note} (toda compra é por API — nunca fila manual)` };
  }
  const promise = Array.isArray(order.fulfillments)
    ? (order.fulfillments as Array<{ storeKey?: string; deliveryPromise?: string }>).filter((f) => !f?.storeKey || f.storeKey === rehearsal.storeKey).map((f) => f?.deliveryPromise).filter(Boolean).join(" · ") || undefined
    : undefined;
  return {
    deliveryNotConfirmed: { storeKey: rehearsal.storeKey, storeLabel: rehearsal.storeLabel, promise, kind: rehearsal.kind as DeliveryNotConfirmed["kind"], basket },
    note,
    ownerAlert: `🎭 Ensaio da compra barrou a cobrança: ${rehearsal.storeLabel} recusou (${rehearsal.kind}) — ${rehearsal.detail.slice(0, 160)}. Pedido ${order.id.slice(-6).toUpperCase()} NÃO foi cobrado.`
  };
}

// Cobrança JÁ aberta (awaiting_payment) que vai ser reemitida/reenviada (troca Pix↔cartão, Pix vencido,
// "manda de novo"): a loja é consultada de novo antes. Bloqueio = o pedido fecha sem dinheiro (a mesma
// saída única de `closeUnpaidOrder`, que respeita um pagamento chegando no mesmo instante) e o chamador
// devolve a lista ao cliente. null = pode seguir.
export async function recheckOpenCharge(order: ChargeableOrder & { status: string; notes: string | null; pixId: string | null }): Promise<ChargeBlock | null> {
  if (order.status !== "awaiting_payment") return null;
  const block = await findChargeBlock(order);
  if (!block) return null;
  const closed = await closeUnpaidOrder(order, block.note);
  if (closed !== "closed") return null;
  if ("ownerAlert" in block) await notifyOwner(block.ownerAlert, order.phone).catch(() => undefined);
  return block;
}

export async function issueValidatedRetailerQuotePayment(
  orderId: string,
  method: "pix" | "card"
): Promise<{ expired: boolean; unavailable?: PreflightUnavailable; pixOutDown?: boolean; deliveryNotConfirmed?: DeliveryNotConfirmed }> {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "awaiting_quote_confirmation") return { expired: false };
  if (!order.quoteExpiresAt || order.quoteExpiresAt.getTime() <= Date.now()) {
    await cancelPendingRetailerQuote(order.id);
    return { expired: true };
  }

  const basket = ((order.items as unknown as BasketItem[]) ?? []).filter(Boolean);
  const block = await findChargeBlock(order);
  if (block) {
    await prisma.deliveryOrder.updateMany({
      where: { id: order.id, status: "awaiting_quote_confirmation" },
      data: { status: "canceled", quoteExpiresAt: null, notes: [order.notes, block.note].filter(Boolean).join("\n") }
    });
    if ("unavailable" in block) return { expired: false, unavailable: block.unavailable };
    await notifyOwner(block.ownerAlert, order.phone).catch(() => undefined);
    return { expired: false, deliveryNotConfirmed: block.deliveryNotConfirmed };
  }

  // Trava do Pix de saída (06/10): loja de compra automática só é cobrada se a Lia
  // consegue pagar a loja agora. Senão, nada é cobrado e a cotação fica de pé.
  const auto = automaticPurchaseStores();
  const basketStores = [...new Set(basket.map((i) => i.storeKey))];
  if (basketStores.length && basketStores.every((k) => auto.includes(k) && k !== MERCADO_LIVRE_STORE_KEY)) {
    const ready = await pixOutReadiness(Math.round(order.total * 100));
    if (!ready.ok) {
      console.error("[pix-out:preflight-blocked]", order.id, ready.reason);
      if (!(order.notes ?? "").includes("PIX DE SAÍDA TRAVADO")) {
        await prisma.deliveryOrder.update({ where: { id: order.id }, data: { notes: appendOrderNote(order.notes, `⛔ PIX DE SAÍDA TRAVADO (${ready.reason}) — cliente NÃO foi cobrado.`) } });
        await notifyOwner(`⛔ Pix de saída travado (${ready.reason === "saldo" ? "saldo do Asaas menor que o pedido" : "Asaas recusando o Pix"}). Pedido ${order.id.slice(-6).toUpperCase()} de ${copy.brl(order.total)} NÃO foi cobrado — o cliente viu "não consigo finalizar agora".`, order.phone);
      }
      return { expired: false, pixOutDown: true };
    }
  }

  const isCard = method === "card";
  // Base SEM taxa de cartão, recomposta das partes: `order.total` pode ter ficado com o
  // gross-up de uma emissão de cartão que falhou (revisão 01/09 — o Pix seguinte saía
  // ~5% mais caro e um novo "cartão" aplicava a taxa duas vezes).
  const components = roundMoney(order.itemsSubtotal + order.serviceFee + order.deliveryFee);
  const base = components > 0 ? components : order.total;
  const total = isCard ? cardTotal(base) : base;
  const cardFee = roundMoney(total - base);
  const notes = withPaymentNote(order.notes, paymentNote(method, isCard ? copy.brl(cardFee) : undefined));
  const claimed = await prisma.deliveryOrder.updateMany({
    where: { id: order.id, status: "awaiting_quote_confirmation", quoteExpiresAt: { gt: new Date() } },
    data: { status: "payment_issuing", total, notes }
  });
  if (claimed.count !== 1) {
    const current = await prisma.deliveryOrder.findUnique({ where: { id: order.id }, select: { status: true } });
    return { expired: current?.status === "canceled" };
  }

  try {
    if (isCard) {
      const credential = await getOneClickCredential(order.userId);
      const awaitingPayment = await prisma.deliveryOrder.update({
        where: { id: order.id },
        data: { status: "awaiting_payment", pixId: null, pixCopiaECola: null, quoteExpiresAt: null }
      });
      await setQuoteConversationAwaitingPayment(order);
      if (credential) {
        try {
          await createCardAttempt(awaitingPayment, credential);
          return { expired: false };
        } catch (error) {
          console.warn("[retailer-quote:card:fallback-checkout]", error instanceof Error ? error.message : error);
        }
      }
      if (await sendFirstCardEnrollment(awaitingPayment)) return { expired: false };
      const link = await checkoutAdapter.createLink({ orderId: order.id, amount: total, description: `Lia · pedido ${order.id.slice(-6)}`, method: "card" });
      await prisma.deliveryOrder.update({ where: { id: order.id }, data: { pixId: link.preferenceId, pixCopiaECola: link.initPoint } });
      await reply(order.phone, copy.cardInstructions(total, link.initPoint, link.mock));
    } else {
      const charge = await pixAdapter.createPix({ orderId: order.id, amount: total, description: `Lia · pedido ${order.id.slice(-6)}` });
      await prisma.deliveryOrder.update({
        where: { id: order.id },
        data: { status: "awaiting_payment", pixId: charge.pixId, pixCopiaECola: charge.copiaECola, quoteExpiresAt: null }
      });
      await setQuoteConversationAwaitingPayment(order);
      const bubbleSent = await maybeSendNativePixBubble(order.phone, order.id, charge.pixId, total, charge.copiaECola, charge.mock);
      if (!bubbleSent) await reply(order.phone, copy.pixInstructions(total, charge.mock));
      await reply(order.phone, charge.copiaECola);
    }
    return { expired: false };
  } catch (error) {
    const rolledBack = await prisma.deliveryOrder.updateMany({
      where: { id: order.id, status: { in: ["payment_issuing", "awaiting_payment"] } },
      // `total` volta à base (a taxa do cartão só existe com cobrança de cartão) e a
      // validade da cotação volta junto: o caminho do cartão já tinha zerado
      // `quoteExpiresAt` antes de falhar, e o "pix" seguinte cancelava o pedido como
      // "preço vencido" (achado pelo E2E de 01/09).
      data: {
        status: "awaiting_quote_confirmation",
        total: base,
        quoteExpiresAt: order.quoteExpiresAt,
        notes: [notes, `⚠️ Falha ao emitir pagamento: ${error instanceof Error ? error.message.slice(0, 180) : "erro desconhecido"}`].filter(Boolean).join("\n")
      }
    });
    if (!rolledBack.count) return { expired: false };
    await setQuoteConversationAwaitingConfirmation(order);
    // Mercado Pago fora do ar: a cotação continua de pé (o TTL ainda vale), então o
    // cliente repete *pix*/*cartão* e a Lia tenta emitir de novo. Não relança — isso
    // devolveria 500 pro webhook do WhatsApp e o cliente ficaria sem resposta nenhuma.
    if (error instanceof PaymentProviderError) {
      await reply(order.phone, copy.paymentIssueFailed());
      await notifyOwner(
        copy.operatorPaymentFailedAlert(order.id.slice(-6).toUpperCase(), error.message.slice(0, 180)),
        order.phone
      );
      return { expired: false };
    }
    throw error;
  }
}

// The customer changed their mind about how to pay while the charge is still open:
// re-issue the charge with the other method (total re-derived from the order rows so
// the fee pass-through stays honest) and keep reconciliation on the same order id.
export async function switchPaymentMethod(
  phone: string,
  order: {
    id: string;
    userId: string;
    phone: string;
    total: number;
    items: unknown;
    status: string;
    itemsSubtotal: number;
    serviceFee: number;
    deliveryFee: number;
    notes?: string | null;
    pixId?: string | null;
  },
  method: "pix" | "card",
  // renewed (06/10): cobrança nova no MESMO método (Pix/link vencido) — o texto não diz "troquei".
  opts: { renewed?: boolean } = {}
) {
  const base = Math.round((order.itemsSubtotal + order.serviceFee + order.deliveryFee) * 100) / 100;
  const isCard = method === "card";
  const total = isCard ? cardTotal(base) : base;
  const cardFee = Math.round((total - base) * 100) / 100;
  const description = `Lia · pedido ${order.id.slice(-6)}`;
  // Replace ONLY the payment line — other notes (e.g. a cancel-request flag) survive.
  const notes = withPaymentNote(order.notes, paymentNote(method, isCard ? copy.brl(cardFee) : undefined));

  if (isCard) {
    if (await getConfirmedPaymentAttempt(order.id)) {
      await reply(phone, copy.cardPaymentProcessing());
      return;
    }
    await expireOpenPaymentAttempts(order.id);
    const credential = await getOneClickCredential(order.userId);
    if (credential) {
      const updated = await prisma.deliveryOrder.update({
        where: { id: order.id },
        data: { total, notes, pixId: null, pixCopiaECola: null }
      });
      await supersedePixCharge(order.pixId);
      try {
        await createCardAttempt(updated, credential);
        return;
      } catch (error) {
        console.warn("[whatsapp-pay:switch:fallback-checkout]", error instanceof Error ? error.message : error);
      }
    }
    const updated = await prisma.deliveryOrder.update({
      where: { id: order.id },
      data: { total, notes, pixId: null, pixCopiaECola: null }
    });
    await supersedePixCharge(order.pixId);
    if (await sendFirstCardEnrollment(updated)) {
      await reply(phone, copy.paymentSwitched(method, total, opts.renewed));
      return;
    }
    let link;
    try {
      link = await checkoutAdapter.createLink({ orderId: order.id, amount: total, description, method: "card" });
    } catch (error) {
      // O pedido já está com o total/notas do cartão e sem cobrança: repetir *cartão*
      // reemite pelo resendCharge. O que não pode é sair link de mentira.
      await reportChargeIssueFailure(phone, { id: order.id, notes }, error);
      return;
    }
    await prisma.deliveryOrder.update({
      where: { id: order.id },
      data: { total, notes, pixId: link.preferenceId, pixCopiaECola: link.initPoint }
    });
    await reply(phone, [copy.paymentSwitched(method, total, opts.renewed), link.initPoint, link.mock ? `\n${copy.sandboxHint()}` : ""].filter(Boolean).join("\n"));
    return;
  }

  await expireOpenPaymentAttempts(order.id);
  let charge;
  try {
    charge = await pixAdapter.createPix({ orderId: order.id, amount: total, description }).then((pix) => ({
      pixId: pix.pixId,
      payload: pix.copiaECola,
      mock: pix.mock
    }));
  } catch (error) {
    // Nada foi gravado ainda: o pedido continua na forma de pagamento anterior e
    // aguardando. Um Pix mock aqui viraria "paguei" aprovado sem dinheiro.
    await reportChargeIssueFailure(phone, order, error);
    return;
  }
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { total, notes, pixId: charge.pixId, pixCopiaECola: charge.payload }
  });
  if (order.pixId !== charge.pixId) await supersedePixCharge(order.pixId);
  // Bolha antes do texto (a troca de forma continua numa mensagem só: contexto do
  // novo total + código juntos — aqui o código não precisa ser mensagem solitária
  // porque a bolha, quando entregue, já tem o Copy Pix code).
  await maybeSendNativePixBubble(phone, order.id, charge.pixId, total, charge.payload, charge.mock);
  await reply(
    phone,
    [copy.paymentSwitched(method, total, opts.renewed), charge.payload, charge.mock ? `\n${copy.sandboxHint()}` : ""].filter(Boolean).join("\n")
  );
}

// ---------- order lifecycle (called by webhook + operator dashboard) ----------

export type PaymentEvidence = {
  provider: "mercadopago" | "pagarme" | "mock";
  paymentId?: string | null;
  amount?: number | null;
  // Financeiro (23/09): taxa do provedor e líquido, quando a leitura do MP já os trouxe.
  feeAmount?: number | null;
  netAmount?: number | null;
};

// Dinheiro e razão precisam confirmar juntos; falha no banco pede retry do webhook.
export async function ledgerRecord(order: { id: string; notes: string | null }, evidence: PaymentEvidence, status: "approved" | "unexpected", db: Prisma.TransactionClient = prisma) {
  if (!evidence.paymentId || evidence.amount == null || !Number.isFinite(evidence.amount) || evidence.amount <= 0) {
    throw new Error("Evidência de pagamento incompleta ou inválida.");
  }
  await recordPayment({
    deliveryOrderId: order.id, provider: evidence.provider, providerPaymentId: evidence.paymentId,
    method: evidence.provider === "pagarme" || isCardCharge(order) ? "card" : "pix",
    amountCents: Math.round(evidence.amount * 100), status,
    feeCents: evidence.feeAmount != null && Number.isFinite(evidence.feeAmount) ? Math.round(evidence.feeAmount * 100) : null,
    netCents: evidence.netAmount != null && Number.isFinite(evidence.netAmount) ? Math.round(evidence.netAmount * 100) : null
  }, db);
}

// Pagamento aprovado que NÃO bate com a cobrança na mesa: valor diferente, ou um Pix
// que não é o vigente (código antigo pago depois de reabrir/trocar pra cartão).
export function paymentEvidenceMismatch(order: { total: number; pixId: string | null }, evidence: PaymentEvidence): string | null {
  if (!evidence.paymentId || evidence.amount == null || !Number.isFinite(evidence.amount) || evidence.amount <= 0) return "evidência de pagamento incompleta ou inválida";
  if (Math.round(evidence.amount * 100) !== Math.round(order.total * 100)) {
    return `valor pago ${copy.brl(evidence.amount)} ≠ total ${copy.brl(order.total)}`;
  }
  // Link de cartão (Checkout Pro) guarda o id da PREFERÊNCIA em pixId e o pagamento
  // nasce com outro id — aí só o valor é conferível. Pix guarda o id do pagamento.
  if (
    evidence.provider === "mercadopago" &&
    evidence.paymentId &&
    order.pixId &&
    /^\d{1,20}$/.test(order.pixId) &&
    order.pixId !== evidence.paymentId
  ) {
    return `pagamento ${evidence.paymentId} não é a cobrança vigente (${order.pixId})`;
  }
  return null;
}

export async function recordUnexpectedPayment(
  order: { id: string; phone: string; notes: string | null; status: string },
  evidence: PaymentEvidence,
  reason: string
) {
  const marker = `⚠️ PAGAMENTO FORA DO ESPERADO (${evidence.provider} ${evidence.paymentId ?? "?"})`;
  if ((order.notes ?? "").includes(marker)) return; // replay do webhook
  await ledgerRecord(order, evidence, "unexpected");
  const detail = `${reason}${evidence.amount != null ? ` — ${copy.brl(evidence.amount)}` : ""}`;
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { notes: appendOrderNote(order.notes, `${marker}: ${detail}. Conferir no provedor e estornar se for duplicado.`) }
  });
  console.error("[payment:unexpected]", {
    orderId: order.id,
    provider: evidence.provider,
    paymentId: evidence.paymentId,
    amount: evidence.amount,
    status: order.status,
    reason
  });
  await notifyOwner(copy.operatorUnexpectedPaymentAlert(order.id.slice(-6).toUpperCase(), detail), order.phone);
  if (evidence.amount != null) await reply(order.phone, copy.unexpectedPaymentReceived(order.id.slice(-6).toUpperCase(), evidence.amount));
}

// Pix vencido no provedor (60 min): limpa o código pra "pix" gerar outro, anota UMA vez e
// avisa o cliente. Idempotente pelo marcador na nota (o cron repete sem duplicar).
export async function markPixExpired(orderId: string, pixId: string) {
  const marker = `⏰ PIX EXPIROU (${pixId})`;
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "awaiting_payment") return false;
  if ((order.notes ?? "").includes(marker)) return false;
  const cleared = await prisma.deliveryOrder.updateMany({
    where: { id: orderId, status: "awaiting_payment", pixId },
    data: { pixId: null, pixCopiaECola: null, notes: appendOrderNote(order.notes, `${marker}: cliente avisado; "pix" reemite.`) }
  });
  if (!cleared.count) return false;
  await reply(order.phone, copy.pixExpiredReissue());
  return true;
}

// Cartão salvo com desfecho desconhecido (retries esgotados / 1h sem id do provedor):
// nota no pedido + alerta ao operador. Chamado pelo módulo de pagamentos.
export async function flagCardOutcomeUnknown(orderId: string, attemptId: string, detail: string) {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order) return;
  const marker = `⚠️ CARTÃO: DESFECHO DESCONHECIDO (${attemptId})`;
  if (!(order.notes ?? "").includes(marker)) {
    await prisma.deliveryOrder.update({
      where: { id: orderId },
      data: { notes: appendOrderNote(order.notes, `${marker}: ${detail.slice(0, 160)}. Conferir no Pagar.me antes de cobrar/comprar.`) }
    });
  }
  await notifyOwner(copy.operatorCardOutcomeUnknownAlert(order.id.slice(-6).toUpperCase(), detail.slice(0, 120)), order.phone);
}

export async function markDeliveryOrderPaid(orderId: string, evidence?: PaymentEvidence, opts: { notifyCustomer?: boolean } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DeliveryOrder" WHERE id = ${orderId} FOR UPDATE`;
    const current = await tx.deliveryOrder.findUnique({ where: { id: orderId } });
    if (!current) return { order: null, flipped: false, unexpected: null };
    if (evidence) {
      const known = evidence.paymentId ? await tx.payment.findUnique({ where: {
        provider_providerPaymentId: { provider: evidence.provider, providerPaymentId: evidence.paymentId }
      } }) : null;
      if (known && known.deliveryOrderId !== orderId) throw new Error("Pagamento vinculado a outro pedido.");
      if (current.status !== "awaiting_payment") {
        if (known) return { order: current, flipped: false, unexpected: null };
        return { order: current, flipped: false, unexpected: `pedido estava em "${current.status}"` };
      }
      const mismatch = paymentEvidenceMismatch(current, evidence);
      if (mismatch) return { order: current, flipped: false, unexpected: mismatch };
      if (known && (known.refundedCents > 0 || ["refunded", "partially_refunded"].includes(known.status))) {
        return { order: current, flipped: false, unexpected: "pagamento já estornado" };
      }
      await ledgerRecord(current, evidence, "approved", tx);
    }
    if (current.status !== "awaiting_payment") return { order: current, flipped: false, unexpected: null };
    const order = await tx.deliveryOrder.update({ where: { id: orderId }, data: { status: "paid", paidAt: new Date() } });
    return { order, flipped: true, unexpected: null };
  });
  const order = result.order;
  if (!order) return null;
  if (result.unexpected && evidence) {
    await recordUnexpectedPayment(order, evidence, result.unexpected);
    return order;
  }
  // Create the durable local-worker task after the money state is committed. This is
  // best-effort: a queue outage must not undo a real payment; claim() backfills paid
  // orders that missed this hook.
  // A compra no servidor só DISPARA depois da confirmação ao cliente (06/10, caso Karlão):
  // a compra que falhava em 1 s mandava o estorno antes do "Pagamento confirmado. Já estou
  // separando" — o cliente lia as duas mensagens ao contrário.
  let startServerBuyer: (() => void) | undefined;
  try {
    const { ensurePurchaseJobForPaidOrder, manualQueueJobForPaidOrder } = await import("@/lib/purchase-worker");
    // Sem executor para esta loja/cesta: fila manual explícita no /ops (11/09).
    const job = await ensurePurchaseJobForPaidOrder(order.id);
    if (!job) await manualQueueJobForPaidOrder(order.id);
    // Comprador VTEX no servidor (25/09): compra na hora em que o dinheiro cai, sem esperar
    // o cron. Corre depois da resposta ao webhook (waitUntil); o cron cobre o que sobrar.
    else if ((await import("@/lib/purchase/vtex-checkout")).VTEX_API_STORE_KEYS.includes(job.storeKey)) {
      const { runVtexApiPurchases } = await import("@/lib/purchase/vtex-runner");
      const { waitUntil } = await import("@vercel/functions");
      startServerBuyer = () =>
        waitUntil(runVtexApiPurchases({ maxJobs: 1 }).then((r) => { if (r.errors.length) console.warn("[vtex-runner:on-paid]", r.errors); }).catch((error) => console.error("[vtex-runner:on-paid]", error instanceof Error ? error.message : error)));
    }
  } catch (error) {
    console.error("[purchase-worker:enqueue-failed]", error instanceof Error ? error.message : error);
  }
  if (!result.flipped) {
    startServerBuyer?.();
    return order;
  }
  // Reset the conversation (keep the address) so the next message starts a fresh
  // basket instead of resurrecting the awaiting_payment step. If the customer has
  // ALREADY started a new basket in this conversation, leave it alone — the async
  // webhook must not wipe an in-flight order.
  const pendingNewItem = await mergeDecisionRequestFor(order);
  await resetConversationForClosedOrder(order, "paid");
  // Não existe mais carrinho reservado por robô: quem compra é o operador, depois do
  // pagamento confirmado. Fora do horário de quem compra (operador contratado), a Lia diz
  // a verdade em vez de "já estou separando" — o prazo da loja não muda.
  try {
    if (opts.notifyCustomer !== false)
      await reply(
        order.phone,
        operatorIsHired() && !withinOperatorHours() ? copy.paymentConfirmedOutsideHours() : copy.paymentConfirmed()
      );
    // Pix pago com "juntar ou pedido novo?" aberta: o reset apaga o passo, mas o item
    // novo que o cliente pediu não pode sumir em silêncio (revisão 01/09).
    if (pendingNewItem) await reply(order.phone, copy.newItemAfterPayment(pendingNewItem));
  } finally {
    startServerBuyer?.();
  }
  // Pedido pago é o alerta mais urgente de todos: dinheiro na mão e ninguém comprando.
  // Ficou desligado enquanto o dono era o operador (20/08 — o /ops já mostra). Com um
  // operador CONTRATADO ele volta sozinho: quem compra não fica olhando o painel o dia
  // inteiro, e foi este alerta que matou o pedido-zumbi de 2 dias em 11/08.
  // `LIA_OPERATOR_PAID_ALERT=false` desliga à força; `=true` liga mesmo sem operador.
  const hiredOperator = operatorIsHired();
  const paidAlert = process.env.LIA_OPERATOR_PAID_ALERT === "true" || (hiredOperator && process.env.LIA_OPERATOR_PAID_ALERT !== "false");
  if (paidAlert) {
    await notifyOperator(copy.operatorPaidAlert(order.id.slice(-6).toUpperCase(), order.total), order.phone);
  }
  return order;
}
