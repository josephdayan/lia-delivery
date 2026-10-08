// Gerente de diálogo × recomendação (08/10/2026, etapa ENTENDER do plano-recomendacoes): a ação
// `recommend` (forma, necessidade/produto, critérios, restrições, pra quem, urgência, sintoma) — parse,
// validação contra o estado, exclusividade, flag, a guarda de "lista nova" e o pré-cadastro (o pedido de
// recomendação vira o pedido guardado até o CEP). A IA é SIMULADA; o E2E usa banco.
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { DIALOGUE_SCHEMA, DIALOGUE_SYSTEM_PROMPT, parseDecision } from "../src/lib/dialogue/model";
import { planActions } from "../src/lib/dialogue/plan";
import { __setPreSignupModelForTests, PRESIGNUP_SCHEMA, PRESIGNUP_SYSTEM_PROMPT, parsePreDecision, planPreSignup, recommendText, type PreDecision } from "../src/lib/dialogue/presignup";
import { buildDialogueState } from "../src/lib/dialogue/state";
import type { DialogueAction, DialogueState } from "../src/lib/dialogue/types";
import { detectIntent } from "../src/lib/lia-intents";
import { recommendRedFlag, vagueRequestAnswer } from "../src/lib/lia-copy";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5510${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
  if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
  (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
    outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
    return key === "sendDeliveryChoices" ? false : { provider: "test", to };
  };
}

process.env.LIA_DIALOGUE_LLM = "true";

const act = (type: DialogueAction["type"], rest: Partial<DialogueAction> = {}): DialogueAction => ({ type, ...rest });
const rec = (rest: Partial<DialogueAction>) => act("recommend", rest);

