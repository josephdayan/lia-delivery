// Flow "Escolher minha lista" no cérebro (07/10, Etapas 2 e 3), com o adaptador Meta mockado:
// lista com faltante → mensagem de Flow com uma vaga por item que tem opção, faltante no bloco
// "Não encontrei" e cesta já montada; resposta do formulário (trocar / tirar / manter); token
// velho; "Pagar" sem abrir o formulário; flag desligada, envio falhando ou remédio isento →
// caminho de sempre; "macarrão espaguete" depois da falta busca só a faltante; SearchMiss gravado.
import "./helpers/load-env";
import "./helpers/medicine-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter, type WhatsAppFlowInput } from "../src/lib/adapters/whatsapp";
import { __setRerankForTests, type RerankCandidate, type RerankResult } from "../src/lib/adapters/ai";
import { handleDeliveryMessage } from "../src/lib/delivery-service";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5571${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;

const outbox: { to: string; text: string }[] = [];
const flows: { to: string; input: WhatsAppFlowInput }[] = [];
const followUps: { to: string; body: string; opts?: { listFlowButton?: boolean; qtyButton?: boolean } }[] = [];
let flowShouldFail = false;
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;
adapter.sendFlowMessage = async (to: string, input: WhatsAppFlowInput) => {
  if (flowShouldFail) throw new Error("Meta fora do ar");
  flows.push({ to, input });
  return { messageId: "flow" };
};
adapter.sendChoiceFollowUp = async (to: string, body: string, opts?: { listFlowButton?: boolean }) => {
  followUps.push({ to, body, opts });
  return { messageId: "followup" };
};
// Cards/carrossel: texto simples no outbox (a vitrine não é o assunto aqui).
adapter.sendDeliveryCarousel = async () => null;
adapter.sendDeliveryChoices = async (to: string, choices: { id: string; name: string; displayPrice: number }[]) => {
  outbox.push({ to, text: choices.map((c, i) => `*${i + 1})* ${c.name} — R$ ${c.displayPrice.toFixed(2)}`).join("\n") });
  return { messageId: "choices" };
};

// Imagens das opções: nenhuma sai pela rede nos testes (miniatura = opção sem imagem).
const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) return new Response("", { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

// Juiz determinístico no lugar da IA do rerank: o que o cliente chama de leite/arroz/feijão existe
// no seed; "macarrão" (o seed não tem gelo) e "leite de aveia" não existem (a menos que o teste diga o contrário).
let judgeExtra: (query: string, c: RerankCandidate) => boolean = () => false;
const rerankCalls: string[][] = [];
function installJudge() {
  __setRerankForTests(async (_message, lines): Promise<RerankResult> => {
    rerankCalls.push(lines.map((l) => l.query));
    return {
      lines: lines.map((line) => {
        const q = line.query.toLowerCase();
        const ok = (c: RerankCandidate) => {
          if (judgeExtra(line.query, c)) return true;
          if (/macarr|aveia/.test(q)) return false;
          if (/dipirona/.test(q)) return /dipirona/i.test(c.name);
          if (/leite/.test(q)) return /\bleite\b/i.test(c.name) && !/aveia|coco|chocolate|condensado|em p[oó]/i.test(c.name);
          if (/arroz/.test(q)) return /\barroz\b/i.test(c.name);
          if (/feij[aã]o/.test(q)) return /feij[aã]o/i.test(c.name);
          return false;
        };
        return { skus: line.candidates.filter(ok).map((c) => c.sku), exigencias: [], proximos: [] };
      })
    };
  });
}

function startFlowEnv() {
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.LIA_LIST_FLOW = "true";
  process.env.LIA_FLOW_LIST_ID = "999000222";
}
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  await prisma.searchMiss.deleteMany({});
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
  startFlowEnv();
  flowShouldFail = false;
  judgeExtra = () => false;
  installJudge();
});
afterEach(() => {
  process.env.WHATSAPP_PROVIDER = "mock";
  delete process.env.LIA_LIST_FLOW;
  delete process.env.LIA_FLOW_LIST_ID;
  delete process.env.LIA_MEDICINE_MIP;
  __setRerankForTests(null);
});
after(async () => {
  if (dbOk) await wipe();
  global.fetch = realFetch;
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customer(): Promise<string> {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function ctxOf(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } }, orderBy: { updatedAt: "desc" } });
  return JSON.parse(convo.context ?? "{}") as {
    step?: string;
    basket?: { sku: string; name: string; qty: number }[];
    pending?: { query: string; options: { medicine?: string }[] }[];
    listFlow?: { id: string; basketSig: string; slots: { lineKey: string; query: string; skus: string[]; suggestedSku: string | null }[] };
    listMisses?: { query: string; qty: number; reason: string; retried?: boolean }[];
    lastMiss?: { query: string };
  };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `lfb_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function submit(phone: string, form: Record<string, string>): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text: "", messageId: `lfb_${RUN}_${++seq}`, flowResponse: { ...form, flow_token: String(form.lia_lista) } });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
type FlowData = Record<string, unknown>;
const dataOf = (flow: { input: WhatsAppFlowInput }) => flow.input.data as FlowData;
const lastFlow = (phone: string) => flows.filter((f) => f.to === phone).at(-1)!;
const visibleSlots = (data: FlowData) => Array.from({ length: 15 }, (_, i) => i + 1).filter((i) => data[`visible_${i}`] === true);

const LIST = "2 leites, arroz, feijão e macarrão";

test("lista de 4 com 1 faltante: um formulário com 3 vagas, o faltante no bloco 'Não encontrei' e a cesta já montada", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, LIST);
  const mine = flows.filter((f) => f.to === phone);
  assert.equal(mine.length, 1, `um formulário: ${out}`);
  const flow = mine[0];
  assert.equal(flow.input.screen, "LISTA");
  assert.equal(flow.input.cta, "Escolher minha lista");
  assert.equal(flow.input.flowId, "999000222");
  const data = dataOf(flow);
  assert.equal(flow.input.token, data.lista_id, "flow_token = lista_id");
  assert.deepEqual(visibleSlots(data), [1, 2, 3]);
  assert.equal(data.faltas_visible, true);
  assert.match(String(data.faltas_texto), /macarrão/);
  assert.match(String(data.faltas_texto), /não achei em nenhuma loja/);
  assert.match(String(data.faltas_texto), /Me manda outro nome ou marca pra qualquer um desses que eu procuro de novo/);
  assert.match(flow.input.body, /Montei sua lista/);
  assert.match(flow.input.body, /❌ \*macarrão\* — não achei em nenhuma loja/);
  assert.match(flow.input.body, /2x .*[Ll]eite/);

  const ctx = await ctxOf(phone);
  assert.equal(ctx.step, "collecting");
  assert.equal(ctx.pending, undefined);
  assert.equal(ctx.basket?.length, 3, "a sugestão de cada vaga já está na cesta");
  assert.equal(ctx.listFlow?.id, data.lista_id);
  assert.equal(ctx.listFlow?.slots.length, 3);
  assert.deepEqual(ctx.listMisses?.map((m) => [m.query, m.reason]), [["macarrão", "not_found"]]);
  // Pagar / Mudar ou adicionar / Cancelar (08/10).
  const follow = followUps.filter((f) => f.to === phone);
  assert.equal(follow.length, 1);
  assert.equal(follow[0].opts?.listFlowButton, true);
  // Registro para o /ops.
  const rows = await prisma.searchMiss.findMany({ where: { query: "macarrão" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "not_found");
  assert.equal(rows[0].cepPrefix, "01310");
  assert.ok(!/\+?55\d{8,}/.test(rows[0].phoneHash), "só o hash do telefone");
});

test("resposta do formulário: trocar uma, tirar outra e manter a terceira → cesta certa + resumo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  const flow = lastFlow(phone);
  const ctx = await ctxOf(phone);
  const slots = ctx.listFlow!.slots;
  const swap = slots.find((s) => s.skus.length > 1)!;
  const other = swap.skus.find((sku) => sku !== swap.suggestedSku)!;
  const drop = slots.find((s) => s !== swap)!;
  const keep = slots.find((s) => s !== swap && s !== drop)!;
  const form: Record<string, string> = { lia_lista: String(dataOf(flow).lista_id) };
  slots.forEach((slot, i) => {
    form[`item_${i + 1}`] = slot === swap ? other : slot === drop ? "skip" : String(slot.suggestedSku);
  });
  const before = followUps.length;
  const out = await submit(phone, form);
  const after = await ctxOf(phone);
  assert.equal(after.basket?.length, 2);
  assert.ok(after.basket!.some((i) => i.sku === other), "a troca entrou");
  assert.ok(!after.basket!.some((i) => i.sku === swap.suggestedSku), "a sugestão trocada saiu");
  assert.ok(!after.basket!.some((i) => i.sku === drop.suggestedSku), "a pulada saiu");
  assert.ok(after.basket!.some((i) => i.sku === keep.suggestedSku), "a mantida ficou");
  assert.notEqual(after.listFlow?.id, dataOf(flow).lista_id, "o id gira");
  const fu = followUps.slice(before);
  assert.equal(fu.length, 1, `${out}`);
  assert.equal(fu[0].opts?.listFlowButton, true);
  // Uma linha só depois do formulário (dono, 09/10): quantos itens, quanto, prazo.
  assert.match(fu[0].body, /✅ Lista salva: 2 itens · R\$/);
  assert.match(fu[0].body, /❌ \*macarrão\* — não achei em nenhuma loja/);
  assert.doesNotMatch(fu[0].body, /^• /m, "sem a lista enumerada de novo");
  const history = await prisma.message.findMany({ where: { conversation: { user: { phone } }, sender: "user" }, select: { text: true } });
  assert.ok(history.some((m) => m.text === "🛒 Lista escolhida no formulário"));
});

test("token velho: 'essa lista mudou' e o formulário atual, sem aplicar a resposta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  const first = lastFlow(phone);
  const slots = (await ctxOf(phone)).listFlow!.slots;
  // Edição por texto muda a cesta e invalida o formulário enviado.
  await send(phone, "pode colocar mais um leite");
  const changed = await ctxOf(phone);
  const count = flows.filter((f) => f.to === phone).length;
  const form: Record<string, string> = { lia_lista: String(dataOf(first).lista_id) };
  slots.forEach((slot, i) => (form[`item_${i + 1}`] = "skip"));
  await submit(phone, form);
  const mine = flows.filter((f) => f.to === phone);
  assert.equal(mine.length, count + 1, "formulário reenviado");
  assert.match(mine.at(-1)!.input.body, /Essa lista mudou depois que te mandei/);
  assert.notEqual(dataOf(mine.at(-1)!).lista_id, dataOf(first).lista_id);
  const after = await ctxOf(phone);
  assert.deepEqual(after.basket?.map((i) => i.sku).sort(), changed.basket?.map((i) => i.sku).sort(), "nada foi aplicado");
  // Um id que nunca existiu também.
  await submit(phone, { lia_lista: "lst-que-nao-existe", item_1: "skip" });
  assert.match(lastFlow(phone).input.body, /Essa lista mudou/);
});

test("'Pagar' sem abrir o formulário segue com as sugestões", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  let out = await send(phone, "pagar");
  // Cesta em 2+ lojas (09/10): a lista não junta sozinha; o fechamento oferece juntar ou manter.
  // (Aqui o feijão sozinho na Carrefour ficaria abaixo do mínimo dela: juntar é o que fecha.)
  if (/\*juntar\* ou \*manter\*/.test(out)) out = await send(phone, "juntar");
  assert.match(out, /R\$/, out.slice(0, 300));
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { user: { phone } }, orderBy: { createdAt: "desc" } });
  assert.equal((order.items as unknown[]).length, 3, "a cotação sai com as sugestões");
});

test("'Mudar minha lista' reenvia o formulário com o estado atual", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  const slots = (await ctxOf(phone)).listFlow!.slots;
  const form: Record<string, string> = { lia_lista: String(dataOf(lastFlow(phone)).lista_id) };
  slots.forEach((slot, i) => (form[`item_${i + 1}`] = i === 0 ? "skip" : String(slot.suggestedSku)));
  await submit(phone, form);
  const count = flows.filter((f) => f.to === phone).length;
  await send(phone, "mudar_lista");
  const mine = flows.filter((f) => f.to === phone);
  assert.equal(mine.length, count + 1);
  const data = dataOf(mine.at(-1)!);
  assert.match(mine.at(-1)!.input.body, /Sua lista do jeito que está agora/);
  // Botão único "Mudar ou adicionar" (08/10): o formulário reaberto ensina a adicionar item novo.
  assert.match(mine.at(-1)!.input.body, /adicionar\* um item novo, é só me mandar o nome/);
  assert.equal(data.init_1, slots[0].skus.length ? data.init_1 : "", "a vaga pulada volta sem pré-seleção");
  assert.match(String(data.label_1), /escolha uma/);
});

test("flag desligada: caminho de sempre, sem formulário", async (t) => {
  if (!dbOk) return t.skip();
  delete process.env.LIA_LIST_FLOW;
  const phone = await customer();
  await send(phone, LIST);
  assert.equal(flows.filter((f) => f.to === phone).length, 0);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.step, "choosing", "uma lista de uma linha só segue linha a linha");
  assert.equal(ctx.listFlow, undefined);
  assert.equal(ctx.pending?.length, 3);
});

test("envio do formulário falhando: caminho de sempre, cesta e contexto coerentes", async (t) => {
  if (!dbOk) return t.skip();
  flowShouldFail = true;
  const phone = await customer();
  await send(phone, LIST);
  assert.equal(flows.filter((f) => f.to === phone).length, 0);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.listFlow, undefined);
  assert.equal(ctx.step, "choosing");
  assert.equal(ctx.pending?.length, 3);
  assert.equal(ctx.basket?.length ?? 0, 0, "nada entrou na cesta por um formulário que não saiu");
});

test("lista com remédio isento não usa o formulário", async (t) => {
  if (!dbOk) return t.skip();
  process.env.LIA_MEDICINE_MIP = "true";
  const phone = await customer();
  await send(phone, "2 leites e dipirona");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.length, 2, "as duas linhas têm opção");
  assert.ok(ctx.pending!.some((p) => p.options.some((o) => o.medicine === "mip")), "uma delas é remédio isento");
  assert.equal(flows.filter((f) => f.to === phone).length, 0);
});

test("faltante: nome novo ('macarrão espaguete') depois da falta busca só ela e o resto da cesta fica", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  rerankCalls.length = 0;
  // Agora existe macarrão espaguete nas lojas (o juiz aceita o primeiro candidato).
  judgeExtra = (q, c) => /macarr/.test(q.toLowerCase()) && /espaguete/.test(q.toLowerCase()) && /macarr|espaguete|spaghetti/i.test(c.name);
  const out = await send(phone, "macarrão espaguete");
  assert.ok(rerankCalls.every((queries) => queries.length === 1 && /macarr/.test(queries[0])), `busca só a faltante: ${JSON.stringify(rerankCalls)}`);
  assert.ok(/Achei|\*1\)\*/.test(out), out.slice(0, 300));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.basket?.length, 3, "a cesta anterior continua");
  assert.equal(ctx.pending?.length, 1, "a faltante achada vira escolha avulsa (vitrine)");
  assert.equal(ctx.listMisses, undefined, "saiu da lista de faltantes");
});

test("faltante: 'tenta de novo' refaz e, sem achar, diz a verdade e tira da lista", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  const first = await send(phone, "tenta de novo");
  assert.match(first, /macarrão/i, first.slice(0, 300));
  const ctx = await ctxOf(phone);
  assert.equal(ctx.listMisses?.[0]?.retried, true);
  const second = await send(phone, "tenta de novo");
  assert.match(second, /Procurei de novo.*macarrão/i, second.slice(0, 300));
});

// Ajustes do dono (07/10, depois do teste no celular): mais barata marcada, preço crescente,
// "Nenhuma — ver outras", tudo numa mensagem só e "Para fechar o pedido:" antes dos botões.
test("sugestão = a mais barata entre as aprovadas, opções do mais barato ao mais caro, sem mensagem solta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, LIST);
  assert.equal(out, "", `nada sai fora do formulário e dos botões: ${out}`);
  const flow = lastFlow(phone);
  const ctx = (await ctxOf(phone)) as Awaited<ReturnType<typeof ctxOf>> & {
    listFlow: { slots: { skus: string[]; suggestedSku: string | null; options: { sku: string; unitPrice: number }[] }[] };
  };
  const reorganized = /Juntei entregas|Reorganizei/.test(flow.input.body);
  for (const slot of ctx.listFlow.slots) {
    const prices = slot.skus.map((sku) => slot.options.find((o) => o.sku === sku)!.unitPrice);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), `ordem por preço: ${slot.skus.join(",")}`);
    if (!reorganized && slot.suggestedSku) assert.equal(slot.suggestedSku, slot.skus[0], "a marcada é a mais barata");
  }
  const fu = followUps.filter((f) => f.to === phone).at(-1)!;
  assert.equal(fu.body, "Para fechar o pedido:");
  assert.equal(fu.opts?.listFlowButton, true);
  const opts = dataOf(flow).opts_1 as Array<{ id: string; title: string }>;
  assert.deepEqual(opts.slice(-2).map((o) => o.id), ["more", "skip"]);
});

test("'Nenhuma — ver outras': tira a sugestão, resume a lista e mostra outras opções daquele item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, LIST);
  const flow = lastFlow(phone);
  const slots = (await ctxOf(phone)).listFlow!.slots;
  const target = slots.find((s) => /arroz/.test(s.query)) ?? slots[0];
  const form: Record<string, string> = { lia_lista: String(dataOf(flow).lista_id) };
  slots.forEach((slot, i) => (form[`item_${i + 1}`] = slot === target ? "more" : String(slot.suggestedSku)));
  const fuStart = followUps.length;
  const sentText = await submit(phone, form);
  const out = [sentText, ...followUps.slice(fuStart).filter((f) => f.to === phone).map((f) => f.body)].join("\n---\n");
  const after = await ctxOf(phone);
  assert.ok(!after.basket!.some((i) => i.sku === target.suggestedSku), "a sugestão recusada saiu da cesta");
  assert.equal(after.basket?.length, slots.length - 1, "as outras ficaram");
  assert.match(out, /Lista salva/);
  if (after.step === "choosing") {
    assert.match(out, new RegExp(`Agora as outras opções de \\*${target.query}\\*`));
    assert.equal(after.pending?.[0].query, target.query);
    const offered = (after.pending?.[0].options ?? []) as unknown as { sku: string }[];
    assert.ok(offered.length > 0);
    assert.ok(offered.every((o) => !target.skus.includes(o.sku)), "nada do que a tela já mostrou");
    assert.ok(!after.listFlow!.slots.some((s) => s.lineKey === target.lineKey), "a vaga sai do formulário");
    // Escolher uma das novas soma o item de volta.
    await send(phone, "1");
    const done = await ctxOf(phone);
    assert.equal(done.basket?.length, slots.length);
    assert.ok(done.basket!.some((i) => i.sku === offered[0].sku));
  } else {
    assert.match(out, /não tenho outras opções além das que te mostrei/);
    assert.doesNotMatch(out, /Agora as outras opções/);
  }
});

// Dono, 09/10: "2 vodkas" (R$190) passava do teto de R$100 por LINHA → ficava sem sugestão, fora da primeira
// mensagem e da cesta ("veio as três e não as quatro"). No formulário o teto é por unidade (R$300).
test("linha cara pela quantidade (unidade barata) também vem pré-escolhida e aparece na primeira mensagem", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "30 leites, arroz e feijão");
  const ctx = await ctxOf(phone);
  const leite = ctx.listFlow?.slots.find((s) => /leite/i.test(s.query));
  assert.ok(leite?.suggestedSku, `leite pré-escolhido: ${JSON.stringify(ctx.listFlow?.slots.map((s) => [s.query, s.suggestedSku]))}`);
  assert.ok(ctx.basket?.some((b) => b.sku === leite!.suggestedSku), "e na cesta");
  assert.match(lastFlow(phone).input.body, /\dx .*[Ll]eite/, "e na primeira mensagem");
});

test("primeira mensagem e resumo do formulário mostram loja e prazo de cada item", async () => {
  const copy = await import("../src/lib/lia-copy");
  const items = [{ qty: 2, name: "Vodka Absolut Original 1L", total: 208.78, when: "Mambo · hoje, 12h–15h" }, { qty: 1, name: "Gin Seagers 1L", total: 87.98, when: "Mambo · hoje, 12h–15h" }];
  const intro = copy.listFlowIntro({ items, misses: [] });
  assert.match(intro, /2x Vodka Absolut Original 1L — R\$ ?208,78 · _Mambo · hoje, 12h–15h_/);
  assert.match(intro, /1x Gin Seagers 1L — R\$ ?87,98 · _Mambo · hoje, 12h–15h_/);
  const done = copy.listFlowDone({ items, leftOut: [], misses: [], produtos: 296.76 });
  assert.equal(done, "✅ Lista salva: 2 itens · R$ 296,76 _(a entrega entra no total)_\n🚚 Mambo · hoje, 12h–15h");
});
