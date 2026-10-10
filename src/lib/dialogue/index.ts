// Gerente de diálogo (ligado por padrão desde 07/10 — placar: 52% × 49% limpos, 79% × 74% objetivo; LIA_DIALOGUE_LLM=false desliga): para mensagem de TEXTO LIVRE nos passos de
// montar a lista / escolher / total na mesa / escolher a entrega, a IA lê a mensagem + o estado
// e escolhe ações de uma lista fechada ANTES do roteamento por regex. O que é inequívoco e
// barato (número com opções na tela, CEP, botões, "pix"/"cartão", cadastro, CPF) continua
// determinístico e nem chama a IA. IA fora do ar, timeout ou ação inválida para o estado =
// o caminho de hoje assume (nunca deixa o cliente sem resposta).
import type { DeliveryContext } from "../conversation-types";
import type { Intent } from "../lia-intents";
import { resolveListItems } from "../list-items";
import { hasMissMatching } from "../list-misses";
import { asksCheapestQuestion, wantsCheapestForAll, wantsChoiceForAll, asksRunningTotal, asksDeliveryToday, asksReturnPolicy, asksDeadline, isExplicitClearAll, isExplicitRepeatOrder, normalizeMsg } from "../lia-intents";
import { detectRecommendation } from "../recommend/detect";
import { recommendEnabled } from "../recommend/types";
import { extractCpf } from "../medicine";
import { prisma } from "../prisma";
import { turnMeta } from "../turn-runtime";
import { executePlan, type DialogueHandlers } from "./execute";
import { callDialogueModel, dialogueModelAvailable } from "./model";
import { planActions, type Planned } from "./plan";
import { buildDialogueState, type OpenOrderView } from "./state";
import type { PlanOutcome } from "./types";

export { __setDialogueModelForTests } from "./model";

export function dialogueEnabled(): boolean {
  return process.env.LIA_DIALOGUE_LLM !== "false";
}

const HOOK_STEPS = new Set<string | undefined>([undefined, "collecting", "choosing", "awaiting_quote_confirmation", "choosing_freight"]);

// Intenções que o regex reconhece SEM ambiguidade e que não valem uma chamada de IA.
const DETERMINISTIC_INTENTS = new Set<Intent["kind"]>([
  "cep",
  "number",
  "thanks",
  "greeting",
  "help",
  "hold",
  "affirm",
  "pay",
  "choose_payment",
  "stale_option_tap",
  "product_details_tap",
  "product_details",
  "saved_card_pay",
  "saved_card_other",
  "paid_claim",
  "resend_code",
  "switch_payment",
  // Pergunta sobre cancelar ("como cancelo?") só explica; a IA lia como pedido e cancelava (09/10, rodada 3).
  "cancel_question",
  "unsupported_payment",
  "insult",
  // Dono avisado no WhatsApp por caminho fixo: se o regex pegou, não depende da IA.
  "human",
  "complaint",
  "refund_request",
  "charge_complaint",
  // Troca/devolução tem resposta fixa (10/10, rodada 6 M1).
  "return_question",
  // Agendar/dia escolhido (10/10, rodada 7 M2): a IA oferecia agendamento, que a Lia não faz.
  "scheduling_question",
  // Dois pagadores / "dois pedidos" (10/10, rodada 8 A2): resposta fixa e a oferta de juntar fica na mesa.
  "split_orders"
]);
// Só valem sem IA quando a mensagem é CURTA ("cancelar", "só isso"): frase longa pode ser outra coisa.
const SHORT_ONLY_INTENTS = new Set<Intent["kind"]>(["cancel", "done", "clear_cart", "more_options"]);

// "arroz, feijão e 2 cafés" / "quero 3 leites": segmentos curtos, sem pergunta, sem fala de conversa.
const CHATTER_RE = /\b(pode|poderia|consegue|queria|gostaria|tava|estava|pensando|legal|daquel[ae]s?|daquilo|mais em conta|recomenda|sugere|talvez|tipo|ou seja|tambem|alem)\b/;
export function isPlainShoppingList(text: string): boolean {
  const n = normalizeMsg(text);
  if (/[?]/.test(text) || CHATTER_RE.test(n)) return false;
  // Segmentos = os itens que o resolvedor único de contagem enxerga (list-items.ts): "romeu e julieta"
  // é UM segmento, "arroz e feijão" são dois. Sem item reconhecível, a regex antiga decide.
  const items = resolveListItems(text);
  const segments = items.length
    ? items.map((item) => item.phrase)
    : text.split(/[\n,;]+|\s+e\s+/i).map((x) => x.trim()).filter(Boolean);
  // Lista comprida (09/10, 13 itens de lojas diferentes): passou de 120 caracteres, ia pra IA do diálogo, que devolve
  // no máximo 3 ações — só 3 itens viravam busca e os outros 10 sumiam. 4+ itens curtos é lista, de qualquer tamanho.
  if (n.length > 120 && segments.length < 4) return false;
  return segments.length >= 1 && segments.every((seg) => seg.split(/\s+/).length <= 5);
}

