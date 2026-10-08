// Rodada de QUALIDADE da recomendação (08/10/2026, noite; placar scripts/bench-recommend.mts, linha de base
// final-r2: atende 73,5%, card errado 23,1%, restrição respeitada 81,3%, motivo verdadeiro 58,5%). Regras
// determinísticas, puras (sem rede, sem banco) e verificáveis, que valem COM e SEM IA:
//   - RESTRIÇÃO é dura: o candidato de prateleira de risco ("sem lactose" em laticínio, doce, padaria…)
//     precisa PROVAR no nome ("zero lactose", "sem glúten", "vegano"); fora dela, não pode ter palavra que
//     fere ("leite", "trigo", "carne"). Palavra solta ("sem porco", "sem álcool", "sem dipirona") vira a
//     família inteira (suíno/bacon/linguiça; cerveja/vinho/destilado; Novalgina/Dorflex…).
//   - ATRIBUTO do produto julgado ("shampoo pra cacheado", "café de coador", "pasta pra dente sensível")
//     vira exigência no nome quando algum candidato a cumpre.
//   - PRATELEIRA certa: o item tem de ser do tipo da prateleira (hortifrúti não aceita Ruffles nem
//     Gatorade "frutas cítricas"; café não aceita copo; comida não aceita fórmula infantil).
//   - MOTIVO (why) só com fato que o card sustenta: nada de "o mais vendido", "marca líder", prazo
//     prometido ou "o mais em conta" fora do card realmente mais barato.
import type { RecommendCriterion } from "./types";

export function normQ(input: string | undefined | null): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- restrições de dieta

export type DietKind = "lactose" | "gluten" | "vegan" | "vegetarian" | "sugar";

// Prateleiras onde o item comum FERE a restrição: só passa quem prova no nome (ou é naturalmente livre).
const RISK: Record<DietKind, RegExp> = {
  lactose:
    /^(frios\.|doces\.(chocolate|chocolate_presente|sorvete|bolo|biscoito_doce|doces)$|padaria\.|congelados\.|lanches\.|snacks\.(biscoito_salgado|salgadinho)$|mercado\.(achocolatado|cereal_matinal|barra_cereal|sopa|macarrao_instantaneo|confeitaria)$|bebe\.(formula_infantil|papinha)$|farmacia\.suplementos$)/,
  gluten:
    /^(padaria\.|doces\.(bolo|biscoito_doce|chocolate|chocolate_presente|doces|sorvete)$|snacks\.|congelados\.|lanches\.|mercado\.(macarrao|macarrao_instantaneo|cereal_matinal|barra_cereal|sopa|farinha|confeitaria)$|bebidas\.cerveja$|frios\.frios$)/,
  vegan:
    /^(frios\.|carnes\.|doces\.|padaria\.|congelados\.|lanches\.|snacks\.(biscoito_salgado|salgadinho)$|mercado\.(sopa|achocolatado|cereal_matinal|barra_cereal|mel_geleia|confeitaria|macarrao_instantaneo)$|hortifruti\.ovos$|bebe\.(formula_infantil|papinha)$|farmacia\.suplementos$)/,
  vegetarian: /^(carnes\.|frios\.frios$|congelados\.(pratos_prontos|empanados|salgados|pizza)$|lanches\.|mercado\.(sopa|enlatados|macarrao_instantaneo)$)/,
  sugar:
    /^(doces\.|bebidas\.(refrigerante|suco|energetico|isotonico)$|mercado\.(achocolatado|cereal_matinal|barra_cereal|mel_geleia|confeitaria)$|frios\.iogurte$|padaria\.)/
};

// Prova no nome.
const PROOF: Record<DietKind, RegExp> = {
  lactose: /\b(zero|sem|livre de|0%?) lactose\b|\blac ?free\b|\blactose free\b|\bvegan[oa]?s?\b|\b100% vegetal\b|\bbebida vegetal\b|\bsorbet\b|\ba base de agua\b/,
  gluten: /\b(sem|zero|livre de) gluten\b|\bgluten free\b|\bnao contem gluten\b/,
  vegan: /\bvegan[oa]?s?\b|\b100% vegetal\b|\bplant ?based\b|\bnao contem (ingredientes de )?origem animal\b|\bbebida vegetal\b/,
  vegetarian: /\bvegetarian[oa]s?\b|\bvegan[oa]?s?\b|\b100% vegetal\b|\bplant ?based\b|\b(mussarela|muçarela|queijo|queijos|marguerita|margherita|quatro queijos|4 queijos|espinafre|brocolis|palmito|legumes|ricota|tomate suave|sabor tomate|sabor legumes)\b/,
  // "sem adição de açúcar" NÃO prova zero açúcar (o juiz do placar reprovou sorvete/biscoito assim).
  sugar: /\b(zero|sem) acucar(es)?\b|\bzero\b(?! (lactose|gluten|alcool|cafeina))|\bdiet\b|\bsugar free\b|\b0% acucar\b/
};

// Naturalmente livre mesmo dentro de prateleira de risco (sem precisar de selo).
const NATURAL: Partial<Record<DietKind, RegExp>> = {
  // Pão francês/italiano e baguete não levam leite na receita (placar q1: café da manhã sem lactose sem pão).
  lactose: /\b(pao frances|paes franceses|baguete|ciabatta|pao italiano|tapioca|pipoca|castanhas?|frutas?|banana)\b/,
  // (08/10, corpus difícil h03) o que é naturalmente sem glúten: fruta, iogurte natural, queijo, ovo,
  // castanha, pipoca, arroz, tapioca, mandioca, batata.
  gluten: /\b(pipoca|pipocas|castanhas?|amendoas?|nozes|macadamia|pistaches?|mandioca|tapioca|biscoitos? de arroz|bolachas? de arroz|chips de banana|frutas?|banana|maca|iogurte natural|queijos?|ovos?|arroz|batata|polvilho|pao de queijo)\b/
};

