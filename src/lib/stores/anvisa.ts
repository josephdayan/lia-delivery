import type { CatalogItem } from "./types";
import { isPrescriptionText } from "../medicine";

// Terceira guarda ANVISA — roda em RUNTIME, no conector, depois da colheita.
//
// A Lia não vende medicamento. As vitrines de farmácia já são colhidas com allowlist de
// categoria (`--categories`) e deny-regex (`--deny`), mas a auditoria de 02/08 provou que isso
// não basta: a própria loja classifica medicamento dentro de categorias cosméticas. Escaparam
// itens com princípio ativo registrado — cetoconazol (antifúngico), metronidazol (Rozex),
// ciclopirox e "Dermodex Tratamento 100.000 U.I./g".
//
// Por isso o filtro final mora aqui, no código, e não no script de colheita: uma recolheita
// futura não pode reintroduzir medicamento por esquecimento de flag. Preferimos descartar um
// cosmético limítrofe a vender um remédio — no concierge o operador cota à mão o que faltar.
//
// Ao mexer aqui: só AFROUXE com evidência de que o item não é medicamento registrado.

// Princípios ativos e marcas de medicamento. Basta aparecer no nome para descartar.
const ACTIVE_INGREDIENT_RE =
  /\b(ciclopirox|cetoconazol|ketoconazol|metronidazol|miconazol|clotrimazol|nistatina|terbinafina|fluconazol|dexpantenol|neomicina|bacitracina|hidrocortisona|dexametasona|betametasona|triancinolona|lidoca[ií]na|benzoca[ií]na|adapaleno|tretino[ií]na|peroxido de benzo[ií]la|per[oó]xido de benzo[ií]la|clindamicina|eritromicina|mupirocina|aciclovir|permetrina|ivermectina|cetirizina|loratadina|dexclorfeniramina|dipirona|paracetamol|ibuprofeno|nimesulida|diclofenaco|naproxeno|omeprazol|pantoprazol|ranitidina|simeticona|bromoprida|metoclopramida|amoxicilina|azitromicina|cefalexina|prednisona|prednisolona|salbutamol|budesonida|insulina|semaglutida|tirzepatida|liraglutida|sinvastatina|losartana|enalapril|metformina|sertralina|fluoxetina|clonazepam)\b/i;

// Marcas cujo nome, sozinho, identifica medicamento no varejo brasileiro.
const MEDICINE_BRAND_RE =
  /\b(rozex|dermodex tratamento|zella|dorflex|neosaldina|buscopan|novalgina|tylenol|advil|benegrip|resfenol|cimegripe|coristina|torsilax|luftal|epocler|engov|sonrisal|eno frutas|gaviscon|rivotril|mounjaro|ozempic|wegovy|saxenda|voltaren|cataflam|allegra|loratamed|polaramine|celestamine|nasonex|rinosoro medic)\b/i;

// Notação de dosagem farmacêutica: "80 Mg/g", "7,5mg/g", "100.000 U.I./g". Cosmético não
// declara concentração de princípio ativo assim; medicamento declara.
const DOSAGE_NOTATION_RE = /\d[\d.,]*\s*(mg\s*\/\s*[gm]l?|u\.?\s?i\.?\s*\/\s*g|mcg\s*\/)/i;

// Palavras que marcam finalidade terapêutica declarada.
const THERAPEUTIC_CLAIM_RE =
  /\b(anti[-\s]?f[uú]ngic|antibi[oó]tic|anti[-\s]?inflamat[oó]ri|analg[eé]sic|antit[eé]rmic|antial[eé]rgic|antiviral|vermífug|vermifug|laxante|descongestionante|medicamento|rem[eé]dio|via oral|uso oral|comprimido|c[aá]psula|dr[aá]gea)\b/i;

