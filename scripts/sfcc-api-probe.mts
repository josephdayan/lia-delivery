// Sondagem SECA do checkout de convidado em lojas Salesforce Commerce Cloud (SFCC / B2C
// Commerce), por HTTP puro. Mesma pergunta do `vtex-api-probe.mts`: "dá pra comprar por API,
// sem operador, pagando Pix?" — aqui só até a lista de meios de pagamento. NUNCA cria pedido:
// não existe chamada a `/orders`, `PlaceOrder` nem `SubmitPayment` neste arquivo.
//
//   npx tsx scripts/sfcc-api-probe.mts puma        # SCAPI (PWA Kit): token pelo proxy SLAS do próprio site
//   npx tsx scripts/sfcc-api-probe.mts cacaushow   # SFRA híbrido: token SLAS de convidado vem no cookie cc-at_*
//   npx tsx scripts/sfcc-api-probe.mts loccitane   # SFRA clássico: controllers /on/demandware.store/...
//   npx tsx scripts/sfcc-api-probe.mts puma --term meia --pid 123456
//
// Duas famílias de acesso:
//  - "scapi": token de convidado (SLAS) → shopper-search → shopper-products → shopper-baskets
//    (cesta, e-mail, endereço, métodos de entrega, métodos de pagamento) → DELETE da cesta.
//    O token vem (a) do proxy `/mobify/slas/private/...` do PWA Kit, que injeta o segredo do
//    client privado no servidor da loja, ou (b) do cookie `cc-at_<site>` que o SFRA em modo
//    "hybrid auth" entrega a qualquer visitante.
//  - "sfra": sessão `dwsid` + controllers (Cart-AddProduct, Checkout-Begin,
//    CheckoutShippingServices-UpdateShippingMethodsList); meios de pagamento lidos do HTML do
//    checkout. Para antes de CheckoutServices-SubmitPayment / PlaceOrder.
//
// Endereço: SEMPRE o bloco `probe` do `.retail-buyer/config.json`. Rua, número, complemento e
// nome NUNCA são impressos nem gravados: o JSON salvo passa por `redact()`. Só o CEP aparece.
// Sem CPF/CNPJ, sem login, sem conta. Resultado: `.retail-buyer/probes/sfcc-<loja>-<ts>.json`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

type Json = Record<string, any>;
type Store = {
  domain: string;
  mode: "scapi-proxy" | "scapi-hybrid" | "sfra";
  site: string; // siteId SCAPI / nome do site SFRA (Sites-<site>-Site)
  org?: string;
  shortCode?: string;
  locale?: string;
  terms: string[];
  addr?: "puma" | "number-neighborhood"; // dialeto de endereço BR da loja
};
const STORES: Record<string, Store> = {
  puma: { domain: "br.puma.com", mode: "scapi-proxy", site: "BR", org: "f_ecom_bktg_prd", shortCode: "e0msji7y", addr: "puma", terms: ["meia", "chaveiro", "bone"] },
  cacaushow: { domain: "www.cacaushow.com.br", mode: "scapi-hybrid", site: "CacauShow", addr: "number-neighborhood", terms: ["trufa", "tablete"] },
  // L'Occitane: sem checkout de convidado (carrinho → Account-ShowLoginModal: login ou cadastro com código por e-mail).
  loccitane: { domain: "br.loccitaneaubresil.com", mode: "sfra", site: "LoccitaneBR", terms: ["sabonete", "creme de maos"] },
  // Sephora BR (SiteGenesis): busca é Constructor.io (ac.cnstrc.com, key pública), então o modo
  // "sfra" para na busca; à mão (06/10) Cart-AddProduct e ShippingQuote-Request funcionaram, mas
  // Cart-SubmitForm (entrada do checkout) dá 403 do Akamai Bot Manager para HTTP puro.
  sephora: { domain: "www.sephora.com.br", mode: "sfra", site: "Sephora_BR", terms: ["lixa", "esponja", "batom"] },
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const args = process.argv.slice(2);
const storeKey = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!storeKey || !STORES[storeKey]) {
  console.error(`Uso: npx tsx scripts/sfcc-api-probe.mts <${Object.keys(STORES).join("|")}> [--term txt] [--pid id]`);
  process.exit(2);
}
const store = STORES[storeKey];
const root = resolve(process.cwd(), ".retail-buyer");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8")) as { probe?: Record<string, string> };
const probe = config.probe;
if (!probe?.cep || !probe.street || !probe.city) {
  console.error("Defina `probe` no .retail-buyer/config.json (cep, street, number, neighborhood, city, state).");
  process.exit(2);
}
const email = "contato+probe@liadelivery.com.br";
const phone = "+5511999990000";
const cep = probe.cep.replace(/\D/g, "");
const cepDash = `${cep.slice(0, 5)}-${cep.slice(5)}`;
// Número sozinho não entra (redigiria preços); só junto da rua, que é como é enviado.
const SECRETS = [probe.text, `${probe.street}, ${probe.number}`, probe.street, probe.complement, probe.name].filter((s): s is string => !!s && s.length >= 3);
function redact(s: string): string {
  let out = s;
  for (const secret of SECRETS) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/("access_token"|"refresh_token"|"Authorization")\s*:\s*"[^"]+"/g, '$1:"[token]"')
    .replace(/("(?:address2|c_address3|c_number|c_streetNumber|lastName|firstName)"\s*:\s*)"[^"]*"/g, '$1"[REDACTED]"');
}

