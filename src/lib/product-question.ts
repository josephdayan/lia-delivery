// Pergunta sobre o PRODUTO com as opções na tela (09/10, rodada 2 do teste de WhatsApp): "essa ração serve pra
// filhote?", "é original?", "qual a validade?", "qual a diferença entre o 1 e o 2?", "não sei o que é o dois".
// Caía na FAQ de confiança/lojas. Aqui a pergunta é lida em código (sem IA) e respondida com o que a Lia SABE:
// nome, preço e loja das opções — e, onde o dado não existe, diz isso com honestidade. Puro e testável.
import { normalizeMsg } from "./lia-intents";

export type ProductOption = { name: string; price: number; storeLabel?: string };

export type AudienceTag = "filhote" | "adulto" | "senior" | "gato" | "cao" | "pequeno" | "grande";

export type ProductQuestion =
  | { kind: "audience"; tag: AudienceTag }
  | { kind: "compare"; a: number; b: number }
  | { kind: "explain"; n: number }
  | { kind: "original" }
  | { kind: "expiry" }
  | { kind: "dietary"; term: string };

const AUDIENCE_LABEL: Record<AudienceTag, string> = {
  filhote: "filhotes",
  adulto: "adultos",
  senior: "sêniores",
  gato: "gatos",
  cao: "cães",
  pequeno: "raças pequenas",
  grande: "raças grandes"
};

const AUDIENCE_NAME_RE: Record<AudienceTag, RegExp> = {
  filhote: /\b(filhotes?|puppy|puppies|junior|kitten|gatinhos?|cachorrinhos?)\b/,
  adulto: /\badult[oa]s?\b/,
  senior: /\b(seniors?|idos[oa]s?|mature)\b/,
  gato: /\b(gatos?|felinos?|cats?)\b/,
  cao: /\b(caes|cao|cachorros?|dogs?)\b/,
  pequeno: /\b(mini|pequen[oa]s?|small|toy)\b/,
  grande: /\b(grandes?|large|giants?|gigantes?|mega|maxi)\b/
};

// Como o cliente fala o público ("filhote", "cachorro", "gato").
const AUDIENCE_ASK: [AudienceTag, RegExp][] = [
  ["filhote", /\b(filhotes?|cachorrinhos?|gatinhos?|puppy|bebes?)\b/],
  ["senior", /\b(idos[oa]s?|seniors?|velhinh[oa]s?|mais velh[oa]s?)\b/],
  ["adulto", /\badult[oa]s?\b/],
  ["gato", /\b(gatos?|felinos?)\b/],
  ["cao", /\b(caes|cao|cachorros?|dogs?)\b/],
  ["pequeno", /\b(porte pequeno|racas? pequen[oa]s?|pequeno porte|mini)\b/],
  ["grande", /\b(porte grande|racas? grandes?|grande porte)\b/]
];

export function audienceTags(name: string): AudienceTag[] {
  const n = normalizeMsg(name);
  return (Object.keys(AUDIENCE_NAME_RE) as AudienceTag[]).filter((tag) => AUDIENCE_NAME_RE[tag].test(n));
}

const WORD_NUMBER: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5
};
const REF_RE = /\b(?:(?:o|a|os|as|do|da|dos|das|no|na|numero|opcao|n)\s+)?(\d{1,2}|dois|duas|tres|quatro|cinco|seis|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|ultim[oa]|um|uma)\b/g;

// Referências a opções na ordem em que aparecem. "um/uma" só contam com artigo antes ("o um"), senão é "uma ração".
function refsIn(n: string, count: number): number[] {
  const out: number[] = [];
  for (const m of n.matchAll(REF_RE)) {
    const token = m[1];
    const hasArticle = m[0] !== token;
    if ((token === "um" || token === "uma") && !hasArticle) continue;
    const value = /^\d+$/.test(token) ? Number(token) : /^ultim/.test(token) ? count : WORD_NUMBER[token];
    if (value && value >= 1 && value <= count && !out.includes(value)) out.push(value);
  }
  return out;
}

const QUESTION_START_RE = /^(e |eh |sera |sao |isso e |esse e |essa e |qual |quais |quando |tem |ate quando |da pra |pode |posso |serve |servem )/;

