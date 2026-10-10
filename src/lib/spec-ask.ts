// Itens que dependem de uma especificação que o cliente não deu (09/10, rodada 3, g7): "capa de celular"
// sem modelo mostrava capa de Motorola Razr. Em vez de chutar, a Lia pergunta a especificação em uma linha,
// segue com o resto da lista e, quando o cliente responde ("iphone 13", "é tipo c"), a resposta volta para a
// busca DAQUELE item. Puro e sem banco: só detecção e composição da nova frase de busca.
import { normalizeMsg } from "./lia-intents";

export type SpecKind = "capa" | "pelicula" | "carregador" | "cartucho" | "filtro" | "pneu" | "racao";

const has = (n: string, re: RegExp) => re.test(n);
// Resposta de modelo de celular: marca/código ("iphone 13", "a54", "moto g84") ou só o número ("13", "13 pro").
const PHONE_ANSWER = /\b(iphone|ipad|galaxy|samsung|motorola|moto|xiaomi|redmi|poco|realme|lg|asus|zenfone|positivo|nokia|infinix|tcl|oppo|pixel|huawei|honor|multilaser|edge|razr)\b|\b[a-z]{1,2}\d{1,3}[a-z]?\b/;
const PHONE_BARE_NUMBER = /^\d{1,2}( (pro|max|plus|mini|ultra|s|se|lite))*$/;

// Marca/modelo de celular: marca conhecida ou token com letra+número ("a54", "s23", "g84", "j7") ou número solto.
const PHONE_MODEL = /\b(iphone|ipad|galaxy|samsung|motorola|moto|xiaomi|redmi|poco|realme|lg|asus|zenfone|positivo|nokia|infinix|tcl|oppo|pixel|huawei|honor|multilaser|edge|razr|note|plus|pro max|mini)\b|\b[a-z]{1,2}\d{1,3}[a-z]?\b|\b\d{1,2}\b/;
// Cabo/entrada do carregador.
const CABLE_TYPE = /\b(usb ?-?c|tipo ?-?c|type ?-?c|lightning|micro ?-?usb|usb ?-?micro|v8|iphone|ipad|apple|airpods|samsung|motorola|xiaomi|usb|usb ?-?a|p2|p4|tipo ?-?a|tomada)\b/;
const CHARGER_OTHER = /\b(pilha|pilhas|bateria|baterias|notebook|laptop|carro|veicular|automotivo|portatil|power ?bank|inducao|sem fio|ferramenta|furadeira|parafusadeira|barbeador|camera|console|videogame|patinete|bike|bicicleta)\b/;
const FILTER_BRANDS = /\b(europa|electrolux|latina|ibbl|purificador|brastemp|consul|colormaq|hoken|libell|esmaltec|philco|mondial|midea|lg|samsung|gol|palio|uno|onix|hb20|corolla|civic|fiesta|ka|strada|saveiro|hilux)\b/;

const RULES: Array<{ kind: SpecKind; test: (n: string) => boolean }> = [
  {
    kind: "capa",
    test: (n) => has(n, /\b(capa|capas|capinha|capinhas)\b/) && has(n, /\b(celular|celulares|smartphone|telefone|cel|capinha|capinhas)\b/) && !has(n, PHONE_MODEL) && !has(n, /\b(notebook|tablet|sofa|cadeira|colchao|chuva|almofada|travesseiro|mochila|bicicleta|carro)\b/)
  },
  {
    kind: "pelicula",
    test: (n) => has(n, /\b(pelicula|peliculas)\b/) && !has(n, PHONE_MODEL) && !has(n, /\b(carro|insulfilm|janela|pvc|filme|alimento|aluminio|relogio|tablet|notebook|camera)\b/)
  },
  {
    kind: "carregador",
    test: (n) => has(n, /\bcarregador(es)?\b/) && !has(n, CABLE_TYPE) && !has(n, CHARGER_OTHER)
  },
  {
    kind: "cartucho",
    test: (n) =>
      (has(n, /\b(cartucho|cartuchos|toner|toners)\b/) || (has(n, /\btintas?\b/) && has(n, /\bimpressora\b/))) &&
      !has(n, /\b(gas|vedacao|torneira|silicone|cola|fumaca|caneta)\b/) &&
      // modelo dado: número de 2+ dígitos ("hp 664", "ink tank 416", "t544") ou "compativel com".
      !has(n, /\b[a-z]{0,3}\d{2,}[a-z]?\b/) &&
      !has(n, /\bcompativel\b/)
  },
  {
    kind: "filtro",
    test: (n) =>
      has(n, /\b(filtro|filtros|refil)\b/) &&
      has(n, /\b(agua|ar|oleo|combustivel|cabine)\b/) &&
      !has(n, /\b(cafe|linha|papel|barro|solar|piscina|aquario|cigarro|cozinha|coifa|exaustor)\b/) &&
      // modelo dado: número ou marca/linha do aparelho.
      !has(n, /\b\d{2,}\b/) &&
      !has(n, FILTER_BRANDS)
  },
  {
    kind: "pneu",
    test: (n) =>
      has(n, /\bpneus?\b/) &&
      !has(n, /\b(reparo|calibrador|pretinho|brilho|limpa|cuidado|furo|cola)\b/) &&
      // medida dada: 175/70, aro 14, R14, 205 55 r16, aro 26.
      !has(n, /\b\d{2,3}\s*\/\s*\d{2}\b|\baro\s*\d{2}\b|\br\s*\d{2}\b|\b\d{3}\s+\d{2}\s*r?\s*\d{2}\b/)
  }
];

