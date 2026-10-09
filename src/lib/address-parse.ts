// Cadastro e endereço em texto livre (06/10, relatório do testador): o que é endereço, o que
// é pedido e o que é cortesia numa mensagem só. Tudo puro (sem banco, sem rede) — testado em
// tests/feedback-2026-10-06-cadastro.test.ts.
import { resolveListItems } from "@/lib/list-items";
import { CEP_RE, CEP_RE_GLOBAL, isNarrativeSegment, isWaitGripe, normalizeMsg, parseAddressComplement, type ParsedLine } from "@/lib/lia-intents";

// Tipo de logradouro. Os fortes valem em minúscula ("rua augusta"); os fracos ("largo",
// "praça", "estrada") só com a palavra seguinte em maiúscula — "calça larga" não é endereço.
const STRONG_STREET = String.raw`rua|r\.|avenida|av\.?|alameda|al\.`;
const WEAK_STREET = String.raw`travessa|tv\.|estrada|estr\.|rodovia|rod\.|pra[çc]a|p[çc]a\.?|largo|viela|servid[aã]o`;
const STREET_START_RE = new RegExp(String.raw`(^|[\s,.;:!?(])(?:(${STRONG_STREET})\s+(?=[\p{L}\d])|(${WEAK_STREET})\s+(?=[\p{Lu}\d]))`, "giu");

const WANT_CLAUSE_RE =
  /[,.;!?]\s*(?:e\s+)?(?:eu\s+)?(?:tamb[eé]m\s+)?(?:quero|queria|preciso|precisava|gostaria|manda|me\s+(?:manda|traz)|compra|traz)\b/i;
const PHONE_RE = /[,;]?\s*\b(?:tel|telefone|cel|celular|whats(?:app)?|zap|fone|contato)\b\.?:?\s*[\d\s()+.-]{8,}/gi;

// Fim de frase de verdade: ponto depois de número, de palavra longa ou de parêntese, ou
// !/?/quebra de linha. "Rua Eng. Edgar" (abreviação curta) não termina a frase.
const SENTENCE_BREAK_RE = /(?:(?<=\d|\p{L}{5}|\))[.;]\s+|[!?]+\s*|\n+)/u;

// Restos de "entrega em", "moro na", "meu endereço é" no fim da parte que veio antes da rua.
const LEAD_IN_RE =
  /(?:[\s,;:-]|\b(?:e|entao|então|ai|aí)\b)*(?:(?:\bna verdade|\bpode|\bfavor|\bpor favor)\s+)*(?:\b(?:me\s+)?(?:entrega|entregar|entregue|manda|mandar|envia|enviar|leva|levar|traz|trazer)(?:\s+(?:tudo|isso|aqui|pra mim))?(?:\s+(?:em|na|no|para|pra|pro|at[eé]))?(?:\s+(?:a|o))?(?:\s+(?:casa|ap(?:to|artamento)?|trabalho|escrit[oó]rio|endere[cç]o)(?:\s+d[aeo]s?)?(?:\s+(?:minha|meu))?(?:\s+\p{L}+)?)?|\b(?:eu\s+)?(?:moro|mora|morando|resido|fico)\s+(?:na|no|em)|\b(?:o\s+)?(?:meu\s+)?endere[cç]o(?:\s+(?:[eé]|eh|fica))?(?:\s+(?:na|no|em))?\s*:?|\b(?:na|no)\s+(?:casa|ap(?:to|artamento)?)\s+d[aeo]s?\s+(?:minha|meu)?\s*\p{L}+)?[\s,;:-]*$/iu;

function squash(text: string): string {
  return text
    .replace(/\s*,(?:\s*,)+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "")
    .trim();
}