const fresh: DialogueState = buildDialogueState({ flow: "delivery", step: "collecting" } as DeliveryContext, { hasAddress: true });
function choosingState(): DialogueState {
  return buildDialogueState(
    {
      flow: "delivery",
      step: "choosing",
      pending: [
        {
          query: "leite",
          qty: 1,
          options: [
            { sku: "L1", name: "Leite Integral 1L", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil" },
            { sku: "L2", name: "Leite Desnatado 1L", unitPrice: 6, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje" }
          ]
        }
      ]
    } as DeliveryContext,
    { hasAddress: true }
  );
}

const D = (over: Partial<PreDecision> = {}): PreDecision => ({
  items: [],
  budget: null,
  answers: [],
  medicine: false,
  outOfScope: false,
  human: false,
  waiting: false,
  farewell: false,
  vague: false,
  recommend: false,
  ...over
});

beforeEach(() => {
  process.env.LIA_DIALOGUE_LLM = "true";
  delete process.env.LIA_RECOMMEND;
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
});

// ---------------------------------------------------------------- parse

test("parseDecision: recommend traz forma, necessidade/produto, critérios do enum, restrições, pra quem, urgência e sintoma", () => {
  const d = parseDecision({
    actions: [
      {
        type: "recommend",
        option: null,
        qty: null,
        delta: null,
        target: null,
        query: null,
        attribute: null,
        from: null,
        to: null,
        topic: null,
        method: null,
        text: null,
        sort: null,
        retry: null,
        replace: null,
        form: "need",
        need: "  algo   doce ",
        product: null,
        criteria: ["fast", "rapidissimo", "fast"],
        constraints: ["sem chocolate", "", "sem chocolate"],
        recipient: null,
        urgency: true,
        symptom: null
      }
    ]
  });
  const a = d?.actions[0];
  assert.equal(a?.type, "recommend");
  assert.equal(a?.form, "need");
  assert.equal(a?.need, "algo doce");
  assert.deepEqual(a?.criteria, ["fast"], "critério fora do enum cai; repetido sai");
  assert.deepEqual(a?.constraints, ["sem chocolate"]);
  assert.equal(a?.urgency, true);
  assert.equal(a?.product, undefined);
  // forma desconhecida fica ausente (o plano infere ou recusa)
  assert.equal(parseDecision({ actions: [{ type: "recommend", form: "talvez", need: "fome" }] })?.actions[0].form, undefined);
  // em outra ação, os campos de recomendação nem existem
  assert.equal("form" in (parseDecision({ actions: [{ type: "search", query: "leite", form: "need" }] })?.actions[0] ?? {}), false);
});

test("schema estrito: todo campo novo está em required e aceita null; critérios e forma têm enum", () => {
  const item = DIALOGUE_SCHEMA.properties.actions.items;
  for (const field of ["form", "need", "product", "criteria", "constraints", "recipient", "urgency", "symptom"]) {
    assert.ok((item.required as readonly string[]).includes(field), `${field} fora de required`);
    const type = (item.properties as unknown as Record<string, { type: string | readonly string[] }>)[field].type;
    assert.ok(Array.isArray(type) && type.includes("null"), `${field} não aceita null`);
  }
  assert.deepEqual(item.properties.criteria.items.enum, ["fast", "good", "cheap", "healthy"]);
  assert.ok(item.properties.type.enum.includes("recommend"));
  assert.ok((PRESIGNUP_SCHEMA.required as readonly string[]).includes("recommend"));
});

test("prompts: regra recommend × search, exemplos da seção 0 e sintoma ≠ medicine", () => {
  assert.match(DIALOGUE_SYSTEM_PROMPT, /recommend \{form, need, product, criteria, constraints, recipient, urgency, symptom\}/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"tô com muita fome, quero algo doce" -> recommend form=need need="algo doce" criteria=\[fast\] urgency=true/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"me recomenda um chocolate bom" -> recommend form=product_judged product="chocolate" criteria=\[good\]/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"tô com dor de barriga" -> recommend form=need need="dor de barriga" symptom="dor de barriga"/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"quero chocolate" -> search "chocolate"/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /SINTOMA sem remédio nomeado .* NÃO é medicine/);
  assert.match(PRESIGNUP_SYSTEM_PROMPT, /- recommend: true/);
});

// ---------------------------------------------------------------- plano

test("plano: recommend de necessidade vira o contrato da etapa ENTENDER (source=dialogue, text=mensagem original)", () => {
  const text = "tô com muita fome, quero algo doce";
  const plan = planActions({ actions: [rec({ form: "need", need: "algo doce", criteria: ["fast"], urgency: true })] }, fresh, { text });
  assert.ok(plan.ok);
  const step = plan.ok ? plan.steps[0] : null;
  assert.equal(step?.type, "recommend");
  if (step?.type !== "recommend") return;
  assert.equal(step.request.form, "need");
  assert.equal(step.request.need, "algo doce");
  assert.equal(step.request.text, text);
  assert.equal(step.request.source, "dialogue");
  assert.deepEqual(step.request.criteria, ["fast"]);
  assert.equal(step.request.urgency, true);
});

test("plano: produto + julgamento sem critério dito = good; teto e restrição vêm da MENSAGEM (código), não da IA", () => {
  const judged = planActions({ actions: [rec({ form: "product_judged", product: "chocolate" })] }, fresh, { text: "me recomenda um chocolate bom" });
  assert.ok(judged.ok && judged.steps[0].type === "recommend");
  if (judged.ok && judged.steps[0].type === "recommend") {
    assert.equal(judged.steps[0].request.product, "chocolate");
    assert.deepEqual(judged.steps[0].request.criteria, ["good"]);
  }
  const gift = planActions({ actions: [rec({ form: "need", need: "presente pra minha mãe", recipient: "mãe" })] }, fresh, { text: "presente pra minha mãe até 100" });
  assert.ok(gift.ok && gift.steps[0].type === "recommend" && gift.steps[0].request.budget === 100, "teto lido da frase");
  const sweet = planActions({ actions: [rec({ form: "need", need: "algo doce" })] }, fresh, { text: "algo doce sem chocolate" });
  assert.ok(sweet.ok && sweet.steps[0].type === "recommend" && sweet.steps[0].request.constraints.includes("sem chocolate"), "restrição que a IA esqueceu");
  // sem forma: o campo preenchido decide
  const inferred = planActions({ actions: [rec({ symptom: "dor de barriga" })] }, fresh, { text: "tô com dor de barriga" });
  assert.ok(inferred.ok && inferred.steps[0].type === "recommend" && inferred.steps[0].request.form === "need" && inferred.steps[0].request.symptom === "dor de barriga");
});

test("plano: recommend inválido derruba o plano (sem necessidade/produto, texto longo, combinado com outra ação)", () => {
  const reason = (actions: DialogueAction[], state = fresh, text = "x") => {
    const p = planActions({ actions }, state, { text });
    return p.ok ? "ok" : p.reason;
  };
  assert.equal(reason([rec({})]), "recommend:sem_forma");
  assert.equal(reason([rec({ form: "product_judged", need: "algo doce" })]), "recommend:sem_produto");
  assert.equal(reason([rec({ form: "need" })]), "recommend:sem_necessidade");
  assert.equal(reason([rec({ form: "need", need: "x".repeat(121) })]), "recommend:texto_longo");
  assert.equal(reason([rec({ form: "need", need: "algo doce" }), act("search", { query: "leite" })]), "acao_exclusiva_combinada");
  assert.equal(reason([act("remove", { target: 1 }), rec({ form: "need", need: "fome" })]), "acao_exclusiva_combinada");
});

test("plano: com opções na tela, 'mais barato'/'sem açúcar'/'outras' nunca viram recomendação (mesmo se a IA errar)", () => {
  const state = choosingState();
  for (const text of ["mais barato", "sem açúcar", "outras", "qual o melhor?"]) {
    const p = planActions({ actions: [rec({ form: "need", need: text })] }, state, { text });
    assert.deepEqual(p, { ok: false, reason: "recommend:recomendacao_na_tela" }, text);
  }
  // necessidade nova e clara continua valendo com a tela aberta
  const p = planActions({ actions: [rec({ form: "need", need: "algo doce" })] }, state, { text: "tô com fome, quero algo doce" });
  assert.ok(p.ok && p.steps[0].type === "recommend");
});

test("plano (revisão C4, 08/10): com opções na tela e sem sinal das regras, recommend cai em QUALQUER tamanho; sintoma e emergência passam", () => {
  const state = choosingState();
  const long = "e qual desses aí você acha que fica melhor pra dar de presente pra alguém";
  assert.deepEqual(planActions({ actions: [rec({ form: "need", need: "presente" })] }, state, { text: long }), { ok: false, reason: "recommend:recomendacao_na_tela" });
  // sintoma dito pela IA passa (a MAPEAR decide o alerta)
  const sym = planActions({ actions: [rec({ form: "need", need: "dor de cabeça", symptom: "dor de cabeça" })] }, state, { text: "nossa, bateu uma dor de cabeça agora" });
  assert.ok(sym.ok && sym.steps[0].type === "recommend");
  // emergência passa mesmo se a IA não marcou sintoma
  const em = planActions({ actions: [rec({ form: "need", need: "algo quente" })] }, state, { text: "tô com o peito apertado e suando frio" });
  assert.ok(em.ok && em.steps[0].type === "recommend");
});

test("prompts (revisão C1/C2/BAIXO): quantidade + 'bom' é search; estado é need; insistir em remédio depois do alerta é medicine", () => {
  assert.match(DIALOGUE_SYSTEM_PROMPT, /Quantidade \+ produto = search/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"manda 2 pacotes de arroz bom" -> search "arroz" qty=2/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"tô de dieta, o que você indica" -> need="algo leve"/);
  assert.match(DIALOGUE_SYSTEM_PROMPT, /"mas quero um remédio mesmo".* = medicine/);
});

test("pré-cadastro (revisão A2): frase com emergência responde o alerta NA HORA (sem CEP), decida a IA o que decidir", () => {
  for (const decision of [D({ recommend: true }), D({ items: [{ query: "sopa", qty: 1, cheapest: false }] }), D({ human: true }), D({ smalltalk: "oi!" })]) {
    const plan = planPreSignup(decision, { text: "tô com o peito apertado e suando frio" });
    assert.deepEqual(plan, { ok: true, steps: [{ type: "fixed", key: "red_flag", reason: "dor no peito" }], label: "red_flag" });
  }
  const air = planPreSignup(D({ recommend: true }), { text: "tô com falta de ar" });
  assert.ok(air.ok && air.steps[0].type === "fixed" && air.steps[0].key === "red_flag" && air.steps[0].reason === "falta de ar");
  // sem emergência: o caminho de sempre
  const normal = planPreSignup(D({ recommend: true }), { text: "tô com dor de barriga" });
  assert.ok(normal.ok && normal.steps[0].type === "recommend");
  const wine = planPreSignup(D({ items: [{ query: "vinho sangue de boi", qty: 1, cheapest: false }] }), { text: "um vinho sangue de boi" });
  assert.ok(wine.ok && wine.steps[0].type === "items");
});

test("plano: LIA_RECOMMEND=false — produto julgado vira a busca de sempre; necessidade cai no caminho de hoje", () => {
  process.env.LIA_RECOMMEND = "false";
  const judged = planActions({ actions: [rec({ form: "product_judged", product: "chocolate" })] }, fresh, { text: "me recomenda um chocolate bom" });
  assert.deepEqual(judged, { ok: true, steps: [{ type: "search", lines: [{ query: "chocolate", qty: 1 }] }] });
  const need = planActions({ actions: [rec({ form: "need", need: "fome" })] }, fresh, { text: "tô com fome" });
  assert.deepEqual(need, { ok: false, reason: "recommend:recomendacao_desligada" });
});

test("bypass: 'tô com muita fome, quero algo doce' não é lista nova (a IA decide); lista de verdade continua sem IA", () => {
  const ctx = { flow: "delivery", step: "collecting" } as DeliveryContext;
  const why = (text: string) => dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: true });
  assert.equal(why("tô com muita fome, quero algo doce"), null);
  assert.equal(why("tô com fome quero algo doce"), null);
  assert.equal(why("churrasco pra 8"), null);
  assert.equal(why("arroz, feijão e café"), "lista_nova");
  // sintoma com "horrível" o regex lê como reclamação: com recomendação ligada, a IA decide
  assert.equal(detectIntent("to com uma dor de cabeça horrível").kind, "complaint");
  assert.equal(why("to com uma dor de cabeça horrível"), null);
  assert.equal(why("o atendimento de vocês é horrível"), "intent:complaint");
  assert.equal(why("2 cocas"), "lista_nova");
});

