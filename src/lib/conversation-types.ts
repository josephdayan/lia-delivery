// Tipos e contas puras da conversa (revisão 02/09): extraídos de delivery-service.ts.
// Sem I/O — só tipos, constantes e funções de dinheiro/rótulo compartilhadas.
import { ParsedLine } from "@/lib/lia-intents";
import { ACTIVE_DELIVERY_ORDER_STATUSES, CONCIERGE_STORE_KEY } from "@/lib/order-flags";
import { displayPrice } from "@/lib/pricing";
import { DEFAULT_STORE_KEY, StoreConnector, getStore } from "@/lib/stores";
import * as copy from "@/lib/lia-copy";
import type { SpecAsk, SpecKind } from "@/lib/spec-ask";
import type { RecommendRequest, ShelfCandidate, ShelfPlan } from "@/lib/recommend/types";

// Card MDR (~4.99% à vista) passed through to the customer when they choose card, so the
// 10% margin survives. Gross-up: charged = net / (1 - mdr). Tunable via env as volume
// lowers the rate. Pix has no fee, so its total is the base.
export const CARD_MDR = Math.min(0.3, Math.max(0, Number(process.env.LIA_CARD_MDR ?? 0.0499)));

export function cardTotal(base: number): number {
  return Math.round((base / (1 - CARD_MDR)) * 100) / 100;
}

// Remédio isento não leva markup (29/09): a taxa da Lia sai numa linha própria da cotação.
export function display(price: number, medicine?: string): number {
  return medicine === "mip" ? Math.round(price * 100) / 100 : displayPrice(price);
}

export type BasketItem = {
  sku: string;
  name: string;
  brand?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  storeKey: string;
  storeLabel: string;
  productUrl?: string;
  // A oferta escolhida declarava frete grátis (anúncio do ML) — a cotação não cobra
  // frete por cima do que o próprio anúncio dá de graça.
  freeShipping?: boolean;
  // Remédio isento (29/09): sem markup, taxa da Lia em linha própria, compra no CPF do cliente.
  medicine?: "mip";
  // O que o cliente PEDIU nessa linha ("2 vodkas absolute" → "vodka absolut"), 08/10 noite: juntar a cesta
  // numa loja só compara com o pedido, não com a variante que a Lia escolheu (sabor, tamanho).
  ask?: string;
  // Prazo que a LOJA informou pro CEP na consulta ao vivo do card ("prazo da loja: 1 dia útil"), 09/10: a lista
  // e o "quanto tempo demora?" mostram o prazo direto, antes do total.
  delivery?: string;
};

// `verified`/`etaMinutes`/`delivery` (03/09): vêm da simulação AO VIVO no site da loja para
// o CEP do cliente — a única fonte que pode pôr prazo num card.
// `repeat` (04/09): o cliente já comprou este produto — vem primeiro e com destaque.
// `why` (08/10, recomendação): motivo de 1 linha do card ("doce e gelado", "alivia a cólica") — só em
// opção que veio de uma recomendação; aparece abaixo do nome no card e em itálico na lista de texto.
export type ChoiceOption = { sku: string; freightFee?: number; name: string; brand?: string; unitPrice: number; imageUrl?: string; productUrl?: string; storeKey?: string; storeLabel?: string; delivery?: string; freeShipping?: boolean; verified?: boolean; etaMinutes?: number; repeat?: boolean; medicine?: "mip"; unitWeightKg?: number; why?: string; suggestedQty?: number };

// Estado de uma escolha que veio de RECOMENDAÇÃO (08/10, plano-recomendacoes): o pedido entendido, o
// plano de prateleiras, as prateleiras já mostradas/sem item e os candidatos já buscados (para "mais
// barato" re-julgar sem nova busca e "outras" mostrar as próximas prateleiras). `logId` = RecommendLog.
export type RecommendationState = {
  request: RecommendRequest;
  plan: ShelfPlan;
  shownShelfIds: string[];
  emptyShelves: string[];
  candidates?: ShelfCandidate[];
  logId?: string;
};

export type StoreFulfillment = {
  storeKey: string;
  storeLabel: string;
  unitId: string;
  unitLabel: string;
  unitAddress: string;
  unitCep?: string;
  courierKey: string;
  courierQuoteId: string;
  deliveryMode?: "retailer_delivery" | "authorized_courier";
  deliveryPromise?: string;
  retailerTotal?: number;
  deliveryFee: number;
  etaMinutes: number;
  itemsSubtotal: number;
  serviceFee: number;
};

