// Validação do que a IA pediu contra o ESTADO real: ação inválida para o passo (opção que não
// existe, item que não está na cesta, "fechar" fora de hora…) derruba o plano inteiro e o caminho
// de hoje assume. Puro e testável. Resolve os números do estado em alvos concretos ANTES de
// qualquer handler mexer na cesta (compostos como "tira o leite e bota 2 pães").
import { countDistinctItems, resolveListItems, textHasCount } from "../list-items";
import { extractCep, isNonItemSegment, looksLikeMedicine, normalizeMsg, parseKeepItem, parseBudgetStatement, parsePriceCap, sharesProductNoun, stripMedicineNegation, attributeFragment } from "../lia-intents";
import { splitAlternativeLine } from "../alt-items";
import { isPrescriptionDrugName, looksLikePrescriptionRequest, medicineEnabled } from "../medicine";
import { detectRecommendation } from "../recommend/detect";
import { emergencyFlag } from "../recommend/fallback";
import { recommendEnabled, type RecommendCriterion, type RecommendRequest } from "../recommend/types";
import { RECOMMEND_CRITERIA, type AnswerTopic, type DialogueAction, type DialogueDecision, type DialogueState, type PayMethod, type Sort } from "./types";

export type Target = { kind: "screen" } | { kind: "basket"; idx: number; name: string } | { kind: "queue"; idx: number; name: string };

export type Planned =
  | { type: "search"; lines: { query: string; qty: number }[]; retry?: boolean; replace?: boolean }
  | { type: "pick"; source: "screen" | "last" | "freight"; index: number; qty?: number }
  | { type: "more_options"; sort: Sort }
  | { type: "refine"; attribute: string }
  | { type: "qty"; mode: "set" | "add"; target: Target; value: number }
  | { type: "remove"; target: Target }
  | { type: "swap"; from: Target & { kind: "basket" }; to: string }
  | { type: "skip_current" }
  // dropQueueOnly: "1, só amora" — escolhe a opção e larga o resto da fila (nada de confirmar/mostrar nada além do pick)
  | { type: "only_keep"; target: Target; dropQueueOnly?: boolean }
  | { type: "rewrite"; text: string; label: string }
  | { type: "reply"; kind: "smalltalk" | "unclear"; text?: string }
  // Texto FIXO do lia-copy (nunca livre da IA): produto que a Lia não vende / remédio insistente.
  | { type: "fixed"; key: "out_of_scope" | "medicine" }
  // Recomendação (08/10): necessidade ou produto + julgamento, já validada e no contrato da etapa ENTENDER.
  | { type: "recommend"; request: RecommendRequest };

export type Plan = { ok: true; steps: Planned[] } | { ok: false; reason: string };

// Pergunta canônica de cada tema: o roteador de intenções já a reconhece e a resposta sai do
// lia-copy (texto fixo e verdadeiro). Coberto por tests/dialogue-2026-10-07.test.ts.
export const ANSWER_TEXT: Record<AnswerTopic, string> = {
  delivery_fee: "quanto é o frete?",
  delivery_time: "qual o prazo de entrega?",
  payment_methods: "quais formas de pagamento vocês aceitam?",
  area: "quais cidades vocês atendem?",
  service_fee: "vocês cobram taxa de serviço?",
  price_compare: "vocês comparam preços?",
  safety: "é seguro? é golpe?",
  identity: "quem é você?",
  invoice: "vocês emitem nota fiscal?",
  cnpj: "qual o CNPJ da empresa?",
  who_delivers: "quem faz a entrega?",
  pix_receiver: "pra quem vai o pix?",
  coupon: "tem cupom de desconto?",
  installments: "parcela em quantas vezes?",
  scheduling: "posso agendar a entrega?",
  stores: "de qual loja é?",
  how_it_works: "como você funciona?",
  // "quanto deu tudo?": o total parcial/do pedido; "quanto falta?": o pedido mínimo da loja
  order_total: "quanto deu tudo?",
  minimum_order: "quanto falta?"
};

const PAY_TEXT: Record<PayMethod, string> = { pix: "pix", card: "cartão", unspecified: "quero pagar" };
const SORT_TEXT: Record<Sort, string> = { next: "outras opções", cheaper: "mais barato", pricier: "mais caro" };

