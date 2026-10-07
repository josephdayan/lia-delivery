// Gerente de diálogo ANTES do cadastro (rodada 2 do plano-conversa-100, 07/10/2026). Placar com o
// gerente ligado: sem endereço confirmado a mensagem ainda era lida por regex, e pedaço de frase virava
// item ("tenho uns 120 reais no total", "no total com entrega", "secreto do trabalho", "eu tenho receita",
// "FIM", "vou aguardar", "o mais barato" pedindo de novo o produto…). Aqui a IA lê a mensagem e extrai
// o que ela É (itens com quantidade, orçamento, preferência, perguntas do serviço, remédio, despedida,
// pedido de atendente); o CÓDIGO guarda os itens no `pendingRequest`, responde pelos textos fixos e só
// pede o endereço quando há pedido de produto. Endereço, CEP e CPF continuam determinísticos (nem
// chegam aqui). IA fora do ar, timeout ou decisão sem ação = o caminho de hoje assume.
import { liaTextModel, sanitizeRouterReply } from "../adapters/ai";
import type { DeliveryContext } from "../conversation-types";
import * as copy from "../lia-copy";
import { looksLikeMedicine, type Intent } from "../lia-intents";
import { isPrescriptionDrugName } from "../medicine";
import { reply, turnMeta, writeCtx } from "../turn-runtime";
import { ANSWER_TEXT } from "./plan";
import { ANSWER_TOPICS, type AnswerTopic, type PlanOutcome } from "./types";

export type PreSignupState = {
  passo: "sem_cadastro" | "pedindo_endereco" | "pedindo_cep";
  itensAnotados: string[];
  recusouRemedioRecente: boolean;
  atendimentoAberto: boolean;
  ultimaFalaDaLia: string | null;
};

export type PreItem = { query: string; qty: number; cheapest: boolean };

export type PreDecision = {
  items: PreItem[];
  budget: number | null;
  answers: AnswerTopic[];
  medicine: boolean;
  outOfScope: boolean;
  human: boolean;
  waiting: boolean;
  farewell: boolean;
  vague: boolean;
  smalltalk?: string;
};

export type PreModelInput = { text: string; state: PreSignupState };

