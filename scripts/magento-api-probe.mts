// Sondagem SECA do checkout de convidado em lojas Magento / Adobe Commerce, por HTTP puro
// (sem navegador). Mesma pergunta do `vtex-api-probe.mts`: "dá pra comprar por API, sem
// operador?" — catálogo → carrinho de convidado → endereço/frete → e-mail → métodos de
// pagamento (tem Pix?) e PARA. Não existe modo de compra aqui, de propósito.
//
//   npx tsx scripts/magento-api-probe.mts divinho                  # 1º item barato da busca padrão
//   npx tsx scripts/magento-api-probe.mts divinho --term "vinho"   # escolhe o 1º disponível da busca
//   npx tsx scripts/magento-api-probe.mts havan --sku 1234 --term "pano de prato"
//   npx tsx scripts/magento-api-probe.mts --domain=www.loja.com.br --term "arroz"
//
// NUNCA chama placeOrder / payment-information / setPaymentMethodAndPlaceOrder; não envia
// CPF/CNPJ; não faz login. Ao final remove o item do carrinho de convidado.
//
// Caminhos tentados (o primeiro que responder vale, o resto fica registrado):
//   GraphQL  POST /graphql — products(search:), createEmptyCart, addProductsToCart,
//            setShippingAddressesOnCart (available_shipping_methods), setGuestEmailOnCart,
//            available_payment_methods.
//   REST     /rest/V1/guest-carts, /items, /estimate-shipping-methods, /shipping-information
//            (devolve payment_methods sem criar pedido), /payment-methods.
// Também lê o `requirejs-config.js` do tema para listar os módulos de pagamento instalados
// (Pagarme_Pagarme, MercadoPago_*, …) e sinais de reCAPTCHA no checkout.
//
// Endereço: SEMPRE o bloco `probe` do `.retail-buyer/config.json` (decisão do dono, 14/09).
// Só o CEP é impresso/gravado; rua, número, nome, bairro e cidade são mascarados no JSON.
// Resultado: resumo no stdout; JSON em `.retail-buyer/probes/magento-<loja>-<ts>.json`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const STORES: Record<string, { domain: string; term: string }> = {
  divinho: { domain: "www.divinho.com.br", term: "vinho" },
  havan: { domain: "www.havan.com.br", term: "pano de prato" },
  grandcru: { domain: "www.grandcru.com.br", term: "vinho" },
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const args = process.argv.slice(2);
const domainFlag = args.find((a) => a.startsWith("--domain="))?.slice(9);
const storeKey = domainFlag ? domainFlag.replace(/^www\./, "").replace(/\..*$/, "") : args[0];
if (domainFlag) STORES[storeKey] = { domain: domainFlag, term: "arroz" };
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!storeKey || !STORES[storeKey]) {
  console.error(`Uso: npx tsx scripts/magento-api-probe.mts <${Object.keys(STORES).join("|")}> | --domain=host [--term txt] [--sku sku] [--qty n]`);
  process.exit(2);
}
const { domain } = STORES[storeKey];
const term = flag("--term") ?? STORES[storeKey].term;
const forcedSku = flag("--sku");
const qty = Number(flag("--qty") ?? 1);
const origin = `https://${domain}`;
const root = resolve(process.cwd(), ".retail-buyer");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8")) as { probe?: Record<string, string> };
const probe = config.probe;
if (!probe?.cep || !probe.street || !probe.name) {
  console.error("Defina `probe` no .retail-buyer/config.json (name, cep, street, number, neighborhood, city, state).");
  process.exit(2);
}
const cep = probe.cep.replace(/\D/g, "");
const cepFmt = `${cep.slice(0, 5)}-${cep.slice(5)}`;
const email = process.env.LIA_PROBE_EMAIL?.trim() || "contato+probe@liadelivery.com.br";
const [firstname, ...rest] = probe.name.trim().split(/\s+/);
const lastname = rest.join(" ") || "Lia";
const telephone = "11999999999"; // fictício: modo seco