// ---------- HTTP com jar de cookies ----------
const jar = new Map<string, string>();
async function call(url: string, init: { method?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; accept?: string } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: init.accept ?? "application/json", "Accept-Language": "pt-BR,pt;q=0.9", ...init.headers };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const response = await fetch(url, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, body, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  for (const c of response.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  await new Promise((r) => setTimeout(r, 400)); // sem martelar
  return { status: response.status, json, text, url: response.url, server: response.headers.get("server") };
}

const dump: Json = { store: storeKey, domain: store.domain, mode: store.mode, cep, startedAt: new Date().toISOString(), steps: [] as Json[] };
function step(name: string, status: number, detail: unknown) {
  dump.steps.push({ name, status, detail });
  const line = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(redact(`[${name}] HTTP ${status} ${line.length > 900 ? line.slice(0, 900) + "…" : line}`));
}
function save() {
  mkdirSync(resolve(root, "probes"), { recursive: true });
  const file = resolve(root, "probes", `sfcc-${storeKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, redact(JSON.stringify(dump, null, 1)));
  console.log(`→ ${file}`);
}
let cleanup: (() => Promise<void>) | null = null;
async function finish(msg?: string): Promise<never> {
  if (cleanup) {
    try {
      await cleanup();
    } catch (e) {
      step("limpeza", 0, String(e));
    }
  }
  if (msg) step("parou", 0, msg);
  save();
  process.exit(msg ? 1 : 0);
}
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (error: unknown) => {
    step("erro inesperado", 0, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    save();
    process.exit(1);
  });
}
const PIX_RE = /\bpix\b/i;
const decodeJwt = (t: string): Json => {
  const p = t.split(".")[1];
  return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
};

// ============================== SCAPI ==============================
async function runScapi() {
  let token = "";
  let org = store.org;
  let shortCode = store.shortCode;
  if (store.mode === "scapi-proxy") {
    // PWA Kit com SLAS "private client": o servidor da loja guarda o segredo e expõe o proxy.
    const r = await call(`https://${store.domain}/mobify/slas/private/shopper/auth/v1/organizations/${org}/oauth2/token`, {
      form: { grant_type: "client_credentials", channel_id: store.site },
      headers: { Origin: `https://${store.domain}`, Referer: `https://${store.domain}/` },
    });
    token = r.json?.access_token ?? "";
    step("token convidado (proxy SLAS do site)", r.status, token ? { usid: r.json.usid, expires_in: r.json.expires_in, server: r.server } : r.text.slice(0, 200));
  } else {
    const r = await call(`https://${store.domain}/`, { accept: "text/html" });
    const cookie = [...jar].find(([k]) => k.startsWith("cc-at_"));
    token = cookie?.[1] ?? "";
    step("home (cookie cc-at do SFRA híbrido)", r.status, { cookies: [...jar.keys()], hasToken: !!token, server: r.server });
  }
  if (!token) await finish("sem token de convidado");
  const claims = decodeJwt(token);
  shortCode ??= claims.ssc;
  org ??= `f_ecom_${String(claims.iss).split("/").pop()}`;
  step("claims", 0, { org, shortCode, isb: claims.isb, scopesBaskets: String(claims.scp).includes("shopper-baskets-orders.rw") });
  const api = `https://${shortCode}.api.commercecloud.salesforce.com`;
  const auth = { Authorization: `Bearer ${token}` };
  const site = `siteId=${store.site}&locale=pt-BR`;

  // 1. produto barato e pedível
  let pid = flag("--pid");
  if (!pid) {
    const terms = flag("--term") ? [flag("--term")!] : store.terms;
    for (const term of terms) {
      const r = await call(`${api}/search/shopper-search/v1/organizations/${org}/product-search?${site}&q=${encodeURIComponent(term)}&limit=24`, { headers: auth });
      const hits: Json[] = (r.json?.hits ?? []).filter((h: Json) => h.orderable !== false && h.price);
      hits.sort((a, b) => a.price - b.price);
      step(`busca "${term}"`, r.status, { total: r.json?.total, cheapest: hits.slice(0, 3).map((h) => [h.productId, h.price, h.productName, h.hitType]) });
      if (hits[0]) {
        pid = hits[0].productId;
        break;
      }
    }
  }
  if (!pid) await finish("busca sem item");
  let prod = await call(`${api}/product/shopper-products/v1/organizations/${org}/products/${pid}?${site}&expand=availability,prices,variations`, { headers: auth });
  let p = prod.json ?? {};
  if (p.type?.master || p.type?.variationGroup || (p.variants && !p.type?.variant)) {
    const v = (p.variants ?? []).find((x: Json) => x.orderable);
    step("produto (mestre)", prod.status, { id: p.id, name: p.name, variants: (p.variants ?? []).length, pick: v?.productId });
    if (v) {
      prod = await call(`${api}/product/shopper-products/v1/organizations/${org}/products/${v.productId}?${site}&expand=availability,prices`, { headers: auth });
      // Puma: o hook custom da variante dá 500; o item da variante entra na cesta mesmo assim.
      p = prod.status < 300 ? prod.json : { id: v.productId, name: p.name, price: v.price, inventory: { orderable: v.orderable } };
    }
  }
  step("produto", prod.status, { id: p.id, name: p.name, price: p.price, orderable: p.inventory?.orderable, ats: p.inventory?.ats, fault: p.title ?? p.detail });
  if (!p.id) await finish("produto não carregou");

  // 2. cesta
  const bpath = `${api}/checkout/shopper-baskets/v1/organizations/${org}/baskets`;
  const created = await call(`${bpath}?${site}`, { method: "POST", body: {}, headers: auth });
  // SFRA híbrido: a sessão do site já abriu uma cesta pra este convidado (cota = 1); reaproveita.
  const basketId = created.json?.basketId ?? String(created.json?.detail ?? "").match(/\(([a-f0-9]{20,})/)?.[1];
  step("cesta", created.status, basketId ?? created.text.slice(0, 300));
  if (!basketId) await finish("sem cesta");
  cleanup = async () => {
    const d = await call(`${bpath}/${basketId}?siteId=${store.site}`, { method: "DELETE", headers: auth });
    step("cesta apagada (limpeza)", d.status, d.text.slice(0, 300));
  };
  const added = await call(`${bpath}/${basketId}/items?${site}`, { method: "POST", body: [{ productId: p.id, quantity: 1 }], headers: auth });
  step("item", added.status, added.json?.productItems ? { items: added.json.productItems.map((i: Json) => [i.productId, i.productName, i.price]), productTotal: added.json.productTotal } : added.text.slice(0, 300));
  if (added.status >= 300) await finish("item recusado");

  // 3. convidado (e-mail) — sem documento
  const cust = await call(`${bpath}/${basketId}/customer?${site}`, { method: "PUT", body: { email }, headers: auth });
  step("e-mail convidado", cust.status, cust.json?.customerInfo ?? cust.text.slice(0, 300));

  // 4. endereço (campos padrão + atributos BR comuns; a loja ignora c_* que não conhece? se não, reporta)
  // CPF (c_documentType/c_documentNumber) NUNCA é enviado.
  const addr: Json =
    store.addr === "puma"
      ? // Puma (PWA Kit): address1 = rua, address2 = número, c_address3 = complemento, c_district = bairro.
        { address1: probe!.street, address2: probe!.number, c_address3: probe!.complement || undefined, c_district: probe!.neighborhood }
      : // Cacau Show: c_number e c_neighborhood obrigatórios (AddressVerificationError).
        { address1: probe!.street, address2: probe!.complement || undefined, c_number: probe!.number, c_neighborhood: probe!.neighborhood };
  Object.assign(addr, { firstName: "Lia", lastName: "Delivery", city: probe!.city, postalCode: cepDash, stateCode: probe!.state, countryCode: "BR", phone });

  let shipAddr = await call(`${bpath}/${basketId}/shipments/me/shipping-address?${site}&useAsBilling=true`, { method: "PUT", body: addr, headers: auth });
  step("endereço", shipAddr.status, shipAddr.json?.shipments?.[0]?.shippingAddress ? { postalCode: shipAddr.json.shipments[0].shippingAddress.postalCode } : shipAddr.text.slice(0, 1500));

  // 5. métodos de entrega (preço/prazo)
  const sm = await call(`${bpath}/${basketId}/shipments/me/shipping-methods?${site}`, { headers: auth });
  const methods: Json[] = sm.json?.applicableShippingMethods ?? [];
  step(
    "métodos de entrega",
    sm.status,
    methods.length
      ? methods.map((m) => ({ id: m.id, name: m.name, price: m.price, description: m.description, c: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("c_"))) }))
      : sm.text.slice(0, 400),
  );
  const pick = methods.find((m) => typeof m.price === "number") ?? methods[0];
  if (pick) {
    const set = await call(`${bpath}/${basketId}/shipments/me/shipping-method?${site}`, { method: "PUT", body: { id: pick.id }, headers: auth });
    step("escolhe entrega", set.status, { id: pick.id, shippingTotal: set.json?.shippingTotal, orderTotal: set.json?.orderTotal, productTotal: set.json?.productTotal, fault: set.json?.title });
  }

  // 6. meios de pagamento — a pergunta principal: existe Pix?
  const pm = await call(`${bpath}/${basketId}/payment-methods?${site}`, { headers: auth });
  const pms: Json[] = pm.json?.applicablePaymentMethods ?? [];
  const pix = pms.some((m) => PIX_RE.test(`${m.id} ${m.name} ${m.description ?? ""}`));
  step("meios de pagamento", pm.status, pms.length ? pms.map((m) => ({ id: m.id, name: m.name, processor: m.paymentProcessorId, cards: (m.cards ?? []).length || undefined })) : pm.text.slice(0, 400));
  dump.result = { pid: p.id, price: p.price, shipping: methods.map((m) => [m.id, m.price]), payments: pms.map((m) => m.id), pix };
  console.log(`\nPix oferecido ao convidado: ${pix ? "SIM" : "NÃO"}`);
  await finish();
}

