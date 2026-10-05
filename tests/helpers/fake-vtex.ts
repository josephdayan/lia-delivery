// Loja VTEX de mentira para os testes do comprador no servidor (25/09/2026). Reproduz as
// respostas reais observadas na Drogaria SP em 25/09: cesta, perfil, endereço com SLAs,
// Pix, transaction, cofre (vault) e gatewayCallback 428 com o Payment App do Pix.
import { crc16 } from "../../src/lib/pix-emv";

export function emv(amount: string, opts: { dynamic?: boolean; txid?: string } = {}) {
  const tlv = (id: string, v: string) => `${id}${String(v.length).padStart(2, "0")}${v}`;
  const account = tlv("26", tlv("00", "br.gov.bcb.pix") + (opts.dynamic === false ? tlv("01", "chave@example.test") : tlv("25", "pix.adyen.com/pixqrcodelocation/pixloc/v1/loc/ABC")));
  const body = tlv("00", "01") + tlv("01", "12") + account + tlv("52", "0000") + tlv("53", "986") + tlv("54", amount) + tlv("58", "BR") + tlv("59", "DROGARIA SAO PAULO SA") + tlv("60", "SAO PAULO") + tlv("62", tlv("05", opts.txid ?? "***")) + "6304";
  return body + crc16(body);
}

