// Colhe o catálogo de REMÉDIO ISENTO DE PRESCRIÇÃO (MIP) das farmácias da Lia (29/09/2026).
//
//   npx tsx scripts/harvest-mip-catalog.mts            # escreve os dois arquivos
//   npx tsx scripts/harvest-mip-catalog.mts --dry      # só conta, não escreve
//   npx tsx scripts/harvest-mip-catalog.mts --out-dir=/tmp/x   # grava noutra pasta (rotina semanal)
//
// Lista POSITIVA, feita pela própria farmácia, nunca por palavra nossa:
//   - Drogaria SP: a loja separa os isentos numa prateleira própria ("Remédios", C:/868/ —
//     Dorflex, Tylenol, Buscopan, Loratadina 10 mg, antigripais). Os de tarja ficam em
//     "Medicamentos" (C:/800/), marcados "Tarja Vermelha"/"Tarja Preta" e com o tipo de
//     receita; de lá só entra o que a loja marca "Sem Tarja". Item com qualquer classificação
//     diferente de "Sem Tarja", ou "Com Retenção De Receita", fica fora.
//   - Pague Menos: não publica tarja. Só entra item cujo CÓDIGO DE BARRAS (GTIN válido) é o de
//     um MIP da Drogaria SP, e que a loja não marca como antibiótico/controlado/restrito.
//   - As duas passam ainda pela guarda de prescrição por nome (src/lib/medicine.ts), que o
//     runtime repete: prateleira errada da loja não vira venda de remédio de receita.
// Farmácia sem tarja nem código de barras confiável (Drogal) fica de fora.
// Só API pública da VTEX, a mesma do scripts/harvest-vtex-catalog.mts.
import { writeFileSync } from "node:fs";
import { isPrescriptionText, isValidGtin, onlyDigits } from "../src/lib/medicine";

const DRY = process.argv.includes("--dry");
// --out-dir=<pasta>: a rotina semanal (scripts/refresh-catalogs.mts) colhe numa pasta temporária
// e só troca o catálogo real se a colheita não encolheu.
const OUT_DIR = process.argv.find((a) => a.startsWith("--out-dir="))?.slice("--out-dir=".length) ?? "src/lib/stores";
const DSP = "https://www.drogariasaopaulo.com.br";
const PM = "https://www.paguemenos.com.br";
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "application/json",
};
// A VTEX pública pagina até _from=2500. A prateleira de isentos da Drogaria SP passa disso:
// três ordenações diferentes cobrem o que uma só corta.
const MAX_FROM = 2500;
const ORDERS = ["OrderByTopSaleDESC", "OrderByNameASC", "OrderByNameDESC"];
// Pague Menos, "Medicamentos e Saúde": subcategorias onde há isento. As de receita
// (colesterol, contraceptivos, sistema nervoso, diabetes, hormônio, pressão, tireoide,
// canabinoides, emagrecedores) e as de aparelho/ortopedia nem são varridas — o código de
// barras é a trava de verdade; isso só poupa requisição.
const PM_SUBCATEGORIES = ["100/101", "100/103", "100/104", "100/108", "100/109", "100/110", "100/111", "100/112", "100/114", "100/115", "100/119", "100/122", "100/124", "100/126", "100/681", "100/683", "100/705", "100/714", "100/716", "100/717"];

type Seller = { sellerId?: string; commertialOffer?: { Price?: number; AvailableQuantity?: number } };
type Sku = { itemId?: string; ean?: string; nameComplete?: string; name?: string; images?: Array<{ imageUrl?: string }>; sellers?: Seller[] };
type Product = Record<string, unknown> & { productName?: string; brand?: string; link?: string; linkText?: string; categories?: string[]; items?: Sku[] };
type Out = { sku: string; name: string; brand?: string; unitPrice: number; unit: string; category: string; imageUrl?: string; productUrl: string; popularity: number; medicine: "mip"; ean?: string };