const clampQty = (n: number | undefined) => (n && n > 0 ? Math.min(50, n) : undefined);
// Quantidade na ESCOLHA só vale se a fala diz uma (10/10, rodada 12 A4): "o de salmão da Dreamies" vinha com qty 2 da IA
// (a da areia, escolhida antes) e o petisco virava 2x. O número da opção ("quero o 3") não é quantidade.
function saidPickQty(text: string | undefined, option: number, qty: number | undefined): number | undefined {
  if (!text) return clampQty(qty);
  const rest = normalizeMsg(text).replace(new RegExp(`\\b(?:o|a|opcao|numero)\\s+${option}\\b`), " ");
  return textHasCount(rest) || /\b(?:so|apenas)\s+(?:um|uma)\b|\b(?:um|uma)\s+(?:so|unidade|pacote)\b/.test(rest) ? clampQty(qty) : undefined;
}

function resolveTarget(state: DialogueState, target: number | undefined): Target | null {
  if (target === undefined || !Number.isInteger(target) || target < 0) return null;
  if (target === 0) return state.emEscolha ? { kind: "screen" } : null;
  const basket = state.cesta[target - 1];
  if (basket) return { kind: "basket", idx: target - 1, name: basket.nome };
  const queued = state.fila.find((f) => f.n === target);
  if (queued) return { kind: "queue", idx: state.fila.indexOf(queued), name: queued.item };
  return null;
}

// Ações que respondem/encerram o turno sozinhas: só valem isoladas.
const SOLO = new Set(["close_list", "answer", "human", "status", "cancel", "pay", "change_address", "more_options", "smalltalk", "unclear", "out_of_scope", "medicine", "recommend"]);

