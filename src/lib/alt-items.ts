// "X ou Y" = UM item com alternativa (09/10, rodada 3): "um brinquedo da ri happy pra menino de 5 anos, lego ou carrinho"
// virava 2 itens e "Ri Happy" entrava na busca. Puro, sem DB.
import { normalizeMsg } from "@/lib/lia-intents";

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
export function parseAltAnswer(text: string, alternatives: [string, string]): 0 | 1 | "both" | null {
  const n = normalizeMsg(text).replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (/^(?:os dois|as duas|ambos|ambas|os 2|as 2|tanto faz|qualquer um|qualquer uma)$/.test(n)) return "both";
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