// Endereço pronto pra etiqueta: sem o CEP (vive no campo próprio), sem "CEP" órfão, sem
// telefone e sem traço/vírgula sobrando.
export function cleanAddressText(raw: string): string {
  return squash(
    raw
      .replace(PHONE_RE, " ")
      .replace(CEP_RE_GLOBAL, " ")
      .replace(/[,;-]?\s*\bcep\b\s*[.:]?\s*/gi, " ")
      .replace(/\s+-\s*(?=,|$)/g, "")
      .replace(/\s*[-–]\s*$/g, "")
  ).replace(/[,;.\s-]+$/, "");
}

// Tem logradouro + número? (mesma régua do looksLikeDeliveryAddress do cérebro, agora com
// "Al." e na mensagem original).
function hasStreetWithNumber(text: string): boolean {
  STREET_START_RE.lastIndex = 0;
  for (let m = STREET_START_RE.exec(text); m; m = STREET_START_RE.exec(text)) {
    const after = text.slice(m.index + m[1].length, m.index + m[1].length + 90);
    if (/\d|\bs\/?n\b/i.test(after.replace(CEP_RE_GLOBAL, " "))) return true;
  }
  return false;
}

function streetStart(text: string): number {
  STREET_START_RE.lastIndex = 0;
  for (let m = STREET_START_RE.exec(text); m; m = STREET_START_RE.exec(text)) {
    const start = m.index + m[1].length;
    const after = text.slice(start, start + 90);
    if (/\d|\bs\/?n\b/i.test(after.replace(CEP_RE_GLOBAL, " "))) return start;
  }
  return -1;
}

const FILLER_ONLY_RE = /^(?:na verdade|entao|bom|ok|certo|sim|obrigad\w*|por favor|pfv|pf|valeu|e|ai|tchau|bjs?|beijos?|abs|abraco)?$/;

// Pedido + endereço na mesma mensagem (A1): "quero 2 sabonetes dove e um shampoo seda, entrega
// em Rua X 221 ap 13 … 01233020", "Rua Augusta 1500, 01305-100. quero arroz e feijão", a mensagem
// longa com nome, lista e "Moro na Rua…". Devolve só o endereço (sem CEP) e, à parte, o resto que
// pode ser pedido. null = não há rua com número.
export function splitAddressAndItems(raw: string): { address: string; items?: string } | null {
  const text = (raw ?? "").trim();
  if (!hasStreetWithNumber(text)) return null;
  const start = streetStart(text);
  if (start < 0) return null;
  let before = text.slice(0, start);
  const after = text.slice(start);
  let addressPart: string;
  let tail = "";
  const cep = CEP_RE.exec(after);
  if (cep) {
    addressPart = after.slice(0, cep.index);
    tail = after.slice(cep.index + cep[0].length);
    // Depois do CEP: frase nova é pedido; complemento ou bairro/cidade continuam o endereço.
    const startsSentence = /^\s*(?:[.!?;]|\n)/.test(tail) || WANT_CLAUSE_RE.test(`,${tail.replace(/^\s*[,]\s*/, " ")}`.slice(0, 40));
    if (!startsSentence && tail.trim()) {
      const extra = tail.replace(/^[\s,;:-]+/, "");
      const complement = parseAddressComplement(extra);
      if (complement || !WANT_CLAUSE_RE.test(`, ${extra}`)) {
        addressPart = `${addressPart}, ${extra}`;
        tail = "";
      }
    }
  } else {
    const brk = SENTENCE_BREAK_RE.exec(after.slice(3));
    addressPart = brk ? after.slice(0, brk.index + 3) : after;
    tail = brk ? after.slice(brk.index + 3) : "";
  }
  // "Rua Augusta 1500, quero arroz" — a oração de pedido sai do endereço.
  const want = WANT_CLAUSE_RE.exec(addressPart);
  if (want) {
    tail = `${addressPart.slice(want.index + 1)} ${tail}`;
    addressPart = addressPart.slice(0, want.index);
  }
  before = before.replace(CEP_RE_GLOBAL, " ").replace(LEAD_IN_RE, "");
  const address = cleanAddressText(addressPart);
  const items = [before, tail.replace(PHONE_RE, " ").replace(CEP_RE_GLOBAL, " ").replace(/[,;-]?\s*\bcep\b\s*[.:]?/gi, " ")]
    .map((part) => stripCourtesy(part).text.replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, "").trim())
    .filter((part) => part && !FILLER_ONLY_RE.test(normalizeMsg(part).replace(/[.!?,]+/g, "").trim()))
    .join(", ");
  return { address, ...(items ? { items } : {}) };
}

