// Placar da etapa ENTENDER (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.1 e §5):
// tabela-ouro PURA (sem IA, sem banco, sem rede) de frases reais de cliente — informais, com erro de
// digitação e gíria — → forma esperada + campos principais. Meta do plano: ≥ 97 % e ZERO produto
// nomeado virando recomendação. Aqui a régua é mais dura: a tabela inteira tem que passar.
// Frases de fronteira e as que eram ambíguas estão marcadas com "fronteira:" no comentário da linha.
import "./helpers/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyForm, detectRecommendation, needKey, type DetectOptions } from "../src/lib/recommend/detect";
import type { RecommendCriterion, RecommendRequest } from "../src/lib/recommend/types";

type Expect =
  | "product"
  | {
      form: "need" | "product_judged";
      need?: string;
      product?: string;
      key?: string;
      // critérios que TÊM de estar (outros podem aparecer)
      criteria?: RecommendCriterion[];
      constraints?: string[];
      recipient?: string;
      symptom?: string;
      urgency?: boolean;
      budget?: number;
    };
type Row = [text: string, expect: Expect, opts?: DetectOptions];

const TELA: DetectOptions = { hasPendingChoice: true };

// ---------------------------------------------------------------- as 5 frases da seção 0 do plano
const SECAO_0: Row[] = [
  ["tô com muita fome, quero algo doce", { form: "need", need: "algo doce", key: "algo doce", criteria: ["fast"], urgency: true }],
  ["me recomenda um chocolate bom", { form: "product_judged", product: "chocolate", criteria: ["good"] }],
  ["tô com dor de barriga", { form: "need", need: "dor de barriga", symptom: "dor de barriga", key: "dor de barriga" }],
  ["algo gostoso pra comer", { form: "need", key: "algo pra comer" }],
  ["me indica um presente pra minha mãe", { form: "need", need: "presente pra minha mãe", recipient: "mãe", key: "presente mae" }]
];

