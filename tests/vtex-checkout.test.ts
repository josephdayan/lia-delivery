import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { VtexCheckoutSession, VtexCheckoutRejected, VtexOrderWithoutPayment, vtexOrderId, VTEX_API_STORE_KEYS } from "../src/lib/purchase/vtex-checkout";
import { checkCheckout } from "../src/lib/purchase-execution";
import { splitAddressText, resolveVtexAddress } from "../src/lib/purchase/vtex-address";
import { parsePixEmv } from "../src/lib/pix-emv";
import { classifyStoreMail } from "../src/lib/mailbox-policy";
import { fakeVtex } from "./helpers/fake-vtex";

const profile = { email: "compras@example.test", firstName: "Lia", lastName: "Delivery", document: "12345678000199", documentType: "cnpj" as const, corporateName: "Lia Delivery" };
const address = { receiverName: "Joseph Teste", postalCode: "01233020", street: "Rua Engenheiro Edgar Egidio de Souza", number: "221", complement: "ap 13", neighborhood: "Santa Cecília", city: "São Paulo", state: "SP", geo: { lat: -23.5372, lng: -46.6533 } };
const job = { cartHash: "a".repeat(64), customerAddress: "Rua Engenheiro Edgar Egidio de Souza, 221 ap 13, Santa Cecília, São Paulo, SP", items: [{ sku: "dsp-354260" }] };

test("endereço: número e complemento do texto do cliente; rua/bairro/cidade/UF do CEP; geo", async () => {
  assert.deepEqual(splitAddressText("Rua Engenheiro Edgar Egidio de Souza, 221 ap 13, Santa Cecília, São Paulo, SP, CEP 01233-020", { neighborhood: "Santa Cecília", city: "São Paulo", uf: "SP" }, "01233-020"),
    { street: "Rua Engenheiro Edgar Egidio de Souza", number: "221", complement: "ap 13" });
  assert.deepEqual(splitAddressText("Av. Paulista 1000", {}), { street: "Av. Paulista", number: "1000", complement: "" });
  assert.deepEqual(splitAddressText("Rua X, nº 45, bloco B apto 12, Centro, São Paulo - SP", { neighborhood: "Centro", city: "São Paulo", uf: "SP" }), { street: "Rua X", number: "45", complement: "bloco B apto 12" });
  assert.equal(splitAddressText("Rua sem número", {}).number, "");
  const fake = fakeVtex();
  const resolved = await resolveVtexAddress({ receiverName: "Joseph Teste", cep: "01233-020", addressText: job.customerAddress, fetchImpl: fake.fetchImpl });
  assert.equal(resolved.street, "Rua Engenheiro Edgar Egidio de Souza");
  assert.equal(resolved.number, "221");
  assert.equal(resolved.complement, "ap 13");
  assert.equal(resolved.state, "SP");
  assert.ok(resolved.geo && resolved.geo.lat < 0);
  await assert.rejects(resolveVtexAddress({ receiverName: "X", cep: "01233-020", addressText: "Rua sem numero", fetchImpl: fake.fetchImpl }), /sem número/);
});

test("cesta → PJ → entrega no prazo prometido (mais barata) → Pix; evidência no formato do servidor", async () => {
  const fake = fakeVtex();
  const session = new VtexCheckoutSession("drogariasp", fake.fetchImpl);
  await session.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address, deliveryPromise: "pela própria loja · prazo da loja: 90 min" });
  const profileCall = fake.calls.find((c) => c.url.endsWith("/attachments/clientProfileData"))!.body as Record<string, unknown>;
  assert.equal(profileCall.documentType, "cnpj");
  assert.equal(profileCall.isCorporate, true);
  assert.equal(profileCall.corporateDocument, "12345678000199");
  const shipCall = fake.calls.find((c) => c.url.endsWith("/attachments/shippingData"))!.body as { selectedAddresses: Record<string, unknown>[] };
  assert.deepEqual(shipCall.selectedAddresses[0].geoCoordinates, [-46.6533, -23.5372]);
  const e = session.snapshot(job);
  assert.equal(e.deliveryOption, "SUPER EXPRESSA", "90 min prometido → só a SUPER EXPRESSA cabe (retira nunca)");
  assert.equal(e.deliveryPromise, "prazo da loja: 90 min");
  assert.equal(e.freightCents, 890);
  assert.equal(e.totalCents, 1429);
  assert.deepEqual(e.items[0], { sku: "dsp-354260", retailerSku: "354260", seller: "1", name: "Sabonete Dove Creamy Comfort 90g", qty: 1, unitPriceCents: 539, lineTotalCents: 539 });
  assert.equal(e.recipientName, "Joseph Teste");
  assert.equal(e.postalCode, "01233020");
  assert.deepEqual(e.payment, { kind: "pix_store", paymentSystem: 125 });
  // Sem promessa legível: a mais barata.
  const cheap = new VtexCheckoutSession("drogariasp", fakeVtex().fetchImpl);
  await cheap.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address });
  assert.equal(cheap.snapshot(job).deliveryOption, "NORMAL");
  // Cookie do checkout guardado para leituras posteriores.
  assert.ok(Object.keys(session.cookies()).includes("checkout.vtex.com"));
});