export type PendingChoice = {
  query: string;
  qty: number;
  // "pra hoje" (04/09): `urgent` = só opções com entrega da loja em menos de 1 dia;
  // `noneToday` = pediu hoje, ninguém entrega hoje — o cabeçalho diz isso e mostra o mais rápido.
  urgent?: boolean;
  noneToday?: boolean;
  // O cliente DISSE a quantidade ("uma coca", "2 leites") — não re-perguntar depois
  // da escolha; a pergunta de quantidade é só pra pedido sem quantidade.
  qtyExplicit?: boolean;
  options: ChoiceOption[];
  // Original query before a refinement ("coleira" when query became "coleira azul").
  baseQuery?: string;
  // Active refinement attributes ("azul", "2kg") — paging re-applies them.
  attrs?: string[];
  // Every sku already shown for this item, so "tem outras?" never repeats one — robust
  // even if the underlying ranking shifts between turns (live scrape vs seed).
  shownSkus?: string[];
  // TODA opção já mostrada (com dados completos), para o toque num card ANTIGO — de
  // antes do "outras"/refino — continuar escolhendo exatamente o produto daquele card.
  // Caso real 11/08: ids posicionais fizeram "Escolher esse" confirmar outro produto.
  shownOptions?: ChoiceOption[];
  // Teto de preço pedido na linha ("até R$50") — TODO caminho que repõe opções
  // (paginação, refino, mais-baratas, resgate) re-filtra por ele.
  cap?: number;
  // O teto vale para o TOTAL (produto + entrega estimada), não só para o preço do produto — pedido de um
  // item só (rodada 2, 07/10): paginação/refino/resgate também descartam o que estoura com o frete.
  capTotal?: boolean;
  // Escolha REABERTA ("Outras opções" depois de já ter escolhido): o novo pick
  // SUBSTITUI esta linha da cesta em vez de somar uma segunda mochila.
  replaceSku?: string;
  // O pool + a re-busca relaxada já esgotaram: o próximo "outras" pede reformulação
  // em vez de repetir "essas são todas" (27/08 S4).
  exhausted?: boolean;
  // "qualquer um, escolhe vc": a Lia auto-escolhe o topo do ranking (28/08 S6).
  autoPick?: boolean;
  // Nenhum candidato cumpria tudo o que o cliente pediu (tamanho, sabor…): estas opções são o
  // MAIS PRÓXIMO, do tipo certo, e `closestFalta` diz a diferença ("é de 500 ml"). Nunca
  // entram na cesta sem o cliente escolher (sem autoPick, sem modo lista, fora do plano B).
  closestFalta?: string;
  // O cliente pediu o mais barato desse item: as opções vêm do mais barato ao mais caro e o
  // cabeçalho diz isso (preferência explícita de preço, 07/10).
  cheapestFirst?: boolean;
  // Escolha montada por uma recomendação (08/10): "outras"/"mais barato"/refino seguem a recomendação
  // (próximas prateleiras, re-julgamento, re-plano) em vez de paginar variantes de uma busca.
  recommendation?: RecommendationState;
};

// not_found = nenhuma loja tem; unbuyable = existe, mas nenhuma entrega no CEP. ("mais perto" e
// "proibido" não entram: o primeiro é uma vaga do Flow, o segundo não se procura de novo.)
export type ListMissReason = "not_found" | "unbuyable";
export type ListMiss = { query: string; qty: number; reason: ListMissReason; at: number; retried?: boolean };

export type ListFlowCtxSlot = {
  lineKey: string;
  query: string;
  qty: number;
  // Só os produtos oferecidos (sem "skip"), na ordem enviada; é contra isto que a resposta é validada.
  skus: string[];
  suggestedSku: string | null;
  // As opções por trás dos skus: trocar a cesta depois não precisa de nova busca.
  options: ChoiceOption[];
  // Opções aprovadas que não couberam nas 4 da tela: o "Nenhuma — ver outras" começa por elas.
  extraOptions?: ChoiceOption[];
  closestFalta?: string;
};
export type ListFlowCtx = { id: string; sentAt: number; basketSig: string; slots: ListFlowCtxSlot[] };

