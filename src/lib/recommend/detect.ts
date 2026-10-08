// ENTENDER sem IA (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.1): reconhece por
// REGRAS que o cliente pediu uma recomendação — necessidade/estado/ocasião/sintoma/presente sem
// produto ("tô com fome", "algo doce", "churrasco pra 8", "dor de barriga", "presente pra minha
// mãe") ou produto + julgamento ("me recomenda um chocolate bom", "qual o melhor shampoo pra
// cabelo cacheado") — e extrai critérios, restrições, orçamento, pra quem, urgência e sintoma.
// É o caminho quando a IA do gerente de diálogo cai, e a régua da tabela-ouro
// (tests/recommend-golden.test.ts). Puro: sem IA, sem banco, sem rede.
//
// Princípio: ERRAR PARA O LADO DE NÃO RECOMENDAR. A mensagem é quebrada em palavras; cada
// trecho reconhecido (saudação, orçamento, restrição, sintoma, necessidade, julgamento, pra quem,
// critério) é "consumido". Se sobra palavra de conteúdo que não é enfeite de fala, ela é um
// PRODUTO: sem pedido de julgamento, a mensagem é busca de produto (null) — por isso "algo doce
// tipo um chocolate" vira busca do chocolate, e "quero chocolate"/"2 cocas" nunca viram
// recomendação. Com julgamento, o que sobra é o produto julgado.
import { detectIntent, looksLikeMedicine, normalizeMsg, parseBudgetStatement, parsePriceCap } from "../lia-intents";
import type { RecommendCriterion, RecommendForm, RecommendRequest } from "./types";

export type DetectOptions = {
  // Opções na tela (escolha aberta): "mais barato", "outras", "sem X", "qual o melhor?" são sobre
  // ELAS (more_options/refine/pergunta), nunca recomendação nova.
  hasPendingChoice?: boolean;
  // Nomes dos itens da cesta: "o vinho é bom?" com vinho na cesta é pergunta sobre o escolhido.
  basketNames?: string[];
};

type Role = "noise" | "budget" | "constraint" | "symptom" | "need" | "judge" | "recipient" | "criteria" | "group" | "medclass";

type Tok = { orig: string; norm: string; start: number; comma: boolean; role?: Role };

type NeedKind = "symptom" | "gift" | "occasion" | "beauty" | "vontade" | "state" | "open";
type NeedHit = { kind: NeedKind; display: string; key: string; at?: number };

// Ordem de preferência quando a mensagem traz mais de uma necessidade ("tô de ressaca, algo pra dor
// de cabeça" = dor de cabeça; "tô com fome, quero algo doce" = algo doce, e a fome vira critério).
const NEED_PRIORITY: NeedKind[] = ["symptom", "gift", "occasion", "beauty", "vontade", "state", "open"];

const CRITERIA_ORDER: RecommendCriterion[] = ["fast", "good", "cheap", "healthy"];

// ---------------------------------------------------------------- tokens

class Scan {
  toks: Tok[] = [];
  constructor(input: string) {
    // "oq tem de bom", "oque vc indica": a abreviação vira as duas palavras que os padrões esperam.
    const text = input.replace(/(^|[\s,.;:!?])(?:oq|oque|o q)(?=[\s,.;:!?]|$)/gi, "$1o que");
    const re = /[^\s,.;:!?()"“”'‘’…/\\|*_~]+|[,;]/g;
    let pos = 0;
    for (const m of text.matchAll(re)) {
      const raw = m[0];
      if (raw === "," || raw === ";") {
        if (this.toks.length) this.toks[this.toks.length - 1].comma = true;
        continue;
      }
      const norm = normalizeMsg(raw).replace(/[^a-z0-9$%-]/g, "").replace(/^-+|-+$/g, "");
      if (!norm) continue;
      this.toks.push({ orig: raw.replace(/^[-–]+|[-–]+$/g, ""), norm, start: pos, comma: false });
      pos += norm.length + 1;
    }
  }
  // A frase normalizada com os trechos já consumidos trocados por "·" (mesmo comprimento: os
  // índices dos caracteres continuam batendo com os tokens).
  view(): string {
    return this.toks.map((t) => (t.role ? "·".repeat(t.norm.length) : t.norm)).join(" ");
  }
  private range(start: number, end: number): [number, number] | null {
    let first = -1;
    let last = -1;
    for (let i = 0; i < this.toks.length; i++) {
      const t = this.toks[i];
      const tEnd = t.start + t.norm.length;
      if (tEnd > start && t.start < end) {
        if (first < 0) first = i;
        last = i;
      }
    }
    return first < 0 ? null : [first, last];
  }
  // Consome cada ocorrência de `re` (que precisa da flag g) com o papel dado. `fn` recebe o match e
  // a faixa de tokens; devolver false desiste daquele trecho (não consome).
  take(re: RegExp, role: Role, fn?: (m: RegExpMatchArray, r: [number, number]) => boolean | void): number {
    let count = 0;
    const view = this.view();
    for (const m of view.matchAll(re)) {
      const lead = m[0].length - m[0].trimStart().length;
      const text = m[0].trim();
      if (!text || text.includes("·")) continue;
      const r = this.range((m.index ?? 0) + lead, (m.index ?? 0) + lead + text.length);
      if (!r) continue;
      if (this.toks.slice(r[0], r[1] + 1).some((t) => t.role)) continue;
      if (fn && fn(m, r) === false) continue;
      for (let i = r[0]; i <= r[1]; i++) this.toks[i].role = role;
      count++;
    }
    return count;
  }
  origOf(r: [number, number]): string {
    return this.toks
      .slice(r[0], r[1] + 1)
      .map((t) => t.orig.toLowerCase())
      .join(" ");
  }
}

const rx = (src: string) => new RegExp(`(?:^|\\s)(?:${src})(?=\\s|$)`, "g");

// ---------------------------------------------------------------- vocabulário

// Saudação, cortesia, interjeição: nunca é produto.
const NOISE_RE = rx(
  [
    "oi+e?",
    "ol[a]+",
    "opa+",
    "e ?a[ie]+",
    "eai+",
    "iae+",
    "salve",
    "hey",
    "hello",
    "bom dia+",
    "boa tarde+",
    "boa noite+",
    "boa madrugada",
    "tudo (?:bem|bom|certo|joia)",
    "td (?:bem|bom)",
    "blz",
    "beleza",
    "fala(?: lia)?",
    "lia",
    "lizinha",
    "por (?:favor|gentileza)",
    "porfa(?:vor)?",
    "pf+v?r?",
    "obrigad[oa]s?",
    "brigad[oa]",
    "valeu+",
    "vlw+",
    "kk+",
    "rs+",
    "ha(?:ha)+h?",
    "he(?:he)+",
    "aff+",
    "ai+(?= ?$)",
    "nossa+",
    "meu deus",
    "mds",
    "socorro",
    "eita+",
    "oxe",
    "vish+",
    "uai",
    "bah",
    "mano",
    "mana",
    "vei",
    "cara",
    "velho",
    "poxa",
    "puts",
    "putz",
    "caramba",
    "hm+",
    "hum+",
    "ah+",
    "tipo assim",
    "sabe",
    "ne",
    "enfim",
    "olha",
    "entao",
    "pois e",
    "ta bom"
  ].join("|")
);

// Enfeite de fala: verbos de pedir, pronomes, artigos, preposições, intensificadores. Sobrar SÓ
// isso depois dos trechos reconhecidos = não há produto na frase.
const FILLER = new Set(
  (
    "eu voce vc vcs voces ce ces tu a gente nos me mim te comigo pra mim " +
    "to tou tô estou ta esta estamos tamo tamos tava estava fiquei ficou sou ser seja sendo " +
    "e ou mas so tambem tb tbm mais muito muita muitos muitas mt mto mta mtt bem demais super mega bastante tanto tanta meio pouco poquinho " +
    "pra para pro pros pras p pa por de do da dos das no na nos nas num numa em com sem ao aos a o os as um uma uns umas " +
    "algum alguma alguns algumas qualquer que q qual quais quem como onde aqui ai la ali agora hoje ja ainda logo " +
    "quero queria quer queremos gostaria gostava preciso precisava precisando necessito afim fim vontade desejo " +
    "pode poderia podia consegue conseguiria da tem teria tenho temos vende vendem ve manda mandar traz trazer " +
    "compra comprar compro pedir pede peco encomendar achar acha ajuda ajudar ajude escolher escolho sei saber " +
    "nao n sim ok entao assim tipo pois porque pq mesmo msm realmente serio verdade " +
    "algo coisa coisas coisinha coisinhas negocio negocinho treco parada sugestao dica dicas ideia ideias recomendacao indicacao " +
    "comer beber tomar jantar almocar lanchar beliscar petiscar usar passar levar fazer preparar servir comendo bebendo " +
    "casa familia pessoal galera gente seria fosse vai vou iria bora vamo vamos ver dar dou daria presentear presenteio " +
    "sabado domingo segunda terca quarta quinta sexta amanha fds feriado semana noite noitinha tarde cedo madrugada hj " +
    // contexto de fala: intensificador, narrativa curta, "ele ama churrasco"
    "danado danada absurdo enorme terrivel braba brabo grande todo toda todos todas mundo ninguem ele ela eles elas ama adora gosta curte " +
    "estudar trabalhar trabalho dirigir academia treino basico tudo nada posso horas hora gravida gestante amamentando energia bateu veio " +
    "minha meu minhas meus nossa nosso sua seu gente moca amiga amigo querida " +
    // grafias comuns
    "qero qro kero keru qria keria qeria presiso priciso presizo nois oq oque vcs cm tbem pfvr " +
    "ate total reais real conto contos"
  ).split(" ")
);

// Referência às opções/itens já mostrados: "qual desses é melhor?" é pergunta sobre a tela.
const REFERENCE = new Set(
  "esse essa esses essas isso desse dessa desses dessas nesse nessa disso deles delas dele dela aquele aquela aqueles aquelas daquele daquela primeiro primeira segundo segunda terceiro terceira ultimo ultima opcao opcoes outra outro outras outros".split(" ")
);

// Serviço, pedido, pagamento e comandos de cesta: com qualquer um deles a mensagem é outra coisa.
const SERVICE = new Set(
  (
    "frete fretes entrega entregas entregador prazo prazos pix cartao credito debito pagamento pagar paguei pago boleto taxa taxas cupom desconto " +
    "cnpj nota fiscal endereco cep pedido pedidos status rastreio atendente atendimento loja lojas app aplicativo site horario parcela parcelar " +
    "troco reembolso estorno cancelar cancela cancelamento tira tirar remove remover troca trocar bota botar coloca colocar adiciona adicionar " +
    "acrescenta acrescentar inclui incluir esquece finaliza finalizar fecha fechar tenta tentar carrinho cesta sacola valor preco precos"
  ).split(" ")
);

const NUMBER_WORDS = "um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|quarenta|cinquenta";
// Quantidade dita por extenso (sem "um/uma", que é artigo) e número/pronome que nunca é produto.
const QTY_WORD_RE = /^(?:dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|duzia|duzias|meia)$/;
const NUMBER_ONLY_RE = new RegExp(`^(?:${NUMBER_WORDS}|ambos|ambas|eles|elas|primeiro|segundo|terceiro)$`);
const NUMBER_VALUE: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50 };

