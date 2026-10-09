// COMPLEMENTO NO FECHAMENTO (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.5 e fase 4):
// quando o cliente fecha a lista ("só isso"), a Lia oferece UM item que costuma ir junto do que está na
// cesta ("quem leva carvão costuma levar pão de alho"). Puro e determinístico: tabela curada de
// co-ocorrência (o plano prevê trocá-la por co-ocorrência dos pedidos pagos quando houver ≥ 50
// recomendações reais; até lá, conhecimento revisado à mão).
//
// Regras: no máximo 1 sugestão; nunca algo que já está na cesta; nunca o que o cliente recusou nesta
// conversa; NUNCA com remédio isento na cesta (nem complemento de remédio, nem nada junto dele); nunca
// prateleira de remédio; gelo não existe nos catálogos (fora da tabela). Ordem da tabela = prioridade.
import { recommendEnabled } from "./types";
import type { ShelfNode } from "./types";

export type ComplementBasketItem = { name: string; brand?: string; storeKey?: string; sku: string; medicine?: "mip" };
export type ComplementSuggestion = { query: string; shelfId: string; why: string; trigger: string };

type Pair = {
  // Item da cesta que dispara (nome normalizado).
  when: RegExp;
  // Exceções do gatilho ("leite condensado" não é leite).
  unless?: RegExp;
  // O que oferecer: consulta de busca, prateleira do mapa ("produto" = busca textual sem prateleira),
  // a frase da oferta e o que na cesta já conta como "tem".
  query: string;
  shelfId: string;
  why: string;
  has: RegExp;
  // Nome curto do gatilho (log e teste).
  trigger: string;
};

export function normComplement(input: string | undefined | null): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MEAT_BBQ = /\b(picanha|fraldinha|alcatra|maminha|cupim|costela|contra file|contrafile|linguica toscana|linguica para churrasco|linguica churrasco|carne para churrasco|kit churrasco|coracao de frango|asa de frango|tulipa|medalhao)\b/;

// Petisco de cachorro já na cesta (inclui os que não dizem "petisco" no nome: Dentastix, ossinho, bifinho).
const PET_TREAT_RE = /\b(petisco|petiscos|bifinho|bifinhos|osso|ossinho|ossinhos|snack|snacks|dentastix|palito dental|mastigavel|mastigaveis|rawhide|stick|sticks|joy beef|pedigree biscrok|biscoito para (cao|cachorro))\b/;
// Item de pet: só puxa complemento de pet — "Ração Carne e Arroz" não pede feijão (09/10, rodada 2).
const PET_ITEM_RE = /\b(racao|racoes|petisco|petiscos|pet|cao|caes|cachorro|cachorros|cachorrinho|filhote|filhotes|gato|gatos|felino|felinos|canino|caninos|dog|cat|areia higienica|granulado sanitario|dentastix|whiskas|friskies|pedigree|golden|premier|guabi|biofresh|sache)\b/;