export type DeliveryContext = {
  flow?: "delivery";
  step?:
    | "collecting"
    | "need_cep"
    | "need_address"
    // Perfil do WhatsApp sem nome, ou entrega para outra pessoa: a loja precisa do
    // nome de quem recebe (11/09).
    | "need_recipient_name"
    // Remédio isento (29/09): a compra na farmácia sai no CPF do cliente — pede nome
    // completo + CPF uma vez, antes de cotar.
    | "need_cpf"
    | "choosing"
    | "choosing_freight"
    | "awaiting_operator_quote"
    | "awaiting_supplier_validation"
    | "awaiting_quote_confirmation"
    | "payment_issuing"
    | "awaiting_payment"
    | "awaiting_merge_decision"
    | "awaiting_plan_b";
  basket?: BasketItem[];
  // Nome de quem recebe este pedido quando difere do perfil do WhatsApp (11/09).
  recipientName?: string;
  // CPF ou nome recebidos em mensagens separadas enquanto `need_cpf` (29/09). Some assim
  // que os dois vão para o User.
  cpfDraft?: { cpf?: string; name?: string };
  // 05/10 (dono): nome + CPF pedidos no CADASTRO, logo depois do endereço. Neste modo a
  // resposta sem CPF não trava nada: segue como mensagem normal.
  cpfOnboarding?: boolean;
  // Pedido não-pago parado + item novo pedido do nada (01/09): a Lia pergunta "juntar
  // ou pedido novo?" e guarda aqui o pedido antigo e o texto do item até a resposta.
  mergeDecision?: { orderId: string; request: string; total: number };
  // Quando a cobrança do pedido atual foi emitida (epoch ms). É o relógio de "cobrança
  // fresca" da fusão de item novo — não o updatedAt do pedido, que qualquer nota
  // (reclamação, atendimento humano, troca de método) renova (revisão 01/09).
  paymentIssuedAt?: number;
  pending?: PendingChoice[];
  // Quando a escolha pendente atual nasceu (writeCtx carimba). Validade ABSOLUTA: uma lista
  // de opções de dias atrás nunca é reenviada (caso real 15/09: "relógio" de 09/09 voltou
  // no lugar da ração, porque "ops" do dono renovava o relógio de inatividade sem tocar no
  // contexto).
  pendingSince?: number;
  // Cotação instantânea PARADA esperando o cliente escolher a entrega (barata/lenta ×
  // rápida/cara do anúncio). Nada é cobrado antes do toque; os dois totais já estão
  // calculados, então a resposta publica a cotação na hora.
  freightChoice?: {
    orderId: string;
    itemsSubtotal: number;
    // Margem exata por item (faixas progressivas) — botões e publicação usam o MESMO
    // número, consistente com os preços dos cards.
    serviceFee?: number;
    // Quando o frete/data foram consultados no anúncio (epoch ms). É o que permite
    // recusar um toque de botão feito dias depois, com promessa de entrega já vencida.
    quotedAt?: number;
    stores: number;
    // "ml": estimate é data do anúncio ("chega até sáb."); "store": SLA da loja ("60m" →
    // "prazo da loja: 60 min"). Sem kind = ml (contextos antigos).
    kind?: "ml" | "store";
    // Limite do cliente para o TOTAL: a opção que passa dele sai marcada (rodada 2, 07/10).
    budgetCap?: number;
    barato: { fee: number; estimate?: string };
    rapido: { fee: number; estimate?: string; name?: string };
  };
  storeKey?: string;
  notFound?: string[];
  // MODO ATENDIMENTO (07/10, placar c13/c30/c31): o dono já foi avisado (atendente, reclamação,
  // pedido sumido, CNPJ/nota). Enquanto vale, mensagem que não é pedido de produto ("vou esperar",
  // "e aí?") recebe uma confirmação CURTA e DIFERENTE da anterior, sem pedir endereço nem produto;
  // pedido de produto sai do modo e segue o fluxo normal. Substitui `humanAskedAt` e o Map
  // `noOrderAskedAt` (memória do processo, perdida a cada deploy).
  attendance?: {
    kind: "human" | "complaint" | "order_missing" | "invoice";
    // Quando o modo começou / quando o dono foi avisado pela última vez (epoch ms).
    since: number;
    notifiedAt: number;
    // Confirmações curtas já enviadas depois da 1ª (escolhe a variação seguinte).
    acks: number;
  };
  // Último pedido que NENHUMA loja tinha (07/10, placar c28/c40): "tenta de novo" e "pode ser
  // uma Wilson" falam dele. `retried` = já refizemos a busca uma vez; a 2ª vez é resposta honesta.
  lastMiss?: { query: string; qty: number; at: number; retried?: boolean };
  // Faltantes de uma lista (07/10, Etapa 3): cada linha sem produto termina num status (ListMissReason)
  // e fica aqui por 20 min — "tenta de novo" refaz todas; resposta curta casa com a mais parecida.
  // Substitui `lastMiss` (que só guardava UM pedido); contextos antigos com `lastMiss` seguem lidos.
  listMisses?: ListMiss[];
  // Flow "Escolher minha lista" enviado (LIA_LIST_FLOW). `id` é o flow_token: a resposta só vale se
  // o id bate e a cesta continua como estava (`basketSig`); qualquer edição por texto invalida.
  listFlow?: ListFlowCtx;
  // A cesta nasceu de uma LISTA mandada numa mensagem só (09/10, rodada 1): a dica de frete não pode
  // mandar o cliente "mandar a lista inteira numa mensagem só" — ele já mandou.
  listInOneMessage?: boolean;
  // Orçamento declarado na linha ("presente até R$100", "uns 80 reais") vale para o TOTAL com entrega
  // (07/10, c23/c24). `sku` = a escolha que o teto cobre (só vale com ela sozinha na cesta);
  // `warned` = já avisamos que estourou (a 2ª vez pergunta em vez de repetir a lista);
  // `awaiting` = nada cabe e a Lia espera "pode"/"não"; `override` = o cliente aceitou passar.
  budget?: { cap: number; sku: string; warned?: boolean; awaiting?: boolean; override?: boolean };
  // Embalagem diferente da pedida (07/10, c28: "12 ovos" → caixa de 20): a Lia pergunta ANTES de pôr
  // na cesta. Guarda a opção e a quantidade pedida; "sim" confirma, "outras" volta às opções.
  packConfirm?: { sku: string; askedQty: number };
  // Últimas falas da Lia (07/10, rodada 2 do plano 100): base da guarda anti-repetição — a mesma
  // mensagem não sai duas vezes seguidas para falas diferentes do cliente (src/lib/dialogue/repeat.ts).
  lastSent?: { texts: string[]; at: number };
  // Orçamento dito ANTES do cadastro, sem produto ainda ("tenho uns 120 reais"): vale para o 1º pedido.
  preBudget?: number;
  // Última recusa de remédio (07/10, c35): a 2ª em pouco tempo troca de texto em vez de repetir.
  medicineRefusedAt?: number;
  // Oferta pendente de busca na cauda longa (Mercado Livre) para as linhas que as
  // vitrines locais não cobriram (revisão 02/09). "sim" dispara a busca; "não" limpa.
  // Item que depende de especificação não dita (09/10, g7): fila de perguntas ("capa de celular" → modelo?). A resposta
  // curta do cliente volta para a busca do item; vale 30 min.
  specAsk?: { asks: Array<{ kind: SpecKind; query: string; qty: number; qtyExplicit?: boolean }>; askedAt: number };
  longTailOffer?: { lines: Array<{ phrase: string; qty: number; qtyExplicit?: boolean; cap?: number; raw?: string }> };
  // Plano B (04/09): pedido PAGO travou na loja; substituto verificado ao vivo oferecido
  // com botões "Trocar"/"Devolver o dinheiro". Vive até a resposta ou o estorno automático.
  planB?: { orderId: string; substitutes: Array<{ fromSku: string; fromName: string; fromStore: string; qty: number; to: ChoiceOption }>; offeredAt: string };
  // Proposta viva de troca de loja pro pedido mínimo (24/08): itens da loja travada +
  // substitutos de loja sem mínimo. Validada contra a cesta na hora do aceite.
  minSwap?: {
    fromStoreKey: string;
    replacements: { fromSku: string; qty: number; option: ChoiceOption }[];
  };
  // Última escolha CONCLUÍDA (com o sku escolhido): "Outras opções"/"mais barato" fora
  // da escolha reabrem ela — o toque num card antigo não pode cair no "me diz de outro
  // jeito" (teste real 19/08).
  lastChoice?: PendingChoice & { chosenSku: string };
  // Pedido em texto cru aguardando o CEP do onboarding — vira busca COM OPÇÕES depois.
  pendingRequest?: string;
  // Pedido de RECOMENDAÇÃO guardado até o CEP (08/10), inteiro ("tô com muita fome, quero algo doce"):
  // o `pendingRequest` separa por ", " e só guarda o que parece produto. Depois do CEP vira recomendação.
  pendingRecommend?: string;
  // Complemento no fechamento (08/10, recomendação fase 4): no "só isso", UMA oferta do que costuma ir
  // junto ("quem leva carvão costuma levar pão de alho"). `complementOffer` = a oferta na mesa (sim → entra
  // na cesta e segue pro total; não/"só isso" → total sem insistir); `complementAsked` = já perguntou NESTE
  // pedido (skus da cesta na hora: cesta sem nenhum deles = pedido novo, pode perguntar de novo);
  // `complementDeclined` = consultas/prateleiras recusadas nesta conversa (nunca oferece de novo).
  complementOffer?: { option: ChoiceOption; query: string; shelfId: string; why: string; trigger: string; logId?: string; at: number };
  complementAsked?: { skus: string[]; at: number };
  // Número solto já usado como ajuste de quantidade deste item (09/10, rodada 2): o segundo "1" não reescreve de novo.
  bareQtyUsed?: string;
  complementDeclined?: string[];
  cep?: string;
  city?: string;
  uf?: string;
  deliveryAddress?: string;
  // ViaCEP only identifies the street/area; a courier needs the customer's actual
  // destination. This flips true only after the customer confirms a full address.
  deliveryAddressVerified?: boolean;
  storeUnitId?: string;
  storeUnitLabel?: string;
  storeUnitAddress?: string;
  storeUnitDistanceKm?: number;
  deliveryFee?: number;
  etaMinutes?: number;
  courierQuoteId?: string;
  courierKey?: string;
  serviceFee?: number;
  itemsSubtotal?: number;
  total?: number;
  fulfillments?: StoreFulfillment[];
  deliveryOrderId?: string;
  // Cliente sinalizou que quer receber HOJE/agora ("urgente", "pra hoje"). Vira a tag
  // "⚡ URGENTE" no pedido do /ops — o operador escolhe o canal por isso na cotação.
  urgent?: boolean;
  // Último pedido cancelado NESTA conversa: "cadê meu pedido?" logo depois de um
  // cancelamento fala primeiro dele — sem isso, o fallback achava um pedido pago de
  // dias atrás e o cliente entendia que o cancelado tinha "virado pago" (27/08 S17).
  lastCanceledOrderId?: string;
  // Pergunta do motivo do cancelamento em aberto (06/10): o próximo toque/número responde.
  cancelReason?: { orderId: string; askedAt: number };
  // Desistência de pedido PAGO esperando o "sim" (06/10): só o sim estorna; vale 30 min.
  withdrawConfirm?: { orderId: string; askedAt: number };
  // "cancela" ambíguo com vários itens em escolha (09/10, rodada 1): a Lia pergunta se é a cesta toda; vale 30 min.
  clearAllConfirm?: { askedAt: number };
  // Ensaio da compra recusou a cobrança desta loja/cesta (08/10 noite): a 1ª recusa recota na hora; a 2ª
  // da MESMA loja com os mesmos itens tira a loja do caminho e busca alternativas — nunca fica em loop
  // "cota → recusa → cota" e nunca cobra.
  rehearsalRefused?: { storeKey: string; skus: string[]; count: number; at: number };
  // Uma loja por pedido (08/10 noite): cesta (skus×qtd) que já tentou juntar numa loja só — não busca de novo.
  consolidationTried?: string;
  // Oferta de juntar a cesta numa loja só (09/10, dono: "oferecer, não impor"): a cesta juntada fica
  // guardada até o cliente escolher (botão consolidar:sim / consolidar:nao). `key` = a cesta de quando a
  // oferta saiu; cesta mudou → a oferta morre.
  consolidationOffer?: { key: string; basket: BasketItem[]; storeLabel: string; stores: number; pairs: Array<{ fromName: string; fromPrice: number; toName: string; toPrice: number }>; delta: number };
  // "o de sempre" restaurou a cesta antiga e está esperando o "sim" de conferência
  // antes de fechar o total (27/08 S16).
  repeatConfirm?: boolean;
  // Cadastro/endereço em texto (06/10, relatório do testador):
  // rua e bairro que o ViaCEP deu para o CEP — com eles, "1500" ou "221 apto 13" bastam.
  cepPlace?: { street?: string; district?: string };
  // Cliente com endereço confirmado mandou um CEP solto: a troca espera o "sim".
  cepSwap?: { cep: string; askedAt: number; items?: string };
  // O CEP é de outra cidade que a escrita no endereço: nada salvo até confirmar.
  cepCityCheck?: { cep: string; raw: string; askedAt: number; via: "cep" | "address" };
  // Cesta/cotação que venceu por inatividade (09/10, rodada 1): quem volta horas depois é avisado e retoma com "sim".
  expiredCart?: { items: string[]; at: number; quote?: boolean };
  // Endereço de antes de uma troca, para "deixa o antigo"/"usa o de antes".
  previousAddress?: { cep: string; address: string; city?: string; uf?: string };
  // Último CEP recusado por estar fora da área: a mensagem seguinte lembra o motivo.
  outsideArea?: { city?: string };
};

