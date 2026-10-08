// Remédio isento de prescrição (MIP) comprado NO NOME DO CLIENTE (29/09/2026).
//
// Decisão do dono: a Lia pode trazer remédio sem receita, ficando tudo no WhatsApp, sem
// contrato com farmácia. O desenho que mantém a venda com a farmácia licenciada:
//   - o pedido na farmácia sai no CPF e no nome do cliente (a nota e a dispensação são dele);
//   - só entra item que a própria farmácia classifica como isento (catálogo MIP colhido por
//     scripts/harvest-mip-catalog.mts) e que não bate com a lista de prescrição abaixo;
//   - a vitrine de remédio é texto puro (a Meta proíbe catálogo/carrinho/pagamento nativo
//     para remédio) e a taxa da Lia aparece numa linha própria, sem markup no remédio.
// Análise jurídica e riscos: docs/remedio-intermediacao-legal-2026-09-29.md.
//
// TUDO atrás de LIA_MEDICINE_MIP=true. Desligado, nada muda: o catálogo MIP não é servido e
// a recusa de remédio continua exatamente como antes.
import { sha256Hex } from "./sha256";

export function medicineEnabled(): boolean {
  return process.env.LIA_MEDICINE_MIP === "true";
}

// Farmácias que vendem MIP pela Lia. Ambas fecham por API no servidor (VTEX).
export const MIP_STORE_KEYS: readonly string[] = ["drogariasp", "paguemenos"];

export function isMipItem(item: { medicine?: string } | null | undefined): boolean {
  return item?.medicine === "mip";
}

export function hasMip(items: ReadonlyArray<{ medicine?: string } | null | undefined> | null | undefined): boolean {
  return Array.isArray(items) && items.some(isMipItem);
}

// ---------------------------------------------------------------------------
// Prescrição: SEMPRE fora, com ou sem a flag. É uma guarda independente da classificação
// da farmácia (a colheita e o runtime passam por ela): se a loja errar a prateleira, o nome
// ainda barra. Só entra aqui o que é inequivocamente de receita no Brasil.

const PRESCRIPTION_WORDS_RE =
  /\b(antibi[oó]tic[oa]s?|tarja (?:preta|vermelha)|controlad[oa]s?|reten[cç][aã]o de receita|sob prescri[cç][aã]o|injet[aá]ve(?:l|is)|ampolas?|anticoncepciona(?:l|is)|contraceptiv[oa]s?|psicotr[oó]pic[oa]s?|antidepressiv[oa]s?|ansiol[ií]tic[oa]s?)\b/i;

const PRESCRIPTION_ACTIVE_RE =
  /\b(omeprazol|pantoprazol|esomeprazol|lansoprazol|dexlansoprazol|rabeprazol|amoxicilina|clavulanato|azitromicina|cefalexina|cefuroxima|ceftriaxona|cefadroxila|ciprofloxacino|levofloxacino|norfloxacino|claritromicina|eritromicina|doxiciclina|minociclina|tetraciclina|sulfametoxazol|trimetoprima|nitrofuranto[ií]na|fosfomicina|penicilina|benzilpenicilina|benzetacil|metronidazol|secnidazol|tinidazol|fluconazol|itraconazol|oseltamivir|valaciclovir|sertralina|fluoxetina|escitalopram|citalopram|paroxetina|venlafaxina|desvenlafaxina|duloxetina|amitriptilina|nortriptilina|bupropiona|trazodona|mirtazapina|clonazepam|alprazolam|diazepam|lorazepam|bromazepam|midazolam|zolpidem|quetiapina|risperidona|olanzapina|aripiprazol|haloperidol|carbonato de l[ií]tio|carbamazepina|oxcarbazepina|fenito[ií]na|fenobarbital|valproato|[aá]cido valpr[oó]ico|topiramato|lamotrigina|pregabalina|gabapentina|metilfenidato|lisdexanfetamina|modafinila|tramadol|code[ií]na|morfina|oxicodona|tapentadol|metadona|sibutramina|orlistate?|semaglutida|tirzepatida|liraglutida|dulaglutida|insulina|metformina|glibenclamida|gliclazida|glimepirida|dapagliflozina|empagliflozina|sitagliptina|vildagliptina|losartana|valsartana|olmesartana|enalapril|captopril|ramipril|anlodipino|nifedipino|atenolol|propranolol|metoprolol|carvedilol|hidroclorotiazida|clortalidona|furosemida|espironolactona|sinvastatina|atorvastatina|rosuvastatina|pravastatina|ezetimiba|levotiroxina|prednisona|prednisolona|dexametasona|betametasona|metilprednisolona|deflazacorte|varfarina|clopidogrel|rivaroxabana|apixabana|dabigatrana|sildenafila|tadalafila|finasterida|dutasterida|isotretino[ií]na|tretino[ií]na|adapaleno|ivermectina|hidroxicloroquina|cloroquina|nimesulida|cetoprofeno|meloxicam|piroxicam|celecoxibe|etoricoxibe|ciclobenzaprina|domperidona|ondansetrona|misoprostol|levonorgestrel|drospirenona|etinilestradiol|desogestrel|gestodeno|estradiol|progesterona|testosterona|ciproterona)\b/i;

