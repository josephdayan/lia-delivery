import "./helpers/load-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { classifyStoreMail } from "../src/lib/mailbox-policy";
import { readStoreOrder, pollVtexOrderStatuses, etaTextFrom } from "../src/lib/purchase/vtex-status";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";

const sent: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => { sent.push({ to, text }); return { provider: "test", to, text }; };
const users: string[] = [];
after(async () => {
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: users } } });
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: users } } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

test("e-mail: só a última milha vira 'saiu pra entrega'; 'a caminho'/'transportadora' é envio", () => {
  const from = '"Martins Fontes" <pedidos@martinsfontespaulista.com.br>';
  const k = (subject: string) => classifyStoreMail("martinsfontes", { from, subject, text: "Pedido 1234567890-01" })?.kind;
  assert.equal(k("Seu pedido saiu para entrega"), "out_for_delivery");
  assert.equal(k("Seu pedido está em rota de entrega"), "out_for_delivery");
  assert.equal(k("Seu pedido está a caminho"), "shipped");
  assert.equal(k("Pedido enviado"), "shipped");
  assert.equal(k("Pedido 1234567890-01: produtos encaminhados para a transportadora"), "shipped");
  assert.equal(k("Pedido faturado"), "invoiced");
  assert.equal(k("Seu pedido foi entregue"), "delivered");
});

test("status da loja: lê estado, previsão, rastreio e só marca última milha com evento explícito", () => {
  const base = { state: "invoiced", shippingData: { logisticsInfo: [{ shippingEstimateDate: "2026-09-30T18:00:00Z" }] } };
  assert.deepEqual(readStoreOrder(base), { state: "invoiced", eta: "2026-09-30T18:00:00Z" });
  const shipped = readStoreOrder({ ...base, packageAttachment: { packages: [{ trackingUrl: "https://rastreio.example/abc", courierStatus: { finished: false, data: [{ description: "Objeto postado", createDate: "2026-09-28T10:00:00Z" }, { description: "Em trânsito para a unidade de distribuição", createDate: "2026-09-29T08:00:00Z" }] } }] } });
  assert.ok(shipped.shipped && !shipped.lastMile && !shipped.delivered);
  assert.equal(shipped.trackingUrl, "https://rastreio.example/abc");
  const lastMile = readStoreOrder({ ...base, packageAttachment: { packages: [{ courierStatus: { finished: false, data: [{ description: "Objeto postado", createDate: "2026-09-28T10:00:00Z" }, { description: "Objeto saiu para entrega ao destinatário", createDate: "2026-09-30T09:00:00Z" }] } }] } });
  assert.equal(lastMile.lastMile?.toISOString(), "2026-09-30T09:00:00.000Z");
  const delivered = readStoreOrder({ ...base, packageAttachment: { packages: [{ courierStatus: { finished: true, deliveredDate: "2026-09-30T15:00:00Z", data: [{ description: "Entregue" }] } }] } });
  assert.equal(delivered.delivered?.toISOString(), "2026-09-30T15:00:00.000Z");
  assert.equal(etaTextFrom("2026-09-27T20:00:00Z", new Date("2026-09-27T15:00:00Z")), "hoje");
  assert.equal(etaTextFrom("2026-09-28T20:00:00Z", new Date("2026-09-27T15:00:00Z")), "amanhã");
  assert.match(etaTextFrom("2026-09-30T20:00:00Z", new Date("2026-09-27T15:00:00Z"))!, /^até qua, 30\/09$/);
});