// Ração pelada ("ração", "ração de cachorro", "ração 10kg"): marca, sabor, idade ou porte já é especificação. Diferente
// dos outros itens, só vira pergunta se o catálogo separa (racaoStagesMixed): as opções mostram idade/porte diferentes.
export function isBareRacao(phrase: string): boolean {
  const n = normalizeMsg(phrase).replace(/-/g, " ");
  if (!has(n, /\bracao\b|\bracoes\b/)) return false;
  const rest = n
    .replace(/\b(racao|racoes|de|do|da|para|pra|pro|um|uma|saco|sacos|pacote|pacotes|quero|queria|preciso|cachorro|cachorros|cao|caes|gato|gatos|pet|meu|minha)\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest === "";
}

export function racaoStagesMixed(names: string[]): boolean {
  const stages = new Set<string>();
  const sizes = new Set<string>();
  for (const raw of names) {
    const n = normalizeMsg(raw);
    if (/\b(filhotes?|puppy|kitten|gatinhos?)\b/.test(n)) stages.add("filhote");
    if (/\b(adultos?|adult)\b/.test(n)) stages.add("adulto");
    if (/\b(senior|idosos?)\b/.test(n)) stages.add("senior");
    if (/\b(pequen[oa]s?|mini|toy)\b/.test(n)) sizes.add("p");
    if (/\b(medi[oa]s?)\b/.test(n)) sizes.add("m");
    if (/\b(grandes?|gigantes?)\b/.test(n)) sizes.add("g");
  }
  return stages.size >= 2 || sizes.size >= 2;
}

export function specKindOf(phrase: string): SpecKind | null {
  const n = normalizeMsg(phrase).replace(/-/g, " ");
  return RULES.find((r) => r.test(n))?.kind ?? null;
}

export type SpecAsk = { kind: SpecKind; query: string; qty: number; qtyExplicit?: boolean };

// A resposta serve para a pergunta? Modelo/medida/tipo reconhecível. Resposta que parece outro pedido
// ("pilha aa", "arroz") NÃO é consumida: segue o fluxo normal.
export function specAnswerLooksValid(kind: SpecKind, answer: string): boolean {
  const n = normalizeMsg(answer).replace(/-/g, " ");
  const words = n.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7) return false;
  switch (kind) {
    case "capa":
    case "pelicula":
      return has(n, PHONE_ANSWER) || PHONE_BARE_NUMBER.test(n);
    case "carregador":
      return has(n, CABLE_TYPE) || (words.length <= 3 && has(n, /\b(c|a)\b/));
    case "cartucho":
      return has(n, /\b[a-z]{0,3}\d{2,}[a-z]?\b/) || has(n, /\b(hp|epson|canon|brother|lexmark|xerox|ricoh|samsung|deskjet|laserjet|ecotank|pixma)\b/);
    case "filtro":
      return has(n, /\d/) || has(n, FILTER_BRANDS) || has(n, /\bmodelo\b/);
    case "pneu":
      return has(n, /\d{2,3}\s*\/\s*\d{2}|\baro\s*\d{2}\b|\br\s*\d{2}\b|\b\d{3}\s+\d{2}\s+\d{2}\b/) || /^\d{2}$/.test(n);
    case "racao":
      return has(n, /\b(filhote|filhotes|adulto|adultos|adulta|senior|idoso|idosa|castrad[oa]s?|pequeno|pequena|medio|media|grande|mini|porte|gatinho|gatinha|cachorrinho|puppy|kitten|racas?)\b/);
  }
}

