// Tipos e contas puras da conversa (revisão 02/09): extraídos de delivery-service.ts.
// Sem I/O — só tipos, constantes e funções de dinheiro/rótulo compartilhadas.
import { ParsedLine } from "@/lib/lia-intents";
import { ACTIVE_DELIVERY_ORDER_STATUSES, CONCIERGE_STORE_KEY } from "@/lib/order-flags";
import { displayPrice } from "@/lib/pricing";
import { DEFAULT_STORE_KEY, StoreConnector, getStore } from "@/lib/stores";
import * as copy from "@/lib/lia-copy";

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
};

// `verified`/`etaMinutes`/`delivery` (03/09): vêm da simulação AO VIVO no site da loja para
// o CEP do cliente — a única fonte que pode pôr prazo num card.
// `repeat` (04/09): o cliente já comprou este produto — vem primeiro e com destaque.
export type ChoiceOption = { sku: string; freightFee?: number; name: string; brand?: string; unitPrice: number; imageUrl?: string; productUrl?: string; storeKey?: string; storeLabel?: string; delivery?: string; freeShipping?: boolean; verified?: boolean; etaMinutes?: number; repeat?: boolean; medicine?: "mip" };

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
  // Escolha REABERTA ("Outras opções" depois de já ter escolhido): o novo pick
  // SUBSTITUI esta linha da cesta em vez de somar uma segunda mochila.
  replaceSku?: string;
  // O pool + a re-busca relaxada já esgotaram: o próximo "outras" pede reformulação
  // em vez de repetir "essas são todas" (27/08 S4).
  exhausted?: boolean;
  // "qualquer um, escolhe vc": a Lia auto-escolhe o topo do ranking (28/08 S6).
  autoPick?: boolean;
};

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
    barato: { fee: number; estimate?: string };
    rapido: { fee: number; estimate?: string; name?: string };
  };
  storeKey?: string;
  notFound?: string[];
  // Oferta pendente de busca na cauda longa (Mercado Livre) para as linhas que as
  // vitrines locais não cobriram (revisão 02/09). "sim" dispara a busca; "não" limpa.
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
  // "o de sempre" restaurou a cesta antiga e está esperando o "sim" de conferência
  // antes de fechar o total (27/08 S16).
  repeatConfirm?: boolean;
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

export type ExtractedLines = { lines: ParsedLine[]; greetingOnly: boolean; containsMedicine: boolean; containsTobacco: boolean };

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
  containsTobacco: boolean;
  // 06/10: linhas (frase já normalizada pelo split do teto) que TINHAM produto nas lojas,
  // mas nenhuma loja confirmou ao vivo para o CEP — o cliente ouve "não consigo comprar
  // agora", não "não achei".
  unconfirmed?: string[];
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
