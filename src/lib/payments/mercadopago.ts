import { randomUUID } from "crypto";

// Pix money-in. Real Mercado Pago is wired but INERT until
// MERCADO_PAGO_ACCESS_TOKEN is set — until then it returns a mock copia-e-cola so
// the flow runs end-to-end in sandbox. external_reference = DeliveryOrder.id so the
// webhook can reconcile. WITH the token set, a failed call throws PaymentProviderError —
// it never falls back to the mock (that would "pay" a real order with fake money).

export type PixCharge = {
  pixId: string;
  copiaECola: string;
  qrBase64?: string;
  amount: number;
  mock: boolean;
};

// "expired": o MP devolve `cancelled` quando o Pix venceu (60 min) — o cliente precisa de
// um código NOVO, não de "ainda não caiu" (revisão 02/09).
export type PixStatus = "pending" | "approved" | "rejected" | "expired" | "unknown";


// Checkout Pro link: one hosted MP page per order where the customer pays with
// CARD or Pix. We only create a "preference" and send the init_point URL — the card
// never touches us (MP hosts everything; zero PCI on our side). Reconciliation is the
// SAME as Pix: MP fires the payment webhook with external_reference = DeliveryOrder.id.
export type CheckoutLink = {
  preferenceId: string;
  initPoint: string;
  amount: number;
  mock: boolean;
};

function hasCreds() {
  return Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN);
}

// Em deploy de produção, dinheiro de mentira não existe (revisão 02/09): um build sem
// MERCADO_PAGO_ACCESS_TOKEN gerava Pix "MOCKPIX" e "paguei" aprovava sem dinheiro.
export function productionRequiresRealMoney(): boolean {
  return process.env.NODE_ENV === "production" && process.env.VERCEL === "1";
}

// True only in dev/tests (no access token): the mock charges below are safe ONLY here.
export function paymentsAreMocked(): boolean {
  return !hasCreds() && !productionRequiresRealMoney();
}