// Natural vale pelo NOME do produto (as 2 primeiras palavras): "Castanha de Caju" é natural, "Salgadinho
// Queijo Nacho Doritos" não é (placar difícil q1: o "queijo" do sabor liberava o Doritos pra celíaca).
const PROCESSED_HEAD_RE = /^(salgadinh\w*|biscoit\w*|bolach\w*|barra|barrinha|snack|snacks|bolo|torta|cereal|sanduich\w*|pizza|empanad\w*|nuggets|macarrao|massa|lasanha)\b/;
function naturallyFree(kind: DietKind, text: string): boolean {
  const re = NATURAL[kind];
  if (!re) return false;
  if (PROCESSED_HEAD_RE.test(text)) return false;
  return re.test(text.split(" ").slice(0, 3).join(" "));
}

// O que fere a restrição em QUALQUER prateleira.
const VIOLATES: Record<DietKind, RegExp> = {
  lactose:
    /\b(leite|leites|queijo|queijos|iogurte|iogurtes|yogurt|requeijao|manteiga|laticinios?|sorvete|sorvetes|creme de leite|chantilly|doce de leite|nata|coalhada|petit suisse|achocolatado|ao leite|bombom|bombons|trufa|trufas|whey|cappuccino|capuccino|mussarela|parmesao|cheddar|catupiry|lacteo|lactea|cremoso|alpino|galak|negresco|passatempo|chocolate)\b/,
  gluten:
    /\b(pao|paes|biscoito|biscoitos|bolacha|bolachas|bolo|bolos|macarrao|massa|massas|torrada|torradas|cerveja|cervejas|wafer|pizza|lasanha|bisnaguinha|cereal|cereais|granola|aveia|trigo|cevada|malte|empanad\w*|japones|crocante|croissant|panetone|rosca|esfiha|pastel|coxinha|kibe|quibe|nuggets|sanduiche|lamen|miojo|hot pocket|cookie|cookies|brownie)\b/,
  vegan:
    /\b(carne|carnes|picanha|frango|linguica|bacon|presunto|salame|peixe|atum|sardinha|camarao|leite|queijo|queijos|iogurte|requeijao|manteiga|ovo|ovos|mel|hamburguer|salsicha|mortadela|peito de peru|sorvete|ao leite|bombom|bombons|whey|colageno|gelatina|mussarela|parmesao|cheddar|nata|creme de leite|chantilly|lacteo|lactea|trufa|trufas|alpino|galak|cremoso)\b/,
  vegetarian:
    /\b(carne|carnes|picanha|alcatra|fraldinha|costela|frango|linguica|calabresa|bacon|presunto|salame|peito de peru|mortadela|salsicha|hamburguer|peixe|atum|sardinha|camarao|bacalhau|tilapia|salmao|pepperoni|x bacon|x burguer|x salada|frutos do mar|suin[oa]|bovin[oa]|nuggets|empanado de frango|gelatina|colageno)\b/,
  sugar: /\b(acucar|leite condensado|brigadeiro|doce de leite|mel|xarope de glicose|recheado|recheados|cobertura)\b/
};

// Natural com cobertura/recheio deixa de ser natural ("pipoca gourmet com cobertura de chocolate").
const COATED_RE = /\b(cobert\w*|chocolate|caramel\w*|recheio|recheado|gourmet|doce de leite|leite condensado)\b/;

// Prateleiras que cumprem por natureza uma restrição de alérgeno (sem processamento com traços).
// (q9) Também as prateleiras que não são comida (brinquedo, livro, moda, eletrônico, papelaria, festa, flores): alergia a
// amendoim não tem o que verificar ali (r35: "viagem com 2 crianças, nada de amendoim" zerava livro e brinquedo).
const ALLERGEN_SAFE_SHELF = /^(hortifruti\.(frutas|legumes|verduras)|bebidas\.(agua|agua_coco)|mercado\.(cafe|cha|arroz|feijao|acucar|sal)|carnes\.|casa\.|higiene\.|limpeza\.|beleza\.|pet\.|farmacia\.|bebe\.(fralda|lenco_umedecido|higiene_bebe)|brinquedo\.|livraria\.|moda\.|eletronico\.|papelaria\.|festa\.|presente\.flores)/;

// A prateleira é de risco pra esta regra de dieta (o item comum fere; só passa quem prova no nome)? Palavra solta
// ("sem porco") e "sem remédio" não têm prateleira de risco. (q9: o plano põe as de risco depois das livres.)
export function shelfAtRisk(rule: { kind: string }, shelfId: string): boolean {
  return rule.kind in RISK && RISK[rule.kind as DietKind].test(shelfId);
}

export type DietRule = { kind: DietKind };
export type WordRule = { kind: "word"; word: string; family: RegExp; allow?: RegExp };
// "sem remédio"/"não quero remédio" (corpus difícil h13/h28): nenhuma prateleira nem item de remédio.
export type NoMedicineRule = { kind: "no_medicine" };
export type ConstraintRuleQ = DietRule | WordRule | NoMedicineRule;

// Alergia/restrição de amendoim, castanha ou fruto do mar: o nome não prova ausência de traços.
export function isAllergenRule(rule: ConstraintRuleQ): boolean {
  return rule.kind === "word" && /\b(amendoim|amendoins|castanhas?|nozes|amendoas?|camarao|frutos do mar|crustace\w*|ovo|ovos|soja)\b/.test(rule.word);
}