// `text` = a mensagem original do cliente: vira o `text` da recomendação e é de onde o CÓDIGO tira o
// teto de preço (a IA não decide dinheiro) e os sinais determinísticos (detect.ts).
export function planActions(decision: DialogueDecision, state: DialogueState, opts: { text?: string } = {}): Plan {
  const actions = decision.actions;
  if (!actions.length || actions.length > 3) return { ok: false, reason: "quantidade_de_acoes" };
  if (actions.length > 1 && actions.some((a) => SOLO.has(a.type))) return { ok: false, reason: "acao_exclusiva_combinada" };
  // Remédio no meio de uma lista (10/10, rodada 7 A4): a IA respondia "medicine" para a mensagem inteira e os outros
  // itens ("band-aid, protetor, shampoo, leite...") sumiam. Com algum item que não é remédio, o caminho determinístico
  // assume: deixa o remédio de fora com o aviso curto e busca o resto.
  if (actions.some((a) => a.type === "medicine") && opts.text && listHasNonMedicineItem(opts.text)) return { ok: false, reason: "remedio_no_meio_da_lista" };
  // Remédio isento ligado: "dipirona 500mg gotas, a normal sem receita" é pedido que a Lia compra — a recusa da IA ("remédio
  // de receita...") só vale com remédio de receita nomeado na mensagem.
  if (actions.some((a) => a.type === "medicine") && opts.text && medicineEnabled() && looksLikeMedicine(opts.text) && !looksLikePrescriptionRequest(opts.text)) return { ok: false, reason: "remedio_isento" };

  const steps: Planned[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const step = planOne(a, state, actions.some((x) => x.type === "pick"), opts.text);
    if (typeof step === "string") return { ok: false, reason: `${a.type}:${step}` };
    // search consecutivos viram UMA busca de várias linhas (a extração já separa itens).
    const prev = steps[steps.length - 1];
    if (step.type === "search" && prev?.type === "search" && !step.retry && !prev.retry && !!step.replace === !!prev.replace) {
      prev.lines.push(...step.lines);
    } else {
      steps.push(step);
    }
  }
  // Atributo solto como busca (10/10, rodada 12: "faltou a escova de dente, tem que ser macia" virava o item "tem que ser
  // macia" e 47 s de busca): refina a linha anterior da mesma busca; sozinho, com as opções na tela, é refino delas.
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    // "tem algo de carrinho ou lego pra 5 anos?" com o "brinquedo" na tela: não é refino ("brinquedo carrinho ou lego anos"
    // não acha nada), é o item da tela trocado por UM item com duas buscas.
    if (st.type === "refine" && splitAlternativeLine(st.attribute)) {
      steps[i] = { type: "search", lines: [{ query: st.attribute, qty: 1 }], replace: true };
      continue;
    }
    if (st.type !== "search") continue;
    const kept: { query: string; qty: number }[] = [];
    let lone: string | undefined;
    for (const line of st.lines) {
      const attr = attributeFragment(line.query);
      if (!attr) kept.push(line);
      else if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], query: normalizeMsg(kept[kept.length - 1].query).includes(attr) ? kept[kept.length - 1].query : `${kept[kept.length - 1].query} ${attr}` };
      else lone = attr;
    }
    if (kept.length) st.lines = kept;
    else if (lone && state.passo === "escolhendo_opcao" && state.emEscolha) steps[i] = { type: "refine", attribute: lone };
    else if (lone) return { ok: false, reason: "search:atributo_solto" };
  }
  // O modelo às vezes devolve só 3 buscas para uma lista de 6 (09/10, teste real: ração/esmalte/carregador sumiram sem aviso).
  // Plano só de buscas com MENOS linhas do que itens na mensagem = lista cortada: cai no pipeline determinístico, que conta todos.
  // Garantia geral (10/10, rodada 8 A1): nenhum item da mensagem some calado. "quero esse leite do Ninho, e um shampoo, e
  // ração..., e pilhas AA" voltava como pick + 2 buscas (o teto de 3 ações) e as pilhas sumiam com "Achei os 2 itens". Cada
  // passo cobre um trecho (busca = uma linha; escolha/refino/edição = um); com trecho a mais na fala do que coberto, o
  // pipeline determinístico (que conta todos e diz o que não achou) assume. Vale para qualquer plano com busca.
  const searchOnly = steps.length > 0 && steps.every((st) => st.type === "search" && !st.retry);
  const hasSearch = steps.some((st) => st.type === "search" && !st.retry);
  if (hasSearch && opts.text) {
    const planned = steps.reduce((sum, st) => sum + (st.type === "search" ? st.lines.length : st.type === "rewrite" || st.type === "reply" || st.type === "fixed" ? 0 : 1), 0);
    // Só lista GRANDE (4+) quando só há buscas: frase solta ("você consegue qualquer coisa? tava pensando em sabão") conta
    // item a mais sem ser lista. Com escolha junto, 3 trechos já bastam (a escolha pelo número nem conta como trecho).
    const counted = countDistinctItems(opts.text);
    if (counted >= (searchOnly ? 4 : 3) && counted > planned) return { ok: false, reason: "lista_maior_que_as_acoes" };
  }
  // Sem busca nenhuma (10/10, rodada 9 A1): "gostei desse leite integral, mais um desodorante, ração de cachorro adulto e
  // pilhas AAA" com o carrossel aberto voltava só como "unclear" (ou só a escolha) — a Lia perguntava qual leite e os 3
  // itens novos sumiam. Pergunta/escolha/edição que não cobre uma lista de 3+ trechos: o caminho determinístico (que
  // escolhe ou pergunta E enfileira o resto com "Anotei…") assume.
  // Só com os cards na tela: sem escolha aberta, o "unclear" de uma fala hesitante ("aquele leite, não, o outro, sabe")
  // é uma pergunta legítima.
  if (!hasSearch && opts.text && state.passo === "escolhendo_opcao" && state.emEscolha && steps.some((st) => st.type === "pick" || st.type === "reply" || st.type === "refine" || st.type === "qty")) {
    const planned = steps.filter((st) => st.type !== "reply").length;
    const counted = countDistinctItems(opts.text);
    if (counted >= 3 && counted > planned) return { ok: false, reason: "lista_maior_que_as_acoes" };
  }
  // "1, só amora" (pick + only_keep da tela, em qualquer ordem): primeiro larga a fila e só então escolhe —
  // senão o pick abria o próximo item da fila e o only_keep rodava em cima dele.
  const pickAt = steps.findIndex((st) => st.type === "pick" && st.source === "screen");
  const keepAt = steps.findIndex((st) => st.type === "only_keep" && st.target.kind === "screen");
  if (pickAt >= 0 && keepAt >= 0) {
    const keep = steps[keepAt] as Extract<Planned, { type: "only_keep" }>;
    const pick = steps[pickAt];
    return { ok: true, steps: [{ ...keep, dropQueueOnly: true }, pick, ...steps.filter((_, i) => i !== pickAt && i !== keepAt)] };
  }
  return { ok: true, steps };
}