// ---- máscara: nada do endereço (exceto CEP) vai para stdout ou para o JSON ----
const ADDRESS_KEYS = /^(street|firstname|lastname|middlename|city|telephone|company|region|region_code|neighborhood|complement|number|vat_id|taxvat)$/i;
const secrets = [probe.street, probe.name, probe.neighborhood, probe.complement, probe.text, firstname, lastname]
  .filter((s): s is string => typeof s === "string" && s.trim().length >= 4);
function redact<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key && ADDRESS_KEYS.test(key) && v !== null && v !== undefined && typeof v !== "object") return "[mascarado]";
    if (key && ADDRESS_KEYS.test(key) && Array.isArray(v)) return v.map(() => "[mascarado]");
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string") return secrets.reduce((s, sec) => s.split(sec).join("[mascarado]"), v);
    return v;
  };
  return walk(value) as T;
}

const jar = new Map<string, string>();
async function call(url: string, body?: unknown, init: { method?: string; accept?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: init.accept ?? "application/json", "Content-Type": "application/json", ...init.headers };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(url, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
    redirect: "manual",
  });
  for (const c of response.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await response.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, json: json as Json, text, headers: response.headers };
}
async function gql(query: string, variables: Json = {}) {
  return call(`${origin}/graphql`, { query, variables });
}

