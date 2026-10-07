// Executor: mapeia cada ação VALIDADA para os handlers que já existem no delivery-service
// (recebidos por parâmetro — sem import circular e sem duplicar lógica). Fechar, pagar,
// cancelar, atendente, status, troca de endereço e perguntas do serviço NÃO são executados
// aqui: viram uma frase canônica reencaminhada ao roteador de intenções (`rewrite`), então
// dinheiro, estorno e textos fixos seguem exatamente os caminhos determinísticos de sempre.
import { sanitizeRouterReply } from "../adapters/ai";
import { orderStore, type BasketItem, type DeliveryContext, type PendingChoice } from "../conversation-types";
import * as copy from "../lia-copy";
import { normalizeMsg, parseRefinement } from "../lia-intents";
import { reopenOrderForEdit } from "../order-payments";
import { getStore } from "../stores";
import { queryTokens } from "../stores/types";
import { turnMeta, writeCtx, reply, addressOnlyCtx } from "../turn-runtime";
import type { dialogueHandlers } from "../delivery-service";
import type { Planned, Target } from "./plan";
import type { PlanOutcome } from "./types";

export type DialogueHandlers = typeof dialogueHandlers;

export type ExecEnv = {
  phone: string;
  convoId: string;
  userId: string;
  userCep: string | null | undefined;
  ctx: DeliveryContext;
  text: string;
  h: DialogueHandlers;
};

type StepResult = "done" | "invalid";

const EDITING = new Set(["search", "qty", "remove", "swap", "only_keep"]);

export async function executePlan(env: ExecEnv, steps: Planned[]): Promise<PlanOutcome> {
  const label = steps.map(describe).join("+");
  // Pergunta/fechamento/pagamento/cancelamento/atendente/status/endereço: o roteador de
  // intenções de sempre executa (a IA só decidiu O QUE o cliente quer, não COMO se faz).
  if (steps.length === 1 && steps[0].type === "rewrite") return { kind: "rewrite", text: steps[0].text, actions: label };
  if (steps.length === 1 && steps[0].type === "more_options") return { kind: "rewrite", text: moreText(steps[0].sort), actions: label };
  if (steps.length === 1 && steps[0].type === "pick" && steps[0].source === "freight") {
    return { kind: "rewrite", text: steps[0].index === 0 ? "frete:barato" : "frete:rapido", actions: label };
  }

  const { ctx, phone, convoId, userCep } = env;
  // Total na mesa + edição da cesta: reabre o pedido antes (como os handlers de edição fazem).
  const editing = steps.some((s) => EDITING.has(s.type) || (s.type === "pick" && s.source === "last"));
  const reopened = editing ? await reopenOrderForEdit(phone, convoId, ctx, userCep) : false;

  for (let i = 0; i < steps.length; i++) {
    const nextIsSearch = steps[i + 1]?.type === "search";
    const result = await runStep(env, steps[i], { reopened, nextIsSearch, nextIsPick: steps[i + 1]?.type === "pick" });
    if (result === "invalid") {
      // Primeiro passo inválido: nada foi dito ao cliente, o caminho de hoje assume.
      // Passo posterior: o que veio antes já respondeu; o resto não se improvisa.
      return i === 0 && !reopened ? { kind: "fallthrough", reason: `passo_invalido:${describe(steps[i])}` } : { kind: "handled", actions: label };
    }
  }
  return { kind: "handled", actions: label };
}

function moreText(sort: "next" | "cheaper" | "pricier"): string {
  return sort === "cheaper" ? "mais barato" : sort === "pricier" ? "mais caro" : "outras opções";
}

function describe(step: Planned): string {
  switch (step.type) {
    case "search":
      return step.retry ? "search(retry)" : step.replace ? "search(replace)" : "search";
    case "rewrite":
      return step.label;
    case "pick":
      return `pick(${step.source}:${step.index + 1})`;
    case "qty":
      return step.mode === "set" ? "set_qty" : "add_qty";
    case "reply":
      return step.kind;
    default:
      return step.type;
  }
}

// Localiza o item da cesta que a IA viu: pelo índice e, se a cesta andou (pedido reaberto
// descarta linhas sem preço), pelo nome.
function locate(ctx: DeliveryContext, target: Target): BasketItem | undefined {
  if (target.kind !== "basket") return undefined;
  const basket = ctx.basket ?? [];
  const byIdx = basket[target.idx];
  if (byIdx && byIdx.name.slice(0, 90) === target.name) return byIdx;
  return basket.find((item) => item.name.slice(0, 90) === target.name);
}

