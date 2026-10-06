import { displayPrice, serviceFeeForItems } from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import { carouselEnabled, whatsappAdapter } from "@/lib/adapters/whatsapp";
import { getStore, pickStoreForQueries, gatherCrossStoreCandidates, prefetchLongTailIfNeeded, longTailOptInEnabled, type StoreCandidate, type StoreConnector } from "@/lib/stores";
import { mercadoLivreEnabled, prefetchMercadoLivre, searchMercadoLivre } from "@/lib/stores/mercadolivre";
import { mlItemIdFrom } from "@/lib/ml-freight";
import { composeBasket } from "@/lib/basket-composer";
import { attrMatchesItem, conciergeMatchIsStrong, diversifyOptions, inferCatalogRefinement, queryTokens, sameProductVariant, scoreCatalogMatch } from "@/lib/stores/types";
import { paymentsAreMocked, pixAdapter } from "@/lib/payments/mercadopago";

import { cardOnFileEnabled, expireOpenPaymentAttempts, findPendingSavedCardAttempt, listOneClickCredentials } from "@/lib/payments/whatsapp-pay";

import { extractShoppingList, rerankShoppingOptions, interpretCustomerMessage } from "@/lib/adapters/ai";
import { computeStoreFreights, freightBreakdownLabel, instantQuoteEligible, PER_AD_FREIGHT_STORES, storeFreight, type InstantQuoteItem } from "@/lib/instant-quote";
import { humanEstimate, liveFreightEnabled, liveStoreFreight, type LiveItemCheck, slowestEstimate } from "@/lib/live-freight";
import { buyableWithoutOperator, checkCandidatesLive, liveConfirmationRequired, liveKey } from "@/lib/live-availability";
import { mlBasketFreight } from "@/lib/ml-freight";
import { detectIntent, extractCep, parseAddressComplement, parseAttributeAsk, parseOnlyKeep, withAddressComplement, isDemonstrativeOnly, isQuestion, asksRunningTotal, looksLikeMedicine, hasUrgencySignal, isNarrativeSegment, isRequestModifier, sharesProductNoun, stripMedicineNegation, narrowChoiceByName, normalizeMsg, parseBasketLines, parsePriceCap, splitPriceCap, mergeShoppingLines, parseChoiceReply, splitCommandClauses, stripListNumbering, parseRefinement, wantsMoreOptions, looksLikeTobacco, looksLikeSymptomAsk, parseCancelReason, type Intent, type ParsedLine } from "@/lib/lia-intents";
import { AWAITING_OPERATOR_QUOTE_STATUS, CONCIERGE_STORE_KEY, CONCIERGE_STORE_LABEL, PAID_OR_IN_FULFILLMENT_STATUSES, REPEATABLE_DELIVERY_ORDER_STATUSES, appendOrderNote, isCardCharge, isOrderOutForDelivery } from "@/lib/order-flags";
import { automaticPurchaseStores } from "@/lib/purchase-policy";
import { extractCpf, extractFullName, hasMip, isMipItem, looksLikeCpfAttempt, looksLikeMedicineName, looksLikePrescriptionRequest, maskCpf, medicineEnabled } from "@/lib/medicine";
import { isServedState, servedAreaLabel } from "@/lib/coverage";
import { currentShopperCep, noteShopperCep, storeServesCep } from "@/lib/store-areas";
import { SIGNUP_FORM_MESSAGE, buildSignupAddress, isSignupFormReply, parseSignupForm } from "@/lib/signup-form";
import { CEP_RE_GLOBAL } from "@/lib/lia-intents";
import { isKeepOldAddress, isKeepOldAddressExplicit, looksLikePersonName, mentionsStreetWithoutNumber, onboardingNote, parseHouseNumberReply, parsePriceAsk, saysNoCep, splitAddressAndItems, typedCityMismatch } from "@/lib/address-parse";
import * as copy from "@/lib/lia-copy";
import { latestAcquisitionTouchId, mergeAcquisition, recordAcquisitionTouch, stripAcquisitionTag, type InboundAcquisition } from "@/lib/acquisition";

// The operational brain of the remodelled Lia. One conversation = one basket of
// everyday items, fulfilled by a pluggable store. Retailer delivery is the default;
// pickup + courier remains only for formally-authorized partners. This module owns
// the WhatsApp conversation state machine AND the order lifecycle the operator
// dashboard drives. Intent detection lives in lia-intents (pure, unit-tested) and
// every customer-facing string lives in lia-copy.
import { ACTIVE_ORDER_STATUSES, BasketItem, CANCELABLE_FALLBACK_STATUSES, ChoiceOption, ChoicesResult, DeliveryContext, ExtractedLines, PendingChoice, STORE_SEARCH_URL, basketForCopy, cardTotal, conciergeStoresBelowMinimum, display, orderDateLabel, orderItemsPreview, orderStore, roundMoney, storeMinReal } from "./conversation-types";
import { createOpsLoginToken, opsLoginUrl } from "./auth";
import { derivedMessageLabel, understandMedia, type InboundMedia } from "./media-understanding";
import { TurnSupersededError, acquireTurnLock, addressOnlyCtx, getOrCreateConvo, isFreightChoicePayload, lastActivityAt, markTurnReplied, normalizePhone, notifyOperator, quoteAbandonTtlMs, readCtx, releaseTurnLock, rememberCtxSnapshot, reply, replyQuoteNotice, searchNoticeTimer, sleep, turnMeta, writeCtx, isAdminPhone, notifyOwner, phoneRole } from "./turn-runtime";
import { cancelPendingRetailerQuote, closeUnpaidOrder, createCardAttempt, flagLatestOrder, handleSavedCardOther, handleSavedCardPay, issueValidatedRetailerQuotePayment, markDeliveryOrderPaid, markPixExpired, methodFromIntent, reopenOrderForEdit, resendCharge, switchPaymentMethod } from "./order-payments";
import { opsPublishManualQuote, recordWaitlistLead, sendFreightChoice } from "./ops-lifecycle";

// Fachada pública (rotas, testes e módulos de pagamento importam daqui).
export { runTurnScoped, TurnSupersededError, normalizePhone } from "./turn-runtime";
export { markDeliveryOrderPaid, issueValidatedRetailerQuotePayment, markPixExpired, flagCardOutcomeUnknown } from "./order-payments";
export type { PaymentEvidence } from "./order-payments";
export { opsRefundViaProvider, opsPurchaseFailedRefund, watchPaidOrder, opsPublishManualQuote, opsMarkBought, opsSetStoreCost, opsMarkRetailerOutForDelivery, opsMarkDelivered, opsCancelRefund, opsConfirmRefund, opsNotifyCustomer, opsSetRecipient, getOperatorQueue, recordWaitlistLead, getWaitlist } from "./ops-lifecycle";

// Costura de TESTE do CAS: os E2E provam que uma escrita de turno velho morre depois
// de outra escrita (cancelar) — sem exportar nada disso pro fluxo normal.
export const __casTestSeams = { writeCtx, rememberCtxSnapshot };

// Início do turno por telefone: o orçamento do resgate de última chance mede daqui.
export const turnStartedAt = new Map<string, number>();

// "óleo" numa lista de MERCADO é óleo de cozinha — a busca nua trazia óleo corporal/
// mineral (28/08 S1/S15, 3ª rodada seguida). Reescreve pra variante básica quando o
// contexto é de despensa.
const GROCERY_STAPLES = new Set([
  "arroz", "feijao", "cafe", "leite", "acucar", "macarrao", "sal", "farinha", "molho",
  "pao", "banana", "sabao", "detergente", "refrigerante", "coca", "manteiga", "ovos", "ovo"
]);

// Marca usada como nome GENÉRICO do produto ("bombril", "gilete", "maisena"): a busca
// literal achava outra coisa ou nada (29/08 S11 — gilete "não achei", bombril virou
// esponja). Reescrita só quando a linha é a marca sozinha.
const BRAND_GENERIC: Record<string, string> = {
  bombril: "palha de aço",
  gilete: "aparelho de barbear",
  giletes: "aparelho de barbear",
  gillette: "aparelho de barbear gillette",
  maisena: "maizena amido de milho",
  danone: "iogurte",
  durex: "fita adesiva durex"
};

function rewriteGroceryOil(lines: ParsedLine[]): ParsedLine[] {
  const staples = lines.filter((l) => queryTokens(l.phrase).some((t) => GROCERY_STAPLES.has(t))).length;
  return lines.map((l) => {
    const tokens = queryTokens(l.phrase);
    if (tokens.length === 1 && BRAND_GENERIC[tokens[0]]) {
      return { ...l, phrase: BRAND_GENERIC[tokens[0]] };
    }
    if (staples >= 2 && tokens.length === 1 && tokens[0] === "oleo") {
      return { ...l, phrase: l.phrase.replace(/\boleo\b/i, "óleo de soja") };
    }
    return l;
  });
}

// Remédio (29/09): com LIA_MEDICINE_MIP=true só o remédio de RECEITA é barrado — o isento
// segue como pedido normal e só existe nas vitrines das farmácias (catálogo MIP). Desligado,
// qualquer remédio é barrado, como sempre foi.
function blocksMedicine(text: string): boolean {
  return medicineEnabled() ? looksLikePrescriptionRequest(text) : looksLikeMedicine(text);
}
function noMedicineCopy(): string {
  return medicineEnabled() ? copy.prescriptionRefusal() : copy.noMedicine();
}
function medicineSkippedCopy(): string {
  return medicineEnabled() ? copy.prescriptionSkippedNote() : copy.medicineSkippedNote();
}

// Clean the request into a shopping list. The LLM handles greetings, synonyms
// ("pasta de dente"->creme dental), medicines and quantities; the deterministic
// splitter + medicine word-list covers OpenAI-off and OpenAI-error, so a remédio
// never slips through as a plain search.
async function extractLines(text: string): Promise<ExtractedLines> {
  // "sem remédio"/"não quero remédio" é negação: sai da mensagem ANTES de qualquer
  // detecção — senão a Lia avisa que removeu um medicamento que ninguém pediu
  // (rodadas 4 e 14 dos testes reais de 14/08).
  const sanitized = stripMedicineNegation(text);
  const containsTobacco = looksLikeTobacco(sanitized);
  // Frase já reescrita pelo roteador da IA neste turno: é uma busca limpa, o parser
  // determinístico dá conta e a 2ª chamada de IA só somava até 10 s (06/10).
  const routed = turnMeta.getStore()?.routerQuery;
  const extraction = routed && normalizeMsg(routed) === normalizeMsg(text) ? null : await extractShoppingList(sanitized);
  const deterministic = parseBasketLines(sanitized)
    .filter((line) => queryTokens(line.phrase).length)
    .filter((line) => !blocksMedicine(line.phrase))
    .filter((line) => !looksLikeTobacco(line.phrase));
  if (extraction) {
    // A IA às vezes devolve contexto como item ("Para uma viagem") — o mesmo filtro de
    // modificador do parser determinístico vale pra ela (6º ciclo, rodada 1).
    const items = extraction.items.filter(
      (item) => !blocksMedicine(item.query) && !looksLikeTobacco(item.query) && !isRequestModifier(item.query)
    );
    // Remédio isento ligado (05/10): a IA às vezes marca containsMedicine para um isento que
    // ELA MESMA manteve na lista ("quero advil" → Advil na lista + aviso "remédio de receita
    // deixei de fora"). Só vale o aviso se algum pedido da mensagem ficou de fora de verdade.
    const kept = [...items.map((item) => item.query), ...deterministic.map((line) => line.phrase)];
    const llmDroppedSomething =
      !medicineEnabled() ||
      parseBasketLines(sanitized)
        .filter((line) => queryTokens(line.phrase).length && !looksLikeTobacco(line.phrase))
        .some((line) => !kept.some((query) => queryTokens(query).some((token) => queryTokens(line.phrase).includes(token))));
    return {
      lines: rewriteGroceryOil(mergeShoppingLines(items.map((item) => ({ phrase: item.query, qty: item.qty })), deterministic)),
      greetingOnly: extraction.greetingOnly,
      containsMedicine: (extraction.containsMedicine && llmDroppedSomething) || blocksMedicine(sanitized),
      containsTobacco
    };
  }
  const raw = parseBasketLines(sanitized).filter((line) => queryTokens(line.phrase).length);
  const safe = deterministic;
  return {
    lines: rewriteGroceryOil(safe),
    greetingOnly: false,
    containsMedicine: safe.length < raw.length - (containsTobacco ? 1 : 0) || blocksMedicine(sanitized),
    containsTobacco
  };
}

// Like buildBasket, but instead of auto-picking the top match it returns up to 3
// OPTIONS per item so the customer chooses (numbered list — tappable buttons need an
// approved WhatsApp Business sender).
function dedupeBasket(items: BasketItem[]): BasketItem[] {
  const out: BasketItem[] = [];
  for (const item of items) {
    const found = out.find((x) => x.sku === item.sku);
    if (found) {
      found.qty += item.qty;
      found.lineTotal = Math.round(found.unitPrice * found.qty * 100) / 100;
    } else {
      out.push(item);
    }
  }
  return out;
}

async function buildChoices(
  text: string,
  lockedStoreKey?: string,
  preferredSkus?: Map<string, number>,
  onLongTailSearch?: () => void,
  forceLongTail?: boolean,
  cep?: string | null
): Promise<ChoicesResult> {
  noteShopperCep(cep);
  // Mapa (loja:sku → verificação ao vivo) preenchido por linha e lido ao montar os cards.
  const liveChecks = new Map<string, LiveItemCheck>();
  // Enquanto a IA extrai a lista (~2-5s), o parser determinístico já sabe quais linhas
  // não têm match local forte — o run frio do ML (~21s) começa AGORA e roda em paralelo.
  // A busca de verdade lá embaixo se acopla ao mesmo run (dedupe em voo no conector).
  const crossStore = !lockedStoreKey;
  if (crossStore && !forceLongTail && mercadoLivreEnabled() && !longTailOptInEnabled()) {
    const sanitized = stripMedicineNegation(text);
    for (const line of parseBasketLines(sanitized)) {
      if (!queryTokens(line.phrase).length || blocksMedicine(line.phrase)) continue;
      void prefetchLongTailIfNeeded(splitPriceCap(line.phrase).phrase).catch(() => {});
    }
  }

  const { lines, greetingOnly, containsMedicine, containsTobacco } = await extractLines(text);
  // "Preciso pra HOJE" (dono, 04/09): quando tem urgência, a vitrine fica só com o que a
  // loja entrega em menos de 1 dia (prazo da entrega mais rápida); se ninguém entrega
  // hoje, o cabeçalho diz isso e mostra o mais rápido.
  const urgent = hasUrgencySignal(text);

  // Candidatos por linha. No concierge sem loja travada a busca é LARGA (todas as
  // vitrines): eleger uma loja única por palpite léxico escondia o item certo — no
  // empate a ordem do registry decidia, e "carregador usb c" caía na Petz (veicular)
  // com o carregador de parede USB-C parado na Pague Menos. No fluxo legado vale
  // "one order = one store", então a linha continua buscando numa loja só.
  const perLine = await Promise.all(
    lines.map(async (line) => {
      // "vinho até 40 reais": o teto NÃO é termo de busca — vira filtro sobre o
      // preço exibido (com markup), senão a lista mostra item acima do que pediram.
      const { phrase: searchPhrase, cap } = splitPriceCap(line.phrase);
      let candidates: StoreCandidate[];
      if (crossStore) {
        candidates = await gatherCrossStoreCandidates(searchPhrase, 12, 4, {
          onLongTailSearch,
          forceLongTail,
          ...(line.raw ? { longTailQuery: splitPriceCap(line.raw).phrase } : {})
        });
      } else {
        const lineStore = lockedStoreKey ? getStore(lockedStoreKey) : await pickStoreForQueries([searchPhrase]);
        candidates = (await lineStore.searchItems(searchPhrase, 12)).map((item) => ({ store: lineStore, item }));
      }
      if (cap != null) candidates = candidates.filter((c) => display(c.item.unitPrice, c.item.medicine) <= cap);
      // Tamanho/volume pedido ("30 litros", "2kg") vale para TODOS os cards, não só a
      // escolha (rodada 7, 4º ciclo: 1 das 3 opções não era de 30l). Se ao menos um
      // candidato tem o atributo, os que não têm saem da vitrine.
      const sizeAsk = searchPhrase.match(/\d+(?:[.,]\d+)?\s*(?:kg|ml|lt?s?|litros?|g(?![a-z]))\b/i)?.[0];
      if (sizeAsk) {
        const sized = candidates.filter((c) => attrMatchesItem(sizeAsk, c.item));
        if (sized.length) candidates = sized;
      }
      // Recompra: o que o cliente já escolheu antes sobe (sort estável preserva o
      // ranking de relevância entre itens sem histórico).
      candidates.sort((a, b) => (preferredSkus?.get(b.item.sku) ?? 0) - (preferredSkus?.get(a.item.sku) ?? 0));
      // Verificação AO VIVO no site de cada loja para o CEP do cliente (03/09: chá cobrado
      // sem estoque). Sem estoque/sem entrega no endereço sai daqui; confirmado ganha o
      // prazo real e vem antes do não-verificável.
      let noneToday = false;
      let unconfirmed = false;
      if (cep) {
        const wrapped = candidates.map((c) => ({ storeKey: c.store.key, sku: c.item.sku, c }));
        const live = await checkCandidatesLive(wrapped, cep);
        for (const [key, check] of live.checks) liveChecks.set(key, check);
        if (live.dropped.length) {
          console.log("[live-check:dropped]", live.dropped.map((w) => `${w.storeKey}:${w.sku}`).join(","));
        }
        candidates = live.kept.map((w) => w.c);
        // 06/10 (testers: pilha da Casa & Vídeo, fita isolante da Obramax): sem operador, opção
        // que a loja não confirmou para o CEP é beco no "pagar" (a cotação aborta). Sai da
        // vitrine; se nada foi confirmado, a linha vira "não consigo comprar agora".
        if (liveConfirmationRequired()) {
          const buyable = candidates.filter((c) => buyableWithoutOperator(c.store.key, liveChecks.get(liveKey(c.store.key, c.item.sku))));
          if (buyable.length < candidates.length) {
            console.log("[live-check:unconfirmed]", candidates.filter((c) => !buyable.includes(c)).map((c) => `${c.store.key}:${c.item.sku}`).join(","));
          }
          unconfirmed = candidates.length > 0 && buyable.length === 0;
          candidates = buyable;
        }
        if (urgent) {
          const today = candidates.filter((c) => {
            const check = liveChecks.get(liveKey(c.store.key, c.item.sku));
            return check?.available && check.fastEtaMinutes != null && check.fastEtaMinutes < sameDayMaxMinutes();
          });
          if (today.length) candidates = today;
          else noneToday = true;
        }
      }
      // O teto viaja NA LINHA: paginação, refino e o resgate do ML re-filtram por ele
      // (26/08: "até R$50/100/200" vazou nas opções — o cap morria aqui).
      return { line: { ...line, phrase: searchPhrase, ...(cap != null ? { cap } : {}) }, candidates, noneToday, unconfirmed };
    })
  );

  // UMA chamada de IA julga todas as linhas: dos candidatos, o que é realmente o
  // produto pedido, em que ordem — e lista vazia quando nada serve (a linha vira
  // livre/não-achei, que é o resultado honesto). IA off/falhou → null → ranking
  // determinístico de sempre, diversificado.
  const withCandidates = perLine.filter((entry) => entry.candidates.length);
  const rerank = withCandidates.length
    ? await rerankShoppingOptions(
        text,
        withCandidates.map((entry) => ({
          query: entry.line.phrase,
          candidates: entry.candidates.map((c) => ({
            sku: c.item.sku,
            name: c.item.name,
            brand: c.item.brand,
            price: display(c.item.unitPrice, c.item.medicine),
            store: c.store.label
          }))
        })),
        vitrineLimit()
      )
    : null;
  const rerankedSkus = new Map<(typeof perLine)[number], string[]>();
  if (rerank) withCandidates.forEach((entry, i) => rerankedSkus.set(entry, rerank.lines[i].skus));

  const autoAdded: BasketItem[] = [];
  const pending: PendingChoice[] = [];
  const notFound: string[] = [];
  const notFoundLines: ParsedLine[] = [];
  const unconfirmedLines = perLine.filter((entry) => entry.unconfirmed).map((entry) => entry.line.phrase);
  let firstStore: StoreConnector | undefined;
  for (const entry of perLine) {
    const { line, candidates, noneToday } = entry;
    const bySku = new Map(candidates.map((c) => [c.item.sku, c]));
    const chosen = rerankedSkus.get(entry);
    let options: StoreCandidate[] = chosen
      ? chosen.map((sku) => bySku.get(sku)).filter((c): c is StoreCandidate => Boolean(c))
      : diversifyOptions(line.phrase, candidates.map((c) => c.item), vitrineLimit()).map((item) => bySku.get(item.sku)!);
    if (!options.length) {
      notFound.push(line.phrase);
      notFoundLines.push(line);
      continue;
    }
    firstStore = firstStore ?? options[0].store;
    // "O de sempre" (dono, 04/09): quem já comprou um produto vê ele PRIMEIRO e com
    // destaque quando pede de novo — mesmo que a IA/diversificação não o tenha posto
    // no top-3 (só não entra se a verificação ao vivo o tirou dos candidatos).
    const repeatPick = preferredSkus?.size
      ? candidates
          .filter((c) => preferredSkus.has(c.item.sku))
          .sort((a, b) => (preferredSkus.get(b.item.sku) ?? 0) - (preferredSkus.get(a.item.sku) ?? 0))[0]
      : undefined;
    if (repeatPick && !options.some((o) => o.item.sku === repeatPick.item.sku)) options = [repeatPick, ...options];
    pending.push({
      query: line.phrase,
      qty: line.qty,
      ...(line.qtyExplicit ? { qtyExplicit: true } : {}),
      ...(line.cap != null ? { cap: line.cap } : {}),
      ...(line.autoPick ? { autoPick: true } : {}),
      ...(urgent && !noneToday && cep ? { urgent: true } : {}),
      ...(urgent && noneToday ? { noneToday: true } : {}),
      options: options
        .map(({ store, item }) => {
          const check = liveChecks.get(liveKey(store.key, item.sku));
          const option = toChoiceOption(item, { storeKey: store.key, storeLabel: store.label }, check, urgent);
          return preferredSkus?.has(item.sku) ? { ...option, repeat: true } : option;
        })
        .sort(byRepeatThenVerifiedThenEta)
        .slice(0, vitrineLimit())
    });
  }
  return {
    store: firstStore ?? getStore(lockedStoreKey),
    autoAdded: dedupeBasket(autoAdded),
    pending,
    notFound,
    notFoundLines,
    lines,
    reranked: Boolean(rerank),
    greetingOnly: greetingOnly && autoAdded.length === 0 && pending.length === 0,
    containsMedicine,
    containsTobacco,
    ...(unconfirmedLines.length ? { unconfirmed: unconfirmedLines } : {})
  };
}

async function buildChoicesWithSearchNotice(
  phone: string,
  text: string,
  lockedStoreKey?: string,
  preferredSkus?: Map<string, number>,
  forceLongTail?: boolean,
  cep?: string | null
): Promise<ChoicesResult> {
  let notice: ReturnType<typeof searchNoticeTimer> | undefined;
  return buildChoices(
    text,
    lockedStoreKey,
    preferredSkus,
    () => {
      notice ??= searchNoticeTimer(phone);
    },
    forceLongTail,
    cep
  ).finally(() => notice?.cancel());
}

// Ordem das opções (25/09, dono): confirmado pela loja antes do não-verificável; depois, o item
// que a loja aceita SOZINHO (preço ≥ pedido mínimo dela) antes do que esbarra no mínimo — item
// barato em loja de mínimo alto obriga o cliente a completar a cesta; depois o que chega ANTES;
// depois o mais barato posto na casa (produto + frete da loja para o CEP). Estável: quem empata
// em tudo mantém a ordem de relevância do rerank.
export function fitsStoreMinimum(o: Pick<ChoiceOption, "storeKey" | "unitPrice">): boolean {
  // getStore cai na loja padrão quando a chave está desligada: só vale o mínimo da PRÓPRIA loja.
  const store = o.storeKey ? getStore(o.storeKey) : undefined;
  const min = store?.key === o.storeKey ? store?.minOrder ?? 0 : 0;
  return !(min > 0) || o.unitPrice >= min;
}
export function byVerifiedThenEta(a: ChoiceOption, b: ChoiceOption): number {
  const va = a.verified ? 1 : 0;
  const vb = b.verified ? 1 : 0;
  if (va !== vb) return vb - va;
  const ma = fitsStoreMinimum(a) ? 1 : 0;
  const mb = fitsStoreMinimum(b) ? 1 : 0;
  if (ma !== mb) return mb - ma;
  const eta = (a.etaMinutes ?? Number.MAX_SAFE_INTEGER) - (b.etaMinutes ?? Number.MAX_SAFE_INTEGER);
  if (eta !== 0) return eta;
  if (a.freightFee == null || b.freightFee == null) return 0;
  return a.unitPrice + a.freightFee - (b.unitPrice + b.freightFee);
}

// Já comprado vem antes de tudo; entre iguais, confirmado ao vivo e depois o prazo.
function byRepeatThenVerifiedThenEta(a: ChoiceOption, b: ChoiceOption): number {
  const ra = a.repeat ? 1 : 0;
  const rb = b.repeat ? 1 : 0;
  if (ra !== rb) return rb - ra;
  return byVerifiedThenEta(a, b);
}

// A free-form concierge line: whatever the customer asked for, verbatim. No catalog
// price yet — the operator sets the real price at quote time. The name-based sku lets
// mergeBaskets fold duplicates ("mais 2 pães").
function conciergeItem(phrase: string, qty: number): BasketItem {
  const name = phrase.trim().replace(/\s+/g, " ");
  return {
    sku: `concierge:${normalizeMsg(name)}`,
    name,
    qty: Math.max(1, qty),
    unitPrice: 0,
    lineTotal: 0,
    storeKey: CONCIERGE_STORE_KEY,
    storeLabel: CONCIERGE_STORE_LABEL
  };
}

function choiceToBasketItem(o: ChoiceOption, qty: number, store: StoreConnector): BasketItem {
  const selectedStore = o.storeKey ? getStore(o.storeKey) : store;
  return {
    sku: o.sku,
    name: o.name,
    brand: o.brand,
    qty,
    unitPrice: o.unitPrice,
    lineTotal: Math.round(o.unitPrice * qty * 100) / 100,
    storeKey: selectedStore.key,
    storeLabel: o.storeLabel ?? selectedStore.label,
    ...(o.productUrl ? { productUrl: o.productUrl } : {}),
    ...(o.freeShipping ? { freeShipping: true } : {}),
    ...(o.medicine === "mip" ? { medicine: "mip" as const } : {})
  };
}

// Nome da loja junto do prazo em TODA opção — texto, card e carrossel (dono, 06/10: "nome da
// loja pode pôr", depois de dois testadores perguntarem "qual a loja?"). "Mambo · 1 dia útil".
function optionDelivery(o: ChoiceOption): string | undefined {
  const store = o.storeLabel?.trim();
  if (!store) return o.delivery;
  const when = o.delivery?.replace(/^prazo da loja:\s*/i, "").trim();
  return when ? `${store} · ${when}` : store;
}

// Customer-facing options message (prices already marked up).
function choicesTextFor(p: PendingChoice, header?: string): string {
  return copy.choicesText(
    p.query,
    p.options.map((o) => ({ name: customerChoiceName(p, o), displayPrice: display(o.unitPrice, o.medicine), delivery: optionDelivery(o), repeat: o.repeat })),
    header ?? choicesHeaderFor(p)
  );
}

function customerChoiceName(p: PendingChoice, option: ChoiceOption): string {
  if (option.storeKey === "boticario" && /\bperfume\b/i.test(p.baseQuery ?? p.query)) {
    return option.name.replace(/desodorante col[oô]nia/gi, "Perfume");
  }
  return option.name;
}

function toChoiceOption(
  o: { sku: string; name: string; brand?: string; unitPrice: number; imageUrl?: string; productUrl?: string; category?: string; freeShipping?: boolean; medicine?: "mip" },
  storeRef?: { storeKey?: string; storeLabel?: string },
  live?: LiveItemCheck,
  urgent = false
): ChoiceOption {
  // Prazo em card SÓ com dado real da loja para o CEP do cliente (regra de 17/08, agora
  // atendida pela simulação ao vivo de 03/09). Sem simulação, nenhum prazo — nunca uma
  // estimativa nossa ou a frase genérica do anúncio. Com urgência, o prazo mostrado é o
  // da entrega MAIS RÁPIDA da loja (a cotação oferece essa opção).
  const useFast = urgent && live?.available && Boolean(live.fastEstimate);
  const delivery = live?.available ? humanEstimate(useFast ? live.fastEstimate : live.estimate) : undefined;
  const eta = useFast ? live!.fastEtaMinutes : live?.etaMinutes;
  const fee = useFast ? live!.fastFee : live?.fee;
  return {
    sku: o.sku,
    name: o.name,
    brand: o.brand,
    // Preço da loja AGORA quando a simulação respondeu (05/10): o card e o total batem.
    unitPrice: live?.available && live.unitPrice != null ? live.unitPrice : o.unitPrice,
    imageUrl: o.imageUrl,
    productUrl: o.productUrl ?? STORE_SEARCH_URL[storeRef?.storeKey ?? ""]?.(o.name),
    ...storeRef,
    ...(delivery ? { delivery } : {}),
    ...(o.freeShipping ? { freeShipping: true } : {}),
    ...(o.medicine === "mip" ? { medicine: "mip" as const } : {}),
    ...(live?.available ? { verified: true, ...(eta != null ? { etaMinutes: eta } : {}), ...(fee != null ? { freightFee: fee } : {}) } : {})
  };
}

// Verificação ao vivo para opções montadas FORA do buildChoices (paginação, refino, resgate,
// troca): confirmado ganha preço/prazo/frete da loja; sem operador, o que a loja não
// confirmou sai (06/10 — a mesma regra da vitrine principal).
async function confirmOptionsLive(pool: ChoiceOption[], cep: string | null | undefined): Promise<ChoiceOption[]> {
  if (!cep || !pool.length) return pool;
  const live = await checkCandidatesLive(pool.map((o) => ({ storeKey: o.storeKey ?? "", sku: o.sku, o })), cep);
  const checked = live.kept.map((w) => {
    const check = live.checks.get(liveKey(w.storeKey, w.sku));
    if (!check?.available) return w.o;
    const delivery = humanEstimate(check.estimate);
    return {
      ...w.o,
      verified: true,
      ...(check.unitPrice != null ? { unitPrice: check.unitPrice } : {}),
      ...(delivery ? { delivery } : {}),
      ...(check.etaMinutes != null ? { etaMinutes: check.etaMinutes } : {}),
      ...(check.fee != null ? { freightFee: check.fee } : {})
    };
  });
  if (!liveConfirmationRequired()) return checked;
  return checked.filter((o) => buyableWithoutOperator(o.storeKey, o.verified ? { sku: o.sku, available: true } : undefined));
}

async function replyPhoto(phone: string, text: string, imageUrl?: string) {
  if (imageUrl) {
    markTurnReplied();
    await whatsappAdapter.sendMedia(phone, text, imageUrl);
  }
  else await reply(phone, text);
}

// Show the (up to 3) options with a product PHOTO each (one image message per option),
// then the numbered prompt. Falls back to the single numbered-text message when photos
// are off (LIA_SEND_PHOTOS=false) or none of the options has an image.
// Pedido de endereço com o botão "Enviar localização" (04/09): no canal Meta a mensagem
// leva o botão; o cliente toca e o GPS vira CEP (webhook). Texto continua valendo.
async function askAddress(phone: string, text: string) {
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    try {
      markTurnReplied();
      const sent = await whatsappAdapter.sendLocationRequest(phone, text);
      if (sent) return;
    } catch (error) {
      console.warn("[whatsapp:meta:location-request:fallback-text]", error instanceof Error ? error.message : error);
    }
  }
  await reply(phone, text);
}

// Cadastro no primeiro contato (06/10, dono: "pode pedir tudo direto no começo"): nome
// completo, CPF, CEP, número e complemento num formulário nativo do WhatsApp (Flow
// publicado pelo cron /api/cron/meta-templates). A resposta volta pelo webhook e cai em
// handleSignupForm. Sem Flow publicado, fora da Meta ou com falha no envio, o plano B é o
// pedido em texto de sempre (`fallback`): endereço, depois nome e CPF.
async function askSignup(phone: string, body: string, fallback: () => Promise<void>) {
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    try {
      const { activeSignupFlowId, SIGNUP_FLOW_CTA, SIGNUP_FLOW_SCREEN } = await import("@/lib/meta-setup");
      const flowId = await activeSignupFlowId();
      if (flowId) {
        markTurnReplied();
        const sent = await whatsappAdapter.sendFlowMessage(phone, {
          body,
          cta: SIGNUP_FLOW_CTA,
          flowId,
          screen: SIGNUP_FLOW_SCREEN,
          token: `lia-cadastro-${Date.now()}`
        });
        if (sent) return;
      }
    } catch (error) {
      console.warn("[whatsapp:meta:signup-flow:fallback-text]", error instanceof Error ? error.message : error);
    }
  }
  await fallback();
}

// Re-pedido no onboarding: sem CEP nenhum ainda, o cliente não fez o cadastro → formulário
// de novo, sem a apresentação. Com CEP, falta só rua e número → o pedido de sempre.
async function askStreetOrSignup(phone: string, ctx: DeliveryContext, userCep: string | null | undefined) {
  if (ctx.cep || userCep) return askStreetAndNumber(phone, ctx);
  const noted = ctx.pendingRequest ? parseBasketLines(ctx.pendingRequest).map((line) => `${line.qty}x ${line.phrase}`) : [];
  // Sem CEP nenhum, o texto pede o endereço COM CEP (06/10: "Falta o endereço: rua, número e
  // complemento" saía para quem nem tinha mandado endereço e soava como cobrança).
  await askSignup(phone, copy.signupFormBody(noted, false), () =>
    reply(phone, noted.length ? `${copy.notedItemsLine(noted)}\n\n${copy.askAddressWithCep()}` : copy.askAddressWithCep())
  );
}

// Rua/número/complemento com o Flow de endereço (formulário dentro do chat, 04/09) quando
// LIA_FLOW_ADDRESS_ID está configurado; CEP/rua/bairro/cidade já conhecidos vão
// pré-preenchidos. A resposta volta pelo webhook como linha de endereço completo.
// Sem Flow (ou falha), o pedido em texto de sempre.
async function askStreetAndNumber(phone: string, ctx: DeliveryContext) {
  const flowId = process.env.LIA_FLOW_ADDRESS_ID?.trim();
  const parts = (ctx.deliveryAddress ?? "").split(",").map((x) => x.trim());
  // O Flow só mostra o que já sabemos e pede número/complemento: precisa de CEP e rua
  // conhecidos (ViaCEP). Sem rua (CEP geral), o pedido em texto de sempre.
  const known = parts.length >= 3 && parts[0] && !/\d/.test(parts[0]) ? { rua: parts[0], bairro: parts[1], cidade: parts[2] } : null;
  if (flowId && known && ctx.cep && process.env.WHATSAPP_PROVIDER === "meta") {
    try {
      markTurnReplied();
      const sent = await whatsappAdapter.sendFlowMessage(phone, {
        body: "Falta só o número e o complemento. Confere e confirma seu endereço:",
        cta: "Preencher endereço",
        flowId,
        screen: "ADDRESS",
        data: { cep: ctx.cep, ...known }
      });
      if (sent) return;
    } catch (error) {
      console.warn("[whatsapp:meta:flow:fallback-text]", error instanceof Error ? error.message : error);
    }
  }
  // Rua conhecida pelo CEP (06/10, A3): confirma a rua e pede só o número.
  const street = !ctx.deliveryAddressVerified ? ctx.cepPlace?.street : undefined;
  if (street && ctx.cep) {
    await reply(phone, copy.askHouseNumber(street, ctx.cepPlace?.district, ctx.cep));
    return;
  }
  await reply(phone, ctx.cep ? copy.askFullDeliveryAddress() : copy.askAddressWithCep());
}

// Tamanho da vitrine (dono, 10/09: "agora que tem carrossel, uns 5"): 5 opções quando o
// carrossel está ligado (cabe numa mensagem, mesmo custo), 3 nos cards soltos e nos
// testes. A IA do rerank recebe o mesmo teto e usa as vagas extras pra VARIAR dentro do
// pedido (outra marca/loja/faixa de preço), nunca pra sair dele.
function vitrineLimit(): number {
  const env = Number(process.env.LIA_VITRINE_MAX);
  if (Number.isFinite(env) && env >= 2 && env <= 5) return env;
  return carouselEnabled() ? 5 : 3;
}

function choicesHeaderFor(p: PendingChoice): string {
  if (p.urgent) return copy.choicesHeaderToday(p.query);
  if (p.noneToday) return copy.noneTodayHeader(p.query);
  return copy.choicesHeader(p.query);
}