export const ACTIVE_ORDER_STATUSES = ACTIVE_DELIVERY_ORDER_STATUSES;

// Pedidos que "cancelar" pode mirar por FALLBACK (sem referência explícita nem vínculo
// com a conversa): só os que ainda não têm dinheiro do cliente. Pedido PAGO nunca é
// alvo implícito — teste de 26/08: o "cancelar" de encerramento acertava o pedido pago
// real do operador e respondia "depois do pagamento não dá", confundindo tudo.
export const CANCELABLE_FALLBACK_STATUSES = [
  "awaiting_operator_quote",
  "awaiting_supplier_validation",
  "awaiting_quote_confirmation",
  "payment_issuing",
  "awaiting_payment"
];

// ---------- helpers: conversation + money + text ----------

// prescriptionDropped: nomes dos remédios de receita que saíram da lista (dono, 08/10: a recusa nomeia o item).
export type ExtractedLines = { lines: ParsedLine[]; greetingOnly: boolean; containsMedicine: boolean; containsTobacco: boolean; prescriptionDropped: string[] };

export type ChoicesResult = {
  store: StoreConnector;
  autoAdded: BasketItem[];
  pending: PendingChoice[];
  notFound: string[];
  // As mesmas linhas de `notFound`, mas com a quantidade preservada. O concierge precisa
  // disso para transformar "2 pães de forma" numa linha livre com qty=2 em vez de perder o
  // número no caminho (o fluxo legado só mostra os nomes, por isso `notFound` é string[]).
  notFoundLines: ParsedLine[];
  // Todas as linhas extraídas (com `raw`, a frase completa do cliente quando a IA
  // encurtou) — o resgate no ML busca pela frase completa mesmo em linha "fraca".
  lines: ParsedLine[];
  // As opções já passaram pelo julgamento semântico da IA (rerank). Quando true, o piso
  // léxico do concierge NÃO deve rodar por cima: a IA entende sinônimos que o piso mata
  // ("escova de dente" ≈ "Escova Dental") e já descartou o que não serve.
  reranked: boolean;
  greetingOnly: boolean;
  containsMedicine: boolean;
  prescriptionDropped: string[];
  containsTobacco: boolean;
  // 06/10: linhas (frase já normalizada pelo split do teto) que TINHAM produto nas lojas,
  // mas nenhuma loja confirmou ao vivo para o CEP — o cliente ouve "não consigo comprar
  // agora", não "não achei".
  unconfirmed?: string[];
  // 09/10 (g7): linhas que dependem de especificação não dita; só vêm quando o chamador pede (`askSpecs`).
  specAsks?: SpecAsk[];
};

