// Golden set da BUSCA de produtos — o placar que substitui tentativa-e-erro infinita.
//
// Cada caso é um pedido real (ou realista) com o resultado esperado rotulado. Ele é
// consumido por dois harnesses:
//
//   1. tests/search-golden.test.ts — roda o pipeline DETERMINÍSTICO (sem OpenAI) nos
//      casos `deterministic: true`. É o piso de regressão: o que passa aqui não pode
//      voltar a quebrar. Roda no `npm test`, rápido e sem rede.
//   2. scripts/eval-search.mts — roda o pipeline COMPLETO (extração + rerank por IA)
//      em TODOS os casos com a chave real e imprime o placar. É onde se mede se uma
//      mudança de prompt/scorer melhorou ou piorou o conjunto, antes de ir pra prod.
//
// Fluxo de melhoria: cliente reporta busca ruim → vira caso aqui (com o esperado
// certo) → roda o eval → conserta (prompt, scorer, catálogo) → placar sobe → commit.
// Regras novas no scorer só entram acompanhadas de caso que as justifique.
//
// Convenções: os regexes casam contra o NOME NORMALIZADO (minúsculas, sem acento —
// normalizeText). `query` é a linha JÁ extraída (o que chega na busca); `message` é a
// mensagem crua do cliente, usada só pelo eval completo quando a extração por IA faz
// parte do que se quer testar (sinônimo tipo "pasta de dente" → "creme dental").

export type GoldenCase = {
  name: string;
  // Linha de pedido como chega na busca (pós-extração).
  query: string;
  // Mensagem crua p/ o eval completo (default: a própria query).
  message?: string;
  // A 1ª opção mostrada deve casar…
  top1Include?: RegExp;
  // …e não pode casar.
  top1Exclude?: RegExp;
  // NENHUMA das opções mostradas pode casar (o determinístico só garante isso nos
  // casos `deterministic`; no eval por IA vale para todos).
  allExclude?: RegExp;
  // Resultado honesto = nenhuma opção (linha livre pro operador cotar).
  none?: boolean;
  // As opções mostradas devem ser produtos DISTINTOS entre si — nunca o mesmo produto
  // (ou quase) em outra cor/tamanho/embalagem (checado com sameProductVariant).
  distinctOptions?: boolean;
  // O pipeline determinístico (sem OpenAI) já passa este caso — vira regressão dura
  // no npm test. `false` = só a camada de IA resolve (sinônimo/julgamento semântico).
  deterministic: boolean;
  note?: string;
};