// ---------- pra quem ----------
const RECIPIENTS: [RegExp, string][] = [
  [/^(?:mae|mamae|maezinha|mainha)$/, "mãe"],
  [/^(?:pai|papai|painho)$/, "pai"],
  [/^namorad[ao]$/, ""],
  [/^esposa$/, "esposa"],
  [/^(?:marido|esposo)$/, "marido"],
  [/^noiv[ao]$/, ""],
  [/^(?:filh[ao]s?)$/, ""],
  [/^(?:criancas?|crianca)$/, "criança"],
  [/^(?:menin[ao]s?|garot[ao]s?)$/, ""],
  [/^(?:bebe|bebes|nenem|neneim|bebezinho|bebezinha)$/, "bebê"],
  [/^(?:avo|vo|vovo|avos)$/, "avó"],
  [/^(?:sogr[ao]|ti[ao]|prim[ao]|cunhad[ao]|sobrinh[ao]|net[ao]|afilhad[ao]|madrinha|padrinho|chefe|colega|vizinh[ao]|professor|professora|amig[ao]s?|irma|irmao|irmas|irmaos)$/, ""],
  [/^(?:cachorr[oa]s?|cao|caes|cadela|dog|doguinho|cachorrinh[oa]|catioro|pet)$/, "cachorro"],
  [/^(?:gat[oa]s?|gatinh[oa]|felino|bichano)$/, "gato"]
];
const RECIP_WORDS =
  "mae|mamae|maezinha|mainha|pai|papai|painho|namorad[ao]|esposa|mulher|marido|esposo|noiv[ao]|filh[ao]s?|criancas?|menin[ao]s?|garot[ao]s?|bebe|bebes|nenem|neneim|bebezinh[oa]|avo|vo|vovo|avos|sogr[ao]|ti[ao]|prim[ao]|cunhad[ao]|sobrinh[ao]|net[ao]|afilhad[ao]|madrinha|padrinho|chefe|colega|vizinh[ao]|professora?|amig[ao]s?|irmas?|irmaos?|cachorr[oa]s?|cao|caes|cadela|dog|doguinho|cachorrinh[oa]|catioro|pet|gat[oa]s?|gatinh[oa]|felino|bichano";
const ACCENTED: Record<string, string> = { irma: "irmã", irmao: "irmão", irmas: "irmãs", irmaos: "irmãos", avo: "avó", vo: "vó", vovo: "vovó" };
const AGE_SRC = `(?:\\s+(?:de|com|que tem|q tem)\\s+(\\d{1,2}|${NUMBER_WORDS})\\s+(anos?|aninhos?|meses|mes))?`;
const RECIP_SRC = `(?:pra|para|pro|pros|pras|p|pa|ao|aos|a|o|da|do|de|dos|das|com)\\s+(?:(?:o|a|os|as)\\s+)?(?:(?:minha|meu|minhas|meus|nossa|nosso|sua|seu|um|uma)\\s+)?(${RECIP_WORDS})${AGE_SRC}`;
const RECIP_RE = rx(RECIP_SRC);
// "meu cachorro", "minha filha de 5 anos" sem preposição.
const RECIP_POSS_RE = rx(`(?:minha|meu|minhas|meus|nossa|nosso)\\s+(${RECIP_WORDS})${AGE_SRC}`);

function recipientDisplay(word: string, ageNum?: string, ageUnit?: string): string {
  let base = word;
  for (const [re, canon] of RECIPIENTS) {
    if (re.test(word)) {
      base = canon || word;
      break;
    }
  }
  base = ACCENTED[base] ?? base;
  if (!ageNum) return base;
  const n = /^\d+$/.test(ageNum) ? Number(ageNum) : NUMBER_VALUE[ageNum] ?? ageNum;
  return `${base} ${n} ${/^mes/.test(ageUnit ?? "") ? "meses" : "anos"}`;
}

// ---------- restrições ----------
const CONSTRAINT_CANON: Record<string, string> = {
  lactose: "lactose",
  gluten: "glúten",
  glutem: "glúten",
  acucar: "açúcar",
  acucares: "açúcar",
  cafeina: "cafeína",
  sodio: "sódio",
  camarao: "camarão",
  chocolate: "chocolate",
  amendoim: "amendoim",
  energetico: "energético",
  energeticos: "energético",
  alcool: "álcool",
  pimenta: "pimenta"
};
// "sem pressa", "sem frete", "sem receita" não são restrição do produto.
const NOT_CONSTRAINT = new Set("pressa frescura problema compromisso frete taxa nada ideia saber dinheiro grana receita tempo paciencia nocao graca vergonha".split(" "));
const CONSTRAINT_RE = rx(
  `(?:sem|zero|nada de|livre de|que nao (?:tenha|leve|tem)|nao (?:pode|posso) (?:ter|comer|tomar)|nao (?:como|tomo|quero))\\s+(?:nada de\\s+|nenhum\\s+|nenhuma\\s+)?([a-z]{3,}(?: de (?:soja|vaca|trigo)| alcoolic[oa]s?| artificia(?:l|is)| refinad[oa]s?| industrializad[oa]s?| animal)?)(?:\\s+(?:alergia|alergic[oa]|intolerancia|pq (?:sou|tenho) alergi\\w*|por causa da alergia))?`
);
const DIET_RE = rx(
  "(veganos?|veganas?|vegetarian[oa]s?|diet|kosher|(?:sou |e |eh )?intolerante (?:a |à )?lactose|(?:sou |e |eh |to )?(?:diabetic[oa]|celiac[oa]|alergic[oa] (?:a|ao|à|com) [a-z]{3,}|tenho alergia (?:a|ao|de) [a-z]{3,}))"
);