// Inibidores de bomba de prótons (omeprazol, pantoprazol, esomeprazol, lansoprazol, rabeprazol): a
// Drogaria SP marca TODOS como "Tarja Vermelha", inclusive omeprazol 10 mg com 14 cápsulas (consulta de
// 08/10: 20/20 omeprazol, 30/30 pantoprazol, 27/27 esomeprazol, 16/16 lansoprazol). Como a Lia só vende o
// que a farmácia classifica como isento, a classe inteira é de receita — e a recusa NOMEIA o remédio.
// A regra de dose abaixo fica como rede extra (versão antiga achava que a dose baixa era isenta).
const PRESCRIPTION_DOSE_RE = /\b(omeprazol\s*(20|40)\s*mg|pantoprazol\s*40\s*mg|esomeprazol\s*(20|40)\s*mg)\b/i;

const PRESCRIPTION_BRAND_RE =
  /\b(ozempic|wegovy|mounjaro|saxenda|victoza|trulicity|rivotril|frontal|lexotan|apraz|ritalina|venvanse|concerta|viagra|cialis|roacutan|tramal|zoloft|prozac|lexapro|pristiq|wellbutrin|seroquel|zyprexa|depakote|tegretol|lyrica|neurontin|xarelto|eliquis|marevan|glifage|diamicron|jardiance|forxiga|januvia|galvus|puran t4|synthroid|euthyrox|levoid|meticorten|predsim|decadron|celestone|diane 35|yasmin|selene|tamisa|microvlar|ciclo 21|amoxil|clavulin|keflex|zitromax|flagyl)\b/i;

// Marcas que também são palavra comum ("frontal", "selene"): só barram por aqui quando a flag do
// remédio isento está ligada e o pedido inteiro é examinado — nunca para recusar sozinhas.
const AMBIGUOUS_BRANDS = new Set(["frontal", "selene", "concerta", "apraz", "diane 35", "ciclo 21"]);

// Nome de remédio de receita pelo princípio ativo, dose ou marca (07/10, c08): vale com a flag do
// remédio isento DESLIGADA, quando "Euthyrox 50mg" precisa ser barrado ainda no primeiro pedido.
// Mais estreita que `isPrescriptionText`: sem "ampola"/"injetável" (ampola capilar é cosmético) e
// sem as marcas ambíguas.
export function isPrescriptionDrugName(text: string): boolean {
  const t = text ?? "";
  if (PRESCRIPTION_ACTIVE_RE.test(t) || PRESCRIPTION_DOSE_RE.test(t)) return true;
  const brand = t.match(PRESCRIPTION_BRAND_RE);
  return Boolean(brand) && !AMBIGUOUS_BRANDS.has(brand![0].toLowerCase());
}

