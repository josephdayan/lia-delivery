// Checkout VTEX por HTTP puro, no servidor (25/09/2026). Portado de scripts/vtex-api-probe.mts,
// que fechou pedidos reais em Drogaria SP, Cobasi e Pague Menos sem navegador e sem CAPTCHA.
//
// O que a VTEX exige e o que aprendemos ao vivo:
//   - Perfil de convidado (`loggedIn:false`). Pessoa jurídica = `documentType:"cnpj"` +
//     `isCorporate` + `corporateDocument`; CNPJ em `documentType:"cpf"` dá `400 ORD007`.
//   - Entrega é decidida por item + coordenadas (Cobasi só oferece entrega com geo).
//   - O envio do pagamento NÃO vai ao `receiverUri` (/split → 500). O checkout-ui copia o
//     pagamento da cesta com `merchantSellerPayments`, anexa `transaction`, `currencyCode`,
//     `installments*` e posta em api.vtexvault.com com `orderId`, `redirect=false`,
//     `callbackUrl`, `deviceInfo` e `an`. O `gatewayCallback` responde 428 com
//     `paymentAuthorizationAppCollection[].appPayload` (vtex.pix-payment) = copia-e-cola.
// Nada aqui toca o banco; a máquina de estados fica em purchase-execution.ts.
import { effectiveSla, estimateMinutes, humanEstimate, promisedMinutes } from "../live-freight";
import { findPixCode } from "../pix-emv";
import type { CheckoutEvidence } from "../purchase-execution";