export const GOLDEN_CASES: GoldenCase[] = [
  // ---- o caso que motivou tudo (06/08): forma/uso errados com palavras parecidas ----
  {
    name: "carregador usb c → nunca veicular; sem loja que venda, linha livre",
    query: "carregador usb c",
    // 28/09: a única loja com carregador USB-C (Casa & Vídeo) saiu da vitrine (Pix recusado).
    // O certo agora é "não tenho", nunca um veicular no lugar. Se voltar uma loja com o item,
    // troque por top1Include: /usb.?c|parede/.
    none: true,
    deterministic: true,
    note: "3 carregadores veiculares venciam por empate léxico + desempate por preço"
  },
  {
    name: "carregador veicular continua achável (o inverso não pode quebrar)",
    query: "carregador veicular",
    // 27/09: a Drogal chama o mesmo produto de "Carregador Carro" (sinônimo no matcher).
    top1Include: /veicular|carro/,
    deterministic: true
  },

  // ---- diversidade (10/08): as 3 opções não podem ser quase o mesmo produto ----
  {
    name: "carregador genérico mostra 3 produtos distintos, não 3 vezes o quase-mesmo",
    query: "carregador usb",
    top1Include: /carregador/,
    distinctOptions: true,
    deterministic: true,
    note: "caso real 10/08: pedir carregador devolvia quase o mesmo carregador 3x"
  },

  // ---- guardas de espécie/variante que já existiam (não podem regredir) ----
  { name: "ração de cachorro sem item de gato", query: "racao para cachorro", top1Include: /ca(es|o)|cachorro/, allExclude: /gato/, distinctOptions: true, deterministic: true, note: "distinctOptions 10/08: mostrava 3 tamanhos da quase-mesma ração" },
  { name: "ração de gato sem item de cão", query: "racao para gato", top1Include: /gato/, allExclude: /\bca(es|o)\b(?! e gatos)|cachorro/, deterministic: true },
  { name: "ração de filhote quando pedida", query: "racao filhote cachorro", top1Include: /filhote|puppy|junior/, deterministic: true },
  { name: "shampoo humano nunca vira produto pet", query: "shampoo", allExclude: /\bca(es|o)\b|cachorro|\bgatos?\b|\bpet\b/, top1Include: /shampoo|xampu/, deterministic: true },

  // ---- tamanho/atributo pedido ----
  { name: "coca 2 litros traz a garrafa certa", query: "coca cola 2 litros", top1Include: /coca.*2\s*l/, deterministic: true },
  { name: "leite sem lactose respeita a negação", query: "leite sem lactose", top1Include: /(sem|zero)\s*lactose/, deterministic: true },
  { name: "café sem açúcar não traz o adoçado", query: "cafe sem acucar", allExclude: /com acucar/, deterministic: true },

  // ---- básicos de mercearia/higiene (o feijão-com-arroz não pode quebrar) ----
  { name: "arroz básico primeiro", query: "arroz", top1Include: /arroz/, deterministic: true },
  { name: "papel higiênico", query: "papel higienico", top1Include: /higienico/, deterministic: true },
  { name: "sabão em pó", query: "sabao em po", top1Include: /sabao|lava.?roupas/, deterministic: true },
  { name: "água com gás", query: "agua com gas", top1Include: /com gas/, deterministic: true },
  { name: "detergente", query: "detergente", top1Include: /detergente/, deterministic: true },
  { name: "miojo acha o lámen", query: "miojo", top1Include: /miojo|lamen/, deterministic: true },
  {
    name: "leite é de vaca — não de coco, não loção, não pet",
    query: "leite",
    top1Include: /^leite/,
    allExclude: /de (coco|soja|amendoas|castanha|aveia|rosas)|\bpet\b|gatos?|caes/,
    deterministic: true,
    note: "3 bugs empilhados: 'de coco' faltava na lista de variantes, a marca 'Leiteria' casava por prefixo e a versão pet não era penalizada — o cliente recebia loção de pele"
  },
  {
    name: "água sem qualificador é água mineral (com gás só quando pedido)",
    query: "agua",
    top1Include: /agua mineral|agua natural/,
    deterministic: true
  },
  {
    name: "cotonete acha o cotonete (nome comercial põe o termo em 2º lugar)",
    query: "cotonete",
    top1Include: /cotonete|haste/,
    deterministic: true,
    note: "a regra de pedido-de-1-palavra zerava 'Hastes Flexíveis COTONETES' por não ser o head"
  },
  {
    name: "ovos: a palavra como ingrediente não vale (regra que a apposição não pode afrouxar)",
    query: "ovos",
    top1Include: /^ovos?\b/,
    allExclude: /macarrao|biscoito/,
    deterministic: true
  },

  // ---- verticais ----
  { name: "perfume feminino vai pra beleza", query: "perfume feminino", top1Include: /colonia|perfume|eau de/, deterministic: true },
  {
    name: "hidratante é o produto, não o sabonete que hidrata",
    query: "hidratante",
    top1Include: /hidratante/,
    top1Exclude: /sabonete/,
    deterministic: true,
    note: "re-teste 15/08 rodada 10: 'Sabonete Líquido Hidratante' vencia o hidratante corporal"
  },
  { name: "cerveja da marca pedida", query: "cerveja heineken", top1Include: /heineken/, deterministic: true },
  { name: "vinho tinto", query: "vinho tinto", top1Include: /tinto/, deterministic: true },
  { name: "chocolate", query: "chocolate", top1Include: /chocolate|bombom|cacau/, deterministic: true },
  { name: "fralda tamanho G", query: "fralda g", top1Include: /fralda/, deterministic: true },
  { name: "brinquedo de cachorro", query: "brinquedo cachorro", top1Include: /brinquedo|mordedor|bolinha/, deterministic: true },
  { name: "whisky", query: "whisky", top1Include: /whisky|whiskey/, deterministic: true },

  // ---- honestidade: fora de catálogo → nenhuma opção (linha livre) ----
  {
    name: "cabo usb-c é cabo USB-C — nunca carregador, nunca cabo elétrico de obra",
    query: "cabo usb c 2 metros",
    top1Include: /^cabo .*(usb|tipo.?c)/,
    allExclude: /carregador|flexivel|porteiro|extensor/,
    deterministic: true,
    note: "4º ciclo 15/08: o catálogo não tinha cabo USB-C e o rerank servia carregador de parede. 27/09: Drogal/Casa & Vídeo têm cabo USB-C; a Obramax/Telhanorte têm cabo elétrico 'por metro' que empatava — especificação técnica pedida (usb) agora é obrigatória"
  },
  { name: "conserto de torneira não vira espumante", query: "conserto de torneira", none: true, deterministic: true, note: "fuzzy conserto≈concerto; caso real do piso do concierge" },
  // 27/09: Mondial e Philco entraram na vitrine e VENDEM parafusadeira — o caso virou "achável".
  { name: "parafusadeira (Mondial/Philco) é achável", query: "parafusadeira", top1Include: /parafusadeira/, deterministic: true },

  // ---- casos que SÓ a camada de IA resolve (sinônimo/julgamento) ----
  {
    name: "escova de dente acha Escova Dental (derivação que o léxico não cobre)",
    query: "escova de dente macia",
    top1Include: /escova (de )?dent/,
    deterministic: false,
    note: "o piso léxico não casa dente≈dental; o rerank deve aprovar o candidato"
  },
  {
    name: "pasta de dente é creme dental (sinônimo na extração)",
    query: "creme dental",
    message: "quero uma pasta de dente",
    top1Include: /creme dental/,
    allExclude: /amendoim/,
    deterministic: false
  },
  {
    name: "refri vira refrigerante na extração",
    query: "refrigerante",
    message: "me ve um refri gelado",
    top1Include: /refrigerante|coca|guarana/,
    deterministic: true,
    note: "a query canônica é determinística; a mensagem crua depende da extração"
  },
  {
    name: "carregador genérico prioriza o de uso comum (parede), não o veicular",
    query: "carregador de celular",
    top1Exclude: /veicular/,
    distinctOptions: true,
    deterministic: false,
    note: "empate semântico: IA deve preferir parede/cabo como 1ª opção"
  },
  {
    name: "óleo sozinho é óleo de COZINHA, nunca corporal/capilar (27/08 S18)",
    query: "oleo",
    message: "arroz, feijão, café, leite, banana, óleo e sabão em pó",
    top1Include: /soja|girassol|milho|canola|cozinha|algodao|oleo de/,
    allExclude: /corporal|corpo|capilar|cabelo|massagem|paixao/,
    deterministic: false,
    note: "rodada 27/08 S18: 'óleo' na lista semanal virou Óleo Corporal Paixão R$14,84 — contexto de mercado define o sentido"
  },
  {
    name: "apoio pra guitarra de chão → suporte de chão, nunca apoio de PÉ (caso real 01/09)",
    query: "apoio pra guitarra de chao",
    top1Include: /suporte|estante|ch[aã]o/,
    top1Exclude: /apoio de p[eé]|descanso|pedal/,
    deterministic: false,
    note: "pedido real do dono: top1 veio 'Apoio De Pé Descanso Violonista' (descanso de pé) e a 2ª opção um expositor de quadros/livros — 'de chão' define o tipo do acessório"
  },
  {
    name: "apoio de pé para violão continua achável (o inverso não pode quebrar)",
    query: "apoio de pe para violao",
    top1Include: /apoio de p[eé]|descanso/,
    deterministic: false
  }
];