// ---------- sintomas (normalizados, com acento na exibição) ----------
const SYMPTOMS: [string, string][] = [
  // EMERGÊNCIA (revisão A2, 08/10): viram necessidade com sintoma (nunca busca literal) para a etapa
  // MAPEAR responder o alerta. "tô com falta de ar" virava aparelho de saúde; "peito apertado e suando
  // frio", sopa/chá. "sem ar condicionado" e "Sangue de Boi" (vinho) ficam de fora.
  ["dor no peito", "dor(?:es)? no peito|(?:aperto|pressao|pontada|queimacao) no peito|peito (?:ta |esta )?(?:apertado|doendo|apertando|pesado)|dor no braco esquerdo"],
  ["falta de ar", "falta de ar|sem ar(?! condicionado)|dificuldade (?:pra|para|de) respirar|nao (?:consigo|consegue|to conseguindo|ta conseguindo) respirar|respirando mal|chiado no peito|sufocad[oa]|sufocando"],
  ["desmaio", "desmaiei|desmaiou|desmaiando|desmaio|desmaiar|convulsao|convulsoes|convulsionando|convulsionou|perdi a consciencia|perdeu a consciencia"],
  ["suor frio", "suando frio|suor frio"],
  ["sangramento", "sangrando|sangramento|sangrou|sangue(?! de boi| bom)"],
  ["confusão mental", "confusao mental|desorientad[oa]|fala enrolada|boca torta|rosto torto"],
  ["inchaço", "garganta fechando|choque anafilatico|(?:rosto|boca|labios?|lingua|garganta) (?:ta |esta )?(?:inchad[oa]s?|inchando|inchou)"],
  ["dor de barriga", "dor(?:es)?(?: (?:muito |bem )?(?:forte|fortissima|horrivel|terrivel|chata|leve|insuportavel))? (?:de|na|no) barriga|dor(?:es)?(?: [a-z]+){1,5} (?:da|na|no|de) barriga|barriga (?:ta |esta )?(?:doendo|ruim|dolorida|estranha)|barriga (?:ta |esta )?(?:doendo|ruim|dolorida|estranha)|mal estar na barriga|colica intestinal"],
  ["dor de estômago", "dor(?:es)? (?:de|no) estomago|estomago (?:ta |esta )?(?:doendo|ruim|embrulhado|virado)|mal estar estomacal"],
  ["diarreia", "diarreia|diarreica|caganeira|desarranjo|intestino solto|disenteria|soltura"],
  ["prisão de ventre", "intestino preso|prisao de ventre|constipad[oa]|sem conseguir ir ao banheiro"],
  ["gases", "(?:muito )?gas(?:es)?|barriga (?:inchada|estufada)|estufad[oa]|empachad[oa]|inchad[oa] de gases"],
  ["má digestão", "ma digestao|indigestao|comi demais|comi muito|digestao ruim"],
  ["azia", "azia|queimacao(?: no estomago)?|refluxo"],
  ["enjoo", "enjoo|enjoos|enjoad[oa]|nausea|nauseas|nausead[oa]|ansia de vomito|vomitando|vontade de vomitar|mareado|mareada"],
  ["dor de cabeça", "dor(?:es)? de cabe(?:c|ss|s)a|cabe(?:c|ss|s)a (?:ta |esta )?(?:doendo|explodindo|latejando|estourando)|enxaqueca"],
  ["dor de garganta", "dor(?:es)? de garganta|garganta (?:ta |esta )?(?:inflamada|doendo|arranhando|irritada|ruim)|rouquidao|rouc[oa]|sem voz"],
  ["gripe", "gripad[oa]|gripe|gripezinha|resfriad[oa]|resfriado|resfriamento"],
  ["tosse", "tosse seca|tosse com catarro|tosse|tossindo"],
  ["febre", "febre|febril|com febre"],
  ["nariz entupido", "nariz (?:ta |esta )?entupido|congestao nasal|nariz escorrendo|coriza|sinusite"],
  ["alergia", "alergia|crise alergica|rinite|espirrando|coceira"],
  ["cólica", "colica(?: menstrual)?|colicas|dor de colica|menstruada com dor"],
  ["dor nas costas", "dor(?:es)? (?:nas|na) costas|costas doendo|dor lombar|lombar doendo"],
  ["dor muscular", "dor(?:es)? muscular(?:es)?|musculo doendo|torcicolo|dor no corpo|corpo doendo|dolorid[oa]|torci o pe|dor (?:no|na|nos|nas) (?:joelho|ombro|perna|pernas|braco|bracos|pescoco|pe|pes)"],
  ["dor de dente", "dor(?:es)? de dente|dente doendo"],
  ["afta", "aftas?"],
  ["picada de inseto", "picadas? de (?:inseto|mosquito|pernilongo|abelha|formiga)|picad[oa] (?:de|por) (?:inseto|mosquito|pernilongo)"],
  ["queimadura de sol", "queimadura de sol|queimei no sol|queimad[oa] de sol|torrad[oa] de sol"],
  ["assadura", "assaduras?"],
  ["ressaca", "ressaca|ressacad[oa]|de ressaca"],
  ["dor", "dor(?:es)?|dorzinha"]
];
const SYMPTOM_LEAD = "(?:(?:to|tou|estou|ta|tamo|estamos|fiquei|ando|acordei|tenho|tive|sentindo|sinto|me deu|deu|bateu|com|uma|um|muita|muito|mt|mto|forte|baita|maior|essa|esta|minha|meu)\\s+)*";
const SYMPTOM_RES = SYMPTOMS.map(([canon, src]) => [canon, rx(`${SYMPTOM_LEAD}(?:${src})`)] as const);
// Com sintoma na frase, estas palavras não são produto: "remédio pra dor de cabeça", "algo pra azia",
// e os sinais de alerta ("dor forte", "faz 3 dias", "gestante") — a etapa MAPEAR é que decide o alerta.
const SYMPTOM_CONTEXT = new Set(
  ("remedio remedios remedinho medicamento medicamentos medicacao comprimido comprimidos forte fortissima horrivel insuportavel pior sangue sangrando dias dia semana semanas faz ha desde ontem anteontem " +
    "gravida gestante gravidez amamentando meses idade velho idosa idoso sentindo aliviar alivia melhorar passar curar resolver ajudar ajuda bom boa posso tomo " +
    "doi doendo engolir respirar tossir dormir falta ar fezes urina xixi coco vomito cocando coca coceira ficar sentado sentada pe vida veio repente embaixo lado direito esquerdo cima baixo toda todo nao para " +
    // comorbidade, remédio contínuo e combinações (revisão A4, 08/10): a MAPEAR decide o alerta.
    "uso usa usando toma tomando anticoagulante anticoagulantes marevan xarelto ulcera ulceras gastrite pressao alta hipertenso hipertensa hipertensao diabetico diabetica diabetes " +
    "asma asmatico asmatica bronquite renal rim rins figado hepatite cardiaco cardiaca coracao urinar mijar pescoco nuca duro dura rigido travado").split(" ")
);

// ---------- classe terapêutica nomeada (revisão A1, 08/10) ----------
// "qual o melhor antitérmico pro meu bebê", "me recomenda um analgésico pra criança": com sintoma ou pra
// quem, vira NECESSIDADE com sintoma (a MAPEAR checa o alerta: bebê/criança/idoso…); sem nenhum dos
// dois, continua produto julgado e a MAPEAR passa pela porta do remédio (prateleira mip → alerta).
const MED_CLASSES: [symptom: string, src: string][] = [
  ["febre", "anti[- ]?termicos?|antifebril"],
  ["dor", "analgesicos?"],
  ["dor", "anti[- ]?inflamatorios?"],
  ["azia", "anti[- ]?acidos?"],
  ["prisão de ventre", "laxantes?"],
  ["nariz entupido", "descongestionantes?(?: nasa(?:l|is))?"],
  ["alergia", "anti[- ]?alergicos?|anti[- ]?histaminicos?"],
  ["gripe", "anti[- ]?gripa(?:l|is)"],
  ["mal-estar", "remedios?|remedinhos?|medicamentos?|medicacao"]
];
const MED_CLASS_RES = MED_CLASSES.map(([symptom, src]) => [symptom, rx(src)] as const);

// ---------- estados ----------
const STATE_LEAD = "(?:(?:to|tou|cm|a|estou|ta|tamo|tamos|estamos|fiquei|ando|acordei|bateu|me deu|deu|que|com|uma|um|muita|muito|mt|mto|mta|maior|baita|tanta|tanto|super|mega|morrendo de|mort[oa] de|varad[oa] de|cheio de|cheia de)\\s+)*";
// "frio"/"calor"/"sono" só como ESTADO dito ("tô com frio", "que calor"): "algo frio pra beber" é vontade.
const STATE_LEAD_REQUIRED = "(?:(?:to|tou|estou|ta|tamo|tamos|estamos|fiquei|ando|acordei|bateu|me deu|deu|que|com|cm|uma|um|muita|muito|mt|mto|mta|maior|baita|tanto|tanta|super|mega|morrendo de|mort[oa] de|cheio de|cheia de)\\s+)+";
const STATES: [string, string, string, boolean][] = [
  // [exibição, chave, regex, exige "tô com"/"que"…]
  ["fome", "fome", "fome de leao|fome+|faminto|faminta|esfomead[oa]|fominha", false],
  ["larica", "larica", "larica", false],
  ["sede", "sede", "sede+|sedent[oa]", false],
  ["frio", "frio", "frio|friozinho|congelando", true],
  ["calor", "calor", "calor|calorzao|derretendo", true],
  ["sono", "sono", "sono|sonolent[oa]", true],
  ["cansaço", "cansaco", "cansad[oa]+|exaust[oa]|sem energia|mort[oa] de cansaco|moid[oa]|acabad[oa]", false],
  ["preguiça de cozinhar", "preguica de cozinhar", "preguica de (?:cozinhar|fazer comida|fazer janta|fazer o jantar)|sem (?:vontade|saco) de cozinhar|nao (?:quero|to a fim de|to afim de) cozinhar", false],
  // Revisão C2 (08/10): estado sem produto virava o "produto" ("dieta", "ansioso"). Agora é necessidade:
  // dieta → algo leve (saudável); ansioso/estressado → relaxar; triste → um mimo; entediado → filme.
  ["algo leve", "algo leve", "de dieta|fazendo dieta|em dieta|na dieta|dieta|de regime|regime", false],
  ["relaxar", "relaxar", "ansios[oa]|estressad[oa]|nervos[oa]|agitad[oa]|com ansiedade|ansiedade|estresse|stress", false],
  ["um mimo", "um mimo", "triste|tristinh[oa]|chatead[oa]|desanimad[oa]|na bad", false],
  ["noite de filme", "noite de filme", "entediad[oa]|sem nada pra fazer|tedio", false]
];
// Exige o "tô com", menos no começo da mensagem ("frio e sem nada em casa").
const STATE_RES = STATES.map(([display, key, src, lead]) => [display, key, lead ? new RegExp(`(?:^(?:${src})(?=\\s|$)|(?:^|\\s)${STATE_LEAD_REQUIRED}(?:${src})(?=\\s|$))`, "g") : rx(`${STATE_LEAD}(?:${src})`)] as const);