test("fechamento: transaction → vault → callback 428 com o Pix do Payment App", async () => {
  const fake = fakeVtex();
  const session = new VtexCheckoutSession("drogariasp", fake.fetchImpl);
  await session.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address, deliveryPromise: "prazo da loja: 90 min" });
  const pix = await session.placeOrder();
  assert.equal(pix.orderGroup, "v123456dgsp");
  assert.equal(vtexOrderId(pix.orderGroup), "v123456dgsp-01");
  assert.equal(pix.transactionId, "TID1");
  assert.equal(pix.expiresAt, "2026-09-25 15:00:00Z");
  const parsed = parsePixEmv(pix.code);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.amountCents, 1429);
  const vault = fake.calls.find((c) => c.url.startsWith("https://api.vtexvault.com/"))!;
  const url = new URL(vault.url);
  assert.equal(url.pathname, "/api/payments/transactions/TID1/payments");
  assert.equal(url.searchParams.get("orderId"), "v123456dgsp");
  assert.equal(url.searchParams.get("redirect"), "false");
  assert.equal(url.searchParams.get("callbackUrl"), "https://www.drogariasaopaulo.com.br/checkout/gatewayCallback/v123456dgsp/{messageCode}");
  assert.equal(url.searchParams.get("an"), "drogariasp");
  const payment = (vault.body as Record<string, unknown>[])[0];
  assert.equal(payment.id, "DROGARIASP");
  assert.deepEqual(payment.transaction, { id: "TID1", merchantName: "DROGARIASP" });
  assert.equal(payment.group, "instantPaymentPaymentGroup");
  assert.equal(payment.currencyCode, "BRL");
  assert.equal(payment.installmentsValue, 1429);
  assert.ok(!fake.calls.some((c) => c.url.includes("/split/")), "nunca o receiverUri /split");
});

test("recusas: item sem estoque e transaction 403 esvaziam a cesta; gateway 500 = pedido sem pagamento", async () => {
  const out = fakeVtex({ available: false });
  await assert.rejects(new VtexCheckoutSession("drogariasp", out.fetchImpl).prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address }), (e: unknown) => e instanceof VtexCheckoutRejected && e.stage === "items");
  const captcha = fakeVtex({ transactionStatus: 403 });
  const s1 = new VtexCheckoutSession("drogariasp", captcha.fetchImpl);
  await s1.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address });
  await assert.rejects(s1.placeOrder(), (e: unknown) => e instanceof VtexCheckoutRejected && e.stage === "transaction" && e.status === 403);
  assert.ok(captcha.calls.some((c) => c.url.endsWith("/items/removeAll")), "cesta esvaziada após recusa");
  const noPay = fakeVtex({ vaultStatus: 500 });
  const s2 = new VtexCheckoutSession("drogariasp", noPay.fetchImpl);
  await s2.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address });
  await assert.rejects(s2.placeOrder(), (e: unknown) => e instanceof VtexOrderWithoutPayment && e.orderGroup === "v123456dgsp");
  assert.ok(!noPay.calls.some((c) => c.url.endsWith("/items/removeAll")), "pedido já existe: não mexe na cesta");
  await assert.rejects(new VtexCheckoutSession("drogariasp", fakeVtex().fetchImpl).prepare({ items: [{ sku: "cobasi-1", qty: 1 }], profile, address }), /não é da loja/);
});

test("e-mail da Drogaria SP: 'Pagamento foi aprovado' com número v…dgsp-01 vira `paid`", () => {
  const v = classifyStoreMail("drogariasp", { from: '"Drogaria São Paulo" <pedidos@drogariasaopaulo.com.br>', subject: "Drogaria São Paulo | Pagamento foi aprovado", text: "Olá, Lia ! Confirmamos o pagamento do seu pedido v79835708dgsp-01 :)" });
  assert.deepEqual(v, { kind: "paid", storeOrderNumber: "v79835708dgsp-01" });
  assert.equal(classifyStoreMail("drogariasp", { from: "golpe@example.test", subject: "Pagamento foi aprovado", text: "v79835708dgsp-01" }), null);
});