// ============================== SFRA ==============================
async function runSfra() {
  const base = `https://${store.domain}/on/demandware.store/Sites-${store.site}-Site/${store.locale ?? "pt_BR"}`;
  const home = await call(`https://${store.domain}/`, { accept: "text/html" });
  step("home", home.status, { cookies: [...jar.keys()], server: home.server, botCookies: [...jar.keys()].filter((k) => /^(_abck|bm_|_px|__cf|cf_|datadome)/.test(k)) });
  if (home.status >= 400) await finish("home bloqueada");

  // Candidatos: --pid ou os data-pid da busca. Product-Variation nem sempre existe (L'Occitane: 500),
  // então o critério é o próprio Cart-AddProduct aceitar o item.
  const candidates: string[] = flag("--pid") ? [flag("--pid")!] : [];
  if (!candidates.length) {
    const terms = flag("--term") ? [flag("--term")!] : store.terms;
    for (const term of terms) {
      const r = await call(`${base}/Search-Show?q=${encodeURIComponent(term)}&srule=price-low-to-high`, { accept: "text/html" });
      const pids = [...new Set([...r.text.matchAll(/data-pid="([^"]+)"/g)].map((m) => m[1]))];
      step(`busca "${term}"`, r.status, { url: r.url, pids: pids.slice(0, 8), botWall: r.status === 403 || /captcha|challenge/i.test(r.text.slice(0, 3000)) });
      candidates.push(...pids.slice(0, 6));
      if (pids.length) break;
    }
  }
  let items: Json[] = [];
  let pid = "";
  for (const cand of candidates) {
    const add = await call(`${base}/Cart-AddProduct`, { form: { pid: cand, quantity: "1", options: "[]" }, headers: { "X-Requested-With": "XMLHttpRequest" } });
    step("Cart-AddProduct", add.status, add.json ? { pid: cand, error: add.json.error, message: add.json.message, qty: add.json.quantityTotal, items: add.json.cart?.items?.map((i: Json) => [i.id, i.productName, i.price?.sales?.value ?? i.priceTotal?.price, i.UUID]) } : add.text.slice(0, 200));
    if (!add.json?.error && add.json?.cart?.items?.length) {
      items = add.json.cart.items;
      pid = cand;
      break;
    }
  }
  cleanup = async () => {
    for (const it of items) {
      const d = await call(`${base}/Cart-RemoveProductLineItem?pid=${encodeURIComponent(it.id)}&uuid=${it.UUID}`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
      step("item removido (limpeza)", d.status, "");
    }
  };
  if (!items.length) await finish("item não entrou no carrinho");

  // Checkout de convidado: Checkout-Begin (SFRA aceita convidado; algumas lojas redirecionam pro login)
  const begin = await call(`${base}/Checkout-Begin`, { accept: "text/html" });
  const html = begin.text;
  const shipmentUUID = html.match(/name="shipmentUUID"\s+value="([^"]+)"/)?.[1] ?? html.match(/data-shipment-uuid="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  const payIds = [...new Set([...html.matchAll(/data-method-id="([^"]+)"/g)].map((m) => m[1]))];
  const payWords = [...new Set([...html.matchAll(/(?:payment[-_]?method|paymentMethod)[^>]{0,200}?(?:value|data-[a-z-]+)="([^"]{2,40})"/gi)].map((m) => m[1]))].slice(0, 20);
  const forms = [...new Set([...html.matchAll(/name="(dwfrm_[a-z_]+)"/gi)].map((m) => m[1]))];
  step("Checkout-Begin", begin.status, { url: begin.url, shipmentUUID: !!shipmentUUID, csrf: !!csrf, payIds, payWords, pixInHtml: PIX_RE.test(html), forms: forms.slice(0, 60), captcha: /recaptcha|hcaptcha|turnstile/i.test(html) });
  dump.checkoutHtmlLen = html.length;
  if (process.env.SFCC_SAVE_HTML) writeFileSync(resolve(root, "probes", `sfcc-${storeKey}-checkout.html`), redact(html));

  if (shipmentUUID && csrf) {
    // Os nomes dos campos variam por loja (SFRA customizado). Envia o padrão SFRA + variantes BR comuns.
    const f: Record<string, string> = {
      shipmentUUID,
      csrf_token: csrf,
      "dwfrm_shipping_shippingAddress_addressFields_firstName": "Lia",
      "dwfrm_shipping_shippingAddress_addressFields_lastName": "Delivery",
      "dwfrm_shipping_shippingAddress_addressFields_address1": probe!.street,
      "dwfrm_shipping_shippingAddress_addressFields_address2": probe!.complement ?? "",
      "dwfrm_shipping_shippingAddress_addressFields_postalCode": cepDash,
      "dwfrm_shipping_shippingAddress_addressFields_city": probe!.city,
      "dwfrm_shipping_shippingAddress_addressFields_states_stateCode": probe!.state,
      "dwfrm_shipping_shippingAddress_addressFields_country": "BR",
      "dwfrm_shipping_shippingAddress_addressFields_phone": phone,
      firstName: "Lia",
      lastName: "Delivery",
      address1: probe!.street,
      postalCode: cepDash,
      city: probe!.city,
      stateCode: probe!.state,
      countryCode: "BR",
    };
    const upd = await call(`${base}/CheckoutShippingServices-UpdateShippingMethodsList`, { form: f, headers: { "X-Requested-With": "XMLHttpRequest" } });
    const ship: Json[] = upd.json?.order?.shipping?.[0]?.applicableShippingMethods ?? [];
    step(
      "UpdateShippingMethodsList",
      upd.status,
      upd.json
        ? { error: upd.json.error, methods: ship.map((m) => [m.ID, m.displayName, m.shippingCost, m.estimatedArrivalTime]), totals: upd.json.order?.totals ? { sub: upd.json.order.totals.subTotal, ship: upd.json.order.totals.totalShippingCost, total: upd.json.order.totals.grandTotal } : undefined }
        : upd.text.slice(0, 300),
    );
    dump.result = { pid, shipping: ship.map((m) => [m.ID, m.shippingCost]), payIds, pix: PIX_RE.test(html) };
  } else {
    dump.result = { pid, payIds, pix: PIX_RE.test(html), note: "sem shipmentUUID/csrf no Checkout-Begin" };
  }
  console.log(`\nPix no HTML do checkout: ${PIX_RE.test(html) ? "SIM" : "NÃO"} (ids: ${payIds.join(", ") || "—"})`);
  await finish();
}

if (store.mode === "sfra") await runSfra();
else await runScapi();