// ---------- vontade ("algo doce", "alguma coisa pra comer") ----------
const QUAL_CANON: [RegExp, string, boolean][] = [
  // [palavra, canônico, fraca (não define a chave quando há propósito)]
  [/^(?:doce|doces|docinho|docinhos|adocicad[oa])$/, "doce", false],
  [/^(?:salgad[oa]s?|salgadinh[oa])$/, "salgado", false],
  [/^(?:gelad[oa]s?|geladinh[oa]|refrescante|fresquinh[oa]|fri[oa]s?|friozinho)$/, "gelado", false],
  [/^(?:quente|quentinh[oa]|quentes)$/, "quente", false],
  [/^(?:leve|levinho|levinha|leves|light)$/, "leve", false],
  [/^(?:saudave(?:l|is)|sa[ul]dave(?:l|is)|fit|natural|naturais|nutritiv[oa]|proteic[oa])$/, "saudável", false],
  [/^(?:crocante|crocantes)$/, "crocante", false],
  [/^(?:cremos[oa]s?)$/, "cremoso", false],
  [/^(?:apimentad[oa]|picante|ardid[oa])$/, "apimentado", false],
  [/^(?:azedinh[oa]|citric[oa])$/, "azedinho", false],
  [/^(?:caseir[oa])$/, "caseiro", false],
  [/^(?:gostos[oa]s?|gostosinh[oa]|delicios[oa]|bom|boa|legal|diferente|especial|top|gordo|gorda|besta)$/, "", true],
  [/^(?:pratic[oa]|rapid[oa]|rapidinh[oa]|facil|pronto|pronta)$/, "", true]
];
const QUAL_WORDS =
  "fri[oa]s?|doce|doces|docinhos?|adocicad[oa]|salgad[oa]s?|salgadinh[oa]|gelad[oa]s?|geladinh[oa]|refrescante|fresquinh[oa]|quente|quentinh[oa]|quentes|leve|levinh[oa]|leves|light|saudave(?:l|is)|sa[ul]dave(?:l|is)|fit|natural|naturais|nutritiv[oa]|proteic[oa]|crocantes?|cremos[oa]s?|apimentad[oa]|picante|ardid[oa]|azedinh[oa]|citric[oa]|caseir[oa]|gostos[oa]s?|gostosinh[oa]|delicios[oa]|bom|boa|legal|diferente|especial|top|gord[oa]|pratic[oa]|rapid[oa]|rapidinh[oa]|facil|pront[oa]";
const VAGUE_NOUN = "algo|alguma coisa|alguma coisinha|uma coisinha|uma coisa|um negocio|um negocinho|qualquer coisa|coisas?|coisinhas?|algo assim|um treco|uns trem";
const PURPOSES: [string, string][] = [
  ["comer", "comer|comer agora|comer hoje|comer a noite|forrar o estomago|matar a fome|mastigar"],
  ["beber", "beber|tomar|matar a sede|refrescar"],
  ["jantar", "jantar|janta|o jantar|a janta|a noite"],
  ["almoço", "almocar|o almoco|almoco"],
  ["lanche", "lanchar|o lanche|lanche|lanchinho|o lanchinho|a tarde"],
  ["café da manhã", "o cafe da manha|cafe da manha|o cafe|tomar cafe|o desjejum"],
  ["beliscar", "beliscar|petiscar|acompanhar a cerveja|acompanhar a bebida|o happy hour"],
  ["sobremesa", "sobremesa|a sobremesa"],
  ["acordar", "acordar|despertar|ficar acordad[oa]|dar energia|ter energia|dar uma animada"],
  // "me indica algo pra dormir" (revisão B1, 08/10): era o produto "dormir" (pijama).
  ["dormir", "dormir|dormir melhor|conseguir dormir|pegar no sono"]
];
const PURPOSE_SRC = PURPOSES.map(([, src]) => src).join("|");
const VONTADE_RE = rx(
  `(?:(?:vontade de|desejo de|afim de|a fim de)\\s+(?:comer\\s+|tomar\\s+|beber\\s+)?)?(?:${VAGUE_NOUN})(?:\\s+(?:bem|mais|meio|bem mais)?\\s*(?:${QUAL_WORDS})(?:\\s+(?:e|ou|mas|meio|bem|tipo)\\s+(?:${QUAL_WORDS}))*)?(?:\\s+(?:pra|para|pro|de|p)\\s+(?:${PURPOSE_SRC}))?`
);
// "vontade de doce", "um doce", "uns docinhos", "besteira pra comer"
// "doce"/"sobremesa" sozinhos também: com produto junto ("doce de leite", "batata doce") sobra o
// produto e a mensagem continua busca — o consumo aqui nunca rouba uma busca.
const VONTADE_BARE_RE = rx(
  `(?:(?:vontade de|desejo de|afim de|a fim de|comer|quero|queria|um|uma|uns|umas|algum|alguma|alguns)\\s+(?:um\\s+|uma\\s+|uns\\s+)?)?(?:doce|doces|docinhos?|sobremesas?|sobremesinha)|(?:vontade de|desejo de|afim de|a fim de|comer|quero|queria|um|uns|algum|alguns)\\s+(?:um\\s+|uns\\s+)?(salgado|salgados)(?=\\s*$|\\s+(?:pra|para|agora|hoje|rapido|rapidinho|ja|por favor|pf|pfv))|(?:comer|uma|umas|alguma|algumas)?\\s*(?:besteira|besteirinha|besteiras|porcaria|bobeira|guloseimas?|gordice)`
);
// "o que tem de bom pra jantar", "o que eu como hoje", "não sei o que comer"
const OPEN_FOOD_RE = rx(
  `o que (?:(?:voce|vc|voces|vcs|ce|cê)\\s+)?(?:tem|teria|rola|sugere|indica|recomenda)(?:\\s+de bom)?(?:\\s+(?:pra|para|pro|de|p)\\s+(${PURPOSE_SRC}))(?:\\s+(?:hoje|agora|hj))?|o que (?:tem|rola) de bom(?:\\s+(?:hoje|agora|hj|ai))?|o que (?:eu\\s+)?(?:como|comer|janto|jantar|almoco|almocar|lancho|lanchar|bebo|beber|tomo|tomar|peco|pedir|belisco)(?:\\s+(?:hoje|agora|hj|a noite|de (?:sobremesa|lanche|janta|jantar)))?`
);
// "me surpreende", "me recomenda alguma coisa", "o que você sugere?"
const OPEN_RE = rx(
  `me surpreend\\w*|surpreend\\w* me|(?:(?:voce|vc|ce|tu)\\s+)?me\\s+(?:recomenda|recomende|indica|indique|sugere|sugira)\\s+(?:algo|alguma coisa|qualquer coisa|uma coisa)(?:\\s+(?:bom|boa|legal|gostos[oa]|diferente))?|o que (?:(?:voce|vc|ce|tu)\\s+)?(?:me\\s+)?(?:recomenda|sugere|indica|aconselha)`
);

// ---------- ocasiões ----------
const OCCASIONS: [string, string, string][] = [
  // [exibição, chave, regex]
  ["churrasco", "churrasco", "churras(?:co|quinho|cada)?"],
  ["café da manhã", "cafe da manha", "cafe da manha(?: especial| reforcado| completo| na cama)?|brunch"],
  ["festa infantil", "festa infantil", `festa infantil|festinha infantil|festa de crianca|aniversario infantil|(?:festa|festinha|aniversario|niver)(?: de aniversario)? (?:do|da|pro|pra|para) (?:meu |minha |o |a )?(?:filh[oa]|sobrinh[oa]|net[oa]|crianca|criancas|afilhad[oa])(?: (?:de|com|que faz) (?:\\d{1,2}|${NUMBER_WORDS}) anos?)?`],
  ["festa de aniversário", "festa", "(?:festa|festinha|festona) de aniversario|festa|festinha|aniversario(?! infantil)|niver"],
  ["noite de filme", "noite de filme", "noite de filme|noite do filme|sessao de (?:cinema|filme)|cineminha|maratona de (?:serie|filme)s?|assistir (?:um |uns )?(?:filme|filmes|serie|o jogo|jogo)|ver (?:um )?filme"],
  ["piquenique", "piquenique", "piquenique|pique-nique"],
  ["jantar romântico", "jantar romantico", "jantar romantico|jantarzinho romantico|noite romantica|jantar a dois"],
  ["receber visitas", "receber visitas", "receber (?:visita|visitas|os amigos|amigos|a familia|gente)|(?:vai ter|vou ter|vem|chegando|chega) (?:uma |umas )?visitas?|visita em casa|happy hour|encontro com amigos|reuniao com amigos|juntar a galera"],
  ["lancheira", "lancheira", "lancheira|lanche da escola|lanche escolar|lanche (?:pra|para) (?:a )?escola"],
  ["ceia de natal", "ceia de natal", "ceia(?: de natal)?|natal|ano novo|reveillon"],
  ["páscoa", "pascoa", "pascoa"],
  ["chá de bebê", "cha de bebe", "cha de (?:bebe|fralda|revelacao)"],
  ["acampamento", "acampamento", "acampamento|acampar|camping"],
  ["praia", "praia", "dia de praia|(?:ir|vou|vamos|indo) (?:pra|para|a|na) praia|levar (?:pra|para|a) praia"],
  ["chegada do bebê", "bebe novo", "(?:chegou|nasceu|vai nascer|vai chegar|nascendo) (?:o |um |meu |minha |a )?(?:bebe|nenem|filh[oa]|netinh[oa]|net[oa])|enxoval(?: de bebe| do bebe)?|bebe recem nascido|chegada do bebe|bebe novo(?: em casa)?"],
  ["pet novo", "pet novo", "(?:adotei|adotamos|ganhei|ganhamos|comprei|peguei|chegou|vou adotar|vamos adotar) (?:um |uma |o |a |meu |minha )?(?:gatinh[oa]|gat[oa]|cachorr\\w*|filhote|cao|cadela|doguinho|pet|catioro)(?: filhote)?|(?:gato|cachorro|pet) novo(?: em casa)?"],
  ["viagem", "viagem", "viagem de carro|pegar estrada|road trip"]
];
const OCCASION_LEAD =
  "(?:(?:vou|vamos|vai|vou fazer|vamos fazer|to fazendo|tou fazendo|estou fazendo|to organizando|vou organizar|organizar|organizando|fazer|preparar|preparando|planejando|montar|montando|ter|teremos|tenho|temos|um|uma|o|a|os|as|meu|minha|nosso|nossa|pra|para|pro|p|no|na|num|numa|de|do|da|coisas|coisa|tudo|itens|comprar|levar|o que|que|preciso|precisa|ajuda|me ajuda|com|hoje|amanha|sabado|domingo|fim de semana|fds|aqui em casa|em casa)\\s+)*";
