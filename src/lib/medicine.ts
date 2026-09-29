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
  /\b(amoxicilina|clavulanato|azitromicina|cefalexina|cefuroxima|ceftriaxona|cefadroxila|ciprofloxacino|levofloxacino|norfloxacino|claritromicina|eritromicina|doxiciclina|minociclina|tetraciclina|sulfametoxazol|trimetoprima|nitrofuranto[ií]na|fosfomicina|penicilina|benzilpenicilina|benzetacil|metronidazol|secnidazol|tinidazol|fluconazol|itraconazol|oseltamivir|valaciclovir|sertralina|fluoxetina|escitalopram|citalopram|paroxetina|venlafaxina|desvenlafaxina|duloxetina|amitriptilina|nortriptilina|bupropiona|trazodona|mirtazapina|clonazepam|alprazolam|diazepam|lorazepam|bromazepam|midazolam|zolpidem|quetiapina|risperidona|olanzapina|aripiprazol|haloperidol|carbonato de l[ií]tio|carbamazepina|oxcarbazepina|fenito[ií]na|fenobarbital|valproato|[aá]cido valpr[oó]ico|topiramato|lamotrigina|pregabalina|gabapentina|metilfenidato|lisdexanfetamina|modafinila|tramadol|code[ií]na|morfina|oxicodona|tapentadol|metadona|sibutramina|orlistate?|semaglutida|tirzepatida|liraglutida|dulaglutida|insulina|metformina|glibenclamida|gliclazida|glimepirida|dapagliflozina|empagliflozina|sitagliptina|vildagliptina|losartana|valsartana|olmesartana|enalapril|captopril|ramipril|anlodipino|nifedipino|atenolol|propranolol|metoprolol|carvedilol|hidroclorotiazida|clortalidona|furosemida|espironolactona|sinvastatina|atorvastatina|rosuvastatina|pravastatina|ezetimiba|levotiroxina|prednisona|prednisolona|dexametasona|betametasona|metilprednisolona|deflazacorte|varfarina|clopidogrel|rivaroxabana|apixabana|dabigatrana|sildenafila|tadalafila|finasterida|dutasterida|isotretino[ií]na|tretino[ií]na|adapaleno|ivermectina|hidroxicloroquina|cloroquina|nimesulida|cetoprofeno|meloxicam|piroxicam|celecoxibe|etoricoxibe|ciclobenzaprina|domperidona|ondansetrona|misoprostol|levonorgestrel|drospirenona|etinilestradiol|desogestrel|gestodeno|estradiol|progesterona|testosterona|ciproterona)\b/i;

// Omeprazol/pantoprazol/esomeprazol: a dose baixa é isenta, a alta é de receita.
const PRESCRIPTION_DOSE_RE = /\b(omeprazol\s*(20|40)\s*mg|pantoprazol\s*40\s*mg|esomeprazol\s*(20|40)\s*mg)\b/i;

const PRESCRIPTION_BRAND_RE =
  /\b(ozempic|wegovy|mounjaro|saxenda|victoza|trulicity|rivotril|frontal|lexotan|apraz|ritalina|venvanse|concerta|viagra|cialis|roacutan|tramal|zoloft|prozac|lexapro|pristiq|wellbutrin|seroquel|zyprexa|depakote|tegretol|lyrica|neurontin|xarelto|eliquis|marevan|glifage|diamicron|jardiance|forxiga|januvia|galvus|puran t4|synthroid|meticorten|predsim|decadron|celestone|diane 35|yasmin|selene|tamisa|microvlar|ciclo 21|amoxil|clavulin|keflex|zitromax|flagyl)\b/i;

export function isPrescriptionText(text: string): boolean {
  const t = text ?? "";
  return PRESCRIPTION_WORDS_RE.test(t) || PRESCRIPTION_ACTIVE_RE.test(t) || PRESCRIPTION_DOSE_RE.test(t) || PRESCRIPTION_BRAND_RE.test(t);
}

// Pedido que a Lia recusa mesmo com MIP ligado: nomeia remédio de receita ou fala de
// receita/tarja/controlado. "dipirona", "dorflex", "antigripal" passam.
export function looksLikePrescriptionRequest(text: string): boolean {
  if (isPrescriptionText(text)) return true;
  return /\b(receita|receitu[aá]rio|prescri[cç][aã]o|tarja)\b/i.test(text ?? "");
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