// Família de palavras de cada restrição solta ("sem X"). Vence a primeira cuja chave casa com X.
const WORD_FAMILIES: Array<{ key: RegExp; family: RegExp; allow?: RegExp }> = [
  {
    key: /\b(porco|porcos|suin[oa]s?|carne de porco|carne suina)\b/,
    family: /\b(porco|suin[oa]s?|bacon|pernil|lombo|panceta|toucinho|torresmo|costelinha|linguicas?|calabresa|toscana|presunto|salame|copa|mortadela|salsichas?|pepperoni|leitao|banha)\b/,
    allow: /\b(de frango|frango|bovin[oa]|de peru)\b/
  },
  {
    key: /\b(alcool|alcoolic\w*|bebida alcoolica|bebidas alcoolicas|alcoolica)\b/,
    family: /\b(cervejas?|chope|chopp|vinhos?|espumantes?|champagne|champanhe|prosecco|whisky|whiskey|uisque|vodka|gin|cachaca|licor|rum|tequila|sake|caipirinha|drinks?|ice|beats|alcool|alcoolic\w*|aperol|campari|vermute|conhaque|sidra)\b/,
    allow: /\b(sem alcool|zero alcool|0 0|nao alcoolic\w*|alcool 0)\b/
  },
  {
    key: /\b(cafeina|cafe)\b/,
    family: /\b(cafe|cafes|cafeina|espresso|expresso|cappuccino|capuccino|energetic\w*|red bull|monster|cha preto|cha verde|cha mate|chimarrao|mate|matte|coca cola|coca|pepsi|achocolatad\w*|toddy|nescau|ovomaltine|guarana em po|chocolate amargo)\b/,
    allow: /\b(descafeinado|sem cafeina|decaf|zero cafeina)\b/
  },
  { key: /\b(energetic\w*)\b/, family: /\b(energetic\w*|energy drink|red bull|monster|tnt|burn|fusion|reign)\b/ },
  {
    key: /\b(amendoim|amendoins)\b/,
    family: /\b(amendoim|amendoins|pacoca|pacocas|pe de moleque|mendorato|dori|pasta de amendoim|amendoa de amendoim|crokissimo|amendupa)\b/
  },
  {
    key: /\b(dipirona|novalgina|metamizol)\b/,
    family: /\b(dipirona|metamizol|novalgina|neosaldina|dorflex|lisador|anador|magnopyrol|atroveran|buscopan composto|sedalgina|doril)\b/
  },
  { key: /\b(ibuprofeno|advil|alivium)\b/, family: /\b(ibuprofeno|advil|alivium|buscofem|ibupril|spidufen|motrin|ibuflex)\b/ },
  { key: /\b(paracetamol|tylenol)\b/, family: /\b(paracetamol|tylenol|acetaminofen\w*|naldecon|resfenol|cimegripe|vick pyrena|tandrilax)\b/ },
  {
    key: /\b(chocolates?)\b/,
    family:
      /\b(chocolates?|choco\w*|bombons?|trufas?|cacau|brigadeiros?|nutella|ovomaltine|achocolatad\w*|nescau|toddy|lacta|garoto|kit ?kat|bis|prestigio|sonho de valsa|ouro branco|talento|baton|twix|snickers|ferrero|lindt|hershey|hersheys|toblerone|laka|diamante negro|alpino|galak|suflair|charge|chokito|milka|kinder|negresco|trento|oreo|brownie|tablito|chicabon|cookies? and cream|stikadinho|mms|m m)\b/
  },
  { key: /\b(acucar)\b/, family: /\b(acucar|leite condensado|brigadeiro|doce de leite|xarope de glicose)\b/, allow: PROOF.sugar },
  { key: /\b(leite)\b/, family: VIOLATES.lactose, allow: PROOF.lactose },
  { key: /\b(carne|carnes)\b/, family: VIOLATES.vegetarian, allow: PROOF.vegetarian },
  { key: /\b(gorduros\w*)\b/, family: /\b(castanhas?|amendoim|amendoins|nozes|salgadinhos?|chips|frit[oa]s?|bacon|salame|calabresa|pizza|hamburguer|empanad\w*|coxinha|pastel|nuggets|torresmo|maionese|requeijao)\b/ },
  { key: /\b(fritura|frituras|frito|fritos)\b/, family: /\b(chips|batata frita|salgadinho|salgadinhos|frit[oa]s?|empanad\w*|nuggets|coxinha|pastel|pasteis|torresmo|doritos|ruffles|pringles|cheetos|fandangos)\b/ },
  { key: /\b(pimenta|picante|apimentad\w*)\b/, family: /\b(pimenta|picante|apimentad\w*|hot|chilli|chili|jalapeno|sriracha|calabresa)\b/ },
  { key: /\b(refrigerante|refrigerantes|refri)\b/, family: /\b(refrigerantes?|refri|coca cola|guarana|soda|fanta|sprite|pepsi|tonica)\b/ }
];

// Ruído depois da palavra: "sem dipirona (alergia)", "sem porco pq não como".
const WORD_NOISE = /\s+(alergia|alergico|alergica|pq|porque|por causa|por favor|pfv|pf|nao como|nao bebo|nao tomo)\b.*$/;

