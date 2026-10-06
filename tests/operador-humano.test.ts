import "./helpers/load-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { recordPayment } from "../src/lib/payments/ledger";
import { ensurePurchaseJobForPaidOrder, manualQueueJobForPaidOrder, MANUAL_QUEUE_STATUS } from "../src/lib/purchase-worker";
import { savePurchaseAccount } from "../src/lib/purchase-execution";
import { preparationStores } from "../src/lib/purchase-preparation";
import { createOpsLoginToken, isAgentRequest, opsLoginRole, opsOrderActionDenied, opsRole, opsSessionCookieValue, ownerKeyMatches, requireOpsKey, requireOpsOwner } from "../src/lib/auth";
import { operatorIsHired, ownerPhones, phoneRole, withinOperatorHours } from "../src/lib/turn-runtime";
import { ordersForOpsRole } from "../src/lib/operator-queue-view";
import { operatorStoreItemUrl } from "../src/lib/operator-store-links";

// Decisão de 15/09/2026: quem cota, compra e acompanha é um operador CONTRATADO, não o
// dono. Estes testes prendem as três consequências: nenhuma compra nasce automática, o
// painel separa os dois papéis, e os alertas de dinheiro não vão para quem só compra.

const STORE = "naturaldaterra";
const users: string[] = [];
let sequence = 0;

async function paidOrder() {
  const user = await prisma.user.create({ data: { phone: `+55090877${process.pid}${++sequence}` } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({
    data: {
      userId: user.id, phone: user.phone, status: "paid", storeKey: STORE, storeLabel: STORE, customerName: "Cliente Teste",
      items: [{ sku: `${STORE}-1`, name: "Chá", qty: 2, unitPrice: 10, lineTotal: 20, storeKey: STORE, storeLabel: STORE, productUrl: `https://www.obahortifruti.com.br/cha/p` }],
      itemsSubtotal: 20, deliveryFee: 8, serviceFee: 2, total: 30, cep: "01310-100",
      deliveryAddress: "Rua Teste, 10, Centro, São Paulo - SP", paidAt: new Date(Date.now() - 60_000),
      courierKey: "retailer_delivery",
    },
  });
  await recordPayment({ deliveryOrderId: order.id, provider: "mercadopago", providerPaymentId: `humano-${process.pid}-${sequence}`, amountCents: 3000, status: "approved", method: "pix" });
  return order;
}

after(async () => {
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.purchaseAccount.deleteMany({ where: { storeKey: "oba" } });
  await prisma.$disconnect();
});

test("kill-switch: conta pronta da loja NÃO tira o pedido da fila manual", async () => {
  // O buraco real: `LIA_AUTO_PURCHASE_OFF` só barrava o clique final, então o job nascia
  // do mesmo jeito, o pedido saía da fila manual e o operador nunca via "COMPRA MANUAL".
  await savePurchaseAccount({ storeKey: "oba", email: "compras@example.test", enabled: true, loginReady: true, paymentReady: true });
  const order = await paidOrder();
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { storeKey: "oba", storeLabel: "Oba", items: [{ sku: "oba-1", name: "Chá", qty: 2, unitPrice: 10, lineTotal: 20, storeKey: "oba", storeLabel: "Oba", productUrl: "https://www.obahortifruti.com.br/cha/p" }] },
  });

  const old = process.env.LIA_AUTO_PURCHASE_OFF;
  try {
    process.env.LIA_AUTO_PURCHASE_OFF = "true";
    assert.equal(await ensurePurchaseJobForPaidOrder(order.id), null, "com o kill-switch nenhum job automático nasce");
    const manual = await manualQueueJobForPaidOrder(order.id);
    assert.equal(manual?.status, MANUAL_QUEUE_STATUS, "o pedido pago fica visível como compra manual");
  } finally {
    if (old === undefined) delete process.env.LIA_AUTO_PURCHASE_OFF; else process.env.LIA_AUTO_PURCHASE_OFF = old;
  }
});

test("preparação de carrinho é opt-in: sem env, nenhuma loja monta carrinho sozinha", () => {
  const old = process.env.LIA_PURCHASE_PREP_STORES;
  try {
    delete process.env.LIA_PURCHASE_PREP_STORES;
    assert.deepEqual(preparationStores(), [], "o default era 'mercadolivre' e ninguém tinha pedido isso");
    process.env.LIA_PURCHASE_PREP_STORES = "mercadolivre";
    assert.deepEqual(preparationStores(), ["mercadolivre"]);
  } finally {
    if (old === undefined) delete process.env.LIA_PURCHASE_PREP_STORES; else process.env.LIA_PURCHASE_PREP_STORES = old;
  }
});