export const VTEX_API_STORES: Record<string, { domain: string; skuPrefix: string; label: string }> = {
  drogariasp: { domain: "www.drogariasaopaulo.com.br", skuPrefix: "dsp-", label: "Drogaria São Paulo" },
  cobasi: { domain: "www.cobasi.com.br", skuPrefix: "cobasi-", label: "Cobasi" },
  paguemenos: { domain: "www.paguemenos.com.br", skuPrefix: "paguemenos-", label: "Pague Menos" },
  // 25/09 (sondagem a seco no endereço do dono): abertas até o Pix.
  swift: { domain: "loja.swift.com.br", skuPrefix: "swift-", label: "Swift" },
  kopenhagen: { domain: "www.kopenhagen.com.br", skuPrefix: "kopenhagen-", label: "Kopenhagen" },
  rihappy: { domain: "www.rihappy.com.br", skuPrefix: "rihappy-", label: "Ri Happy" },
  // 25/09 (varredura de 80 varejistas + sondagem a seco): supermercado, beleza e farmácia.
  mambo: { domain: "www.mambo.com.br", skuPrefix: "mambo-", label: "Mambo" },
  americanas: { domain: "www.americanas.com.br", skuPrefix: "americanas-", label: "Americanas" },
  prezunic: { domain: "www.prezunic.com.br", skuPrefix: "prezunic-", label: "Prezunic" },
  zonasul: { domain: "www.zonasul.com.br", skuPrefix: "zonasul-", label: "Zona Sul" },
  covabra: { domain: "www.covabra.com.br", skuPrefix: "covabra-", label: "Covabra" },
  savegnago: { domain: "www.savegnago.com.br", skuPrefix: "savegnago-", label: "Savegnago" },
  wepink: { domain: "www.wepink.com.br", skuPrefix: "wepink-", label: "WePink" },
  underarmour: { domain: "www.underarmour.com.br", skuPrefix: "underarmour-", label: "Under Armour" },
  tokstok: { domain: "www.tokstok.com.br", skuPrefix: "tokstok-", label: "Tok&Stok" },
  pbkids: { domain: "www.pbkids.com.br", skuPrefix: "pbkids-", label: "PBKids" },
  osklen: { domain: "www.osklen.com.br", skuPrefix: "osklen-", label: "Osklen" },
  motorola: { domain: "www.motorola.com.br", skuPrefix: "motorola-", label: "Motorola" },
  livrariascuritiba: { domain: "www.livrariascuritiba.com.br", skuPrefix: "livrariascuritiba-", label: "Livrarias Curitiba" },
  fila: { domain: "www.fila.com.br", skuPrefix: "fila-", label: "Fila" },
  farmaciaindiana: { domain: "www.farmaciaindiana.com.br", skuPrefix: "farmaciaindiana-", label: "Farmácia Indiana" },
  extrafarma: { domain: "www.extrafarma.com.br", skuPrefix: "extrafarma-", label: "Extrafarma" },
  drogariaspacheco: { domain: "www.drogariaspacheco.com.br", skuPrefix: "drogariaspacheco-", label: "Drogarias Pacheco" },
  drogariacatarinense: { domain: "www.drogariacatarinense.com.br", skuPrefix: "drogariacatarinense-", label: "Drogaria Catarinense" },
  santaluzia: { domain: "www.santaluzia.com.br", skuPrefix: "santaluzia-", label: "Casa Santa Luzia" },
  cea: { domain: "www.cea.com.br", skuPrefix: "cea-", label: "C&A" },
  capodarte: { domain: "www.capodarte.com.br", skuPrefix: "capodarte-", label: "Capodarte" },
  aramis: { domain: "www.aramis.com.br", skuPrefix: "aramis-", label: "Aramis" },
  epocacosmeticos: { domain: "www.epocacosmeticos.com.br", skuPrefix: "epoca-", label: "Época Cosméticos" },
  drogal: { domain: "www.drogal.com.br", skuPrefix: "drogal-", label: "Drogal" },
  // 27/09: fora de farmácia/mercado (livros, casa, construção, presentes, skincare).
  martinsfontes: { domain: "www.martinsfontespaulista.com.br", skuPrefix: "martinsfontes-", label: "Martins Fontes" },
  brinox: { domain: "www.brinox.com.br", skuPrefix: "brinox-", label: "Brinox" },
  creamy: { domain: "www.creamy.com.br", skuPrefix: "creamy-", label: "Creamy" },
  casaevideo: { domain: "www.casaevideo.com.br", skuPrefix: "casaevideo-", label: "Casa & Vídeo" },
  telhanorte: { domain: "www.telhanorte.com.br", skuPrefix: "telhanorte-", label: "Telhanorte" },
  zonacriativa: { domain: "www.zonacriativa.com.br", skuPrefix: "zonacriativa-", label: "Zona Criativa" },  // 27/09 (2ª leva): eletro e casa.
  philco: { domain: "www.philco.com.br", skuPrefix: "philco-", label: "Philco" },
  mondial: { domain: "www.mondial.com.br", skuPrefix: "mondial-", label: "Mondial" },
  oxford: { domain: "www.oxfordporcelanas.com.br", skuPrefix: "oxford-", label: "Oxford Porcelanas" },
  polishop: { domain: "www.polishop.com.br", skuPrefix: "polishop-", label: "Polishop" },
  obramax: { domain: "www.obramax.com.br", skuPrefix: "obramax-", label: "Obramax" },
};
export const VTEX_API_STORE_KEYS = Object.keys(VTEX_API_STORES);
export const PIX_PAYMENT_SYSTEM = "125";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type Json = Record<string, unknown>;
export type VtexAddress = {
  receiverName: string;
  postalCode: string; // só dígitos
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
  geo?: { lat: number; lng: number };
};
// `phone`: obrigatório em 7 lojas (29/09: sem ele o conector de Pix recusava com CHK0223).
// `strictDocument` (remédio no CPF do cliente, 29/09): a loja PRECISA devolver este documento
// no perfil; perfil mascarado (e-mail já conhecido) ou outro documento aborta antes do pedido.
export type VtexBuyerProfile = { email: string; firstName: string; lastName: string; document: string; documentType: "cpf" | "cnpj"; corporateName?: string; phone?: string; strictDocument?: boolean };
export type VtexCartItem = { sku: string; qty: number };
export type VtexPix = { code: string; expiresAt?: string; paymentId?: string; transactionId: string; orderGroup: string };

