// Validação do que a IA pediu contra o ESTADO real: ação inválida para o passo (opção que não
// existe, item que não está na cesta, "fechar" fora de hora…) derruba o plano inteiro e o caminho
// de hoje assume. Puro e testável. Resolve os números do estado em alvos concretos ANTES de
// qualquer handler mexer na cesta (compostos como "tira o leite e bota 2 pães").
import { extractCep } from "../lia-intents";
import type { AnswerTopic, DialogueAction, DialogueDecision, DialogueState, PayMethod, Sort } from "./types";

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
  | { type: "only_keep"; target: Target }
  | { type: "rewrite"; text: string; label: string }
  | { type: "reply"; kind: "smalltalk" | "unclear"; text?: string };

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
const SOLO = new Set(["close_list", "answer", "human", "status", "cancel", "pay", "change_address", "more_options", "smalltalk", "unclear"]);

export function planActions(decision: DialogueDecision, state: DialogueState): Plan {
  const actions = decision.actions;
  if (!actions.length || actions.length > 3) return { ok: false, reason: "quantidade_de_acoes" };
  if (actions.length > 1 && actions.some((a) => SOLO.has(a.type))) return { ok: false, reason: "acao_exclusiva_combinada" };

  const steps: Planned[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const step = planOne(a, state);
    if (typeof step === "string") return { ok: false, reason: `${a.type}:${step}` };
    // search consecutivos viram UMA busca de várias linhas (a extração já separa itens).
    const prev = steps[steps.length - 1];
    if (step.type === "search" && prev?.type === "search" && !step.retry && !prev.retry && !!step.replace === !!prev.replace) {
      prev.lines.push(...step.lines);
    } else {
      steps.push(step);
    }
  }
  return { ok: true, steps };
}

function planOne(a: DialogueAction, state: DialogueState): Planned | string {
  const onScreen = state.passo === "escolhendo_opcao" && state.emEscolha;
  switch (a.type) {
    case "search": {
      const query = a.query?.replace(/\s+/g, " ").trim();
      if (!query || query.length > 160) return "sem_busca";
      return {
        type: "search",
        lines: [{ query, qty: clampQty(a.qty) ?? 1 }],
        ...(a.retry ? { retry: true } : {}),
        ...(a.replace && onScreen ? { replace: true } : {})
      };
    }
    case "pick": {
      const n = a.option;
      if (!n || n < 1) return "sem_opcao";
      if (state.passo === "escolhendo_frete") {
        return state.opcoesDeFrete && n <= state.opcoesDeFrete.length ? { type: "pick", source: "freight", index: n - 1 } : "frete_inexistente";
      }
      if (onScreen) return n <= state.emEscolha!.opcoes.length ? { type: "pick", source: "screen", index: n - 1, qty: clampQty(a.qty) } : "opcao_fora_da_tela";
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
      const attribute = a.attribute?.replace(/\s+/g, " ").trim();
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
      const target = resolveTarget(state, a.target);
      if (!target) return "alvo_invalido";
      return target.kind === "screen" ? { type: "skip_current" } : { type: "remove", target };
    }
    case "swap": {
      const from = resolveTarget(state, a.from ?? a.target);
      if (!from || from.kind !== "basket") return "alvo_invalido";
      const to = a.to?.replace(/\s+/g, " ").trim();
      if (!to || to.length > 100) return "sem_destino";
      return { type: "swap", from, to };
    }
    case "skip_current":
      return onScreen ? { type: "skip_current" } : "sem_opcoes_na_tela";
    case "only_keep": {
      const target = resolveTarget(state, a.target ?? (onScreen ? 0 : undefined));
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
      const said = a.text?.trim();
      // Só um CEP: vale como CEP solto (o fluxo de endereço novo já cuida); com rua, vai junto.
      if (said && extractCep(said) && said.replace(/\D/g, "").length <= 8) return { type: "rewrite", text: said, label: "change_address" };
      return { type: "rewrite", text: said ? `trocar endereço: ${said}` : "trocar endereço", label: "change_address" };
    }
    case "smalltalk":
      return { type: "reply", kind: "smalltalk", text: a.text };
    case "unclear":
      return { type: "reply", kind: "unclear", text: a.text };
    default:
      return "desconhecida";
  }
}