// ---------------------------------------------------------------- necessidade (estado, vontade, ocasião, presente, sintoma)
const NEED: Row[] = [
  // estado
  ["to com fome", { form: "need", need: "fome", key: "fome", criteria: ["fast"], urgency: true }],
  ["tô morrendo de fome aqui", { form: "need", key: "fome", urgency: true }],
  ["to cm fomee", { form: "need", key: "fome" }],
  ["fome de leão kkkk", { form: "need", key: "fome" }],
  ["bateu uma larica", { form: "need", need: "larica", key: "larica", criteria: ["fast"] }],
  ["to com sede", { form: "need", key: "sede", urgency: true }],
  ["tô com frio", { form: "need", key: "frio" }],
  ["to com sono, preciso de algo pra acordar", { form: "need", key: "algo pra acordar" }],
  ["tô com preguiça de cozinhar", { form: "need", key: "preguica de cozinhar" }],
  ["cansadoo demais, preciso de energia mas sem energético", { form: "need", key: "cansaco", constraints: ["sem energético"] }],
  ["to com fome mas sem dinheiro, ate 30 reais", { form: "need", key: "fome", criteria: ["fast", "cheap"], budget: 30 }],
  ["bateu a larica de madrugada, o q vcs tem?", { form: "need", key: "larica" }],
  // fronteira: "algo rápido" não diz o quê; o estado manda
  ["tô faminta, algo rápido pfv", { form: "need", key: "fome", criteria: ["fast"], urgency: true }],
  // vontade
  ["quero algo doce", { form: "need", need: "algo doce", key: "algo doce" }],
  ["queria alguma coisa salgada", { form: "need", key: "algo salgado" }],
  ["que calor, quero algo gelado", { form: "need", key: "algo gelado" }],
  ["algo gelado pra beber", { form: "need", key: "algo gelado" }],
  ["algo frio pra beber", { form: "need", key: "algo gelado" }],
  ["algo quentinho pra tomar, tá frio", { form: "need", key: "algo quente" }],
  ["uma coisinha leve pro jantar", { form: "need", key: "algo leve", criteria: ["healthy"] }],
  ["preciso de algo saudável pra lanchar", { form: "need", key: "algo saudavel", criteria: ["healthy"] }],
  ["algo doce e gelado", { form: "need", key: "algo doce e gelado" }],
  ["um doce", { form: "need", key: "algo doce" }],
  // fronteira: "doce"/"sobremesa" sozinhos não são produto (a busca devolvia uva doce e batata doce, §0 do plano)
  ["doce", { form: "need", key: "algo doce" }],
  ["uma sobremesa", { form: "need", key: "algo pra sobremesa" }],
  ["to com uma vontade de comer um doce", { form: "need", key: "algo doce" }],
  ["qualquer coisa pra beliscar", { form: "need", key: "algo pra beliscar" }],
  ["queria algo pra comer agora", { form: "need", key: "algo pra comer", criteria: ["fast"], urgency: true }],
  ["qero algo doce", { form: "need", key: "algo doce" }],
  ["me surpreende", { form: "need", key: "surpresa" }],
  ["me surpreenda hoje", { form: "need", key: "surpresa" }],
  ["o que tem de bom pra jantar?", { form: "need", need: "algo pra jantar", key: "algo pra jantar" }],
  ["oq tem de bom pra comer hj", { form: "need", key: "algo pra comer" }],
  ["nao sei o que comer", { form: "need", key: "algo pra comer" }],
  ["me recomenda algo pra jantar", { form: "need", key: "algo pra jantar" }],
  ["o que vc sugere pra sobremesa?", { form: "need", key: "algo pra sobremesa" }],
  ["me indica alguma coisa gostosa", { form: "need", key: "algo gostoso" }],
  ["quero algo doce mas sem chocolate", { form: "need", key: "algo doce", constraints: ["sem chocolate"] }],
  ["algo doce sem lactose", { form: "need", key: "algo doce", constraints: ["sem lactose"] }],
  ["algo salgado vegano", { form: "need", key: "algo salgado", constraints: ["vegano"] }],
  ["sou diabética, queria um docinho", { form: "need", key: "algo doce", constraints: ["sem açúcar"] }],
  ["algo doce zero açúcar", { form: "need", key: "algo doce", constraints: ["sem açúcar"] }],
  // ocasião
  ["churrasco pra 8", { form: "need", need: "churrasco pra 8 pessoas", key: "churrasco" }],
  ["vou fazer um churras sábado pra uns 15 amigos", { form: "need", need: "churrasco pra 15 pessoas", key: "churrasco" }],
  ["café da manhã pra 4", { form: "need", need: "café da manhã pra 4 pessoas", key: "cafe da manha" }],
  ["algo pro café da manhã", { form: "need", key: "cafe da manha" }],
  ["festa infantil", { form: "need", key: "festa infantil" }],
  ["vou fazer uma festinha de aniversário pro meu filho de 5 anos", { form: "need", key: "festa infantil" }],
  ["noite de filme com a namorada", { form: "need", key: "noite de filme", recipient: "namorada" }],
  ["bora uma noite de filme hoje", { form: "need", key: "noite de filme" }],
  ["jantar romântico pra dois", { form: "need", need: "jantar romântico pra 2 pessoas", key: "jantar romantico" }],
  ["vai ter visita aqui em casa", { form: "need", key: "receber visitas" }],
  ["me ajuda com o lanche da escola do meu filho", { form: "need", key: "lancheira" }],
  ["preciso limpar o banheiro", { form: "need", need: "limpar o banheiro", key: "limpar banheiro" }],
  ["o que uso pra tirar mofo da parede", { form: "need", key: "tirar mofo" }],
  ["preciso dar uma faxina na casa", { form: "need", key: "faxina" }],
  ["festa infantil em casa, 20 crianças de 6 anos", { form: "need", need: "festa infantil pra 20 crianças", recipient: "criança 6 anos" }],
  ["viagem de carro de 6 horas com 2 criancas, nada de amendoim (alergia)", { form: "need", key: "viagem", constraints: ["sem amendoim"] }],
  ["adotei um gatinho hj, o que preciso?", { form: "need", key: "gato novo", recipient: "gato" }],
  ["chegou um bebe aqui em casa, preciso do basico", { form: "need", key: "bebe novo" }],
  // presente sem produto
  ["presente pra minha mãe", { form: "need", recipient: "mãe", key: "presente mae" }],
  ["presente pra minha mãe até 100", { form: "need", recipient: "mãe", key: "presente mae", budget: 100 }],
  ["presente pra minha mãe até 120 reais", { form: "need", recipient: "mãe", budget: 120 }],
  ["quero dar um presente pra minha mãe, tenho uns 120 reais no total com a entrega", { form: "need", recipient: "mãe", key: "presente mae", budget: 120 }],
  ["o que dar pro meu pai", { form: "need", need: "presente pro meu pai", recipient: "pai", key: "presente pai" }],
  ["presente pro meu sobrinho de 5 anos", { form: "need", recipient: "sobrinho 5 anos", key: "presente sobrinho" }],
  ["quero dar um presente pra minha namorada, até 150", { form: "need", recipient: "namorada", budget: 150 }],
  ["amigo secreto até 50 reais", { form: "need", key: "presente amigo secreto", budget: 50 }],
  ["presente de dia das mães", { form: "need", key: "presente mae" }],
  ["uma lembrancinha pra professora", { form: "need", key: "presente professora" }],
  ["lembrancinha pra professora, nada caro", { form: "need", key: "presente professora", criteria: ["cheap"] }],
  ["presente de casamento pra uma amiga, uns 200", { form: "need", recipient: "amiga", budget: 200 }],
  ["amigo secreto da familia, valor 30, sem bebida alcoolica", { form: "need", key: "presente amigo secreto", budget: 30 }],
  // sintoma
  ["to com uma dor de cabeça horrível", { form: "need", symptom: "dor de cabeça", key: "dor de cabeca" }],
  ["dor de cabeça", { form: "need", symptom: "dor de cabeça" }],
  ["algo pra azia", { form: "need", symptom: "azia", key: "azia" }],
  ["tô gripado", { form: "need", symptom: "gripe" }],
  ["tô enjoada", { form: "need", symptom: "enjoo" }],
  ["minha garganta ta inflamada", { form: "need", symptom: "dor de garganta" }],
  ["qual remédio é bom pra cólica?", { form: "need", symptom: "cólica" }],
  // dois sintomas: vale o que veio primeiro na frase
  ["comi demais, to estufado", { form: "need", symptom: "má digestão" }],
  ["tô com tosse", { form: "need", symptom: "tosse" }],
  ["meu nariz ta entupido", { form: "need", symptom: "nariz entupido" }],
  ["algo pra dor nas costas", { form: "need", symptom: "dor nas costas" }],
  ["to com diarreia desde ontem", { form: "need", symptom: "diarreia" }],
  ["to de ressaca", { form: "need", key: "ressaca", symptom: "ressaca" }],
  ["tô de ressaca, o que é bom?", { form: "need", symptom: "ressaca" }],
  ["o que tomar pra dor de cabeça", { form: "need", symptom: "dor de cabeça" }],
  ["dor de cabeça, mas sou alérgica a dipirona", { form: "need", symptom: "dor de cabeça", constraints: ["sem dipirona"] }],
  // sinais de alerta continuam recomendação (a etapa MAPEAR é que decide o alerta e não recomenda)
  ["meu bebe de 3 meses ta com febre e vomitando", { form: "need", symptom: "febre", recipient: "bebê 3 meses" }],
  ["tô grávida de 6 semanas e com dor forte na barriga", { form: "need", symptom: "dor de barriga" }],
  ["a pior dor de cabeça da minha vida, veio de repente", { form: "need", symptom: "dor de cabeça" }],
  // beleza/cuidado (com gatilho)
  ["o que é bom pra cabelo ressecado", { form: "need", key: "cabelo ressecado" }],
  ["algo pra caspa", { form: "need", key: "caspa" }],
  // com opções na tela, necessidade NOVA e inequívoca continua valendo
  ["tô com fome, quero algo doce", { form: "need", key: "algo doce" }, TELA]
];

