// Gerente de diálogo, rodada 2 do plano-conversa-100 (07/10/2026): (1) ANTES do cadastro a IA extrai itens/
// orçamento/perguntas em vez do regex; (2) guarda anti-repetição no reply(); (3) "trocar endereço: <endereço>"
// não perde o endereço; (4) produto que a Lia não vende; (5) remédio insistente. A IA é SIMULADA.
import "./helpers/load-env";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests, dialogueBypassReason } from "../src/lib/dialogue";
import { executePlan, type ExecEnv } from "../src/lib/dialogue/execute";
import { __setPreSignupModelForTests, parsePreDecision, planPreSignup, preSignupBypassReason, itemsText, type PreDecision, type PreModelInput } from "../src/lib/dialogue/presignup";
import { __setRepeatModelForTests, isRepeatableVerbatim, mergeSent, sameAsRecent } from "../src/lib/dialogue/repeat";
import { detectIntent } from "../src/lib/lia-intents";
import type { DialogueAction, ModelInput } from "../src/lib/dialogue/types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
  ...over
});
let preCalls: PreModelInput[] = [];
function preModel(script: (input: PreModelInput) => PreDecision | null) {
  preCalls = [];
  __setPreSignupModelForTests(async (input) => {
    preCalls.push(input);
    return script(input);
  });
}
let calls: ModelInput[] = [];
function mainModel(script: (input: ModelInput) => DialogueAction[] | null) {
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
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `r2_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
// Cliente NOVO: sem endereço nem CEP (o caso do pré-cadastro).
async function newcomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone } });
  return phone;
}
async function registered() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function context(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}");
}
async function setCtx(phone: string, ctx: Record<string, unknown>) {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const convo = await prisma.conversation.findFirst({ where: { userId: user.id } });
  const data = JSON.stringify({ flow: "delivery", ...ctx });
  if (convo) await prisma.conversation.update({ where: { id: convo.id }, data: { context: data } });
  else await prisma.conversation.create({ data: { userId: user.id, context: data } });
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
  __setPreSignupModelForTests(null);
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
});
after(async () => {
  __setPreSignupModelForTests(null);
  __setRepeatModelForTests(null);
  __setDialogueModelForTests(null);
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------- puros

test("pré-cadastro: orçamento e perguntas nunca viram item; teto só entra na linha quando há UM produto", () => {
  const one = planPreSignup(D({ items: [{ query: "presente pra minha mãe", qty: 1, cheapest: false }], budget: 120 }));
  assert.ok(one.ok);
  assert.deepEqual(one.ok && one.steps, [{ type: "items", text: "presente pra minha mãe até 120 reais" }]);
  assert.equal(itemsText([{ query: "leite", qty: 2, cheapest: false }, { query: "pão", qty: 1, cheapest: true }], 80), "2 leite, pão mais barato");
  assert.equal(itemsText([{ query: "desodorante mais barato", qty: 1, cheapest: true }], null), "desodorante mais barato", "não duplica a preferência");
  assert.equal(itemsText([{ query: "perfume", qty: 1, cheapest: false }], 99.5), "perfume até 99,50 reais");
});

test("pré-cadastro: remédio nunca vira item (nem se a IA errar); pedir pessoa vale mais que o resto; decisão vazia não faz nada", () => {
  const med = planPreSignup(D({ items: [{ query: "dipirona 500mg", qty: 1, cheapest: false }] }));
  assert.ok(med.ok && med.steps[0].type === "medicine" && med.steps.length === 1);
  const human = planPreSignup(D({ human: true, items: [{ query: "leite", qty: 1, cheapest: false }] }));
  assert.ok(human.ok && human.steps[0].type === "human");
  assert.equal(planPreSignup(D()).ok, false);
  const budgetOnly = planPreSignup(D({ budget: 120 }));
  assert.ok(budgetOnly.ok && budgetOnly.setPreBudget === 120);
});

test("pré-cadastro: decisão crua da IA — item sem produto cai, tema desconhecido cai, orçamento absurdo vira null", () => {
  const d = parsePreDecision({
    items: [{ query: "  ", qty: 1, cheapest: false }, { query: "leite", qty: 0, cheapest: true }],
    budget: -5,
    answers: ["cnpj", "faz_magica"],
    medicine: false,
    outOfScope: true,
    human: false,
    waiting: false,
    farewell: false,
    vague: false,
    smalltalk: null
  });
  assert.deepEqual(d?.items, [{ query: "leite", qty: 1, cheapest: true }]);
  assert.equal(d?.budget, null);
  assert.deepEqual(d?.answers, ["cnpj"]);
  assert.equal(d?.outOfScope, true);
  assert.equal(parsePreDecision(null), null);
});

test("pré-cadastro: quando NÃO consulta a IA — endereço, CEP, CPF, nome, botão, passo com dono, cadastro feito", () => {
  const why = (text: string, over: { hasAddress?: boolean; addressLike?: boolean; ctx?: Record<string, unknown> } = {}) =>
    preSignupBypassReason({
      hasAddress: over.hasAddress ?? false,
      addressLike: over.addressLike ?? false,
      ctx: { flow: "delivery", ...(over.ctx ?? {}) } as Parameters<typeof preSignupBypassReason>[0]["ctx"],
      text,
      intent: detectIntent(text)
    });
  assert.equal(why("tenho uns 120 reais no total"), null);
  assert.equal(why("Obrigada! FIM"), null);
  assert.equal(why("vou aguardar"), null, "thanks também passa");
  assert.equal(why("Rua Augusta, 1500", { addressLike: true }), "endereco");
  assert.equal(why("01310-100"), "intent:cep");
  assert.equal(why("cadastrar_endereco"), "botao");
  assert.equal(why("oi"), "intent:greeting");
  assert.equal(why("Marcos Teste", { ctx: { step: "need_recipient_name" } }), "passo");
  assert.equal(why("sim", { ctx: { cepSwap: { cep: "01310100", askedAt: 1 } } }), "pergunta_aberta");
  assert.equal(why("quero leite", { hasAddress: true }), "com_cadastro");
});

test("guarda anti-repetição: só prosa se repete; dinheiro, link e Pix saem iguais; a janela guarda as 4 últimas", () => {
  assert.equal(isRepeatableVerbatim("Total *R$ 32,29* no Pix."), true);
  assert.equal(isRepeatableVerbatim("00020126MOCKPIX-abc520400005303986"), true);
  assert.equal(isRepeatableVerbatim("Ainda não entrego em Belo Horizonte 😔"), false);
  assert.equal(sameAsRecent("Ainda  não entrego em BELO Horizonte 😔", ["ainda não entrego em belo horizonte 😔"]), true);
  const merged = mergeSent({ texts: ["a", "b", "c"], at: Date.now() }, ["d", "e"]);
  assert.deepEqual(merged?.texts, ["b", "c", "d", "e"]);
  assert.deepEqual(mergeSent({ texts: ["velha"], at: Date.now() - 3_600_000 }, ["nova"])?.texts, ["nova"], "fala de 1 h atrás não conta");
});

test("change_address sem o texto do endereço: a mensagem ORIGINAL segue no rewrite (placar c16)", async () => {
  const original = "trocar endereço: Rua Oscar Freire, 379, apto 12, Jardins, São Paulo, 01426-001";
  const out = await executePlan({ text: original } as ExecEnv, [{ type: "rewrite", text: "trocar endereço", label: "change_address" }]);
  assert.ok(out.kind === "rewrite" && out.text === original, JSON.stringify(out));
  const plain = await executePlan({ text: "quero mudar meu endereço" } as ExecEnv, [{ type: "rewrite", text: "trocar endereço", label: "change_address" }]);
  assert.ok(plain.kind === "rewrite" && plain.text === "trocar endereço");
});

test("'qual o mais barato?' com as opções na tela vai ao roteador de sempre (responde qual é), não à IA", () => {
  const ctx = { flow: "delivery", step: "choosing", pending: [{ query: "desodorante", qty: 1, options: [{ sku: "A", name: "Desodorante A", unitPrice: 5 }] }] } as Parameters<typeof dialogueBypassReason>[0]["ctx"];
  const why = (text: string) => dialogueBypassReason({ text, intent: detectIntent(text), ctx, hasAddress: true, looksLikeList: false });
  assert.equal(why("qual o mais barato?"), "pergunta_menor_preco");
  assert.equal(why("troca pelo mais barato aí"), null);
});

// ---------------------------------------------------------------- E2E: antes do cadastro

test("c23: 'tenho uns 120 reais no total com a entrega' não vira item — o produto guarda o teto e a Lia pede o endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "presente pra minha mãe", qty: 1, cheapest: false }], budget: 120 }));
  const out = await send(phone, "quero dar um presente pra minha mãe, tenho uns 120 reais no total com a entrega");
  assert.equal(preCalls.length, 1);
  const ctx = await context(phone);
  assert.match(ctx.pendingRequest, /presente pra minha mãe/);
  assert.match(ctx.pendingRequest, /120/);
  assert.doesNotMatch(ctx.pendingRequest, /total|entrega/);
  assert.match(out, /endere[cç]o/i);
  assert.doesNotMatch(out, /tenho uns 120 reais/);
});

test("c79: contexto ('amigo secreto do trabalho') e 'com a entrega' ficam de fora da lista anotada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "caixa de bombom", qty: 1, cheapest: false }], budget: 60 }));
  await send(phone, "amigo secreto do trabalho, uma caixa de bombom, no maximo 60 reais com a entrega");
  const ctx = await context(phone);
  assert.match(ctx.pendingRequest, /caixa de bombom/);
  assert.doesNotMatch(ctx.pendingRequest, /secreto|trabalho|entrega/);
});

test("c78: durante a coleta do endereço ('no total com entrega' sozinho) não vira item e o pedido anterior fica", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel((input) => (input.text.includes("perfume") ? D({ items: [{ query: "perfume", qty: 1, cheapest: false }] }) : D({ budget: 130 })));
  await send(phone, "quero um perfume pra minha namorada");
  const out = await send(phone, "no total com entrega, até 130 reais");
  const ctx = await context(phone);
  assert.match(ctx.pendingRequest, /perfume/);
  assert.doesNotMatch(ctx.pendingRequest, /total|entrega/);
  assert.equal(ctx.preBudget, 130, "o teto fica guardado para o pedido");
  assert.doesNotMatch(out, /no total com entrega/);
});

test("c08/c67/c10: despedida ('Obrigada! FIM') depois da recusa de remédio não vira item nem pede endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  await setCtx(phone, { medicineRefusedAt: Date.now() });
  preModel(() => D({ farewell: true }));
  const out = await send(phone, "Obrigada! FIM");
  const ctx = await context(phone);
  assert.equal(ctx.pendingRequest, undefined);
  assert.notEqual(ctx.step, "need_address");
  assert.doesNotMatch(out, /FIM|endere[cç]o/i);
  assert.match(out, /Combinado|é só me chamar/);
});

test("c66/c67: 'eu tenho receita' e 'pra dor o que tem?' → recusa de remédio curta, sem pedir endereço nem anotar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ medicine: true }));
  const first = await send(phone, "mas eu tenho receita");
  const second = await send(phone, "pra dor o que tem?");
  const ctx = await context(phone);
  assert.equal(ctx.pendingRequest, undefined);
  assert.match(first, /rem[eé]dio/i);
  assert.match(second, /rem[eé]dio/i);
  assert.doesNotMatch(first + second, /endere[cç]o|anotei/i);
});

test("c65: depois da recusa, pedir a bolsa térmica ('algo pra aliviar') é pedido normal — anota e pede o endereço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "bolsa térmica", qty: 1, cheapest: false }] }));
  const out = await send(phone, "tem alguma bolsa térmica ou algo assim pra aliviar?");
  assert.equal((await context(phone)).pendingRequest, "bolsa térmica");
  assert.match(out, /bolsa t[eé]rmica/i);
  assert.match(out, /endere[cç]o/i);
});

test("c77: carro 0km → resposta honesta, nada anotado, endereço não é pedido", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ outOfScope: true }));
  const out = await send(phone, "vcs vendem carro 0km?");
  assert.equal((await context(phone)).pendingRequest, undefined);
  assert.match(out, /n[aã]o consigo comprar/i);
  assert.doesNotMatch(out, /endere[cç]o|anotei|n[aã]o achei/i);
});

test("c54: 'qual o desodorante mais barato que vc tem?' guarda o pedido COM a preferência (não pergunta o que ele quer)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "desodorante", qty: 1, cheapest: true }] }));
  const out = await send(phone, "qual o desodorante mais barato que vc tem?");
  assert.equal((await context(phone)).pendingRequest, "desodorante mais barato");
  assert.match(out, /desodorante mais barato/i);
});

test("c29: pedido + 'o que você recomenda?' guarda a lasanha; recomendação não é pergunta de serviço", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "lasanha congelada", qty: 1, cheapest: false }] }));
  const out = await send(phone, "pode ser uma lasanha congelada, o que vc recomenda?");
  assert.equal((await context(phone)).pendingRequest, "lasanha congelada");
  assert.match(out, /lasanha congelada/);
  assert.doesNotMatch(out, /como funciono|Eu procuro o que você pedir/);
});

test("c13: 'vou aguardar' com o dono já avisado → confirmação curta, não vira item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  await setCtx(phone, { step: "need_address", attendance: { kind: "support", since: Date.now(), notifiedAt: Date.now(), acks: 0 } });
  preModel(() => D({ waiting: true }));
  const out = await send(phone, "beleza, vou aguardar. antes de seguir com qualquer compra, preciso que me mandem o nome do responsável e o CNPJ pra eu conferir.");
  const ctx = await context(phone);
  assert.equal(ctx.pendingRequest, undefined);
  assert.doesNotMatch(out, /vou aguardar|Já anotei|CNPJ pra eu conferir/);
  assert.ok(out.length > 10);
});

test("pergunta do serviço junto do pedido: responde (texto fixo) e anota só o produto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "sabão em pó", qty: 1, cheapest: false }], answers: ["delivery_fee"] }));
  const out = await send(phone, "você consegue comprar qualquer coisa? tava pensando em sabão em pó");
  assert.equal((await context(phone)).pendingRequest, "sabão em pó");
  assert.match(out, /frete/i);
  assert.match(out, /sabão em pó/);
});

test("pergunta do serviço sozinha antes do cadastro: resposta fixa pelo roteador, nada anotado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ answers: ["cnpj"] }));
  const out = await send(phone, "qual o cnpj de vocês pra eu conferir?");
  assert.equal((await context(phone)).pendingRequest, undefined);
  assert.ok(out.length > 20);
  assert.doesNotMatch(out, /Já anotei/);
});

test("IA fora do ar (sem decisão): o caminho de hoje assume — nunca fica sem resposta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => null);
  const out = await send(phone, "quero 2 leites");
  assert.equal(preCalls.length, 1);
  assert.match((await context(phone)).pendingRequest ?? "", /leite/);
  assert.match(out, /endere[cç]o/i);
});

test("endereço, CEP e CPF continuam determinísticos: a IA nem é consultada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await newcomer();
  preModel(() => D({ items: [{ query: "isso não deveria ser chamado", qty: 1, cheapest: false }] }));
  await send(phone, "Rua Augusta, 1500, apto 31, Consolação, São Paulo, 01304-001");
  await send(phone, "01310-100");
  assert.equal(preCalls.length, 0);
});

test("LIA_DIALOGUE_LLM desligado: o pré-cadastro não consulta a IA", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_DIALOGUE_LLM = "false";
  const phone = await newcomer();
  preModel(() => D({ farewell: true }));
  await send(phone, "quero leite");
  assert.equal(preCalls.length, 0);
});

// ---------------------------------------------------------------- E2E: gerente principal (com cadastro)

test("c77 com cadastro: out_of_scope responde honesto, sem 'não achei em nenhuma loja'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  mainModel(() => [act("out_of_scope")]);
  const out = await send(phone, "Tenta um Fusca 0km então kkk");
  assert.match(out, /n[aã]o consigo comprar/i);
  assert.doesNotMatch(out, /n[aã]o achei/i);
});

test("c66 com cadastro: 'eu tenho receita' → recusa fixa de remédio (nunca busca)", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  mainModel(() => [act("medicine")]);
  const out = await send(phone, "mas eu tenho receita, pode comprar?");
  assert.match(out, /rem[eé]dio/i);
  assert.equal(((await context(phone)).basket ?? []).length, 0);
});

// ---------------------------------------------------------------- E2E: guarda anti-repetição

test("mesma fala da Lia duas vezes seguidas: a segunda sai reescrita pelo gerente, sabendo o que já foi dito", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  let seen: { customer: string; said: string; recent: string[] } | undefined;
  __setRepeatModelForTests(async (input) => {
    seen = input;
    return "Valeu! Quando precisar é só chamar 💚";
  });
  const first = await send(phone, "obrigado");
  assert.match(first, /Imagina/);
  const second = await send(phone, "valeu mesmo");
  assert.equal(seen?.customer, "valeu mesmo");
  assert.match(seen?.said ?? "", /Imagina/);
  assert.ok(seen?.recent.some((r) => /Imagina/.test(r)));
  assert.match(second, /Valeu! Quando precisar/);
  assert.doesNotMatch(second, /Imagina/);
});

test("guarda anti-repetição: IA fora do ar ou resposta que repete = a mensagem original sai; desligada não toca em nada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  __setRepeatModelForTests(async () => null);
  await send(phone, "obrigado");
  assert.match(await send(phone, "valeu"), /Imagina/);
  __setRepeatModelForTests(async () => "Imagina! Qualquer coisa é só chamar 💚");
  assert.match(await send(phone, "muito obrigado"), /Imagina/);
  process.env.LIA_DIALOGUE_LLM = "false";
  let called = false;
  __setRepeatModelForTests(async () => {
    called = true;
    return "outra";
  });
  assert.match(await send(phone, "valeu demais"), /Imagina/);
  assert.equal(called, false);
});

test("a mesma fala só conta dentro da janela de 10 min e só se a IA do gerente está ligada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await registered();
  __setRepeatModelForTests(async () => "Outra fala 💚");
  await send(phone, "obrigado");
  // envelhece a última fala da Lia: 11 min atrás
  const ctx = await context(phone);
  ctx.lastSent = { ...ctx.lastSent, at: Date.now() - 11 * 60_000 };
  await setCtx(phone, ctx);
  assert.match(await send(phone, "valeu"), /Imagina/, "fora da janela, repete igual");
});
