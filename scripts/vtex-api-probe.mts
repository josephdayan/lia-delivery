// Sondagem da API pública de checkout da VTEX, por HTTP puro (sem navegador, sem perfil
// Chrome). Responde à pergunta "dá pra comprar por API, sem operador?" loja a loja:
//
//   npx tsx scripts/vtex-api-probe.mts drogariasp            # seco: cesta → perfil → endereço → frete → Pix, e esvazia
//   npx tsx scripts/vtex-api-probe.mts cobasi --term "areia" # escolhe o 1º item disponível da busca
//   npx tsx scripts/vtex-api-probe.mts paguemenos --sku 52253 --sla "Econômica"
//
// Modo seco NÃO cria pedido: para antes de `POST .../transaction`. O modo `--buy` cria um
// pedido REAL na loja (Pix, vence sozinho se não for pago) e exige, de propósito, três
// coisas explícitas: a flag, `LIA_PROBE_CONFIRM=sim` e `LIA_PROBE_DOCUMENT` (CPF/CNPJ do
// comprador; a VTEX exige documento no fechamento). O documento nunca é impresso nem gravado.
//
// Endereço: SEMPRE o bloco `probe` do `.retail-buyer/config.json` (decisão do dono, 14/09).
// Resultado: resumo no stdout; JSON completo em `.retail-buyer/probes/vtex-api-<loja>-<ts>.json`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { findPixCode } from "../src/lib/pix-emv";

const STORES: Record<string, string> = {
  cobasi: "www.cobasi.com.br",
  drogariasp: "www.drogariasaopaulo.com.br",
  paguemenos: "www.paguemenos.com.br",
  oba: "secure.obahortifruti.com.br",
  swift: "loja.swift.com.br",
  naturaldaterra: "www.naturaldaterra.com.br",
  divvino: "www.divvino.com.br",
  rihappy: "www.rihappy.com.br",
  kopenhagen: "www.kopenhagen.com.br",
  carrefour: "mercado.carrefour.com.br",
  petz: "www.petz.com.br",
  // Candidatos da varredura de 25/09 (catálogo + orderForm abertos ao servidor); sem catálogo na Lia ainda.
  mambo: "www.mambo.com.br",
  sonda: "www.sondadelivery.com.br",
  hortifruti: "www.hortifruti.com.br",
  mundoverde: "www.mundoverde.com.br",
  americanas: "www.americanas.com.br",
  drogal: "www.drogal.com.br",
  epocacosmeticos: "www.epocacosmeticos.com.br",
  livup: "www.livup.com.br",
  tokstok: "www.tokstok.com.br",
  // Supermercados da 2ª varredura (27/09).
  savegnago: "www.savegnago.com.br",
  covabra: "www.covabra.com.br",
  zonasul: "www.zonasul.com.br",
  supernosso: "www.supernosso.com",
  // Fora de farmácia/mercado (27/09): livros, casa, festa, roupa, skincare.
  martinsfontes: "www.martinsfontespaulista.com.br",
  telhanorte: "www.telhanorte.com.br",
  brinox: "www.brinox.com.br",
  zonacriativa: "www.zonacriativa.com.br",
  creamy: "www.creamy.com.br",
  hering: "www.hering.com.br",
  casaevideo: "www.casaevideo.com.br",
  // Candidatos por categoria de e-commerce (27/09): moda, eletro, brinquedos, casa, construção.
  pbkids: "www.pbkids.com.br",
  farmrio: "www.farmrio.com.br",
  animale: "www.animale.com.br",
  usereserva: "www.usereserva.com",
  osklen: "www.osklen.com.br",
  oxford: "www.oxfordporcelanas.com.br",
  brastemp: "www.brastemp.com.br",
  philco: "www.philco.com.br",
  mondial: "www.mondial.com.br",
  obramax: "www.obramax.com.br",
  lojasrede: "www.lojasrede.com.br",
  polishop: "www.polishop.com.br",
};
const PIX_SYSTEM = 125;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type Json = Record<string, unknown>;
const args = process.argv.slice(2);
const storeKey = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
if (!storeKey || !STORES[storeKey]) {
  console.error(`Uso: npx tsx scripts/vtex-api-probe.mts <${Object.keys(STORES).join("|")}> [--term txt] [--sku id --seller 1] [--qty n] [--sla nome] [--buy]`);
  process.exit(2);
}
const domain = STORES[storeKey];
const root = resolve(process.cwd(), ".retail-buyer");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8")) as { probe?: Record<string, string> };
const probe = config.probe;
if (!probe?.cep || !probe.street || !probe.name) {
  console.error("Defina `probe` no .retail-buyer/config.json (name, cep, street, number, neighborhood, city, state).");
  process.exit(2);
}
const email = process.env.LIA_PROBE_EMAIL?.trim() || "contato+probe@liadelivery.com.br";
const buy = has("--buy");
const document = process.env.LIA_PROBE_DOCUMENT?.replace(/\D/g, "");
// 25/09: a Drogaria SP devolveu `400 ORD007` ("documento de identificação inválido") quando um
// CNPJ foi enviado como `documentType: "cpf"`. Pessoa jurídica na VTEX é `isCorporate` +
// `corporateDocument` (docs "orderForm fields"); `LIA_PROBE_DOCUMENT_TYPE=cnpj` liga esse modo.
const documentType = (process.env.LIA_PROBE_DOCUMENT_TYPE ?? (document && document.length === 14 ? "cnpj" : "cpf")).toLowerCase();
if (buy && (process.env.LIA_PROBE_CONFIRM !== "sim" || !document)) {
  console.error("--buy cria um pedido REAL. Exige LIA_PROBE_CONFIRM=sim e LIA_PROBE_DOCUMENT (CPF/CNPJ do comprador).");
  process.exit(2);
}
if (buy && !((documentType === "cpf" && document!.length === 11) || (documentType === "cnpj" && document!.length === 14))) {
  console.error(`LIA_PROBE_DOCUMENT tem ${document!.length} dígitos; ${documentType} exige ${documentType === "cpf" ? 11 : 14}.`);
  process.exit(2);
}