// "Hoje" = entrega da loja em menos de um dia (SLA em minutos/horas ou "0bd").
function sameDayMaxMinutes(): number {
  return Number(process.env.LIA_SAME_DAY_MAX_MINUTES ?? 24 * 60);
}

async function sendChoices(phone: string, p: PendingChoice, header?: string) {
  // Remédio isento: a política da Meta veta CATÁLOGO, carrinho e pagamento nativo do
  // WhatsApp para remédio — não foto nem botão comum. Desde 05/10 (dono: "por que não pode
  // ter botão?") a vitrine de remédio é de cards soltos (foto + "Adicionar"); só o carrossel
  // fica de fora, porque é template de MARKETING revisado pela Meta.
  const medicine = medicineEnabled() && hasMip(p.options);
  // Meta supports reply buttons inside the 24h customer-service window. One card per
  // option keeps each "Escolher este" button attached to the correct product.
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    // O id do botão carrega o SKU, não a posição: card antigo (de antes do
    // "outras"/refino) tocado depois escolhe o produto DAQUELE card — id
    // posicional confirmava outro produto quando a lista trocava por baixo.
    const choices = p.options.map((o) => ({
      id: `optsku:${o.sku}`,
      name: customerChoiceName(p, o),
      displayPrice: display(o.unitPrice, o.medicine),
      imageUrl: o.imageUrl,
      delivery: optionDelivery(o),
      ...(o.repeat ? { badge: "Você já pediu este" } : {}),
      // Liga o botão "Ver detalhes" do card quando o produto tem página real.
      productUrl: o.productUrl,
      sku: o.sku
    }));
    // Carrossel (dono, 07/09): cabeçalho + cards numa mensagem só. Se não der (1 opção,
    // foto faltando, template não aprovado, desligado), segue nos cards soltos.
    const intro = header ?? choicesHeaderFor(p);
    let introSent = false;
    if (carouselEnabled() && !medicine) {
      try {
        markTurnReplied();
        // Carrossel v5 (05/10): corpo fixo "Olha o que achei 👇". Cabeçalho que só navega
        // ("Mais opções de X") some; o que INFORMA ("a loja não confirmou X", "chega hoje")
        // vai num texto logo antes. v3/v4 seguem levando o cabeçalho no corpo.
        const { activeCarouselPrefix, carouselHasFixedBody } = await import("@/lib/meta-setup");
        const navigational = [
          copy.choicesHeader(p.query),
          copy.moreChoicesHeader(p.query),
          copy.priceSortedHeader(p.query, true),
          copy.priceSortedHeader(p.query, false),
          copy.narrowedChoices(p.query)
        ].includes(intro);
        if (!navigational && choices.length >= 2 && carouselHasFixedBody(await activeCarouselPrefix(Math.min(choices.length, 5)))) {
          await reply(phone, intro);
          introSent = true;
        }
        const legacyHeader = intro === copy.choicesHeader(p.query) ? copy.choicesHeaderLegacy(p.query) : intro;
        const sent = await whatsappAdapter.sendDeliveryCarousel(phone, legacyHeader, choices);
        if (sent) {
          await rememberCarousel(phone, sent.messageId, p, intro);
          return;
        }
      } catch (error) {
        console.warn("[whatsapp:meta:carousel:error]", error instanceof Error ? error.message : error);
      }
    }
    if (!introSent) await reply(phone, intro);
    try {
      markTurnReplied();
      const interactive = await whatsappAdapter.sendDeliveryChoices(phone, choices);
      if (interactive) return;
    } catch (error) {
      console.warn("[whatsapp:meta:choices:fallback-text]", error instanceof Error ? error.message : error);
    }
    await reply(phone, choicesTextFor(p));
    return;
  }

  // Only lay out photos if at least one image can ACTUALLY be delivered (Petz's Akamai
  // CDN 403s Twilio, so those options use the clean single-list fallback, not per-item text).
  const withPhotos =
    process.env.LIA_SEND_PHOTOS !== "false" && p.options.some((o) => whatsappAdapter.canSendImage(o.imageUrl));
  if (!withPhotos) {
    await reply(phone, choicesTextFor(p, header));
    return;
  }
  // Small gap between media messages so WhatsApp keeps them in order.
  const gapMs = process.env.WHATSAPP_PROVIDER === "twilio" ? Number(process.env.TWILIO_PRODUCT_MESSAGE_DELAY_MS ?? 600) : 0;
  await reply(phone, header ?? choicesHeaderFor(p));
  for (let i = 0; i < p.options.length; i++) {
    const o = p.options[i];
    await replyPhoto(phone, copy.choiceLine(i, o.name, display(o.unitPrice, o.medicine), optionDelivery(o), o.repeat), o.imageUrl);
    if (gapMs > 0 && i < p.options.length - 1) await sleep(gapMs);
  }
  await reply(phone, copy.choicesAsk(p.options.length));
}

// Rede de segurança do carrossel (caso real 08/09: "quero um relógio barato" ficou sem
// resposta). A Graph aceita o template e o WhatsApp descarta depois com status "failed"
// (131042: conta sem moeda configurada — carrossel é template PAGO). O carrossel enviado
// fica gravado como Message(sender "carousel", metadata = wamid) com o header e as opções;
// quando o webhook recebe o "failed" daquele wamid, reenvia tudo como cards soltos.
async function rememberCarousel(phone: string, messageId: string | undefined, p: PendingChoice, header: string) {
  if (!messageId) return;
  try {
    const { convo } = await getOrCreateConvo(phone);
    await prisma.message.create({
      data: { conversationId: convo.id, sender: "carousel", metadata: messageId, text: JSON.stringify({ header, pending: p }) }
    });
  } catch (error) {
    console.warn("[carousel:remember-failed]", error instanceof Error ? error.message : error);
  }
}

// Vitrine recente que mostrou este sku: a última escolha (memória da conversa) ou um dos
// carrosséis gravados nas últimas horas. Opção achada → a vitrine volta como escolha aberta.
const REVIVE_TAP_WINDOW_MS = 6 * 60 * 60 * 1000;
async function reviveTappedOption(
  convoId: string,
  ctx: DeliveryContext,
  sku: string
): Promise<{ pending: PendingChoice; option: ChoiceOption } | null> {
  const wanted = sku.trim().toLowerCase();
  const find = (p: PendingChoice) =>
    p.options.find((o) => o.sku.toLowerCase() === wanted) ?? p.shownOptions?.find((o) => o.sku.toLowerCase() === wanted);
  if (ctx.lastChoice) {
    const { chosenSku: _chosen, replaceSku: _replace, ...pending } = ctx.lastChoice;
    const option = find(pending);
    if (option) return { pending, option };
  }
  try {
    const rows = await prisma.message.findMany({
      where: { conversationId: convoId, sender: { in: ["carousel", "carousel-recovered"] }, createdAt: { gte: new Date(Date.now() - REVIVE_TAP_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      take: 10
    });
    for (const row of rows) {
      const saved = JSON.parse(row.text) as { pending?: PendingChoice };
      if (!saved.pending?.options?.length) continue;
      const option = find(saved.pending);
      if (option) return { pending: saved.pending, option };
    }
  } catch (error) {
    console.warn("[stale-tap:revive]", error instanceof Error ? error.message : error);
  }
  return null;
}

export async function recoverFailedCarousel(messageId: string, recipientDigits: string, failure?: string): Promise<boolean> {
  if (!messageId) return false;
  const row = await prisma.message.findFirst({ where: { sender: "carousel", metadata: messageId } });
  if (!row) return false;
  // Idempotente: a Meta reenvia status em rajada; o segundo "failed" não manda cards de novo.
  await prisma.message.update({ where: { id: row.id }, data: { sender: "carousel-recovered" } });
  const phone = `+${recipientDigits.replace(/\D/g, "")}`;
  const saved = JSON.parse(row.text) as { header: string; pending: PendingChoice };
  console.warn("[carousel:recover]", phone.slice(-4), failure?.slice(0, 200));
  await reply(phone, saved.header);
  try {
    const choices = saved.pending.options.map((o) => ({
      id: `optsku:${o.sku}`,
      name: customerChoiceName(saved.pending, o),
      displayPrice: display(o.unitPrice, o.medicine),
      imageUrl: o.imageUrl,
      delivery: optionDelivery(o),
      ...(o.repeat ? { badge: "Você já pediu este" } : {}),
      productUrl: o.productUrl,
      sku: o.sku
    }));
    if (await whatsappAdapter.sendDeliveryChoices(phone, choices)) return true;
  } catch (error) {
    console.warn("[carousel:recover:cards-failed]", error instanceof Error ? error.message : error);
  }
  await reply(phone, choicesTextFor(saved.pending));
  return true;
}

// CEP -> human address via ViaCEP. invalid=true means the CEP definitely doesn't
// exist; a network failure keeps invalid=false (we save the CEP and move on). Hard
// 4s timeout — a WhatsApp turn must never hang on a slow ViaCEP.
async function expandCep(cep: string): Promise<{ address?: string; street?: string; district?: string; city?: string; uf?: string; invalid: boolean }> {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) return { invalid: true };
  try {
    const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.LIA_VIACEP_TIMEOUT_MS ?? 4000))
    });
    if (!res.ok) return { invalid: false };
    const data = (await res.json()) as { logradouro?: string; bairro?: string; localidade?: string; uf?: string; erro?: boolean };
    if (data.erro) return { invalid: true };
    return {
      address: [data.logradouro, data.bairro, data.localidade, data.uf].filter(Boolean).join(", "),
      street: data.logradouro?.trim() || undefined,
      district: data.bairro?.trim() || undefined,
      city: data.localidade,
      uf: data.uf,
      invalid: false
    };
  } catch {
    return { invalid: false };
  }
}

// ---------- quote + summary ----------

function minimumOrderText(ctx: DeliveryContext, store: StoreConnector): string {
  const displayMin = display(storeMinReal(store));
  const produtos = (ctx.basket ?? [])
    .filter((item) => item.storeKey === store.key)
    .reduce((sum, item) => sum + Math.round(display(item.unitPrice, item.medicine) * item.qty * 100) / 100, 0);
  const falta = Math.max(0, Math.round((displayMin - produtos) * 100) / 100);
  const scoped = { ...ctx, basket: (ctx.basket ?? []).filter((item) => item.storeKey === store.key) };
  // O resto da cesta aparece junto: a mensagem parecia resumo COMPLETO e o cliente
  // achava que os outros itens tinham sumido (rodadas 3 e 10, 14/08).
  const others = { ...ctx, basket: (ctx.basket ?? []).filter((item) => item.storeKey !== store.key) };
  return copy.minimumOrder({
    items: basketForCopy(scoped),
    produtos,
    displayMin,
    falta,
    storeLabel: store.label,
    otherItems: basketForCopy(others)
  });
}

// Só o mínimo de UMA loja trava e os itens têm equivalente FORTE em loja sem mínimo →
// oferece a troca com botão. Melhor caminho pro cliente pequeno (teste real 24/08:
// pasta de R$6 presa no mínimo de R$30 do mercado; o cliente desistiu).
// Pares antigo→novo (com preço de exibição da LINHA) da troca de loja, para a copy
// anunciar cada substituição — a troca nunca é silenciosa (27/08 S1/S2/S5/S18).
function swapPairsForCopy(
  originals: BasketItem[],
  replacements: { fromSku: string; qty: number; option: ChoiceOption }[]
): copy.SwapPair[] {
  const pairs: copy.SwapPair[] = [];
  for (const r of replacements) {
    const from = originals.find((i) => i.sku === r.fromSku);
    if (!from) continue;
    pairs.push({
      fromName: from.name,
      fromPrice: Math.round(display(from.unitPrice, from.medicine) * from.qty * 100) / 100,
      toName: r.option.name,
      toPrice: Math.round(display(r.option.unitPrice, r.option.medicine) * r.qty * 100) / 100
    });
  }
  return pairs;
}