// ---------------------------------------------------------------- pré-cadastro

test("pré-cadastro: recomendação/vago vira o pedido guardado com a MENSAGEM ORIGINAL (rewrite), não texto fixo", () => {
  const text = "tô com muita fome, quero algo doce";
  const plan = planPreSignup(D({ recommend: true }), { text });
  assert.deepEqual(plan, { ok: true, steps: [{ type: "recommend", text }], label: "recommend" });
  const vague = planPreSignup(D({ vague: true }), { text: "me surpreende" });
  assert.ok(vague.ok && vague.steps[0].type === "recommend" && vague.steps[0].text === "me surpreende");
  // pergunta + recomendação: responde a pergunta e guarda o pedido
  const withAnswer = planPreSignup(D({ recommend: true, answers: ["delivery_time"] }), { text: "tô com fome, entrega hoje?" });
  assert.ok(withAnswer.ok && withAnswer.steps.map((s) => s.type).join("+") === "answer+recommend");
  // item concreto junto: a lista de sempre (o produto nomeado sem julgamento é busca)
  const items = planPreSignup(D({ recommend: true, items: [{ query: "coca", qty: 2, cheapest: false }] }), { text: "2 cocas e me indica um chocolate bom" });
  assert.ok(items.ok && items.steps[0].type === "items");
  // remédio na mesma mensagem: só a porta do remédio
  const med = planPreSignup(D({ recommend: true, medicine: true }), { text: "dor de cabeça, tem dipirona?" });
  assert.ok(med.ok && med.steps.length === 1 && med.steps[0].type === "medicine");
  // teto dito ANTES, em outra mensagem, acompanha o pedido; o da própria frase não duplica
  assert.equal(recommendText("presente pra minha mãe", 100), "presente pra minha mãe até 100 reais");
  assert.equal(recommendText("presente pra minha mãe até 100", 100), "presente pra minha mãe até 100");
  const pre = planPreSignup(D({ recommend: true }), { text: "presente pra minha mãe", preBudget: 80 });
  assert.ok(pre.ok && pre.steps[0].type === "recommend" && pre.steps[0].text === "presente pra minha mãe até 80 reais");
});