// Jar de cookies mínimo: a VTEX devolve `checkout.vtex.com` e `CheckoutOrderFormOwnership`
// (sem este, o perfil volta mascarado e o pedido não pode ser lido depois).
const jar = new Map<string, string>();
async function call(url: string, body?: unknown, init: { method?: string; accept?: string } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: init.accept ?? "application/json", "Content-Type": "application/json" };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(url, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  for (const c of response.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* html/texto */
  }
  return { status: response.status, json, text };
}
const dump: Json = { store: storeKey, domain, startedAt: new Date().toISOString(), steps: [] as Json[] };
const steps = dump.steps as Json[];
function step(name: string, status: number, detail: unknown) {
  steps.push({ name, status, detail });
  console.log(`[${name}] HTTP ${status} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
// Erro inesperado (rede, JSON, exceção) também grava o que já se viu: sem isso a sondagem
// sumia sem arquivo (28/09: 6 lojas em --buy saíram sem rastro).
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (error: unknown) => {
    step("erro inesperado", 0, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    try { save(); } catch { /* segue */ }
    console.error(`✗ erro inesperado: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
function fail(msg: string): never {
  save();
  console.error(`✗ ${msg}`);
  process.exit(1);
}
// Nunca deixar cesta com endereço pendurada na loja quando a sondagem para no meio.
let cartToClear: string | null = null;
async function clearCart(): Promise<number> {
  if (!cartToClear) return 0;
  const r = await call(`${base}/orderForm/${cartToClear}/items/removeAll`, {}).catch(() => ({ status: -1 }));
  cartToClear = null;
  return r.status;
}
function save() {
  mkdirSync(resolve(root, "probes"), { recursive: true });
  const file = resolve(root, "probes", `vtex-api-${storeKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 1));
  console.log(`→ ${file}`);
}
const base = `https://${domain}/api/checkout/pub`;
const orderFormSummary = (of: Json) => {
  const items = (of.items as Json[]) ?? [];
  const li = (((of.shippingData as Json)?.logisticsInfo as Json[]) ?? [])[0];
  const pay = (of.paymentData as Json) ?? {};
  return {
    loggedIn: of.loggedIn,
    canEditData: of.canEditData,
    items: items.map((i) => [i.name, i.quantity, i.availability, i.sellingPrice]),
    email: (of.clientProfileData as Json)?.email,
    postalCode: (((of.shippingData as Json)?.selectedAddresses as Json[]) ?? [])[0]?.postalCode,
    selectedSla: li?.selectedSla,
    deliverySlas: ((li?.slas as Json[]) ?? []).filter((s) => s.deliveryChannel === "delivery").map((s) => [s.id, s.price, s.shippingEstimate]),
    totalizers: ((of.totalizers as Json[]) ?? []).map((t) => [t.id, t.value]),
    value: of.value,
    payments: ((pay.payments as Json[]) ?? []).map((p) => [p.paymentSystem, p.value]),
    pixOffered: ((pay.paymentSystems as Json[]) ?? []).some((p) => p.id === PIX_SYSTEM),
    messages: ((of.messages as Json[]) ?? []).map((m) => m.text),
  };
};

// 1. Item: --sku ou 1º disponível da busca
let sku = flag("--sku");
let seller = flag("--seller") ?? "1";
const qty = Number(flag("--qty") ?? 1);
if (!sku) {
  const term = flag("--term") ?? "sabonete";
  const r = await call(`https://${domain}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}&_from=0&_to=9`);
  if (!Array.isArray(r.json)) fail(`busca ${r.status}: catálogo bloqueado ou vazio (${r.text.slice(0, 120)})`);
  for (const p of r.json as Json[]) {
    for (const it of (p.items as Json[]) ?? []) {
      const s = ((it.sellers as Json[]) ?? []).find((x) => Number((x.commertialOffer as Json)?.AvailableQuantity) > 0);
      if (s) {
        sku = String(it.itemId);
        seller = String(s.sellerId);
        step("busca", r.status, { term, product: p.productName, sku, seller, price: (s.commertialOffer as Json).Price });
        break;
      }
    }
    if (sku) break;
  }
  if (!sku) fail("busca sem item disponível");
}

// 2. Carrinho anônimo + item
const created = await call(`${base}/orderForm`, {});
const orderFormId = (created.json as Json)?.orderFormId as string | undefined;
step("orderForm", created.status, orderFormId ?? created.text.slice(0, 120));
if (!orderFormId) fail("sem orderForm (WAF/anti-bot barrou o servidor)");
cartToClear = orderFormId;
const added = await call(`${base}/orderForm/${orderFormId}/items`, { orderItems: [{ id: sku, quantity: qty, seller }] });
step("items", added.status, orderFormSummary(added.json as Json));

// 3. Perfil de convidado (sem login). O documento só entra em --buy.
const corporate = buy && documentType === "cnpj";
const profile = await call(`${base}/orderForm/${orderFormId}/attachments/clientProfileData`, {
  email,
  firstName: "Lia",
  lastName: "Delivery",
  documentType,
  isCorporate: corporate,
  ...(buy ? { document } : {}),
  ...(corporate
    ? { corporateDocument: document, corporateName: "Lia Delivery", tradeName: "Lia Delivery", stateInscription: "isento" }
    : {}),
});
step("clientProfileData(payload)", 0, { documentType, isCorporate: corporate, documentSent: buy });
step("clientProfileData", profile.status, orderFormSummary(profile.json as Json));

// 4. Endereço com geocoordenadas (Cobasi só oferece entrega com lat/lng)
let geo: number[] = [];
try {
  const b = (await call(`https://brasilapi.com.br/api/cep/v2/${probe.cep}`)).json as Json;
  const c = ((b.location as Json)?.coordinates as Json) ?? {};
  if (c.longitude && c.latitude) geo = [Number(c.longitude), Number(c.latitude)];
} catch {
  /* segue sem */
}
if (!geo.length) {
  try {
    const q = encodeURIComponent(`${probe.street} ${probe.number}, ${probe.city}, Brasil`);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { "User-Agent": "lia-probe/1.0" } });
    const j = (await r.json()) as Json[];
    if (j[0]) geo = [Number(j[0].lon), Number(j[0].lat)];
  } catch {
    /* segue sem */
  }
}
const address = {
  addressType: "residential",
  receiverName: probe.name,
  postalCode: `${probe.cep.slice(0, 5)}-${probe.cep.slice(5)}`,
  city: probe.city,
  state: probe.state,
  country: "BRA",
  street: probe.street,
  number: probe.number,
  neighborhood: probe.neighborhood,
  complement: probe.complement ?? "",
  geoCoordinates: geo,
};
let shipping = await call(`${base}/orderForm/${orderFormId}/attachments/shippingData`, { selectedAddresses: [address], clearAddressIfPostalCodeNotFound: false });
let summary = orderFormSummary(shipping.json as Json);
step("shippingData", shipping.status, { ...summary, geo: geo.length > 0 });
const wanted = flag("--sla");
const options = summary.deliverySlas as [string, number, string][];
if (!options.length) {
  await clearCart();
  fail("loja não oferece ENTREGA nesse endereço (só retirada ou item indisponível)");
}
const chosen = wanted ? options.find((o) => o[0] === wanted)?.[0] : [...options].sort((a, b) => a[1] - b[1])[0][0];
if (!chosen) {
  await clearCart();
  fail(`SLA "${wanted}" não está entre ${options.map((o) => o[0]).join(", ")}`);
}
shipping = await call(`${base}/orderForm/${orderFormId}/attachments/shippingData`, {
  selectedAddresses: [address],
  logisticsInfo: [{ itemIndex: 0, selectedDeliveryChannel: "delivery", selectedSla: chosen }],
  clearAddressIfPostalCodeNotFound: false,
});
summary = orderFormSummary(shipping.json as Json);
step("selectedSla", shipping.status, { selectedSla: summary.selectedSla, totalizers: summary.totalizers, value: summary.value });
if (summary.selectedSla !== chosen) {
  await clearCart();
  fail(`a loja não aceitou a opção "${chosen}"`);
}

// 5. Pix como meio de pagamento
const value = Number(summary.value);
const payment = await call(`${base}/orderForm/${orderFormId}/attachments/paymentData`, {
  payments: [{ paymentSystem: String(PIX_SYSTEM), referenceValue: value, value, installments: 1 }],
});
summary = orderFormSummary(payment.json as Json);
step("paymentData(Pix)", payment.status, { payments: summary.payments, pixOffered: summary.pixOffered, value });
// Desconto de Pix (28/09: Kopenhagen/Creamy): a loja recalcula o pagamento abaixo do total da
// cesta. O fechamento manda o valor do PAGAMENTO e o da cesta como referência, igual ao
// comprador do servidor (vtex-checkout.ts); mandar o total cheio faz a loja devolver 200 sem pedido.
const paid = (((payment.json as Json)?.paymentData as Json | undefined)?.payments as Json[] | undefined)?.[0]?.value;
const payValue = Number.isFinite(Number(paid)) && Number(paid) > 0 ? Number(paid) : value;
const cartValue = Number(((payment.json as Json)?.value as number | undefined) ?? value);
// Objeto de pagamento completo da cesta: é o que o checkout-ui copia (com `merchantSellerPayments`)
// para montar o envio ao gateway. Guardado no JSON para inspeção.
dump.paymentDataPayments = ((payment.json as Json).paymentData as Json | undefined)?.payments ?? null;
if (!summary.pixOffered) {
  await clearCart();
  fail("a loja não oferece Pix (só cartão) — fora da arquitetura sem operador");
}

if (!buy) {
  step("removeAll", await clearCart(), "cesta esvaziada; nenhum pedido criado");
  dump.verdict = `API aberta: cesta, perfil de convidado, entrega "${chosen}" e Pix aceitos por HTTP. Falta só o fechamento (--buy).`;
  save();
  console.log(`\n✓ ${dump.verdict}`);
  process.exit(0);
}

// 6. Fechamento REAL: transaction → gateway (Pix) → gatewayCallback → ler pedido e Pix
const tx = await call(`${base}/orderForm/${orderFormId}/transaction`, {
  referenceId: orderFormId,
  savePersonalData: false,
  optinNewsLetter: false,
  value: payValue,
  referenceValue: cartValue,
  interestValue: 0,
});
const txJson = tx.json as Json;
step("transaction", tx.status, tx.status === 200 ? { orderGroup: txJson.orderGroup, receiverUri: txJson.receiverUri, merchantTransactions: txJson.merchantTransactions, sent: { value: payValue, referenceValue: cartValue }, ...(txJson.orderGroup ? {} : { messages: (txJson.messages as unknown) ?? tx.text.slice(0, 400) }) } : tx.text.slice(0, 400));
if (tx.status === 200 && !txJson.orderGroup) {
  await clearCart();
  fail("a loja respondeu 200 sem pedido (sem orderGroup); nenhum pedido criado — ver messages no JSON");
}
if (tx.status !== 200) {
  await clearCart();
  fail(
    tx.status === 403
      ? "fechamento recusado: 403 CHK0082 = reCAPTCHA exigido no fechamento (loja sai da lista)"
      : `fechamento recusado (HTTP ${tx.status}; ORD007 = documento inválido para o documentType enviado; ver JSON). Cesta esvaziada.`,
  );
}
const orderGroup = String(txJson.orderGroup);
const merchant = (txJson.merchantTransactions as Json[])?.[0] ?? {};
const tid = String(txJson.id ?? merchant.transactionId);
const account = new URL(String(txJson.receiverUri)).hostname.split(".")[0];
// 25/09: o checkout-ui (v6.152.3, `sendPayment` + `getTransactionURL`) NÃO usa o `receiverUri`
// (`/split/{og}/payments` devolveu 500). Ele copia cada `paymentData.payments[]` da cesta,
// funde o `merchantSellerPayments[]` correspondente, anexa `transaction {id, merchantName}`,
// `installmentsValue`, `installmentsInterestRate`, `currencyCode`, `originalPaymentIndex`, e
// posta em api.vtexvault.com (padrão) ou em {account}.vtexpayments.com.br/api/payments/pub
// (flag "Janus"), sempre com `orderId`, `redirect=false`, `callbackUrl`, `deviceInfo` e `an`.
const templatePath = String(
  txJson.gatewayCallbackTemplatePath ??
    (txJson.transactionData as Json | undefined)?.gatewayCallbackTemplatePath ??
    `/checkout/gatewayCallback/${orderGroup}/{messageCode}`,
);
const cartPayments = (((txJson.paymentData as Json | undefined)?.payments as Json[] | undefined) ?? (dump.paymentDataPayments as Json[] | null) ?? []) as Json[];
const merchants = (txJson.merchantTransactions as Json[]) ?? [];
const payments = cartPayments.flatMap((p, i) =>
  ((p.merchantSellerPayments as Json[] | undefined) ?? [{ id: merchant.id, installments: 1, referenceValue: payValue, value: payValue, interestRate: 0, installmentValue: payValue }]).map((m) => {
    const t = merchants.find((x) => String(x.id).toLowerCase() === String(m.id).toLowerCase()) ?? merchant;
    return {
      ...p,
      ...m,
      paymentSystemName: "Pix",
      group: "instantPaymentPaymentGroup",
      fields: {},
      transaction: { id: t.transactionId, merchantName: t.merchantName },
      installmentsValue: m.installmentValue ?? payValue,
      installmentsInterestRate: m.interestRate ?? 0,
      currencyCode: "BRL",
      originalPaymentIndex: i,
    };
  }),
);
const deviceInfo = Buffer.from(
  `sw=1728&sh=1117&cd=30&tz=180&lang=pt-BR&java=false&sourceApplication=vcs.checkout-ui@6.152.3&installedApplications=[]`,
).toString("base64");
const callbackUrl = `https://${domain}${templatePath}`;
const gatewayUrls = [
  `https://api.vtexvault.com/api/payments/transactions/${tid}/payments?&orderId=${orderGroup}&redirect=false&callbackUrl=${encodeURIComponent(callbackUrl)}&deviceInfo=${deviceInfo}&an=${account}`,
  `https://${account}.vtexpayments.com.br/api/payments/pub/transactions/${tid}/payments?&orderId=${orderGroup}&redirect=false&callbackUrl=${callbackUrl}&deviceInfo=${deviceInfo}&an=${account}`,
];
dump.gatewayPayload = payments;
let gw: Awaited<ReturnType<typeof call>> | null = null;
for (const url of gatewayUrls) {
  gw = await call(url, payments);
  step(`gateway payments (${new URL(url).hostname})`, gw.status, gw.text.slice(0, 400));
  if (gw.status >= 200 && gw.status < 300) break;
}
if (!gw || gw.status < 200 || gw.status >= 300) {
  save();
  fail(`gateway recusou o pagamento (HTTP ${gw?.status}); pedido ${orderGroup} fica sem pagamento e a loja cancela sozinha. Ver JSON.`);
}
dump.gatewayResponse = gw.json ?? gw.text;
// Cookies do fechamento (`CheckoutDataAccess`, `Vtex_CHKO_Auth`): sem eles a leitura pública do
// pedido devolve 403 depois. Ficam no JSON (0600) para conferir o pedido mais tarde.
dump.checkoutCookies = Object.fromEntries(jar);
let pix: string | null = findPixCode(gw.text);
step("pix no retorno do gateway", gw.status, { pixFound: Boolean(pix) });
const cb = await call(`${base}/gatewayCallback/${orderGroup}`, {});
step("gatewayCallback", cb.status, cb.text.slice(0, 300));
dump.gatewayCallbackResponse = cb.json ?? cb.text;
pix = pix ?? findPixCode(cb.text);

// O Payment App (Pix) recebe `paymentAppData.payload` via Checkout UI durante o checkout; em
// headless procuramos o EMV em todo lugar público: retorno do gateway, callback, pedido do
// grupo (com os cookies do fechamento) e a transação no gateway.
let orderIds: unknown = null;
for (let i = 0; i < 12 && !pix; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const og = await call(`${base}/orders/order-group/${orderGroup}`);
  const gwTx = await call(`https://${account}.vtexpayments.com.br/api/pub/transactions/${tid}`);
  const gwTxPay = await call(`https://${account}.vtexpayments.com.br/api/pub/transactions/${tid}/payments?orderId=${orderGroup}`);
  if (Array.isArray(og.json)) orderIds = (og.json as Json[]).map((o) => [o.orderId, o.status ?? o.state, o.statusDescription]);
  pix = findPixCode(og.text) ?? findPixCode(gwTx.text) ?? findPixCode(gwTxPay.text);
  const appData = (og.text.match(/"paymentAppData":\s*(\{[^}]{0,400}\})/) ?? [])[1];
  step(`leitura ${i + 1}`, og.status, { orders: orderIds, gwTx: gwTx.status, gwTxPay: gwTxPay.status, pixFound: Boolean(pix), appData: appData?.slice(0, 200) });
  dump.lastOrderGroup = og.json;
  dump.lastGatewayTransaction = gwTx.json ?? gwTx.text.slice(0, 500);
  dump.lastGatewayPayments = gwTxPay.json ?? gwTxPay.text.slice(0, 500);
}
dump.verdict = pix
  ? `PEDIDO CRIADO por API sem CAPTCHA: grupo ${orderGroup}; Pix copia-e-cola obtido (${pix.length} chars).`
  : `Pedido criado (grupo ${orderGroup}), mas o código Pix não apareceu nas leituras públicas — ver JSON e o e-mail da loja.`;
dump.pixCode = pix;
save();
console.log(`\n${pix ? "✓" : "△"} ${dump.verdict}`);
