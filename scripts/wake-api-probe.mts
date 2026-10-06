// Sondagem SECA da Storefront API (GraphQL) da Wake Commerce (antiga Linx Commerce / Fbits),
// por HTTP puro. Responde "dá pra comprar por API como convidado?" loja a loja (06/10/2026).
//
//   npx tsx scripts/wake-api-probe.mts polipet                 # catálogo → carrinho → frete no CEP → formas de pagamento
//   npx tsx scripts/wake-api-probe.mts soneda --term "sabonete"
//   npx tsx scripts/wake-api-probe.mts --domain=www.loja.com.br
//
// Como funciona: a loja Wake expõe no HTML o token público da Storefront API
// (`storefrontAccessToken:"tcs_..."`, também no cookie `sf_storefront_access_token`), que vai no
// header `TCS-Access-Token` para `https://storefront-api.fbits.net/graphql` (multi-tenant).
//
// SOMENTE SECO: nunca chama `checkoutComplete`, `customerCreate`, login nem nada que crie
// pedido, conta ou cobrança. `checkoutAddressAssociate` exige `customerAccessToken` (cliente
// logado com endereço salvo) — por isso o frete é cotado por `shippingQuotes(cep:)`, sem login.
// Endereço: só o CEP do bloco `probe` do `.retail-buyer/config.json` é usado.
// Resultado: resumo no stdout; JSON em `.retail-buyer/probes/wake-<loja>-<ts>.json`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const STORES: Record<string, string> = {
  polipet: "www.polipet.com.br", // pet (SP)
  soneda: "www.soneda.com.br", // perfumaria/beleza (SP)
  balaroti: "www.balaroti.com.br", // construção/casa (PR)
  casaalmeida: "www.casaalmeida.com.br",
  mamobrasil: "www.mamobrasil.com.br",
  shoulder: "www.shoulder.com.br", // moda
  oqvestir: "www.oqvestir.com.br", // moda
  ybera: "www.ybera.com.br", // cosméticos
};
const API = "https://storefront-api.fbits.net/graphql";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
type Json = Record<string, any>;

const args = process.argv.slice(2);
const domainFlag = args.find((a) => a.startsWith("--domain="))?.slice(9);
const storeKey = domainFlag ? domainFlag.replace(/^www\./, "").replace(/\..*$/, "") : args[0];
if (domainFlag) STORES[storeKey] = domainFlag;
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!storeKey || !STORES[storeKey]) {
  console.error(`Uso: npx tsx scripts/wake-api-probe.mts <${Object.keys(STORES).join("|")}> [--term txt] [--variant id]`);
  process.exit(2);
}
const domain = STORES[storeKey];
const root = resolve(process.cwd(), ".retail-buyer");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8")) as { probe?: Record<string, string> };
const cep = (args.find((a) => a.startsWith("--cep="))?.slice(6) ?? config.probe?.cep ?? "").replace(/\D/g, "");
if (cep.length !== 8) {
  console.error("CEP de sondagem ausente (`probe.cep` no .retail-buyer/config.json).");
  process.exit(2);
}
const term = flag("--term");