// ---------- número da casa com o CEP já conhecido (A3) ----------

const STREET_WORDS = /^(?:rua|r|avenida|av|alameda|al|travessa|tv|estrada|rodovia|praca|largo|de|da|do|das|dos|e)$/;

function streetTokens(street?: string): string[] {
  return normalizeMsg(street ?? "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((w) => w && !STREET_WORDS.test(w));
}

// Com o CEP salvo (ViaCEP deu a rua), "1500", "221 apto 13", "o numero é 1500", "numero 221 ap
// 13", "Augusta 1500" e "nº 1500" bastam. Devolve número e complemento como o cliente escreveu.
// Palavra da rua com 1 letra de diferença ("souza" × "Sousa" do CEP, "egidio" × "egídio", digitação), 09/10:
// a rua não era reconhecida e o endereço ia pra etiqueta como o cliente digitou, em minúsculas.
function nearStreetWord(word: string, known: Set<string>): boolean {
  if (known.has(word)) return true;
  // Abreviação: "eng" de Engenheiro, "prof" de Professor, "gen" de General.
  if (word.length >= 3 && [...known].some((k) => k.length > word.length && k.startsWith(word))) return true;
  if (word.length < 4) return false;
  for (const k of known) {
    if (Math.abs(k.length - word.length) > 1 || k.length < 4) continue;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < k.length && j < word.length && edits <= 1) {
      if (k[i] === word[j]) {
        i++;
        j++;
        continue;
      }
      edits++;
      if (k.length > word.length) i++;
      else if (word.length > k.length) j++;
      else {
        i++;
        j++;
      }
    }
    edits += k.length - i + (word.length - j);
    if (edits <= 1) return true;
  }
  return false;
}

export function parseHouseNumberReply(
  raw: string,
  place?: { street?: string; district?: string; city?: string }
): { numero: string; complemento?: string } | null {
  let text = (raw ?? "")
    .replace(CEP_RE_GLOBAL, " ")
    .replace(/\b(?:o\s+)?(?:meu\s+)?cep\s*(?:[eé]|eh|:)?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s,.;:-]+|[\s,.;:!-]+$/g, "")
    .replace(/^(?:e\s+)?(?:o\s+)?(?:n[uú]mero|num|n[º°o]\.?|nro\.?)(?:\s+(?:da casa|do pr[eé]dio))?\s*(?:[eé]|eh|:)?\s*/i, "")
    .trim();
  // A rua do CEP repetida antes do número ("Augusta 1500", "Rua Augusta, 1500").
  const known = new Set(streetTokens(place?.street));
  if (known.size) {
    const words = text.split(/\s+/);
    let i = 0;
    while (i < words.length && !/\d/.test(words[i])) {
      const w = normalizeMsg(words[i]).replace(/[^a-z0-9]/g, "");
      if (!w || STREET_WORDS.test(w) || nearStreetWord(w, known)) i++;
      else break;
    }
    if (i > 0 && i < words.length && /\d/.test(words[i])) text = words.slice(i).join(" ").replace(/^[\s,]+/, "");
  }
  const m = text.match(/^(\d{1,5}[a-z]?|s\/?n|sem n[uú]mero)(?![\d/])\s*[,;-]?\s*(.*)$/i);
  if (!m) return null;
  // Número 0 não é endereço ("rua sem nome 0", 09/10 rodada 1).
  if (/^0+[a-z]?$/i.test(m[1])) return null;
  const tail = m[2].trim().replace(/[\s,.;]+$/, "");
  if (!tail) return { numero: m[1] };
  const complement = parseAddressComplement(tail);
  if (complement) return { numero: m[1], complemento: complement };
  // Bairro/cidade do próprio CEP depois do número ("1500, Consolação") não atrapalha.
  const placeWords = new Set([...streetTokens(place?.district), ...streetTokens(place?.city)]);
  const tailWords = normalizeMsg(tail).replace(/[^a-z0-9\s]/g, " ").split(" ").filter(Boolean);
  if (placeWords.size && tailWords.every((w) => placeWords.has(w) || STREET_WORDS.test(w) || w === "sp" || w === "rj")) return { numero: m[1] };
  return null;
}