// ---------------------------------------------------------------- produto + julgamento
const JUDGED: Row[] = [
  ["qual o melhor shampoo pra cabelo cacheado", { form: "product_judged", product: "shampoo pra cabelo cacheado", criteria: ["good"] }],
  ["qual ração vale a pena pro meu gato", { form: "product_judged", product: "ração pro gato", recipient: "gato", criteria: ["good"] }],
  ["um bom vinho", { form: "product_judged", product: "vinho", criteria: ["good"] }],
  ["vinho bom até 80 reais", { form: "product_judged", product: "vinho", budget: 80 }],
  ["me indica um vinho tinto bom e barato", { form: "product_judged", product: "vinho tinto", criteria: ["good", "cheap"] }],
  ["qual a melhor cerveja?", { form: "product_judged", product: "cerveja" }],
  ["qual o melhor café?", { form: "product_judged", product: "café" }],
  ["qual sabão em pó é bom?", { form: "product_judged", product: "sabão em pó" }],
  ["me recomenda um protetor solar pra pele oleosa", { form: "product_judged", product: "protetor solar pra pele oleosa" }],
  ["qual fralda vc recomenda pra recém nascido?", { form: "product_judged", product: "fralda pra recém nascido" }],
  ["me indica um perfume masculino", { form: "product_judged", product: "perfume masculino" }],
  ["me indica um perfume pra minha mãe", { form: "product_judged", product: "perfume pra mãe", recipient: "mãe" }],
  ["qual o melhor sabonete pra pele sensível", { form: "product_judged", product: "sabonete pra pele sensível" }],
  ["qual cerveja vale a pena?", { form: "product_judged", product: "cerveja" }],
  ["me sugere um vinho pra churrasco", { form: "product_judged", product: "vinho pra churrasco" }],
  ["qual azeite é bom?", { form: "product_judged", product: "azeite" }],
  ["um arroz bom", { form: "product_judged", product: "arroz" }],
  ["quero um café bom", { form: "product_judged", product: "café" }],
  ["qual o melhor desodorante masculino", { form: "product_judged", product: "desodorante masculino" }],
  ["qual papel higiênico vale mais a pena", { form: "product_judged", product: "papel higiênico" }],
  ["me indica uma ração boa pra cachorro filhote", { form: "product_judged", product: "ração pra cachorro filhote", recipient: "cachorro" }],
  ["qual o melhor fone bluetooth até 200", { form: "product_judged", product: "fone bluetooth", budget: 200 }],
  ["qual brinquedo é bom pra criança de 3 anos", { form: "product_judged", product: "brinquedo pra criança de 3 anos", recipient: "criança 3 anos" }],
  ["me recomenda um shampoo sem sal", { form: "product_judged", product: "shampoo", constraints: ["sem sal"] }],
  ["um bom vinho até 60 reais", { form: "product_judged", product: "vinho", budget: 60 }],
  ["qual o melhor iogurte sem lactose", { form: "product_judged", product: "iogurte", constraints: ["sem lactose"] }],
  ["q chocolate vc indica?", { form: "product_judged", product: "chocolate" }],
  ["qual a melhor marca de leite", { form: "product_judged", product: "leite" }],
  ["o que vc recomenda de vinho?", { form: "product_judged", product: "vinho" }],
  ["pode ser uma lasanha congelada, o que vc recomenda?", { form: "product_judged", product: "lasanha congelada" }],
  ["qual fralda é melhor pra recem nascido?", { form: "product_judged", product: "fralda pra recem nascido" }],
  ["me indica um café bom, de coador", { form: "product_judged", product: "café de coador" }],
  ["qual detergente rende mais?", { form: "product_judged", product: "detergente" }],
  ["me indica um sorvete gostoso sem lactose", { form: "product_judged", product: "sorvete", constraints: ["sem lactose"] }],
  ["me recomenda uma cerveja boa pra hoje", { form: "product_judged", product: "cerveja", criteria: ["good", "fast"] }],
  // com opções na tela, só com verbo explícito ("me recomenda", "qual o melhor X")
  ["me recomenda um chocolate bom", { form: "product_judged", product: "chocolate" }, TELA]
];

