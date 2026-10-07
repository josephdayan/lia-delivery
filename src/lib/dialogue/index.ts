// Gerente de diálogo (LIA_DIALOGUE_LLM=true): para mensagem de TEXTO LIVRE nos passos de
// montar a lista / escolher / total na mesa / escolher a entrega, a IA lê a mensagem + o estado
// e escolhe ações de uma lista fechada ANTES do roteamento por regex. O que é inequívoco e
// barato (número com opções na tela, CEP, botões, "pix"/"cartão", cadastro, CPF) continua
// determinístico e nem chama a IA. IA fora do ar, timeout ou ação inválida para o estado =
// o caminho de hoje assume (nunca deixa o cliente sem resposta).
import type { DeliveryContext } from "../conversation-types";
import type { Intent } from "../lia-intents";
import { normalizeMsg } from "../lia-intents";
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
  return process.env.LIA_DIALOGUE_LLM === "true";
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
  // Dono avisado no WhatsApp por caminho fixo: se o regex pegou, não depende da IA.
  "human",
  "complaint",
  "refund_request",
  "charge_complaint"
]);
// Só valem sem IA quando a mensagem é CURTA ("cancelar", "só isso"): frase longa pode ser outra coisa.
const SHORT_ONLY_INTENTS = new Set<Intent["kind"]>(["cancel", "done", "clear_cart", "more_options"]);

// "arroz, feijão e 2 cafés" / "quero 3 leites": segmentos curtos, sem pergunta, sem fala de conversa.
const CHATTER_RE = /\b(pode|poderia|consegue|queria|gostaria|tava|estava|pensando|legal|daquel[ae]s?|daquilo|mais em conta|recomenda|sugere|talvez|tipo|ou seja|tambem|alem)\b/;
export function isPlainShoppingList(text: string): boolean {
  const n = normalizeMsg(text);
  if (n.length > 120 || /[?]/.test(text) || CHATTER_RE.test(n)) return false;
  const segments = text.split(/[\n,;]+|\s+e\s+/i).map((x) => x.trim()).filter(Boolean);
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
  if (ctx.minSwap || ctx.repeatConfirm || ctx.planB || ctx.mergeDecision || ctx.longTailOffer || ctx.cepSwap || ctx.cepCityCheck || ctx.cancelReason || ctx.withdrawConfirm) {
    return "pergunta_aberta";
  }
  const trimmed = text.trim();
  // id de botão ("optsku:123", "frete:barato", "adicionar_mais"): string de máquina, não linguagem.
  if (/^[a-z][a-z0-9]*(?:[:_][a-z0-9:._-]+)+$/i.test(trimmed)) return "botao";
  if (DETERMINISTIC_INTENTS.has(i.intent.kind)) return `intent:${i.intent.kind}`;
  if (SHORT_ONLY_INTENTS.has(i.intent.kind) && trimmed.split(/\s+/).length <= 4) return `intent:${i.intent.kind}`;
  if (extractCpf(text)) return "cpf";
  // Lista nova de compras sem nada em andamento: a IA não acrescenta nada à busca. Só lista
  // INEQUÍVOCA ("arroz, feijão e café"): frase com conversa no meio ("ah legal, queria um sabão
  // em pó, pode ser daqueles mais em conta") conta como duas linhas no regex e vira produto
  // "não achado" — essa a IA decide.
  const fresh = !ctx.pending?.length && !(ctx.basket?.length) && !ctx.lastMiss && !ctx.lastChoice && (ctx.step === undefined || ctx.step === "collecting");
  if (fresh && i.looksLikeList && isPlainShoppingList(text)) return "lista_nova";
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
    const plan = planActions(decision, state);
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