export class VtexCheckoutRejected extends Error {
  constructor(public readonly stage: string, public readonly status: number, public readonly detail: string) {
    super(`${stage}: HTTP ${status} ${detail}`.slice(0, 400));
    this.name = "VtexCheckoutRejected";
  }
}
// Pedido criado na loja, mas o pagamento não foi enviado/lido: existe um pedido pendurado
// (a loja cancela sozinha sem Pix), então o resultado precisa de conferência humana.
export class VtexOrderWithoutPayment extends Error {
  constructor(public readonly orderGroup: string, public readonly detail: string) {
    super(`pedido ${orderGroup} criado sem pagamento: ${detail}`.slice(0, 400));
    this.name = "VtexOrderWithoutPayment";
  }
}

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\W/g, "");
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class VtexCheckoutSession {
  private readonly jar = new Map<string, string>();
  readonly base: string;
  private form: Json | null = null;
  constructor(readonly storeKey: string, private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 30_000) {
    const store = VTEX_API_STORES[storeKey];
    if (!store) throw new Error(`Loja sem checkout VTEX por API: ${storeKey}`);
    this.base = `https://${store.domain}/api/checkout/pub`;
  }
  get store() { return VTEX_API_STORES[this.storeKey]; }
  get domain() { return this.store.domain; }
  get orderForm(): Json | null { return this.form; }
  cookies(): Record<string, string> { return Object.fromEntries(this.jar); }

  private async call(url: string, body?: unknown, init: { method?: string } = {}) {
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await this.fetchImpl(url, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    for (const c of response.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, text, json };
  }
  private async orderFormCall(stage: string, path: string, body?: unknown) {
    const r = await this.call(`${this.base}${path}`, body);
    if (r.status !== 200 || !r.json || typeof r.json !== "object") throw new VtexCheckoutRejected(stage, r.status, r.text.slice(0, 300));
    this.form = r.json as Json;
    return this.form;
  }

  // Seller do SKU na hora da compra (mesma regra do comprador do Mac): marketplace (Época,
  // Ri Happy) vende o mesmo SKU por vários sellers; exige exatamente UM com estoque suficiente,
  // preferindo a própria loja ("1"). Sem seller disponível = item indisponível.
  private async sellerFor(id: string, quantity: number): Promise<string> {
    const r = await this.call(`https://${this.domain}/api/catalog_system/pub/products/search?fq=${encodeURIComponent(`skuId:${id}`)}`);
    if (r.status !== 200 && r.status !== 206) throw new VtexCheckoutRejected("seller", r.status, `catálogo não respondeu para o SKU ${id}`);
    const products = Array.isArray(r.json) ? (r.json as Json[]) : [];
    const sku = products.flatMap((p) => (p.items as Json[] | undefined) ?? []).find((i) => String(i.itemId) === id);
    const priced = ((sku?.sellers as Json[] | undefined) ?? []).filter((sl) => Number((sl.commertialOffer as Json | undefined)?.Price ?? 0) > 0);
    const sellers = priced.filter((sl) => Number((sl.commertialOffer as Json | undefined)?.AvailableQuantity ?? 0) >= quantity);
    // Estoque REGIONAL (Drogaria SP, 05/10): o catálogo sem CEP mostra 0 para a própria loja,
    // mas o carrinho com o endereço do cliente tem o item e entrega. Sem seller com estoque no
    // catálogo, a própria loja ("1") segue e quem decide é o carrinho com endereço (a
    // conferência recusa item que não ficar `available`).
    if (!sellers.length && priced.some((sl) => String(sl.sellerId) === "1")) return "1";
    if (!sellers.length) throw new VtexCheckoutRejected("items", 200, `item ${id} sem seller com estoque`);
    const own = sellers.find((sl) => String(sl.sellerId) === "1");
    if (own) return "1";
    if (sellers.length !== 1) throw new VtexCheckoutRejected("items", 200, `item ${id} com vendedor ambíguo (${sellers.length})`);
    return String(sellers[0].sellerId);
  }

  // 1–5: cesta → perfil → endereço (com geo) → entrega escolhida → Pix. Nada é criado na loja.
  async prepare(input: { items: VtexCartItem[]; profile: VtexBuyerProfile; address: VtexAddress; deliveryPromise?: string }) {
    const { skuPrefix } = this.store;
    const orderItems: { id: string; quantity: number; seller: string }[] = [];
    for (const item of input.items) {
      const id = item.sku.startsWith(skuPrefix) ? item.sku.slice(skuPrefix.length) : "";
      if (!/^\d+$/.test(id)) throw new VtexCheckoutRejected("sku", 0, `SKU ${item.sku} não é da loja ${this.storeKey}`);
      const quantity = Math.max(1, Math.round(item.qty));
      orderItems.push({ id, quantity, seller: await this.sellerFor(id, quantity) });
    }
    const created = await this.orderFormCall("orderForm", "/orderForm");
    const orderFormId = String(created.orderFormId);
    const withItems = await this.orderFormCall("items", `/orderForm/${orderFormId}/items`, { orderItems });
    const echoed = (withItems.items as Json[] | undefined) ?? [];
    for (const wanted of orderItems) {
      // A loja pode dividir a mesma linha em várias com preços diferentes (promoção "leve 2",
      // Drogarias Pacheco 05/10): a quantidade é a SOMA das linhas daquele item.
      const rows = echoed.filter((i) => String(i.id) === wanted.id);
      if (!rows.length) throw new VtexCheckoutRejected("items", 200, `item ${wanted.id} não entrou na cesta`);
      const off = rows.find((i) => i.availability !== "available");
      if (off) throw new VtexCheckoutRejected("items", 200, `item ${wanted.id} indisponível (${String(off.availability)})`);
      const got = rows.reduce((sum, i) => sum + Number(i.quantity), 0);
      if (got !== wanted.quantity) throw new VtexCheckoutRejected("items", 200, `item ${wanted.id}: quantidade ${String(got)} ≠ ${wanted.quantity}`);
    }
    const corporate = input.profile.documentType === "cnpj";
    const profiled = await this.orderFormCall("clientProfileData", `/orderForm/${orderFormId}/attachments/clientProfileData`, {
      email: input.profile.email,
      firstName: input.profile.firstName,
      lastName: input.profile.lastName,
      ...(input.profile.phone ? { phone: input.profile.phone } : {}),
      document: input.profile.document,
      documentType: input.profile.documentType,
      isCorporate: corporate,
      ...(corporate
        ? { corporateDocument: input.profile.document, corporateName: input.profile.corporateName ?? `${input.profile.firstName} ${input.profile.lastName}`.trim(), tradeName: input.profile.corporateName ?? "", stateInscription: "isento" }
        : {}),
    });
    if (input.profile.strictDocument) {
      const back = (profiled.clientProfileData as Json | undefined) ?? {};
      const got = String(back.document ?? "").replace(/\D/g, "");
      if (got !== input.profile.document.replace(/\D/g, "") || back.isCorporate === true)
        throw new VtexCheckoutRejected("clientProfileData", 200, "a loja não confirmou o CPF do comprador (perfil mascarado ou outro documento)");
    }
    const a = input.address;
    const shipped = await this.orderFormCall("shippingData", `/orderForm/${orderFormId}/attachments/shippingData`, {
      clearAddressIfPostalCodeNotFound: false,
      selectedAddresses: [{
        addressType: "residential",
        receiverName: a.receiverName,
        postalCode: a.postalCode,
        country: "BRA",
        street: a.street,
        number: a.number,
        complement: a.complement || null,
        neighborhood: a.neighborhood,
        city: a.city,
        state: a.state,
        ...(a.geo ? { geoCoordinates: [a.geo.lng, a.geo.lat] } : {}),
      }],
    });
    const messages = ((shipped.messages as Json[] | undefined) ?? []).map((m) => String(m.text ?? "")).filter(Boolean);
    const logistics = (((shipped.shippingData as Json | undefined)?.logisticsInfo as Json[] | undefined) ?? []);
    if (!logistics.length) throw new VtexCheckoutRejected("shippingData", 200, messages[0] ?? "loja não devolveu logística");
    const budget = promisedMinutes(input.deliveryPromise);
    const selection = logistics.map((line) => {
      // Entrega agendada: preço + janela mais cedo, prazo até o fim dela (mesma regra da cotação).
      const slas = ((line.slas as Json[] | undefined) ?? []).map((s) => effectiveSla(s as never) as unknown as Json).filter((s) =>
        s.deliveryChannel === "delivery" && typeof s.price === "number" && Number.isFinite(s.price) && (s.price as number) >= 0 && !/retir/i.test(String(s.name ?? s.id ?? "")));
      // Mesma regra do comprador do Mac (15/09): entrega com prazo igual ou MENOR que o
      // prometido ao cliente, a mais barata; empate → a mais rápida. Sem promessa legível,
      // a mais barata que exista.
      const fits = slas.filter((s) => budget == null || (estimateMinutes(String(s.shippingEstimate)) >= 0 && estimateMinutes(String(s.shippingEstimate)) <= budget));
      fits.sort((x, y) => (x.price as number) - (y.price as number) || estimateMinutes(String(x.shippingEstimate)) - estimateMinutes(String(y.shippingEstimate)));
      if (!fits.length) throw new VtexCheckoutRejected("sla", 200, messages[0] ?? (slas.length ? `nenhuma entrega dentro do prazo prometido (${input.deliveryPromise ?? "?"})` : "loja não entrega esse item nesse endereço"));
      const window = (fits[0] as { deliveryWindow?: Json }).deliveryWindow;
      return { itemIndex: Number(line.itemIndex ?? 0), selectedSla: String(fits[0].id), selectedDeliveryChannel: "delivery", ...(window ? { deliveryWindow: window } : {}) };
    });
    await this.orderFormCall("selectedSla", `/orderForm/${orderFormId}/attachments/shippingData`, { ...(shipped.shippingData as Json), logisticsInfo: selection });
    const value = Number(this.form!.value);
    const paid = await this.orderFormCall("paymentData", `/orderForm/${orderFormId}/attachments/paymentData`, {
      payments: [{ paymentSystem: PIX_PAYMENT_SYSTEM, referenceValue: value, value, installments: 1 }],
    });
    const payments = ((paid.paymentData as Json | undefined)?.payments as Json[] | undefined) ?? [];
    const payValue = Number(payments[0]?.value);
    // Desconto no Pix (Kopenhagen 3%, Ri Happy ~2%): o pagamento fica MENOR que a cesta; nunca maior.
    if (payments.length !== 1 || String(payments[0].paymentSystem) !== PIX_PAYMENT_SYSTEM || !Number.isFinite(payValue) || payValue > value || payValue <= 0)
      throw new VtexCheckoutRejected("paymentData", 200, "Pix não ficou selecionado na cesta");
    return this.form!;
  }

  // Evidência no MESMO formato que o comprador do Mac entregava ao servidor (checkCheckout).
  snapshot(job: { cartHash: string; customerAddress: string; items: { sku: string }[] }): CheckoutEvidence {
    const form = this.form;
    if (!form) throw new Error("Cesta ainda não preparada.");
    const shipping = form.shippingData as Json;
    const dest = ((shipping.selectedAddresses as Json[] | undefined) ?? [])[0] ?? {};
    const logistics = (shipping.logisticsInfo as Json[] | undefined) ?? [];
    const selected = logistics.map((l) => {
      if (l.selectedDeliveryChannel !== "delivery") throw new Error("Retirada não é entrega.");
      const raw = ((l.slas as Json[] | undefined) ?? []).find((v) => v.id === l.selectedSla);
      if (!raw) throw new Error("Entrega não selecionada.");
      // A VTEX guarda a janela escolhida DENTRO da SLA selecionada (`slas[].deliveryWindow`), e deixa
      // `logisticsInfo[].deliveryWindow` nulo (Mambo, 25/09). Aceita os dois lugares.
      const chosen = ((l.deliveryWindow as { startDateUtc?: string; endDateUtc?: string } | null | undefined) ?? (raw.deliveryWindow as { startDateUtc?: string; endDateUtc?: string } | null | undefined)) ?? undefined;
      if ((raw.availableDeliveryWindows as unknown[] | undefined)?.length && !chosen?.endDateUtc) throw new Error("Janela de entrega não selecionada.");
      if (!chosen?.endDateUtc) return raw;
      const hours = Math.max(1, Math.ceil((Date.parse(chosen.endDateUtc) - Date.now()) / 3_600_000));
      return { ...raw, shippingEstimate: `${hours}h@${chosen.startDateUtc}~${chosen.endDateUtc}`, windowLabel: `${chosen.startDateUtc}→${chosen.endDateUtc}` };
    });
    const promises = [...new Set(selected.map((s) => humanEstimate(String(s.shippingEstimate))))];
    if (!selected.length || promises.length !== 1 || !promises[0]) throw new Error("Prazo do checkout precisa de conferência.");
    const payments = ((form.paymentData as Json | undefined)?.payments as Json[] | undefined) ?? [];
    const payValue = Number(payments[0]?.value);
    if (payments.length !== 1 || !Number.isFinite(payValue) || payValue > Number(form.value) || String(payments[0].paymentSystem) !== PIX_PAYMENT_SYSTEM)
      throw new Error("Pix não está selecionado no checkout.");
    const { skuPrefix } = this.store;
    const rows = ((form.items as Json[] | undefined) ?? []).map((i) => {
      const sku = `${skuPrefix}${String(i.id)}`;
      if (!job.items.some((j) => j.sku === sku) || i.availability !== "available") throw new Error("Produto divergente ou sem estoque.");
      const unit = Number(i.sellingPrice);
      const total = Number((i.priceDefinition as Json | undefined)?.total ?? unit * Number(i.quantity));
      return { sku, retailerSku: String(i.id), seller: String(i.seller), name: String(i.name).slice(0, 300), qty: Number(i.quantity), unitPriceCents: unit, lineTotalCents: total };
    });
    // Linha dividida pela loja (promoção "leve 2", 05/10) volta a ser UMA por sku: quantidade e
    // total somados, preço unitário = média (a conferência aceita o arredondamento disso).
    const items: typeof rows = [];
    for (const row of rows) {
      const same = items.find((i) => i.sku === row.sku);
      if (!same) { items.push({ ...row }); continue; }
      if (same.seller !== row.seller) throw new Error("Produto dividido entre vendedores.");
      same.qty += row.qty;
      same.lineTotalCents += row.lineTotalCents;
      same.unitPriceCents = Math.round(same.lineTotalCents / same.qty);
    }
    const freight = ((form.totalizers as Json[] | undefined) ?? []).find((t) => t.id === "Shipping");
    const itemsAndFreight = items.reduce((a, i) => a + i.lineTotalCents, 0) + Number(freight?.value ?? 0);
    const discountCents = Math.max(0, itemsAndFreight - payValue);
    return {
      recipientName: String(dest.receiverName ?? ""),
      accountEmail: String((form.clientProfileData as Json).email ?? ""),
      checkoutUrl: `https://${this.domain}/checkout/#/payment`,
      cartHash: job.cartHash,
      destination: job.customerAddress,
      postalCode: String(dest.postalCode ?? ""),
      deliveryOption: selected.map((s) => (s.windowLabel ? `${String(s.id)} [${String(s.windowLabel)}]` : String(s.id))).join(" · ").slice(0, 300),
      deliveryPromise: String(promises[0]),
      payment: { kind: "pix_store", paymentSystem: 125 },
      observedAt: new Date().toISOString(),
      items,
      freightCents: Number(freight?.value ?? 0),
      ...(discountCents ? { discountCents } : {}),
      totalCents: payValue,
    };
  }

  // Esvazia a cesta (nunca deixar cesta com endereço pendurada na loja).
  async clearCart() {
    const form = this.form;
    if (!form) return;
    await this.call(`${this.base}/orderForm/${String(form.orderFormId)}/items/removeAll`, {}).catch(() => undefined);
    this.form = null;
  }

  // 6: fechamento REAL. transaction → vault → gatewayCallback → Pix do Payment App.
  async placeOrder(): Promise<VtexPix> {
    const form = this.form;
    if (!form) throw new Error("Cesta ainda não preparada.");
    const orderFormId = String(form.orderFormId);
    const cartValue = Number(form.value);
    const payments0 = ((form.paymentData as Json | undefined)?.payments as Json[] | undefined) ?? [];
    const value = Number(payments0[0]?.value ?? cartValue);
    const tx = await this.call(`${this.base}/orderForm/${orderFormId}/transaction`, {
      referenceId: orderFormId, savePersonalData: false, optinNewsLetter: false, value, referenceValue: cartValue, interestValue: 0,
    });
    const txJson = (tx.json ?? {}) as Json;
    if (tx.status !== 200 || !txJson.orderGroup) {
      await this.clearCart();
      throw new VtexCheckoutRejected("transaction", tx.status, tx.text.slice(0, 300));
    }
    // A partir daqui existe pedido na loja: qualquer falha é "pedido sem pagamento".
    this.form = null;
    const orderGroup = String(txJson.orderGroup);
    const merchants = (txJson.merchantTransactions as Json[]) ?? [];
    const merchant = merchants[0] ?? {};
    const tid = String(txJson.id ?? merchant.transactionId ?? "");
    const account = new URL(String(txJson.receiverUri ?? `https://${this.storeKey}.vtexpayments.com.br/`)).hostname.split(".")[0];
    const templatePath = String(txJson.gatewayCallbackTemplatePath ?? (txJson.transactionData as Json | undefined)?.gatewayCallbackTemplatePath ?? `/checkout/gatewayCallback/${orderGroup}/{messageCode}`);
    const cartPayments = (((txJson.paymentData as Json | undefined)?.payments as Json[] | undefined) ?? ((form.paymentData as Json).payments as Json[]) ?? []);
    const payments = cartPayments.flatMap((p, i) =>
      (((p.merchantSellerPayments as Json[] | undefined) ?? [{ id: merchant.id, installments: 1, referenceValue: value, value, interestRate: 0, installmentValue: value }])).map((m) => {
        const t = merchants.find((x) => String(x.id).toLowerCase() === String(m.id).toLowerCase()) ?? merchant;
        return {
          ...p, ...m,
          paymentSystemName: "Pix", group: "instantPaymentPaymentGroup", fields: {},
          transaction: { id: t.transactionId, merchantName: t.merchantName },
          installmentsValue: m.installmentValue ?? value, installmentsInterestRate: m.interestRate ?? 0,
          currencyCode: "BRL", originalPaymentIndex: i,
        };
      }));
    const deviceInfo = Buffer.from("sw=1728&sh=1117&cd=30&tz=180&lang=pt-BR&java=false&sourceApplication=vcs.checkout-ui@6.152.3&installedApplications=[]").toString("base64");
    const callbackUrl = `https://${this.domain}${templatePath}`;
    const urls = [
      `https://api.vtexvault.com/api/payments/transactions/${tid}/payments?&orderId=${orderGroup}&redirect=false&callbackUrl=${encodeURIComponent(callbackUrl)}&deviceInfo=${deviceInfo}&an=${account}`,
      `https://${account}.vtexpayments.com.br/api/payments/pub/transactions/${tid}/payments?&orderId=${orderGroup}&redirect=false&callbackUrl=${callbackUrl}&deviceInfo=${deviceInfo}&an=${account}`,
    ];
    let sent: { status: number; text: string } | null = null;
    for (const url of urls) {
      try {
        sent = await this.call(url, payments);
        if (sent.status >= 200 && sent.status < 300) break;
      } catch (error) {
        sent = { status: 0, text: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!sent || sent.status < 200 || sent.status >= 300) throw new VtexOrderWithoutPayment(orderGroup, `gateway HTTP ${sent?.status ?? 0}`);
    let pix = findPixCode(sent.text);
    let expiresAt: string | undefined;
    let paymentId: string | undefined;
    const cb = await this.call(`${this.base}/gatewayCallback/${orderGroup}`, {}).catch((error) => ({ status: 0, text: String(error), json: null }));
    const apps = ((cb.json as Json | null)?.paymentAuthorizationAppCollection as Json[] | undefined) ?? [];
    for (const app of apps) {
      try {
        const payload = JSON.parse(String(app.appPayload ?? "{}")) as Json;
        if (typeof payload.code === "string" && findPixCode(payload.code)) {
          pix = payload.code;
          expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
          paymentId = typeof payload.paymentId === "string" ? payload.paymentId : undefined;
        }
      } catch { /* payload não-JSON: tenta o texto bruto abaixo */ }
    }
    pix = pix ?? findPixCode(cb.text);
    if (!pix) throw new VtexOrderWithoutPayment(orderGroup, `callback HTTP ${cb.status} sem código Pix`);
    return { code: pix, expiresAt, paymentId, transactionId: tid, orderGroup };
  }
}

export function vtexOrderId(orderGroup: string) {
  return `${orderGroup}-01`;
}
export function normalizeForCompare(value: string) {
  return normalize(value);
}