export function isPrescriptionText(text: string): boolean {
  const t = text ?? "";
  return PRESCRIPTION_WORDS_RE.test(t) || PRESCRIPTION_ACTIVE_RE.test(t) || PRESCRIPTION_DOSE_RE.test(t) || PRESCRIPTION_BRAND_RE.test(t);
}

// Pedido com cara de remédio pelo nome e dose ("Euthyrox 50mg", "losartana 50 mg 30
// comprimidos") — 06/10: quando nada é achado, a Lia explica que remédio de receita ela não
// compra, em vez de "me diz outra marca", e não gasta uma segunda busca pela IA.
export function looksLikeMedicineName(text: string): boolean {
  const t = text ?? "";
  return /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ui)\b/i.test(t) || /\b(?:comprimidos?|c[aá]psulas?|dr[aá]geas?)\b/i.test(t);
}

// Pedido que a Lia recusa mesmo com MIP ligado: nomeia remédio de receita ou fala de
// receita/tarja/controlado. "dipirona", "dorflex", "antigripal" passam.
export function looksLikePrescriptionRequest(text: string): boolean {
  const t = text ?? "";
  if (/\b(receita|receitu[aá]rio|prescri[cç][aã]o|tarja)\b/i.test(t)) return true;
  if (PRESCRIPTION_WORDS_RE.test(t) || PRESCRIPTION_ACTIVE_RE.test(t) || PRESCRIPTION_DOSE_RE.test(t)) return true;
  const brand = t.match(PRESCRIPTION_BRAND_RE);
  if (!brand) return false;
  // Marca ambígua ("frontal", "selene") só é remédio com contexto de remédio: dose, forma ou a
  // palavra remédio. "lanterna frontal e pilha" não é pedido de receita (revisão 08/10).
  if (!AMBIGUOUS_BRANDS.has(brand[0].toLowerCase())) return true;
  return looksLikeMedicineName(t) || /\b(rem[eé]dios?|medicamentos?|farm[aá]cia|caixa|comprimidos?|gotas)\b/i.test(t);
}

// ---------------------------------------------------------------------------
// Taxa da Lia em pedido com remédio: linha própria, remédio sem markup.

export function medicineServiceFee(): number {
  const raw = Number(String(process.env.LIA_MEDICINE_SERVICE_FEE ?? "4.90").replace(",", "."));
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) / 100 : 4.9;
}

// ---------------------------------------------------------------------------
// CPF do comprador.

export function onlyDigits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

const CPF_CANDIDATE_RE = /\d[\d.\s-]{9,16}\d/g;

// Primeiro CPF VÁLIDO no texto: "123.456.789-09", "12345678909", "123 456 789 09".
export function extractCpf(text: string): string | null {
  for (const candidate of (text ?? "").match(CPF_CANDIDATE_RE) ?? []) {
    const digits = onlyDigits(candidate);
    if (digits.length === 11 && isValidCpf(digits)) return digits;
  }
  return null;
}

// Mensagem com cara de CPF (11 dígitos), válido ou não — para responder "CPF inválido" em
// vez de tratar como outra coisa.
export function looksLikeCpfAttempt(text: string): boolean {
  return ((text ?? "").match(CPF_CANDIDATE_RE) ?? []).some((c) => onlyDigits(c).length === 11);
}

const NAME_STOPWORDS = /^(cpf|nome|completo|meu|minha|sou|eu|o|a|é|e|aqui|segue|ta|tá|está|esta|ok|pronto)$/i;
const NAME_PARTICLES = /^(da|de|do|dos|das)$/i;

