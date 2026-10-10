// "X ou Y" = UM item com alternativa (09/10, rodada 3): "um brinquedo da ri happy pra menino de 5 anos, lego ou carrinho"
// virava 2 itens e "Ri Happy" entrava na busca. Puro, sem DB.
import { normalizeMsg, productHead } from "@/lib/lia-intents";
import { localCatalogProbe } from "@/lib/stores/list-probe";

export type AltItem = { base: string; alternatives: [string, string] };

// Atributos/variações ("preto ou branco", "10kg ou 15kg", "zero ou normal") continuam sendo busca normal do mesmo item.
const ATTRIBUTE_WORDS = new Set([
  "preto", "preta", "branco", "branca", "azul", "verde", "vermelho", "vermelha", "rosa", "amarelo", "amarela", "cinza", "marrom", "roxo", "roxa", "laranja", "dourado", "prata",
  "pp", "p", "m", "g", "gg", "grande", "pequeno", "pequena", "medio", "media", "zero", "normal", "light", "diet", "integral", "desnatado", "quente", "gelado", "gelada",
  "pix", "cartao", "hoje", "amanha", "barato", "barata", "caro", "cara", "novo", "nova", "velho", "usado", "outro", "outra", "qualquer"
]);
const FILLER = /^(?:(?:um|uma|uns|umas|o|a|os|as|de|do|da)\s+)+/;
const WORD = "[a-z][a-z-]*";
const ALT_PHRASE = `(?:(?:um|uma)\\s+)?${WORD}(?:\\s+${WORD})?`;
const ALT_TAIL_RE = new RegExp(`(${ALT_PHRASE})\\s+ou\\s+(${ALT_PHRASE})\\s*[?!.]*$`);

function cleanAlt(raw: string): string {
  return raw.replace(/^(?:(?:quero|queria|preciso(?: de)?|precisava(?: de)?|me ve|manda|compra)\s+)+/, "").replace(FILLER, "").replace(/[?!.]+$/g, "").trim();
}

function isProductAlt(alt: string): boolean {
  if (!alt || /\d/.test(alt)) return false;
  const words = alt.split(/\s+/);
  if (words.length > 3) return false;
  return !words.every((w) => ATTRIBUTE_WORDS.has(w));
}

// Menção de loja ("da ri happy") não é termo de busca do produto.
export function stripStoreWords(text: string, storeNames: string[]): string {
  let out = text;
  for (const name of storeNames) {
    const body = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`\\b(?:(?:da|na|no|do|de|em|pela|pelo)\\s+)?${body}\\b`, "gi"), " ");
  }
  return out.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

export function detectAlternativeItem(text: string, storeNames: string[] = []): AltItem | null {
  const raw = stripStoreWords(normalizeMsg(text), storeNames.map((n) => normalizeMsg(n))).replace(/\s+/g, " ").trim();
  const m = ALT_TAIL_RE.exec(raw);
  if (!m) return null;
  const head = raw.slice(0, m.index);
  if (/\bou\b/.test(head)) return null;
  const a = cleanAlt(m[1]);
  const b = cleanAlt(m[2]);
  if (!isProductAlt(a) || !isProductAlt(b) || a === b) return null;
  // Só vale quando o "X ou Y" abre a mensagem ou vem depois de vírgula/pedido: senão X é continuação do item
  // ("tênis preto ou branco", "ração gato castrado ou filhote").
  const trimmed = head.trimEnd();
  const afterComma = /[,;:]$/.test(trimmed);
  let base = trimmed.replace(/[\s,;:]+$/g, "");
  base = base.replace(/^(?:(?:oi|ola)\b[\s,]*)?(?:bom dia|boa tarde|boa noite)?[\s,]*/, "");
  const askVerb = /^(?:quero|queria|preciso(?: de)?|precisava(?: de)?|me ve|manda|compra|busca|procura|tem)(?:\s+(?:um|uma))?$/;
  if (askVerb.test(base)) base = "";
  if (base && !afterComma) return null;
  // Base com 2+ itens ("fralda, pilha, lego ou carrinho") não é uma alternativa isolada: a lista decide.
  if (base.split(",").filter((p) => p.trim()).length >= 2) return null;
  base = base.replace(/^(?:(?:quero|queria|preciso(?: de)?|precisava(?: de)?|me ve|manda|compra)\s+)+(?:(?:um|uma)\s+)?/, "").trim();
  return { base, alternatives: [a, b] };
}

// Resposta à pergunta "Lego ou carrinho?": "1"/"2", "o primeiro", "carrinho", "os dois". null = não é resposta.
// "tanto faz" / "qualquer um" (10/10, rodada 12) = UM item com as duas buscas ("either"); "os dois" = os dois itens.
export function parseAltAnswer(text: string, alternatives: [string, string]): 0 | 1 | "both" | "either" | null {
  const n = normalizeMsg(text).replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (/^(?:os dois|as duas|ambos|ambas|os 2|as 2)$/.test(n)) return "both";
  if (/^(?:tanto faz|qualquer um|qualquer uma|qualquer|pode ser qualquer um|pode ser qualquer uma|tanto faz qual|voce escolhe|vc escolhe)$/.test(n)) return "either";
  if (/^(?:(?:o|a|opcao|numero|n)\s+)?(?:1|um|uma|primeir[oa])$/.test(n)) return 0;
  if (/^(?:(?:o|a|opcao|numero|n)\s+)?(?:2|segund[oa])$/.test(n)) return 1;
  const ans = n.replace(/^(?:(?:o|a|os|as|um|uma|de|do|da|quero|prefiro|pode ser|vai de|vou de|fico com)\s+)+/, "").trim();
  if (!ans) return null;
  const [a, b] = alternatives.map((alt) => normalizeMsg(alt));
  const hit = (alt: string) => ans === alt || (ans.length >= 3 && alt.includes(ans)) || alt.split(" ").some((w) => w.length >= 4 && ans.split(" ").includes(w));
  const ha = hit(a);
  const hb = hit(b);
  if (ha && !hb) return 0;
  if (hb && !ha) return 1;
  return null;
}