test("desconto no Pix (Kopenhagen/Ri Happy): total é o valor pago; conferência aceita itens + frete − desconto", async () => {
  const fake = fakeVtex({ pixDiscountCents: 43 });
  const session = new VtexCheckoutSession("drogariasp", fake.fetchImpl);
  await session.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address, deliveryPromise: "prazo da loja: 90 min" });
  const e = session.snapshot(job);
  assert.equal(e.totalCents, 1386);
  assert.equal(e.discountCents, 43);
  assert.equal(e.freightCents, 890);
  const order = { items: [{ sku: "dsp-354260", qty: 1, unitPrice: 5.39, storeKey: "drogariasp", productUrl: "https://www.drogariasaopaulo.com.br/sabonete/p" }], deliveryAddress: job.customerAddress, customerName: "Joseph Teste", cep: "01233-020", deliveryFee: 8.9, itemsSubtotal: 5.39, fulfillments: [{ deliveryPromise: "prazo da loja: 90 min" }] };
  const { purchaseCartHash } = await import("../src/lib/purchase-worker");
  const hash = purchaseCartHash(order.items.map((i) => ({ ...i, name: "", storeLabel: "" })), order.deliveryFee, "prazo da loja: 90 min", order);
  assert.doesNotThrow(() => checkCheckout(order, { ...e, cartHash: hash }));
  assert.throws(() => checkCheckout(order, { ...e, cartHash: hash, discountCents: 0 }), /não fecha/);
  const pix = await session.placeOrder();
  assert.equal(parsePixEmv(pix.code).amountCents, 1386);
  const tx = fake.calls.find((c) => c.url.endsWith("/transaction"))!.body as { value: number; referenceValue: number };
  assert.equal(tx.value, 1386);
  assert.equal(tx.referenceValue, 1429);
  assert.deepEqual(VTEX_API_STORE_KEYS.slice(0, 6), ["drogariasp", "cobasi", "paguemenos", "swift", "kopenhagen", "rihappy"]);
  assert.ok(VTEX_API_STORE_KEYS.includes("mambo") && VTEX_API_STORE_KEYS.includes("epocacosmeticos") && VTEX_API_STORE_KEYS.includes("drogal"));
});

test("seller do SKU na hora: própria loja preferida; marketplace único aceito; ambíguo ou sem estoque recusa", async () => {
  const own = fakeVtex({ sellers: [{ sellerId: "1", available: 5 }, { sellerId: "mkt1", available: 9 }] });
  const s1 = new VtexCheckoutSession("drogariasp", own.fetchImpl);
  await s1.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address });
  assert.equal((own.calls.find((c) => c.url.endsWith("/items"))!.body as { orderItems: { seller: string }[] }).orderItems[0].seller, "1");
  const mkt = fakeVtex({ sellers: [{ sellerId: "epc057", available: 3 }] });
  const s2 = new VtexCheckoutSession("drogariasp", mkt.fetchImpl);
  await s2.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address });
  assert.equal(s2.snapshot(job).items[0].seller, "epc057");
  await assert.rejects(new VtexCheckoutSession("drogariasp", fakeVtex({ sellers: [{ sellerId: "a", available: 3 }, { sellerId: "b", available: 3 }] }).fetchImpl).prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address }), /ambíguo/);
  await assert.rejects(new VtexCheckoutSession("drogariasp", fakeVtex({ sellers: [{ sellerId: "1", available: 1 }] }).fetchImpl).prepare({ items: [{ sku: "dsp-354260", qty: 2 }], profile, address }), /sem seller/);
});

test("entrega agendada (Mambo): escolhe a janela mais cedo, soma o preço dela e o prazo vai até o fim da janela", async () => {
  const start = new Date(Date.now() + 10 * 3_600_000), end = new Date(Date.now() + 13 * 3_600_000);
  const later = { startDateUtc: new Date(Date.now() + 20 * 3_600_000).toISOString(), endDateUtc: new Date(Date.now() + 23 * 3_600_000).toISOString(), price: 300 };
  const fake = fakeVtex({ slas: [{ id: "Entrega Agendada", price: 1290, shippingEstimate: "2h", availableDeliveryWindows: [later, { startDateUtc: start.toISOString(), endDateUtc: end.toISOString(), price: 300 }] }] });
  const session = new VtexCheckoutSession("drogariasp", fake.fetchImpl);
  await session.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address, deliveryPromise: "prazo da loja: 18h" });
  const sel = (fake.calls.filter((c) => c.url.endsWith("/attachments/shippingData")).at(-1)!.body as { logisticsInfo: { deliveryWindow?: { startDateUtc: string } }[] }).logisticsInfo[0];
  assert.equal(sel.deliveryWindow?.startDateUtc, start.toISOString(), "janela mais cedo");
  const e = session.snapshot(job);
  assert.equal(e.freightCents, 1590, "SLA 12,90 + janela 3,00");
  assert.match(e.deliveryPromise, /^prazo da loja: em até 13h \(/);
  assert.match(e.deliveryOption, /Entrega Agendada \[/);
  const pix = await session.placeOrder();
  assert.equal(parsePixEmv(pix.code).amountCents, 539 + 1590);
  // Promessa curta demais (2h) não cabe: recusa antes de criar pedido.
  await assert.rejects(new VtexCheckoutSession("drogariasp", fakeVtex({ slas: [{ id: "Entrega Agendada", price: 1290, shippingEstimate: "2h", availableDeliveryWindows: [{ startDateUtc: start.toISOString(), endDateUtc: end.toISOString(), price: 300 }] }] }).fetchImpl)
    .prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address, deliveryPromise: "prazo da loja: 2h" }), /prazo prometido/);
});