// Raised when Mercado Pago is configured for real money but the call failed
// (timeout, 5xx, malformed answer). It must NEVER degrade into a mock charge: a
// mock code is uncopiable, carries the sandbox hint, and the brain approves a
// "mockpix_" order on the customer's word alone — i.e. a real order marked paid
// with no money in. Callers keep the order waiting and tell customer + operator.
export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export const pixAdapter = {
  async createPix(input: {
    orderId: string;
    amount: number;
    description?: string;
    payerEmail?: string;
  }): Promise<PixCharge> {
    if (hasCreds()) {
      // Real credentials → real charge or nothing. No mock fallback (see PaymentProviderError).
      try {
        return await realCreatePix(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[pix:create:failed]", input.orderId, detail);
        throw new PaymentProviderError(detail);
      }
    }
    if (productionRequiresRealMoney()) {
      throw new PaymentProviderError("MERCADO_PAGO_ACCESS_TOKEN ausente em produção — cobrança recusada (nada de mock)");
    }
    const pixId = `mockpix_${randomUUID()}`;
    return {
      pixId,
      copiaECola: `00020126MOCKPIX-${input.orderId}-${Math.round(input.amount * 100)}5204000053039865802BR6009SAO PAULO`,
      amount: input.amount,
      mock: true
    };
  },

  async getStatus(pixId: string): Promise<PixStatus> {
    if (hasCreds() && !pixId.startsWith("mock")) {
      try {
        return await realGetStatus(pixId);
      } catch (error) {
        console.warn("[pix:status:error]", error instanceof Error ? error.message : error);
        return "unknown";
      }
    }
    return "pending";
  }
};


async function realCreatePix(input: { orderId: string; amount: number; description?: string; payerEmail?: string }): Promise<PixCharge> {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  // Pix QR expires in 60 min so a stale charge can't be paid after the quote drifts.
  // MP wants an explicit offset (e.g. -03:00), not the "Z" that toISOString() emits —
  // shift the instant by -3h so the wall-clock digits match BRT, then label it -03:00.
  const expiration = new Date(Date.now() + 60 * 60 * 1000 - 3 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "-03:00");
  const body: Record<string, unknown> = {
    transaction_amount: Number(input.amount.toFixed(2)),
    description: input.description ?? `Pedido Lia ${input.orderId}`,
    payment_method_id: "pix",
    external_reference: input.orderId,
    date_of_expiration: expiration,
    payer: { email: input.payerEmail ?? "cliente@lia.app", first_name: "Cliente" }
  };
  // Per-payment notification_url is more reliable than the dashboard-only setting.
  if (process.env.MERCADO_PAGO_WEBHOOK_URL) body.notification_url = process.env.MERCADO_PAGO_WEBHOOK_URL;
  const res = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Mesma chave por 30 min (retentativa após timeout devolve o MESMO pagamento, sem
      // duplicar); chave nova depois disso, pra reemissão de Pix vencido não receber de
      // volta o pagamento antigo já cancelado (revisão 01/09).
      "X-Idempotency-Key": `${input.orderId}:${Number(input.amount.toFixed(2))}:${Math.floor(Date.now() / (30 * 60 * 1000))}`
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
  });
  if (!res.ok) {
    // Surface MP's actual error body (it names the offending field) so a 400 is
    // diagnosable from the logs instead of a bare status code.
    const errBody = await res.text().catch(() => "");
    throw new Error(`mercadopago createPix ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    id?: number | string;
    point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string } };
  };
  const td = data.point_of_interaction?.transaction_data;
  return {
    pixId: String(data.id ?? `q_${randomUUID()}`),
    copiaECola: td?.qr_code ?? "",
    qrBase64: td?.qr_code_base64,
    amount: input.amount,
    mock: false
  };
}

// Checkout Pro: create a payment preference and return its hosted link (init_point).
// One link covers BOTH card and Pix — the customer chooses on MP's page. INERT until
// MERCADO_PAGO_ACCESS_TOKEN is set (mock link in sandbox so the flow runs end-to-end).
export type CheckoutMethod = "pix" | "card" | "any";

export const checkoutAdapter = {
  async createLink(input: {
    orderId: string;
    amount: number;
    description?: string;
    payerEmail?: string;
    method?: CheckoutMethod;
  }): Promise<CheckoutLink> {
    if (hasCreds()) {
      // Real credentials → real preference or nothing. Same rule as Pix: a mock link
      // ("https://mock.lia/...") sent to a real customer is a dead end, not a payment.
      try {
        return await realCreateCheckout(input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("[checkout:create:failed]", input.orderId, detail);
        throw new PaymentProviderError(detail);
      }
    }
    if (productionRequiresRealMoney()) {
      throw new PaymentProviderError("MERCADO_PAGO_ACCESS_TOKEN ausente em produção — link recusado (nada de mock)");
    }
    return {
      preferenceId: `mockpref_${randomUUID()}`,
      initPoint: `https://mock.lia/pay/${input.orderId}`,
      amount: input.amount,
      mock: true
    };
  }
};

// Lock the hosted link to ONE payment type so the fee pass-through is honest: a Pix
// link can't be paid by card (which would cost us the MDR at the no-fee price), and a
// card link can't be paid by Pix (which would overcharge the customer the card fee).
function excludedTypesFor(method?: CheckoutMethod): Array<{ id: string }> {
  if (method === "pix") {
    return [{ id: "credit_card" }, { id: "debit_card" }, { id: "prepaid_card" }, { id: "ticket" }, { id: "atm" }];
  }
  if (method === "card") {
    return [{ id: "bank_transfer" }, { id: "ticket" }, { id: "atm" }]; // bank_transfer = Pix
  }
  return [];
}

