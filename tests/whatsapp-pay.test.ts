import "./helpers/load-env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOrderDetailsPayload, buildPixOrderDetailsPayload, parsePaymentConfirmation, whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { pagarmeAdapter } from "../src/lib/payments/pagarme";

test("One-Click: payload usa centavos, bens físicos e o credential_id interno", () => {
  const payload = buildOrderDetailsPayload("+5511999999999", {
    referenceId: "attempt_internal_123",
    body: "Confira seu pedido",
    credentialId: "credential_internal_456",
    last4: "5235",
    total: 29.5,
    subtotal: 23,
    shipping: 4.5,
    tax: 2,
    items: [{ retailerId: "sku_coca", name: "Coca-Cola Lata", quantity: 2, unitAmount: 11.5 }]
  });
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.reference_id, "attempt_internal_123");
  assert.equal(parameters.type, "physical-goods");
  assert.equal(parameters.total_amount.value, 2950);
  assert.equal(parameters.total_amount.offset, 100);
  assert.equal(parameters.payment_settings[0].offsite_card_pay.credential_id, "credential_internal_456");
  assert.equal(parameters.payment_settings[0].offsite_card_pay.last_four_digits, "5235");
  assert.equal(parameters.order.items[0].amount.value * parameters.order.items[0].quantity + parameters.order.shipping.value + parameters.order.tax.value, parameters.total_amount.value);
});

test("Pix nativo: bolha usa pix_dynamic_code em centavos e fecha item = total", () => {
  const payload = buildPixOrderDetailsPayload("+5511999999999", {
    referenceId: "pix-12345",
    body: "Pedido #ABC123 — toca em Pagar com Pix",
    itemName: "Pedido Lia #ABC123",
    total: 98.4,
    pixCode: "00020126PIXEXEMPLO5204000053039865802BR",
    merchantName: "Lia Delivery",
    key: "12345678000199",
    keyType: "CNPJ"
  });
  const parameters = payload.interactive.action.parameters;
  assert.equal(payload.interactive.type, "order_details");
  assert.equal(parameters.reference_id, "pix-12345");
  assert.equal(parameters.payment_type, "br");
  assert.equal(parameters.currency, "BRL");
  assert.equal(parameters.total_amount.value, 9840);
  assert.equal(parameters.total_amount.offset, 100);
  const pix = parameters.payment_settings[0];
  assert.equal(pix.type, "pix_dynamic_code");
  assert.equal(pix.pix_dynamic_code.code, "00020126PIXEXEMPLO5204000053039865802BR");
  assert.equal(pix.pix_dynamic_code.merchant_name, "Lia Delivery");
  assert.equal(pix.pix_dynamic_code.key, "12345678000199");
  assert.equal(pix.pix_dynamic_code.key_type, "CNPJ");
  // A bolha é apresentação de linha única: item = subtotal = total, sem frete/taxa avulsos.
  assert.equal(parameters.order.items.length, 1);
  assert.equal(parameters.order.items[0].amount.value, parameters.total_amount.value);
  assert.equal(parameters.order.subtotal.value, parameters.total_amount.value);
});

test("One-Click: parser reconhece o payment_method interativo oficial", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [{
      from: "5511999999999",
      type: "interactive",
      interactive: {
        type: "payment_method",
        payment_method: {
          payment_method: "offsite_card_pay",
          reference_id: "attempt_123",
          credential_id: "credential_456",
          last_four_digits: "5235"
        }
      }
    }] } }] }]
  } as any;
  const confirmation = parsePaymentConfirmation(payload);
  assert.deepEqual(confirmation, {
    referenceId: "attempt_123",
    credentialId: "credential_456",
    last4: "5235",
    status: "confirmed"
  });
  assert.equal(whatsappAdapter.parseInbound(payload).eventType, "payment_confirmation");
});

test("One-Click: parser aceita o shape de status de parceiros e ignora recibo", () => {
  const statusPayload = {
    entry: [{ changes: [{ value: { statuses: [{
      type: "payment",
      payment: { reference_id: "attempt_789", credential_id: "credential_456", last_four_digits: "5235" }
    }] } }] }]
  } as any;
  assert.equal(parsePaymentConfirmation(statusPayload)?.referenceId, "attempt_789");
  const receipt = { entry: [{ changes: [{ value: { statuses: [{ status: "read", id: "wamid.1" }] } }] }] } as any;
  assert.equal(parsePaymentConfirmation(receipt), null);
});

