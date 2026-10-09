// Pedido em inglês (09/10, rodada 3): "I need a phone charger and some milk" virava "não achei: phone charger, milk"
// depois de ~24 s de busca. Tradução opcional e barata: só palavras de compra comuns; fora do dicionário, o texto
// segue como veio. Puro e testado.

// Frases primeiro (ordem importa); depois palavras soltas.
const PHRASES: Array<[RegExp, string]> = [
  [/\bcell ?phone charger\b/g, "carregador de celular"],
  [/\bphone charger\b/g, "carregador de celular"],
  [/\bphone case\b/g, "capa de celular"],
  [/\bscreen protector\b/g, "película de celular"],
  [/\btoilet paper\b/g, "papel higiênico"],
  [/\bpaper towels?\b/g, "papel toalha"],
  [/\btooth ?paste\b/g, "pasta de dente"],
  [/\btooth ?brush\b/g, "escova de dente"],
  [/\bdish ?soap\b/g, "detergente"],
  [/\blaundry detergent\b/g, "sabão em pó"],
  [/\bdog food\b/g, "ração de cachorro"],
  [/\bcat food\b/g, "ração de gato"],
  [/\bcat litter\b/g, "areia de gato"],
  [/\borange juice\b/g, "suco de laranja"],
  [/\bolive oil\b/g, "azeite"]
];
const WORDS: Record<string, string> = {
  milk: "leite", bread: "pão", water: "água", eggs: "ovos", egg: "ovo", rice: "arroz", beans: "feijão", coffee: "café",
  sugar: "açúcar", salt: "sal", butter: "manteiga", cheese: "queijo", chicken: "frango", meat: "carne", beef: "carne",
  pasta: "macarrão", noodles: "macarrão", banana: "banana", bananas: "banana", apple: "maçã", apples: "maçã", tomato: "tomate",
  tomatoes: "tomate", potato: "batata", potatoes: "batata", onion: "cebola", juice: "suco", beer: "cerveja", wine: "vinho",
  soap: "sabonete", shampoo: "shampoo", conditioner: "condicionador", diapers: "fralda", diaper: "fralda", batteries: "pilha",
  battery: "pilha", charger: "carregador", cable: "cabo", flour: "farinha", oil: "óleo", cookies: "bolacha", chocolate: "chocolate",
  yogurt: "iogurte", cereal: "cereal", ham: "presunto", sausage: "linguiça", fish: "peixe", soda: "refrigerante", tea: "chá"
};
// Palavras de ligação em inglês (somem na tradução) e que denunciam que a frase é inglês.
const CUES = /\b(?:i need|i want|i would like|i'd like|i am looking for|i'm looking for|looking for|can you (?:get|bring|send)|could you (?:get|bring|send)|do you have|get me|bring me|please|some)\b/;
const FILLER = new Set(["i", "need", "want", "would", "like", "id", "i'd", "a", "an", "the", "some", "please", "of", "and", "also", "plus", "get", "me", "bring", "send", "can", "could", "you", "do", "have", "looking", "for", "am", "i'm", "to", "buy", "my", "any", "more", "too", "thanks", "thank", "hi", "hello"]);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[.!?;:()]+/g, " ").replace(/,/g, " , ").split(/\s+/).filter(Boolean);
}

// null = não é inglês de compra (o texto segue como veio).
export function translateEnglishOrder(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower || lower.length > 200 || /[à-úç]/.test(lower)) return null;
  let work = lower;
  for (const [re, pt] of PHRASES) work = work.replace(re, ` ${pt.replace(/ /g, "§")} `);
  const toks = tokens(work);
  const known = toks.filter((t) => WORDS[t] || t.includes("§"));
  if (!known.length) return null;
  // Precisa ter cara de inglês: palavra de ligação/pedido em inglês, ou só dicionário + ligações ("milk and bread").
  const onlyKnown = toks.every((t) => t === "," || WORDS[t] || t.includes("§") || FILLER.has(t));
  if (!CUES.test(lower) && !onlyKnown) return null;
  // Sem palavra de pedido em inglês, precisa de ao menos uma palavra que NÃO existe em português ("pasta", "banana",
  // "chocolate", "shampoo" e "cereal" são português também).
  const AMBIGUOUS = new Set(["pasta", "banana", "chocolate", "shampoo", "cereal"]);
  if (!CUES.test(lower) && !toks.some((t) => WORDS[t] && !AMBIGUOUS.has(t)) && !known.some((t) => t.includes("§"))) return null;
  const out: string[] = [];
  let segment: string[] = [];
  const flush = () => {
    if (segment.length) out.push(segment.join(" "));
    segment = [];
  };
  for (const t of toks) {
    if (t === "," || t === "and" || t === "plus" || t === "also") {
      flush();
      continue;
    }
    if (FILLER.has(t) && !WORDS[t]) continue;
    segment.push(t.includes("§") ? t.replace(/§/g, " ") : WORDS[t] ?? t);
  }
  flush();
  const items = out.map((x) => x.trim()).filter(Boolean);
  return items.length ? items.join(", ") : null;
}

// Link de produto/loja (09/10, rodada 3): a Lia não abre link. Devolve o texto SEM o link e se havia link.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com\.br|com|net|org|br)\/\S+/gi;
export function stripLinks(text: string): { text: string; hadLink: boolean } {
  if (!new RegExp(URL_RE.source, "i").test(text)) return { text, hadLink: false };
  return { text: text.replace(URL_RE, " ").replace(/\s+/g, " ").replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, ""), hadLink: true };
}