function wordStemRe(word: string): RegExp {
  const stem = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${stem}(s|es)?\\b`);
}

// Frase de restrição → regra. "zero açúcar"/"sem açúcar"/"diet" agora é DURA (rodada de qualidade 08/10:
// diabética recebia chocolate comum); "light", "pouco sal", "sem conservante" seguem preferência.
export function parseConstraint(raw: string): ConstraintRuleQ | null {
  const c = normQ(raw).replace(WORD_NOISE, "").trim();
  if (!c) return null;
  if (/\blactose\b/.test(c) || /\b(intolerante|alergi\w*) (a |ao )?leite\b/.test(c) || /\bsem leite\b/.test(c)) return { kind: "lactose" };
  if (/\bgluten\b/.test(c) || /\bceliac[oa]s?\b/.test(c)) return { kind: "gluten" };
  if (/\bvegan[oa]?s?\b/.test(c)) return { kind: "vegan" };
  if (/\bvegetarian[oa]s?\b/.test(c) || /\bnao como carne\b/.test(c)) return { kind: "vegetarian" };
  if (/\b(zero|sem) acucar\b|^diet$|\bdiet\b/.test(c)) return { kind: "sugar" };
  if (/^(?:sem|nada de|nao quero|nao pode ser|nao posso tomar|evitar|sem tomar)\s+(?:um |nenhum |o |os )?(remedio|remedios|medicamento|medicamentos|remedinho)\b/.test(c)) return { kind: "no_medicine" };
  const m = c.match(/^(?:sem|nada de|nao quero|nao pode ter|tirar?|tira|exceto|menos|alergi\w* (?:a|ao|de))\s+(.+)$/);
  const word = m?.[1]?.replace(/^(o|a|os|as)\s+/, "").trim();
  if (!word || /^(sal|gordura|conservantes?|corante|pressa)$/.test(word)) return null;
  const fam = WORD_FAMILIES.find((f) => f.key.test(word));
  if (fam) {
    const label = new RegExp(`\\b(sem|zero|livre de|nao contem|free de) ${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return { kind: "word", word, family: fam.family, allow: fam.allow ?? label };
  }
  return { kind: "word", word, family: wordStemRe(word), allow: new RegExp(`\\b(sem|zero|livre de) ${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) };
}

// O texto (nome do candidato, ou query + rótulo da prateleira) fere a regra? Com `shelfId` de prateleira
// de risco, o candidato só passa provando no nome (ou sendo naturalmente livre).
export function violatesRule(textRaw: string, rule: ConstraintRuleQ, shelfId?: string): boolean {
  const text = normQ(textRaw);
  if (!text) return false;
  // Remédio sai pela prateleira (mip) e pela flag do item — quem decide é o chamador (fallback.ts).
  if (rule.kind === "no_medicine") return false;
  if (rule.kind === "word") {
    if (rule.allow?.test(text)) return false;
    // Alergia (placar q5: biscoito/salgadinho "sem amendoim" só pelo nome): o nome não prova a ausência de
    // traços. Fora das prateleiras naturalmente livres (fruta, legume, água, carne, café…), só sai o que o
    // próprio rótulo declara ("sem amendoim"); sem nada, a Lia diz que não consegue garantir.
    if (shelfId && isAllergenRule(rule) && !ALLERGEN_SAFE_SHELF.test(shelfId)) return true;
    return rule.family.test(text);
  }
  const kind = rule.kind;
  // "Sem adição de açúcar" não é zero açúcar, mesmo com "Zero" no nome da linha (Pense Zero).
  const proven = PROOF[kind].test(text) && !(kind === "sugar" && /\bsem adicao de acucar\b/.test(text) && !/\b(zero|sem) acucar\b|\bdiet\b/.test(text));
  if (kind === "vegetarian") {
    // Carne no nome fere mesmo com "queijo" junto ("pizza calabresa com queijo").
    if (VIOLATES.vegetarian.test(text) && !/\bvegetarian[oa]s?\b|\bvegan[oa]?s?\b|\bvegetal\b|\bplant ?based\b/.test(text)) return true;
    if (shelfId && RISK.vegetarian.test(shelfId)) return !proven;
    return false;
  }
  // "Vegana ... ao Leite" (placar difícil q1): a palavra que fere no nome vale mais que a prova.
  if (kind === "vegan" && /\b(ao leite|whey|leite em po|com leite|colageno)\b/.test(text)) return true;
  if (proven) return false;
  if (shelfId && RISK[kind].test(shelfId)) return !(naturallyFree(kind, text) && !VIOLATES[kind].test(text) && !COATED_RE.test(text));
  if (kind === "lactose" && /\bchocolate\b/.test(text) && /\b(amargo|70%|80%|85%|meio amargo)\b/.test(text) && !/\bao leite\b/.test(text)) return false;
  return VIOLATES[kind].test(text);
}

// Fruta, suco, água de coco, café, leite e ovo não levam (conforme o caso) leite, trigo nem carne: o motivo diz isso quando
// o cliente pediu a dieta e o nome não prova (r24: o juiz reprovava o suco "sem lactose" porque o motivo não dizia nada;
// h19: leite zero lactose para quem também é celíaco). Só nome sem ingrediente que fere e sem cobertura/recheio.
const NATURAL_BY_KIND: Partial<Record<DietKind, RegExp>> = {
  lactose: /^(hortifruti\.|bebidas\.(suco|agua|agua_coco)$|mercado\.(cafe|cha|arroz|feijao)$)/,
  gluten: /^(hortifruti\.|bebidas\.(suco|agua|agua_coco)$|frios\.(leite|iogurte)$|mercado\.(cafe|cha|arroz|feijao)$)/,
  vegan: /^(hortifruti\.(frutas|legumes|verduras)$|bebidas\.(suco|agua|agua_coco)$|mercado\.(cafe|cha|arroz|feijao)$)/
};
const NATURAL_LABEL: Partial<Record<DietKind, string>> = { lactose: "sem lactose", gluten: "sem glúten", vegan: "vegano" };
function naturalNoun(shelfId: string): string {
  if (/^hortifruti\.ovos$/.test(shelfId)) return "ovo";
  if (/^hortifruti\.(verduras|legumes)$/.test(shelfId)) return "verdura/legume";
  if (/^hortifruti\./.test(shelfId)) return "fruta";
  if (/frios\.iogurte$/.test(shelfId)) return "iogurte natural";
  if (/suco$/.test(shelfId)) return "suco de fruta";
  if (/frios\.leite$/.test(shelfId)) return "leite";
  if (/mercado\.cafe$/.test(shelfId)) return "café";
  if (/mercado\.cha$/.test(shelfId)) return "chá";
  if (/mercado\.(arroz|feijao)$/.test(shelfId)) return "grão";
  return "bebida";
}
export function naturalDietWhy(name: string, shelfId: string, rules: readonly ConstraintRuleQ[]): string | undefined {
  const text = normQ(name);
  if (COATED_RE.test(text) || /\b(vitamina|lacteo|cremos\w*|nectar de leite|achocolatado|cappuccino|capuccino|aromatizad\w*|maionese|molho|frango|atum|presunto|queijo|empanad\w*|congelad\w*|pronta|temperad\w*|granola|cereal|biscoito|cookie|brownie|chocolate)\b/.test(text)) return undefined;
  const labels: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "word" || rule.kind === "no_medicine" || rule.kind === "vegetarian" || rule.kind === "sugar") continue;
    const re = NATURAL_BY_KIND[rule.kind];
    if (!re?.test(shelfId) || PROOF[rule.kind].test(text)) continue;
    // "leite" é do próprio produto no frios.leite: só vale pra glúten ali.
    // Iogurte só vale como "naturalmente sem glúten" quando o nome diz natural/grego tradicional (sem sabor nem mistura).
    if (shelfId === "frios.iogurte" && !/\b(natural|grego tradicional|grego natural|tradicional)\b/.test(text)) continue;
    const violates = shelfId === "frios.leite" ? /\b(trigo|cevada|malte|aveia|biscoito|cereal)\b/.test(text) : VIOLATES[rule.kind].test(text);
    if (!violates) labels.push(NATURAL_LABEL[rule.kind]!);
  }
  return labels.length ? `${naturalNoun(shelfId)}, naturalmente ${labels.join(" e ")}` : undefined;
}

// Prova de dieta no nome → motivo factual ("zero lactose no rótulo").
export function dietProofWhy(name: string, rules: readonly ConstraintRuleQ[]): string | undefined {
  const text = normQ(name);
  for (const rule of rules) {
    if (rule.kind === "word" || rule.kind === "no_medicine") continue;
    if (!PROOF[rule.kind].test(text)) continue;
    if (rule.kind === "lactose" && /\b(zero|sem|0%?) lactose\b|\blac ?free\b/.test(text)) return "zero lactose no rótulo";
    if (rule.kind === "gluten") return "sem glúten no rótulo";
    if (rule.kind === "vegan" && /\bvegan/.test(text)) return "vegano no rótulo";
    if (rule.kind === "sugar" && /\b(zero|sem) (adicao de )?acucar|\bzero\b|\bdiet\b/.test(text)) return /\bdiet\b/.test(text) ? "versão diet" : "versão zero açúcar";
  }
  return undefined;
}

// ---------------------------------------------------------------- atributo do produto julgado

type AttributeRule = { require: RegExp; forbid?: RegExp; why: string };
const ATTRIBUTES: Array<{ key: RegExp } & AttributeRule> = [
  { key: /\b(cache\w*|cachos?|crespo\w*|ondulad\w*)\b/, require: /\b(cache\w*|cachos?|crespo\w*|curly|ondulad\w*|juba|cachinhos)\b/, forbid: /\b(liso|lisos|anticaspa)\b/, why: "linha pra cabelo cacheado" },
  { key: /\b(coador|passado|de filtro)\b/, require: /\b(po|moido|moidos|torrado e moido|tradicional|extra forte)\b/, forbid: /\b(capsulas?|soluvel|instantaneo|copo|caneca|cappuccino|capuccino|graos?|sache|dolce gusto|nespresso|tres)\b/, why: "café em pó, pra coador" },
  { key: /\b(oleos\w*|oil free|acne)\b/, require: /\b(oleos\w*|oil ?free|toque seco|antioleosidade|mista|matte|acne)\b/, why: "indicado pra pele oleosa" },
  { key: /\b(recem nascid\w*|rn|prematur\w*)\b/, require: /\b(rn|recem nascid\w*|prematur\w*)\b/, why: "tamanho RN (recém-nascido)" },
  { key: /\bsensiv\w*\b/, require: /\b(sensiv\w*|sensodyne)\b/, forbid: /\b(branqueador\w*|clareador\w*|whitening|mais brancos?)\b/, why: "linha pra dente sensível" },
  { key: /\b(gatos?|gatas?|gatinh\w*|felin\w*)\b/, require: /\b(gat[oa]s?|gatinh\w*|felin\w*|cat)\b/, forbid: /\b(caes|cao|cachorr\w*|dog)\b/, why: "própria pra gato" },
  { key: /\b(cachorr\w*|caes|cao|dog)\b/, require: /\b(caes|cao|cachorr\w*|dog|canin\w*)\b/, forbid: /\b(gat[oa]s?|felin\w*)\b/, why: "própria pra cachorro" },
  { key: /\b(seca|secos?|ressecad\w*)\b/, require: /\b(sec[oa]s?|ressecad\w*|hidrata\w*|nutri\w*)\b/, why: "pra pele/cabelo seco" },
  { key: /\b(infantil|crianca|criancas|kids)\b/, require: /\b(infantil|kids|crianca|criancas|junior|baby)\b/, why: "versão infantil" }
];

// O motivo é o atributo COMO O CLIENTE DISSE ("pra pele sensível"), nunca o modelo de outra linha (corpus
// difícil h26: "pele sensível" saía com "linha pra dente sensível").
export function attributeRule(constraint: string): AttributeRule | null {
  const c = normQ(constraint);
  if (!c || /^(sem|zero|nada de|nao|tira|menos|exceto)\b/.test(c) || /\b(orcamento|reais|barat\w*|lactose|gluten|vegan\w*|vegetarian\w*|acucar|diet|remedio\w*)\b/.test(c)) return null;
  const hit = ATTRIBUTES.find((a) => a.key.test(c));
  const said = constraint.trim().replace(/\s+/g, " ").toLowerCase();
  return hit ? { require: hit.require, forbid: hit.forbid, why: said.length <= 40 ? `pra ${said}` : hit.why } : null;
}

export function attributeRules(constraints: readonly string[]): AttributeRule[] {
  return constraints.map(attributeRule).filter((r): r is AttributeRule => Boolean(r));
}

export function meetsAttributes(name: string, rules: readonly AttributeRule[]): boolean {
  const text = normQ(name);
  return rules.every((r) => r.require.test(text) && !r.forbid?.test(text));
}

// ---------------------------------------------------------------- prateleira certa

// O item é do TIPO da prateleira? (o piso pelo substantivo-cabeça deixa passar "Batata Ruffles" no
// hortifrúti por "batata", "Gatorade Frutas Cítricas" em frutas, "Eco Copo Café" no café.)
const PROCESSED_RE =
  /\b(chips|ruffles|pringles|batata palha|salgadinho|snack|snacks|isotonic\w*|gatorade|powerade|trufa|minitrufa|chocolate|bombom|suco|sucos|nectar|bala|balas|biscoito|bolacha|iogurte|sorvete|picole|geleia|doce|bolo|cereal|barra|refrigerante|cha|agua|polpa|panettone|chocotone|cristalizad\w*|tempero|temperos|desidratad\w*|liofilizad\w*|bebida|tablete|creme|sabonete|shampoo|hidratante|perfume|colonia|body|vela|aromatizador|essencia|sache|gelatina|pastilha|molho|conserva|enlatad\w*|pure|farinha|farofa|drage|drages|dragea|dragees|pouch|passa|passas|maionese|salpicao|frango|atum|presunto|empanad\w*|bacon)\b/;
const NOT_FOOD_RE =
  /\b(comprimidos?|capsulas?|medicamento|formula infantil|fraldas?|pomada|shampoo|sabonete|hidratante|creme dental|desodorante|perfume|colonia|bepantol|aptanutri|aptamil|cafeteira|brinquedo|pelucia|livro|camiseta|vela|caneca|xicara|garrafa termica)\b/;
const SHELF_SANITY: Array<{ shelf: RegExp; forbid: RegExp }> = [
  { shelf: /^hortifruti\.(frutas|legumes|verduras)$/, forbid: PROCESSED_RE },
  { shelf: /^mercado\.cafe$/, forbid: /\b(copo|caneca|xicara|cafeteira|filtro de papel|garrafa|porta|bombom|tablete|bolo|biscoito|chocolate)\b/ },
  { shelf: /^mercado\.cha$/, forbid: /\b(chaleira|xicara|caneca|infusor|garrafa)\b/ },
  { shelf: /^casa\.churrasco$/, forbid: /\b(eletric\w*|127v|220v|bivolt)\b/ },
  { shelf: /^(frios|doces|snacks|lanches|padaria|congelados|bebidas|carnes)\./, forbid: NOT_FOOD_RE },
  { shelf: /^mercado\.(?!cafe$)/, forbid: NOT_FOOD_RE },
  { shelf: /^doces\.chocolate$/, forbid: /\b(achocolatado|em po|cobertura|forma de|molde|caneca)\b/ },
  { shelf: /^doces\.(doces|bolo|biscoito_doce|balas)$/, forbid: /\b(picole|sorvete|acai)\b/ },
  // Brinquedo só na prateleira de brinquedo/bebê/pet (placar q1: "Boneca Minnie" em acessórios de moda).
  { shelf: /^(?!brinquedo\.|bebe\.|pet\.|festa\.|livraria\.)/, forbid: /\b(boneca|bonecas|boneco|bonecos|brinquedo|brinquedos|pelucia|lego)\b/ },
  { shelf: /^bebe\.lenco_umedecido$/, forbid: /\b(nasal|nasais|nariz|intimo|intima|intimos|intimas)\b/ },
  { shelf: /^snacks\.amendoim_castanhas$/, forbid: /\b(india|comprimidos?|capsulas?|varivax|extrato|suplemento|vitamina)\b/ },
  { shelf: /^hortifruti\.ovos$/, forbid: /\b(tempero|temperos|spices|casca|ovo de pascoa|chocolate|chocotone|po)\b/ },
  { shelf: /^farmacia\.antisseptico_cicatrizante$/, forbid: /\b(garganta|bucal|pastilha|pastilhas|anestesic\w*|spray bucal|cystex|urinari\w*|cistite)\b/ },
  { shelf: /^farmacia\.curativo$/, forbid: /\b(acne|acnes|espinha|espinhas|cravos?)\b/ },
  { shelf: /^higiene\.absorvente$/, forbid: /\b(fraldas?|geriatric\w*|infantil)\b/ },
  { shelf: /^bebe\.higiene_bebe$/, forbid: /\b(kids|minions|teen|adulto)\b/ },
  // Barril de chope (5 L, precisa de chopeira) não é cerveja de churrasco (q9: "churrasco pra 12" → 2 barris Heineken).
  { shelf: /^bebidas\.cerveja$/, forbid: /\b(barril|barris|chopeira)\b/ }
];

export function shelfSanityOk(shelfId: string, name: string, category?: string): boolean {
  // "batata doce" é legume, não doce.
  const text = normQ(`${name}`).replace(/\bbatata doce\b/g, "batata");
  for (const rule of SHELF_SANITY) {
    if (rule.shelf.test(shelfId) && rule.forbid.test(text)) return false;
  }
  void category;
  return true;
}

// ---------------------------------------------------------------- atributo pedido que o NOME prova (q9)

// "ração pro gato castrado com problema nos rins", "meu cachorro tá cheio de pulga": o atributo é a razão
// do pedido, e o juiz do placar reprovava ração comum com motivo "pra problema renal" e shampoo
// "antifúngico" no lugar do antipulgas. Regra: (1) o MOTIVO (why) que afirma o atributo só sai se o nome
// do card o prova; (2) na prateleira que o atributo vale, só ficam os cards que o provam — e, quando o
// atributo é de saúde/parasita (`strict`), prateleira sem nenhum que prove sai inteira (preferível 1
// card certo a 4 com 3 errados, ou nenhum e a Lia dizer que não achou).
export type ProofAttr = { key: string; ask: RegExp; proof: RegExp; claim: RegExp; shelf: RegExp; strict: boolean; why: string };
export const PROOF_ATTRS: ProofAttr[] = [
  { key: "renal", ask: /\b(rins?|renal|renais)\b/, proof: /\b(renal|renais|rim|rins|kidney)\b/, claim: /\b(renal|renais|rins?)\b/, shelf: /^pet\./, strict: true, why: "linha renal, pra problema nos rins" },
  { key: "urinario", ask: /\b(urinari\w*|cristais|calculo)\b/, proof: /\b(urinar\w*|urinary|struvite)\b/, claim: /\burinar\w*\b/, shelf: /^pet\./, strict: true, why: "linha urinária, pro trato urinário" },
  { key: "pulga", ask: /\b(pulgas?|carrapatos?)\b/, proof: /\b(pulgas?|antipulgas?|carrapatos?|anticarrapatos?)\b/, claim: /\b(pulgas?|carrapatos?)\b/, shelf: /^pet\.(higiene|coleira)/, strict: true, why: "feito pra pulgas e carrapatos" },
  { key: "castrado", ask: /\bcastrad[oa]s?\b/, proof: /\b(castrad\w*|neutered|sterili[sz]ed|sterilised)\b/, claim: /\bcastrad\w*\b/, shelf: /^pet\.racao/, strict: false, why: "própria pra castrados" },
  { key: "filhote", ask: /\b(filhotes?|puppy|kitten|gatinh[oa]|cachorrinh[oa])\b/, proof: /\b(filhotes?|puppy|puppies|kitten|kittens|junior)\b/, claim: /\bfilhotes?\b/, shelf: /^pet\.racao/, strict: false, why: "própria pra filhote" },
  // Cabelo e pele (q9, h15/h26): "queda de cabelo" e "caspa" são strict; "pele sensível" prefere quem prova.
  { key: "queda", ask: /\b(queda de cabelo|cabelo caindo|antiqueda|caindo muito)\b/, proof: /\b(antiqueda|anti queda|queda|fortalecedor\w*|fortalece|crescimento|tonico capilar|biotina)\b/, claim: /\bantiqueda\b|\bqueda\b/, shelf: /^(beleza\.(shampoo|condicionador|tratamento_capilar)|farmacia\.(suplementos|vitaminas))$/, strict: true, why: "linha antiqueda" },
  { key: "caspa", ask: /\bcaspa\b/, proof: /\b(anticaspa|caspa|seborreic\w*)\b/, claim: /\bcaspa\b/, shelf: /^beleza\.(shampoo|condicionador|tratamento_capilar)$/, strict: true, why: "linha anticaspa" },
  { key: "sensivel", ask: /\b(pele sensivel|peles sensiveis|rosacea|atopic\w*)\b/, proof: /\b(sensiv\w*|sensodyne|hipoalerg\w*|atopic\w*|reativ\w*|redness|rosacea|dermato\w*|sensitive)\b/, claim: /\b(pele|peles) sensiv\w*|\bsensiv\w*\b/, shelf: /^(beleza|higiene)\./, strict: false, why: "feito pra pele sensível" },
  { key: "light", ask: /\b(obes\w*|sobrepeso|acima do peso|gordinh\w*)\b/, proof: /\b(light|obes\w*|slim|peso ideal|controle de peso|weight|sobrepeso)\b/, claim: /\b(light|obes\w*|sobrepeso)\b/, shelf: /^pet\.racao/, strict: false, why: "linha light, pra controle de peso" }
];

// Motivo factual do atributo pedido que o nome do card PROVA ("linha renal, pra problema nos rins").
export function provenAttributeWhy(name: string, askRaw: string): string | undefined {
  const n = normQ(name);
  const hit = askedProofAttrs(askRaw).find((a) => a.proof.test(n));
  return hit?.why;
}

export function askedProofAttrs(askRaw: string): ProofAttr[] {
  const ask = normQ(askRaw);
  return PROOF_ATTRS.filter((a) => a.ask.test(ask));
}

// O motivo afirma um atributo (renal, castrado, pulgas, sem lactose…) que o nome do card não prova?
export function whyClaimsUnproven(why: string | undefined | null, name: string, shelfId?: string): boolean {
  const w = normQ(why);
  if (!w) return false;
  const n = normQ(name);
  if (PROOF_ATTRS.some((a) => a.claim.test(w) && !a.proof.test(n))) return true;
  // Chá gelado (ice tea, mate pronto) não é "bebida quente"; amendoim japonês não é "castanha".
  if (/\b(quente|quentinh[oa]|aquece|esquenta)\b/.test(w) && /\b(ice tea|gelad\w*|refrigerad\w*|sorvete|picole)\b/.test(n)) return true;
  if (/\bcastanhas?\b/.test(w) && !/\b(castanhas?|nozes|amendoas?|nuts|pistaches?|caju|macadamia|avela|mix)\b/.test(n)) return true;
  // Dieta no motivo ("sem lactose", "sem glúten", "vegano", "zero açúcar"): o nome prova — ou a prateleira é
  // livre por natureza (fruta, água, carne, café): "naturalmente sem lactose" em banana é fato.
  if (shelfId && ALLERGEN_SAFE_SHELF.test(shelfId)) return false;
  for (const kind of Object.keys(PROOF) as DietKind[]) {
    const claim = kind === "lactose" ? /\blactose\b/ : kind === "gluten" ? /\bgluten\b/ : kind === "vegan" ? /\bvegan\w*\b/ : kind === "sugar" ? /\b(sem|zero) acucar\b|\bdiet\b/ : null;
    if (claim && claim.test(w) && !PROOF[kind].test(n)) return true;
  }
  return false;
}

// Candidatos que cumprem o atributo pedido: nas prateleiras onde ele vale, só quem o PROVA no nome. Sem nenhum que
// prove: atributo `strict` esvazia a prateleira; senão ficam todos (e o motivo não afirma o atributo).
export function keepProvenAttributes<T extends { shelfId: string; option: { name: string } }>(candidates: readonly T[], askRaw: string): T[] {
  let out = [...candidates];
  for (const attr of askedProofAttrs(askRaw)) {
    const shelves = [...new Set(out.filter((c) => attr.shelf.test(c.shelfId)).map((c) => c.shelfId))];
    for (const shelf of shelves) {
      const proving = out.filter((c) => c.shelfId === shelf && attr.proof.test(normQ(c.option.name)));
      if (!proving.length && !attr.strict) continue;
      out = out.filter((c) => c.shelfId !== shelf || proving.includes(c));
    }
  }
  return out;
}

// ---------------------------------------------------------------- motivo factual

// O que NÃO é fato que o card sustenta (o juiz do placar marcou falso em 08/10): popularidade, liderança,
// prazo prometido, comparação de preço solta e juízo de qualidade.
const UNSUPPORTED_WHY_RE =
  /\b(mais vendid\w*|mais pedid\w*|campea\w*|lider|lideres|preferid\w*|queridinh\w*|favorit\w*|sucesso|top|bem avaliad\w*|melhor|melhores|garant\w*|mais barat\w*|mais em conta|em conta|economic\w*|chega\w*|entrega\w*|prazo|amanha|hoje|agora|na hora|\d+ ?(h|min|horas?|minutos?|dias?)|preco medio|preco mais alto|mais caro|faixa de preco|custo beneficio|vale a pena|classic\w* do|o doce mais|o mimo mais|mais procurad\w*|mais comprad\w*|reconhecid\w*|famos\w*|opcoes|opcao|ama|perfeit\w*|ideal|otim\w*)\b/;

export function whyIsFactual(why: string | undefined | null): boolean {
  const text = normQ(why);
  return Boolean(text) && !UNSUPPORTED_WHY_RE.test(text);
}

// Critério "rápido" valendo (pedido com urgência ou critério fast).
export function wantsFast(criteria: readonly RecommendCriterion[], urgency?: boolean): boolean {
  return Boolean(urgency) || criteria.includes("fast");
}

// Prazo: em pedido urgente, quando há item que chega em até 6 h (ou no dobro do menor prazo), o que leva
// um dia ou mais sai — mas só se sobrarem ≥ 2 prateleiras (senão fica tudo, ordenado por prazo).
export function fastEtaCutoff(etas: readonly (number | undefined)[]): number | undefined {
  const known = etas.filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m > 0);
  if (!known.length) return undefined;
  const min = Math.min(...known);
  if (min >= 12 * 60) return undefined;
  return Math.max(6 * 60, 2 * min);
}

// Mesmo produto em outro tamanho/embalagem ("Pampers RN 20" e "Pampers RN 36") não é opção diferente.
// Conjunto de palavras, sem ordem ("Pampers Recém Nascido Premium Care RN 36" = "Pampers Premium Care
// Recém-Nascido RN 36", placar q1) e sem plural.
export function baseProductName(name: string): string {
  const words = normQ(name)
    .replace(/\b\d+([.,]\d+)?\s*(g|kg|mg|ml|l|lt|litros?|un|unid\w*|unidades?|und|x|cm|m|caps?|comp\w*|fps|tam\w*)?\b/g, " ")
    .replace(/\b(com|c|de|da|do|e|kit|leve|pague|pack|fardo|caixa|cx|tamanho|tam|rn|p|m|g|xg|xxg)\b/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(" ");
}

// ---------------------------------------------------------------- busca com a prova da dieta

const DIET_QUERY: Partial<Record<DietKind, string[]>> = {
  lactose: ["sem lactose"],
  gluten: ["sem gluten"],
  vegan: ["vegano"],
  sugar: ["zero acucar"]
};

// Rodada q2 (08/10): "sorvete zero lactose" trazia Kibon comum e adoçante e o sorvete SEM lactose ficava
// fora dos 14 candidatos. Em prateleira de risco, a consulta ganha as variantes com a prova da dieta
// ("sorvete sem lactose | sorvete zero lactose") — a busca acha quem prova no nome.
export function withDietQueries(query: string, shelfId: string, rules: readonly ConstraintRuleQ[]): string {
  const alts = query.split("|").map((q) => q.trim()).filter(Boolean);
  if (!alts.length) return query;
  const extra: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "word" || rule.kind === "no_medicine" || rule.kind === "vegetarian") continue;
    if (!RISK[rule.kind].test(shelfId)) continue;
    for (const alt of alts.slice(0, 2)) {
      const head = normQ(alt).replace(/\b(sem|zero|livre de|0) (lactose|gluten|acucar)\b|\b(vegano|vegana|vegetal|diet|lac free)\b/g, " ").replace(/\s+/g, " ").trim();
      if (!head) continue;
      for (const proof of DIET_QUERY[rule.kind] ?? []) extra.push(`${head} ${proof}`);
    }
  }
  // A prova da dieta vai ANTES: a busca enche os candidatos pela 1ª consulta ("sorvete zero lactose" trazia
  // picolé comum e adoçante "zero").
  const out: string[] = [];
  for (const q of [...extra, ...alts]) if (!out.some((o) => normQ(o) === normQ(q))) out.push(q);
  return out.slice(0, 6).join(" | ");
}

// Condição do bicho dita no pedido de ração (placar difícil q2, h10: "gato castrado com problema nos rins"):
// a consulta ganha a linha terapêutica/específica na frente — achar "renal" no nome é o fato que o juiz cobra.
export function withPetCondition(query: string, shelfId: string, text: string): string {
  if (!/^pet\.racao_/.test(shelfId)) return query;
  const t = normQ(text);
  const species = /^pet\.racao_gato$/.test(shelfId) ? "gato" : "cachorro";
  const extra: string[] = [];
  if (/\b(rins|renal|renais)\b/.test(t)) extra.push(`racao renal ${species}`);
  if (/\b(urinari\w*|cristais|calculo)\b/.test(t)) extra.push(`racao urinary ${species}`);
  if (/\bcastrad[oa]s?\b/.test(t)) extra.push(`racao ${species} castrado`);
  if (/\b(filhote|filhotes|gatinh[oa]|cachorrinh[oa]|adotei|ganhei um)\b/.test(t)) extra.push(`racao filhote ${species}`);
  if (/\b(obes\w*|sobrepeso|acima do peso|gordinh\w*)\b/.test(t)) extra.push(`racao light ${species}`);
  if (!extra.length) return query;
  const out: string[] = [];
  for (const q of [...extra, ...query.split("|").map((x) => x.trim()).filter(Boolean)]) if (!out.some((o) => normQ(o) === normQ(q))) out.push(q);
  return out.slice(0, 5).join(" | ");
}