const GROUP_RE_SRC = `(?:\\s+(?:pra|para|pro|com|de|p)\\s+(?:umas?\\s+|uns\\s+|mais ou menos\\s+|tipo\\s+)?(\\d{1,3}|${NUMBER_WORDS})(?!\\s*(?:anos?|aninhos?|meses|mes|horas?|h|min|minutos|dias?|reais|real|conto|contos|kg|g|litros?|l)(?:\\s|$))\\s*(pessoas?|convidad[oa]s?|adultos?|criancas?|amig[oa]s?|gente)?)?`;
const OCCASION_RES = OCCASIONS.map(([display, key, src]) => [display, key, rx(`${OCCASION_LEAD}(?:${src})${GROUP_RE_SRC}`)] as const);
const CLEAN_RE = rx(
  `(?:(?:preciso|quero|vou|tenho que|tenho q|preciso de algo pra|algo pra|alguma coisa pra|coisas pra|o que usar pra|o que uso pra|como)\\s+)*(limpar|lavar|faxinar|higienizar|desinfetar|desengordurar|desentupir|tirar)\\s+(?:o\\s+|a\\s+|os\\s+|as\\s+|meu\\s+|minha\\s+)?(banheiro|casa|cozinha|quintal|geladeira|fogao|forno|vidros?|janelas?|sofa|tapete|chao|piso|azulejos?|rejunte|area|churrasqueira|pia|ralo|vaso|privada|box|mofo|limo|mancha|manchas|gordura|tudo)(?:\\s+d[oa]\\s+(?:banheiro|cozinha|parede|roupa|sofa|tapete|chao))?|(?:dar|fazer)\\s+(?:uma\\s+)?(?:faxina|limpeza)(?:\\s+(?:geral|pesada|completa))?(?:\\s+(?:n[oa]|em)\\s+(?:casa|banheiro|cozinha))?|(?:faxina|limpeza)(?:\\s+(?:geral|pesada|completa))?`
);
// "o que levar pra praia", "coisas pra viagem" — só com o verbo/objeto vago na frente (senão "praia" é produto/palavra solta).
const GIFT_OCCASION = "namoro|aniversario de namoro|natal|dia das maes|dia dos pais|dia dos namorados|dia das criancas|dia dos professores|amigo secreto|amigo oculto|casamento|formatura|cha de (?:bebe|panela|casa nova|cozinha)|pascoa|bodas";
const GIFT_RE = rx(
  `(?:(?:o que|que|qual)\\s+(?:eu\\s+)?(?:dou|dar|posso dar|daria|compro|comprar|levo|levar|presenteio|presentear|eu dou|eu compro)\\s+(?:de\\s+(?:presente|${GIFT_OCCASION})\\s+)?|(?:um|uma|uns|umas|algum|alguma|o|meu|um bom|uma boa)\\s+)?(presente|presentes|presentinho|presentinhos|lembrancinha|lembrancinhas|lembranca|mimo|mimos|agrado|regalo)(?:\\s+(?:de|do|da|pro|pra|no|para)\\s+(?:${GIFT_OCCASION}))?(?:\\s+${RECIP_SRC})?`
);
// "o que dar pro meu pai" sem a palavra presente; "amigo secreto" sozinho.
const GIFT_NOWORD_RE = rx(
  `(?:o que|que)\\s+(?:eu\\s+)?(?:dou|dar|posso dar|daria|presenteio|presentear|eu dou)\\s+(?:de\\s+presente\\s+)?${RECIP_SRC}|(?:(?:pro|pra|para|do|no|de)\\s+(?:o\\s+)?)?amigo (?:secreto|oculto)|(?:pro|pra|para|no|de)\\s+(dia das maes|dia dos pais|dia dos namorados|dia das criancas)`
);

// ---------- beleza/cuidado: só com gatilho ("o que é bom pra…", "algo pra…", "me indica algo pra…") ----------
const BEAUTY_RE = rx(
  `(cabelos?|pele|rosto|unhas?|labios?|boca|pes|maos|barba|couro cabeludo|olheiras?)\\s+(ressecad[oa]s?|secos?|secas?|oleos[oa]s?|cachead[oa]s?|crespos?|lisos?|com frizz|danificad[oa]s?|quebradic[oa]s?|com caspa|sensive(?:l|is)|manchad[oa]s?|com acne|com espinhas?|rachad[oa]s?|fracas?|fracos?|caindo|opac[oa]s?|cansad[oa]s?|descascando)|(caspa|frizz|acne|espinhas?|cravos?|olheiras|estrias|celulite|calos?|chule|mau halito|cheiro de suor|suor|queda de cabelo|cabelo caindo|unha fraca|pele seca|pele oleosa)`
);
const BEAUTY_TRIGGER_RE = /\b(?:o que (?:e |eh |seria )?(?:bom|boa|indicad[oa])|algo (?:bom )?(?:pra|para)|alguma coisa (?:boa )?(?:pra|para)|o que (?:eu )?(?:uso|usar|passo|passar|compro|comprar)|me (?:recomenda|recomende|indica|indique|sugere|sugira)|recomenda|indica|sugere|(?:qual|quais|que) (?:e |eh )?(?:o |a |os |as )?melhor(?:es)?|ajuda com)\b/;

// ---------- julgamento ----------
const RECOMMEND_VERB_RE = rx(
  `(?:(?:voce|vc|ce|tu|voces|vcs)\\s+)?(?:me\\s+|nos\\s+)?(?:recom[ea]?n?d\\w*|indic[aio]\\w*|indique\\w*|suger\\w*|sugir\\w*|aconselh\\w*)(?:\\s+(?:pra|para|p)\\s+(?:mim|nos|a gente))?|(?:me\\s+)?(?:da|de|manda|passa)\\s+(?:uma\\s+)?(?:dica|sugestao|indicacao|recomendacao)(?:\\s+de)?|(?:alguma|uma|sua)\\s+(?:dica|sugestao|indicacao|recomendacao)(?:\\s+de)?|me ajuda a escolher|nao sei qual (?:comprar|escolher|pegar|levar)|o que (?:e |eh |seria )?(?:bom|boa|indicad[oa])(?:\\s+(?:pra|para|p))?|o que (?:eu\\s+)?(?:uso|usar|passo|passar|tomo|tomar|compro|comprar|levo|levar|faco|fazer|preparo|preparar|sirvo|servir|ofereco|oferecer)(?:\\s+(?:pra|para|p|no|na|num|numa))?`
);
const BEST_RE = rx(
  `(?:(?:qual|quais|que)\\s+)?(?:(?:e|eh|seria|sao|for|fica)\\s+)?(?:o|a|os|as)?\\s*(?:melhor|melhores|mais gostos[oa]s?|mais bem avaliad[oa]s?|mais vendid[oa]s?|mais recomendad[oa]s?|mais indicad[oa]s?|mais famos[oa]s?)(?:\\s+(?:que (?:voce|vc|ce) (?:tem|conhece|recomenda)|do mercado|que tem|disponive(?:l|is)))?`
);
// "qual ração vale a pena", "esse vinho presta?", "um chocolate bom", "um bom vinho"
const GOOD_AFTER_RE = rx(
  `(?:e\\s+|eh\\s+)?(?:que\\s+)?(?:vale(?:\\s+mais)?(?:\\s+a)?\\s+pena|compensa|presta|(?:seja|e|eh|for)\\s+(?:bom|boa|bons|boas)|(?:bom|boa|bons|boas)(?!\\s+(?:dia|tarde|noite|ar|bril|principio|gosto|jesus|vista|esperanca|sabor|preco))|otim[oa]s?|excelentes?|top|de qualidade|de primeira|bem avaliad[oa]s?|decentes?|confiave(?:l|is)|gostos[oa]s?|delicios[oa]s?|premium|rende mais|dura mais|mais duravel|mais resistente|limpa melhor|funciona (?:melhor|mesmo|bem)|e melhor|que (?:voce|vc|ce|tu) (?:recomenda|indica|sugere|gosta|acha bom))(?:\\s+(?:mesmo|de verdade|msm))?`
);
const GOOD_BEFORE_RE = rx(`(?:um|uma|uns|umas|algum|alguma|alguns|algumas)\\s+(?:bom|boa|bons|boas|otim[oa]|excelente|bel[oa])`);
const QUAL_PREFIX_RE = /^(?:qual|quais|que)$/;

// ---------- critérios ----------
const FAST_WORDS = "rapid[oa]s?|rapidinh[oa]|rapidao|urgente|urgencia|agora|pra ja|pra agora|hoje|hj|correndo|pra ontem|o quanto antes|o mais rapido|na hora|imediat[oa]|depressa|asap|ja ja|sem demora|chega rapido";
const CHEAP_WORDS = "sem (?:dinheiro|grana)|(?:to |tou |estou |ando )?(?:dur[oa]|lis[oa])(?= |$)|nada (?:muito )?car[oa]|barat[oa]s?|baratinh[oa]s?|em conta|economic[oa]s?|custo[ -]beneficio|precinho|bom preco|preco bom|preco justo|sem gastar muito|nao muito car[oa]|que nao seja car[oa]|pouco dinheiro|mais acessive(?:l|is)|acessive(?:l|is)";
const HEALTHY_WORDS = "saudave(?:l|is)|sa[ul]dave(?:l|is)|light|fit|integra(?:l|is)|natura(?:l|is)|organic[oa]s?|diet|low carb|proteic[oa]s?|nutritiv[oa]s?|leve|levinh[oa]|sem gordura|menos calori\\w*";
const FAST_RE = new RegExp(`\\b(?:${FAST_WORDS})\\b|\\bja\\s*$`);
const CHEAP_RE = new RegExp(`\\b(?:${CHEAP_WORDS})\\b`);
const HEALTHY_RE = new RegExp(`\\b(?:${HEALTHY_WORDS})\\b`);
const GOOD_RE = /\b(?:melhor|melhores|bom|boa|bons|boas|otim[oa]s?|excelentes?|top|qualidade|premium|de primeira|que presta|presta|vale (?:mais )?a pena|compensa|bem avaliad[oa]s?|mais vendid[oa]s?|gostos[oa]s?|delicios[oa]s?|decentes?)\b/;