export const PRESIGNUP_SYSTEM_PROMPT = `Você é o GERENTE DE DIÁLOGO da Lia, concierge de compras do dia a dia no WhatsApp (compra em lojas oficiais — mercado, farmácia sem remédio, casa, pet, beleza, eletrônicos, brinquedos, presentes —; o cliente aprova o total e paga por Pix ou cartão; a entrega é da própria loja). O cliente ainda NÃO terminou o cadastro (falta o endereço com CEP). Você NÃO escreve para o cliente: lê a MENSAGEM e o ESTADO (JSON) e devolve um JSON de classificação; o sistema responde com textos fixos.

ESTADO: passo (sem_cadastro | pedindo_endereco | pedindo_cep); itensAnotados (o que a Lia já guardou do pedido); recusouRemedioRecente; atendimentoAberto (o responsável humano já foi avisado e o cliente espera); ultimaFalaDaLia.

CAMPOS (todos obrigatórios; o que não se aplica fica vazio/null/false):
- items: os PRODUTOS que o cliente PEDE agora, cada um {query, qty, cheapest}. query = SÓ o produto, como ele escreveu (marca, nome, tamanho, atributo do produto); sem "quero/preciso/me ve/tenho", sem orçamento, sem urgência, sem contexto ("do trabalho", "amigo secreto", "pro meu sobrinho de 5 anos" só entra se define o produto). Presente sem produto definido continua como ele disse ("presente pra minha mãe", "presente pro meu sobrinho de 5 anos"): a busca sabe converter. Quantidade DITA = qty ("3 leites" = 3; "2 litros de leite" = qty 1 e query "leite 2 litros"; sem número = 1). cheapest = true só se ele pede o mais barato / mais em conta DAQUELE item. Vários produtos = vários itens. Item que já está em itensAnotados e que ele só repete NÃO entra de novo.
- budget: número em reais se ele diz quanto quer ou pode gastar ("uns 120 reais", "até 130 no total com entrega", "no máximo 60"); senão null. Orçamento NUNCA é item.
- answers: perguntas sobre o SERVIÇO que ele fez (o texto da resposta é fixo): ${ANSWER_TOPICS.join(", ")}. Pedido de CNPJ/nome do responsável = cnpj. "O que você recomenda?" / "me indica algo" NÃO é answers (é pedido de produto: items, ou vague).
- medicine: true se ele pede remédio/medicamento/antibiótico/tarja preta, OU insiste depois da recusa ("eu tenho receita", "mas é urgente", "e um genérico?", "pra dor o que tem?", "não consegue nem com receita?"). Remédio NUNCA entra em items. Pergunta sobre dar um jeito de conseguir remédio ("não consegue nem com receita?", "não tem como encomendar por aqui?", "e por uma farmácia parceira?") depois do pedido de remédio também é medicine, nunca answers. Produto não-remédio que ele pede em seguida ("bolsa térmica", "um chá") entra em items normalmente.
- outOfScope: true se pede algo que a Lia NÃO vende por natureza: veículo, imóvel, serviço (uber, encanador, conserto), empréstimo/dinheiro, animal vivo, arma, droga. Produto comum de loja (inclusive TV, celular, fone, brinquedo, móvel) NÃO é fora de escopo: vira item. Se true, a coisa pedida NÃO entra em items.
- human: true se pede falar com uma pessoa/atendente/dono/gerente/responsável OU cobra a resposta dela de novo ("ninguém apareceu", "cadê o atendente?").
- waiting: true se, com atendimentoAberto, ele diz que vai aguardar/esperar o retorno da pessoa e não pede mais nada ("beleza, vou aguardar", "tô esperando eles me mandarem o CNPJ"). Se pede algo novo junto, é human/answers, não waiting.
- farewell: true se ele se despede ou encerra ("tchau", "obrigado, vou procurar em outro lugar", "FIM", "deixa pra lá", "valeu, era só isso") SEM pedir produto.
- vague: true se quer comprar mas não diz o quê ("me indica algo bom", "me surpreende", "quero algo gostoso") — sem exemplo concreto de produto.
- smalltalk: uma frase curta e calorosa, SÓ para papo social sem pedido nem pergunta; senão null. Sem promessa, preço, prazo ou desconto.

REGRAS: pedaço de frase NUNCA vira produto ("você consegue", "pode tentar", "no total com entrega", "tenho receita", "vou aguardar", "o CNPJ pra eu conferir", "secreto do trabalho"). Pergunta + pedido na mesma mensagem: answers + items. Na dúvida entre pedir produto e perguntar, prefira não inventar item. O cliente escreve informal, com erros e gírias: interprete a intenção.

EXEMPLOS: "quero dar um presente pra minha mãe, tenho uns 120 reais no total com a entrega" -> items [{"presente pra minha mãe",1,false}], budget 120. "amigo secreto do trabalho, uma caixa de bombom, no máximo 60 com a entrega" -> items [{"caixa de bombom",1,false}], budget 60. "qual o desodorante mais barato que vc tem?" -> items [{"desodorante",1,true}]. "mas eu tenho receita" (depois de pedir amoxicilina) -> medicine. "tem alguma bolsa térmica ou algo assim pra aliviar?" -> items [{"bolsa térmica",1,false}]. "Obrigada! FIM" -> farewell. "vcs vendem carro 0km?" -> outOfScope. "pode ser uma lasanha congelada, o que vc recomenda?" -> items [{"lasanha congelada",1,false}]. "beleza, vou aguardar. preciso do CNPJ pra eu conferir" (atendimentoAberto) -> waiting.`;

const NULLABLE = (type: string) => ({ type: [type, "null"] });

export const PRESIGNUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" }, qty: { type: "integer" }, cheapest: { type: "boolean" } },
        required: ["query", "qty", "cheapest"]
      }
    },
    budget: NULLABLE("number"),
    answers: { type: "array", items: { type: "string", enum: [...ANSWER_TOPICS] } },
    medicine: { type: "boolean" },
    outOfScope: { type: "boolean" },
    human: { type: "boolean" },
    waiting: { type: "boolean" },
    farewell: { type: "boolean" },
    vague: { type: "boolean" },
    smalltalk: NULLABLE("string")
  },
  required: ["items", "budget", "answers", "medicine", "outOfScope", "human", "waiting", "farewell", "vague", "smalltalk"]
} as const;

const clampText = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : undefined;
};