async function offerMinimumSwap(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  store: StoreConnector
): Promise<boolean> {
  const stuck = (ctx.basket ?? []).filter((item) => item.storeKey === store.key);
  if (!stuck.length) return false;
  const replacements: { fromSku: string; qty: number; option: ChoiceOption }[] = [];
  for (const item of stuck) {
    const tokens = queryTokens(item.name);
    let found: ChoiceOption | undefined;
    for (const take of [4, 3]) {
      const query = tokens.slice(0, take).join(" ");
      if (!query) break;
      const candidates = await gatherCrossStoreCandidates(query, 12);
      const alts = candidates.filter(
        (c) =>
          c.store.key !== store.key &&
          storeMinReal(c.store) === 0 &&
          conciergeMatchIsStrong(query, c.item)
      );
      // Entre as lojas que servem, frete CONHECIDO ganha de tarifa padrão (R$18 numa
      // pasta de R$6 mataria a vantagem da troca), e o fee menor desempata.
      const ranked = alts
        .map((c) => ({ c, freight: storeFreight(c.store.key, c.store.label, 0) }))
        .sort((a, b) => {
          const aPad = a.freight.source === "padrao" ? 1 : 0;
          const bPad = b.freight.source === "padrao" ? 1 : 0;
          if (aPad !== bPad) return aPad - bPad;
          return a.freight.fee - b.freight.fee;
        });
      if (ranked.length) {
        const alt = ranked[0].c;
        found = toChoiceOption(alt.item, { storeKey: alt.store.key, storeLabel: alt.store.label });
        break;
      }
      // Nenhuma vitrine local sem mínimo tem o item → MERCADO LIVRE (dono, 25/08:
      // "ele pode ir pra outra loja, o Meli, e comprar direto"). Sem mínimo por
      // definição (cada anúncio é um checkout). Só anúncio que fecha sozinho serve:
      // com id (frete ao vivo por anúncio) ou frete grátis declarado — senão o
      // fechamento abortaria pro operador e a troca viraria espera.
      if (mercadoLivreEnabled()) {
        try {
          const mlItems = await searchMercadoLivre(query, 4);
          const mlAlt = mlItems.find(
            (item) =>
              conciergeMatchIsStrong(query, item) &&
              (item.freeShipping === true || mlItemIdFrom(item) !== null)
          );
          if (mlAlt) {
            const mlStore = getStore("mercadolivre");
            found = toChoiceOption(mlAlt, { storeKey: mlStore.key, storeLabel: mlStore.label });
            break;
          }
        } catch (error) {
          console.warn("[minswap:ml-failed]", error instanceof Error ? error.message : error);
        }
      }
    }
    if (!found) return false;
    replacements.push({ fromSku: item.sku, qty: item.qty, option: found });
  }
  const oldDisplay = stuck.reduce((sum, i) => sum + Math.round(display(i.unitPrice, i.medicine) * i.qty * 100) / 100, 0);
  const newDisplay = replacements.reduce((sum, r) => sum + Math.round(display(r.option.unitPrice, r.option.medicine) * r.qty * 100) / 100, 0);
  ctx.minSwap = { fromStoreKey: store.key, replacements };
  await writeCtx(convoId, ctx);
  const body = copy.minimumSwapOffer({
    newTotal: newDisplay,
    delta: Math.round((newDisplay - oldDisplay) * 100) / 100,
    storeLabel: store.label,
    pairs: swapPairsForCopy(stuck, replacements)
  });
  try {
    markTurnReplied();
    const interactive = await whatsappAdapter.sendStoreSwapOffer(phone, body);
    if (interactive) return true;
  } catch (error) {
    console.warn("[whatsapp:minswap:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, `${body}\n(responde *trocar de loja* que eu troco)`);
  return true;
}

// ---------- the WhatsApp conversation state machine ----------

export async function handleDeliveryMessage(input: {
  phone?: string;
  text: string;
  name?: string;
  messageId?: string;
  // Áudio ou foto que o cliente mandou (14/09): só o id da Meta — vira texto depois do
  // dedupe, em `understandMedia`.
  media?: InboundMedia;
  acquisition?: InboundAcquisition;
  // Resposta de Flow (formulário dentro do chat), já parseada pelo adapter. O de cadastro
  // (06/10) é tratado aqui; o de endereço o webhook já converteu em texto.
  flowResponse?: Record<string, unknown>;
}) {
  const phone = normalizePhone(input.phone);
  turnStartedAt.set(phone, Date.now());
  // Formulário de cadastro: o histórico grava só um rótulo (o formulário traz o CPF).
  const signupForm = isSignupFormReply(input.flowResponse) ? input.flowResponse : undefined;
  const tagged = stripAcquisitionTag(signupForm ? SIGNUP_FORM_MESSAGE : (input.text ?? "").trim());
  let text = tagged.text;
  const acquisition = mergeAcquisition(input.acquisition, tagged.campaignCode);
  const { user, convo } = await getOrCreateConvo(phone, input.name);

  // Twilio/Meta retry the webhook when a turn is slow — never process the same inbound
  // message twice (a duplicated "2 arroz" would silently double the basket). O dedupe é
  // ATÔMICO pelo índice único (conversationId, metadata): checar-depois-gravar deixava
  // duas entregas SIMULTÂNEAS do mesmo sid passarem juntas pelo findFirst.
  let inboundMessageId: string | undefined;
  try {
    const created = await prisma.message.create({
      data: { conversationId: convo.id, sender: "user", text, metadata: input.messageId }
    });
    inboundMessageId = created.id;
  } catch (error) {
    if (input.messageId && (error as { code?: string })?.code === "P2002") return;
    throw error;
  }

  // Attribution is deliberately best-effort: an analytics write can never make the
  // customer retry a purchase turn. Message dedupe runs first, so a Meta webhook retry
  // cannot create a second acquisition touch.
  if (acquisition && inboundMessageId) {
    try {
      await recordAcquisitionTouch({
        conversationId: convo.id,
        providerMessageId: input.messageId ?? `message:${inboundMessageId}`,
        acquisition
      });
    } catch (error) {
      console.error("[acquisition:record-failed]", error instanceof Error ? error.message : error);
    }
  }

  // Áudio e foto viram texto AQUI, depois do dedupe (14/09): transcrever custa segundos,
  // e turno lento é exatamente quando a Meta re-entrega o mesmo wamid — do outro lado do
  // dedupe cada áudio é baixado, transcrito e ecoado UMA vez. O texto derivado segue pelo
  // mesmo NLU de quem digitou; o eco ("🎧 Ouvi: …") vai antes da busca porque
  // transcrição erra e o cliente precisa ver o que ela entendeu enquanto ainda dá pra
  // corrigir.
  if (!text && input.media) {
    const understood = await understandMedia(input.media);
    if (!understood) {
      await reply(phone, copy.mediaNotUnderstood(input.media.kind));
      return;
    }
    text = understood.text;
    if (inboundMessageId) {
      // A conversa gravada tem que dizer que aquilo veio de áudio/foto: transcrição
      // errada não pode parecer coisa que o cliente digitou.
      await prisma.message
        .update({ where: { id: inboundMessageId }, data: { text: derivedMessageLabel(understood.kind, text) } })
        .catch(() => undefined);
    }
    await reply(phone, copy.mediaUnderstood(understood.kind, text));
  }

  // Mensagem sem texto legível (figurinha, vídeo, contato, tipo desconhecido): resposta
  // honesta em vez de silêncio — antes caía num 400 mudo no webhook (28/08). Fica
  // DEPOIS do dedupe pra retry da Meta não repetir o aviso.
  if (!text) {
    await reply(phone, copy.nonTextMessage());
    return;
  }

  // Login do painel pelo WhatsApp (04/09): operador manda "ops" e recebe link de 10 min.
  // Fica ANTES do lock porque não toca no contexto da conversa.
  if (/^(ops|painel|login|entrar)$/i.test(text) && isAdminPhone(phone)) {
    // O link carrega o PAPEL de quem pediu: o operador contratado abre um painel sem as
    // contas das lojas nem as ações de dinheiro (ver src/lib/auth.ts).
    const token = createOpsLoginToken(Date.now(), phoneRole(phone) ?? "owner");
    await reply(phone, token ? copy.opsLoginLink(opsLoginUrl(token)) : copy.opsLoginUnavailable());
    return;
  }

  // Teste do formulário de cadastro em produção (06/10): o dono ou um admin manda
  // "cadastro" e recebe o formulário mesmo já cadastrado. Preencher regrava os dados dele.
  if (!signupForm && /^cadastro$/i.test(text) && isAdminPhone(phone)) {
    await askSignup(phone, copy.signupFormBody(), () => reply(phone, copy.welcomeAskFullDeliveryAddress()));
    return;
  }

  // Um turno por vez por conversa (ver acquireTurnLock). O dedupe fica ANTES do lock
  // de propósito: retry do webhook sai na hora, sem esperar o turno original terminar.
  const lockToken = await acquireTurnLock(convo.id);
  try {
    // Recarrega a conversa DEPOIS do lock: o turno anterior pode ter gravado contexto
    // enquanto esperávamos — processar sobre o snapshot velho recriaria a corrida.
    const freshConvo = (await prisma.conversation.findUnique({ where: { id: convo.id } })) ?? convo;
    // O snapshot do CAS também precisa avançar para o contexto recarregado; senão a
    // primeira escrita deste turno colide com a do turno que terminou enquanto
    // esperávamos o lock e morre em falso TurnSupersededError — cliente sem resposta.
    rememberCtxSnapshot(convo.id, freshConvo.context ?? null);
    // Contexto sem CEP (conversa nova/limpa): o CEP salvo do cliente define a área da busca.
    if (!currentShopperCep()) noteShopperCep(user.cep);
    if (signupForm) await handleSignupForm(phone, signupForm, user, freshConvo);
    else await handleDeliveryTurn(phone, text, user, freshConvo, inboundMessageId);
    // REDE ANTI-SILÊNCIO: nenhum caminho do turno respondeu nada → fallback pedindo
    // reformulação. Silêncio absoluto é o pior desfecho possível (28/08: 4 sessões).
    if ((turnMeta.getStore()?.replies ?? 1) === 0) {
      console.warn("[turn:zero-replies]", phone, text.slice(0, 80));
      await reply(phone, copy.fallbackNoAnswer());
    }
  } finally {
    await releaseTurnLock(convo.id, lockToken);
  }
}

async function handleDeliveryTurn(
  phone: string,
  text: string,
  user: Awaited<ReturnType<typeof getOrCreateConvo>>["user"],
  convo: Awaited<ReturnType<typeof getOrCreateConvo>>["convo"],
  inboundMessageId?: string
) {
  const ctx = readCtx(convo.context);
  // Addresses saved through the legacy checkout are customer-entered and can be
  // reused safely by the delivery flow.
  // Nunca durante "trocar endereço" (need_cep/need_address): o passo acabou de
  // esvaziar o endereço de propósito, e restaurar aqui fazia o mesmo CEP manter a rua
  // VELHA como verificada (revisão 01/09).
  if (!ctx.deliveryAddress && user.defaultAddress && ctx.step !== "need_cep" && ctx.step !== "need_address") {
    ctx.deliveryAddress = user.defaultAddress;
    ctx.deliveryAddressVerified = true;
  }
  const intent = detectIntent(text);

  // Motivo do cancelamento (06/10): o toque na lista (ou número/palavra curta logo depois de
  // perguntar) vira nota no pedido cancelado. Pergunta vale 30 min e UMA resposta; qualquer
  // outra mensagem desarma e segue o fluxo normal — nunca prende o cliente.
  if (ctx.cancelReason || /^cancelmotivo:/.test(normalizeMsg(text))) {
    const asked = ctx.cancelReason && Date.now() - ctx.cancelReason.askedAt < 30 * 60_000 ? ctx.cancelReason : undefined;
    const reason = parseCancelReason(text, Boolean(asked));
    const orderId = asked?.orderId ?? ctx.lastCanceledOrderId;
    if (ctx.cancelReason) {
      ctx.cancelReason = undefined;
      await writeCtx(convo.id, ctx);
    }
    if (reason) {
      await recordCancelReason(orderId, reason);
      await reply(phone, copy.cancelReasonThanks());
      return;
    }
    if (/^cancelmotivo:/.test(normalizeMsg(text))) return;
  }

  // Auto-expire a stale cart: if the last activity was over 30 min ago, start fresh
  // (keep only the saved address) so a leftover basket from a previous session doesn't
  // bleed into a new order — the reported "old items still there" problem.
  const CART_TTL_MS = Number(process.env.LIA_CART_TTL_MS ?? 30 * 60 * 1000);
  // ÚLTIMA ATIVIDADE REAL = a mensagem anterior da conversa. `Conversation.updatedAt` só
  // muda quando o contexto é gravado: quem só faz perguntas ("já saiu o total?") ficava
  // com o relógio parado e podia ser expirado no meio de uma conversa viva.
  const idleSince = await lastActivityAt(convo.id, inboundMessageId);
  const idleMs = idleSince ? Date.now() - idleSince.getTime() : 0;
  // Escolha pendente também vence por idade absoluta (LIA_PENDING_TTL_MS, 6 h): a inatividade
  // não basta, porque mensagens que não tocam no contexto ("ops" do dono) renovam o relógio.
  const PENDING_TTL_MS = Number(process.env.LIA_PENDING_TTL_MS ?? 6 * 60 * 60 * 1000);
  const pendingTooOld = Boolean(ctx.pending?.length && ctx.pendingSince && Date.now() - ctx.pendingSince > PENDING_TTL_MS);
  const stale = Boolean((ctx.basket?.length || ctx.pending?.length) && idleSince && idleMs > CART_TTL_MS) || pendingTooOld;
  if (stale) {
    // (hadBasket removido 25/09: a lista vencida some em silêncio.)
    const keptCep = ctx.cep;
    const keptAddr = ctx.deliveryAddress;
    const keptAddrVerified = ctx.deliveryAddressVerified;
    for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
    ctx.flow = "delivery";
    ctx.cep = keptCep;
    ctx.deliveryAddress = keptAddr;
    ctx.deliveryAddressVerified = keptAddrVerified;
    // Persist before any early return (especially greeting). Previously the clear
    // lived only in memory, so the same stale warning repeated on every new message.
    await writeCtx(convo.id, ctx);
    // A lista vencida some em silêncio (25/09, dono: "tira isso"): o aviso "sua lista anterior
    // expirou" aparecia no meio de uma compra nova e só confundia. O endereço continua salvo.

  }
  // "Foi embora no meio" (pedido do dono, 11/08): cotação parada + cliente sumido por
  // LIA_QUOTE_ABANDON_TTL_MS (60 min) = ele não quer mais aquilo. Na volta, o pedido
  // não-pago é cancelado sozinho, a conversa recomeça do zero (endereço preservado) e a
  // mensagem nova é processada normalmente — o zumbi de sábado (2 dias preso em
  // awaiting_operator_quote, camiseta caindo dentro) não pode se repetir. Pedido PAGO
  // nunca é tocado; awaiting_payment também não (o cliente pode estar pagando o Pix
  // agora mesmo — e a cotação vencida já bloqueia pagamento velho por conta própria).
  // `choosing_freight` entra na lista (revisão 18/08): a escolha da entrega ficava VIVA
  // pra sempre — o cliente sumia dias e o toque publicava frete e data consultados no
  // passado, já vencidos, numa cotação pagável.
  const QUOTE_ABANDON_TTL_MS = quoteAbandonTtlMs();
  const quoteWaitSteps: Array<DeliveryContext["step"]> = [
    "awaiting_operator_quote",
    "awaiting_supplier_validation",
    "awaiting_quote_confirmation",
    "choosing_freight"
  ];
  // Revisão 01/09: o relógio acima só conta mensagens do CLIENTE (a Lia não grava as
  // suas em Message). Cotação manual publicada 70 min depois do "só isso" e aceita 2 min
  // depois era cancelada "por inatividade" no instante do "pix". Só no passo em que a
  // cotação JÁ SAIU (`awaiting_quote_confirmation`), a publicação (updatedAt do pedido)
  // entra como segundo relógio: vale o mais recente dos dois. Nos passos de espera pelo
  // operador o relógio continua sendo o do cliente (o zumbi de 11/08 tem que expirar).
  let quoteIdleMs = idleMs;
  if (ctx.step === "awaiting_quote_confirmation" && idleSince && idleMs > QUOTE_ABANDON_TTL_MS && ctx.deliveryOrderId) {
    const waiting = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId }, select: { updatedAt: true } });
    if (waiting) quoteIdleMs = Math.min(idleMs, Date.now() - waiting.updatedAt.getTime());
  }
  if (quoteWaitSteps.includes(ctx.step) && idleSince && quoteIdleMs > QUOTE_ABANDON_TTL_MS) {
    let canceledShortId: string | undefined;
    // O operador pode ter publicado a cotação no exato instante em que o cliente voltou.
    // Se a corrida for perdida, NÃO limpamos a conversa: o contexto correto acabou de ser
    // escrito por opsPublishManualQuote e o cliente já recebeu o total.
    let lostRaceToOperator = false;
    if (ctx.deliveryOrderId) {
      const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
      if (order?.status === AWAITING_OPERATOR_QUOTE_STATUS) {
        // Guardado por status no próprio UPDATE (nada de ler-depois-escrever por id).
        const canceled = await prisma.deliveryOrder.updateMany({
          where: { id: order.id, status: AWAITING_OPERATOR_QUOTE_STATUS },
          data: {
            status: "canceled",
            notes: appendOrderNote(order.notes, "⏰ Cancelado automático: cliente ficou 1h+ sem resposta antes da cotação sair.")
          }
        });
        if (canceled.count) canceledShortId = order.id.slice(-6).toUpperCase();
        else lostRaceToOperator = true;
      } else if (order && (await cancelPendingRetailerQuote(order.id))) {
        canceledShortId = order.id.slice(-6).toUpperCase();
      }
    }
    if (!lostRaceToOperator) {
      const fresh = addressOnlyCtx(ctx);
      for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
      Object.assign(ctx, fresh);
      await writeCtx(convo.id, ctx);
      if (canceledShortId) await reply(phone, copy.staleQuoteRestart(canceledShortId));
      // Toque num BOTÃO velho não é mensagem nova pra processar: sem isso "frete:barato"
      // seguiria adiante como se fosse uma lista de compras.
      if (isFreightChoicePayload(text)) {
        if (!canceledShortId) await reply(phone, copy.quoteExpired());
        return;
      }
    }
  }

  // Depois dos dois resets acima, para a marca não morrer na mesma mensagem que a criou.
  // Persistida pelo writeCtx do handler que tratar a mensagem (toda rota de pedido grava).
  if (!ctx.urgent && hasUrgencySignal(text)) ctx.urgent = true;

  // ---- endereço: pergunta da Lia em aberto (troca de CEP / cidade ≠ CEP), 06/10 ----
  if ((ctx.cepSwap || ctx.cepCityCheck) && (await handlePendingAddressQuestion(phone, user, convo.id, ctx, text, intent))) return;
  // "deixa o endereço antigo" / "usa o de antes" (06/10, A4): no meio de uma troca, volta o
  // endereço anterior; fora dela, confirma que nada mudou (a IA respondia "consigo trocar").
  if (isKeepOldAddress(text) && (await keepPreviousAddress(phone, user, convo.id, ctx, text))) return;

  const savedCep = user.cep ?? ctx.cep;

  if (normalizeMsg(text) === "cadastrar_endereco") {
    ctx.flow = "delivery";
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    await askAddress(phone, copy.askCepAgain());
    return;
  }

  if (normalizeMsg(text) === "adicionar_mais") {
    ctx.step = "collecting";
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.askMoreItems());
    return;
  }

  // Botão "Editar itens" do resumo da cotação (dono, 01/09: o total aparecia sem
  // caminho visível pra tirar/trocar item). A resposta é o manual curto — os comandos
  // em si já funcionam em qualquer etapa (reopenOrderForEdit + handlers de edição).
  if (normalizeMsg(text) === "editar_itens") {
    await reply(phone, copy.editItemsHelp());
    return;
  }

  // Resposta à oferta da cauda longa ("procuro no Mercado Livre?", revisão 02/09). Só
  // vale sem escolha aberta e fora de outras perguntas binárias (o de sempre, troca de
  // loja) — nesses, "sim" continua sendo delas.
  // 06/09 (pai do dono): a oferta nasceu com uma escolha aberta e o "sim" era ignorado.
  // Botão vale sempre; palavra solta ("sim") só quando não há escolha aberta.
  if (ctx.longTailOffer && !ctx.repeatConfirm && !ctx.minSwap) {
    const n = normalizeMsg(text);
    const free = !ctx.pending?.length && (ctx.step === "collecting" || !ctx.step);
    const yes = n === "longtail_sim" || (free && n.length <= 30 && /^(sim|pode|procura|procurar|manda|quero|bora|vai|ok|isso|claro|beleza|blz)\b/.test(n));
    const no = n === "longtail_nao" || (free && n.length <= 30 && /^(n|nao|nao precisa|deixa|deixa pra la|esquece|nao quero|nem|dispensa)\b/.test(n));
    if (yes) {
      const offer = ctx.longTailOffer;
      ctx.longTailOffer = undefined;
      await rescueLongTail(phone, convo.id, user.cep, ctx, offer.lines, user.id);
      return;
    }
    if (no) {
      ctx.longTailOffer = undefined;
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.longTailDeclined());
      return;
    }
  }

  // Botão "Mudar quantidade" do follow-up (dono, 01/09: mudar quantidade tem que ser
  // botão). Reabre os botões 1/2/Outra da pergunta clássica para o ÚLTIMO item; o
  // toque volta como qty:N e cai nos handlers logo abaixo. Nunca dispara no estado
  // legado choosing_quantity — lá os mesmos ids fecham a escolha pendente.
  if (normalizeMsg(text) === "qtd_alterar") {
    const last = ctx.basket?.[ctx.basket.length - 1];
    if (!last) {
      await reply(phone, copy.askMoreItems());
      return;
    }
    markTurnReplied();
    const interactive = await whatsappAdapter.sendQuantityChoices(phone, last.name);
    if (!interactive) await reply(phone, copy.quantityAsk(last.name));
    return;
  }
  const qtyTap = normalizeMsg(text).match(/^qty:([12])$/);
  if (qtyTap && ctx.basket?.length) {
    const last = ctx.basket[ctx.basket.length - 1];
    last.qty = Number(qtyTap[1]);
    last.lineTotal = Math.round(last.unitPrice * last.qty * 100) / 100;
    await writeCtx(convo.id, ctx);
    await replyBasketAdjusted(phone, copy.qtyAdjustedShort(last.qty, last.name), copy.qtyAdjusted(last.qty, last.name));
    return;
  }
  if (normalizeMsg(text) === "qty:other" && ctx.basket?.length) {
    // O número digitado em seguida cai no ajuste de número seco do último item.
    await reply(phone, copy.quantityAskFree(ctx.basket[ctx.basket.length - 1].name));
    return;
  }

  // GUARDA DE REMÉDIO GLOBAL (26/08 P1.6: 2/4 — a recusa dependia da etapa; na
  // pergunta de quantidade "também queria dipirona" virava "responde o número").
  // "sem remédio, quero X" segue como pedido (negação já tratada na extração).
  if (blocksMedicine(text) && !/^sem\s/.test(normalizeMsg(text))) {
    await reply(phone, noMedicineCopy());
    if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
    return;
  }


  // ---- social / meta (work in ANY step) ----
  if (intent.kind === "thanks") {
    await reply(phone, copy.thanks());
    return;
  }
  if (intent.kind === "help") {
    await reply(phone, copy.help());
    return;
  }
  if (intent.kind === "greeting") {
    if (!user.defaultAddress) {
      ctx.flow = "delivery";
      ctx.step = "need_address";
      await writeCtx(convo.id, ctx);
      const noted = ctx.pendingRequest ? parseBasketLines(ctx.pendingRequest).map((line) => `${line.qty}x ${line.phrase}`) : [];
      await askSignup(phone, copy.signupFormBody(noted), () => askAddress(phone, copy.welcomeAskFullDeliveryAddress()));
    } else if (!savedCep) {
      ctx.flow = "delivery";
      ctx.step = "need_cep";
      await writeCtx(convo.id, ctx);
      await askAddress(phone, copy.welcomeAskCep());
    } else if (
      ctx.step === "awaiting_operator_quote" ||
      ctx.step === "awaiting_supplier_validation" ||
      ctx.step === "awaiting_quote_confirmation" ||
      ctx.step === "payment_issuing" ||
      ctx.step === "awaiting_payment" ||
      (ctx.basket?.length ?? 0) > 0 ||
      (ctx.pending?.length ?? 0) > 0
    ) {
      // "oi" no meio de um pedido em andamento não reapresenta a Lia do zero.
      await reply(phone, copy.greetingMidOrder(ctx.step ?? "collecting", ctx.basket?.length ?? 0));
    } else {
      await reply(phone, copy.greeting());
    }
    return;
  }

  // ---- perguntas de serviço / atendimento (funcionam em QUALQUER step) ----
  if (intent.kind === "service_question") {
    // "vai mudar o frete?"/"quanto ta o frete?" com pedido já cotado → o valor REAL.
    if (
      intent.topic === "fee" &&
      ctx.deliveryFee != null &&
      ctx.step === "awaiting_payment"
    ) {
      await reply(phone, copy.currentFee(ctx.deliveryFee));
      return;
    }
    if (intent.topic === "stores") {
      const onTable = ctx.step === "choosing" && ctx.pending?.length ? ctx.pending[0].options : [];
      await reply(phone, copy.storesAnswer(onTable.map((o) => ({ storeLabel: o.storeLabel }))));
      return;
    }
    await reply(
      phone,
      copy.serviceAnswer(intent.topic, servedAreaLabel(), {
        hasCep: Boolean(user.cep),
        hasBasket: (ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0
      })
    );
    return;
  }
  if (intent.kind === "human") {
    await flagLatestOrder(user.id, `🙋 CLIENTE PEDIU ATENDIMENTO HUMANO: "${text.slice(0, 140)}"`);
    await reply(phone, copy.humanHandoff());
    return;
  }
  if (intent.kind === "complaint") {
    await flagLatestOrder(user.id, `⚠️ RECLAMAÇÃO DO CLIENTE: "${text.slice(0, 140)}"`);
    await reply(phone, copy.complaintAck());
    return;
  }

  // ---- perguntas de confiança/logística: respondem em QUALQUER estado (28/08) ----
  // Depois de responder, a ETAPA em curso é reapresentada — a pergunta lateral fazia
  // os cards "sumirem" e o cliente tinha que pedir de novo (29/08 S7/S12).
  const rePresentStep = async () => {
    if (ctx.step === "choosing" && ctx.pending?.length) {
      await sendChoices(phone, ctx.pending[0]);
    }
  };
  if (intent.kind === "trust_question") {
    await reply(phone, copy.trustAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "third_party_pay") {
    await reply(phone, copy.thirdPartyPayAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "fiscal_question") {
    const businessInfo = process.env.LIA_BUSINESS_INFO?.trim() || undefined;
    await reply(phone, copy.fiscalAnswer(intent.topic, businessInfo));
    // "me fala que eu te envio" não pode ser beco: sem a env, o operador é acionado
    // pra mandar os dados de verdade (29/08 S7).
    if (intent.topic === "cnpj" && !businessInfo) {
      await notifyOwner(`📇 Cliente pediu o CNPJ/dados da empresa — enviar manualmente (configure LIA_BUSINESS_INFO).`, phone);
    }
    await rePresentStep();
    return;
  }
  if (intent.kind === "who_delivers") {
    await reply(phone, copy.whoDeliversAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "price_dispute") {
    await reply(phone, copy.priceDisputeAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "coupon_promo") {
    await reply(phone, copy.couponPromoAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "charge_complaint") {
    await flagLatestOrder(user.id, `💳 RECLAMAÇÃO DE COBRANÇA: "${text.slice(0, 140)}"`);
    await notifyOwner(`💳 URGENTE — cliente relata cobrança indevida/duplicada: "${text.slice(0, 140)}"`, phone);
    await reply(phone, copy.chargeComplaintAck());
    return;
  }
  if (intent.kind === "scheduling_question") {
    await reply(phone, copy.schedulingAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "store_location_question") {
    await reply(phone, copy.storeLocationAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "installments_question") {
    await reply(phone, copy.installmentsAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "meta_probe") {
    await reply(phone, copy.metaProbeAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "insult") {
    await reply(phone, copy.insultAnswer());
    await rePresentStep();
    return;
  }
  // "espera aí/já volto": pausa reconhecida — NADA de busca (28/08 S10/S20).
  if (intent.kind === "hold") {
    await reply(phone, copy.holdAck());
    return;
  }
  // "voltei, onde a gente tava?": resumo do estado + retomada (28/08 S20).
  if (intent.kind === "resume_where") {
    if (ctx.step === "choosing" && ctx.pending?.length) {
      await reply(phone, copy.resumeHeader());
      await sendChoices(phone, ctx.pending[0]);
      return;
    }
    if ((ctx.basket?.length ?? 0) > 0) {
      const items = basketForCopy(ctx);
      const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
      await reply(phone, `${copy.resumeHeader()}\n${copy.partialTotal(items, produtos, ctx.pending?.length ?? 0)}`);
      return;
    }
    if ((ctx.step === "awaiting_quote_confirmation" || ctx.step === "awaiting_payment") && ctx.deliveryOrderId) {
      const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
      if (order && (order.status === "awaiting_quote_confirmation" || order.status === "awaiting_payment")) {
        await reply(phone, `${copy.resumeHeader()}\n${copy.totalAwaitingPayment(order.total)}`);
        return;
      }
    }
    await reply(phone, copy.resumeNothingOpen());
    return;
  }
  // "na vdd quero sim, ainda dá?": recupera a compra recém-cancelada (28/08 S11 —
  // virou busca de "na vdd sim" e produto pra cachorro).
  if (intent.kind === "resume_canceled") {
    const canceled = ctx.lastCanceledOrderId
      ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.lastCanceledOrderId } })
      : await prisma.deliveryOrder.findFirst({
          where: { userId: user.id, status: "canceled", paidAt: null },
          orderBy: { createdAt: "desc" }
        });
    const freshEnough = canceled && Date.now() - canceled.createdAt.getTime() < 6 * 60 * 60 * 1000;
    const items = ((canceled?.items as unknown as BasketItem[]) ?? []).filter((i) => i.unitPrice > 0);
    if (canceled && canceled.status === "canceled" && freshEnough && items.length) {
      const next: DeliveryContext = {
        ...addressOnlyCtx(ctx, user.cep),
        basket: items,
        step: "collecting"
      };
      await continueAfterBasket(phone, convo.id, next, user.cep, copy.canceledOrderResumed());
      return;
    }
    await reply(phone, copy.canceledOrderResumeMissing());
    return;
  }
  if (intent.kind === "cancel_question") {
    const active = await prisma.deliveryOrder.findFirst({
      where: {
        userId: user.id,
        status: { in: ACTIVE_ORDER_STATUSES.filter((status) => !isOrderOutForDelivery(status)) }
      }
    });
    const hasPaidOrder = Boolean(active && PAID_OR_IN_FULFILLMENT_STATUSES.includes(active.status));
    await reply(phone, copy.cancelHowTo(hasPaidOrder));
    return;
  }
  if (intent.kind === "resend_code" || intent.kind === "switch_payment") {
    const order = await prisma.deliveryOrder.findFirst({
      where: { userId: user.id, status: "awaiting_payment" },
      orderBy: { createdAt: "desc" }
    });
    if (!order) {
      const validating = await prisma.deliveryOrder.findFirst({
        where: { userId: user.id, status: { in: ["awaiting_supplier_validation", "payment_issuing"] } },
        orderBy: { createdAt: "desc" }
      });
      if (validating) {
        await reply(phone, copy.supplierValidationPending());
        return;
      }
      await reply(phone, (ctx.basket?.length ?? 0) > 0 ? copy.finishOrderFirst() : copy.noOrdersYet());
      return;
    }
    if (intent.kind === "switch_payment") {
      // "quero mudar a forma de pagamento" sem dizer qual → oferece as duas de novo.
      const method = isCardCharge(order) ? "pix" : "card";
      await switchPaymentMethod(phone, order, method);
    } else if (intent.expired) {
      // Pix expirado: reemitir uma cobrança NOVA em vez de reenviar o código morto.
      await switchPaymentMethod(phone, order, isCardCharge(order) ? "card" : "pix");
    } else {
      await resendCharge(phone, order);
    }
    return;
  }

  // ---- complemento do endereço sozinho ("apto 4", "ap 23", "bloco B apto 31"), 06/10 ----
  // Clara mandou o endereço, o CEP e depois "apto 4": a Lia buscou placa de apartamento.
  // Complemento nunca é produto — entra no endereço salvo, em qualquer passo da conversa.
  const complement = parseAddressComplement(text);
  if (complement && ctx.deliveryAddress && ctx.deliveryAddressVerified && ctx.step !== "need_address") {
    await handleAddressComplement(phone, user.id, convo.id, ctx, complement);
    return;
  }

  // ---- order-level commands (work in ANY step) ----
  // Cartão salvo (modo sem Meta Payments): o toque no botão traz o attemptId; o texto
  // humano ("usar cartão") resolve pela última tentativa pendente do pedido em aberto.
  if (intent.kind === "saved_card_pay") {
    await handleSavedCardPay(phone, user.id, intent.attemptId);
    return;
  }
  if (intent.kind === "saved_card_other") {
    await handleSavedCardOther(phone, user.id);
    return;
  }
  // "2" com cobrança de cartão salvo na mesa = trocar PRO cartão nº 2 da lista
  // numerada (26/08: vários cartões salvos, só o mais recente era oferecido).
  if (intent.kind === "number" && ctx.step === "awaiting_payment" && cardOnFileEnabled()) {
    const order = await prisma.deliveryOrder.findFirst({
      where: { userId: user.id, status: "awaiting_payment" },
      orderBy: { createdAt: "desc" }
    });
    const pending = order ? await findPendingSavedCardAttempt(order.id) : null;
    if (order && pending) {
      const creds = await listOneClickCredentials(user.id);
      const chosen = creds[intent.value - 1];
      if (chosen && chosen.id !== pending.credentialId) {
        await expireOpenPaymentAttempts(order.id);
        await createCardAttempt(order as Parameters<typeof createCardAttempt>[0], {
          id: chosen.id,
          last4: chosen.last4
        });
        return;
      }
      if (chosen) {
        // Escolheu o que já está oferecido: só confirma o caminho.
        await reply(phone, copy.savedCardOffer(order.total, chosen.last4));
        return;
      }
    }
  }
  if (intent.kind === "status") {
    await handleStatus(phone, user.id, ctx, text);
    return;
  }
  if (intent.kind === "paid_claim") {
    await handlePaidClaim(phone, convo.id, user.id, ctx);
    return;
  }
  if (intent.kind === "cancel") {
    await handleCancel(phone, convo.id, user.id, user.cep, ctx, intent.explicitOrder ?? false);
    return;
  }
  // "mais três do mesmo" repete o ÚLTIMO item da cesta pelo sku — nunca nova busca
  // (a busca genérica podia trazer OUTRA marca; rodada 13 dos testes de 14/08).
  if (intent.kind === "add_more_same") {
    // Com substantivo ("mais um desse CAFÉ"), mira o item da cesta que casa com ele;
    // sem substantivo, o último item. Nunca vira nova busca.
    const basket = ctx.basket ?? [];
    const byNoun = intent.noun ? [...basket].reverse().find((item) => itemMatchesPhrase(intent.noun!, item)) : undefined;
    const last = byNoun ?? basket[basket.length - 1];
    if (last) {
      last.qty = Math.min(50, last.qty + intent.qty);
      last.lineTotal = Math.round(last.unitPrice * last.qty * 100) / 100;
      await writeCtx(convo.id, ctx);
      await replyBasketAdjusted(phone, copy.moreOfSameAddedShort(last.qty, last.name), copy.moreOfSameAdded(intent.qty, last.name, last.qty));
      return;
    }
    await reply(phone, copy.askWhatYouWant());
    return;
  }
  // Trocar endereço vale em QUALQUER estado — inclusive nos de ESPERA, que abaixo
  // respondem e retornam (o cliente pedia a troca e recebia de volta o menu de
  // pagamento, podendo pagar uma cotação amarrada ao endereço velho). Como o frete foi
  // calculado pro endereço antigo, uma cotação em aberto cai antes de pedir o CEP novo.
  // Recusa da troca de loja: mantém a cesta e lembra o caminho de completar.
  if (ctx.minSwap && normalizeMsg(text) === "minswap:no") {
    const fromStore = getStore(ctx.minSwap.fromStoreKey);
    ctx.minSwap = undefined;
    await writeCtx(convo.id, ctx);
    await reply(phone, minimumOrderText(ctx, fromStore));
    return;
  }

  // Aceite da troca de loja do pedido mínimo (botão minswap:yes, "trocar de loja" ou
  // um sim com a proposta na mesa). Valida contra a cesta atual: proposta velha morre.
  if (ctx.minSwap && (normalizeMsg(text) === "minswap:yes" || /^troca(r)? de loja$/.test(normalizeMsg(text)) || intent.kind === "affirm")) {
    const swap = ctx.minSwap;
    const basket = ctx.basket ?? [];
    const valid = swap.replacements.every((r) => basket.some((b) => b.sku === r.fromSku));
    ctx.minSwap = undefined;
    if (!valid) {
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.didNotUnderstand());
      return;
    }
    const keep = basket.filter((b) => !swap.replacements.some((r) => r.fromSku === b.sku));
    // O que saiu e o que entrou, com preço: a troca nunca é silenciosa (27/08 S1/S2/S5
    // — café e leite mudaram de marca/gramatura sem anúncio e o cliente só descobriu
    // auditando linha a linha).
    const swappedOut = basket.filter((b) => swap.replacements.some((r) => r.fromSku === b.sku));
    const added = swap.replacements.map((r) =>
      choiceToBasketItem(r.option, r.qty, r.option.storeKey ? getStore(r.option.storeKey) : orderStore(ctx))
    );
    ctx.basket = mergeBaskets(keep, added);
    await writeCtx(convo.id, ctx);
    await continueAfterBasket(phone, convo.id, ctx, user.cep, copy.minimumSwapDone(swapPairsForCopy(swappedOut, swap.replacements)));
    return;
  }

  // Regateio ("faz por 10?", "tem desconto?"): o preço é o mostrado; o caminho barato
  // já existe ("mais barato" reordena). Nunca vira escolha de número nem busca (26/08).
  if (intent.kind === "haggle") {
    await reply(phone, copy.haggleAnswer());
    if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
    return;
  }

  // "Quanto falta?"/"o que peço pra completar?" — responde o mínimo que falta, nunca busca.
  if (intent.kind === "missing_question") {
    const below = conciergeStoresBelowMinimum(ctx)[0];
    if (below) {
      await reply(phone, minimumOrderText(ctx, below));
      if (!ctx.minSwap) await offerMinimumSwap(phone, convo.id, ctx, below);
      return;
    }
    if (ctx.basket?.length) {
      const produtos = Math.round(basketForCopy(ctx).reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
      await reply(phone, copy.partialTotal(basketForCopy(ctx), produtos, ctx.pending?.length ?? 0));
      return;
    }
    await reply(phone, copy.didNotUnderstand());
    return;
  }

  // "Vc salvou o endereço?": confirma o que está em arquivo — nunca vira busca.
  if (intent.kind === "address_question") {
    const saved = ctx.deliveryAddress ?? user.defaultAddress;
    if (saved) {
      await reply(phone, copy.addressUpdated(saved, ctx.cep ?? user.cep ?? undefined));
    } else {
      await askStreetAndNumber(phone, ctx);
    }
    return;
  }

  if (intent.kind === "change_address") {
    // Cobrança já emitida (Pix/cartão vivos): trocar o endereço agora deixaria uma
    // cobrança válida amarrada a um total de outro frete — e a conversa órfã do pedido.
    // O caminho honesto é cancelar primeiro (o cancel contextual estorna nada: não pago).
    if (ctx.step === "awaiting_payment" || ctx.step === "payment_issuing") {
      await reply(phone, copy.addressChangeNeedsCancel());
      return;
    }
    // Pedido ainda SEM preço (fila do operador): sobrevive à troca — o deliveryOrderId
    // fica no contexto e, quando o endereço novo for confirmado, o pedido é atualizado
    // (antes ele ficava órfão no /ops com o endereço velho).
    // `choosing_freight` também é pedido SEM preço na fila do operador (a cotação está
    // calculada mas não publicada), então sobrevive à troca do mesmo jeito — e o frete novo
    // sai pelo CEP novo quando a lista re-cotar.
    const keepOrder = (ctx.step === "awaiting_operator_quote" || ctx.step === "choosing_freight") && Boolean(ctx.deliveryOrderId);
    if (!keepOrder && ctx.deliveryOrderId && (ctx.step === "awaiting_quote_confirmation" || ctx.step === "awaiting_supplier_validation")) {
      const openOrder = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
      if (await cancelPendingRetailerQuote(ctx.deliveryOrderId)) {
        await reply(phone, copy.quoteDroppedForNewAddress());
        // Cesta preservada: com o endereço novo salvo, o fluxo re-cota sozinho.
        ctx.basket = ((openOrder?.items as unknown as BasketItem[]) ?? []).filter((item) => item.unitPrice > 0);
      }
    }
    // A new CEP must never inherit the previous door number/address.
    ctx.deliveryAddress = undefined;
    ctx.deliveryAddressVerified = false;
    ctx.step = "need_cep";
    if (!keepOrder) ctx.deliveryOrderId = undefined;
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.askNewCep());
    return;
  }
  if (ctx.step === "awaiting_operator_quote") {
    // O pedido pode ter morrido por fora (cancelado/estornado no /ops): sem isso a
    // conversa respondia "ainda estou cotando" de um pedido que não existe mais. Limpa e
    // deixa a mensagem seguir como pedido novo.
    if (ctx.deliveryOrderId) {
      const openOrder = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
      if (!openOrder || openOrder.status !== AWAITING_OPERATOR_QUOTE_STATUS) {
        const fresh = addressOnlyCtx(ctx, user.cep);
        for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
        Object.assign(ctx, fresh);
        await writeCtx(convo.id, ctx);
      }
    }
  }
  if (ctx.step === "awaiting_operator_quote") {
    // Pedido NOVO enquanto o operador cota não pode ser engolido (caso real de produção,
    // 07/08: "quero um cotonete" → "segura aí" e o item sumia; o cliente teve que
    // CANCELAR pra conseguir pedir). A cotação ainda não saiu, então item novo entra no
    // MESMO pedido como linha livre — o operador cota tudo junto e vê a adição no /ops.
    if (intent.kind === "free_text" && !isQuestion(text) && ctx.deliveryOrderId) {
      const { lines, containsMedicine } = await extractLines(text);
      if (lines.length) {
        const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
        if (order && order.status === AWAITING_OPERATOR_QUOTE_STATUS) {
          const added = lines.map((line) => conciergeItem(line.phrase, line.qty));
          const items = mergeBaskets((order.items as unknown as BasketItem[]) ?? [], added);
          const addedLabels = added.map((i) => `${i.qty}x ${i.name}`);
          await prisma.deliveryOrder.update({
            where: { id: order.id },
            data: {
              items: items as unknown as object,
              notes: appendOrderNote(order.notes, `➕ Cliente adicionou durante a cotação: ${addedLabels.join(", ")}`)
            }
          });
          const notes: string[] = [];
          if (containsMedicine) notes.push(medicineSkippedCopy());
          notes.push(copy.addedToPendingQuote(addedLabels));
          await replyQuoteNotice(phone, notes.join("\n"));
          await notifyOperator(copy.operatorItemAddedAlert(order.id.slice(-6).toUpperCase(), addedLabels), phone);
          return;
        }
      }
      // A mensagem era SÓ remédio (a extração filtra): responde a recusa certa em vez
      // de fingir que está cotando algo que não pode vender.
      if (!lines.length && containsMedicine) {
        await reply(phone, noMedicineCopy());
        return;
      }
    }
    await replyQuoteNotice(phone, copy.operatorQuoteStillWorking());
    return;
  }
  if (ctx.step === "awaiting_supplier_validation") {
    await reply(phone, copy.supplierValidationPending());
    return;
  }
  if (ctx.step === "payment_issuing") {
    await reply(phone, "Gerando seu pagamento agora. Um instante.");
    return;
  }
  if (ctx.step === "awaiting_quote_confirmation" && ctx.deliveryOrderId) {
    const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
    if (!order || order.status !== "awaiting_quote_confirmation") {
      await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
    } else {
      const method = methodFromIntent(intent);
      if (method) {
        const issued = await issueValidatedRetailerQuotePayment(order.id, method);
        if (issued.unavailable) {
          await handlePreflightUnavailable(phone, convo.id, user, ctx, issued.unavailable);
          return;
        }
        if (issued.expired) {
          await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
          await reply(phone, copy.quoteExpired());
        }
        return;
      }
      if (order.quoteExpiresAt && order.quoteExpiresAt.getTime() <= Date.now()) {
        await cancelPendingRetailerQuote(order.id);
        // A MENSAGEM não morre com a cotação (27/08 r3 S18: o CEP de Campinas chegou
        // depois do TTL e sumiu atrás de "Esse preço venceu"). A cesta volta pro
        // contexto e o texto segue o roteamento normal — troca de endereço, item
        // novo, o que for.
        const revived = {
          ...addressOnlyCtx(ctx, user.cep),
          basket: ((order.items as unknown as BasketItem[]) ?? []).filter((item) => item.unitPrice > 0)
        };
        for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
        Object.assign(ctx, revived);
        await writeCtx(convo.id, ctx);
        await reply(phone, copy.quoteExpired());
        // sem return: o resto do turno processa a mensagem sobre a cesta restaurada
        // (o else-if abaixo NÃO roda — a cotação já morreu)
      }
      // CEP no meio do menu de pagamento ("Antes de pagar, vou entregar em Campinas,
      // CEP 13010-100") é troca de DESTINO — a cotação do endereço velho cai e o CEP
      // segue pro fluxo normal de endereço. Antes, qualquer texto que não fosse
      // pix/cartão devolvia o menu do endereço antigo (3º ciclo, rodada 6).
      else if (intent.kind === "cep") {
        if (await cancelPendingRetailerQuote(order.id)) {
          await reply(phone, copy.quoteDroppedForNewAddress());
        }
        // A CESTA volta do pedido cancelado pro contexto: depois do endereço novo, o
        // fluxo re-cota sozinho (5º ciclo, rodada 6: a Lia "esquecia" a cesta e pedia
        // pra começar de novo).
        ctx.basket = ((order.items as unknown as BasketItem[]) ?? []).filter((item) => item.unitPrice > 0);
        ctx.deliveryOrderId = undefined;
        ctx.deliveryAddress = undefined;
        ctx.deliveryAddressVerified = false;
        // segue para a seção de CEP abaixo, que salva e pede o endereço completo
      } else {
        // Ajuste DEPOIS do total nunca cai no menu de pagamento (27/08 S12/S14): o
        // cliente ainda está decidindo, e empurrar "pix ou cartão" quebra a confiança
        // no exato momento do dinheiro.
        const nq = normalizeMsg(text);
        const wantsFasterDelivery =
          /\b(mais rapid\w*|rapidinho|chega\w* antes|acelera\w*)\b/.test(nq) ||
          (/\brapid|urgent/.test(nq) && /\b(entrega|frete|chega|receber|envio)\b/.test(nq));
        if (wantsFasterDelivery) {
          const alt = ctx.freightChoice?.orderId === order.id ? ctx.freightChoice : undefined;
          const altFresh = alt?.quotedAt ? Date.now() - alt.quotedAt <= quoteAbandonTtlMs() : false;
          if (alt && altFresh) {
            // O anúncio tinha a opção rápida e ela ficou guardada: republica a cotação
            // com o frete/data rápidos — mesmo caminho da escolha original.
            const reclaimed = await prisma.deliveryOrder.updateMany({
              where: { id: order.id, status: "awaiting_quote_confirmation" },
              data: {
                status: AWAITING_OPERATOR_QUOTE_STATUS,
                notes: appendOrderNote(
                  order.notes,
                  `🚚 Cliente trocou para a entrega mais rápida (frete ${copy.brl(alt.rapido.fee)}${alt.rapido.estimate ? `, chega até ${alt.rapido.estimate}` : ""}) — comprar ESSA opção de envio no anúncio.`
                )
              }
            });
            if (reclaimed.count) {
              await publishInstantQuote(order.id, {
                itemsSubtotal: alt.itemsSubtotal,
                serviceFee: alt.serviceFee,
                fee: alt.rapido.fee,
                estimate: alt.rapido.estimate,
                stores: alt.stores
              });
              return;
            }
          }
          await reply(phone, copy.onlyOneShippingMode());
          return;
        }
        // "mais barato" com o total na mesa: é a promessa do haggleAnswer — reabre a
        // última escolha ordenada por preço em vez de repetir o menu de pagamento.
        if (intent.kind === "more_options" && ctx.lastChoice) {
          await cancelPendingRetailerQuote(order.id);
          const restored: DeliveryContext = {
            ...addressOnlyCtx(ctx, user.cep),
            basket: ((order.items as unknown as BasketItem[]) ?? []).filter((item) => item.unitPrice > 0),
            lastChoice: ctx.lastChoice,
            step: "collecting"
          };
          if (await reopenLastChoice(phone, convo.id, restored, intent.cheaper === false ? "more" : "cheaper")) return;
          await writeCtx(convo.id, restored);
          await reply(phone, copy.cheaperAfterQuoteNeedsItem());
          return;
        }
        if (intent.kind === "more_options") {
          await reply(phone, copy.cheaperAfterQuoteNeedsItem());
          return;
        }
        // "quanto ficou mesmo?"/"ver total" com a cotação na mesa: o TOTAL do pedido,
        // nunca o menu seco de pagamento (29/08 S1 — o catch-all interceptava antes
        // do router e a pergunta virava busca/menu).
        if (asksRunningTotal(text)) {
          await reply(phone, copy.totalAwaitingPayment(order.total));
          return;
        }
        // Mudança na CESTA com o total na mesa ("adiciona um óleo", "troca X por Y",
        // "tira o X"): NÃO devolve o menu de pagamento — deixa passar pros handlers de
        // edição, que reabrem o pedido (28/08 S18).
        const basketEdit =
          intent.kind === "swap_item" ||
          intent.kind === "remove_item" ||
          (intent.kind === "free_text" && !isQuestion(text));
        if (!basketEdit) {
          await reply(phone, copy.paymentMethod(order.total, cardTotal(order.total)));
          return;
        }
        // segue: reopenOrderForEdit + handlers de troca/remoção/busca cuidam do resto
      }
    }
  }
  if (intent.kind === "clear_cart") {
    await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
    await reply(phone, copy.cartCleared());
    return;
  }

  // ---- remédio isento (29/09): nome completo + CPF para a compra sair no nome do cliente ----
  // Vem ANTES do CEP: um CPF nunca pode ser lido como CEP. "sem remédio" tira o remédio da
  // cesta e fecha o resto.
  if (ctx.step === "need_cpf" && ctx.cpfOnboarding && !ctx.cpfDraft && !looksLikeCpfAttempt(text)) {
    // Cadastro: sem CPF na mensagem, a pergunta não segura o cliente — o que ele mandou
    // segue como mensagem normal (o CPF volta a ser pedido só no 1º remédio).
    delete ctx.cpfOnboarding;
    ctx.step = "collecting";
    const queued = ctx.pendingRequest;
    ctx.pendingRequest = undefined;
    await writeCtx(convo.id, ctx);
    if (queued) {
      await handleSearch(phone, convo.id, user.cep, ctx, intent.kind === "free_text" ? `${queued}, ${text}` : queued, user.id);
      return;
    }
  } else if (ctx.step === "need_cpf") {
    const n = normalizeMsg(text);
    if (/\b(sem|tira|tirar|remove|remover|nao quero|deixa)\b.*\bremedios?\b/.test(n)) {
      ctx.basket = (ctx.basket ?? []).filter((item) => !isMipItem(item));
      ctx.step = "collecting";
      delete ctx.cpfDraft;
      await writeCtx(convo.id, ctx);
      if (!ctx.basket.length) {
        await reply(phone, copy.cartCleared());
        return;
      }
      await continueAfterBasket(phone, convo.id, ctx, user.cep, copy.medicineRemovedFromBasket());
      return;
    }
    const cpf = extractCpf(text) ?? ctx.cpfDraft?.cpf;
    if (!cpf) {
      if (extractFullName(text) && !looksLikeCpfAttempt(text)) {
        ctx.cpfDraft = { name: extractFullName(text)! };
        await writeCtx(convo.id, ctx);
        await reply(phone, copy.askCpfAfterName());
        return;
      }
      await reply(phone, looksLikeCpfAttempt(text) ? copy.cpfInvalid() : copy.askCpfForMedicine());
      return;
    }
    const name = extractFullName(text) ?? ctx.cpfDraft?.name;
    if (!name) {
      ctx.cpfDraft = { cpf };
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.askFullNameForCpf());
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { cpf, cpfName: name, cpfConsentAt: new Date() } });
    delete ctx.cpfDraft;
    ctx.step = "collecting";
    if (ctx.cpfOnboarding) {
      // Cadastro: segue para o pedido guardado no onboarding, ou pergunta o que ele quer.
      delete ctx.cpfOnboarding;
      const queued = ctx.pendingRequest;
      ctx.pendingRequest = undefined;
      await writeCtx(convo.id, ctx);
      if (queued) {
        await reply(phone, copy.cpfSaved(maskCpf(cpf)));
        await handleSearch(phone, convo.id, user.cep, ctx, queued, user.id);
      } else if (ctx.basket?.length) {
        await continueAfterBasket(phone, convo.id, ctx, user.cep, copy.cpfSaved(maskCpf(cpf)));
      } else {
        await reply(phone, copy.cpfSavedAskItems());
      }
      return;
    }
    await writeCtx(convo.id, ctx);
    await continueAfterBasket(phone, convo.id, ctx, user.cep, copy.cpfSaved(maskCpf(cpf)));
    return;
  }

  // ---- CEP (onboarding, requested change, or spontaneously sent) ----
  if (intent.kind === "cep") {
    await handleNewCep(phone, user.id, convo.id, ctx, intent.cep, Boolean(savedCep), intent.rest, text);
    return;
  }

  // ---- destinatário (11/09): "é pra outra pessoa" ou perfil sem nome ----
  if (intent.kind === "recipient_other") {
    ctx.step = "need_recipient_name";
    ctx.recipientName = undefined;
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.askRecipientName());
    return;
  }
  if (ctx.step === "need_recipient_name") {
    const name = parseRecipientName(text);
    if (!name) {
      await reply(phone, copy.recipientNameInvalid());
      return;
    }
    ctx.recipientName = name;
    ctx.step = "collecting";
    if (!user.name?.trim()) await prisma.user.update({ where: { id: user.id }, data: { name } });
    await writeCtx(convo.id, ctx);
    if ((ctx.basket?.length ?? 0) > 0) {
      await continueAfterBasket(phone, convo.id, ctx, user.cep, copy.recipientNameSaved(name));
    } else {
      await reply(phone, copy.recipientNameSaved(name));
    }
    return;
  }

  // A CEP identifies the neighbourhood, not the door. Do not send an address-like
  // message to a courier until the customer confirms street + number.
  if (ctx.step === "need_address") {
    await handleDeliveryAddress(phone, user.id, convo.id, ctx, user.cep, text);
    return;
  }

  // ---- step need_cep: um número curto ("1", "08") é tentativa de CEP, não escolha ----
  if (ctx.step === "need_cep" && intent.kind === "number") {
    await reply(phone, copy.cepNotFound(text.trim()));
    return;
  }
  // Esperando CEP, veio texto que não é CEP ("é pertinho da padaria São José"):
  // re-pede o CEP — NUNCA vira busca de produto (28/08 S12).
  if (ctx.step === "need_cep" && intent.kind === "free_text" && !extractCep(text)) {
    if (looksLikeDeliveryAddress(text)) {
      await handleDeliveryAddress(phone, user.id, convo.id, ctx, user.cep, text);
      return;
    }
    // Acabou de ouvir "ainda não chego em X" (06/10, M9): lembra o motivo e mostra a saída
    // (endereço de alguém na área); o produto pedido fica anotado pra depois.
    if (ctx.outsideArea) {
      const note = isQuestion(text) ? "" : onboardingNote(text).text;
      if (note) ctx.pendingRequest = ctx.pendingRequest ? `${ctx.pendingRequest}, ${note}` : note;
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.stillOutsideArea(ctx.outsideArea.city, servedAreaLabel()));
      return;
    }
    if (saysNoCep(text)) {
      await reply(phone, copy.dontKnowCep());
      return;
    }
    await reply(phone, copy.cepNeededNotLandmark());
    return;
  }

  // ---- step: cliente escolhendo a ENTREGA do anúncio (barata/lenta × rápida/cara) ----
  // A cotação está calculada e PARADA (nada cobrado): o toque — ou "1"/"2", ou "mais
  // rápido" por texto — publica na hora. Fica ANTES do onboarding de endereço porque lá o
  // texto não reconhecido vira lista de compras, e o toque `frete:barato` acabaria virando
  // item da cesta. Cancelar e trocar endereço são tratados acima e não chegam aqui.
  if (ctx.step === "choosing_freight" && ctx.freightChoice) {
    const n = normalizeMsg(text);
    const choice = ctx.freightChoice;
    // O frete e a DATA vieram da consulta ao anúncio no instante da cotação. Publicar isso
    // muito depois entrega promessa vencida (data possivelmente no passado) numa cotação
    // pagável — e, se o pedido já morreu por fora, `opsPublishManualQuote` lançaria erro a
    // cada toque (loop de genericError, sem saída além de "trocar endereço").
    // Contexto sem `quotedAt` é anterior a esta trava: tratado como velho, porque não dá
    // pra provar que é fresco.
    const quoteAgeMs = choice.quotedAt ? Date.now() - choice.quotedAt : Number.POSITIVE_INFINITY;
    const openOrder = await prisma.deliveryOrder.findUnique({
      where: { id: choice.orderId },
      select: { status: true, notes: true }
    });
    const quotable = openOrder?.status === AWAITING_OPERATOR_QUOTE_STATUS;
    if (!quotable || quoteAgeMs > quoteAbandonTtlMs()) {
      const canceled = quotable
        ? await prisma.deliveryOrder.updateMany({
            where: { id: choice.orderId, status: AWAITING_OPERATOR_QUOTE_STATUS },
            data: {
              status: "canceled",
              notes: appendOrderNote(
                openOrder?.notes ?? null,
                "⏰ Cancelado automático: entrega escolhida muito depois da cotação — frete e data do anúncio já vencidos."
              )
            }
          })
        : { count: 0 };
      // Só limpa a conversa se ela AINDA estiver parada nesta escolha: o operador pode ter
      // publicado a cotação neste exato instante, e o contexto dele (recém-escrito) vale
      // mais que o nosso, que já nasceu velho.
      const stored = readCtx(
        (await prisma.conversation.findUnique({ where: { id: convo.id }, select: { context: true } }))?.context ?? null
      );
      if (stored.step !== "choosing_freight" || stored.freightChoice?.orderId !== choice.orderId) return;
      await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
      await reply(
        phone,
        canceled.count ? copy.staleQuoteRestart(choice.orderId.slice(-6).toUpperCase()) : copy.quoteExpired()
      );
      return;
    }
    let picked: { fee: number; estimate?: string } | undefined;
    let label = "";
    if (n === "frete:barato" || (intent.kind === "number" && intent.value === 1) || /\bbarat|econom|em conta|demorad|devagar/.test(n)) {
      picked = choice.barato;
      label = "mais barata";
    } else if (n === "frete:rapido" || (intent.kind === "number" && intent.value === 2) || /\brapid|urgent|antes|logo|hoje/.test(n)) {
      picked = choice.rapido;
      label = "mais rápida";
    }
    if (!picked) {
      await reply(phone, copy.choiceNotUnderstood());
      await sendFreightChoice(phone, choice);
      return;
    }
    // A escolha vai pra nota ANTES de publicar: é ela que diz ao operador qual opção de
    // envio comprar no anúncio (comprar a errada quebraria a data prometida ao cliente).
    const current = await prisma.deliveryOrder.findUnique({ where: { id: choice.orderId }, select: { notes: true } });
    await prisma.deliveryOrder.update({
      where: { id: choice.orderId },
      data: {
        notes: appendOrderNote(
          current?.notes ?? null,
          choice.kind === "store"
            ? `🚚 Cliente escolheu a entrega ${label} da loja (frete ${copy.brl(picked.fee)}${picked.estimate ? `, ${humanEstimate(picked.estimate) ?? picked.estimate}` : ""}${label === "mais rápida" && choice.rapido.name ? `, opção "${choice.rapido.name}"` : ""}) — comprar com ESSA opção de entrega no site da loja, AGORA (o prazo conta da compra).`
            : `🚚 Cliente escolheu a entrega ${label} (frete ${copy.brl(picked.fee)}${picked.estimate ? `, chega até ${picked.estimate}` : ""}) — comprar ESSA opção de envio no anúncio.`
        )
      }
    });
    await publishInstantQuote(choice.orderId, {
      itemsSubtotal: choice.itemsSubtotal,
      serviceFee: choice.serviceFee,
      fee: picked.fee,
      ...(choice.kind === "store" ? { storeEstimate: picked.estimate } : { estimate: picked.estimate }),
      stores: choice.stores
    });
    return;
  }

  // ---- onboarding: save the complete delivery address once, before the first basket ----
  if (!user.defaultAddress) {
    if (blocksMedicine(text)) {
      await reply(phone, noMedicineCopy());
      return;
    }
    if (intent.kind === "reject") {
      await writeCtx(convo.id, addressOnlyCtx(ctx, null));
      await reply(phone, copy.thanks());
      return;
    }
    // "quanto tá o leite ninho?" é pedido em forma de pergunta (06/10, M2): anota o produto.
    const priceAsk = intent.kind === "free_text" ? parsePriceAsk(text) : null;
    const asking = !priceAsk && intent.kind === "free_text" && isQuestion(text);
    if (asking) {
      await answerOnboardingQuestion(phone, text);
      ctx.flow = "delivery";
      ctx.step = "need_address";
      await writeCtx(convo.id, ctx);
      await askSignup(phone, copy.signupFormBody([], false), () => reply(phone, copy.askAddressWithCep()));
      return;
    }
    // Cliente que abre a conversa mandando o endereço direto (sem "oi") está respondendo
    // à pergunta que ainda nem foi feita — salvar, não tratar como lista de compras
    // ("1x Av Paulista 1000", "1x apto 5").
    if (looksLikeDeliveryAddress(text)) {
      ctx.flow = "delivery";
      await handleDeliveryAddress(phone, user.id, convo.id, ctx, user.cep, text);
      return;
    }
    // Só o que tem cara de produto é anotado (06/10, M1): "sou a Clara Souza", "gostaria de
    // fazer um pedido", "vi o anúncio", história pessoal e "me liga" ficam de fora.
    const note = intent.kind === "free_text" ? onboardingNote(priceAsk ?? text).text : "";
    if (note) {
      ctx.pendingRequest = ctx.pendingRequest ? `${ctx.pendingRequest}, ${note}` : note;
    }
    ctx.flow = "delivery";
    ctx.step = "need_address";
    await writeCtx(convo.id, ctx);
    if (priceAsk && note) await reply(phone, copy.priceAfterAddress(priceAsk));
    const noted = ctx.pendingRequest ? parseBasketLines(ctx.pendingRequest).map((line) => `${line.qty}x ${line.phrase}`) : [];
    await askSignup(phone, copy.signupFormBody(noted), () => askAddress(phone, copy.welcomeAskFullDeliveryAddress(noted)));
    return;
  }

  // ---- onboarding: address saved, but no CEP yet — stash the request, ask the CEP ----
  // O pedido NÃO é resolvido agora (senão o 1º pedido do cliente seria auto-escolhido
  // sem opções nem preço): guarda o texto cru e roda a busca normal depois do CEP.
  if (!savedCep) {
    if (blocksMedicine(text)) {
      await reply(phone, noMedicineCopy());
      return;
    }
    const alreadyAsked = ctx.step === "need_cep";
    if (intent.kind === "reject") {
      // "não"/"deixa" durante o pedido de CEP: estaciona sem insistir.
      await writeCtx(convo.id, addressOnlyCtx(ctx, null));
      await reply(phone, copy.thanks());
      return;
    }
    // Pergunta ("o que vc consegue comprar?") se responde — NUNCA vira item anotado.
    const priceAsk = intent.kind === "free_text" ? parsePriceAsk(text) : null;
    const asking = !priceAsk && intent.kind === "free_text" && isQuestion(text);
    if (asking) {
      await answerOnboardingQuestion(phone, text);
      ctx.flow = "delivery";
      ctx.step = "need_cep";
      await writeCtx(convo.id, ctx);
      await askAddress(phone, copy.askCepAgain());
      return;
    }
    const note = intent.kind === "free_text" ? onboardingNote(priceAsk ?? text).text : "";
    const lines = note ? parseBasketLines(note) : [];
    if (note) {
      ctx.pendingRequest = ctx.pendingRequest ? `${ctx.pendingRequest}, ${note}` : note;
    }
    ctx.flow = "delivery";
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    const noted = ctx.pendingRequest ? parseBasketLines(ctx.pendingRequest).map((l) => `${l.qty}x ${l.phrase}`) : [];
    await reply(
      phone,
      alreadyAsked
        ? lines.length
          ? copy.notedAskCep(noted)
          : copy.askCepAgain()
        : copy.welcomeAskCep(noted)
    );
    return;
  }

  // ---- "quero" / "queria comprar" sozinho: vontade de comprar sem dizer o quê ----
  // Buscar isso viraria "Não entendi seu pedido" (frio). Perguntamos o item; se havia
  // uma escolha aberta, reapresentamos as opções.
  if (intent.kind === "want_items") {
    if (ctx.pending?.length) {
      await sendChoices(phone, ctx.pending[0]);
    } else {
      await reply(phone, copy.askWhatYouWant());
    }
    return;
  }


  // ---- step: customer choosing one of the (max 3) options for an ambiguous item ----
  // "tira X"/"troca X por Y" fall through to the basket-editing handlers below.
  if (
    ctx.step === "choosing" &&
    ctx.pending?.length &&
    intent.kind !== "remove_item" &&
    intent.kind !== "swap_item" &&
    intent.kind !== "pay" &&
    intent.kind !== "choose_payment" &&
    intent.kind !== "done" &&
    // "Ver detalhes"/"detalhes 2" respondem no handler global (que já olha os cards
    // na mesa) sem mexer na escolha — os cards continuam valendo depois do link.
    intent.kind !== "product_details" &&
    intent.kind !== "product_details_tap"
  ) {
    await handleChoosing(phone, user.id, user.cep, convo.id, ctx, text, intent);
    return;
  }


  // ---- step: juntar × pedido novo (pedido não-pago parado + item novo, 01/09) ----
  // Plano B (04/09): o pedido PAGO travou na loja e a Lia ofereceu um substituto
  // verificado. "Trocar" substitui os itens e a compra segue; "Devolver" estorna na hora.
  if (ctx.planB && !ctx.pending?.length) {
    const n = normalizeMsg(text);
    const accept = n === "planb_trocar" || (n.length <= 30 && /^(troca|trocar|troque|sim|pode|quero|ok|beleza|blz|isso|fechado)\b/.test(n));
    const decline = !accept && (n === "planb_devolver" || (n.length <= 40 && /^(devolv|estorn|nao|n|dinheiro|quero o dinheiro|cancela)\b/.test(n)));
    if (accept || decline) {
      const planB = await import("./plan-b");
      if (accept) await planB.acceptPlanB(phone, ctx, convo.id);
      else await planB.declinePlanB(phone, ctx, convo.id);
      return;
    }
    if (ctx.step === "awaiting_plan_b") {
      await reply(phone, copy.planBReask(ctx.planB.substitutes.map((s) => s.to.name)));
      return;
    }
  }

  if (ctx.step === "awaiting_merge_decision" && ctx.mergeDecision) {
    const pendingMerge = ctx.mergeDecision;
    const n = normalizeMsg(text);
    const wantsMerge = n === "juntar_pedido" || n === "1" || /\bjunt/.test(n) || /mesmo pedido/.test(n);
    // "outro" sozinho NÃO conta ("quero outro modelo" é refinamento, e o "novo"
    // cancela um Pix emitido): só "novo", "separado" ou "outro pedido".
    const wantsNew = !wantsMerge && (n === "pedido_novo" || n === "2" || /\b(novo|separado)\b|outro pedido/.test(n));
    if (wantsMerge || wantsNew) {
      ctx.mergeDecision = undefined;
      const order = await prisma.deliveryOrder.findUnique({ where: { id: pendingMerge.orderId } });
      if (order && order.status === "awaiting_payment") {
        const closed = await closeUnpaidOrder(
          order,
          wantsMerge ? "reaberto pelo cliente (juntar item novo)" : "cliente preferiu pedido novo (nada cobrado)"
        );
        if (closed === "card_processing") {
          ctx.mergeDecision = pendingMerge;
          await writeCtx(convo.id, ctx);
          await reply(phone, copy.cardPaymentProcessing());
          return;
        }
        if (closed === "paid") {
          await reply(phone, copy.newItemAfterPayment(pendingMerge.request));
          return;
        }
        if (wantsMerge && !ctx.basket?.length) ctx.basket = ((order.items as unknown) as BasketItem[]) ?? [];
      }
      if (wantsNew) ctx.basket = [];
      ctx.deliveryOrderId = undefined;
      ctx.step = "collecting";
      await writeCtx(convo.id, ctx);
      await reply(phone, wantsMerge ? copy.orderReopened() : copy.newOrderStarted(pendingMerge.orderId.slice(-6).toUpperCase()));
      await handleSearch(phone, convo.id, user.cep, ctx, pendingMerge.request, user.id);
      return;
    }
    // "cancelar" nunca chega aqui (o cancelamento contextual roda antes e mira o
    // pedido aguardando). Qualquer outra coisa re-pergunta — a decisão é binária.
    await reply(phone, `${copy.mergeOrNewOrderPrompt(pendingMerge.orderId.slice(-6).toUpperCase(), pendingMerge.total)}\n1. Juntar no pedido\n2. Pedido novo`);
    return;
  }

  // ---- step: awaiting payment — resend / switch method instead of dead-ending ----
  if (ctx.step === "awaiting_payment" && ctx.deliveryOrderId && (intent.kind === "pay" || intent.kind === "choose_payment")) {
    const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
    if (order && order.status === "awaiting_payment") {
      const wanted = intent.kind === "choose_payment" ? intent.method : intent.kind === "pay" ? intent.method : undefined;
      if (wanted && wanted !== (isCardCharge(order) ? "card" : "pix")) {
        // Rajada "pix"/"cartão" (28/08 S10): a troca deixa claro que o código anterior
        // NÃO vale mais — antes o cliente ficava com Pix vivo e oferta de cartão juntos.
        await reply(phone, copy.previousChargeSuperseded(wanted));
        await switchPaymentMethod(phone, order, wanted);
      } else {
        await resendCharge(phone, order);
      }
      return;
    }
    // Order got paid/canceled meanwhile — fall through to the normal flow.
  }

  // ---- confirm + choose how to pay ----
  // Cotação publicada enquanto a conversa estava em outro assunto (revisão 01/09): o
  // resumo chega rotulado, mas o contexto não aponta pro pedido — "pix"/"cartão" sem
  // cesta nem escolha aberta procura a cotação em aberto do cliente em vez de virar busca.
  const spokenMethod =
    intent.kind === "pay" ? intent.method : intent.kind === "choose_payment" ? intent.method : undefined;
  if (spokenMethod && !(ctx.basket?.length ?? 0) && !(ctx.pending?.length ?? 0) && ctx.step !== "awaiting_quote_confirmation") {
    const quoted = await prisma.deliveryOrder.findFirst({
      where: { userId: user.id, status: "awaiting_quote_confirmation" },
      orderBy: { createdAt: "desc" }
    });
    if (quoted) {
      const result = await issueValidatedRetailerQuotePayment(quoted.id, spokenMethod);
      if (result.unavailable) {
        await handlePreflightUnavailable(phone, convo.id, user, ctx, result.unavailable);
        return;
      }
      if (result.expired) await reply(phone, copy.quoteExpired());
      return;
    }
  }
  const wantsToPay =
    intent.kind === "pay" ||
    intent.kind === "done" ||
    (intent.kind === "choose_payment" && (ctx.basket?.length ?? 0) > 0);
  const directMethod =
    intent.kind === "pay" && intent.method
      ? intent.method
      : intent.kind === "choose_payment" && (ctx.basket?.length ?? 0) > 0
        ? intent.method
        : undefined;
  if (wantsToPay || directMethod) {
    // Concierge: "só isso"/"pagar"/"pix" close the list and hand it to the operator to
    // quote — there is no total to charge until the operator sends the quote.
    {
      // Fechar no meio de uma escolha não descarta o item NEM vira linha livre (regra
      // 11/08: só item com preço entra no pedido) — a Lia pede pra terminar a escolha,
      // que é o único jeito de fechar com total na hora.
      if (ctx.pending?.length) {
        await reply(phone, copy.finishChoiceFirst());
        await sendChoices(phone, ctx.pending[0]);
        return;
      }
      if ((ctx.basket?.length ?? 0) > 0) {
        await continueAfterBasket(phone, convo.id, ctx, user.cep);
        return;
      }
      const openOrder = await prisma.deliveryOrder.findFirst({
        where: { userId: user.id, status: { in: [AWAITING_OPERATOR_QUOTE_STATUS, "awaiting_payment"] } },
        orderBy: { createdAt: "desc" }
      });
      if (openOrder?.status === AWAITING_OPERATOR_QUOTE_STATUS) {
        await replyQuoteNotice(phone, copy.operatorQuoteStillWorking());
        return;
      }
      if (openOrder?.status === "awaiting_payment") {
        await resendCharge(phone, openOrder);
        return;
      }
      await reply(phone, copy.emptyCartPay());
      return;
    }
  }

  // ---- "repete o de sempre" — reorder the last basket (memory) ----
  if (intent.kind === "repeat_last") {
    const last = await prisma.deliveryOrder.findFirst({
      where: { userId: user.id, status: { in: REPEATABLE_DELIVERY_ORDER_STATUSES } },
      orderBy: { createdAt: "desc" }
    });
    const items = (last?.items as unknown as BasketItem[]) ?? [];
    if (!items.length) {
      await reply(phone, copy.noPreviousOrder());
      return;
    }
    // A cesta antiga volta pra CONFERÊNCIA — retomada automática com dinheiro na mesa
    // precisa de um "sim" antes do total/pagamento (27/08 S16).
    const next: DeliveryContext = {
      flow: "delivery",
      basket: items,
      notFound: [],
      step: "collecting",
      repeatConfirm: true,
      cep: user.cep ?? ctx.cep,
      deliveryAddress: ctx.deliveryAddress,
      deliveryAddressVerified: ctx.deliveryAddressVerified
    };
    await writeCtx(convo.id, next);
    await reply(
      phone,
      copy.repeatOrderConfirm(
        items.map((i) => ({ qty: i.qty, name: i.name, total: Math.round(display(i.unitPrice, i.medicine) * i.qty * 100) / 100 }))
      )
    );
    return;
  }

  // ---- edit the basket: swap / remove / comando composto ----
  // "troca o arroz por integral, tira o café e bota 2 leites" numa mensagem só: divide
  // nas fronteiras de verbo e executa em SEQUÊNCIA (28/08 S4 — virava UMA busca e
  // nenhuma das três ordens acontecia). Só entra quando 2+ cláusulas são acionáveis.
  if (intent.kind === "swap_item" || intent.kind === "remove_item" || intent.kind === "free_text") {
    const clauses = splitCommandClauses(text);
    if (clauses.length >= 2) {
      const parsed = clauses.map((c) => ({ clause: c, intent: detectIntent(c) }));
      const actionable = parsed.filter(
        (p) => p.intent.kind === "swap_item" || p.intent.kind === "remove_item" || p.intent.kind === "free_text"
      );
      const edits = parsed.filter((p) => p.intent.kind === "swap_item" || p.intent.kind === "remove_item");
      if (edits.length >= 1 && actionable.length >= 2 && actionable.length === parsed.length) {
        // Com cotação/cobrança na mesa, reabre o pedido antes de editar.
        await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
        // Ordem que fecha certo: remove → ajusta quantidade → troca (a troca re-cota
        // com a cesta FINAL) → busca de item novo por último (abre cards).
        const removes = parsed.filter((p) => p.intent.kind === "remove_item");
        const frees = parsed.filter((p) => p.intent.kind === "free_text");
        const swaps = parsed.filter((p) => p.intent.kind === "swap_item");
        const adjusts: typeof frees = [];
        const searches: typeof frees = [];
        for (const part of frees) {
          const clauseLines = parseBasketLines(part.clause);
          const single = clauseLines.length === 1 ? clauseLines[0] : undefined;
          const existing = single?.qtyExplicit
            ? (ctx.basket ?? []).find((item) => itemMatchesPhrase(single.phrase, item))
            : undefined;
          (single && existing ? adjusts : searches).push(part);
        }
        for (const part of removes) {
          if (part.intent.kind !== "remove_item") continue;
          await handleRemove(phone, convo.id, user.cep, ctx, part.intent.target, { silentIfFound: true });
          if (part.intent.andAdd) searches.push({ clause: part.intent.andAdd, intent: { kind: "free_text" } });
        }
        for (const part of adjusts) {
          // "bota 2 leites" com leite já na cesta = ajuste de quantidade (28/08 S4).
          const single = parseBasketLines(part.clause)[0];
          const existing = (ctx.basket ?? []).find((item) => itemMatchesPhrase(single.phrase, item));
          if (existing) {
            existing.qty = Math.max(1, single.qty);
            existing.lineTotal = Math.round(existing.unitPrice * existing.qty * 100) / 100;
            await writeCtx(convo.id, ctx);
            await replyBasketAdjusted(phone, copy.qtyAdjustedShort(existing.qty, existing.name), copy.qtyAdjusted(existing.qty, existing.name));
          }
        }
        for (const part of swaps) {
          if (part.intent.kind !== "swap_item") continue;
          // "troca o arroz por integral": lado novo de 1 token sem substantivo
          // próprio compõe com o item trocado ("arroz integral").
          const toTokens = queryTokens(part.intent.to);
          const composed =
            toTokens.length === 1 && !sharesProductNoun(part.intent.to, part.intent.from)
              ? `${part.intent.from} ${part.intent.to}`
              : part.intent.to;
          await handleSwap(phone, convo.id, user.cep, ctx, part.intent.from, composed, part.clause, part.intent.attr);
        }
        for (const part of searches) {
          await handleSearch(phone, convo.id, user.cep, ctx, part.clause, user.id);
        }
        // Só removes/ajustes (nada re-cotou nem abriu cards): recap do estado atual,
        // senão a compound "tira X e tira Y" terminava quase muda.
        if (!swaps.length && !searches.length) {
          const items = basketForCopy(ctx);
          const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
          await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0));
        }
        return;
      }
    }
  }
  if (intent.kind === "swap_item") {
    await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
    await handleSwap(phone, convo.id, user.cep, ctx, intent.from, intent.to, text, intent.attr);
    return;
  }
  if (intent.kind === "remove_item") {
    await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
    await handleRemove(phone, convo.id, user.cep, ctx, intent.target, { silentIfFound: Boolean(intent.andAdd) });
    // Multi-intenção "tira o arroz E coloca feijão": o remove acima, o add agora.
    if (intent.andAdd) {
      await handleSearch(phone, convo.id, user.cep, ctx, intent.andAdd, user.id);
    }
    return;
  }

  // ---- "Outras opções"/"mais barato" com a escolha já fechada: reabre a última ----
  if (intent.kind === "more_options") {
    if (await reopenLastChoice(phone, convo.id, ctx, intent.cheaper ? "cheaper" : "more")) return;
    await reply(phone, copy.rejectedAskAgain());
    return;
  }

  // ---- botão "Escolher esse" de uma mensagem antiga, fora de escolha ativa ----
  if (intent.kind === "stale_option_tap") {
    // Card de um carrossel que ainda está na tela (05/10: a opção escolhida não tinha
    // entrega, o cliente tocou em OUTRA do mesmo carrossel e ouviu "conversa antiga"). Sem
    // pedido em andamento, o toque vale: a vitrine é recuperada e a opção entra na cesta.
    const revived = ctx.deliveryOrderId ? null : await reviveTappedOption(convo.id, ctx, intent.sku);
    if (revived) {
      ctx.pending = [revived.pending, ...(ctx.pending ?? [])];
      const store = getStore(revived.option.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
      await confirmChosenOption(phone, convo.id, ctx, user.cep, store, revived.pending, revived.option);
      return;
    }
    await reply(phone, copy.staleButtonTap(false));
    return;
  }

  // ---- "Ver detalhes" (botão optinfo:<sku>) e "detalhes 2" digitado (dono, 01/09):
  // responde com a PÁGINA REAL do produto — reviews, fotos, specs, tudo que o cliente
  // veria no ML/na loja. Não mexe em estado nenhum: os cards continuam valendo.
  if (intent.kind === "product_details_tap" || intent.kind === "product_details") {
    const activeOptions = ctx.pending?.[0]?.options ?? ctx.lastChoice?.options ?? [];
    if (intent.kind === "product_details_tap") {
      // O intent vem do texto normalizado (minúsculas); os skus reais têm caixa mista.
      const wanted = intent.sku.toLowerCase();
      const hit =
        activeOptions.find((o) => o.sku.toLowerCase() === wanted) ??
        (ctx.basket ?? []).find((b) => b.sku.toLowerCase() === wanted);
      if (hit?.productUrl) await reply(phone, copy.productDetailsLink(hit.name, hit.productUrl));
      else if (hit) await reply(phone, copy.productDetailsUnavailable());
      else await reply(phone, copy.productDetailsWhich());
      return;
    }
    if (intent.ordinal) {
      const picked = activeOptions[intent.ordinal - 1];
      if (picked?.productUrl) await reply(phone, copy.productDetailsLink(picked.name, picked.productUrl));
      else if (picked) await reply(phone, copy.productDetailsUnavailable());
      else await reply(phone, copy.productDetailsWhich());
      return;
    }
    const linked = activeOptions
      .filter((o) => Boolean(o.productUrl))
      .map((o) => ({ name: o.name, url: o.productUrl! }));
    if (linked.length > 1) await reply(phone, copy.productDetailsList(linked));
    else if (linked.length === 1) await reply(phone, copy.productDetailsLink(linked[0].name, linked[0].url));
    else if (activeOptions.length) await reply(phone, copy.productDetailsUnavailable());
    else await reply(phone, copy.productDetailsWhich());
    return;
  }

  // ---- "não era isso" outside the choice step ----
  if (intent.kind === "reject") {
    await reply(phone, copy.rejectedAskAgain());
    return;
  }

  // ---- a lone "show!"/"perfeito" with nothing to confirm — friendly ack, not a search ----
  if (intent.kind === "affirm") {
    // "sim" confirmando a recompra do "o de sempre": fecha o total (27/08 S16).
    if (ctx.repeatConfirm && ctx.basket?.length) {
      ctx.repeatConfirm = undefined;
      await continueAfterBasket(phone, convo.id, ctx, user.cep);
      return;
    }
    // "👍"/"sim" com cards na mesa: qual deles? Re-pergunta em vez de "de nada" —
    // agradecer no meio da escolha parecia ignorar o cliente (28/08 S2).
    if (ctx.step === "choosing" && ctx.pending?.length) {
      await reply(phone, copy.choiceNotUnderstood());
      await sendChoices(phone, ctx.pending[0]);
      return;
    }
    await reply(phone, copy.thanks());
    return;
  }

  // ---- a bare number with nothing to select ----
  if (intent.kind === "number") {
    // "4" logo depois de um item entrar na cesta = ajuste de quantidade do ÚLTIMO item
    // (rodada 13 dos testes de 14/08: o cliente tentou corrigir a quantidade assim e
    // recebeu "não entendi"). Fora desse contexto, segue o honesto "não entendi".
    const last = ctx.basket?.[ctx.basket.length - 1];
    if (last && intent.value >= 1 && intent.value <= 50 && (ctx.step === "collecting" || ctx.step === undefined)) {
      last.qty = intent.value;
      last.lineTotal = Math.round(last.unitPrice * last.qty * 100) / 100;
      await writeCtx(convo.id, ctx);
      await replyBasketAdjusted(phone, copy.qtyAdjustedShort(last.qty, last.name), copy.qtyAdjusted(last.qty, last.name));
      return;
    }
    await reply(phone, copy.didNotUnderstand());
    return;
  }

  // ---- "quanto deu tudo?"/"resumo" → responde pelo estado, nunca vira busca ----
  if (asksRunningTotal(text)) {
    if (ctx.step === "awaiting_payment" && ctx.total) {
      await reply(phone, copy.totalAwaitingPayment(ctx.total));
      return;
    }
    // Cobrança/cotação na mesa mas ctx sem total (o contexto pós-emissão só guarda o
    // id): busca no PEDIDO — "quanto ficou mesmo?" virava busca de produto (29/08 S1).
    if (
      (ctx.step === "awaiting_payment" || ctx.step === "awaiting_quote_confirmation") &&
      ctx.deliveryOrderId
    ) {
      const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
      if (order && (order.status === "awaiting_payment" || order.status === "awaiting_quote_confirmation")) {
        await reply(phone, copy.totalAwaitingPayment(order.total));
        return;
      }
    }
    if ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0) {
      const items = basketForCopy(ctx);
      const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
      await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0));
      return;
    }
  }

  // ---- awaiting_payment + item novo ----
  // "ah, e adiciona um leite" logo depois da cobrança: reabre e funde (fluxo de sempre).
  // MAS pedido parado há tempo + item novo do nada é outra MISSÃO de compra (caso real
  // 01/09: livro esperando Pix há 2h + "preciso de um apoio pra guitarra" → a Lia fundiu
  // sozinha e declarou "o total anterior não vale mais"). Agora ela PERGUNTA: juntar ou
  // pedido novo? Adicionar explícito ("adiciona/bota/põe/mais um") sempre funde.
  if (ctx.step === "awaiting_payment" && ctx.deliveryOrderId && intent.kind === "free_text" && !isQuestion(text)) {
    const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
    if (order && order.status === "awaiting_payment") {
      const explicitAdd = /\b(adiciona|acrescenta|inclui|bota|coloca|poe|põe|mais um|mais uma)\b/.test(normalizeMsg(text));
      const issuedAt = ctx.paymentIssuedAt ?? order.updatedAt.getTime();
      const chargeFresh = Date.now() - issuedAt < 10 * 60_000;
      if (!explicitAdd && !chargeFresh) {
        // 04/09 (dono): pedido parado + item novo do nada = pedido NOVO, sem perguntar
        // ("se ele esquece do outro e pede outra coisa, só dá o que ele pede"). O antigo
        // fica como está — o Pix dele continua válido até vencer — e a conversa segue com
        // o que o cliente pediu agora.
        const fresh = addressOnlyCtx(ctx, user.cep);
        for (const key of Object.keys(ctx)) delete (ctx as unknown as Record<string, unknown>)[key];
        Object.assign(ctx, fresh);
        await writeCtx(convo.id, ctx);
        await handleSearch(phone, convo.id, user.cep, ctx, text, user.id);
        return;
      }
      const closed = await closeUnpaidOrder(order, "reaberto pelo cliente (item novo)");
      if (closed === "card_processing") {
        await reply(phone, copy.cardPaymentProcessing());
        return;
      }
      if (closed === "paid") {
        await reply(phone, copy.newItemAfterPayment(text));
        return;
      }
      if (!ctx.basket?.length) ctx.basket = ((order.items as unknown) as BasketItem[]) ?? [];
      ctx.deliveryOrderId = undefined;
      ctx.step = "collecting";
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.orderReopened());
    }
  }

  // ---- default: treat as a product request ----
  // Classificar ANTES de buscar (revisão 02/09): a busca era o default de tudo que não
  // casava com intent, e frase/pergunta virava produto ("seu Jorge aqui" → Imagem de São
  // Jorge). Frase solta passa pelo roteador primeiro; lista de compras evidente vai
  // direto pra busca (custo/latência). Sem OpenAI o roteador devolve null e nada muda.
  if (classifyFirstEnabled() && intent.kind === "free_text" && !looksLikeProductList(text)) {
    if (await tryLlmInterpret(phone, convo.id, user.cep, ctx, text, user.id)) return;
  }
  // Item novo com cotação na mesa ("adiciona um óleo" em awaiting_quote_confirmation):
  // reabre o pedido pra cesta antiga não se perder (28/08 S18).
  if (
    intent.kind === "free_text" &&
    !isQuestion(text) &&
    (ctx.step === "awaiting_quote_confirmation" || ctx.step === "choosing_freight")
  ) {
    await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
  }
  await handleSearch(phone, convo.id, user.cep, ctx, text, user.id);
}

