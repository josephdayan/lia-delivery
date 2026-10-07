// Gerente de diálogo ("IA decide, código garante", Fase 2 do plano-conversa-100, 07/10/2026).
// A IA lê a mensagem + o ESTADO da conversa e devolve AÇÕES de uma lista fechada; o código
// valida contra o estado e executa pelos handlers que já existem. A IA nunca define preço,
// total, cobrança, estorno nem prazo: dinheiro continua nos caminhos determinísticos.

export const ACTION_TYPES = [
  "search",
  "pick",
  "more_options",
  "refine",
  "set_qty",
  "add_qty",
  "remove",
  "swap",
  "skip_current",
  "only_keep",
  "close_list",
  "answer",
  "human",
  "status",
  "cancel",
  "pay",
  "change_address",
  "smalltalk",
  // Produto/serviço que a Lia não vende (carro, imóvel…) e pedido/insistência de remédio:
  // a resposta é o texto FIXO do lia-copy (nunca texto livre da IA).
  "out_of_scope",
  "medicine",
  "unclear"
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// Perguntas sobre o serviço: a resposta é o TEXTO FIXO e verdadeiro do lia-copy (o executor
// reencaminha uma pergunta canônica ao roteador de intenções), nunca texto livre da IA.
export const ANSWER_TOPICS = [
  "delivery_fee",
  "delivery_time",
  "payment_methods",
  "area",
  "service_fee",
  "price_compare",
  "safety",
  "identity",
  "invoice",
  "cnpj",
  "who_delivers",
  "pix_receiver",
  "coupon",
  "installments",
  "scheduling",
  "stores",
  "how_it_works",
  "order_total",
  "minimum_order"
] as const;
export type AnswerTopic = (typeof ANSWER_TOPICS)[number];

export const SORTS = ["next", "cheaper", "pricier"] as const;
export type Sort = (typeof SORTS)[number];

export const PAY_METHODS = ["pix", "card", "unspecified"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

// Ação CRUA devolvida pela IA (campos nulos viram undefined). Os números (option, target, from)
// referem a numeração do ESTADO enviado — nunca a skus nem a preços.
export type DialogueAction = {
  type: ActionType;
  // pick: número da opção (da tela, da última escolha ou da entrega).
  option?: number;
  // search/pick: quantidade DITA pelo cliente nesta mensagem.
  qty?: number;
  // add_qty: unidades a somar (negativo tira).
  delta?: number;
  // set_qty/add_qty/remove/only_keep: 0 = item em escolha na tela; 1..B = cesta; B+1.. = fila.
  target?: number;
  // search: frase de busca do produto (marca/nome como o cliente escreveu).
  query?: string;
  // refine: característica nova do MESMO produto ("sem açúcar", "5 kg", "de soja").
  attribute?: string;
  // swap: item da cesta (número) trocado pelo produto descrito em `to`.
  from?: number;
  to?: string;
  topic?: AnswerTopic;
  method?: PayMethod;
  // smalltalk/unclear: frase curta; change_address: endereço/CEP dito pelo cliente.
  text?: string;
  sort?: Sort;
  // search: o cliente quer REPETIR o último "não achei" (ex.: "tenta em outra loja").
  retry?: boolean;
  // search durante a escolha: troca o item em escolha por este (em vez de entrar na fila).
  replace?: boolean;
};

export type DialogueDecision = { actions: DialogueAction[] };

// ---------- estado enviado à IA ----------

export type StateOption = { n: number; nome: string; preco: number; loja?: string; prazo?: string; escolhida?: boolean };

export type DialogueState = {
  passo: "montando_lista" | "escolhendo_opcao" | "total_na_mesa" | "escolhendo_frete";
  enderecoSalvo: boolean;
  cesta: { n: number; nome: string; qtd: number; loja?: string; precoUnit: number }[];
  // Itens ainda sem escolha (depois do que está na tela), numerados a seguir da cesta.
  fila: { n: number; item: string; qtd: number }[];
  emEscolha: null | { item: string; qtdPedida: number; qtdDita: boolean; tetoPreco?: number; opcoes: StateOption[] };
  // Sem escolha aberta: a lista da última escolha concluída (trocar pelo "outro" / "o de R$34").
  ultimaEscolha: null | { item: string; opcoes: StateOption[] };
  naoAcheiRecente: null | { pedido: string; qtd: number; jaTentouDeNovo: boolean };
  totalNaMesa: number | null;
  cobrancaAberta: boolean;
  opcoesDeFrete: null | { n: number; tipo: "barata" | "rapida"; frete: number; prazo?: string }[];
};

export type ModelInput = { text: string; state: DialogueState };

export type PlanOutcome =
  // handled: o executor respondeu ao cliente. rewrite: reencaminha uma frase canônica ao
  // roteador de intenções (fecha/paga/cancela/pergunta seguem os caminhos determinísticos).
  // fallthrough: nada a fazer — o caminho de hoje assume.
  | { kind: "handled"; actions: string }
  | { kind: "rewrite"; text: string; actions: string }
  | { kind: "fallthrough"; reason: string };