const spec = (p: Product, key: string): string => {
  const v = p[key];
  return Array.isArray(v) ? v.map(String).join(" ") : "";
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const slug = (p: Product, extra = "") =>
  norm(`${(p.categories?.[0] ?? "").split("/").filter(Boolean).join(" ")} ${extra}`).replace(/\s+/g, " ").trim();

async function page(origin: string, fq: string[], from: number, order: string): Promise<Product[]> {
  const q = fq.map((f) => `&fq=${encodeURIComponent(f)}`).join("");
  const url = `${origin}/api/catalog_system/pub/products/search?_from=${from}&_to=${from + 49}&O=${order}${q}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok || res.status === 206) return (await res.json()) as Product[];
    if (res.status === 400 || res.status === 404) return [];
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`falhou: ${url}`);
}

async function sweep(origin: string, fq: string[], orders: string[], onProduct: (p: Product) => void) {
  for (const order of orders) {
    for (let from = 0; from < MAX_FROM; from += 50) {
      let products: Product[];
      try {
        products = await page(origin, fq, from, order);
      } catch (error) {
        console.warn(`\nparada ${fq.join(" ")} ${order} _from=${from}: ${error instanceof Error ? error.message : error}`);
        break;
      }
      if (!products.length) break;
      products.forEach(onProduct);
      process.stdout.write(`\r${origin.replace("https://www.", "")} ${fq.join(" ")} ${order} ${from}…   `);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function offer(item: Sku | undefined) {
  const seller = item?.sellers?.find((s) => (s.commertialOffer?.AvailableQuantity ?? 0) > 0 && (s.commertialOffer?.Price ?? 0) > 0);
  return seller?.commertialOffer?.Price;
}

const rejected: Record<string, number> = {};
const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

// ---- Drogaria SP ----
const dsp: Out[] = [];
const dspSeen = new Set<string>();
const dspEans = new Set<string>();
function absorbDsp(p: Product) {
  const item = p.items?.[0];
  const id = item?.itemId;
  const price = offer(item);
  const link = p.link ?? (p.linkText ? `${DSP}/${p.linkText}/p` : undefined);
  if (!id || !price || !link || dspSeen.has(id)) return;
  dspSeen.add(id);
  const name = (item.nameComplete || item.name || p.productName || "").replace(/\s+/g, " ").trim();
  const classification = norm(spec(p, "Classificação"));
  const prescription = norm(spec(p, "Prescrição Médica"));
  const klass = spec(p, "Classe dos Remédios") || spec(p, "Classe do Medicamento");
  if (classification && classification !== "sem tarja") return reject("dsp: classificação ≠ sem tarja");
  if (/com retencao|com receita|sob prescricao/.test(prescription)) return reject("dsp: receita");
  if (isPrescriptionText(`${name} ${klass} ${(p.categories ?? []).join(" ")}`)) return reject("dsp: nome/classe de receita");
  const ean = isValidGtin(item.ean) ? onlyDigits(item.ean!) : undefined;
  if (ean) dspEans.add(ean);
  dsp.push({
    sku: `dsp-${id}`,
    name,
    brand: p.brand || undefined,
    unitPrice: Math.round(price * 100) / 100,
    unit: "un",
    category: slug(p, klass),
    imageUrl: item.images?.[0]?.imageUrl,
    productUrl: new URL(link, DSP).toString(),
    popularity: dsp.length + 1,
    medicine: "mip",
    ...(ean ? { ean } : {}),
  });
}
await sweep(DSP, ["C:/868/"], ORDERS, absorbDsp);
await sweep(DSP, ["C:/800/", "specificationFilter_176:Sem Tarja"], ["OrderByTopSaleDESC"], absorbDsp);
console.log(`\nDrogaria SP: ${dsp.length} isentos (${dspEans.size} com código de barras)`);

// ---- Pague Menos ----
const pm: Out[] = [];
const pmSeen = new Set<string>();
function absorbPm(p: Product) {
  const item = p.items?.[0];
  const id = item?.itemId;
  const price = offer(item);
  const link = p.link ?? (p.linkText ? `${PM}/${p.linkText}/p` : undefined);
  if (!id || !price || !link || pmSeen.has(id)) return;
  pmSeen.add(id);
  const ean = isValidGtin(item.ean) ? onlyDigits(item.ean!) : "";
  if (!ean || !dspEans.has(ean)) return reject("pm: código de barras fora da lista da Drogaria SP");
  if (/sim/i.test(spec(p, "Antibiotico")) || /sim/i.test(spec(p, "MedicamentoControlado")) || /sim/i.test(spec(p, "TemRestricao"))) return reject("pm: antibiótico/controlado/restrito");
  const name = (item.nameComplete || item.name || p.productName || "").replace(/\s+/g, " ").trim();
  if (isPrescriptionText(`${name} ${spec(p, "NomeSubstanciaPrincipioAtivo")} ${(p.categories ?? []).join(" ")}`)) return reject("pm: nome de receita");
  pm.push({
    sku: `paguemenos-${id}`,
    name,
    brand: p.brand || undefined,
    unitPrice: Math.round(price * 100) / 100,
    unit: "un",
    category: slug(p),
    imageUrl: item.images?.[0]?.imageUrl,
    productUrl: new URL(link, PM).toString(),
    popularity: pm.length + 1,
    medicine: "mip",
    ean,
  });
}
for (const sub of PM_SUBCATEGORIES) await sweep(PM, [`C:/${sub}/`], ["OrderByTopSaleDESC"], absorbPm);
console.log(`\nPague Menos: ${pm.length} isentos confirmados pelo código de barras`);
console.log("descartes:", rejected);

function write(file: string, origin: string, items: Out[]) {
  const header = `// GERADO por scripts/harvest-mip-catalog.mts em ${new Date().toISOString().slice(0, 10)} a partir da API pública de
// ${origin}. REMÉDIO ISENTO DE PRESCRIÇÃO: lista positiva da própria farmácia (ver o cabeçalho do
// script). Servido só com LIA_MEDICINE_MIP=true e sempre repassado pela guarda de prescrição em
// runtime (src/lib/stores/anvisa.ts → mipOnly). Para atualizar: npx tsx scripts/harvest-mip-catalog.mts
import type { CatalogItem } from "./types";

export const MIP_CATALOG: CatalogItem[] = `;
  writeFileSync(file, header + JSON.stringify(items, null, 1).replace(/"([a-zA-Z]+)":/g, "$1:") + ";\n");
  console.log(`${items.length} → ${file}`);
}
if (!DRY) {
  if (dsp.length < 200) throw new Error(`Drogaria SP devolveu só ${dsp.length} isentos — colheita suspeita, nada escrito.`);
  write(`${OUT_DIR}/drogariasp-mip-catalog.ts`, DSP, dsp);
  write(`${OUT_DIR}/paguemenos-mip-catalog.ts`, PM, pm);
}