// ---------- intent handlers ----------

// "pedido de ONTEM/anterior": o cliente está perguntando do passado — a cesta em
// montagem e o pedido da conversa atual não são o assunto (27/08 S2).
function asksPastOrder(text?: string): boolean {
  if (!text) return false;
  return /\b(ontem|anteontem|semana passada|outro dia|(da |a )?ultima vez|anterior|(meu |o )?outro pedido|de antes)\b/.test(
    normalizeMsg(text)
  );
}

async function handleStatus(phone: string, userId: string, ctx: DeliveryContext, text?: string) {
  if (asksPastOrder(text)) {
    const past =
      (await prisma.deliveryOrder.findFirst({
        where: {
          userId,
          status: { in: ACTIVE_ORDER_STATUSES },
          ...(ctx.deliveryOrderId ? { id: { not: ctx.deliveryOrderId } } : {})
        },
        orderBy: { createdAt: "desc" }
      })) ??
      (await prisma.deliveryOrder.findFirst({
        where: { userId, ...(ctx.deliveryOrderId ? { id: { not: ctx.deliveryOrderId } } : {}) },
        orderBy: { createdAt: "desc" }
      }));
    if (past) {
      await reply(
        phone,
        copy.orderStatusLine({
          shortId: past.id.slice(-6).toUpperCase(),
          status: past.status,
          trackingUrl: past.courierTrackingUrl,
          paid: Boolean(past.paidAt),
          dateLabel: orderDateLabel(past.createdAt),
          itemsPreview: orderItemsPreview(past.items)
        })
      );
      return;
    }
    await reply(phone, copy.noOrdersYet());
    return;
  }
  // A COMPRA EM ANDAMENTO na conversa vence qualquer pedido velho: "quanto ficou? e
  // quando chega?" com a cesta na mesa é pergunta sobre a compra ATUAL — no teste de
  // 26/08 (sessão 5), a resposta foi um pedido cancelado de outro dia + "estorno a
  // caminho", e o cliente abandonou.
  const ctxOrder = ctx.deliveryOrderId
    ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } })
    : null;
  if (!ctxOrder && ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0)) {
    const items = basketForCopy(ctx);
    const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
    await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0));
    return;
  }
  // Cancelou agora há pouco e perguntou "cadê meu pedido?": o assunto é o CANCELADO.
  // Sem essa memória, o fallback achava um pedido pago antigo e respondia como se o
  // cancelamento nunca tivesse acontecido (27/08 S17: "#YAQHF8 confirmado..." depois
  // de "Cancelado. Nada foi cobrado." leu como pedido ressuscitado).
  if (!ctxOrder && ctx.lastCanceledOrderId) {
    const canceled = await prisma.deliveryOrder.findUnique({ where: { id: ctx.lastCanceledOrderId } });
    if (canceled && canceled.status === "canceled") {
      let msg = copy.orderStatusLine({
        shortId: canceled.id.slice(-6).toUpperCase(),
        status: canceled.status,
        paid: Boolean(canceled.paidAt),
        dateLabel: orderDateLabel(canceled.createdAt),
        itemsPreview: orderItemsPreview(canceled.items)
      });
      const paidActive = await prisma.deliveryOrder.findFirst({
        where: { userId, status: { in: ACTIVE_ORDER_STATUSES }, paidAt: { not: null } },
        orderBy: { createdAt: "desc" }
      });
      if (paidActive) {
        msg += `\n\n${copy.alsoActiveOrder({
          shortId: paidActive.id.slice(-6).toUpperCase(),
          dateLabel: orderDateLabel(paidActive.createdAt),
          itemsPreview: orderItemsPreview(paidActive.items)
        })}`;
      }
      await reply(phone, msg);
      return;
    }
  }
  // Pedido ATIVO vence pedido morto: status nunca responde um cancelado antigo quando
  // existe um vivo — e um cancelado só entra quando é tudo que o cliente tem.
  const order =
    ctxOrder ??
    (await prisma.deliveryOrder.findFirst({
      where: { userId, status: { in: ACTIVE_ORDER_STATUSES } },
      orderBy: { createdAt: "desc" }
    })) ??
    (await prisma.deliveryOrder.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }));
  if (!order) {
    // "que horas chega?" sem pedido = pergunta de PRAZO, não de status.
    if (text && /\b(chega|demora|horas|prazo|falta)\b/.test(normalizeMsg(text))) {
      await reply(phone, copy.serviceAnswer("eta", servedAreaLabel()));
    } else {
      await reply(phone, copy.noOrdersYet());
    }
    return;
  }
  const statusLine = copy.orderStatusLine({
    shortId: order.id.slice(-6).toUpperCase(),
    status: order.status,
    trackingUrl: order.courierTrackingUrl,
    paid: Boolean(order.paidAt),
    dateLabel: orderDateLabel(order.createdAt),
    itemsPreview: orderItemsPreview(order.items)
  });
  // "quando chega o DE HOJE?" sem pedido de hoje: diz isso antes de citar o antigo —
  // repetir só o antigo parecia que a compra de hoje tinha sido paga (28/08 S17).
  const asksToday = Boolean(text && /\b(de hoje|o de agora|pedido de hoje)\b/.test(normalizeMsg(text)));
  if (asksToday && orderDateLabel(order.createdAt) !== undefined) {
    await reply(phone, `${copy.noOrderToday()} O que tenho em andamento é: ${statusLine}`);
    return;
  }
  await reply(phone, statusLine);
}

// "paguei": in sandbox (mock charge) it approves; with a REAL charge we VERIFY with
// Mercado Pago before believing it — a text message can't mark a real order paid.
async function handlePaidClaim(phone: string, convoId: string, userId: string, ctx: DeliveryContext) {
  const order =
    (ctx.deliveryOrderId
      ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } })
      : null) ??
    (await prisma.deliveryOrder.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }));
  if (!order) {
    await reply(phone, copy.noOrdersYet());
    return;
  }
  if (order.status !== "awaiting_payment") {
    if (PAID_OR_IN_FULFILLMENT_STATUSES.includes(order.status)) {
      await reply(phone, copy.alreadyPaid());
    } else {
      await reply(
        phone,
        copy.orderStatusLine({
          shortId: order.id.slice(-6).toUpperCase(),
          status: order.status,
          trackingUrl: order.courierTrackingUrl,
          paid: Boolean(order.paidAt),
          dateLabel: orderDateLabel(order.createdAt),
          itemsPreview: orderItemsPreview(order.items)
        })
      );
    }
    return;
  }
  // Cobrança mock só existe sem credencial (dev/testes). Com token real, um id "mock"
  // é resíduo — nunca autorização de pagamento: cai na verificação normal abaixo.
  const isMock = paymentsAreMocked() && (order.pixId ?? "").startsWith("mock");
  if (isMock) {
    await markDeliveryOrderPaid(order.id, { provider: "mock", paymentId: order.pixId, amount: order.total });
    await writeCtx(convoId, addressOnlyCtx(ctx));
    return;
  }
  if (isCardCharge(order)) {
    await reply(phone, copy.cardPending());
    return;
  }
  const status = await pixAdapter.getStatus(order.pixId ?? "");
  if (status === "approved") {
    // Evidência real (id + valor) vem do próprio MP; sem ela o flip continua valendo.
    const { getMercadoPagoPayment } = await import("@/lib/payments/mercadopago");
    const details = await getMercadoPagoPayment(order.pixId ?? "");
    await markDeliveryOrderPaid(
      order.id,
      details
        ? { provider: "mercadopago", paymentId: details.id, amount: details.amount, feeAmount: details.feeAmount, netAmount: details.netAmount }
        : undefined
    );
    await writeCtx(convoId, addressOnlyCtx(ctx));
    return;
  }
  if (status === "expired") {
    await markPixExpired(order.id, order.pixId ?? "");
    return;
  }
  await reply(phone, copy.pixNotSeenYet());
}