// Nome completo junto do CPF ("Maria da Silva 123.456.789-09"): o que sobra, sem número.
// Precisa de nome E sobrenome — a nota fiscal sai nesse nome.
export function extractFullName(text: string): string | null {
  const words = (text ?? "")
    .replace(CPF_CANDIDATE_RE, " ")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NAME_STOPWORDS.test(w));
  const real = words.filter((w) => !NAME_PARTICLES.test(w));
  if (real.length < 2 || real.length > 8 || real.some((w) => w.length < 2)) return null;
  const name = words
    .map((w) => (NAME_PARTICLES.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  return name.length >= 5 && name.length <= 120 ? name : null;
}

export function maskCpf(cpf: string): string {
  const d = onlyDigits(cpf);
  return d.length === 11 ? `***.***.${d.slice(6, 9)}-${d.slice(9)}` : "***";
}

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

// E-mail do perfil VTEX para compra no CPF do cliente. A VTEX guarda perfil por e-mail: o
// e-mail padrão da Lia já tem o CNPJ salvo e, sem login, a loja devolveria o perfil
// mascarado e fecharia no CNPJ. Um apelido por CPF ("contato+c1a2b3…@…") dá a cada cliente
// um perfil próprio e continua caindo na mesma caixa (subendereçamento com "+").
// O vtex-checkout ainda confere o documento devolvido e aborta se não for o CPF.
export function medicineBuyerEmail(baseEmail: string, cpf: string): string {
  const tag = `c${sha256Hex(onlyDigits(cpf)).slice(0, 10)}`;
  const template = process.env.LIA_MEDICINE_BUYER_EMAIL_TEMPLATE?.trim();
  if (template && template.includes("{tag}")) return template.replace("{tag}", tag);
  const [local, domain] = baseEmail.trim().split("@");
  if (!local || !domain) throw new Error("E-mail base da conta da loja inválido para o apelido do CPF.");
  return `${local.split("+")[0]}+${tag}@${domain}`;
}

// Conferência do comprador (purchase-execution): o checkout precisa estar na conta
// operacional da loja. Com compra no CPF do cliente, o e-mail do checkout é o apelido
// derivado DAQUELE CPF — qualquer outro continua recusado.
export function matchesOperationalEmail(accountEmail: string | null | undefined, checkoutEmail: string, buyerDocument?: string | null): boolean {
  const account = (accountEmail ?? "").trim().toLowerCase();
  const checkout = (checkoutEmail ?? "").trim().toLowerCase();
  if (!account || !checkout) return false;
  if (account === checkout) return true;
  if (!buyerDocument) return false;
  try {
    return medicineBuyerEmail(account, buyerDocument).toLowerCase() === checkout;
  } catch {
    return false;
  }
}

// Código de barras de verdade (GTIN com dígito verificador). Kit na Pague Menos vem com
// "123456789101112": nunca pode casar com nada.
export function isValidGtin(value: string | undefined | null): boolean {
  const d = onlyDigits(value ?? "");
  if (![8, 12, 13, 14].includes(d.length) || /^(\d)\1+$/.test(d)) return false;
  const body = d.slice(0, -1).split("").reverse();
  const sum = body.reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}

// ---------------------------------------------------------------------------
// Pedido do dono (08/10/2026), três comportamentos de remédio:
//  1. remédio de RECEITA: dizer QUAL item não dá e por quê ("Rivotril precisa de receita");
//  2. marca pedida "seca" ("tylenol"): a apresentação BÁSICA da marca vem antes das extensões
//     de linha (Tylenol Sinus/DC/Bebê, Advil 12h/Mulher, Dorflex DIP/Max, Buscopan Composto…);
//  3. marca sem estoque / só o genérico: oferecer o equivalente de mesmo princípio ativo como
//     "o mais perto que tenho", nunca como se fosse o pedido (o cliente escolhe).

const normMed = (s: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+\s]/g, " ").replace(/\s+/g, " ").trim();

// Qual nome de remédio de receita apareceu no texto (princípio ativo, dose de receita ou marca),
// para a recusa nomear o item. Null quando o texto só fala de "receita"/"tarja" sem nomear.
export function prescriptionDrugNameIn(text: string): string | null {
  const t = text ?? "";
  const m = t.match(PRESCRIPTION_ACTIVE_RE) ?? t.match(PRESCRIPTION_DOSE_RE);
  if (m) return m[0];
  const brand = t.match(PRESCRIPTION_BRAND_RE);
  if (brand && !AMBIGUOUS_BRANDS.has(brand[0].toLowerCase())) return brand[0];
  return null;
}