async function realCreateCheckout(input: { orderId: string; amount: number; description?: string; payerEmail?: string; method?: CheckoutMethod }): Promise<CheckoutLink> {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  // Link expires in 60 min so a stale total can't be paid after the quote drifts. MP
  // wants an explicit offset (-03:00), not the "Z" toISOString() emits — same trick as Pix.
  const expiration = new Date(Date.now() + 60 * 60 * 1000 - 3 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "-03:00");
  const body: Record<string, unknown> = {
    items: [
      {
        id: input.orderId,
        title: input.description ?? `Pedido Lia ${input.orderId}`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(input.amount.toFixed(2))
      }
    ],
    external_reference: input.orderId,
    // à vista only — parcelamento costs more and isn't passed through. excluded_payment_types
    // locks the link to Pix-only or card-only when a method was chosen (fee pass-through).
    payment_methods: {
      installments: 1,
      default_installments: 1,
      excluded_payment_types: excludedTypesFor(input.method)
    },
    expires: true,
    expiration_date_to: expiration,
    // Nome na fatura do cartão (06/10, dono: o cliente via o nome pessoal do dono). O Pix não
    // tem campo assim: o banco mostra o titular da chave (o MEI leva o nome do dono).
    statement_descriptor: statementDescriptor()
  };
  // Per-preference notification_url is more reliable than the dashboard-only setting.
  if (process.env.MERCADO_PAGO_WEBHOOK_URL) body.notification_url = process.env.MERCADO_PAGO_WEBHOOK_URL;
  if (input.payerEmail) body.payer = { email: input.payerEmail };
  const base = process.env.LIA_PUBLIC_URL ?? "https://liadelivery.com.br"; // domínio próprio: não muda se o projeto da Vercel for renomeado
  if (base) body.back_urls = { success: base, pending: base, failure: base };
  const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `pref_${input.orderId}`
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
  });
  if (!res.ok) {
    // Surface MP's actual error body (it names the offending field) so a 400 is
    // diagnosable from the logs instead of a bare status code.
    const errBody = await res.text().catch(() => "");
    throw new Error(`mercadopago createPreference ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = (await res.json()) as { id?: string; init_point?: string; sandbox_init_point?: string };
  const initPoint = data.init_point ?? data.sandbox_init_point ?? "";
  if (!initPoint) throw new Error("mercadopago createPreference: no init_point in response");
  return {
    preferenceId: String(data.id ?? `pref_${randomUUID()}`),
    initPoint,
    amount: input.amount,
    mock: false
  };
}

async function realGetStatus(pixId: string): Promise<PixStatus> {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${pixId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
  });
  if (!res.ok) return "unknown";
  const data = (await res.json()) as { status?: string };
  if (data.status === "approved") return "approved";
  if (data.status === "cancelled" || data.status === "expired") return "expired";
  if (data.status === "rejected") return "rejected";
  return "pending";
}

// Cancela no Mercado Pago uma cobrança Pix que deixou de valer (pedido cancelado,
// reaberto pra edição, trocado pra cartão). Best-effort e NUNCA lança: a bolha/código
// antigo no chat ficava pagável por 60 min e o dinheiro entrava sem pedido (revisão
// 01/09). Só ids numéricos de PAGAMENTO — id de preferência (Checkout Pro) não passa
// por aqui; mock nunca chama a API.
export async function cancelMercadoPagoPayment(paymentId: string): Promise<boolean> {
  if (paymentsAreMocked() || !/^\d{1,20}$/.test(paymentId)) return false;
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn("[mercadopago:cancel:rejected]", paymentId, res.status, errBody.slice(0, 200));
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[mercadopago:cancel:failed]", paymentId, error instanceof Error ? error.message : error);
    return false;
  }
}

export type MercadoPagoPaymentDetails = {
  id: string;
  status: string;
  amount: number | null;
  externalReference: string | null;
  refundedAmount: number;
  // Financeiro (23/09): taxa que o MP tirou de nós e líquido creditado. null = o corpo do
  // pagamento não trouxe (o cron tenta de novo mais tarde; o P&L estima enquanto isso).
  feeAmount: number | null;
  netAmount: number | null;
};

// Pedaço do corpo de /v1/payments/{id} que interessa ao financeiro. O MP lista as taxas em
// `fee_details` (fee_payer "collector" = saiu do NOSSO lado) e o líquido em
// `transaction_details.net_received_amount`. Qualquer um dos dois fecha a conta; sem
// nenhum, fica desconhecido — nunca chutamos zero.
export type MercadoPagoPaymentBody = {
  transaction_amount?: number;
  fee_details?: { type?: string; amount?: number; fee_payer?: string }[];
  transaction_details?: { net_received_amount?: number };
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function mercadoPagoFees(data: MercadoPagoPaymentBody): { feeAmount: number | null; netAmount: number | null } {
  const amount = typeof data.transaction_amount === "number" ? data.transaction_amount : null;
  const fees = Array.isArray(data.fee_details)
    ? data.fee_details.filter((f) => typeof f?.amount === "number" && Number.isFinite(f.amount) && (f.fee_payer ?? "collector") === "collector")
    : [];
  const net = typeof data.transaction_details?.net_received_amount === "number" ? data.transaction_details.net_received_amount : null;
  let feeAmount: number | null = fees.length ? round2(fees.reduce((sum, f) => sum + (f.amount as number), 0)) : null;
  if (feeAmount == null && amount != null && net != null) feeAmount = round2(amount - net);
  const netAmount = net ?? (amount != null && feeAmount != null ? round2(amount - feeAmount) : null);
  return { feeAmount, netAmount };
}

// Leitura completa de um pagamento (status + valor) — base da reconciliação por cron e
// da evidência que o cérebro exige pra marcar "pago". Nunca lança: null = não deu pra ler.
export async function getMercadoPagoPayment(paymentId: string): Promise<MercadoPagoPaymentDetails | null> {
  if (!hasCreds() || !/^\d{1,20}$/.test(paymentId)) return null;
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MercadoPagoPaymentBody & {
      id?: number | string;
      status?: string;
      external_reference?: string;
      transaction_amount_refunded?: number;
    };
    return {
      id: String(data.id ?? paymentId),
      status: data.status ?? "unknown",
      amount: typeof data.transaction_amount === "number" ? data.transaction_amount : null,
      externalReference: data.external_reference ?? null,
      refundedAmount: typeof data.transaction_amount_refunded === "number" ? data.transaction_amount_refunded : 0,
      ...mercadoPagoFees(data)
    };
  } catch (error) {
    console.warn("[mercadopago:get-payment:failed]", paymentId, error instanceof Error ? error.message : error);
    return null;
  }
}

// Estorno por API (revisão 02/09): total (sem `amount`) ou parcial. Lança
// PaymentProviderError com o corpo do MP quando recusado — o operador precisa LER o
// motivo (saldo, prazo, pagamento já estornado), nunca um "falhou" seco.
export async function refundMercadoPagoPayment(
  paymentId: string,
  amount?: number,
  idempotencyKey?: string
): Promise<{ refundId: string; status: string; amount: number | null }> {
  if (!/^\d{1,20}$/.test(paymentId)) throw new PaymentProviderError(`id de pagamento inválido: ${paymentId}`);
  if (!hasCreds()) {
    if (productionRequiresRealMoney()) throw new PaymentProviderError("MERCADO_PAGO_ACCESS_TOKEN ausente em produção");
    return { refundId: `mockrefund_${randomUUID()}`, status: "approved", amount: amount ?? null };
  }
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN as string;
  const body = amount != null ? JSON.stringify({ amount: Number(amount.toFixed(2)) }) : "{}";
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey ?? `refund:${paymentId}:${amount != null ? Number(amount.toFixed(2)) : "full"}`
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.LIA_MP_TIMEOUT_MS ?? 10000))
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new PaymentProviderError(`Mercado Pago recusou o estorno (${res.status}): ${text.slice(0, 300)}`);
  let data: { id?: number | string; status?: string; amount?: number } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    /* corpo vazio */
  }
  return { refundId: String(data.id ?? ""), status: data.status ?? "unknown", amount: typeof data.amount === "number" ? data.amount : amount ?? null };
}


// "LIA DELIVERY" na fatura do cartão; LIA_STATEMENT_DESCRIPTOR troca (até 13 caracteres,
// letras, números e espaço — o limite do Pagar.me, que usa o mesmo nome).
export function statementDescriptor(): string {
  const raw = (process.env.LIA_STATEMENT_DESCRIPTOR ?? "LIA DELIVERY").normalize("NFD").replace(/[^A-Za-z0-9 ]/g, "").trim();
  return (raw || "LIA DELIVERY").slice(0, 13).toUpperCase();
}