const isMedicineLine = (phrase: string) => looksLikeMedicine(phrase) || isPrescriptionDrugName(phrase) || looksLikePrescriptionRequest(phrase);
// "pode", "comprar", "consegue" não são produto ("mas eu tenho receita, pode comprar?" é pergunta sobre o remédio).
const NOT_PRODUCT_WORD = new Set(["pode", "podem", "comprar", "compra", "consegue", "conseguem", "tem", "vende", "vendem", "quero", "preciso", "voce", "voces", "mas", "isso", "ai", "entao", "favor"]);
const isProductLine = (phrase: string) => !isNonItemSegment(phrase) && normalizeMsg(phrase).split(/[^a-z0-9]+/).some((w) => w.length >= 3 && !NOT_PRODUCT_WORD.has(w));
export function listHasNonMedicineItem(text: string): boolean {
  const lines = resolveListItems(stripMedicineNegation(text)).map((line) => line.phrase).filter((phrase) => /[a-z]{3,}/i.test(phrase));
  return lines.length >= 2 && lines.some((phrase) => !isMedicineLine(phrase) && isProductLine(phrase)) && lines.some(isMedicineLine);
}

// Negação de atributo vira filtro, nunca termo positivo (09/10, rodada 3): "troca a areia por uma SEM cheiro" → a IA
// devolvia "cheiro" e a busca trazia areia perfumada. Se a fala diz "sem X" e a frase da IA tem X sem o "sem", devolve o "sem".
export function keepNegation(text: string, phrase: string): string {
  const said = normalizeMsg(text);
  let out = phrase;
  for (const m of said.matchAll(/\bsem\s+([a-z]{3,})/g)) {
    const word = m[1];
    const norm = normalizeMsg(out);
    if (!new RegExp(`\\b${word}\\b`).test(norm) || new RegExp(`\\bsem\\s+${word}\\b`).test(norm)) continue;
    const swapped = out.replace(new RegExp(`\\b${word}\\b`, "i"), `sem ${word}`);
    out = swapped === out ? `${out} sem ${word}` : swapped;
  }
  return out;
}

const ORDINALS = ["primeir", "segund", "terceir", "quart", "quint", "sext", "setim", "oitav"];
// A fala cita a opção n: o número solto (não medida/quantidade: "2l", "3 de 2l") ou o ordinal; "o último"/"esse" também.
function namesOption(text: string, n: number): boolean {
  const said = normalizeMsg(text);
  if (new RegExp(`(?:^|[^\\d,.])${n}(?!\\d|[,.]\\d|\\s*(?:x\\b|l\\b|lt|litros?|kg|g\\b|ml|un|de\\b|pacotes?|caixas?|latas?|garrafas?|unidades?))`).test(said)) return true;
  if (ORDINALS[n - 1] && new RegExp(`\\b${ORDINALS[n - 1]}[oa]\\b`).test(said)) return true;
  return /\b(?:ultim[oa]|ess[ea]|est[ea]|op[cç]ao)\b/.test(said);
}

const FREE_BRAND_RE = /\b(?:qualquer (?:marca|uma|um)|tanto faz(?: a marca)?|sem preferencia|outra marca|nao precisa ser (?:dess|da|de))/;
const REPLACE_CUE_RE = /\b(?:na verdade|na vdd|em vez|ao inves|no lugar|troca\w*|substitu\w*|mudei de ideia|pensando bem|melhor|prefiro|esquece|nao quero (?:ess|mais))/;