export type BypassInput = {
  text: string;
  intent: Intent;
  ctx: DeliveryContext;
  hasAddress: boolean;
  // lista de compras evidente (2+ linhas / "3 leites") — vai direto para a busca
  looksLikeList: boolean;
};

// Motivo pelo qual a IA NÃO é consultada (null = consultar).
export function dialogueBypassReason(i: BypassInput): string | null {
  const { ctx, text } = i;
  if (!i.hasAddress) return "sem_cadastro";
  if (!HOOK_STEPS.has(ctx.step)) return "passo";
  if (ctx.minSwap || ctx.consolidationOffer || ctx.repeatConfirm || ctx.planB || ctx.mergeDecision || ctx.longTailOffer || ctx.cepSwap || ctx.cepCityCheck || ctx.cancelReason || ctx.withdrawConfirm || ctx.clearAllConfirm) {
    return "pergunta_aberta";
  }
  const trimmed = text.trim();
  // id de botão ("optsku:123", "frete:barato", "adicionar_mais"): string de máquina, não linguagem.
  if (/^[a-z][a-z0-9]*(?:[:_][a-z0-9:._-]+)+$/i.test(trimmed)) return "botao";
  // "*caixinhas de 1 litro, longa vida" (10/10, rodada 7): o asterisco do WhatsApp corrige o item da fila — o cérebro
  // aplica a correção (applyAsteriskCorrection); a IA lia a vírgula como dois itens novos com o "*" no nome.
  if (/^\*\s*[^*\s]/.test(trimmed) && !trimmed.slice(1).includes("*") && ctx.pending?.length) return "correcao_asterisco";
  // "tô com uma dor de cabeça horrível" o regex lê como reclamação; com sintoma de verdade é pedido de
  // recomendação (08/10) e a IA decide.
  const symptomComplaint = i.intent.kind === "complaint" && recommendEnabled() && Boolean(detectRecommendation(text)?.symptom);
  if (DETERMINISTIC_INTENTS.has(i.intent.kind) && !symptomComplaint) return `intent:${i.intent.kind}`;
  // "muda pra 6" / "põe 6" / "quero 6" com UM item na cesta e nada em escolha (09/10, rodada 1): só pode ser a quantidade desse item.
  // Logo depois de escolher (lastChoice, ainda coletando), "mais um" soma ao item recém-escolhido, mesmo com outros na cesta.
  if (i.intent.kind === "qty_adjust" && !i.ctx.pending?.length && (i.ctx.basket?.length === 1 || (i.ctx.lastChoice && (!i.ctx.step || i.ctx.step === "collecting")))) return "intent:qty_single";
  // "troca o arroz pelo mais barato" (09/10, rodada 1): "mais barato" é critério; o cérebro resolve o item sem IA.
  // "troca a areia por uma opção mais barata" (o "sim" à pergunta da própria Lia vira essa frase, 10/10, rodada 8 g25): idem.
  if (i.intent.kind === "swap_item" && /^(?:(?:o|a|um|uma|outr[oa])\s+)?(?:(?:opcao|versao|marca|op[cç]ao)\s+)?mais (?:barat|em conta)/.test(normalizeMsg(i.intent.to)) && (i.ctx.basket?.length ?? 0) > 0) return "intent:swap_cheapest";
  if (i.intent.kind === "clear_cart" && isExplicitClearAll(text)) return "intent:clear_all";
  if (i.intent.kind === "repeat_last" && isExplicitRepeatOrder(text)) return "intent:repeat_order";
  // "vocês entregam hoje?": sim/não direto, calculado dos prazos reais (não passa pela IA, que perde o "hoje").
  if (asksDeliveryToday(text) && ["status", "service_question", "free_text"].includes(i.intent.kind)) return "intent:today_ask";
  if (SHORT_ONLY_INTENTS.has(i.intent.kind) && trimmed.split(/\s+/).length <= 4) return `intent:${i.intent.kind}`;
  // "tem um mais em conta?" (5 palavras) ia pra IA e 1 em 3 vezes ela inventava opções e depois tirava o item errado
  // (10/10, rodada 6 g19). Pedido de mais barato sem nome é caminho fixo (pergunta "de qual item?" com 2+ itens).
  if (i.intent.kind === "more_options" && i.intent.cheaper && trimmed.split(/\s+/).length <= 7) return "intent:more_cheaper";
  // "total"/"quanto tá?" com carrossel ou pergunta aberta (10/10, rodada 7 M6/N4): a IA devolvia outra pergunta
  // ("quer saber o total ou escolher?") ou "comparo, sim". O cérebro já responde o parcial em qualquer passo.
  if (asksRunningTotal(text) && trimmed.split(/\s+/).length <= 6 && (ctx.basket?.length || ctx.pending?.length)) return "intent:running_total";
  // "tira o gelo" com o gelo entre os não achados (10/10, rodada 8 g25): o cérebro tira da lista de faltantes e diz que
  // ele já estava de fora; a IA só via a cesta e perguntava "você quis tirar outro item?".
  if (i.intent.kind === "remove_item" && !i.intent.andAdd && hasMissMatching(ctx, i.intent.target)) return "intent:remove_miss";
  if (extractCpf(text)) return "cpf";
  // "preciso que chegue até sexta, dá?" / "sábado que vem, chega?" com os cards na tela (10/10, rodada 9 A4): sim/não pro
  // dia, calculado do prazo de cada opção. A IA reescrevia para "qual o prazo?" ou "agendar" e o dia se perdia.
  if (ctx.step === "choosing" && ctx.pending?.[0]?.options.length && asksDeadline(text)) return "intent:deadline_ask";
  // "põe o papel de volta" logo depois de um "tira" (10/10, rodada 9 A3): o cérebro devolve o MESMO item; a IA perguntava
  // "Qual papel você quer colocar de volta?".
  if (ctx.lastRemoved && trimmed.length <= 80 && /\b(?:de volta|devolta)\b|^(?:pode )?(?:repoe|recoloca|reponha|devolve)\b/.test(normalizeMsg(text))) return "intent:restore_removed";
  // "dão nota fiscal? e se vier errado, troca?" (10/10, rodada 6 M1): a IA respondia só a nota; o roteador responde as duas.
  if (i.intent.kind === "fiscal_question" && asksReturnPolicy(text)) return "intent:fiscal_return";
  // "qual o horário de vocês?" (09/10): o regex já sabe que é horário de atendimento; a IA perguntava "da Lia ou da loja?".
  if (i.intent.kind === "service_question" && i.intent.topic === "hours") return "intent:hours";
  // "qual o mais barato?" com as opções na tela: o roteador de sempre responde QUAL é (sem pôr na cesta) — a
  // IA entendia como pergunta de serviço e dizia "comparo, sim" (placar c54).
  if (ctx.step === "choosing" && ctx.pending?.[0]?.options.length && asksCheapestQuestion(text)) return "pergunta_menor_preco";
  // "QUERO O MAIS BARATO DE TUDO" com vários itens em escolha (10/10, rodada 7 M4): o roteador escolhe o mais barato de
  // CADA item; a IA escolhia só o da vez.
  if (ctx.step === "choosing" && (ctx.pending?.length ?? 0) > 1 && wantsCheapestForAll(text)) return "intent:cheapest_all";
  // "escolhe você tudo que falta, não quero ver mais opção" (10/10, rodada 8 M2): idem, com a escolha delegada.
  if (ctx.step === "choosing" && (ctx.pending?.length ?? 0) > 1 && wantsChoiceForAll(text)) return "intent:choose_all";
  // Lista nova de compras sem nada em andamento: a IA não acrescenta nada à busca. Só lista
  // INEQUÍVOCA ("arroz, feijão e café"): frase com conversa no meio ("ah legal, queria um sabão
  // em pó, pode ser daqueles mais em conta") conta como duas linhas no regex e vira produto
  // "não achado" — essa a IA decide.
  const fresh = !ctx.pending?.length && !(ctx.basket?.length) && !ctx.lastMiss && !ctx.lastChoice && (ctx.step === undefined || ctx.step === "collecting");
  // "tô com muita fome, quero algo doce" tem vírgula e frases curtas — parece lista, mas é pedido de
  // recomendação (08/10): a IA decide (ação recommend), nunca a busca literal de "algo doce".
  if (fresh && i.looksLikeList && isPlainShoppingList(text) && !(recommendEnabled() && detectRecommendation(text))) return "lista_nova";
  return null;
}