// Normaliza o JSON cru (item sem produto cai; tema desconhecido cai). null = JSON inutilizável.
export function parsePreDecision(raw: unknown): PreDecision | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const items: PreItem[] = [];
  for (const item of Array.isArray(r.items) ? r.items.slice(0, 8) : []) {
    const it = item as Record<string, unknown>;
    const query = clampText(it?.query, 100);
    if (!query) continue;
    const qty = typeof it.qty === "number" && Number.isFinite(it.qty) ? Math.round(it.qty) : 1;
    items.push({ query, qty: qty >= 1 ? Math.min(50, qty) : 1, cheapest: it.cheapest === true });
  }
  const budgetRaw = typeof r.budget === "number" && Number.isFinite(r.budget) ? r.budget : null;
  const answers = (Array.isArray(r.answers) ? r.answers : []).filter((t): t is AnswerTopic => ANSWER_TOPICS.includes(t as AnswerTopic)).slice(0, 2);
  return {
    items,
    budget: budgetRaw != null && budgetRaw >= 1 && budgetRaw <= 100000 ? Math.round(budgetRaw * 100) / 100 : null,
    answers: [...new Set(answers)],
    medicine: r.medicine === true,
    outOfScope: r.outOfScope === true,
    human: r.human === true,
    waiting: r.waiting === true,
    farewell: r.farewell === true,
    vague: r.vague === true,
    smalltalk: clampText(r.smalltalk, 200)
  };
}

async function callPreSignupModelReal(input: PreModelInput): Promise<PreDecision | null> {
  if (!process.env.OPENAI_API_KEY || process.env.LIA_DIALOGUE_LLM !== "true") return null;
  try {
    const effort = (process.env.LIA_DIALOGUE_EFFORT ?? process.env.LIA_AI_EFFORT ?? "low").trim();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.LIA_DIALOGUE_TIMEOUT_MS ?? 9000)),
      body: JSON.stringify({
        model: liaTextModel(),
        ...(effort && effort !== "default" ? { reasoning: { effort } } : {}),
        input: [
          { role: "system", content: PRESIGNUP_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ mensagem: input.text, estado: input.state }) }
        ],
        text: { format: { type: "json_schema", name: "presignup_decision", strict: true, schema: PRESIGNUP_SCHEMA } }
      })
    });
    if (!response.ok) {
      console.warn("[dialogue:presignup:fallback]", response.status, (await response.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const payload = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const jsonText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!jsonText) return null;
    return parsePreDecision(JSON.parse(jsonText));
  } catch (error) {
    console.warn("[dialogue:presignup:error]", error instanceof Error ? error.message : error);
    return null;
  }
}

let modelImpl: (input: PreModelInput) => Promise<PreDecision | null> = callPreSignupModelReal;
let seamActive = false;
// Costura de TESTE (como a do gerente principal): decisões determinísticas, sem rede.
export function __setPreSignupModelForTests(fn: ((input: PreModelInput) => Promise<PreDecision | null>) | null) {
  modelImpl = fn ?? callPreSignupModelReal;
  seamActive = Boolean(fn);
}
export function preSignupModelAvailable(): boolean {
  return seamActive || Boolean(process.env.OPENAI_API_KEY);
}

// ---------- quando consultar ----------

// Intenções que ainda passam pela IA antes do cadastro. O resto (CEP, número, saudação, atendente,
// reclamação, "pix"…) tem caminho inequívoco e barato.
const CONSULTED_INTENTS = new Set<Intent["kind"]>(["free_text", "more_options", "thanks"]);
// Passos em que a mensagem tem DONO (nome do destinatário, CPF, pergunta de endereço aberta…).
const COLLECTING_STEPS = new Set<string | undefined>([undefined, "collecting", "need_address", "need_cep"]);

export type PreBypassInput = {
  text: string;
  intent: Intent;
  ctx: DeliveryContext;
  hasAddress: boolean;
  // A mensagem é (ou carrega) endereço/CEP/CPF/número de casa: o fluxo de endereço decide, sem IA.
  addressLike: boolean;
};

export function preSignupBypassReason(i: PreBypassInput): string | null {
  const { ctx } = i;
  if (i.hasAddress) return "com_cadastro";
  if (!COLLECTING_STEPS.has(ctx.step)) return "passo";
  if (ctx.cepSwap || ctx.cepCityCheck || ctx.cpfOnboarding || ctx.cancelReason || ctx.withdrawConfirm) return "pergunta_aberta";
  if (i.addressLike) return "endereco";
  if (!CONSULTED_INTENTS.has(i.intent.kind)) return `intent:${i.intent.kind}`;
  if (!i.text.trim() || i.text.length > 600) return "tamanho";
  // id de botão ("optsku:123", "cadastrar_endereco"): string de máquina, não linguagem.
  if (/^[a-z][a-z0-9]*(?:[:_][a-z0-9:._-]+)+$/i.test(i.text.trim())) return "botao";
  return null;
}