// ---------------------------------------------------------------- análise

type Analysis = {
  needs: NeedHit[];
  judge: boolean;
  explicitVerb: boolean;
  // Julgamento que não é só adjetivo ("vale a pena", "compensa", "rende mais") — revisão C1.
  strongJudge: boolean;
  medClass?: { display: string; symptom: string };
  scan: Scan;
  criteria: Set<RecommendCriterion>;
  constraints: string[];
  recipient?: string;
  urgency: boolean;
  budget?: number;
};

function canonQual(word: string): { canon: string; weak: boolean } | null {
  for (const [re, canon, weak] of QUAL_CANON) if (re.test(word)) return { canon, weak };
  return null;
}

function purposeCanon(text: string): string | null {
  for (const [canon, src] of PURPOSES) if (new RegExp(`(?:^|\\s)(?:${src})$`).test(text)) return canon;
  return null;
}

function analyze(text: string): Analysis {
  const scan = new Scan(text);
  const needs: NeedHit[] = [];
  const criteria = new Set<RecommendCriterion>();
  const constraints: string[] = [];
  let recipient: string | undefined;
  let urgency = false;

  scan.take(NOISE_RE, "noise");

  // Orçamento: o valor sai do parser de sempre (lia-intents); aqui só se consome o trecho.
  let budget = parsePriceCap(text) ?? parseBudgetStatement(text) ?? undefined;
  // "presente pra namorada, uns 150", "amigo secreto, valor 30": o parser de sempre exige a moeda;
  // aqui, número solto depois de "uns/valor/em torno de" (e sem unidade depois) também é teto.
  if (budget == null) {
    const loose = normalizeMsg(text).match(/(?:^|\s)(?:uns|umas|valor(?: de| maximo| max| ate)?|orcamento(?: de)?|na faixa de|faixa de|em torno de)\s+(?:r\$\s*)?(\d{2,5})(?!\s*(?:anos?|meses|mes|kg|g|gr|ml|l|lt|litros?|pessoas?|convidad|criancas?|amig|adultos?|horas?|min|unidades?|un|cm|m|metros?|%))(?=[\s,.!?]|$)/);
    if (loose && Number(loose[1]) >= 10) budget = Number(loose[1]);
  }
  const money = `(?:r\\$\\s*)?(?:\\d{1,5}(?:[.,]\\d{1,2})?|cem|cinquenta|vinte|trinta|quarenta|sessenta|setenta|oitenta|noventa|duzentos|trezentos|quinhentos|mil)`;
  const moneyCue = `(?:reais|real|conto|contos|pila|pilas|mangos?|r\\$|paus?)`;
  const moneyTail = `(?:\\s+(?:no total|total|com (?:a |o )?(?:entrega|frete)|ja com (?:a |o )?(?:entrega|frete)|com tudo|tudo|no maximo|mais ou menos))*`;
  scan.take(
    rx(
      // Prefixo forte ("até 80", "no máximo 60", "orçamento de 100") dispensa a moeda; prefixo fraco
      // ("uns 120", "de 50", "tenho 30") só com "reais/conto" — "filho de 5 anos" não é dinheiro.
      `(?:(?:eu\\s+)?(?:so\\s+)?(?:posso gastar|quero gastar|queria gastar|pretendo gastar|gastar|gasto|orcamento(?:\\s+de|\\s+e)?|limite(?:\\s+de|\\s+e)?|teto(?:\\s+de|\\s+e)?|ate|no maximo|maximo|max)\\s+)+(?:(?:uns|umas|de|tipo)\\s+)?${money}(?:\\s*${moneyCue})?${moneyTail}|(?:(?:eu\\s+)?(?:so\\s+)?(?:tenho|to com|tou com|estou com|na faixa de|faixa de|em torno de|mais ou menos|uns|umas|de|por|que custe|custando)\\s+)*${money}\\s*${moneyCue}${moneyTail}`
    ),
    "budget",
    () => budget != null
  );
  if (budget != null) {
    scan.take(rx(`(?:(?:uns|umas|valor(?:\\s+(?:de|maximo|max|ate))?|orcamento(?:\\s+de)?|na faixa de|faixa de|em torno de)\\s+)+(?:r\\$\\s*)?(\\d{2,5})`), "budget", (m) => Number(m[1]) === budget);
  }

  // Restrições ditas.
  scan.take(CONSTRAINT_RE, "constraint", (m) => {
    const word = m[1].split(" ")[0];
    if (NOT_CONSTRAINT.has(word) || FILLER.has(word) || SERVICE.has(word)) return false;
    constraints.push(`sem ${CONSTRAINT_CANON[word] ?? m[1]}`);
    if (word === "acucar" || word === "acucares") criteria.add("healthy");
  });
  scan.take(DIET_RE, "constraint", (m) => {
    const w = m[1];
    if (/vegan/.test(w)) constraints.push("vegano");
    else if (/vegetarian/.test(w)) constraints.push("vegetariano");
    else if (/diet|diabetic/.test(w)) constraints.push("sem açúcar");
    else if (/kosher/.test(w)) constraints.push("kosher");
    else if (/lactose|leite/.test(w)) constraints.push("sem lactose");
    else if (/celiac|gluten/.test(w)) constraints.push("sem glúten");
    else {
      // "sou alérgica a dipirona" / "tenho alergia a camarão": o que ele não pode é restrição.
      const what = w.match(/alergi\w* (?:a|ao|à|com|de) ([a-z]{3,})$/)?.[1];
      if (what) constraints.push(`sem ${CONSTRAINT_CANON[what] ?? what}`);
    }
  });

  // Sintomas.
  for (const [canon, re] of SYMPTOM_RES) {
    scan.take(re, "symptom", (_m, r) => {
      needs.push({ kind: "symptom", display: canon, key: normalizeMsg(canon), at: r[0] });
    });
  }

  // Classe terapêutica nomeada (A1): consumida como "medclass"; quem decide se é produto é a API.
  let medClass: Analysis["medClass"];
  for (const [symptom, re] of MED_CLASS_RES) {
    scan.take(re, "medclass", (_m, r) => {
      medClass = medClass ?? { display: scan.origOf(r), symptom };
    });
  }

  // Presente sem produto.
  const giftRecipient = (m: RegExpMatchArray, offset: number) => (m[offset] ? recipientDisplay(m[offset], m[offset + 1], m[offset + 2]) : undefined);
  scan.take(GIFT_RE, "need", (m, r) => {
    const who = giftRecipient(m, 2) ?? occasionRecipient(m[0]);
    if (who) recipient = who;
    const said = scan.origOf(r).replace(/^(?:o que|que|qual)\s+.*?(?=presente|lembr|mimo|agrado)/, "").replace(/^(?:um|uma|uns|umas|algum|alguma|o|meu)\s+/, "");
    needs.push({ kind: "gift", display: said || "presente", key: `presente${who ? ` ${giftKey(who)}` : ""}` });
  });
  scan.take(GIFT_NOWORD_RE, "need", (m) => {
    let who = m[1] ? recipientDisplay(m[1], m[2], m[3]) : undefined;
    if (!who) who = occasionRecipient(m[0]);
    if (who) recipient = who;
    const prep = /\bpro\b/.test(m[0]) ? "pro" : "pra";
    const poss = /\bminha\b/.test(m[0]) ? "minha " : /\bmeu\b/.test(m[0]) ? "meu " : "";
    needs.push({ kind: "gift", display: who ? `presente ${prep} ${poss}${who}` : "presente", key: `presente${who ? ` ${giftKey(who)}` : ""}` });
  });

  // Ocasião.
  for (const [display, key, re] of OCCASION_RES) {
    scan.take(re, "need", (m, r) => {
      // A ocasião precisa estar no texto (o prefixo sozinho não vale).
      const words = scan.toks.slice(r[0], r[1] + 1).map((t) => t.norm).join(" ");
      if (!new RegExp(`(?:^|\\s)(?:${OCCASIONS.find((o) => o[1] === key)![2]})(?:\\s|$)`).test(words)) return false;
      const n = m[1] ? (/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_VALUE[m[1]]) : undefined;
      const unit = m[2] ? (/crianc/.test(m[2]) ? "crianças" : "pessoas") : "pessoas";
      if (key === "pet novo") {
        const species = /\bgat/.test(words) ? "gato" : "cachorro";
        recipient = recipient ?? species;
        needs.push({ kind: "occasion", display: `${species} novo em casa`, key: `${species} novo` });
        return;
      }
      needs.push({ kind: "occasion", display: n ? `${display} pra ${n} ${unit}` : display, key });
    });
  }
  // "churras sábado pra uns 15 amigos", "festa infantil em casa, 20 crianças de 6 anos": o tamanho
  // do grupo longe da ocasião (com unidade quando não há preposição).
  const occasion = needs.find((x) => x.kind === "occasion");
  if (occasion && !/ pra \d+ /.test(occasion.display)) {
    const groupWithPrep = GROUP_RE_SRC.replace(/^\(\?:\\s\+/, "(?:").replace(/\)\?$/, ")");
    const groupBare = `(?:umas?\\s+|uns\\s+)?(\\d{1,3}|${NUMBER_WORDS})\\s+(pessoas?|convidad[oa]s?|adultos?|criancas?|amig[oa]s?)(?:\\s+(?:de|com)\\s+(\\d{1,2})\\s+anos?)?`;
    for (const src of [groupBare, groupWithPrep]) {
      scan.take(rx(src), "group", (m) => {
        const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_VALUE[m[1]];
        if (!n || /pra \d+ /.test(occasion.display)) return false;
        const kids = Boolean(m[2] && /crianc/.test(m[2]));
        occasion.display = `${occasion.display} pra ${n} ${kids ? "crianças" : "pessoas"}`;
        if (kids && m[3]) recipient = recipient ?? `criança ${Number(m[3])} anos`;
      });
    }
  }
  scan.take(CLEAN_RE, "need", (m, r) => {
    const said = scan
      .origOf(r)
      .replace(/^(?:(?:preciso|quero|vou|tenho que|tenho q|preciso de algo pra|algo pra|alguma coisa pra|coisas pra|o que usar pra|o que uso pra|como)\s+)+/, "")
      .replace(/^(?:fazer|dar)\s+(?:uma\s+)?/, "");
    const key = m[1] && m[2] ? `${m[1] === "tirar" ? "tirar" : m[1] === "desentupir" ? "desentupir" : "limpar"} ${m[2].replace(/s$/, "")}` : "faxina";
    needs.push({ kind: "occasion", display: said, key });
  });

  // Beleza/cuidado (só com gatilho).
  if (BEAUTY_TRIGGER_RE.test(normalizeMsg(text))) {
    scan.take(BEAUTY_RE, "need", (_m, r) => {
      const said = scan.origOf(r);
      needs.push({ kind: "beauty", display: said, key: normalizeMsg(said) });
    });
  }

  // Vontade.
  scan.take(VONTADE_RE, "need", (_m, r) => {
    const words = scan.toks.slice(r[0], r[1] + 1).map((t) => t.norm);
    const joined = words.join(" ");
    const quals: { canon: string; weak: boolean }[] = [];
    for (const w of words) {
      const q = canonQual(w);
      if (q && !/^(?:um|uma|algo)$/.test(w)) quals.push(q);
    }
    const purposeMatch = joined.match(new RegExp(`(?:pra|para|pro|de|p)\\s+((?:${PURPOSE_SRC}))$`));
    const purpose = purposeMatch ? purposeCanon(purposeMatch[1]) : null;
    if (!quals.length && !purpose) return false;
    const strong = quals.filter((q) => !q.weak).map((q) => q.canon);
    const tasty = words.some((w) => /^(?:gostos|gostosinh|delicios)/.test(w));
    const key = strong.length ? `algo ${[...new Set(strong)].map((s) => normalizeMsg(s)).join(" e ")}` : purpose ? `algo pra ${normalizeMsg(purpose)}` : tasty ? "algo gostoso" : "surpresa";
    const display = scan
      .origOf(r)
      .replace(/^(?:vontade de|desejo de|afim de|a fim de)\s+(?:comer\s+|tomar\s+|beber\s+)?/, "")
      .replace(/^(?:uma|um)\s+/, "");
    needs.push({ kind: "vontade", display, key });
    for (const q of quals) if (q.canon === "saudável" || q.canon === "leve") criteria.add("healthy");
  });
  scan.take(VONTADE_BARE_RE, "need", (m) => {
    const salty = /salgad/.test(m[0]);
    const junk = /besteir|porcaria|bobeira|guloseima|gordice/.test(m[0]);
    const dessert = /sobremes/.test(m[0]);
    const [display, key] = junk ? ["besteira", "besteira"] : salty ? ["algo salgado", "algo salgado"] : dessert ? ["sobremesa", "algo pra sobremesa"] : ["algo doce", "algo doce"];
    needs.push({ kind: "vontade", display, key });
  });
  // Estados.
  for (const [display, key, re] of STATE_RES) {
    scan.take(re, "need", () => {
      needs.push({ kind: "state", display, key });
      if (key === "algo leve") criteria.add("healthy");
      if (key === "fome" || key === "larica" || key === "sede") {
        criteria.add("fast");
        urgency = true;
      }
    });
  }

  scan.take(OPEN_FOOD_RE, "need", (m) => {
    const purpose = m[1] ? purposeCanon(m[1]) : null;
    const verb = m[0].match(/\b(como|comer|janto|jantar|almoco|almocar|lancho|lanchar|bebo|beber|tomo|tomar|belisco|peco|pedir)\b/)?.[1];
    const p =
      purpose ??
      (verb ? (/jant/.test(verb) ? "jantar" : /almo/.test(verb) ? "almoço" : /lanch/.test(verb) ? "lanche" : /beb|tom/.test(verb) ? "beber" : /belis/.test(verb) ? "beliscar" : "comer") : null);
    needs.push({ kind: "vontade", display: p ? `algo pra ${p}` : "algo bom", key: p ? `algo pra ${normalizeMsg(p)}` : "surpresa" });
  });
  // Pedido aberto ("o que você recomenda", "me surpreende") é JULGAMENTO: com produto na frase, julga o
  // produto; sem produto, é a necessidade "surpresa".
  scan.take(OPEN_RE, "judge", () => {
    needs.push({ kind: "open", display: "me surpreende", key: "surpresa" });
  });

  // Critérios: rápido/barato/saudável na frase inteira; "bom/melhor" só fora dos trechos de necessidade
  // ("o que tem de bom pra jantar" não pede qualidade).
  const full = normalizeMsg(text);
  if (FAST_RE.test(full)) criteria.add("fast");
  if (FAST_RE.test(full)) urgency = true;
  if (CHEAP_RE.test(full)) criteria.add("cheap");
  if (HEALTHY_RE.test(full)) criteria.add("healthy");
  const outsideNeeds = scan.toks.filter((t) => t.role !== "need" && t.role !== "symptom").map((t) => t.norm).join(" ");
  const cheapPhrase = CHEAP_RE.exec(outsideNeeds)?.[0] ?? "";
  if (GOOD_RE.test(outsideNeeds.replace(cheapPhrase, " "))) criteria.add("good");

  // Julgamento. "o que você recomenda de vinho?" (consumido como pedido aberto) também julga o produto.
  let judge = needs.some((x) => x.kind === "open");
  let explicitVerb = judge;
  scan.take(rx(CHEAP_WORDS), "criteria");
  if (scan.take(RECOMMEND_VERB_RE, "judge") > 0) {
    judge = true;
    explicitVerb = true;
  }
  if (scan.take(BEST_RE, "judge", (m) => /melhor|mais/.test(m[0])) > 0) {
    judge = true;
    explicitVerb = true;
  }
  if (scan.take(GOOD_BEFORE_RE, "judge") > 0) judge = true;
  let strongJudge = false;
  if (
    scan.take(GOOD_AFTER_RE, "judge", (m, r) => {
      if (!(r[0] > 0 || scan.toks.length === 1)) return false;
      if (/vale|compensa|presta|rende|dura|resistente|limpa|funciona|melhor|recomenda|indica|sugere|gosta|acha bom|avaliad|confiave/.test(m[0])) strongJudge = true;
    }) > 0
  )
    judge = true;

  // Pra quem.
  const takeRecipient = (m: RegExpMatchArray) => {
    recipient = recipient ?? recipientDisplay(m[1], m[2], m[3]);
  };
  scan.take(RECIP_RE, "recipient", takeRecipient);
  scan.take(RECIP_POSS_RE, "recipient", takeRecipient);

  // Critérios que sobraram soltos ("rapidinho", "barato", "saudável") não são produto.
  scan.take(rx(`${FAST_WORDS}|ja`), "criteria");
  scan.take(rx(HEALTHY_WORDS), "criteria");

  return { needs, judge, explicitVerb, strongJudge, ...(medClass ? { medClass } : {}), scan, criteria, constraints: [...new Set(constraints)], recipient, urgency, budget: budget ?? undefined };
}