async function runStep(env: ExecEnv, step: Planned, opts: { reopened: boolean; nextIsSearch: boolean; nextIsPick: boolean }): Promise<StepResult> {
  const { ctx, phone, convoId, userCep, userId, h } = env;
  const choosing = ctx.step === "choosing" && Boolean(ctx.pending?.length);
  const current = choosing ? ctx.pending![0] : undefined;
  const store = () => getStore(current?.options[0]?.storeKey ?? ctx.storeKey ?? orderStore(ctx).key);

  switch (step.type) {
    case "search": {
      let text = step.lines.map((l) => (l.qty > 1 && !/^\d/.test(l.query) ? `${l.qty} ${l.query}` : l.query)).join(", ");
      const miss = ctx.lastMiss && Date.now() - ctx.lastMiss.at < 20 * 60_000 ? ctx.lastMiss : undefined;
      // "tenta de novo / em outra loja": o caminho do "não achei" refaz UMA vez e depois diz a verdade.
      if (step.retry && miss) text = "tenta de novo";
      else if (process.env.LIA_DIALOGUE_SKIP_EXTRACT === "true") {
        // A frase já está limpa (IA do gerente): a extração não paga outra chamada de IA.
        const meta = turnMeta.getStore();
        if (meta) meta.routerQuery = text;
      }
      if (choosing && !(step.retry && miss)) await searchDuringChoice(env, text, Boolean(step.replace));
      else await h.handleSearch(phone, convoId, userCep, ctx, text, userId);
      return "done";
    }

    case "pick": {
      if (step.source === "screen") {
        if (!current?.options[step.index]) return "invalid";
        if (step.qty) {
          current.qty = step.qty;
          current.qtyExplicit = true;
        }
        await h.confirmChosenOption(phone, convoId, ctx, userCep, store(), current, current.options[step.index]);
        return "done";
      }
      if (step.source === "last") {
        if (!ctx.lastChoice?.options[step.index]) return "invalid";
        await h.handleChoiceSwitch(phone, convoId, userCep, ctx, { index: step.index }, opts.reopened);
        return "done";
      }
      return "invalid";
    }

    case "refine": {
      if (!current) return "invalid";
      const attrs = parseRefinement(step.attribute);
      if (attrs) {
        await h.refineOptions(phone, convoId, ctx, store(), attrs);
        return "done";
      }
      const base = current.baseQuery ?? current.query;
      const baseTokens = new Set(queryTokens(normalizeMsg(base)));
      const asked = queryTokens(normalizeMsg(step.attribute));
      const fresh = asked.filter((token) => !baseTokens.has(token));
      if (!fresh.length) {
        await h.sendChoices(phone, current);
        return "done";
      }
      const wanted = `${base} ${fresh.join(" ")}`;
      // Tudo o que o cliente pediu tem que estar no produto, não só a palavra nova.
      if (await h.researchChoice(phone, convoId, ctx, current, wanted, asked.join(" "))) return "done";
      await reply(phone, copy.refineNoResult(wanted));
      await h.sendChoices(phone, current);
      return "done";
    }

    case "qty": {
      if (step.target.kind === "screen") {
        if (!current) return "invalid";
        const next = Math.max(1, Math.min(50, step.mode === "set" ? step.value : current.qty + step.value));
        current.qty = next;
        current.qtyExplicit = true;
        await writeCtx(convoId, ctx);
        await h.sendChoices(phone, current, copy.qtyNotedPickOne(next, current.query));
        return "done";
      }
      const item = locate(ctx, step.target);
      if (!item) return "invalid";
      await h.handleQtyAdjust(phone, convoId, userCep, ctx, step.mode === "set" ? { set: step.value } : { delta: step.value }, opts.reopened, item.sku);
      // Com opções na tela, a escolha continua de onde estava.
      if (ctx.step === "choosing" && ctx.pending?.length) await h.sendChoices(phone, ctx.pending[0]);
      return "done";
    }

    case "remove": {
      if (step.target.kind === "basket") {
        const item = locate(ctx, step.target);
        if (!item) return "invalid";
        await h.handleRemove(phone, convoId, userCep, ctx, item.name, { silentIfFound: opts.nextIsSearch, exact: { skus: [item.sku] } });
        return "done";
      }
      if (step.target.kind === "queue") {
        const queued = ctx.pending?.[1 + step.target.idx];
        if (!queued) return "invalid";
        await h.handleRemove(phone, convoId, userCep, ctx, queued.query, { silentIfFound: opts.nextIsSearch, exact: { queries: [queued.query] } });
        return "done";
      }
      return "invalid";
    }

    case "swap": {
      const item = locate(ctx, step.from);
      if (!item) return "invalid";
      await h.handleSwap(phone, convoId, userCep, ctx, item.name, step.to, env.text, undefined, item.sku);
      return "done";
    }

    case "skip_current": {
      if (!current) return "invalid";
      ctx.pending = ctx.pending!.slice(1);
      // Era o único item: "Deixei de fora" já diz o próximo passo.
      if (!ctx.pending.length && !(ctx.basket?.length ?? 0)) {
        await writeCtx(convoId, addressOnlyCtx(ctx, userCep));
        await reply(phone, copy.choiceSkipped(current.query));
        return "done";
      }
      await reply(phone, copy.choiceSkipped(current.query));
      await h.advancePending(phone, convoId, ctx, userCep);
      return "done";
    }

    case "only_keep": {
      if (step.target.kind === "screen") {
        if (!current) return "invalid";
        // "só essa" no item da tela: os que esperam na fila saem; uma opção só já é a escolhida.
        if ((ctx.pending?.length ?? 0) > 1) {
          const skipped = ctx.pending!.slice(1).map((p) => p.query);
          ctx.pending = [current];
          await reply(phone, copy.onlyKeepSkipped(skipped));
        }
        if (step.dropQueueOnly) {
          await writeCtx(convoId, ctx);
          return "done";
        }
        if (current.options.length === 1) {
          await h.confirmChosenOption(phone, convoId, ctx, userCep, store(), current, current.options[0]);
          return "done";
        }
        await writeCtx(convoId, ctx);
        // "só amora, a 1": o pick vem logo a seguir — não reapresenta a lista antes dele.
        if (!opts.nextIsPick) await h.sendChoices(phone, current);
        return "done";
      }
      const kept = locate(ctx, step.target);
      if (!kept) return "invalid";
      const skipped = [...(ctx.basket ?? []).filter((b) => b !== kept).map((b) => b.name), ...(ctx.pending ?? []).map((p) => p.query)];
      ctx.basket = [kept];
      ctx.pending = [];
      await reply(phone, copy.onlyKeepSkipped(skipped));
      await h.advancePending(phone, convoId, ctx, userCep);
      return "done";
    }

    case "reply": {
      // Texto livre da IA passa pelo MESMO filtro anti-promessa do roteador de fallback.
      const clean = sanitizeRouterReply(step.text);
      if (step.kind === "smalltalk") {
        await reply(phone, clean ?? copy.thanks());
        if (current) await h.sendChoices(phone, current);
        return "done";
      }
      if (clean) {
        await reply(phone, clean);
        return "done";
      }
      await reply(phone, copy.choiceNotUnderstood());
      if (current) await h.sendChoices(phone, current);
      return "done";
    }

    default:
      return "invalid";
  }
}