// The store an in-progress order belongs to (picked when the basket was built).
export function orderStore(ctx: DeliveryContext): StoreConnector {
  return getStore(ctx.storeKey ?? ctx.basket?.[0]?.storeKey ?? DEFAULT_STORE_KEY);
}

// "Ver detalhes" para TODAS as lojas (dono, 01/09): quem tem página própria usa ela;
// item de catálogo raspado SEM url por item (Carrefour, Petz) ganha o link de BUSCA
// da loja com o nome do produto — não é a página exata, mas abre o produto na loja
// real com foto/reviews a um clique.
export const STORE_SEARCH_URL: Record<string, (name: string) => string> = {
  carrefour: (name) => `https://mercado.carrefour.com.br/s?q=${encodeURIComponent(name)}`,
  petz: (name) => `https://www.petz.com.br/busca?q=${encodeURIComponent(name)}`
};

// Apply a chosen courier quote to the context (fee/eta/key/quoteId + recompute total).
export function basketForCopy(ctx: DeliveryContext): copy.CopyBasketItem[] {
  return (ctx.basket ?? []).map((item) => ({
    qty: item.qty,
    name: item.name,
    displayLineTotal: Math.round(display(item.unitPrice, item.medicine) * item.qty * 100) / 100
  }));
}

// After quoting: show the minimum-order nudge, the frete choice (barato/rápido), or the
// order summary — whichever applies. `prefix` is prepended (e.g. "Endereço salvo").
// Minimum order is a PER-STORE rule (in real R$ of
// products), declared on the StoreConnector — NOT a global Lia rule. A store with no
// minimum sets 0 and this never triggers. min is on the real cost (what we pay the
// store); the customer is shown the marked-up equivalent.
export function storeMinReal(store: StoreConnector): number {
  return store.minOrder ?? 0;
}