// Testadora no grupo (06/10): "quando cancelado faz a pergunta com algumas opções de motivo,
// por exemplo: valor frete, valor produto, comprei outro app, desisti da compra". Lista de
// tocar no Meta; fora dele (ou se falhar), a mesma lista numerada em texto.
async function askCancelReason(phone: string) {
  try {
    const sent = await whatsappAdapter.sendListMessage(phone, {
      body: copy.cancelReasonAsk(),
      buttonText: "Escolher motivo",
      sections: [{ rows: copy.CANCEL_REASON_OPTIONS.map((o) => ({ id: `cancelmotivo:${o.key}`, title: o.title })) }]
    });
    if (sent) {
      markTurnReplied();
      return;
    }
  } catch (error) {
    console.warn("[whatsapp:cancel-reason:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, copy.cancelReasonAskText());
}

async function recordCancelReason(orderId: string | undefined, reason: string) {
  const label = copy.cancelReasonLabel(reason);
  console.log("[cancel-reason]", reason, orderId ?? "-");
  if (!orderId) return;
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
  if (!order) return;
  await prisma.deliveryOrder.update({ where: { id: orderId }, data: { notes: appendOrderNote(order.notes, `📝 Motivo do cancelamento (cliente): ${label}`) } });
}

async function handleCancel(
  phone: string,
  convoId: string,
  userId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  explicitOrder: boolean
) {
  // Mid-cart (not charged yet): "cancelar" just clears the basket — UNLESS the
  // customer said "cancela o PEDIDO", which targets the committed order even when a
  // new basket is being assembled on top of it.
  // Escolha aberta (opções na tela / pergunta de quantidade) também é "carrinho em
  // montagem": "cancelar" limpa, em vez de "não achei pedido" deixando a escolha viva.
  if (
    ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0) &&
    ctx.step !== "awaiting_payment" &&
    !explicitOrder
  ) {
    await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
    await reply(phone, copy.cartCleared());
    return;
  }
  const order =
    (ctx.deliveryOrderId
      ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } })
      : null) ??
    (await prisma.deliveryOrder.findFirst({
      where: { userId, status: { in: explicitOrder ? ACTIVE_ORDER_STATUSES : CANCELABLE_FALLBACK_STATUSES } },
      orderBy: { createdAt: "desc" }
    }));
  if (!order || !ACTIVE_ORDER_STATUSES.includes(order.status)) {
    // O contexto ainda aponta pra um pedido que não está mais ativo (cancelado/estornado
    // no /ops): "não tem pedido pra cancelar" não podia deixar o passo velho vivo — o
    // cliente ficava preso ouvindo "ainda estou cotando", ou sem saída na escolha de frete.
    if (ctx.deliveryOrderId) {
      const fresh = addressOnlyCtx(ctx, userCep);
      // Lista em montagem sobrevive: quem disse "cancela o PEDIDO" não pediu pra apagá-la.
      if (ctx.pending?.length) {
        fresh.pending = ctx.pending;
        fresh.step = "choosing";
      } else if (ctx.basket?.length) {
        fresh.basket = ctx.basket;
        fresh.step = "collecting";
      }
      await writeCtx(convoId, fresh);
    }
    // Existe um pedido PAGO em andamento? A recusa nomeia ELE — sem isso o cliente do
    // teste de 26/08 ouviu "depois do pagamento não dá" sem saber de qual pedido.
    const paidActive = await prisma.deliveryOrder.findFirst({
      where: { userId, status: { in: ACTIVE_ORDER_STATUSES }, paidAt: { not: null } },
      orderBy: { createdAt: "desc" }
    });
    await reply(
      phone,
      copy.nothingToCancel(
        paidActive
          ? {
              shortId: paidActive.id.slice(-6).toUpperCase(),
              dateLabel: orderDateLabel(paidActive.createdAt),
              itemsPreview: orderItemsPreview(paidActive.items)
            }
          : undefined
      )
    );
    return;
  }
  // O contexto limpo LEMBRA qual pedido acabou de ser cancelado: "cadê meu pedido?"
  // em seguida fala dele primeiro (27/08 S17).
  const canceledCtx = { ...addressOnlyCtx(ctx, userCep), lastCanceledOrderId: order.id, cancelReason: { orderId: order.id, askedAt: Date.now() } };
  if (order.status === AWAITING_OPERATOR_QUOTE_STATUS) {
    await prisma.deliveryOrder.update({ where: { id: order.id }, data: { status: "canceled" } });
    await writeCtx(convoId, canceledCtx);
    await reply(phone, copy.canceledUnpaid());
    await askCancelReason(phone);
    return;
  }
  if (order.status === "awaiting_supplier_validation" || order.status === "awaiting_quote_confirmation") {
    await cancelPendingRetailerQuote(order.id);
    await writeCtx(convoId, canceledCtx);
    await reply(phone, copy.canceledUnpaid());
    await askCancelReason(phone);
    return;
  }
  if (order.status === "awaiting_payment") {
    const closed = await closeUnpaidOrder(order, "cancelado pelo cliente (nada cobrado)");
    if (closed === "card_processing") {
      await reply(phone, copy.cardPaymentProcessing());
      return;
    }
    if (closed === "paid") {
      // O pagamento caiu no mesmo instante: o webhook já reiniciou a conversa e avisou.
      await reply(phone, copy.cancelRequestedPaid());
      return;
    }
    await writeCtx(convoId, canceledCtx);
    await reply(phone, copy.canceledUnpaid());
    await askCancelReason(phone);
    return;
  }
  if (isOrderOutForDelivery(order.status)) {
    await reply(phone, copy.cancelTooLate());
    return;
  }
  // Pedido PAGO (11/09, CDC art. 49): enquanto a compra na loja não saiu, o cliente pode
  // desistir e o estorno é imediato pelo provedor. Se a compra já está em curso (clique,
  // Pix da loja, carrinho com o dono) ou já tem número na loja, vale a regra antiga.
  const { customerWithdrawRefund } = await import("./ops-lifecycle");
  const outcome = await customerWithdrawRefund(order.id);
  if (outcome.ok) {
    await writeCtx(convoId, canceledCtx);
    await reply(phone, copy.withdrawnRefunded(outcome.amount));
    await askCancelReason(phone);
    return;
  }
  await reply(phone, copy.cancelRequestedPaid());
}

async function handleNewCep(
  phone: string,
  userId: string,
  convoId: string,
  ctx: DeliveryContext,
  cep: string,
  hadCepBefore: boolean,
  // Itens que vieram JUNTO do CEP ("meu cep é X, quero arroz e leite") — processados
  // depois de salvar o endereço, nunca descartados. Já vem normalizado (sem acento/
  // pontuação), o que serve pra busca mas não pra endereço — daí o rawText.
  restItems?: string,
  // Mensagem original. O endereço que vai pro courier tem que sair daqui: "Av Paulista
  // 1000, apto 5" não pode virar "av paulista 1000 apto 5" no rótulo da entrega.
  rawText?: string,
  // 06/10: o cliente já disse "sim" à troca do CEP / à cidade diferente da do CEP.
  opts?: { swapConfirmed?: boolean; cityConfirmed?: boolean }
) {
  const normalizedCep = cep.replace(/\D/g, "");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { cep: true, defaultAddress: true } });
  // O CEP anterior é o da conversa OU o do cadastro: com o contexto limpo (ctx.cep vazio) o
  // CEP novo era gravado por cima do endereço antigo sem ninguém perceber (06/10, A4).
  const previousCep = (ctx.cep ?? user?.cep ?? "").replace(/\D/g, "") || undefined;
  const cepChanged = Boolean(previousCep && previousCep !== normalizedCep);
  const { address, street, district, city, uf, invalid } = await expandCep(cep);
  if (invalid) {
    ctx.step = "need_cep";
    await writeCtx(convoId, ctx);
    await reply(phone, copy.cepNotFound(cep));
    return;
  }

  // Trava de cobertura: nunca aceita um pedido pago que a operação não entrega. Fora da
  // área → grava o lead (vira mapa de demanda no /ops) e NÃO persiste o CEP nem cota.
  // The active concierge has a hard state boundary. Legacy catalog mode keeps its
  // configurable city/preset behavior for compatibility with the conversation evals.
  const area = { covered: isServedState({ cep, city, uf }), city, uf };
  if (!area.covered) {
    await recordWaitlistLead({ phone, cep, city, uf, reason: "outside_coverage" });
    // A mensagem seguinte ("quero shampoo", "e se for pra SP?") lembra o motivo (06/10, M9).
    // Quem já tem endereço confirmado continua com ele: o passo não vira "manda o CEP".
    const keepsAddress = Boolean(ctx.deliveryAddress && ctx.deliveryAddressVerified && user?.defaultAddress);
    if (!keepsAddress) {
      ctx.step = "need_cep";
      ctx.outsideArea = { city };
    }
    await writeCtx(convoId, ctx);
    await reply(phone, copy.outsideCoverage(city, servedAreaLabel()));
    return;
  }

  // O que veio além do CEP (06/10): endereço com número (com ou sem pedido junto), só o
  // número (a rua vem do CEP), só a rua sem número, ou itens.
  const raw = rawText ?? "";
  const split = raw ? splitAddressAndItems(raw) : null;
  const rawRest = raw
    .replace(CEP_RE_GLOBAL, " ")
    .replace(/\b(?:o\s+)?(?:meu\s+)?(?:novo\s+)?cep\s*(?:[eé]|eh|:)?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const place = { street, district, city };
  const house = !split && rawRest ? parseHouseNumberReply(rawRest, place) : null;
  const streetOnly = !split && !house && Boolean(rawRest) && mentionsStreetWithoutNumber(rawRest, street);
  const firstAddress = !user?.defaultAddress;
  // Antes do cadastro, só o que tem cara de produto vira item (cortesia e apresentação não).
  const items = split
    ? (split.items ? onboardingNote(split.items).text : "") || undefined
    : house || streetOnly
      ? undefined
      : firstAddress && rawRest
        ? onboardingNote(rawRest).text || undefined
        : restItems;

  // Cliente com endereço confirmado mandou um CEP solto (A4): pergunta antes de trocar. O
  // endereço salvo continua valendo; "deixa o antigo" ou qualquer pedido segue com ele.
  const hasConfirmed = Boolean(ctx.deliveryAddress && ctx.deliveryAddressVerified && user?.defaultAddress);
  const quietSteps: Array<DeliveryContext["step"]> = [undefined, "collecting", "choosing"];
  if (cepChanged && hasConfirmed && !split && !house && !opts?.swapConfirmed && quietSteps.includes(ctx.step)) {
    ctx.cepSwap = { cep, askedAt: Date.now(), ...(items ? { items } : {}) };
    await writeCtx(convoId, ctx);
    await reply(phone, copy.confirmCepSwap(cep, place, ctx.deliveryAddress!));
    return;
  }

  // CEP de uma cidade, endereço escrito com outra (A5): nada é salvo antes de confirmar.
  if (split && city && !opts?.cityConfirmed) {
    const typedCity = typedCityMismatch(split.address, city, uf);
    if (typedCity) {
      ctx.cepCityCheck = { cep, raw, askedAt: Date.now(), via: "cep" };
      await writeCtx(convoId, ctx);
      await reply(phone, copy.cepCityMismatch(cep, city, typedCity));
      return;
    }
  }

  if (cepChanged && user?.defaultAddress && previousCep && !ctx.previousAddress) {
    ctx.previousAddress = { cep: `${previousCep.slice(0, 5)}-${previousCep.slice(5)}`, address: user.defaultAddress, city: ctx.city, uf: ctx.uf };
  }
  ctx.outsideArea = undefined;
  ctx.cepSwap = undefined;
  ctx.cepCityCheck = undefined;
  ctx.cep = cep;
  ctx.city = city ?? ctx.city;
  ctx.uf = uf ?? ctx.uf;
  ctx.cepPlace = { street, district };
  // ViaCEP's street fragment is useful context but cannot be sent as the final
  // courier destination. A confirmed address remains valid only for the same CEP.
  if (cepChanged || !ctx.deliveryAddressVerified) {
    ctx.deliveryAddress = address;
    ctx.deliveryAddressVerified = false;
  }
  ctx.flow = "delivery";
  await prisma.user.update({ where: { id: userId }, data: { cep } });
  // "Av Paulista 1000, Bela Vista, São Paulo, 01310-100" é UMA mensagem com endereço E
  // CEP — o jeito mais natural de responder. Desde 06/10 o endereço é SEPARADO do pedido
  // que veio junto ("quero 2 sabonetes, entrega em Rua X 221 … 01233020"): antes o texto
  // inteiro virava o endereço da etiqueta e os itens sumiam. Só o número ("meu cep é X e o
  // número é 1500") monta o endereço com a rua do CEP.
  const typedAddress = split?.address
    ? split.address
    : house && street && !ctx.deliveryAddressVerified
      ? buildSignupAddress({ street, numero: house.numero, complemento: house.complemento, district, city, uf })
      : undefined;
  if (typedAddress) {
    ctx.deliveryAddress = typedAddress;
    ctx.deliveryAddressVerified = true;
    await prisma.user.update({ where: { id: userId }, data: { defaultAddress: typedAddress } });
  }
  // Itens enviados na MESMA mensagem do CEP — ou guardados no onboarding — entram no
  // fluxo NORMAL de busca (com opções e preço), nunca auto-escolhidos.
  const queued = [items, ctx.pendingRequest].filter(Boolean).join(", ").trim();
  ctx.pendingRequest = queued || undefined;
  if (!ctx.deliveryAddressVerified) {
    ctx.step = "need_address";
    await writeCtx(convoId, ctx);
    await askStreetAndNumber(phone, ctx);
    return;
  }

  // Fim do cadastro = 1º endereço completo OU 1º CEP (06/10, M11: o CEP salvo antes do
  // endereço fazia o 1º endereço sair como "atualizado" e o CPF nunca ser pedido).
  const completingSignup = firstAddress || !hadCepBefore;
  const shownAddress = ctx.deliveryAddress ?? cep;
  const savedMsg = completingSignup ? copy.addressSavedPrefix(shownAddress, ctx.cep) : copy.addressUpdated(shownAddress, ctx.cep);
  ctx.pendingRequest = undefined;
  if (await syncAwaitingQuoteOrderAddress(phone, convoId, ctx)) return;
  // 1º CEP com o endereço já completo = fim do cadastro, venha o endereço junto ("Rua X 10,
  // 01310-100") ou antes (06/10, Clara mandou rua e número, depois o CEP: o CPF nunca foi pedido).
  // Os itens guardados aparecem na confirmação: o cliente vê que não sumiram.
  const noted = queued ? parseBasketLines(queued).map((line) => `${line.qty}x ${line.phrase}`) : [];
  const savedWithNoted = noted.length ? `${savedMsg}\n\n${copy.notedItemsLine(noted)}` : savedMsg;
  if (completingSignup && (await askCpfAtOnboarding(phone, userId, convoId, ctx, savedWithNoted, queued))) return;
  if (queued) {
    await reply(phone, savedMsg);
    await handleSearch(phone, convoId, null, ctx, queued);
    return;
  }

  // CEP no MEIO de uma escolha ("choosing"): endereço atualiza, mas a pergunta pendente
  // não pode virar órfã — reapresenta a escolha em vez de resetar o passo.
  if (ctx.pending?.length) {
    ctx.step = "choosing";
    await writeCtx(convoId, ctx);
    await reply(phone, savedMsg);
    await sendChoices(phone, ctx.pending[0]);
    return;
  }

  if (ctx.basket?.length) {
    await continueAfterBasket(phone, convoId, ctx, cep, savedMsg);
    return;
  }
  ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  await reply(phone, completingSignup ? copy.addressSavedAskItems(shownAddress) : copy.addressUpdated(shownAddress, ctx.cep));
}

// Uma mensagem é o ENDEREÇO de entrega (e não um pedido de produto)? Marcador de
// logradouro + número é o menor sinal confiável, sem tentar parsing frágil. Serve às
// duas pontas: aceitar o endereço e — no caminho do CEP — não confundir a rua com item.
// "Al. Santos 1000" (06/10) também é endereço.
function looksLikeDeliveryAddress(text: string): boolean {
  const address = text.trim();
  const hasStreet = /\b(?:rua|r\.?|avenida|av\.?|alameda|al(?=\.)|travessa|estrada|rodovia|pra[çc]a|largo)\b/i.test(address);
  const hasNumber = /(?:\d|\bs\/?n\b)/i.test(address);
  return address.length >= 12 && hasStreet && hasNumber;
}

async function handleDeliveryAddress(
  phone: string,
  userId: string,
  convoId: string,
  ctx: DeliveryContext,
  userCep: string | null | undefined,
  rawAddress: string,
  opts?: { cityConfirmed?: boolean }
) {
  const address = rawAddress.trim();
  const knownCep = ctx.cep ?? userCep ?? undefined;
  // CEP já conhecido e a rua veio do ViaCEP (06/10, A3): "1500", "221 apto 13", "o numero é
  // 1500", "Augusta 1500" bastam. Antes era laço infinito de "Falta o endereço".
  const place = !ctx.deliveryAddressVerified && knownCep ? ctx.cepPlace : undefined;
  const house = place?.street ? parseHouseNumberReply(address, { ...place, city: ctx.city }) : null;
  let finalAddress: string | undefined;
  let extraItems: string | undefined;
  if (house && place?.street) {
    finalAddress = buildSignupAddress({ street: place.street, numero: house.numero, complemento: house.complemento, district: place.district, city: ctx.city, uf: ctx.uf });
  } else if (looksLikeDeliveryAddress(address)) {
    // Pedido e endereço na mesma mensagem (A1): só a rua vai pra etiqueta; o resto é pedido.
    const split = splitAddressAndItems(address);
    finalAddress = split?.address && looksLikeDeliveryAddress(split.address) ? split.address : address;
    extraItems = split?.items ? onboardingNote(split.items).text || undefined : undefined;
    // Cidade escrita ≠ cidade do CEP já salvo (A5): pergunta antes de gravar.
    const typedCity = knownCep && ctx.city && !opts?.cityConfirmed ? typedCityMismatch(finalAddress, ctx.city, ctx.uf) : null;
    if (typedCity && knownCep) {
      ctx.cepCityCheck = { cep: knownCep, raw: rawAddress, askedAt: Date.now(), via: "address" };
      await writeCtx(convoId, ctx);
      await reply(phone, copy.cepCityMismatch(knownCep, ctx.city!, typedCity));
      return;
    }
  }
  if (!finalAddress) {
    const kind = detectIntent(address).kind;
    const hasSavedAddress = Boolean(ctx.deliveryAddress && ctx.deliveryAddressVerified);
    // "Vc salvou o endereço já?" — pergunta SOBRE o endereço com endereço na mão:
    // confirma e destrava, nunca re-pede (teste real 24/08: loop infinito de endereço).
    if (hasSavedAddress && /\b(endereco|cep)\b/.test(normalizeMsg(address))) {
      ctx.step = "collecting";
      const queued = ctx.pendingRequest;
      ctx.pendingRequest = undefined;
      await writeCtx(convoId, ctx);
      await reply(phone, copy.addressUpdated(ctx.deliveryAddress!, ctx.cep));
      if (queued) await handleSearch(phone, convoId, null, ctx, queued);
      return;
    }
    // Endereço já existe e a mensagem é OUTRA coisa: o passo travado não pode reter o
    // cliente — destrava pra coleta e roteia a mensagem como pedido normal.
    if (hasSavedAddress) {
      ctx.step = "collecting";
      await writeCtx(convoId, ctx);
      if (kind === "free_text" && !isQuestion(address)) {
        await handleSearch(phone, convoId, null, ctx, address);
        return;
      }
      await reply(phone, copy.addressSavedAskItems(ctx.deliveryAddress!));
      return;
    }
    // "não sei meu cep" (06/10, M6): explica onde achar, em vez de repetir o pedido.
    if (!knownCep && saysNoCep(address)) {
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      await reply(phone, copy.dontKnowCep());
      return;
    }
    // Nome e CPF antes do endereço (06/10, M11): vão pro cadastro, nunca pra lista de itens.
    const cpf = extractCpf(address);
    if (cpf || looksLikeCpfAttempt(address)) {
      if (cpf) {
        // O nome pode ter vindo na mensagem anterior ("Teste Silva") e ficado na lista guardada.
        const segments = (ctx.pendingRequest ?? "").split(", ").filter(Boolean);
        const lastSegment = segments[segments.length - 1];
        const nameFromList = lastSegment && looksLikePersonName(lastSegment) ? lastSegment : undefined;
        const name = extractFullName(address) ?? nameFromList;
        if (name) {
          if (nameFromList && !extractFullName(address)) ctx.pendingRequest = segments.slice(0, -1).join(", ") || undefined;
          await prisma.user.update({ where: { id: userId }, data: { cpf, cpfName: name, cpfConsentAt: new Date() } });
          ctx.step = "need_address";
          await writeCtx(convoId, ctx);
          await reply(phone, copy.identitySavedAskAddress(Boolean(ctx.cepPlace?.street && knownCep)));
          return;
        }
      }
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      await askStreetOrSignup(phone, ctx, userCep);
      return;
    }
    // Pergunta no meio do onboarding: responde e pede o endereço de novo — pergunta não
    // é pedido e nunca entra no estoque.
    if (isQuestion(address) || kind === "help" || kind === "service_question") {
      await answerOnboardingQuestion(phone, address);
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      await askStreetOrSignup(phone, ctx, userCep);
      return;
    }
    // Rua sem número ("moro na rua augusta perto do metrô"): diz exatamente o que falta.
    if (mentionsStreetWithoutNumber(address, ctx.cepPlace?.street)) {
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      if (ctx.cepPlace?.street && knownCep) await askStreetAndNumber(phone, ctx);
      else await reply(phone, copy.askNumberAndCep(Boolean(knownCep)));
      return;
    }
    // Não é endereço — mas TAMBÉM não é lixo: quem responde "preciso de um carregador"
    // aqui está fazendo o pedido, não errando o endereço. Guardar em vez de descartar,
    // pra rodar a busca assim que o endereço chegar. Só PEDIDO entra no estoque:
    // "pode ser amanhã" (affirm), "obrigado" e afins ficam de fora (24/08). Número solto
    // ("1500") e cortesia ("sou a Clara") também não (06/10).
    const note = kind === "free_text" && !parseHouseNumberReply(address) ? onboardingNote(address).text : "";
    if (note && queryTokens(note).length && !blocksMedicine(address)) {
      ctx.pendingRequest = ctx.pendingRequest ? `${ctx.pendingRequest}, ${note}` : note;
    }
    ctx.step = "need_address";
    await writeCtx(convoId, ctx);
    await askStreetOrSignup(phone, ctx, userCep);
    return;
  }

  // 1º endereço do cliente = fim do cadastro (o CPF é pedido logo depois, uma vez).
  const firstAddress = !(await prisma.user.findUnique({ where: { id: userId }, select: { defaultAddress: true } }))?.defaultAddress;
  ctx.deliveryAddress = finalAddress;
  ctx.deliveryAddressVerified = true;
  ctx.cepCityCheck = undefined;
  await prisma.user.update({ where: { id: userId }, data: { defaultAddress: finalAddress } });
  if (extraItems) ctx.pendingRequest = ctx.pendingRequest ? `${ctx.pendingRequest}, ${extraItems}` : extraItems;

  if (!ctx.cep && userCep) ctx.cep = userCep;
  if (!ctx.cep) {
    ctx.step = "need_cep";
    await writeCtx(convoId, ctx);
    const noted = extraItems ? parseBasketLines(extraItems).map((line) => `${line.qty}x ${line.phrase}`) : [];
    await reply(phone, noted.length ? `${copy.addressSavedAskCep()}\n\n${copy.notedItemsLine(noted)}` : copy.addressSavedAskCep());
    return;
  }

  if (await syncAwaitingQuoteOrderAddress(phone, convoId, ctx)) return;
  ctx.step = "collecting";

  const queued = ctx.pendingRequest;
  ctx.pendingRequest = undefined;
  const savedMsg = copy.addressSavedPrefix(finalAddress, ctx.cep);
  const noted = queued ? parseBasketLines(queued).map((line) => `${line.qty}x ${line.phrase}`) : [];
  if (firstAddress && (await askCpfAtOnboarding(phone, userId, convoId, ctx, noted.length ? `${savedMsg}\n\n${copy.notedItemsLine(noted)}` : savedMsg, queued))) return;
  if (queued) {
    await reply(phone, copy.addressUpdated(finalAddress, ctx.cep));
    await handleSearch(phone, convoId, null, ctx, queued);
    return;
  }

  if (ctx.basket?.length) {
    await continueAfterBasket(phone, convoId, ctx, userCep, copy.addressUpdated(finalAddress, ctx.cep));
    return;
  }

  await writeCtx(convoId, ctx);
  await reply(phone, copy.addressSavedAskItems(finalAddress));
}

// Pergunta antes do cadastro (06/10, testadores: "vocês são do iFood?", "quem é o dono?",
// "é de graça?" recebiam o texto genérico). A mesma IA que responde depois do cadastro
// responde aqui; sem IA (ou sem resposta), o genérico de sempre.
async function answerOnboardingQuestion(phone: string, text: string) {
  const meta = turnMeta.getStore();
  let answer: string | undefined;
  if (!meta?.llmUsed) {
    if (meta) meta.llmUsed = true;
    const verdict = await interpretCustomerMessage({
      text,
      state: "cliente novo, ainda sem cadastro: depois da resposta a Lia pede o endereço com CEP"
    }).catch(() => null);
    if (verdict?.reply && ["question", "support", "smalltalk", "manipulation"].includes(verdict.action)) answer = verdict.reply;
  }
  await reply(phone, answer ?? copy.serviceAnswer("generic", servedAreaLabel()));
}

type TurnUser = Awaited<ReturnType<typeof getOrCreateConvo>>["user"];

// Resposta à pergunta de endereço que a Lia deixou em aberto (06/10). Vale 30 min e UMA
// resposta: "sim" faz a troca / aceita a cidade do CEP; "não"/"deixa o antigo" mantém; outra
// mensagem desarma e segue o fluxo normal com o endereço de sempre — nunca prende o cliente.
async function handlePendingAddressQuestion(
  phone: string,
  user: TurnUser,
  convoId: string,
  ctx: DeliveryContext,
  text: string,
  intent: Intent
): Promise<boolean> {
  const fresh = (at: number) => Date.now() - at < 30 * 60_000;
  const n = normalizeMsg(text).replace(/[!.?,]+/g, " ").trim();
  const yes =
    intent.kind === "affirm" ||
    /^(sim|s|pode|pode sim|pode trocar|troca|trocar|quero trocar|muda|mudar|isso|esse|esse mesmo|ta certo|esta certo|certo|correto|confirmo|confirma|o cep (ta|esta) certo)\b/.test(n);
  const no = isKeepOldAddress(text) || intent.kind === "reject" || /^(nao|n)\b/.test(n);
  if (ctx.cepSwap) {
    const swap = ctx.cepSwap;
    ctx.cepSwap = undefined;
    if (fresh(swap.askedAt)) {
      if (yes && !no) {
        await handleNewCep(phone, user.id, convoId, ctx, swap.cep, true, swap.items, swap.cep, { swapConfirmed: true });
        return true;
      }
      // Número logo depois da pergunta ("1500") = sim, e já é o número da casa.
      if (!no && parseHouseNumberReply(text)) {
        await handleNewCep(phone, user.id, convoId, ctx, swap.cep, true, undefined, `${swap.cep} ${text}`, { swapConfirmed: true });
        return true;
      }
      if (no) {
        await writeCtx(convoId, ctx);
        await reply(phone, copy.keptAddress(ctx.deliveryAddress ?? user.defaultAddress ?? "", ctx.cep ?? user.cep ?? undefined));
        if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
        else if (swap.items) await handleSearch(phone, convoId, user.cep, ctx, swap.items, user.id);
        return true;
      }
    }
    await writeCtx(convoId, ctx);
    return false;
  }
  const check = ctx.cepCityCheck!;
  ctx.cepCityCheck = undefined;
  if (fresh(check.askedAt) && !extractCep(text)) {
    if (yes && !no) {
      if (check.via === "cep") await handleNewCep(phone, user.id, convoId, ctx, check.cep, Boolean(user.cep), undefined, check.raw, { cityConfirmed: true });
      else await handleDeliveryAddress(phone, user.id, convoId, ctx, user.cep, check.raw, { cityConfirmed: true });
      return true;
    }
    if (no) {
      await writeCtx(convoId, ctx);
      await reply(phone, copy.askRightCep());
      return true;
    }
  }
  await writeCtx(convoId, ctx);
  return false;
}

// "deixa o endereço antigo" / "usa o de antes" (06/10, A4). No meio de uma troca (passo de
// CEP/endereço), volta o endereço anterior inteiro — CEP, rua e cidade. Fora dela, com o
// endereço confirmado, só diz que nada mudou. false = a mensagem não era sobre isso.
async function keepPreviousAddress(phone: string, user: TurnUser, convoId: string, ctx: DeliveryContext, text: string): Promise<boolean> {
  const changing = ctx.step === "need_cep" || ctx.step === "need_address";
  if (changing) {
    const prev = ctx.previousAddress ?? (user.defaultAddress && user.cep ? { cep: user.cep, address: user.defaultAddress } : undefined);
    if (!prev || !user.defaultAddress) return false;
    ctx.cep = prev.cep;
    if ("city" in prev && prev.city) ctx.city = prev.city;
    if ("uf" in prev && prev.uf) ctx.uf = prev.uf;
    ctx.deliveryAddress = prev.address;
    ctx.deliveryAddressVerified = true;
    ctx.previousAddress = undefined;
    ctx.cepPlace = undefined;
    ctx.outsideArea = undefined;
    if (user.cep !== prev.cep || user.defaultAddress !== prev.address) {
      await prisma.user.update({ where: { id: user.id }, data: { cep: prev.cep, defaultAddress: prev.address } });
    }
    if (await syncAwaitingQuoteOrderAddress(phone, convoId, ctx)) return true;
    const kept = copy.keptAddress(prev.address, prev.cep);
    if (ctx.pending?.length) {
      ctx.step = "choosing";
      await writeCtx(convoId, ctx);
      await reply(phone, kept);
      await sendChoices(phone, ctx.pending[0]);
      return true;
    }
    if (ctx.basket?.length) {
      await continueAfterBasket(phone, convoId, ctx, prev.cep, kept);
      return true;
    }
    ctx.step = "collecting";
    const queued = ctx.pendingRequest;
    ctx.pendingRequest = undefined;
    await writeCtx(convoId, ctx);
    await reply(phone, kept);
    if (queued) await handleSearch(phone, convoId, prev.cep, ctx, queued, user.id);
    return true;
  }
  if (!ctx.deliveryAddress || !ctx.deliveryAddressVerified || !isKeepOldAddressExplicit(text)) return false;
  await reply(phone, copy.keptAddress(ctx.deliveryAddress, ctx.cep ?? user.cep ?? undefined));
  if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
  return true;
}

// Cadastro (05/10, dono): nome + CPF pedidos UMA vez, logo depois do 1º endereço, e
// guardados para sempre. Só com remédio isento ligado (é o único uso do CPF hoje). O pedido
// que veio no onboarding fica guardado e roda assim que o CPF chega (ou quando o cliente
// responde outra coisa — a pergunta nunca trava).
async function askCpfAtOnboarding(phone: string, userId: string, convoId: string, ctx: DeliveryContext, savedMsg: string, queued?: string): Promise<boolean> {
  if (!medicineEnabled() || ctx.basket?.length || ctx.pending?.length) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { cpf: true, cpfName: true } });
  if (user?.cpf && user.cpfName) return false;
  ctx.step = "need_cpf";
  ctx.cpfOnboarding = true;
  ctx.pendingRequest = queued || undefined;
  await writeCtx(convoId, ctx);
  await reply(phone, `${savedMsg}\n\n${copy.askCpfOnboarding()}`);
  return true;
}

// Complemento que chegou sozinho (06/10): vai pro endereço salvo e pro pedido aberto ainda
// não pago (mesmo CEP, mesmo frete). A conversa continua de onde estava.
async function handleAddressComplement(phone: string, userId: string, convoId: string, ctx: DeliveryContext, complement: string) {
  const updated = withAddressComplement(ctx.deliveryAddress!, complement);
  ctx.deliveryAddress = updated;
  await prisma.user.update({ where: { id: userId }, data: { defaultAddress: updated } });
  if (ctx.deliveryOrderId) {
    await prisma.deliveryOrder.updateMany({
      where: { id: ctx.deliveryOrderId, status: { in: [AWAITING_OPERATOR_QUOTE_STATUS, "awaiting_payment"] } },
      data: { deliveryAddress: updated }
    });
  }
  await writeCtx(convoId, ctx);
  await reply(phone, ctx.step === "need_cep" ? `${copy.addressUpdated(updated)}\n\nFalta o *CEP* 📍` : copy.addressUpdated(updated, ctx.cep));
  if (ctx.step === "need_cpf") {
    await reply(phone, ctx.cpfOnboarding ? copy.askCpfOnboarding() : copy.askCpfForMedicine());
    return;
  }
  if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
}

// Resposta do formulário de cadastro (06/10). Ordem: CEP (existe? estado atendido?) →
// endereço com a rua do CEP + número e complemento do formulário → nome + CPF. O que
// conferiu fica salvo mesmo quando outra parte falha; só a parte que falhou volta a ser
// pedida, por texto, pelos passos de sempre (need_cep / need_address / need_cpf).
const SIGNUP_STEPS: Array<DeliveryContext["step"]> = [undefined, "collecting", "need_cep", "need_address", "need_cpf"];
async function handleSignupForm(
  phone: string,
  payload: Record<string, unknown>,
  user: Awaited<ReturnType<typeof getOrCreateConvo>>["user"],
  convo: Awaited<ReturnType<typeof getOrCreateConvo>>["convo"]
) {
  const ctx = readCtx(convo.context);
  const form = parseSignupForm(payload);
  const identity = form.name && form.cpf ? { cpf: form.cpf, cpfName: form.name, cpfConsentAt: new Date() } : null;
  const firstName = form.name?.split(" ")[0];

  // Formulário reenviado no meio de um pedido (só acontece com o teste "cadastro" do dono):
  // guarda nome e CPF, mas não mexe no endereço nem no passo do pedido em andamento.
  if (!SIGNUP_STEPS.includes(ctx.step)) {
    if (identity) await prisma.user.update({ where: { id: user.id }, data: identity });
    await reply(phone, identity ? copy.signupIdentityOnly() : copy.cpfInvalid());
    return;
  }
  ctx.flow = "delivery";

  if (!form.cep) {
    if (identity) await prisma.user.update({ where: { id: user.id }, data: identity });
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.signupCepInvalid());
    return;
  }
  const place = await expandCep(form.cep);
  if (place.invalid) {
    if (identity) await prisma.user.update({ where: { id: user.id }, data: identity });
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.cepNotFound(form.cep));
    return;
  }
  // Fora da área: guarda o lead (mapa de demanda no /ops) e NÃO guarda o CPF, porque sem
  // entrega ele não tem uso.
  if (!isServedState({ cep: form.cep, city: place.city, uf: place.uf })) {
    await recordWaitlistLead({ phone, cep: form.cep, city: place.city, uf: place.uf, reason: "outside_coverage" });
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.outsideCoverage(place.city, servedAreaLabel()));
    return;
  }
  ctx.cep = form.cep;
  ctx.city = place.city ?? ctx.city;
  ctx.uf = place.uf ?? ctx.uf;

  // CEP geral (cidade inteira, sem rua) ou ViaCEP fora do ar: guarda o CEP e pede a rua por
  // texto; o handleDeliveryAddress de sempre monta o endereço com ela.
  if (!place.street || !form.numero) {
    ctx.deliveryAddress = place.address || undefined;
    ctx.deliveryAddressVerified = false;
    ctx.step = "need_address";
    await prisma.user.update({ where: { id: user.id }, data: { cep: form.cep, ...(identity ?? {}) } });
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.signupNeedStreet());
    return;
  }

  const address = buildSignupAddress({
    street: place.street,
    numero: form.numero,
    complemento: form.complemento,
    district: place.district,
    city: place.city,
    uf: place.uf
  });
  ctx.deliveryAddress = address;
  ctx.deliveryAddressVerified = true;
  await prisma.user.update({ where: { id: user.id }, data: { cep: form.cep, defaultAddress: address, ...(identity ?? {}) } });

  // Endereço salvo, mas nome ou CPF não conferiu: pede os dois por texto, sem travar.
  if (!identity) {
    ctx.step = "need_cpf";
    ctx.cpfOnboarding = true;
    delete ctx.cpfDraft;
    await writeCtx(convo.id, ctx);
    await reply(phone, copy.signupFixCpf(address, form.cpf ? "name" : "cpf"));
    return;
  }

  ctx.step = "collecting";
  delete ctx.cpfOnboarding;
  delete ctx.cpfDraft;
  const queued = ctx.pendingRequest;
  ctx.pendingRequest = undefined;
  await writeCtx(convo.id, ctx);
  if (queued) {
    await reply(phone, copy.signupSaved(firstName, address));
    await handleSearch(phone, convo.id, form.cep, ctx, queued, user.id);
    return;
  }
  if (ctx.basket?.length) {
    await continueAfterBasket(phone, convo.id, ctx, form.cep, copy.signupSaved(firstName, address));
    return;
  }
  await reply(phone, copy.signupSavedAskItems(firstName, address));
}

// Endereço novo confirmado com um pedido AINDA na fila do operador (2ª revisão, 11/08):
// o pedido segue vivo — atualiza cep/endereço NELE, avisa o /ops e devolve a conversa
// pra espera da cotação. Antes, "trocar endereço" órfãva o pedido no /ops com o
// endereço velho. Só vale pra awaiting_operator_quote (sem preço ainda); estados com
// cotação/cobrança são tratados na entrada do change_address.
async function syncAwaitingQuoteOrderAddress(phone: string, convoId: string, ctx: DeliveryContext): Promise<boolean> {
  if (!ctx.deliveryOrderId || !ctx.deliveryAddress || !ctx.deliveryAddressVerified) return false;
  const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } });
  if (!order || order.status !== AWAITING_OPERATOR_QUOTE_STATUS) return false;
  const updated = await prisma.deliveryOrder.updateMany({
    where: { id: order.id, status: AWAITING_OPERATOR_QUOTE_STATUS },
    data: {
      cep: ctx.cep,
      deliveryAddress: ctx.deliveryAddress,
      notes: appendOrderNote(order.notes, `📍 Cliente trocou o endereço durante a cotação: ${ctx.deliveryAddress}`)
    }
  });
  if (!updated.count) return false;
  ctx.step = AWAITING_OPERATOR_QUOTE_STATUS;
  await writeCtx(convoId, ctx);
  await reply(phone, copy.addressUpdatedQuoteContinues(ctx.deliveryAddress));
  await notifyOperator(copy.operatorAddressChangedAlert(order.id.slice(-6).toUpperCase(), ctx.deliveryAddress), phone);
  return true;
}