test("pedido comprado pelo servidor: faturado → envio → saiu pra entrega → entregue, cada aviso uma vez e com o texto certo", async () => {
  const user = await prisma.user.create({ data: { phone: `+55090988${process.pid}1`, name: "Cliente" } });
  users.push(user.id);
  const order = await prisma.deliveryOrder.create({ data: {
    userId: user.id, phone: user.phone, status: "retailer_preparing", storeKey: "martinsfontes", storeLabel: "Martins Fontes", storeOrderNumber: "v999dgsp-01",
    items: [{ sku: "martinsfontes-1", name: "Livro", qty: 1, unitPrice: 50, storeKey: "martinsfontes", storeLabel: "Martins Fontes" }], itemsSubtotal: 50, total: 60,
    paidAt: new Date(Date.now() - 3_600_000), courierKey: "retailer_delivery",
  } });
  // Mensagens recentes do cliente = janela de 24h aberta (aviso vai como texto).
  const convo = await prisma.conversation.create({ data: { userId: user.id } });
  await prisma.message.create({ data: { conversationId: convo.id, sender: "user", text: "oi" } });
  const job = await prisma.purchaseJob.create({ data: { deliveryOrderId: order.id, fulfillmentKey: "martinsfontes", storeKey: "martinsfontes", storeLabel: "Martins Fontes", status: "completed", storeOrderNumber: "v999dgsp-01" } });
  await prisma.purchaseAttempt.create({ data: { purchaseJobId: job.id, step: "vtex_order", status: "placed", idempotencyKey: "vtex-order:t1", details: { orderGroup: "v999dgsp", storeOrderNumber: "v999dgsp-01", cookies: { CheckoutDataAccess: "x" } } } });
  await prisma.trackingSubscription.create({ data: { deliveryOrderId: order.id, storeKey: "martinsfontes", storeOrderNumber: "v999dgsp-01" } });
  let state: Record<string, unknown> = { state: "payment-approved" };
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(`${url} cookie=${(init?.headers as Record<string, string>)?.Cookie ?? ""}`);
    return new Response(JSON.stringify([{ orderId: "v999dgsp-01", ...state }]), { status: 200 });
  };
  const tick = async () => {
    await prisma.trackingSubscription.updateMany({ where: { deliveryOrderId: order.id }, data: { nextCheckAt: new Date(0) } });
    return pollVtexOrderStatuses({ fetchImpl });
  };
  const mine = () => sent.filter((m) => m.to === user.phone).map((m) => m.text);

  await tick();
  assert.equal(mine().length, 0, "pagamento aprovado na loja: nada a dizer");
  const nextIn = async () => ((await prisma.trackingSubscription.findUniqueOrThrow({ where: { deliveryOrderId: order.id } })).nextCheckAt!.getTime() - Date.now()) / 60_000;
  assert.ok((await nextIn()) > 50, "sem previsão próxima: olha de hora em hora");
  // Entrega rápida (Expressa 30 min, Drogal 08/10): previsão nas próximas 2h → olha a cada 5 min.
  state = { state: "payment-approved", shippingData: { logisticsInfo: [{ shippingEstimateDate: new Date(Date.now() + 25 * 60_000).toISOString() }] } };
  await tick();
  assert.ok((await nextIn()) <= 5.1, "previsão em 25 min: próxima olhada em ≤ 5 min");
  state = { state: "payment-approved" };
  assert.match(calls[0], /martinsfontespaulista\.com\.br\/api\/checkout\/pub\/orders\/order-group\/v999dgsp cookie=CheckoutDataAccess=x/);

  state = { state: "invoiced", shippingData: { logisticsInfo: [{ shippingEstimateDate: new Date(Date.now() + 3 * 86_400_000).toISOString() }] } };
  await tick(); await tick();
  assert.equal(mine().length, 1, "faturado avisa UMA vez");
  assert.match(mine()[0], /emitiu a nota .* preparando o envio — previsão de entrega: até /);
  assert.doesNotMatch(mine()[0], /saiu/i);

  state = { ...state, packageAttachment: { packages: [{ trackingUrl: "https://rastreio.example/abc", courierStatus: { finished: false, data: [{ description: "Objeto postado", createDate: new Date(Date.now() - 60_000).toISOString() }] } }] } };
  await tick(); await tick();
  const afterShip = mine();
  assert.equal(afterShip.length, 2);
  assert.match(afterShip[1], /A loja enviou seu pedido/);
  assert.doesNotMatch(afterShip[1], /saiu pra entrega\./, "envio pela transportadora NÃO é 'saiu pra entrega'");
  assert.match(afterShip[1], /rastreio\.example/);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "retailer_out_for_delivery");

  state = { ...state, packageAttachment: { packages: [{ trackingUrl: "https://rastreio.example/abc", courierStatus: { finished: false, data: [{ description: "Objeto postado", createDate: new Date(Date.now() - 60_000).toISOString() }, { description: "Objeto saiu para entrega ao destinatário", createDate: new Date(Date.now() - 30_000).toISOString() }] } }] } };
  await tick(); await tick();
  assert.equal(mine().length, 3);
  assert.match(mine()[2], /saiu pra entrega/);

  state = { ...state, packageAttachment: { packages: [{ courierStatus: { finished: true, deliveredDate: new Date(Date.now() - 10_000).toISOString(), data: [{ description: "Entregue" }] } }] } };
  await tick();
  assert.equal(mine().length, 4);
  assert.match(mine()[3], /Entregue/);
  assert.equal((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "delivered");
  assert.ok((await prisma.trackingSubscription.findUniqueOrThrow({ where: { deliveryOrderId: order.id } })).completedAt);
});