// "número 1000, quero pão de forma" (09/10, rodada 1): o número da casa dito junto do CEP e de um
// pedido. Devolve o número e o resto da mensagem sem a expressão — nunca vira item.
const LABELED_NUMBER_RE = /(?:^|[\s,;.])(?:o\s+)?(?:n[uú]mero|num|n[º°]\.?|nro\.?|n\.?(?=\s*\d))(?:\s+(?:da casa|do pr[eé]dio))?\s*(?:[eé]|eh|:)?\s*(\d{1,5}[a-z]?|s\/?n)(?![\d/])/i;
export function extractLabeledHouseNumber(raw: string): { numero: string; complemento?: string; rest: string } | null {
  const text = raw ?? "";
  const m = LABELED_NUMBER_RE.exec(text);
  if (!m || /^0+[a-z]?$/i.test(m[1])) return null;
  const before = text.slice(0, m.index);
  let after = text.slice(m.index + m[0].length);
  let complemento: string | undefined;
  const comp = /^\s*[,;-]?\s*((?:ap(?:to|artamento)?|apt|bloco|bl|casa|fundos|sala|conj(?:unto)?|cj|andar|loja)\.?\s*\w+)/i.exec(after);
  if (comp && parseAddressComplement(comp[1])) {
    complemento = parseAddressComplement(comp[1]) || undefined;
    after = after.slice(comp[0].length);
  }
  const rest = `${before} ${after}`.replace(/\s+/g, " ").replace(/^[\s,;.:-]+|[\s,;:-]+$/g, "").replace(/\s+,/g, ",").trim();
  return { numero: m[1], ...(complemento ? { complemento } : {}), rest };
}