const dump: Json = { store: storeKey, domain, cep, startedAt: new Date().toISOString(), steps: [] as Json[] };
function step(name: string, status: number, detail: unknown) {
  dump.steps.push({ name, status, detail });
  console.log(`[${name}] HTTP ${status} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}`);
}
function save() {
  mkdirSync(resolve(root, "probes"), { recursive: true });
  const file = resolve(root, "probes", `wake-${storeKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 1));
  console.log(`→ ${file}`);
}
function fail(msg: string): never {
  dump.result = { stoppedAt: msg };
  save();
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1) Token público do HTML.
const home = await fetch(`https://${domain}/`, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
const html = await home.text();
const token = html.match(/storefrontAccessToken\s*:\s*["'](tcs_[^"']+)["']/)?.[1] ?? html.match(/sf_storefront_access_token=(tcs_[^;"'\s]+)/)?.[1];
const checkoutUrl = html.match(/checkoutUrl\s*:\s*["']([^"']+)["']/)?.[1];
step("home", home.status, {
  poweredBy: home.headers.get("x-powered-by"),
  version: home.headers.get("x-version"),
  tokenFound: Boolean(token),
  tokenPrefix: token?.slice(0, 10),
  checkoutUrl,
  recaptchaInHtml: /recaptcha/i.test(html),
});
if (!token) fail("token público da Storefront API não encontrado no HTML");

async function gql(name: string, query: string, variables: Json = {}) {
  await sleep(700); // sem martelar
  const r = await fetch(API, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", "TCS-Access-Token": token!, Origin: `https://${domain}`, Referer: `https://${domain}/` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json: Json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: r.status, data: json.data as Json | undefined, errors: json.errors as Json[] | undefined, raw: json.raw };
}
const errs = (e?: Json[]) => e?.map((x) => x.message);

// 2) Catálogo: busca o item disponível mais barato (ou o termo dado).
const PRODUCT_FIELDS = "productId productVariantId productName variantName available stock prices { price listPrice installmentPlans { displayName name } }";
// `installmentPlans` lista os meios de pagamento configurados na loja (PIX, boleto, cartão…) sem login;
// `paymentMethods(checkoutId)` só responde com cliente logado + endereço no carrinho.
let variantId = flag("--variant") ? Number(flag("--variant")) : undefined;
let picked: Json | undefined;
if (!variantId) {
  const s = await gql(
    "search",
    `query($q:String){ search(query:$q, operation:AND, autoSecondSearch:true, ignoreDisplayRules:false, ignoreRedirectTerms:true, useAI:false){
      products(first:30, sortKey:PRICE, sortDirection:ASC, onlyMainVariant:false){ totalCount nodes { ${PRODUCT_FIELDS} } } } }`,
    { q: term ?? "" },
  );
  let nodes: Json[] = s.data?.search?.products?.nodes ?? [];
  step("search", s.status, { term: term ?? "(vazio)", total: s.data?.search?.products?.totalCount, errors: errs(s.errors), first: nodes.slice(0, 3).map((n) => [n.productName, n.prices?.price, n.available, n.stock]) });
  if (!nodes.length) {
    // Fallback: listagem de produtos sem termo, mais baratos primeiro.
    const p = await gql("products", `query{ products(first:30, sortKey:PRICE, sortDirection:ASC, filters:{ available:true }){ totalCount nodes { ${PRODUCT_FIELDS} } } }`);
    nodes = p.data?.products?.nodes ?? [];
    step("products", p.status, { total: p.data?.products?.totalCount, errors: errs(p.errors), first: nodes.slice(0, 3).map((n) => [n.productName, n.prices?.price, n.available]) });
  }
  picked = nodes.find((n) => n.available && (n.prices?.price ?? 0) >= 5) ?? nodes.find((n) => n.available);
  if (!picked) fail("nenhum produto disponível no catálogo pela API");
  variantId = Number(picked.productVariantId);
}
dump.picked = picked;
const catalogPlans = ((picked?.prices?.installmentPlans ?? []) as Json[]).map((p) => `${p.displayName} [${p.name}]`);
const catalogPix = catalogPlans.some((p) => /pix/i.test(p) && !/parcelad/i.test(p));
step("meios no catálogo (installmentPlans)", 200, { plans: catalogPlans, pix: catalogPix });

// 3) Carrinho anônimo.
const CHECKOUT_FIELDS = "checkoutId cep subtotal shippingFee total completed customer { customerId } products { name productVariantId quantity price } minimumRequirements { __typename }";
const c = await gql("createCheckout", `mutation($p:[CheckoutProductItemInput]){ createCheckout(products:$p){ ${CHECKOUT_FIELDS.replace(" minimumRequirements { __typename }", "")} } }`, { p: [{ productVariantId: variantId, quantity: 1 }] });
const checkout = c.data?.createCheckout;
step("createCheckout", c.status, { errors: errs(c.errors), checkoutId: checkout?.checkoutId, products: checkout?.products?.map((p: Json) => [p.name, p.quantity, p.price]), subtotal: checkout?.subtotal, total: checkout?.total });
if (!checkout?.checkoutId) fail("createCheckout falhou");
const checkoutId = checkout.checkoutId as string;

// 4) Frete por CEP (sem login, sem endereço salvo).
const sq = await gql(
  "shippingQuotes",
  `query($id:Uuid!, $cep:CEP){ shippingQuotes(checkoutId:$id, cep:$cep){ shippingQuoteId name type value deadline deadlineInHours distributionCenterId physicalStore { name city state pickup } } }`,
  { id: checkoutId, cep },
);
const quotes: Json[] = sq.data?.shippingQuotes ?? [];
step("shippingQuotes", sq.status, { errors: errs(sq.errors), quotes: quotes.map((q) => [q.name, q.type, q.value, q.deadline, q.deadlineInHours, q.physicalStore?.city]) });

// 4b) Selecionar o frete de entrega mais barato (não cria pedido; só grava no carrinho).
const delivery = quotes.filter((q) => !q.physicalStore?.pickup && !/retir/i.test(`${q.type} ${q.name}`)).sort((a, b) => a.value - b.value)[0];
if (delivery) {
  const sel = await gql(
    "checkoutSelectShippingQuote",
    `mutation($id:Uuid!, $q:Uuid!){ checkoutSelectShippingQuote(checkoutId:$id, shippingQuoteId:$q){ cep subtotal shippingFee total selectedShipping { name value deadline } } }`,
    { id: checkoutId, q: delivery.shippingQuoteId },
  );
  step("checkoutSelectShippingQuote", sel.status, { errors: errs(sel.errors), result: sel.data?.checkoutSelectShippingQuote });
}

// 5) Formas de pagamento oferecidas a este carrinho anônimo.
const pm = await gql("paymentMethods", `query($id:Uuid!){ paymentMethods(checkoutId:$id){ id name type hasMultiPayment } }`, { id: checkoutId });
const methods: Json[] = pm.data?.paymentMethods ?? [];
const pix = methods.find((m) => /pix/i.test(`${m.name} ${m.type}`));
step("paymentMethods", pm.status, { errors: errs(pm.errors), methods: methods.map((m) => [m.id, m.name, m.type]), pix: Boolean(pix) });

// 5b) Selecionar Pix (não cria pedido; só mostra o que a loja ainda exige antes de fechar).
if (pix) {
  const sp = await gql(
    "checkoutSelectPaymentMethod",
    `mutation($id:Uuid!, $m:ID!){ checkoutSelectPaymentMethod(checkoutId:$id, paymentMethodId:$m){ total paymentFees selectedPaymentMethod { id type displayType installments { number value total } } } }`,
    { id: checkoutId, m: pix.id },
  );
  step("checkoutSelectPaymentMethod(pix)", sp.status, { errors: errs(sp.errors), result: sp.data?.checkoutSelectPaymentMethod });
}

// 6) Estado final do carrinho (sem customerAccessToken: endereço/cliente devem vir vazios).
const fin = await gql("checkout", `query($id:String!){ checkout(checkoutId:$id){ cep subtotal shippingFee total customer { customerId } selectedAddress { cep } selectedShipping { name value deadline } selectedPaymentMethod { id type } url } }`, { id: checkoutId });
step("checkout(final)", fin.status, { errors: errs(fin.errors), result: fin.data?.checkout });

// Limpeza: tirar o item do carrinho anônimo.
const rm = await gql("checkoutRemoveProduct", `mutation($i:CheckoutProductInput!){ checkoutRemoveProduct(input:$i){ total } }`, { i: { id: checkoutId, products: [{ productVariantId: variantId, quantity: 1 }] } });
step("checkoutRemoveProduct", rm.status, { errors: errs(rm.errors), total: rm.data?.checkoutRemoveProduct?.total });

dump.result = {
  catalog: Boolean(variantId),
  cart: Boolean(checkoutId),
  freightQuotes: quotes.length,
  cheapestDelivery: delivery ? { name: delivery.name, value: delivery.value, deadline: delivery.deadline } : null,
  paymentMethods: methods.map((m) => m.name),
  pixInCheckout: Boolean(pix),
  catalogPlans,
  pixConfigured: catalogPix,
  note: "Fechamento (checkoutComplete) NÃO chamado. Endereço exige customerAccessToken (conta na loja); paymentData exige CPF.",
};
console.log("RESULTADO", JSON.stringify(dump.result));
save();