// Lojas da cesta (concierge = cesta mista) cujo subtotal está abaixo do mínimo DELAS.
// Linha do próprio concierge não tem loja real, então não tem mínimo — e `getStore` cai
// no default quando a chave é desconhecida, o que faria a Lia cobrar o mínimo do
// Carrefour por engano.
export function conciergeStoresBelowMinimum(ctx: DeliveryContext): StoreConnector[] {
  return [...new Set((ctx.basket ?? []).map((item) => item.storeKey))]
    .filter((key): key is string => Boolean(key) && key !== CONCIERGE_STORE_KEY)
    .map((key) => getStore(key))
    .filter((store) => belowMinimum(ctx, store));
}

export function belowMinimum(ctx: DeliveryContext, store: StoreConnector): boolean {
  const min = storeMinReal(store);
  const subtotal = (ctx.basket ?? []).filter((item) => item.storeKey === store.key).reduce((sum, item) => sum + item.lineTotal, 0);
  return min > 0 && subtotal < min;
}

// "de ontem" / "de sábado" / "de 23/08" — âncora temporal pra qualquer pedido que não
// seja de hoje. Sem ela, um pedido pago antigo aparecia como se fosse o atual (27/08).
export function orderDateLabel(createdAt: Date): string | undefined {
  const tz = "America/Sao_Paulo";
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = dayFmt.format(new Date());
  const that = dayFmt.format(createdAt);
  if (that === today) return undefined;
  const diffDays = Math.round((Date.parse(today) - Date.parse(that)) / 86_400_000);
  if (diffDays === 1) return "de ontem";
  if (diffDays > 1 && diffDays < 7) {
    const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" }).format(createdAt);
    return `de ${weekday.replace("-feira", "")}`;
  }
  const dm = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(createdAt);
  return `de ${dm}`;
}

// "1x Escova de Dente Colgate…, +2" — o conteúdo do pedido citado, curto.
export function orderItemsPreview(itemsJson: unknown): string | undefined {
  if (!Array.isArray(itemsJson) || !itemsJson.length) return undefined;
  const items = itemsJson as { qty?: number; name?: string }[];
  const parts = items.slice(0, 2).map((i) => {
    const name = (i.name ?? "item").trim();
    return `${i.qty ?? 1}x ${name.length > 40 ? `${name.slice(0, 38)}…` : name}`;
  });
  const extra = items.length - 2;
  return parts.join(", ") + (extra > 0 ? ` +${extra}` : "");
}

// A pergunta da entrega com BOTÃO (dono, 17/08). Os totais mostrados são o que o cliente
// vai pagar de verdade: produtos com markup + o frete de cada opção.
export type FreightChoiceState = NonNullable<DeliveryContext["freightChoice"]>;

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function quoteTtlMinutes(): number {
  const configured = Number(process.env.LIA_RETAILER_QUOTE_TTL_MINUTES ?? 5);
  return Number.isFinite(configured) ? Math.max(1, Math.min(15, Math.floor(configured))) : 5;
}