export function parseProductQuestion(text: string, optionCount: number): ProductQuestion | null {
  if (optionCount < 1) return null;
  const n = normalizeMsg(text).replace(/[!.?\s]+$/g, "").trim();
  if (!n || n.length > 120) return null;
  const isQuestion = /\?/.test(text) || QUESTION_START_RE.test(n);

  // "qual a diferença entre o 1 e o 2?": só quando as DUAS opções vêm nomeadas (sem elas, o comparativo geral já cobre).
  const diff = n.match(/\b(?:diferenca|diferencas|diferente|comparar|compara|comparacao)\b(.*)$/);
  if (diff) {
    const refs = refsIn(diff[1], optionCount);
    if (refs.length >= 2) return { kind: "compare", a: refs[0], b: refs[1] };
    return null;
  }

  // "não sei o que é o dois", "o que é o 2?", "como assim o 3"
  const explain = n.match(/\b(?:nao sei|nao entendi|nao entendo|o que (?:e|eh)|que (?:e|eh)|como assim|me explica|explica|qual (?:e|eh))\b(.*)$/);
  if (explain) {
    const refs = refsIn(explain[1], optionCount);
    if (refs.length === 1 && /\b(?:o|a|do|da|n|numero|opcao)?\s*(\d{1,2}|dois|duas|tres|quatro|cinco|seis|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|ultim[oa]|um|uma)\s*$/.test(explain[1])) {
      return { kind: "explain", n: refs[0] };
    }
  }

  if (!isQuestion) return null;

  if (/\b(validade|vencimento|vence|vencido|prazo de validade|data de fabricacao)\b/.test(n)) return { kind: "expiry" };
  if (/\b(original|originais|autentic[oa]s?|legitim[oa]s?|falsific\w+|pirata|paralel[oa])\b/.test(n)) return { kind: "original" };

  const dietary = n.match(/\b(?:sem|zero|livre de|isento de)\s+(lactose|gluten|acucar|corante|conservante)\b/);
  if (dietary) return { kind: "dietary", term: dietary[1] };

  // "essa ração serve pra filhote?", "é boa pra gato?", "pode dar pra cachorro idoso?"
  const serves = n.match(/\b(?:serve|servem|vale|pode|posso dar|da pra|e (?:boa|bom|ideal|indicad[oa]|segur[oa])|eh (?:boa|bom|ideal|indicad[oa]))\b.*\b(?:pra|para|p|pro|a)\s+(.*)$/);
  if (serves) {
    for (const [tag, re] of AUDIENCE_ASK) if (re.test(serves[1])) return { kind: "audience", tag };
  }
  return null;
}

const brl = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;
const where = (o: ProductOption) => (o.storeLabel ? ` · ${o.storeLabel}` : "");

// "cães adultos de raças grandes": espécie + fase + porte, na ordem que se fala.
function labelList(tags: AudienceTag[]): string {
  const species = tags.filter((t) => t === "cao" || t === "gato").map((t) => AUDIENCE_LABEL[t]);
  const stage = tags.filter((t) => t === "filhote" || t === "adulto" || t === "senior").map((t) => AUDIENCE_LABEL[t]);
  const size = tags.filter((t) => t === "pequeno" || t === "grande").map((t) => AUDIENCE_LABEL[t]);
  const head = [species.join(" e ") || (stage.length ? "pets" : ""), stage.join(" e ")].filter(Boolean).join(" ");
  return [head, size.length ? `de ${size.join(" e ")}` : ""].filter(Boolean).join(" ");
}

const STOP = new Set(["de", "da", "do", "das", "dos", "para", "com", "sem", "e", "em", "a", "o", "kg", "g", "ml", "l"]);
function words(name: string): { key: string; shown: string }[] {
  return name
    .split(/[\s,/()-]+/)
    .map((w) => ({ key: normalizeMsg(w), shown: w }))
    .filter((w) => w.key.length > 1 && !STOP.has(w.key));
}

function differences(a: string, b: string): { onlyA: string[]; onlyB: string[] } {
  const wa = words(a);
  const wb = words(b);
  const kb = new Set(wb.map((w) => w.key));
  const ka = new Set(wa.map((w) => w.key));
  return { onlyA: wa.filter((w) => !kb.has(w.key)).map((w) => w.shown), onlyB: wb.filter((w) => !ka.has(w.key)).map((w) => w.shown) };
}