// Caminho único de confirmação de escolha (número digitado, "a mais barata", nome ou
// toque no card por sku): tira o item da fila, pergunta quantidade quando falta, soma na
// cesta e segue. A loja é a do PRODUTO escolhido — com opções cross-store, a opção 2
// pode ser de outra loja que a opção 1.
async function confirmChosenOption(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  userCep: string | null | undefined,
  fallbackStore: StoreConnector,
  current: PendingChoice,
  chosen: ChoiceOption
) {
  const chosenStore = chosen.storeKey ? getStore(chosen.storeKey) : fallbackStore;
  ctx.pending = ctx.pending!.slice(1);
  // Memória da escolha concluída: "Outras opções"/"mais barato" depois dela reabrem
  // esta mesma escolha (e o novo pick substitui o item na cesta, não soma outro).
  const { replaceSku, ...lastBase } = current;
  ctx.lastChoice = { ...lastBase, chosenSku: chosen.sku };
  if (replaceSku && replaceSku !== chosen.sku) {
    ctx.basket = (ctx.basket ?? []).filter((item) => item.sku !== replaceSku);
  }
  // Quantidade não dita = 1 e segue em frente (dono, 01/09): a rodada "quantas
  // unidades?" era uma mensagem a mais no caso comum — quem quer 3 fala "3x" na hora
  // ou depois ("bota 3"). O handler de choosing_quantity fica vivo só para conversas
  // que estavam no meio da pergunta durante o deploy.
  const assumedOne = current.qty === 1 && !current.qtyExplicit;
  const confirmed = assumedOne
    ? copy.choiceConfirmedAssumedOne(chosen.name, current.query)
    : copy.choiceConfirmed(chosen.name, current.qty);
  ctx.basket = mergeBaskets(ctx.basket ?? [], [choiceToBasketItem(chosen, current.qty, chosenStore)]);
  if (ctx.pending.length) {
    await writeCtx(convoId, ctx);
    await reply(phone, confirmed);
    await sendChoices(phone, ctx.pending[0], copy.nextChoiceHeader(ctx.pending[0].query, ctx.pending.length));
    return;
  }
  // Quantidade assumida → o follow-up troca "Cancelar" por "Mudar quantidade".
  await advancePending(phone, convoId, ctx, userCep, confirmed, { qtyButton: assumedOne });
}

// Confirmação de ajuste na cesta com os botões pós-escolha (Pagar / Adicionar mais /
// Cancelar) — o "diz *só isso*" virou botão (dono, 28/09). Sem Meta, o texto de sempre.
async function replyBasketAdjusted(phone: string, shortBody: string, fallbackText: string) {
  try {
    markTurnReplied();
    const interactive = await whatsappAdapter.sendChoiceFollowUp(phone, shortBody);
    if (interactive) return;
  } catch (error) {
    console.warn("[whatsapp:basket-adjusted:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, fallbackText);
}

async function handleChoosing(
  phone: string,
  userId: string,
  userCep: string | null | undefined,
  convoId: string,
  ctx: DeliveryContext,
  text: string,
  intent: Intent
) {
  const current = ctx.pending![0];
  const store = getStore(current.options[0]?.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
  // Toque em "Escolher esse": o id carrega o SKU do card, então mesmo um card ANTIGO
  // (de antes do "outras"/refino) escolhe exatamente o produto mostrado nele. Vem antes
  // de qualquer parser: é string de máquina, não linguagem.
  const skuTap = text.trim().match(/^optsku:(.+)$/i);
  if (skuTap) {
    const wanted = skuTap[1].trim().toLowerCase();
    const tapped =
      current.options.find((o) => o.sku.toLowerCase() === wanted) ??
      current.shownOptions?.find((o) => o.sku.toLowerCase() === wanted);
    if (!tapped) {
      // Card de outro item/conversa antiga: não chuta produto — DIZ que o botão é
      // velho (27/08 S1: "não peguei qual você quer" confundia) e reapresenta a atual.
      await reply(phone, copy.staleButtonTap(true));
      await sendChoices(phone, current);
      return;
    }
    await confirmChosenOption(phone, convoId, ctx, userCep, store, current, tapped);
    return;
  }
  // Mensagem com 2+ produtos ("shampoo Kerasys Coconut 1L, condicionador Kerasys Coconut
  // 1L", 06/10, Claire) é pedido novo: não estreita nem refina as opções na mesa.
  const multiItem = parseBasketLines(text).length >= 2;
  // "qual a diferença entre o 1 e o 2?": comparação honesta pelo que a Lia SABE
  // (nome, preço, loja) — repetir os cards sem palavra parecia ignorar (29/08 S17).
  if (/\b(qual (a )?diferenca|diferenca entre|compara(r|cao)?)\b/.test(normalizeMsg(text))) {
    await reply(
      phone,
      copy.optionComparison(
        current.options.map((o) => ({ name: o.name, price: display(o.unitPrice, o.medicine), storeLabel: o.storeLabel }))
      )
    );
    await sendChoices(phone, current);
    return;
  }

  // "só amora"/"só essa" com algo já escolhido (06/10, Adely): fecha a lista com o que está
  // na cesta. Virava busca "framboesa só amora" e, no "só essa", a IA TIRAVA a amora.
  const only = parseOnlyKeep(text);
  if (only && (ctx.basket?.length ?? 0) > 0) {
    const keepsBasket =
      "demonstrative" in only
        ? current.options.length > 1
        : (ctx.basket ?? []).some((b) => sharesProductNoun(only.target, b.name)) &&
          !current.options.some((o) => sharesProductNoun(only.target, o.name));
    if (keepsBasket) {
      const skipped = (ctx.pending ?? []).map((pending) => pending.query);
      ctx.pending = [];
      await reply(phone, copy.onlyKeepSkipped(skipped));
      await advancePending(phone, convoId, ctx, userCep);
      return;
    }
  }

  // Narrativa no meio da escolha ("meu neto que pediu isso aí"): ANTES de qualquer
  // parser de escolha — na rodada 3 (S15) a frase caiu no parser e ESCOLHEU o "Violão
  // Meu Primeiro Violão" pelo token "meu/isso". Nunca vira pick nem item "anotado".
  if (intent.kind === "free_text" && isNarrativeSegment(text)) {
    await reply(phone, copy.choiceNotUnderstood());
    await sendChoices(phone, current);
    return;
  }
  // "não gostei"/"não curti" seco: o cliente quer OUTRAS opções, não abrir mão do
  // item (27/08 r3 S17: virava "deixei de fora" + "não entendi", beco).
  // "Estes não são bons. Tem que ser estilo tocha" (06/09): rejeição + característica
  // que a Lia não conhece = busca nova com a característica ("isqueiro tocha"), inclusive
  // no Mercado Livre quando as opções vieram de lá. Rejeição sozinha = próximas opções.
  const styleAsk = normalizeMsg(text).match(STYLE_ASK_RE);
  if (styleAsk) {
    // "tem que ser estilo tocha" → atributo "tocha" (o "estilo/tipo" é só conectivo).
    const attr = styleAsk[1].replace(/[.!?]+$/, "").replace(/^(?:estilo|tipo|modelo|de|do|da|um|uma)\s+/, "").trim();
    if (await researchChoice(phone, convoId, ctx, current, `${current.baseQuery ?? current.query} ${attr}`)) return;
  }
  // "veja se tem kerasys de coco", "tem de coco?" (06/10, Claire): o MESMO produto com uma
  // característica nova. Busca nova com ela e só mostra o que tem a característica; sem
  // nada, diz que não achou. Antes, o refino achava "kerasys" e repetia a mesma opção
  // ("Ficou entre essas") — "ele insiste no outro produto".
  const attrAsk = parseAttributeAsk(text);
  if (attrAsk && !parseRefinement(attrAsk) && !wantsMoreOptions(text)) {
    const base = current.baseQuery ?? current.query;
    const baseTokens = new Set(queryTokens(normalizeMsg(base)));
    const fresh = queryTokens(normalizeMsg(attrAsk)).filter((token) => !baseTokens.has(token));
    if (fresh.length && fresh.length <= 4) {
      const wanted = `${base} ${fresh.join(" ")}`;
      // Tudo o que o cliente pediu tem que estar no produto ("kerasys" E "coco"), não só a
      // palavra nova — senão "Kit Skala Coco" aparecia como "shampoo kerasys coco".
      if (await researchChoice(phone, convoId, ctx, current, wanted, queryTokens(normalizeMsg(attrAsk)).join(" "))) return;
      await reply(phone, copy.refineNoResult(wanted));
      await sendChoices(phone, current);
      return;
    }
  }
  if (/^(nao|não) (gostei|curti|quero ess[ea]s?)( d[eo]ss?[ea]s?( ai)?)?[\s!.]*$/.test(normalizeMsg(text)) || REJECT_ONLY_RE.test(normalizeMsg(text))) {
    await pageMoreOptions(phone, convoId, ctx, store);
    return;
  }
  // "acha outras" pages; "tem essa em azul?"/"tem de 2kg?"/"quero uma maior" refine.
  // Both are checked AFTER an explicit pick ("2", "a colgate", "mais barato") but
  // BEFORE reject→skip — "não gostei, tem outras?" should show more, not drop the item.
  const more = multiItem ? false : wantsMoreOptions(text);
  const refineAttrs = more || multiItem ? null : parseRefinement(text);
  let parsed = multiItem ? null : parseChoiceReply(text, current.options);
  // "nenhuma dessas, mostra outras" asks for MORE — don't let the skip pattern drop the item.
  if (parsed?.type === "skip" && more) parsed = null;
  if (!parsed && !more && !refineAttrs && intent.kind === "reject") parsed = { type: "skip" } as const;

  if (parsed?.type === "name") {
    current.options = [current.options[parsed.index]];
    await writeCtx(convoId, ctx);
    await sendChoices(phone, current, copy.narrowedChoices(current.query));
    return;
  }
  if (parsed) {
    if (parsed.type === "skip") {
      ctx.pending = ctx.pending!.slice(1);
      await reply(phone, copy.choiceSkipped(current.query));
      await advancePending(phone, convoId, ctx, userCep);
      return;
    }
    // "mais barato"/"mais caro" SEM verbo de escolha: mostrar opções nessa faixa —
    // nunca colocar no carrinho o que o cliente não pediu (teste real 19/08).
    if (parsed.type === "cheaper" || parsed.type === "pricier") {
      await showPriceSortedOptions(phone, convoId, ctx, store, parsed.type === "cheaper" ? "asc" : "desc");
      return;
    }
    const index =
      parsed.type === "pick"
        ? parsed.index
        : parsed.type === "cheapest"
          ? current.options.reduce((best, o, i, arr) => (o.unitPrice < arr[best].unitPrice ? i : best), 0)
          : 0;
    await confirmChosenOption(phone, convoId, ctx, userCep, store, current, current.options[index]);
    return;
  }

  if (more) {
    await pageMoreOptions(phone, convoId, ctx, store);
    return;
  }
  if (refineAttrs) {
    await refineOptions(phone, convoId, ctx, store, refineAttrs);
    return;
  }

  // "quanto deu tudo?" no meio das escolhas → parcial honesto e volta pras opções.
  if (asksRunningTotal(text)) {
    const items = basketForCopy(ctx);
    const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
    await reply(phone, copy.partialTotal(items, produtos, ctx.pending!.length));
    await sendChoices(phone, current);
    return;
  }

  // "algum até 150 reais?" — teto de preço filtra as opções na mesa (preço exibido,
  // com markup). Nenhuma dentro do teto → resposta honesta + caminhos (barato/opções).
  const priceCap = parsePriceCap(text);
  if (priceCap != null) {
    const within = current.options.filter((o) => display(o.unitPrice, o.medicine) <= priceCap);
    if (!within.length) {
      await reply(phone, copy.nonePriceCap(priceCap));
      await sendChoices(phone, current);
      return;
    }
    if (within.length < current.options.length) {
      current.options = within;
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current, copy.narrowedChoices(current.query));
      return;
    }
    // todas cabem no teto → só reapresenta confirmando
    await sendChoices(phone, current, copy.narrowedChoices(current.query));
    return;
  }

  // "coca" com [Fanta, Coca Lata, Coca Pet] na mesa: o cliente está discriminando
  // entre as opções, não pedindo item novo. Uma só bate → escolhe; várias → estreita.
  // 04/09 (dono): texto que discrimina NUNCA escolhe sozinho — "masculino" com uma só
  // opção masculina mostrava o card e já fechava. Agora estreita para 1 e o cliente
  // confirma no botão/número, como em qualquer escolha.
  const narrowed = multiItem ? [] : narrowChoiceByName(text, current.options);
  if (narrowed.length >= 1 && narrowed.length < current.options.length) {
    current.options = narrowed.map((i) => current.options[i]);
    await writeCtx(convoId, ctx);
    await sendChoices(phone, current, copy.narrowedChoices(current.query));
    return;
  }

  // Refinamento aberto e sistêmico: se a resposta curta discrimina itens do catálogo
  // da busca atual, ela é atributo — mesmo que nunca tenha sido cadastrada numa lista
  // fixa. Isso cobre marca, sabor, aroma, material, número de roupa/calçado e futuras
  // características do catálogo. Se não combinar com a busca atual (ex.: "leite"
  // enquanto escolhe Coca), continua sendo tratado como um NOVO produto.
  // Refino pelo catálogo é para resposta CURTA ("morango", "azul", "42"): numa frase longa
  // ele achava um atributo qualquer ("kerasys") e descartava o resto (06/10, Claire).
  const shortReply = !multiItem && queryTokens(normalizeMsg(text)).length <= 3;
  const catalogAttrs = shortReply ? await contextualCatalogAttrs(store, ctx, current, text) : null;
  if (catalogAttrs) {
    await refineOptions(phone, convoId, ctx, store, catalogAttrs);
    return;
  }

  // Marca/atributo que NÃO existe no pool atual ("Philco" escolhendo fone bluetooth):
  // antes de tratar como item novo, tenta a BUSCA COMBINADA "fone bluetooth philco" —
  // com a cauda longa (ML) FORÇADA, porque a marca pedida raramente está na vitrine
  // local (27/08 r3 S5: sem o ML, a re-busca falhava e "Philco" virava linha nova que
  // depois mostrava air fryer). Só refina se o resultado cobre a query combinada E o
  // token novo — "leite" no meio da escolha de coca continua caindo em item novo.
  const addedTokens = queryTokens(normalizeMsg(text));
  if (intent.kind === "free_text" && !isQuestion(text) && addedTokens.length === 1) {
    const combinedQuery = `${current.baseQuery ?? current.query} ${normalizeMsg(text)}`.replace(/\s+/g, " ").trim();
    const combined = await gatherCrossStoreCandidates(combinedQuery, 12, 4, { forceLongTail: true });
    const strong = combined
      .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }))
      .filter((o) => conciergeMatchIsStrong(combinedQuery, o) && conciergeMatchIsStrong(normalizeMsg(text), o))
      // O teto da busca original continua valendo no refinamento por marca. Esse é o
      // caminho de cauda longa de "fone até 150" → "Philco" que ainda deixava um
      // anúncio caro do ML furar o orçamento depois de os primeiros cards respeitarem.
      .filter((o) => current.cap == null || display(o.unitPrice, o.medicine) <= current.cap);
    if (strong.length) {
      current.baseQuery = current.baseQuery ?? current.query;
      current.query = combinedQuery;
      const opts = diversifyOptions(combinedQuery, strong, vitrineLimit());
      const remembered = new Set((current.shownOptions ?? current.options).map((o) => o.sku));
      current.shownOptions = [...(current.shownOptions ?? current.options), ...opts.filter((o) => !remembered.has(o.sku))];
      current.options = opts;
      current.shownSkus = [...new Set([...(current.shownSkus ?? []), ...opts.map((o) => o.sku)])];
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current, copy.narrowedChoices(current.query));
      return;
    }
    // A re-busca combinada falhou. Se o token sozinho é uma MARCA (todos os matches
    // dele são da marca, não produtos com esse nome), a resposta honesta é "não achei
    // <query> <marca>" + re-mostrar o que existe — enfileirar "philco" seco como item
    // novo era o que trazia air fryer depois (27/08 r3 S5).
    try {
      const token = normalizeMsg(text);
      const solo = (await gatherCrossStoreCandidates(token, 8))
        .map((c) => c.item)
        .filter((item) => conciergeMatchIsStrong(token, item));
      const brandOnly = solo.length > 0 && solo.every((item) => normalizeMsg(item.brand ?? "").includes(token));
      if (brandOnly) {
        await reply(phone, copy.refineNoResult(combinedQuery));
        await sendChoices(phone, current);
        return;
      }
    } catch (error) {
      console.warn("[choice:brand-probe-failed]", error instanceof Error ? error.message : error);
    }
  }

  // Not a selection — maybe they're adding MORE items mid-choice ("ah, e 2 leites").
  // Questions about the shown options ("qual é a desnatada?") must NOT be searched
  // as new products — re-show the options instead.
  if (intent.kind === "free_text" && !isQuestion(text)) {
    const added = await buildChoicesWithSearchNotice(phone, text, undefined, undefined, undefined, ctx.cep);
    // "Isqueiro maçarico" enquanto escolhe "isqueiro" (06/09): nada nas vitrines → busca
    // direto no Mercado Livre com a frase nova e troca as opções, sem oferecer/perguntar.
    if (!added.autoAdded.length && !added.pending.length && sharesProductNoun(text, current.query) && mercadoLivreEnabled()) {
      ctx.longTailOffer = undefined;
      if (await researchChoice(phone, convoId, ctx, current, text)) return;
    }
    // "Só shampoo normal, sem preferência de marca" ENQUANTO escolhe shampoo é
    // esclarecimento do MESMO item — substitui as opções na mesa, nunca vira uma
    // segunda linha (rodada 5 dos testes de 14/08: a linha duplicada fez o cliente
    // escolher DOIS shampoos sem perceber e a cesta foi contraditória pro pagamento).
    // Com 2+ produtos na mensagem (06/10, Claire), o que é do MESMO produto da escolha
    // aberta a substitui e os outros entram na fila — antes, todos iam pra fila e a Lia
    // reapresentava o shampoo antigo.
    const clarifyIdx = multiItem ? added.pending.findIndex((pending) => sharesProductNoun(pending.query, current.query)) : -1;
    if (clarifyIdx >= 0) {
      const clarified = added.pending[clarifyIdx];
      const others = added.pending.filter((_, i) => i !== clarifyIdx);
      current.baseQuery = undefined;
      current.attrs = undefined;
      current.query = clarified.query.replace(/^(.+?)\s+\1$/i, "$1");
      if (clarified.qtyExplicit) {
        current.qty = clarified.qty;
        current.qtyExplicit = true;
      }
      const remembered = new Set((current.shownOptions ?? current.options).map((o) => o.sku));
      current.shownOptions = [...(current.shownOptions ?? current.options), ...clarified.options.filter((o) => !remembered.has(o.sku))];
      current.options = clarified.options;
      current.shownSkus = [...new Set([...(current.shownSkus ?? []), ...clarified.options.map((o) => o.sku)])];
      ctx.basket = mergeBaskets(ctx.basket ?? [], added.autoAdded);
      ctx.pending = [current, ...(ctx.pending ?? []).slice(1), ...others];
      ctx.notFound = [...(ctx.notFound ?? []), ...added.notFound];
      await writeCtx(convoId, ctx);
      const notes: string[] = [];
      if (added.autoAdded.length) notes.push(copy.autoAddedNote(added.autoAdded.map((i) => `${i.qty}x ${i.name}`)));
      if (others.length) notes.push(copy.queuedItemsNote(others.map((pending) => pending.query)));
      if (added.notFound.length) notes.push(copy.notFoundNote(added.notFound));
      if (notes.length) await reply(phone, notes.join("\n"));
      await sendChoices(phone, current, copy.narrowedChoices(current.query));
      return;
    }
    if (!added.autoAdded.length && added.pending.length === 1 && sharesProductNoun(added.pending[0].query, current.query)) {
      const clarified = added.pending[0];
      current.baseQuery = undefined;
      current.attrs = undefined;
      current.query = clarified.query.replace(/^(.+?)\s+\1$/i, "$1");
      if (clarified.qtyExplicit) {
        current.qty = clarified.qty;
        current.qtyExplicit = true;
      }
      const remembered = new Set((current.shownOptions ?? current.options).map((o) => o.sku));
      current.shownOptions = [...(current.shownOptions ?? current.options), ...clarified.options.filter((o) => !remembered.has(o.sku))];
      current.options = clarified.options;
      current.shownSkus = [...new Set([...(current.shownSkus ?? []), ...clarified.options.map((o) => o.sku)])];
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current, copy.narrowedChoices(current.query));
      return;
    }
    if (added.autoAdded.length || added.pending.length) {
      ctx.basket = mergeBaskets(ctx.basket ?? [], added.autoAdded);
      // PIVÔ ("então me ve um chá e um gatorade" com a escolha anterior parada): o
      // assunto novo SUBSTITUI a escolha estagnada — enfileirar atrás dela deixava o
      // cliente preso nos cards antigos pra sempre (29/08 S2).
      const pivot = /^(entao|então|na verdade|melhor|deixa isso|esquece isso)\b/.test(normalizeMsg(text));
      const dropped = pivot && added.pending.length ? current.query : undefined;
      ctx.pending = pivot && added.pending.length ? added.pending : [...(ctx.pending ?? []), ...added.pending];
      ctx.notFound = [...(ctx.notFound ?? []), ...added.notFound];
      await writeCtx(convoId, ctx);
      const notes: string[] = [];
      if (dropped) notes.push(copy.choiceSkipped(dropped));
      if (added.autoAdded.length) notes.push(copy.autoAddedNote(added.autoAdded.map((i) => `${i.qty}x ${i.name}`)));
      // Item novo no meio de uma escolha entra na FILA — avisar, senão parece ignorado.
      if (!pivot && added.pending.length) notes.push(copy.queuedItemsNote(added.pending.map((p) => p.query)));
      if (added.notFound.length) notes.push(copy.notFoundNote(added.notFound));
      if (notes.length) await reply(phone, notes.join("\n"));
      await sendChoices(phone, ctx.pending![0]);
      return;
    }
  }
  // Último recurso da escolha: o roteador LLM tenta entender (pergunta? edição?
  // frase de produto torta?) antes do "não peguei qual você quer".
  if (await tryLlmInterpret(phone, convoId, userCep, ctx, text, userId)) return;
  await reply(phone, copy.choiceNotUnderstood());
  await sendChoices(phone, current);
}

async function contextualCatalogAttrs(store: StoreConnector, ctx: DeliveryContext, current: PendingChoice, text: string): Promise<string[] | null> {
  const candidates = await choiceCandidates(store, ctx, current);
  return inferCatalogRefinement(text, candidates);
}

// beginQuantityChoice foi removida (01/09): a escolha assume 1 unidade e segue. O
// estado choosing_quantity e o finishQuantityChoice abaixo continuam existindo para
// terminar conversas que estavam no meio da pergunta quando o deploy trocou a regra.
// Ranked candidates for the item being chosen, with the active refinement attributes
// re-applied — the single source pageMoreOptions and refineOptions share, so paging
// after a refine keeps honoring the attribute filter. No concierge sem loja travada o
// pool vem de TODAS as vitrines (como o buildChoices que gerou as opções): paginar só
// na loja da opção 1 escondia os produtos das outras — cada opção carrega a própria
// loja no resultado.
async function choiceCandidates(store: StoreConnector, ctx: DeliveryContext, p: PendingChoice, attrs?: string[]): Promise<ChoiceOption[]> {
  const active = attrs ?? p.attrs ?? [];
  const query = active.length ? (p.baseQuery ?? p.query) : p.query;
  let pool: ChoiceOption[];
  if (!ctx.storeKey) {
    const fromLongTail = (p.options ?? []).some((o) => o.storeKey === "mercadolivre");
    const candidates = await gatherCrossStoreCandidates(query, 40, 12, { forceLongTail: fromLongTail });
    pool = candidates.map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }));
  } else {
    pool = (await store.searchItems(query, 40)).map((item) => toChoiceOption(item, { storeKey: store.key, storeLabel: store.label }));
  }
  // Paginação/refino também só mostram o que a loja confirmou para o CEP (03/09).
  pool = await confirmOptionsLive(pool, ctx.cep);
  // Piso de relevância TAMBÉM na paginação/refino (vistoria 10/08: "outras" de
  // "carregador de celular" devolvia Sérum Nivea "Cellular" e chip de operadora —
  // score>0 sem piso). O rerank de IA não roda aqui (resposta na hora), então o piso
  // léxico é a única guarda; pool que esvazia vira o honesto "essas são todas".
  pool = pool.filter((o) => conciergeMatchIsStrong(query, o));
  if (p.cap != null) pool = pool.filter((o) => display(o.unitPrice, o.medicine) <= p.cap!);
  return active.length ? pool.filter((o) => active.every((a) => attrMatchesItem(a, o))) : pool;
}

// "acha outras" (ou o botão "Outras opções"): show the NEXT 3 catalog matches for the
// same item — never repeat a sku already shown. When the pool is exhausted, say so
// honestly.
// "mais barato"/"mais caro" na escolha: reordena o pool conhecido (tudo que já foi
// mostrado + candidatos frescos) por preço e mostra os 3 primeiros — produtos
// distintos primeiro, variantes preenchem. É navegação, nunca compra.
async function showPriceSortedOptions(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  store: StoreConnector,
  dir: "asc" | "desc"
) {
  const p = ctx.pending![0];
  const known = new Map<string, ChoiceOption>();
  for (const o of [...(p.shownOptions ?? []), ...p.options]) known.set(o.sku, o);
  try {
    for (const o of await choiceCandidates(store, ctx, p)) if (!known.has(o.sku)) known.set(o.sku, o);
  } catch (error) {
    console.warn("[choice:price-sort:pool-failed]", error instanceof Error ? error.message : error);
  }
  const pool = [...known.values()].sort((a, b) => (dir === "asc" ? a.unitPrice - b.unitPrice : b.unitPrice - a.unitPrice));
  const picked: ChoiceOption[] = [];
  for (const o of pool) {
    if (picked.length >= 3) break;
    if (!picked.some((cur) => sameProductVariant(p.query, cur, o))) picked.push(o);
  }
  for (const o of pool) {
    if (picked.length >= 3) break;
    if (!picked.some((cur) => cur.sku === o.sku)) picked.push(o);
  }
  if (!picked.length) {
    await sendChoices(phone, p);
    return;
  }
  const remembered = new Set((p.shownOptions ?? p.options).map((o) => o.sku));
  p.shownOptions = [...(p.shownOptions ?? p.options), ...picked.filter((o) => !remembered.has(o.sku))];
  p.shownSkus = [...new Set([...(p.shownSkus ?? p.options.map((o) => o.sku)), ...picked.map((o) => o.sku)])];
  p.options = picked;
  await writeCtx(convoId, ctx);
  await sendChoices(phone, p, copy.priceSortedHeader(p.query, dir === "asc"));
}

// "Outras opções"/"mais barato" FORA da escolha (ela já fechou — inclusive por uma
// escolha que o cliente não quis): reabre a última escolha; o novo pick SUBSTITUI o
// item na cesta. Só vale no passo de coleta — com cotação/pagamento na mesa, não mexe.
async function reopenLastChoice(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  mode: "more" | "cheaper"
): Promise<boolean> {
  const last = ctx.lastChoice;
  if (!last) return false;
  if (ctx.step && ctx.step !== "collecting") return false;
  const { chosenSku, ...pendingBase } = last;
  const restored: PendingChoice = { ...pendingBase, replaceSku: chosenSku };
  ctx.pending = [restored, ...(ctx.pending ?? [])];
  ctx.step = "choosing";
  await writeCtx(convoId, ctx);
  const store = getStore(restored.options[0]?.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
  if (mode === "cheaper") await showPriceSortedOptions(phone, convoId, ctx, store, "asc");
  else await pageMoreOptions(phone, convoId, ctx, store);
  return true;
}

async function pageMoreOptions(phone: string, convoId: string, ctx: DeliveryContext, store: StoreConnector) {
  const p = ctx.pending![0];
  const shown = p.shownSkus ?? p.options.map((o) => o.sku);
  const pool = (await choiceCandidates(store, ctx, p)).filter((o) => !shown.includes(o.sku));
  // Quem pediu "outras" dispensou o que está na mesa: variante do dispensado não é
  // "outra opção". Só volta a valer se não sobrar mais nada de distinto.
  const fresh = pool.filter((o) => !p.options.some((cur) => sameProductVariant(p.query, cur, o)));
  const next = diversifyOptions(p.query, fresh.length ? fresh : pool, vitrineLimit());
  // "Outras" tem que vir com 3 de verdade (pedido do dono, 11/08): completa com o que
  // sobrou no pool — variante repetida ainda atende melhor que uma opção solitária.
  for (const option of pool) {
    if (next.length >= vitrineLimit()) break;
    if (!next.some((n) => n.sku === option.sku)) next.push(option);
  }
  if (!next.length) {
    // Pool esgotado: UMA re-busca relaxada antes de desistir — sem o token menos
    // importante da query, forçando a cauda longa (ML). Repetir a mesma frase a cada
    // "outras" era beco sem saída (27/08 S4: duas vezes a frase idêntica).
    if (!p.exhausted) {
      p.exhausted = true;
      const tokens = queryTokens(p.baseQuery ?? p.query);
      const relaxedQuery = tokens.length > 2 ? tokens.slice(0, -1).join(" ") : (p.baseQuery ?? p.query);
      try {
        const rescue = await confirmOptionsLive(
          (await gatherCrossStoreCandidates(relaxedQuery, 12, 4, { forceLongTail: true }))
            .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }))
            .filter((o) => conciergeMatchIsStrong(relaxedQuery, o) && !shown.includes(o.sku))
            .filter((o) => p.cap == null || display(o.unitPrice, o.medicine) <= p.cap),
          ctx.cep
        );
        const rescueNext = diversifyOptions(relaxedQuery, rescue, vitrineLimit());
        if (rescueNext.length) {
          const rememberedRescue = new Set((p.shownOptions ?? p.options).map((o) => o.sku));
          p.shownOptions = [...(p.shownOptions ?? p.options), ...rescueNext.filter((o) => !rememberedRescue.has(o.sku))];
          p.options = rescueNext;
          p.shownSkus = [...shown, ...rescueNext.map((o) => o.sku)];
          await writeCtx(convoId, ctx);
          await sendChoices(phone, p, copy.moreChoicesHeader(relaxedQuery));
          return;
        }
      } catch (error) {
        console.warn("[choice:more-options:rescue-failed]", error instanceof Error ? error.message : error);
      }
      await writeCtx(convoId, ctx);
      await reply(phone, copy.noMoreOptions(p.query));
      return;
    }
    await reply(phone, copy.noMoreOptionsAskReword(p.query));
    return;
  }
  // Memória de TUDO que já foi mostrado: o toque num card antigo resolve por sku.
  const remembered = new Set((p.shownOptions ?? p.options).map((o) => o.sku));
  p.shownOptions = [...(p.shownOptions ?? p.options), ...next.filter((o) => !remembered.has(o.sku))];
  p.options = next;
  p.shownSkus = [...shown, ...next.map((o) => o.sku)];
  await writeCtx(convoId, ctx);
  await sendChoices(phone, p, copy.moreChoicesHeader(p.query));
}

// "tem essa em azul?" / "tem de 2kg?" / "quero uma maior": re-search the item with the
// attribute. Only results where the attribute ACTUALLY applies count (attrMatchesItem)
// — otherwise the search degrades to the base tokens and we'd re-show the same list
// under a dishonest header. No match → say so and re-show what exists.
// "estes não são bons" (rejeição) opcional + "tem que ser / estilo / tipo X".
const REJECT_PREFIX = "(?:(?:estes|esses|essas|estas|isso|esse|essa|nenhum|nenhuma)\\s+(?:nao|não)\\s+(?:sao|são|servem?|prestam?|e|eh|da|dao)\\s*(?:bons|boas|bom|boa|legal|legais|isso)?[\\s.!,]*)?";
const STYLE_ASK_RE = new RegExp(`^${REJECT_PREFIX}(?:tem que ser|precisa ser|tinha que ser|teria que ser|tem de ser|quero (?:um |uma )?(?:do |de )?(?:estilo|tipo|modelo)|estilo|tipo|modelo) (.{2,40})$`);
const REJECT_ONLY_RE = new RegExp(`^(?:estes|esses|essas|estas|isso|esse|essa|nenhum|nenhuma)\\s+(?:nao|não)\\s+(?:sao|são|servem?|prestam?|e|eh|da|dao)\\s*(?:bons|boas|bom|boa|legal|legais|isso)?[\\s.!,]*$`);

// Busca nova (vitrines + Mercado Livre) para a escolha ABERTA com uma frase mais
// específica ("isqueiro maçarico", "isqueiro tocha") e troca as opções na mesa. Devolve
// false quando nada aparece — o chamador segue o caminho de sempre.
async function researchChoice(phone: string, convoId: string, ctx: DeliveryContext, current: PendingChoice, text: string, mustMatch?: string): Promise<boolean> {
  const found = await buildChoicesWithSearchNotice(phone, text, undefined, undefined, true, ctx.cep);
  const choice = found.pending.find((p) => sharesProductNoun(p.query, current.query)) ?? found.pending[0];
  // `mustMatch` (06/10): só vale opção que tem TUDO o que foi pedido ("kerasys coco"); a
  // busca nova não pode devolver outro produto com cabeçalho de refino.
  if (choice && mustMatch) choice.options = choice.options.filter((o) => attrMatchesItem(mustMatch, o));
  if (!choice?.options.length) return false;
  current.baseQuery = undefined;
  current.attrs = undefined;
  current.query = choice.query;
  const remembered = new Set((current.shownOptions ?? current.options).map((o) => o.sku));
  current.shownOptions = [...(current.shownOptions ?? current.options), ...choice.options.filter((o) => !remembered.has(o.sku))];
  current.options = choice.options;
  current.shownSkus = [...new Set([...(current.shownSkus ?? []), ...choice.options.map((o) => o.sku)])];
  ctx.longTailOffer = undefined;
  await writeCtx(convoId, ctx);
  await sendChoices(phone, current, copy.narrowedChoices(current.query));
  return true;
}

async function refineOptions(phone: string, convoId: string, ctx: DeliveryContext, store: StoreConnector, attrs: string[]) {
  const p = ctx.pending![0];
  const base = p.baseQuery ?? p.query;
  const refined = `${base} ${attrs.join(" ")}`;
  let matches = diversifyOptions(refined, await choiceCandidates(store, ctx, p, attrs), vitrineLimit());
  let closest = false;
  if (!matches.length) {
    // 04/09 (dono): "quero do grande masculino"/"100ml" não podem morrer em "não achei".
    // Sem item que case os atributos à risca, a busca roda com a frase refinada inteira
    // (marca + atributos como termos) e mostra o mais perto — verificado ao vivo.
    const broadened = await choiceCandidates(store, ctx, { ...p, query: refined, baseQuery: undefined, attrs: undefined }, []);
    matches = diversifyOptions(refined, broadened, vitrineLimit());
    closest = matches.length > 0;
  }
  if (!matches.length) {
    await reply(phone, copy.refineNoResult(refined));
    await sendChoices(phone, p);
    return;
  }
  p.baseQuery = base;
  p.attrs = attrs;
  p.query = refined;
  // O que JÁ estava na mesa antes do refino — capturado antes de sobrescrever p.options.
  const previouslyShownSkus = p.shownSkus ?? p.options.map((o) => o.sku);
  const previouslyShown = p.shownOptions ?? p.options;
  const remembered = new Set(previouslyShown.map((o) => o.sku));
  p.shownOptions = [...previouslyShown, ...matches.filter((o) => !remembered.has(o.sku))];
  p.options = matches;
  // Histórico de paginação ACUMULA (não substitui): refinar e depois pedir "outras"
  // repetia cards já mostrados, porque o refino apagava o que a paginação usa pra não
  // repetir. Skus fora do refino atual continuam valendo como "já mostrei isso".
  p.shownSkus = [...new Set([...previouslyShownSkus, ...matches.map((m) => m.sku)])];
  await writeCtx(convoId, ctx);
  await sendChoices(phone, p, closest ? copy.refineClosest(attrs.join(" ")) : undefined);
}