// ---------------------------------------------------------------- produto nomeado / comando / serviço → null (busca de sempre)
const PRODUCT: Row[] = [
  ["quero chocolate", "product"],
  ["2 cocas", "product"],
  ["arroz e feijão", "product"],
  ["ração golden 15kg", "product"],
  ["leite ninho", "product"],
  ["me ve 3 pães franceses", "product"],
  ["coca 2 litros", "product"],
  ["sabonete dove", "product"],
  ["uma pizza de calabresa", "product"],
  ["detergente ypê", "product"],
  ["quero um sorvete", "product"],
  ["fralda pampers g", "product"],
  ["doce de leite", "product"],
  ["batata doce", "product"],
  ["pão de queijo", "product"],
  ["cerveja gelada", "product"],
  ["leite sem lactose", "product"],
  ["amaciante sem perfume", "product"],
  ["vinho tinto até 50 reais", "product"],
  ["chocolate barato", "product"],
  ["sabão em pó mais barato", "product"],
  ["shampoo pra cabelo cacheado", "product"],
  ["perfume pra minha mãe", "product"],
  ["ração pro meu cachorro", "product"],
  ["carvão pro churrasco", "product"],
  ["picanha pro churrasco", "product"],
  ["panetone de natal", "product"],
  ["bolo de aniversário", "product"],
  ["bom dia, quero 2 leites", "product"],
  ["dipirona", "product"],
  ["tem dipirona? to com dor de cabeça", "product"],
  ["qual a melhor dipirona", "product"],
  ["o 2", "product"],
  ["a primeira", "product"],
  ["mais barato", "product"],
  ["outras opções", "product"],
  ["tira o leite", "product"],
  ["troca o arroz por integral", "product"],
  ["só isso", "product"],
  ["pode fechar", "product"],
  ["quanto é o frete?", "product"],
  ["qual o prazo de entrega?", "product"],
  ["cadê meu pedido?", "product"],
  ["tenta de novo", "product"],
  ["01310-100", "product"],
  ["pix", "product"],
  ["quero pagar", "product"],
  ["oi", "product"],
  ["boa noite", "product"],
  ["obrigada", "product"],
  ["sim", "product"],
  ["quero falar com um atendente", "product"],
  ["qual a melhor loja?", "product"],
  ["qual o melhor?", "product"],
  ["esse é bom?", "product"],
  ["quero comprar algo", "product"],
  // fronteira: exemplo concreto vence o pedido vago
  ["algo doce tipo um chocolate", "product"],
  ["to com fome, me ve um x-tudo", "product"],
  ["tô com vontade de chocolate", "product"],
  ["algo salgado, tipo um hambúrguer", "product"],
  // fronteira: lista mista (produto + julgamento de outro) segue a busca de sempre; a IA do gerente separa
  ["2 cocas e me indica um vinho bom", "product"],
  ["arroz e feijão bons", "product"],
  // fronteira: "lanche"/"salgadinho" são produto de prateleira (sanduíche, chips) — busca de sempre
  ["quero um lanche", "product"],
  ["tô muito a fim de um salgadinho", "product"],
  ["doce de leite pastoso", "product"],
  ["pão doce", "product"],
  // com opções na tela: refino, mais opções e pergunta sobre a tela NUNCA são recomendação
  ["mais barato", "product", TELA],
  ["sem açúcar", "product", TELA],
  ["outras", "product", TELA],
  ["qual o melhor?", "product", TELA],
  ["qual vc recomenda?", "product", TELA],
  ["tem de chocolate bom?", "product", TELA],
  ["me surpreende", "product", TELA],
  ["sem chocolate", "product", TELA],
  // pergunta sobre o item já escolhido
  ["o vinho é bom?", "product", { basketNames: ["Vinho Tinto Casillero del Diablo 750ml"] }]
];