// ---------- plano (puro) ----------

export type PreStep =
  | { type: "fixed"; key: "out_of_scope" | "farewell" | "vague" | "budget_only" }
  | { type: "medicine" }
  | { type: "wait" }
  | { type: "answer"; topics: AnswerTopic[] }
  | { type: "smalltalk"; text: string }
  | { type: "human" }
  // Lista limpa que o fluxo de sempre anota e pede o endereço.
  | { type: "items"; text: string };

export type PrePlan = { ok: true; steps: PreStep[]; label: string; setPreBudget?: number } | { ok: false; reason: string };

const asksCheaper = /\bmais\s+(?:barat|em conta|economic)/i;

export function itemsText(items: PreItem[], budget: number | null): string {
  const lines = items.map((item) => {
    const base = item.cheapest && !asksCheaper.test(item.query) ? `${item.query} mais barato` : item.query;
    return item.qty > 1 && !/^\d/.test(base) ? `${item.qty} ${base}` : base;
  });
  // Teto só vale numa linha: com 2+ produtos o orçamento é do conjunto e a busca por linha não sabe dividi-lo.
  if (budget != null && lines.length === 1) lines[0] = `${lines[0]} até ${Number.isInteger(budget) ? budget : budget.toFixed(2).replace(".", ",")} reais`;
  return lines.join(", ");
}

export function planPreSignup(d: PreDecision, opts: { preBudget?: number } = {}): PrePlan {
  // Remédio nunca é item, venha como vier (a IA pode errar; a guarda de regex fecha a porta).
  const items = d.items.filter((item) => !looksLikeMedicine(item.query) && !isPrescriptionDrugName(item.query));
  const medicine = d.medicine || items.length !== d.items.length;
  // Pedir pessoa vale mais que qualquer outra coisa na mesma mensagem: o dono é avisado pelo caminho fixo.
  if (d.human) return { ok: true, steps: [{ type: "human" }], label: "human" };
  const steps: PreStep[] = [];
  const parts: string[] = [];
  const budget = d.budget ?? opts.preBudget ?? null;
  if (items.length) {
    if (d.answers.length) {
      steps.push({ type: "answer", topics: d.answers });
      parts.push("answer");
    }
    if (medicine) {
      steps.push({ type: "medicine" });
      parts.push("medicine");
    }
    if (d.outOfScope) {
      steps.push({ type: "fixed", key: "out_of_scope" });
      parts.push("out_of_scope");
    }
    steps.push({ type: "items", text: itemsText(items, budget) });
    parts.push("items");
    return { ok: true, steps, label: parts.join("+") };
  }
  if (medicine) return { ok: true, steps: [{ type: "medicine" }], label: "medicine" };
  if (d.outOfScope) return { ok: true, steps: [{ type: "fixed", key: "out_of_scope" }], label: "out_of_scope" };
  if (d.answers.length) return { ok: true, steps: [{ type: "answer", topics: d.answers }], label: `answer:${d.answers.join(",")}` };
  if (d.waiting) return { ok: true, steps: [{ type: "wait" }], label: "waiting" };
  if (d.farewell) return { ok: true, steps: [{ type: "fixed", key: "farewell" }], label: "farewell" };
  if (d.vague) return { ok: true, steps: [{ type: "fixed", key: "vague" }], label: "vague" };
  if (d.budget != null) return { ok: true, steps: [{ type: "fixed", key: "budget_only" }], label: "budget_only", setPreBudget: d.budget };
  if (d.smalltalk) return { ok: true, steps: [{ type: "smalltalk", text: d.smalltalk }], label: "smalltalk" };
  return { ok: false, reason: "sem_acao" };
}

// ---------- execução ----------

export type PreHandlers = {
  refuseMedicine: (phone: string, convoId: string, ctx: DeliveryContext) => Promise<void>;
  attendanceWait: (phone: string, convoId: string, ctx: DeliveryContext) => Promise<void>;
  // Responde uma pergunta do serviço pelo roteador de sempre (texto fixo do lia-copy) e devolve o contexto novo.
  answerCanonical: (phone: string, userId: string, convoId: string, ctx: DeliveryContext, canonical: string) => Promise<void>;
};

export type PreSignupTurnInput = PreBypassInput & {
  phone: string;
  convoId: string;
  userId: string;
  lastLiaText?: string;
  handlers: PreHandlers;
};