test("One-Click: sender encaminha order_details e order_status para a Graph API", async () => {
  const previous = {
    provider: process.env.WHATSAPP_PROVIDER,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    fetch: global.fetch
  };
  const bodies: Record<string, any>[] = [];
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ messages: [{ id: `m${bodies.length}` }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await whatsappAdapter.sendOrderDetailsCard("+5511999999999", {
      referenceId: "attempt_1",
      body: "Confira",
      credentialId: "credential_1",
      last4: "5235",
      total: 12,
      subtotal: 10,
      shipping: 1,
      tax: 1,
      items: [{ retailerId: "sku_1", name: "Item", quantity: 1, unitAmount: 10 }]
    });
    await whatsappAdapter.sendOrderStatus("+5511999999999", {
      referenceId: "attempt_1",
      body: "Pagamento aprovado",
      orderStatus: "processing",
      paymentStatus: "captured",
      timestamp: 1722445231
    });
    assert.equal(bodies[0].interactive.type, "order_details");
    assert.equal(bodies[0].interactive.action.parameters.payment_settings[0].offsite_card_pay.credential_id, "credential_1");
    assert.equal(bodies[1].interactive.type, "order_status");
    assert.equal(bodies[1].interactive.action.parameters.order.status, "processing");
    assert.equal(bodies[1].interactive.action.parameters.payment.status, "captured");
  } finally {
    process.env.WHATSAPP_PROVIDER = previous.provider;
    process.env.WHATSAPP_ACCESS_TOKEN = previous.token;
    process.env.WHATSAPP_PHONE_NUMBER_ID = previous.phoneId;
    global.fetch = previous.fetch;
  }
});

test("One-Click: Pagar.me aprova em mock sem credenciais reais", async () => {
  const previous = process.env.PAGARME_SECRET_KEY;
  const previousMock = process.env.PAGARME_MOCK;
  delete process.env.PAGARME_SECRET_KEY;
  process.env.PAGARME_MOCK = "true";
  try {
    const charge = await pagarmeAdapter.chargeSavedCard({
      orderId: "order_1",
      attemptId: "attempt_1",
      amountCents: 1234,
      customerId: "customer_1",
      cardId: "card_1",
      description: "Pedido de teste"
    });
    assert.equal(charge.status, "captured");
    assert.equal(charge.mock, true);
  } finally {
    if (previous === undefined) delete process.env.PAGARME_SECRET_KEY;
    else process.env.PAGARME_SECRET_KEY = previous;
    if (previousMock === undefined) delete process.env.PAGARME_MOCK;
    else process.env.PAGARME_MOCK = previousMock;
  }
});

test("One-Click: Pagar.me envia card_id e preserva resultado ambíguo para retry", async () => {
  const previous = {
    secret: process.env.PAGARME_SECRET_KEY,
    baseUrl: process.env.PAGARME_BASE_URL,
    mock: process.env.PAGARME_MOCK,
    fetch: global.fetch
  };
  process.env.PAGARME_SECRET_KEY = "sk_test_123";
  process.env.PAGARME_BASE_URL = "https://pagarme.test/core/v5";
  delete process.env.PAGARME_MOCK;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "or_123", status: "paid", charges: [{ id: "ch_123", status: "paid" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const charge = await pagarmeAdapter.chargeSavedCard({
      orderId: "order_1",
      attemptId: "attempt_1",
      amountCents: 1234,
      customerId: "customer_1",
      cardId: "card_1",
      description: "Pedido de teste"
    });
    assert.equal(charge.status, "captured");
    assert.equal(calls[0]?.url, "https://pagarme.test/core/v5/orders");
    assert.equal(calls[0]?.init?.headers && new Headers(calls[0].init.headers).get("Idempotency-Key"), "attempt_1");
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.items[0].amount, 1234);
    assert.equal(body.payments[0].credit_card.card_id, "card_1");

    global.fetch = (async () => new Response(JSON.stringify({ message: "idempotency request in progress" }), { status: 409 })) as typeof fetch;
    const pending = await pagarmeAdapter.chargeSavedCard({
      orderId: "order_1",
      attemptId: "attempt_1",
      amountCents: 1234,
      customerId: "customer_1",
      cardId: "card_1",
      description: "Pedido de teste"
    });
    assert.equal(pending.status, "unavailable");
  } finally {
    if (previous.secret === undefined) delete process.env.PAGARME_SECRET_KEY;
    else process.env.PAGARME_SECRET_KEY = previous.secret;
    if (previous.baseUrl === undefined) delete process.env.PAGARME_BASE_URL;
    else process.env.PAGARME_BASE_URL = previous.baseUrl;
    if (previous.mock === undefined) delete process.env.PAGARME_MOCK;
    else process.env.PAGARME_MOCK = previous.mock;
    global.fetch = previous.fetch;
  }
});

test("cartão não aprovado grava o veredito inteiro do Pagar.me, não só 'Transação aprovada com sucesso'", async () => {
  const { chargeFailureDetail } = await import("../src/lib/payments/pagarme");
  const detail = chargeFailureDetail({
    id: "or_1", status: "failed",
    charges: [{ id: "ch_1", status: "failed", last_transaction: { status: "voided", success: false, acquirer_message: "Transação aprovada com sucesso", antifraud_response: { status: "reproved", return_message: "score alto" } } }],
  });
  assert.match(detail ?? "", /antifraude reproved \(score alto\)/);
  assert.match(detail ?? "", /cobrança failed · transação voided/);
});