function occasionRecipient(said: string): string | undefined {
  if (/dia das maes/.test(said)) return "mãe";
  if (/dia dos pais/.test(said)) return "pai";
  if (/dia dos namorados/.test(said)) return "namorado";
  if (/dia das criancas/.test(said)) return "criança";
  if (/dia dos professores/.test(said)) return "professor";
  if (/amigo (?:secreto|oculto)/.test(said)) return "amigo secreto";
  return undefined;
}

function giftKey(who: string): string {
  return normalizeMsg(who).replace(/\s+\d+\s+(?:anos|meses)$/, "");
}

// A necessidade que manda: sintoma > presente > ocasião > beleza > vontade > estado > aberto; vontade
// sem sabor nem propósito ("algo rápido") perde para o estado ("tô faminta, algo rápido" = fome).
// "algo pra comer/beber" com fome/sede dita: o estado diz mais. Mesma classe: o que veio antes na frase.
function pickNeed(needs: NeedHit[]): NeedHit | undefined {
  const hasState = needs.some((x) => x.kind === "state");
  const rank = (x: NeedHit) =>
    x.key === "surpresa" ? NEED_PRIORITY.length + 1 : hasState && /^algo pra (?:comer|beber)$/.test(x.key) ? NEED_PRIORITY.length : NEED_PRIORITY.indexOf(x.kind);
  return [...needs].sort((x, y) => rank(x) - rank(y) || (x.at ?? 0) - (y.at ?? 0))[0];
}

// ---------------------------------------------------------------- API

const ALLOWED_INTENTS = new Set(["free_text", "vague_request", "want_items"]);
const SYMPTOM_INTENTS = new Set(["complaint"]);