// Produto novo no meio da escolha: entra na FILA (ou troca o item da tela, com `replace`),
// como o caminho de hoje faz — o que já foi escolhido fica na cesta.
async function searchDuringChoice(env: ExecEnv, text: string, replace: boolean) {
  const { ctx, phone, convoId, h } = env;
  const current = ctx.pending![0];
  const added = await h.buildChoicesWithSearchNotice(phone, text, undefined, undefined, undefined, ctx.cep);
  if (!added.autoAdded.length && !added.pending.length) {
    if (added.containsMedicine) await reply(phone, copy.medicineSkippedNote());
    else if (added.containsTobacco) await reply(phone, copy.tobaccoRefusal());
    else {
      const missed = added.notFound.length ? added.notFound : [text];
      await reply(phone, copy.notFoundNote(missed));
      if (missed.length === 1) {
        ctx.lastMiss = { query: missed[0], qty: 1, at: Date.now() };
        await writeCtx(convoId, ctx);
      }
    }
    await h.sendChoices(phone, current);
    return;
  }
  ctx.basket = h.mergeBaskets(ctx.basket ?? [], added.autoAdded);
  const dropped = replace && added.pending.length ? current.query : undefined;
  const queue: PendingChoice[] = dropped ? ctx.pending!.slice(1) : ctx.pending!;
  ctx.pending = dropped ? [...added.pending, ...queue] : [...queue, ...added.pending];
  ctx.notFound = [...(ctx.notFound ?? []), ...added.notFound];
  await writeCtx(convoId, ctx);
  const notes: string[] = [];
  if (dropped) notes.push(copy.choiceSkipped(dropped));
  if (added.autoAdded.length) notes.push(copy.autoAddedNote(added.autoAdded.map((i) => `${i.qty}x ${i.name}`)));
  // Item novo no meio de uma escolha entra na FILA — avisar, senão parece ignorado.
  if (!dropped && added.pending.length) notes.push(copy.queuedItemsNote(added.pending.map((p) => p.query)));
  if (added.notFound.length) notes.push(copy.notFoundNote(added.notFound));
  if (notes.length) await reply(phone, notes.join("\n"));
  await h.sendChoices(phone, ctx.pending[0]);
}