function planOne(a: DialogueAction, state: DialogueState, pickOnScreen = false, text = ""): Planned | string {
  const onScreen = state.passo === "escolhendo_opcao" && state.emEscolha;
  switch (a.type) {
    case "search": {
      let query = a.query ? keepNegation(text, a.query.replace(/\s+/g, " ").trim()) : undefined;
      if (!query || query.length > 160) return "sem_busca";
      // "ração pra gatinho filhote qualquer marca" depois do "não achei ração Whiskas" (10/10, rodada 5 M12): o cliente
      // LIBERA a marca — refazer a busca perdida (retry ou a mesma frase) repetia o "não achei". Busca a frase dele.
      let retry = Boolean(a.retry);
      const missed = state.naoAcheiRecente?.pedido;
      // Só quando a frase repete o PRODUTO: "pode tentar de qualquer marca" sozinho continua sendo retry (c40).
      if (FREE_BRAND_RE.test(normalizeMsg(text)) && text.trim().length <= 160 && missed && sharesProductNoun(text, missed) && (retry || normalizeMsg(query) === normalizeMsg(missed))) {
        query = text.trim();
        retry = false;
      }
      // Quantidade dita e perdida pela IA (10/10, rodada 6 A6: "leite integral 12 caixas de 1 litro" voltava qty 1): com UM
      // item na fala, a contagem explícita do parser vale quando a IA não trouxe nenhuma.
      // Teto dito ("perfume feminino até 60 reais", 10/10, rodada 6 g19) que a IA tirou da frase: volta na busca de um item
      // só — sem ele, a vitrine de R$ 83 a R$ 94 saía sem aviso.
      const saidCap = text ? parsePriceCap(text) : null;
      if (saidCap != null && parsePriceCap(query) == null && resolveListItems(text).length <= 1 && sharesProductNoun(text, query)) query = `${query} até ${saidCap} reais`;
      let qty = clampQty(a.qty) ?? 1;
      if (qty === 1 && text) {
        const said = resolveListItems(text);
        if (said.length === 1 && said[0].qtyExplicit && said[0].qty > 1 && sharesProductNoun(said[0].phrase, query)) qty = Math.min(50, said[0].qty);
      }
      return {
        type: "search",
        lines: [{ query, qty }],
        ...(retry ? { retry: true } : {}),
        // Trocar o item da tela só quando é o MESMO produto ou o cliente diz que corrige (10/10, rodada 5): "ração pra
        // gatinho qualquer marca" com o arroz na tela tirava o arroz ("Deixei arroz Camil de fora").
        ...(a.replace && onScreen && (sharesProductNoun(query, state.emEscolha!.item) || REPLACE_CUE_RE.test(normalizeMsg(text))) ? { replace: true } : {})
      };
    }
    case "pick": {
      const n = a.option;
      if (!n || n < 1) return "sem_opcao";
      if (state.passo === "escolhendo_frete") {
        return state.opcoesDeFrete && n <= state.opcoesDeFrete.length ? { type: "pick", source: "freight", index: n - 1 } : "frete_inexistente";
      }
      // Pergunta não escolhe (10/10, rodada 9 B-307): "tem de 2 litros? eu queria 3 de 2l" virava pick do card de 2 L
      // (com prazo de 9 dias, sem o cliente ver). Com "?" e sem o número/ordinal da opção na fala, a escolha não vale:
      // o caminho determinístico refina e mostra as opções que respondem à pergunta.
      if (onScreen && text && /\?/.test(text) && !namesOption(text, n)) return "pergunta_nao_escolhe";
      if (onScreen) return n <= state.emEscolha!.opcoes.length ? { type: "pick", source: "screen", index: n - 1, qty: saidPickQty(text, n, a.qty) } : "opcao_fora_da_tela";
      if (state.ultimaEscolha) {
        return n <= state.ultimaEscolha.opcoes.length ? { type: "pick", source: "last", index: n - 1 } : "opcao_fora_da_ultima";
      }
      return "sem_opcoes";
    }
    case "more_options": {
      const sort: Sort = a.sort ?? "next";
      if (onScreen) return { type: "more_options", sort };
      if (state.ultimaEscolha && sort !== "pricier" && state.passo !== "escolhendo_frete") return { type: "more_options", sort };
      return "sem_opcoes";
    }
    case "refine": {
      const attribute = a.attribute ? keepNegation(text, a.attribute.replace(/\s+/g, " ").trim()) : undefined;
      if (!onScreen) return "sem_opcoes_na_tela";
      if (!attribute || attribute.length > 60) return "sem_atributo";
      return { type: "refine", attribute };
    }
    case "set_qty":
    case "add_qty": {
      const target = resolveTarget(state, a.target);
      if (!target || target.kind === "queue") return "alvo_invalido";
      if (a.type === "set_qty") {
        const qty = clampQty(a.qty);
        return qty ? { type: "qty", mode: "set", target, value: qty } : "sem_quantidade";
      }
      const delta = a.delta ?? a.qty;
      if (!delta || Math.abs(delta) > 50) return "sem_delta";
      return { type: "qty", mode: "add", target, value: delta };
    }
    case "remove": {
      // "não, deixa o arroz" é MANTER (10/10, rodada 6 A5): a IA lia "deixa" como "tira".
      if (text && parseKeepItem(text)) return "fala_de_manter";
      const target = resolveTarget(state, a.target);
      if (!target) return "alvo_invalido";
      return target.kind === "screen" ? { type: "skip_current" } : { type: "remove", target };
    }
    case "swap": {
      const from = resolveTarget(state, a.from ?? a.target);
      if (!from || from.kind !== "basket") return "alvo_invalido";
      const to = a.to ? keepNegation(text, a.to.replace(/\s+/g, " ").trim()) : undefined;
      if (!to || to.length > 100) return "sem_destino";
      // "troca por bolacha água e sal e coloca 3" (09/10, teste real): a quantidade dita junto da troca se perdia — o
      // modelo não tem campo de quantidade no swap. Quantidade de unidades depois de coloca/bota/quero entra na busca.
      // "o leite ninho eu quis dizer o leite em pó, 2 latas" (10/10, rodada 6 g19): número + embalagem também é a quantidade.
      const said =
        text.match(/\b(?:coloca|bota|poe|põe|quero|manda)\s+(\d{1,2}|dois|duas|tr[eê]s|quatro|cinco|seis)\b/i) ??
        text.match(/\b(\d{1,2}|dois|duas|tr[eê]s|quatro|cinco|seis)\s+(?:latas?|latinhas?|pacotes?|caixas?|potes?|garrafas?|vidros?|sacos?|fardos?|kits?|unidades?|un)\b/i);
      const words: Record<string, string> = { dois: "2", duas: "2", tres: "3", "três": "3", quatro: "4", cinco: "5", seis: "6" };
      const qty = said ? words[said[1].toLowerCase()] ?? said[1] : undefined;
      return { type: "swap", from, to: qty && !/\d/.test(to) && Number(qty) > 1 ? `${qty} ${to}` : to };
    }
    case "skip_current":
      return onScreen ? { type: "skip_current" } : "sem_opcoes_na_tela";
    case "only_keep": {
      // "1, só amora": junto de um pick da tela, o "só X" é o item que está sendo escolhido,
      // mesmo que a IA tenha numerado o alvo como cesta (que ainda não o tem).
      const withPick = Boolean(onScreen) && pickOnScreen;
      const target = a.target === undefined ? (onScreen ? resolveTarget(state, 0) : null) : resolveTarget(state, a.target) || (withPick ? resolveTarget(state, 0) : null);
      if (!target || target.kind === "queue") return "alvo_invalido";
      return { type: "only_keep", target };
    }
    case "close_list":
      return { type: "rewrite", text: "só isso", label: "close_list" };
    case "answer":
      return a.topic ? { type: "rewrite", text: ANSWER_TEXT[a.topic], label: `answer:${a.topic}` } : "sem_tema";
    case "human":
      return { type: "rewrite", text: "quero falar com um atendente", label: "human" };
    case "status":
      return { type: "rewrite", text: "cadê meu pedido?", label: "status" };
    case "cancel":
      return { type: "rewrite", text: "cancelar", label: "cancel" };
    case "pay":
      return { type: "rewrite", text: PAY_TEXT[a.method ?? "unspecified"], label: `pay:${a.method ?? "unspecified"}` };
    case "change_address": {
      let said = a.text?.trim();
      // O endereço que a IA devolve tem que estar na fala do cliente (09/10, rodada 3: "trocar endereço" voltava com o
      // endereço ANTIGO da cesta como se fosse novo). Palavra por palavra; sem isso, vale "trocar endereço" puro.
      if (said && text) {
        const spoken = new Set(normalizeMsg(text).split(/[^a-z0-9]+/).filter(Boolean));
        const missing = normalizeMsg(said).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 || /\d/.test(w)).some((w) => !spoken.has(w));
        if (missing) said = undefined;
      }
      // Só um CEP: vale como CEP solto (o fluxo de endereço novo já cuida); com rua, vai junto.
      if (said && extractCep(said) && said.replace(/\D/g, "").length <= 8) return { type: "rewrite", text: said, label: "change_address" };
      return { type: "rewrite", text: said ? `trocar endereço: ${said}` : "trocar endereço", label: "change_address" };
    }
    case "out_of_scope":
      return { type: "fixed", key: "out_of_scope" };
    case "medicine":
      return { type: "fixed", key: "medicine" };
    case "recommend":
      return planRecommend(a, state, text);
    case "smalltalk":
      return { type: "reply", kind: "smalltalk", text: a.text };
    case "unclear":
      return { type: "reply", kind: "unclear", text: a.text };
    default:
      return "desconhecida";
  }
}

