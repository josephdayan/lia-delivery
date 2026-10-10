import { customerInvoiceEnabled, displayPrice, serviceFeeForItems } from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import { LIST_FLOW_REOPEN_ID, carouselEnabled, whatsappAdapter } from "@/lib/adapters/whatsapp";
import { getStore, listStores, pickStoreForQueries, gatherCrossStoreCandidates, prefetchLongTailIfNeeded, longTailOptInEnabled, type StoreCandidate, type StoreConnector } from "@/lib/stores";
import { withDeadline } from "@/lib/stores/live-search";
import { compactCardDelivery } from "@/lib/meta-carousel-card";
import { mercadoLivreEnabled, prefetchMercadoLivre, searchMercadoLivre } from "@/lib/stores/mercadolivre";
import { mlItemIdFrom } from "@/lib/ml-freight";
import { composeBasket } from "@/lib/basket-composer";
import { attrMatchesItem, conciergeMatchIsStrong, diversifyOptions, inferCatalogRefinement, parsePackPhrase, queryTokens, sameProductVariant, stapleFor, scoreCatalogMatch, variantPenalty } from "@/lib/stores/types";
import { paymentsAreMocked, pixAdapter } from "@/lib/payments/mercadopago";

import { cardOnFileEnabled, expireOpenPaymentAttempts, findPendingSavedCardAttempt, listOneClickCredentials } from "@/lib/payments/whatsapp-pay";

import { extractShoppingList, rerankShoppingOptions, interpretCustomerMessage, classifyMisses } from "@/lib/adapters/ai";
import { computeStoreFreights, freightBreakdownLabel, instantQuoteEligible, PER_AD_FREIGHT_STORES, storeFreight, type InstantQuoteItem } from "@/lib/instant-quote";
import { estimateDay, humanEstimate, liveCheckSupported, liveFreightEnabled, liveStoreFreight, preflightBasket, type LiveItemCheck, slowestEstimate } from "@/lib/live-freight";
import { buyableWithoutOperator, checkCandidatesLive, liveConfirmationRequired, liveKey } from "@/lib/live-availability";
import { mlBasketFreight } from "@/lib/ml-freight";
import { countDistinctItems, resolveListItems } from "@/lib/list-items";
import { localCatalogProbe } from "@/lib/stores/list-probe";
import { detectAlternativeItem, parseAltAnswer } from "@/lib/alt-items";
import { LIST_FLOW_MAX_OPTIONS, LIST_FLOW_MAX_SLOTS, LIST_FLOW_MESSAGE, buildListFlowData, isListFlowReply, parseListFlowReply } from "@/lib/list-flow";
import { fetchThumbs } from "@/lib/flow-thumbs";
import { applyListMisses, freshListMisses, mergeListMisses, missLabel, pickMissForFragment } from "@/lib/list-misses";
import { recordSearchMisses } from "@/lib/search-misses";
import { stripLinks, translateEnglishOrder } from "@/lib/en-order";
import { detectIntent, isMissingItemOnlyComplaint, extractCep, parseAddressComplement, parseAttributeAsk, parseAvailabilityAsk, parseOnlyKeep, withAddressComplement, isDemonstrativeOnly, isQuestion, asksRunningTotal, looksLikeMedicine, hasUrgencySignal, parseNeededBy, isNarrativeSegment, isRequestModifier, sharesProductNoun, stripMedicineNegation, narrowChoiceByName, normalizeMsg,  parsePriceCap, parseBudgetStatement, splitPriceCap, mergeShoppingLines, parseChoiceReply, parseChoiceCombo, parseChoiceEtaAsk, isAngerSwear, asksDeliveryToday, answerOpenQuestion, parseItemCheapest, parseItemSize, parseChoiceNumber, parseStoreReference, asksCheapestQuestion, splitCommandClauses, stripListNumbering, parseRefinement, wantsMoreOptions, looksLikeTobacco, looksLikeSymptomAsk, parseCancelReason, parseMissFollowUp, inheritMissQualifiers, stripPreferenceFiller, splitFiscalClause, splitServiceQuestions, parseChoiceSwitch, parseQtyCommand, isAttendanceFollowUp, looksLikePharmacyPartnerAsk, parseOptionSwitchRef, asksToSeeChoicesAgain, ADDITIVE_CUE_RE, splitRestartCue, isKeepSeparateReply, type Intent, type ParsedLine } from "@/lib/lia-intents";
import { AWAITING_OPERATOR_QUOTE_STATUS, CONCIERGE_STORE_KEY, CONCIERGE_STORE_LABEL, PAID_OR_IN_FULFILLMENT_STATUSES, REPEATABLE_DELIVERY_ORDER_STATUSES, appendOrderNote, isCardCharge, isOrderOutForDelivery } from "@/lib/order-flags";
import { MERCADO_LIVRE_STORE_KEY, automaticPurchaseStores } from "@/lib/purchase-policy";
import { baseFormulationFirst, extractCpf, extractFullName, hasMip, isMedicineLineExtension, isMipItem, isPrescriptionDrugName, looksLikeCpfAttempt, looksLikeMedicineName, looksLikePrescriptionRequest, maskCpf, medicineEnabled, medicineEquivalentFor, prescriptionDrugNamesIn } from "@/lib/medicine";
import { isServedState, servedAreaLabel } from "@/lib/coverage";
import { currentShopperCep, noteShopperCep, storeServesCep } from "@/lib/store-areas";
import { SIGNUP_FORM_MESSAGE, buildSignupAddress, isSignupFormReply, parseSignupForm } from "@/lib/signup-form";
import { CEP_RE_GLOBAL, expandShoppingShorthand, isWaitGripe } from "@/lib/lia-intents";
import { displayQueryName } from "@/lib/query-display";
import { dropAddressOnlyItems, extractLabeledHouseNumber, isKeepOldAddress, isKeepOldAddressExplicit, looksLikePersonName, mentionsStreetWithoutNumber, onboardingNote, parseHouseNumberReply, parsePriceAsk, saysNoCep, splitAddressAndItems, typedCityMismatch } from "@/lib/address-parse";
import * as copy from "@/lib/lia-copy";
import { dialogueEnabled, runDialogueTurn } from "@/lib/dialogue";
import { answerProductQuestion, isPetFood, parseProductQuestion } from "./product-question";
import { runPreSignupTurn, type PreHandlers } from "@/lib/dialogue/presignup";
import { REPEAT_WINDOW_MS } from "@/lib/dialogue/repeat";
import { detectRecommendation } from "@/lib/recommend/detect";
import { findComplement, handleRecommend, markComplementOutcome, markRecommendChosen, recommendByPrice, recommendFollowUp, recommendMore, recommendRefineFromAttribute, recordComplementOffer, setRecommendDeps, type RecommendEnv } from "@/lib/recommend/handle";
import { complementEnabled } from "@/lib/recommend/complement";
import { forgetPreferences, isStatementOnly, parseForget, parseStatements, rememberStatement } from "@/lib/recommend/memory";
import { recommendEnabled } from "@/lib/recommend/types";
import { latestAcquisitionTouchId, mergeAcquisition, recordAcquisitionTouch, stripAcquisitionTag, type InboundAcquisition } from "@/lib/acquisition";

// The operational brain of the remodelled Lia. One conversation = one basket of
// everyday items, fulfilled by a pluggable store. Retailer delivery is the default;
// pickup + courier remains only for formally-authorized partners. This module owns
// the WhatsApp conversation state machine AND the order lifecycle the operator
// dashboard drives. Intent detection lives in lia-intents (pure, unit-tested) and
// every customer-facing string lives in lia-copy.
import type { ListFlowCtx, ListFlowCtxSlot, ListMiss } from "./conversation-types";
import { isBareRacao, racaoStagesMixed, specKindOf, specAnswerLooksValid, specAnswerUnknown, combineSpecQuery, cartridgeForPrinter, type SpecAsk } from "./spec-ask";
import { ACTIVE_ORDER_STATUSES, BasketItem, CANCELABLE_FALLBACK_STATUSES, ChoiceOption, ChoicesResult, DeliveryContext, ExtractedLines, PendingChoice, STORE_SEARCH_URL, basketForCopy, cardTotal, conciergeStoresBelowMinimum, display, orderDateLabel, orderItemsPreview, orderStore, roundMoney, storeMinReal } from "./conversation-types";
import { createOpsLoginToken, opsLoginUrl } from "./auth";
import { derivedMessageLabel, understandMedia, type InboundMedia } from "./media-understanding";
import { refreshPausedStores } from "./store-pause";
import { TURN_LOCK_TTL_MS, TurnSupersededError, type TurnTicket, skipTurnTicket, acquireTurnLock, addressOnlyCtx, getOrCreateConvo, isFreightChoicePayload, isRecentDuplicateInbound, lastActivityAt, markTurnReplied, normalizePhone, notifyOperator, persistSentTexts, quoteAbandonTtlMs, readCtx, releaseTurnLock, rememberCtxSnapshot, reply, replyQuoteNotice, searchNoticeTimer, sleep, turnMeta, writeCtx, isAdminPhone, notifyOwner, phoneRole, withinOperatorHours } from "./turn-runtime";
import { cancelPendingRetailerQuote, closeUnpaidOrder, createCardAttempt, flagLatestOrder, handleSavedCardOther, handleSavedCardPay, issueValidatedRetailerQuotePayment, markDeliveryOrderPaid, markPixExpired, methodFromIntent, recheckOpenCharge, reopenOrderForEdit, resendCharge, switchPaymentMethod } from "./order-payments";
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
  // 07/10 (c08): remédio pelo NOME ("Euthyrox 50mg") também é remédio com a flag desligada — a
  // lista de palavras só tinha genéricos e o pedido virava "anotei… me manda o endereço".
  return medicineEnabled()
    ? looksLikePrescriptionRequest(text)
    : looksLikeMedicine(text) || (isPrescriptionDrugName(text) && countDistinctItems(text) <= 1);
}
// Dono (08/10): a recusa NOMEIA o remédio de receita ("Rivotril precisa de receita") quando o texto o nomeia.
// A recusa da MENSAGEM INTEIRA só vale quando tudo o que foi pedido é remédio de receita (dono,
// 08/10): "dipirona e rivotril" segue para a busca, que mostra a dipirona e nomeia o Rivotril na
// nota. Com a flag do isento desligada, nada muda (qualquer remédio recusa a mensagem).
function refusesWholeMessage(text: string): boolean {
  if (!blocksMedicine(text)) return false;
  // 09/10 (rodada 1, A3): também com a flag desligada, o remédio no meio de uma lista sai com a explicação
  // curta e o resto segue; a recusa da mensagem inteira só vale quando tudo ali é remédio.
  const lines = resolveListItems(stripMedicineNegation(text)).filter((line) => queryTokens(line.phrase).length);
  // "dipirona, vê se tem em alguma farmácia": o resto é só a pergunta sobre farmácia, não item de compra.
  return lines.length <= 1 || lines.every((line) => blocksMedicine(line.phrase) || /\b(?:farmacias?|drogarias?)\b/.test(normalizeMsg(line.phrase)));
}
function noMedicineCopy(text?: string): string {
  if (!medicineEnabled()) return copy.noMedicine();
  const lines = text ? resolveListItems(stripMedicineNegation(text)).map((line) => line.phrase) : [];
  return copy.prescriptionRefusal(prescriptionDrugNamesIn(lines.length ? lines : [text ?? ""]));
}
// A recusa de remédio repetida em pouco tempo muda de texto (07/10, c35): a mesma frase duas vezes
// parecia travada, e "tem farmácia parceira?" não é pedido — é pergunta.
async function refuseMedicine(phone: string, convoId: string, ctx: DeliveryContext, text?: string) {
  const again = ctx.medicineRefusedAt != null && Date.now() - ctx.medicineRefusedAt < 30 * 60_000;
  ctx.medicineRefusedAt = Date.now();
  await writeCtx(convoId, ctx);
  await reply(phone, again && !medicineEnabled() ? copy.noMedicineAgain() : noMedicineCopy(text));
}
function medicineSkippedCopy(dropped?: string[]): string {
  return medicineEnabled() ? copy.prescriptionSkippedNote(dropped) : copy.medicineSkippedNote();
}

// Clean the request into a shopping list. The LLM handles greetings, synonyms
// ("pasta de dente"->creme dental), medicines and quantities; the deterministic
// splitter + medicine word-list covers OpenAI-off and OpenAI-error, so a remédio
// never slips through as a plain search.
// Algum pedido da mensagem não aparece (por nenhuma palavra) entre as consultas mantidas?
export function someRequestDropped(requested: string[], kept: string[]): boolean {
  return requested.some((phrase) => !kept.some((query) => queryTokens(query).some((token) => queryTokens(phrase).includes(token))));
}
async function extractLines(text: string): Promise<ExtractedLines> {
  // "sem remédio"/"não quero remédio" é negação: sai da mensagem ANTES de qualquer
  // detecção — senão a Lia avisa que removeu um medicamento que ninguém pediu
  // (rodadas 4 e 14 dos testes reais de 14/08).
  const sanitized = expandShoppingShorthand(stripMedicineNegation(text));
  const containsTobacco = looksLikeTobacco(sanitized);
  // Frase já reescrita pelo roteador da IA neste turno: é uma busca limpa, o parser
  // determinístico dá conta e a 2ª chamada de IA só somava até 10 s (06/10).
  const routed = turnMeta.getStore()?.routerQuery;
  const extraction = routed && normalizeMsg(routed) === normalizeMsg(text) ? null : await extractShoppingList(sanitized);
  const deterministic = resolveListItems(sanitized, { log: true })
    .filter((line) => queryTokens(line.phrase).length)
    .filter((line) => !blocksMedicine(line.phrase))
    .filter((line) => !looksLikeTobacco(line.phrase));
  // Remédio de receita que saiu da lista, pelo nome (dono, 08/10): a nota diz QUAL ficou de fora.
  const prescriptionDropped = prescriptionDrugNamesIn(
    resolveListItems(sanitized)
      .filter((line) => queryTokens(line.phrase).length && blocksMedicine(line.phrase))
      .map((line) => line.phrase)
  );
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
    // Aviso e cesta têm que concordar (09/10, rodada 2: "deixei ele de fora" com a pomada de assadura na lista):
    // só vale se algum pedido da mensagem ficou de fora de verdade — com a flag do isento ligada ou não.
    const llmDroppedSomething = someRequestDropped(
      resolveListItems(sanitized)
        .filter((line) => queryTokens(line.phrase).length && !looksLikeTobacco(line.phrase))
        .map((line) => line.phrase),
      kept
    );
    return {
      lines: rewriteGroceryOil(mergeShoppingLines(items.map((item) => ({ phrase: item.query, qty: item.qty })), deterministic)),
      greetingOnly: extraction.greetingOnly,
      containsMedicine: (extraction.containsMedicine && llmDroppedSomething) || blocksMedicine(sanitized),
      containsTobacco,
      prescriptionDropped
    };
  }
  const raw = resolveListItems(sanitized).filter((line) => queryTokens(line.phrase).length);
  const safe = deterministic;
  return {
    lines: rewriteGroceryOil(safe),
    greetingOnly: false,
    containsMedicine: safe.length < raw.length - (containsTobacco ? 1 : 0) || blocksMedicine(sanitized),
    containsTobacco,
    prescriptionDropped
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

// Os "mais próximos" do rerank: o primeiro e os que falham na MESMA coisa (mesma frase de
// diferença). Misturar "é de 500 ml" com "é de 250 ml" sob um aviso só seria impreciso.
// Remédio pedido pela marca (dono, 08/10): a apresentação básica vem antes das extensões de linha
// (Tylenol Sinus, Advil 12h, Dorflex DIP…) que o cliente não pediu. Só na vitrine de isentos.
function medicineBaseFirst(query: string, options: ChoiceOption[], closest: boolean): ChoiceOption[] {
  // Só vitrine SÓ de isentos: numa mistura ("leites" → leite integral + Leite de Magnésia) a regra
  // empurrava o leite de verdade para trás do remédio (suíte, list-flow 08/10).
  if (closest || !medicineEnabled() || !options.every((o) => isMipItem(o))) return options;
  return baseFormulationFirst(query, options);
}

function closestFromRerank(proximos: { sku: string; falta: string }[] | undefined): { skus: string[]; falta: string } | null {
  if (!proximos?.length) return null;
  const falta = proximos[0].falta;
  const same = proximos.filter((p) => normalizeMsg(p.falta) === normalizeMsg(falta));
  return { skus: same.map((p) => p.sku), falta };
}

async function buildChoices(
  text: string,
  lockedStoreKey?: string,
  preferredSkus?: Map<string, number>,
  onLongTailSearch?: () => void,
  forceLongTail?: boolean,
  cep?: string | null,
  opts?: { askSpecs?: boolean }
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
    for (const line of resolveListItems(sanitized)) {
      if (!queryTokens(line.phrase).length || blocksMedicine(line.phrase)) continue;
      void prefetchLongTailIfNeeded(splitPriceCap(line.phrase).phrase).catch(() => {});
    }
  }

  const perfStart = Date.now();
  const extracted = await extractLines(text);
  const { greetingOnly, containsMedicine, containsTobacco, prescriptionDropped } = extracted;
  // Item que depende de especificação não dita ("capa de celular" sem modelo, 09/10 g7): não busca, pergunta.
  const specAsks: SpecAsk[] = [];
  const lines = (opts?.askSpecs
    ? extracted.lines.filter((line) => {
        const kind = specKindOf(line.phrase);
        if (!kind || (line.raw && !specKindOf(line.raw))) return true;
        specAsks.push({ kind, query: line.phrase, qty: line.qty, ...(line.qtyExplicit ? { qtyExplicit: true } : {}) });
        return false;
      })
    : extracted.lines
  ).map((line) => {
    const cartridge = cartridgeForPrinter(line.phrase);
    return cartridge ? { ...line, phrase: cartridge } : line;
  });
  const perfExtracted = Date.now();
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
      const { phrase: rawPhrase, cap } = splitPriceCap(line.phrase);
      // "meio quilo de queijo" / "2 quilos de batata" (06/10, A6): peso por extenso vira medida,
      // senão "meio"/"quilo" contam como palavras do produto e nada cobre o pedido.
      let shownPhrase = (giftSearchPhrase(rawPhrase) ?? rawPhrase)
        .replace(/\bmei[oa]\s+(quilo|kilo|kg)\b/i, "500g")
        .replace(/(\d+(?:[.,]\d+)?)\s*(quilos?|kilos?)\b/i, "$1kg")
        .replace(/\b(um|1)\s+(quilo|kilo)\b/i, "1kg");
      // Pack/fardo (06/10, A5): "pack de cerveja brahma 12 latas" virava 1 lata solta. A palavra
      // de embalagem e a contagem saem da busca (são identidade da EMBALAGEM, não do produto) e
      // voltam como filtro: só packs; sem pack na vitrine, N unidades soltas.
      const pack = parsePackAsk(shownPhrase);
      const searchPhrase = pack ? pack.core : shownPhrase;
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
      // "bolacha" é "biscoito" no catálogo: busca as duas formas (09/10, "bolacha maizena" voltava só amido de milho).
      if (crossStore && /\bbolachas?\b/i.test(searchPhrase)) {
        const alt = await gatherCrossStoreCandidates(searchPhrase.replace(/\bbolachas?\b/gi, "biscoito"), 12, 4);
        const have = new Set(candidates.map((c) => `${c.store.key}:${c.item.sku}`));
        candidates = [...candidates, ...alt.filter((c) => !have.has(`${c.store.key}:${c.item.sku}`))];
      }
      let packQty: number | undefined;
      let packOnly = false;
      let packSingles: StoreCandidate[] = [];
      if (pack && crossStore) {
        // Pack da marca costuma não repetir o tipo ("Pack 8 Latas - Heineken 269ml"): busca
        // também pela marca/variante sem o substantivo genérico.
        const extra = pack.brand ? await gatherCrossStoreCandidates(`pack ${pack.brand}`, 12, 4) : [];
        const seen = new Set(candidates.map((c) => `${c.store.key}:${c.item.sku}`));
        const pool = [...candidates, ...extra.filter((c) => !seen.has(`${c.store.key}:${c.item.sku}`))];
        const packs = pool.filter((c) => isPackItem(c.item.name) && (conciergeMatchIsStrong(searchPhrase, c.item) || (pack.brand ? conciergeMatchIsStrong(`pack ${pack.brand}`, c.item) || conciergeMatchIsStrong(`fardo ${pack.brand}`, c.item) : false)));
        if (packs.length) {
          packOnly = true;
          packSingles = candidates.filter((c) => !isPackItem(c.item.name) && conciergeMatchIsStrong(searchPhrase, c.item));
          candidates = pack.count ? [...packs.filter((c) => declaredPack(c.item.name) === pack.count), ...packs.filter((c) => declaredPack(c.item.name) !== pack.count)] : packs;
        } else if (pack.count) {
          packQty = pack.count;
        }
      }
      if (cap != null) candidates = candidates.filter((c) => display(c.item.unitPrice, c.item.medicine) <= cap);
      // Tamanho/volume pedido ("30 litros", "2kg") vale para TODOS os cards, não só a
      // escolha (rodada 7, 4º ciclo: 1 das 3 opções não era de 30l).
      // 06/10 (A6): o tamanho só filtra DENTRO do produto pedido — candidato que responde por
      // todas as palavras do pedido. "ração premier gato 1kg" virava ração de cachorro de 1 kg e
      // "meio quilo de queijo mussarela" virava canelone de 500 g só porque o peso batia. Sem o
      // produto certo no tamanho pedido, ficam os outros tamanhos (o tamanho vira preferência).
      // Item vendido por peso ("Tomate Italiano Kg") atende qualquer pedido em kg/g.
      let qty = packQty ? line.qty * packQty : line.qty;
      // O que a reserva (mais abaixo) também tem que respeitar: o produto e o tamanho pedidos.
      let sizeOk: (c: StoreCandidate) => boolean = () => true;
      let sizeSplit = false;
      const bestScore = Math.max(0, ...candidates.map((c) => scoreCatalogMatch(searchPhrase, c.item)));
      const sizeAsk = searchPhrase.match(/\d+(?:[.,]\d+)?\s*(?:kg|ml|lt?s?|litros?|g(?![a-z]))\b/i)?.[0];
      if (sizeAsk) {
        const relevant = candidates.filter((c) => conciergeMatchIsStrong(searchPhrase, c.item, { allTokens: true }));
        const isWeight = /(kg|g)$/i.test(sizeAsk.replace(/\s+/g, ""));
        const fits = (c: StoreCandidate) => attrMatchesItem(sizeAsk, c.item) || (isWeight && /\bkg\.?$/i.test(c.item.name.trim()));
        const sized = relevant.filter(fits);
        if (sized.length) {
          candidates = sized;
          sizeOk = (c) => conciergeMatchIsStrong(searchPhrase, c.item, { allTokens: true }) && fits(c);
        }
        else {
          // "2 litros de leite" = 2 caixas de 1 L quando não existe a embalagem de 2 L (A9).
          const split = splitBySize(sizeAsk, relevant.map((c) => c.item));
          if (split) {
            sizeSplit = true;
            candidates = relevant.filter((c) => attrMatchesItem(split.unit, c.item));
            // A IA às vezes já põe o 2 na quantidade ("2x leite 2 litros"): o mesmo número não multiplica.
            qty = line.qty === split.count ? line.qty : line.qty * split.count;
            // O rerank julga pelo pedido: "leite 2 litros" faria a IA recusar as caixas de 1 L.
            shownPhrase = shownPhrase.replace(sizeAsk, split.unit === "1kg" ? "1kg" : "1 litro");
            sizeOk = (c) => conciergeMatchIsStrong(searchPhrase, c.item, { allTokens: true }) && attrMatchesItem(split.unit, c.item);
          }
        }
      }
      // Recompra: o que o cliente já escolheu antes sobe (sort estável preserva o
      // ranking de relevância entre itens sem histórico).
      candidates.sort((a, b) => (preferredSkus?.get(b.item.sku) ?? 0) - (preferredSkus?.get(a.item.sku) ?? 0));
      // Verificação AO VIVO no site de cada loja para o CEP do cliente (03/09: chá cobrado
      // sem estoque). Sem estoque/sem entrega no endereço sai daqui; confirmado ganha o
      // prazo real e vem antes do não-verificável.
      let noneToday = false;
      let urgentWhen: PendingChoice["urgentWhen"];
      let unconfirmed = false;
      if (cep) {
        // Quantidade que o card confere na loja = a que vai ser cobrada (06/10, M3).
        const qtyFor = (c: StoreCandidate) => (line.qtyExplicit || qty > 1 ? packAdjusted(c.item.name, qty, searchPhrase).qty : 1);
        const confirm = async (pool: StoreCandidate[]) => {
          const wrapped = pool.map((c) => ({ storeKey: c.store.key, sku: c.item.sku, qty: qtyFor(c), c }));
          const live = await checkCandidatesLive(wrapped, cep);
          for (const [key, check] of live.checks) liveChecks.set(key, check);
          let kept = live.kept;
          // Loja que não respondeu a tempo (06/10, M4: "nenhuma loja confirmou" depois de 25 s)
          // ganha UMA nova tentativa antes de virar "não confirmado".
          const unknown = kept.filter((w) => !live.checks.has(liveKey(w.storeKey, w.sku)) && liveCheckSupported(w.storeKey));
          if (unknown.length && liveConfirmationRequired()) {
            const again = await checkCandidatesLive(unknown, cep);
            for (const [key, check] of again.checks) liveChecks.set(key, check);
            kept = kept.filter((w) => !unknown.includes(w) || again.kept.includes(w));
            live.dropped.push(...again.dropped);
          }
          if (live.dropped.length) {
            console.log("[live-check:dropped]", live.dropped.map((w) => `${w.storeKey}:${w.sku}`).join(","));
          }
          return { kept: kept.map((w) => w.c), dropped: live.dropped.length };
        };
        const first = await confirm(candidates);
        candidates = first.kept;
        // 06/10 (testers: pilha da Casa & Vídeo, fita isolante da Obramax): sem operador, opção
        // que a loja não confirmou para o CEP é beco no "pagar" (a cotação aborta). Sai da
        // vitrine; se nada foi confirmado, a linha vira "não consigo comprar agora".
        if (liveConfirmationRequired()) {
          const buyableOf = (pool: StoreCandidate[]) => pool.filter((c) => buyableWithoutOperator(c.store.key, liveChecks.get(liveKey(c.store.key, c.item.sku))));
          let buyable = buyableOf(candidates);
          if (buyable.length < candidates.length) {
            console.log("[live-check:unconfirmed]", candidates.filter((c) => !buyable.includes(c)).map((c) => `${c.store.key}:${c.item.sku}`).join(","));
          }
          // Reserva (06/10, A9): a loja derrubou os primeiros candidatos (Mambo: metade dos skus
          // "não pode ser entregue para as coordenadas" — açúcar, detergente). Antes de dizer
          // "não achei", confere os PRÓXIMOS candidatos relevantes, mais fundo em cada vitrine.
          // "Bom" = relevância perto da melhor da busca: o "Porta Detergente" que sobrou depois que a
          // Mambo derrubou os detergentes não conta como opção (o rerank o descartava → "não achei").
          const good = (c: StoreCandidate) => scoreCatalogMatch(searchPhrase, c.item) >= bestScore - 1;
          if (buyable.filter(good).length < 2 && (first.dropped > 0 || buyable.length < candidates.length)) {
            const tried = new Set([...liveChecks.keys()]);
            let deeper = (await gatherCrossStoreCandidates(searchPhrase, 36, 12)).filter(
              // Só o mesmo produto: relevância perto da dos primeiros (no máx. 3 pontos abaixo) e o
              // tamanho pedido — "Leite de Rosas" não é reserva de leite.
              (c) => !tried.has(liveKey(c.store.key, c.item.sku)) && conciergeMatchIsStrong(searchPhrase, c.item) && sizeOk(c) && (!packOnly || isPackItem(c.item.name)) && scoreCatalogMatch(searchPhrase, c.item) >= bestScore - 3
            );
            if (cap != null) deeper = deeper.filter((c) => display(c.item.unitPrice, c.item.medicine) <= cap);
            if (deeper.length) {
              const more = await confirm(deeper.slice(0, 12));
              const extra = buyableOf(more.kept);
              console.log("[live-check:deeper]", searchPhrase, `${extra.length}/${Math.min(12, deeper.length)}`);
              candidates = [...candidates, ...more.kept];
              // Os bons primeiro (os da reserva antes do que sobrou fraco da 1ª leva).
              const byScore = (a: StoreCandidate, b: StoreCandidate) => scoreCatalogMatch(searchPhrase, b.item) - scoreCatalogMatch(searchPhrase, a.item);
              buyable = [...buyable.filter(good), ...[...extra].sort(byScore), ...buyable.filter((c) => !good(c))];
            }
          }
          // Nenhum pack confirmado para o CEP: as unidades soltas, na contagem pedida (A5).
          if (!buyable.length && packOnly && packSingles.length) {
            const singles = await confirm(packSingles);
            buyable = buyableOf(singles.kept);
            candidates = [...candidates, ...singles.kept];
            if (buyable.length && pack?.count) qty = line.qty * pack.count;
            console.log("[pack:singles]", searchPhrase, buyable.length);
          }
          unconfirmed = candidates.length > 0 && buyable.length === 0;
          candidates = buyable;
        }
        if (urgent) {
          const today = candidates.filter((c) => {
            const check = liveChecks.get(liveKey(c.store.key, c.item.sku));
            return check?.available && check.fastEtaMinutes != null && check.fastEtaMinutes < sameDayMaxMinutes();
          });
          if (today.length) {
            candidates = today;
            // O cabeçalho diz o dia de verdade (10/10, rodada 5 g16): "menos de 24h" com janela de amanhã não é "hoje".
            const days = today.map((c) => estimateDay(liveChecks.get(liveKey(c.store.key, c.item.sku))?.fastEstimate));
            urgentWhen = days.every((d) => d === "hoje") ? undefined : days.every((d) => d === "hoje" || d === "amanhã") ? "amanha" : "rapido";
          } else noneToday = true;
        }
      }
      // Pedido de UM item com teto: o teto é do TOTAL (produto + entrega da loja para o CEP). Entre os candidatos
      // que SÃO o produto pedido, o que estoura com a entrega sai da vitrine — desde que outro caiba; se nenhum
      // cabe, ficam todos e o total avisa (rodada 2, 07/10: vinho "até R$60" chegava a R$61,87). Candidato fraco
      // nunca decide: tirar o produto certo e deixar só o parecido esvaziaria a vitrine.
      if (cap != null && lines.length === 1 && candidates.length) {
        const asOption = (c: StoreCandidate) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }, liveChecks.get(liveKey(c.store.key, c.item.sku)));
        const strong = candidates.filter((c) => conciergeMatchIsStrong(searchPhrase, c.item));
        const fitKeys = new Set(withinBudget(strong.map(asOption), { cap, capTotal: true, qty }).map((o) => `${o.storeKey}:${o.sku}`));
        const fitsTotal = (c: StoreCandidate) => fitKeys.has(`${c.store.key}:${c.item.sku}`);
        const anyFits = strong.some((c) => estimatedTotal(asOption(c), qty) <= cap + 0.005);
        if (anyFits) {
          const kept = candidates.filter((c) => !strong.includes(c) || fitsTotal(c));
          if (kept.length < candidates.length) {
            console.log("[budget:vitrine]", searchPhrase, `${kept.length}/${candidates.length} cabem em R$${cap} com a entrega`);
            candidates = kept;
          }
        }
      }
      // O teto viaja NA LINHA: paginação, refino e o resgate do ML re-filtram por ele
      // (26/08: "até R$50/100/200" vazou nas opções — o cap morria aqui).
      return { line: { ...line, qty, ...(qty !== line.qty ? { qtyExplicit: true } : {}), phrase: shownPhrase, ...(cap != null ? { cap } : {}) }, candidates, noneToday, urgentWhen, unconfirmed, sizeSplit };
    })
  );

  // UMA chamada de IA julga todas as linhas: dos candidatos, o que é realmente o
  // produto pedido, em que ordem — e lista vazia quando nada serve (a linha vira
  // livre/não-achei, que é o resultado honesto). IA off/falhou → null → ranking
  // determinístico de sempre, diversificado.
  const perfSearched = Date.now();
  const withCandidates = perLine.filter((entry) => entry.candidates.length);
  const rerank = withCandidates.length
    ? await rerankShoppingOptions(
        // "2 litros de leite" virou "2× leite 1 litro": a mensagem original ("2 litros") contradiz o
        // pedido que a IA julga e ela recusava todas as caixas de 1 L (placar c27) — com o tamanho
        // reescrito, a IA recebe os pedidos já reescritos.
        withCandidates.some((entry) => entry.sizeSplit) ? withCandidates.map((entry) => entry.line.phrase).join(", ") : text,
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
  console.log(`[perf:buildChoices] extract=${perfExtracted - perfStart}ms search+live=${perfSearched - perfExtracted}ms rerank=${Date.now() - perfSearched}ms lines=${lines.length}`);
  const rerankedSkus = new Map<(typeof perLine)[number], string[]>();
  const rerankedClosest = new Map<(typeof perLine)[number], { skus: string[]; falta: string }>();
  const askedCheapest = new Set<(typeof perLine)[number]>();
  if (rerank) {
    // 2ª chance (09/10, rodada com a IA: "fralda pampers g e lenço umedecido" → "lenço umedecido: não achei" com 7
    // lenços confirmados na loja; a mesma chamada ora escolhia, ora zerava). Linha zerada que tem candidato com TODAS
    // as palavras do pedido é julgada de novo, sozinha, sem o resto da mensagem puxando o contexto.
    const retryIdx = withCandidates
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry, i }) => !rerank.lines[i].skus.length && !rerank.lines[i].proximos?.length && entry.candidates.some((c) => conciergeMatchIsStrong(entry.line.phrase, c.item, { allTokens: true })));
    if (retryIdx.length && withCandidates.length > 1) {
      const again = await Promise.all(
        retryIdx.map(({ entry }) =>
          rerankShoppingOptions(
            entry.line.phrase,
            [{ query: entry.line.phrase, candidates: entry.candidates.map((c) => ({ sku: c.item.sku, name: c.item.name, brand: c.item.brand, price: display(c.item.unitPrice, c.item.medicine), store: c.store.label })) }],
            vitrineLimit()
          ).catch(() => null)
        )
      );
      retryIdx.forEach(({ entry, i }, k) => {
        const line = again[k]?.lines[0];
        if (line?.skus.length) {
          console.log("[rerank:retry]", entry.line.phrase, line.skus.length);
          rerank.lines[i] = line;
        }
      });
    }
    withCandidates.forEach((entry, i) => {
      rerankedSkus.set(entry, rerank.lines[i].skus);
      if (rerank.lines[i].maisBarato) askedCheapest.add(entry);
      const closest = closestFromRerank(rerank.lines[i].proximos);
      if (closest) rerankedClosest.set(entry, closest);
    });
  }

  const autoAdded: BasketItem[] = [];
  const pending: PendingChoice[] = [];
  const notFound: string[] = [];
  const notFoundLines: ParsedLine[] = [];
  const unconfirmedLines = perLine.filter((entry) => entry.unconfirmed).map((entry) => entry.line.phrase);
  let firstStore: StoreConnector | undefined;
  for (const entry of perLine) {
    const { line, candidates, noneToday, urgentWhen } = entry;
    const bySku = new Map(candidates.map((c) => [c.item.sku, c]));
    const chosen = rerankedSkus.get(entry);
    // Equivalente de remédio (reserva de gatherCrossStoreCandidates) nunca entra como opção comum:
    // sem IA ele sairia como se fosse a marca pedida. Só pelo caminho do "mais perto", abaixo.
    const equivalent = medicineEnabled() ? medicineEquivalentFor(line.phrase) : null;
    const isEquivalent = (c: StoreCandidate) => Boolean(equivalent && c.item.medicine === "mip" && equivalent.matches(c.item.name));
    // Sem o juízo da IA (fora do ar/prazo): quem tem TODAS as palavras do pedido (marca, "sem fio", tamanho)
    // vem na frente do que só se parece; se ninguém tem, segue o ranking de sempre.
    const exactWords = chosen ? [] : candidates.filter((c) => !isEquivalent(c) && conciergeMatchIsStrong(line.phrase, c.item, { allTokens: true }));
    const fallbackPool = exactWords.length ? exactWords : candidates.filter((c) => !isEquivalent(c));
    let options: StoreCandidate[] = chosen
      ? chosen.map((sku) => bySku.get(sku)).filter((c): c is StoreCandidate => Boolean(c))
      : diversifyOptions(line.phrase, fallbackPool.map((c) => c.item), vitrineLimit()).map((item) => bySku.get(item.sku)!);
    // Ninguém cumpre tudo o que o cliente pediu (tamanho, sabor…) mas há produto do tipo certo:
    // vira escolha com o aviso da diferença; nunca entra na cesta sem o cliente tocar.
    let closestFalta: string | undefined;
    const closest = rerankedClosest.get(entry);
    if (!options.length && closest) {
      options = closest.skus.map((sku) => bySku.get(sku)).filter((c): c is StoreCandidate => Boolean(c));
      closestFalta = options.length ? closest.falta : undefined;
    }
    // Remédio (dono, 08/10): marca sem estoque, ou só o genérico na prateleira → o equivalente de
    // MESMO princípio ativo vira "o mais perto que tenho", nunca como se fosse o pedido. Os
    // candidatos já passaram pela checagem ao vivo; a reserva veio de gatherCrossStoreCandidates.
    if (!options.length && equivalent) {
      const alt = candidates.filter((c) => isEquivalent(c) && !isMedicineLineExtension(equivalent.queries[0], c.item.name));
      if (alt.length) {
        options = alt.slice(0, vitrineLimit());
        closestFalta = equivalent.faltaFor(alt[0].item.name);
      }
    }
    if (!options.length) {
      notFound.push(line.phrase);
      notFoundLines.push(line);
      continue;
    }
    firstStore = firstStore ?? options[0].store;
    // "O de sempre" (dono, 04/09): quem já comprou um produto vê ele PRIMEIRO e com
    // destaque quando pede de novo — mesmo que a IA/diversificação não o tenha posto
    // no top-3 (só não entra se a verificação ao vivo o tirou dos candidatos).
    const cheapestFirst = askedCheapest.has(entry) && !closestFalta;
    const repeatPick = preferredSkus?.size && !closestFalta && !cheapestFirst
      ? candidates
          .filter((c) => preferredSkus.has(c.item.sku))
          .sort((a, b) => (preferredSkus.get(b.item.sku) ?? 0) - (preferredSkus.get(a.item.sku) ?? 0))[0]
      : undefined;
    if (repeatPick && !options.some((o) => o.item.sku === repeatPick.item.sku)) options = [repeatPick, ...options];
    // Embalagem exata do pedido ("12 ovos" → dúzia) entra na vitrine mesmo fora do top-3.
    const exactPack = !closestFalta && line.qty >= 4 && countsPackContent(line.phrase) ? candidates.find((c) => declaredPack(c.item.name) === line.qty) : undefined;
    if (exactPack && !options.includes(exactPack)) options = [exactPack, ...options];
    // Item genérico do dia a dia ("2kg de frango"): se nenhuma opção é a versão comum (peito/coxa/filé), a primeira candidata
    // comum entra na frente (rodada 4, M8: só passarinho). Só quando a loja confirmou a candidata (está em `candidates`).
    const staplePrefer = !closestFalta && !askedCheapest.has(entry) ? stapleFor(line.phrase)?.prefer : undefined;
    if (staplePrefer && !options.some((o) => staplePrefer.test(normalizeMsg(o.item.name)))) {
      const common = candidates.find((c) => !isEquivalent(c) && staplePrefer.test(normalizeMsg(c.item.name)) && conciergeMatchIsStrong(line.phrase, c.item));
      if (common) options = [common, ...options];
    }
    let sortedOptions = options
      .map(({ store, item }) => {
        const check = liveChecks.get(liveKey(store.key, item.sku));
        const option = toChoiceOption(item, { storeKey: store.key, storeLabel: store.label }, check, urgent);
        return preferredSkus?.has(item.sku) ? { ...option, repeat: true } : option;
      })
      // Preço pedido explicitamente manda na ordem (desempate: confirmado ao vivo e prazo).
      .sort(cheapestFirst ? (a, b) => display(a.unitPrice, a.medicine) - display(b.unitPrice, b.medicine) || byVerifiedThenEta(a, b) : byRepeatThenVerifiedThenEta(line.phrase));
    // Pediu "sabonete dove" e há 2+ Dove de verdade (09/10, rodada de cliente): o Nivea cadastrado com marca
    // "Dove" pela loja sai da vitrine. Só quando sobra escolha; o já comprado fica sempre.
    const coversAsk = (o: ChoiceOption) => missingAskWords(line.phrase, { name: o.name }) === 0;
    if (!cheapestFirst && !closestFalta && sortedOptions.filter(coversAsk).length >= 2) {
      sortedOptions = sortedOptions.filter((o) => coversAsk(o) || o.repeat);
    }
    // Tamanho/embalagem pedido que nenhuma opção tem (rodada 4, M7: "Omo de 1 kg" e só 1,6/2,2 kg): o mesmo aviso do "mais
    // perto", mesmo quando a IA pôs as opções como se servissem. Mais próxima do pedido vai na frente.
    if (!closestFalta && !cheapestFirst) {
      const gap = sizeGapFor(line.phrase, sortedOptions);
      if (gap) {
        closestFalta = gap.falta;
        sortedOptions = gap.options;
      }
    }
    pending.push({
      query: line.phrase,
      qty: line.qty,
      ...(line.qtyExplicit ? { qtyExplicit: true } : {}),
      ...(line.cap != null ? { cap: line.cap, ...(lines.length === 1 ? { capTotal: true } : {}) } : {}),
      ...(line.autoPick && !closestFalta ? { autoPick: true } : {}),
      ...(closestFalta ? { closestFalta } : {}),
      ...(cheapestFirst ? { cheapestFirst: true } : {}),
      ...(urgent && !noneToday && cep ? { urgent: true, ...(urgentWhen ? { urgentWhen } : {}) } : {}),
      ...(urgent && noneToday ? { noneToday: true } : {}),
      options: (cheapestFirst ? sortedOptions : medicineBaseFirst(line.phrase, exactPackFirst(line.phrase, line.qty, sortedOptions), Boolean(closestFalta))).slice(0, vitrineLimit())
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
    prescriptionDropped,
    ...(unconfirmedLines.length ? { unconfirmed: unconfirmedLines } : {}),
    ...(specAsks.length ? { specAsks } : {})
  };
}

// Juízo do "não achei" (rodada 3): a categoria que a Lia não compra (sofá, geladeira, carro) e se o cliente
// fixou marca/versão/uso viram texto próprio. IA fora do ar → undefined e o texto de sempre sai.
async function judgeMisses(message: string, queries: string[]): Promise<copy.MissInfo[] | undefined> {
  const verdict = await classifyMisses(message, queries.map((q) => q.replace(/^\d+x\s+/, ""))).catch(() => null);
  return verdict ?? undefined;
}

async function buildChoicesWithSearchNotice(
  phone: string,
  text: string,
  lockedStoreKey?: string,
  preferredSkus?: Map<string, number>,
  forceLongTail?: boolean,
  cep?: string | null,
  opts?: { askSpecs?: boolean }
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
    cep,
    opts
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

function missingAskWords(query: string, option: { name: string; brand?: string }): number {
  const have = normalizeMsg(`${option.name} ${option.brand ?? ""}`).replace(/-/g, " ");
  const haveWords = new Set(have.split(/\s+/));
  return queryTokens(normalizeMsg(query)).filter((t) => !/^\d/.test(t) && !haveWords.has(t) && !have.includes(t)).length;
}

// Já comprado vem antes de tudo; entre iguais, confirmado ao vivo, depois o produto BÁSICO (sem sabor/edição
// que o pedido não pediu — 09/10) e depois o prazo.
function byRepeatThenVerifiedThenEta(query: string) {
  return (a: ChoiceOption, b: ChoiceOption): number => {
    const ra = a.repeat ? 1 : 0;
    const rb = b.repeat ? 1 : 0;
    if (ra !== rb) return rb - ra;
    const va = a.verified ? 1 : 0;
    const vb = b.verified ? 1 : 0;
    if (va !== vb) return vb - va;
    // O que o cliente DISSE vem antes (09/10, rodada de cliente: "sabonete dove" mostrava Nivea primeiro): opção que
    // não cobre uma palavra do pedido (marca, tipo) vai depois das que cobrem.
    // O NOME manda antes do campo de marca: a Casa Santa Luzia cadastra "Sabonete … Nivea" com marca "Dove" (09/10).
    const na = missingAskWords(query, { name: a.name });
    const nb = missingAskWords(query, { name: b.name });
    if (na !== nb) return na - nb;
    const ma = missingAskWords(query, a);
    const mb = missingAskWords(query, b);
    if (ma !== mb) return ma - mb;
    const pa = variantPenalty(query, a.name);
    const pb = variantPenalty(query, b.name);
    if (pa !== pb) return pa - pb;
    return byVerifiedThenEta(a, b);
  };
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

function choiceToBasketItem(o: ChoiceOption, qty: number, store: StoreConnector, ask?: string): BasketItem {
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
    ...(o.medicine === "mip" ? { medicine: "mip" as const } : {}),
    ...(ask?.trim() ? { ask: ask.trim().slice(0, 120) } : {}),
    ...(o.delivery ? { delivery: o.delivery } : {})
  };
}

// Prazo por loja da cesta (09/10, dono: "devia mostrar o prazo direto"): o que a loja informou na consulta
// ao vivo de cada card; loja com vários itens vale o MAIS LENTO. `complete` = toda linha tem prazo.
function deliveryMinutes(label: string): number {
  const t = normalizeMsg(label);
  if (/\bhoje\b/.test(t)) return 8 * 60;
  const n = Number((t.match(/(\d+)/) ?? [])[1] ?? NaN);
  if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER;
  if (/\bmin\b/.test(t)) return n;
  if (/\bh\b|\bhoras?\b|\d+h\b/.test(t)) return n * 60;
  if (/uteis|util/.test(t)) return n * 24 * 60 + 12 * 60;
  return n * 24 * 60;
}
export function basketEtaByStore(basket: BasketItem[]): { rows: { store: string; when: string }[]; complete: boolean } {
  const byStore = new Map<string, string>();
  let complete = basket.length > 0;
  for (const item of basket) {
    const when = item.delivery?.replace(/^prazo da loja:\s*/i, "").trim();
    if (!when) {
      complete = false;
      continue;
    }
    const store = item.storeLabel || item.storeKey;
    const prev = byStore.get(store);
    if (!prev || deliveryMinutes(when) > deliveryMinutes(prev)) byStore.set(store, when);
  }
  return { rows: [...byStore].map(([store, when]) => ({ store, when })), complete };
}

// Pergunta de prazo com a lista na mesa (09/10): toda forma — "quanto tempo demora", "quando chega",
// "em quanto tempo chega", "entrega hoje?" — responde com o prazo da loja, nunca o texto genérico.
const BASKET_ETA_ASK_RE = /\b(quando (chega|chegam|vai chegar|entrega|entregam|fica pronto)|chega(m)? quando|quanto tempo|quanto tenpo|em quanto tempo|que horas|qual (e |eh )?o prazo|prazo( de entrega)?|demora|demoram|chega(m)? hoje|entrega(m)? hoje|vai chegar|chega rapido|e rapido)\b/;
function isBasketEtaAsk(text: string): boolean {
  const n = normalizeMsg(text);
  return n.length <= 60 && BASKET_ETA_ASK_RE.test(n);
}
async function answerBasketEta(phone: string, convoId: string, ctx: DeliveryContext, userCep: string | null, askedToday = false) {
  if (ctx.pending?.length) {
    const known = basketEtaByStore(ctx.basket ?? []);
    await reply(phone, copy.etaAfterChoice(known.rows));
    await sendChoices(phone, ctx.pending[0]);
    return;
  }
  const eta = basketEtaByStore(ctx.basket ?? []);
  if (eta.complete && eta.rows.length) {
    await reply(phone, copy.basketEtaAnswer(eta.rows, askedToday));
    return;
  }
  // Sem o prazo de alguma loja na mão: o total traz o prazo de todas — fecha agora.
  await continueAfterBasket(phone, convoId, ctx, userCep, copy.etaComesWithTotal());
}

// Nome da loja junto do prazo em TODA opção — texto, card e carrossel (dono, 06/10: "nome da
// loja pode pôr", depois de dois testadores perguntarem "qual a loja?"). "Mambo · 1 dia útil".
function optionDelivery(o: ChoiceOption): string | undefined {
  const store = o.storeLabel?.trim();
  if (!store) return o.delivery;
  const when = o.delivery ? compactCardDelivery(o.delivery) : "";
  return when ? `${store} · ${when}` : store;
}

// Customer-facing options message (prices already marked up).
function choicesTextFor(p: PendingChoice, header?: string): string {
  return copy.choicesText(
    p.query,
    p.options.map((o) => ({ name: textChoiceName(p, o), displayPrice: display(o.unitPrice, o.medicine), delivery: optionDelivery(o), repeat: o.repeat })),
    header ?? choicesHeaderFor(p)
  );
}

function customerChoiceName(p: PendingChoice, option: ChoiceOption): string {
  if (option.storeKey === "boticario" && /\bperfume\b/i.test(p.baseQuery ?? p.query)) {
    return option.name.replace(/desodorante col[oô]nia/gi, "Perfume");
  }
  return option.name;
}

// Card de RECOMENDAÇÃO (08/10): o motivo vai na linha de baixo do nome (cards soltos) ou depois do nome
// (carrossel, onde a quebra vira " · " e o nome é encurtado para caber); na lista de texto, "_motivo_".
function cardChoiceName(p: PendingChoice, option: ChoiceOption): string {
  const name = customerChoiceName(p, option);
  return option.why ? `${name}\n_${option.why}_` : name;
}
function textChoiceName(p: PendingChoice, option: ChoiceOption): string {
  const name = customerChoiceName(p, option);
  return option.why ? `${name} · _${option.why}_` : name;
}

// Nome que a loja cadastrou repetido ("Energético Energy Drink Red Bull 250ml Energético Red Bull Energy Drink
// 250ml", Mambo, 09/10): fica a primeira metade quando a segunda repete as mesmas palavras.
export function dedupeProductName(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = normalizeMsg(words[0] ?? "");
  if (words.length < 4 || first.length < 3) return name;
  for (let i = 2; i < words.length - 1; i++) {
    if (normalizeMsg(words[i]) !== first) continue;
    const a = new Set(words.slice(0, i).map((w) => normalizeMsg(w)));
    const b = new Set(words.slice(i).map((w) => normalizeMsg(w)));
    const common = [...b].filter((w) => a.has(w)).length;
    if (common / Math.max(a.size, b.size) >= 0.7) return words.slice(0, i).join(" ");
  }
  return name;
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
  // Vendido por peso (06/10, A3): o preço vivo é de 1 unidade de ~X g, e o nome diz isso.
  const unitWeightKg = live?.available ? live.unitWeightKg : undefined;
  return {
    sku: o.sku,
    name: unitWeightKg ? copy.soldByWeightName(dedupeProductName(o.name), unitWeightKg) : dedupeProductName(o.name),
    brand: o.brand,
    // Preço da loja AGORA quando a simulação respondeu (05/10): o card e o total batem.
    unitPrice: live?.available && live.unitPrice != null ? live.unitPrice : o.unitPrice,
    ...(unitWeightKg ? { unitWeightKg } : {}),
    imageUrl: o.imageUrl,
    productUrl: o.productUrl ?? STORE_SEARCH_URL[storeRef?.storeKey ?? ""]?.(o.name),
    ...storeRef,
    ...(delivery ? { delivery } : {}),
    ...(o.freeShipping ? { freeShipping: true } : {}),
    ...(o.medicine === "mip" ? { medicine: "mip" as const } : {}),
    ...(live?.available ? { verified: true, ...(eta != null ? { etaMinutes: eta } : {}), ...(fee != null ? { freightFee: fee } : {}) } : {})
  };
}

// O produto cabe no teto do cliente (rodada 2, 07/10)? O teto é do TOTAL: produto + entrega. A entrega é a da
// loja para o CEP quando a verificação ao vivo respondeu; sem ela, a política publicada da loja.
function estimatedTotal(o: Pick<ChoiceOption, "unitPrice" | "medicine" | "storeKey" | "storeLabel" | "freightFee">, qty: number): number {
  const products = roundMoney(display(o.unitPrice, o.medicine) * Math.max(1, qty));
  const fee = o.freightFee ?? storeFreight(o.storeKey ?? CONCIERGE_STORE_KEY, o.storeLabel ?? "", roundMoney(o.unitPrice * Math.max(1, qty))).fee;
  return roundMoney(products + fee);
}

// Aplica o teto de uma pergunta (preço do produto; e, se for o teto do TOTAL, produto + entrega). Se nada cabe
// com a entrega mas algo cabe só no produto, mantém esses (o total avisa); nunca esvazia por causa do frete.
function withinBudget(pool: ChoiceOption[], p: { cap?: number; capTotal?: boolean; qty?: number }): ChoiceOption[] {
  if (p.cap == null) return pool;
  const byProduct = pool.filter((o) => display(o.unitPrice, o.medicine) <= p.cap! + 0.005);
  if (!p.capTotal) return byProduct;
  const byTotal = byProduct.filter((o) => estimatedTotal(o, p.qty ?? 1) <= p.cap! + 0.005);
  return byTotal.length ? byTotal : byProduct;
}

// Verificação ao vivo para opções montadas FORA do buildChoices (paginação, refino, resgate,
// troca): confirmado ganha preço/prazo/frete da loja; sem operador, o que a loja não
// confirmou sai (06/10 — a mesma regra da vitrine principal).
async function confirmOptionsLive(pool: ChoiceOption[], cep: string | null | undefined, opts?: { urgent?: boolean }): Promise<ChoiceOption[]> {
  if (!cep || !pool.length) return pool;
  const live = await checkCandidatesLive(pool.map((o) => ({ storeKey: o.storeKey ?? "", sku: o.sku, o })), cep);
  const checked = live.kept.map((w) => {
    const check = live.checks.get(liveKey(w.storeKey, w.sku));
    if (!check?.available) return w.o;
    // Pedido urgente (recomendação de fome/ressaca/"pra hoje", q9): o card mostra a entrega MAIS RÁPIDA da loja
    // (a cotação oferece a opção "rápido"), como a vitrine de sempre faz com o "pra hoje" (toChoiceOption urgent).
    const fast = Boolean(opts?.urgent && check.fastEstimate);
    const delivery = humanEstimate(fast ? check.fastEstimate : check.estimate);
    const weighed = check.unitWeightKg && !w.o.unitWeightKg ? { name: copy.soldByWeightName(w.o.name, check.unitWeightKg), unitWeightKg: check.unitWeightKg } : {};
    return {
      ...w.o,
      verified: true,
      ...weighed,
      ...(check.unitPrice != null ? { unitPrice: check.unitPrice } : {}),
      ...(delivery ? { delivery } : {}),
      ...((fast ? check.fastEtaMinutes : check.etaMinutes) != null ? { etaMinutes: fast ? check.fastEtaMinutes : check.etaMinutes } : {}),
      ...((fast ? check.fastFee : check.fee) != null ? { freightFee: fast ? check.fastFee : check.fee } : {})
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
  const noted = notedForCopy(ctx);
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

// Nome do item nos cabeçalhos ("Agora *Omo*"): a digitação errada do cliente não volta como está (09/10, rodada 1).
function shownQuery(p: PendingChoice): string {
  return displayQueryName(p.query, p.options);
}

function choicesHeaderFor(p: PendingChoice): string {
  if (p.closestFalta) return copy.closestHeader(p.query, p.closestFalta);
  if (p.cheapestFirst) return copy.cheapestFirstHeader(p.query);
  if (p.urgent) return copy.choicesHeaderToday(p.query, p.urgentWhen);
  if (p.noneToday) return copy.noneTodayHeader(p.query);
  return copy.choicesHeader(p.query);
}

// "Hoje" = entrega da loja em menos de um dia (SLA em minutos/horas ou "0bd").
function sameDayMaxMinutes(): number {
  return Number(process.env.LIA_SAME_DAY_MAX_MINUTES ?? 24 * 60);
}

// Itens ainda sem escolha, pelo nome que o cliente usou (09/10, rodada 2): "fecha"/"pagar"/"quanto tá" dizem QUAIS faltam.
function pendingNames(ctx: DeliveryContext): string[] {
  const names = (ctx.pending ?? []).map((p) => (p.baseQuery ?? p.query).trim()).filter(Boolean);
  return [...new Set(names)];
}

// O lembrete "as opções de X continuam aí em cima" não repete em falas seguidas (09/10, rodada 2: depois de "blz" saía
// o mesmo ponteiro três vezes numa conversa curta). Olha a última fala da Lia, de turnos anteriores.
function choicesNudgeAllowed(): boolean {
  const last = turnMeta.getStore()?.prevSent?.slice(-1)[0];
  return !(last && /continuam aí em cima/.test(last));
}

// "ok"/"blz"/"👍"/"obrigado"/"valeu" sozinhos: reconhecimento, nunca escolha nem encerramento (09/10, rodada 2).
const NEUTRAL_ACK_RE = /^(?:muito |mto )?(?:ok+|okay|oks|blz|beleza|certo|certinho|show|top|joia|massa|valeu|vlw|obrigad[oa]|obg|brigad[oa]|perfeito|otimo|legal|tudo bem|ta bom|ta certo|ta otimo|entendi|ahh?|aham)(?: (?:valeu|obrigad[oa]|pela ajuda|demais))?$/;
const EMOJI_ACK_RE = /^[\p{Extended_Pictographic}\u{FE0F}\u200d\s]+$/u;
function neutralAck(text: string): "thanks" | "ok" | null {
  const n = normalizeMsg(text).replace(/[!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (NEUTRAL_ACK_RE.test(n)) return /valeu|vlw|obrig|obg|brigad/.test(n) ? "thanks" : "ok";
  if (EMOJI_ACK_RE.test(text.trim())) return /[🙏❤💚🙌]/u.test(text) ? "thanks" : /[👍👌✅🆗😊🙂]/u.test(text) ? "ok" : null;
  return null;
}

// Reenvio idêntico (regra de 08/10): sem refazer a busca, mas nunca em silêncio (09/10, rodada 2). Turno anterior ainda
// rodando = uma linha ("já estou nisso"); já terminou = reapresenta a pergunta/opções em que a conversa parou.
async function replyToDuplicateInbound(phone: string, convoId: string) {
  const fresh = await prisma.conversation.findUnique({ where: { id: convoId }, select: { context: true, turnLock: true, turnLockAt: true } });
  const running = Boolean(fresh?.turnLock && fresh.turnLockAt && Date.now() - fresh.turnLockAt.getTime() < TURN_LOCK_TTL_MS);
  if (running) {
    await reply(phone, copy.duplicateStillWorking());
    return;
  }
  const ctx = readCtx(fresh?.context ?? null);
  if (ctx.step === "choosing" && ctx.pending?.[0]?.options.length) {
    await reply(phone, copy.duplicateRecap());
    await sendChoices(phone, ctx.pending[0]);
    return;
  }
  const last = ctx.lastSent && Date.now() - ctx.lastSent.at < REPEAT_WINDOW_MS ? ctx.lastSent.texts.slice(-1)[0] : undefined;
  await reply(phone, last ? copy.duplicateRecapLast(last) : copy.duplicateNothingToShow());
}

// Loja pedida pelo nome ("chocolate kopenhagen") que não aparece nas opções (09/10, rodada 3): uma linha avisa, em vez de
// mostrar Ferrero/Lindt como se fosse a loja pedida. Uma vez por escolha.
// Lojas que o cliente cita pelo nome mesmo quando o registro desta instância não as tem ligadas.
const KNOWN_RETAILER_NAMES = ["Ri Happy", "Kopenhagen", "Americanas", "Carrefour", "Petz", "Cobasi", "Boticário", "Magazine Luiza", "Casas Bahia", "Leroy Merlin", "Mercado Livre", "Mambo"];
function mentionableStoreNames(): string[] {
  return [...new Set([...listStores().map((s) => s.label), ...KNOWN_RETAILER_NAMES])].filter((n) => n.length >= 4);
}
function requestedStoreMissing(text: string, p: PendingChoice): string | null {
  if (p.storeNoted || !p.options.length) return null;
  const squash = (v: string) => normalizeMsg(v).replace(/[^a-z0-9]+/g, " ").trim();
  // O toque num card chega como "optsku:mambo-8057": o nome da loja ali NÃO é pedido do cliente (09/10, rodada 4, M1).
  const typed = text.replace(/\b(?:optsku|opt|choose|pick)[:_][^\s]+/gi, " ");
  // Só vale a loja pedida PARA ESTE item: com lista ("leite da mambo, fralda pampers") a menção precisa estar no trecho
  // do item (compartilha uma palavra da busca); texto de um item só vale inteiro.
  const segments = typed.split(/[,;\n+]| e /i).map(squash).filter(Boolean);
  const itemWords = new Set(squash(`${p.query} ${p.baseQuery ?? ""}`).split(" ").filter((w) => w.length >= 3));
  const sharesItem = (seg: string) => seg.split(" ").some((w) => w.length >= 3 && itemWords.has(w));
  for (const name of mentionableStoreNames()) {
    const label = squash(name);
    const key = label.replace(/\s+/g, "");
    const mentioning = segments.filter((seg) => ` ${seg} `.includes(` ${label} `));
    if (!mentioning.length) continue;
    if (segments.length > 1 && !mentioning.some(sharesItem)) continue;
    if (p.options.some((o) => squash(o.storeLabel ?? "") === label || squash(o.storeKey ?? "").replace(/\s+/g, "") === key)) return null;
    return name;
  }
  return null;
}

async function sendChoices(phone: string, p: PendingChoice, header?: string) {
  const missingStore = requestedStoreMissing(turnMeta.getStore()?.inboundText ?? "", p);
  if (missingStore) {
    p.storeNoted = true;
    await reply(phone, copy.requestedStoreNotShown(missingStore, shownQuery(p)));
  }
  // Remédio isento: a política da Meta veta CATÁLOGO, carrinho e pagamento nativo do
  // WhatsApp para remédio — não foto nem botão comum. Desde 05/10 (dono: "por que não pode
  // ter botão?") a vitrine de remédio é de cards soltos (foto + "Adicionar"); só o carrossel
  // fica de fora, porque é template de MARKETING revisado pela Meta.
  const medicine = medicineEnabled() && hasMip(p.options);
  // Meta supports reply buttons inside the 24h customer-service window. One card per
  // option keeps each "Escolher este" button attached to the correct product.
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    // Mesma vitrine recém-enviada e nada mudou (09/10, rodada 1): "arroz" + "e feijão também",
    // "oi?", "alô, tá aí?" reenviavam o carrossel inteiro do mesmo item — spam de cards. Uma
    // linha lembra a escolha; cabeçalho que informa algo novo (quantidade, refino…) reenvia.
    const reminder = !header || header === copy.choicesHeader(p.query) ? copy.choicesStillOpen(p.query)
      : header === copy.greetingMidChoice(p.query) ? copy.greetingChoicesStillOpen(p.query)
      : header === copy.demonstrativeNeedsChoice() ? header
      : undefined;
    const inbound = turnMeta.getStore()?.inboundText ?? "";
    if (reminder && !asksToSeeChoicesAgain(inbound) && (await choicesStillOnScreen(phone, p))) {
      await reply(phone, reminder);
      return;
    }
    // O id do botão carrega o SKU, não a posição: card antigo (de antes do
    // "outras"/refino) tocado depois escolhe o produto DAQUELE card — id
    // posicional confirmava outro produto quando a lista trocava por baixo.
    const choices = p.options.map((o) => ({
      id: `optsku:${o.sku}`,
      name: cardChoiceName(p, o),
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
        const legacyHeader = intro === copy.choicesHeader(p.query) ? copy.choicesHeaderLegacy(shownQuery(p)) : intro;
        const sent = await whatsappAdapter.sendDeliveryCarousel(phone, legacyHeader, choices);
        if (sent) {
          if (sent.messageId) await rememberCarousel(phone, sent.messageId, p, intro);
          else await rememberChoicesShown(phone, p, intro);
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
      if (interactive) {
        await rememberChoicesShown(phone, p, intro);
        return;
      }
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
    await replyPhoto(phone, copy.choiceLine(i, textChoiceName(p, o), display(o.unitPrice, o.medicine), optionDelivery(o), o.repeat), o.imageUrl);
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

// Cards soltos também ficam gravados (sender "choices", sem wamid) — só pra saber se a vitrine
// ainda está na tela (choicesStillOnScreen). O resgate de toque velho continua só nos carrosséis.
async function rememberChoicesShown(phone: string, p: PendingChoice, header: string) {
  try {
    const { convo } = await getOrCreateConvo(phone);
    await prisma.message.create({ data: { conversationId: convo.id, sender: "choices", text: JSON.stringify({ header, pending: p }) } });
  } catch (error) {
    console.warn("[choices:remember-failed]", error instanceof Error ? error.message : error);
  }
}

// A ÚLTIMA vitrine enviada nesta conversa é esta mesma (item, opções e preços), há menos de
// LIA_CHOICES_REPEAT_MS (3 min): o cliente ainda tem os cards logo acima.
function choicesRepeatWindowMs(): number {
  const value = Number(process.env.LIA_CHOICES_REPEAT_MS);
  return Number.isFinite(value) && value >= 0 ? value : 3 * 60_000;
}
const vitrineKey = (p: PendingChoice) => JSON.stringify([p.query, p.options.map((o) => [o.sku, o.unitPrice])]);
async function choicesStillOnScreen(phone: string, p: PendingChoice): Promise<boolean> {
  const windowMs = choicesRepeatWindowMs();
  if (!windowMs) return false;
  try {
    const { convo } = await getOrCreateConvo(phone);
    const last = await prisma.message.findFirst({
      where: { conversationId: convo.id, sender: { in: ["carousel", "carousel-recovered", "choices"] } },
      orderBy: { createdAt: "desc" },
      select: { text: true, createdAt: true }
    });
    if (!last || Date.now() - last.createdAt.getTime() > windowMs) return false;
    const saved = JSON.parse(last.text) as { pending?: PendingChoice };
    return Boolean(saved.pending?.options?.length) && vitrineKey(saved.pending!) === vitrineKey(p);
  } catch {
    return false;
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
      // Preço na mesma faixa (09/10, rodada de cliente: pão de R$ 9,89 → pão orgânico de R$ 26,84 "pra fugir do
      // mínimo"): a troca é pelo MESMO tipo de produto, até 1,5× e sem variante que o original não tinha.
      const alts = candidates.filter(
        (c) =>
          c.store.key !== store.key &&
          storeMinReal(c.store) === 0 &&
          conciergeMatchIsStrong(query, c.item) &&
          c.item.unitPrice <= item.unitPrice * 1.5 &&
          variantPenalty(query, c.item.name) <= variantPenalty(query, item.name)
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

// Resposta afirmativa à oferta de juntar (09/10, rodada 3): "juntar", "sim, juntar na X", "pode juntar", "ok junta".
// Palavras de aceite antes são ignoradas; negação ("não junta") nunca casa porque "nao" não está na lista.
function isJoinReply(said: string): boolean {
  return /^(?:(?:sim|ok|okay|pode|bora|quero|isso|claro|vamos|vai|beleza|blz|show|por favor|pf|entao)\b[\s,.!]*)*junt(?:a|ar|e|em)\b/.test(said);
}

// ---------- uma loja por pedido: juntar a cesta (08/10 noite) ----------
// A compra é por API e fecha UMA loja por pedido (dono, 08/10: "toda compra é por API"). A lista monta
// cada item na melhor loja, então "2 vodkas, 1 suco, 1 gin, 4 red bull" caía em três lojas (Santa Luzia,
// Americanas, Mambo) — com pedido mínimo, três fretes e nenhuma chance de fechar (90 dias: 50 cotações
// com mais de uma loja, NENHUMA paga). No fechamento, a Lia procura o MESMO produto nas lojas da cesta
// (depois nas outras lojas de compra automática) e junta tudo na loja que cobre a lista inteira pelo
// menor total. Mesmo produto = o que o cliente pediu na linha (ou, sem isso, o mesmo nome, marca e
// tamanho), entre metade e 1,5× o preço. Nenhuma loja cobre tudo → a cesta fica como está.
const MEASURE_IN_NAME_RE = /(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l|lt|litros?)\b/i;
function measureOf(name: string): number | null {
  const m = normalizeMsg(name).replace(/(\d),(\d)/g, "$1.$2").match(MEASURE_IN_NAME_RE);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  return unit === "kg" || unit === "l" || unit === "lt" || unit.startsWith("litro") ? value * 1000 : unit === "mg" ? value / 1000 : value;
}
function measureLabel(name: string): string | null {
  const m = normalizeMsg(name).replace(/(\d),(\d)/g, "$1.$2").match(MEASURE_IN_NAME_RE);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return `${m[1].replace(".", ",")} ${unit.startsWith("lit") || unit === "lt" ? "L" : unit === "l" ? "L" : unit}`;
}
// O pedido tem tamanho (peso/volume ±10%) ou número de unidades da embalagem e NENHUMA opção cumpre: devolve a diferença
// ("é de 1,6 kg") e as opções com a mais próxima na frente. Opções sem medida no nome não permitem concluir nada.
export function sizeGapFor<T extends { name: string }>(phrase: string, options: T[]): { falta: string; options: T[] } | null {
  if (!options.length) return null;
  const asked = measureOf(phrase);
  if (asked != null) {
    const sizes = options.map((o) => measureOf(o.name));
    if (sizes.some((z) => z == null)) return null;
    if (sizes.some((z) => Math.abs((z as number) - asked) / asked <= 0.1)) return null;
    const order = options.map((o, i) => ({ o, d: Math.abs((sizes[i] as number) - asked) }));
    order.sort((a, b) => a.d - b.d);
    const label = measureLabel(order[0].o.name);
    return label ? { falta: `é de ${label}`, options: order.map((x) => x.o) } : null;
  }
  const askedCount = UNIT_COUNT_RE.exec(normalizeMsg(phrase))?.[1];
  if (askedCount) {
    const counts = options.map((o) => UNIT_COUNT_RE.exec(normalizeMsg(o.name))?.[1]);
    if (counts.some((c) => c == null) || counts.some((c) => c === askedCount)) return null;
    return { falta: `é de ${counts[0]} unidades`, options };
  }
  return null;
}
// O substituto da consolidação tem que ser a MESMA coisa (09/10, rodada 3): mesmo tamanho (±10%), mesma
// quantidade na embalagem (fralda 60 un ≠ 92 un), mesma voltagem (127V ≠ 220V) e nenhum subtipo novo
// ("temperado", "integral", "zero"…). Troca que muda isso não é oferecida.
const UNIT_COUNT_RE = /(\d+)\s*(?:un|und|unid|unidades?|uni|folhas?|capsulas?|comprimidos?|tabletes?|sach[eê]s?)\b/;
const VOLTAGE_RE = /\b(110|127|220)\s*v\b|\bbivolt\b/;
const SUBTYPE_RE = /\b(temperad\w*|tempero|integral|desnatad\w*|lactose|zero|light|diet|aromatizad\w*|organic\w*|vegan\w*|gourmet)\b/g;
export function sameSpecAsOriginal(originalName: string, extraContext: string, candidateName: string): boolean {
  const o = normalizeMsg(originalName).replace(/(\d),(\d)/g, "$1.$2");
  const c = normalizeMsg(candidateName).replace(/(\d),(\d)/g, "$1.$2");
  const within = (a: number, b: number) => Math.abs(a - b) / a <= 0.1;
  const mo = measureOf(originalName);
  if (mo != null) {
    const mc = measureOf(candidateName);
    if (mc == null || !within(mo, mc)) return false;
  }
  const uo = UNIT_COUNT_RE.exec(o);
  if (uo) {
    const uc = UNIT_COUNT_RE.exec(c);
    if (!uc || !within(Number(uo[1]), Number(uc[1]))) return false;
  }
  const vo = VOLTAGE_RE.exec(o);
  if (vo) {
    const vc = VOLTAGE_RE.exec(c);
    if (!vc || vc[0] !== vo[0]) return false;
  }
  const known = `${o} ${normalizeMsg(extraContext)}`;
  for (const m of c.matchAll(SUBTYPE_RE)) if (!known.includes(m[0])) return false;
  return true;
}
function sameProductElsewhere(original: BasketItem, candidate: { name: string; brand?: string; unitPrice: number; medicine?: "mip" }): boolean {
  if (Boolean(original.medicine) !== Boolean(candidate.medicine)) return false;
  // Marca de verdade só: catálogo que põe o nome da LOJA no campo marca ("OBA", "Swift") ou "Não Disponível" não conta.
  const brand = normalizeMsg(original.brand ?? "").split(" ")[0] ?? "";
  const storeWords = new Set([original.storeKey, ...normalizeMsg(original.storeLabel ?? "").split(" ")]);
  const realBrand = brand.length >= 3 && !/^(nao|generico|marca)$/.test(brand) && !storeWords.has(brand);
  if (realBrand && !normalizeMsg(`${candidate.name} ${candidate.brand ?? ""}`).includes(brand)) return false;
  const a = measureOf(original.name);
  const b = measureOf(candidate.name);
  if (a != null && (b == null || Math.abs(a - b) / a > 0.1)) return false;
  return display(candidate.unitPrice, candidate.medicine) <= display(original.unitPrice, original.medicine) * 1.5;
}
// Produto × produto (não pedido × produto): o buscador lê "sem açúcar" como exclusão ("café SEM açúcar"),
// então nome de catálogo com "Sem Açúcar" nunca casava consigo mesmo. Aqui vale o nome: mesmo
// substantivo (1ª palavra) e ≥ 60% das palavras em comum, sem contar medidas.
function nameIdentity(name: string): string[] {
  return queryTokens(name).filter((token) => !/^\d/.test(token));
}
function sameNamedProduct(a: string, b: string): boolean {
  const ta = nameIdentity(a);
  const tb = new Set(nameIdentity(b));
  if (!ta.length || !tb.size || !tb.has(ta[0])) return false;
  const common = new Set(ta.filter((t) => tb.has(t))).size;
  return common / (new Set(ta).size + tb.size - common) >= 0.6;
}
// Oferta da loja pra uma linha da cesta. Com o pedido do cliente (`ask`), vale o que ele pediu: "vodka
// absolut" aceita qualquer Absolut (o sabor foi escolha da Lia), com o tamanho do PEDIDO quando ele disse um;
// sem `ask` (cesta antiga), o mesmo produto pelo nome.
async function findInStores(item: BasketItem, onlyStores: string[]): Promise<Map<string, ChoiceOption>> {
  const found = new Map<string, { option: ChoiceOption; score: number }>();
  if (!onlyStores.length) return new Map();
  const ask = item.ask?.trim();
  const query = ask || queryTokens(normalizeMsg(item.name).replace(/\bsem\s+\w+/g, " ")).filter((t) => !/^\d/.test(t)).slice(0, 5).join(" ");
  if (!query) return new Map();
  const askedSize = ask ? measureOf(ask) : null;
  const askTokens = new Set(ask ? nameIdentity(ask) : []);
  const generic = (t: string) => /^(garrafa|lata|unidades?|pack|refrigerado|integral|original|tradicional|classic[oa]?|regular|litros?|ml|kg)$/.test(t);
  const originalTokens = new Set(nameIdentity(item.name));
  const extras = new Set([...originalTokens].filter((t) => !askTokens.has(t) && !generic(t)));
  // Duas buscas: o pedido + o que distinguia a escolha ("suco de laranja natural one" acha o Natural One de
  // laranja pura que "suco de laranja" sozinho deixa de fora) e o pedido puro como reserva.
  const searches = ask && extras.size ? [`${ask} ${[...extras].slice(0, 3).join(" ")}`, query] : [query];
  const lists = await Promise.all(searches.map((q) => gatherCrossStoreCandidates(q, 40, 6, { noLongTail: true, onlyStores }).catch(() => [] as StoreCandidate[])));
  const seen = new Set<string>();
  const candidates: StoreCandidate[] = lists.flat().filter((c) => {
    const key = `${c.store.key}:${c.item.sku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const was = display(item.unitPrice, item.medicine);
  for (const c of candidates) {
    if (c.store.key === item.storeKey) continue;
    if (Boolean(item.medicine) !== Boolean(c.item.medicine)) continue;
    // Faixa de preço: até 50% mais caro; menos da metade do preço é outro produto (suco de R$ 4,49 → "Fruit
    // Shoot" infantil de R$ 0,99), não o mesmo em outra loja.
    const now = display(c.item.unitPrice, c.item.medicine);
    if (now > was * 1.5 || now < was * 0.5) continue;
    // Nunca pra uma variante que a escolhida não era (09/10: "Coca Cola 220ml" → "Coca-Cola Zero").
    if (variantPenalty(ask || query, c.item.name) > variantPenalty(ask || query, item.name)) continue;
    // Nem pra sub-tipo de uso que o escolhido não era (09/10: lenço umedecido → lenço de higiene íntima).
    const useQualifier = USE_QUALIFIER_RE.exec(normalizeMsg(c.item.name));
    if (useQualifier && !normalizeMsg(`${item.name} ${ask ?? ""} ${query}`).includes(useQualifier[0])) continue;
    if (!sameSpecAsOriginal(item.name, `${ask ?? ""} ${query}`, c.item.name)) continue;
    let ok: boolean;
    if (ask) {
      const size = measureOf(c.item.name);
      ok = conciergeMatchIsStrong(ask, c.item) && (askedSize == null || (size != null && Math.abs(size - askedSize) / askedSize <= 0.1));
    } else {
      ok = sameNamedProduct(item.name, c.item.name) && sameProductElsewhere(item, c.item);
    }
    if (!ok) continue;
    // Com o pedido: a 1ª que serve na ordem do buscador (relevância ao pedido, que já prefere o produto
    // básico — "vodka absolut" → Absolut Original, nunca a de pimenta só porque o nome parece com o sabor
    // escolhido antes). Sem o pedido: a mais parecida com o item escolhido.
    // O que distinguia a escolha além do pedido ("Natural One" no suco, "Raspeberry" na vodka) vem primeiro:
    // mesma marca/sabor quando a loja tem; senão, a ordem do buscador.
    // Palavra nova que nem o pedido nem a escolha tinham ("e Maçã" num suco de laranja) pesa contra.
    const tokens = nameIdentity(c.item.name);
    const shared = [...extras].filter((t) => tokens.includes(t)).length;
    const foreign = new Set(tokens.filter((t) => !askTokens.has(t) && !originalTokens.has(t) && !generic(t))).size;
    const score = ask
      ? candidates.length * (2 * shared - foreign) - candidates.indexOf(c)
      : nameSimilarity(item.name, c.item.name) - display(c.item.unitPrice, c.item.medicine) / 10_000;
    const prev = found.get(c.store.key);
    if (!prev || score > prev.score) found.set(c.store.key, { option: toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }), score });
  }
  return new Map([...found].map(([k, v]) => [k, v.option]));
}
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameIdentity(a));
  const tb = new Set(nameIdentity(b));
  if (!ta.size || !tb.size) return 0;
  const common = [...ta].filter((t) => tb.has(t)).length;
  return common / (ta.size + tb.size - common);
}
// Plano pra juntar a cesta numa loja só. Não muda o contexto (quem chama aplica): com teto de tempo, uma
// busca que termina depois não pode mexer numa cesta que já seguiu.
export async function consolidateBasketStores(ctx: Pick<DeliveryContext, "basket">): Promise<{ basket: BasketItem[]; storeLabel: string; pairs: copy.SwapPair[]; delta: number } | null> {
  const basket = ctx.basket ?? [];
  const basketStores = [...new Set(basket.map((i) => i.storeKey))];
  if (basketStores.length < 2 || basket.some((i) => !i.storeKey || i.storeKey === CONCIERGE_STORE_KEY || !(i.unitPrice > 0))) return null;
  const auto = automaticPurchaseStores();
  const eligible = (key: string) => key !== MERCADO_LIVRE_STORE_KEY && (!auto.length || auto.includes(key));
  const lineOf = (unitPrice: number, qty: number, medicine?: "mip") => Math.round(display(unitPrice, medicine) * qty * 100) / 100;
  const plan = async (targets: string[]) => {
    if (!targets.length) return null;
    const offers = await Promise.all(basket.map((item) => findInStores(item, targets.filter((t) => t !== item.storeKey))));
    let best: { store: string; total: number; native: number } | null = null;
    for (const store of targets) {
      let total = 0;
      let native = 0;
      let covers = true;
      basket.forEach((item, i) => {
        if (item.storeKey === store) {
          total += lineOf(item.unitPrice, item.qty, item.medicine);
          native += 1;
          return;
        }
        const offer = offers[i].get(store);
        if (!offer) covers = false;
        else total += lineOf(offer.unitPrice, item.qty, offer.medicine);
      });
      // Loja onde a cesta junta fica abaixo do pedido mínimo dela não serve (09/10: juntou na Americanas e travou no
      // mínimo de R$ 30 logo em seguida).
      const raw = basket.reduce((sum, item, i) => sum + (item.storeKey === store ? item.unitPrice : offers[i].get(store)?.unitPrice ?? 0) * item.qty, 0);
      const min = storeMinReal(getStore(store));
      if (covers && min > 0 && raw < min) covers = false;
      if (covers && (!best || native > best.native || (native === best.native && total < best.total - 0.009))) best = { store, total, native };
    }
    return best ? { ...best, offers } : null;
  };
  // 1º as lojas que já estão na cesta (troca menor: vence a que já tem mais itens); depois as outras de
  // compra automática.
  const inBasket = basketStores.filter(eligible);
  let chosen = await plan(inBasket);
  if (!chosen && auto.length) chosen = await plan(auto.filter((k) => eligible(k) && !inBasket.includes(k)));
  if (!chosen) return null;
  const target = getStore(chosen.store);
  const replacements = basket
    .map((item, i) => ({ item, offer: chosen!.offers[i].get(chosen!.store) }))
    .filter((r) => r.item.storeKey !== chosen!.store && r.offer)
    .map((r) => ({ fromSku: r.item.sku, qty: r.item.qty, option: r.offer!, ask: r.item.ask }));
  const moved = basket.filter((item) => item.storeKey !== chosen!.store);
  const oldTotal = basket.reduce((sum, i) => sum + lineOf(i.unitPrice, i.qty, i.medicine), 0);
  return {
    basket: mergeBaskets(
      basket.filter((item) => item.storeKey === chosen!.store).map((item) => ({ ...item })),
      replacements.map((r) => choiceToBasketItem(r.option, r.qty, target, r.ask))
    ),
    storeLabel: target.label,
    pairs: swapPairsForCopy(moved, replacements),
    delta: Math.round((chosen.total - oldTotal) * 100) / 100
  };
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
  {
    const meta = turnMeta.getStore();
    if (meta) meta.phone = phone;
  }
  // Formulário de cadastro: o histórico grava só um rótulo (o formulário traz o CPF).
  const signupForm = isSignupFormReply(input.flowResponse) ? input.flowResponse : undefined;
  // Formulário da lista (07/10): o histórico grava só um rótulo; a resposta crua tem skus.
  const listForm = !signupForm && isListFlowReply(input.flowResponse) ? input.flowResponse : undefined;
  const tagged = stripAcquisitionTag(signupForm ? SIGNUP_FORM_MESSAGE : listForm ? LIST_FLOW_MESSAGE : (input.text ?? "").trim());
  let text = tagged.text;
  const acquisition = mergeAcquisition(input.acquisition, tagged.campaignCode);
  const { user, convo } = await getOrCreateConvo(phone, input.name);
  // Loja pausada pelo vigia ou pelo dono (09/10) sai da vitrine deste turno (cache de 30 s).
  await refreshPausedStores();

  // Twilio/Meta retry the webhook when a turn is slow — never process the same inbound
  // message twice (a duplicated "2 arroz" would silently double the basket). O dedupe é
  // ATÔMICO pelo índice único (conversationId, metadata): checar-depois-gravar deixava
  // duas entregas SIMULTÂNEAS do mesmo sid passarem juntas pelo findFirst.
  let inboundMessageId: string | undefined;
  // Lugar na fila do turno (FIFO por conversa, 09/10): a mensagem gravada é a ordem de chegada.
  let ticket: TurnTicket | undefined;
  try {
    const created = await prisma.message.create({
      data: { conversationId: convo.id, sender: "user", text, metadata: input.messageId }
    });
    inboundMessageId = created.id;
    ticket = { messageId: created.id, createdAt: created.createdAt };
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
      await skipTurnTicket(convo.id, ticket);
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
    await skipTurnTicket(convo.id, ticket);
    return;
  }

  // Lista reenviada (08/10, teste do dono): a mesma lista chegou duas vezes em 23 s (wamids
  // diferentes — o cliente reenviou enquanto o 1º turno ainda buscava) e o 2º turno virou
  // "troca + busca de novo" em cima do formulário, com três carrosséis. Texto idêntico ao da
  // mensagem anterior, há poucos minutos, com cara de pedido de produto = reenvio por impaciência:
  // o 1º turno já responde (ou responderá); este NÃO refaz a busca. Rodada 2 (09/10): mudo também deixava o cliente sem sinal
  // — agora responde curto (replyToDuplicateInbound). Fica ANTES do lock de propósito.
  if (inboundMessageId && looksLikeProductList(text) && (await isRecentDuplicateInbound(convo.id, inboundMessageId, text))) {
    console.log("[inbound:duplicate]", phone, JSON.stringify(text.slice(0, 60)));
    await skipTurnTicket(convo.id, ticket);
    await replyToDuplicateInbound(phone, convo.id);
    return;
  }

  // Login do painel pelo WhatsApp (04/09): operador manda "ops" e recebe link de 10 min.
  // Fica ANTES do lock porque não toca no contexto da conversa.
  if (/^(ops|painel|login|entrar)$/i.test(text) && isAdminPhone(phone)) {
    // O link carrega o PAPEL de quem pediu: o operador contratado abre um painel sem as
    // contas das lojas nem as ações de dinheiro (ver src/lib/auth.ts).
    const token = createOpsLoginToken(Date.now(), phoneRole(phone) ?? "owner");
    await reply(phone, token ? copy.opsLoginLink(opsLoginUrl(token)) : copy.opsLoginUnavailable());
    await skipTurnTicket(convo.id, ticket);
    return;
  }

  // Teste do formulário de cadastro em produção (06/10): o dono ou um admin manda
  // "cadastro" e recebe o formulário mesmo já cadastrado. Preencher regrava os dados dele.
  if (!signupForm && /^cadastro$/i.test(text) && isAdminPhone(phone)) {
    await askSignup(phone, copy.signupFormBody(), () => reply(phone, copy.welcomeAskFullDeliveryAddress()));
    await skipTurnTicket(convo.id, ticket);
    return;
  }

  // Um turno por vez por conversa, na ordem de chegada (ver acquireTurnLock). O dedupe fica
  // ANTES do lock de propósito: retry do webhook sai na hora, sem esperar o turno original.
  const lockToken = await acquireTurnLock(convo.id, ticket);
  try {
    // Recarrega a conversa DEPOIS do lock: o turno anterior pode ter gravado contexto
    // enquanto esperávamos — processar sobre o snapshot velho recriaria a corrida.
    const freshConvo = (await prisma.conversation.findUnique({ where: { id: convo.id } })) ?? convo;
    // O snapshot do CAS também precisa avançar para o contexto recarregado; senão a
    // primeira escrita deste turno colide com a do turno que terminou enquanto
    // esperávamos o lock e morre em falso TurnSupersededError — cliente sem resposta.
    rememberCtxSnapshot(convo.id, freshConvo.context ?? null);
    {
      // Guarda anti-repetição: o que o cliente disse e as últimas falas da Lia (até 10 min atrás).
      const meta = turnMeta.getStore();
      const lastSent = readCtx(freshConvo.context ?? null).lastSent;
      if (meta) {
        meta.inboundText = text;
        meta.prevSent = lastSent && Date.now() - lastSent.at < REPEAT_WINDOW_MS ? lastSent.texts : [];
      }
    }
    // Contexto sem CEP (conversa nova/limpa): o CEP salvo do cliente define a área da busca.
    if (!currentShopperCep()) noteShopperCep(user.cep);
    if (signupForm) await handleSignupForm(phone, signupForm, user, freshConvo);
    else if (listForm) await handleListFlowReply(phone, listForm, user, freshConvo);
    else await handleDeliveryTurn(phone, text, user, freshConvo, inboundMessageId);
    // REDE ANTI-SILÊNCIO: nenhum caminho do turno respondeu nada → fallback pedindo
    // reformulação. Silêncio absoluto é o pior desfecho possível (28/08: 4 sessões).
    if ((turnMeta.getStore()?.replies ?? 1) === 0) {
      console.warn("[turn:zero-replies]", phone, text.slice(0, 80));
      await reply(phone, copy.fallbackNoAnswer());
    }
  } finally {
    await persistSentTexts(convo.id);
    await releaseTurnLock(convo.id, lockToken, ticket);
  }
}

// ---------- modo atendimento (07/10, placar c13/c30/c31) ----------
// O dono já foi avisado (atendente, reclamação, pedido sumido, CNPJ). O estado vive no contexto
// (`ctx.attendance`), não em memória do processo. `notifiedAt === 0` = a Lia só registrou que o
// cliente perguntou de um pedido inexistente, sem avisar ninguém ainda (a 2ª pergunta avisa).
const ATTENDANCE_TTL_MS = 12 * 60 * 60_000;
const ATTENDANCE_RENOTIFY_MS = 30 * 60_000;

function attendanceLive(ctx: DeliveryContext): NonNullable<DeliveryContext["attendance"]> | undefined {
  const att = ctx.attendance;
  return att && Date.now() - att.since < ATTENDANCE_TTL_MS ? att : undefined;
}

// Entra (ou renova) o modo. `notify` = avisar o dono agora (1ª vez, assunto novo ou 30 min depois).
function enterAttendance(ctx: DeliveryContext, kind: NonNullable<DeliveryContext["attendance"]>["kind"]): { notify: boolean; repeat: boolean } {
  const now = Date.now();
  const cur = attendanceLive(ctx);
  if (!cur || cur.notifiedAt === 0) {
    ctx.attendance = { kind, since: cur?.since ?? now, notifiedAt: now, acks: 0 };
    return { notify: true, repeat: false };
  }
  const notify = cur.kind !== kind || now - cur.notifiedAt >= ATTENDANCE_RENOTIFY_MS;
  ctx.attendance = { ...cur, kind, notifiedAt: notify ? now : cur.notifiedAt };
  return { notify, repeat: true };
}

// Próxima confirmação curta (nunca igual à anterior).
function nextAttendanceAck(ctx: DeliveryContext): string {
  const att = ctx.attendance;
  const n = att?.acks ?? 0;
  if (att) att.acks = n + 1;
  return copy.attendanceAck(n, withinOperatorHours());
}

// Contexto "quieto": sem cesta, escolha nem pedido em andamento. Só aí o modo atendimento intercepta.
function attendanceQuiet(ctx: DeliveryContext): boolean {
  if (ctx.pending?.length || ctx.basket?.length) return false;
  // Pergunta binária em aberto (plano B, "o de sempre", troca de loja, juntar pedido, cobrança, teto
  // estourado…): o "sim"/"ok" é resposta DELA, não espera pelo atendente.
  if (ctx.planB || ctx.repeatConfirm || ctx.minSwap || ctx.consolidationOffer || ctx.mergeDecision || ctx.longTailOffer || ctx.freightChoice || ctx.budget?.awaiting || ctx.packConfirm || ctx.cepSwap || ctx.cepCityCheck || ctx.cancelReason || ctx.withdrawConfirm || ctx.clearAllConfirm) return false;
  return !ctx.step || ctx.step === "collecting" || ctx.step === "need_cep" || ctx.step === "need_address";
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
  // "1"/"2" numa pergunta de sim/não em aberto (09/10, rodada 2): os botões são "sim"/"não", e o cliente que
  // digita o número não pode ter a quantidade mexida. Vale para toda pergunta binária pendente, num lugar só.
  const yesNoDigit = /^\s*([12])[\s.!]*$/.exec(text);
  if (yesNoDigit && ctx.consolidationOffer) {
    // Oferta de juntar aberta: 1 = juntar, 2 = manter; o número nunca mexe na quantidade (09/10, rodada 3).
    text = yesNoDigit[1] === "1" ? "consolidar:sim" : "consolidar:nao";
  } else if (yesNoDigit) {
    const free = !ctx.pending?.length;
    const recent = (at?: number) => at != null && Date.now() - at < 30 * 60_000;
    if (recent(ctx.withdrawConfirm?.askedAt) || recent(ctx.clearAllConfirm?.askedAt) || (free && (ctx.complementOffer || ctx.longTailOffer || ctx.repeatConfirm || ctx.minSwap))) {
      text = yesNoDigit[1] === "1" ? "sim" : "não";
    }
  }
  // Link de produto/loja (09/10, rodada 3): a Lia não abre link; uma linha pede o nome do produto (antes: ~24 s de busca
  // por pedaços da URL e "não achei"). Se a mensagem trazia mais texto, o resto segue como pedido.
  {
    const linkless = stripLinks(text);
    if (linkless.hadLink && !/^[a-z][a-z0-9]*(?:[:_][a-z0-9:._-]+)+$/i.test(text.trim())) {
      await reply(phone, copy.productLinkNotOpened());
      // "olha esse <link>": sobra só enrolação, nenhum produto — a linha acima já pede o nome (antes vinham 2 mensagens, 10/10).
      const LINK_FILLER = new Set(["olha", "olhe", "ve", "veja", "acha", "achar", "procura", "procure", "busca", "quero", "queria", "me", "manda", "esse", "essa", "isso", "este", "esta", "aqui", "ai", "o", "a", "um", "uma", "link", "produto", "item", "pra", "para", "mim", "por", "favor", "pf", "pfv", "aquele", "aquela", "desse", "dessa", "disso", "tem", "se", "comprar", "compra"]);
      if (!normalizeMsg(linkless.text).split(/\s+/).some((word) => word.length >= 2 && !LINK_FILLER.has(word))) return;
      text = linkless.text;
    }
    // Pedido em inglês ("I need a phone charger and some milk"): traduz o básico e segue; fora do dicionário, como veio.
    const english = translateEnglishOrder(text);
    if (english) text = english;
  }
  let intent = detectIntent(text);
  // "só essa" com o item já na cesta e nada em escolha (07/10, c07): é fechar a lista — não "a qual produto
  // você se refere?" (o cliente então digitava o nome e o mesmo item entrava de novo: 2x).
  if (intent.kind === "free_text" && !(ctx.pending?.length) && (ctx.basket?.length ?? 0) > 0 && ctx.step === "collecting") {
    const only = parseOnlyKeep(text);
    if (only && "demonstrative" in only) intent = { kind: "done" };
  }

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

  // Resposta à pergunta de especificação (g7, 09/10): "iphone 13" / "é tipo c" volta para a busca daquele item.
  // Vale 30 min; mensagem que não parece a resposta segue o fluxo normal e a pergunta continua de pé.
  if (ctx.specAsk) {
    const live = Date.now() - ctx.specAsk.askedAt < SPEC_ASK_TTL_MS ? ctx.specAsk : undefined;
    if (!live) {
      ctx.specAsk = undefined;
      await writeCtx(convo.id, ctx);
    } else if (intent.kind === "free_text" || intent.kind === "reject") {
      if (specAnswerUnknown(text)) {
        ctx.specAsk = undefined;
        await writeCtx(convo.id, ctx);
        await reply(phone, live.asks.map((a) => copy.specSkipped(a.query)).join("\n"));
        return;
      }
      const idx = intent.kind === "free_text" ? live.asks.findIndex((a) => specAnswerLooksValid(a.kind, text)) : -1;
      if (idx >= 0) {
        const answered = live.asks[idx];
        const rest = live.asks.filter((_, i) => i !== idx);
        ctx.specAsk = rest.length ? { asks: rest, askedAt: live.askedAt } : undefined;
        await writeCtx(convo.id, ctx);
        text = combineSpecQuery(answered, text);
        intent = detectIntent(text);
      }
    }
  }

  // Desistência de pedido PAGO esperando o "sim" (06/10). "sim"/"confirmo"/"cancela" de novo
  // estornam; "não" mantém; qualquer outra mensagem desarma e segue o fluxo normal — o
  // pedido continua de pé e o cliente nunca fica preso na pergunta.
  if (ctx.withdrawConfirm) {
    const asked = Date.now() - ctx.withdrawConfirm.askedAt < 30 * 60_000 ? ctx.withdrawConfirm : undefined;
    ctx.withdrawConfirm = undefined;
    await writeCtx(convo.id, ctx);
    if (asked && (intent.kind === "affirm" || intent.kind === "cancel" || intent.kind === "refund_request")) {
      await confirmWithdraw(phone, convo.id, user.cep, ctx, asked.orderId);
      return;
    }
    if (asked && intent.kind === "reject") {
      await reply(phone, copy.withdrawKept(asked.orderId.slice(-6).toUpperCase()));
      return;
    }
  }

  // "cancela" ambíguo com vários itens em escolha (09/10, rodada 1): "sim"/"tudo" esvazia; "não" mantém e volta pra
  // escolha; qualquer outra mensagem desarma e segue o fluxo normal (a cesta continua de pé).
  if (ctx.clearAllConfirm) {
    const asked = Date.now() - ctx.clearAllConfirm.askedAt < 30 * 60_000;
    ctx.clearAllConfirm = undefined;
    const said = normalizeMsg(text);
    if (asked && (intent.kind === "affirm" || intent.kind === "cancel" || intent.kind === "clear_cart" || /^(tudo|a cesta toda|tudo mesmo|limpa tudo)[\s!.]*$/.test(said))) {
      await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
      await reply(phone, copy.cartCleared());
      return;
    }
    await writeCtx(convo.id, ctx);
    if (asked && intent.kind === "reject" && /^(nao|n|nn|nao quero|nao precisa|melhor nao)[\s!.]*$/.test(said)) {
      await reply(phone, copy.cancelAllKept());
      if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
      return;
    }
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
    const expiredCart = snapshotExpiredCart(ctx, idleMs);
    const keptCep = ctx.cep;
    const keptAddr = ctx.deliveryAddress;
    const keptAddrVerified = ctx.deliveryAddressVerified;
    for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
    ctx.flow = "delivery";
    ctx.cep = keptCep;
    ctx.deliveryAddress = keptAddr;
    ctx.deliveryAddressVerified = keptAddrVerified;
    if (expiredCart) ctx.expiredCart = expiredCart;
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
      const expiredCart = snapshotExpiredCart(ctx, quoteIdleMs, true);
      const fresh = addressOnlyCtx(ctx);
      for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
      Object.assign(ctx, fresh);
      if (expiredCart) ctx.expiredCart = expiredCart;
      await writeCtx(convo.id, ctx);
      // 08/10 (dono, teste da lista): SEM "cancelei o pedido por inatividade". Quem parou na
      // compra e volta um dia depois pedindo outra coisa só quer a coisa nova — o pedido velho
      // morre em silêncio (nada foi cobrado) e a mensagem segue como pedido novo.
      if (canceledShortId) console.log("[quote:abandoned]", canceledShortId);
      // Toque num BOTÃO velho não é mensagem nova pra processar: sem isso "frete:barato"
      // seguiria adiante como se fosse uma lista de compras.
      if (isFreightChoicePayload(text)) {
        await reply(phone, copy.quoteExpired());
        return;
      }
    }
  }

  // Cesta/cotação vencida (09/10, rodada 1): quem volta com "oi", "1", "pagar" é avisado e retoma com "sim";
  // quem já chega com um pedido novo segue com ele (o aviso só atrapalharia, 25/09).
  if (ctx.expiredCart) {
    const expired = ctx.expiredCart;
    const nText = normalizeMsg(text).replace(/[!.?,]+/g, " ").trim();
    const resumeYes = intent.kind === "affirm" || /^(1|um)$/.test(nText);
    const nudge = ["greeting", "pay", "status", "paid_claim", "choose_payment", "done", "resume_where", "more_options", "thanks"].includes(intent.kind);
    const stillFresh = Date.now() - expired.at < 3 * 24 * 60 * 60_000;
    if (stillFresh && (user.defaultAddress || ctx.deliveryAddressVerified) && expired.items.length) {
      if (resumeYes) {
        ctx.expiredCart = undefined;
        ctx.flow = "delivery";
        ctx.step = "collecting";
        await writeCtx(convo.id, ctx);
        await handleSearch(phone, convo.id, user.cep, ctx, expired.items.join(", "), user.id);
        return;
      }
      if (intent.kind === "reject" || intent.kind === "cancel" || intent.kind === "clear_cart") {
        ctx.expiredCart = undefined;
        await writeCtx(convo.id, ctx);
        await reply(phone, copy.cartExpiredDropped());
        return;
      }
      if (nudge || /^(1|um)$/.test(nText)) {
        await reply(phone, copy.cartExpired(expired.items, Boolean(expired.quote)));
        return;
      }
    }
    // Qualquer outra mensagem é assunto novo: a cesta velha sai de cena.
    ctx.expiredCart = undefined;
    await writeCtx(convo.id, ctx);
  }

  // Depois dos dois resets acima, para a marca não morrer na mesma mensagem que a criou.
  // Persistida pelo writeCtx do handler que tratar a mensagem (toda rota de pedido grava).
  if (!ctx.urgent && hasUrgencySignal(text)) ctx.urgent = true;
  // Prazo dito ("é aniversário da minha mãe amanhã"): o total avisa se a entrega não cumpre (rodada 4, M6).
  const neededBy = parseNeededBy(text);
  if (neededBy) ctx.neededBy = neededBy;

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

  // Botão "Mudar ou adicionar" (antes "Mudar minha lista", 07/10; juntado com "Adicionar mais" em 08/10):
  // reabre o formulário com a lista como está agora (o corpo diz que item novo é só mandar o nome).
  // Sem formulário pra reabrir (lista já fechada, flag desligada): vira o "Adicionar mais" de sempre.
  if (normalizeMsg(text) === LIST_FLOW_REOPEN_ID) {
    if (!(await reshowListFlow(phone, convo.id, ctx, "reopen"))) {
      if (ctx.step === "collecting" && (ctx.basket?.length ?? 0) > 0) await reply(phone, copy.askMoreItems());
      else await reply(phone, copy.listFlowClosed());
    }
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
  // Botão antigo reenviado como texto (09/10, rodada 2): "complemento_nao" sem oferta aberta não é pedido de produto
  // ("optsku:..." já tem intent próprio, stale_option_tap).
  {
    const tap = text.trim().toLowerCase();
    if ((/^complemento_(sim|nao)$/.test(tap) && !ctx.complementOffer) || (/^longtail_(sim|nao)$/.test(tap) && !ctx.longTailOffer)) {
      await reply(phone, copy.staleButtonTap(false));
      return;
    }
  }

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

  // Complemento no fechamento (08/10, recomendação fase 4): resposta à oferta "quer adicionar o X?".
  if (ctx.complementOffer && (await handleComplementAnswer(phone, convo.id, user, ctx, text, intent))) return;

  // Memória do cliente (08/10, recomendação fase 2): "sou intolerante a lactose", "tenho um cachorro
  // grande", "somos 4 em casa" ficam guardados; "esquece minhas preferências" apaga.
  if (await handlePreferenceStatement(phone, convo.id, user, ctx, text)) return;

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

  // PEDIDO + PERGUNTA DE SERVIÇO na mesma mensagem (07/10, c06/c13): a pergunta é respondida e só o
  // resto segue como pedido — antes a pergunta virava produto ("Não achei: ver o total…") ou engolia o pedido.
  if (["service_question", "free_text", "trust_question", "identity"].includes(intent.kind) && /\?/.test(text) && (!ctx.step || ctx.step === "collecting" || ctx.step === "choosing" || ctx.step === "need_address" || ctx.step === "need_cep")) {
    const mixed = splitServiceQuestions(text);
    if (mixed) {
      const onTable = ctx.step === "choosing" && ctx.pending?.length ? ctx.pending[0].options : [];
      for (const { intent: asked } of mixed.questions) {
        if (asked.kind === "trust_question") await reply(phone, copy.trustAnswer());
        else if (asked.kind === "identity") await reply(phone, copy.identityAnswer());
        else if (asked.kind === "service_question" && asked.topic === "stores") await reply(phone, copy.storesAnswer(onTable.map((o) => ({ storeLabel: o.storeLabel }))));
        else if (asked.kind === "service_question") await reply(phone, copy.serviceAnswer(asked.topic, servedAreaLabel(), { hasCep: Boolean(user.cep ?? ctx.cep), hasBasket: (ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0 }));
      }
      text = mixed.rest;
      intent = detectIntent(text);
    }
  }

  // "tem alguma farmácia parceira que venda?" / "consegue indicar uma farmácia que entregue dipirona?"
  // (07/10, c35/c08): é pergunta, com resposta fixa — não pede endereço, não vira busca de "farmácia"
  // e vem ANTES da guarda de remédio (que repetiria a recusa em vez de responder).
  if (
    looksLikePharmacyPartnerAsk(text) &&
    (looksLikeMedicine(text) || isPrescriptionDrugName(text) || /\b(?:remedios?|medicamentos?|receita)\b/.test(normalizeMsg(text)) || (ctx.medicineRefusedAt != null && Date.now() - ctx.medicineRefusedAt < 60 * 60_000))
  ) {
    await reply(phone, copy.pharmacyPartnerAnswer(medicineEnabled()));
    if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
    return;
  }

  // GUARDA DE REMÉDIO GLOBAL (26/08 P1.6: 2/4 — a recusa dependia da etapa; na
  // pergunta de quantidade "também queria dipirona" virava "responde o número").
  // "sem remédio, quero X" segue como pedido (negação já tratada na extração).
  if (refusesWholeMessage(text) && !/^sem\s/.test(normalizeMsg(text))) {
    await refuseMedicine(phone, convo.id, ctx, text);
    if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
    return;
  }
  // ENDEREÇO + PERGUNTA na mesma mensagem, antes do cadastro (07/10, c06): "…, 01451-001. E como vc
  // funciona? De onde vc compra?" era engolida pela pergunta — o endereço nunca era salvo e o pedido
  // guardado se perdia. Responde a pergunta e segue só com o endereço.
  if ((!user.defaultAddress || ctx.step === "need_address" || ctx.step === "need_cep") && ["service_question", "trust_question", "identity", "help", "free_text"].includes(intent.kind) && looksLikeDeliveryAddress(text) && /\?/.test(text)) {
    const split = splitAddressAndItems(text);
    if (split?.items && /\?/.test(split.items) && looksLikeDeliveryAddress(split.address)) {
      const askIntent = detectIntent(split.items);
      if (askIntent.kind === "service_question") await reply(phone, copy.serviceAnswer(askIntent.topic, servedAreaLabel(), { hasCep: false, hasBasket: false }));
      else await answerOnboardingQuestion(phone, split.items);
      text = split.address;
      intent = detectIntent(text);
    }
  }

  // MODO ATENDIMENTO (07/10, c13/c30/c31): o dono já foi avisado e o cliente só espera ou cobra
  // ("vou esperar", "e aí?", "preciso falar com alguém mesmo", "conseguem procurar pelo meu CPF?").
  // Confirmação CURTA e diferente da anterior, sem pedir endereço nem produto. Pedido de produto
  // não casa com o léxico e segue o fluxo normal.
  {
    const att = attendanceLive(ctx);
    if (
      att &&
      att.notifiedAt > 0 &&
      attendanceQuiet(ctx) &&
      ["free_text", "thanks", "greeting", "hold", "resume_where", "affirm"].includes(intent.kind)
    ) {
      // O léxico pega a espera comum; o resto ("só preciso que alguém me atenda agora") a classificação
      // decide: suporte/conversa é espera, pedido de produto segue o fluxo normal.
      let waiting = isAttendanceFollowUp(text);
      if (!waiting && intent.kind === "free_text" && !isQuestion(text)) {
        const verdict = await interpretCustomerMessage({ text, state: "o responsável humano já foi avisado e o cliente aguarda atendimento; nenhuma compra em andamento" }).catch(() => null);
        waiting = verdict?.action === "support" || verdict?.action === "smalltalk";
      }
      if (waiting) {
        const ack = nextAttendanceAck(ctx);
        await writeCtx(convo.id, ctx);
        await reply(phone, ack);
        return;
      }
    }
  }

  // Orçamento estourado e nada cabe (07/10, c23/c24): "pode"/"assim mesmo" segue com o item; "não"
  // tira da lista. Qualquer outra mensagem desarma e segue o fluxo normal (o teto deixa de valer).
  if (ctx.budget?.awaiting && !ctx.pending?.length && (ctx.basket?.length ?? 0) === 1 && (!ctx.step || ctx.step === "collecting")) {
    const n = normalizeMsg(text);
    if (intent.kind === "affirm" || intent.kind === "done" || intent.kind === "pay" || /\b(assim mesmo|mesmo assim|pode fechar|pode seguir|segue assim|fecha assim|fecha mesmo)\b/.test(n)) {
      ctx.budget = { ...ctx.budget, awaiting: false, override: true };
      await writeCtx(convo.id, ctx);
      await continueAfterBasket(phone, convo.id, ctx, user.cep);
      return;
    }
    if (intent.kind === "reject" || intent.kind === "cancel" || intent.kind === "clear_cart") {
      ctx.basket = [];
      ctx.budget = undefined;
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.overBudgetDeclined());
      return;
    }
    // Pedido de outro produto ("tem algum perfume que fique até 100 com entrega?"): o item que estourou
    // SAI da cesta (era ele que não cabia) e o teto acompanha a busca nova — sem somar os dois no total.
    if (intent.kind === "free_text") {
      const cap = ctx.budget.cap;
      ctx.basket = [];
      ctx.budget = undefined;
      ctx.lastChoice = undefined;
      if (parsePriceCap(text) == null) text = `${text} até ${cap} reais`;
    } else {
      ctx.budget = { ...ctx.budget, awaiting: false };
    }
  }

  // Teto dito numa mensagem separada, com o item já na cesta ("tenho até uns R$60", "no máximo 150 com a entrega"):
  // vira o limite do TOTAL e é conferido ao cotar (rodada 2, 07/10). Nunca vira "produto não encontrado".
  if ((!ctx.step || ctx.step === "collecting") && !ctx.pending?.length && (ctx.basket?.length ?? 0) === 1 && !ctx.budget?.awaiting && !ctx.deliveryOrderId) {
    const statedBudget = parseBudgetStatement(text);
    if (statedBudget != null) {
      ctx.budget = { cap: statedBudget, sku: ctx.basket![0].sku };
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.budgetNoted(statedBudget));
      return;
    }
  }

  // Recusa + exigência com as opções na mesa: refino determinístico, antes do gerente de diálogo.
  if (ctx.step === "choosing" && ctx.pending?.length && intent.kind === "free_text" && (await tryRejectedRefine(phone, convo.id, ctx, text))) return;

  // Teto dito sozinho com as opções na mesa ("cerca de 60 reais com a entrega"): trata aqui, antes do gerente de
  // diálogo — que o lia como "unclear" e perguntava de volta, deixando o total passar do limite (rodada 2).
  if (ctx.step === "choosing" && ctx.pending?.length) {
    const optionsBudget = parseBudgetStatement(text);
    if (optionsBudget != null) {
      const current = ctx.pending[0];
      const store = getStore(current.options[0]?.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
      await applyChoiceBudget(phone, convo.id, ctx, store, current, optionsBudget);
      return;
    }
  }

  // Trocar de produto com a escolha de entrega ou o total na mesa (07/10, c24): "troca pelo de R$ 34,09",
  // "prefiro o outro". Reabre o pedido (nada cobrado) e põe a opção pedida no lugar — antes a Lia
  // repetia "o frete é o da loja" e ignorava o pedido.
  if ((ctx.step === "choosing_freight" || ctx.step === "awaiting_quote_confirmation") && ctx.lastChoice && ctx.deliveryOrderId) {
    const last = ctx.lastChoice;
    const currentIndex = last.options.findIndex((o) => o.sku === last.chosenSku);
    // Na escolha de entrega "1"/"2"/"o outro" são as opções de FRETE: lá só vale o preço do produto.
    const atFreight = ctx.step === "choosing_freight";
    // "muda pra 6" / "põe 6" com o resumo na tela é QUANTIDADE (09/10, rodada 1), não a opção 6 da lista.
    const viaIndex = atFreight || parseQtyCommand(text) ? null : parseChoiceSwitch(text);
    const ref =
      currentIndex >= 0
        ? parseOptionSwitchRef(text, last.options.map((o) => ({ name: o.name, price: display(o.unitPrice, o.medicine) })), currentIndex, { priceOnly: atFreight })
        : null;
    const switchTo = ref ? { index: ref.index } : viaIndex;
    if (switchTo && currentIndex >= 0) {
      const reopened = await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
      if (reopened) {
        await handleChoiceSwitch(phone, convo.id, user.cep, ctx, switchTo, true);
        return;
      }
    }
    // "tem alguma opção que fique até R$ 80 com a entrega?" (07/10, c24): o cliente só agora disse o teto.
    // Reabre e refaz a cotação com o orçamento valendo — se o total estoura, as opções que cabem voltam.
    const statedCap = switchTo ? null : parsePriceCap(text);
    if (statedCap != null && currentIndex >= 0) {
      const reopened = await reopenOrderForEdit(phone, convo.id, ctx, user.cep);
      if (reopened && (ctx.basket?.length ?? 0) === 1) {
        ctx.budget = { cap: statedCap, sku: last.chosenSku };
        await writeCtx(convo.id, ctx);
        await continueAfterBasket(phone, convo.id, ctx, user.cep);
        return;
      }
    }
  }

  // Total/entrega na mesa há mais de 10 min + pedido de produto do nada (08/10, teste do dono: parou
  // na compra ontem, hoje mandou outra lista e ouviu "cancelei o pedido"): é OUTRA missão de compra.
  // Mesma regra do Pix emitido (04/09, dono: "se ele esquece do outro e pede outra coisa, só dá o que
  // ele pede"): sem "adiciona", nada de fundir a cesta velha nem anunciar — o pedido antigo é cancelado
  // em silêncio (nada foi cobrado), o endereço fica e a mensagem segue como pedido novo. Até 10 min,
  // "e um óleo" continua sendo ajuste do mesmo pedido (reabre e refaz o total). Fica ANTES do gerente
  // de diálogo, que trataria a lista nova como edição do pedido na mesa.
  if (
    (ctx.step === "awaiting_quote_confirmation" || ctx.step === "choosing_freight") &&
    ctx.deliveryOrderId &&
    intent.kind === "free_text" &&
    !isQuestion(text) &&
    !explicitAddCue(text) &&
    looksLikeNewProductRequest(text)
  ) {
    const waiting = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId }, select: { id: true, updatedAt: true } });
    // Relógio = publicação da cotação (updatedAt do pedido; ver o segundo relógio do TTL de abandono).
    const quoteAgeMs = waiting ? Date.now() - waiting.updatedAt.getTime() : 0;
    if (waiting && quoteAgeMs >= newMissionAfterMs() && (await cancelPendingRetailerQuote(waiting.id))) {
      console.log("[quote:new-mission]", waiting.id.slice(-6).toUpperCase(), JSON.stringify(text.slice(0, 60)));
      const fresh = addressOnlyCtx(ctx, user.cep);
      for (const key of Object.keys(ctx)) delete (ctx as unknown as Record<string, unknown>)[key];
      Object.assign(ctx, fresh);
      await writeCtx(convo.id, ctx);
      await handleSearch(phone, convo.id, user.cep, ctx, text, user.id);
      return;
    }
  }

  // Resposta à pergunta de esclarecimento da Lia (09/10, rodada 3): "Qual leite você quer?" → "o integral mesmo, e o pão
  // de forma". A resposta resolve a pergunta e o resto é SOMADO à cesta; nunca vira "lista nova".
  // Com o carrossel de UM item aberto, "o integral mesmo, e o pão de forma" também responde a esse item.
  const choosingNow = ctx.step === "choosing" ? ctx.pending?.[0] : undefined;
  const impliedQuestion =
    !ctx.openQuestion && choosingNow && intent.kind === "free_text" && /\b(mesmo|mesma|pode ser)\b/.test(normalizeMsg(text)) && /,|\be\b/.test(text) && !/\d/.test(text)
      ? { text: `Qual ${choosingNow.query} você quer?`, at: Date.now() }
      : undefined;
  if (ctx.openQuestion || impliedQuestion) {
    const open = (ctx.openQuestion ?? impliedQuestion)!;
    ctx.openQuestion = undefined;
    if (Date.now() - open.at < 10 * 60_000 && intent.kind === "free_text" && !isQuestion(text)) {
      const answered = answerOpenQuestion(open.text, text);
      // No carrossel aberto só vale quando há item extra; a resposta sozinha é refinamento e o fluxo de escolha cuida.
      if (answered && (!impliedQuestion || answered.includes(","))) {
        console.log("[open-question:answer]", JSON.stringify(open.text), "->", JSON.stringify(answered));
        if (impliedQuestion && choosingNow) ctx.pending = ctx.pending!.filter((p) => p !== choosingNow);
        if (impliedQuestion && !ctx.pending?.length) ctx.step = "collecting";
        text = answered;
        intent = detectIntent(text);
      }
    }
    await writeCtx(convo.id, ctx);
  }

  // "lego ou carrinho" (09/10, rodada 3): resposta à pergunta de qual, ou pedido novo com alternativa.
  if (ctx.askEither || intent.kind === "free_text") {
    if (await handleAltItem(phone, convo.id, user.cep, ctx, text, user.id)) return;
  }

  // "não, quero o nivea de antes" / "volta o anterior" logo depois de uma troca (09/10, rodada 3): desfaz a troca.
  // Antes virava "Comecei uma lista nova" e o cliente perdia as escolhas.
  if (ctx.lastSwap && intent.kind !== "clear_cart" && isUndoSwapText(text, ctx.lastSwap)) {
    if (await undoLastSwap(phone, convo.id, user.cep, ctx)) return;
  }

  // Cesta ativa + mensagem nova (09/10, rodada 4 — 4ª rodada da mesma família: reclamação, "tbm", "sim, juntar na X",
  // "não, quero o nivea de antes" e resposta a pergunta caíam em "Comecei uma lista nova" e apagavam as escolhas).
  // Regra: o padrão é SOMAR. Só troca a lista com intenção explícita ("nova lista", "começa de novo", "esquece tudo
  // e…", "na verdade quero só…"), com lista que repete e reformula a atual, ou (regra do dono de 09/10) com pedido de
  // produto depois de 10 min parado. Mensagem sem item de produto real (reclamação, demora, pergunta) não mexe na cesta.
  // Resposta a "De qual item você quer um mais em conta?" (10/10, rodada 4 M2): número ou nome de UM item da cesta → troca
  // esse pelo mais barato. Qualquer outra coisa desarma a pergunta e segue o fluxo.
  if (ctx.cheaperAsk) {
    const asked = ctx.cheaperAsk;
    ctx.cheaperAsk = undefined;
    const lines = (ctx.basket ?? []).filter((item) => item.unitPrice > 0);
    if (Date.now() - asked.at < 15 * 60_000 && lines.length && (!ctx.step || ctx.step === "collecting")) {
      const said = normalizeMsg(text)
        .replace(/[!.?]+/g, " ")
        .replace(/\b(mais barat\w*|mais em conta|menor preco)\b/g, " ")
        .replace(/^\s*(?:(?:e|o|a|os|as|do|da|de|no|na|pro|pra|para|quero|queria|pode ser|acho que|um|uma|item|opcao|numero)\s+)*/, "")
        .replace(/\s+/g, " ")
        .trim();
      const digit = /^([1-9])$/.exec(said);
      const named = said && !digit ? lines.filter((item) => itemMatchesPhrase(said, item) || (item.ask ? sharesProductNoun(item.ask, said) : false) || sharesProductNoun(item.name, said)) : [];
      const target = digit ? lines[Number(digit[1]) - 1] : named.length === 1 ? named[0] : undefined;
      if (target) {
        await writeCtx(convo.id, ctx);
        await handleSwap(phone, convo.id, user.cep, ctx, target.name, "um mais barato", text, undefined, target.sku);
        return;
      }
    }
    await writeCtx(convo.id, ctx);
  }

  const basketActive =
    (ctx.basket?.length ?? 0) > 0 &&
    !ctx.deliveryOrderId &&
    // Oferta de juntar aberta: "sim, juntar na X" tem vírgula mas é resposta, não lista (09/10, rodada 3).
    !ctx.consolidationOffer &&
    (!ctx.step || ctx.step === "collecting" || ctx.step === "choosing") &&
    !isQuestion(text);
  const restart = basketActive ? splitRestartCue(text) : null;
  const restartItems = restart?.rest ? resolveListItems(restart.rest).filter((l) => localCatalogProbe(l.phrase).strong) : [];
  if (restart && (restartItems.length || !restart.rest)) {
    console.log("[basket:new-list]", "explicito", JSON.stringify(text.slice(0, 60)), `itens_velhos=${ctx.basket!.length}`);
    await startNewList(phone, convo.id, user.cep, ctx, restart.rest, user.id);
    return;
  }
  if (
    basketActive &&
    intent.kind === "free_text" &&
    // Carrossel aberto e a mensagem começa respondendo a ele (A3, 10/10): quem trata é a escolha (escolhe e soma o resto).
    !(ctx.step === "choosing" && ctx.pending?.length && splitChoiceHeadAndItems(text, ctx.pending[0])) &&
    !explicitAddCue(text) &&
    !ADD_TO_BASKET_RE.test(normalizeMsg(text)) &&
    !EDIT_OR_CHOICE_RE.test(normalizeMsg(text))
  ) {
    // "não, quero o nivea" = recusa + 1 item (a vírgula não separa dois itens).
    const cleaned = text.replace(/^\s*(?:n[aã]o|nao|ah|ai|ei)\s*[,.!]+\s*/i, "");
    const lines = resolveListItems(cleaned);
    const real = lines.filter((l) => localCatalogProbe(l.phrase).strong);
    const repeats = real.map((l) => ({ line: l, hit: repeatedBasketLine(l.phrase, ctx.basket!) })).filter((r) => r.hit);
    const reformulates = real.length >= 2 && repeats.length >= 2 && repeats.length * 2 >= real.length;
    const idleNewMission = real.length > 0 && idleMs >= newMissionAfterMs() && looksLikeNewProductRequest(text);
    if (reformulates || idleNewMission) {
      console.log("[basket:new-list]", reformulates ? "reformula" : "parado", JSON.stringify(text.slice(0, 60)), `itens_velhos=${ctx.basket!.length}`, `parado_ms=${idleMs}`);
      await startNewList(phone, convo.id, user.cep, ctx, text, user.id);
      return;
    }
    // Item repetido (M3): soma na linha que já existe em vez de buscar de novo e abrir outra linha.
    if (repeats.length) {
      const merged = repeats.map(({ line, hit }) => {
        hit!.qty += line.qty;
        hit!.lineTotal = Math.round(hit!.unitPrice * hit!.qty * 100) / 100;
        return { name: hit!.name, qty: hit!.qty, added: line.qty };
      });
      const rest = real.filter((l) => !repeats.some((r) => r.line === l));
      console.log("[basket:repeat-merged]", merged.map((m) => `${m.name}+${m.added}`).join(" | "), `novos=${rest.length}`);
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.repeatedItemMerged(merged));
      if (rest.length) await handleSearch(phone, convo.id, user.cep, ctx, rest.map((l) => `${l.qty} ${l.phrase}`).join(", "), user.id);
      else if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
      return;
    }
    if (lines.length >= 2 && real.length) {
      console.log("[basket:sum]", JSON.stringify(text.slice(0, 60)), `itens_velhos=${ctx.basket!.length}`);
      await reply(phone, copy.summedToBasket(real.map((l) => `${l.qty}x ${l.phrase}`)));
      await handleSearch(phone, convo.id, user.cep, ctx, text, user.id);
      return;
    }
    // Sem item de produto real (reclamação, demora, xingamento): segue o fluxo sem tocar na cesta.
  }

  // "o sabonete pode ser o mais barato" com a lista do formulário montada (09/10): troca pela opção mais barata da
  // vaga (sem nova busca) ou diz que já é. A IA perguntava de volta.
  if (ctx.listFlow?.slots.length && ctx.basket?.length && (!ctx.step || ctx.step === "collecting")) {
    const itemAsk = parseItemCheapest(text);
    const slot = itemAsk ? ctx.listFlow.slots.find((sl) => sharesProductNoun(sl.query, itemAsk)) : undefined;
    const pool = slot ? [...slot.options, ...(slot.extraOptions ?? [])].filter((o) => o.unitPrice > 0) : [];
    if (slot && itemAsk && pool.length) {
      const cheapest = pool.reduce((a, b) => (display(b.unitPrice, b.medicine) < display(a.unitPrice, a.medicine) ? b : a));
      const currentSku = slotCurrentSku(slot, ctx.basket);
      const current = ctx.basket.find((item) => item.sku === currentSku);
      const where = [cheapest.storeLabel, cheapest.delivery ? compactCardDelivery(cheapest.delivery) : ""].filter(Boolean).join(" · ");
      const already = Boolean(current) && display(current!.unitPrice, current!.medicine) <= display(cheapest.unitPrice, cheapest.medicine);
      if (!already) {
        const qty = current?.qty ?? Math.max(1, slot.qty);
        ctx.basket = mergeBaskets(
          ctx.basket.filter((item) => item.sku !== currentSku),
          [choiceToBasketItem(cheapest, qty, cheapest.storeKey ? getStore(cheapest.storeKey) : orderStore(ctx), slot.query)]
        );
        ctx.listFlow = {
          ...ctx.listFlow,
          slots: ctx.listFlow.slots.map((sl) => (sl === slot ? { ...sl, suggestedSku: cheapest.sku } : sl)),
          basketSig: basketSignature(ctx.basket)
        };
        await writeCtx(convo.id, ctx);
      }
      const shown = already && current ? current : cheapest;
      await reply(phone, copy.itemCheapestAnswer({ item: slot.query, name: shown.name, price: display(shown.unitPrice, shown.medicine), where, already }));
      return;
    }
  }

  // "a ração tem que ser de 3kg" com a cesta montada (09/10): troca aquele item por opções do tamanho pedido (só o
  // tamanho, ±10%); sem nenhuma, o item fica e a Lia avisa.
  if (ctx.basket?.length && (!ctx.step || ctx.step === "collecting")) {
    const sized = parseItemSize(text);
    const slot = sized ? ctx.listFlow?.slots.find((sl) => sharesProductNoun(sl.query, sized.item)) : undefined;
    const target = sized
      ? (slot ? ctx.basket.find((b) => b.sku === slotCurrentSku(slot, ctx.basket!)) : undefined) ??
        ctx.basket.find((b) => (b.ask && sharesProductNoun(b.ask, sized.item)) || itemMatchesPhrase(sized.item, b))
      : undefined;
    if (sized && target && measureOf(target.name) !== measureOf(sized.size)) {
      const base = (slot?.query ?? target.ask ?? sized.item).replace(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|ml|l|litros?)\b/gi, " ").replace(/\s+/g, " ").trim();
      await handleSwap(phone, convo.id, user.cep, ctx, target.name, `${base} ${sized.size}`, text, undefined, target.sku);
      return;
    }
  }

  // "pode ser o mais baratinho" com as opções na tela (09/10, rodada 2): escolhe a mais barata; empate de preço = a
  // primeira (melhor relevância) e a Lia diz que estavam empatadas, em vez de perguntar "a 1 ou a 5?".
  if (ctx.step === "choosing" && ctx.pending?.[0]?.options.length && intent.kind === "free_text" && CHEAPEST_PICK_RE.test(normalizeMsg(text))) {
    const current = ctx.pending[0];
    const { index, tied } = cheapestWithTies(current.options);
    const store = getStore(current.options[0]?.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
    const o = current.options[index];
    await confirmChosenOption(phone, convo.id, ctx, user.cep, store, current, o, tied.length > 1 ? { note: copy.cheapestTieNote(tied.map((i) => i + 1), display(o.unitPrice, o.medicine), index + 1) } : undefined);
    return;
  }

  // "troca a ração por outra marca" com a cesta montada: determinístico, antes da IA (que pedia "qual marca?").
  if (intent.kind === "swap_item" && ctx.basket?.length && (!ctx.step || ctx.step === "collecting") && OTHER_BRAND_RE.test(normalizeMsg(intent.to))) {
    await handleSwap(phone, convo.id, user.cep, ctx, intent.from, intent.to, text);
    return;
  }

  // Escolha aberta + reconhecimento seco ("👍", "ok", "blz", "obrigado", "valeu") — 09/10, rodada 2: "👍" virava
  // "Não peguei qual você quer" (8,6 s de IA) e "obrigado" soava como encerramento. Resposta curta que lembra o item
  // pendente, sem IA, sem repetir o lembrete em falas seguidas.
  if (
    ctx.step === "choosing" &&
    ctx.pending?.[0]?.options.length &&
    !(ctx.minSwap || ctx.repeatConfirm || ctx.planB || ctx.mergeDecision || ctx.longTailOffer || ctx.cepSwap || ctx.cepCityCheck || ctx.cancelReason || ctx.withdrawConfirm || ctx.packConfirm)
  ) {
    const ack = neutralAck(text);
    if (ack) {
      await reply(phone, copy.choiceAck(ctx.pending[0].baseQuery ?? ctx.pending[0].query, ack === "thanks", choicesNudgeAllowed(), turnMeta.getStore()?.prevSent ?? []));
      return;
    }
  }

  // Pergunta sobre o PRODUTO com as opções na tela (09/10, rodada 2): "essa ração serve pra filhote?", "é original?",
  // "qual a validade?", "qual a diferença entre o 1 e o 2?", "não sei o que é o dois". Respondida em código com o nome/
  // preço/loja das opções (e diz com honestidade o que não dá pra saber), sem perder a escolha aberta.
  if (
    ctx.step === "choosing" &&
    ctx.pending?.[0]?.options.length &&
    intent.kind === "free_text" &&
    !(ctx.minSwap || ctx.repeatConfirm || ctx.planB || ctx.mergeDecision || ctx.longTailOffer || ctx.cepSwap || ctx.cepCityCheck || ctx.cancelReason || ctx.withdrawConfirm || ctx.packConfirm)
  ) {
    const current = ctx.pending[0];
    const shown = current.options.map((o) => ({ name: o.name, price: display(o.unitPrice, o.medicine), storeLabel: o.storeLabel }));
    const pq = parseProductQuestion(text, shown.length);
    if (pq && !(pq.kind === "dietary" && !isPetFood(shown))) {
      const answer = answerProductQuestion(pq, shown, current.baseQuery ?? current.query);
      await reply(phone, choicesNudgeAllowed() ? `${answer}\n\n${copy.choicesStillOpen(current.query)}` : answer);
      return;
    }
  }

  // ---- gerente de diálogo (LIA_DIALOGUE_LLM=true, Fase 2 do plano-conversa-100): a IA lê a mensagem + o
  // estado e escolhe uma ação de lista fechada ANTES do roteamento por regex. Inequívoco/barato (número,
  // CEP, botões, pix/cartão, cadastro) segue determinístico; IA fora do ar ou ação inválida = caminho de hoje.
  if (dialogueEnabled() && !turnMeta.getStore()?.skipDialogue) {
    const hasAddress = Boolean(user.defaultAddress && savedCep);
    const dialogue = hasAddress
      ? await runDialogueTurn({
          phone,
          convoId: convo.id,
          userId: user.id,
          userCep: user.cep,
          text,
          intent,
          ctx,
          hasAddress,
          looksLikeList: looksLikeProductList(text),
          handlers: dialogueHandlers
        })
      : // Antes do cadastro (rodada 2 do plano 100): a IA extrai itens/orçamento/perguntas; o endereço segue determinístico.
        await runPreSignupTurn({
          phone,
          convoId: convo.id,
          userId: user.id,
          text,
          intent,
          ctx,
          hasAddress,
          lastLiaText: turnMeta.getStore()?.prevSent?.slice(-1)[0],
          addressLike:
            looksLikeDeliveryAddress(text) ||
            Boolean(extractCep(text)) ||
            Boolean(extractCpf(text)) ||
            looksLikeCpfAttempt(text) ||
            looksLikePersonName(text) ||
            Boolean(ctx.cepPlace?.street && parseHouseNumberReply(text, { ...ctx.cepPlace, city: ctx.city })),
          handlers: preSignupHandlers
        });
    if (dialogue?.kind === "handled") return;
    if (dialogue?.kind === "rewrite") {
      text = dialogue.text;
      intent = detectIntent(text);
    }
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
      const noted = notedForCopy(ctx);
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
      // "oi" com a escolha aberta lembra a lista que está esperando (06/10).
      if (ctx.step === "choosing" && ctx.pending?.length) {
        await sendChoices(phone, ctx.pending[0], copy.greetingMidChoice(ctx.pending[0].query));
        return;
      }
      // "oi" no meio de um pedido em andamento não reapresenta a Lia do zero.
      await reply(phone, copy.greetingMidOrder(ctx.step ?? "collecting", ctx.basket?.length ?? 0));
      // Total na mesa (06/10): o "oi" reapresenta as formas de pagamento.
      if (ctx.step === "awaiting_quote_confirmation") await replyChargeNotIssuedButtons(phone, user.id, ctx);
    } else if (ctx.step === "choosing_freight" && ctx.freightChoice) {
      // "bom dia" na escolha da entrega (06/10) esquecia o pedido pendente.
      await reply(phone, copy.greetingMidOrder("choosing_freight", 0));
      await sendFreightChoice(phone, ctx.freightChoice);
    } else {
      await reply(phone, copy.greeting());
    }
    return;
  }

  // "Vocês entregam hoje?" (09/10, rodada 3): resposta direta (Sim / Não / Depende da loja) com o prazo real que
  // a Lia já tem. Com opções na tela, o bloco de prazos das opções logo abaixo responde.
  if (
    asksDeliveryToday(text) &&
    (intent.kind === "status" || intent.kind === "service_question" || intent.kind === "free_text") &&
    !(ctx.step === "choosing" && ctx.pending?.[0]?.options.length)
  ) {
    const current = await currentOrderForQuestions(user.id, ctx);
    const paid = current && PAID_OR_IN_FULFILLMENT_STATUSES.includes(current.status);
    if (!paid) {
      if (current && ctx.deliveryOrderId && current.status === "awaiting_quote_confirmation") {
        const fulfillments = (Array.isArray(current.fulfillments) ? current.fulfillments : []) as Array<{ deliveryPromise?: string }>;
        await reply(phone, copy.todayOnOrder(fulfillments.map((f) => f?.deliveryPromise ?? ""), orderDeliveryInfoLine(current)));
        await replyChargeNotIssuedButtons(phone, user.id, ctx);
        return;
      }
      if ((ctx.basket?.length ?? 0) > 0 && !ctx.deliveryOrderId) {
        await answerBasketEta(phone, convo.id, ctx, user.cep, true);
        return;
      }
      if (!ctx.deliveryOrderId) {
        await reply(phone, copy.todayUnknown());
        return;
      }
    }
  }

  // Prazo com a lista montada e sem pedido ainda (09/10): responde com o prazo de cada loja (ou fecha o total,
  // que traz o prazo). Antes: "quanto tempo demora" → texto genérico; "em quanto tempo chega" → busca.
  if (
    (ctx.basket?.length ?? 0) > 0 &&
    !ctx.deliveryOrderId &&
    !(ctx.step === "choosing" && parseChoiceEtaAsk(text)?.option) &&
    (intent.kind === "status" || intent.kind === "service_question" || intent.kind === "free_text") &&
    isBasketEtaAsk(text)
  ) {
    await answerBasketEta(phone, convo.id, ctx, user.cep);
    return;
  }

  // "chega hoje?"/"o 2 chega hoje?" com as opções na tela (06/10): os prazos das opções. Virava
  // status ("falta você escolher…") com o prazo de cada loja já na mão.
  if (ctx.step === "choosing" && ctx.pending?.length && (intent.kind === "status" || intent.kind === "service_question" || intent.kind === "free_text")) {
    const etaAsk = parseChoiceEtaAsk(text);
    if (etaAsk) {
      const options = ctx.pending[0].options;
      const rows = options
        .map((o, i) => ({
          n: i + 1,
          name: o.name,
          delivery: optionDelivery(o),
          // O texto da loja manda ("hoje", "60 min", "2 horas"); sem ele, o prazo em minutos.
          today: o.delivery ? /\bhoje\b|\bmin\b|\bhoras?\b/i.test(o.delivery) : o.etaMinutes != null && o.etaMinutes < sameDayMaxMinutes()
        }))
        .map((row, i) => ({ ...row, delivery: options[i].delivery ? row.delivery : undefined }))
        .filter((row) => !etaAsk.option || row.n === etaAsk.option);
      if (rows.length) {
        await reply(phone, copy.choiceEtaAnswer(rows, etaAsk.today));
        return;
      }
    }
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
    // "quanto fica o frete?" com opções ou cesta (06/10): a Lia já tem o frete ao vivo de
    // cada loja — responde com o número, não com "depende da distância".
    if (intent.topic === "fee") {
      const fees = knownStoreFees(ctx);
      if (fees.length) {
        await reply(phone, copy.feeByStore(fees));
        return;
      }
    }
    if (intent.topic === "stores") {
      const onTable = ctx.step === "choosing" && ctx.pending?.length ? ctx.pending[0].options : [];
      // "o pedido é de qual loja?" sem opções na tela (06/10): a loja do pedido em andamento.
      if (!onTable.length) {
        const current = await currentOrderForQuestions(user.id, ctx);
        const stores = current ? orderStoresOf(current) : [];
        if (current && stores.length) {
          await reply(phone, copy.orderStoreAnswer(current.id.slice(-6).toUpperCase(), stores));
          return;
        }
      }
      await reply(phone, copy.storesAnswer(onTable.map((o) => ({ storeLabel: o.storeLabel }))));
      return;
    }
    // "qual o prazo de entrega?" com pedido pago ou escolha de entrega na tela (06/10): o prazo
    // DO PEDIDO, não a explicação genérica.
    // "quanto fica o frete?" na escolha de entrega (06/10): o frete está na tela — reapresenta.
    if (intent.topic === "fee" && ctx.step === "choosing_freight" && ctx.freightChoice) {
      await sendFreightChoice(phone, ctx.freightChoice);
      return;
    }
    if (intent.topic === "eta") {
      if (ctx.step === "choosing_freight" && ctx.freightChoice) {
        await reply(phone, copy.freightEtaHeader());
        await sendFreightChoice(phone, ctx.freightChoice);
        return;
      }
      const current = await currentOrderForQuestions(user.id, ctx);
      if (current && (PAID_OR_IN_FULFILLMENT_STATUSES.includes(current.status) || current.status === "awaiting_quote_confirmation" || current.status === "awaiting_payment")) {
        await handleStatus(phone, user.id, ctx, text, convo.id);
        return;
      }
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
  // "Chamei alguém da equipe" sem avisar ninguém (06/10): a nota no pedido só aparecia no
  // /ops, e cliente sem pedido nem nota tinha. Agora o dono recebe no WhatsApp.
  if (intent.kind === "human") {
    const { notify, repeat } = enterAttendance(ctx, "human");
    if (notify) {
      await flagLatestOrder(user.id, `🙋 CLIENTE PEDIU ATENDIMENTO HUMANO: "${text.slice(0, 140)}"`);
      await notifyOwner(`🙋 Cliente pediu atendimento humano: "${text.slice(0, 200)}" — responder no WhatsApp dele.`, phone);
    }
    const answer = repeat ? nextAttendanceAck(ctx) : copy.humanHandoff(withinOperatorHours());
    await writeCtx(convo.id, ctx);
    await reply(phone, answer);
    return;
  }
  // "faltou o café" com a cesta em montagem e nenhum pedido pago/entregue (09/10, rodada 2): é item esquecido, não
  // reclamação (que chamava o responsável). Com pedido pago/entregue continua reclamação.
  if (
    intent.kind === "complaint" &&
    isMissingItemOnlyComplaint(text) &&
    ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0) &&
    !ctx.deliveryOrderId &&
    !(await prisma.deliveryOrder.findFirst({ where: { userId: user.id, status: { in: [...PAID_OR_IN_FULFILLMENT_STATUSES, "delivered"] } }, select: { id: true } }))
  ) {
    intent = { kind: "free_text" };
  }
  // Recomendação (08/10): pedido vago ("quero algo doce") e sintoma que o regex lê como reclamação
  // ("tô com uma dor de cabeça horrível") viram recomendação. Com endereço e CEP, a busca de sempre
  // (handleSearch: reabre cotação, depois reconhece a recomendação); sem eles, o onboarding abaixo
  // guarda a frase inteira e pede o CEP.
  const socialRec =
    recommendEnabled() && (intent.kind === "vague_request" || intent.kind === "want_items" || intent.kind === "complaint")
      ? detectRecommendation(text, { hasPendingChoice: Boolean(ctx.pending?.length), basketNames: ctx.basket?.map((b) => b.name) })
      : null;
  const recommendNow = socialRec && (intent.kind !== "complaint" || socialRec.symptom) ? socialRec : null;
  if (recommendNow && user.defaultAddress && savedCep) {
    await handleSearch(phone, convo.id, user.cep, ctx, text, user.id);
    return;
  }
  if (intent.kind === "complaint" && !recommendNow) {
    await flagLatestOrder(user.id, `⚠️ RECLAMAÇÃO DO CLIENTE: "${text.slice(0, 140)}"`);
    const { notify, repeat } = enterAttendance(ctx, "complaint");
    if (notify) await notifyOwner(`⚠️ Reclamação de cliente: "${text.slice(0, 200)}" — responder no WhatsApp dele.`, phone);
    const hasOrder = Boolean(await prisma.deliveryOrder.findFirst({ where: { userId: user.id }, select: { id: true } }));
    const answer = repeat ? nextAttendanceAck(ctx) : copy.complaintAck(hasOrder, withinOperatorHours());
    await writeCtx(convo.id, ctx);
    await reply(phone, answer);
    return;
  }
  // "quero meu dinheiro de volta"/"quero o estorno" (06/10): pedido pago e ainda não comprado
  // = desistência (o mesmo "confirma?" do cancelar); sem pagamento, diz que nada foi cobrado.
  if (intent.kind === "refund_request") {
    await handleRefundRequest(phone, convo.id, user.id, ctx, text);
    return;
  }

  // ---- perguntas de confiança/logística: respondem em QUALQUER estado (28/08) ----
  // Depois de responder, a ETAPA em curso é reapresentada — a pergunta lateral fazia
  // os cards "sumirem" e o cliente tinha que pedir de novo (29/08 S7/S12).
  const rePresentStep = async () => {
    if (ctx.step === "choosing" && ctx.pending?.length && choicesNudgeAllowed()) {
      await reply(phone, copy.choicesStillOpen(ctx.pending[0].query));
    }
  };
  if (intent.kind === "trust_question") {
    await reply(phone, copy.trustAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "identity") {
    await reply(phone, copy.identityAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "out_of_scope_service") {
    await reply(phone, copy.outOfScopeServiceAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "vague_request" && !recommendNow) {
    await reply(phone, copy.vagueRequestAnswer());
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
    // CNPJ sem a env (07/10, c13): o dono é avisado e entra o modo atendimento — a 2ª pergunta não
    // repete o mesmo texto nem avisa o dono de novo.
    if (intent.topic === "cnpj" && !businessInfo) {
      const { notify, repeat } = enterAttendance(ctx, "invoice");
      if (notify) await notifyOwner(`📇 Cliente pediu o CNPJ/dados da empresa — enviar manualmente (configure LIA_BUSINESS_INFO).`, phone);
      const answer = repeat ? nextAttendanceAck(ctx) : copy.fiscalAnswer("cnpj", businessInfo, withinOperatorHours());
      await writeCtx(convo.id, ctx);
      await reply(phone, answer);
      await rePresentStep();
      return;
    }
    await reply(phone, copy.fiscalAnswer(intent.topic, businessInfo, undefined, medicineEnabled()));
    // "me fala que eu te envio" não pode ser beco: sem a env, o operador é acionado
    // pra mandar os dados de verdade (29/08 S7).
    if (intent.topic === "nf") {
      await notifyOwner(`🧾 Cliente perguntou da nota fiscal: "${text.slice(0, 160)}" — se pedir cópia, enviar.`, phone);
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
  // "dinheiro"/"vale refeição" (06/10) viravam busca de produto.
  if (intent.kind === "unsupported_payment") {
    await reply(phone, copy.unsupportedPayment());
    await rePresentStep();
    return;
  }
  if (intent.kind === "meta_probe") {
    await reply(phone, copy.metaProbeAnswer());
    await rePresentStep();
    return;
  }
  if (intent.kind === "insult") {
    await reply(phone, isAngerSwear(normalizeMsg(text)) ? copy.angerApology() : copy.insultAnswer());
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
      await reply(phone, `${copy.resumeHeader()}\n${copy.partialTotal(items, produtos, ctx.pending?.length ?? 0, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx))}`);
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
      // Escolha da entrega ou total na mesa, sem cobrança ainda (06/10): "manda o pix de novo"
      // respondia "Você ainda não tem pedidos".
      if (await replyChargeNotIssued(phone, user.id, ctx)) return;
      if (intent.kind === "resend_code" && intent.keyAsk) {
        await reply(phone, copy.pixKeyNoCharge());
        return;
      }
      await reply(phone, (ctx.basket?.length ?? 0) > 0 ? copy.finishOrderFirst() : copy.noOrdersYet());
      return;
    }
    // Ensaio da compra (08/10 noite): antes de reemitir/reenviar, a loja é consultada de novo — a cobrança
    // só volta pro cliente se a compra ainda consegue fechar; senão a lista volta e a Lia recota.
    if (await guardOpenCharge(phone, convo.id, user, ctx, order)) return;
    if (intent.kind === "resend_code" && intent.keyAsk) {
      // "qual a chave pix?" (06/10): explica o copia-e-cola e reenvia o mesmo código.
      if (!isCardCharge(order)) await reply(phone, copy.pixKeyExplain());
      await resendCharge(phone, order);
      return;
    }
    if (intent.kind === "switch_payment") {
      // "quero mudar a forma de pagamento" sem dizer qual → oferece as duas de novo.
      const method = isCardCharge(order) ? "pix" : "card";
      await switchPaymentMethod(phone, order, method);
    } else if (intent.expired) {
      // Pix expirado: reemitir uma cobrança NOVA em vez de reenviar o código morto.
      await switchPaymentMethod(phone, order, isCardCharge(order) ? "card" : "pix", { renewed: true });
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
    await handleStatus(phone, user.id, ctx, text, convo.id);
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
  // Botões do pedido mínimo (09/10): tirar o item que não atinge o mínimo (e seguir com o resto) ou completar na loja.
  if (/^minimo:(tirar|completar)$/.test(normalizeMsg(text))) {
    const stuckStore = conciergeStoresBelowMinimum(ctx)[0];
    if (!stuckStore) {
      await reply(phone, copy.didNotUnderstand());
      return;
    }
    if (normalizeMsg(text) === "minimo:completar") {
      const produtos = (ctx.basket ?? []).filter((item) => item.storeKey === stuckStore.key).reduce((sum, item) => sum + display(item.unitPrice, item.medicine) * item.qty, 0);
      const falta = Math.max(0, Math.round((display(storeMinReal(stuckStore)) - produtos) * 100) / 100);
      await reply(phone, `Manda o nome de um item da ${stuckStore.label} que eu somo (faltam ${copy.brl(falta)}).`);
      return;
    }
    const removed = (ctx.basket ?? []).filter((item) => item.storeKey === stuckStore.key);
    ctx.basket = (ctx.basket ?? []).filter((item) => item.storeKey !== stuckStore.key);
    if (!ctx.basket.length) {
      await writeCtx(convo.id, addressOnlyCtx(ctx, user.cep));
      await reply(phone, copy.cartCleared());
      return;
    }
    await writeCtx(convo.id, ctx);
    await continueAfterBasket(phone, convo.id, ctx, user.cep, `Tirei ${removed.map((item) => item.name).join(", ")}. Sigo com o resto.`);
    return;
  }

  // Resposta à oferta de juntar numa loja só (09/10). Cesta mudou desde a oferta → ela morre. Outra
  // mensagem qualquer segue o fluxo normal (a oferta sai da mesa e não volta pra mesma cesta).
  if (ctx.consolidationOffer) {
    const offer = ctx.consolidationOffer;
    const key = (ctx.basket ?? []).map((i) => `${i.sku}x${i.qty}`).sort().join("|");
    const said = normalizeMsg(text);
    // "ok"/"blz" solto não escolhe entre duas opções (09/10, rodada 2): pergunta de novo, uma vez. "sim/pode/quero" aceita.
    const vagueOk = intent.kind === "affirm" && /^(ok|okay|okey|blz|beleza|certo|tudo bem|fechou|vai|show)\b[\s!.]*$/.test(said);
    const join = said === "consolidar:sim" || isJoinReply(said) || (intent.kind === "affirm" && !vagueOk && !/mant/.test(said));
    // Recusa com outras palavras também é manter (10/10, rodada 4 A1: "prefiro deixar separado", "não, deixa como está").
    const keep = said === "consolidar:nao" || /^(pode )?(mante(r|m|nha)|deixa(r)?( como (esta|ta))?|separad[oa]s?|nao junta)/.test(said) || isKeepSeparateReply(text);
    if (vagueOk && offer.key === key && !keep) {
      await reply(phone, copy.consolidationAsk());
      return;
    }
    ctx.consolidationOffer = undefined;
    if (offer.key === key && (join || keep)) {
      if (join) {
        ctx.basket = offer.basket;
        ctx.minSwap = undefined;
        ctx.consolidationTried = offer.basket.map((i) => `${i.sku}x${i.qty}`).sort().join("|");
      }
      await writeCtx(convo.id, ctx);
      await continueAfterBasket(phone, convo.id, ctx, user.cep, join ? copy.basketConsolidated(offer.storeLabel, offer.pairs, offer.delta, offer.joinedTotal != null && offer.keptTotal != null ? { saved: roundMoney(offer.keptTotal - offer.joinedTotal), eta: humanEstimate(offer.joinedEta) } : undefined) : copy.consolidationKept(offer.stores));
      return;
    }
    await writeCtx(convo.id, ctx);
  }

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
      choiceToBasketItem(r.option, r.qty, r.option.storeKey ? getStore(r.option.storeKey) : orderStore(ctx), basket.find((b) => b.sku === r.fromSku)?.ask)
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
      await reply(phone, copy.partialTotal(basketForCopy(ctx), produtos, ctx.pending?.length ?? 0, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx)));
      return;
    }
    await reply(phone, copy.didNotUnderstand());
    return;
  }

  // "Vc salvou o endereço?": confirma o que está em arquivo — nunca vira busca.
  if (intent.kind === "address_question") {
    // "pra qual endereço vai?" (06/10): com pedido pago, o endereço DO PEDIDO.
    if (intent.order) {
      const current = await currentOrderForQuestions(user.id, ctx);
      if (current?.deliveryAddress) {
        await reply(phone, copy.orderAddressAnswer(current.id.slice(-6).toUpperCase(), current.deliveryAddress));
        return;
      }
      const saved = ctx.deliveryAddress ?? user.defaultAddress;
      if (saved) {
        await reply(phone, copy.savedAddressAnswer(saved, ctx.cep ?? user.cep ?? undefined));
        return;
      }
    }
    const saved = ctx.deliveryAddress ?? user.defaultAddress;
    if (saved) {
      await reply(phone, copy.addressUpdated(saved, ctx.cep ?? user.cep ?? undefined));
    } else {
      await askStreetAndNumber(phone, ctx);
    }
    return;
  }

  if (intent.kind === "change_address") {
    // Pedido PAGO a caminho (06/10, A4): dizia "Endereço atualizado" e o pedido seguia pro
    // endereço antigo. Avisa o destino do pedido pago, grava nota pro dono e segue a troca —
    // o endereço novo vale para os próximos pedidos.
    if (ctx.step !== "awaiting_payment" && ctx.step !== "payment_issuing") {
      const paid = await latestPaidOrder(user.id);
      if (paid && paid.deliveryAddress && !isOrderOutForDelivery(paid.status)) {
        await prisma.deliveryOrder.update({
          where: { id: paid.id },
          data: { notes: appendOrderNote(paid.notes, `📍 Cliente pediu pra trocar o endereço DEPOIS de pagar ("${text.slice(0, 120)}") — este pedido segue para o endereço original; o novo vale para os próximos.`) }
        });
        await reply(phone, copy.paidOrderAddressKept(paid.id.slice(-6).toUpperCase(), paid.deliveryAddress));
      }
    }
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
    // "trocar endereço — Rua Oscar Freire, 379, apto 12, 01426-001": o endereço já veio junto
    // (placar c16) — usa-o em vez de pedir de novo.
    const embedded = text
      // "muda o endereço pro trabalho: Rua X..." (09/10, rodada 3): "muda/troca" e o apelido do lugar também saem.
      .replace(/^.*?\b(?:trocar|troca|mudar|muda|alterar|altera|atualizar|atualiza|novo)\s+(?:o\s+|meu\s+)*endere[cç]o\b(?:\s+(?:pro|pra|para|do|da|de)\s+(?:meu\s+|minha\s+|o\s+|a\s+)?[a-zà-ú]+)?[\s:—–\-,.]*/i, "")
      .trim();
    if (embedded.length > 8 && (extractCep(embedded) || looksLikeDeliveryAddress(embedded))) {
      // Com CEP novo na mensagem, o fluxo do CEP roda primeiro (senão o endereço novo era gravado com o
      // CEP ANTIGO — placar rodada 2, c16).
      const typed = detectIntent(embedded);
      const typedCep = extractCep(embedded);
      if (typed.kind === "cep") await handleNewCep(phone, user.id, convo.id, ctx, typed.cep, Boolean(savedCep), typed.rest, embedded);
      // O CEP escrito no meio do endereço também vale (antes o endereço era salvo sem CEP e a Lia pedia "o CEP").
      else if (typedCep) await handleNewCep(phone, user.id, convo.id, ctx, typedCep, Boolean(savedCep), undefined, embedded);
      else await handleDeliveryAddress(phone, user.id, convo.id, ctx, null, embedded);
      return;
    }
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
      const { lines, containsMedicine, prescriptionDropped } = await extractLines(text);
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
          if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
          notes.push(copy.addedToPendingQuote(addedLabels));
          await replyQuoteNotice(phone, notes.join("\n"));
          await notifyOperator(copy.operatorItemAddedAlert(order.id.slice(-6).toUpperCase(), addedLabels), phone);
          return;
        }
      }
      // A mensagem era SÓ remédio (a extração filtra): responde a recusa certa em vez
      // de fingir que está cotando algo que não pode vender.
      if (!lines.length && containsMedicine) {
        await reply(phone, noMedicineCopy(text));
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
        if (issued.pixOutDown) {
          await reply(phone, copy.purchaseTemporarilyDown());
          return;
        }
        if (issued.unavailable) {
          await handlePreflightUnavailable(phone, convo.id, user, ctx, issued.unavailable);
          return;
        }
        if (issued.deliveryNotConfirmed) {
          await handleDeliveryNotConfirmed(phone, convo.id, user, ctx, issued.deliveryNotConfirmed);
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
          // Quantidade, troca de opção e "voltar" também editam a cesta (06/10).
          intent.kind === "qty_adjust" ||
          intent.kind === "switch_choice" ||
          intent.kind === "back" ||
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

  // ---- nome + CPF fora da hora (06/10): "Teste Silva 529…" no meio da escolha virava busca
  // ("não achei *Teste Silva 529…*"). Guarda no cadastro e devolve a conversa onde estava.
  if (ctx.step !== "need_cpf" && !ctx.cpfDraft) {
    const strayCpf = extractCpf(text);
    const strayName = strayCpf ? extractFullName(text) : null;
    if (strayCpf && strayName) {
      await prisma.user.update({ where: { id: user.id }, data: { cpf: strayCpf, cpfName: strayName, cpfConsentAt: new Date() } });
      if (ctx.step === "choosing" && ctx.pending?.length) {
        await reply(phone, copy.cpfSaved(maskCpf(strayCpf)));
        await sendChoices(phone, ctx.pending[0]);
      } else {
        await reply(phone, ctx.basket?.length ? copy.cpfSaved(maskCpf(strayCpf)) : copy.cpfSavedAskItems());
      }
      return;
    }
  }

  // ---- remédio isento (29/09): nome completo + CPF para a compra sair no nome do cliente ----
  // Vem ANTES do CEP: um CPF nunca pode ser lido como CEP. "sem remédio" tira o remédio da
  // cesta e fecha o resto.
  // Cadastro (06/10): "pra que cpf?" tem resposta fixa e a pergunta continua; "não quero dar"
  // segue sem CPF; nome sozinho fica guardado e a Lia pede só o CPF (antes o nome se perdia e
  // o CPF da mensagem seguinte virava busca de produto).
  if (ctx.step === "need_cpf" && ctx.cpfOnboarding && !ctx.cpfDraft?.cpf && !looksLikeCpfAttempt(text)) {
    const n = normalizeMsg(text);
    if (/\b(pra|para|por)\s*(que|q)\b.*\bcpf\b|\bcpf\b.*\b(pra|para)\s*(que|q)\b|\bprecisa\s+(do|de|mesmo\s+do)\s+cpf\b|\bporque\b.*\bcpf\b/.test(n)) {
      await reply(phone, copy.whyCpf());
      return;
    }
    if (looksLikeOnboardingName(text)) {
      ctx.cpfDraft = { name: extractFullName(text)! };
      await writeCtx(convo.id, ctx);
      await reply(phone, copy.askCpfAfterName());
      return;
    }
    if (/\b(nao|n)\s+(quero|vou)\s+(dar|passar|informar|mandar)\b|\bsem\s+cpf\b|\bprefiro\s+nao\b|\bpula(r)?\b/.test(n)) {
      delete ctx.cpfOnboarding;
      ctx.cpfRequired = undefined; // recusa explícita do cliente vale
      ctx.step = "collecting";
      const queued = ctx.pendingRequest;
      ctx.pendingRequest = undefined;
      await writeCtx(convo.id, ctx);
      if (queued || ctx.pendingRecommend) {
        await reply(phone, copy.cpfSkipped(true));
        await runQueuedRequest(phone, convo.id, user.cep, ctx, queued, user.id);
      } else {
        await reply(phone, copy.cpfSkipped(false));
      }
      return;
    }
  }
  if (ctx.step === "need_cpf" && ctx.cpfOnboarding && !ctx.cpfDraft?.cpf && !looksLikeCpfAttempt(text)) {
    // Cadastro: sem CPF na mensagem, a pergunta não segura o cliente — o que ele mandou
    // segue como mensagem normal (o CPF volta a ser pedido só no 1º remédio).
    delete ctx.cpfOnboarding;
    delete ctx.cpfDraft;
    ctx.step = "collecting";
    const queued = ctx.pendingRequest;
    ctx.pendingRequest = undefined;
    await writeCtx(convo.id, ctx);
    if (queued) {
      await runQueuedRequest(phone, convo.id, user.cep, ctx, intent.kind === "free_text" ? `${queued}, ${text}` : queued, user.id);
      return;
    }
    if (ctx.pendingRecommend && intent.kind !== "free_text") {
      await runQueuedRequest(phone, convo.id, user.cep, ctx, undefined, user.id);
      return;
    }
    // Mensagem nova com uma recomendação guardada: a mensagem nova manda (a guardada sai).
    delete ctx.pendingRecommend;
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
      await reply(phone, looksLikeCpfAttempt(text) ? copy.cpfInvalid() : ctx.cpfRequired ? copy.askCpfBeforeQuote() : copy.askCpfForMedicine());
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
    ctx.cpfRequired = undefined;
    ctx.step = "collecting";
    if (ctx.cpfOnboarding) {
      // Cadastro: segue para o pedido guardado no onboarding, ou pergunta o que ele quer.
      delete ctx.cpfOnboarding;
      const queued = ctx.pendingRequest;
      ctx.pendingRequest = undefined;
      await writeCtx(convo.id, ctx);
      if (queued || ctx.pendingRecommend) {
        await reply(phone, copy.cpfSaved(maskCpf(cpf)));
        await runQueuedRequest(phone, convo.id, user.cep, ctx, queued, user.id);
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
    if (intent.kind === "free_text" && isWaitGripe(text) && !looksLikeDeliveryAddress(text)) {
      await reply(phone, copy.waitApology());
      return;
    }
    // "pagar"/"pix"/"só isso" com o endereço incompleto (09/10, rodada 1): diz o que falta em vez de repetir a pergunta ou mandar "👍".
    if (["pay", "choose_payment", "done"].includes(intent.kind) && !ctx.deliveryAddressVerified) {
      const place = ctx.cepPlace;
      await reply(phone, copy.payNeedsAddressNumber(place?.street, place?.district));
      return;
    }
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
    if (isWaitGripe(text)) {
      await reply(phone, copy.waitApology());
      return;
    }
    if (looksLikeDeliveryAddress(text)) {
      await handleDeliveryAddress(phone, user.id, convo.id, ctx, user.cep, text);
      return;
    }
    // Acabou de ouvir "ainda não chego em X" (06/10, M9): lembra o motivo e mostra a saída
    // (endereço de alguém na área); o produto pedido fica anotado pra depois.
    if (ctx.outsideArea) {
      const note = isQuestion(text) ? "" : onboardingNote(text).text;
      if (note) addPendingRequest(ctx, note);
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
      // 06/10: "pix"/"cartão"/"pagar", "o frete tá caro" e "chega que horas?" caíam no
      // "Não peguei qual você quer". A entrega vem antes do pagamento — nada é escolhido sozinho.
      const asksPay = intent.kind === "choose_payment" || intent.kind === "pay" || intent.kind === "done";
      const asksFee = /\b(frete|taxa|caro|cara|entrega)\b/.test(n) && !/\b(prazo|demora|quando|horas?|chega)\b/.test(n);
      const asksEta = /\b(prazo|demora\w*|quando|horas?|chega\w*|tempo)\b/.test(n);
      await reply(phone, asksPay ? copy.freightBeforePayment() : asksFee ? copy.freightFeeExplain() : asksEta ? copy.freightEtaHeader() : copy.choiceNotUnderstood());
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
    if (intent.kind === "free_text" && isWaitGripe(text)) {
      await reply(phone, copy.waitApology());
      return;
    }
    if (refusesWholeMessage(text)) {
      await refuseMedicine(phone, convo.id, ctx, text);
      return;
    }
    if (intent.kind === "reject") {
      await writeCtx(convo.id, addressOnlyCtx(ctx, null));
      await reply(phone, copy.thanks());
      return;
    }
    // "tem açaí?" e "quanto tá o leite ninho?" são pedido em forma de pergunta: anota o item
    // (06/10, sumiam depois do endereço).
    const availability = intent.kind === "free_text" ? parseAvailabilityAsk(text) : null;
    if (availability) text = availability;
    const priceAsk = !availability && intent.kind === "free_text" ? parsePriceAsk(text) : null;
    // Pedido de recomendação (08/10): a frase INTEIRA fica guardada até o CEP ("qual o melhor
    // chocolate?" não é pergunta do serviço; "tô com fome, quero algo doce" não vira "1x tô com fome").
    const recNote = onboardingRecommendation(text, intent);
    const asking = !recNote && !availability && !priceAsk && intent.kind === "free_text" && isQuestion(text);
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
    const note = !recNote && intent.kind === "free_text" ? onboardingNote(priceAsk ?? text).text : "";
    if (recNote) ctx.pendingRecommend = recNote.text;
    // Despedida depois da recusa de remédio ("vou procurar uma farmácia, obrigada"): sem pedido novo, sem
    // pedir endereço de novo (07/10, c08).
    if (!note && !recNote && intent.kind === "free_text" && !isQuestion(text) && ctx.medicineRefusedAt != null && Date.now() - ctx.medicineRefusedAt < 60 * 60_000) {
      await reply(phone, copy.medicineFarewell());
      return;
    }
    if (note) addPendingRequest(ctx, note);
    ctx.flow = "delivery";
    ctx.step = "need_address";
    await writeCtx(convo.id, ctx);
    if (priceAsk && note) await reply(phone, copy.priceAfterAddress(priceAsk));
    const noted = notedForCopy(ctx);
    await askSignup(phone, copy.signupFormBody(noted), () => askAddress(phone, copy.welcomeAskFullDeliveryAddress(noted)));
    return;
  }

  // ---- onboarding: address saved, but no CEP yet — stash the request, ask the CEP ----
  // O pedido NÃO é resolvido agora (senão o 1º pedido do cliente seria auto-escolhido
  // sem opções nem preço): guarda o texto cru e roda a busca normal depois do CEP.
  if (!savedCep) {
    if (intent.kind === "free_text" && isWaitGripe(text)) {
      await reply(phone, copy.waitApology());
      return;
    }
    if (refusesWholeMessage(text)) {
      await refuseMedicine(phone, convo.id, ctx, text);
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
    const availability = intent.kind === "free_text" ? parseAvailabilityAsk(text) : null;
    if (availability) text = availability;
    const priceAsk = !availability && intent.kind === "free_text" ? parsePriceAsk(text) : null;
    const recNote = onboardingRecommendation(text, intent);
    const asking = !recNote && !availability && !priceAsk && intent.kind === "free_text" && isQuestion(text);
    if (asking) {
      await answerOnboardingQuestion(phone, text);
      ctx.flow = "delivery";
      ctx.step = "need_cep";
      await writeCtx(convo.id, ctx);
      await askAddress(phone, copy.askCepAgain());
      return;
    }
    const note = !recNote && intent.kind === "free_text" ? onboardingNote(priceAsk ?? text).text : "";
    const lines = note ? resolveListItems(note) : [];
    if (note) addPendingRequest(ctx, note);
    if (recNote) ctx.pendingRecommend = recNote.text;
    ctx.flow = "delivery";
    ctx.step = "need_cep";
    await writeCtx(convo.id, ctx);
    const noted = notedForCopy(ctx);
    await reply(
      phone,
      alreadyAsked
        ? lines.length || recNote
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
  // "o 1, pode pagar no pix" (06/10) é escolha + pagamento: entra na escolha mesmo com o
  // intent de pagar.
  // Escolha que veio de RECOMENDAÇÃO (08/10): "outras" = próximas prateleiras, "mais barato" = re-julga
  // pelo preço, "sem chocolate"/"de morango" = refaz a recomendação com a restrição — antes da escolha
  // comum ("sem chocolate" seria remoção da cesta; "outras" paginaria variantes de "algo doce").
  if (ctx.step === "choosing" && ctx.pending?.[0]?.recommendation) {
    const env: RecommendEnv = { phone, convoId: convo.id, userId: user.id, userCep: user.cep, ctx };
    if (await recommendFollowUp(env, text, intent)) return;
  }
  const choiceThenPay = ctx.step === "choosing" && ctx.pending?.length ? parseChoiceCombo(text, ctx.pending[0].options)?.pay : false;
  if (
    ctx.step === "choosing" &&
    ctx.pending?.length &&
    (choiceThenPay || (
    intent.kind !== "remove_item" &&
    intent.kind !== "swap_item" &&
    intent.kind !== "pay" &&
    intent.kind !== "choose_payment" &&
    intent.kind !== "done" &&
    // "Ver detalhes"/"detalhes 2" respondem no handler global (que já olha os cards
    // na mesa) sem mexer na escolha — os cards continuam valendo depois do link.
    intent.kind !== "product_details" &&
    intent.kind !== "product_details_tap"))
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
      if (await guardOpenCharge(phone, convo.id, user, ctx, order)) return;
      const wanted = intent.kind === "choose_payment" ? intent.method : intent.kind === "pay" ? intent.method : undefined;
      if (wanted && wanted !== (isCardCharge(order) ? "card" : "pix")) {
        // Rajada "pix"/"cartão" (28/08 S10): a troca deixa claro que o código anterior
        // NÃO vale mais — antes o cliente ficava com Pix vivo e oferta de cartão juntos.
        await reply(phone, copy.previousChargeSuperseded(wanted));
        await switchPaymentMethod(phone, order, wanted, { announced: true });
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
      if (result.pixOutDown) {
        await reply(phone, copy.purchaseTemporarilyDown());
        return;
      }
      if (result.unavailable) {
        await handlePreflightUnavailable(phone, convo.id, user, ctx, result.unavailable);
        return;
      }
      if (result.deliveryNotConfirmed) {
        await handleDeliveryNotConfirmed(phone, convo.id, user, ctx, result.deliveryNotConfirmed);
        return;
      }
      if (result.expired) await reply(phone, copy.quoteExpired());
      return;
    }
  }
  // "pix"/"cartão" sem cesta, escolha nem pedido aberto (09/10, rodada 1): resposta curta de que não há o que pagar.
  // Antes rodava a busca inteira (12 s) e caía no FAQ de pagamento ou em "não achei cartão".
  if (intent.kind === "choose_payment" && !(ctx.basket?.length ?? 0) && !(ctx.pending?.length ?? 0)) {
    const openOrder = await prisma.deliveryOrder.findFirst({
      where: { userId: user.id, status: { in: [AWAITING_OPERATOR_QUOTE_STATUS, "awaiting_payment", "awaiting_quote_confirmation"] } },
      select: { id: true }
    });
    if (!openOrder) {
      await reply(phone, copy.noOpenOrderToPay());
      return;
    }
  }
  const wantsToPay =
    intent.kind === "pay" ||
    intent.kind === "done" ||
    // "cartão"/"pix" com escolha aberta e cesta vazia virava busca de "cartão" (06/10).
    (intent.kind === "choose_payment" && ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0));
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
        await reply(phone, copy.finishChoiceFirst(pendingNames(ctx), turnMeta.getStore()?.prevSent ?? []));
        await sendChoices(phone, ctx.pending[0]);
        return;
      }
      if ((ctx.basket?.length ?? 0) > 0) {
        // Complemento no fechamento (08/10, fase 4): 1 oferta antes do total; sem oferta, o total de sempre.
        await closeListOrOfferComplement(phone, convo.id, ctx, user.cep, user.id);
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
        if (await guardOpenCharge(phone, convo.id, user, ctx, openOrder)) return;
        await resendCharge(phone, openOrder);
        return;
      }
      await reply(phone, copy.emptyCartPay());
      return;
    }
  }

  // ---- quantidade / troca de opção / "voltar" depois de escolher (varredura 06/10) ----
  // "quero 2", "6x", "tira um", "na verdade quero o 2", "troca pelo outro", "voltar": mexem no
  // item recém-escolhido. Com o total na mesa, o pedido reabre antes (como tirar/trocar).
  if (intent.kind === "qty_adjust" || intent.kind === "switch_choice" || intent.kind === "back") {
    const last = ctx.lastChoice;
    const hasLastChoice = Boolean(last);
    if (intent.kind === "qty_adjust" || hasLastChoice) {
      const reopened = await reopenOrderForEdit(phone, convo.id, ctx, user.cep, { quiet: intent.kind === "qty_adjust" });
      if (intent.kind === "qty_adjust") await handleQtyAdjust(phone, convo.id, user.cep, ctx, intent, reopened);
      else await handleChoiceSwitch(phone, convo.id, user.cep, ctx, intent.kind === "back" ? { other: true, back: true } : intent, reopened);
      return;
    }
    await reply(phone, intent.kind === "back" ? copy.backNothingOpen() : copy.switchNothingOpen());
    return;
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
          const clauseLines = resolveListItems(part.clause);
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
          const single = resolveListItems(part.clause)[0];
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
          await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx)));
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
    // Toque repetido no card que acabou de entrar (06/10): confirma de novo, sem somar — a
    // quantidade só muda quando o cliente pede.
    const lastSku = ctx.lastChoice?.chosenSku;
    const again = lastSku && lastSku.toLowerCase() === intent.sku.toLowerCase() ? (ctx.basket ?? []).find((b) => b.sku === lastSku) : undefined;
    if (again) {
      await reply(phone, copy.alreadyInBasket(again.name, again.qty));
      return;
    }
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
    // "ok"/"sim" com a cesta montada (06/10) encerrava com "Imagina! 💚" e nada era
    // cobrado — o cliente achava que tinha fechado. Agora mostra o total para aprovar.
    if ((ctx.basket?.length ?? 0) > 0 && (ctx.step === "collecting" || ctx.step === undefined)) {
      await continueAfterBasket(phone, convo.id, ctx, user.cep);
      return;
    }
    // Com o Pix aberto, "ok" é "vou pagar": o pagamento continua valendo.
    if (ctx.step === "awaiting_payment" && ctx.deliveryOrderId) {
      const open = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId }, select: { status: true, total: true } });
      if (open?.status === "awaiting_payment") {
        await reply(phone, copy.awaitingPaymentAck(open.total));
        return;
      }
    }
    // "pode mandar" com item escolhido e nada pendente (06/10): é "fecha", não "obrigado".
    if (ctx.basket?.length && !ctx.pending?.length && /\b(mand\w*|envi\w*|fech\w*|segu\w*)\b/.test(normalizeMsg(text))) {
      await continueAfterBasket(phone, convo.id, ctx, user.cep);
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
      // Número solto não reescreve a quantidade já pedida (09/10, rodada 2): "uma dúzia de coca" + "1" + "1" virava 1x.
      // Vale uma vez por item, e "1" seco nunca derruba quantidade maior (para isso há "só 1", "deixa 1").
      const key = `${last.sku}`;
      if (intent.value !== last.qty && (ctx.bareQtyUsed === key || (intent.value === 1 && last.qty > 1))) {
        await reply(phone, copy.bareNumberKeepsQty(last.qty, last.name));
        return;
      }
      ctx.bareQtyUsed = key;
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
      await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx)));
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
      const n = normalizeMsg(text);
      const explicitAdd = explicitAddCue(text);
      // Só item novo reabre (06/10): "to pagando", "comprovante enviado", o nome do cliente,
      // "o link não abre" CANCELAVAM o Pix que o cliente estava pagando.
      const productLike = looksLikeNewProductRequest(text);
      if (!productLike) {
        if (/\b(link|nao abre|nao abriu|nao consigo abrir|nao carrega|erro)\b/.test(n)) {
          await reply(phone, copy.paymentLinkTrouble());
          return;
        }
        if (/\b(pagando|vou pagar|ja vou|pago ja|paguei|comprovante|transferi|transferindo|fazendo o pix|fiz o pix|enviei|mandei|aguarda|espera|um minuto|um minutinho|ja ja|calma|ok|blz|beleza|certo|ta bom|beleza)\b/.test(n)) {
          await reply(phone, copy.awaitingPaymentAck(order.total));
          return;
        }
        if (classifyFirstEnabled() && (await tryLlmInterpret(phone, convo.id, user.cep, ctx, text, user.id))) return;
        await reply(phone, copy.awaitingPaymentAck(order.total));
        return;
      }
      const issuedAt = ctx.paymentIssuedAt ?? order.updatedAt.getTime();
      const chargeFresh = Date.now() - issuedAt < newMissionAfterMs();
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
  // "tenta de novo"/"pode tentar uma Wilson?" logo depois de um "não achei" continua o pedido
  // anterior (07/10): o classificador os tratava como pergunta ("essa eu não sei responder").
  const continuesMiss = Boolean(freshListMisses(ctx).length && parseMissFollowUp(text));
  if (classifyFirstEnabled() && intent.kind === "free_text" && !looksLikeProductList(text) && !continuesMiss) {
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

// Cliente que insiste "cadê meu pedido?" sem nenhum pedido neste número (07/10, c31): a 2ª vez não repete
// "você ainda não tem pedidos" — pede o dado que falta e chama o responsável. Melhor esforço (memória do
// processo); a nota/alerta ao dono é o que fica.
// Guardado em `ctx.attendance` (era um Map em memória). 1ª pergunta: só registra; 2ª: avisa o dono e
// vira modo atendimento; depois: confirmação curta e diferente.
async function replyNoOrders(phone: string, convoId: string, ctx: DeliveryContext, text?: string) {
  const cur = attendanceLive(ctx);
  // "cadê meu pedido de ONTEM?" sem pedido nenhum é uma reclamação concreta (outro número? pedido de
  // teste?): avisa o dono já na 1ª vez em vez de pedir que o cliente "monte o primeiro" (placar c31).
  const claimsPastOrder = asksPastOrder(text);
  if ((!cur || cur.notifiedAt === 0) && claimsPastOrder) {
    enterAttendance(ctx, "order_missing");
    await notifyOwner(`🔎 Cliente diz que fez um pedido (${(text ?? "").slice(0, 120)}), mas não há pedido neste número — conferir (outro número? pedido de teste?).`, phone);
    await writeCtx(convoId, ctx);
    await reply(phone, copy.noOrdersEscalated(withinOperatorHours()));
    return;
  }
  if (cur && cur.notifiedAt > 0) {
    const { notify } = enterAttendance(ctx, cur.kind);
    if (notify) await notifyOwner(`🔎 Cliente segue sem pedido neste número: "${(text ?? "").slice(0, 160)}" — conferir.`, phone);
    const ack = nextAttendanceAck(ctx);
    await writeCtx(convoId, ctx);
    await reply(phone, ack);
    return;
  }
  if (cur && cur.kind === "order_missing" && Date.now() - cur.since < ATTENDANCE_RENOTIFY_MS) {
    enterAttendance(ctx, "order_missing");
    await notifyOwner(`🔎 Cliente diz que fez um pedido, mas não há pedido neste número: "${(text ?? "").slice(0, 160)}" — conferir (outro número? pedido de teste?).`, phone);
    await writeCtx(convoId, ctx);
    await reply(phone, copy.noOrdersEscalated(withinOperatorHours()));
    return;
  }
  ctx.attendance = { kind: "order_missing", since: Date.now(), notifiedAt: 0, acks: 0 };
  await writeCtx(convoId, ctx);
  await reply(phone, copy.noOrdersYet());
}

const ETA_QUESTION_RE = /\b(chega|chegam|chegar|demora|demoram|prazo|horas|hoje|amanha|entrega quando|quando entrega)\b/;
async function handleStatus(phone: string, userId: string, ctx: DeliveryContext, text?: string, convoId?: string) {
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
    await replyNoOrders(phone, convoId ?? "", ctx, text);
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
    // "Quando chega?" com a lista na mesa (08/10 noite, dono: a Lia respondia "Até agora… diz só isso" duas
    // vezes): é pergunta de PRAZO. O prazo de cada loja só existe no total — então responde isso e fecha
    // agora (o total vem com o prazo); escolha em aberto termina antes.
    if (text && ETA_QUESTION_RE.test(normalizeMsg(text)) && convoId && (ctx.basket?.length ?? 0) > 0) {
      const owner = await prisma.user.findUnique({ where: { id: userId }, select: { cep: true } });
      await answerBasketEta(phone, convoId, ctx, owner?.cep ?? null);
      return;
    }
    const items = basketForCopy(ctx);
    const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
    await reply(phone, copy.partialTotal(items, produtos, ctx.pending?.length ?? 0, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx)));
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
      await replyNoOrders(phone, convoId ?? "", ctx, text);
    }
    return;
  }
  // Escolha da entrega na tela ou total esperando a forma de pagamento (06/10): "quando
  // chega?" respondia "com o total sendo fechado"/"em andamento" com os prazos já na tela.
  if (order.id === ctxOrder?.id && ctx.step === "choosing_freight" && ctx.freightChoice?.orderId === order.id && order.status === AWAITING_OPERATOR_QUOTE_STATUS) {
    await reply(phone, copy.freightEtaHeader());
    await sendFreightChoice(phone, ctx.freightChoice);
    return;
  }
  if (order.status === "awaiting_quote_confirmation") {
    await replyChargeNotIssued(phone, userId, ctx, order);
    return;
  }
  let statusLine = copy.orderStatusLine({
    shortId: order.id.slice(-6).toUpperCase(),
    status: order.status,
    trackingUrl: order.courierTrackingUrl,
    paid: Boolean(order.paidAt),
    dateLabel: orderDateLabel(order.createdAt),
    itemsPreview: orderItemsPreview(order.items)
  });
  // Pedido pago (06/10): loja e prazo gravados no pedido — "quando chega?" devolvia só o status.
  if (PAID_OR_IN_FULFILLMENT_STATUSES.includes(order.status) || order.status === "awaiting_payment") {
    const info = orderDeliveryInfoLine(order);
    if (info) statusLine = `${statusLine}\n${info}`;
  }
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
  // "paguei" antes de existir cobrança (06/10): respondia "em andamento" e a cotação vencia.
  if (await replyChargeNotIssued(phone, userId, ctx, order)) return;
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
    // Vários itens em jogo e uma escolha na tela (09/10, rodada 1): "cancela" pode ser só o item da vez — pergunta.
    if (ctx.step === "choosing" && ctx.pending?.length && (ctx.pending.length + (ctx.basket?.length ?? 0)) >= 2) {
      ctx.clearAllConfirm = { askedAt: Date.now() };
      await writeCtx(convoId, ctx);
      await reply(phone, copy.cancelAllAsk(ctx.pending[0].query));
      return;
    }
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
      for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
      Object.assign(ctx, fresh);
    }
    // Existe um pedido PAGO em andamento? A recusa nomeia ELE — sem isso o cliente do
    // teste de 26/08 ouviu "depois do pagamento não dá" sem saber de qual pedido.
    const paidActive = await prisma.deliveryOrder.findFirst({
      where: { userId, status: { in: ACTIVE_ORDER_STATUSES }, paidAt: { not: null } },
      orderBy: { createdAt: "desc" }
    });
    // "cancela"/"desisti" depois de pagar (06/10): respondia "não tem compra em aberto" e só
    // "cancela o pedido" estornava. Agora é o mesmo caminho, com "confirma?". Exceção: logo
    // depois de cancelar outro pedido nesta conversa, o "cancelar" repetido é sobre aquele.
    if (paidActive && !ctx.lastCanceledOrderId) {
      await askWithdraw(phone, convoId, ctx, paidActive);
      return;
    }
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
  // Pedido PAGO (11/09, CDC art. 49): enquanto a compra na loja não saiu, o cliente pode
  // desistir e o estorno é imediato pelo provedor — depois do "sim" (06/10).
  await askWithdraw(phone, convoId, ctx, order);
}

// Pergunta "confirma?" antes de estornar (06/10). Fora de "paid" sem compra (saiu pra entrega,
// compra em curso ou já com número na loja) explica que não dá — nunca promete o estorno.
async function askWithdraw(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  order: { id: string; status: string; total: number; items: unknown; notes?: string | null; pixCopiaECola?: string | null }
) {
  if (isOrderOutForDelivery(order.status)) {
    await reply(phone, copy.cancelTooLate());
    return;
  }
  const { customerCanWithdraw } = await import("./ops-lifecycle");
  if (!(await customerCanWithdraw(order.id))) {
    await reply(phone, copy.cancelRequestedPaid());
    return;
  }
  ctx.withdrawConfirm = { orderId: order.id, askedAt: Date.now() };
  await writeCtx(convoId, ctx);
  await reply(
    phone,
    copy.withdrawConfirmAsk({
      shortId: order.id.slice(-6).toUpperCase(),
      itemsPreview: orderItemsPreview(order.items),
      total: order.total,
      card: isCardCharge(order)
    })
  );
}

// O "sim" da desistência: o mesmo customerWithdrawRefund que o "cancela o pedido" já usava
// (o gate de compra em curso é refeito na transação — a compra pode ter saído no meio).
async function confirmWithdraw(phone: string, convoId: string, userCep: string | null | undefined, ctx: DeliveryContext, orderId: string) {
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    await reply(phone, copy.nothingToCancel());
    return;
  }
  if (order.status !== "paid") {
    if (PAID_OR_IN_FULFILLMENT_STATUSES.includes(order.status)) await reply(phone, copy.cancelRequestedPaid());
    else
      await reply(
        phone,
        copy.orderStatusLine({ shortId: order.id.slice(-6).toUpperCase(), status: order.status, paid: Boolean(order.paidAt), itemsPreview: orderItemsPreview(order.items) })
      );
    return;
  }
  const { customerWithdrawRefund } = await import("./ops-lifecycle");
  const outcome = await customerWithdrawRefund(order.id);
  if (outcome.ok) {
    await writeCtx(convoId, { ...addressOnlyCtx(ctx, userCep), lastCanceledOrderId: order.id, cancelReason: { orderId: order.id, askedAt: Date.now() } });
    await reply(phone, copy.withdrawnRefunded(outcome.amount));
    await askCancelReason(phone);
    return;
  }
  await reply(phone, copy.cancelRequestedPaid());
}

async function handleRefundRequest(phone: string, convoId: string, userId: string, ctx: DeliveryContext, text: string) {
  const paid = await latestPaidOrder(userId);
  if (paid) {
    await askWithdraw(phone, convoId, ctx, paid);
    return;
  }
  const last = await prisma.deliveryOrder.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  const shortId = last?.id.slice(-6).toUpperCase() ?? "";
  if (last && !last.paidAt && (last.status === "canceled" || CANCELABLE_FALLBACK_STATUSES.includes(last.status))) {
    await reply(phone, last.status === "canceled" ? copy.refundNothingCharged(shortId) : copy.refundNotPaidYet(shortId));
    return;
  }
  if (last && (last.status === "refunded" || last.status === "refund_pending" || last.status === "canceled")) {
    await reply(phone, copy.orderStatusLine({ shortId, status: last.status, paid: Boolean(last.paidAt), itemsPreview: orderItemsPreview(last.items) }));
    return;
  }
  // Entregue (ou sem pedido): é suporte — mesmo caminho da reclamação.
  await flagLatestOrder(userId, `⚠️ CLIENTE PEDIU O DINHEIRO DE VOLTA: "${text.slice(0, 140)}"`);
  await reply(phone, copy.complaintAck());
}

// Sem cobrança gerada ainda (06/10): escolha da entrega na tela → reapresenta a escolha;
// total na mesa → reapresenta Pix/cartão (com o prazo da loja). false quando não é o caso.
async function replyChargeNotIssued(
  phone: string,
  userId: string,
  ctx: DeliveryContext,
  known?: { id: string; status: string; total: number; items: unknown; storeKey: string; storeLabel: string; fulfillments: unknown } | null
): Promise<boolean> {
  const order =
    known ??
    (ctx.deliveryOrderId ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } }) : null) ??
    (await prisma.deliveryOrder.findFirst({ where: { userId, status: "awaiting_quote_confirmation" }, orderBy: { createdAt: "desc" } }));
  if (!order) return false;
  if (order.status === AWAITING_OPERATOR_QUOTE_STATUS && ctx.step === "choosing_freight" && ctx.freightChoice?.orderId === order.id) {
    await reply(phone, copy.chargeNotIssuedChooseFreight());
    await sendFreightChoice(phone, ctx.freightChoice);
    return true;
  }
  if (order.status === "awaiting_quote_confirmation") {
    const info = orderDeliveryInfoLine(order);
    await reply(phone, info ? `${copy.chargeNotIssuedChoosePayment()}\n${info}` : copy.chargeNotIssuedChoosePayment());
    const interactive = await whatsappAdapter.sendPaymentChoices(phone, order.total, cardTotal(order.total)).catch(() => null);
    if (!interactive) await reply(phone, copy.paymentMethod(order.total, cardTotal(order.total)));
    else markTurnReplied();
    return true;
  }
  return false;
}

// Loja(s) e prazo gravados no pedido (06/10): "quando chega?", "qual loja?", "qual o prazo?".
function orderStoresOf(order: { items: unknown; storeKey: string; storeLabel: string }): string[] {
  const items = (order.items as unknown as BasketItem[]) ?? [];
  const labels = items.filter((i) => i.storeLabel && i.storeKey !== CONCIERGE_STORE_KEY).map((i) => i.storeLabel as string);
  if (!labels.length && order.storeKey !== CONCIERGE_STORE_KEY && order.storeLabel !== CONCIERGE_STORE_LABEL) labels.push(order.storeLabel);
  return [...new Set(labels)];
}

function orderDeliveryInfoLine(order: { items: unknown; storeKey: string; storeLabel: string; fulfillments: unknown }): string {
  const fulfillments = (Array.isArray(order.fulfillments) ? order.fulfillments : []) as Array<{ deliveryPromise?: string; storeLabel?: string }>;
  // Pedido de várias lojas (09/10): o prazo de cada loja, com o nome dela.
  const promise = fulfillments.length > 1
    ? fulfillments.filter((f) => f?.deliveryPromise).map((f) => `${f.storeLabel ?? "loja"}: ${f.deliveryPromise}`).join("; ") || undefined
    : fulfillments.map((f) => f?.deliveryPromise).find(Boolean);
  return copy.orderDeliveryInfo({ stores: orderStoresOf(order), promise });
}

// Pedido pago e ainda não entregue — assunto das perguntas de loja, prazo e endereço.
async function latestPaidOrder(userId: string) {
  return prisma.deliveryOrder.findFirst({
    where: { userId, status: { in: PAID_OR_IN_FULFILLMENT_STATUSES } },
    orderBy: { createdAt: "desc" }
  });
}

// O pedido da conversa (se ainda vivo) ou o último pago — para "qual loja?"/"qual o prazo?".
async function currentOrderForQuestions(userId: string, ctx: DeliveryContext) {
  const ctxOrder = ctx.deliveryOrderId ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } }) : null;
  if (ctxOrder && ACTIVE_ORDER_STATUSES.includes(ctxOrder.status)) return ctxOrder;
  if ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0) return null;
  return latestPaidOrder(userId);
}

// Só os botões Pix/cartão do total na mesa (o "oi" já disse o que falta).
async function replyChargeNotIssuedButtons(phone: string, userId: string, ctx: DeliveryContext) {
  const order = ctx.deliveryOrderId ? await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId } }) : null;
  if (!order || order.status !== "awaiting_quote_confirmation" || order.userId !== userId) return;
  const interactive = await whatsappAdapter.sendPaymentChoices(phone, order.total, cardTotal(order.total)).catch(() => null);
  if (!interactive) await reply(phone, copy.paymentMethod(order.total, cardTotal(order.total)));
  else markTurnReplied();
}

// Endereço trocado por CEP/rua com pedido PAGO ainda não saído (06/10, A4): o pedido pago
// segue pro endereço antigo — diz isso junto do "Endereço atualizado" e anota pro dono.
async function paidOrderAddressNotice(userId: string, newAddress: string): Promise<string> {
  const paid = await latestPaidOrder(userId);
  if (!paid?.deliveryAddress || isOrderOutForDelivery(paid.status)) return "";
  if (normalizeMsg(paid.deliveryAddress) === normalizeMsg(newAddress)) return "";
  await prisma.deliveryOrder.update({
    where: { id: paid.id },
    data: { notes: appendOrderNote(paid.notes, `📍 Cliente trocou o endereço DEPOIS de pagar (novo: "${newAddress.slice(0, 120)}") — este pedido segue para o endereço original; o novo vale para os próximos.`) }
  });
  return `\n\n${copy.paidOrderAddressKept(paid.id.slice(-6).toUpperCase(), paid.deliveryAddress)}`;
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
  if (split?.items) split.items = (await takeIdentityFromItems(userId, split.items)) ?? "";
  const rawRest = raw
    .replace(CEP_RE_GLOBAL, " ")
    .replace(/\b(?:o\s+)?(?:meu\s+)?(?:novo\s+)?cep\s*(?:[eé]|eh|:)?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const place = { street, district, city };
  const plainHouse = !split && rawRest ? parseHouseNumberReply(rawRest, place) : null;
  // "meu cep é X, número 1000, quero pão de forma" (09/10, rodada 1): o número rotulado salva e o resto segue como pedido.
  const labeled = !split && !plainHouse && rawRest ? extractLabeledHouseNumber(rawRest) : null;
  const house = plainHouse ?? (labeled ? { numero: labeled.numero, ...(labeled.complemento ? { complemento: labeled.complemento } : {}) } : null);
  const streetOnly = !split && !house && Boolean(rawRest) && mentionsStreetWithoutNumber(rawRest, street);
  const firstAddress = !user?.defaultAddress;
  // Antes do cadastro, só o que tem cara de produto vira item (cortesia e apresentação não).
  const items = dropAddressOnlyItems(split
    ? (split.items ? onboardingNote(split.items).text : "") || undefined
    : labeled
      ? (labeled.rest ? onboardingNote(labeled.rest).text : "") || undefined
      : house || streetOnly
        ? undefined
        : firstAddress && rawRest
          ? onboardingNote(rawRest).text || undefined
          : restItems, { city, district, street });

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
  // Endereço escrito sem a cidade ("Rua Funchal 418, Vila Olímpia, 04551-060", 09/10, rodada 3): a cidade do CEP completa o
  // rótulo, como no cadastro ("..., São Paulo"); o resumo do pedido não pode ficar sem ela.
  const withCity = (addr: string) => (city && !normalizeMsg(addr).includes(normalizeMsg(city)) ? `${addr.replace(/[\s,]+$/, "")}, ${city}` : addr);
  const typedAddress = split?.address
    ? (firstAddress ? split.address : withCity(split.address))
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
  // Nome e CPF que vieram junto do CEP (ou ficaram guardados do passo anterior) saem da lista (rodada 4, M4).
  const queued = ((await takeIdentityFromItems(userId, [items, ctx.pendingRequest].filter(Boolean).join(", ").trim())) ?? "").trim();
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
  const savedMsg = completingSignup ? copy.addressSavedPrefix(shownAddress, ctx.cep, ctx.uf) : `${copy.addressUpdated(shownAddress, ctx.cep)}${await paidOrderAddressNotice(userId, shownAddress)}`;
  ctx.pendingRequest = undefined;
  if (await syncAwaitingQuoteOrderAddress(phone, convoId, ctx)) return;
  // 1º CEP com o endereço já completo = fim do cadastro, venha o endereço junto ("Rua X 10,
  // 01310-100") ou antes (06/10, Clara mandou rua e número, depois o CEP: o CPF nunca foi pedido).
  // Os itens guardados aparecem na confirmação: o cliente vê que não sumiram.
  const noted = notedForCopy(ctx, queued);
  const savedWithNoted = noted.length ? `${savedMsg}\n\n${copy.notedItemsLine(noted)}` : savedMsg;
  if (completingSignup && (await askCpfAtOnboarding(phone, userId, convoId, ctx, savedWithNoted, queued))) return;
  if (queued || ctx.pendingRecommend) {
    await reply(phone, savedMsg);
    await runQueuedRequest(phone, convoId, null, ctx, queued || undefined, userId, undefined);
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
  await reply(phone, completingSignup ? copy.addressSavedAskItems(shownAddress) : `${copy.addressUpdated(shownAddress, ctx.cep)}${await paidOrderAddressNotice(userId, shownAddress)}`);
}

// Uma mensagem é o ENDEREÇO de entrega (e não um pedido de produto)? Marcador de
// logradouro + número é o menor sinal confiável, sem tentar parsing frágil. Serve às
// duas pontas: aceitar o endereço e — no caminho do CEP — não confundir a rua com item.
// "Al. Santos 1000" (06/10) também é endereço.
// Pedido guardado para depois do cadastro (07/10, c06): "leite nude" e depois "um leite Nude de origem
// vegetal sem açúcar" são o MESMO pedido refinado — o mais completo substitui o curto em vez de somar
// (o resumo saía com o leite duplicado).
function addPendingRequest(ctx: DeliveryContext, note: string) {
  const segments = (ctx.pendingRequest ?? "").split(", ").filter(Boolean);
  const wanted = new Set(queryTokens(note));
  const same = segments.findIndex((segment) => {
    const tokens = queryTokens(segment);
    return tokens.length > 0 && wanted.size > 0 && (tokens.every((t) => wanted.has(t)) || [...wanted].every((t) => tokens.includes(t)));
  });
  if (same >= 0) {
    if (queryTokens(note).length >= queryTokens(segments[same]).length) segments[same] = note;
  } else {
    segments.push(note);
  }
  ctx.pendingRequest = segments.join(", ") || undefined;
}

// ---- recomendação no onboarding (08/10, plano-recomendacoes; dono: CEP no 1º contato) ----
// A mensagem é um pedido de recomendação? (vago, sintoma, presente, produto + julgamento). Sintoma
// lido como reclamação também conta; o resto da reclamação não.
function onboardingRecommendation(text: string, intent: Intent) {
  if (!recommendEnabled()) return null;
  if (intent.kind !== "free_text" && intent.kind !== "vague_request" && intent.kind !== "want_items" && intent.kind !== "complaint") return null;
  const req = detectRecommendation(text);
  return req && (intent.kind !== "complaint" || req.symptom) ? req : null;
}

// "Já anotei:" — os itens guardados e, se houver, a recomendação guardada ("uma recomendação de algo doce").
function notedForCopy(ctx: DeliveryContext, queued: string | undefined = ctx.pendingRequest): string[] {
  const items = queued ? resolveListItems(queued).map((line) => `${line.qty}x ${line.phrase}`) : [];
  const rec = ctx.pendingRecommend ? detectRecommendation(ctx.pendingRecommend) : null;
  return rec ? [...items, copy.recommendNoted(rec)] : items;
}

// O pedido guardado no onboarding roda depois do CEP/cadastro: a recomendação guardada vira
// recomendação (cards); itens viram a busca de sempre. As duas coisas juntas (raro: "tô com fome" e
// depois "e 2 cocas" antes do CEP): a recomendação vai e os itens ficam registrados no log — o
// cliente vê os cards e pede os itens de novo depois. Flag desligada: a frase vira busca, como antes.
async function runQueuedRequest(
  phone: string,
  convoId: string,
  cep: string | null | undefined,
  ctx: DeliveryContext,
  queued: string | undefined,
  userId?: string,
  searchUserId: string | undefined = userId
) {
  const recText = ctx.pendingRecommend;
  delete ctx.pendingRecommend;
  const req = recText && recommendEnabled() ? detectRecommendation(recText) : null;
  if (req) {
    if (queued) console.log(`[recommend] pedido guardado com itens; itens não buscados: ${JSON.stringify(queued.slice(0, 120))}`);
    await handleRecommend({ phone, convoId, userId, userCep: cep, ctx }, { ...req, source: "presignup" });
    return;
  }
  const text = [queued, recText].filter(Boolean).join(", ");
  if (text) await handleSearch(phone, convoId, cep, ctx, text, searchUserId);
}

// O que o cliente tinha na cesta/escolha quando ela venceu, para avisar na volta (09/10, rodada 1).
function snapshotExpiredCart(ctx: DeliveryContext, idleMs: number, quote = false): DeliveryContext["expiredCart"] | undefined {
  // Opções soltas (sem nada na cesta) de uma ausência curta continuam sumindo em silêncio (decisão 25/09,
  // conversation.eval); "voltou horas depois" (3 h+) é avisado.
  const longAway = idleMs >= 3 * 60 * 60_000;
  if (!ctx.basket?.length && !longAway) return undefined;
  const items = [
    ...(ctx.basket ?? []).map((b) => ((b.qty > 1 ? `${b.qty} ` : "") + (b.ask ?? b.name)).trim()),
    ...(ctx.pending ?? []).map((p) => (p.qtyExplicit && p.qty > 1 ? `${p.qty} ` : "") + p.query)
  ].filter(Boolean);
  return items.length ? { items, at: Date.now(), ...(quote ? { quote: true } : {}) } : undefined;
}

// Nome completo e CPF colados antes do endereço ("Carla Mendes, CPF 529.982.247-25, Av Paulista 1000…", 09/10, rodada 3)
// vão pro cadastro e saem do texto: nome e CPF nunca viram item de busca. CPF inválido também sai (a Lia pede de novo
// depois, pelos passos de sempre); só grava quando vêm CPF válido E nome.
export async function takeIdentityFromItems(userId: string, items: string | undefined): Promise<string | undefined> {
  if (!items || !looksLikeCpfAttempt(items)) return items;
  const cpf = extractCpf(items);
  const rest: string[] = [];
  let name: string | null = null;
  for (const segment of items.split(/\s*[,;\n]\s*/).filter(Boolean)) {
    if (looksLikeCpfAttempt(segment)) {
      name = name ?? extractFullName(segment);
    } else if (!name && looksLikeOnboardingName(segment)) {
      name = extractFullName(segment);
    } else {
      rest.push(segment);
    }
  }
  if (cpf && !name) name = (await prisma.user.findUnique({ where: { id: userId }, select: { cpfName: true } }))?.cpfName ?? null;
  if (cpf && name) await prisma.user.update({ where: { id: userId }, data: { cpf, cpfName: name, cpfConsentAt: new Date() } });
  return rest.join(", ") || undefined;
}

function looksLikeDeliveryAddress(text: string): boolean {
  const address = text.trim();
  const hasStreet = /\b(?:rua|r(?:\.|(?=\s+[a-zà-ú]))|avenida|av\.?|alameda|al(?=\.)|travessa|estrada|rodovia|pra[çc]a|largo)\b/i.test(address);
  // Número 0 ("rua sem nome 0") e rua sem nome não são endereço (09/10, rodada 1); o CEP não conta como número da casa.
  const hasNumber = /(?:\b(?!0+\b)\d+|\bs\/?n\b)/i.test(address.replace(CEP_RE_GLOBAL, " "));
  return address.length >= 12 && hasStreet && hasNumber && !/\bsem nome\b/i.test(address);
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
    finalAddress = (split?.address && looksLikeDeliveryAddress(split.address) ? split.address : address).replace(/\s+,/g, ",").replace(/,\s*,/g, ",");
    const itemsText = split?.items ? await takeIdentityFromItems(userId, split.items) : undefined;
    extraItems = itemsText ? onboardingNote(itemsText).text || undefined : undefined;
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
      await reply(phone, `${copy.addressUpdated(ctx.deliveryAddress!, ctx.cep)}${await paidOrderAddressNotice(userId, ctx.deliveryAddress!)}`);
      if (queued || ctx.pendingRecommend) await runQueuedRequest(phone, convoId, null, ctx, queued, userId, undefined);
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
        const name = extractFullName(address) ?? nameFromList ?? (await prisma.user.findUnique({ where: { id: userId }, select: { cpfName: true } }))?.cpfName ?? null;
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
    // "Vc tem cottage?"/"quanto tá o leite?" esperando o endereço (06/10): é pedido em forma
    // de pergunta — anota o produto e segue pedindo o endereço.
    const askedItem = kind === "free_text" ? parseAvailabilityAsk(address) ?? parsePriceAsk(address) : null;
    if (askedItem && !blocksMedicine(address)) {
      addPendingRequest(ctx, askedItem);
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
    // Endereço inválido ("rua sem nome 0") nunca vira item: pede rua com número e o CEP (09/10, rodada 1).
    if (/^(?:rua|r\.|avenida|av\.?|alameda|al\.|travessa|estrada|rodovia|pra[çc]a|largo)\s/i.test(address) && (/\b0+\b/.test(address) || /\bsem nome\b/i.test(address))) {
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      await reply(phone, copy.addressNotValid(Boolean(knownCep)));
      return;
    }
    // Nome sozinho ("Rafael Torres") é cadastro, não item: guarda o nome e segue pedindo o endereço (rodada 4, M4).
    if (kind === "free_text" && looksLikeBareFirstNameFullName(address)) {
      await prisma.user.update({ where: { id: userId }, data: { cpfName: extractFullName(address) } });
      ctx.step = "need_address";
      await writeCtx(convoId, ctx);
      await askStreetOrSignup(phone, ctx, userCep);
      return;
    }
    const note = kind === "free_text" && !parseHouseNumberReply(address) ? onboardingNote(address).text : "";
    if (note && queryTokens(note).length && !blocksMedicine(address)) {
      addPendingRequest(ctx, note);
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
  if (extraItems) addPendingRequest(ctx, extraItems);

  if (!ctx.cep && userCep) ctx.cep = userCep;
  if (!ctx.cep) {
    ctx.step = "need_cep";
    await writeCtx(convoId, ctx);
    const noted = extraItems ? resolveListItems(extraItems).map((line) => `${line.qty}x ${line.phrase}`) : [];
    await reply(phone, noted.length ? `${copy.addressSavedAskCep()}\n\n${copy.notedItemsLine(noted)}` : copy.addressSavedAskCep());
    return;
  }

  if (await syncAwaitingQuoteOrderAddress(phone, convoId, ctx)) return;
  ctx.step = "collecting";

  const queued = ctx.pendingRequest;
  ctx.pendingRequest = undefined;
  const savedMsg = copy.addressSavedPrefix(finalAddress, ctx.cep, ctx.uf);
  const noted = notedForCopy(ctx, queued);
  if (firstAddress && (await askCpfAtOnboarding(phone, userId, convoId, ctx, noted.length ? `${savedMsg}\n\n${copy.notedItemsLine(noted)}` : savedMsg, queued))) return;
  if (queued || ctx.pendingRecommend) {
    await reply(phone, `${copy.addressUpdated(finalAddress, ctx.cep)}${await paidOrderAddressNotice(userId, finalAddress)}`);
    await runQueuedRequest(phone, convoId, null, ctx, queued, userId, undefined);
    return;
  }

  if (ctx.basket?.length) {
    await continueAfterBasket(phone, convoId, ctx, userCep, `${copy.addressUpdated(finalAddress, ctx.cep)}${await paidOrderAddressNotice(userId, finalAddress)}`);
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
  // "1" com a pergunta de sim/não na tela é a opção única = sim, não o número da casa (09/10, rodada 1).
  const yes =
    intent.kind === "affirm" ||
    /^(1|um)$/.test(n) ||
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
    if (queued || ctx.pendingRecommend) await runQueuedRequest(phone, convoId, prev.cep, ctx, queued, user.id);
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
    // CPF digitado que não conferiu: o pedido só fecha com um válido (09/10, rodada 3).
    if (!form.cpf) ctx.cpfRequired = true;
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
  if (queued || ctx.pendingRecommend) {
    await reply(phone, copy.signupSaved(firstName, address, place.uf));
    await runQueuedRequest(phone, convo.id, form.cep, ctx, queued, user.id);
    return;
  }
  if (ctx.basket?.length) {
    await continueAfterBasket(phone, convo.id, ctx, form.cep, copy.signupSaved(firstName, address, place.uf));
    return;
  }
  await reply(phone, copy.signupSavedAskItems(firstName, address, place.uf));
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
  chosen: ChoiceOption,
  opts?: { note?: string; after?: string; thenPay?: boolean; packOk?: boolean }
) {
  const chosenStore = chosen.storeKey ? getStore(chosen.storeKey) : fallbackStore;
  // Quantidade sugerida pela recomendação por número de pessoas (q9, 08/10: "churrasco pra 12" → 3 peças de
  // picanha): o card mostrou "sugestão: 3x"; escolher o card põe essa quantidade, a menos que o cliente tenha
  // dito outra. A embalagem já foi contada pela sugestão (sem a pergunta de pacote).
  if (current.recommendation && chosen.suggestedQty && chosen.suggestedQty > 1 && current.qty === 1 && !current.qtyExplicit) {
    current.qty = chosen.suggestedQty;
    current.qtyExplicit = true;
    opts = { ...opts, packOk: true };
  }
  // Embalagem que não fecha com o pedido ("12 ovos" → bandeja de 20, 07/10 c28): o ajuste mudava a
  // quantidade REAL em silêncio e só avisava depois de pôr na cesta. Agora pergunta antes; a escolha
  // continua aberta (pending) até o "sim". Toque repetido no mesmo card conta como confirmação.
  const packAsked = ctx.packConfirm && ctx.packConfirm.sku === chosen.sku && ctx.packConfirm.askedQty === Math.max(1, current.qty);
  ctx.packConfirm = undefined;
  if (!opts?.packOk && !packAsked) {
    const askedQty = Math.max(1, current.qty);
    const perPack = declaredPack(chosen.name);
    const adjusted = packAdjusted(chosen, askedQty, current.query, { assumedOne: current.qty === 1 && !current.qtyExplicit });
    const weightConversion = Boolean(chosen.unitWeightKg && current.query && parseWeightAskKg(current.query));
    if (adjusted.note && !weightConversion && perPack >= 4 && adjusted.qty * perPack !== askedQty) {
      ctx.packConfirm = { sku: chosen.sku, askedQty };
      await writeCtx(convoId, ctx);
      await reply(phone, copy.packMismatchAsk(chosen.name, askedQty, perPack, adjusted.qty));
      return;
    }
  }
  ctx.pending = ctx.pending!.slice(1);
  // Recomendação escolhida (08/10): o RecommendLog fecha o ciclo (o que converte).
  if (current.recommendation) await markRecommendChosen(current.recommendation, chosen);
  // Memória da escolha concluída: "Outras opções"/"mais barato" depois dela reabrem
  // esta mesma escolha (e o novo pick substitui o item na cesta, não soma outro).
  const { replaceSku, ...lastBase } = current;
  ctx.lastChoice = { ...lastBase, chosenSku: chosen.sku };
  rememberShown(ctx, chosen.sku, current);
  if (replaceSku) {
    // Escolha reaberta ("voltar", "na verdade quero o 2", "outras"): a linha antiga sai e a
    // quantidade dela vale para a nova (06/10). Escolher o MESMO produto de novo não soma.
    const replaced = (ctx.basket ?? []).find((item) => item.sku === replaceSku);
    ctx.basket = (ctx.basket ?? []).filter((item) => item.sku !== replaceSku);
    // A substituição é uma troca (10/10, rodada 4 M2): "não, quero a fralda de antes"/"volta com a anterior" desfaz,
    // sem precisar da marca. Antes só "troca X por Y" lembrava o item tirado.
    if (replaced && replaced.sku !== chosen.sku) ctx.lastSwap = { removed: [replaced], to: current.query, addedSku: chosen.sku, at: Date.now() };
    if (replaced && !current.qtyExplicit && replaced.qty > 1) {
      current.qty = replaced.qty;
      current.qtyExplicit = true;
    }
  }
  // Quantidade não dita = 1 e segue em frente (dono, 01/09): a rodada "quantas
  // unidades?" era uma mensagem a mais no caso comum — quem quer 3 fala "3x" na hora
  // ou depois ("bota 3"). O handler de choosing_quantity fica vivo só para conversas
  // que estavam no meio da pergunta durante o deploy.
  const assumedOne = current.qty === 1 && !current.qtyExplicit;
  // "12 ovos" com a caixa de 10 escolhida = 1 caixa, não 12 caixas (testadores 06/10: R$92
  // de ovo). A conversão já valia no auto-pick; faltava na escolha do cliente.
  const pack = packAdjusted(chosen, current.qty, current.query, { assumedOne });
  const confirmedBase = assumedOne && !pack.note
    ? copy.choiceConfirmedAssumedOne(chosen.name, current.query)
    : `${copy.choiceConfirmed(chosen.name, pack.qty)}${pack.note ? `\n${pack.note}` : ""}`;
  const confirmed = [opts?.note, confirmedBase, opts?.after].filter(Boolean).join("\n");
  ctx.basket = mergeBaskets(ctx.basket ?? [], [choiceToBasketItem(chosen, pack.qty, chosenStore, current.query)]);
  // Teto dito na linha ("até R$100") vale para o TOTAL com entrega (07/10, c23/c24): guardado aqui, conferido
  // na cotação. `warned` sobrevive à troca de opção para não repetir a lista de "cabe no limite".
  if (current.cap != null) {
    ctx.budget = { cap: current.cap, sku: chosen.sku, ...(ctx.budget?.cap === current.cap && ctx.budget.warned ? { warned: true } : {}) };
  }
  if (ctx.pending.length) {
    await writeCtx(convoId, ctx);
    await reply(phone, opts?.thenPay ? `${confirmed}\n${copy.finishChoiceFirst(pendingNames(ctx))}` : confirmed);
    await sendChoices(phone, ctx.pending[0], copy.nextChoiceHeader(shownQuery(ctx.pending[0]), ctx.pending.length, ctx.pending[0].closestFalta));
    return;
  }
  // "quero o 1 e paga no pix" (06/10): escolheu e já pediu pra fechar — segue pro total.
  if (opts?.thenPay) {
    ctx.pending = undefined;
    ctx.step = "collecting";
    ctx.cep = ctx.cep ?? userCep ?? undefined;
    await writeCtx(convoId, ctx);
    // "o 1, pode fechar" também é fechar a lista: complemento antes do total (fase 4, 08/10).
    await closeListOrOfferComplement(phone, convoId, ctx, userCep, undefined, confirmed);
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

// Teto de preço dito com as opções na mesa ("algum até 150 reais?", "no máximo 60 com a entrega"): vale para o
// TOTAL (produto + entrega) de um pedido de um item só e acompanha a escolha até o fechamento (ctx.budget).
// Nada na mesa cabe: procura no resto do catálogo antes de dizer que não tem (rodada 2, 07/10).
async function applyChoiceBudget(phone: string, convoId: string, ctx: DeliveryContext, store: StoreConnector, current: PendingChoice, priceCap: number) {
  const single = ctx.pending!.length === 1 && !(ctx.basket?.length);
  current.cap = priceCap;
  if (single) current.capTotal = true;
  else delete current.capTotal;
  let within = withinBudget(current.options, current);
  if (!within.length) {
    const wider = await choiceCandidates(store, ctx, current).catch(() => [] as ChoiceOption[]);
    const seen = new Set(current.options.map((o) => o.sku));
    within = wider.filter((o) => !seen.has(o.sku)).slice(0, vitrineLimit());
    if (within.length) {
      const remembered = new Set((current.shownOptions ?? current.options).map((o) => o.sku));
      current.shownOptions = [...(current.shownOptions ?? current.options), ...within.filter((o) => !remembered.has(o.sku))];
      current.shownSkus = [...new Set([...(current.shownSkus ?? []), ...within.map((o) => o.sku)])];
    }
  }
  if (!within.length) {
    delete current.cap;
    delete current.capTotal;
    await reply(phone, copy.nonePriceCap(priceCap));
    await sendChoices(phone, current);
    return;
  }
  current.options = within;
  await writeCtx(convoId, ctx);
  await sendChoices(phone, current, copy.budgetNarrowedChoices(current.query, priceCap, Boolean(current.capTotal)));
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
  // "qualquer marca"/"comum" dentro de um refino não são palavras do produto (rodada 2, c20).
  if (intent.kind === "free_text") text = stripPreferenceFiller(text);
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
      // Toque repetido no card que ACABOU de entrar na cesta (06/10): confirma de novo, sem
      // somar e sem chamar de "conversa antiga".
      const again = ctx.lastChoice?.chosenSku.toLowerCase() === wanted ? (ctx.basket ?? []).find((b) => b.sku === ctx.lastChoice!.chosenSku) : undefined;
      if (again) {
        await reply(phone, copy.alreadyInBasket(again.name, again.qty));
        await sendChoices(phone, current, copy.nextChoiceHeader(shownQuery(current), ctx.pending!.length, current.closestFalta));
        return;
      }
      // Card de outro item/conversa antiga: não chuta produto — DIZ que o botão é
      // velho (27/08 S1: "não peguei qual você quer" confundia) e reapresenta a atual.
      await reply(phone, copy.staleButtonTap(true));
      await sendChoices(phone, current);
      return;
    }
    await confirmChosenOption(phone, convoId, ctx, userCep, store, current, tapped);
    return;
  }

  // Assunto NOVO de recomendação no meio da escolha (09/10, rodada de cliente: com os cards de dor de cabeça na tela,
  // "tem algo doce pra comer?" virava refino da dor de cabeça e reenviava os mesmos remédios). Outra necessidade
  // ou outro produto pra julgar = pedido novo; a escolha da tela sai com aviso. Mesma necessidade = refino (abaixo).
  if (intent.kind === "free_text" && recommendEnabled()) {
    const rec = detectRecommendation(text, { hasPendingChoice: true, basketNames: ctx.basket?.map((b) => b.name) });
    const was = current.recommendation?.request;
    const subject = (r: { form: string; need?: string; product?: string; symptom?: string }) => normalizeMsg(r.symptom ?? r.need ?? r.product ?? "");
    if (rec && subject(rec) && (!was || subject(rec) !== subject(was)) && !(was && subject(was) && subject(rec).includes(subject(was)))) {
      ctx.pending = ctx.pending!.slice(1);
      if (!ctx.pending.length) ctx.pending = undefined;
      ctx.step = ctx.pending?.length ? "choosing" : "collecting";
      await writeCtx(convoId, ctx);
      await handleSearch(phone, convoId, userCep, ctx, text, userId);
      return;
    }
  }

  // Pergunta de embalagem em aberto (07/10, c28): "sim" põe na cesta; "não"/"outras" volta às opções;
  // qualquer outra coisa desarma e segue como escolha normal.
  if (ctx.packConfirm) {
    const asked = ctx.packConfirm;
    const option = current.options.find((o) => o.sku === asked.sku);
    const n = normalizeMsg(text);
    // "1" = a única opção da pergunta (sim); antes o "1" caía em "👍"/"Por nada!" e o cliente travava (09/10, rodada 1).
    if (option && (intent.kind === "affirm" || /^(1|um)$/.test(n) || /^(sim|s|pode|pode sim|isso|isso mesmo|ok|beleza|blz|claro|fechado|quero|quero sim|mesmo assim|pode ser|ta bom|certo)\b/.test(n))) {
      await confirmChosenOption(phone, convoId, ctx, userCep, store, current, option, { packOk: true });
      return;
    }
    ctx.packConfirm = undefined;
    if (option && (intent.kind === "reject" || /^(nao|n|nao quero|nao precisa)\b/.test(n))) {
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current, copy.packMismatchDeclined());
      return;
    }
    await writeCtx(convoId, ctx);
  }

  // ---- varredura 06/10: escolha + outra coisa na mesma mensagem, troca, "voltar" ----
  // "quero o 1 e paga no pix" / "o 1, pode pagar no pix": escolhe e segue pro total.
  // "quero o 2 e um sabonete": escolhe o 2 e o sabonete entra na fila (virava a busca
  // "leite quero o 2 e um sabonete").
  const combo = parseChoiceCombo(text, current.options);
  if (combo) {
    const chosen = current.options[combo.reply.index];
    if (combo.reply.qty) {
      current.qty = combo.reply.qty;
      current.qtyExplicit = true;
    }
    if (combo.pay) {
      await confirmChosenOption(phone, convoId, ctx, userCep, store, current, chosen, { thenPay: true });
      return;
    }
    if (!combo.rest) {
      await confirmChosenOption(phone, convoId, ctx, userCep, store, current, chosen);
      return;
    }
    const added = await buildChoicesWithSearchNotice(phone, withMissQualifiers(ctx, combo.rest), undefined, undefined, undefined, ctx.cep);
    ctx.basket = mergeBaskets(ctx.basket ?? [], added.autoAdded);
    ctx.pending = [...(ctx.pending ?? []), ...added.pending];
    const notes: string[] = [];
    if (added.autoAdded.length) notes.push(copy.autoAddedNote(added.autoAdded.map((i) => `${i.qty}x ${i.name}`)));
    if (added.notFound.length) notes.push(copy.notFoundNote(added.notFound));
    await confirmChosenOption(phone, convoId, ctx, userCep, store, current, chosen, { after: notes.join("\n") || undefined });
    return;
  }
  // "o desnatado, e um pacote de bolacha maizena" (10/10, rodada 4 A3): a cabeça responde ao carrossel (refino/nome) e a
  // cauda é item novo. A cauda entra na fila (ou na cesta) e a cabeça segue como resposta à escolha da mesa.
  const headAndItems = splitChoiceHeadAndItems(text, current);
  if (headAndItems) {
    const added = await buildChoicesWithSearchNotice(phone, withMissQualifiers(ctx, headAndItems.tail), undefined, undefined, undefined, ctx.cep);
    ctx.basket = mergeBaskets(ctx.basket ?? [], added.autoAdded);
    ctx.pending = [...(ctx.pending ?? []), ...added.pending];
    await writeCtx(convoId, ctx);
    const notes: string[] = [];
    if (added.pending.length) notes.push(copy.queuedItemsNote(added.pending.map((p) => p.query)));
    if (added.autoAdded.length) notes.push(copy.autoAddedNote(added.autoAdded.map((i) => `${i.qty}x ${i.name}`)));
    if (added.notFound.length) notes.push(copy.notFoundNote(added.notFound));
    if (notes.length) await reply(phone, notes.join("\n"));
    await handleChoosing(phone, userId, userCep, convoId, ctx, headAndItems.head, detectIntent(headAndItems.head));
    return;
  }
  if (intent.kind === "switch_choice") {
    // Com a lista aberta, "na verdade quero o 3" é simplesmente escolher o 3.
    if (intent.other) {
      await pageMoreOptions(phone, convoId, ctx, store);
      return;
    }
    const idx = intent.index === -1 ? current.options.length - 1 : (intent.index ?? -1);
    if (idx >= 0 && idx < current.options.length) {
      await confirmChosenOption(phone, convoId, ctx, userCep, store, current, current.options[idx]);
      return;
    }
    await reply(phone, copy.choiceOutOfRange(current.options.length));
    await sendChoices(phone, current);
    return;
  }
  if (intent.kind === "back") {
    // "voltar" com a lista do item ANTERIOR ainda na memória: ela volta primeiro e esta fica
    // na fila; o item já escolhido continua na cesta até ele escolher outro.
    const last = ctx.lastChoice;
    const kept = last ? (ctx.basket ?? []).find((b) => b.sku === last.chosenSku) : undefined;
    if (last && kept) {
      const { chosenSku, ...base } = last;
      const restored: PendingChoice = { ...base, replaceSku: chosenSku };
      ctx.pending = [restored, ...(ctx.pending ?? [])];
      await writeCtx(convoId, ctx);
      await sendChoices(phone, restored, copy.backToChoice(restored.query, kept.name));
      return;
    }
    await sendChoices(phone, current);
    return;
  }
  // "qual o mais barato?" é pergunta: responde qual é, sem pôr na cesta (06/10).
  const priceAsk = asksCheapestQuestion(text);
  if (priceAsk && current.options.length > 1) {
    const idx = current.options.reduce(
      (best, o, i, arr) => ((priceAsk === "cheapest" ? o.unitPrice < arr[best].unitPrice : o.unitPrice > arr[best].unitPrice) ? i : best),
      0
    );
    const o = current.options[idx];
    await reply(phone, copy.cheapestOptionAnswer(idx + 1, o.name, display(o.unitPrice, o.medicine), priceAsk === "cheapest"));
    return;
  }
  // "o da Mambo", "o da drogaria são paulo": a LOJA da opção (06/10). Estreita para as opções
  // dela — como nome/marca digitado, quem confirma é o número (regra do dono, 04/09).
  const storeRef = parseStoreReference(text, current.options, listStores().map((s) => s.label));
  if (storeRef) {
    if (!storeRef.indices.length) {
      await reply(phone, copy.storeNoneOnTable(storeRef.label));
      await sendChoices(phone, current);
      return;
    }
    if (storeRef.indices.length === current.options.length) {
      await reply(phone, copy.storeAllSame(storeRef.label));
      await sendChoices(phone, current);
      return;
    }
    current.options = storeRef.indices.map((i) => current.options[i]);
    await writeCtx(convoId, ctx);
    await sendChoices(phone, current, copy.storeNarrowed(storeRef.label));
    return;
  }
  // Mensagem com 2+ produtos ("shampoo Kerasys Coconut 1L, condicionador Kerasys Coconut
  // 1L", 06/10, Claire) é pedido novo: não estreita nem refina as opções na mesa.
  const multiItem = countDistinctItems(text) >= 2;
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

  // "só amora" / "só essa" ENQUANTO escolhe o 1º de vários itens (07/10, c07): o cliente fecha a lista
  // no item da mesa — os outros saem da fila; "só essa" com uma opção só já escolhe ela.
  if (only && (ctx.pending?.length ?? 0) > 1) {
    const namesCurrent = "demonstrative" in only ? current.options.length === 1 : sharesProductNoun(only.target, current.query);
    if (namesCurrent) {
      const skipped = ctx.pending!.slice(1).map((pending) => pending.query);
      ctx.pending = [current];
      await reply(phone, copy.onlyKeepSkipped(skipped));
      if ("demonstrative" in only) {
        await confirmChosenOption(phone, convoId, ctx, userCep, store, current, current.options[0]);
        return;
      }
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current);
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
  // "não gostei dessas, quero da Dove" (07/10, c36): recusa + o que quer no lugar. É busca nova
  // do MESMO produto com a marca/atributo — nunca "deixei o item de fora".
  const rejectThen = normalizeMsg(text).match(REJECT_THEN_RE);
  if (rejectThen) {
    const wantedTail = rejectThen[1]
      .replace(/^(?:quero|queria|prefiro|procura|procure|ve se tem|veja se tem|tem|pode ser|me ve|manda)\s+/, "")
      .replace(/^(?:uma?|d[aeo]s?)\s+/, "")
      .trim();
    const base = current.baseQuery ?? current.query;
    const baseTokens = new Set(queryTokens(normalizeMsg(base)));
    const fresh = queryTokens(wantedTail).filter((token) => !baseTokens.has(token));
    if (fresh.length && fresh.length <= 4) {
      if (await researchChoice(phone, convoId, ctx, current, `${base} ${fresh.join(" ")}`, fresh.join(" "))) return;
      await replyRefineMiss(phone, current, `${base} ${fresh.join(" ")}`, text);
      return;
    }
  }
  const attrAskRaw = parseAttributeAsk(text);
  // Orçamento junto do pedido de atributo ("óleo de soja, até uns 12 reais"): o teto vale para a escolha e sai das
  // palavras da busca — "ate 12 reais" virava termo do produto e a Lia dizia "não achei óleo soja ate 12 reais".
  const attrBudget = attrAskRaw ? splitPriceCap(attrAskRaw) : null;
  const attrAsk = attrBudget?.cap != null ? attrBudget.phrase : attrAskRaw;
  if (attrBudget?.cap != null) current.cap = attrBudget.cap;
  if (attrAsk && !parseRefinement(attrAsk) && !wantsMoreOptions(text)) {
    const base = current.baseQuery ?? current.query;
    const baseTokens = new Set(queryTokens(normalizeMsg(base)));
    const fresh = queryTokens(normalizeMsg(attrAsk)).filter((token) => !baseTokens.has(token));
    if (fresh.length && fresh.length <= 4) {
      const wanted = `${base} ${fresh.join(" ")}`;
      // Tudo o que o cliente pediu tem que estar no produto ("kerasys" E "coco"), não só a
      // palavra nova — senão "Kit Skala Coco" aparecia como "shampoo kerasys coco".
      if (await researchChoice(phone, convoId, ctx, current, wanted, queryTokens(normalizeMsg(attrAsk)).join(" "))) return;
      await replyRefineMiss(phone, current, wanted, text);
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
  // "o mesmo da última vez" (06/10): procura nas compras do cliente; nunca é "a última opção".
  if (parsed?.type === "previous") {
    const bought = await preferredSkuCounts(userId);
    const hits = current.options.map((o, i) => ({ i, n: bought.get(o.sku) ?? 0 })).filter((h) => h.n > 0).sort((a, b) => b.n - a.n);
    if (hits.length) {
      current.options = [current.options[hits[0].i]];
      await writeCtx(convoId, ctx);
      await sendChoices(phone, current, copy.previousPurchaseFound());
      return;
    }
    await reply(phone, copy.previousPurchaseNotHere());
    await sendChoices(phone, current);
    return;
  }
  if (parsed?.type === "pick" && parsed.qty) {
    current.qty = parsed.qty;
    current.qtyExplicit = true;
  }
  if (!parsed) {
    // "5" numa lista de 3 (06/10): a pessoa respondeu um número — diz quantas opções há.
    const asked = parseChoiceNumber(text);
    if (asked && asked > current.options.length && (intent.kind === "number" || intent.kind === "free_text")) {
      await reply(phone, copy.choiceOutOfRange(current.options.length));
      await sendChoices(phone, current);
      return;
    }
    // "quero 2 unidades"/"6x" com a lista aberta: guarda a quantidade e pede qual.
    if (intent.kind === "qty_adjust" && intent.set) {
      current.qty = intent.set;
      current.qtyExplicit = true;
      await writeCtx(convoId, ctx);
      // "quero 2 desse" depois de uma foto (15/09): guarda o 2 e pergunta de qual.
      await sendChoices(phone, current, isDemonstrativeOnly(text) ? copy.demonstrativeNeedsChoice() : copy.qtyNotedPickOne(intent.set, current.query));
      return;
    }
  }
  if (parsed) {
    if (parsed.type === "skip") {
      ctx.pending = ctx.pending!.slice(1);
      // Era o único item (06/10): "Deixei de fora" já diz o próximo passo — sem o "Não
      // entendi" logo atrás, que contradizia.
      if (!ctx.pending.length && !(ctx.basket?.length ?? 0)) {
        await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
        await reply(phone, copy.choiceSkipped(current.query));
        return;
      }
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
          ? cheapestWithTies(current.options).index
          : 0;
    const tied = parsed.type === "cheapest" ? cheapestWithTies(current.options).tied : [];
    await confirmChosenOption(phone, convoId, ctx, userCep, store, current, current.options[index], tied.length > 1 ? { note: copy.cheapestTieNote(tied.map((i) => i + 1), display(current.options[index].unitPrice, current.options[index].medicine), index + 1) } : undefined);
    return;
  }

  if (more) {
    await pageMoreOptions(phone, convoId, ctx, store);
    return;
  }
  if (refineAttrs) {
    await refineOptions(phone, convoId, ctx, store, refineAttrs, text);
    return;
  }

  // "quanto deu tudo?" no meio das escolhas → parcial honesto e volta pras opções.
  if (asksRunningTotal(text)) {
    const items = basketForCopy(ctx);
    const produtos = Math.round(items.reduce((sum, i) => sum + i.displayLineTotal, 0) * 100) / 100;
    // Os cards acabaram de ir (09/10): uma linha lembra, sem reenviar o carrossel. Num balão só (rodada 1); o lembrete
    // não se repete em falas seguidas (rodada 2).
    const partial = copy.partialTotal(items, produtos, ctx.pending!.length, basketEtaByStore(ctx.basket ?? []).rows, pendingNames(ctx));
    await reply(phone, choicesNudgeAllowed() ? `${partial}\n\n${copy.choicesStillOpen(current.query)}` : partial);
    return;
  }

  // "algum até 150 reais?" — teto de preço filtra as opções na mesa (preço exibido,
  // com markup). Nenhuma dentro do teto → resposta honesta + caminhos (barato/opções).
  const priceCap = parsePriceCap(text);
  if (priceCap != null) {
    await applyChoiceBudget(phone, convoId, ctx, store, current, priceCap);
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
    await refineOptions(phone, convoId, ctx, store, catalogAttrs, text);
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
    let strong = combined
      .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }))
      .filter((o) => conciergeMatchIsStrong(combinedQuery, o) && conciergeMatchIsStrong(normalizeMsg(text), o))
      // Refino mantém o PRODUTO da escolha (06/10): com cervejas na mesa, "quero desodorante"
      // virava "*cerveja quero desodorante*: Body Splash Cereja" — produto de outro tipo é
      // item novo e vai pra fila logo abaixo.
      .filter((o) => conciergeMatchIsStrong(current.baseQuery ?? current.query, o))
      // O teto da busca original continua valendo no refinamento por marca. Esse é o
      // caminho de cauda longa de "fone até 150" → "Philco" que ainda deixava um
      // anúncio caro do ML furar o orçamento depois de os primeiros cards respeitarem.
      .filter((o) => current.cap == null || display(o.unitPrice, o.medicine) <= current.cap);
    // Idem: a busca combinada com a marca também passa pelo juízo da IA antes de ir à mesa.
    strong = await aiApprovePool(combinedQuery, strong, orderSiblings(ctx, current));
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
        await replyRefineMiss(phone, current, combinedQuery, text);
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
    const added = await buildChoicesWithSearchNotice(phone, withMissQualifiers(ctx, text), undefined, undefined, undefined, ctx.cep);
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
    // Com sinal de ADIÇÃO ("vamos adicionar outro produto, 3 rações…", 07/10 c09) o item é novo mesmo
    // dividindo o substantivo: reformular apagava a escolha em aberto e trocava a quantidade.
    const addsNew = ADDITIVE_CUE_RE.test(normalizeMsg(text));
    const clarifyIdx = multiItem && !addsNew ? added.pending.findIndex((pending) => sharesProductNoun(pending.query, current.query)) : -1;
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
    if (!addsNew && !added.autoAdded.length && added.pending.length === 1 && sharesProductNoun(added.pending[0].query, current.query)) {
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

// "Tenta outro modelo de mouse" depois do "não achei mouse sem fio": a procura continua com o "sem fio".
function withMissQualifiers(ctx: DeliveryContext, text: string): string {
  const miss = ctx.lastMiss && Date.now() - ctx.lastMiss.at < 20 * 60_000 ? ctx.lastMiss : undefined;
  return (miss && inheritMissQualifiers(text, miss.query)) || text;
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
  pool = withinBudget(pool, p);
  pool = active.length ? pool.filter((o) => active.every((a) => attrMatchesItem(a, o))) : pool;
  // O juízo da IA confere também o refino ativo ("coco", "1 L"), não só o pedido original.
  // O juízo precisa do CONTEXTO do pedido: "óleo" numa lista de mercado (arroz, feijão, café) é óleo de cozinha;
  // sem isso, "outras" de "óleo" aprovava óleo lubrificante e capilar (rodada 2, c20).
  return aiApprovePool(active.length ? `${query} ${active.join(" ")}` : query, pool, orderSiblings(ctx, p));
}

// O que mais está no pedido (cesta + outras escolhas na fila): contexto para o juízo da IA.
function orderSiblings(ctx: DeliveryContext, p: PendingChoice): string[] {
  return [...(ctx.basket ?? []).map((b) => b.name), ...(ctx.pending ?? []).filter((x) => x !== p).map((x) => x.query)].slice(0, 8);
}

// "Outras"/refino/mais barato também passam pelo juízo da IA (07/10, placar c20: "outras" de
// "arroz" trazia arroz carreteiro, com brócolis e arbório — o piso léxico só vê a palavra).
// IA fora do ar = o pool segue como estava; a ordem do ranking original é preservada.
async function aiApprovePool(query: string, pool: ChoiceOption[], siblings: string[] = []): Promise<ChoiceOption[]> {
  if (!pool.length) return pool;
  const head = pool.slice(0, 18);
  const rerank = await rerankShoppingOptions(
    siblings.length ? `${query} (pedido junto com: ${siblings.join(", ")})` : query,
    [{ query, candidates: head.map((o) => ({ sku: o.sku, name: o.name, brand: o.brand, price: o.unitPrice, store: o.storeLabel ?? "" })) }],
    18
  );
  if (!rerank) {
    // IA sem resposta no prazo: o piso léxico sozinho deixa passar "óleo lubrificante" para "óleo". Pelo menos
    // exige TODAS as palavras do pedido (e a marca/o atributo escrito) quando alguém as tem.
    const strict = pool.filter((o) => conciergeMatchIsStrong(query, o, { allTokens: true }));
    return strict.length ? strict : pool;
  }
  const approved = new Set(rerank.lines[0].skus);
  return head.filter((o) => approved.has(o.sku));
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
  // Recomendação (08/10): re-julga os candidatos da recomendação pelo preço.
  if (p.recommendation) return recommendByPrice({ phone, convoId, userCep: ctx.cep, ctx }, p, dir);
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
  p.closestFalta = undefined;
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
  // "tem um mais em conta?" sem nome com 2+ itens na cesta (10/10, rodada 4 M2): o alvo é ambíguo — reabrir a última
  // escolha trocava a fralda quando o cliente pensava no protetor. Pergunta de qual item.
  const lines = (ctx.basket ?? []).filter((item) => item.unitPrice > 0);
  if (mode === "cheaper" && lines.length >= 2) {
    ctx.cheaperAsk = { at: Date.now() };
    await writeCtx(convoId, ctx);
    await reply(phone, copy.cheaperWhichItem(lines.map((item) => item.name)));
    return true;
  }
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
  // Recomendação (08/10): "outras" = as próximas prateleiras do plano, não variantes de "algo doce".
  if (p.recommendation) return recommendMore({ phone, convoId, userCep: ctx.cep, ctx }, p);
  const shown = p.shownSkus ?? p.options.map((o) => o.sku);
  const pool = (await choiceCandidates(store, ctx, p)).filter((o) => !shown.includes(o.sku));
  // Quem pediu "outras" dispensou o que está na mesa: variante do dispensado não é
  // "outra opção". Só volta a valer se não sobrar mais nada de distinto.
  const fresh = pool.filter((o) => !p.options.some((cur) => sameProductVariant(p.query, cur, o)));
  // Quem pediu "a mais barata" segue vendo as próximas mais baratas (não a diversificação).
  const next = p.cheapestFirst
    ? [...pool].sort((x, y) => display(x.unitPrice, x.medicine) - display(y.unitPrice, y.medicine)).slice(0, vitrineLimit())
    : diversifyOptions(p.query, fresh.length ? fresh : pool, vitrineLimit());
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
        // A re-busca relaxada também passa pelo juízo da IA contra o pedido de verdade: sem isso, "óleo" (que não
        // tinha mais nada de cozinha) trazia óleo lubrificante e secante por conta só do piso léxico (rodada 2, c20).
        const rescue = await aiApprovePool(
          (p.attrs ?? []).length ? `${p.baseQuery ?? p.query} ${(p.attrs ?? []).join(" ")}` : p.query,
          await confirmOptionsLive(
            (await gatherCrossStoreCandidates(relaxedQuery, 12, 4, { forceLongTail: true }))
              .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }))
              .filter((o) => conciergeMatchIsStrong(relaxedQuery, o) && !shown.includes(o.sku))
              .filter((o) => p.cap == null || display(o.unitPrice, o.medicine) <= p.cap),
            ctx.cep
          ),
          orderSiblings(ctx, p)
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
  p.closestFalta = undefined;
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
// Recusa das opções + o que a pessoa quer no lugar ("não gostei dessas, quero da dove").
const REJECT_THEN_RE = /^(?:nao gostei|nao curti|nao gosto|nao quero (?:essas?|esses|nenhum[ao]?)|nenhum[ao]s? d[eo]ss[ea]s?)(?: d[eo]ss[ea]s?)?\s*[,;.]\s*(?:mas\s+|e\s+|entao\s+)?(.{3,60})$/;
const STYLE_ASK_RE = new RegExp(`^${REJECT_PREFIX}(?:tem que ser|precisa ser|tinha que ser|teria que ser|tem de ser|quero (?:um |uma )?(?:do |de )?(?:estilo|tipo|modelo)|estilo|tipo|modelo) (.{2,40})$`);
const REJECT_ONLY_RE = new RegExp(`^(?:estes|esses|essas|estas|isso|esse|essa|nenhum|nenhuma)\\s+(?:nao|não)\\s+(?:sao|são|servem?|prestam?|e|eh|da|dao)\\s*(?:bons|boas|bom|boa|legal|legais|isso)?[\\s.!,]*$`);

// Busca nova (vitrines + Mercado Livre) para a escolha ABERTA com uma frase mais
// específica ("isqueiro maçarico", "isqueiro tocha") e troca as opções na mesa. Devolve
// false quando nada aparece — o chamador segue o caminho de sempre.
async function researchChoice(phone: string, convoId: string, ctx: DeliveryContext, current: PendingChoice, text: string, mustMatch?: string): Promise<boolean> {
  // Recomendação (08/10): o refino ("tem de morango?") refaz a recomendação com a palavra pedida.
  if (current.recommendation) {
    await recommendRefineFromAttribute({ phone, convoId, userCep: ctx.cep, ctx }, current, text);
    return true;
  }
  const found = await buildChoicesWithSearchNotice(phone, text, undefined, undefined, true, ctx.cep);
  const picked = found.pending.find((p) => sharesProductNoun(p.query, current.query)) ?? found.pending[0];
  // Busca nova que só achou o "mais próximo" não serve de refino (o cabeçalho diria o contrário).
  const choice = picked?.closestFalta ? undefined : picked;
  // `mustMatch` (06/10): só vale opção que tem TUDO o que foi pedido ("kerasys coco"); a
  // busca nova não pode devolver outro produto com cabeçalho de refino.
  if (choice && mustMatch) choice.options = choice.options.filter((o) => attrMatchesItem(mustMatch, o));
  // O teto que o cliente já disse continua valendo na busca nova.
  if (choice && current.cap != null) choice.options = withinBudget(choice.options, current);
  if (!choice?.options.length) return false;
  current.baseQuery = undefined;
  current.attrs = undefined;
  current.closestFalta = undefined;
  current.cheapestFirst = choice.cheapestFirst;
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

// O cliente RECUSOU o que está na mesa ("nenhum desses", "esses não servem", "tem que ser tocha") e a busca
// refinada não achou nada: mostrar de novo as mesmas opções recusadas, só com o aviso "não achei", era a
// resposta que o cliente já tinha dispensado (rodada 2, c11). Diz que não achou e devolve a escolha a ele.
const REJECTED_SHOWN_RE = /\b(nenhum(?:a)? d(?:es|ess)[ea]s?|nao (?:servem?|serve|gostei|e isso|era isso|quero (?:ess\w*|nenhum\w*))|(?:ess\w+|est\w+) (?:nao (?:servem?|sao)|sao (?:comuns?|simples|normais|errad\w+|diferentes))|tem que ser|precisa ser|tinha que ser|so serve|(?:eu )?(?:preciso|precisava|quero|queria) (?:de )?(?:um|uma) (?:estilo|tipo|modelo))\b/;
async function replyRefineMiss(phone: string, current: PendingChoice, refined: string, text?: string) {
  if (text && REJECTED_SHOWN_RE.test(normalizeMsg(text))) {
    await reply(phone, copy.refineNoResultRejected(refined));
    return;
  }
  await reply(phone, copy.refineNoResult(refined));
  await sendChoices(phone, current);
}

// Recusou o que está na mesa dizendo O QUE EXIGE ("Nenhuma dessas, tem que ser estilo tocha", "Esses são comuns,
// preciso de um estilo tocha"): é refino do MESMO produto com a exigência. Resolvido aqui, antes do gerente de
// diálogo, para o "não achei" nunca devolver as opções que ele acabou de recusar (rodada 2, c11).
const REQUIREMENT_RE = /\b(?:tem que ser|precisa ser|tinha que ser|preciso de|precisava de|preciso que seja|quero)\s+(?:um |uma |o |a )?(?:estilo |tipo |modelo |sabor )?([a-z0-9][a-z0-9/ -]{1,40})/;
async function tryRejectedRefine(phone: string, convoId: string, ctx: DeliveryContext, text: string): Promise<boolean> {
  const current = ctx.pending?.[0];
  if (!current) return false;
  const n = normalizeMsg(text);
  if (!REJECTED_SHOWN_RE.test(n)) return false;
  // "Não gostei, quero o 2"/"essa não, a segunda" é escolha, não exigência: quem escolhe segue o caminho de sempre.
  if (parseChoiceReply(text, current.options)?.type === "pick" || parseChoiceCombo(text, current.options)) return false;
  const required = n.match(REQUIREMENT_RE)?.[1];
  if (!required) return false;
  const base = current.baseQuery ?? current.query;
  const baseTokens = new Set(queryTokens(normalizeMsg(base)));
  const asked = queryTokens(required.replace(/\//g, " ").replace(/\b(?:outras?|opcoes|opcao|mais)\b/g, " "));
  const fresh = asked.filter((token) => !baseTokens.has(token));
  if (!fresh.length || fresh.length > 4) return false;
  const wanted = `${base} ${fresh.join(" ")}`;
  if (await researchChoice(phone, convoId, ctx, current, wanted, fresh.join(" "))) return true;
  await replyRefineMiss(phone, current, wanted, text);
  return true;
}


async function refineOptions(phone: string, convoId: string, ctx: DeliveryContext, store: StoreConnector, attrs: string[], text?: string) {
  const p = ctx.pending![0];
  if (p.recommendation) return recommendRefineFromAttribute({ phone, convoId, userCep: ctx.cep, ctx }, p, attrs.join(" "));
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
    await replyRefineMiss(phone, p, refined, text);
    return;
  }
  p.baseQuery = base;
  p.attrs = attrs;
  p.query = refined;
  p.closestFalta = undefined;
  p.cheapestFirst = undefined;
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
  followUpOpts?: { qtyButton?: boolean; listFlowButton?: boolean }
) {
  if (ctx.pending?.length) {
    await writeCtx(convoId, ctx);
    if (prefix) await reply(phone, prefix);
    await sendChoices(phone, ctx.pending[0], copy.nextChoiceHeader(shownQuery(ctx.pending[0]), ctx.pending.length, ctx.pending[0].closestFalta));
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

// Troca a cesta por uma lista nova (só com intenção explícita ou reformulação; ver o bloco [basket:new-list]).
// A cesta velha sai (nada foi cobrado; o endereço fica) e a Lia diz o que saiu. Sem itens = só limpa.
async function startNewList(phone: string, convoId: string, userCep: string | null | undefined, ctx: DeliveryContext, text: string, userId?: string) {
  const dropped = [...(ctx.basket ?? []).map((b) => b.name), ...(ctx.pending ?? []).map((p) => p.query)];
  const fresh = addressOnlyCtx(ctx, userCep);
  for (const key of Object.keys(ctx)) delete (ctx as unknown as Record<string, unknown>)[key];
  Object.assign(ctx, fresh);
  await writeCtx(convoId, ctx);
  if (!text.trim()) {
    await reply(phone, copy.cartCleared());
    return;
  }
  await reply(phone, copy.newListDropped(dropped));
  await handleSearch(phone, convoId, userCep, ctx, text, userId);
}

// Linha da cesta que a frase pede DE NOVO (09/10, rodada 4, M3: "latão de Skol" e depois "cerveja skol latão").
// Mesmo produto = o catálogo casa a frase com o item, a marca do item está na frase (ou a frase é a mesma do pedido
// original) e nenhuma medida diferente foi pedida. "leite" não casa com "Leite Condensado Moça".
function repeatedBasketLine(phrase: string, basket: BasketItem[]): BasketItem | undefined {
  const canon = (t: string) => (/^lat(ao|oes|inha|inhas)$/.test(t) ? "lata" : t.replace(/s$/, ""));
  const tokenList = (x: string) => normalizeMsg(x).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d/.test(t)).map(canon);
  const same = (a: string, b: string) => tokenList(a).length > 0 && tokenList(a).sort().join(" ") === tokenList(b).sort().join(" ");
  const flat = (x: string) => ` ${normalizeMsg(x).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const wanted = measureOf(phrase);
  const asked = tokenList(phrase);
  return basket.find((b) => {
    if (wanted != null && measureOf(b.name) != null && wanted !== measureOf(b.name)) return false;
    if (b.ask && same(b.ask, phrase)) return true;
    if (!sharesProductNoun(phrase, b.name) || !itemMatchesPhrase(phrase, b)) return false;
    const nameTokens = new Set(tokenList(b.name));
    if (asked.length >= 2 && asked.every((t) => nameTokens.has(t))) return true;
    const brand = b.brand ? flat(b.brand) : "";
    return brand.trim().length > 0 && flat(b.name).includes(brand) && flat(phrase).includes(brand);
  });
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
  if (countDistinctItems(text) >= 2) return true;
  // Saudação na frente ("Ola quero 2 cxs de…", 06/10) não muda o que a mensagem é.
  const n = normalizeMsg(text).replace(/^(?:(?:oi+|ola+|opa+|bom dia|boa tarde|boa noite|e ?ai)(?:\s+lia)?[\s,!.]*)+/, "");
  return /^\d+\s*x?\s+\S/.test(n) || /^(quero|queria|me ve|manda|preciso de|traz|compra)\s+\d/.test(n);
}

// "adiciona/bota/põe mais um": o cliente está AMPLIANDO o pedido que está na mesa (funde).
// Escolha/refino do item na mesa + item novo na mesma mensagem (10/10, rodada 4 A3): "o desnatado, e um pacote de
// bolacha maizena" com o carrossel de leite aberto. A cabeça é resposta ao carrossel (número, nome de opção, atributo
// como "o desnatado", ou o próprio produto da mesa); a cauda tem item de produto real. Devolve as duas partes.
function splitChoiceHeadAndItems(text: string, current: PendingChoice): { head: string; tail: string } | null {
  const parts = text.trim().match(/^(.+?)(?:\s*[,;]\s*(?:e\s+)?|\s+e\s+(?:tamb[eé]m\s+)?)(.+)$/i);
  if (!parts) return null;
  const head = parts[1].trim();
  const tail = parts[2].trim();
  const reply = parseChoiceReply(head, current.options);
  const refersToChoice =
    (reply && reply.type !== "skip") || parseRefinement(head) != null || sharesProductNoun(head, current.baseQuery ?? current.query);
  if (!refersToChoice) return null;
  // A cauda só conta quando traz produto (não "e paga no pix", não quantidade) e não repete o item da mesa.
  const items = resolveListItems(tail).filter((l) => localCatalogProbe(l.phrase).strong && !sharesProductNoun(l.phrase, current.baseQuery ?? current.query));  return items.length ? { head, tail } : null;
}

function explicitAddCue(text: string): boolean {
  // Imperativo E infinitivo: "adicionar 1 gin e 1 vodka" (09/10, teste real) apagou a cesta como se fosse lista nova.
  return /\b(adicion(a|ar|e|em)|acrescent(a|ar|e|em)|inclu(i|ir|a|am)|bot(a|ar)|coloc(a|ar|e)|poe|põe|pon(ha|ho)|somar|mais um|mais uma)\b/.test(normalizeMsg(text));
}

// Ampliar a cesta sem "adiciona": "também", "e mais", "mais 2", "junta" (09/10: lista com uma dessas palavras soma).
// "e uma coca e um guaraná" começa com "e": continua a lista de antes.
const ADD_TO_BASKET_RE = /^e\b|\b(tambem|tbm|tb|tmb|e mais|mais \d|mais dois|mais duas|mais tres|junta|junto|alem disso|faltou|esqueci)\b/;
// Mexe na cesta ou na escolha, não é pedido novo: "tira o gin e a vodka", "troca", "2 do primeiro e 1 do segundo".
// Correção também ("não quero de uva, quero de laranja", "na verdade…", "em vez de…", "prefiro…").
const EDIT_OR_CHOICE_RE = /\b(tira|tirar|remove|remover|retira|exclui|troca|trocar|muda|mudar|diminui|aumenta|deixa|so|somente|apenas|primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|ultim[oa]|opcao|opcoes|esse|essa|desse|dessa|desses|dessas|numero|nao quero|na verdade|em vez|ao inves|no lugar|prefiro|melhor|errei|corrig\w*)\b/;

// Pedido de produto do nada ("preciso de um shampoo", "quero 2 cocas", lista) — o que, com um
// pedido parado na mesa, vira outra missão de compra (04/09 no Pix; 08/10 no total/entrega).
function looksLikeNewProductRequest(text: string): boolean {
  if (explicitAddCue(text) || looksLikeProductList(text)) return true;
  return /^(?:(?:ah+|e|ah e|ai|opa)\s+)?(?:quero|queria|preciso|precisava|me ve|manda|traz|compra|tambem|esqueci|faltou|e tambem|e um|e uma|e o|e a)\b/.test(normalizeMsg(text));
}

// Pedido parado + pedido de produto do nada depois deste tempo = missão NOVA (não funde, não pergunta).
// Lido a cada chamada (os evals ajustam o env em tempo de teste).
function newMissionAfterMs(): number {
  const value = Number(process.env.LIA_NEW_MISSION_AFTER_MS);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60_000;
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
  // `exact` (gerente de diálogo): o alvo já vem resolvido por sku/pergunta — sem casar por texto.
  opts?: { silentIfFound?: boolean; exact?: { skus?: string[]; queries?: string[] } }
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
  const exact = opts?.exact;
  const categoryAsk = exact ? null : normalizeMsg(target).match(/^(?:tudo|todos|todas)\s+(?:o\s+|os\s+|as\s+)?(?:que\s+(?:for|seja|sao|são|e|eh)\s+)?(?:de\s+|da\s+|do\s+|d[ao]s\s+)?(.+)$/);
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
  const keep = basket.filter((item) => (exact ? !exact.skus?.includes(item.sku) : categoryAsk ? !matchesTarget(item.name) : !itemMatchesPhrase(target, item)));
  const removed = basket.filter((item) => !keep.includes(item));
  const pendingKeep = pending.filter((p) =>
    exact ? !exact.queries?.includes(p.query) : categoryAsk ? !matchesTarget(p.query) : !itemMatchesPhrase(target, { sku: p.query, name: p.query, unitPrice: 0 })
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

// Quantidade do item recém-escolhido por texto (06/10): "quero 2", "6x", "bota 3" (set) e
// "tira um", "põe mais um" (delta). O alvo é o último escolhido; sem ele, o último da cesta.
async function handleQtyAdjust(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  cmd: { set?: number; delta?: number },
  reopened: boolean,
  // gerente de diálogo: o item já vem resolvido (senão vale o último escolhido)
  targetSku?: string
) {
  const basket = ctx.basket ?? [];
  const target =
    (targetSku ? basket.find((b) => b.sku === targetSku) : undefined) ??
    (ctx.lastChoice ? basket.find((b) => b.sku === ctx.lastChoice!.chosenSku) : undefined) ??
    basket[basket.length - 1];
  if (!target) {
    await reply(phone, copy.demonstrativeNeedsItem());
    return;
  }
  const next = cmd.set ?? target.qty + (cmd.delta ?? 0);
  if (next <= 0) {
    // "tira um" com 1 unidade = tirar o item.
    ctx.basket = basket.filter((b) => b !== target);
    if (!ctx.basket.length) {
      await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
      await reply(phone, copy.removedItems(target.name, true));
      return;
    }
    if (reopened) {
      await continueAfterBasket(phone, convoId, ctx, userCep, copy.removedItems(target.name, false));
      return;
    }
    await writeCtx(convoId, ctx);
    await replyBasketAdjusted(phone, copy.removedItems(target.name, false), copy.removedItems(target.name, false));
    return;
  }
  target.qty = Math.min(50, next);
  target.lineTotal = Math.round(target.unitPrice * target.qty * 100) / 100;
  if (reopened) {
    await continueAfterBasket(phone, convoId, ctx, userCep, copy.qtyAdjustedShort(target.qty, target.name));
    return;
  }
  await writeCtx(convoId, ctx);
  await replyBasketAdjusted(phone, copy.qtyAdjustedShort(target.qty, target.name), copy.qtyAdjusted(target.qty, target.name));
}

// "na verdade quero o 2" / "troca pelo outro" / "voltar" depois de escolher (06/10): a última
// lista volta com o item escolhido marcado para SUBSTITUIR (replaceSku) — ele só sai da cesta
// quando o cliente escolhe outro, e a quantidade dele passa para o novo.
async function handleChoiceSwitch(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  ask: { index?: number; other?: boolean; back?: boolean },
  reopened: boolean
) {
  const last = ctx.lastChoice;
  const kept = last ? (ctx.basket ?? []).find((b) => b.sku === last.chosenSku) : undefined;
  if (!last || !kept) {
    await reply(phone, ask.back ? copy.backNothingOpen() : copy.switchNothingOpen());
    return;
  }
  const { chosenSku, ...base } = last;
  const restored: PendingChoice = { ...base, replaceSku: chosenSku };
  const others = last.options.filter((o) => o.sku !== chosenSku);
  // "o outro" com só duas opções é inequívoco; com mais, a lista volta pra ele dizer qual.
  const option = ask.back
    ? undefined
    : ask.other
      ? others.length === 1 ? others[0] : undefined
      : last.options[ask.index === -1 ? last.options.length - 1 : (ask.index ?? -1)];
  ctx.pending = [restored, ...(ctx.pending ?? [])];
  ctx.step = "choosing";
  if (!option) {
    await writeCtx(convoId, ctx);
    if (!ask.back && !ask.other) await reply(phone, copy.choiceOutOfRange(last.options.length));
    await sendChoices(phone, restored, copy.backToChoice(restored.query, kept.name));
    return;
  }
  if (option.sku === chosenSku) {
    ctx.pending = ctx.pending.slice(1);
    if (!ctx.pending.length) {
      ctx.pending = undefined;
      ctx.step = "collecting";
    }
    await writeCtx(convoId, ctx);
    await reply(phone, copy.choiceSameAsBasket(kept.name));
    return;
  }
  const store = getStore(option.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);
  await confirmChosenOption(phone, convoId, ctx, userCep, store, restored, option, {
    note: copy.choiceSwitchedOut(kept.name),
    thenPay: reopened
  });
}

// Mais barata das opções na tela; no empate de preço fica a primeira (a de melhor relevância/prazo) e o cliente é avisado.
function cheapestWithTies(options: ChoiceOption[]): { index: number; tied: number[] } {
  const price = (o: ChoiceOption) => Math.round(display(o.unitPrice, o.medicine) * 100);
  const index = options.reduce((best, o, i, arr) => (price(o) < price(arr[best]) ? i : best), 0);
  return { index, tied: options.map((o, i) => (price(o) === price(options[index]) ? i : -1)).filter((i) => i >= 0) };
}
const CHEAPEST_PICK_RE = /^(?:(?:pode ser|quero|vou de|vou no|vou na|fico com|prefiro|me ve|manda|bota|pega)\s+(?:o |a )?mais barat\w+|(?:(?:pode ser|quero|vou de|fico com|prefiro|me ve)\s+)?(?:o |a )?mais baratinh[oa])(?:\s+(?:mesmo|ai|por favor|pfv))?$/;
const CHEAPEST_TO_RE = /^(?:(?:o|a|um|uma)\s+)?(?:\S+\s+){0,3}?(?:mais barat\w*|mais em conta|mais economic\w*|menor preco)$|^(?:o |a )?(?:mais barat\w*|mais em conta)$/;
// Sub-tipo de uso: se o candidato tem e o item atual não, não é "o mesmo item mais barato".
const USE_QUALIFIER_RE = /\b(intim\w*|antissept\w*|demaquilant\w*|facial|pet|cachorro|gato|geriatric\w*|adulto)\b/;
// "Mais barato" mantém o SUBTIPO (09/10, rodada 3: protetor solar → protetor labial 4,8 g; → aerossol): forma, zona do corpo e
// público que o candidato tem e o atual não = outro produto. Junto do tamanho (±10%) e de uma economia que valha (≥ 5%).
const CHEAPER_SUBTYPE_RE = /\b(intim\w*|antissept\w*|demaquilant\w*|facial|corporal|labial|labios?|capilar|maos|pes|pet|cachorro|gato|geriatric\w*|adulto|infantil|kids|baby|bebe|aerossol|spray|bastao|stick|roll ?on|gel|mousse|serum|oleo|po compacto|compacto|stick)\b/g;
const CHEAPER_MIN_SAVING = 0.05;
// Opções já mostradas na escolha que pôs `sku` na cesta (10/10, rodada 5 g16): a última escolha e a memória curta
// das escolhas anteriores (`recentShown`).
function shownOptionsForItem(ctx: DeliveryContext, sku: string): ChoiceOption[] {
  const out: ChoiceOption[] = [];
  if (ctx.lastChoice?.chosenSku === sku) out.push(...(ctx.lastChoice.shownOptions ?? []), ...ctx.lastChoice.options);
  for (const r of ctx.recentShown ?? []) if (r.sku === sku) out.push(...r.options);
  return out;
}

// Guarda as opções mostradas de uma escolha concluída (no máx. 4 escolhas × 10 opções).
function rememberShown(ctx: DeliveryContext, sku: string, choice: PendingChoice) {
  const options = [...new Map([...(choice.shownOptions ?? []), ...choice.options].map((o) => [o.sku, o])).values()].slice(0, 10);
  ctx.recentShown = [{ sku, options }, ...(ctx.recentShown ?? []).filter((r) => r.sku !== sku)].slice(0, 4);
}

// Candidatos do "mais barato" (10/10, rodada 5 g16): busca nova + o que o cliente já viu, só o mesmo tipo e mais barato
// que o atual; mesmo tamanho primeiro, depois por preço. São esses que vão à confirmação ao vivo.
export function cheaperSwapPool(current: BasketItem, fresh: ChoiceOption[], shown: ChoiceOption[]): ChoiceOption[] {
  const currentNorm = normalizeMsg(`${current.name} ${current.ask ?? ""}`);
  const currentPrice = display(current.unitPrice, current.medicine);
  const base = measureOf(current.name);
  const sameSize = (o: ChoiceOption) => {
    if (base == null) return true;
    const size = measureOf(o.name);
    return size != null && Math.abs(size - base) / base <= 0.1;
  };
  // Número que o cliente pediu e não é tamanho ("fps 30", "hp 667"), e que o item atual tem, vem antes: a busca larga
  // trazia FPS 50 na frente (preferência, não filtro: sem nenhum FPS 30 mais barato, o resto ainda serve).
  const askSpecs = [...normalizeMsg(current.ask ?? "")
    .replace(/\d+(?:[.,]\d+)?\s?(?:kg|g|mg|ml|l|litros?|un|unidades?|cm|m)\b/g, " ")
    .matchAll(/\b([a-z]+)\s?(\d+)\b/g)].map((m) => new RegExp(`\\b${m[1]}\\s?${m[2]}\\b`)).filter((re) => re.test(normalizeMsg(current.name)));
  const specOk = (o: ChoiceOption) => { const name = normalizeMsg(o.name); return askSpecs.every((re) => re.test(name)); };
  const merged = new Map<string, ChoiceOption>();
  for (const o of [...shown, ...fresh]) if (!merged.has(o.sku)) merged.set(o.sku, o);
  return [...merged.values()]
    .filter((o) => o.sku !== current.sku)
    .filter((o) => display(o.unitPrice, o.medicine) <= currentPrice * (1 - CHEAPER_MIN_SAVING))
    .filter((o) => { const q = USE_QUALIFIER_RE.exec(normalizeMsg(o.name)); return !q || currentNorm.includes(q[0]); })
    .filter((o) => sameSubtypeForCheaper(currentNorm, o.name))
    .sort((a, b) => Number(specOk(b)) - Number(specOk(a)) || Number(sameSize(b)) - Number(sameSize(a)) || display(a.unitPrice, a.medicine) - display(b.unitPrice, b.medicine))
    .slice(0, 12);
}

function sameSubtypeForCheaper(current: string, candidate: string): boolean {
  // Corpo é a zona padrão (10/10, rodada 4 A2): "Protetor Solar Sundown Praia e Piscina" é corporal sem dizer; o
  // "Basic+ Corporal" do mesmo carrossel não é outro subtipo. Facial/labial/capilar/mãos/pés continuam separando.
  const plain = normalizeMsg(current);
  const mine = /\b(facial|labial|labios?|capilar|maos|pes|rosto)\b/.test(plain) ? plain : `${plain} corporal`;
  return [...normalizeMsg(candidate).matchAll(CHEAPER_SUBTYPE_RE)].every((m) => mine.includes(m[1]));
}
const OTHER_BRAND_RE = /^(?:outr[oa]s?|uma outra|um outro|diferente|algum[a]? outr[oa])(?: (?:marca|versao|opcao|tipo|sabor|modelo|coisa))?s?$|^(?:de )?outra marca$/;

// Desfazer a última troca (09/10, rodada 3). Vale por 30 min; o texto tem de citar "de antes/anterior/original/que estava"
// (ou "volta/desfaz") e, se nomear produto, o nome tem de bater com o item tirado.
const UNDO_SWAP_WINDOW_MS = 30 * 60_000;
const UNDO_SWAP_CUE_RE = /\b(de antes|do anterior|o anterior|a anterior|anterior|original|que estava|que tava|que eu tinha|que tinha|que era|desfaz\w*|desfeit\w*|volt\w*|voltar)\b/;
const UNDO_SWAP_STOP = new Set(["nao", "quero", "queria", "volta", "voltar", "volte", "deixa", "deixe", "prefiro", "pode", "ser", "antes", "anterior", "original", "estava", "tava", "tinha", "era", "eu", "que", "esse", "essa", "melhor", "fico", "com", "desfaz", "desfazer", "troca"]);
function isUndoSwapText(text: string, swap: NonNullable<DeliveryContext["lastSwap"]>): boolean {
  if (!swap.removed?.length || Date.now() - swap.at > UNDO_SWAP_WINDOW_MS) return false;
  const n = normalizeMsg(text);
  if (n.length > 80 || !UNDO_SWAP_CUE_RE.test(n)) return false;
  // "volta" sozinho também pode ser "voltar pro endereço de antes": só vale sem menção a endereço/CEP/pagamento.
  if (/\b(endereco|cep|rua|pix|cartao|pagamento|pagar|frete|entrega)\b/.test(n)) return false;
  const named = queryTokens(n.replace(/[^\p{L}\p{N}\s]/gu, " ")).filter((t) => !UNDO_SWAP_STOP.has(t) && !/^(o|a|os|as|um|uma|de|do|da|no|na)$/.test(t));
  if (!named.length) return true;
  const removedNorm = swap.removed.map((r) => normalizeMsg(`${r.name} ${r.brand ?? ""} ${r.ask ?? ""}`)).join(" ");
  return named.some((t) => removedNorm.includes(t));
}

async function undoLastSwap(phone: string, convoId: string, userCep: string | null | undefined, ctx: DeliveryContext): Promise<boolean> {
  const swap = ctx.lastSwap;
  if (!swap?.removed?.length) return false;
  if (ctx.step === "choosing_freight" || ctx.step === "awaiting_quote_confirmation") {
    if (!(await reopenOrderForEdit(phone, convoId, ctx, userCep))) return false;
  }
  const restored = swap.removed;
  const basket = (ctx.basket ?? []).filter((b) => !(swap.addedSku && b.sku === swap.addedSku));
  const toNorm = normalizeMsg(swap.to);
  const pending = (ctx.pending ?? []).filter((p) => normalizeMsg(p.query) !== toNorm);
  ctx.basket = mergeBaskets(basket, restored);
  ctx.pending = pending.length ? pending : undefined;
  ctx.lastSwap = undefined;
  ctx.step = ctx.pending?.length ? "choosing" : "collecting";
  await writeCtx(convoId, ctx);
  const names = restored.map((r) => r.name).join(", ");
  if (ctx.pending?.length) {
    await reply(phone, copy.swapUndone(names));
    await sendChoices(phone, ctx.pending[0]);
    return true;
  }
  await continueAfterBasket(phone, convoId, ctx, userCep, copy.swapUndone(names));
  return true;
}

// "X ou Y" é UM item com alternativa: pergunta qual (ou "os dois"); a resposta busca. Só com a cesta sem pedido aberto
// e sem carrossel na tela (com opções abertas, "ou" é do cliente falando das opções).
async function handleAltItem(phone: string, convoId: string, userCep: string | null | undefined, ctx: DeliveryContext, text: string, userId?: string): Promise<boolean> {
  const asked = ctx.askEither;
  if (asked) {
    const fresh = Date.now() - asked.at < 15 * 60_000;
    ctx.askEither = undefined;
    const answer = fresh ? parseAltAnswer(text, asked.alternatives) : null;
    if (answer == null) {
      await writeCtx(convoId, ctx);
      return false;
    }
    await writeCtx(convoId, ctx);
    const search = (alt: string) => [asked.base, alt].filter(Boolean).join(" ");
    const query = answer === "both" ? `${search(asked.alternatives[0])}, ${search(asked.alternatives[1])}` : search(asked.alternatives[answer]);
    await handleSearch(phone, convoId, userCep, ctx, query, userId);
    return true;
  }
  if (ctx.deliveryOrderId || ctx.pending?.length || (ctx.step && ctx.step !== "collecting")) return false;
  if (isQuestion(text)) return false;
  const alt = detectAlternativeItem(text, mentionableStoreNames());
  if (!alt) return false;
  ctx.askEither = { ...alt, at: Date.now() };
  await writeCtx(convoId, ctx);
  await reply(phone, copy.askEitherItem(alt.alternatives[0], alt.alternatives[1]));
  return true;
}

async function handleSwap(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  from: string,
  to: string,
  rawText?: string,
  attrSwap?: boolean,
  // gerente de diálogo: o item trocado já vem resolvido por sku
  exactFromSku?: string
) {
  const basket = ctx.basket ?? [];
  // "quero A e B; pensando bem, troca B por C" numa LISTA NOVA (cesta vazia): não há o
  // que remover — a autocorreção vale para a PRÓPRIA mensagem. Monta a lista corrigida
  // (linhas antes do "troca", menos o B, mais o C) e segue o fluxo normal de busca
  // (3º ciclo de testes 15/08, rodada 3: respondia "não achei pra tirar").
  if (!basket.length && !(ctx.pending?.length)) {
    const before = (rawText ?? "").split(/\b(?:troca|trocar|substitui|substituir|muda|mudar)\b/i)[0] ?? "";
    const keptLines = resolveListItems(before).filter(
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
  let keep = basket.filter((item) => (exactFromSku ? item.sku !== exactFromSku : !itemMatchesPhrase(from, item)));
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
  const pendingKeep = exactFromSku ? pending : pending.filter((p) => !itemMatchesPhrase(from, { sku: p.query, name: p.query, unitPrice: 0 }));
  const removedPending = pending.filter((p) => !pendingKeep.includes(p));
  if (!removed.length && !removedPending.length) {
    await reply(phone, copy.removeNotFound());
    return;
  }
  if (!to) {
    await reply(phone, copy.swapAskWhat([...removed.map((i) => i.name), ...removedPending.map((p) => p.query)].join(", ")));
    return;
  }
  // "troca a ração por OUTRA MARCA" (09/10, rodada 2): "outra marca" não é produto — busca de novo o mesmo item
  // (o que o cliente pediu), sem a marca/produto atual, e o que ele escolher ENTRA NO LUGAR.
  // "troca o lenço pelo MAIS BARATO" (09/10, rodada 2): o "mais barato" fica dentro do item que está na cesta (mesma busca,
  // sem sub-tipo que o atual não tinha — lenço infantil não vira lenço de higiene íntima) e vai por preço.
  const cheapestSwap = removed.length === 1 && CHEAPEST_TO_RE.test(normalizeMsg(to));
  if (cheapestSwap) to = removed[0].ask?.trim() || removed[0].name.split(/\s+/).slice(0, 2).join(" ");
  const otherBrand = !cheapestSwap && OTHER_BRAND_RE.test(normalizeMsg(to)) && removed.length === 1;
  if (otherBrand) to = removed[0].ask?.trim() || removed[0].name.replace(/\b\d+(?:[.,]\d+)?\s?(?:kg|g|ml|l|litros?|un|unidades?)\b/gi, " ").replace(/\s+/g, " ").trim();
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
  // "troca a areia por uma SEM cheiro de 4kg" (09/10, rodada 3): o destino é só um atributo negado — compõe com o item
  // trocado e mantém o "sem" (filtro, não termo de busca: "cheiro" sozinho trazia areia perfumada).
  const negatedOnly = normalizeMsg(to).replace(/^(?:(?:uma?|outr[oa])\s+)/, "");
  if (!attrSwap && removed[0] && /^sem\s+\S/.test(negatedOnly)) {
    searchPhrase = `${removed[0].ask?.trim() || removed[0].name.split(/\s+/).slice(0, 2).join(" ")} ${negatedOnly}`;
    to = searchPhrase;
  }
  // "troca pelo mais barato" (10/10, rodada 5 g16): o conjunto comparado era só a busca nova com 12 candidatos — o
  // carrossel daquele item tinha 200 ml mais baratos (Cenoura e Bronze, OAZ) que nem entravam, e a Lia dizia "já é o
  // mais barato". Agora a busca é mais larga, as opções JÁ MOSTRADAS na escolha do item entram, e só os mais baratos
  // do mesmo tipo vão à confirmação ao vivo (mesmo de antes: no máximo 12).
  const candidates: StoreCandidate[] = crossStore
    ? await gatherCrossStoreCandidates(searchPhrase, cheapestSwap ? 40 : 12)
    : (await store.searchItems(searchPhrase, cheapestSwap ? 12 : 3)).map((item) => ({ store, item }));
  // 06/10: a troca também só oferece o que a loja confirmou para o CEP (sem operador, o
  // não confirmado é beco no "pagar").
  const leaving = otherBrand ? removed[0] : undefined;
  const leavingBrand = leaving ? normalizeMsg(leaving.brand ?? "") : "";
  let toConfirm = candidates
    .filter((c) => !leaving || (c.item.sku !== leaving.sku && !(leavingBrand.length > 2 && normalizeMsg(`${c.item.brand ?? ""} ${c.item.name}`).includes(leavingBrand))))
    .filter((c) => conciergeMatchIsStrong(searchPhrase, c.item))
    .map((c) => toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }));
  if (cheapestSwap) toConfirm = cheaperSwapPool(removed[0], toConfirm, shownOptionsForItem(ctx, removed[0].sku));
  const confirmed = await confirmOptionsLive(toConfirm, ctx.cep ?? userCep);
  // Tamanho pedido na troca ("a ração tem que ser de 3kg", 09/10): só o que tem o tamanho (±10%); a busca
  // mostrava as de 1kg de novo. Sem nenhuma do tamanho, a troca não acontece (o original fica, com aviso).
  const askedSize = measureOf(searchPhrase);
  const sized = askedSize ? confirmed.filter((o) => {
    const size = measureOf(o.name);
    return size != null && Math.abs(size - askedSize) / askedSize <= 0.1;
  }) : confirmed;
  let options = diversifyOptions(searchPhrase, sized, vitrineLimit());
  if (cheapestSwap) {
    const current = removed[0];
    const currentNorm = normalizeMsg(`${current.name} ${current.ask ?? ""}`);
    const currentPrice = display(current.unitPrice, current.medicine);
    const cheaperEnough = (o: ChoiceOption) => display(o.unitPrice, o.medicine) <= currentPrice * (1 - CHEAPER_MIN_SAVING);
    const base = measureOf(current.name);
    const sameKind = sized
      .filter((o) => o.sku !== current.sku)
      .filter((o) => { const q = USE_QUALIFIER_RE.exec(normalizeMsg(o.name)); return !q || currentNorm.includes(q[0]); })
      .filter((o) => sameSubtypeForCheaper(currentNorm, o.name))
      .sort((a, b) => display(a.unitPrice, a.medicine) - display(b.unitPrice, b.medicine));
    const pool = sameKind.filter((o) => {
      if (base == null) return true;
      const size = measureOf(o.name);
      return size != null && Math.abs(size - base) / base <= 0.1;
    });
    const cheapest = pool[0];
    // Mais barato só em OUTRO tamanho (10/10, rodada 4 A2: Sundown 200ml × Basic+ 100ml R$ 25,29 no carrossel): dizer
    // "já é o mais barato" era falso aos olhos do cliente. Mostra as mais baratas de outro tamanho, avisando o tamanho;
    // o item atual fica na cesta até ele escolher (a escolha substitui a linha).
    const otherSize = !cheapest || !cheaperEnough(cheapest) ? sameKind.filter((o) => !pool.includes(o) && measureOf(o.name) != null && cheaperEnough(o)) : [];
    if (otherSize.length) {
      ctx.basket = basket;
      ctx.pending = [
        { query: to, qty, options: otherSize.slice(0, vitrineLimit()), replaceSku: current.sku, cheapestFirst: true },
        ...(pending.length ? pending : [])
      ];
      ctx.step = "choosing";
      await writeCtx(convoId, ctx);
      await sendChoices(phone, ctx.pending[0], copy.cheaperOnlyOtherSize({ item: to, name: current.name, price: currentPrice, size: measureLabel(current.name) ?? undefined }));
      return;
    }
    if (!cheapest || !cheaperEnough(cheapest)) {
      ctx.basket = basket;
      ctx.pending = pending.length ? pending : undefined;
      await writeCtx(convoId, ctx);
      await reply(phone, copy.itemCheapestAnswer({ item: to, name: current.name, price: display(current.unitPrice, current.medicine), where: current.storeLabel, already: true }));
      return;
    }
    options = [cheapest];
  }

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
    ctx.lastSwap = { removed, to, addedSku: only.sku, at: Date.now() };
    ctx.basket = mergeBaskets(ctx.basket ?? [], [choiceToBasketItem(only, qty, only.storeKey ? getStore(only.storeKey) : store, to)]);
    await continueAfterBasket(phone, convoId, ctx, userCep, cheapestSwap ? copy.itemCheapestAnswer({ item: to, name: only.name, price: display(only.unitPrice, only.medicine), where: only.storeLabel, already: false }) : copy.swappedFor(removedNames, only.name));
    return;
  }
  ctx.lastSwap = { removed, to, at: Date.now() };
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
  await reply(phone, copy.swapRemovedPrefix(removedNames, to));
  await sendChoices(phone, ctx.pending[0]);
}

// Concierge mode request: parse the message into free-form lines (medicine still
// filtered by law), add them to the basket and confirm — no catalog, no options step.
// Cesta como CONJUNTO (P1.8): entre as opções aprovadas de cada linha, escolhe a combinação que
// minimiza produtos+frete — reordena `options` (a escolhida vai à frente) e devolve o aviso de cada
// troca. Compartilhado pelo modo lista e pelo Flow da lista.
function runBasketComposer(pending: PendingChoice[]): string[] {
  const composedNotes: string[] = [];
  // Desligado por padrão desde 09/10 (dono, teste de lojas: a lista de 9 lojas virou 6 sozinha): pedido de várias
  // lojas fecha, e juntar é OFERTA no fechamento (consolidationOffer, com os dois totais). LIA_BASKET_COMPOSER=on religa.
  if (process.env.LIA_BASKET_COMPOSER === "on" && process.env.LIA_BASKET_COMPOSER_OFF !== "true" && pending.length >= 2) {
    // Só troca por opção tão básica e tão fiel ao pedido quanto a 1ª (09/10, rodada com a IA: "feijão" virou
    // "Feijão Carioca Pronto Com Tempero 380g" pra juntar loja). `allowed[i]` guarda o índice original.
    const allowed = pending.map((p) => {
      const first = p.options[0];
      if (!first) return [] as number[];
      const pen = variantPenalty(p.query, first.name);
      const miss = missingAskWords(p.query, { name: first.name });
      return p.options.map((o, j) => (j === 0 || (variantPenalty(p.query, o.name) <= pen && missingAskWords(p.query, { name: o.name }) <= miss) ? j : -1)).filter((j) => j >= 0);
    });
    const composition = composeBasket(
      pending.map((p, i) => ({
        qty: Math.max(1, p.qty),
        options: allowed[i].map((j) => p.options[j]).map((o) => ({
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
        const pick = allowed[i][composition.picks[i]] ?? 0;
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
  return composedNotes;
}

// Perguntas de especificação (g7) montadas neste turno, enviadas pelo invólucro depois do resto da resposta.
const turnSpecAsks = new Map<string, SpecAsk[]>();

async function handleConciergeRequest(
  phone: string,
  convoId: string,
  userCep: string | null | undefined,
  ctx: DeliveryContext,
  text: string,
  userId?: string
) {
  turnSpecAsks.delete(phone);
  try {
    await handleConciergeCore(phone, convoId, userCep, ctx, text, userId);
  } catch (err) {
    turnSpecAsks.delete(phone);
    throw err;
  }
  const asks = turnSpecAsks.get(phone);
  turnSpecAsks.delete(phone);
  if (!asks?.length) return;
  // Contexto fresco: o miolo do pedido gravou a cesta/escolhas por conta própria.
  const fresh = readCtx((await prisma.conversation.findUnique({ where: { id: convoId }, select: { context: true } }))?.context ?? null);
  const keep = (fresh.specAsk && Date.now() - fresh.specAsk.askedAt < SPEC_ASK_TTL_MS ? fresh.specAsk.asks : []).filter((old) => !asks.some((a) => a.kind === old.kind));
  fresh.specAsk = { asks: [...keep, ...asks], askedAt: Date.now() };
  await writeCtx(convoId, fresh);
  await reply(phone, fresh.specAsk.asks.map((a) => copy.specQuestion(a.kind, a.query)).join("\n"));
}

const SPEC_ASK_TTL_MS = 30 * 60_000;

async function handleConciergeCore(
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
    /^(?:(?:pode|coloca|poe|bota|adiciona|acrescenta|quero|queria|me ve|manda|e|vamos|vou|podemos|entao|tambem)\s+)*(?:colocar\s+|adicionar\s+|acrescentar\s+|botar\s+)?mais\s+(.+)$/
  );
  if (moreOf && ctx.basket?.length) {
    const lines = resolveListItems(moreOf[1]).filter((l) => queryTokens(l.phrase).length);
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
  // Depois de "não achei" (07/10): "tenta de novo"/"qualquer marca" refaz o pedido anterior UMA
  // vez (a 2ª é resposta honesta) e "pode tentar uma Wilson?" soma a marca ao pedido anterior.
  // Com várias faltantes (`ctx.listMisses`, Etapa 3), "tenta de novo" refaz TODAS e a resposta curta
  // casa com a faltante mais parecida e busca só ela.
  const carriedMisses = freshListMisses(ctx);
  let missCarry = carriedMisses;
  let prevMiss: ListMiss | undefined;
  let fragmentReplaced = false;
  ctx.lastMiss = undefined;
  let retriedMiss = false;
  let rawPre: ChoicesResult | undefined;
  // Pedido anterior + fragmento ("pode tentar uma Wilson?") sem nada nas duas buscas: o "não achei"
  // fala do PEDIDO COMPLETO, não do fragmento nem de "essa eu não sei responder".
  let missCombined: string | undefined;
  const follow = carriedMisses.length ? parseMissFollowUp(text) : null;
  // "Pode tentar outro modelo de mouse?" depois de "não achei mouse sem fio": o "sem fio" continua valendo.
  if (carriedMisses.length && !follow) {
    const lastCarried = carriedMisses[carriedMisses.length - 1];
    text = withMissQualifiers({ ...ctx, lastMiss: { query: lastCarried.query, qty: lastCarried.qty, at: Date.now() } }, text);
  }
  if (carriedMisses.length && follow?.kind === "retry") {
    if (carriedMisses.every((miss) => miss.retried)) {
      applyListMisses(ctx, carriedMisses);
      await writeCtx(convoId, ctx);
      const stillQuery = carriedMisses.map((miss) => miss.query).join(", ");
      await reply(phone, copy.missStillNone(stillQuery, (await judgeMisses(text, [stillQuery]))?.[0]));
      return;
    }
    prevMiss = carriedMisses[carriedMisses.length - 1];
    text = carriedMisses.map(missLabel).join(", ");
    missCarry = [];
    retriedMiss = true;
  } else if (carriedMisses.length && follow?.kind === "fragment") {
    const picked = pickMissForFragment(carriedMisses, follow.words);
    if (picked) {
      const target = picked.miss;
      const combined = picked.replaces ? follow.words : `${target.query} ${follow.words}`;
      const probe = await buildChoices(combined, undefined, preferred, undefined, undefined, ctx.cep ?? userCep);
      // Só vale se o pedido combinado continua UMA linha e a marca/atributo está mesmo numa opção —
      // senão "leite" depois de "bola de tênis" virava "bola de tênis leite". Quando o cliente
      // reescreveu o próprio nome do item ("gelo em cubo" para "gelo"), vale o que ele escreveu.
      const fragmentWord = normalizeMsg(follow.words);
      const named = picked.replaces || [...probe.pending.flatMap((p) => p.options), ...probe.autoAdded].some((o) => normalizeMsg(o.name).includes(fragmentWord));
      if (probe.lines.length === 1 && named) {
        prevMiss = target;
        missCarry = carriedMisses.filter((miss) => miss !== target);
        fragmentReplaced = picked.replaces;
        text = target.qty > 1 ? `${target.qty} ${combined}` : combined;
        rawPre = probe;
      } else if (/\b(tent|procur|busc|pode ser|ve se|veja se)/.test(normalizeMsg(text))) {
        prevMiss = target;
        missCarry = carriedMisses.filter((miss) => miss !== target);
        missCombined = combined;
      }
    }
  }
  const raw = rawPre ?? (mercadoLivreEnabled()
    ? await buildChoicesWithSearchNotice(phone, text, undefined, preferred, undefined, ctx.cep ?? userCep, { askSpecs: true })
    : await buildChoices(text, undefined, preferred, undefined, undefined, ctx.cep ?? userCep, { askSpecs: true }));

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
  const { greetingOnly, containsMedicine, prescriptionDropped } = raw;
  // Perguntas de especificação (g7): as já detectadas antes da busca + ração pelada cujas opções misturam idade/porte
  // (só pergunta quando o catálogo separa e o cliente não disse). O invólucro envia depois do resto da resposta.
  const specAsks: SpecAsk[] = [...(raw.specAsks ?? [])];
  for (let i = pending.length - 1; i >= 0; i--) {
    const choice = pending[i];
    if (!choice.autoPick && isBareRacao(choice.query) && racaoStagesMixed(choice.options.map((o) => o.name))) {
      specAsks.push({ kind: "racao", query: choice.query, qty: choice.qty, ...(choice.qtyExplicit ? { qtyExplicit: true } : {}) });
      pending.splice(i, 1);
    }
  }
  if (specAsks.length) turnSpecAsks.set(phone, specAsks);
  // Só havia item com especificação faltando: a pergunta é a resposta inteira.
  if (specAsks.length && !pending.length && !notFoundLines.length && !raw.autoAdded.length && !containsMedicine) return;

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
      await refuseMedicine(phone, convoId, ctx, text);
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
    // Com o Flow da lista ligado, o "o resto achei" (nota de vitrine) usa a copy única por status.
    withOptions && listFlowEnabled(phone) && !medicineMiss && !offerLongTail && (unavailable.length || unbuyable.length)
      ? copy.missesBlock(
          notFoundLines.map((line): copy.MissEntry => ({
            status: unconfirmedSet.has(normalizeMsg(line.phrase)) ? "unbuyable" : "not_found",
            label: line.phrase,
            qty: line.qty
          }))
        )
      : [
      !unavailable.length
        ? null
        : offerLongTail
          ? copy.longTailOffer(unavailable)
          : withOptions
            ? copy.itemsNotAvailableWithOptions(unavailable)
            : medicineMiss
              ? copy.medicineNotFound(unavailable)
              : copy.itemsNotAvailable(unavailable, missInfo),
      unbuyable.length ? copy.itemsNotBuyableNow(unbuyable) : null
    ]
      .filter(Boolean)
      .join("\n");
  const missInfo = unavailable.length && !medicineMiss && !offerLongTail ? await judgeMisses(text, unavailable) : undefined;
  const hasNotFound = unavailable.length > 0 || unbuyable.length > 0;
  // Faltantes desta mensagem (Etapa 3): ficam 20 min no contexto e vão para o registro do /ops.
  // A busca refeita ("tenta de novo") não grava de novo — é a mesma demanda.
  const turnMisses: ListMiss[] = notFoundLines
    .filter((line) => !looksLikeMedicineName(line.phrase) && !isPrescriptionDrugName(line.phrase))
    .map((line) => ({
      query: line.phrase,
      qty: line.qty,
      reason: unconfirmedSet.has(normalizeMsg(line.phrase)) ? ("unbuyable" as const) : ("not_found" as const),
      at: Date.now(),
      ...(retriedMiss || fragmentReplaced ? { retried: true } : {})
    }));
  applyListMisses(ctx, mergeListMisses(missCarry, turnMisses));
  if (!retriedMiss && !prevMiss && turnMisses.length) await recordSearchMisses(phone, ctx.cep ?? userCep, turnMisses);
  ctx.flow = "delivery";
  // A cesta continua pertencendo ao "concierge" mesmo quando o item veio de uma vitrine: o
  // pedido é cotado e comprado à mão, então não há uma loja dona do pedido.
  ctx.storeKey = CONCIERGE_STORE_KEY;
  ctx.cep = ctx.cep ?? userCep ?? undefined;
  ctx.notFound = undefined;
  // Um item sem opção no meio de uma lista com escolhas ("mouse sem fio" + "pilha"): guarda o que não foi achado
  // para o "tenta outro modelo de mouse" seguinte continuar procurando "mouse sem fio" (rodada 2, c72).
  if (pending.length && unavailable.length === 1 && notFoundLines.length === 1 && !containsMedicine && !medicineMiss) {
    ctx.lastMiss = { query: notFoundLines[0].phrase, qty: notFoundLines[0].qty, at: Date.now() };
  }

  // "escolhe vc"/"qualquer um": a linha marcada auto-escolhe o topo do ranking, com
  // confirmação do que entrou (28/08 S6 — "escolhe vc" virava item não-achado).
  const autoPickPending = pending.filter((choice) => choice.autoPick && choice.options.length);
  if (autoPickPending.length) {
    const packNotes: string[] = [];
    const added: BasketItem[] = [];
    for (const choice of autoPickPending) {
      const top = choice.options[0];
      const store = top.storeKey ? getStore(top.storeKey) : orderStore(ctx);
      const adj = packAdjusted(top, Math.max(1, choice.qty), choice.query);
      if (adj.note) packNotes.push(adj.note);
      added.push(choiceToBasketItem(top, adj.qty, store, choice.query));
    }
    ctx.basket = mergeBaskets(ctx.basket ?? [], added);
    // "escolhe você, até R$60": o teto continua valendo para o total (rodada 2, 07/10).
    if (autoPickPending.length === 1 && autoPickPending[0].cap != null && ctx.basket.length === 1) {
      ctx.budget = { cap: autoPickPending[0].cap!, sku: ctx.basket[0].sku };
    }
    const rest = pending.filter((choice) => !autoPickPending.includes(choice));
    ctx.pending = rest.length ? rest : undefined;
    ctx.step = rest.length ? "choosing" : "collecting";
    const notes: string[] = [copy.autoAddedNote(added.map((i) => `${i.qty}x ${i.name}`)), ...packNotes];
    if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
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

  // Flow da lista (07/10, LIA_LIST_FLOW): 2+ linhas com opção viram um formulário nativo, com a
  // sugestão de cada uma já na cesta. Falha ou condição não atendida → segue o caminho de sempre.
  if (pending.length >= 2) {
    const flowNotes: string[] = [];
    if (containsMedicine) flowNotes.push(medicineSkippedCopy(prescriptionDropped));
    if (raw.containsTobacco) flowNotes.push(copy.tobaccoRefusal());
    if (await tryListFlow({ phone, convoId, userCep, ctx, pending, notFoundLines, unconfirmedSet, notes: flowNotes })) return;
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
    const composedNotes = runBasketComposer(pending);
    const autopickMax = Number(process.env.LIA_BULK_AUTOPICK_MAX ?? 100);
    // O teto vale pra LINHA (preço × quantidade após conversão de embalagem), não só
    // pra unidade — 12x de um item de R$18 entrava sozinho por R$217 (29/08 S4).
    const lineDisplayOf = (choice: PendingChoice) => {
      const top = choice.options[0];
      const adj = packAdjusted(top, Math.max(1, choice.qty), choice.query);
      return display(top.unitPrice, top.medicine) * adj.qty;
    };
    // "Mais próximo" (sem o tamanho/sabor pedido) nunca entra sozinho: o cliente escolhe.
    const auto = pending.filter((choice) => !choice.closestFalta && lineDisplayOf(choice) <= autopickMax);
    const confirm = pending.filter((choice) => !auto.includes(choice));
    const added: BasketItem[] = [];
    const packNotes: string[] = [];
    for (const choice of auto) {
      const top = choice.options[0];
      const store = top.storeKey ? getStore(top.storeKey) : orderStore(ctx);
      const adj = packAdjusted(top, Math.max(1, choice.qty), choice.query);
      if (adj.note) packNotes.push(adj.note);
      added.push(choiceToBasketItem(top, adj.qty, store, choice.query));
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
      if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
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
    if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
    if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
    if (hasNotFound) notes.push(notFoundNote(false));
    await advancePending(phone, convoId, ctx, userCep, notes.join("\n"));
    return;
  }

  if (pending.length) {
    ctx.step = "choosing";
    ctx.pending = pending;
    if (raw.lines.length >= 2) ctx.listInOneMessage = true;
    await writeCtx(convoId, ctx);
    const notes: string[] = [];
    if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
    if (raw.containsTobacco) notes.push(copy.tobaccoRefusal());
    // Os itens sem preço são recusados ANTES das opções — mas com escopo explícito:
    // "não achei X — o resto tá abaixo" (a copy global parecia contradição, 19/08).
    if (hasNotFound) notes.push(notFoundNote(true));
    if (notes.length) await reply(phone, notes.join("\n"));
    if (pending.length > 1) await reply(phone, copy.choiceSequence(pending.map(shownQuery)));
    await sendChoices(phone, pending[0]);
    return;
  }

  // Nada com preço nesta mensagem: recusa honesta na hora; a cesta que já existia fica
  // exatamente como estava.
  // Endereço já confirmado = o passo de endereço acabou (07/10: depois do 1º "não achei" no
  // cadastro o passo ficava em need_address e a próxima frase virava "Endereço salvo…").
  if (hadBasket || (ctx.deliveryAddress && ctx.deliveryAddressVerified && (ctx.step === "need_address" || ctx.step === "need_cep"))) ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  // NADA achou preço: o roteador LLM tenta entender a mensagem (pergunta? "uma 51"?
  // edição?) antes do eco de não-achado — o eco fazia "posso agendar a entrega pra…"
  // virar produto (29/08: 6 sessões nesse padrão).
  // Remédio não achado já tem resposta certa: a segunda busca pela IA só atrasava (>45 s).
  if (missCombined && prevMiss && !pending.length && !containsMedicine && !raw.containsTobacco) {
    applyListMisses(ctx, mergeListMisses(missCarry, [{ query: missCombined, qty: prevMiss.qty, reason: "not_found", at: Date.now() }]));
    await writeCtx(convoId, ctx);
    await reply(phone, copy.itemsNotAvailable([missCombined], await judgeMisses(text, [missCombined])));
    return;
  }
  if (fragmentReplaced && prevMiss && !pending.length && notFoundLines.length === 1) {
    // Busca refeita de UMA faltante que continua sem nada (Etapa 3): "continuo sem nenhuma opção" e
    // ela sai da lista (o "tenta de novo" geral segue valendo para as outras).
    applyListMisses(ctx, missCarry);
    await writeCtx(convoId, ctx);
    await reply(phone, copy.missStillNone(prevMiss.query, (await judgeMisses(text, [prevMiss.query]))?.[0]));
    return;
  }
  if (!containsMedicine && !raw.containsTobacco && !medicineMiss) {
    if (await tryLlmInterpret(phone, convoId, userCep, ctx, text, userId)) return;
    if (isQuestion(text)) {
      await reply(phone, copy.questionNotUnderstood());
      return;
    }
  }
  // Remédio pelo nome que ninguém tem (07/10, c08): depois de "remédio eu não vendo", "não achei em
  // nenhuma loja, me diz outra marca" convida a procurar à toa. Só a recusa — e sem 2ª busca.
  if (!medicineEnabled() && unavailable.length > 0 && !unbuyable.length && unavailable.every((label) => looksLikeMedicineName(label) || isPrescriptionDrugName(label))) {
    await refuseMedicine(phone, convoId, ctx);
    return;
  }
  const notes: string[] = [];
  if (containsMedicine) notes.push(medicineSkippedCopy(prescriptionDropped));
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

// ---------- Flow "Escolher minha lista" (07/10, Etapas 2 e 3) ----------
// Lista com 2+ linhas que têm opção vira UMA mensagem de formulário nativo (uma vaga por item,
// com miniaturas) em vez de uma sequência de cards. A sugestão da Lia de cada vaga já está na
// cesta (zero espera: dá pra tocar em Pagar sem abrir nada); o formulário só troca ou tira.
// Tudo atrás de LIA_LIST_FLOW=true; qualquer falha cai no modo lista/sequencial de sempre.

// LIA_LIST_FLOW=admin: só os telefones de LIA_ADMIN_PHONES/dono recebem o formulário (teste ao vivo).
function listFlowEnabled(phone: string): boolean {
  if (process.env.WHATSAPP_PROVIDER !== "meta") return false;
  const mode = process.env.LIA_LIST_FLOW;
  return mode === "true" || (mode === "admin" && isAdminPhone(phone));
}

// Foto da cesta: a resposta do formulário só vale se a cesta continua como estava quando ele foi
// enviado — qualquer edição por texto (troca, tira, quantidade, item novo) a muda e invalida o id.
function basketSignature(basket: BasketItem[] | undefined): string {
  return (basket ?? []).map((item) => `${item.sku}:${item.qty}`).sort().join("|");
}

function newListFlowId(): string {
  return `lst${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// A opção desta vaga que está na cesta agora (a sugestão ou a troca já aplicada); null = fora.
function slotCurrentSku(slot: ListFlowCtxSlot, basket: BasketItem[]): string | null {
  const inBasket = (sku: string) => basket.some((item) => item.sku === sku);
  if (slot.suggestedSku && inBasket(slot.suggestedSku)) return slot.suggestedSku;
  return slot.skus.find(inBasket) ?? null;
}

// Linha da lista com loja e prazo (09/10, dono: "na primeira mensagem já precisa vir o tempo de entrega de cada
// coisa — pode influenciar a decisão"): "Mambo · hoje, 12h–15h".
function basketLinesForCopy(basket: BasketItem[]) {
  return basket.map((item) => {
    const when = item.delivery ? compactCardDelivery(item.delivery) : "";
    const where = [item.storeLabel?.trim(), when].filter(Boolean).join(" · ");
    return { qty: item.qty, name: item.name, total: display(item.unitPrice, item.medicine) * item.qty, ...(when ? { when: where } : {}) };
  });
}

// Status das linhas que não viraram sugestão, na copy única (Etapa 3).
function missEntriesFor(listMisses: ListMiss[], slots: ListFlowCtxSlot[]): copy.MissEntry[] {
  const closest = slots
    .filter((slot) => slot.closestFalta && !slot.suggestedSku)
    .map((slot): copy.MissEntry => ({ status: "closest", label: slot.query, qty: slot.qty, falta: slot.closestFalta }));
  const gone = listMisses.map((miss): copy.MissEntry => ({ status: miss.reason, label: miss.query, qty: miss.qty }));
  return [...closest, ...gone];
}

// Monta o `data`, envia a mensagem de Flow e devolve o estado para o contexto (ou null se não
// saiu). `slots` já vem na ordem do formulário, com a sugestão (ou não) de cada vaga.
async function sendListFlowMessage(
  phone: string,
  flowId: string,
  input: {
    slots: ListFlowCtxSlot[];
    items: { qty: number; name: string; total: number }[];
    misses: copy.MissEntry[];
    notes?: string[];
    head?: "stale" | "reopen";
    thumbs?: Promise<Map<string, string>>;
  }
): Promise<ListFlowCtx | null> {
  const { LIST_FLOW_CTA, LIST_FLOW_SCREEN } = await import("@/lib/meta-setup");
  const id = newListFlowId();
  const thumbs = await (input.thumbs ?? fetchThumbs(input.slots.slice(0, LIST_FLOW_MAX_SLOTS).flatMap((slot) => slot.options)));
  const built = buildListFlowData(
    {
      listaId: id,
      slots: input.slots.map((slot) => ({
        lineKey: slot.lineKey,
        label: slot.query,
        qty: slot.qty,
        options: slot.options,
        suggestedSku: slot.suggestedSku,
        closestFalta: slot.closestFalta
      })),
      faltasTexto: input.misses.length ? copy.missesBlock(input.misses, true) : undefined,
      thumbs
    },
    (price, option) => display(price, option?.medicine)
  );
  const body = copy.listFlowIntro({
    items: input.items,
    misses: input.misses,
    notes: input.notes,
    stale: input.head === "stale",
    reopen: input.head === "reopen",
    overflowCount: built.overflow.length
  });
  markTurnReplied();
  const sent = await whatsappAdapter.sendFlowMessage(phone, { body, cta: LIST_FLOW_CTA, flowId, screen: LIST_FLOW_SCREEN, data: built.data, token: id });
  if (!sent) return null;
  const sentSlots = built.slots.map((sentSlot): ListFlowCtxSlot => {
    const slot = input.slots.find((s) => s.lineKey === sentSlot.lineKey) as ListFlowCtxSlot;
    return { ...slot, skus: sentSlot.skus, suggestedSku: sentSlot.suggestedSku, options: sentSlot.skus.map((sku) => slot.options.find((o) => o.sku === sku) as ChoiceOption) };
  });
  return { id, sentAt: Date.now(), basketSig: "", slots: sentSlots };
}

// Os botões de sempre (Pagar / Adicionar mais / Mudar minha lista) depois do formulário.
async function sendListFlowFollowUp(phone: string, body: string) {
  try {
    markTurnReplied();
    const interactive = await whatsappAdapter.sendChoiceFollowUp(phone, body, { listFlowButton: true });
    if (interactive) return;
  } catch (error) {
    console.warn("[whatsapp:list-flow:followup:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, copy.conciergeKeepAdding());
}

// Opções da linha: a versão BÁSICA primeiro (09/10 — "gin" pré-escolhia o Apogee Citrus por ser o mais barato),
// depois do mais barato ao mais caro pelo total da linha (embalagem ajustada); empate mantém o ranking.
function cheapestFirstForLine(choice: PendingChoice): ChoiceOption[] {
  const qty = Math.max(1, choice.qty);
  return choice.options
    .map((option, index) => ({ option, index, basic: variantPenalty(choice.query, option.name), total: display(option.unitPrice, option.medicine) * packAdjusted(option, qty, choice.query).qty }))
    .sort((a, b) => a.basic - b.basic || a.total - b.total || a.index - b.index)
    .map(({ option }) => option);
}

// Gatilho (handleConciergeRequest): devolve true se mandou o formulário. Só mexe no contexto
// DEPOIS de o formulário sair; sem Flow publicado, remédio isento na lista ou falha no envio, o
// chamador segue o caminho de sempre com tudo intacto.
async function tryListFlow(args: {
  phone: string;
  convoId: string;
  userCep: string | null | undefined;
  ctx: DeliveryContext;
  pending: PendingChoice[];
  notFoundLines: ParsedLine[];
  unconfirmedSet: Set<string>;
  notes: string[];
}): Promise<boolean> {
  const { phone, convoId, ctx, pending } = args;
  if (!listFlowEnabled(phone) || pending.length < 2) return false;
  // Remédio isento usa cards soltos no Meta (05/10): a lista com remédio não usa o formulário.
  if (pending.some((choice) => choice.options.some((option) => option.medicine))) return false;
  let flowId: string | null = null;
  try {
    const { activeListFlowId } = await import("@/lib/meta-setup");
    flowId = await activeListFlowId();
  } catch (error) {
    console.warn("[list-flow:id]", error instanceof Error ? error.message : error);
  }
  if (!flowId) return false;

  try {
    // Cópia: o composer reordena as opções, e se o formulário falhar o caminho antigo roda o dele.
    // Do mais barato ao mais caro (dono, 07/10): a sugestão é a mais em conta entre as aprovadas, e o
    // composer só troca se juntar entregas economizar no total.
    const lines = pending.map((choice) => ({ ...choice, options: cheapestFirstForLine(choice) }));
    const composedNotes = runBasketComposer(lines);
    // Pré-escolha do formulário (09/10): o cliente vê e troca tudo antes de pagar, então o teto é por UNIDADE
    // (R$300) com folga na linha (R$1.000) — o teto de R$100 por linha deixava "2 vodkas" (R$190) sem sugestão,
    // fora da primeira mensagem e da cesta, como se não tivesse sido pedida.
    const unitMax = Number(process.env.LIA_LIST_AUTOPICK_UNIT_MAX ?? 300);
    const lineMax = Number(process.env.LIA_LIST_AUTOPICK_LINE_MAX ?? 1000);
    const added: BasketItem[] = [];
    const packNotes: string[] = [];
    const slots: ListFlowCtxSlot[] = lines.map((choice, index) => {
      const top = choice.options[0];
      const qty = Math.max(1, choice.qty);
      const adj = packAdjusted(top, qty, choice.query);
      // "Mais próximo" ou acima do teto não entra sozinho: vaga sem sugestão ("escolha uma").
      const unit = display(top.unitPrice, top.medicine);
      const suggest = !choice.closestFalta && unit <= unitMax && unit * adj.qty <= lineMax;
      if (suggest) {
        if (adj.note) packNotes.push(adj.note);
        added.push(choiceToBasketItem(top, adj.qty, top.storeKey ? getStore(top.storeKey) : orderStore(ctx), choice.query));
      }
      return {
        lineKey: `${index}:${normalizeMsg(choice.query)}`,
        query: choice.query,
        qty,
        skus: choice.options.slice(0, LIST_FLOW_MAX_OPTIONS).map((o) => o.sku),
        suggestedSku: suggest ? top.sku : null,
        options: choice.options.slice(0, LIST_FLOW_MAX_OPTIONS),
        ...(choice.options.length > LIST_FLOW_MAX_OPTIONS ? { extraOptions: choice.options.slice(LIST_FLOW_MAX_OPTIONS, LIST_FLOW_MAX_OPTIONS + 8) } : {}),
        ...(choice.closestFalta ? { closestFalta: choice.closestFalta } : {})
      };
    });
    // O que precisa de escolha vem primeiro: só as 15 primeiras vagas cabem no formulário.
    const ordered = [...slots.filter((s) => !s.suggestedSku), ...slots.filter((s) => s.suggestedSku)];
    if (slots.filter((s) => !s.suggestedSku).length > LIST_FLOW_MAX_SLOTS) return false;

    const misses = missEntriesFor(
      args.notFoundLines.map((line): ListMiss => ({
        query: line.phrase,
        qty: line.qty,
        reason: args.unconfirmedSet.has(normalizeMsg(line.phrase)) ? "unbuyable" : "not_found",
        at: Date.now()
      })),
      ordered
    );
    const thumbs = fetchThumbs(ordered.slice(0, LIST_FLOW_MAX_SLOTS).flatMap((slot) => slot.options));
    // Uma mensagem só (dono, 07/10): "juntei entregas" e aviso de embalagem vão no corpo do formulário.
    const sent = await sendListFlowMessage(phone, flowId, {
      slots: ordered,
      items: basketLinesForCopy(added),
      misses,
      notes: [...args.notes, ...composedNotes, ...packNotes],
      thumbs
    });
    if (!sent) return false;

    ctx.basket = mergeBaskets(ctx.basket ?? [], added);
    ctx.pending = undefined;
    ctx.step = "collecting";
    ctx.listFlow = { ...sent, basketSig: basketSignature(ctx.basket) };
    await writeCtx(convoId, ctx);
    await sendListFlowFollowUp(phone, copy.listFlowFollowUp());
    return true;
  } catch (error) {
    if (error instanceof TurnSupersededError) throw error;
    console.warn("[list-flow:send-failed:fallback]", error instanceof Error ? error.message : error);
    return false;
  }
}

// Reenvia o formulário com o estado atual da cesta ("Mudar minha lista" ou resposta de uma
// lista que já mudou). False = não deu (sem formulário ativo, lista fechada, Flow fora do ar).
async function reshowListFlow(phone: string, convoId: string, ctx: DeliveryContext, head: "stale" | "reopen"): Promise<boolean> {
  const lf = ctx.listFlow;
  if (!lf || !listFlowEnabled(phone) || ctx.step !== "collecting") return false;
  try {
    const { activeListFlowId } = await import("@/lib/meta-setup");
    const flowId = await activeListFlowId();
    if (!flowId) return false;
    const basket = ctx.basket ?? [];
    const slots = lf.slots.map((slot) => ({ ...slot, suggestedSku: slotCurrentSku(slot, basket) }));
    const inSlots = new Set(slots.flatMap((slot) => (slot.suggestedSku ? [slot.suggestedSku] : [])));
    const sent = await sendListFlowMessage(phone, flowId, {
      slots,
      items: basketLinesForCopy(basket.filter((item) => inSlots.has(item.sku))),
      misses: missEntriesFor(freshListMisses(ctx), slots),
      head
    });
    if (!sent) return false;
    ctx.listFlow = { ...sent, basketSig: basketSignature(basket) };
    await writeCtx(convoId, ctx);
    await sendListFlowFollowUp(phone, copy.listFlowFollowUp());
    return true;
  } catch (error) {
    if (error instanceof TurnSupersededError) throw error;
    console.warn("[list-flow:reshow-failed]", error instanceof Error ? error.message : error);
    return false;
  }
}

// Resposta do formulário (nfm_reply com `lia_lista`). Vale só se o id é o do último formulário e
// a cesta continua como estava; senão a Lia diz que a lista mudou e manda o formulário atual.
async function handleListFlowReply(
  phone: string,
  payload: Record<string, unknown>,
  user: Awaited<ReturnType<typeof getOrCreateConvo>>["user"],
  convo: Awaited<ReturnType<typeof getOrCreateConvo>>["convo"]
) {
  const ctx = readCtx(convo.context);
  const lf = ctx.listFlow;
  const id = String(payload.lia_lista ?? "");
  const current = lf && lf.id === id && ctx.step === "collecting" && basketSignature(ctx.basket) === lf.basketSig;
  if (!current) {
    if (lf && ctx.step === "collecting" && (await reshowListFlow(phone, convo.id, ctx, "stale"))) return;
    await reply(phone, copy.listFlowClosed());
    return;
  }

  const parsed = parseListFlowReply(payload, lf.slots);
  let basket = (ctx.basket ?? []).map((item) => ({ ...item }));
  const leftOut: string[] = [];
  const packNotes: string[] = [];
  const slots = lf.slots.map((slot) => ({ ...slot }));
  const wantMore: ListFlowCtxSlot[] = [];
  slots.forEach((slot, index) => {
    const choice = parsed.choices[index];
    const currentSku = slot.suggestedSku;
    if (choice.kind === "more") {
      if (currentSku) basket = basket.filter((item) => item.sku !== currentSku);
      slot.suggestedSku = null;
      wantMore.push(slot);
      return;
    }
    if (choice.kind === "skip") {
      if (currentSku) basket = basket.filter((item) => item.sku !== currentSku);
      slot.suggestedSku = null;
      return;
    }
    if (choice.kind === "pick") {
      const option = slot.options.find((o) => o.sku === choice.sku);
      if (option) {
        if (currentSku) basket = basket.filter((item) => item.sku !== currentSku);
        const adj = packAdjusted(option, slot.qty, slot.query);
        if (adj.note) packNotes.push(adj.note);
        basket = mergeBaskets(basket, [choiceToBasketItem(option, adj.qty, option.storeKey ? getStore(option.storeKey) : orderStore(ctx), slot.query)]);
        slot.suggestedSku = option.sku;
        return;
      }
    }
    if (!currentSku) leftOut.push(slot.query);
  });

  ctx.basket = basket;
  ctx.step = "collecting";
  // "Nenhuma — ver outras": a vaga sai do formulário e vira escolha por cards (abaixo).
  const keptSlots = slots.filter((slot) => !wantMore.includes(slot));
  // O id gira: reenviar a mesma resposta depois cai em "essa lista mudou" e mostra o estado atual.
  ctx.listFlow = { ...lf, id: newListFlowId(), sentAt: Date.now(), slots: keptSlots, basketSig: basketSignature(basket) };
  const summaryFor = (moreFor: string[]) =>
    copy.listFlowDone({
      items: basketLinesForCopy(basket),
      leftOut,
      misses: missEntriesFor(freshListMisses(ctx), []),
      produtos: Math.round(basket.reduce((sum, item) => sum + display(item.unitPrice, item.medicine) * item.qty, 0) * 100) / 100,
      moreFor
    });
  if (wantMore.length) {
    await showListFlowMoreOptions(phone, convo.id, ctx, wantMore, (moreFor) => [summaryFor(moreFor), ...packNotes].join("\n"));
    return;
  }
  const summary = summaryFor([]);
  if (!basket.length) {
    await writeCtx(convo.id, ctx);
    await reply(phone, summary);
    await reply(phone, copy.askMoreItems());
    return;
  }
  await advancePending(phone, convo.id, ctx, user.cep, [summary, ...packNotes].join("\n"), { listFlowButton: true });
}

// "Nenhuma — ver outras" (dono, 07/10): cada vaga marcada assim vira uma escolha por cards, com
// as opções aprovadas que não couberam na tela; sem elas, a mesma busca do "outras" (sem repetir
// o que a tela mostrou). Item sem nenhuma outra opção fica fora da lista, com aviso.
async function showListFlowMoreOptions(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  wanted: ListFlowCtxSlot[],
  summaryFor: (moreFor: string[]) => string
) {
  const limit = vitrineLimit();
  const choices = await Promise.all(
    wanted.map(async (slot): Promise<PendingChoice | null> => {
      const base: PendingChoice = { query: slot.query, qty: slot.qty, qtyExplicit: true, options: slot.options, shownSkus: slot.skus, shownOptions: slot.options };
      let next = (slot.extraOptions ?? []).filter((o) => !slot.skus.includes(o.sku)).slice(0, limit);
      if (!next.length) {
        try {
          // As opções da tela vêm de várias lojas: a busca de outras também (sem storeKey = todas).
          const store = getStore(slot.options[0]?.storeKey ?? orderStore(ctx).key);
          const pool = (await choiceCandidates(store, { ...ctx, storeKey: undefined }, base)).filter((o) => !slot.skus.includes(o.sku));
          next = cheapestFirstForLine({ ...base, options: pool }).slice(0, limit);
        } catch (error) {
          console.warn("[list-flow:more-options:search-failed]", error instanceof Error ? error.message : error);
        }
      }
      if (!next.length) return null;
      return { ...base, options: next, cheapestFirst: true, shownSkus: [...slot.skus, ...next.map((o) => o.sku)], shownOptions: [...slot.options, ...next] };
    })
  );
  const ready = choices.filter((choice): choice is PendingChoice => Boolean(choice));
  const none = wanted.filter((_, index) => !choices[index]).map((slot) => slot.query);
  const head = [summaryFor(ready.map((choice) => choice.query)), none.length ? copy.listFlowNoOtherOptions(none) : ""].filter(Boolean).join("\n\n");
  if (!ready.length && !ctx.basket?.length) {
    await writeCtx(convoId, ctx);
    await reply(phone, head);
    await reply(phone, copy.askMoreItems());
    return;
  }
  if (!ready.length) {
    await advancePending(phone, convoId, ctx, ctx.cep, head, { listFlowButton: true });
    return;
  }
  ctx.pending = [...ready, ...(ctx.pending ?? [])];
  ctx.step = "choosing";
  await writeCtx(convoId, ctx);
  await reply(phone, head);
  await sendChoices(phone, ready[0], copy.moreChoicesHeader(ready[0].query));
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
    if (rescued.length > 1) await reply(phone, copy.choiceSequence(rescued.map(shownQuery)));
    await sendChoices(phone, rescued[0]);
    return;
  }
  if (ctx.basket?.length) ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  await reply(phone, copy.itemsNotAvailable(unavailable, await judgeMisses(retryText, unavailable)));
}

// Presente sem produto (06/10, A7): "um presente pra minha mãe de 60 anos" chegava à busca
// como frase e virava sacola de presente ou "não achei". Sem nenhum produto na frase, vira a
// categoria comum de presente para quem recebe. Com produto ("perfume pra minha mãe"), nada muda.
const GIFT_FEMALE_RE = /\b(mae|mamae|esposa|namorada|noiva|tia|irma|sogra|amiga|mulher|madrinha|professora|chefe)\b/;
const GIFT_MALE_RE = /\b(pai|papai|marido|namorado|noivo|tio|irmao|sogro|amigo|homem|padrinho|professor)\b/;
const GIFT_CHILD_RE = /\b(menino|menina|crianca|filho|filha|neto|neta|sobrinho|sobrinha|bebe|afilhado|afilhada)\b/;
const GIFT_FILLER = new Set(["presente", "presentinho", "lembrancinha", "aniversario", "um", "uma", "pra", "para", "pro", "minha", "meu", "de", "do", "da", "dia", "das", "dos", "anos", "ano", "com", "que", "e", "o", "a", "quero", "algo", "alguma", "coisa", "legal", "bonito", "bom", "boa", "natal", "mes", "mais"]);
export function giftSearchPhrase(phrase: string): string | null {
  const norm = normalizeMsg(phrase);
  if (!/\b(presente|presentinho|lembrancinha)\b/.test(norm)) return null;
  const leftover = norm.split(/\s+/).filter((w) => w && !GIFT_FILLER.has(w) && !/^\d+$/.test(w) && !GIFT_FEMALE_RE.test(w) && !GIFT_MALE_RE.test(w) && !GIFT_CHILD_RE.test(w));
  if (leftover.length) return null;
  const age = norm.match(/\b(\d{1,2})\s*anos?\b/)?.[1];
  if (GIFT_CHILD_RE.test(norm) || (age && Number(age) <= 12)) {
    const who = /\b(menina|filha|neta|sobrinha|afilhada)\b/.test(norm) ? "menina" : "menino";
    return `brinquedo ${who}${age ? ` ${age} anos` : ""}`;
  }
  if (GIFT_FEMALE_RE.test(norm)) return "perfume feminino";
  if (GIFT_MALE_RE.test(norm)) return "perfume masculino";
  return null;
}

// "pack de cerveja brahma 12 latas", "fardo de água", "engradado de heineken" (06/10, A5).
export function parsePackAsk(phrase: string): { core: string; brand?: string; count?: number } | null {
  return parsePackPhrase(phrase);
}
function isPackItem(name: string): boolean {
  return /\b(fardo|pack|engradado|caixa com|kit)\b/i.test(name) || declaredPack(name) >= 4 || /\bc\/\s*\d+/i.test(name);
}

// "2 litros de leite" (06/10, A9): sem embalagem de 2 L entre os produtos certos, mas com a de
// 1 L, o pedido vira 2 × 1 L (o parser montava "leite 2litros" e a busca não achava nada).
// Vale para volume e peso inteiros (2 L, 3 kg) e só com a unidade de 1 (L ou kg).
export function splitBySize(sizeAsk: string, items: { name: string; brand?: string; sku: string; unitPrice: number }[]): { unit: string; count: number } | null {
  const m = sizeAsk.toLowerCase().replace(/\s+/g, "").match(/^(\d+)(kg|l|lt|lts|litros?)$/);
  if (!m) return null;
  const count = Number(m[1]);
  if (!(count >= 2 && count <= 12)) return null;
  const unit = m[2] === "kg" ? "1kg" : "1l";
  return items.some((item) => attrMatchesItem(unit, item)) ? { unit, count } : null;
}

// "12 ovos" quando o produto é "Ovos ... 10 Unidades": a quantidade pedida é em
// UNIDADES, não embalagens — converte pra embalagens e ANUNCIA (28/08 S9: viraram 12
// caixas de 10 = 120 ovos por R$118).
// 06/10 (A4/M6): arredonda para CIMA (12 ovos = 2 caixas de 10, nunca 10 ovos) e converte
// também quando o pedido é MENOR que a caixa, se o número conta o próprio conteúdo da
// embalagem ("6 ovos", "meia dúzia de ovos" com caixa de 10 = 1 caixa, não 6).
// 06/10 (A3): item vendido por peso ("2kg de banana", unidade de ~180 g) = 11 unidades.
const PACK_CONTENT_NOUN_RE = /\b(ovos?|rolos?|pilhas?|fraldas?|c[aá]psulas?|sach[eê]s?|saquinhos?|comprimidos?|len[cç]os?|latas?|latinhas?|garrafas?|long ?necks?)\b/i;
export function parseWeightAskKg(query: string): number | undefined {
  const t = normalizeMsg(query);
  if (/\bmei[oa] (quilo|kg|kilo)\b/.test(t)) return 0.5;
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|quilos?|kilos?|g|gramas?|gr)\b/);
  if (!m) return undefined;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return /^(g|gramas?|gr)$/.test(m[2]) ? value / 1000 : value;
}
// Quantas unidades a embalagem declara no nome ("com 10 Unidades", "Pack 12 Latas", "dúzia").
export function declaredPack(optionName: string): number {
  const m = optionName.match(/(\d{1,3})\s*(?:und?s?\b|unid(?:ades)?\b|ovos\b|rolos\b|latas\b|garrafas\b|fraldas\b|c[aá]psulas\b|sach[eê]s\b|saquinhos\b)/i);
  return m ? Number(m[1]) : /\bmeia\s+d[uú]zia\b/i.test(optionName) ? 6 : /\bd[uú]zia\b/i.test(optionName) ? 12 : 0;
}
// O pedido conta o CONTEÚDO ("6 ovos", "12 rolos") e não embalagens ("2 caixas de ovos").
function countsPackContent(query: string | undefined): boolean {
  return Boolean(query && PACK_CONTENT_NOUN_RE.test(query) && !/\b(caixas?|cartelas?|bandejas?|pacotes?|embalage[nm]s?|fardos?|packs?)\b/i.test(query));
}
// "12 ovos" / "30 ovos" (06/10, A4): a embalagem que bate EXATO com o pedido vai na frente.
function exactPackFirst<T extends { name: string }>(query: string, qty: number, items: T[]): T[] {
  if (qty < 4 || !countsPackContent(query)) return items;
  const exact = items.filter((item) => declaredPack(item.name) === qty);
  return exact.length ? [...exact, ...items.filter((item) => !exact.includes(item))] : items;
}
export function packAdjusted(
  option: string | { name: string; unitWeightKg?: number },
  qty: number,
  query?: string,
  opts?: { assumedOne?: boolean }
): { qty: number; note?: string } {
  const optionName = typeof option === "string" ? option : option.name;
  const unitKg = typeof option === "string" ? undefined : option.unitWeightKg;
  const askedKg = unitKg && query ? parseWeightAskKg(query) : undefined;
  if (unitKg && askedKg) {
    const units = Math.max(1, Math.round((askedKg / unitKg) * Math.max(1, qty)));
    return { qty: units, note: copy.weightConversionNote(askedKg * Math.max(1, qty), unitKg, units) };
  }
  if (opts?.assumedOne) return { qty };
  const pack = declaredPack(optionName);
  const countsContent = countsPackContent(query);
  if (pack >= 4 && (qty >= pack || (countsContent && qty > 1 && qty < pack && (!/\bfraldas?\b/i.test(query ?? "") || qty > 5)))) {
    const packs = Math.max(1, Math.ceil(qty / pack));
    return { qty: packs, note: copy.packConversionNote(qty, pack, packs) };
  }
  return { qty };
}

// Pré-voo barrou a cobrança (04/09): o pedido fechou sem cobrar; o resto da cesta volta
// pro contexto e os itens que a loja não tem são buscados de novo — a verificação ao vivo
// tira a loja que falhou e mostra só o que está confirmado para o CEP.
// Ensaio da compra recusou a entrega/endereço/preço (08/10 noite): nada cobrado, a cesta inteira volta
// para o cliente e a Lia REFAZ A COTAÇÃO NO MESMO TURNO (simulação com as mesmas coordenadas da compra →
// a entrega/preço que a loja confirma). Endereço recusado: pede o endereço de novo antes de cotar.
// Loop impossível: a 2ª recusa seguida da MESMA loja com os mesmos itens tira a loja do caminho e busca o
// item em outra (como o pré-voo faz com item sem estoque).
async function handleDeliveryNotConfirmed(
  phone: string,
  convoId: string,
  user: { id: string; cep: string | null },
  ctx: DeliveryContext,
  info: { storeKey: string; storeLabel: string; promise?: string; kind: "items" | "delivery" | "address" | "price" | "checkout"; basket: BasketItem[] }
) {
  const basket = info.basket.filter((item) => item.unitPrice > 0);
  const skus = basket.filter((item) => item.storeKey === info.storeKey).map((item) => item.sku).sort();
  // Recusa anterior conta por 2 h: a mesma loja/itens recusados ontem são outra história.
  const prior = ctx.rehearsalRefused && Date.now() - ctx.rehearsalRefused.at < 2 * 3_600_000 ? ctx.rehearsalRefused : undefined;
  const repeated = Boolean(prior && prior.storeKey === info.storeKey && prior.skus.join("|") === skus.join("|") && info.kind !== "address");
  if (repeated && skus.length) {
    const failed = basket.filter((item) => item.storeKey === info.storeKey);
    await handlePreflightUnavailable(
      phone,
      convoId,
      user,
      { ...ctx, rehearsalRefused: undefined },
      { storeLabel: info.storeLabel, items: failed, remaining: basket.filter((item) => item.storeKey !== info.storeKey) },
      copy.rehearsalGaveUpStore(failed.map((i) => i.name), info.storeLabel)
    );
    return;
  }
  const next: DeliveryContext = {
    ...addressOnlyCtx(ctx, user.cep),
    step: "collecting",
    basket,
    ...(ctx.recipientName ? { recipientName: ctx.recipientName } : {}),
    rehearsalRefused: { storeKey: info.storeKey, skus, count: (prior?.storeKey === info.storeKey ? prior.count : 0) + 1, at: Date.now() }
  };
  if (info.kind === "address") {
    next.deliveryAddressVerified = false;
    await writeCtx(convoId, next);
    await reply(phone, copy.deliveryNotConfirmed(info.storeLabel, info.promise, info.kind));
    await continueAfterBasket(phone, convoId, next, user.cep);
    return;
  }
  await writeCtx(convoId, next);
  await continueAfterBasket(phone, convoId, next, user.cep, copy.deliveryNotConfirmed(info.storeLabel, info.promise, info.kind));
}

// Cobrança aberta (awaiting_payment) prestes a ser reemitida/reenviada: a loja é consultada de novo
// (pré-voo + ensaio). Bloqueio = pedido fechado sem dinheiro e a lista volta pro cliente. true = o turno
// foi resolvido aqui; false = pode reemitir/reenviar.
async function guardOpenCharge(
  phone: string,
  convoId: string,
  user: { id: string; cep: string | null },
  ctx: DeliveryContext,
  order: Parameters<typeof recheckOpenCharge>[0]
): Promise<boolean> {
  const block = await recheckOpenCharge(order).catch((error) => {
    console.warn("[recheck-open-charge:error]", order.id, error instanceof Error ? error.message : error);
    return null;
  });
  if (!block) return false;
  if ("unavailable" in block) await handlePreflightUnavailable(phone, convoId, user, ctx, block.unavailable);
  else await handleDeliveryNotConfirmed(phone, convoId, user, ctx, block.deliveryNotConfirmed);
  return true;
}

async function handlePreflightUnavailable(
  phone: string,
  convoId: string,
  user: { id: string; cep: string | null },
  ctx: DeliveryContext,
  unavailable: { storeLabel: string; items: BasketItem[]; remaining: BasketItem[]; intro?: string },
  intro?: string
) {
  const next: DeliveryContext = { ...addressOnlyCtx(ctx, user.cep), basket: unavailable.remaining };
  await writeCtx(convoId, next);
  await reply(phone, intro ?? unavailable.intro ?? copy.preflightUnavailable(unavailable.items.map((i) => i.name), unavailable.storeLabel));
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
  return [...fromAuto, ...result.pending.filter((p) => !p.closestFalta).flatMap((p) => p.options)];
}

// Placar da busca: igual ao plano B, mas devolve à parte o que a Lia mostraria COMO "mais
// próximo" (com aviso da diferença) — não entra na conta de acerto, só é contado.
export async function searchOptionsForBench(query: string, cep: string): Promise<{ options: ChoiceOption[]; closest: ChoiceOption[] }> {
  const result = await buildChoices(query, undefined, undefined, undefined, false, cep);
  const fromAuto: ChoiceOption[] = result.autoAdded.map((b) => ({
    sku: b.sku, name: b.name, brand: b.brand, unitPrice: b.unitPrice, productUrl: b.productUrl, storeKey: b.storeKey, storeLabel: b.storeLabel, freeShipping: b.freeShipping
  }));
  return {
    options: [...fromAuto, ...result.pending.filter((p) => !p.closestFalta).flatMap((p) => p.options)],
    closest: result.pending.filter((p) => p.closestFalta).flatMap((p) => p.options)
  };
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
  // Item novo com o total na mesa (06/10): TODO caminho que busca reabre o pedido antes. O
  // roteador da IA ("e também um sabonete" → "sabonete") buscava direto e a cotação nova saía
  // só com o sabonete — o arroz sumia. Cobrança Pix aberta não entra aqui (tem bloco próprio).
  if (ctx.deliveryOrderId && (ctx.step === "awaiting_quote_confirmation" || ctx.step === "choosing_freight")) {
    await reopenOrderForEdit(phone, convoId, ctx, userCep);
  }
  // Pergunta do CNPJ junto com o pedido (07/10, c13): responde e segue só com o pedido.
  const fiscal = splitFiscalClause(text);
  if (fiscal.asked) {
    const businessInfo = process.env.LIA_BUSINESS_INFO?.trim() || undefined;
    await reply(phone, copy.fiscalAnswer("cnpj", businessInfo, withinOperatorHours()));
    if (!businessInfo) await notifyOwner(`📇 Cliente pediu o CNPJ/dados da empresa junto com um pedido — enviar manualmente (configure LIA_BUSINESS_INFO).`, phone);
    text = fiscal.text;
  }
  // Recomendação (08/10, plano-recomendacoes): necessidade/estado/ocasião/sintoma/presente ("tô com
  // fome, quero algo doce", "dor de barriga", "presente pra minha mãe") ou produto + julgamento ("me
  // recomenda um chocolate bom") vira cards de prateleiras distintas. Produto nomeado sem julgamento
  // ("quero chocolate") nunca entra aqui (detect devolve null) e segue a busca de sempre.
  if (recommendEnabled()) {
    const rec = detectRecommendation(text, { hasPendingChoice: Boolean(ctx.pending?.length), basketNames: ctx.basket?.map((b) => b.name) });
    if (rec) {
      await handleRecommend({ phone, convoId, userId, userCep, ctx }, rec);
      return;
    }
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
const NOT_A_NAME_RE =
  /\b(pix|cart[aã]o|cartao|credito|debito|boleto|dinheiro|pagar|pago|paguei|pagamento|cancela\w*|desisto|desisti|sim|nao|ok|blz|beleza|oi|ola|obrigad\w*|valeu|tchau|quanto|qual|quero|pedido|frete|total|endereco|cep|ajuda|atendente|humano)\b/;
// Frete ao vivo por loja que a conversa já conhece: lojas das opções na mesa e das já
// escolhidas (a cesta não guarda o frete; a opção escolhida, sim).
function knownStoreFees(ctx: DeliveryContext): { storeLabel: string; fee: number }[] {
  const options = [
    ...(ctx.pending ?? []).flatMap((p) => [...p.options, ...(p.shownOptions ?? [])]),
    ...(ctx.lastChoice ? [...ctx.lastChoice.options, ...(ctx.lastChoice.shownOptions ?? [])] : [])
  ];
  const inBasket = new Set((ctx.basket ?? []).map((i) => i.storeKey));
  const onTable = new Set((ctx.pending?.[0]?.options ?? []).map((o) => o.storeKey));
  const byStore = new Map<string, number>();
  for (const o of options) {
    if (o.freightFee == null || !o.storeLabel || !o.storeKey) continue;
    if (!inBasket.has(o.storeKey) && !onTable.has(o.storeKey)) continue;
    const prev = byStore.get(o.storeLabel);
    if (prev == null || o.freightFee < prev) byStore.set(o.storeLabel, o.freightFee);
  }
  return [...byStore].map(([storeLabel, fee]) => ({ storeLabel, fee }));
}

// Resposta ao "nome completo e CPF" do cadastro que só tem o nome: 2 a 5 palavras, sem
// número, sem verbo de pedido. "leite ninho" passa no extractFullName; por isso o filtro.
// Nome de gente sem sinal de produto: 1ª palavra é um primeiro nome comum do Brasil ("rafael torres", "Ana Souza").
// Mais estrito que looksLikeOnboardingName, porque "leite ninho" também parece nome (rodada 4, M4).
const COMMON_FIRST_NAMES = new Set(("ana maria joao jose pedro paulo carlos lucas luiz luis marcos marcelo rafael rodrigo fernando fabio felipe filipe gabriel gustavo daniel diego bruno " +
  "eduardo andre antonio ricardo renato roberto sergio thiago tiago vinicius victor vitor leonardo leandro mateus matheus henrique igor julio juliana julia fernanda patricia camila amanda " +
  "aline bruna carolina carla claudia cristina daniela debora denise eliane elaine fabiana flavia gabriela helena isabela isabel jessica joana juliane karen larissa leticia luciana luana " +
  "marcia mariana marina michele monica natalia paula priscila rafaela renata roberta sandra simone sonia tatiana vanessa vera viviane beatriz bianca clara eduarda laura livia manuela " +
  "alexandre alessandra adriana adriano alan alberto alex augusto caio cesar cleber davi edson elias emerson enzo erick fabricio francisco geraldo guilherme heitor hugo ivan jair jorge " +
  "joaquim jonas kleber leo lorena lucia luciano manoel mario mauricio miguel murilo nelson nicolas otavio rogerio ronaldo samuel sebastiao silvio valter wagner wellington william yuri " +
  "regina rosana rosangela rita silvia solange sueli teresa tereza valeria vitoria zilda").split(" "));
export function looksLikeBareFirstNameFullName(text: string): boolean {
  if (!looksLikeOnboardingName(text)) return false;
  const first = normalizeMsg(text).split(" ")[0] ?? "";
  return COMMON_FIRST_NAMES.has(first);
}

export function looksLikeOnboardingName(text: string): boolean {
  if (/\d/.test(text) || !extractFullName(text)) return false;
  const n = normalizeMsg(text);
  const words = n.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (/\b(quero|queria|preciso|precisava|manda|compra|comprar|tem|vende|pedido|pedir|oi|ola|bom|boa|tudo|obrigad\w*|cpf|sim|nao|ok)\b/.test(n)) return false;
  return !parseAvailabilityAsk(text);
}

export function parseRecipientName(text: string): string | null {
  let clean = text.replace(/\s+/g, " ").trim();
  // "é pra Joana" tira as duas palavras, não só o "é".
  for (let prev = ""; prev !== clean; ) {
    prev = clean;
    clean = clean.replace(/^(é|eh|e|o nome é|nome:|pra|para|entrega pra|entregar pra)\s+/i, "");
  }
  if (!/^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(clean) || clean.split(" ").length > 6) return null;
  // Palavra de comando não é nome (testadores 06/10: "pix" virou "Entrega em nome de *Pix*").
  if (NOT_A_NAME_RE.test(normalizeMsg(clean))) return null;
  return clean
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
// ---------- complemento no fechamento (08/10, recomendação fase 4) ----------

// Fechou a lista ("só isso", "pagar", "o 1 e pode fechar"): antes do total, UMA oferta do que costuma
// ir junto (recommend/complement.ts + o funil da recomendação no CEP). Só uma vez por pedido, nunca com
// remédio na cesta, nunca com teto de orçamento valendo, no máximo 4 s; sem item comprável segue calado.
async function closeListOrOfferComplement(phone: string, convoId: string, ctx: DeliveryContext, userCep: string | null | undefined, userId?: string, prefix?: string) {
  if (await maybeOfferComplement(phone, convoId, ctx, userCep, userId, prefix)) return;
  await continueAfterBasket(phone, convoId, ctx, userCep, prefix);
}

async function maybeOfferComplement(phone: string, convoId: string, ctx: DeliveryContext, userCep: string | null | undefined, userId?: string, prefix?: string): Promise<boolean> {
  if (!complementEnabled()) return false;
  const basket = ctx.basket ?? [];
  const cep = ctx.cep ?? userCep;
  if (!basket.length || ctx.pending?.length || !cep || ctx.deliveryOrderId || ctx.budget || ctx.repeatConfirm) return false;
  if (ctx.step && ctx.step !== "collecting" && ctx.step !== "choosing") return false;
  if (hasMip(basket)) return false;
  // Já perguntou neste pedido (a cesta ainda tem algum item de quando perguntou).
  if (ctx.complementAsked?.skus.some((sku) => basket.some((b) => b.sku === sku))) return false;
  ctx.complementAsked = { skus: basket.map((b) => b.sku), at: Date.now() };
  const found = await findComplement({ cep, basket, declined: ctx.complementDeclined, ...(userId ? { userId } : {}) }).catch(() => null);
  if (!found) {
    await writeCtx(convoId, ctx);
    return false;
  }
  const logId = await recordComplementOffer({ phone, ...(userId ? { userId } : {}) }, found);
  ctx.complementOffer = {
    option: found.option,
    query: found.suggestion.query,
    shelfId: found.suggestion.shelfId,
    why: found.suggestion.why,
    trigger: found.suggestion.trigger,
    ...(logId ? { logId } : {}),
    at: Date.now()
  };
  ctx.step = "collecting";
  await writeCtx(convoId, ctx);
  if (prefix) await reply(phone, prefix);
  const body = copy.complementOffer(found.option.name, display(found.option.unitPrice, found.option.medicine), found.suggestion.why);
  // Botões sim/não no canal Meta (o toque volta como `complemento_sim`/`complemento_nao`). O adaptador
  // não tem método próprio de sim/não para o cliente: `sendOperatorButtons` é o envio genérico de botões
  // (ids livres; só `op1.…` é rota do operador). Fora do Meta, o texto já pede "sim ou não".
  if (process.env.WHATSAPP_PROVIDER === "meta") {
    try {
      markTurnReplied();
      const sent = await whatsappAdapter.sendOperatorButtons(phone, body, [
        { id: "complemento_sim", title: "Sim, adiciona" },
        { id: "complemento_nao", title: "Não, só isso" }
      ]);
      if (sent) return true;
    } catch (error) {
      console.warn("[whatsapp:complement:fallback-text]", error instanceof Error ? error.message : error);
    }
  }
  await reply(phone, body);
  return true;
}

// Resposta à oferta. "sim" → entra na cesta e segue pro total; "não"/"só isso"/"pix" → total sem
// insistir. Qualquer OUTRA mensagem conta como recusa e segue o fluxo normal (decisão 08/10: "ah, e
// uma coca" tem que entrar na cesta, não ir pro total) — o próximo "só isso" não pergunta de novo.
async function handleComplementAnswer(
  phone: string,
  convoId: string,
  user: { id: string; cep: string | null },
  ctx: DeliveryContext,
  text: string,
  intent: Intent
): Promise<boolean> {
  const offer = ctx.complementOffer!;
  ctx.complementOffer = undefined;
  const stale = Date.now() - offer.at > 30 * 60_000 || !ctx.basket?.length || Boolean(ctx.pending?.length) || (ctx.step != null && ctx.step !== "collecting");
  if (stale) {
    await writeCtx(convoId, ctx);
    return false;
  }
  const n = normalizeMsg(text);
  const closing = intent.kind === "done" || intent.kind === "pay" || intent.kind === "choose_payment" || /\b(fecha\w*|so isso|pagar|paga|total)\b/.test(n);
  // "sim, pode fechar" = adiciona e fecha; "pode fechar"/"ok, fecha" sozinho = fecha sem o item.
  const yes =
    n === "complemento_sim" ||
    (n.length <= 40 && !/\bnao\b/.test(n) && /^(sim|s|ss|claro|aceito|uhum|opa)\b/.test(n)) ||
    // "quero"/"bota" só sozinhos ou com enfeite — "quero um refri também" é pedido novo, não o "sim".
    /^(quero|manda|bota|coloca|adiciona|acrescenta|pode adicionar|pode colocar|pode por)( (sim|ele|esse|essa|isso|tambem|pode|por favor|pf|pfv|entao|ai|junto))*$/.test(n) ||
    (!closing && (intent.kind === "affirm" || (n.length <= 30 && !/\bnao\b/.test(n) && /^(pode|ok|isso|beleza|blz|bora|vai)\b/.test(n))));
  const no =
    !yes &&
    (n === "complemento_nao" ||
      closing ||
      // "cancela" seco com o complemento na tela (09/10, rodada 1) recusa a oferta; não apaga a cesta.
      (intent.kind === "cancel" && !intent.explicitOrder && n.split(" ").length <= 2) ||
      intent.kind === "reject" ||
      (n.length <= 40 && /^(nao|n|nn|dispenso|deixa|so isso|obrigad\w*|valeu|nem|agora nao|dessa vez nao|nao precisa|nao quero)\b/.test(n)));
  if (yes) {
    const store = getStore(offer.option.storeKey ?? orderStore(ctx).key);
    ctx.basket = mergeBaskets(ctx.basket ?? [], [choiceToBasketItem(offer.option, 1, store, offer.query)]);
    await markComplementOutcome(offer.logId, "accepted", `${offer.option.storeKey ?? ""}:${offer.option.sku}`);
    await writeCtx(convoId, ctx);
    await continueAfterBasket(phone, convoId, ctx, user.cep, copy.complementAdded(offer.option.name));
    return true;
  }
  ctx.complementDeclined = [...new Set([...(ctx.complementDeclined ?? []), offer.query, offer.shelfId])].slice(-20);
  await markComplementOutcome(offer.logId, "declined");
  await writeCtx(convoId, ctx);
  if (no) {
    await continueAfterBasket(phone, convoId, ctx, user.cep);
    return true;
  }
  return false;
}

// ---------- memória do cliente (08/10, recomendação fase 2) ----------

// Declaração sobre si: grava (com data, sem duplicar). Mensagem que é SÓ a declaração, de cliente com
// endereço, recebe "Anotado…"; junto de um pedido, grava e o pedido segue sem resposta extra (a
// recomendação deste mesmo turno já lê a memória nova). "esquece minhas preferências" apaga tudo;
// "não sou mais vegano"/"voltei a comer carne" tira só aquela.
async function handlePreferenceStatement(
  phone: string,
  convoId: string,
  user: { id: string; defaultAddress: string | null },
  ctx: DeliveryContext,
  text: string
): Promise<boolean> {
  // Memória faz parte da recomendação: em LIA_RECOMMEND=test só dono/admins (08/10, noite).
  if (!recommendEnabled()) return false;
  if (ctx.step === "need_cpf" || ctx.step === "need_recipient_name") return false;
  const forget = parseForget(text);
  if (forget) {
    const { removed } = "all" in forget ? await forgetPreferences(user.id) : await forgetPreferences(user.id, { keys: forget.keys, ...(forget.pet ? { pet: true } : {}) });
    if ("all" in forget || normalizeMsg(text).length <= 40) {
      await reply(phone, copy.preferencesForgotten(removed));
      return true;
    }
    return false;
  }
  const { statements } = parseStatements(text);
  if (!statements.length) return false;
  const { saved } = await rememberStatement(user.id, text);
  if (!user.defaultAddress || !isStatementOnly(text)) return false;
  const labels = saved.length
    ? saved
    : statements.map((st) => (st.kind === "restriction" ? (st.whoLabel ? `${st.label} (${st.whoLabel})` : st.label) : st.kind === "pet" ? st.species : `${st.people} em casa`));
  await reply(phone, copy.preferenceSaved(labels));
  // Opções na mesa continuam valendo: lembra delas.
  if (ctx.step === "choosing" && ctx.pending?.length) await sendChoices(phone, ctx.pending[0]);
  return true;
}

// Total estimado de uma cesta (produtos + margem + frete de cada loja) para a oferta de juntar: frete
// da loja ao vivo para o CEP quando dá, senão a política de frete dela. O total de verdade sai na cotação.
async function estimateBasket(basket: BasketItem[], cep?: string | null): Promise<{ total: number; estimate?: string }> {
  const items = basket as InstantQuoteItem[];
  const freights = computeStoreFreights(items).freights;
  const estimates: string[] = [];
  if (liveFreightEnabled() && cep) {
    const outcomes = await withDeadline(
      Promise.all(freights.map((f) => liveStoreFreight(f.storeKey, basket.filter((i) => i.storeKey === f.storeKey).map((i) => ({ sku: i.sku, qty: i.qty })), cep).catch(() => null))),
      8_000,
      null
    );
    outcomes?.forEach((outcome, i) => {
      if (outcome?.kind === "ok") {
        freights[i] = { ...freights[i], fee: outcome.fee, source: "vivo" };
        if (outcome.estimate) estimates.push(outcome.estimate);
      }
    });
  }
  const subtotal = basket.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  const total = roundMoney(subtotal + serviceFeeForItems(basket as { unitPrice: number; qty: number }[]) + freights.reduce((sum, f) => sum + f.fee, 0));
  return { total, estimate: slowestEstimate(estimates) };
}

function consolidationBudgetMs(): number {
  const configured = Number(process.env.LIA_CONSOLIDATE_BUDGET_MS ?? 15_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
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
    // Uma loja por pedido (08/10 noite): lista espalhada em várias lojas é juntada numa só ANTES do
    // pedido mínimo (juntar costuma resolver o mínimo também). A troca nunca é silenciosa.
    const tried = (ctx.basket ?? []).map((i) => `${i.sku}x${i.qty}`).sort().join("|");
    if (new Set((ctx.basket ?? []).map((i) => i.storeKey)).size > 1 && ctx.consolidationTried !== tried) {
      ctx.consolidationTried = tried;
      let joined = await withDeadline(
        consolidateBasketStores(ctx).catch((error) => {
          console.warn("[basket:consolidate:failed]", error instanceof Error ? error.message : error);
          return null;
        }),
        consolidationBudgetMs(),
        null,
        () => console.warn("[basket:consolidate:timeout]")
      );
      // A loja tem que confirmar a cesta JUNTA antes de a oferta existir (09/10, rodada 2: aceitou, "Juntei tudo" e
      // logo "Não tenho estes itens"). Recusa definitiva da loja = sem oferta; a cesta original segue intacta.
      if (joined) {
        const refused = await withDeadline(
          preflightBasket(joined.basket.map((i) => ({ sku: i.sku, qty: i.qty, storeKey: i.storeKey ?? "" })), ctx.cep ?? userCep).catch(() => null),
          consolidationBudgetMs(),
          null
        );
        if (refused) {
          console.warn("[basket:consolidate:store-refused]", refused.storeKey, refused.kind);
          joined = null;
        }
      }
      if (joined) {
        // Oferecer, não impor (09/10, dono): o cliente vê os dois totais com o frete e escolhe. A
        // compra fecha as duas formas — várias lojas viram um trabalho de compra por loja.
        const stores = new Set((ctx.basket ?? []).map((i) => i.storeKey)).size;
        const [keptEst, joinedEst] = await Promise.all([estimateBasket(ctx.basket ?? [], ctx.cep), estimateBasket(joined.basket, ctx.cep)]);
        const { total: keptTotal, estimate: keptEta } = keptEst;
        const { total: joinedTotal, estimate: joinedEta } = joinedEst;
        // Juntar que sai MAIS CARO no total (produtos + frete) não é oferta (09/10, rodada 3: +R$ 44 pra poupar R$ 8,90 de frete).
        const costlier = joinedTotal > keptTotal + 0.009 && conciergeStoresBelowMinimum(ctx).length === 0;
        if (costlier) console.warn("[basket:consolidate:costlier]", joinedTotal, keptTotal);
        else {
        ctx.consolidationOffer = { key: tried, basket: joined.basket, storeLabel: joined.storeLabel, stores, pairs: joined.pairs, delta: joined.delta, joinedTotal, keptTotal, ...(joinedEta ? { joinedEta } : {}) };
        await writeCtx(convoId, ctx);
        if (prefix) await reply(phone, prefix);
        const body = copy.consolidationOffer({ storeLabel: joined.storeLabel, joinedTotal, keptTotal, keptStores: stores, pairs: joined.pairs, joinedEta: humanEstimate(joinedEta), keptEta: humanEstimate(keptEta) });
        markTurnReplied();
        const interactive = await whatsappAdapter.sendConsolidationOffer(phone, body, joined.storeLabel, stores).catch(() => null);
        if (!interactive) await reply(phone, `${body}\nResponde *juntar* ou *manter* (ou 1 / 2).`);
        return;
        }
      }
      await writeCtx(convoId, ctx);
    }
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
      const swapOffered = await offerMinimumSwap(phone, convoId, ctx, belowStore);
      // Sem equivalente em outra loja (09/10, teste real: detergente de R$ 3 travando lista de 12): dois botões —
      // tirar o item que não atinge o mínimo ou completar na própria loja.
      if (!swapOffered) {
        const stuckItem = (ctx.basket ?? []).find((item) => item.storeKey === belowStore.key);
        markTurnReplied();
        await whatsappAdapter
          .sendMinimumOptions(phone, "O que prefere?", (stuckItem?.name.split(" ")[0] ?? "item"), belowStore.label)
          .catch(() => null);
      }
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
    // CPF do cadastro não conferiu (09/10, rodada 3): pede de novo antes do total, em vez de seguir sem ele.
    if (ctx.cpfRequired) {
      const buyer = await prisma.user.findFirst({ where: { phone }, select: { cpf: true, cpfName: true } });
      if (buyer?.cpf && buyer?.cpfName) {
        ctx.cpfRequired = undefined;
      } else {
        ctx.step = "need_cpf";
        ctx.cpfOnboarding = false;
        await writeCtx(convoId, ctx);
        if (prefix) await reply(phone, prefix);
        await reply(phone, copy.askCpfBeforeQuote());
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
  const next: DeliveryContext = { ...addressOnlyCtx(ctx), storeKey: CONCIERGE_STORE_KEY, basket: rest, ...(ctx.recipientName ? { recipientName: ctx.recipientName } : {}), ...(ctx.urgent ? { urgent: ctx.urgent } : {}), ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {}) };
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
  // Compra e nota no nome do cliente (08/10, modelo service_fee: toda loja; antes só o remédio
  // isento, 29/09). Cópia no pedido pra compra não depender do perfil mudar depois; sem CPF
  // cadastrado = CNPJ da Lia, como sempre (remédio exige o CPF antes de cotar).
  const buyer = customerInvoiceEnabled() || (medicineEnabled() && hasMip(ctx.basket))
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
    ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}),
    // Prazo dito ("aniversário amanhã"): o resumo do total avisa se a entrega não cumpre — sobrevive ao fechamento
    // (10/10, rodada 5 g16: sumia aqui e o aviso nunca saía).
    ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {}),
    // Complemento (08/10, fase 4): "editar itens" reabre ESTE pedido — não pergunta de novo nem oferece o recusado.
    ...(ctx.complementAsked ? { complementAsked: ctx.complementAsked } : {}),
    ...(ctx.complementDeclined?.length ? { complementDeclined: ctx.complementDeclined } : {}),
    // Ensaio da compra (08/10 noite): a recusa anterior sobrevive à recotação — a 2ª da mesma loja troca de loja.
    ...(ctx.rehearsalRefused ? { rehearsalRefused: ctx.rehearsalRefused } : {})
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
    // Prazo de CADA loja (09/10): pedido de várias lojas guarda o prazo e o frete por loja — é o que a
    // compra de cada loja confere.
    const estimateByStore = new Map<string, string>();
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
          if (outcome.estimate) {
            storeEstimates.push(outcome.estimate);
            estimateByStore.set(freights[i].storeKey, outcome.estimate);
          }
          console.log("[instant-quote:estimate]", freights[i].storeKey, outcome.estimate ?? "-");
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
        // O aviso de junção ("Juntei tudo na Mambo…") vem ANTES do "a loja mudou o preço" (09/10): senão o cliente lê
        // o preço novo de um produto que ainda nem sabe que entrou na cesta.
        if (prefix) {
          await reply(phone, prefix);
          prefix = undefined;
        }
        await reply(phone, copy.pricesUpdatedByStore(raised.map((r) => ({ name: r.name, from: display(r.from, r.medicine), to: display(r.to, r.medicine) }))));
      }
    }
    const totalFee = Math.round(freights.reduce((sum, f) => sum + f.fee, 0) * 100) / 100;
    const itemsSubtotal = roundMoney(items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0));
    if (itemsSubtotal <= 0) return { handled: false };
    // ORÇAMENTO = TOTAL (07/10, c23/c24): "até R$100" pedido na linha vale produto + entrega. Estourou:
    // avisa e oferece o que cabe ANTES de qualquer cobrança — a opção mais barata do total, não do preço.
    const budget = ctx.budget;
    if (budget && !budget.override && convoId && items.length === 1 && items[0].sku === budget.sku) {
      const budgetTotal = roundMoney(itemsSubtotal + serviceFeeForItems(items as { unitPrice: number; qty: number }[]) + totalFee);
      if (budgetTotal > budget.cap + 0.005) {
        if (prefix) await reply(phone, prefix);
        await handleOverBudget(phone, convoId, ctx, orderId, { total: budgetTotal, fee: totalFee, storeKey: freights[0]?.storeKey });
        return { handled: true };
      }
    }
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
        ...(budget && !budget.override && items.length === 1 && items[0].sku === budget.sku ? { budgetCap: budget.cap } : {}),
        barato: { fee: totalFee, estimate: mlEstimate },
        rapido: { fee: rapidoFee, estimate: mlFaster.estimate }
      };
      await writeCtx(convoId, {
        ...addressOnlyCtx(ctx),
        deliveryOrderId: orderId,
        step: "choosing_freight",
        freightChoice: choice,
        ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}),
        ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {})
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
        ...(budget && !budget.override && items.length === 1 && items[0].sku === budget.sku ? { budgetCap: budget.cap } : {}),
        barato: { fee: totalFee, estimate: slowestEstimate(storeEstimates) },
        rapido: { fee: roundMoney(totalFee - sf.cheapFee + sf.faster.fee), estimate: sf.faster.estimate, name: sf.faster.name }
      };
      await writeCtx(convoId, {
        ...addressOnlyCtx(ctx),
        deliveryOrderId: orderId,
        step: "choosing_freight",
        freightChoice: choice,
        ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}),
        ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {})
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
      storeEstimate: slowestEstimate(storeEstimates),
      ...(freights.length > 1
        ? {
            perStore: freights.map((f) => ({
              storeKey: f.storeKey,
              storeLabel: f.storeLabel,
              fee: f.fee,
              promise: storePromiseText(PER_AD_FREIGHT_STORES.has(f.storeKey) ? mlEstimate : undefined, estimateByStore.get(f.storeKey))
            }))
          }
        : {})
    });
    // Frete comendo a compra (3+ entregas e frete ≥ 40% dos produtos): dica honesta de
    // como baratear — a recomposição automática vale pra LISTA; cesta montada card a
    // card foi escolha explícita do cliente e não é trocada em silêncio.
    const produtosDisplay = itemsSubtotal + serviceFeeExact;
    // Lista que JÁ veio numa mensagem só (formulário da lista) não ouve "me manda a lista numa mensagem só" (09/10).
    if (freights.length >= 3 && totalFee >= 0.4 * produtosDisplay && !ctx.listFlow && !ctx.listInOneMessage) {
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

// O total (produto + entrega) passou do teto que o cliente disse (07/10, c23/c24). Cancela a cotação
// ainda sem cobrança, reabre a escolha só com o que cabe (total estimado = preço + entrega da loja,
// conferida ao vivo quando dá) ou, sem nada que caiba, pergunta se segue assim mesmo.
async function handleOverBudget(
  phone: string,
  convoId: string,
  ctx: DeliveryContext,
  orderId: string,
  quoted: { total: number; fee: number; storeKey?: string }
) {
  const budget = ctx.budget!;
  const item = ctx.basket![0];
  const current = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { notes: true } });
  await prisma.deliveryOrder.updateMany({
    where: { id: orderId, status: AWAITING_OPERATOR_QUOTE_STATUS },
    data: {
      status: "canceled",
      notes: appendOrderNote(current?.notes ?? null, `💸 Passou do limite do cliente: total ${copy.brl(quoted.total)} > teto ${copy.brl(budget.cap)} — nada foi cobrado.`)
    }
  });
  const last = ctx.lastChoice?.chosenSku === item.sku ? ctx.lastChoice : undefined;
  const pool = last
    ? [...new Map([...last.options, ...(last.shownOptions ?? [])].map((o) => [o.sku, o])).values()]
        .filter((o) => o.sku !== item.sku && storeServesCep(o.storeKey ?? CONCIERGE_STORE_KEY, ctx.cep))
    : [];
  // Só vale a pena medir quem já cabe no teto SÓ no produto; o frete é conferido ao vivo (ou pela tabela).
  const candidates = pool.filter((o) => display(o.unitPrice, o.medicine) * item.qty <= budget.cap).slice(0, 4);
  const measured = await Promise.all(
    candidates.map(async (option) => {
      let fee = option.storeKey && option.storeKey === quoted.storeKey ? quoted.fee : storeFreight(option.storeKey ?? CONCIERGE_STORE_KEY, option.storeLabel ?? "", roundMoney(option.unitPrice * item.qty)).fee;
      let unitPrice = option.unitPrice;
      if (option.storeKey && option.storeKey !== quoted.storeKey && liveFreightEnabled() && ctx.cep) {
        const outcome = await liveStoreFreight(option.storeKey, [{ sku: option.sku, qty: item.qty }], ctx.cep).catch(() => null);
        if (outcome && (outcome.kind === "no-delivery" || outcome.kind === "item-unavailable")) return null;
        if (outcome?.kind === "ok") {
          fee = outcome.fee;
          unitPrice = outcome.unitPrices?.[option.sku] ?? unitPrice;
        }
      }
      return { option: { ...option, unitPrice }, total: roundMoney(display(unitPrice, option.medicine) * item.qty + fee) };
    })
  );
  const ranked = measured.filter((m): m is { option: ChoiceOption; total: number } => m != null).sort((a, b) => a.total - b.total);
  const fitting = ranked.filter((m) => m.total <= budget.cap + 0.005);
  const base: DeliveryContext = { ...addressOnlyCtx(ctx), storeKey: CONCIERGE_STORE_KEY, basket: ctx.basket, ...(ctx.recipientName ? { recipientName: ctx.recipientName } : {}), ...(ctx.urgent ? { urgent: ctx.urgent } : {}), ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {}) };
  // Já avisamos uma vez e o novo total ainda estoura: não repete a lista — pergunta se segue.
  if (fitting.length && !budget.warned && last) {
    const { chosenSku: _chosen, replaceSku: _replace, ...lastBase } = last;
    const pending: PendingChoice = { ...lastBase, qty: item.qty, qtyExplicit: true, options: fitting.map((m) => m.option).slice(0, vitrineLimit()), replaceSku: item.sku, cap: budget.cap };
    await writeCtx(convoId, { ...base, step: "choosing", pending: [pending], lastChoice: last, budget: { ...budget, warned: true } });
    await sendChoices(phone, pending, copy.overBudgetFit(budget.cap, quoted.total, fitting[0].total));
    return;
  }
  await writeCtx(convoId, { ...base, step: "collecting", ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}), budget: { ...budget, warned: true, awaiting: true } });
  await reply(phone, copy.overBudgetNone(budget.cap, quoted.total, item.name, ranked[0]?.total));
}

// Publica a cotação instantânea. A data vem do próprio anúncio pro CEP do cliente (consulta
// do ML) — é promessa da loja, não estimativa nossa. Sem data publicada, a frase segue sem
// prazo (inventar prazo segue proibido).
// Prazo de UMA loja, no mesmo formato da promessa do pedido de uma loja só.
function storePromiseText(mlEstimate: string | undefined, storeEstimate: string | undefined): string {
  const storeEta = humanEstimate(storeEstimate);
  return mlEstimate ? `pela própria loja · chega até ${mlEstimate}` : storeEta ? `pela própria loja · ${storeEta}` : "pela própria loja";
}

async function publishInstantQuote(
  orderId: string,
  input: {
    itemsSubtotal: number;
    serviceFee?: number;
    fee: number;
    estimate?: string;
    storeEstimate?: string;
    stores: number;
    perStore?: Array<{ storeKey: string; storeLabel: string; fee: number; promise?: string }>;
  }
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
    deliveryPromise: promise,
    ...(input.perStore ? { perStore: input.perStore } : {})
  });
}

// Handlers expostos ao gerente de diálogo (src/lib/dialogue): ele escolhe a ação, ESTES executam.
// Passados por parâmetro (sem import circular); nada aqui duplica lógica.
// Handlers do gerente de diálogo ANTES do cadastro (dialogue/presignup.ts).
async function attendanceWait(phone: string, convoId: string, ctx: DeliveryContext) {
  const att = attendanceLive(ctx);
  if (att && att.notifiedAt > 0) {
    const ack = nextAttendanceAck(ctx);
    await writeCtx(convoId, ctx);
    await reply(phone, ack);
    return;
  }
  await reply(phone, copy.holdAck());
}

// Pergunta do serviço junto de um pedido: o roteador de sempre responde a pergunta canônica (texto fixo) e o
// contexto que ele deixou volta para o turno em curso, que segue com o pedido.
async function answerCanonical(phone: string, userId: string, convoId: string, ctx: DeliveryContext, canonical: string) {
  const [user, convo] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId } }), prisma.conversation.findUniqueOrThrow({ where: { id: convoId } })]);
  const meta = turnMeta.getStore();
  const before = meta?.skipDialogue;
  if (meta) meta.skipDialogue = true;
  try {
    await handleDeliveryTurn(phone, canonical, user, convo);
  } finally {
    if (meta) meta.skipDialogue = before;
  }
  const fresh = readCtx((await prisma.conversation.findUnique({ where: { id: convoId }, select: { context: true } }))?.context ?? null);
  for (const key of Object.keys(ctx)) delete (ctx as Record<string, unknown>)[key];
  Object.assign(ctx, fresh);
}

export const preSignupHandlers: PreHandlers = { refuseMedicine, attendanceWait, answerCanonical };

// Vários ajustes de quantidade no mesmo turno (09/10, dono: lista repetida virou 4 mensagens com botões): a
// cesta ajustada vai numa mensagem só — lista, produtos, prazo de cada loja e UM conjunto de botões.
async function replyBasketList(phone: string, ctx: DeliveryContext) {
  const basket = ctx.basket ?? [];
  const body = copy.basketQtyUpdated(
    basketLinesForCopy(basket),
    Math.round(basket.reduce((sum, item) => sum + display(item.unitPrice, item.medicine) * item.qty, 0) * 100) / 100
  );
  await replyBasketAdjusted(phone, body, `${body}\n\nDiz *pagar* que eu fecho, ou me manda o que mudar.`);
}

export const dialogueHandlers = {
  replyBasketList,
  handleSearch,
  buildChoicesWithSearchNotice,
  confirmChosenOption,
  handleChoiceSwitch,
  refineOptions,
  researchChoice,
  handleQtyAdjust,
  handleRemove,
  handleSwap,
  advancePending,
  sendChoices,
  mergeBaskets,
  refuseMedicine
};

// Recomendação (08/10): a execução (recommend/handle.ts) reusa a vitrine daqui sem import circular.
setRecommendDeps({
  searchOptions: (query, cep) => searchOptionsForPlanB(query, cep),
  sendChoices,
  advancePending: (phone, convoId, ctx, userCep) => advancePending(phone, convoId, ctx, userCep),
  toChoiceOption: (item, storeRef) => toChoiceOption(item, storeRef),
  confirmOptionsLive
});

// Expostos só para os testes (rodada 3, g8).
export { sameSubtypeForCheaper, requestedStoreMissing, isUndoSwapText };