// ≥ 40 pares. Ordem = prioridade quando a cesta dispara mais de um.
export const COMPLEMENT_PAIRS: readonly Pair[] = [
  { trigger: "carvão", when: /\bcarvao\b/, query: "pao de alho", shelfId: "padaria.pao_de_alho", why: "Quem leva carvão costuma levar pão de alho 🧄", has: /\bpao de alho\b/ },
  { trigger: "carne de churrasco", when: MEAT_BBQ, query: "carvao", shelfId: "casa.churrasco", why: "Pro churrasco, o carvão já vai junto? 🔥", has: /\bcarvao\b/ },
  { trigger: "pão de alho", when: /\bpao de alho\b/, query: "carvao", shelfId: "casa.churrasco", why: "Pão de alho pede brasa — o carvão já vai junto? 🔥", has: /\bcarvao\b/ },
  { trigger: "macarrão", when: /\b(macarrao|espaguete|spaghetti|penne|parafuso|talharim|fettuccine|massa para lasanha|lasanha massa|nhoque|rigatoni|fusilli)\b/, unless: /\binstantaneo|miojo|cup noodles|lamen\b/, query: "molho de tomate", shelfId: "mercado.molho_tomate", why: "Quem leva macarrão costuma levar molho de tomate 🍝", has: /\b(molho de tomate|molho tomate|extrato de tomate|polpa de tomate|passata|molho pronto|pomarola|tomate pelado)\b/ },
  { trigger: "molho de tomate", when: /\b(molho de tomate|molho tomate|pomarola|passata|polpa de tomate)\b/, query: "macarrao espaguete", shelfId: "mercado.macarrao", why: "Molho de tomate pede um macarrão 🍝", has: /\b(macarrao|espaguete|penne|parafuso|talharim|nhoque|lasanha)\b/ },
  { trigger: "café", when: /\bcafe\b/, unless: /\b(capsula|capsulas|soluvel|cafeteira|cappuccino|capuccino|filtro|dolce gusto|nespresso|tres coracoes capsula|com leite|gelado|bebida)\b/, query: "filtro de papel para cafe", shelfId: "produto", why: "Quem leva café em pó costuma levar filtro de papel ☕", has: /\bfiltro\b/ },
  { trigger: "pão", when: /\b(pao frances|pao de forma|pao forma|bisnaguinha|pao integral|pao de leite|pao sovado|pao caseiro|pao italiano|baguete)\b/, query: "manteiga", shelfId: "frios.requeijao_manteiga", why: "Pão pede uma manteiga 🧈", has: /\b(manteiga|margarina|requeijao|cream cheese)\b/ },
  { trigger: "torrada", when: /\btorrada/, query: "requeijao", shelfId: "frios.requeijao_manteiga", why: "Torrada combina com requeijão 😋", has: /\b(manteiga|margarina|requeijao|cream cheese|geleia)\b/ },
  { trigger: "ração de cachorro", when: /\bracao\b.*\b(cao|caes|cachorro|cachorros|dog|canin\w*|adulto raca|filhote raca)\b|\b(pedigree|golden formula|premier pet|special dog|dog chow|biofresh|guabi natural)\b/, unless: /\bgat|\b(petisco|bifinho|snack|dentastix|osso)\b/, query: "petisco cachorro", shelfId: "pet.petisco_cachorro", why: "Quem leva ração costuma levar um petisco pro cachorro 🐶", has: PET_TREAT_RE },
  { trigger: "ração de gato", when: /\bracao\b.*\b(gato|gatos|felin\w*|cat)\b|\b(whiskas|cat chow|friskies|gran plus gato|golden gatos)\b/, unless: /\b(petisco|sache|snack|churu|dreamies)\b/, query: "petisco gato", shelfId: "pet.petisco_gato", why: "Quem leva ração costuma levar um petisco pro gato 🐱", has: /\b(petisco|sache|churu|dreamies|snack|bifinho|stick|sticks)\b/ },
  { trigger: "areia de gato", when: /\bareia\b.*\b(gato|gatos|higienica|sanitari\w*)\b|\bgranulado sanitario\b/, query: "sache para gato", shelfId: "pet.petisco_gato", why: "Quem leva areia costuma levar um sachê pro gato 🐱", has: /\b(sache|petisco|racao)\b/ },
  { trigger: "shampoo", when: /\bshampoo\b/, unless: /\b(pet|cachorro|cao|gato|infantil|anticaspa a seco|seco)\b/, query: "condicionador", shelfId: "beleza.condicionador", why: "Quem leva shampoo costuma levar o condicionador 🧴", has: /\bcondicionador\b/ },
  { trigger: "condicionador", when: /\bcondicionador\b/, unless: /\b(pet|cachorro|gato)\b/, query: "shampoo", shelfId: "beleza.shampoo", why: "Quem leva condicionador costuma levar o shampoo 🧴", has: /\bshampoo\b/ },
  { trigger: "fralda", when: /\bfralda/, unless: /\badult|geriatric|incontinencia|pet\b|cachorro/, query: "lenco umedecido", shelfId: "bebe.lenco_umedecido", why: "Quem leva fralda costuma levar lenço umedecido 👶", has: /\b(lenco umedecido|lencos umedecidos|toalhinha umedecida|toalhas umedecidas)\b/ },
  { trigger: "sabão em pó", when: /\b(sabao em po|sabao liquido|lava roupas|omo|ariel|tixan)\b/, unless: /\bamaciante\b/, query: "amaciante", shelfId: "limpeza.amaciante", why: "Quem leva sabão pra roupa costuma levar amaciante 👕", has: /\b(amaciante|comfort|downy|fofo|mon bijou)\b/ },
  { trigger: "amaciante", when: /\b(amaciante|comfort|downy)\b/, query: "sabao em po", shelfId: "limpeza.lava_roupas", why: "Quem leva amaciante costuma levar o sabão 👕", has: /\b(sabao em po|sabao liquido|lava roupas|omo|ariel|ace|brilhante|tixan)\b/ },
  { trigger: "escova de dente", when: /\bescova (de dente|dental|dentes)\b/, query: "creme dental", shelfId: "higiene.creme_dental", why: "Escova nova pede um creme dental 🪥", has: /\b(creme dental|pasta de dente|gel dental|colgate|sensodyne|oral b creme|close up)\b/ },
  { trigger: "creme dental", when: /\b(creme dental|pasta de dente|gel dental)\b/, query: "escova de dente", shelfId: "higiene.escova_dente", why: "Quem leva creme dental costuma trocar a escova 🪥", has: /\bescova (de dente|dental|dentes)\b/ },
  { trigger: "vinho", when: /\bvinho\b/, unless: /\bvinagre|taca|tacas|saca rolha|abridor\b/, query: "queijo", shelfId: "frios.queijo", why: "Vinho combina com um queijo 🧀", has: /\b(queijo|brie|camembert|gouda|parmesao|gorgonzola|provolone)\b/ },
  { trigger: "leite", when: /\bleite\b/, unless: /\b(condensado|de coco|doce de leite|creme de leite|ao leite|po infantil|formula|achocolatado|chocolate|leite de rosas|hidratante|sabonete|desodorante|bebida lactea|em po)\b/, query: "achocolatado", shelfId: "mercado.achocolatado", why: "Leite pede um achocolatado 🥛", has: /\b(achocolatado|nescau|toddy|chocolate em po|cereal|sucrilhos|granola)\b/ },
  { trigger: "cereal matinal", when: /\b(cereal matinal|sucrilhos|corn flakes|granola|nescau cereal|snow flakes)\b/, query: "leite integral", shelfId: "frios.leite", why: "Cereal pede leite 🥣", has: /\bleite\b(?! condensado| de coco)/ },
  { trigger: "arroz", when: /\barroz\b/, unless: /\b(farinha de arroz|biscoito de arroz|bolacha de arroz|arroz doce|oleo de arroz|leite de arroz)\b/, query: "feijao carioca", shelfId: "mercado.feijao", why: "Arroz pede feijão 🍛", has: /\bfeijao\b/ },
  { trigger: "feijão", when: /\bfeijao\b/, unless: /\b(feijoada pronta|feijao pronto|caldo de feijao)\b/, query: "arroz branco", shelfId: "mercado.arroz", why: "Feijão pede arroz 🍛", has: /\barroz\b/ },
  { trigger: "pizza congelada", when: /\bpizza\b/, unless: /\b(forma|assadeira|cortador|molho)\b/, query: "refrigerante", shelfId: "bebidas.refrigerante", why: "Pizza pede um refri 🍕", has: /\b(refrigerante|refri|coca|guarana|fanta|sprite|pepsi|soda|cerveja|suco)\b/ },
  { trigger: "hambúrguer", when: /\bhamburguer\b/, unless: /\bpao de hamburguer|pao para hamburguer|pao hamburguer|prensa|chapa\b/, query: "pao de hamburguer", shelfId: "padaria.pao", why: "Hambúrguer pede pão 🍔", has: /\bpao (de |para )?hamburguer\b|\bpao brioche\b/ },
  { trigger: "pão de hambúrguer", when: /\bpao (de |para )?hamburguer\b/, query: "hamburguer", shelfId: "carnes.hamburguer", why: "Pão de hambúrguer pede o hambúrguer 🍔", has: /\bhamburguer\b/ },
  { trigger: "salsicha", when: /\bsalsicha\b/, unless: /\bpet\b|cachorro/, query: "pao de hot dog", shelfId: "padaria.pao", why: "Salsicha pede pão de cachorro-quente 🌭", has: /\bpao (de )?(hot dog|cachorro quente)\b/ },
  { trigger: "detergente", when: /\b(detergente|lava loucas)\b/, query: "esponja", shelfId: "limpeza.esponja_pano", why: "Quem leva detergente costuma levar esponja 🧽", has: /\besponja\b/ },
  { trigger: "esponja", when: /\besponja\b/, unless: /\bmaquiagem|banho|corporal\b/, query: "detergente", shelfId: "limpeza.detergente", why: "Quem leva esponja costuma levar detergente 🧽", has: /\b(detergente|lava loucas)\b/ },
  { trigger: "cerveja", when: /\b(cerveja|chopp|chope)\b/, unless: /\b(sem alcool zero copo|copo|caneca|abridor)\b/, query: "amendoim", shelfId: "snacks.amendoim_castanhas", why: "Cerveja pede um petisco 🥜", has: /\b(amendoim|salgadinho|batata|chips|castanha|petisco|torresmo|doritos|ruffles)\b/ },
  { trigger: "salgadinho", when: /\b(salgadinho|batata chips|doritos|ruffles|cheetos|fandangos|pringles)\b/, query: "refrigerante", shelfId: "bebidas.refrigerante", why: "Salgadinho pede um refri 🥤", has: /\b(refrigerante|refri|coca|guarana|fanta|sprite|pepsi|cerveja|suco)\b/ },
  { trigger: "pipoca", when: /\bpipoca\b|\bmilho de pipoca\b/, query: "refrigerante", shelfId: "bebidas.refrigerante", why: "Pipoca pede um refri 🍿", has: /\b(refrigerante|refri|coca|guarana|fanta|sprite|pepsi|suco)\b/ },
  { trigger: "sorvete", when: /\bsorvete\b/, unless: /\bcasquinha|pote vazio\b/, query: "cobertura para sorvete", shelfId: "produto", why: "Sorvete com cobertura fica melhor 🍨", has: /\b(cobertura|calda|casquinha)\b/ },
  { trigger: "mistura para bolo", when: /\b(mistura para bolo|massa para bolo|mistura bolo|bolo pronto mistura)\b/, query: "ovos", shelfId: "hortifruti.ovos", why: "Mistura pra bolo pede ovos 🥚", has: /\bovos?\b/ },
  { trigger: "leite condensado", when: /\bleite condensado\b/, query: "creme de leite", shelfId: "produto", why: "Leite condensado costuma ir com creme de leite 🍮", has: /\bcreme de leite\b/ },
  { trigger: "creme de leite", when: /\bcreme de leite\b/, query: "leite condensado", shelfId: "produto", why: "Creme de leite costuma ir com leite condensado 🍮", has: /\bleite condensado\b/ },
  { trigger: "queijo", when: /\b(queijo mussarela|queijo prato|mucarela|mussarela|muçarela)\b/, unless: /\bralado|pizza\b/, query: "presunto", shelfId: "frios.frios", why: "Queijo pede um presunto pro misto 🥪", has: /\b(presunto|peito de peru|apresuntado|salame)\b/ },
  { trigger: "presunto", when: /\b(presunto|apresuntado|peito de peru)\b/, query: "queijo mussarela", shelfId: "frios.queijo", why: "Presunto pede um queijo pro misto 🥪", has: /\b(queijo|mussarela|mucarela)\b/ },
  { trigger: "batata frita congelada", when: /\bbatata (frita|palito|pre frita|congelada)\b|\bmccain\b/, query: "ketchup", shelfId: "produto", why: "Batata frita pede ketchup 🍟", has: /\b(ketchup|catchup|maionese|mostarda)\b/ },
  { trigger: "aparelho de barbear", when: /\b(aparelho de barbear|lamina de barbear|prestobarba|gillette mach|barbeador descartavel)\b/, query: "espuma de barbear", shelfId: "higiene.barbear", why: "Quem leva aparelho de barbear costuma levar espuma 🪒", has: /\b(espuma|gel de barbear|creme de barbear)\b/ },
  { trigger: "espuma de barbear", when: /\b(espuma de barbear|gel de barbear|creme de barbear)\b/, query: "aparelho de barbear", shelfId: "higiene.barbear", why: "Espuma pede um aparelho de barbear 🪒", has: /\b(aparelho|lamina|prestobarba|barbeador)\b/ },
  { trigger: "esmalte", when: /\besmalte\b/, unless: /\bremovedor|acetona\b/, query: "removedor de esmalte", shelfId: "beleza.esmalte", why: "Quem leva esmalte costuma levar removedor 💅", has: /\b(removedor|acetona)\b/ },
  { trigger: "chá", when: /\bcha\b/, unless: /\b(cha pronto|cha gelado|ice tea|mate leao|cha de bebe|cha mate pronto)\b/, query: "mel", shelfId: "mercado.mel_geleia", why: "Chá combina com mel 🍯", has: /\bmel\b/ },
  { trigger: "carne moída", when: /\bcarne moida\b|\bpatinho moido\b/, query: "molho de tomate", shelfId: "mercado.molho_tomate", why: "Carne moída pede um molho de tomate 🍝", has: /\b(molho de tomate|molho tomate|extrato de tomate|polpa de tomate|passata|pomarola)\b/ },
  { trigger: "tapioca", when: /\b(tapioca|goma de tapioca|goma para tapioca)\b/, query: "queijo coalho", shelfId: "frios.queijo", why: "Tapioca combina com queijo coalho 🧀", has: /\bqueijo\b/ },
  { trigger: "açaí", when: /\bacai\b/, query: "granola", shelfId: "mercado.cereal_matinal", why: "Açaí pede uma granola 🥣", has: /\b(granola|leite em po|pacoca)\b/ }
];