export function answerProductQuestion(q: ProductQuestion, options: ProductOption[], query: string): string {
  switch (q.kind) {
    case "compare": {
      const a = options[q.a - 1];
      const b = options[q.b - 1];
      const d = differences(a.name, b.name);
      const lines = [`*${q.a}* — ${a.name} — ${brl(a.price)}${where(a)}`, `*${q.b}* — ${b.name} — ${brl(b.price)}${where(b)}`];
      const notes: string[] = [];
      if (d.onlyA.length || d.onlyB.length) {
        notes.push(`Pelo nome, o que muda: a *${q.a}* tem ${d.onlyA.slice(0, 6).join(" ") || "o mesmo"}; a *${q.b}* tem ${d.onlyB.slice(0, 6).join(" ") || "o mesmo"}.`);
      } else notes.push("Pelo nome são o mesmo produto.");
      const gap = Math.round(Math.abs(a.price - b.price) * 100) / 100;
      notes.push(gap ? `A *${a.price < b.price ? q.a : q.b}* sai ${brl(gap)} mais barata.` : "O preço é o mesmo.");
      notes.push("Detalhe técnico além do nome eu não tenho aqui. Qual você quer?");
      return ["O que eu sei comparar é nome, preço e loja:", ...lines, "", ...notes].join("\n");
    }
    case "explain": {
      const o = options[q.n - 1];
      const tags = audienceTags(o.name);
      return [
        `A opção *${q.n}* é *${o.name}* — ${brl(o.price)}${where(o)}.`,
        tags.length ? `Pelo nome, é para ${labelList(tags)}.` : "",
        `Quer essa? Responde *${q.n}*.`
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "original": {
      const stores = [...new Set(options.map((o) => o.storeLabel).filter(Boolean))] as string[];
      const loja = stores.length ? stores.map((s) => `*${s}*`).join(" e ") : "a própria loja";
      return `Sim: compro no site oficial, direto na loja (${loja}), que vende e entrega com nota fiscal da própria loja. Eu não compro de vendedor avulso.`;
    }
    case "expiry":
      return "A validade não aparece no cadastro da loja, então não consigo te dizer a data antes de comprar. O produto vem da própria loja; se chegar vencido ou perto de vencer, me chama aqui que eu resolvo com a loja.";
    case "dietary":
      return `Isso é produto pra pet: "sem ${q.term}" é termo de alimento humano, e o nome dessas opções não diz nada sobre ${q.term}. A composição fica no rótulo da loja (posso mandar o link: é só pedir "detalhes do 1"); se o seu pet tem restrição, o veterinário indica a linha certa.`;
    case "audience": {
      const label = AUDIENCE_LABEL[q.tag];
      const fits = options.map((o, i) => ({ i: i + 1, o })).filter(({ o }) => audienceTags(o.name).includes(q.tag));
      if (fits.length === options.length) return `Pelo nome, ${options.length === 1 ? "essa serve" : "todas servem"} pra ${label}.`;
      if (fits.length) {
        return `Pelo nome, ${fits.length === 1 ? "só a opção" : "as opções"} ${fits.map((f) => `*${f.i}*`).join(", ")} ${fits.length === 1 ? "é" : "são"} pra ${label}. As outras não dizem pra quem são.`;
      }
      const declared = [...new Set(options.flatMap((o) => audienceTags(o.name)))];
      const base = query.replace(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|ml|l)\b/gi, " ");
      const suggest = `${base} ${label}`.replace(/\s+/g, " ").trim();
      if (declared.length) {
        return `Pelo nome, ${options.length === 1 ? "essa é" : "essas são"} pra ${labelList(declared)} — nenhuma diz ser pra ${label}. Quer que eu procure? É só mandar _${suggest}_.`;
      }
      return `O nome dessas opções não diz pra quem são, e eu não quero chutar. Posso procurar uma que diga *${label}* no nome — é só mandar _${suggest}_.`;
    }
  }
}

// Termos que só fazem sentido em alimento humano: em ração/petisco a pergunta "tem sem lactose?" não se aplica.
export function isPetFood(options: ProductOption[]): boolean {
  return options.length > 0 && options.every((o) => /\b(racao|petisco|sache|areia|bifinho|osso)\b/.test(normalizeMsg(o.name)));
}