// "não sei" / "qualquer um": sem a especificação não dá para acertar.
export function specAnswerUnknown(answer: string): boolean {
  return /^(nao sei|n sei|nao lembro|qualquer( um| uma)?|tanto faz|sei la|deixa|deixa pra la|esquece|nao precisa|nao quero|nem)\b/.test(normalizeMsg(answer));
}

// Impressora -> cartucho (10/10, rodada 4, M1): "cartucho para HP DeskJet 2774" oferecia a linha HP 664XL, que não serve.
// Só compatibilidades CERTAS (fabricante); modelo fora da tabela segue como está (e sem número a Lia pergunta).
const PRINTER_CARTRIDGES: Array<{ brand: string; models: string[]; cartridge: string }> = [
  { brand: "hp", models: ["2374", "2376", "2774", "2775", "2776", "2777"], cartridge: "667" },
  { brand: "hp", models: ["1115", "2135", "2136", "2676", "3636", "3776"], cartridge: "664" },
  { brand: "epson", models: ["l355", "l365", "l375", "l395", "l210", "l220"], cartridge: "664" },
  { brand: "epson", models: ["l3110", "l3150", "l3210", "l3250"], cartridge: "544" },
  { brand: "canon", models: ["mg2510", "mg2910"], cartridge: "145" }
];

// "cartucho hp 667" quando a frase cita cartucho/tinta/toner + impressora conhecida e nenhum número de cartucho próprio.
export function cartridgeForPrinter(phrase: string): string | null {
  const n = normalizeMsg(phrase).replace(/-/g, " ");
  if (!has(n, /\b(cartucho|cartuchos|tintas?|refil)\b/) || has(n, /\btoner\b/)) return null;
  const hit = PRINTER_CARTRIDGES.find((p) => p.models.some((m) => new RegExp(`\\b${m}\\b`).test(n.replace(/\b(l)\s+(\d)/g, "$1$2"))));
  if (!hit) return null;
  // já pediu um cartucho por número ("hp 667", "t544"): respeita.
  const wanted = n.replace(new RegExp(`\\b(${hit.models.join("|")})\\b`), " ");
  if (/\b(?:hp|pg|cl|gi|t|n)?\s?\d{3}\s?(?:xl)?\b/.test(wanted)) return null;
  const brandOk = n.includes(hit.brand) || /\b(deskjet|ink advantage|ecotank|pixma)\b/.test(n) || hit.brand !== "hp";
  if (!brandOk) return null;
  return hit.brand === "epson" ? `refil tinta epson ${hit.cartridge}` : hit.brand === "canon" ? `cartucho canon pg ${hit.cartridge}` : `cartucho ${hit.brand} ${hit.cartridge}`;
}

const FILLER = /^(e|eh|é|seria|sao|são|o|a|do|da|de|um|uma|pro|pra|para o|para a|modelo|meu|minha)\s+/i;

function cleanAnswer(answer: string): string {
  let a = answer.trim().replace(/[.!?]+$/, "");
  for (let i = 0; i < 4 && FILLER.test(a); i++) a = a.replace(FILLER, "");
  return a.replace(/^(celular|impressora)\s+/i, "").trim();
}

// Frase de busca nova: o item com a especificação (a quantidade original volta como prefixo).
export function combineSpecQuery(ask: SpecAsk, answer: string): string {
  const a = cleanAnswer(answer);
  const mapped = ask.kind === "cartucho" ? cartridgeForPrinter(`cartucho ${a}`) : null;
  if (mapped) return ask.qty > 1 ? `${ask.qty} ${mapped}` : mapped;
  const q = ask.query.replace(/\s+/g, " ").trim();
  const base: Record<SpecKind, string> = {
    capa: `capa ${a}`,
    pelicula: `película ${a}`,
    carregador: `carregador ${a}`,
    cartucho: /\btoner\b/i.test(q) ? `toner ${a}` : `cartucho ${a}`,
    filtro: `${q} ${a}`,
    pneu: `pneu ${a}`,
    racao: `${q} ${a}`
  };
  return ask.qty > 1 ? `${ask.qty} ${base[ask.kind]}` : base[ask.kind];
}