// Move to the next pending choice, or quote the finished basket (keeping the
// not-found list so the summary is honest about what's missing).
async function advancePending(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  userCep?: string | null,
  prefix?: string,
  followUpOpts?: { qtyButton?: boolean }
) {
  if (ctx.pending?.length) {
    await writeCtx(convoId, ctx);
    if (prefix) await reply(phone, prefix);
    await sendChoices(phone, ctx.pending[0], copy.nextChoiceHeader(ctx.pending[0].query, ctx.pending.length));
    return;
  }
  ctx.pending = undefined;
  if (!(ctx.basket?.length ?? 0)) {
    await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
    await reply(phone, copy.didNotUnderstand());
    return;
  }
  // No concierge, acabar as escolhas NÃO fecha a lista. O fluxo legado cotava aqui porque
  // escolher era o último passo; aqui o cliente ainda pode somar itens e só fecha quando
  // disser "só isso". Fechar sozinho tiraria dele o controle da lista.
  {
    ctx.step = "collecting";
    ctx.cep = ctx.cep ?? userCep ?? undefined;
    await writeCtx(convoId, ctx);
    // As três saídas naturais pós-escolha viram botão no canal Meta (Pagar /
    // Adicionar mais itens / Cancelar); os ids voltam como texto e caem nos ramos
    // já existentes. Sem Meta (ou falha do envio interativo), o texto de sempre.
    const offerAgain =
      ctx.longTailOffer
        ? copy.longTailOffer(ctx.longTailOffer.lines.map((line) => (line.qty > 1 ? `${line.qty}x ${line.phrase}` : line.phrase)))
        : undefined;
    // Com a confirmação ("✅ produto") o corpo é SÓ ela: os botões já são o próximo passo
    // (dono, 05/10). A instrução fica para quando não há o que confirmar.
    const body = [prefix, offerAgain].filter(Boolean).join("\n") || copy.conciergeChooseNext();
    try {
      markTurnReplied();
      const interactive = await whatsappAdapter.sendChoiceFollowUp(phone, body, followUpOpts);
      if (interactive) return;
    } catch (error) {
      console.warn("[whatsapp:choice-followup:fallback-text]", error instanceof Error ? error.message : error);
    }
    const notes: string[] = [];
    if (prefix) notes.push(prefix);
    if (offerAgain) notes.push(offerAgain);
    notes.push(copy.conciergeKeepAdding());
    await reply(phone, notes.join("\n"));
    return;
  }
}

function itemMatchesPhrase(phrase: string, item: { sku: string; name: string; unitPrice: number }): boolean {
  return scoreCatalogMatch(phrase, item) > 0;
}

// ---------- roteador LLM de fallback (ciclo 30/08) ----------
// Entra SÓ nos becos onde a Lia responderia mal (busca vazia, escolha não entendida):
// classifica a mensagem com contexto e (a) reescreve a busca ("uma 51" → "cachaça 51"),
// (b) normaliza edição de cesta, ou (c) responde pergunta/suporte/papo na voz da Lia —
// com o filtro anti-promessa do lado da IA (sanitizeRouterReply). Uma tentativa por
// turno; OpenAI off/falhou → comportamento determinístico de sempre.

function llmStateSummary(ctx: DeliveryContext): string {
  const parts: string[] = [];
  if (ctx.step === "choosing" && ctx.pending?.length) {
    parts.push(`escolhendo "${ctx.pending[0].query}" com ${ctx.pending[0].options.length} opções na tela`);
  }
  if (ctx.basket?.length) {
    parts.push(`cesta atual: ${ctx.basket.slice(0, 5).map((i) => `${i.qty}x ${i.name}`).join(", ")}`);
  }
  if (ctx.step === "awaiting_payment") parts.push("cobrança aberta aguardando pagamento");
  if (ctx.step === "awaiting_quote_confirmation") parts.push("total apresentado, aguardando escolha de pagamento");
  return parts.join(" · ") || "conversa sem compra em andamento";
}

function classifyFirstEnabled(): boolean {
  return process.env.LIA_CLASSIFY_FIRST !== "false";
}

// Lista de compras evidente (2+ linhas, ou quantidade numérica na frente) não precisa
// do classificador: vai direto pra busca, sem pagar a chamada de IA.
function looksLikeProductList(text: string): boolean {
  if (parseBasketLines(text).length >= 2) return true;
  // Saudação na frente ("Ola quero 2 cxs de…", 06/10) não muda o que a mensagem é.
  const n = normalizeMsg(text).replace(/^(?:(?:oi+|ola+|opa+|bom dia|boa tarde|boa noite|e ?ai)(?:\s+lia)?[\s,!.]*)+/, "");
  return /^\d+\s*x?\s+\S/.test(n) || /^(quero|queria|me ve|manda|preciso de|traz|compra)\s+\d/.test(n);
}

async function tryLlmInterpret(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  text: string,
  userId?: string
): Promise<boolean> {
  const meta = turnMeta.getStore();
  if (meta?.llmUsed) return false;
  if (meta) meta.llmUsed = true;
  const verdict = await interpretCustomerMessage({ text, state: llmStateSummary(ctx) });
  if (!verdict) return false;
  const rePresent = async () => {
    if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
  };
  console.log("[llm-router]", verdict.action, JSON.stringify(text.slice(0, 60)));
  if (verdict.action === "unknown") {
    // "Não sei" é resposta legítima (revisão 02/09): pergunta que nem a IA classifica não
    // vira busca de produto. Frase sem interrogação segue pro caminho determinístico.
    if (isQuestion(text)) {
      await reply(phone, copy.questionNotUnderstood());
      await rePresent();
      return true;
    }
    return false;
  }
  if (verdict.action === "product_request" && verdict.productRequest) {
    // Só re-busca se a IA de fato REESCREVEU (senão vira loop do mesmo não-achado).
    if (normalizeMsg(verdict.productRequest) === normalizeMsg(text)) return false;
    if (meta) meta.routerQuery = verdict.productRequest;
    await handleSearch(phone, convoId, userCep, ctx, verdict.productRequest, userId);
    return true;
  }
  if (verdict.action === "basket_edit" && verdict.editCommand) {
    const edited = detectIntent(verdict.editCommand);
    if (edited.kind === "swap_item") {
      await reopenOrderForEdit(phone, convoId, ctx, userCep);
      await handleSwap(phone, convoId, userCep, ctx, edited.from, edited.to, verdict.editCommand, edited.attr);
      return true;
    }
    if (edited.kind === "remove_item") {
      await reopenOrderForEdit(phone, convoId, ctx, userCep);
      await handleRemove(phone, convoId, userCep, ctx, edited.target, { silentIfFound: Boolean(edited.andAdd) });
      if (edited.andAdd) await handleSearch(phone, convoId, userCep, ctx, edited.andAdd, userId);
      return true;
    }
    if (edited.kind === "free_text") {
      await handleSearch(phone, convoId, userCep, ctx, verdict.editCommand, userId);
      return true;
    }
    return false;
  }
  if (
    verdict.action === "question" ||
    verdict.action === "support" ||
    verdict.action === "smalltalk" ||
    verdict.action === "manipulation"
  ) {
    // Resposta livre já passou pelo filtro anti-promessa; sem ela, copy segura da ação.
    const fallbackByAction: Record<string, string> = {
      question: copy.questionNotUnderstood(),
      support: copy.supportGenericAck(),
      smalltalk: copy.thanks(),
      manipulation: copy.metaProbeAnswer()
    };
    await reply(phone, verdict.reply ?? fallbackByAction[verdict.action]);
    if (verdict.action === "support" && userId) {
      await flagLatestOrder(userId, `🆘 SUPORTE (via IA): "${text.slice(0, 140)}"`);
      await notifyOwner(`🆘 Cliente com problema (classificado pela IA): "${text.slice(0, 140)}"`, phone);
    }
    await rePresent();
    return true;
  }
  return false;
}

// Categorias que a remoção "tira tudo que for de X" sabe separar (28/08 S15).
const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  limpeza:
    /\b(sabao|detergente|desinfetante|amaciante|alvejante|agua sanitaria|multiuso|limpador|limpa|esponja|lustra|desengordurante|sapolio|veja|omo|ype|cif|pinho)\b/,
  bebida: /\b(refrigerante|coca|guarana|fanta|sprite|suco|cerveja|breja|vinho|cachaca|vodka|agua|energetico|cha|isotonico|gatorade)\b/,
  bebidas: /\b(refrigerante|coca|guarana|fanta|sprite|suco|cerveja|breja|vinho|cachaca|vodka|agua|energetico|cha|isotonico|gatorade)\b/,
  higiene: /\b(shampoo|condicionador|sabonete|creme dental|pasta de dente|escova|desodorante|papel higienico|absorvente|fralda|cotonete)\b/,
  doce: /\b(chocolate|bombom|bala|doce|biscoito|bolacha|sobremesa|acucar)\b/,
  doces: /\b(chocolate|bombom|bala|doce|biscoito|bolacha|sobremesa|acucar)\b/
};

async function handleRemove(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  target: string,
  opts?: { silentIfFound?: boolean }
) {
  const basket = ctx.basket ?? [];
  const pending = ctx.pending ?? [];
  if (!basket.length && !pending.length) {
    await reply(phone, copy.removeNotFound());
    return;
  }
  // "tira tudo que for de LIMPEZA": remoção por categoria — só os itens da categoria
  // saem, nunca a cesta inteira (28/08 S15: apagou os 12 itens). Categoria que a Lia
  // não sabe separar → resposta honesta pedindo os itens.
  const categoryAsk = normalizeMsg(target).match(/^(?:tudo|todos|todas)\s+(?:o\s+|os\s+|as\s+)?(?:que\s+(?:for|seja|sao|são|e|eh)\s+)?(?:de\s+|da\s+|do\s+|d[ao]s\s+)?(.+)$/);
  const matchesTarget = (name: string): boolean => {
    if (!categoryAsk) return false;
    const cat = categoryAsk[1].trim();
    const rule = CATEGORY_KEYWORDS[cat] ?? CATEGORY_KEYWORDS[cat.replace(/s$/, "")];
    return rule ? rule.test(normalizeMsg(name)) : false;
  };
  if (categoryAsk && !CATEGORY_KEYWORDS[categoryAsk[1].trim()] && !CATEGORY_KEYWORDS[categoryAsk[1].trim().replace(/s$/, "")]) {
    await reply(phone, copy.categoryRemoveUnknown(categoryAsk[1].trim()));
    return;
  }
  const keep = basket.filter((item) => (categoryAsk ? !matchesTarget(item.name) : !itemMatchesPhrase(target, item)));
  const removed = basket.filter((item) => !keep.includes(item));
  const pendingKeep = pending.filter((p) =>
    categoryAsk ? !matchesTarget(p.query) : !itemMatchesPhrase(target, { sku: p.query, name: p.query, unitPrice: 0 })
  );
  const removedPending = pending.filter((p) => !pendingKeep.includes(p));
  if (!removed.length && !removedPending.length) {
    await reply(phone, copy.removeNotFound());
    return;
  }
  ctx.basket = keep;
  ctx.pending = pendingKeep.length ? pendingKeep : undefined;
  const names = [...removed.map((i) => i.name), ...removedPending.map((p) => p.query)].join(", ");

  if (ctx.pending?.length) {
    ctx.step = "choosing";
    await writeCtx(convoId, ctx);
    await reply(phone, copy.removedItems(names, false));
    await sendChoices(phone, ctx.pending[0]);
    return;
  }
  if (!keep.length) {
    await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
    await reply(phone, copy.removedItems(names, !opts?.silentIfFound));
    return;
  }
  // remove+add ("tira X e coloca Y"): não cota agora — o add que vem em seguida cota.
  if (opts?.silentIfFound) {
    await writeCtx(convoId, ctx);
    await reply(phone, copy.removedItems(names, false));
    return;
  }
  await continueAfterBasket(phone, convoId, ctx, userCep, copy.removedItems(names, false));
}

async function handleSwap(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  from: string,
  to: string,
  rawText?: string,
  attrSwap?: boolean
) {
  const basket = ctx.basket ?? [];
  // "quero A e B; pensando bem, troca B por C" numa LISTA NOVA (cesta vazia): não há o
  // que remover — a autocorreção vale para a PRÓPRIA mensagem. Monta a lista corrigida
  // (linhas antes do "troca", menos o B, mais o C) e segue o fluxo normal de busca
  // (3º ciclo de testes 15/08, rodada 3: respondia "não achei pra tirar").
  if (!basket.length && !(ctx.pending?.length)) {
    const before = (rawText ?? "").split(/\b(?:troca|trocar|substitui|substituir|muda|mudar)\b/i)[0] ?? "";
    const keptLines = parseBasketLines(before).filter(
      (l) => queryTokens(l.phrase).length && !itemMatchesPhrase(from, { sku: l.phrase, name: l.phrase, unitPrice: 0 })
    );
    const corrected = [...keptLines.map((l) => (l.qtyExplicit && l.qty > 1 ? `${l.qty} ${l.phrase}` : l.phrase)), to]
      .filter(Boolean)
      .join(", ");
    if (corrected.trim()) {
      await handleSearch(phone, convoId, userCep, ctx, corrected);
      return;
    }
    await reply(phone, copy.removeNotFound());
    return;
  }
  if (!basket.length) {
    await reply(phone, copy.removeNotFound());
    return;
  }
  let keep = basket.filter((item) => !itemMatchesPhrase(from, item));
  let removed = basket.filter((item) => !keep.includes(item));
  // Referência à cesta ≠ busca: "não quero DE UVA" aponta pro suco de uva da cesta,
  // mas a regra de aposição da BUSCA zera "uva" contra "Suco de Uva" (qualificador
  // não responde pedido de 1 palavra). Pra remoção, presença do token basta — desde
  // que aponte pra UM item só (ambíguo mantém o comportamento antigo).
  if (!removed.length && from) {
    const fromTokens = queryTokens(from);
    const byFrom = basket.filter((item) => {
      const nameTokens = new Set(queryTokens(item.name));
      return fromTokens.length > 0 && fromTokens.every((t) => nameTokens.has(t));
    });
    if (byFrom.length === 1) {
      removed = byFrom;
      keep = basket.filter((item) => item !== byFrom[0]);
    }
  }
  // "coca zero em vez da NORMAL": o from ("normal") não nomeia produto nenhum — mas o
  // TO compartilha token com exatamente UM item da cesta (a coca). Esse item é o alvo.
  if (!removed.length && to) {
    const toTokens = queryTokens(to);
    const byTo = basket.filter((item) => {
      const nameTokens = new Set(queryTokens(item.name));
      return toTokens.some((t) => nameTokens.has(t));
    });
    if (byTo.length === 1) {
      removed = byTo;
      keep = basket.filter((item) => item !== byTo[0]);
    }
  }
  // The swapped-out item may still be an unresolved pending choice, not a basket line.
  const pending = ctx.pending ?? [];
  const pendingKeep = pending.filter((p) => !itemMatchesPhrase(from, { sku: p.query, name: p.query, unitPrice: 0 }));
  const removedPending = pending.filter((p) => !pendingKeep.includes(p));
  if (!removed.length && !removedPending.length) {
    await reply(phone, copy.removeNotFound());
    return;
  }
  if (!to) {
    await reply(phone, copy.swapAskWhat([...removed.map((i) => i.name), ...removedPending.map((p) => p.query)].join(", ")));
    return;
  }
  ctx.basket = keep;
  ctx.pending = pendingKeep.length ? pendingKeep : undefined;
  const removedNames = [...removed.map((i) => i.name), ...removedPending.map((p) => p.query)].join(", ");
  const qty = removed[0]?.qty ?? removedPending[0]?.qty ?? 1;
  const store = orderStore(ctx);
  // "troca X por Y" busca nas MESMAS vitrines que o pedido normal. Como no concierge
  // `ctx.storeKey` é "concierge", `orderStore` caía na loja default e o Y só era
  // procurado no Carrefour — as outras 17 vitrines ficavam invisíveis nesse comando.
  const crossStore = !ctx.storeKey || ctx.storeKey === CONCIERGE_STORE_KEY;
  // Troca de ATRIBUTO ("não quero de uva, quero de laranja"): buscar "laranja" solta
  // acharia a fruta — compõe com o substantivo do item trocado ("suco laranja"). Só na
  // frase de atributo (attr) e quando o to ainda não carrega o substantivo.
  let searchPhrase = to;
  const removedHead = removed[0] ? queryTokens(removed[0].name)[0] : undefined;
  if (attrSwap && removedHead && !queryTokens(to).includes(removedHead)) {
    searchPhrase = `${removedHead} ${to}`;
  }
  const candidates: StoreCandidate[] = crossStore
    ? await gatherCrossStoreCandidates(searchPhrase, 12)
    : (await store.searchItems(searchPhrase, 3)).map((item) => ({ store, item }));
  // 06/10: a troca também só oferece o que a loja confirmou para o CEP (sem operador, o
  // não confirmado é beco no "pagar").
  const confirmed = await confirmOptionsLive(
    candidates
      .filter((c) => conciergeMatchIsStrong(searchPhrase, c.item))
      .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label })),
    ctx.cep ?? userCep
  );
  const options = diversifyOptions(searchPhrase, confirmed, vitrineLimit());

  if (!options.length) {
    // TROCA É ATÔMICA (26/08 P1.7): sem substituto forte, o item original FICA — tirar
    // o frango sem incluir o peixe deixava a cesta mutilada em silêncio.
    ctx.basket = basket;
    ctx.pending = pending.length ? pending : undefined;
    await writeCtx(convoId, ctx);
    await reply(phone, copy.swapKeptOriginal(removedNames, to));
    return;
  }
  if (options.length === 1 && !(ctx.pending?.length)) {
    const only = options[0];
    ctx.basket = mergeBaskets(ctx.basket ?? [], [choiceToBasketItem(only, qty, only.storeKey ? getStore(only.storeKey) : store)]);
    await continueAfterBasket(phone, convoId, ctx, userCep, copy.swappedFor(removedNames, only.name));
    return;
  }
  ctx.pending = [
    {
      query: to,
      qty,
      options
    },
    ...(ctx.pending ?? [])
  ];
  ctx.step = "choosing";
  await writeCtx(convoId, ctx);
  await reply(phone, copy.swapRemovedPrefix(removedNames));
  await sendChoices(phone, ctx.pending[0]);
}

// Concierge mode request: parse the message into free-form lines (medicine still
// filtered by law), add them to the basket and confirm — no catalog, no options step.
async function handleConciergeRequest(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  text: string,
  userId?: string
) {
  // LISTA ENCAMINHADA (pedido do dono, 20/08): mensagem com 3+ linhas de itens não
  // vira interrogatório de cards — a Lia escolhe o melhor match de cada linha (mesmo
  // ranking da escolha) e monta a cesta inteira de uma vez; "troca X por Y"/"tira X"
  // ajustam depois. Numeração de lista ("1. coca") é índice, não quantidade.
  text = stripListNumbering(text);
  const bulkList = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).length >= 3;
  // "Pode colocar mais um leite": adição RELATIVA a um item que já está na cesta herda
  // o item exato (sku) — a busca genérica perdia o atributo ("sem lactose" virava leite
  // integral; 3º ciclo de testes 15/08, rodadas 3 e 8).
  const moreOf = normalizeMsg(text).match(
    /^(?:(?:pode|coloca|poe|bota|adiciona|acrescenta|quero|queria|me ve|manda|e)\s+)*(?:colocar\s+|adicionar\s+)?mais\s+(.+)$/
  );
  if (moreOf && ctx.basket?.length) {
    const lines = parseBasketLines(moreOf[1]).filter((l) => queryTokens(l.phrase).length);
    if (lines.length === 1) {
      const target = [...ctx.basket].reverse().find((item) => itemMatchesPhrase(lines[0].phrase, item));
      if (target) {
        const add = Math.max(1, lines[0].qty);
        target.qty = Math.min(50, target.qty + add);
        target.lineTotal = Math.round(target.unitPrice * target.qty * 100) / 100;
        await writeCtx(convoId, ctx);
        await replyBasketAdjusted(phone, copy.moreOfSameAddedShort(target.qty, target.name), copy.moreOfSameAdded(add, target.name, target.qty));
        return;
      }
    }
  }

  // Vitrine híbrida: procura o que o cliente pediu nas 18 lojas e mostra até 3 opções com
  // foto para ele escolher. O que NÃO tiver match vira linha livre, como antes — a largura
  // ("qualquer coisa, de qualquer lugar") continua sendo o moat e nada é recusado.
  //
  // Sem travar loja (`lockedStoreKey` fica indefinido): no concierge quem compra é o
  // operador, que vai em quantas lojas precisar. A cesta pode ser mista, diferente do fluxo
  // legado, onde um pedido = uma loja = uma entrega do varejista.
  // ML ligado = a busca pode custar ~25s numa consulta fria (medido 16/08). O cliente
  // não pode ficar no silêncio: avisa ANTES e as opções chegam na mensagem seguinte.
  // Busca quente (cache) não avisa — responde na hora, como sempre.
  // Memória do cliente: o que ele já comprou sobe no ranking. Estava ligado só no fluxo
  // legado — no concierge nunca rodou (revisão 02/09).
  const preferred = userId ? await preferredSkuCounts(userId) : undefined;
  const raw = mercadoLivreEnabled()
    ? await buildChoicesWithSearchNotice(phone, text, undefined, preferred, undefined, ctx.cep ?? userCep)
    : await buildChoices(text, undefined, preferred, undefined, undefined, ctx.cep ?? userCep);
  // Piso de relevância próprio do concierge: opção que não responde pelo que o cliente
  // escreveu é descartada e a linha volta a ser livre. Sugerir errado é pior que não
  // sugerir, porque a linha livre resolve o pedido de verdade.
  //
  // Quando o rerank de IA rodou, ELE é o piso: já descartou o que não serve e entende
  // sinônimos que o piso léxico mata ("escova de dente" ≈ "Escova Dental"). Rodar o
  // piso por cima desfaria exatamente esses acertos.
  const pending: PendingChoice[] = [];
  const weakLines: ParsedLine[] = [];
  for (const choice of raw.pending) {
    const strong = raw.reranked
      ? choice.options
      : choice.options.filter((option) => conciergeMatchIsStrong(choice.query, option));
    if (strong.length) pending.push({ ...choice, options: strong });
    else {
      const rawPhrase = raw.lines.find((line) => normalizeMsg(line.phrase) === normalizeMsg(choice.query))?.raw;
      weakLines.push({
        phrase: choice.query,
        qty: choice.qty,
        ...(choice.qtyExplicit ? { qtyExplicit: true } : {}),
        ...(choice.cap != null ? { cap: choice.cap } : {}),
        ...(rawPhrase ? { raw: rawPhrase } : {})
      });
    }
  }
  let notFoundLines = [...raw.notFoundLines, ...weakLines];
  const { greetingOnly, containsMedicine } = raw;

  // ÚLTIMA CHANCE antes de dizer "não tenho": as linhas que o pipeline inteiro
  // descartou (piso + rerank) vão ao fornecedor de cauda longa mesmo que alguma
  // vitrine local tenha "casado" — caso real 17/08: "violão" batia no brinquedo da
  // Patrulha Canina, o gate achava que estava resolvido, o rerank descartava o
  // brinquedo (certíssimo) e o cliente ficava sem violão. Custo do ML só é pago aqui,
  // no exato caso em que a alternativa era recusar.
  const turnElapsedMs = Date.now() - (turnStartedAt.get(phone) ?? Date.now());
  const rescueBudgetMs = Number(process.env.LIA_RESCUE_BUDGET_MS ?? 120000);
  // Sem pergunta (dono, 07/09): o ML entra sozinho no que as vitrines não resolveram.
  const optIn = longTailOptInEnabled();
  // A busca no ML usa a frase COMPLETA do cliente quando a IA encurtou (06/09).
  const rescuePhrase = (line: ParsedLine) => line.raw ?? line.phrase;
  if (notFoundLines.length && mercadoLivreEnabled() && !optIn && turnElapsedMs > rescueBudgetMs) {
    // O resgate custa mais uma rodada inteira (extração + actor + rerank, ~40-70s). Com
    // o turno já estourado, recusar honesto AGORA vence morrer no teto da função em
    // silêncio (caso real 19/08).
    console.warn(`[search:rescue-skipped] turno com ${Math.round(turnElapsedMs / 1000)}s; recusa honesta sem 2ª rodada`);
  }
  if (notFoundLines.length && mercadoLivreEnabled() && !optIn && turnElapsedMs <= rescueBudgetMs) {
    // O retry vai re-extrair e re-rankear (~3-6s de IA); o run do ML começa já, com a
    // frase determinística, e a busca do retry se acopla a ele (dedupe em voo).
    for (const line of notFoundLines) prefetchMercadoLivre(splitPriceCap(rescuePhrase(line)).phrase);
    // O teto volta pra frase do retry: o resgate re-extrai e o cap re-filtra no build
    // (26/08: presente "até R$50" resgatado no ML saía sem teto nenhum).
    const retryText = notFoundLines
      .map((line) => (line.cap != null ? `${rescuePhrase(line)} até ${line.cap} reais` : rescuePhrase(line)))
      .join(", ");
    const retry = await buildChoicesWithSearchNotice(phone, retryText, undefined, undefined, true, ctx.cep ?? userCep);
    const rescued: PendingChoice[] = [];
    for (const choice of retry.pending) {
      const strong = retry.reranked
        ? choice.options
        : choice.options.filter((option) => conciergeMatchIsStrong(choice.query, option));
      if (strong.length) rescued.push({ ...choice, options: strong });
    }
    if (rescued.length) {
      // A linha resgatada sai de "não tenho" e vira escolha normal, com a quantidade
      // que o cliente pediu na mensagem original.
      const rescuedQueries = new Set(rescued.map((choice) => normalizeMsg(choice.query)));
      const wasRescued = (line: ParsedLine) => rescuedQueries.has(normalizeMsg(line.phrase)) || (line.raw ? rescuedQueries.has(normalizeMsg(line.raw)) : false);
      notFoundLines = notFoundLines.filter((line) => !wasRescued(line));
      for (const choice of rescued) {
        const original = [...raw.notFoundLines, ...weakLines].find(
          (line) => [line.phrase, line.raw].some((v) => v && normalizeMsg(v) === normalizeMsg(choice.query))
        );
        pending.push(original?.qtyExplicit ? { ...choice, qty: original.qty, qtyExplicit: true } : choice);
      }
    }
  }
  // Modo opt-in (só com LIA_LONGTAIL_OPTIN=true): o que as vitrines não cobriram vira a
  // PERGUNTA "procuro no Mercado Livre?"; "sim" cai em rescueLongTail. Desde 07/09 o
  // padrão é o resgate automático acima — este bloco fica como kill-switch de custo.
  const offerLongTail = notFoundLines.length > 0 && mercadoLivreEnabled() && optIn;
  ctx.longTailOffer = offerLongTail
    ? {
        lines: notFoundLines.map((line) => ({
          phrase: line.phrase,
          qty: line.qty,
          ...(line.qtyExplicit ? { qtyExplicit: true } : {}),
          ...(line.cap != null ? { cap: line.cap } : {}),
          ...(line.raw ? { raw: line.raw } : {})
        }))
      }
    : undefined;
  if (greetingOnly && !pending.length && !notFoundLines.length) {
    await reply(phone, copy.greeting());
    return;
  }
  if (!pending.length && !notFoundLines.length) {
    if (containsMedicine) {
      await reply(phone, noMedicineCopy());
    } else if (raw.containsTobacco) {
      await reply(phone, copy.tobaccoRefusal());
    } else {
      // Beco clássico: mensagem sem produto e sem intent. O roteador LLM tenta
      // entender (pergunta? edição? frase de produto mal escrita?) antes do genérico.
      if (await tryLlmInterpret(phone, convoId, userCep, ctx, text, userId)) return;
      await reply(phone, copy.didNotUnderstand());
    }
    return;
  }

  const hadBasket = (ctx.basket?.length ?? 0) > 0;
  // Regra do dono (11/08): item sem preço nas lojas parceiras NUNCA vira espera de
  // cotação — "se não tem, fala que não tem". A linha livre saiu do fluxo do cliente:
  // só item com preço entra na cesta, e por isso todo fechamento tem total NA HORA.
  // 06/10: linha que TINHA produto, mas nenhuma loja confirmou para o CEP, não é "não
  // achei" — é "não consigo comprar agora" (a vitrine não mostra opção que não fecha).
  const unconfirmedSet = new Set((raw.unconfirmed ?? []).map((phrase) => normalizeMsg(phrase)));
  const lineLabel = (line: ParsedLine) => (line.qty > 1 ? `${line.qty}x ${line.phrase}` : line.phrase);
  const unbuyable = notFoundLines.filter((line) => unconfirmedSet.has(normalizeMsg(line.phrase))).map(lineLabel);
  const unavailable = notFoundLines.filter((line) => !unconfirmedSet.has(normalizeMsg(line.phrase))).map(lineLabel);
  // Remédio pelo nome que não está entre os isentos (06/10, Euthyrox): diz o porquê.
  const medicineMiss = medicineEnabled() && unavailable.length > 0 && unavailable.every(looksLikeMedicineName);
  const notFoundNote = (withOptions: boolean) =>
    [
      !unavailable.length
        ? null
        : offerLongTail
          ? copy.longTailOffer(unavailable)
          : withOptions
            ? copy.itemsNotAvailableWithOptions(unavailable)
            : medicineMiss
              ? copy.medicineNotFound(unavailable)
              : copy.itemsNotAvailable(unavailable),
      unbuyable.length ? copy.itemsNotBuyableNow(unbuyable) : null
    ]
      .filter(Boolean)
      .join("\n");
  const hasNotFound = unavailable.length > 0 || unbuyable.length > 0;
  ctx.flow = "delivery";
  // A cesta continua pertencendo ao "concierge" mesmo quando o item veio de uma vitrine: o
  // pedido é cotado e comprado à mão, então não há uma loja dona do pedido.
  ctx.storeKey = CONCIERGE_STORE_KEY;
  ctx.cep = ctx.cep ?? userCep ?? undefined;
  ctx.notFound = undefined;

  // "escolhe vc"/"qualquer um": a linha marcada auto-escolhe o topo do ranking, com
  // confirmação do que entrou (28/08 S6 — "escolhe vc" virava item não-achado).
  const autoPickPending = pending.filter((choice) => choice.autoPick && choice.options.length);
  if (autoPickPending.length) {
    const packNotes: string[] = [];
    const added: BasketItem[] = [];
    for (const choice of autoPickPending) {
      const top = choice.options[0];
      const store = top.storeKey ? getStore(top.storeKey) : orderStore(ctx);
      const adj = packAdjusted(top.name, Math.max(1, choice.qty));
      if (adj.note) packNotes.push(adj.note);
      added.push(choiceToBasketItem(top, adj.qty, store));
    }
    ctx.basket = mergeBaskets(ctx.basket ?? [], added);
    const rest = pending.filter((choice) => !autoPickPending.includes(choice));
    ctx.pending = rest.length ? rest : undefined;
    ctx.step = rest.length ? "choosing" : "collecting";
    const notes: string[] = [copy.autoAddedNote(added.map((i) => `${i.qty}x ${i.name}`)), ...packNotes];
    if (containsMedicine) notes.push(medicineSkippedCopy());
    if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
    if (hasNotFound) notes.push(notFoundNote(false));
    if (rest.length) {
      await writeCtx(convoId, ctx);
      await reply(phone, notes.join("\n"));
      await sendChoices(phone, rest[0]);
      return;
    }
    await advancePending(phone, convoId, ctx, userCep, notes.join("\n"));
    return;
  }

  // Modo lista: 2+ itens resolvidos de uma mensagem de 3+ linhas → cesta direta com o
  // topo do ranking de cada linha (rerank/determinístico — o mesmo que "escolhe você").
  // Sem cards por item (10 cards é spam); o resumo sai com os botões de sempre e
  // "troca"/"tira"/"opções de X" continuam valendo item a item.
  if (pending.length >= 2 && bulkList) {
    // Item CARO não entra sozinho na cesta (26/08: peça de trator de R$2.556 foi
    // auto-escolhida de uma descrição vaga; 27/08 S5: furadeira de R$142 idem). Acima
    // do teto, a linha vira escolha com cards — o resto da lista continua automático.
    // Cesta como CONJUNTO (P1.8): entre as opções aprovadas de cada linha, escolhe a
    // combinação que minimiza produtos+frete — e ANUNCIA cada troca (lição da rodada
    // 2: mudança silenciosa de produto é quebra de confiança). Só aplica quando a
    // economia é real (≥ R$3) e nunca é kill: LIA_BASKET_COMPOSER_OFF desliga.
    const composedNotes: string[] = [];
    if (process.env.LIA_BASKET_COMPOSER_OFF !== "true" && pending.length >= 2) {
      const composition = composeBasket(
        pending.map((p) => ({
          qty: Math.max(1, p.qty),
          options: p.options.map((o) => ({
            sku: o.sku,
            name: o.name,
            unitPrice: o.unitPrice,
            storeKey: o.storeKey,
            storeLabel: o.storeLabel
          }))
        })),
        display,
        (storeKey, storeLabel, subtotal) => storeFreight(storeKey, storeLabel ?? storeKey, subtotal).fee
      );
      const saved = Math.round((composition.before.total - composition.after.total) * 100) / 100;
      if (composition.moves.length && saved >= 3) {
        for (let i = 0; i < pending.length; i++) {
          const pick = composition.picks[i];
          if (pick > 0) {
            const line = pending[i];
            const chosen = line.options[pick];
            line.options = [chosen, ...line.options.filter((_, j) => j !== pick)];
          }
        }
        composedNotes.push(
          copy.bundledDeliveriesNote({
            moves: composition.moves.map((m) => ({
              fromName: m.fromName,
              fromStore: m.fromStore,
              toName: m.toName,
              toStore: m.toStore
            })),
            storesBefore: composition.before.stores,
            storesAfter: composition.after.stores,
            saved
          })
        );
        console.log("[basket-composer]", `${composition.before.stores}→${composition.after.stores} lojas, -R$${saved}`);
      }
    }
    const autopickMax = Number(process.env.LIA_BULK_AUTOPICK_MAX ?? 100);
    // O teto vale pra LINHA (preço × quantidade após conversão de embalagem), não só
    // pra unidade — 12x de um item de R$18 entrava sozinho por R$217 (29/08 S4).
    const lineDisplayOf = (choice: PendingChoice) => {
      const top = choice.options[0];
      const adj = packAdjusted(top.name, Math.max(1, choice.qty));
      return display(top.unitPrice, top.medicine) * adj.qty;
    };
    const auto = pending.filter((choice) => lineDisplayOf(choice) <= autopickMax);
    const confirm = pending.filter((choice) => lineDisplayOf(choice) > autopickMax);
    const added: BasketItem[] = [];
    const packNotes: string[] = [];
    for (const choice of auto) {
      const top = choice.options[0];
      const store = top.storeKey ? getStore(top.storeKey) : orderStore(ctx);
      const adj = packAdjusted(top.name, Math.max(1, choice.qty));
      if (adj.note) packNotes.push(adj.note);
      added.push(choiceToBasketItem(top, adj.qty, store));
    }
    ctx.basket = mergeBaskets(ctx.basket ?? [], added);
    ctx.pending = confirm.length ? confirm : undefined;
    ctx.step = confirm.length ? "choosing" : "collecting";
    if (confirm.length) {
      const notes: string[] = [];
      if (added.length) {
        notes.push(
          copy.bulkBasketAdded(added.map((i) => ({ qty: i.qty, name: i.name, total: display(i.unitPrice, i.medicine) * i.qty })))
        );
      }
      notes.push(...composedNotes);
      notes.push(...packNotes);
      if (containsMedicine) notes.push(medicineSkippedCopy());
      if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
      if (hasNotFound) notes.push(notFoundNote(false));
      await writeCtx(convoId, ctx);
      if (notes.length) await reply(phone, notes.join("\n"));
      await sendChoices(phone, confirm[0]);
      return;
    }
    const notes: string[] = [
      copy.bulkBasketAdded(added.map((i) => ({ qty: i.qty, name: i.name, total: display(i.unitPrice, i.medicine) * i.qty })))
    ];
    notes.push(...composedNotes);
    notes.push(...packNotes);
    if (containsMedicine) notes.push(medicineSkippedCopy());
    if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
    if (hasNotFound) notes.push(notFoundNote(false));
    await advancePending(phone, convoId, ctx, userCep, notes.join("\n"));
    return;
  }

  if (pending.length) {
    ctx.step = "choosing";
    ctx.pending = pending;
    await writeCtx(convoId, ctx);
    const notes: string[] = [];
    if (containsMedicine) notes.push(medicineSkippedCopy());
    if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
    // Os itens sem preço são recusados ANTES das opções — mas com escopo explícito:
    // "não achei X — o resto tá abaixo" (a copy global parecia contradição, 19/08).
    if (hasNotFound) notes.push(notFoundNote(true));
    if (notes.length) await reply(phone, notes.join("\n"));
    if (pending.length > 1) await reply(phone, copy.choiceSequence(pending.map((p) => p.query)));
    await sendChoices(phone, pending[0]);
    return;
  }

  // Nada com preço nesta mensagem: recusa honesta na hora; a cesta que já existia fica
  // exatamente como estava.
  if (hadBasket) ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  // NADA achou preço: o roteador LLM tenta entender a mensagem (pergunta? "uma 51"?
  // edição?) antes do eco de não-achado — o eco fazia "posso agendar a entrega pra…"
  // virar produto (29/08: 6 sessões nesse padrão).
  // Remédio não achado já tem resposta certa: a segunda busca pela IA só atrasava (>45 s).
  if (!containsMedicine && !raw.containsTobacco && !medicineMiss) {
    if (await tryLlmInterpret(phone, convoId, userCep, ctx, text, userId)) return;
    if (isQuestion(text)) {
      await reply(phone, copy.questionNotUnderstood());
      return;
    }
  }
  const notes: string[] = [];
  if (containsMedicine) notes.push(medicineSkippedCopy());
  if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
  notes.push(notFoundNote(false));
  if (offerLongTail) {
    try {
      markTurnReplied();
      const interactive = await whatsappAdapter.sendLongTailOfferButtons(phone, notes.join("\n"));
      if (interactive) return;
    } catch (error) {
      console.warn("[longtail:offer-buttons:fallback-text]", error instanceof Error ? error.message : error);
    }
  }
  await reply(phone, notes.join("\n"));
}