const TABLE: Row[] = [...SECAO_0, ...NEED, ...JUDGED, ...PRODUCT];

function check(row: Row): string | null {
  const [text, expect, opts] = row;
  const got = detectRecommendation(text, opts);
  if (expect === "product") return got ? `virou ${got.form} (${got.need ?? got.product})` : null;
  if (!got) return "deu null";
  const problems: string[] = [];
  if (got.form !== expect.form) problems.push(`forma ${got.form}`);
  if (got.source !== "regex") problems.push(`source ${got.source}`);
  if (got.text !== text.trim()) problems.push("text não é a mensagem original");
  const eq = (field: keyof RecommendRequest, want: unknown) => {
    if (want !== undefined && got[field] !== want) problems.push(`${field}=${JSON.stringify(got[field])} (esperado ${JSON.stringify(want)})`);
  };
  eq("need", expect.need);
  eq("product", expect.product);
  eq("recipient", expect.recipient);
  eq("symptom", expect.symptom);
  eq("budget", expect.budget);
  if (expect.urgency !== undefined && Boolean(got.urgency) !== expect.urgency) problems.push(`urgency=${got.urgency}`);
  for (const c of expect.criteria ?? []) if (!got.criteria.includes(c)) problems.push(`sem critério ${c} (${got.criteria.join(",")})`);
  if (expect.constraints && JSON.stringify(got.constraints) !== JSON.stringify(expect.constraints)) problems.push(`constraints=${JSON.stringify(got.constraints)}`);
  if (expect.key !== undefined && needKey(got) !== expect.key) problems.push(`needKey=${needKey(got)} (esperado ${expect.key})`);
  if (got.form === "need" && !got.need) problems.push("need vazio");
  if (got.form === "product_judged" && !got.product) problems.push("product vazio");
  return problems.length ? problems.join("; ") : null;
}