const clean120 = (v: string | undefined) => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t && t.length <= 120 ? t : t ? null : undefined;
};

// recommend (08/10, plano-recomendacoes §1.1): valida o que a IA extraiu e monta o contrato da etapa
// ENTENDER. Os sinais determinísticos da própria mensagem (detect.ts) completam o que a IA deixou de
// fora (teto de preço, restrição, pra quem) — nunca o contrário.
function planRecommend(a: DialogueAction, state: DialogueState, text: string): Planned | string {
  const product = clean120(a.product);
  const need = clean120(a.need);
  const symptom = clean120(a.symptom);
  if (product === null || need === null || symptom === null) return "texto_longo";
  const form = a.form ?? (product ? "product_judged" : need || symptom ? "need" : undefined);
  if (!form) return "sem_forma";
  if (form === "product_judged" && !product) return "sem_produto";
  if (form === "need" && !need && !symptom) return "sem_necessidade";
  // Flag desligada: produto + julgamento vira a busca de sempre; necessidade cai no caminho de hoje.
  if (!recommendEnabled()) return form === "product_judged" ? { type: "search", lines: [{ query: product!, qty: 1 }] } : "recomendacao_desligada";
  const onScreen = state.passo === "escolhendo_opcao" && state.emEscolha;
  const signals = text ? detectRecommendation(text, { hasPendingChoice: Boolean(onScreen) }) : null;
  // Opções na tela + mensagem que nem as regras leem como recomendação ("mais barato", "sem açúcar",
  // "outras", "qual desses você indica pra presente?"): é refino/mais opções/pergunta sobre a tela — o
  // caminho de hoje decide, não a recomendação. Revisão C4 (08/10): vale para frase de QUALQUER tamanho
  // (antes só ≤ 4 palavras); só passa com sintoma dito ou emergência (o alerta não pode esperar).
  if (onScreen && !signals && !symptom && !emergencyFlag(text)) return "recomendacao_na_tela";
  const criteria = [...new Set<RecommendCriterion>([...(a.criteria ?? []), ...(signals?.criteria ?? [])])].filter((c) => (RECOMMEND_CRITERIA as readonly string[]).includes(c));
  if (form === "product_judged" && !criteria.length) criteria.push("good");
  const constraints = [...new Set([...(a.constraints ?? []), ...(signals?.constraints ?? [])].map((c) => c.toLowerCase()))].slice(0, 6);
  const budget = (text ? parsePriceCap(text) ?? parseBudgetStatement(text) : null) ?? signals?.budget;
  const recipient = clean120(a.recipient) ?? signals?.recipient;
  const urgency = a.urgency || signals?.urgency;
  const request: RecommendRequest = {
    form,
    text,
    ...(form === "product_judged" ? { product: product! } : { need: need ?? symptom! }),
    criteria: (["fast", "good", "cheap", "healthy"] as RecommendCriterion[]).filter((c) => criteria.includes(c)),
    constraints,
    ...(budget != null ? { budget } : {}),
    ...(recipient ? { recipient } : {}),
    ...(urgency ? { urgency: true } : {}),
    ...(symptom ? { symptom } : signals?.symptom && form === "need" ? { symptom: signals.symptom } : {}),
    source: "dialogue"
  };
  return { type: "recommend", request };
}