export function isMedicine(item: Pick<CatalogItem, "name" | "category">): boolean {
  const haystack = `${item.name ?? ""} ${item.category ?? ""}`;
  return (
    ACTIVE_INGREDIENT_RE.test(haystack) ||
    MEDICINE_BRAND_RE.test(haystack) ||
    DOSAGE_NOTATION_RE.test(haystack) ||
    THERAPEUTIC_CLAIM_RE.test(haystack)
  );
}

/** Remove medicamento de uma vitrine de farmácia. Sempre aplicar antes de servir o catálogo. */
export function withoutMedicine(items: CatalogItem[]): CatalogItem[] {
  return items.filter((item) => !isMedicine(item));
}

// ---------------------------------------------------------------------------
// Pet: medicamento veterinário, antipulga e dieta de prescrição
//
// Mesma regra, outro balcão. O catálogo histórico da Petz já tinha sido curado sem remédio nem
// antipulga; a Cobasi (colhida em 02/08 pela API pública) vinha com 65 itens de medicamento —
// Simparic, Bravecto, NexGard, Apoquel, Drontal, Seresto, Prediderm — e 56 dietas de prescrição
// (Royal Canin Veterinary Diet, Premier Nutrição Clínica). Antiparasitário e medicamento
// veterinário são regulados (MAPA) e dieta terapêutica exige receita: nada disso pode ser
// vendido por concierge. O operador cota à mão se um cliente pedir, com receita.

const VET_MEDICINE_BRAND_RE =
  /\b(simparic|bravecto|nexgard|frontline|advantage|advocate|comfortis|credelio|seresto|revolution|drontal|milbemax|endogard|vermivet|apoquel|prediderm|cytopoint|previcox|meloxivet|carprodyl|agemoxi|baytril|enrofloxacin|doxitec|otomax|conofite|dermazon|alergovet)\b/i;

const VET_MEDICINE_TERM_RE =
  /\b(antipulga|anti[-\s]?pulga|carrapaticida|antiparasit|verm[ií]fugo|vermifugo|verminose|antibi[oó]tic|anti[-\s]?inflamat[oó]ri|medicamento|rem[eé]dio|vacina|sedativ|antial[eé]rgic|verm[ií]fug)\b/i;

// Linhas terapêuticas que exigem prescrição veterinária.
const VET_PRESCRIPTION_DIET_RE =
  /\b(veterinary diet|prescription diet|nutri[çc][aã]o cl[ií]nica|dieta veterin[aá]ri|renal special|urinary s\/o|hepatic|gastro ?intestinal|diabetic|obesity management|recovery|convalescence|hypoallergenic|hipoalerg[eê]nic|satiety)\b/i;

export function isVeterinaryMedicine(item: Pick<CatalogItem, "name" | "category">): boolean {
  const haystack = `${item.name ?? ""} ${item.category ?? ""}`;
  return (
    VET_MEDICINE_BRAND_RE.test(haystack) ||
    VET_MEDICINE_TERM_RE.test(haystack) ||
    VET_PRESCRIPTION_DIET_RE.test(haystack) ||
    DOSAGE_NOTATION_RE.test(haystack)
  );
}

/** Remove medicamento veterinário e dieta de prescrição de uma vitrine de pet. */
export function withoutVeterinaryMedicine(items: CatalogItem[]): CatalogItem[] {
  return items.filter((item) => !isVeterinaryMedicine(item));
}

// ---------------------------------------------------------------------------
// Remédio isento (29/09): a ÚNICA porta de entrada de medicamento numa vitrine. Só passa item
// marcado `medicine: "mip"` (veio da prateleira de isentos da farmácia) e que não bate com a
// guarda de prescrição por nome — mesmo que uma recolheita traga um item de receita, ele
// não chega ao cliente. Servido só com LIA_MEDICINE_MIP=true (conectores das farmácias).
export function mipOnly(items: CatalogItem[]): CatalogItem[] {
  return items.filter((item) => item.medicine === "mip" && !isPrescriptionText(`${item.name ?? ""} ${item.category ?? ""}`));
}