// Remédio na cesta: nada de complemento (nem junto, nem de remédio).
const MEDICINE_NAME_RE = /\b(dipirona|paracetamol|ibuprofeno|dorflex|neosaldina|buscopan|luftal|engov|estomazil|eno|sal de fruta|omeprazol|loratadina|simeticona|loperamida|novalgina|tylenol|advil|aspirina|benegrip|cimegripe|xarope|comprimidos?|capsulas? gelatinosas?|mg\b)/;

export function suggestComplement(
  basket: readonly ComplementBasketItem[],
  opts: { shelfById: (id: string) => ShelfNode | null | undefined; recentlyDeclined?: readonly string[] }
): ComplementSuggestion | null {
  if (!basket.length) return null;
  const names = basket.map((b) => normComplement(b.name));
  if (basket.some((b) => b.medicine === "mip") || names.some((n) => MEDICINE_NAME_RE.test(n))) return null;
  const declined = new Set((opts.recentlyDeclined ?? []).map(normComplement));
  for (const pair of COMPLEMENT_PAIRS) {
    const petPair = pair.shelfId.startsWith("pet.");
    // Item de pet só dispara par de pet; par de comida/higiene humana nunca olha item de pet.
    const triggered = names.some((n) => pair.when.test(n) && !(pair.unless?.test(n) ?? false) && (PET_ITEM_RE.test(n) ? petPair : true));
    if (!triggered) continue;
    // "Já tem": olha os OUTROS itens (o próprio gatilho "pão de hambúrguer" contém "hambúrguer").
    if (names.some((n) => !pair.when.test(n) && pair.has.test(n))) continue;
    if (declined.has(normComplement(pair.query)) || declined.has(normComplement(pair.shelfId))) continue;
    const shelf = pair.shelfId === "produto" ? undefined : opts.shelfById(pair.shelfId);
    if (shelf?.flags?.includes("mip")) continue;
    return { query: pair.query, shelfId: pair.shelfId, why: pair.why, trigger: pair.trigger };
  }
  return null;
}

// Segue o portão da recomendação (08/10, noite): em LIA_RECOMMEND=test só dono/admins recebem a oferta.
export function complementEnabled(): boolean {
  return process.env.LIA_RECOMMEND_COMPLEMENT !== "false" && recommendEnabled();
}
