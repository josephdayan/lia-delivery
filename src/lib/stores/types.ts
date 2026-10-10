// Pluggable store layer. A StoreConnector is one supply source the operator can
// buy from through retailer delivery. Adding a source means writing one connector
// and registering it; the chat flow and operator dashboard only
// ever talk to this interface, never to a specific store.

export type CatalogItem = {
  sku: string;
  name: string;
  brand?: string;
  unitPrice: number;
  unit?: string; // "un", "kg", "pacote", "L"
  category?: string;
  imageUrl?: string;
  // Real deep link to the product page on the store, when the scrape captured it
  // Lets /ops open the exact
  // item instead of a name search.
  productUrl?: string;
  // A PRÓPRIA oferta declara frete grátis (vitrine ao vivo do ML: cada anúncio é um
  // checkout separado, com regra de frete própria — a política por loja não descreve
  // isso). Sem a flag, a cotação cobrava tarifa padrão R$18 num anúncio que estampa
  // "Chegará grátis hoje" (17/08).
  freeShipping?: boolean;
  // Posição no "mais vendidos" da loja (1 = campeão), gravada no harvest VTEX
  // (O=OrderByTopSaleDESC) — e, nos catálogos antigos, derivada da ordem do arquivo por
  // `ensurePopularity`. Só desempata entre itens de MESMA relevância (05/09, dono).
  popularity?: number;
  // Remédio isento de prescrição (29/09): SÓ vem dos catálogos *-mip-catalog.ts, colhidos
  // da prateleira de isentos da farmácia (scripts/harvest-mip-catalog.mts). Servido apenas
  // com LIA_MEDICINE_MIP=true; comprado no CPF do cliente (src/lib/medicine.ts).
  medicine?: "mip";
  // Código de barras do produto — é como a Pague Menos prova que o item é o mesmo MIP da
  // Drogaria SP (a Pague Menos não publica a tarja).
  ean?: string;
};

export type StoreUnit = {
  id: string;
  label: string; // e.g. "Petz Augusta"
  address: string;
  cep?: string;
  // Coordenadas reais da loja (pino do Google Maps). Quando presentes, a escolha da
  // unidade mais próxima usa distância geográfica de verdade (haversine) em vez da
  // proximidade numérica de CEP. Opcional: sem elas, cai no proxy de CEP (nearest.ts).
  lat?: number;
  lng?: number;
};

export type StoreConnector = {
  key: string; // "oba"
  label: string; // "Oba Hortifruti"
  // Minimum order this store requires, in REAL cost (R$ of products we pay the store).
  // Store-specific; 0/undefined = no minimum.
  minOrder?: number;
  // Best catalog matches for one free-text basket line ("pasta de dente colgate").
  searchItems(query: string, limit?: number): Promise<CatalogItem[]>;
  // All clique-e-retire units of this store. Choosing the nearest to a CEP is done by
  // the shared pickNearestUnit() helper (stores/nearest.ts), not per-connector.
  listUnits(): StoreUnit[];
  // Counter-pickup instructions for the click-e-retire order (operator + courier).
  pickupInstructions(orderNumber: string): string;
  // Full catalog (used by the AI matcher; real stores return a fetched/cached list).
  listCatalog(): CatalogItem[];
};