export function detectRecommendation(text: string, opts: DetectOptions = {}): RecommendRequest | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 280) return null;
  // Comandos, perguntas de serviço, escolha por número, CEP, pagamento… têm dono no roteador.
  const intent = detectIntent(raw);
  if (!ALLOWED_INTENTS.has(intent.kind) && !SYMPTOM_INTENTS.has(intent.kind)) return null;
  const a = analyze(raw);
  // "tô com uma dor de cabeça horrível" o roteador lê como reclamação; só vale com sintoma de verdade.
  if (!ALLOWED_INTENTS.has(intent.kind) && !a.needs.some((x) => x.kind === "symptom")) return null;
  const { scan } = a;

  // O que sobrou: conteúdo (produto) ou enfeite.
  const hasSymptom = a.needs.some((x) => x.kind === "symptom");
  // Classe terapêutica + sintoma ou pra quem = necessidade de saúde (A1); senão, a classe é o produto.
  const medAsNeed = Boolean(a.medClass) && (hasSymptom || Boolean(a.recipient));
  const content: number[] = [];
  for (let i = 0; i < scan.toks.length; i++) {
    const t = scan.toks[i];
    if (t.role === "medclass") {
      if (!medAsNeed) content.push(i);
      continue;
    }
    if (t.role) continue;
    if (SERVICE.has(t.norm)) return null;
    if (REFERENCE.has(t.norm)) {
      // "outra coisa pra comer" não é referência; "qual desses é melhor" é.
      if (!a.needs.length || !/^(?:outr[oa]s?)$/.test(t.norm)) return null;
      continue;
    }
    if (FILLER.has(t.norm)) continue;
    if (hasSymptom && SYMPTOM_CONTEXT.has(t.norm)) continue;
    if ((hasSymptom || a.needs.some((x) => x.kind === "occasion")) && /^\d+$/.test(t.norm)) continue;
    content.push(i);
  }

  const best = pickNeed(a.needs);
  const base = {
    text: raw,
    criteria: CRITERIA_ORDER.filter((c) => a.criteria.has(c)),
    constraints: a.constraints,
    ...(a.budget != null ? { budget: a.budget } : {}),
    ...(a.recipient ? { recipient: a.recipient } : {}),
    ...(a.urgency ? { urgency: true } : {}),
    source: "regex" as const
  };

  if (medAsNeed) {
    // Remédio NOMEADO junto ("tem remédio tipo dipirona pra dor?"): a porta do remédio decide, não a recomendação.
    const leftover = content.map((i) => scan.toks[i].orig).join(" ");
    if (leftover && looksLikeMedicine(leftover)) return null;
    if (opts.hasPendingChoice && !hasSymptom && !a.explicitVerb) return null;
    const symptom = pickNeed(a.needs.filter((x) => x.kind === "symptom"))?.display ?? a.medClass!.symptom;
    return { form: "need", need: hasSymptom ? best?.display ?? symptom : a.medClass!.display, ...base, symptom };
  }

  if (!content.length) {
    if (!best) return null;
    // Com opções na tela, só necessidade inequívoca e nova; "me surpreende"/"o que você sugere"
    // ali é pergunta sobre as opções.
    if (opts.hasPendingChoice && best.kind === "open") return null;
    const symptom = pickNeed(a.needs.filter((x) => x.kind === "symptom"))?.display;
    return { form: "need", need: best.display, ...base, ...(symptom ? { symptom } : {}) };
  }

  // Sobrou produto: só é recomendação com pedido de julgamento.
  if (!a.judge) return null;
  if (opts.hasPendingChoice && !a.explicitVerb) return null;
  // Revisão C1 (08/10): "bom/boa" só como adjetivo, sem verbo de recomendação, sem "melhor", sem pergunta,
  // junto de QUANTIDADE ("manda 2 pacotes de arroz bom", "quero 6 cervejas boas") ou de "bom pra X"
  // ("quero uma pizza boa pro jantar") é pedido de produto: busca de sempre, quantidade preservada.
  const question = /\?/.test(raw) || scan.toks.some((t) => /^(?:qual|quais)$/.test(t.norm));
  if (!a.explicitVerb && !a.strongJudge && !question) {
    const qty = scan.toks.some((t) => !t.role && (/^\d+$/.test(t.norm) || QTY_WORD_RE.test(t.norm)));
    const fitFor = /(?:^|\s)(?:bom|boa|bons|boas)\s+(?:pra|pro|para|p)\s/.test(normalizeMsg(raw));
    if (qty || fitFor) return null;
  }
  if (content.length > 6) return null;
  const first = content[0];
  let last = content[content.length - 1];
  // Lista ("arroz, feijão e me indica um vinho bom"): busca de sempre.
  for (let i = first; i <= last; i++) {
    const t = scan.toks[i];
    // vírgula entre dois produtos = lista; ", de coador" / ", pra presente" continua o mesmo produto.
    if (t.comma && i < last && !/^(?:de|do|da|pra|para|pro|com|sem|tipo|que)$/.test(scan.toks[i + 1]?.norm ?? "")) return null;
    // "2 cocas e me indica um vinho bom", "arroz e feijão bons": conjunção entre produtos (o "é" acentuado não conta).
    if (!t.role && /^e$/i.test(t.orig) && i > first && i < last) return null;
  }
  // O produto leva junto o "pra quem"/"pra quê" que vem logo depois ("ração … pro meu gato",
  // "shampoo pra cabelo cacheado"); julgamento, critério e orçamento saem.
  for (let j = last + 1; j < scan.toks.length; j++) {
    const t = scan.toks[j];
    if (t.role === "recipient" || t.role === "need" || t.role === "symptom") last = j;
    else if (t.comma) break;
    else if (t.role === "judge" || t.role === "criteria" || t.role === "noise" || (!t.role && FILLER.has(t.norm))) continue;
    else break;
  }
  const product = scan.toks
    .slice(first, last + 1)
    .filter((t) => !t.role || t.role === "recipient" || t.role === "need" || t.role === "symptom" || t.role === "medclass")
    .map((t) => t.orig.toLowerCase())
    .join(" ")
    .replace(/\b(?:minha|meu|minhas|meus|nossa|nosso)\s+/g, "")
    .replace(/^(?:(?:um|uma|uns|umas|o|a|os|as|de|do|da|pra|para|pro|\d+)\s+)+/, "")
    .replace(/^(?:marcas?|tipos?|modelos?|opção|opções)\s+(?:de|do|da)\s+/, "")
    .replace(/(?:\s+(?:pra|para|pro|de|do|da|e|que|com|mais|pf|pfv))+$/, "")
    .trim();
  // Numeral/pronome isolado nunca é produto ("qual dos dois é melhor" — revisão C2).
  if (!product || product.length > 60 || content.every((i) => /^\d+$/.test(scan.toks[i].norm) || NUMBER_ONLY_RE.test(scan.toks[i].norm))) return null;
  // Medicamento nomeado ("qual a melhor dipirona") nunca vira recomendação: a porta do remédio decide.
  if (looksLikeMedicine(product)) return null;
  // Produto que já está na cesta, sem verbo de recomendação ("o vinho é bom?"): pergunta sobre o escolhido.
  if (!a.explicitVerb && opts.basketNames?.length) {
    const wanted = content.map((i) => scan.toks[i].norm.replace(/s$/, ""));
    const inBasket = opts.basketNames.some((name) => {
      const tokens = normalizeMsg(name).split(/\s+/).map((w) => w.replace(/s$/, ""));
      return wanted.every((w) => tokens.includes(w));
    });
    if (inBasket) return null;
  }
  // Sem critério dito, julgar é escolher o bom (marca/popularidade), nunca o mais barato por padrão.
  const criteria = base.criteria.length ? base.criteria : (["good"] as RecommendCriterion[]);
  return { form: "product_judged", product, ...base, criteria };
}

export function classifyForm(text: string): RecommendForm {
  return detectRecommendation(text)?.form ?? "product";
}

const KEY_DROP = /\b(?:um|uma|uns|umas|o|a|os|as|de|do|da|dos|das|pra|para|pro|minha|meu|minhas|meus|nossa|nosso|me|eu)\b/g;
function tidy(s: string): string {
  return normalizeMsg(s).replace(KEY_DROP, " ").replace(/\s+\d+\s*(?:pessoas?|criancas?|anos|meses)?\b/g, " ").replace(/\s+/g, " ").trim();
}

// Chave normalizada da necessidade para casar com as tabelas curadas (tables.ts): sem acento,
// minúsculas, sem artigo/possessivo/número. Exemplos: "fome", "algo doce", "algo pra jantar",
// "dor de barriga", "presente mae", "presente crianca", "churrasco", "cafe da manha",
// "limpar banheiro", "surpresa". product_judged: o produto limpo ("chocolate").
export function needKey(req: Pick<RecommendRequest, "form" | "need" | "product" | "symptom" | "recipient">): string {
  if (req.form === "product_judged") return tidy(req.product ?? "");
  if (req.symptom) {
    const sym = analyze(req.symptom).needs.find((x) => x.kind === "symptom");
    return sym?.key ?? tidy(req.symptom);
  }
  const need = req.need ?? "";
  const best = pickNeed(analyze(need).needs);
  if (best) {
    if (best.kind === "gift" && best.key === "presente" && req.recipient) return `presente ${giftKey(req.recipient)}`;
    return best.key;
  }
  if (/\bpresente\b/.test(normalizeMsg(need))) return req.recipient ? `presente ${giftKey(req.recipient)}` : "presente";
  return tidy(need);
}

// Diagnóstico (testes/placar): os tokens com o papel que cada trecho recebeu.
export function explainRecommendation(text: string): string {
  const a = analyze(text);
  return a.scan.toks.map((t) => (t.role ? `${t.norm}[${t.role}]` : t.norm)).join(" ") + ` | needs=${a.needs.map((x) => `${x.kind}:${x.key}`).join(",")} judge=${a.judge}`;
}