const dump: Json = { store: storeKey, domain, cep, startedAt: new Date().toISOString(), steps: [] as Json[], summary: {} as Json };
const steps = dump.steps as Json[];
const summary = dump.summary as Json;
function step(name: string, status: number, detail: unknown) {
  const safe = redact(detail);
  steps.push({ name, status, detail: safe });
  const line = typeof safe === "string" ? safe : JSON.stringify(safe);
  console.log(`[${name}] HTTP ${status} ${line.length > 900 ? `${line.slice(0, 900)}…` : line}`);
}
function save() {
  mkdirSync(resolve(root, "probes"), { recursive: true });
  const file = resolve(root, "probes", `magento-${storeKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(redact(dump), null, 1));
  console.log(`→ ${file}`);
}
let cleanup: (() => Promise<void>) | null = null;
async function finish(code: number, msg?: string) {
  if (cleanup) { try { await cleanup(); } catch { /* segue */ } }
  dump.finishedAt = new Date().toISOString();
  save();
  if (msg) console.error(`${code ? "✗" : "✓"} ${msg}`);
  process.exit(code);
}
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (error: unknown) => {
    step("erro inesperado", 0, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    void finish(1, "erro inesperado");
  });
}
const gqlErr = (r: { json: Json }) => (Array.isArray(r.json?.errors) ? r.json.errors.map((e: Json) => e.message).join(" | ") : null);

// ---------- 1. plataforma ----------
const home = await call(`${origin}/`, undefined, { accept: "text/html" });
const magentoHeaders = [...home.headers.keys()].filter((k) => /magento/i.test(k));
const theme = home.text.match(/static\/(version\d+\/)?frontend\/([^/]+\/[^/]+)\/([a-zA-Z_]+)\//);
const version = await call(`${origin}/magento_version`, undefined, { accept: "text/plain" });
summary.platform = {
  homeStatus: home.status,
  server: home.headers.get("server"),
  magentoHeaders,
  magentoVersion: version.status === 200 && /magento/i.test(version.text) ? version.text.trim() : null,
  theme: theme ? theme[2] : null,
  pwa: /venia|pwa-studio|__NEXT_DATA__|window\.__APOLLO/i.test(home.text),
};
const storeCfg = await gql("{ storeConfig { store_code base_currency_code locale } }");
summary.platform.graphql = storeCfg.status === 200 && !!storeCfg.json?.data?.storeConfig;
const restCur = await call(`${origin}/rest/V1/directory/currency`);
summary.platform.rest = restCur.status === 200 && typeof restCur.json === "object" && !!restCur.json?.base_currency_code;
step("plataforma", home.status, summary.platform);
if (!summary.platform.graphql && !summary.platform.rest && !magentoHeaders.length) await finish(1, "não parece Magento (sem GraphQL, sem REST, sem cabeçalho x-magento)");

// módulos do tema (requirejs-config) → pagamento/frete/reCAPTCHA instalados
if (theme) {
  let rjs = await call(`${origin}/${theme[0]}requirejs-config.js`, undefined, { accept: "*/*" });
  if (rjs.status !== 200) rjs = await call(`${origin}/${theme[0]}requirejs-config.min.js`, undefined, { accept: "*/*" });
  const mods = [...new Set(rjs.text.match(/['"]([A-Z][A-Za-z0-9]+_[A-Za-z0-9]+)\//g)?.map((m) => m.slice(1, -1)) ?? [])];
  summary.modules = {
    payment: mods.filter((m) => /pag|pay|pix|mercado|cielo|ebanx|asaas|getnet|adyen|stone|braintree|rede|iugu|vindi|juno|openpix|paghiper|picpay|moip|wirecard/i.test(m)),
    shipping: mods.filter((m) => /ship|frenet|intelipost|correios|frete|delivery|pickup/i.test(m)),
    captcha: mods.filter((m) => /captcha/i.test(m)),
    checkout: mods.filter((m) => /checkout|taxvat|address|brazil|cpf/i.test(m)),
  };
  step("módulos do tema", rjs.status, summary.modules);
}
if (summary.platform.graphql) {
  const rc = await gql("{ recaptchaFormConfig(formType: PLACE_ORDER) { is_enabled configurations { re_captcha_type } } }");
  const rc3 = await gql("{ recaptchaV3Config { is_enabled forms } }");
  summary.recaptchaGraphql = { placeOrder: rc.json?.data?.recaptchaFormConfig ?? gqlErr(rc), v3: rc3.json?.data?.recaptchaV3Config ?? gqlErr(rc3) };
  step("reCAPTCHA (GraphQL)", rc.status, summary.recaptchaGraphql);
}

// ---------- 2. catálogo ----------
type Pick = { sku: string; name: string; price: number | null; stock: string | null; type: string };
let picked: Pick | null = null;
if (summary.platform.graphql) {
  const q = `query($s:String!){ products(search:$s, pageSize:12, sort:{relevance:DESC}) { total_count items { __typename sku name stock_status price_range { minimum_price { final_price { value } } } } } }`;
  const r = await gql(q, { s: term });
  const items = (r.json?.data?.products?.items ?? []) as Json[];
  const list: Pick[] = items.map((i) => ({ sku: i.sku, name: i.name, price: i.price_range?.minimum_price?.final_price?.value ?? null, stock: i.stock_status ?? null, type: i.__typename }));
  step("catálogo GraphQL", r.status, gqlErr(r) ?? { total: r.json?.data?.products?.total_count, items: list.slice(0, 6) });
  const pool = list.filter((i) => i.type === "SimpleProduct" && i.stock !== "OUT_OF_STOCK");
  picked = (forcedSku ? list.find((i) => i.sku === forcedSku) : null) ?? pool.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9))[0] ?? null;
}
if (!picked) {
  const r = await call(`${origin}/rest/V1/products?searchCriteria[filterGroups][0][filters][0][field]=name&searchCriteria[filterGroups][0][filters][0][value]=%25${encodeURIComponent(term)}%25&searchCriteria[filterGroups][0][filters][0][conditionType]=like&searchCriteria[pageSize]=5`);
  step("catálogo REST /V1/products", r.status, typeof r.json === "object" ? (r.json?.message ?? { total: r.json?.total_count, items: (r.json?.items ?? []).map((i: Json) => [i.sku, i.name, i.price, i.type_id]) }) : r.text.slice(0, 200));
  const it = (r.json?.items ?? []).find((i: Json) => i.type_id === "simple");
  if (it) picked = { sku: it.sku, name: it.name, price: it.price, stock: null, type: "simple" };
}
// Fallback HTML (loja com GraphQL desligado e /V1/products fechado, ex.: Havan): página de
// busca → 3 itens mais baratos → página do produto (JSON-LD/dataLayer traz o sku).
const htmlCandidates: Pick[] = [];
if (!picked && !forcedSku) {
  const s = await call(`${origin}/catalogsearch/result/?q=${encodeURIComponent(term)}`, undefined, { accept: "text/html" });
  const cards = s.text.split(/<li class="item product product-item">/).slice(1).map((c) => {
    const link = c.match(/href="([^"]+)"[^>]*class="product-item-link"[^>]*>\s*([^<]+)/) ?? c.match(/class="product-item-link"[^>]*href="([^"]+)"[^>]*>\s*([^<]+)/);
    const price = c.match(/data-price-amount="([\d.]+)"/);
    return link ? { url: link[1], name: link[2].trim(), price: price ? Number(price[1]) : null } : null;
  }).filter((x): x is { url: string; name: string; price: number | null } => !!x);
  step("catálogo HTML (busca)", s.status, { cards: cards.length, first: cards.slice(0, 5).map((c) => [c.name, c.price]) });
  for (const c of cards.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)).slice(0, 3)) {
    const p = await call(c.url, undefined, { accept: "text/html" });
    const sku = p.text.match(/"sku"\s*:\s*"([^"]+)"/)?.[1];
    const type = p.text.match(/"productType"\s*:\s*"([^"]+)"/)?.[1] ?? "simple";
    const stock = p.text.match(/schema\.org\/(InStock|OutOfStock)/)?.[1] ?? null;
    if (sku && type === "simple") htmlCandidates.push({ sku, name: c.name, price: c.price, stock, type });
  }
  step("catálogo HTML (produto)", 200, htmlCandidates);
  picked = htmlCandidates.find((c) => c.stock === "InStock") ?? htmlCandidates[0] ?? null;
}
if (!picked && forcedSku) picked = { sku: forcedSku, name: "(sku informado)", price: null, stock: null, type: "simple" };
if (!picked) await finish(1, "catálogo não devolveu item simples disponível (use --sku)");
summary.item = picked;
console.log(`  item: ${picked!.sku} · ${picked!.name} · R$ ${picked!.price}`);

// ---------- 3. carrinho de convidado ----------
let cartId: string | null = null;
let via: "graphql" | "rest" | null = null;
if (summary.platform.graphql) {
  const r = await gql("mutation { createEmptyCart }");
  cartId = r.json?.data?.createEmptyCart ?? null;
  step("createEmptyCart", r.status, gqlErr(r) ?? { ok: !!cartId });
  if (cartId) {
    const add = await gql(
      `mutation($c:String!,$sku:String!,$q:Float!){ addProductsToCart(cartId:$c, cartItems:[{sku:$sku, quantity:$q}]) { cart { items { uid quantity product { sku name } prices { row_total { value } } } prices { grand_total { value } } } user_errors { code message } } }`,
      { c: cartId, sku: picked!.sku, q: qty },
    );
    const cart = add.json?.data?.addProductsToCart?.cart;
    step("addProductsToCart", add.status, gqlErr(add) ?? { items: (cart?.items ?? []).map((i: Json) => [i.product?.sku, i.quantity, i.prices?.row_total?.value]), userErrors: add.json?.data?.addProductsToCart?.user_errors });
    if (cart?.items?.length) via = "graphql";
  }
}
if (!via) {
  const r = await call(`${origin}/rest/V1/guest-carts`, {});
  cartId = typeof r.json === "string" ? r.json : null;
  step("REST guest-carts", r.status, cartId ? { ok: true } : r.json?.message ?? r.text.slice(0, 200));
  for (const cand of cartId ? [picked!, ...htmlCandidates.filter((c) => c.sku !== picked!.sku)] : []) {
    const add = await call(`${origin}/rest/V1/guest-carts/${cartId}/items`, { cartItem: { sku: cand.sku, qty, quote_id: cartId } });
    step("REST guest-carts/items", add.status, add.json?.message ? { sku: cand.sku, message: add.json.message, parameters: add.json.parameters } : { sku: add.json?.sku, qty: add.json?.qty, price: add.json?.price });
    if (add.status === 200) { via = "rest"; picked = cand; summary.item = cand; break; }
  }
}
if (!cartId || !via) await finish(1, "não conseguiu carrinho de convidado com o item");
summary.cart = { via };
cleanup = async () => {
  if (via === "graphql") {
    const c = await gql(`query($c:String!){ cart(cart_id:$c){ items { uid } } }`, { c: cartId });
    for (const it of c.json?.data?.cart?.items ?? []) await gql(`mutation($c:String!,$u:ID!){ removeItemFromCart(input:{cart_id:$c, cart_item_uid:$u}){ cart { total_quantity } } }`, { c: cartId, u: it.uid });
  } else {
    const c = await call(`${origin}/rest/V1/guest-carts/${cartId}/items`);
    for (const it of Array.isArray(c.json) ? c.json : []) await call(`${origin}/rest/V1/guest-carts/${cartId}/items/${it.item_id}`, undefined, { method: "DELETE" });
  }
  console.log("  carrinho de convidado esvaziado");
};

// ---------- 4. endereço + frete ----------
const countries = await call(`${origin}/rest/V1/directory/countries/BR`);
const region = ((countries.json?.available_regions ?? []) as Json[]).find((r) => r.code === probe.state);
const regionId = region ? Number(region.id) : undefined;
const streetLines = [probe.street, probe.number, probe.complement || "", probe.neighborhood || ""];

// 4a. REST estimate (só CEP) — funciona com o id mascarado do GraphQL também
const est = await call(`${origin}/rest/V1/guest-carts/${cartId}/estimate-shipping-methods`, {
  address: { country_id: "BR", postcode: cepFmt, region_id: regionId, region_code: probe.state },
});
const estMethods = Array.isArray(est.json) ? (est.json as Json[]).map((m) => ({ carrier: m.carrier_code, method: m.method_code, title: `${m.carrier_title} — ${m.method_title}`, amount: m.amount, available: m.available, error: m.error_message || undefined })) : null;
step("REST estimate-shipping-methods (CEP)", est.status, estMethods ?? est.json?.message ?? est.text.slice(0, 300));

let shippingMethods: Json[] | null = null;
let paymentMethods: Json[] | null = null;
if (via === "graphql") {
  const addr = { firstname, lastname, street: streetLines.filter(Boolean), city: probe.city, region_id: regionId, region: probe.state, postcode: cepFmt, country_code: "BR", telephone, save_in_address_book: false };
  const r = await gql(
    `mutation($c:String!,$a:CartAddressInput!){ setShippingAddressesOnCart(input:{cart_id:$c, shipping_addresses:[{address:$a}]}) { cart { shipping_addresses { postcode available_shipping_methods { carrier_code method_code carrier_title method_title amount { value } available error_message } } } } }`,
    { c: cartId, a: addr },
  );
  const sa = r.json?.data?.setShippingAddressesOnCart?.cart?.shipping_addresses?.[0];
  shippingMethods = (sa?.available_shipping_methods ?? []).map((m: Json) => ({ carrier: m.carrier_code, method: m.method_code, title: `${m.carrier_title} — ${m.method_title}`, amount: m.amount?.value, available: m.available, error: m.error_message || undefined }));
  step("setShippingAddressesOnCart", r.status, gqlErr(r) ?? { postcode: sa?.postcode, methods: shippingMethods });
  const chosen = (shippingMethods ?? []).filter((m) => m.available).sort((a, b) => a.amount - b.amount)[0];
  if (chosen) {
    const sm = await gql(`mutation($c:String!,$cc:String!,$mc:String!){ setShippingMethodsOnCart(input:{cart_id:$c, shipping_methods:[{carrier_code:$cc, method_code:$mc}]}) { cart { prices { grand_total { value } subtotal_excluding_tax { value } } } } }`, { c: cartId, cc: chosen.carrier, mc: chosen.method });
    step("setShippingMethodsOnCart", sm.status, gqlErr(sm) ?? { chosen: chosen.title, prices: sm.json?.data?.setShippingMethodsOnCart?.cart?.prices });
    const ba = await gql(`mutation($c:String!,$a:CartAddressInput!){ setBillingAddressOnCart(input:{cart_id:$c, billing_address:{address:$a}}) { cart { id } } }`, { c: cartId, a: addr });
    step("setBillingAddressOnCart", ba.status, gqlErr(ba) ?? { ok: true });
  }
  // ---------- 5. e-mail + pagamento ----------
  const em = await gql(`mutation($c:String!,$e:String!){ setGuestEmailOnCart(input:{cart_id:$c, email:$e}) { cart { email } } }`, { c: cartId, e: email });
  step("setGuestEmailOnCart", em.status, gqlErr(em) ?? { ok: true });
  const pm = await gql(`query($c:String!){ cart(cart_id:$c){ available_payment_methods { code title } prices { grand_total { value } } } }`, { c: cartId });
  paymentMethods = pm.json?.data?.cart?.available_payment_methods ?? null;
  step("available_payment_methods", pm.status, gqlErr(pm) ?? { methods: paymentMethods, total: pm.json?.data?.cart?.prices?.grand_total?.value });
}
if (!shippingMethods?.length && estMethods?.length) shippingMethods = estMethods;
// REST shipping-information: grava endereço+método e devolve payment_methods (não cria pedido)
const chosenRest = (shippingMethods ?? []).filter((m) => m.available !== false).sort((a, b) => a.amount - b.amount)[0];
if (!paymentMethods?.length && chosenRest) {
  const restAddr = { firstname, lastname, street: streetLines.filter(Boolean), city: probe.city, region_id: regionId, region_code: probe.state, region: probe.state, postcode: cepFmt, country_id: "BR", telephone, email };
  const si = await call(`${origin}/rest/V1/guest-carts/${cartId}/shipping-information`, {
    addressInformation: { shipping_address: restAddr, billing_address: restAddr, shipping_carrier_code: chosenRest.carrier, shipping_method_code: chosenRest.method },
  });
  paymentMethods = si.json?.payment_methods ?? null;
  step("REST shipping-information", si.status, si.json?.message ? { message: si.json.message, parameters: si.json.parameters } : { payment_methods: paymentMethods, grand_total: si.json?.totals?.grand_total, shipping: si.json?.totals?.shipping_amount });
}
if (!paymentMethods?.length) {
  const pm = await call(`${origin}/rest/V1/guest-carts/${cartId}/payment-methods`);
  if (Array.isArray(pm.json)) paymentMethods = pm.json;
  step("REST payment-methods", pm.status, Array.isArray(pm.json) ? pm.json : pm.json?.message ?? pm.text.slice(0, 200));
}
summary.shipping = shippingMethods;
summary.payment = paymentMethods;
summary.pix = (paymentMethods ?? []).filter((m) => /pix/i.test(`${m.code} ${m.title}`));
console.log(`\nRESUMO ${storeKey}: carrinho via ${via} · CEP ${cep} · ${shippingMethods?.length ?? 0} método(s) de entrega · pagamento: ${(paymentMethods ?? []).map((m) => m.code).join(", ") || "—"} · Pix: ${summary.pix.length ? summary.pix.map((m: Json) => m.code).join(", ") : "NÃO"}`);
console.log("  (seco: parou antes de placeOrder/payment-information)");
await finish(0);