export function buildPreSignupState(ctx: DeliveryContext, lastLiaText?: string): PreSignupState {
  return {
    passo: ctx.step === "need_cep" ? "pedindo_cep" : ctx.step === "need_address" ? "pedindo_endereco" : "sem_cadastro",
    itensAnotados: ctx.pendingRequest ? ctx.pendingRequest.split(", ").filter(Boolean) : [],
    recusouRemedioRecente: ctx.medicineRefusedAt != null && Date.now() - ctx.medicineRefusedAt < 60 * 60_000,
    atendimentoAberto: Boolean(ctx.attendance && ctx.attendance.notifiedAt > 0),
    ultimaFalaDaLia: lastLiaText ? lastLiaText.slice(0, 300) : null
  };
}

// null = a IA não foi consultada (o caminho de hoje segue, sem custo).
export async function runPreSignupTurn(input: PreSignupTurnInput): Promise<PlanOutcome | null> {
  if (process.env.LIA_DIALOGUE_LLM !== "true" || !preSignupModelAvailable()) return null;
  const bypass = preSignupBypassReason(input);
  if (bypass) return null;
  const started = Date.now();
  const meta = turnMeta.getStore();
  const { ctx, phone, convoId, userId, handlers: h } = input;

  let decision: PreDecision | null;
  try {
    decision = await modelImpl({ text: input.text, state: buildPreSignupState(ctx, input.lastLiaText) });
  } catch (error) {
    console.warn("[dialogue:presignup:error]", error instanceof Error ? error.message : error);
    return { kind: "fallthrough", reason: "erro" };
  }
  if (!decision) {
    console.log(`[dialogue:pre] ação=nenhuma ms=${Date.now() - started} motivo=sem_decisao`);
    return { kind: "fallthrough", reason: "sem_decisao" };
  }
  // A IA do gerente já classificou a mensagem: o roteador de fallback (outra chamada) não repete.
  if (meta) meta.llmUsed = true;
  const plan = planPreSignup(decision, { preBudget: ctx.preBudget });
  if (!plan.ok) {
    console.log(`[dialogue:pre] ação=nenhuma ms=${Date.now() - started} motivo=${plan.reason}`);
    return { kind: "fallthrough", reason: plan.reason };
  }

  const repliesBefore = meta?.replies ?? 0;
  try {
    let outcome: PlanOutcome = { kind: "handled", actions: plan.label };
    for (const step of plan.steps) {
      switch (step.type) {
        case "human":
          outcome = { kind: "rewrite", text: "quero falar com um atendente", actions: plan.label };
          break;
        case "medicine":
          await h.refuseMedicine(phone, convoId, ctx);
          break;
        case "wait":
          await h.attendanceWait(phone, convoId, ctx);
          break;
        case "answer": {
          // Pergunta sozinha: o roteador de sempre responde (rewrite). Junto de itens, responde antes.
          if (plan.steps.length === 1 && step.topics.length === 1) outcome = { kind: "rewrite", text: ANSWER_TEXT[step.topics[0]], actions: plan.label };
          else for (const topic of step.topics) await h.answerCanonical(phone, userId, convoId, ctx, ANSWER_TEXT[topic]);
          break;
        }
        case "smalltalk": {
          const clean = sanitizeRouterReply(step.text);
          if (!clean) return { kind: "fallthrough", reason: "smalltalk_recusado" };
          await reply(phone, clean);
          break;
        }
        case "fixed":
          if (step.key === "out_of_scope") await reply(phone, copy.outOfScopeProductAnswer());
          else if (step.key === "farewell") await reply(phone, copy.medicineFarewell());
          else if (step.key === "vague") await reply(phone, copy.vagueRequestAnswer());
          else {
            ctx.preBudget = plan.setPreBudget;
            await writeCtx(convoId, ctx);
            await reply(phone, copy.askWhatYouWant());
          }
          break;
        case "items":
          // O fluxo de sempre anota (sem duplicar), pede o cadastro/CEP e guarda o pedido para a busca.
          outcome = { kind: "rewrite", text: step.text, actions: plan.label };
          if (ctx.preBudget != null) {
            ctx.preBudget = undefined;
            await writeCtx(convoId, ctx);
          }
          break;
      }
    }
    console.log(`[dialogue:pre] ação=${plan.label} ms=${Date.now() - started} resultado=${outcome.kind}`);
    return outcome;
  } catch (error) {
    if ((meta?.replies ?? 0) > repliesBefore) throw error;
    console.warn("[dialogue:presignup:execute:error]", error instanceof Error ? error.message : error);
    return { kind: "fallthrough", reason: "erro_na_execucao" };
  }
}