// "sim" à oferta da cauda longa: a mesma rodada de resgate que antes era automática
// (extração + actor + rerank), agora só quando o cliente pediu (revisão 02/09).
async function rescueLongTail(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  lines: NonNullable<DeliveryContext["longTailOffer"]>["lines"],
  userId?: string
) {
  void userId;
  const unavailable = lines.map((line) => (line.qty > 1 ? `${line.qty}x ${line.phrase}` : line.phrase));
  // A busca no ML usa a frase COMPLETA do cliente quando a IA encurtou (06/09).
  const searchPhrase = (line: (typeof lines)[number]) => line.raw ?? line.phrase;
  for (const line of lines) prefetchMercadoLivre(splitPriceCap(searchPhrase(line)).phrase);
  const retryText = lines.map((line) => (line.cap != null ? `${searchPhrase(line)} até ${line.cap} reais` : searchPhrase(line))).join(", ");
  const retry = await buildChoicesWithSearchNotice(phone, retryText, undefined, undefined, true, ctx.cep ?? userCep);
  const rescued: PendingChoice[] = [];
  for (const choice of retry.pending) {
    const strong = retry.reranked ? choice.options : choice.options.filter((option) => conciergeMatchIsStrong(choice.query, option));
    if (!strong.length) continue;
    const original = lines.find((line) => [line.phrase, line.raw].some((v) => v && normalizeMsg(v) === normalizeMsg(choice.query)));
    rescued.push(original?.qtyExplicit ? { ...choice, options: strong, qty: original.qty, qtyExplicit: true } : { ...choice, options: strong });
  }
  const rescuedQueries = new Set(rescued.map((choice) => normalizeMsg(choice.query)));
  const still = lines
    .filter((line) => !rescuedQueries.has(normalizeMsg(line.phrase)) && !rescuedQueries.has(normalizeMsg(line.raw ?? "")))
    .map((line) => (line.qty > 1 ? `${line.qty}x ${line.phrase}` : line.phrase));
  ctx.flow = "delivery";
  ctx.storeKey = CONCIERGE_STORE_KEY;
  ctx.cep = ctx.cep ?? userCep ?? undefined;
  if (rescued.length) {
    ctx.step = "choosing";
    // Escolha aberta do MESMO produto ("isqueiro" genérico) é substituída pela busca nova
    // ("isqueiro pra charuto"); escolhas de outros itens continuam na fila.
    ctx.pending = [...rescued, ...(ctx.pending ?? []).filter((p) => !rescued.some((r) => sharesProductNoun(r.query, p.query)))];
    await writeCtx(convoId, ctx);
    if (still.length) await reply(phone, copy.itemsNotAvailableWithOptions(still));
    if (rescued.length > 1) await reply(phone, copy.choiceSequence(rescued.map((p) => p.query)));
    await sendChoices(phone, rescued[0]);
    return;
  }
  if (ctx.basket?.length) ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  await reply(phone, copy.itemsNotAvailable(unavailable));
}

// "12 ovos" quando o produto é "Ovos ... 10 Unidades": a quantidade pedida é em
// UNIDADES, não embalagens — converte pra embalagens e ANUNCIA (28/08 S9: viraram 12
// caixas de 10 = 120 ovos por R$118). Só quando o nome declara o pack e o pedido é
// maior ou igual a ele.
function packAdjusted(optionName: string, qty: number): { qty: number; note?: string } {
  const m = optionName.match(/(\d{1,3})\s*(?:un\b|unid(?:ades)?\b|ovos\b|rolos\b)/i);
  const pack = m ? Number(m[1]) : 0;
  if (pack >= 4 && qty >= pack) {
    const packs = Math.max(1, Math.round(qty / pack));
    return { qty: packs, note: copy.packConversionNote(qty, pack, packs) };
  }
  return { qty };
}

// Pré-voo barrou a cobrança (04/09): o pedido fechou sem cobrar; o resto da cesta volta
// pro contexto e os itens que a loja não tem são buscados de novo — a verificação ao vivo
// tira a loja que falhou e mostra só o que está confirmado para o CEP.
async function handlePreflightUnavailable(
  phone: string,
  convoId: string,
  user: { id: string; cep: string | null },
  ctx: DeliveryContext,
  unavailable: { storeLabel: string; items: BasketItem[]; remaining: BasketItem[] }
) {
  const next: DeliveryContext = { ...addressOnlyCtx(ctx, user.cep), basket: unavailable.remaining };
  await writeCtx(convoId, next);
  await reply(phone, copy.preflightUnavailable(unavailable.items.map((i) => i.name), unavailable.storeLabel));
  const query = unavailable.items.map((i) => (i.qty > 1 ? `${i.qty} ${i.name}` : i.name)).join(", ");
  await handleSearch(phone, convoId, user.cep, next, query, user.id);
}

// Busca para o plano B (plan-b.ts): as opções da vitrine para um nome de produto, já
// filtradas pela verificação ao vivo do CEP. Auto-adicionados e pendentes juntos.
export async function searchOptionsForPlanB(query: string, cep: string): Promise<ChoiceOption[]> {
  const result = await buildChoices(query, undefined, undefined, undefined, false, cep);
  const fromAuto: ChoiceOption[] = result.autoAdded.map((b) => ({
    sku: b.sku, name: b.name, brand: b.brand, unitPrice: b.unitPrice, productUrl: b.productUrl, storeKey: b.storeKey, storeLabel: b.storeLabel, freeShipping: b.freeShipping
  }));
  return [...fromAuto, ...result.pending.flatMap((p) => p.options)];
}

async function handleSearch(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  text: string,
  userId?: string
) {
  // Demonstrativo SEM substantivo ("quero 2 desse") aponta pro que já está na mesa: nunca
  // é termo de busca. Caso real 15/09: a legenda da foto chegou como mensagem separada, o
  // roteador classificou basket_edit e a palavra "desse" foi buscada — "*2x desse* eu não
  // achei em nenhuma loja". Com opções abertas, pergunta QUAL; sem elas, pede o nome.
  if (isDemonstrativeOnly(text)) {
    if (ctx.pending?.length) await sendChoices(phone, ctx.pending[0], copy.demonstrativeNeedsChoice());
    else await reply(phone, copy.demonstrativeNeedsItem());
    return;
  }
  // Concierge mode: no catalog gate. Whatever the customer asks for becomes a free-form
  // line the operator will source and price. Breadth — "anything from anywhere" — is the
  // moat, and a human buyer needs zero integration to honor it.
  // Pedido por SINTOMA ("algo pra dor de cabeça"): explica o limite de remédio ANTES
  // das opções de conforto (28/08 S3 — mostrou touca térmica sem uma palavra).
  if (looksLikeSymptomAsk(text) && !looksLikeMedicine(text)) {
    await reply(phone, (medicineEnabled() ? copy.symptomExplainerMip() : copy.symptomExplainer()));
  }
  // Urgência ("pra HOJE"): a vitrine responde com dado (04/09) — só o que a loja entrega
  // hoje, ou "nada chega hoje" com o mais rápido. O aviso genérico de 28/08 saiu.
  await handleConciergeRequest(phone, convoId, userCep, ctx, text, userId);
}

async function preferredSkuCounts(userId: string): Promise<Map<string, number>> {
  const orders = await prisma.deliveryOrder.findMany({
    where: { userId, status: { in: REPEATABLE_DELIVERY_ORDER_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { items: true }
  });
  const counts = new Map<string, number>();
  for (const order of orders) {
    for (const item of (order.items as unknown as BasketItem[]) ?? []) {
      counts.set(item.sku, (counts.get(item.sku) ?? 0) + Math.max(1, item.qty));
    }
  }
  return counts;
}

function mergeBaskets(existing: BasketItem[], incoming: BasketItem[]): BasketItem[] {
  const out = [...existing];
  for (const item of incoming) {
    const found = out.find((x) => x.sku === item.sku);
    if (found) {
      found.qty += item.qty;
      found.lineTotal = Math.round(found.unitPrice * found.qty * 100) / 100;
    } else {
      out.push(item);
    }
  }
  return out;
}

// Nome de quem recebe: 2 a 60 letras/espaços; nada de número, link ou frase inteira.
export function parseRecipientName(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim().replace(/^(é|eh|e|o nome é|nome:|pra|para|entrega pra|entregar pra)\s+/i, "");
  if (!/^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(clean) || clean.split(" ").length > 6) return null;
  return clean
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
async function continueAfterBasket(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  userCep?: string | null,
  prefix?: string
) {
  if (!ctx.cep && !userCep) {
    ctx.step = "need_cep";
    await writeCtx(convoId, ctx);
    await reply(phone, copy.askCepForQuote((ctx.basket ?? []).map((i) => `${i.qty}x ${i.name}`)));
    return;
  }
  if (!ctx.cep && userCep) {
    ctx.cep = userCep;
    // Only hit ViaCEP when the human-readable address isn't already known — this
    // runs on every quote, so a saved address must not cost a network round-trip.
    if (!ctx.deliveryAddress) {
      ctx.deliveryAddress = (await expandCep(userCep)).address;
      ctx.deliveryAddressVerified = false;
    }
  }
  if (!ctx.deliveryAddress || !ctx.deliveryAddressVerified) {
    ctx.step = "need_address";
    await writeCtx(convoId, ctx);
    if (prefix) await reply(phone, prefix);
    await askStreetAndNumber(phone, ctx);
    return;
  }
  {
    // Pedido mínimo é regra DA LOJA (o operador compra no site dela): fechar abaixo do
    // mínimo cota, cobra e depois toma recusa no checkout. A checagem existia só no
    // fluxo legado, depois do return acima — no concierge nunca rodava.
    const belowStore = conciergeStoresBelowMinimum(ctx)[0];
    if (belowStore) {
      ctx.step = "collecting";
      await writeCtx(convoId, ctx);
      if (prefix) await reply(phone, prefix);
      await reply(phone, minimumOrderText(ctx, belowStore));
      // A saída de verdade: mesmos itens em loja sem mínimo (teste real 24/08).
      await offerMinimumSwap(phone, convoId, ctx, belowStore);
      return;
    }
    // Destinatário (11/09): só pergunta quando o perfil do WhatsApp não tem nome E a cesta
    // é de uma loja com compra automática — é só aí que o checkout exige o nome (a loja
    // imprime na etiqueta e checkCheckout compara). Nas demais, o operador preenche no /ops.
    const basketStores = [...new Set((ctx.basket ?? []).map((i) => i.storeKey).filter(Boolean))];
    const executableBasket = basketStores.length === 1 && automaticPurchaseStores().includes(basketStores[0] as string);
    if (executableBasket && !ctx.recipientName?.trim()) {
      // O nome completo do cadastro (06/10) também serve de destinatário.
      const profile = await prisma.user.findFirst({ where: { phone }, select: { name: true, cpfName: true } });
      if (!profile?.name?.trim() && !profile?.cpfName?.trim()) {
        ctx.step = "need_recipient_name";
        await writeCtx(convoId, ctx);
        if (prefix) await reply(phone, prefix);
        await reply(phone, copy.askRecipientName());
        return;
      }
    }
    // Remédio isento (29/09): a farmácia vende NO NOME do cliente (nota e dispensação dele).
    // Sem nome completo + CPF guardados, pede uma vez antes de cotar.
    if (medicineEnabled() && hasMip(ctx.basket)) {
      const buyer = await prisma.user.findFirst({ where: { phone }, select: { cpf: true, cpfName: true } });
      if (!buyer?.cpf || !buyer?.cpfName) {
        ctx.step = "need_cpf";
        await writeCtx(convoId, ctx);
        if (prefix) await reply(phone, prefix);
        await reply(phone, copy.askCpfForMedicine());
        return;
      }
    }
    await createOperatorQuoteRequest(phone, convoId, ctx, prefix);
    return;
  }
}

// Concierge finish: the list is closed, so create (or refresh) an order that waits for
// the operator to quote by hand. No catalog price, no fake total — the customer sees the
// real number only after the operator publishes the quote (opsPublishManualQuote).
//
// EXCEÇÃO (decisão do dono, 09/08): cesta 100% de vitrine cota NA HORA — o cliente não
// espera no chat. A Lia publica sozinha a mesma cotação que o operador digitaria
// (subtotal da vitrine + frete POR LOJA, da unidade mais próxima até a casa do cliente;
// 2 lojas = 2 fretes) e o pedido chega ao /ops já indo pra pagamento. Linha livre (sem
// preço) mantém o caminho manual — não se cobra o que não tem preço.
function operatorQuoteEnabled(): boolean {
  return process.env.LIA_OPERATOR_QUOTE === "true";
}

// Fechamento sem operador: tira da cesta o que a loja não confirmou e cota o resto.
async function closeWithoutOperator(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  orderId: string,
  holdupStores: string[] | undefined,
  prefix: string | undefined,
  depth: number
) {
  const basket = ctx.basket ?? [];
  const blocked = holdupStores?.length ? basket.filter((i) => holdupStores.includes(i.storeKey ?? CONCIERGE_STORE_KEY)) : [];
  const rest = basket.filter((i) => !blocked.includes(i));
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
  await prisma.deliveryOrder.updateMany({
    where: { id: orderId, status: AWAITING_OPERATOR_QUOTE_STATUS },
    data: {
      status: "canceled",
      notes: appendOrderNote(current?.notes ?? null, `🚫 Sem cotação automática e sem operador (regra 25/09): ${blocked.length ? `fora — ${blocked.map((i) => i.name).join(", ")}` : "loja não confirmou o total"}.`)
    }
  });
  if (prefix) await reply(phone, prefix);
  // Falha sem culpado identificado (loja fora do ar, erro): a cesta fica, o cliente tenta de novo.
  if (!blocked.length) {
    await writeCtx(convoId, { ...addressOnlyCtx(ctx), storeKey: CONCIERGE_STORE_KEY, basket, ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}) });
    await reply(phone, copy.quoteUnavailableNow());
    return;
  }
  const names = blocked.map((i) => (i.qty > 1 ? `${i.qty}x ${i.name}` : i.name));
  // O único item era a escolha de uma vitrine e ela tem OUTRAS opções (05/10: Pacheco sem
  // confirmação, o cliente teve de buscar tudo de novo): as outras voltam na hora, sem a
  // que falhou — o cliente só toca em outra.
  const others = blocked.length === 1 && !rest.length && ctx.lastChoice?.chosenSku === blocked[0].sku
    ? [...new Map([...ctx.lastChoice.options, ...(ctx.lastChoice.shownOptions ?? [])].map((o) => [o.sku, o])).values()]
        .filter((o) => o.sku !== blocked[0].sku && !(holdupStores ?? []).includes(o.storeKey ?? CONCIERGE_STORE_KEY))
        // Vitrine montada antes de trocar de CEP pode ter loja regional de outra área.
        .filter((o) => storeServesCep(o.storeKey ?? CONCIERGE_STORE_KEY, ctx.cep))
        .slice(0, vitrineLimit())
    : [];
  if (others.length) {
    const { chosenSku: _chosen, replaceSku: _replace, ...base } = ctx.lastChoice!;
    const pending: PendingChoice = { ...base, qty: blocked[0].qty, qtyExplicit: base.qtyExplicit || blocked[0].qty > 1, options: others };
    await writeCtx(convoId, { ...addressOnlyCtx(ctx), storeKey: CONCIERGE_STORE_KEY, step: "choosing", pending: [pending] });
    await sendChoices(phone, pending, copy.itemNotDeliverableShowOthers(names[0]));
    return;
  }
  if (!rest.length || depth >= 3) {
    await writeCtx(convoId, { ...addressOnlyCtx(ctx) });
    await reply(phone, copy.itemsNotDeliverableHere(names, false));
    return;
  }
  const next: DeliveryContext = { ...addressOnlyCtx(ctx), storeKey: CONCIERGE_STORE_KEY, basket: rest, ...(ctx.recipientName ? { recipientName: ctx.recipientName } : {}), ...(ctx.urgent ? { urgent: ctx.urgent } : {}) };
  await writeCtx(convoId, next);
  await reply(phone, copy.itemsNotDeliverableHere(names, true));
  await createOperatorQuoteRequest(phone, convoId, next, undefined, depth + 1);
}

async function createOperatorQuoteRequest(phone: string, convoId: string, ctx: DeliveryContext, prefix?: string, depth = 0) {
  const convo = await prisma.conversation.findUnique({ where: { id: convoId } });
  if (!convo) throw new Error("Conversation not found while creating concierge quote request.");
  const basket = (ctx.basket ?? []) as unknown as object;
  const itemNames = (ctx.basket ?? []).map((item) => `${item.qty}x ${item.name}`);
  // Destinatário (11/09): nome do perfil do WhatsApp, ou o nome que o cliente informou
  // quando o perfil não tinha nome ou a entrega é para outra pessoa. A compra na loja
  // exige esse campo (checkCheckout compara com o receiverName do checkout).
  const profile = await prisma.user.findUnique({ where: { id: convo.userId }, select: { name: true, cpfName: true } });
  const recipientName = ctx.recipientName?.trim() || profile?.name?.trim() || profile?.cpfName?.trim() || null;
  const acquisitionTouchId = await latestAcquisitionTouchId(convoId);
  // Remédio isento (29/09): o pedido na farmácia sai no CPF/nome do cliente. Cópia no pedido
  // pra compra não depender do perfil mudar depois; nulo = CNPJ da Lia, como sempre.
  const buyer = medicineEnabled() && hasMip(ctx.basket)
    ? await prisma.user.findUnique({ where: { id: convo.userId }, select: { cpf: true, cpfName: true } })
    : null;
  const buyerData = buyer?.cpf && buyer.cpfName
    ? { buyerDocument: buyer.cpf, buyerName: buyer.cpfName }
    : { buyerDocument: null, buyerName: null };

  // Tag de urgência (pedido do dono, 17/08): o cliente disse "urgente"/"pra hoje" em
  // algum momento da conversa — o operador decide o canal por isso (Rappi/retirada
  // agora vs. ML/dia seguinte). Só marca o pedido; nada muda para o cliente.
  const URGENT_NOTE = "⚡ URGENTE: cliente quer receber hoje.";

  const existing = await prisma.deliveryOrder.findFirst({
    where: { conversationId: convoId, status: AWAITING_OPERATOR_QUOTE_STATUS },
    orderBy: { createdAt: "desc" }
  });
  let order;
  if (existing) {
    const addUrgent = ctx.urgent && !(existing.notes ?? "").includes(URGENT_NOTE);
    order = await prisma.deliveryOrder.update({
      where: { id: existing.id },
      data: {
        items: basket,
        cep: ctx.cep,
        deliveryAddress: ctx.deliveryAddress,
        ...(recipientName && !existing.customerName ? { customerName: recipientName } : {}),
        ...buyerData,
        ...(addUrgent ? { notes: appendOrderNote(existing.notes, URGENT_NOTE) } : {})
      }
    });
  } else {
    order = await prisma.deliveryOrder.create({
      data: {
        userId: convo.userId,
        conversationId: convoId,
        phone,
        customerName: recipientName,
        ...buyerData,
        acquisitionTouchId,
        cep: ctx.cep,
        deliveryAddress: ctx.deliveryAddress,
        storeKey: CONCIERGE_STORE_KEY,
        storeLabel: CONCIERGE_STORE_LABEL,
        items: basket,
        // Default to same-hour operator courier; the operator can switch to retailer
        // delivery when quoting, per item availability.
        fulfillments: [{ storeKey: CONCIERGE_STORE_KEY, storeLabel: CONCIERGE_STORE_LABEL, deliveryMode: "retailer_delivery" }] as unknown as object,
        itemsSubtotal: 0,
        courierKey: "retailer_delivery",
        deliveryFee: 0,
        serviceFee: 0,
        total: 0,
        notes: ctx.urgent
          ? `${URGENT_NOTE}\nPedido concierge aguardando cotação do operador.`
          : "Pedido concierge aguardando cotação do operador.",
        status: AWAITING_OPERATOR_QUOTE_STATUS
      }
    });
  }
  // `lastChoice` sobrevive à publicação: é ela que permite "mais barato" DEPOIS do
  // total reabrir a escolha (27/08 S14).
  await writeCtx(convoId, {
    ...addressOnlyCtx(ctx),
    deliveryOrderId: order.id,
    step: AWAITING_OPERATOR_QUOTE_STATUS,
    ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {})
  });

  let holdupItem: string | undefined;
  let holdupStores: string[] | undefined;
  if (instantQuoteEligible((ctx.basket ?? []) as InstantQuoteItem[], CONCIERGE_STORE_KEY) && ctx.cep) {
    // `handled` = a Lia resolveu o turno (publicou a cotação OU parou na escolha de entrega).
    const outcome = await tryPublishInstantQuote(order.id, phone, ctx, prefix, convoId);
    if (outcome.handled) return;
    holdupItem = outcome.holdup;
    holdupStores = outcome.holdupStores;
  } else {
    // Cesta que nem é cotável automaticamente: os itens sem loja/preço é que travam.
    holdupStores = [...new Set((ctx.basket ?? []).filter((i) => !(i.unitPrice > 0) || !i.storeKey || i.storeKey === CONCIERGE_STORE_KEY || PER_AD_FREIGHT_STORES.has(i.storeKey)).map((i) => i.storeKey ?? CONCIERGE_STORE_KEY))];
  }

  // 27/09/2026 — sem operador (decisão de 25/09): o que a loja não confirma para o CEP NÃO
  // vira espera de cotação humana. "Se não tem, fala que não tem": cancela o pedido aberto,
  // diz o que ficou de fora e fecha o resto na hora. LIA_OPERATOR_QUOTE=true volta ao
  // caminho antigo (operador cota no /ops).
  if (!operatorQuoteEnabled()) {
    await closeWithoutOperator(phone, convoId, ctx, order.id, holdupStores, prefix, depth);
    return;
  }

  if (prefix) await reply(phone, prefix);
  await replyQuoteNotice(
    phone,
    existing ? copy.operatorQuoteStillWorking() : copy.operatorQuoteRequested(itemNames, holdupItem)
  );
  const alert = copy.operatorQuoteAlert(order.id.slice(-6).toUpperCase(), itemNames);
  await notifyOperator(ctx.urgent ? `⚡ URGENTE — ${alert}` : alert, phone);
}

// Publica a cotação instantânea reutilizando opsPublishManualQuote — status, mensagem ao
// cliente e menu de pagamento são EXATAMENTE os mesmos da cotação manual. Qualquer erro
// (frete incalculável, endereço longe demais, corrida com o /ops) devolve false e o
// fluxo cai no caminho manual de sempre: nunca quebra o fechamento da lista.
async function tryPublishInstantQuote(
  orderId: string,
  phone: string,
  ctx: DeliveryContext,
  prefix?: string,
  convoId?: string
): Promise<{ handled: boolean; holdup?: string; holdupStores?: string[] }> {
  try {
    const items = ctx.basket ?? [];
    // Quais itens travaram a cotação automática — vai pra nota do /ops E pra copy do
    // cliente (27/08 S11: "um dos itens precisa de conferência" sem dizer qual).
    const namesOf = (storeKey: string) =>
      items
        .filter((i) => i.storeKey === storeKey)
        .map((i) => i.name)
        .join(", ");
    // A entrega é pelo SITE de cada loja (o operador compra lá e a loja entrega), então
    // o frete é a política de cada site — por loja, com frete grátis por limiar.
    const seeded = computeStoreFreights(items as InstantQuoteItem[]);
    let freights = seeded.freights;
    if (!freights.length) return { handled: false };
    // Mercado Livre: o frete é do ANÚNCIO + CEP, não da loja — a consulta pública do
    // próprio ML (`shipping_options`, ~0,35s) devolve custo e data reais. É o que
    // substitui a tarifa padrão de R$18 (reprovada pelo dono, 17/08). Sem número real, o
    // pedido inteiro vai pro operador em vez de fechar com chute.
    let mlEstimate: string | undefined;
    // Alternativa "chega antes pagando mais" do anúncio: vira PERGUNTA com botão ao
    // cliente (dono, 17/08) em vez de decisão nossa.
    let mlFaster: { fee: number; estimate?: string } | undefined;
    let mlCheapFee = 0;
    for (let i = 0; i < freights.length; i++) {
      if (!PER_AD_FREIGHT_STORES.has(freights[i].storeKey)) continue;
      const mlItems = items.filter((item) => item.storeKey === freights[i].storeKey);
      const outcome = await mlBasketFreight(mlItems, ctx.cep!);
      console.log("[instant-quote:ml-freight]", outcome.kind, outcome.kind === "ok" ? outcome.fee : outcome.reason);
      if (outcome.kind === "manual") {
        const holdup = namesOf(freights[i].storeKey);
        const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
        await prisma.deliveryOrder.update({
          where: { id: orderId },
          data: {
            notes: appendOrderNote(
              current?.notes ?? null,
              `⚠️ Cotação instantânea abortada: Mercado Livre — ${outcome.reason}. Itens: ${holdup}.`
            )
          }
        });
        return { handled: false, holdup, holdupStores: [freights[i].storeKey] };
      }
      freights[i] = { ...freights[i], fee: outcome.fee, source: "vivo" };
      mlEstimate = outcome.estimate;
      mlCheapFee = outcome.fee;
      mlFaster = outcome.faster ? { fee: outcome.faster.fee, estimate: outcome.faster.estimate } : undefined;
    }
    // Precisão final: consulta AO VIVO no checkout de cada loja (cesta + CEP reais), em
    // PARALELO com timeout curto — o fechamento nunca espera mais que um timeout. Site
    // respondeu → frete exato daquele endereço (grátis incluso). Site sem entrega pro
    // CEP → operador cota à mão. Falhou/bloqueou → tabela semeada de sempre.
    // Prazo da loja (SLA da simulação) vai pro resumo (04/09): o card mostrava o prazo e
    // o resumo não — o cliente ficava com "90 min" na cabeça sem ver de quem era o prazo.
    const storeEstimates: string[] = [];
    // Entrega mais rápida da loja (SUPER EXPRESSA etc.), por loja da cesta.
    const storeFaster: Array<{ index: number; cheapFee: number; faster: { fee: number; estimate?: string; name?: string } }> = [];
    const repriced: Array<{ name: string; from: number; to: number; medicine?: string }> = [];
    if (liveFreightEnabled() && ctx.cep) {
      const outcomes = await Promise.all(
        freights.map((f) =>
          liveStoreFreight(
            f.storeKey,
            items.filter((i) => i.storeKey === f.storeKey).map((i) => ({ sku: i.sku, qty: i.qty })),
            ctx.cep!
          )
        )
      );
      for (let i = 0; i < freights.length; i++) {
        const outcome = outcomes[i];
        console.log("[instant-quote:live]", freights[i].storeKey, outcome.kind, outcome.kind === "ok" ? outcome.fee : "");
        // Site não entrega nesse CEP, ou algum item da cesta está indisponível lá: nos
        // dois casos não dá pra cobrar automático — o operador cota à mão. A nota diz
        // POR QUE (rodadas 2 e 11 de 14/08: o mesmo carregador caiu 2x no manual e
        // ninguém sabia o motivo sem o runtime log de 1h).
        if (outcome.kind === "no-delivery" || outcome.kind === "item-unavailable") {
          const why = outcome.kind === "no-delivery" ? "site não entrega no CEP" : "item indisponível no site";
          const holdup = namesOf(freights[i].storeKey);
          const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
          await prisma.deliveryOrder.update({
            where: { id: orderId },
            data: {
              notes: appendOrderNote(current?.notes ?? null, `⚠️ Cotação instantânea abortada: ${freights[i].storeKey} — ${why}. Itens: ${holdup}.`)
            }
          });
          return { handled: false, holdup, holdupStores: [freights[i].storeKey] };
        }
        if (outcome.kind === "ok") {
          // Preço da loja AGORA (27/09): catálogo é foto; o total sai com o preço vivo.
          for (const item of items) {
            const live = outcome.unitPrices?.[item.sku];
            if (item.storeKey !== freights[i].storeKey || live == null || Math.abs(live - item.unitPrice) < 0.005) continue;
            repriced.push({ name: item.name, from: item.unitPrice, to: live, medicine: item.medicine });
            item.unitPrice = live;
            (item as { lineTotal?: number }).lineTotal = roundMoney(live * item.qty);
          }
          freights[i] = { ...freights[i], fee: outcome.fee, source: "vivo" };
          if (outcome.estimate) storeEstimates.push(outcome.estimate);
          if (outcome.faster) storeFaster.push({ index: i, cheapFee: outcome.fee, faster: outcome.faster });
        }
      }
    }
    // Loja sem política de frete calibrada e sem simulação ao vivo = "tarifa padrão", um
    // chute. Cobrar em cima de chute vendeu um chá sem estoque, sem entrega no CEP e abaixo
    // do mínimo da loja (02/09): agora o operador confere ANTES de qualquer cobrança.
    // Cobrança automática SÓ do que a loja confirmou ao vivo para este CEP (estoque,
    // entrega e frete): "tarifa padrão" é chute e a tabela pesquisada não sabe de estoque.
    // LIA_CHARGE_ONLY_VERIFIED=false volta a aceitar a tabela (não recomendado).
    const chargeOnlyVerified = process.env.LIA_CHARGE_ONLY_VERIFIED !== "false";
    const guessed = freights.filter((f) => (chargeOnlyVerified ? f.source !== "vivo" : f.source === "padrao"));
    if (guessed.length) {
      const holdup = guessed.map((f) => namesOf(f.storeKey)).filter(Boolean).join(", ");
      const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
      await prisma.deliveryOrder.update({
        where: { id: orderId },
        data: {
          notes: appendOrderNote(
            current?.notes ?? null,
            `⚠️ Cotação instantânea abortada: ${guessed.map((f) => `${f.storeKey} (${f.source})`).join(", ")} — sem confirmação ao vivo de estoque/entrega/frete para o CEP${guessed.some((f) => f.source === "padrao") ? " (tarifa padrão é chute)" : ""}. Conferir estoque, entrega no CEP e mínimo da loja. Itens: ${holdup}.`
          )
        }
      });
      return { handled: false, holdup, holdupStores: guessed.map((f) => f.storeKey) };
    }
    if (repriced.length) {
      const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
      await prisma.deliveryOrder.update({ where: { id: orderId }, data: {
        items: items as unknown as object,
        notes: appendOrderNote(current?.notes ?? null, `💲 Preço atualizado pela loja no fechamento: ${repriced.map((r) => `${r.name} R$${r.from.toFixed(2)} → R$${r.to.toFixed(2)}`).join("; ")}.`),
      } });
      // NÃO regrava a conversa aqui (05/10, #9AK28P): o contexto já é "aguardando cotação"
      // deste pedido. Regravar o `ctx` antigo devolvia a cesta à conversa — a cotação saía
      // como "pedido separado" e o "cartão" seguinte abria um SEGUNDO pedido e uma segunda
      // cobrança. Os itens repreçados já estão no pedido (e no `ctx.basket` em memória).
      // Só AVISA quando o preço SUBIU: baixa é boa notícia e o total já sai certo — o aviso
      // "a loja mudou o preço" num preço menor só parecia erro (dono, 05/10).
      const raised = repriced.filter((r) => r.to > r.from);
      if (raised.length) {
        await reply(phone, copy.pricesUpdatedByStore(raised.map((r) => ({ name: r.name, from: display(r.from, r.medicine), to: display(r.to, r.medicine) }))));
      }
    }
    const totalFee = Math.round(freights.reduce((sum, f) => sum + f.fee, 0) * 100) / 100;
    const itemsSubtotal = roundMoney(items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0));
    if (itemsSubtotal <= 0) return { handled: false };
    const breakdown = freightBreakdownLabel(freights);
    await prisma.deliveryOrder.update({
      where: { id: orderId },
      data: { notes: `Cotação instantânea (vitrine, entrega pelo site). Frete por loja: ${breakdown}.` }
    });
    if (prefix) await reply(phone, prefix);

    // Duas formas de entrega no anúncio: QUEM ESCOLHE É O CLIENTE (dono, 17/08 — "tem q
    // perguntar se ele quer o mais rápido e caro ou mais demorado e barato e tem q ter
    // botão"). A cotação fica parada aqui, sem cobrar nada, até o toque; os dois totais já
    // estão calculados, então a resposta publica na hora — não é espera, é escolha.
    if (mlFaster && convoId) {
      const rapidoFee = roundMoney(totalFee - mlCheapFee + mlFaster.fee);
      const choice = {
        orderId,
        itemsSubtotal,
        serviceFee: serviceFeeForItems(items as { unitPrice: number; qty: number }[]),
        stores: freights.length,
        quotedAt: Date.now(),
        barato: { fee: totalFee, estimate: mlEstimate },
        rapido: { fee: rapidoFee, estimate: mlFaster.estimate }
      };
      await writeCtx(convoId, {
        ...addressOnlyCtx(ctx),
        deliveryOrderId: orderId,
        step: "choosing_freight",
        freightChoice: choice,
        ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {})
      });
      await sendFreightChoice(phone, choice);
      return { handled: true };
    }

    // Loja com entrega expressa (04/09, dono): mesma escolha barato × rápido do ML, com o
    // prazo da loja. Cesta de uma loja só — com várias lojas a combinação vira confusão.
    if (!mlFaster && storeFaster.length === 1 && freights.length === 1 && convoId) {
      const sf = storeFaster[0];
      const choice = {
        orderId,
        itemsSubtotal,
        serviceFee: serviceFeeForItems(items as { unitPrice: number; qty: number }[]),
        stores: 1,
        kind: "store" as const,
        quotedAt: Date.now(),
        barato: { fee: totalFee, estimate: slowestEstimate(storeEstimates) },
        rapido: { fee: roundMoney(totalFee - sf.cheapFee + sf.faster.fee), estimate: sf.faster.estimate, name: sf.faster.name }
      };
      await writeCtx(convoId, {
        ...addressOnlyCtx(ctx),
        deliveryOrderId: orderId,
        step: "choosing_freight",
        freightChoice: choice,
        ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {})
      });
      await sendFreightChoice(phone, choice);
      return { handled: true };
    }

    const serviceFeeExact = serviceFeeForItems(items as { unitPrice: number; qty: number }[]);
    await publishInstantQuote(orderId, {
      itemsSubtotal,
      serviceFee: serviceFeeExact,
      fee: totalFee,
      estimate: mlEstimate,
      stores: freights.length,
      storeEstimate: slowestEstimate(storeEstimates)
    });
    // Frete comendo a compra (3+ entregas e frete ≥ 40% dos produtos): dica honesta de
    // como baratear — a recomposição automática vale pra LISTA; cesta montada card a
    // card foi escolha explícita do cliente e não é trocada em silêncio.
    const produtosDisplay = itemsSubtotal + serviceFeeExact;
    if (freights.length >= 3 && totalFee >= 0.4 * produtosDisplay) {
      await reply(phone, copy.freightFragmentationTip(freights.length));
    }
    return { handled: true };
  } catch (error) {
    // Turno superado (outro turno/cancelar escreveu por baixo) NÃO cai no caminho
    // manual: ele pararia de escrever mas continuaria FALANDO — resumo velho no meio
    // da conversa nova (27/08 S19). Propaga e morre em silêncio no webhook.
    if (error instanceof TurnSupersededError) throw error;
    console.warn("[instant-quote:fallback-manual]", error instanceof Error ? error.message : error);
    return { handled: false };
  }
}

// Publica a cotação instantânea. A data vem do próprio anúncio pro CEP do cliente (consulta
// do ML) — é promessa da loja, não estimativa nossa. Sem data publicada, a frase segue sem
// prazo (inventar prazo segue proibido).
async function publishInstantQuote(
  orderId: string,
  input: { itemsSubtotal: number; serviceFee?: number; fee: number; estimate?: string; storeEstimate?: string; stores: number }
) {
  const base = input.stores > 1 ? `pela própria loja (${input.stores} entregas)` : "pela própria loja";
  // ML traz data ("chega até sábado"); loja VTEX traz SLA ("1bd") → "prazo da loja: 1 dia útil".
  const storeEta = humanEstimate(input.storeEstimate);
  const promise = input.estimate ? `${base} · chega até ${input.estimate}` : storeEta ? `${base} · ${storeEta}` : base;
  await opsPublishManualQuote(orderId, {
    itemsSubtotal: input.itemsSubtotal,
    serviceFee: input.serviceFee,
    deliveryFee: input.fee,
    deliveryMode: "retailer_delivery",
    deliveryPromise: promise
  });
}
