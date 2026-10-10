// Edição do pedido guardado ANTES do cadastro (10/10, rodada 8 A3/M6/M1). O pedido vive como texto em
// `ctx.pendingRequest` ("papel higiênico, desodorante em creme, sabonete") até o CEP chegar; cada mensagem nova só
// SOMAVA itens. Três jeitos reais de mudar de ideia viravam itens a mais:
//   - troca: "na verdade prefiro em creme" / "não, melhor aerosol" / "esquece, quero roll-on mesmo" — o item novo do
//     mesmo produto SUBSTITUI o anterior (antes: creme + aerosol + roll-on);
//   - manter só um do grupo: "só quero 1 desodorante, o roll-on. tira os outros dois" — fica o roll-on, saem os outros
//     desodorantes (antes: tirava o roll-on, mantinha o creme e "tira os outros dois" virava item);
//   - descartar o que acabou de dizer: "na verdade não são esses itens, ignora" — sai o que a mensagem anterior anotou.
// Puro e testado (tests/rodada8-g23-2026-10-10.test.ts).
import { meaningfulProductTokens, normalizeMsg } from "./lia-intents";

const tokensOf = (s: string) => meaningfulProductTokens(s);
const overlap = (a: string[], b: string[]) => a.filter((t) => b.includes(t)).length;

// "tira os outros (dois)", "remove o resto", "sem os demais", "só esse".
const DROP_OTHERS_RE = /\b(?:tira|tirar|remove|remova|exclui|apaga|cancela|sem|nao quero)\s+(?:(?:os|as|o|a)\s+)?(?:outr[oa]s?|demais|resto)(?:\s+(?:dois|duas|tres|\d))?\b/;
// "só quero 1 desodorante", "fica só o roll-on", "apenas o roll-on".
const ONLY_RE = /(?:^|[\s,.;!])(?:so|somente|apenas)\s+(?:quero\s+|vou querer\s+|preciso(?: de)?\s+|fica\s+|deixa\s+)?/;
const ONLY_PREFIX_RE = /\b(?:fica|deixa)\s+(?:so|somente|apenas)\b/;

// Pista de troca na fala: o item novo do mesmo produto substitui o anterior.
export const PENDING_REPLACE_CUE_RE =
  /(?:^|[\s,.;!])(?:na verdade|na vdd|em vez|ao inves|no lugar|mudei de ideia|pensando bem|melhor|prefiro|esquece|esqueci|troca\w*|substitu\w*)\b|^\s*(?:nao|n)\s*[,.!]|\b(?:quero|vou querer|prefiro)\s+(?:o |a )?[a-z0-9-]+(?:\s+[a-z0-9-]+)?\s+mesmo\b/;

// "ignora", "desconsidera", "não são esses itens", "esquece isso/tudo o que eu falei".
const DISCARD_LAST_RE = /\b(?:ignora|ignore|desconsidera|desconsidere)\b|\bnao (?:sao|era|eram|e) (?:ess[ea]s?|isso)(?: (?:itens|produtos|coisas))?\b|\besquece (?:isso|tudo|o que (?:eu )?(?:falei|disse|mandei|pedi))\b/;

export function discardsLastNote(said: string): boolean {
  return DISCARD_LAST_RE.test(normalizeMsg(said));
}

// "só quero 1 desodorante, o roll-on. tira os outros dois" → fica no grupo "desodorante" só o que casa com o resto da
// fala. Exige a palavra de exclusividade (só/apenas/tira os outros) E um grupo de 2+ itens do mesmo produto: com um
// item só, não há o que manter (e "só quero arroz" sozinho continua sendo outra coisa).
export function keepOnlyInGroup(segments: string[], said: string): { segments: string[]; kept: string; removed: string[] } | null {
  const n = normalizeMsg(said);
  const dropOthers = DROP_OTHERS_RE.test(n);
  if (!dropOthers && !ONLY_RE.test(n) && !ONLY_PREFIX_RE.test(n)) return null;
  const wanted = n
    .replace(DROP_OTHERS_RE, " ")
    .replace(/\b(?:so|somente|apenas|quero|vou querer|preciso|fica|deixa|de|um|uma|1|o|a|os|as|esse|essa|mesmo)\b/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wantedTokens = tokensOf(wanted);
  if (!wantedTokens.length) return null;
  const all = segments.map((seg, i) => ({ seg, i, t: tokensOf(seg) }));
  let group = all.filter((g) => g.t.length && overlap(g.t, wantedTokens) > 0);
  // "fica só o aerosol": a fala só tem o atributo — o grupo é o dos itens do MESMO produto do que casou.
  if (group.length === 1) group = all.filter((g) => g.t.length && overlap(g.t, group[0].t) > 0);
  if (group.length < 2) return null;
  // O que distingue um membro do grupo dos outros (o "roll-on", não o "desodorante" que todos têm).
  const common = group.reduce<string[]>((acc, g) => acc.filter((t) => g.t.includes(t)), group[0].t);
  const specific = wantedTokens.filter((t) => !common.includes(t));
  const best = [...group].sort((a, b) => overlap(b.t, specific) - overlap(a.t, specific) || overlap(b.t, wantedTokens) - overlap(a.t, wantedTokens) || b.i - a.i)[0];
  const fits = specific.length === 0 ? group.length === 1 : specific.every((t) => best.t.includes(t));
  // Nenhum membro tem o que ele pediu: o grupo vira o item dito ("desodorante roll-on").
  const kept = fits ? best.seg : wanted;
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const member = group.find((g) => g.i === i);
    if (!member) out.push(segments[i]);
    else if (member === best) out.push(kept);
    else removed.push(segments[i]);
  }
  if (!fits) removed.push(best.seg);
  return { segments: out, kept, removed };
}

// Troca por texto: com a pista de troca na fala, o item novo substitui o ÚLTIMO item do mesmo produto (mesma posição).
export function replaceInGroup(segments: string[], said: string, note: string): string[] | null {
  if (!PENDING_REPLACE_CUE_RE.test(normalizeMsg(said))) return null;
  const noteTokens = tokensOf(note);
  if (!noteTokens.length) return null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const t = tokensOf(segments[i]);
    if (!t.length || !overlap(t, noteTokens)) continue;
    // Mesmo item repetido (o subconjunto já é tratado por quem chama): nada a trocar.
    if (normalizeMsg(segments[i]) === normalizeMsg(note)) return null;
    const out = [...segments];
    out[i] = note;
    return out;
  }
  return null;
}
