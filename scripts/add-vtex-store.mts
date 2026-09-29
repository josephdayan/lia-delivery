// Liga uma loja VTEX na Lia em um comando (29/09/2026 — varredura em massa). Faz a fiação
// que a Americanas exigiu à mão: conector, registry, VTEX_API_STORES, frete ao vivo, leitor de
// e-mail, allowlist de domínio, rotina semanal, workflow, golden e load-env, e colhe o catálogo.
//
//   npx tsx scripts/add-vtex-store.mts <key> <www.dominio> "<Rótulo>" [--pharmacy] [--seller=1]
//       [--min=30] [--max=3000] [--categories=id,id] [--ft=termo;termo] [--no-harvest]
//
// Pré-requisito: fechamento REAL provado pela sondagem (`vtex-api-probe.mts --buy`). Sem isso, não
// ligar: loja que não fecha sozinha fica fora (regra do dono, 25/09).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [key, domain, label] = args.filter((a) => !a.startsWith("--"));
if (!key || !domain || !label || !/^[a-z0-9]+$/.test(key)) {
  console.error('uso: add-vtex-store.mts <key> <www.dominio> "<Rótulo>" [--pharmacy] [--seller=1] [--min=30] [--max=3000] [--categories=..] [--ft=..] [--no-harvest]');
  process.exit(2);
}
const flag = (n: string) => flags.find((f) => f.startsWith(`--${n}=`))?.slice(n.length + 3);
const pharmacy = flags.includes("--pharmacy");
const seller = flag("seller");
const min = Number(flag("min") ?? 0);
const max = Number(flag("max") ?? 3000);
const categories = flag("categories");
const ft = flag("ft");
const bare = domain.replace(/^www\./, "").replace(/^loja\./, "").replace(/^site\./, "");
const KEY = key.toUpperCase();
const camel = `${key}Store`;

function edit(path: string, anchor: string, insert: string, opts: { before?: boolean } = {}) {
  const s = readFileSync(path, "utf8");
  if (s.includes(insert.trim())) return console.log(`= ${path} já tem`);
  if (!s.includes(anchor)) throw new Error(`âncora não achada em ${path}: ${anchor.slice(0, 60)}`);
  const out = opts.before ? s.replace(anchor, insert + anchor) : s.replace(anchor, anchor + insert);
  writeFileSync(path, out);
  console.log(`+ ${path}`);
}

// 1. Conector
const connector = `src/lib/stores/${key}.ts`;
if (!existsSync(connector)) {
  writeFileSync(connector, `import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
${pharmacy ? 'import { withoutMedicine } from "./anvisa";\n' : ""}import { CATALOG } from "./${key}-catalog";

// ${label} — VTEX com checkout aberto por API (fechamento real provado pela sondagem em ${new Date().toISOString().slice(0, 10)}).
// Catálogo real colhido da API pública de ${domain} (scripts/add-vtex-store.mts). Compra pelo servidor,
// Pix da loja pago pela Lia; entrega pela própria loja.${pharmacy ? " SEM medicamento (ANVISA): deny na colheita + withoutMedicine." : ""}
const ITEMS = ${pharmacy ? "withoutMedicine(catalogWithImages(CATALOG))" : "catalogWithImages(CATALOG)"};

export const ${camel}: StoreConnector = {
  key: "${key}",
  label: "${label}",
  minOrder: Number(process.env.LIA_${KEY}_MIN_ORDER ?? ${min}),
  async searchItems(query: string, limit = 4) {
    return rankCatalog(query, ITEMS, limit);
  },
  listCatalog() {
    return ITEMS;
  },
  listUnits(): StoreUnit[] {
    return [];
  },
  pickupInstructions(orderNumber: string) {
    return \`Pedido ${label} nº \${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.\`;
  }
};
`);
  console.log(`+ ${connector}`);
}

// 2. Registry
edit("src/lib/stores/index.ts", 'import { americanasStore } from "./americanas";', `\nimport { ${camel} } from "./${key}";`);
edit("src/lib/stores/index.ts", '  ...(process.env.LIA_ENABLE_AMERICANAS !== "false" ? { [americanasStore.key]: americanasStore } : {}),',
  `\n  ...(process.env.LIA_ENABLE_${KEY} !== "false" ? { [${camel}.key]: ${camel} } : {}),`);
// 3. Checkout por API
edit("src/lib/purchase/vtex-checkout.ts", '  americanas: { domain: "www.americanas.com.br", skuPrefix: "americanas-", label: "Americanas" },',
  `\n  ${key}: { domain: "${domain}", skuPrefix: "${key}-", label: "${label}" },`);
// 4. Frete ao vivo
edit("src/lib/live-freight.ts", '  americanas: { domain: "www.americanas.com.br", sku: /^americanas-(\\d+)$/ },',
  `\n  ${key}: { domain: "${domain}", sku: /^${key}-(\\d+)$/ },`);
// 5. Leitor de e-mail
edit("src/lib/mailbox-policy.ts", '  americanas: { domains: ["americanas.com.br"], number: /\\b(v?\\d{8,13}[a-z]{0,4}-\\d{2})\\b/i, kinds: VTEX_KINDS },',
  `\n  ${key}: { domains: ["${bare}"], number: /\\b(v?\\d{8,13}[a-z]{0,4}-\\d{2})\\b/i, kinds: VTEX_KINDS },`);
// 6. Allowlist de domínio
edit("src/lib/purchase-preparation.ts", '  americanas: "americanas.com.br", ', `${key}: "${bare}", `);
// 7. Rotina semanal
const deny = pharmacy ? "PHARMACY_DENY" : undefined;
edit("scripts/refresh-catalogs.mts", '  { key: "mambo", origin: "https://www.mambo.com.br", max: 6000,',
  `  { key: "${key}", origin: "https://${domain}", max: ${max}${seller ? `, seller: "${seller}"` : ""}${categories ? `, categories: "${categories}"` : ""}${deny ? `, deny: ${deny}` : ""}${ft ? `, ft: "${ft}"` : ""} },\n`, { before: true });
edit(".github/workflows/refresh-precos.yml", "mambo americanas ", `${key} `);
// 8. Testes: golden (elenco de produção) e load-env (evals no mundo original)
edit("tests/helpers/golden-env.ts", '"MAMBO", "AMERICANAS", ', `"${KEY}", `);
edit("tests/helpers/load-env.ts", '  "AMERICANAS",\n', `  "${KEY}",\n`);

// 9. Catálogo
if (!flags.includes("--no-harvest")) {
  const denyRe = pharmacy
    ? "medicament|remedio|rem[eé]dio|vitamina|polivitam|suplement|vacina|manipula|generico|gen[eé]rico|comprimido|c[aá]psula|dipirona|paracetamol|ibuprofeno|amoxicilina|antibi[oó]tico|xarope|anti-inflamat|analg[eé]sico|antit[eé]rmico|insulina|soro fisiol|teste de|exame"
    : "";
  const cmd = [
    "node --import tsx scripts/harvest-vtex-catalog.mts", `https://${domain}`, key, `src/lib/stores/${key}-catalog.ts`, String(max),
    seller ? `--seller=${seller}` : "", categories ? `--categories=${categories}` : "", denyRe ? `--deny=${JSON.stringify(denyRe)}` : "", ft ? `--ft=${JSON.stringify(ft)}` : "",
  ].filter(Boolean).join(" ");
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}
console.log(`\nOK ${key}: rode tsc + testes (vtex-checkout, search-golden, anvisa) e commite.`);