// Palavras que, logo depois (ou antes) da marca no nome do produto, marcam uma EXTENSÃO DE LINHA:
// outro produto da mesma marca (Tylenol Sinus é descongestionante; Dorflex DIP é dipirona pura).
// Dose, contagem e forma farmacêutica não são extensão ("Tylenol 750mg 20 Comprimidos" é o básico).
// Sal, qualificador neutro e o próprio princípio ativo também não são extensão ("Dipirona Sódica",
// "Tylenol Paracetamol 750mg", "Buscopan Simples", "Engov Original"). "+", "com" e "e" NÃO são
// neutros: anunciam combinação (Paracetamol + Cafeína), que é outro produto.
const DOSE_OR_FORM_RE = /^(\d+([.,]\d+)?(mg|mcg|g|ml|ui|%)?(\/ml|\/g)?|\d+|mg|mcg|ml|g|ui|comprimidos?|capsulas?|drageas?|gotas|xarope|solucao|suspensao|pomada|creme|gel|spray|sache|saches|flaconetes?|revestid[oa]s?|efervescentes?|mastigave(l|is)|liquidas?|moles|adulto|unidades?|un|de|da|do|x|oral|sabor|generico|sodica|sodico|monoidratada|monoidratado|potassica|potassico|cloridrato|dicloridrato|bromidrato|simples|original|classico|classica|tradicional|paracetamol|dipirona|ibuprofeno|loratadina|desloratadina|fexofenadina|simeticona|acido|acetilsalicilico|butilbrometo|escopolamina)$/;
const AUDIENCE_EXTENSION_RE = /^(infantil|pediatrico|baby|bebe|kids|junior)$/;

export function isMedicineLineExtension(query: string, name: string): boolean {
  const q = normMed(query).split(" ").filter(Boolean);
  const words = normMed(name).split(" ").filter(Boolean);
  const brandIdx = words.findIndex((w) => w.length >= 4 && q.some((t) => t === w || (t.length >= 4 && (w.startsWith(t) || t.startsWith(w)))));
  if (brandIdx < 0) return false;
  const asked = new Set(q);
  const before = words[brandIdx - 1];
  if (before && AUDIENCE_EXTENSION_RE.test(before) && !asked.has(before)) return true;
  const after = words[brandIdx + 1];
  if (!after || asked.has(after)) return false;
  // Combinação declarada logo depois do nome ("Paracetamol + Cafeína", "Dipirona com Cafeína") é outro produto.
  if (after === "+" || after === "com" || after === "mais") return true;
  if (DOSE_OR_FORM_RE.test(after)) return false;
  return /^[a-z][a-z0-9]*$/.test(after) || /^\d+h$/.test(after);
}

// Apresentação básica da marca primeiro; havendo o básico, no máximo UMA extensão de linha, no fim (dono,
// 08/10: "primeiro o Tylenol normal e outra opção, o PM" — uma opção, não três Composto). Sem básico, a
// ordem fica como veio.
export function baseFormulationFirst<T extends { name: string }>(query: string, options: T[]): T[] {
  const base = options.filter((o) => !isMedicineLineExtension(query, o.name));
  if (!base.length || base.length === options.length) return options;
  return [...base, ...options.filter((o) => isMedicineLineExtension(query, o.name)).slice(0, 1)];
}

// Equivalentes de mesmo princípio ativo (só isentos que existem nas farmácias da Lia).
// Marca ↔ genérico; nunca "parecido": é a mesma substância.
export const MEDICINE_EQUIVALENTS: ReadonlyArray<{ brands: readonly string[]; active: string; label: string }> = [
  { brands: ["tylenol"], active: "paracetamol", label: "Tylenol" },
  { brands: ["advil", "alivium"], active: "ibuprofeno", label: "Advil" },
  { brands: ["novalgina", "anador", "magnopyrol"], active: "dipirona", label: "Novalgina" },
  { brands: ["allegra"], active: "fexofenadina", label: "Allegra" },
  { brands: ["claritin", "loratamed"], active: "loratadina", label: "Claritin" },
  { brands: ["desalex"], active: "desloratadina", label: "Desalex" },
  { brands: ["luftal"], active: "simeticona", label: "Luftal" },
  { brands: ["aspirina"], active: "acido acetilsalicilico", label: "Aspirina" }
];

