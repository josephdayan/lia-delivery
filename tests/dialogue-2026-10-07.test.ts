// Gerente de diálogo (LIA_DIALOGUE_LLM, Fase 2 do plano-conversa-100, 07/10/2026): a IA escolhe
// uma ação de lista fechada, o código valida e executa pelos handlers existentes. Aqui a IA é
// SIMULADA (`__setDialogueModelForTests`): provamos o executor, o plano e o gancho — não o modelo.
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { buildDialogueState } from "../src/lib/dialogue/state";
import { parseDecision } from "../src/lib/dialogue/model";
import { ANSWER_TEXT, planActions } from "../src/lib/dialogue/plan";
import { ANSWER_TOPICS, type DialogueAction, type DialogueDecision, type DialogueState, type ModelInput } from "../src/lib/dialogue/types";
import { asksRunningTotal, detectIntent } from "../src/lib/lia-intents";
import type { DeliveryContext } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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

// IA simulada: `script` devolve as ações para cada mensagem; `calls` guarda o que ela recebeu.
let calls: ModelInput[] = [];
function model(script: (input: ModelInput) => DialogueAction[] | null) {
  calls = [];
  __setDialogueModelForTests(async (input) => {
    calls.push(input);
    const actions = script(input);
    return actions ? { actions } : null;
  });
}
const act = (type: DialogueAction["type"], rest: Partial<DialogueAction> = {}): DialogueAction => ({ type, ...rest });

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `dlg_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
type Line = { sku: string; name: string; qty: number };
async function basket(phone: string): Promise<Line[]> {
  return ((await context(phone)).basket ?? []) as Line[];
}
// Escolha aberta montada à mão (o seed de teste é uma loja só).
async function withChoice(phone: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const options = [
    { sku: "CRF-PAD-003", name: "Leite UHT Integral Carrefour Classic 1L", unitPrice: 5.38, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 },
    { sku: "MB-LEITE-1", name: "Leite Integral Italac 1L", unitPrice: 6.04, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje", etaMinutes: 120 },
    { sku: "CRF-PAD-027", name: "Leite Integral Jussara Max 1L", unitPrice: 5.71, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil", etaMinutes: 1440 }
  ];
  await prisma.conversation.create({
    data: {
      userId: user.id,
      context: JSON.stringify({
        flow: "delivery",
        step: "choosing",
        cep: "01310-100",
        deliveryAddress: ADDRESS,
        deliveryAddressVerified: true,
        storeKey: "concierge",
        pending: [{ query: "leite", qty: 1, options }],
        pendingSince: Date.now(),
        ...extra
      })
    }
  });
  return options;
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
beforeEach(() => {
  process.env.LIA_DIALOGUE_LLM = "true";
});
after(async () => {
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------- puros

test("cada tema de 'answer' vira uma pergunta que o roteador reconhece (texto fixo do lia-copy)", () => {
  const expected: Record<string, string[]> = {
    delivery_fee: ["service_question"],
    delivery_time: ["service_question"],
    payment_methods: ["service_question"],
    area: ["service_question"],
    service_fee: ["service_question"],
    price_compare: ["service_question"],
    safety: ["trust_question"],
    identity: ["identity"],
    invoice: ["fiscal_question"],
    cnpj: ["fiscal_question"],
    who_delivers: ["who_delivers"],
    pix_receiver: ["service_question"],
    coupon: ["coupon_promo"],
    installments: ["installments_question"],
    scheduling: ["scheduling_question"],
    stores: ["service_question"],
    how_it_works: ["service_question"],
    order_total: ["free_text"],
    minimum_order: ["missing_question"]
  };
  for (const topic of ANSWER_TOPICS) {
    const intent = detectIntent(ANSWER_TEXT[topic]);
    assert.ok(expected[topic].includes(intent.kind), `${topic} -> ${ANSWER_TEXT[topic]} deu ${intent.kind}`);
  }
  assert.ok(asksRunningTotal(ANSWER_TEXT.order_total), "order_total cai no total parcial");
});

test("frases canônicas das ações que reencaminham ao roteador: fechar, atendente, status, cancelar, pagar, outras", () => {
  assert.equal(detectIntent("só isso").kind, "done");
  assert.equal(detectIntent("quero falar com um atendente").kind, "human");
  assert.equal(detectIntent("cadê meu pedido?").kind, "status");
  assert.equal(detectIntent("cancelar").kind, "cancel");
  assert.equal(detectIntent("trocar endereço").kind, "change_address");
  assert.equal(detectIntent("pix").kind, "choose_payment");
  assert.equal(detectIntent("cartão").kind, "choose_payment");
  assert.equal(detectIntent("quero pagar").kind, "pay");
  assert.equal(detectIntent("outras opções").kind, "more_options");
  assert.equal(detectIntent("mais barato").kind, "more_options");
});

function ctxChoosing(): DeliveryContext {
  return {
    flow: "delivery",
    step: "choosing",
    basket: [{ sku: "A", name: "Ração Golden 10kg", qty: 1, unitPrice: 100, lineTotal: 100, storeKey: "cobasi", storeLabel: "Cobasi" }],
    pending: [
      {
        query: "leite",
        qty: 1,
        options: [
          { sku: "L1", name: "Leite Integral 1L", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour", delivery: "1 dia útil" },
          { sku: "L2", name: "Leite Desnatado 1L", unitPrice: 6, storeKey: "mambo", storeLabel: "Mambo", delivery: "hoje" }
        ]
      },
      { query: "sabonete", qty: 2, options: [] }
    ]
  };
}

test("estado enviado à IA: cesta, opções na tela e fila numeradas em sequência; dinheiro só para leitura", () => {
  const state = buildDialogueState(ctxChoosing(), { hasAddress: true });
  assert.equal(state.passo, "escolhendo_opcao");
  assert.deepEqual(state.cesta.map((c) => [c.n, c.qtd]), [[1, 1]]);
  assert.deepEqual(state.emEscolha?.opcoes.map((o) => [o.n, o.loja]), [[1, "Carrefour"], [2, "Mambo"]]);
  assert.deepEqual(state.fila, [{ n: 2, item: "sabonete", qtd: 2 }]);
  assert.equal(state.totalNaMesa, null);
  assert.ok(state.emEscolha!.opcoes.every((o) => o.preco > 5), "preço exibido (com o serviço)");
});

test("estado: sem escolha aberta, mostra a última escolha com a opção que entrou na cesta marcada", () => {
  const ctx: DeliveryContext = {
    flow: "delivery",
    step: "collecting",
    basket: [{ sku: "L1", name: "Leite Integral 1L", qty: 1, unitPrice: 5, lineTotal: 5, storeKey: "carrefour", storeLabel: "Carrefour" }],
    lastChoice: { query: "leite", qty: 1, chosenSku: "L1", options: [{ sku: "L1", name: "Leite Integral 1L", unitPrice: 5 }, { sku: "L2", name: "Leite Desnatado 1L", unitPrice: 30 }] },
    lastMiss: { query: "bola de tênis", qty: 1, at: Date.now() }
  };
  const state = buildDialogueState(ctx, { hasAddress: true });
  assert.equal(state.passo, "montando_lista");
  assert.deepEqual(state.ultimaEscolha?.opcoes.map((o) => o.escolhida ?? false), [true, false]);
  assert.equal(state.naoAcheiRecente?.pedido, "bola de tênis");
});

function plan(actions: DialogueAction[], state: DialogueState) {
  const decision: DialogueDecision = { actions };
  return planActions(decision, state);
}

test("plano: ação inválida para o estado derruba tudo (opção fora da tela, alvo inexistente, exclusiva combinada)", () => {
  const state = buildDialogueState(ctxChoosing(), { hasAddress: true });
  assert.equal(plan([act("pick", { option: 7 })], state).ok, false);
  assert.equal(plan([act("pick", { option: 2 })], state).ok, true);
  assert.equal(plan([act("remove", { target: 9 })], state).ok, false);
  assert.equal(plan([act("set_qty", { target: 1 })], state).ok, false, "sem quantidade");
  assert.equal(plan([act("close_list"), act("search", { query: "pão" })], state).ok, false, "fechar não combina com outra ação");
  assert.equal(plan([act("search", { query: "" })], state).ok, false);
  const noScreen = buildDialogueState({ flow: "delivery", step: "collecting", basket: ctxChoosing().basket }, { hasAddress: true });
  assert.equal(plan([act("pick", { option: 1 })], noScreen).ok, false, "sem opções nem última escolha");
  assert.equal(plan([act("refine", { attribute: "coco" })], noScreen).ok, false);
  assert.equal(plan([act("skip_current")], noScreen).ok, false);
});

test("plano: busca em sequência vira uma linha só; remove do item da tela vira skip_current; troca resolve o alvo da cesta", () => {
  const state = buildDialogueState(ctxChoosing(), { hasAddress: true });
  const merged = plan([act("search", { query: "pão", qty: 2 }), act("search", { query: "manteiga" })], state);
  assert.ok(merged.ok && merged.steps.length === 1 && merged.steps[0].type === "search");
  if (merged.ok && merged.steps[0].type === "search") assert.deepEqual(merged.steps[0].lines, [{ query: "pão", qty: 2 }, { query: "manteiga", qty: 1 }]);
  const skip = plan([act("remove", { target: 0 })], state);
  assert.ok(skip.ok && skip.steps[0].type === "skip_current");
  const keep = plan([act("pick", { option: 1 }), act("only_keep", { target: 7 })], state);
  assert.ok(keep.ok && keep.steps[0].type === "only_keep" && keep.steps[0].dropQueueOnly, "'1, só amora' com alvo numerado como cesta");
  assert.equal(plan([act("only_keep", { target: 9 })], state).ok, false, "sem pick, alvo inexistente continua inválido");
  const swap = plan([act("swap", { from: 1, to: "ração premier" })], state);
  assert.ok(swap.ok && swap.steps[0].type === "swap");
  const queue = plan([act("remove", { target: 2 })], state);
  assert.ok(queue.ok && queue.steps[0].type === "remove" && queue.steps[0].target.kind === "queue");
});

test("decisão crua da IA: nulos viram ausentes, enum desconhecido derruba a ação", () => {
  const ok = parseDecision({ actions: [{ type: "pick", option: 2, qty: null, delta: null, target: null, query: null, attribute: null, from: null, to: null, topic: null, method: null, text: null, sort: null, retry: null, replace: null }] });
  assert.deepEqual(ok?.actions[0], { type: "pick", option: 2, qty: undefined, delta: undefined, target: undefined, query: undefined, attribute: undefined, from: undefined, to: undefined, topic: undefined, method: undefined, text: undefined, sort: undefined, retry: undefined, replace: undefined });
  assert.equal(parseDecision({ actions: [{ type: "faz_magica" }] }), null);
  assert.equal(parseDecision({ actions: [] }), null);
  assert.equal(parseDecision(null), null);
});

test("quando NÃO consulta a IA: número, CEP, botões, pix/cartão, cadastro, CPF, cancelar curto, lista nova", () => {
  const ctx = ctxChoosing();
  const base = { ctx, hasAddress: true, looksLikeList: false };
  const why = (text: string, over: Partial<typeof base> & { ctx?: DeliveryContext } = {}) => dialogueBypassReason({ ...base, ...over, text, intent: detectIntent(text) });
  assert.equal(why("2"), "intent:number");
  assert.equal(why("01310-100"), "intent:cep");
  assert.equal(why("optsku:CRF-PAD-003"), "botao");
  assert.equal(why("frete:barato"), "botao");
  assert.equal(why("adicionar_mais"), "botao");
  assert.equal(why("pix", { ctx: { ...ctx, step: "awaiting_quote_confirmation" } }), "intent:choose_payment");
  assert.equal(why("cancelar"), "intent:cancel");
  assert.equal(why("oi"), "intent:greeting");
  assert.equal(why("meu cpf 529.982.247-25"), "cpf");
  assert.equal(why("acho que o 1 taakku"), null, "frase solta: a IA decide");
  assert.equal(why("mais 3 rações"), null);
  assert.equal(why("o 2", { hasAddress: false }), "sem_cadastro");
  assert.equal(why("quero leite", { ctx: { flow: "delivery", step: "need_cep" } }), "passo");
  assert.equal(why("sim", { ctx: { ...ctx, minSwap: { fromStoreKey: "x", replacements: [] } } }), "pergunta_aberta");
  assert.equal(why("2 leites, 1 pão", { ctx: { flow: "delivery", step: "collecting" }, looksLikeList: true }), "lista_nova");
  assert.equal(why("2 leites, 1 pão", { ctx: { ...ctx, step: "choosing" }, looksLikeList: true }), null, "com escolha aberta a IA decide");
  const fresh: DeliveryContext = { flow: "delivery", step: "collecting" };
  assert.equal(why("quero arroz, feijão e café", { ctx: fresh, looksLikeList: true }), "lista_nova");
  // conversa no meio da "lista" (c12): o regex via duas linhas e um pedaço virava produto — a IA decide
  assert.equal(why("Ah legal, queria um sabão em pó, pode ser daqueles mais em conta", { ctx: fresh, looksLikeList: true }), null);
  assert.equal(why("outras opções"), "intent:more_options");
});

// ---------------------------------------------------------------- E2E (banco local, IA simulada)

test("'acho que o 1 taakku' com opções na tela é pick 1 — uma unidade na cesta, nada na fila", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model((input) => {
    assert.equal(input.state.emEscolha?.opcoes.length, 3);
    return [act("pick", { option: 1 })];
  });
  const out = await send(phone, "acho que o 1 taakku");
  assert.equal(calls.length, 1);
  const items = await basket(phone);
  assert.equal(items.length, 1, out.slice(0, 300));
  assert.equal(items[0].sku, "CRF-PAD-003");
  assert.equal(items[0].qty, 1);
  assert.equal(((await context(phone)).pending ?? []).length, 0);
});

test("'mais 3 rações' com ração na cesta é add_qty: soma 3 àquela ração (4), sem apagar nem criar item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("pick", { option: 1 })]);
  await send(phone, "o primeiro, por favor");
  model((input) => {
    assert.equal(input.state.cesta.length, 1);
    return [act("add_qty", { target: 1, delta: 3 })];
  });
  const out = await send(phone, "vamos adicionar mais 3 desse mesmo leite");
  const items = await basket(phone);
  assert.equal(items.length, 1, out.slice(0, 300));
  assert.equal(items[0].qty, 4);
});

test("'troca pelo de R$34': pick na última escolha troca o item da cesta (sem item novo)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const options = await withChoice(phone);
  model(() => [act("pick", { option: 1 })]);
  await send(phone, "esse mesmo, o 1");
  assert.equal((await basket(phone))[0].sku, options[0].sku);
  model((input) => {
    const wanted = input.state.ultimaEscolha!.opcoes.find((o) => o.nome.includes("Italac"))!;
    assert.ok(wanted.preco > 6, "a IA lê o preço exibido");
    return [act("pick", { option: wanted.n })];
  });
  const out = await send(phone, "troca pelo da Mambo");
  const items = await basket(phone);
  assert.equal(items.length, 1, out.slice(0, 300));
  assert.equal(items[0].sku, "MB-LEITE-1");
});

test("'pode tentar em outra loja' depois de 'não achei': busca de novo UMA vez e depois diz a verdade", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  model(() => null);
  const first = await send(phone, "quero bola de tenis");
  assert.match(first, /eu não achei/i, first.slice(0, 200));
  model((input) => {
    assert.equal(input.state.naoAcheiRecente?.jaTentouDeNovo, false);
    return [act("search", { query: "bola de tenis", retry: true })];
  });
  const again = await send(phone, "pode tentar em outra loja?");
  assert.match(again, /eu não achei/i, again.slice(0, 200));
  assert.equal((await context(phone)).lastMiss?.retried, true);
  model((input) => {
    assert.equal(input.state.naoAcheiRecente?.jaTentouDeNovo, true);
    return [act("search", { query: "bola de tenis", retry: true })];
  });
  const honest = await send(phone, "tenta mais uma vez em outra loja");
  assert.match(honest, /Procurei de novo/i, honest.slice(0, 200));
});

test("'só essa' com 1 item na cesta fecha a lista (close_list): o total, nunca 'a qual produto'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("pick", { option: 2 })]);
  await send(phone, "a da mambo");
  model(() => [act("close_list")]);
  const out = await send(phone, "então pode fechar com essa mesma aí");
  assert.doesNotMatch(out, /a qual produto/i, out.slice(0, 300));
  assert.match(out, /Seu pedido|pedido m[ií]nimo|nome de quem|Entrega|Total|forma/i, out.slice(0, 300));
  const items = await basket(phone);
  assert.ok(items.every((i) => i.qty === 1));
});

test("fechar com 'só essa' no chat segue sem IA (inequívoco): o modelo nem é chamado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("pick", { option: 2 })]);
  await send(phone, "a da mambo");
  model(() => {
    throw new Error("não devia consultar a IA");
  });
  const out = await send(phone, "so essa");
  assert.equal(calls.length, 0, "a IA nem foi consultada");
  assert.doesNotMatch(out, /a qual produto/i);
});

test("pergunta do serviço: answer reencaminha ao texto fixo (frete) e a escolha continua na tela", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("answer", { topic: "delivery_fee" })]);
  const out = await send(phone, "e a entrega vem de graça ou eu pago algo a mais?");
  assert.match(out, /frete/i, out.slice(0, 300));
  assert.equal(((await context(phone)).pending ?? []).length, 1, "a escolha segue aberta");
});

test("item novo no meio da escolha entra na fila; replace troca o item da tela", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("search", { query: "arroz" })]);
  const queued = await send(phone, "ah e queria arroz também");
  assert.match(queued, /arroz/i, queued.slice(0, 300));
  let ctx = await context(phone);
  assert.equal(ctx.pending.length, 2, "leite continua na tela, arroz na fila");
  assert.equal(ctx.pending[0].query, "leite");
  model(() => [act("search", { query: "feijão", replace: true })]);
  await send(phone, "na verdade esquece o leite, quero feijão");
  ctx = await context(phone);
  assert.equal(ctx.pending[0].query, "feijão", "o item da tela foi trocado");
  assert.ok(!ctx.pending.some((p: { query: string }) => p.query === "leite"));
});

test("set_qty na tela guarda a quantidade e pergunta qual; skip_current segue; only_keep da tela solta a fila", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("set_qty", { target: 0, qty: 3 })]);
  const out = await send(phone, "quero umas 3 unidades");
  assert.match(out, /3/, out.slice(0, 200));
  let ctx = await context(phone);
  assert.equal(ctx.pending[0].qty, 3);
  assert.equal(ctx.pending[0].qtyExplicit, true);
  model(() => [act("pick", { option: 2 })]);
  await send(phone, "a segunda");
  assert.equal((await basket(phone))[0].qty, 3);

  const phone2 = await customer();
  await withChoice(phone2, {
    pending: [
      { query: "leite", qty: 1, options: [{ sku: "X1", name: "Leite X", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour" }, { sku: "X2", name: "Leite Y", unitPrice: 6, storeKey: "carrefour", storeLabel: "Carrefour" }] },
      { query: "pão", qty: 1, options: [{ sku: "P1", name: "Pão", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour" }] }
    ]
  });
  model(() => [act("only_keep", { target: 0 })]);
  await send(phone2, "só o leite, esquece o pão");
  ctx = await context(phone2);
  assert.equal(ctx.pending.length, 1);
  assert.equal(ctx.pending[0].query, "leite");

  const phone3 = await customer();
  await withChoice(phone3);
  model(() => [act("skip_current")]);
  const skipped = await send(phone3, "nenhuma dessas serve, deixa pra lá");
  assert.match(skipped, /de fora|deixei/i, skipped.slice(0, 200));
});

test("c07: '1, só amora' = pick + only_keep: escolhe a 1 e larga a fila sem abrir o próximo item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone, {
    pending: [
      { query: "leite", qty: 1, options: [{ sku: "X1", name: "Leite X", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour" }, { sku: "X2", name: "Leite Y", unitPrice: 6, storeKey: "carrefour", storeLabel: "Carrefour" }] },
      { query: "pão", qty: 1, options: [{ sku: "P1", name: "Pão", unitPrice: 5, storeKey: "carrefour", storeLabel: "Carrefour" }] }
    ]
  });
  model(() => [act("pick", { option: 1 }), act("only_keep", { target: 0 })]);
  const out = await send(phone, "1, só o leite");
  const ctx = await context(phone);
  assert.deepEqual((ctx.basket as Line[]).map((b) => b.sku), ["X1"], out.slice(0, 300));
  assert.equal((ctx.pending ?? []).length, 0);
  assert.doesNotMatch(out, /Agora \*?p[ãa]o|Olha o que achei/i, "não abriu o item da fila");
});

test("remove e swap resolvem o item pelo número do estado, com o total já na mesa", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  model(() => null);
  await send(phone, "quero arroz");
  await send(phone, "1");
  await send(phone, "quero feijão");
  await send(phone, "1");
  assert.equal((await basket(phone)).length, 2);
  const quote = await send(phone, "pagar");
  assert.match(quote, /Seu pedido/, quote.slice(0, 300));
  model((input) => {
    assert.equal(input.state.passo, "total_na_mesa");
    assert.equal(input.state.cesta.length, 2, "a cesta vem do pedido em aberto");
    assert.ok(input.state.totalNaMesa && input.state.totalNaMesa > 0);
    return [act("remove", { target: 1 })];
  });
  const out = await send(phone, "o primeiro item pode tirar da lista");
  assert.match(out, /Tirei/i, out.slice(0, 300));
  assert.match(out, /feij/i, out.slice(0, 400));
  assert.doesNotMatch(out.split("Tirei")[1] ?? "", /• .*Arroz/i, "o arroz saiu do novo resumo");
});

test("conversa fiada: smalltalk passa pelo filtro anti-promessa; resposta proibida cai no texto seguro", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("smalltalk", { text: "Por nada! Fico feliz em ajudar 😊" })]);
  const nice = await send(phone, "hmm vou pensar um pouquinho");
  assert.match(nice, /Por nada/);
  model(() => [act("smalltalk", { text: "Pode deixar, te dou desconto de 50%!" })]);
  const forbidden = await send(phone, "hmm sei lá, tá caro");
  assert.doesNotMatch(forbidden, /desconto de 50/i);
});

test("ação inválida, IA fora do ar ou erro do modelo: o caminho de hoje responde (cliente nunca fica sem resposta)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("pick", { option: 9 })]);
  const invalid = await send(phone, "acho que o 2 mesmo");
  assert.ok(invalid.length > 0, "respondeu");
  model(() => null);
  const down = await send(phone, "o 3 pode ser");
  assert.ok(down.length > 0);
  __setDialogueModelForTests(async () => {
    throw new Error("boom");
  });
  const boom = await send(phone, "hmm o segundo");
  assert.ok(boom.length > 0);
});

test("c12/c05: pedaço de frase não vira produto — a IA manda só o produto (search) ou só o atributo (refine)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  model(() => [act("search", { query: "sabão em pó" })]);
  const out = await send(phone, "Você consegue comprar qualquer coisa? Tava pensando em sabão em pó.");
  assert.doesNotMatch(out, /Você consegue|eu não achei/i, out.slice(0, 300));
  assert.match(out, /Pó|Lava|Sabão/i, out.slice(0, 300));
  assert.equal((await context(phone)).pending?.[0]?.query.includes("consegue") ?? false, false);

  const phone2 = await customer();
  await withChoice(phone2);
  model(() => [act("refine", { attribute: "integral 1L" })]);
  const refined = await send(phone2, "Consegue tentar procurar em outra loja? Quero exatamente esse integral de 1L.");
  assert.doesNotMatch(refined, /Anotei|Consegue tentar/i, refined.slice(0, 300));
  assert.equal((await context(phone2)).step, "choosing", "a escolha continua aberta");
});

test("c40: depois de 'não achei', 'pode tentar de qualquer marca' é retry (a frase não vira produto)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  model(() => null);
  await send(phone, "quero bola de tenis");
  model(() => [act("search", { query: "bola de tenis", retry: true })]);
  const out = await send(phone, "Pode tentar de qualquer marca, não precisa ser uma específica.");
  assert.match(out, /eu não achei/i, out.slice(0, 300));
  assert.doesNotMatch(out, /Pode tentar de qualquer/i, out.slice(0, 300));
});

test("variável desligada (padrão): a IA do gerente nunca é consultada", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "false";
  const phone = await customer();
  await withChoice(phone);
  model(() => [act("pick", { option: 1 })]);
  await send(phone, "o segundo por favor");
  assert.equal(calls.length, 0);
});