export type FakeVtexOptions = {
  domain?: string;
  skuId?: string;
  priceCents?: number;
  available?: boolean;
  slas?: { id: string; price: number; shippingEstimate: string; deliveryChannel?: string; availableDeliveryWindows?: { startDateUtc: string; endDateUtc: string; price: number }[] }[];
  transactionStatus?: number;
  vaultStatus?: number;
  callbackHasPix?: boolean;
  orderGroup?: string;
  pixAmount?: string;
  // Desconto no Pix (Kopenhagen 3%): o pagamento fica menor que a cesta.
  pixDiscountCents?: number;
  // Sellers do SKU na busca por skuId (marketplace). Padrão: só a loja ("1") com estoque.
  sellers?: { sellerId: string; available: number; price?: number }[];
  // Promoção "leve 2" (Drogarias Pacheco 05/10): a 2ª unidade em diante volta numa linha
  // separada com este preço.
  splitPriceCents?: number;
};
export function fakeVtex(opts: FakeVtexOptions = {}) {
  const domain = opts.domain ?? "www.drogariasaopaulo.com.br";
  const skuId = opts.skuId ?? "354260";
  const price = opts.priceCents ?? 539;
  const slas = opts.slas ?? [
    { id: "NORMAL", price: 690, shippingEstimate: "2bd" },
    { id: "SUPER EXPRESSA", price: 890, shippingEstimate: "90m" },
    { id: "Retira na loja", price: 0, shippingEstimate: "1h", deliveryChannel: "pickup-in-point" },
  ];
  const orderGroup = opts.orderGroup ?? "v123456dgsp";
  const calls: { method: string; url: string; body: unknown }[] = [];
  let form: Record<string, unknown> = { orderFormId: "of1", items: [], value: 0, totalizers: [], messages: [] };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const recompute = () => {
    const items = form.items as { quantity: number; sellingPrice: number }[];
    const itemsTotal = items.reduce((a, i) => a + i.quantity * i.sellingPrice, 0);
    const li = ((form.shippingData as { logisticsInfo?: { selectedSla?: string; slas: { id: string; price: number; deliveryWindow?: { price?: number } }[] }[] } | undefined)?.logisticsInfo ?? []);
    const shipping = li.reduce((a, l) => { const x = l.slas.find((s) => s.id === l.selectedSla); return a + (x?.price ?? 0) + (x?.deliveryWindow?.price ?? 0); }, 0);
    form.totalizers = [{ id: "Items", value: itemsTotal }, ...(li.length ? [{ id: "Shipping", value: shipping }] : [])];
    form.value = itemsTotal + shipping;
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    if (u.hostname === "brasilapi.com.br") return json(200, { cep: "01233020", state: "SP", city: "São Paulo", neighborhood: "Santa Cecília", street: "Rua Engenheiro Edgar Egidio de Souza", location: { coordinates: { latitude: "-23.5372", longitude: "-46.6533" } } });
    if (u.hostname === "viacep.com.br") return json(200, { logradouro: "Rua Engenheiro Edgar Egidio de Souza", bairro: "Santa Cecília", localidade: "São Paulo", uf: "SP" });
    if (u.hostname === "api.vtexvault.com" || u.hostname.endsWith(".vtexpayments.com.br")) return json(opts.vaultStatus ?? 201, opts.vaultStatus && opts.vaultStatus >= 400 ? "<html>Error</html>" : "");
    if (u.hostname !== domain) return json(404, { error: "host" });
    const p = u.pathname;
    if (p === "/api/catalog_system/pub/products/search") {
      const id = (u.searchParams.get("fq") ?? "").replace("skuId:", "");
      const sellers = opts.sellers ?? [{ sellerId: "1", available: opts.available === false ? 0 : 99 }];
      return json(200, [{ productName: "Sabonete Dove", items: [{ itemId: id, sellers: sellers.map((s) => ({ sellerId: s.sellerId, commertialOffer: { AvailableQuantity: s.available, Price: (s.price ?? price) / 100 } })) }] }]);
    }
    if (p === "/api/checkout/pub/orderForm") return json(200, form, { "set-cookie": "checkout.vtex.com=__ofid=of1; Path=/" });
    if (p.endsWith("/items/removeAll")) { form = { ...form, items: [], shippingData: undefined, paymentData: undefined }; recompute(); return json(200, form); }
    if (p.endsWith("/items")) {
      const wanted = (body.orderItems as { id: string; quantity: number; seller: string }[]);
      form.items = wanted.flatMap((w) => {
        const row = (quantity: number, unit: number) => ({ id: w.id, name: "Sabonete Dove Creamy Comfort 90g", seller: w.seller, quantity, sellingPrice: unit, availability: w.id === skuId && opts.available !== false && (opts.sellers ?? [{ sellerId: "1", available: 99 }]).some((s) => s.sellerId === w.seller && s.available >= w.quantity) ? "available" : "withoutStock", priceDefinition: { total: unit * quantity } });
        return opts.splitPriceCents && w.quantity > 1 ? [row(1, price), row(w.quantity - 1, opts.splitPriceCents)] : [row(w.quantity, price)];
      });
      recompute(); return json(200, form);
    }
    if (p.endsWith("/attachments/clientProfileData")) { form.clientProfileData = { email: body.email, documentType: body.documentType, isCorporate: body.isCorporate }; return json(200, form); }
    if (p.endsWith("/attachments/shippingData")) {
      // A seleção de SLA vem junto com `selectedAddresses` (o checkout reenvia o shippingData
      // inteiro), então a seleção tem precedência sobre recriar a logística.
      if (body.logisticsInfo && form.shippingData) {
        const li = (form.shippingData as { logisticsInfo: { itemIndex: number; selectedSla: string | null; selectedDeliveryChannel: string | null; slas: unknown[] }[] }).logisticsInfo;
        for (const sel of body.logisticsInfo as { itemIndex: number; selectedSla: string; selectedDeliveryChannel: string; deliveryWindow?: unknown }[]) { li[sel.itemIndex].selectedSla = sel.selectedSla; li[sel.itemIndex].selectedDeliveryChannel = sel.selectedDeliveryChannel; (li[sel.itemIndex] as { deliveryWindow?: unknown }).deliveryWindow = null; const chosenSla = (li[sel.itemIndex].slas as { id: string; deliveryWindow?: unknown }[]).find((x) => x.id === sel.selectedSla); if (chosenSla && sel.deliveryWindow) chosenSla.deliveryWindow = sel.deliveryWindow; }
      } else if (body.selectedAddresses) {
        const items = form.items as unknown[];
        form.shippingData = { selectedAddresses: body.selectedAddresses, logisticsInfo: items.map((_, i) => ({ itemIndex: i, selectedSla: null, selectedDeliveryChannel: null, slas: slas.map((s) => ({ name: s.id, deliveryChannel: "delivery", ...s })) })) };
      }
      recompute(); return json(200, form);
    }
    if (p.endsWith("/attachments/paymentData")) {
      const value = (form.value as number) - (opts.pixDiscountCents ?? 0);
      form.paymentData = { payments: [{ paymentSystem: "125", bin: null, accountId: null, tokenId: null, installments: 1, referenceValue: value, value, merchantSellerPayments: [{ id: "DROGARIASP", installments: 1, referenceValue: value, value, interestRate: 0, installmentValue: value }] }] };
      return json(200, form);
    }
    if (p.endsWith("/transaction")) {
      const status = opts.transactionStatus ?? 200;
      const needsWindow = ((form.shippingData as { logisticsInfo?: { selectedSla?: string; slas: { id: string; availableDeliveryWindows?: unknown[]; deliveryWindow?: unknown }[] }[] } | undefined)?.logisticsInfo ?? [])
        .some((l) => { const x = l.slas.find((y) => y.id === l.selectedSla); return (x?.availableDeliveryWindows?.length ?? 0) > 0 && !x?.deliveryWindow; });
      if (needsWindow) return json(400, { error: { code: "ORD006", message: "A janela de entrega é obrigatória" } });
      if (status !== 200) return json(status, { error: { code: status === 403 ? "CHK0082" : "ORD007", message: "recusado" } });
      return json(200, { orderGroup, id: "TID1", receiverUri: `https://drogariasp.vtexpayments.com.br/split/${orderGroup}/payments`, gatewayCallbackTemplatePath: `/checkout/gatewayCallback/${orderGroup}/{messageCode}`, merchantTransactions: [{ id: "DROGARIASP", transactionId: "TID1", merchantName: "DROGARIASP", payments: [{ paymentSystem: "125", value: form.value, referenceValue: form.value }] }], paymentData: form.paymentData });
    }
    if (p.includes("/gatewayCallback/")) {
      if (opts.callbackHasPix === false) return json(500, { error: { code: "CHK0223" } });
      const code = emv(opts.pixAmount ?? (((form.value as number) - (opts.pixDiscountCents ?? 0)) / 100).toFixed(2));
      return json(428, { RedirectResponseCollection: [], paymentAuthorizationAppCollection: [{ appName: "vtex.pix-payment", appPayload: JSON.stringify({ code, expiresAt: "2026-09-25 15:00:00Z", paymentId: "P1", transactionId: "TID1", qrCodeBase64Image: "" }) }] });
    }
    return json(404, { error: p });
  };
  return { fetchImpl, calls, get form() { return form; } };
}