test("pré-cadastro: LIA_RECOMMEND=false mantém a copy de pedido vago; parse lê o campo recommend", () => {
  process.env.LIA_RECOMMEND = "false";
  assert.deepEqual(planPreSignup(D({ recommend: true }), { text: "tô com fome" }), { ok: true, steps: [{ type: "fixed", key: "vague" }], label: "vague" });
  assert.deepEqual(planPreSignup(D({ vague: true }), { text: "me surpreende" }), { ok: true, steps: [{ type: "fixed", key: "vague" }], label: "vague" });
  delete process.env.LIA_RECOMMEND;
  const raw = { items: [], budget: null, answers: [], medicine: false, outOfScope: false, human: false, waiting: false, farewell: false, vague: false, recommend: true, smalltalk: null };
  assert.equal(parsePreDecision(raw)?.recommend, true);
  assert.equal(parsePreDecision({ ...raw, recommend: "sim" })?.recommend, false);
});

// ---------------------------------------------------------------- E2E (banco)

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `rec_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function registered() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  return phone;
}
// O que o gerente registrou neste turno (`[dialogue] ação=…` / `[dialogue:pre] ação=…`).
async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = original;
  }
}
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

test("E2E: a IA devolve recommend → o executor chama handleRecommend (nada de busca literal de 'doce')", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  const seen: string[] = [];
  __setDialogueModelForTests(async (input) => {
    seen.push(input.text);
    return { actions: [rec({ form: "need", need: "algo doce", criteria: ["fast"], urgency: true })] };
  });
  const { result: out, logs } = await withLogs(() => send(phone, "tô com muita fome, quero algo doce"));
  assert.deepEqual(seen, ["tô com muita fome, quero algo doce"], "a IA foi consultada (não caiu em lista_nova)");
  assert.ok(logs.some((l) => /\[dialogue\] ação=recommend\(need\).*resultado=handled/.test(l)), logs.join("\n"));
  assert.ok(out.trim().length > 0, "o cliente recebeu resposta");
  // Seja o stub do orquestrador (copy de pedido vago) ou a execução real, a busca literal ("uva doce",
  // "batata doce") nunca aparece.
  assert.doesNotMatch(out, /batata doce|uva doce/i);
});

test("E2E pré-cadastro: sintoma vira rewrite com a mensagem original e o fluxo pede o endereço (sem texto fixo de pedido vago)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  __setPreSignupModelForTests(async () => D({ recommend: true }));
  const { result: out, logs } = await withLogs(() => send(phone, "tô com dor de barriga"));
  assert.ok(logs.some((l) => /\[dialogue:pre\] ação=recommend .*resultado=rewrite/.test(l)), logs.join("\n"));
  assert.match(out, /endere[cç]o|CEP/i, out);
  assert.ok(!out.includes(vagueRequestAnswer()), "não responde a copy fixa de pedido vago");
});

test("E2E pré-cadastro (revisão A2): emergência responde o alerta na hora — sem pedir endereço/CEP e sem chamar a IA", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  let called = false;
  __setPreSignupModelForTests(async () => {
    called = true;
    return D({ recommend: true });
  });
  const { result: out, logs } = await withLogs(() => send(phone, "tô com o peito apertado e suando frio"));
  assert.equal(called, false, "a IA nem foi chamada");
  assert.ok(logs.some((l) => /\[dialogue:pre\] ação=red_flag .*resultado=handled/.test(l)), logs.join("\n"));
  assert.ok(out.includes(recommendRedFlag("dor no peito")), out);
  assert.doesNotMatch(out, /CEP|endere[cç]o/i);
});
