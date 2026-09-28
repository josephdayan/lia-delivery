import { randomUUID } from "crypto";

export type PagarmeAddress = {
  line1: string;
  line2?: string;
  zipCode: string;
  city: string;
  state: string;
  country?: string;
};

export type PagarmeCustomerInput = {
  code: string;
  name: string;
  email: string;
  document: string;
  phone: string;
  address: PagarmeAddress;
};

export type PagarmeCard = {
  id: string;
  last4: string;
  brand?: string;
};

export type PagarmeSavedCardCharge = {
  status: "captured" | "declined" | "pending" | "unavailable";
  providerOrderId?: string;
  providerChargeId?: string;
  error?: string;
  mock: boolean;
};

type PagarmeOrder = {
  id?: string;
  status?: string;
  charges?: Array<{
    id?: string;
    status?: string;
    last_transaction?: {
      id?: string; status?: string; success?: boolean; acquirer_message?: string; acquirer_return_code?: string;
      antifraud_response?: { status?: string; return_message?: string };
      gateway_response?: { code?: string; errors?: { message?: string }[] };
    };
  }>;
};

// Motivo legível de uma cobrança não aprovada. A mensagem do adquirente pode dizer
// "Transação aprovada com sucesso" mesmo quando o antifraude reprova depois (28/09: duas
// recusas assim); por isso grava o veredito inteiro, não só essa frase.
export function chargeFailureDetail(order: PagarmeOrder): string | undefined {
  const charge = order.charges?.[0];
  const tx = charge?.last_transaction;
  if (!charge && !tx) return undefined;
  const parts = [
    tx?.acquirer_message,
    `pedido ${order.status ?? "?"} · cobrança ${charge?.status ?? "?"} · transação ${tx?.status ?? "?"}`,
    tx?.acquirer_return_code ? `código ${tx.acquirer_return_code}` : undefined,
    tx?.antifraud_response?.status ? `antifraude ${tx.antifraud_response.status}${tx.antifraud_response.return_message ? ` (${tx.antifraud_response.return_message})` : ""}` : undefined,
    tx?.gateway_response?.errors?.length ? `gateway ${tx.gateway_response.errors.map((e) => e.message).filter(Boolean).join("; ")}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ").slice(0, 500);
}

export class PagarmeApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PagarmeApiError";
  }
}

function mockEnabled() {
  // Em deploy de produção nunca existe cartão de mentira (revisão 02/09).
  if (process.env.NODE_ENV === "production" && process.env.VERCEL === "1") return false;
  return process.env.PAGARME_MOCK === "true" || process.env.NODE_ENV === "test";
}

function config() {
  const secretKey = process.env.PAGARME_SECRET_KEY;
  const baseUrl = (process.env.PAGARME_BASE_URL ?? "https://api.pagar.me/core/v5").replace(/\/$/, "");
  return { secretKey, baseUrl };
}

function digits(value: string) {
  return value.replace(/\D/g, "");
}

function phonePayload(phone: string) {
  const normalized = digits(phone).replace(/^55/, "");
  const areaCode = normalized.slice(0, 2);
  const number = normalized.slice(2);
  return {
    mobile_phone: {
      country_code: "55",
      area_code: areaCode,
      number
    }
  };
}

function addressPayload(address: PagarmeAddress) {
  return {
    line_1: address.line1,
    ...(address.line2 ? { line_2: address.line2 } : {}),
    zip_code: digits(address.zipCode),
    city: address.city,
    state: address.state.toUpperCase(),
    country: address.country ?? "BR"
  };
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return {} as Record<string, unknown>;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

async function request<T>(path: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T> {
  const { secretKey, baseUrl } = config();
  if (!secretKey) throw new PagarmeApiError("PAGARME_SECRET_KEY is not configured");
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", authorization);
  headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(10_000)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new PagarmeApiError(
      `Pagar.me ${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload).slice(0, 700)}`,
      response.status
    );
  }
  return payload as T;
}

function statusFromOrder(order: PagarmeOrder): PagarmeSavedCardCharge["status"] {
  const charge = order.charges?.[0];
  const transaction = charge?.last_transaction;
  const paid = order.status === "paid" || charge?.status === "paid" || transaction?.status === "captured" || transaction?.success === true;
  if (paid) return "captured";
  const failed = order.status === "failed" || order.status === "canceled" || charge?.status === "failed" || charge?.status === "canceled" || transaction?.status === "not_authorized";
  if (failed) return "declined";
  return "pending";
}

export const pagarmeAdapter = {
  isAvailable() {
    return Boolean(config().secretKey) || mockEnabled();
  },

  publicKey() {
    return process.env.PAGARME_PUBLIC_KEY ?? "";
  },

  async createCustomer(input: PagarmeCustomerInput) {
    if (mockEnabled() && !config().secretKey) return { id: `cus_mock_${randomUUID()}` };
    return request<{ id: string }>("/customers", {
      method: "POST",
      body: JSON.stringify({
        code: input.code.slice(0, 52),
        name: input.name.slice(0, 64),
        email: input.email.slice(0, 64),
        document: digits(input.document),
        document_type: "CPF",
        type: "individual",
        phones: phonePayload(input.phone),
        address: addressPayload(input.address)
      })
    }, `customer:${input.code}`);
  },

  async createCard(input: { customerId: string; token: string; address: PagarmeAddress }) : Promise<PagarmeCard> {
    if (mockEnabled() && !config().secretKey) {
      return { id: `card_mock_${randomUUID()}`, last4: "4242", brand: "Visa" };
    }
    const card = await request<{ id: string; last_four_digits?: string; brand?: string }>(`/customers/${encodeURIComponent(input.customerId)}/cards`, {
      method: "POST",
      body: JSON.stringify({ token: input.token, billing_address: addressPayload(input.address) })
    }, `card:${input.customerId}:${input.token}`);
    return { id: card.id, last4: card.last_four_digits ?? "", brand: card.brand };
  },

  async chargeSavedCard(input: {
    orderId: string;
    attemptId: string;
    amountCents: number;
    customerId: string;
    cardId: string;
    description: string;
  }): Promise<PagarmeSavedCardCharge> {
    if (mockEnabled() && !config().secretKey) {
      return {
        status: "captured",
        providerOrderId: `or_mock_${randomUUID()}`,
        providerChargeId: `ch_mock_${randomUUID()}`,
        mock: true
      };
    }

    try {
      const order = await request<PagarmeOrder>("/orders", {
        method: "POST",
        body: JSON.stringify({
          code: input.orderId.slice(0, 52),
          customer_id: input.customerId,
          items: [{
            code: input.orderId.slice(0, 52),
            amount: input.amountCents,
            description: input.description.slice(0, 256),
            quantity: 1
          }],
          payments: [{
            payment_method: "credit_card",
            credit_card: {
              card_id: input.cardId,
              installments: 1,
              operation_type: "auth_and_capture"
            }
          }],
          metadata: { delivery_order_id: input.orderId, payment_attempt_id: input.attemptId }
        })
      }, input.attemptId);
      const charge = order.charges?.[0];
      return {
        status: statusFromOrder(order),
        providerOrderId: order.id,
        providerChargeId: charge?.id ?? charge?.last_transaction?.id,
        error: statusFromOrder(order) === "captured" ? charge?.last_transaction?.acquirer_message : chargeFailureDetail(order),
        mock: false
      };
    } catch (error) {
      // Revisão 02/09: um 4xx da API (401 chave errada, 404 cartão/cliente inexistente,
      // 422 payload) é erro de CONFIGURAÇÃO/pedido, não "seu cartão foi recusado" —
      // dizer isso ao cliente e mandar link de fallback era mentira que queimava a
      // credencial. Recusa de verdade vem com 200 e charge `failed`/`not_authorized`
      // (statusFromOrder). Qualquer 4xx/5xx/rede aqui é "unavailable": o step durável
      // tenta de novo com a mesma Idempotency-Key e, esgotado, vira desfecho
      // desconhecido com alerta humano.
      return { status: "unavailable", error: error instanceof Error ? error.message : "Pagar.me unavailable", mock: false };
    }
  },

  // Estorno/cancelamento de uma charge (API v5: DELETE /charges/{id}; `amount` em
  // centavos para parcial). Lança PagarmeApiError com o corpo quando recusado.
  async refundCharge(chargeId: string, amountCents?: number, idempotencyKey?: string): Promise<{ status: string; reference: string }> {
    if (mockEnabled() && !config().secretKey) {
      return { status: "refunded", reference: `refund_mock_${randomUUID()}` };
    }
    const result = await request<{ id?: string; status?: string; last_transaction?: { id?: string; status?: string } }>(
      `/charges/${encodeURIComponent(chargeId)}`,
      { method: "DELETE", body: amountCents != null ? JSON.stringify({ amount: amountCents }) : undefined },
      idempotencyKey ?? `refund:${chargeId}:${amountCents ?? "full"}`
    );
    return { status: result.last_transaction?.status ?? result.status ?? "unknown", reference: result.last_transaction?.id ?? result.id ?? chargeId };
  },

  async getOrder(orderId: string): Promise<PagarmeSavedCardCharge> {
    const order = await request<PagarmeOrder>(`/orders/${encodeURIComponent(orderId)}`);
    const charge = order.charges?.[0];
    return {
      status: statusFromOrder(order),
      providerOrderId: order.id,
      providerChargeId: charge?.id ?? charge?.last_transaction?.id,
      error: statusFromOrder(order) === "captured" ? charge?.last_transaction?.acquirer_message : chargeFailureDetail(order),
      mock: false
    };
  }
};