export type DialogueTurnInput = BypassInput & {
  phone: string;
  convoId: string;
  userId: string;
  userCep: string | null | undefined;
  handlers: DialogueHandlers;
};

async function openOrderView(ctx: DeliveryContext): Promise<OpenOrderView | null> {
  if (!ctx.deliveryOrderId || (ctx.step !== "awaiting_quote_confirmation" && ctx.step !== "choosing_freight")) return null;
  const order = await prisma.deliveryOrder.findUnique({ where: { id: ctx.deliveryOrderId }, select: { items: true, total: true } });
  if (!order) return null;
  return { total: order.total, items: ((order.items as unknown as OpenOrderView["items"]) ?? []).filter((i) => i.unitPrice > 0) };
}

// null = a IA não foi consultada (o caminho de hoje segue, sem custo).
export async function runDialogueTurn(input: DialogueTurnInput): Promise<PlanOutcome | null> {
  if (!dialogueEnabled() || !dialogueModelAvailable()) return null;
  const bypass = dialogueBypassReason(input);
  if (bypass) return null;
  // Resumo na tela com um item só (09/10, rodada 1): "põe 6"/"quero 8" é a quantidade dele; sem IA.
  if (input.intent.kind === "qty_adjust" && !input.ctx.pending?.length && !input.ctx.basket?.length) {
    const open = await openOrderView(input.ctx);
    if (open && open.items.length === 1) return null;
  }
  const started = Date.now();
  const meta = turnMeta.getStore();

  // 1) decidir (qualquer falha aqui = o caminho de hoje assume; nada foi dito ao cliente)
  let planned: { steps: Planned[]; modelMs: number };
  try {
    const state = buildDialogueState(input.ctx, { hasAddress: input.hasAddress, order: await openOrderView(input.ctx) });
    const decision = await callDialogueModel({ text: input.text, state });
    const modelMs = Date.now() - started;
    if (!decision) {
      console.log(`[dialogue] ação=nenhuma ms=${modelMs} motivo=sem_decisao`);
      return { kind: "fallthrough", reason: "sem_decisao" };
    }
    // O gerente já classificou a mensagem: o roteador de fallback (outra chamada de IA) não repete.
    if (meta) meta.llmUsed = true;
    const plan = planActions(decision, state, { text: input.text });
    if (!plan.ok) {
      console.log(`[dialogue] ação=${decision.actions.map((a) => a.type).join("+")} ms=${modelMs} motivo=invalida:${plan.reason}`);
      return { kind: "fallthrough", reason: plan.reason };
    }
    planned = { steps: plan.steps, modelMs };
  } catch (error) {
    console.warn("[dialogue:error]", error instanceof Error ? error.message : error);
    return { kind: "fallthrough", reason: "erro" };
  }
  // 2) executar pelos handlers existentes
  const repliesBefore = meta?.replies ?? 0;
  try {
    const outcome = await executePlan(
      { phone: input.phone, convoId: input.convoId, userId: input.userId, userCep: input.userCep, ctx: input.ctx, text: input.text, h: input.handlers },
      planned.steps
    );
    const label = outcome.kind === "fallthrough" ? `nenhuma motivo=${outcome.reason}` : outcome.actions;
    console.log(`[dialogue] ação=${label} ms=${planned.modelMs} total=${Date.now() - started} resultado=${outcome.kind}`);
    return outcome;
  } catch (error) {
    // Erro depois de o cliente já ter ouvido algo: sobe como qualquer erro de handler (um
    // fallthrough responderia duas vezes). Antes de qualquer resposta: o caminho de hoje assume.
    if ((meta?.replies ?? 0) > repliesBefore) throw error;
    console.warn("[dialogue:execute:error]", error instanceof Error ? error.message : error);
    return { kind: "fallthrough", reason: "erro_na_execucao" };
  }
}