// WhatsApp product cards require an https image. Incomplete scrape rows remain in
// their generated source files for later enrichment, but they are quarantined from
// the active/sellable catalog so the conversation can never degrade to a text-only
// option. Store-specific blocked-CDN checks are covered by the global catalog test.
export function catalogWithImages(items: CatalogItem[]): CatalogItem[] {
  return items.filter((item) => Boolean(item.imageUrl && /^https:\/\//i.test(item.imageUrl)));
}

// Shared helper: accent-insensitive, lowercase token match scoring so a store's
// searchItems can rank a free-text request against its catalog.
export function normalizeText(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Greetings / fillers / articles that must NOT drive product matching, otherwise
// "Bom dia" matches "Bombril" and "quero um X" leaks "um".
const STOPWORDS = new Set(
  "bom boa dia tarde noite oi ola ei eai opa quero queria qro qr qero qria gostaria manda me te lhe por favor pf pff pfv um uma uns umas de do da dos das e o a os as pra para pro pros preciso pode poderia ser com sem no na nos nas ai hoje agora la aqui isso esse essa esses essas outro outra outros outras algum alguma tem voce vc obrigado obrigada nao ne ta cade onde quando quanto custa vou meu minha seu sua pelo pela mim ainda ja so nada mais tambem tb tbm tmb que sei entao".split(
    " "
  )
);

// Tamanhos de vestuário/fralda de 1-2 letras que DEVEM sobreviver ao filtro de tokens
// ("fralda pampers G" — o G é a informação mais importante da mensagem).
const SIZE_LETTER_RE = /^(p|m|g|gg|xg|xxg|rn)$/;

// Compostos que a normalização separa ("USB-C" → "usb c"; o cliente também fala
// "tipo C"): re-colados num token canônico único. Sem isso a letra final é descartada
// como ruído e "carregador usb c" fica idêntico a "carregador usb" — foi assim que 3
// carregadores veiculares venceram o carregador de parede USB-C (caso real, 06/08).
const COMPOUND_PAIRS: Array<[string, string, string]> = [
  ["usb", "c", "usbc"],
  ["tipo", "c", "usbc"],
  ["usb", "a", "usba"],
  ["micro", "usb", "microusb"]
];
// Compound → cabeça genérica: pedido genérico ("usb") serve o item específico
// ("usb-c"), mas pedido específico ("usb c") NÃO casa com o genérico ("2 saídas USB").
const COMPOUND_HEADS: Record<string, string> = { usbc: "usb", usba: "usb", microusb: "usb" };

function collapseCompounds(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const pair = COMPOUND_PAIRS.find(([a, b]) => tokens[i] === a && tokens[i + 1] === b);
    if (pair) {
      out.push(pair[2]);
      i++;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

function words(text: string): string[] {
  return collapseCompounds(normalizeText(text).split(" ").filter(Boolean));
}

// Pet vocabulary. Customers say "cachorro"/"gato"; catalogs say "Cães"/"Gatos"
// (accent-stripped to "caes"). Without treating these as synonyms, a wet sachê that
// literally says "Cachorro" outranks the dry-food bag that says "Cães", and cat food
// leaks into dog results. Words here are already normalized (no accents).
const DOG_WORDS = new Set(["cachorro", "cachorros", "cao", "caes", "canino", "canina", "dog"]);
const CAT_WORDS = new Set(["gato", "gatos", "felino", "felina", "cat"]);
// Wet-food markers ("Ração Úmida ... Sachê / Lata / Patê"). When the customer didn't
// ask for wet food we de-prioritize these so the staple dry pack — what people mean by
// "ração" — ranks first.
const WET_WORDS = new Set(["umida", "umido", "sache", "lata", "pate"]);

// Which species a set of words is ABOUT, or null if neither or BOTH (e.g. a shampoo
// "para Cães e Gatos" serves both, so it shouldn't be excluded from either).
// Raça de cachorro no NOME do item também diz a espécie (06/10, A6: "Ração Premier Raças
// Específicas Bulldog Francês" é de cachorro e aparecia para "ração premier gato 1kg").
// Só lado do item: o cliente que fala "shih tzu" já é coberto pela busca normal.
const DOG_BREED_WORDS = new Set(["bulldog", "buldogue", "shih", "yorkshire", "poodle", "labrador", "pinscher", "spitz", "pug", "lhasa", "maltes", "dachshund", "schnauzer", "beagle", "rottweiler", "pitbull", "chihuahua", "pastor", "border", "dogs"]);
function animalOf(wordList: string[], itemSide = false): "dog" | "cat" | null {
  const dog = wordList.some((w) => DOG_WORDS.has(w) || (itemSide && DOG_BREED_WORDS.has(w)));
  const cat = wordList.some((w) => CAT_WORDS.has(w));
  if (dog === cat) return null;
  return dog ? "dog" : "cat";
}

// tokenMatchesWord plus synonym equivalences: pet (cachorro≈cães≈cão, gato≈felino) e
// beleza (perfume≈colônia — no Boticário os perfumes se chamam "Desodorante Colônia").
function tokenMatchesWordSyn(token: string, word: string): boolean {
  if (tokenMatchesWord(token, word)) return true;
  // Pedido genérico serve o específico: "usb" casa com "usb-c" do nome. A direção
  // inversa (pedir "usb c", nome só diz "usb") fica de fora de propósito.
  if (COMPOUND_HEADS[word] === token) return true;
  if (DOG_WORDS.has(token) && DOG_WORDS.has(word)) return true;
  if (CAT_WORDS.has(token) && CAT_WORDS.has(word)) return true;
  if ((token === "perfume" || token === "perfumes") && (word === "colonia" || word === "colonias")) return true;
  // "miojo" ≈ "lámen": o cliente fala miojo; o catálogo esconde "Miojo"/"Lámen" no
  // meio do nome ("Pack Macarrão Instantâneo Lámen … Nissin Miojo 510g").
  // "bolacha" ≈ "biscoito" (09/10, teste real: "bolacha maizena" não achava nenhum Biscoito Maizena em loja alguma).
  if (COOKIE_WORDS.has(token) && COOKIE_WORDS.has(word)) return true;
  if ((token === "miojo" || token === "miojos" || token === "lamen") && (word === "lamen" || word === "miojo")) return true;
  // 27/09 (golden "carregador veicular"): a Drogal chama o mesmo produto de "Carregador Carro".
  if (VEHICLE_WORDS.has(token) && VEHICLE_WORDS.has(word)) return true;
  return false;
}
const COOKIE_WORDS = new Set(["bolacha", "bolachas", "biscoito", "biscoitos"]);
const VEHICLE_WORDS = new Set(["veicular", "veiculares", "carro", "carros", "automotivo", "automotiva", "automotivos"]);

// Plural irregular do português (08/10, placar r4): "recarregáveis" nunca casava com
// "Recarregável", então toda pilha recarregável pontuava como pilha comum e saía do top-12.
// Só a forma singular canônica dos sufixos regulares (-eis→-el, -ois→-ol, -ais→-al, -oes→-ao,
// -ns→-m, -es após r/z/s/n, -s); "-ães" fica de fora ("mães" viraria "mão"). Palavra curta
// (< 5 letras) não entra: "sais" não pode virar "sal", nem "pais" "pal".
export function singularPt(word: string): string {
  if (word.length < 5 || !word.endsWith("s")) return word;
  if (/eis$/.test(word)) return word.slice(0, -3) + "el";
  if (/ois$/.test(word)) return word.slice(0, -3) + "ol";
  if (/ais$/.test(word)) return word.slice(0, -3) + "al";
  if (/oes$/.test(word)) return word.slice(0, -3) + "ao";
  if (/ns$/.test(word)) return word.slice(0, -2) + "m";
  if (/[rzsn]es$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

// Word-boundary match: avoids "bom"(3) hitting "bombril". Short tokens must match a
// whole word; tokens >=4 may match as a substring of a word ("colgate" in "colgate").
function tokenMatchesWord(token: string, word: string): boolean {
  if (token === word) return true;
  if (token.length >= 5 && word.length >= 5 && singularPt(token) === singularPt(word)) return true;
  // Prefix match only — "refrigerante" matches "refri", but "restauração" must NOT
  // match "ração" (it's a suffix), and "bombril" must NOT match "bom" (too short).
  if (token.length >= 4 && word.startsWith(token)) return true;
  // Reverse prefix covers inflections ("refrigerantes" ~ "refrigerante"), so cap the
  // length gap — otherwise "galactica" matches the name word "Gala" and gibberish
  // requests surface random products instead of an honest "não achei".
  if (word.length >= 4 && token.startsWith(word) && token.length - word.length <= 3) return true;
  // Um erro de digitação em palavras específicas é muito comum no celular
  // ("detergnte", "bananna", "escva"). Só habilitamos para palavras de 5+
  // letras e mesma faixa de tamanho, para não transformar ruído curto em produto.
  // A 1ª letra tem que bater: typo raramente erra ela, e sem essa trava "vinho"
  // vira "Ninho" (distância 1, produto completamente diferente). A palavra do
  // CATÁLOGO precisa de 6+ letras: em 5 letras o espaço é denso demais e palavras
  // REAIS colidem a distância 1 — "miojo" virava "Miolo" (vinho e alcatra).
  if (token.length >= 5 && word.length >= 6 && Math.abs(token.length - word.length) <= 1 && token[0] === word[0]) {
    let previous = Array.from({ length: word.length + 1 }, (_, i) => i);
    for (let i = 1; i <= token.length; i++) {
      const current = [i];
      let rowMin = current[0];
      for (let j = 1; j <= word.length; j++) {
        const value = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (token[i - 1] === word[j - 1] ? 0 : 1)
        );
        current[j] = value;
        rowMin = Math.min(rowMin, value);
      }
      if (rowMin > 1) return false;
      previous = current;
    }
    if (previous[word.length] <= 1) return true;
  }
  return false;
}

// Marca é nome próprio: casar por aproximação com ela é o pior falso positivo possível,
// porque vale +4 de score. Dois casos reais: "miojo" casava com a vinícola "Miolo" (typo)
// e "leite" casava com a marca "Leiteria" (prefixo), roubando o topo do leite de verdade.
// Só exato ou plural — "coca" continua achando a marca Coca-Cola, que é o caso que
// justifica match por marca existir.
function isSameNoun(token: string, word: string): boolean {
  return word === token || word === `${token}s` || word === `${token}es` || token === `${word}s` || token === `${word}es`;
}
function tokenMatchesBrand(token: string, word: string): boolean {
  return isSameNoun(token, word);
}

// The meaningful product tokens in a request (greetings/fillers removed).
export function queryTokens(query: string): string[] {
  return words(query).filter((token) => (token.length > 1 || SIZE_LETTER_RE.test(token)) && !STOPWORDS.has(token));
}

// "café SEM açúcar", "água SEM gás" — o que vem depois do "sem" é EXCLUSÃO, não busca.
function negatedWords(query: string): string[] {
  return [...normalizeText(query).matchAll(/\bsem\s+(\w{3,})\b/g)].map((m) => m[1]);
}

// "sem cheiro" = "sem perfume" = "sem fragrância" no nome do produto (10/10, rodada 5 g16).
const ODOR_WORDS = new Set(["cheiro", "aroma", "odor", "fragrancia", "perfume", "perfumacao", "essencia"]);
const ODOR_FREE_RE = /\b(?:sem|zero)\s+(?:cheiro|aroma|odor|fragrancia|perfume|perfumacao|essencia)\b|\bneutr[oa]s?\b|\binodor[oa]?\b/;
function nameHasNegation(neg: string, nameNorm: string): boolean {
  if (ODOR_WORDS.has(neg)) return ODOR_FREE_RE.test(nameNorm);
  return new RegExp(`\\b(sem|zero)\\s+${neg}\\b`).test(nameNorm);
}
// Pedido com "sem X": a opção que diz no nome que é a versão sem X? `null` = o pedido não tem "sem".
export function satisfiesNegation(query: string, name: string): boolean | null {
  const negs = negatedWords(query);
  if (!negs.length) return null;
  const nameNorm = normalizeText(name);
  return negs.every((neg) => nameHasNegation(neg, nameNorm));
}

// Produtos de higiene/beleza HUMANOS que também existem em versão pet — quando o
// cliente não falou de bicho, a versão pet não pode nem pontuar ("shampoo" não é
// shampoo de cachorro; "perfume" não é colônia de gato).
const HUMAN_PRODUCT_WORDS = new Set(["shampoo", "xampu", "condicionador", "perfume", "colonia", "sabonete", "desodorante", "escova"]);
// Qualquer marca de "é produto pet" no nome (inclui itens "para Cães E Gatos", que o
// species-guard deixa passar por servirem as duas espécies).
const PET_ANY_RE = /\b(caes|cao|cachorros?|gatos?|felinos?|caninos?|pet|aquario|peixes?|roedores?|passaros?)\b/;
// Palavras do cliente que JÁ são de pet mesmo sem citar o bicho ("ração", "petisco"):
// com elas, a penalidade de item-pet não faz sentido — todo candidato é pet.
const PET_INTRINSIC_RE = /\b(racao|racoes|petiscos?|bifinhos?|areia|coleiras?|arranhador|aquario|antipulgas|comedouro|bebedouro|guia)\b/;
// Marcas de item pet para a PENALIDADE geral. Sem o "pet" solto do PET_ANY_RE de
// propósito: em catálogo brasileiro "PET" é a garrafa plástica ("Coca-Cola Pet 2L"),
// então usá-lo aqui penalizava refrigerante como se fosse ração.
// Cabeça do nome, depois de até 2 palavras de marca ("Época Cosméticos Sacola Presenteável P").
const GIFT_WRAP_HEAD_RE = /^(?:[a-z0-9]+ ){0,2}(sacolas?|embalage\w*|papel|lacos?|fitas?|caixas? presente\w*|cartao presente|vale presente|gift card)\b/;
const GIFT_WRAP_ASK_RE = /\b(sacolas?|embalage\w*|papel|lacos?|fitas?|caixas?|cartao|vale|gift)\b/;
// Público (menino/menina/idade) qualifica o pedido de presente/brinquedo, mas raramente está
// no nome do produto: não conta na cobertura (06/10, A7: "brinquedo menino 5 anos" → nada).
const AUDIENCE_WORDS = new Set(["menino", "meninos", "menina", "meninas", "crianca", "criancas", "anos", "ano", "infantil", "bebe", "adolescente"]);
const ADULT_DIAPER_RE = /\b(adultos?|geriatric[ao]s?|incontinencia|bigfral|tena|plenitud|dauf)\b/;
const PET_SPECIES_RE = /\b(caes|cao|cachorros?|gatos?|felinos?|caninos?|aquario|peixes?|roedores?|passaros?)\b/;

// Variantes "processadas" que só devem vencer quando pedidas ("café" = torrado/moído,
// não sachê; "leite" nunca é condensado/fermentado/vegetal).
// "tonica"/"micelar"/"termal" entraram em 11/08: o conserto do encoding do Imigrantes
// destravou 30 águas antes invisíveis e a Água Tônica empatou com a mineral no pedido
// "agua" — mesma classe da sanitária/oxigenada (água que não é água de beber).
// "saborizada" entrou em 17/08: a varredura fit da colheita trouxe águas saborizadas
// zero pro catálogo e "água" seca passou a devolver maracujá em vez de mineral (golden).
// "instantaneo" (06/10, M5): "macarrão" é massa seca; o instantâneo (lámen) só quando pedido.
const PROCESSED_VARIANTS = new Set(["instantaneo", "instantanea", "soy", "condensado", "condensada", "soluvel", "sache", "saches", "capsula", "capsulas", "fermentado", "fermentada", "vegetal", "sanitaria", "oxigenada", "tonica", "micelar", "termal", "saborizada", "saborizado"]);
// "Leite DE COCO" é tão pouco "leite" quanto o de soja: quem pede leite quer o de vaca.
// A lista existia mas estava incompleta, e o coco (barato, 200ml) vencia o desempate de
// preço — pedir "leite" devolvia leite de coco.
const PROCESSED_BIGRAM_RE = /\bem po\b|\bde soja\b|\bde amendoas\b|\bde coco\b|\bde castanha\b|\bde aveia\b|\bde arroz\b/;
// Produto infantil/baby é variante: só rankeia bem se a query pedir criança.
// Vale pra fase de vida pet também: "ração" sem falar idade = adulto (não filhote/sênior).
// Exceção: categorias inerentemente infantis (fralda tem "Baby" no nome de fábrica).
const CHILD_VARIANT_RE = /\b(infantil|infantis|baby|boti baby|kids|junior|crianca|criancas|menino|menina|bebe|bebes|filhote|filhotes|senior)\b/;
const CHILD_NATIVE_RE = /\b(fraldas?|papinhas?|chupetas?|mamadeiras?|lenco(s)? umedecido(s)?)\b/;
// Substantivos de categoria que valem como "head" em qualquer posição do nome —
// beleza/higiene escondem o produto no meio do nome comercial.
const CATEGORY_NOUNS = new Set([
  "colonia", "perfume", "desodorante", "shampoo", "condicionador", "sabonete",
  "hidratante", "batom", "gloss", "rimel", "corretivo", "blush", "serum",
  "esmalte", "locao", "balm", "mascara", "protetor", "demaquilante", "esfoliante",
  // mercearia: substantivos que DEFINEM o produto mesmo enterrados no meio do nome
  // ("Pack Macarrão Instantâneo Lámen … Nissin MIOJO 510g" é um miojo)
  "miojo", "lamen",
  // apelidos de refrigerante ("Refrigerante GUARANÁ Antarctica 2L", "Refrigerante
  // FANTA Laranja") — o apelido identifica o produto em qualquer posição do nome
  "coca", "guarana", "fanta", "sprite", "pepsi", "tonica"
]);
// Versão "para mulher" de um produto sem gênero (Advil Mulher, Dorflex Mulher): variante de
// público, só na frente quando pedida (05/10: "advil" mostrou Advil Mulher em 1º).
const WOMAN_VARIANT_RE = /\bmulher(es)?\b/;
const WOMAN_ASK_RE = /\b(mulher|mulheres|feminin[oa]s?|menstrua\w*|colica)\b/;
function isChildVariant(nameNorm: string): boolean {
  return CHILD_VARIANT_RE.test(nameNorm) && !CHILD_NATIVE_RE.test(nameNorm);
}
// Fardo/pack de BEBIDA só quando pedido ("coca 2l" = 1 garrafa, não 6un) — a regra exige
// marcador de volume no nome pra não punir fraldas/papel ("60 Unidades" é o normal lá).
const PACK_ASK_RE = /\b(fardo|pack|caixa|kit|engradado)\b/;
function isDrinkPack(nameNorm: string): boolean {
  // Só é fardo de BEBIDA com marcador de volume no nome — "Pack Macarrão Instantâneo
  // Lámen … Miojo 510g 6 Unidades" é o produto normal, não um engradado de refri.
  const drinkVolume = /\b(ml|l|litros?)\b|\d(l|ml)\b/.test(nameNorm);
  if (/\b(fardo|pack|engradado)\b/.test(nameNorm)) return drinkVolume;
  return /\b\d+\s+(un|unidades|garrafas|latas)\b/.test(nameNorm) && drinkVolume;
}
// Variantes "de dieta/estilo" usadas só como DESEMPATE (quem pede "arroz" quer o comum;
// quem pede "leite" aceita integral/desnatado — ambos são leite). Termos veterinários
// entram aqui: "ração" genérica não deve dar Veterinary Diets/Hipoalergênica primeiro.
const TIEBREAK_VARIANTS = new Set(["integral", "desnatado", "desnatada", "semidesnatado", "zero", "diet", "light", "organico", "organica", "vegano", "vegana", "hipoalergenica", "hipoalergenico", "veterinary", "vet", "terapeutica", "terapeutico", "castrados", "castrado", "castradas", "gas"]);

// Nº de palavras de variante no nome que o cliente NÃO pediu — usado como desempate
// (menos variantes = mais "produto básico"). O que vem depois de "sabor" é descrição
// de sabor, não variante ("Sabor Frango e Arroz Integral" não é ração integral).
export function variantCount(query: string, item: CatalogItem): number {
  const qTokens = new Set(queryTokens(query));
  const beforeSabor = normalizeText(item.name).split(/\bsabor\b/)[0];
  const nameWords = words(beforeSabor);
  let count = nameWords.filter((w, i) => TIEBREAK_VARIANTS.has(w) && !qTokens.has(w) && nameWords[i - 1] !== "sem").length;
  // "Sem Açúcar"/"Sem Lactose" no NOME é variante não pedida — "coca" genérica prefere
  // a original. Pedir "sem açúcar" (ou o equivalente "zero"/"diet"/"light") desliga.
  for (const m of beforeSabor.matchAll(/\bsem\s+([a-z]\S*)/g)) {
    const negated = m[1];
    // "Sem Gás" nega uma VARIANTE: é a versão básica, não outra variante (06/10: "água
    // mineral 1,5l" punha a com gás na frente por empate).
    if (TIEBREAK_VARIANTS.has(negated)) continue;
    const asked =
      qTokens.has(negated) ||
      (negated === "acucar" && ["zero", "diet", "light"].some((t) => qTokens.has(t)));
    if (!asked) count += 1;
  }
  return count;
}

// A bare "coca" means a normal individual drink or a familiar family bottle, not
// the cheapest 200 ml mini bottle. Explicit sizes still win through scoreCatalogMatch.
// This is a tie-break only, so brand/relevance guards remain authoritative.
export function commonPackageRank(query: string, item: CatalogItem): number {
  const queryNorm = normalizeText(query);
  if (!/\bcocas?(?: colas?)?\b/.test(queryNorm) || /\d+(?:[.,]\d+)?\s*(?:ml|l|lt|litros?)\b/.test(queryNorm)) return 0;
  const name = normalizeText(item.name);
  if (/\b(?:310|350)\s*ml\b/.test(name)) return 0;
  if (/\b600\s*ml\b/.test(name)) return 1;
  if (/\b2\s*(?:l|litros?)\b/.test(name)) return 2;
  if (/\b1[,.]5\s*(?:l|litros?)\b/.test(name)) return 3;
  if (/\b1\s*(?:l|litros?)\b/.test(name)) return 4;
  if (/\b(?:200|220)\s*ml\b/.test(name)) return 9;
  return 5;
}

// Size-normalized form of a name/attr so "2 Litros", "2L", "2 lt" and "2l" all compare
// equal, and decimals survive ("1,5L" -> "1,5l"). Used by attrMatchesItem only.
function normSize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/litros?|\blts?\b/g, "l")
    // "1.5L" e "1,5L" são o mesmo tamanho (06/10, A9: "água mineral 1,5l" não achava "1.5L").
    .replace(/(\d)\.(\d)/g, "$1,$2")
    .replace(/(\d)\s+(?=(kg|g|ml|l)\b)/g, "$1");
}

// Does a refinement attribute ("azul", "grande", "2kg", "1,5l") ACTUALLY apply to this
// item? Sizes/weights use a digit-boundary substring on the size-normalized name (so
// "5l" does NOT match "1,5l"); word attributes use the normal catalog scorer.
export function attrMatchesItem(attr: string, item: CatalogItem): boolean {
  const a = normSize(attr);
  if (/\d/.test(a)) {
    const hay = normSize(`${item.name} ${item.brand ?? ""}`);
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^0-9,.])${esc}($|[^0-9a-z])`).test(hay);
  }
  // Atributo-palavra ("azul", "grande", "desnatado", "sem lactose"): match direto nas
  // palavras do nome — atributos vivem no MEIO do nome, então o funil de busca
  // (piso/head) não se aplica aqui.
  const nameWords = words(`${item.name} ${item.brand ?? ""}`);
  return words(a).every((t) => nameWords.some((w) => tokenMatchesWordSyn(t, w)));
}

// Descobre refinamentos diretamente no catálogo, sem uma lista específica por produto.
// "sabor morango", "cor azul", "tamanho 42", "lavanda" e uma marca nova funcionam
// desde que a característica exista em algum candidato da busca que já está na tela.
export function inferCatalogRefinement(text: string, candidates: CatalogItem[]): string[] | null {
  const labels = new Set(["cor", "tamanho", "sabor", "gosto", "cheiro", "aroma", "fragrancia", "modelo", "versao", "marca", "tipo"]);
  const attrs = queryTokens(text).filter((token) => !labels.has(token));
  if (!attrs.length || attrs.length > 4) return null;
  return candidates.some((item) => attrs.every((attr) => attrMatchesItem(attr, item))) ? attrs : null;
}

const PACK_COUNT_RE = /\b(\d{1,3})\s*(bolas?|rolos?|capsulas?|comprimidos?|saches?|folhas?|metros?|pares?|tabletes?)\b/g;
const packUnit = (unit: string) => unit.replace(/s$/, "");

// Token de medida: tamanho, volume, peso ou dose. Soma score de variante, nunca segura relevância.
// Unidade solta ("leite 2 litros" vira os tokens "2" e "litros"): é medida, não produto.
const UNIT_WORDS = new Set(["litro", "litros", "lt", "lts", "kg", "quilo", "quilos", "kilo", "kilos", "grama", "gramas", "ml", "mg", "g", "l"]);
const MEASURE_TOKEN_RE = /^\d+(?:[.,]\d+)?(?:kg|g|mg|mcg|ui|ml|l|lt|lts|litros?|quilos?|kilos?|gramas?|un)$/;

// Nome equivalente do produto conta como o próprio pedido (06/10, A9): "sabão em pó" casa
// com "Lava Roupas em Pó Omo" — na busca, no piso do concierge e no "tira o X".
// "leite 2 litros" → "leite 2litros": número + unidade é UMA medida (06/10, A9). Separados, o
// "litros" contava como palavra do produto e "Fanta 2 Litros" vencia o leite.
function joinMeasures(query: string): string {
  return query.replace(/(\d+(?:[.,]\d+)?)\s+(litros?|lts?|quilos?|kilos?|kg|gramas?|ml|mg|g|l)\b/gi, "$1$2");
}
// Fatos da CONSULTA memorizados (08/10/2026, placar): `scoreQuery` roda uma vez por item do catálogo
// (~80 mil por consulta) e recalculava tokens, negações e normalizações da MESMA consulta em cada um.
// Mapa limitado (zera ao encher); os arrays são só leitura.
type QueryFacts = { tokens: string[]; negs: string[]; norm: string; sizeNorm: string; words: string[] };
const QUERY_MEMO_MAX = 512;
const queryFactsMemo = new Map<string, QueryFacts>();
function queryFacts(query: string): QueryFacts {
  let facts = queryFactsMemo.get(query);
  if (!facts) {
    if (queryFactsMemo.size >= QUERY_MEMO_MAX) queryFactsMemo.clear();
    facts = { tokens: queryTokens(query), negs: negatedWords(query), norm: normalizeText(query), sizeNorm: normSize(query), words: words(query) };
    queryFactsMemo.set(query, facts);
  }
  return facts;
}
const scoreQueriesMemo = new Map<string, { query: string; aliases: string[] }>();
function scoreQueries(rawQuery: string): { query: string; aliases: string[] } {
  let entry = scoreQueriesMemo.get(rawQuery);
  if (!entry) {
    if (scoreQueriesMemo.size >= QUERY_MEMO_MAX) scoreQueriesMemo.clear();
    const query = joinMeasures(rawQuery);
    entry = { query, aliases: queryAliases(query) };
    scoreQueriesMemo.set(rawQuery, entry);
  }
  return entry;
}

export function scoreCatalogMatch(rawQuery: string, item: CatalogItem): number {
  const { query, aliases } = scoreQueries(rawQuery);
  const own = scoreQuery(query, item);
  return aliases.length ? Math.max(own, ...aliases.map((alias) => scoreQuery(alias, item))) : own;
}

// Texto do item já normalizado, memorizado por objeto (08/10/2026, placar): `rankCatalog` varre ~80 mil
// itens por consulta e normalizar nome/marca/categoria a cada consulta era metade da CPU da busca
// (perfil: normalizeText + words ≈ 3,5 s de 7,5 s). O memo confere nome/marca/categoria, então item
// reescrito no lugar nunca usa texto velho. Os arrays são só leitura.
type ItemText = {
  name: string;
  brand: string;
  category: string;
  nameNorm: string;
  nameWords: string[];
  // nome sem as palavras negadas ("Sem Perfume", "Zero Açúcar") — ver scoreQuery
  nameWordsNoNeg: string[];
  brandWords: string[];
  categoryWords: string[];
  categoryNorm: string;
};
const itemTextMemo = new WeakMap<CatalogItem, ItemText>();
function itemText(item: CatalogItem): ItemText {
  const brand = item.brand ?? "";
  const category = item.category ?? "";
  const memo = itemTextMemo.get(item);
  if (memo && memo.name === item.name && memo.brand === brand && memo.category === category) return memo;
  const nameNorm = normalizeText(item.name);
  const nameNegated = new Set([...nameNorm.matchAll(/\b(?:sem|zero)\s+([a-z]\S*)/g)].map((m) => m[1]));
  const nameWords = words(item.name);
  const text: ItemText = {
    name: item.name,
    brand,
    category,
    nameNorm,
    nameWords,
    nameWordsNoNeg: nameNegated.size ? nameWords.filter((w) => !nameNegated.has(w)) : nameWords,
    brandWords: words(brand),
    categoryWords: words(category),
    categoryNorm: normalizeText(category)
  };
  itemTextMemo.set(item, text);
  return text;
}

function scoreQuery(query: string, item: CatalogItem): number {
  const q = queryFacts(query);
  const tokens = q.tokens;
  if (!tokens.length) return 0;
  const text = itemText(item);
  const nameNorm = text.nameNorm;
  // "Sem Perfume"/"Zero Açúcar" no NOME: a palavra negada não é o produto — pedir
  // "perfume" jamais deve trazer "Antitranspirante Sem Perfume". Ela sai do match
  // de score (attrMatchesItem continua vendo o nome inteiro pra "sem lactose").
  // ("zero 2 litros" não nega o "2" — só palavra, nunca número/tamanho)
  const nameWords = text.nameWordsNoNeg;
  const brandWords = text.brandWords;
  const categoryWords = text.categoryWords;

  // "café SEM açúcar": açúcar é exclusão. Item cujo nome carrega a palavra negada só
  // sobrevive se for a versão "sem X" de verdade.
  const negs = q.negs;
  const negTokens = new Set(negs);
  const effTokens = tokens.filter((t) => !negTokens.has(t));
  if (!effTokens.length) return 0;
  // Regras de "pedido de UMA palavra" contam só palavras — "leite 2litros" é pedido de uma
  // palavra com medida (06/10: sem isso, "Leite de Rosas" empatava com o leite de caixinha).
  const wordEff = effTokens.filter((t) => !MEASURE_TOKEN_RE.test(t));
  for (const neg of negs) {
    if (new RegExp(`\\b${neg}\\b`).test(nameNorm) && !new RegExp(`\\b(sem|zero)\\s+${neg}\\b`).test(nameNorm)) {
      return 0;
    }
  }

  // Embalagem nunca é o presente (06/10, A7: "presente pra minha mãe até R$100" → "Sacola
  // Presenteável P" de R$5,49). Pedido de presente só traz sacola/papel/cartão-presente quando
  // a pessoa pediu a embalagem.
  const queryNormEarly = q.norm;
  if (/\bpresentes?\b/.test(queryNormEarly) && GIFT_WRAP_HEAD_RE.test(nameNorm) && !GIFT_WRAP_ASK_RE.test(queryNormEarly)) return 0;

  // Species guard: a dog request must NEVER surface cat food (or vice versa).
  const queryAnimal = animalOf(effTokens);
  const itemAnimal = animalOf(nameWords, true);
  if (queryAnimal && itemAnimal && queryAnimal !== itemAnimal) return 0;
  // Produto humano vs versão pet: quem pede "shampoo"/"perfume" sem falar de bicho
  // NUNCA quer a versão de cachorro/gato/aquário (nem a "para Cães e Gatos").
  if (!queryAnimal && PET_ANY_RE.test(nameNorm) && effTokens.some((t) => HUMAN_PRODUCT_WORDS.has(t))) return 0;

  let score = 0;
  let strongHit = false;
  for (const token of effTokens) {
    // Token de TAMANHO ("2kg", "350ml") nunca segura a relevância sozinho — senão
    // "arroz 2kg" traz "Areia Higiênica 2Kg" (só o peso em comum). Ele soma score,
    // mas o produto precisa de um token de PALAVRA forte pra passar do piso.
    // 06/10 (A8): DOSE ("600mg", "20mcg", "400ui") também é medida, nunca identidade —
    // "ibuprofeno 600mg" trazia "Sintocalmy 600mg" (outro princípio ativo, só a dose em comum).
    const isSizeToken = MEASURE_TOKEN_RE.test(token);
    if (brandWords.some((word) => tokenMatchesBrand(token, word))) {
      score += 4; // explicit brand match is the strongest signal
      if (!isSizeToken) strongHit = true;
    } else if (nameWords.some((word) => tokenMatchesWordSyn(token, word))) {
      score += token.length >= 4 ? 2 : 1;
      // Forte = token de 4+ letras, OU palavra curta que casa EXATA ("pão", "sal", "chá").
      if (!isSizeToken && (token.length >= 4 || (token.length >= 3 && nameWords.includes(token)))) strongHit = true;
    } else if (categoryWords.some((word) => tokenMatchesWord(token, word))) {
      // Categoria é sinal legítimo pra tokens específicos ("perfume" → "perfumaria").
      score += 1;
      if (token.length >= 5) strongHit = true;
    }
  }
  // Piso de relevância: sem pelo menos UM token forte, é ruído conversacional —
  // devolver vazio honesto em vez de "Esponja Não Risca".
  if (!strongHit) return 0;
  // Especificação técnica pedida (usb, usb-c, hdmi, bluetooth…) é identidade: item sem ela
  // não é o produto (27/09: "cabo usb c" trazia "Cabo Flexível 6mm² por metro" da Obramax).
  const specAsked = effTokens.filter((t) => SPEC_TOKENS.has(t));
  if (specAsked.length) {
    const nameCompounds = new Set(queryTokens(item.name));
    if (specAsked.some((t) => !nameCompounds.has(t) && !nameWords.some((w) => tokenMatchesWordSyn(t, w)) && !categoryWords.some((w) => tokenMatchesWord(t, w)))) return 0;
  }

  // Remédio (06/10, A8): a DOSE pedida é identidade — "ibuprofeno 600mg" nunca vira o de
  // 100mg/ml. Item de remédio que declara dose e nenhuma bate sai; a mesma dose sobe.
  const doseAsks = [...q.norm.matchAll(/(\d+(?:[.,]\d+)?)\s*(mg|mcg)\b/g)].map((m) => `${m[1]}${m[2]}`);
  if (doseAsks.length && item.medicine) {
    const doses = new Set([...nameNorm.matchAll(/(\d+(?:[.,]\d+)?)\s*(mg|mcg)\b/g)].map((m) => `${m[1]}${m[2]}`));
    if (doses.size && !doseAsks.some((d) => doses.has(d))) return 0;
    if (doseAsks.some((d) => doses.has(d))) score += 3;
  }

  // Tamanho pedido ("coca 2 litros", "arroz 5kg") é sinal forte: item com o tamanho
  // certo sobe; item com OUTRO tamanho explícito perde força.
  // normSize (não normalizeText): "1,5l" continua 1,5 — normalizeText apagava a vírgula e o
  // pedido virava "5l" (06/10, A9: "água mineral 1,5l" trazia galão de 5 L).
  const sizeAsks = [...q.sizeNorm.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|lt|litros?)\b/g)];
  for (const m of sizeAsks) {
    const attr = `${m[1]}${m[2].replace(/litros?|lts?$/, "l")}`;
    if (attrMatchesItem(attr, item)) score += 3;
    else score -= 1;
  }

  // Contagem na embalagem pedida ("tubo com 4 bolas", "papel higiênico 12 rolos", "30
  // cápsulas") é identidade (06/10, tio Semy pediu o tubo com 4 bolas e veio o de 3): item
  // que declara OUTRA contagem do mesmo substantivo não é o produto; a mesma contagem sobe.
  // Fora daqui "unidades"/"latas", que o cliente também usa como quantidade a comprar.
  const countAsks = [...q.norm.matchAll(PACK_COUNT_RE)].map((m) => ({ n: Number(m[1]), unit: packUnit(m[2]) }));
  if (countAsks.length) {
    const declared = [...nameNorm.matchAll(PACK_COUNT_RE)].map((m) => ({ n: Number(m[1]), unit: packUnit(m[2]) }));
    for (const ask of countAsks) {
      const sameUnit = declared.filter((d) => d.unit === ask.unit);
      if (sameUnit.length && !sameUnit.some((d) => d.n === ask.n)) return 0;
      if (sameUnit.some((d) => d.n === ask.n)) score += 3;
    }
  }

  // Head-noun bonus: o head EFETIVO pula as palavras da marca ("Quem Disse, Berenice?
  // BASE Líquida" → head = "base"), senão nome com marca na frente nunca ganha o bônus.
  // Substantivo de categoria no MEIO do nome vale como head também: "Pack Macarrão
  // Instantâneo Lámen … Nissin MIOJO 510g" é um miojo tanto quanto "Miojo Nissin …" —
  // sem isso, o item certo com nome comercial comprido perde de qualquer coisa cujo
  // nome COMEÇA com a palavra parecida.
  const brandSet = new Set(brandWords);
  const headWord = nameWords.find((w) => !brandSet.has(w)) ?? nameWords[0];
  const headHit = Boolean(headWord && effTokens.some((token) => tokenMatchesWordSyn(token, headWord)));
  const categoryHit = effTokens.some((token) =>
    nameWords.some((w) => CATEGORY_NOUNS.has(w) && tokenMatchesWordSyn(token, w))
  );
  if (score > 0 && (headHit || categoryHit)) score += 2;
  // Pedido de UMA palavra ("ovos", "frango"): se ela não é o head nem a marca, o item
  // costuma ser outra coisa que só CONTÉM a palavra (Macarrão COM Ovos, Petisco DE
  // Frango) — zera. O que separa esses do caso legítimo é a PREPOSIÇÃO: em "Macarrão com
  // Ovos" a palavra é ingrediente/qualificador; em "Hastes Flexíveis Cotonetes" ela está
  // justaposta ao head, nomeando o mesmo produto (e o cliente pede exatamente por ela).
  // Sem esta distinção, pedir "cotonete" não achava o cotonete que está no catálogo.
  // Substantivo de categoria vale em qualquer posição pelo mesmo motivo (beleza enterra
  // o nome no meio: "Celebre Agora Feminino Desodorante COLÔNIA 100ml" é um perfume).
  const QUALIFIER_MARKERS = new Set(["com", "de", "da", "do", "sem", "sabor", "para", "pra", "em", "tipo", "c"]);
  // A apposição exige a MESMA palavra (ou plural dela), não o prefixo folgado que serve
  // pra "refri"→"refrigerante": senão "leite" entra por "Iogurte Grego LEITERIA" e a
  // exceção vira um buraco maior que a regra.
  // …e só na frase inicial do nome (até a 3ª palavra), que é onde o catálogo brasileiro
  // põe o produto. No fim do nome a palavra é sabor/complemento — "Petisco para Cachorro
  // Purina FRANGO" não responde por "frango", mesmo sem preposição antes.
  const appositionHit = effTokens.some((token) =>
    nameWords.some((word, i) => isSameNoun(token, word) && i > 0 && i <= 2 && !QUALIFIER_MARKERS.has(nameWords[i - 1]))
  );
  if (
    wordEff.length === 1 &&
    !headHit &&
    !categoryHit &&
    !appositionHit &&
    !brandWords.some((w) => tokenMatchesBrand(wordEff[0], w))
  ) {
    return 0;
  }

  if (score > 0) {
    // INVARIANTE das linhas abaixo: penalidade REORDENA, nunca exclui. Quem exclui são as
    // guardas que dão `return 0` (espécie, negação, piso de relevância, pedido de uma
    // palavra). Isso importa porque `score > 0` é lido como "casa ou não casa" fora daqui
    // — `itemMatchesPhrase`, do "tira o X", é um deles. Sem o piso no fim, duas
    // penalidades somadas derrubavam um match legítimo de head e o cliente não conseguia
    // mais remover o item da cesta ("Acessório de Comedouro … para Cães" ficava em -1).
    const beforePenalties = score;
    // Quem pediu "sem X" quer a VERSÃO sem X: o item que diz "Sem/Zero Lactose" no nome
    // deve vencer o leite comum (que também sobrevive à exclusão por nem citar X).
    for (const neg of negs) {
      if (nameHasNegation(neg, nameNorm)) score += 3;
    }
    // "hidratante" achava "Sabonete Líquido HIDRATANTE" (re-teste 15/08, rodada 10):
    // quando um substantivo de categoria DIFERENTE vem ANTES da palavra pedida no nome,
    // o head real é o outro produto e a palavra pedida é adjetivo dele. Penaliza
    // (reordena) — o hidratante de verdade passa na frente; o sabonete segue como
    // fallback honesto quando não existe o produto puro.
    if (wordEff.length === 1) {
      const requested = wordEff[0];
      const requestedIdx = nameWords.findIndex((w) => tokenMatchesWordSyn(requested, w));
      if (
        requestedIdx > 0 &&
        nameWords.slice(0, requestedIdx).some((w) => CATEGORY_NOUNS.has(w) && !tokenMatchesWordSyn(requested, w))
      ) {
        score -= 2;
      }
    }
    // Staple-first: quem não pediu sachê/úmida/cápsula/fardo quer o produto básico.
    const wantsWet = effTokens.some((token) => WET_WORDS.has(token));
    // (PET_ANY_RE cobre "para Cães e Gatos", que deixa itemAnimal ambíguo)
    if ((itemAnimal || PET_ANY_RE.test(nameNorm)) && nameWords.some((word) => WET_WORDS.has(word)) && !wantsWet) score -= 2;
    const queryNorm = q.norm;
    const wantsProcessed = effTokens.some((t) => PROCESSED_VARIANTS.has(t)) || PROCESSED_BIGRAM_RE.test(queryNorm);
    // "em pó" é a forma BÁSICA do achocolatado (Nescau/Toddy) — só é variante
    // processada nos outros produtos ("leite em pó" continua perdendo pro leite).
    const processedHay = /\bachocolatado\b/.test(nameNorm) ? nameNorm.replace(/\bem po\b/g, " ") : nameNorm;
    if (!wantsProcessed && (nameWords.some((w) => PROCESSED_VARIANTS.has(w)) || PROCESSED_BIGRAM_RE.test(processedHay))) score -= 2;
    if (!PACK_ASK_RE.test(queryNorm) && isDrinkPack(nameNorm)) score -= 2;
    // Quem não falou de bicho não está pedindo a versão pet. A guarda dura acima só vale
    // pra higiene/beleza; aqui é a versão geral, e como PENALIDADE (não zero) porque
    // existe item que só existe em versão pet. Palavra intrinsecamente pet desliga:
    // pedir "ração" não pode punir toda ração por ela dizer "Cães" no nome.
    // 06/10 (M5): a CATEGORIA da loja também diz que é pet ("Fralda … para Macho Petix" está em
    // "cachorro higiene e limpeza") — "fralda" mostrava fralda de cachorro.
    const petHay = `${nameNorm} ${text.categoryNorm}`;
    if (!queryAnimal && PET_SPECIES_RE.test(petHay) && !PET_INTRINSIC_RE.test(queryNorm)) score -= 3;
    // Variante de PÚBLICO na fralda (06/10, M5): "fralda"/"fralda XG" é a infantil; a geriátrica
    // só quando pedida (vinham 3 Bigfral adulto para "fralda XG").
    if (/\bfraldas?\b/.test(nameNorm) && ADULT_DIAPER_RE.test(nameNorm) && !ADULT_DIAPER_RE.test(queryNorm) && !/\b(idos[oa]s?|velh[oa]s?|vovo|vo)\b/.test(queryNorm)) score -= 3;
    // Higiene/beleza pedida sem falar de remédio (06/10, M5): o produto com DOSE ou "genérico"
    // no nome é medicamento ("Shampoo Cetoconazol 20mg/ml Genérico") e vai para trás.
    if (effTokens.some((t) => HUMAN_PRODUCT_WORDS.has(t)) && /\b\d+(?:[.,]\d+)?\s*mg\b|\bgenerico\b/.test(nameNorm) && !/\b(mg|generico|remedio|anticaspa|cetoconazol)\b/.test(queryNorm)) score -= 2;
    // Pedido de UMA palavra genérica ("leite", "ovos", "café") = o produto básico. Um
    // qualificador "DE x" que o cliente não pediu troca o TIPO do produto, não a variante:
    // "Leite de Rosas" é loção de pele, "Leite de Coco" é ingrediente, "Ovos de Codorna"
    // é outro ovo. Isto generaliza a lista fixa acima (que só tinha soja/amêndoas) — sem
    // ela, quem pedia "leite" recebia loção, porque o desempate caía no preço.
    // 27/09 (golden "leite"): a palavra pedida que só aparece DEPOIS de "de/com" é
    // ingrediente de outro produto — "Sorvete Doce de Leite", "Creme de Leite", "Pão de
    // Queijo" — e perde para o produto que É aquilo. Penalidade (reordena), não exclusão.
    if (wordEff.length === 1 && !headHit) {
      const requested = wordEff[0];
      const asIngredient = nameWords.some((w, i) => i > 0 && isSameNoun(requested, w) && (nameWords[i - 1] === "de" || nameWords[i - 1] === "com"));
      const asProduct = nameWords.some((w, i) => isSameNoun(requested, w) && (i === 0 || (nameWords[i - 1] !== "de" && nameWords[i - 1] !== "com")));
      if (asIngredient && !asProduct) score -= 3;
    }
    // "Leiteira" não é leite: casou só por prefixo com palavra MAIS LONGA (derivada), sem ser
    // o mesmo substantivo nem abreviação conhecida. Penaliza quando o pedido é a palavra inteira.
    if (wordEff.length === 1 && wordEff[0].length >= 5) {
      const requested = wordEff[0];
      const exactSomewhere = nameWords.some((w) => isSameNoun(requested, w));
      const derived = nameWords.some((w) => w.startsWith(requested) && w.length - requested.length >= 3 && !isSameNoun(requested, w));
      if (derived && !exactSomewhere) score -= 2;
    }
    if (wordEff.length === 1) {
      const asked = new Set(effTokens);
      const unrequested = [...nameNorm.matchAll(/\bde\s+([a-z]{3,})\b/g)].filter(
        (m) => !asked.has(m[1]) && !q.words.includes(m[1])
      );
      if (unrequested.length) score -= 2;
    }
    // Versão infantil/baby só quando pedida ("perfume" pra adulto não pode virar
    // Boti Baby; "shampoo" não pode virar Johnson's Baby). Pedir "infantil" inverte.
    if (!CHILD_VARIANT_RE.test(queryNorm) && isChildVariant(nameNorm)) score -= 2;
    if (!WOMAN_ASK_RE.test(queryNorm) && WOMAN_VARIANT_RE.test(nameNorm)) score -= 2;
    if (beforePenalties > 0) score = Math.max(1, score);
  }
  return score;
}

// Piso de relevância do CONCIERGE — mais exigente que o `scoreCatalogMatch > 0` do fluxo
// legado, e de propósito.
//
// No fluxo legado, um match fraco era o melhor disponível: ou mostrava aquilo, ou não
// mostrava nada. No concierge existe uma saída melhor — a linha livre, que o operador
// garimpa à mão. Então um palpite errado é PIOR que nenhum palpite: sugerir "Espumante
// Concerto" para quem pediu "conserto de torneira" (caso real, o fuzzy casa conserto≈concerto)
// queima confiança, enquanto cair na linha livre resolve o pedido de verdade.
//
// A regra é COBERTURA da consulta, não score: o item precisa responder por todas as palavras
// que o cliente usou. Consulta curta (1–2 palavras) é o próprio substantivo — qualquer palavra
// solta invalida. Consulta longa carrega qualificadores ("escova de dente macia"), então uma
// palavra sem correspondência é tolerada. Tokens de tamanho ("2kg", "350ml") nunca contam:
// eles são filtro de variante, não identidade do produto.
// `allTokens` (06/10, A6): cobertura TOTAL — o item responde por todas as palavras do pedido
// (marca e espécie inclusas). Usado para decidir se um tamanho pedido pode filtrar a vitrine.
const ACCESSORY_HEADS = new Set([
  "copo", "copos", "caneca", "canecas", "taca", "tacas", "jarra", "garrafinha", "squeeze", "abridor", "porta", "suporte",
  "chaveiro", "camiseta", "camisa", "bone", "toalha", "balde", "cooler", "bolsa", "mochila", "estojo", "capa", "adesivo",
  "ima", "pelucia", "boneco", "miniatura", "luminaria", "placa", "quadro", "poster", "fantasia"
]);
// Item do dia a dia pedido SEM qualificador (09/10, rodada de cliente com a IA ligada): "óleo" é óleo de cozinha
// (era "Óleo Secante Color" de unha sem a IA, e "não achei" com ela); "feijão" é o carioca; "açúcar", o refinado.
// `accept` = o que o nome precisa ter pra ser o produto; `prefer` = a versão comum, que vem primeiro.
const STAPLE_DEFAULTS: Record<string, { accept?: RegExp; reject?: RegExp; prefer: RegExp }> = {
  oleo: {
    accept: /\b(soja|girassol|milho|canola|oliva|olliva|algodao|cozinha|composto)\b/,
    reject: /\b(corporal|corpo|capilar|cabelo|hidratante|massagem|bebe|pele|facial|rosto|banho|unha|maquina|madeira)\b/,
    prefer: /\bsoja\b/
  },
  feijao: { prefer: /\bcarioca\b/ },
  acucar: { prefer: /\b(refinado|cristal)\b/ },
  // "2kg de frango" (rodada 4, M8): o corte do dia a dia vem antes de passarinho/asa/coração.
  frango: { prefer: /\b(peito|coxa|sobrecoxa|file|filezinho|inteiro)\b/ }
};
export function stapleFor(query: string): { accept?: RegExp; reject?: RegExp; prefer: RegExp } | undefined {
  const core = queryTokens(normalizeText(query)).filter((t) => !/^\d/.test(t) && !MEASURE_TOKEN_RE.test(t) && !UNIT_WORDS.has(t));
  return core.length === 1 ? STAPLE_DEFAULTS[core[0]] : undefined;
}
export function conciergeMatchIsStrong(rawQuery: string, item: CatalogItem, opts?: { allTokens?: boolean }): boolean {
  const query = joinMeasures(rawQuery);
  return [query, ...queryAliases(query)].some((q) => strongFor(q, item, opts));
}

function strongFor(query: string, item: CatalogItem, opts?: { allTokens?: boolean }): boolean {
  if (scoreQuery(query, item) <= 0) return false;

  const negs = new Set(negatedWords(query));
  const wordTokens = queryTokens(query).filter(
    (token) => !negs.has(token) && !MEASURE_TOKEN_RE.test(token) && !/^\d+$/.test(token) && !UNIT_WORDS.has(token)
  );
  // Pedido de presente/brinquedo: o público (menino, 5 anos) não precisa estar no nome.
  if (/\b(brinquedos?|presentes?)\b/.test(normalizeText(query))) {
    const core = wordTokens.filter((token) => !AUDIENCE_WORDS.has(token));
    if (core.length) wordTokens.splice(0, wordTokens.length, ...core);
  }
  if (!wordTokens.length) return false;

  const text = itemText(item);
  const nameWords = text.nameWords;
  const brandWords = text.brandWords;
  const categoryWords = text.categoryWords;
  const nameCompounds = new Set(queryTokens(item.name));
  const isCovered = (token: string) =>
    nameCompounds.has(token) ||
    nameWords.some((word) => tokenMatchesWordSyn(token, word)) ||
    brandWords.some((word) => tokenMatchesWord(token, word)) ||
    categoryWords.some((word) => tokenMatchesWord(token, word));
  const covered = wordTokens.filter(isCovered).length;

  const missing = wordTokens.length - covered;
  // 06/10 (testador: "cottage da Yorgus 14g proteína" → iogurte Yorgus 14g): a palavra que
  // falta não pode ser a 1ª — em português o pedido começa pelo produto ("cottage", "leite",
  // "ração"); marca e atributos sozinhos não fazem o produto.
  if (wordTokens.length > 2 && !opts?.allTokens && missing === 1 && !isCovered(wordTokens[0])) return false;
  // 27/09 (golden "cabo usb c 2 metros"): especificação técnica pedida é identidade do
  // produto, nunca qualificador tolerável — "cabo usb" não pode virar cabo elétrico de obra.
  // O nome também passa pelos compostos: "Cabo Tipo C" vira "usbc", como o pedido.
  const nameTokens = new Set(queryTokens(item.name));
  // Acessório que leva o nome da marca (09/10, rodada de cliente: "2 cocas" → "Copo Vidro Americano Coca-Cola"):
  // o produto é o COPO, não a bebida. Nome que começa com acessório não pedido nunca é o produto pedido.
  const head = normalizeText(item.name).split(/\s+/)[0] ?? "";
  if (ACCESSORY_HEADS.has(head) && !wordTokens.includes(head) && !wordTokens.some((t) => ACCESSORY_HEADS.has(t))) return false;
  const staple = stapleFor(query);
  if (staple?.accept && (!staple.accept.test(normalizeText(item.name)) || staple.reject?.test(normalizeText(item.name)))) return false;
  const specMissing = wordTokens.some((token) => SPEC_TOKENS.has(token) && !nameTokens.has(token) &&
    !nameWords.some((word) => tokenMatchesWordSyn(token, word)) && !categoryWords.some((word) => tokenMatchesWord(token, word)));
  if (specMissing) return false;
  return wordTokens.length <= 2 || opts?.allTokens ? missing === 0 : missing <= 1;
}

// ---------- Piso da PRATELEIRA pelo substantivo-cabeça (08/10/2026, placar da recomendação) ----------
// O piso da recomendação usava `conciergeMatchIsStrong` com a consulta DECORADA ("bolo pronto",
// "sanduiche pronto", "prato pronto congelado"), que exige todas as palavras: "Bolo de Chocolate Ana
// Maria" caía (não diz "pronto") e a prateleira ficava vazia — o cliente via panetone de farmácia como
// único "bolo". Aqui a régua é o SUBSTANTIVO-CABEÇA da consulta (a 1ª palavra de conteúdo: "bolo",
// "sanduiche", "lasanha"), que precisa ser a cabeça do NOME (posição de título), e as demais palavras
// de conteúdo precisam estar no item como no piso do concierge — menos as palavras de ESTADO
// ("pronto", "congelado"), que nome de produto quase nunca carrega. Posição de título:
// - entre as 3 primeiras palavras do nome, sem preposição antes ("Pão DE Queijo" não é queijo) e sem
//   outro substantivo de categoria antes ("Esmalte Dailus Bolo de Chocolate" é esmalte, não bolo);
// - ou a 1ª palavra que não é da marca; ou a própria marca ("doritos" → "Salgadinho Doritos");
// - ou substantivo de categoria de beleza em qualquer posição (como no ranking: "Natura Kaiak
//   Feminino Desodorante Colônia" é perfume).
// Consulta de 2+ palavras também passa quando TODAS estão no item e qualquer uma está em posição de
// título ("batata chips" × "Chips de Batata Pringles"). Diminutivo conta como o mesmo substantivo, no
// mesmo gênero ("bolinho" = bolo, "salgadinho" = salgado; "bolinha" não é bolo).
// As guardas duras do ranking continuam valendo (negação "sem X", embalagem de presente, espécie,
// produto humano × pet) — ver `hardExclusion`.
const STATE_WORDS = new Set(["pronto", "pronta", "prontos", "prontas", "congelado", "congelada", "congelados", "congeladas", "refrigerado", "refrigerada", "refrigerados", "refrigeradas", "gelado", "gelada", "gelados", "geladas"]);
const HEAD_MARKERS = new Set(["com", "de", "da", "do", "das", "dos", "sem", "sabor", "para", "pra", "em", "tipo", "c", "e"]);
const DIMINUTIVE_RE = /^(.{3,}?)z?inh([oa])s?$/;

function diminutiveMatch(a: string, b: string): boolean {
  const base = (word: string) => {
    const plain = singularPt(word);
    return /[oa]$/.test(plain) ? { stem: plain.slice(0, -1), gender: plain.slice(-1) } : null;
  };
  const check = (dim: string, other: string) => {
    const m = DIMINUTIVE_RE.exec(dim);
    const b2 = base(other);
    return Boolean(m && b2 && m[1] === b2.stem && m[2] === b2.gender);
  };
  return check(a, b) || check(b, a);
}

function headNounMatch(token: string, word: string): boolean {
  return tokenMatchesWordSyn(token, word) || diminutiveMatch(token, word);
}

// Guardas duras do ranking (espelham as de `scoreQuery`): o item nunca serve a esta consulta.
function hardExclusion(query: string, item: CatalogItem): boolean {
  const q = queryFacts(query);
  const text = itemText(item);
  const negs = new Set(q.negs);
  const effTokens = q.tokens.filter((t) => !negs.has(t));
  for (const neg of negs) {
    if (new RegExp(`\\b${neg}\\b`).test(text.nameNorm) && !new RegExp(`\\b(sem|zero)\\s+${neg}\\b`).test(text.nameNorm)) return true;
  }
  if (/\bpresentes?\b/.test(q.norm) && GIFT_WRAP_HEAD_RE.test(text.nameNorm) && !GIFT_WRAP_ASK_RE.test(q.norm)) return true;
  const queryAnimal = animalOf(effTokens);
  const itemAnimal = animalOf(text.nameWordsNoNeg, true);
  if (queryAnimal && itemAnimal && queryAnimal !== itemAnimal) return true;
  return !queryAnimal && PET_ANY_RE.test(text.nameNorm) && effTokens.some((t) => HUMAN_PRODUCT_WORDS.has(t));
}

// Palavras de CONTEÚDO da consulta (sem estado, negação, medida, número; público só em brinquedo/presente).
export function shelfContentWords(query: string): string[] {
  const q = queryFacts(joinMeasures(query));
  const negs = new Set(q.negs);
  let content = q.tokens.filter((t) => !negs.has(t) && !STATE_WORDS.has(t) && !MEASURE_TOKEN_RE.test(t) && !/^\d+$/.test(t) && !UNIT_WORDS.has(t) && t.length > 1);
  if (/\b(brinquedos?|presentes?)\b/.test(q.norm)) {
    const core = content.filter((t) => !AUDIENCE_WORDS.has(t));
    if (core.length) content = core;
  }
  return content;
}

// O substantivo-cabeça de uma consulta ("bolo pronto" → "bolo"); null quando só há palavra de estado.
export function shelfHeadNoun(query: string): string | null {
  const head = shelfContentWords(query)[0];
  return head ? singularPt(head) : null;
}

function inTitlePosition(token: string, text: ItemText): boolean {
  const raw = text.nameWords;
  if (text.brandWords.some((word) => tokenMatchesBrand(token, word))) return true;
  for (let i = 0; i < Math.min(3, raw.length); i++) {
    if (!headNounMatch(token, raw[i])) continue;
    if (i > 0 && HEAD_MARKERS.has(raw[i - 1])) continue;
    if (raw.slice(0, i).some((word) => CATEGORY_NOUNS.has(word) && !headNounMatch(token, word))) continue;
    return true;
  }
  const brand = new Set(text.brandWords);
  const firstOwn = raw.find((word) => !brand.has(word) && !STOPWORDS.has(word) && !/^\d/.test(word));
  if (firstOwn && headNounMatch(token, firstOwn)) return true;
  return raw.some((word, i) => CATEGORY_NOUNS.has(word) && headNounMatch(token, word) && (i === 0 || !HEAD_MARKERS.has(raw[i - 1])));
}

export function shelfHeadMatch(query: string, item: CatalogItem): boolean {
  const content = shelfContentWords(query);
  if (!content.length) return false;
  if (hardExclusion(joinMeasures(query), item)) return false;
  const text = itemText(item);
  const nameCompounds = new Set(queryTokens(item.name));
  const covered = (token: string) =>
    nameCompounds.has(token) ||
    text.nameWords.some((word) => headNounMatch(token, word)) ||
    text.brandWords.some((word) => tokenMatchesWord(token, word)) ||
    text.categoryWords.some((word) => tokenMatchesWord(token, word));
  // A cabeça sempre tem que estar no item; das outras, consulta longa (3+) tolera uma ausente.
  if (!covered(content[0])) return false;
  const missing = content.filter((token) => !covered(token)).length;
  if (missing > (content.length > 2 ? 1 : 0)) return false;
  if (inTitlePosition(content[0], text)) return true;
  return content.length >= 2 && missing === 0 && content.some((token) => inTitlePosition(token, text));
}

// Outros nomes do MESMO produto (06/10, A9): o catálogo chama de um jeito, o cliente de outro.
// Só equivalências de nome comercial — nunca "produto parecido". A busca roda a frase do
// cliente E a equivalente; o rerank julga as duas listas juntas.
const QUERY_ALIASES: Array<[RegExp, string]> = [
  [/\bsab(?:ao|oes) (?:em )?po\b/, "lava roupas em po"],
  [/\blava roupas? (?:em )?po\b/, "sabao em po"],
  [/\bxampus?\b/, "shampoo"],
  // "Sem cheiro" é como o cliente fala; o catálogo escreve "sem perfume"/"sem fragrância" (10/10, rodada 4, B1).
  [/\bsem (?:cheiro|aroma|odor|fragrancia|perfumacao)\b/, "sem perfume"],
  [/\bcaixas? de leite\b/, "leite longa vida"],
  [/\bleite de caixinha\b/, "leite longa vida"],
  // 08/10 (placar r4, s141): o cliente pede "leite em pó para bebê"/"leite infantil"; a farmácia
  // chama de "Fórmula Infantil" (Aptamil, Nan, Nestogeno) — e "leite em pó" sozinho segue leite.
  [/\bleite (?:em po )?(?:para|pra|pro|de) (?:o |a |meu |minha )?(?:bebe|bebes|nenem|nene|neneh|recem[- ]nascido)\b/, "formula infantil"],
  [/\bleite (?:em po )?infantil\b/, "formula infantil"],
  // Marcas escritas do jeito que se fala (09/10, rodada de cliente: "4 red bul" → "não achei em nenhuma loja";
  // em produção a IA corrige, sem ela a busca não achava).
  [/\bred ?bul\b/, "red bull"],
  [/\bredbull\b/, "red bull"],
  [/\babsolute\b/, "absolut"],
  [/\bcoca ?cola\b|\bcocas?\b/, "coca cola"],
  [/\bguaranas?\b/, "guarana"],
  [/\bheinekem\b|\bheineke\b/, "heineken"],
  [/\bjhonnie|\bjohnny walker|\bjhonny walker/, "johnnie walker"],
  // Item do dia a dia sem qualificador (09/10): a busca da loja por "óleo" traz secante de unha e óleo corporal.
  [/^oleos?$/, "oleo de soja"],
  [/^feijao$/, "feijao carioca"],
  // Termos populares que o catálogo não usa (09/10, rodada 2, g4). Todos exigem a palavra INTEIRA ou a frase
  // inteira, para nunca virar produto errado ("massa" fica de fora: pode ser massa de pastel, lasanha ou corrida).
  [/\bcervas?\b|\bcervejinhas?\b|\bbrejas?\b/, "cerveja"],
  [/\breq\b/, "requeijao"],
  [/^ph$/, "papel higienico"],
  [/\bomo{2,}\b/, "omo"],
  [/\bcolgat\b|\bcolgati\b/, "colgate"],
  [/\bgil+ett?e?\b|\bgilete\b/, "gillette"],
  [/\byogurtes?\b|\byogurt\b/, "iogurte"],
  [/\bpapel filme\b/, "filme pvc"],
  [/^calabresa$/, "linguica calabresa"],
  [/^manteigas?$/, "manteiga com sal"],
  [/^ovo$/, "ovos"],
  [/^sal$/, "sal refinado"],
  [/^(pampers|huggies)$/, "fralda $1"],
  [/^toddy$/, "achocolatado toddy"],
  [/^nescau$/, "achocolatado nescau"]
];
// Pack/fardo pedido (06/10, A5): a palavra de embalagem e a contagem não são o produto —
// "Pack 8 Latas - Heineken" responde por "fardo de cerveja heineken" pela marca.
const GENERIC_DRINK_RE = /\b(cervejas?|refrigerantes?|refris?|aguas?|bebidas?|latas?|latinhas?|garrafas?|long ?necks?|mineral|de|da|do)\b/g;
export function parsePackPhrase(phrase: string): { core: string; brand?: string; count?: number } | null {
  const norm = normalizeText(phrase);
  if (!/\b(fardos?|packs?|engradados?)\b/.test(norm)) return null;
  const countMatch = norm.match(/\b(?:com\s+)?(\d{1,2})\s*(latas?|latinhas?|garrafas?|unidades?|un|long ?necks?)\b/);
  const count = countMatch ? Number(countMatch[1]) : undefined;
  const core = norm
    .replace(countMatch?.[0] ?? "\u0000", " ")
    .replace(/\b(fardos?|packs?|engradados?)\b\s*(de|com|da|do)?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const brand = core.replace(GENERIC_DRINK_RE, " ").replace(/\s+/g, " ").trim();
  return { core: core || norm, ...(brand ? { brand } : {}), ...(count && count > 1 ? { count } : {}) };
}

export function queryAliases(query: string): string[] {
  const norm = normalizeText(query);
  const pack = parsePackPhrase(query);
  if (pack) return [...new Set([pack.core, ...(pack.brand ? [`pack ${pack.brand}`, `fardo ${pack.brand}`] : []), ...queryAliases(pack.core)])].filter((alias) => alias && alias !== norm);
  const out: string[] = [];
  for (const [re, alias] of QUERY_ALIASES) {
    if (re.test(norm)) out.push(norm.replace(re, alias));
  }
  return out.filter((alias) => alias !== norm);
}
const SPEC_TOKENS = new Set(["usb", "usbc", "usba", "microusb", "hdmi", "bluetooth", "lightning", "wifi", "vga", "ethernet", "rj45"]);

// Cores/acabamentos que distinguem variantes do MESMO produto. Usadas para não gastar
// as 3 vagas de opção com "Branco/Preto/Rosa" do mesmo item (caso real: 3 carregadores
// veiculares idênticos em cores diferentes) — cada vaga deve apresentar um produto
// de verdade diferente. Se o cliente PEDIU uma cor, a diversificação sai do caminho:
// aí a cor é exatamente o que ele está escolhendo.
const VARIANT_COLOR_WORDS = new Set([
  "branco", "branca", "preto", "preta", "rosa", "vermelho", "vermelha", "azul",
  "verde", "amarelo", "amarela", "roxo", "roxa", "cinza", "bege", "marrom",
  "dourado", "dourada", "prata", "prateado", "prateada", "lilas", "laranja", "vinho"
]);

// Tokens de MEDIDA que distinguem variantes do mesmo produto ("500ml", "15kg", "20w",
// número solto, letra de tamanho P/M/G). Mesma lógica das cores: não são identidade do
// produto — a menos que o cliente tenha pedido a medida, aí ela é o que ele escolhe.
const SIZE_VALUE_RE = /^\d+(?:[.,]\d+)?(?:kg|g|mg|ml|l|lt|un|w|v|gb)?$/;
const SIZE_UNIT_WORDS = new Set(["kg", "quilo", "quilos", "grama", "gramas", "litro", "litros", "ml", "unidade", "unidades"]);
function isSizeToken(token: string): boolean {
  return SIZE_VALUE_RE.test(token) || SIZE_LETTER_RE.test(token) || SIZE_UNIT_WORDS.has(token);
}

// O que sobra do nome quando se tira o que é variante (cor/medida) e ruído: a
// IDENTIDADE do produto, usada pra reconhecer "quase o mesmo item de novo".
function identityTokens(name: string, keepColors: boolean, keepSizes: boolean): Set<string> {
  return new Set(
    words(name).filter(
      (w) =>
        !STOPWORDS.has(w) &&
        (keepColors || !VARIANT_COLOR_WORDS.has(w)) &&
        (keepSizes || !isSizeToken(w))
    )
  );
}

// Dois candidatos são o MESMO produto (ou quase) em variante diferente? Caso real
// (10/08): pedir "carregador" mostrava 3 vezes quase o mesmo carregador; "ração", 3
// tamanhos da mesma ração. Identidade = tokens do nome sem cor/medida; sobreposição
// alta (Jaccard ≥ 0.75) = variante, não um produto distinto que mereça vaga própria.
// Marcas declaradas e diferentes nunca são variantes (nomes iguais de marcas rivais).
export function sameProductVariant(query: string, a: Pick<CatalogItem, "name" | "brand">, b: Pick<CatalogItem, "name" | "brand">): boolean {
  const brandA = normalizeText(a.brand ?? "");
  const brandB = normalizeText(b.brand ?? "");
  if (brandA && brandB && brandA !== brandB) return false;
  const asked = queryTokens(query);
  const keepColors = asked.some((t) => VARIANT_COLOR_WORDS.has(t));
  const keepSizes = asked.some((t) => isSizeToken(t));
  const ta = identityTokens(a.name, keepColors, keepSizes);
  const tb = identityTokens(b.name, keepColors, keepSizes);
  if (!ta.size || !tb.size) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / (ta.size + tb.size - common) >= 0.75;
}

export function diversifyOptions<T extends Pick<CatalogItem, "name" | "brand">>(query: string, items: T[], limit: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (out.some((picked) => sameProductVariant(query, picked, item))) continue;
    out.push(item);
  }
  // Menos produtos distintos que vagas: completa com as variantes repetidas mesmo —
  // 3 opções (ainda que 2 sejam cores) atendem melhor que uma lista curta.
  for (const item of items) {
    if (out.length >= limit) break;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

// Ranking compartilhado dos catálogos-seed (os 3 conectores usam): score desc →
// adulto antes de infantil (quando não pedido) → menos variantes não pedidas
// (integral/diet/zero…) → mais barato. O desempate infantil existe porque nomes de
// perfumaria escondem o substantivo no meio ("Celebre Agora Feminino … Colônia") e
// o empate de score cairia no preço — onde o baby, mais barato, venceria.
// Os catálogos VTEX já vêm na ordem de mais vendidos da loja (harvest com
// O=OrderByTopSaleDESC); a posição no arquivo é o rank. Usado pelo backfill (scripts/
// backfill-popularity.mts) e pelos testes — NÃO roda em runtime, porque catálogos sem
// ordem de vendas (Carrefour, Petz, Boticário…) não podem ganhar rank pela posição.
const popularityDone = new WeakSet<CatalogItem[]>();
export function ensurePopularity(items: CatalogItem[]): void {
  if (popularityDone.has(items)) return;
  items.forEach((item, i) => {
    if (item.popularity == null) item.popularity = i + 1;
  });
  popularityDone.add(items);
}

// Bônus < 1 ponto: só desempata itens com o MESMO score de relevância (scores são
// inteiros) — nunca passa por cima de marca, atributo ou palavra a mais no match.
export function popularityBonus(rank?: number): number {
  if (rank == null || rank <= 0) return 0;
  if (rank <= 3) return 0.9;
  if (rank <= 10) return 0.6;
  if (rank <= 30) return 0.3;
  return 0;
}

// ---------- índice do catálogo (08/10/2026): pontuar só quem PODE pontuar ----------
// `scoreQuery` só devolve > 0 com um token forte casando palavra do nome, da marca ou da
// categoria (tokenMatchesWordSyn / isSameNoun / tokenMatchesWord). Varrer os ~90 mil itens das
// 39 vitrines por linha custava ~1,8 s de CPU — 4 linhas = 7 s travando a thread, e as
// respostas das lojas (busca ao vivo, simulação) venciam o timeout na fila de eventos
// (teste do dono: "não tinha gin"). O índice guarda, por catálogo (identidade do array),
// palavra → itens; a consulta casa os tokens (da frase e dos aliases) contra o VOCABULÁRIO
// (milhares de palavras, não centenas de milhares de itens) com os MESMOS casadores, e só os
// itens apontados passam pelo `scoreCatalogMatch` completo. Condição necessária, nunca
// suficiente: o resultado é idêntico ao da varredura inteira (teste de equivalência em
// tests/catalog-index-2026-10-08.test.ts). Catálogo é array estático por loja, então o índice
// nasce uma vez por processo; pools transitórios (cópia + ao vivo) são pequenos.
type CatalogIndex = { vocab: string[]; postings: Map<string, number[]> };
const CATALOG_INDEXES = new WeakMap<CatalogItem[], CatalogIndex>();
let fullScanForTests = false;

function indexFor(items: CatalogItem[]): CatalogIndex {
  const cached = CATALOG_INDEXES.get(items);
  if (cached) return cached;
  const postings = new Map<string, number[]>();
  items.forEach((item, i) => {
    const seen = new Set<string>();
    for (const w of [...words(item.name), ...words(item.brand ?? ""), ...words(item.category ?? "")]) {
      if (seen.has(w)) continue;
      seen.add(w);
      const list = postings.get(w);
      if (list) list.push(i);
      else postings.set(w, [i]);
    }
  });
  const index = { vocab: [...postings.keys()], postings };
  CATALOG_INDEXES.set(items, index);
  return index;
}

// token × palavra do vocabulário → casa? Puro, então vale entre lojas e consultas.
const MATCH_MEMO = new Map<string, boolean>();
const MATCH_MEMO_MAX = 400_000;
function tokenCanHit(token: string, word: string): boolean {
  const key = `${token}\u0000${word}`;
  const hit = MATCH_MEMO.get(key);
  if (hit !== undefined) return hit;
  const value = isSameNoun(token, word) || tokenMatchesWordSyn(token, word) || tokenMatchesWord(token, word);
  if (MATCH_MEMO.size >= MATCH_MEMO_MAX) MATCH_MEMO.clear();
  MATCH_MEMO.set(key, value);
  return value;
}

// Itens que têm chance de pontuar para a consulta (superconjunto do resultado real).
function candidateItems(rawQuery: string, items: CatalogItem[]): CatalogItem[] {
  const query = joinMeasures(rawQuery);
  const tokens = new Set([query, ...queryAliases(query)].flatMap((q) => queryTokens(q)));
  if (!tokens.size) return [];
  const index = indexFor(items);
  const hit = new Set<number>();
  for (const word of index.vocab) {
    for (const token of tokens) {
      if (!tokenCanHit(token, word)) continue;
      for (const i of index.postings.get(word)!) hit.add(i);
      break;
    }
  }
  return [...hit].sort((a, b) => a - b).map((i) => items[i]);
}

export function __setCatalogFullScanForTests(on: boolean) {
  fullScanForTests = on;
}

export function rankCatalog(query: string, allItems: CatalogItem[], limit: number): CatalogItem[] {
  const items = fullScanForTests ? allItems : candidateItems(query, allItems);
  const childAsked = CHILD_VARIANT_RE.test(normalizeText(query));
  const childRank = (item: CatalogItem) => (!childAsked && isChildVariant(itemText(item).nameNorm) ? 1 : 0);
  // Popularidade (só catálogos VTEX, gravada pelo harvest/backfill) entra DEPOIS de
  // relevância, variante infantil, embalagem comum e básico-antes-de-variante (regras
  // deliberadas do dono) e ANTES do preço: entre iguais, o que a loja mais vende vence.
  const pop = (item: CatalogItem) => item.popularity ?? Number.MAX_SAFE_INTEGER;
  return items
    .map((item) => ({ item, score: scoreCatalogMatch(query, item) }))
    .filter((e) => e.score > 0)
    // Calcular os desempates uma vez por candidato, em vez de repetir regex a cada comparação.
    .map((entry) => ({ ...entry, child: childRank(entry.item), packaging: commonPackageRank(query, entry.item), variants: variantCount(query, entry.item) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.child - b.child ||
        a.packaging - b.packaging ||
        a.variants - b.variants ||
        pop(a.item) - pop(b.item) ||
        a.item.unitPrice - b.item.unitPrice
    )
    .slice(0, limit)
    .map((e) => e.item);
}

// Produto BÁSICO primeiro (dono, 09/10, print: "vodka absolute" → Absolut Citron; "suco de laranja" → Fruit
// Shoot infantil; "gin" → Apogee Citrus). Quem pede o genérico quer a versão comum: sabor, edição, zero/diet,
// drink pronto e "com X" são VARIANTES — só contam a favor quando o próprio pedido diz. Devolve quantos
// marcadores de variante o nome tem que o pedido não tem (0 = básico).
const VARIANT_MARKERS = new Set([
  "citron", "limao", "lemon", "lima", "tabasco", "pimenta", "raspberri", "raspberry", "raspeberry", "framboesa",
  "vanilia", "vanilla", "baunilha", "morango", "strawberry", "pessego", "peach", "melancia", "watermelon", "maca",
  "apple", "uva", "manga", "maracuja", "melao", "acerola", "cenoura", "beterraba", "gengibre", "tropical", "pomelo",
  "amora", "frutas", "vermelhas", "fruits", "cereja", "coco", "nectarina", "blueberry", "mirtilo", "menta",
  "hortela", "caramelo", "canela", "tangerina", "abacaxi", "kiwi", "pitaya", "goiaba", "sugarfree", "sugar",
  "zero", "diet", "light", "edition", "edicao", "summer", "winter", "rose", "pink", "citrus", "mix", "kids",
  "infantil", "shoot", "sprite", "tonic", "tonica", "aromatizada", "saborizada", "sabor", "vitaminas",
  "proteina", "veggies", "blend", "special", "doce", "white", "black", "gold", "premium", "reserva",
  // "leite ninho" sem pedir "sem lactose" (10/10, rodada 5 B2): a versão sem lactose não é a básica.
  "lactose"
]);
const SUGAR_FREE = ["sugarfree", "sugar", "zero", "diet"];
export function variantPenalty(query: string, name: string): number {
  const asked = new Set(words(query));
  // "sem açúcar"/"zero"/"diet" pedidos: as grafias da loja (Sugarfree, Sugar Free, Zero, Diet) são o pedido.
  const wantsSugarFree = (asked.has("sem") && asked.has("acucar")) || SUGAR_FREE.some((t) => asked.has(t));
  if (wantsSugarFree) for (const t of [...SUGAR_FREE, "free"]) asked.add(t);
  const tokens = new Set(words(name));
  let penalty = 0;
  for (const token of tokens) if (VARIANT_MARKERS.has(token) && !asked.has(token)) penalty += 1;
  // A variante PEDIDA ("vodka absolut citron") que o produto não tem conta contra ele.
  for (const token of asked) if (VARIANT_MARKERS.has(token) && !SUGAR_FREE.includes(token) && !tokens.has(token)) penalty += 1;
  if (wantsSugarFree && !SUGAR_FREE.some((t) => tokens.has(t)) && !(tokens.has("sem") && tokens.has("acucar"))) penalty += 1;
  // "Suco de laranja COM maçã", "com vitaminas": algo a mais que o pedido não tem.
  if (tokens.has("com") && !asked.has("com")) penalty += 1;
  const staple = stapleFor(query);
  if (staple && !staple.prefer.test(normalizeText(name))) penalty += 1;
  return penalty;
}