test("tabela-ouro: tamanho e cobertura mínimos do plano (≥120 frases; ≥40 produto, ≥40 necessidade, ≥25 julgamento)", () => {
  assert.ok(TABLE.length >= 120, `só ${TABLE.length} frases`);
  assert.ok(PRODUCT.length >= 40, `só ${PRODUCT.length} de produto`);
  assert.ok(NEED.length + 4 >= 40, `só ${NEED.length} de necessidade`);
  assert.ok(JUDGED.length + 1 >= 25, `só ${JUDGED.length} de julgamento`);
});

test("tabela-ouro: ZERO produto nomeado/comando/serviço virando recomendação", () => {
  const stolen = PRODUCT.map((row) => [row[0], check(row)] as const).filter(([, err]) => err);
  assert.deepEqual(stolen, [], `recomendação roubou a busca: ${JSON.stringify(stolen)}`);
});

test("tabela-ouro: forma + campos de cada frase (placar da etapa ENTENDER)", () => {
  const failures = TABLE.map((row) => [row[2]?.hasPendingChoice ? `[tela] ${row[0]}` : row[0], check(row)] as const).filter(([, err]) => err);
  const score = (TABLE.length - failures.length) / TABLE.length;
  console.log(`[recommend-golden] ${TABLE.length - failures.length}/${TABLE.length} = ${(score * 100).toFixed(1)}%`);
  assert.deepEqual(failures, [], failures.map(([t, e]) => `${t}: ${e}`).join("\n"));
});

test("as 5 frases da seção 0 do plano", () => {
  for (const row of SECAO_0) assert.equal(check(row), null, row[0]);
});

test("classifyForm devolve as 3 formas", () => {
  assert.equal(classifyForm("quero chocolate"), "product");
  assert.equal(classifyForm("me recomenda um chocolate bom"), "product_judged");
  assert.equal(classifyForm("tô com fome"), "need");
});

test("needKey: chaves normalizadas também para o que a IA devolve (sem acento, sem artigo, sem número)", () => {
  const k = (over: Partial<RecommendRequest>) => needKey({ form: "need", ...over } as RecommendRequest);
  assert.equal(k({ need: "algo doce" }), "algo doce");
  assert.equal(k({ need: "Fome" }), "fome");
  assert.equal(k({ need: "dor de barriga", symptom: "Dor de barriga" }), "dor de barriga");
  assert.equal(k({ need: "presente pra minha mãe", recipient: "mãe" }), "presente mae");
  assert.equal(k({ need: "presente", recipient: "criança 5 anos" }), "presente crianca");
  assert.equal(k({ need: "churrasco pra 8 pessoas" }), "churrasco");
  assert.equal(k({ need: "café da manhã" }), "cafe da manha");
  assert.equal(needKey({ form: "product_judged", product: "um Chocolate" } as RecommendRequest), "chocolate");
});

test("mensagem enorme ou vazia não é recomendação", () => {
  assert.equal(detectRecommendation(""), null);
  assert.equal(detectRecommendation(`tô com fome ${"e muita ".repeat(60)}`), null);
});