// ---------- "X ou Y" = UM item com duas buscas (10/10, rodada 12 g35) ----------
// "tem algo de carrinho ou lego pra 5 anos?" virava 2 itens (Hot Wheels + Lego na cesta) e o cliente queria UM brinquedo.
// Atributo/variação ("preto ou branco", "10kg ou 15kg", "ração castrado ou filhote") continua sendo o mesmo produto.
const ALT_FILLER_RE = /^(?:(?:tem|tem algo|algo|alguma coisa|quero|queria|preciso|precisava|me mostra|mostra|pode ser|tanto faz|me ve|um|uma|de|do|da|tipo|algum|alguma|o|a)\s+)+/;
const ALT_MODIFIER = new Set([
  ...ATTRIBUTE_WORDS,
  "filhote", "filhotes", "adulto", "adulta", "adultos", "castrado", "castrada", "senior", "infantil", "masculino", "feminino", "original", "tradicional",
  "nao", "sim", "mais", "menos", "isso", "esse", "essa", "algo", "coisa", "tanto", "hoje", "amanha", "agora", "depois"
]);
const ALT_TAIL_START = /^(?:pra|para|pro|de|com|sem|ate|\d)/;

// As duas buscas de um trecho "X ou Y" (sem vírgula): a cauda dita depois do 2º produto ("pra 5 anos", "até 80 reais") vale
// para os dois. null = não é alternativa de produto.
export function splitAlternativeLine(phrase: string): [string, string] | null {
  const n = normalizeMsg(phrase).replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim();
  if (/[,;]/.test(n)) return null;
  const parts = n.split(/\s+ou\s+/);
  if (parts.length !== 2) return null;
  // "feijão e coca ou guaraná": a alternativa é só "coca ou guaraná".
  const left = (parts[0].split(/\s+e\s+/).pop() ?? "").replace(ALT_FILLER_RE, "").trim();
  const right = parts[1].replace(/^(?:(?:um|uma|o|a|de|do|da)\s+)+/, "").trim();
  const lw = left.split(" ");
  const rw = right.split(" ");
  if (!left || !right || lw.length > 4 || rw.length > 6 || ALT_MODIFIER.has(rw[0]) || ALT_MODIFIER.has(lw[lw.length - 1]) || /^\d/.test(rw[0])) return null;
  const tailAt = rw.findIndex((w, k) => k > 0 && ALT_TAIL_START.test(w));
  const tail = tailAt > 0 ? rw.slice(tailAt).join(" ") : "";
  const a = tail && !left.endsWith(tail) ? `${left} ${tail}` : left;
  if (productHead(a) && productHead(a) === productHead(right)) return null;
  // As duas pontas são produto de verdade no catálogo (a palavra principal de cada uma).
  if (!localCatalogProbe(lw[0]).strong || !localCatalogProbe(rw[0]).strong) return null;
  return [a, right];
}

// "carrinho para 5 anos" + "lego para 5 anos" → "carrinho ou lego para 5 anos" (a cauda comum sai uma vez).
export function alternativeLabel(a: string, b: string): string {
  const wa = a.trim().split(/\s+/);
  const wb = b.trim().split(/\s+/);
  let tail = 0;
  while (tail < Math.min(wa.length, wb.length) - 1 && normalizeMsg(wa[wa.length - 1 - tail]) === normalizeMsg(wb[wb.length - 1 - tail])) tail++;
  const common = tail ? ` ${wa.slice(wa.length - tail).join(" ")}` : "";
  return `${wa.slice(0, wa.length - tail).join(" ")} ou ${wb.slice(0, wb.length - tail).join(" ")}${common}`;
}

// Duas linhas (da IA) que são as duas pontas de um "X ou Y" da mensagem viram UM item: `set` recebe a 1ª linha, o rótulo
// junto e as duas buscas. Linhas que não são pontas de alternativa ficam como estão.
export function foldAlternativeLines<T>(lines: T[], text: string, get: (line: T) => string, set: (line: T, label: string, queries: [string, string]) => T): T[] {
  if (lines.length < 2 || !/\bou\b/i.test(text)) return lines;
  let out = [...lines];
  for (const segment of normalizeMsg(text).split(/[,;.?!\n]+/)) {
    const sides = /\bou\b/.test(segment) ? splitAlternativeLine(segment) : null;
    if (!sides) continue;
    const owns = (line: T, side: string) => productHead(get(line)) === productHead(side);
    const i = out.findIndex((l) => owns(l, sides[0]));
    const j = out.findIndex((l, k) => k !== i && owns(l, sides[1]));
    if (i < 0 || j < 0) continue;
    const merged = set(out[i], alternativeLabel(get(out[i]), get(out[j])), [get(out[i]), get(out[j])]);
    out = out.map((l, k) => (k === i ? merged : l)).filter((_, k) => k !== j);
  }
  return out;
}