export type MedicineEquivalent = { queries: string[]; falta: string; faltaFor: (name: string) => string; matches: (name: string) => boolean };

// Público/forma pedidos têm que estar no equivalente: "tylenol bebê" nunca vira Paracetamol 750mg
// (risco de dose). Marcadores: bebê/infantil/pediátrico/kids/gotas/xarope.
const AUDIENCE_OR_FORM_RE = /^(bebe|infantil|pediatrico|pediatrica|kids|junior|crianca|gotas|xarope)$/;
const hasWord = (haystack: string, word: string) => new RegExp(`\\b${word}\\b`).test(haystack);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "tylenol 750mg" → busca também "paracetamol 750mg", apresentado como "é o genérico (paracetamol)";
// "paracetamol" → busca também "tylenol", apresentado como "é o Tylenol (mesmo paracetamol)".
// Só a MESMA substância: princípio ativo por palavra inteira (desloratadina ≠ loratadina,
// dexibuprofeno ≠ ibuprofeno) e nunca combinação ("Paracetamol + Cafeína", "… com …").
export function medicineEquivalentFor(query: string): MedicineEquivalent | null {
  const norm = normMed(query);
  const tokens = norm.split(" ").filter(Boolean);
  const audience = tokens.filter((t) => AUDIENCE_OR_FORM_RE.test(t));
  const audienceOk = (name: string) => !audience.length || audience.some((a) => hasWord(name, a) || (a === "bebe" && hasWord(name, "infantil")) || (a === "infantil" && hasWord(name, "bebe")) || (a === "crianca" && (hasWord(name, "infantil") || hasWord(name, "pediatrico"))));
  const combo = (name: string) => /\+/.test(name) || /\b(com|mais)\b/.test(name);
  for (const eq of MEDICINE_EQUIVALENTS) {
    const activeWords = eq.active.split(" ");
    const sameActive = (name: string) => activeWords.every((w) => hasWord(name, w));
    const brand = eq.brands.find((b) => tokens.includes(b));
    if (brand) {
      const generic = norm.replace(new RegExp(`\\b${brand}\\b`), eq.active).replace(/\s+/g, " ").trim();
      const falta = `é o genérico (${eq.active})`;
      return {
        queries: [generic],
        falta,
        faltaFor: () => falta,
        matches: (raw) => { const name = normMed(raw); return sameActive(name) && !combo(name) && !eq.brands.some((b) => hasWord(name, b)) && audienceOk(name); }
      };
    }
    if (activeWords.every((t) => tokens.includes(t))) {
      const rest = tokens.filter((t) => !activeWords.includes(t)).join(" ");
      const brandIn = (name: string) => eq.brands.find((b) => hasWord(name, b));
      return {
        queries: eq.brands.map((b) => `${b} ${rest}`.trim()),
        falta: `é o ${eq.label} (mesmo ${eq.active})`,
        faltaFor: (raw) => `é o ${cap(brandIn(normMed(raw)) ?? eq.label.toLowerCase())} (mesmo ${eq.active})`,
        matches: (raw) => { const name = normMed(raw); return Boolean(brandIn(name)) && !combo(name) && audienceOk(name); }
      };
    }
  }
  return null;
}

// Nomes de remédio de receita por LINHA do pedido (dono, 08/10: a recusa nomeia cada um). Só nomes
// reconhecidos — frase sem nome de remédio não vira "*Lanterna frontal* precisa de receita".
export function prescriptionDrugNamesIn(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const name = prescriptionDrugNameIn(line);
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}