// "mudei, entrega na Rua X 466, 04534-002" / "Rio de Janeiro 22041-001" (09/10, rodada 1): o que sobra do
// endereço (aviso de mudança, nome da cidade/estado/bairro) não é produto. Tira esses trechos da lista de itens.
const ADDRESS_FILLER_WORDS = new Set([
  "mudei", "me", "mudou", "mudanca", "troquei", "trocou", "agora", "novo", "nova", "endereco", "cep", "cidade", "bairro", "estado", "capital",
  "moro", "mora", "morando", "entrega", "entregar", "entregue", "manda", "mandar", "pra", "para", "pro", "na", "no", "em", "de", "do", "da", "dos", "das",
  "e", "a", "o", "ai", "ali", "aqui", "la", "casa", "eu", "meu", "minha", "sp", "rj", "uf", "brasil"
]);
const ADDRESS_STATE_WORDS = ["sao paulo", "rio de janeiro", "rio", "campinas", "santos", "niteroi"];
export function dropAddressOnlyItems(items: string | undefined, place?: { city?: string; uf?: string; district?: string; street?: string }): string | undefined {
  if (!items) return items;
  const known = new Set([...streetTokens(place?.city), ...streetTokens(place?.district)]);
  const kept = items
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      let n = ` ${normalizeMsg(part).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
      for (const state of ADDRESS_STATE_WORDS) n = n.replace(new RegExp(` ${state} `, "g"), "  ");
      const words = n.split(" ").filter(Boolean);
      return !(words.every((w) => ADDRESS_FILLER_WORDS.has(w) || known.has(w)) );
    });
  return kept.length ? kept.join(", ") : undefined;
}

// "Rua Augusta, 01305-100", "moro na rua augusta perto do metrô": rua citada, número não.
export function mentionsStreetWithoutNumber(raw: string, street?: string): boolean {
  const text = (raw ?? "").replace(CEP_RE_GLOBAL, " ");
  if (/\d/.test(text)) return false;
  STREET_START_RE.lastIndex = 0;
  if (STREET_START_RE.test(text)) return true;
  const known = streetTokens(street);
  const words = normalizeMsg(text).replace(/[^a-z0-9\s]/g, " ").split(" ").filter((w) => w && !STREET_WORDS.test(w) && w !== "cep" && w !== "meu");
  return known.length > 0 && words.length > 0 && words.every((w) => known.includes(w));
}

// ---------- CEP × cidade escrita (A5) ----------

const KNOWN_CITIES = [
  "São Paulo", "Rio de Janeiro", "Guarulhos", "Osasco", "Barueri", "Carapicuíba", "Cotia", "Taboão da Serra",
  "Embu das Artes", "Itapecerica da Serra", "Santo André", "São Bernardo do Campo", "São Caetano do Sul",
  "Diadema", "Mauá", "Mogi das Cruzes", "Suzano", "Itaquaquecetuba", "Santana de Parnaíba", "Itapevi", "Jandira",
  "Campinas", "Santos", "São Vicente", "Praia Grande", "Guarujá", "Sorocaba", "Jundiaí", "Ribeirão Preto",
  "São José dos Campos", "Taubaté", "Piracicaba", "Bauru", "São José do Rio Preto", "Limeira", "Americana",
  "Niterói", "São Gonçalo", "Duque de Caxias", "Nova Iguaçu", "Petrópolis", "Belford Roxo", "São João de Meriti",
  "Belo Horizonte", "Curitiba", "Porto Alegre", "Salvador", "Recife", "Fortaleza", "Brasília", "Goiânia",
  "Florianópolis", "Manaus", "Belém", "Vitória", "Campo Grande", "Cuiabá", "Natal", "João Pessoa", "Maceió",
  "Aracaju", "Teresina", "São Luís"
];
const UF_TOKEN_RE = /(?:[-–\/,]\s*|\s)(SP|RJ|MG|PR|RS|SC|DF|BA|PE|CE|GO|MT|MS|PB|RN|PI|MA|PA|AM|ES)\b(?!\s*\d)/g;

// O CEP é de uma cidade e o endereço escrito diz outra ("Rua Augusta 1500, Consolação, São Paulo,
// 20040-002", CEP do Centro do Rio). Só a CIDADE (e a UF escrita em maiúscula) — a grafia da rua
// varia demais pra comparar. Olha só o que vem depois do número da casa: "Rua São Paulo 100,
// Santo André" não é divergência. Devolve a cidade escrita, ou null.
export function typedCityMismatch(addressText: string, cepCity?: string, cepUf?: string): string | null {
  if (!cepCity) return null;
  const raw = addressText ?? "";
  const num = raw.search(/\d/);
  const afterNumber = num >= 0 ? raw.slice(num) : raw;
  const n = ` ${normalizeMsg(afterNumber).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  const cep = normalizeMsg(cepCity);
  if (n.includes(` ${cep} `)) return null;
  for (const city of KNOWN_CITIES) {
    const c = normalizeMsg(city);
    if (c !== cep && n.includes(` ${c} `)) return city;
  }
  if (cepUf) {
    for (const m of afterNumber.matchAll(UF_TOKEN_RE)) {
      if (m[1] !== cepUf.toUpperCase()) return m[1];
    }
  }
  return null;
}

// ---------- cortesia e apresentação no 1º contato (M1) ----------

const GREETING_HEAD_RE = /^\s*(?:(?:oi+e?|ol[aá]+|opa|e a[ií]|eai|bom dia|boa tarde|boa noite|hey|al[oô])(?:\s+lia)?\s*[,!.]*\s*)+/i;
const COURTESY_RES: RegExp[] = [
  /(?:^|(?<=[.!?,]\s*))\s*(?:tudo (?:bem|bom|certo|joia|tranquilo)|td (?:bem|bom)|como vai|blz)(?:\s+com\s+voc[eê]s?)?\s*[?!.,]*/giu,
  /\b(?:meu nome [eé]|me chamo|aqui [eé] (?:a|o))\s+\p{L}+(?:\s+(?:d[aeo]s?\s+)?\p{L}+){0,4}\s*[,.!]?/giu,
  /\bsou (?:a|o)\s+\p{Lu}\p{L}*(?:\s+(?:d[aeo]s?\s+)?\p{Lu}\p{L}*){0,4}\s*[,.!]?/gu,
  /\b(?:eu\s+)?(?:gostaria|queria|quero|posso|vou|vim|preciso)\s+(?:de\s+)?(?:fazer|faz[eê]|pedir|encomendar)\s+(?:um|uma|o|meu|minha)?\s*(?:pedido|encomenda|compras?)\b\s*[?!.,]*/giu,
  /\bvi\s+(?:o|a|um|uma|seu|sua)\s+(?:an[uú]ncio|propaganda|post|publica[cç][aã]o|v[ií]deo|perfil)\b[^.,!?\n]*[.,!?]*/giu,
  /\b(?:uma amiga|um amigo|minha \p{L}+|meu \p{L}+|algu[eé]m)\s+(?:me\s+)?indic\w+[^.,!?\n]*[.,!?]*/giu,
  // Pergunta sobre o serviço no meio da apresentação ("Vcs entregam remédio?"): não é item.
  /(?:^|(?<=[.!?,]\s*))\s*(?:(?:e\s+)?(?:vcs?|voc[eê]s?|voce)\s+(?:entregam|entrega|atendem|atende|aceitam|aceita|funcionam|funciona|s[aã]o|cobram|fazem)(?:\s+\p{L}+){0,3}|como funciona|como (?:que )?faz|qual (?:o|a)\s+\p{L}+|quanto custa o servi\w+|[eé] confi[aá]vel|[eé] golpe)\s*\?/giu,
  /\b(?:muito\s+)?obrigad[oa]s?\b[!.]*|\bvaleu\b[!.]*|\bgrat[oa]\b[!.]*/giu
];
const WANTS_ORDER_RE = /\b(?:gostaria|queria|quero|posso|vou|vim|preciso)\s+(?:de\s+)?(?:fazer|faz[eê]|pedir|encomendar)\s+(?:um|uma|o|meu|minha)?\s*(?:pedido|encomenda|compras?)\b/i;

// Tira saudação, apresentação ("sou a Clara Souza", "meu nome é…"), "gostaria de fazer um
// pedido", "vi o anúncio", "uma amiga me indicou" e a pergunta sobre o serviço. O que sobra é
// o pedido (às vezes nada). `wantsToOrder` = disse que quer pedir sem dizer o quê.
export function stripCourtesy(raw: string): { text: string; wantsToOrder: boolean } {
  const original = raw ?? "";
  const wantsToOrder = WANTS_ORDER_RE.test(original);
  let text = original.replace(GREETING_HEAD_RE, "");
  for (const re of COURTESY_RES) text = text.replace(re, " ");
  text = text
    .replace(/(?:^|\s)[,.;!?]+(?=\s|$)/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, "")
    .trim();
  return { text, wantsToOrder };
}

// ---------- "quanto tá o leite ninho?" no 1º contato (M2) ----------

const PRICE_SERVICE_NOUN_RE =
  /^(?:o\s+|a\s+)?(?:servi\w+|frete|taxa|entrega|a entrega|isso|isto|total|pedido|minimo|valor|preco|cadastro|app|aplicativo|voces?|vcs?|pra (?:mim|entregar)|pro meu cep|ai|aqui)\b/;

export function parsePriceAsk(raw: string): string | null {
  const n = normalizeMsg(raw)
    .replace(/[?!.]+$/g, "")
    .replace(/^(?:(?:oi+e?|ola|opa|bom dia|boa tarde|boa noite|eai|e ai)\s*[,!.]?\s+)+/, "")
    .trim();
  const m = n.match(
    /^(?:(?:e\s+)?(?:qual|quanto)\s+(?:e\s+|eh\s+)?(?:o\s+)?(?:preco|valor)\s+d[oae]s?\s+|(?:e\s+)?quanto\s+(?:que\s+)?(?:ta|tá|esta|está|custa|custam|sai|fica|e|eh|vale|ta saindo)\s+(?:o|a|os|as|um|uma)?\s*)(.{2,60})$/
  );
  if (!m) return null;
  const item = m[1].replace(/\b(?:ai|aí|hoje|agora|ai com voces|com voces|com vcs)$/, "").trim();
  if (!item || PRICE_SERVICE_NOUN_RE.test(item)) return null;
  // Com a grafia do cliente: as últimas palavras da mensagem original.
  const words = (raw ?? "").replace(/[?!.]+\s*$/g, "").trim().split(/\s+/);
  const k = item.split(" ").length;
  return words.length >= k ? words.slice(-k).join(" ") : item;
}

// ---------- "deixa o endereço antigo" (A4) e "não sei meu cep" (M6) ----------

export function isKeepOldAddress(raw: string): boolean {
  const n = normalizeMsg(raw).replace(/[!.?,]+/g, " ").replace(/\s+/g, " ").trim();
  if (n.split(" ").length > 12) return false;
  return (
    /\b(deixa|deixe|mantem|mantenha|manter|fica|fique|usa|use|usar|pode usar|continua|continue|volta|volte|vale)\b.*\b(antigo|anterior|de antes|de sempre|o mesmo|mesmo endereco|atual|que (ja|eu) (tinha|tenho|passei|mandei)|salvo|cadastrado)\b/.test(n) ||
    /\b(mantem|mantenha|manter)\b.*\b(endereco|cep)\b/.test(n) ||
    /\b(nao|n)\s+(quero\s+|precisa\s+|vou\s+)?(troca|trocar|muda|mudar|altera|alterar)\b/.test(n) ||
    /^(esquece|esqueca|deixa|deixa pra la)\b.*\b(endereco|cep)\b/.test(n)
  );
}

// "deixa o antigo" fora de uma troca em andamento só vale citando o endereço: "não quero
// trocar" sozinho pode ser sobre um produto.
export function isKeepOldAddressExplicit(raw: string): boolean {
  return isKeepOldAddress(raw) && /\b(endereco|cep)\b/.test(normalizeMsg(raw));
}

export function saysNoCep(raw: string): boolean {
  const n = normalizeMsg(raw);
  return /\b(nao|n)\s+(sei|lembro|tenho|conheco)\b.*\bcep\b|\bcep\b.*\b(nao|n)\s+(sei|lembro)\b|\bqual (e )?(o )?meu cep\b|\bsem cep\b/.test(n);
}

// "Teste Silva", "Maria da Silva Santos": nome de gente (cada palavra com maiúscula, 2 a 5
// palavras, sem número nem verbo de pedido). Só é usado quando o CPF chega logo depois, para
// tirar o nome da lista de itens guardada (M11).
export function looksLikePersonName(raw: string): boolean {
  const text = (raw ?? "").trim();
  if (!text || /\d/.test(text)) return false;
  const words = text.split(/\s+/);
  const real = words.filter((w) => !/^(da|de|do|dos|das|e)$/i.test(w));
  if (real.length < 2 || real.length > 5) return false;
  if (!real.every((w) => /^\p{Lu}[\p{Ll}'-]+$/u.test(w))) return false;
  return !/\b(quero|queria|preciso|manda|oi|ola|bom|boa|obrigad\w*|cpf|sim|nao|ok)\b/.test(normalizeMsg(text));
}

// ---------- o que anotar antes do cadastro (M1 + testadores 06/10) ----------

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Link de produto: o fim do caminho costuma ser o nome ("…/protetor-solar"); código de
// anúncio ("dp/B08XYZ") não diz nada e sai.
function urlSlug(url: string): string {
  const path = url.replace(/^https?:\/\//i, "").split(/[?#]/)[0].split("/").filter(Boolean).slice(1);
  const last = [...path].reverse().find((seg) => /[a-z]{3,}/i.test(seg) && !/\d/.test(seg)) ?? "";
  const words = last.replace(/\.(html?|aspx?|php)$/i, "").split(/[-_+]+/).filter((w) => /^\p{L}{2,}$/u.test(w));
  return words.length >= 2 || (words.length === 1 && words[0].length >= 4) ? words.join(" ") : "";
}
const PHONE_ONLY_RE = /^\+?[\d\s().-]{8,}$/;
const ONBOARDING_NOISE_RE =
  /^(?:me liga\w*|me ligue|liga (?:pra|para) mim|me chama(?: no zap| no whats\w*)?|tchau\w*|ate (?:mais|logo|amanha|depois)|flw|falou|fui|bjs?|beijos?|abracos?|me surpreend\w*|surpreende(?: me)?|(?:algo|alguma coisa|qualquer coisa|coisas?|umas coisas)(?:\s.*)?|chama (?:um )?(?:uber|taxi|99|motoboy).*|kk+|rs+|haha\w*|(?:no\s+|pago\s+no\s+|pagar\s+no\s+|pagamento\s+(?:no\s+|em\s+)?)?(?:pix|cartao|dinheiro))$/;
const REMINDER_RE = /\bme\s+lembr\w*\s+(?:(?:amanh[aã]|depois|mais tarde|hoje|(?:na|no|de)\s+\p{L}+)\s+)?(?:de\s+)?(?:comprar\s+|pedir\s+)?/giu;
const NAME_AT_START_RE = /^\s*\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?\s+(?:aqui|falando)\b[\s,.!]*/u;

// Pedido de quem ainda não tem cadastro: só o que tem cara de produto entra na lista
// guardada. Apresentação, cortesia, pergunta sobre o serviço, história pessoal, "me liga",
// telefone, link sem nome e pedido vago ("algo pra comer", "me surpreende") ficam de fora.
export function onboardingNote(raw: string): { text: string; lines: ParsedLine[]; wantsToOrder: boolean } {
  // Marcador de lista ("- sabonete dove") não é parte do produto.
  const courtesy = stripCourtesy((raw ?? "").replace(NAME_AT_START_RE, "").replace(/^\s*[-•*–]\s+/gm, ""));
  const cleaned = courtesy.text.replace(URL_RE, (url) => ` ${urlSlug(url)} `).replace(REMINDER_RE, "");
  const lines = resolveListItems(cleaned).filter((line) => {
    const n = normalizeMsg(line.phrase);
    if (/^(?:rua|r\.|avenida|av\.?|alameda|al\.|travessa|estrada|rodovia|pra[çc]a|largo)\s/i.test(line.phrase.trim()) && (/\b0+\b/.test(line.phrase) || /\bsem nome\b/i.test(line.phrase))) return false;
    return !/^(?:o\s+)?(?:n[uú]mero|num|n[º°]\.?|nro\.?)\s*(?:[eé]|eh|:)?\s*\d{1,5}[a-z]?$/i.test(line.phrase.trim()) && !PHONE_ONLY_RE.test(line.phrase) && !isWaitGripe(line.phrase) && !ONBOARDING_NOISE_RE.test(n) && !isNarrativeSegment(line.phrase) && /\p{L}{2,}/u.test(line.phrase);
  });
  const text = lines.map((line) => (line.qtyExplicit || line.qty > 1 ? `${line.qty} ${line.phrase}` : line.phrase)).join(", ");
  return { text, lines, wantsToOrder: courtesy.wantsToOrder };
}