test("painel: token do operador entra na fila e é barrado nas rotas do dono", () => {
  const env = { ops: process.env.OPS_TOKEN, op: process.env.OPS_OPERATOR_TOKEN };
  try {
    process.env.OPS_TOKEN = "segredo-do-dono";
    process.env.OPS_OPERATOR_TOKEN = "segredo-do-operador";
    const withKey = (token: string) => new Request("https://lia.test/api/ops/orders", { headers: { "x-ops-key": token } });

    assert.equal(opsRole(withKey("segredo-do-dono")), "owner");
    assert.equal(opsRole(withKey("segredo-do-operador")), "operator");
    assert.equal(opsRole(withKey("chute")), null);

    // A fila de pedidos é do operador; contas de loja e Pix de saída não são.
    assert.equal(requireOpsKey(withKey("segredo-do-operador")), null);
    assert.equal(requireOpsOwner(withKey("segredo-do-operador"))?.status, 403);
    assert.equal(requireOpsOwner(withKey("segredo-do-dono")), null);
    assert.equal(ownerKeyMatches("segredo-do-operador"), false);

    // Cookie: cada papel guarda o HMAC do SEU segredo, então trocar o token do operador
    // derruba só a sessão dele.
    const cookie = (token: string) => new Request("https://lia.test/api/ops/orders", { headers: { cookie: `ops_session=${opsSessionCookieValue(token)}` } });
    assert.equal(opsRole(cookie("segredo-do-operador")), "operator");
    assert.equal(opsRole(cookie("segredo-do-dono")), "owner");

    // O link que a Lia manda no WhatsApp carrega o papel de quem pediu.
    assert.equal(opsLoginRole(createOpsLoginToken(Date.now(), "operator")), "operator");
    assert.equal(opsLoginRole(createOpsLoginToken(Date.now(), "owner")), "owner");
  } finally {
    if (env.ops === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = env.ops;
    if (env.op === undefined) delete process.env.OPS_OPERATOR_TOKEN; else process.env.OPS_OPERATOR_TOKEN = env.op;
  }
});

test("token do agente: entra como operador só pelo header e nunca mexe em dinheiro (dono 06/10)", () => {
  const env = { ops: process.env.OPS_TOKEN, op: process.env.OPS_OPERATOR_TOKEN, ag: process.env.LIA_AGENT_OPS_TOKEN };
  try {
    process.env.OPS_TOKEN = "segredo-do-dono";
    delete process.env.OPS_OPERATOR_TOKEN;
    process.env.LIA_AGENT_OPS_TOKEN = "segredo-do-agente";
    const header = new Request("https://lia.test/api/ops/orders/x", { headers: { "x-ops-key": "segredo-do-agente" } });
    const query = new Request("https://lia.test/api/ops/orders/x?key=segredo-do-agente");
    const cookie = new Request("https://lia.test/api/ops/orders/x", { headers: { cookie: `ops_session=${opsSessionCookieValue("segredo-do-agente")}` } });

    assert.equal(opsRole(header), "operator");
    assert.equal(isAgentRequest(header), true);
    assert.equal(requireOpsKey(header), null);
    assert.equal(requireOpsOwner(header)?.status, 403);
    assert.equal(opsRole(query, { allowQuery: true }), null, "?key= não vale para o agente");
    assert.equal(opsRole(cookie), null, "cookie não vale para o agente");
    assert.equal(createOpsLoginToken(Date.now(), "operator"), null, "agente não vira login de operador");

    for (const action of ["refund_provider", "confirm_refund", "purchase_failed_refund"]) {
      assert.equal(opsOrderActionDenied(action, "operator", true), true, action);
    }
    for (const action of ["notify", "cancel", "bought", "delivered", "set_store_cost"]) {
      assert.equal(opsOrderActionDenied(action, "operator", true), false, action);
    }
    // Operador contratado continua sem cancelar pago; dono faz tudo.
    assert.equal(opsOrderActionDenied("cancel", "operator", false), true);
    assert.equal(opsOrderActionDenied("purchase_failed_refund", "operator", false), false);
    assert.equal(opsOrderActionDenied("refund_provider", "owner", false), false);

    // Token do agente igual ao do dono é descartado (nunca rebaixa nem promove).
    process.env.LIA_AGENT_OPS_TOKEN = "segredo-do-dono";
    assert.equal(isAgentRequest(new Request("https://lia.test", { headers: { "x-ops-key": "segredo-do-dono" } })), false);
  } finally {
    if (env.ops === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = env.ops;
    if (env.op === undefined) delete process.env.OPS_OPERATOR_TOKEN; else process.env.OPS_OPERATOR_TOKEN = env.op;
    if (env.ag === undefined) delete process.env.LIA_AGENT_OPS_TOKEN; else process.env.LIA_AGENT_OPS_TOKEN = env.ag;
  }
});

test("login do operador falha fechado sem um segredo separado", () => {
  const env = { ops: process.env.OPS_TOKEN, op: process.env.OPS_OPERATOR_TOKEN };
  try {
    process.env.OPS_TOKEN = "segredo-do-dono";
    delete process.env.OPS_OPERATOR_TOKEN;
    assert.equal(createOpsLoginToken(Date.now(), "operator"), null);
    process.env.OPS_OPERATOR_TOKEN = "segredo-do-dono";
    assert.equal(createOpsLoginToken(Date.now(), "operator"), null);
  } finally {
    if (env.ops === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = env.ops;
    if (env.op === undefined) delete process.env.OPS_OPERATOR_TOKEN; else process.env.OPS_OPERATOR_TOKEN = env.op;
  }
});

test("fila do operador omite Pix, ids internos e evidência de compra automática", () => {
  const raw = [{
    id: "order-1", userId: "user-1", conversationId: "convo-1", pixId: "pix-1",
    pixCopiaECola: "000201-segredo", courierQuoteId: "quote-1", phone: "+5511999999999",
    purchaseJobs: [{ status: "manual_queue", checkoutEvidence: { segredo: true } }],
    events: [{ id: "event-1", kind: "bought", deliveryStatus: "delivered", lastError: null, occurredAt: new Date(), message: "interno" }],
  }];
  assert.equal(ordersForOpsRole(raw, "owner"), raw);
  const [view] = ordersForOpsRole(raw, "operator") as Array<Record<string, unknown>>;
  assert.equal(view.userId, undefined);
  assert.equal(view.conversationId, undefined);
  assert.equal(view.pixId, undefined);
  assert.equal(view.pixCopiaECola, undefined);
  assert.equal(view.courierQuoteId, undefined);
  assert.equal(view.purchaseJobs, undefined);
  assert.equal(view.manualPurchase, true);
  assert.deepEqual(Object.keys((view.events as Array<Record<string, unknown>>)[0]).sort(), ["deliveryStatus", "id", "kind", "lastError", "occurredAt"]);
});

test("link do operador nunca manda outra loja para o Oba", () => {
  assert.equal(operatorStoreItemUrl({ name: "Ração", storeKey: "cobasi", productUrl: "https://www.cobasi.com.br/racao/p" }), "https://www.cobasi.com.br/racao/p");
  assert.match(operatorStoreItemUrl({ name: "Ração premium", storeKey: "cobasi" }), /site%3Acobasi\.com\.br/);
  assert.match(operatorStoreItemUrl({ name: "Carne", storeKey: "swift" }), /site%3Aswift\.com\.br/);
  assert.match(operatorStoreItemUrl({ name: "Ração", storeKey: "petz" }), /^https:\/\/www\.petz\.com\.br\/busca/);
});

test("telefones: dono e operador se separam sem quebrar quem opera sozinho", () => {
  const env = { owner: process.env.LIA_OWNER_PHONE, operator: process.env.LIA_OPERATOR_PHONE, admins: process.env.LIA_ADMIN_PHONES };
  try {
    delete process.env.LIA_ADMIN_PHONES;
    // Hoje (dono operando sozinho): o número do operador É o dono, nada muda.
    delete process.env.LIA_OWNER_PHONE;
    process.env.LIA_OPERATOR_PHONE = "+5511999990000";
    assert.equal(phoneRole("+5511999990000"), "owner");
    assert.equal(operatorIsHired(), false);
    assert.deepEqual(ownerPhones(), ["+5511999990000"]);

    // Depois da contratação: quem compra é outro número, e só o dono é dono.
    process.env.LIA_OWNER_PHONE = "+5511999990000";
    process.env.LIA_OPERATOR_PHONE = "+5511988887777";
    assert.equal(phoneRole("+5511999990000"), "owner");
    assert.equal(phoneRole("+5511988887777"), "operator");
    assert.equal(phoneRole("+5511900000000"), null, "cliente comum não tem papel");
    assert.equal(operatorIsHired(), true);
  } finally {
    for (const [key, value] of [["LIA_OWNER_PHONE", env.owner], ["LIA_OPERATOR_PHONE", env.operator], ["LIA_ADMIN_PHONES", env.admins]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("horário de quem compra: fora da janela a Lia promete a manhã, não 'já estou separando'", () => {
  const at = (iso: string) => new Date(iso);
  // 14h e 9h em São Paulo (UTC-3) estão dentro; 23h e 7h não.
  assert.equal(withinOperatorHours(at("2026-09-15T17:00:00Z"), "9-20"), true);
  assert.equal(withinOperatorHours(at("2026-09-15T12:00:00Z"), "9-20"), true);
  assert.equal(withinOperatorHours(at("2026-09-16T02:00:00Z"), "9-20"), false, "23h de SP");
  assert.equal(withinOperatorHours(at("2026-09-15T10:00:00Z"), "9-20"), false, "7h de SP");
  // Janela inválida nunca cala a Lia: na dúvida, promete o de sempre.
  assert.equal(withinOperatorHours(at("2026-09-16T02:00:00Z"), "20-9"), true);
  assert.equal(withinOperatorHours(at("2026-09-16T02:00:00Z"), "lixo"), true);
});
