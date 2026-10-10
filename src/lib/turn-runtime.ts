// Runtime do turno (revisão 02/09): contexto (ler/gravar com CAS), lock por conversa,
// resposta ao cliente e alerta ao operador. Zero regra de negócio de compra.
import { whatsappAdapter } from "@/lib/adapters/whatsapp";
import { normalizeMsg } from "@/lib/lia-intents";
import { extractCpf, maskCpf } from "@/lib/medicine";
import { displayPrice, serviceFeeForItems } from "@/lib/pricing";
import { prisma } from "@/lib/prisma";
import * as copy from "@/lib/lia-copy";
import { DeliveryContext } from "./conversation-types";
import { isRepeatableVerbatim, mergeSent, repeatGuardEnabled, rewriteRepeated, sameAsRecent } from "./dialogue/repeat";

// The active product: a WhatsApp concierge with breadth — the customer asks
// for anything from anywhere, the operator sources, prices and buys it by hand, and a
// courier (Uber Direct/Lalamove) delivers same-hour from the operator to the customer.
// No live retailer automation (Browserbase) sits on the critical path here; the operator
// is the source of truth for the quote. Flip LIA_MANUAL_CONCIERGE=false to fall back to
// the legacy catalog auto-quote flow (still exercised by the conversation evals).
// Alerta operacional no WhatsApp do operador (LIA_OPERATOR_PHONE; sem env = silêncio).
// Caso real (11/08): um pedido ficou 2 DIAS em awaiting_operator_quote porque nada avisava
// o operador de que havia trabalho no /ops — pro cliente, o "te mando em instantes" virou
// nunca. Best-effort: falha de envio jamais afeta o fluxo do cliente.
// Janela de atendimento da Meta: mensagem LIVRE só chega até 24h depois da última mensagem
// do cliente; fora dela a Graph aceita (200) e o WhatsApp descarta com erro 131047. Aqui
// medimos pela última mensagem inbound gravada na conversa daquele telefone.
const SERVICE_WINDOW_MS = 23 * 60 * 60_000;

export async function lastInboundAt(phone: string): Promise<Date | undefined> {
  const user = await prisma.user.findUnique({ where: { phone: normalizePhone(phone) }, select: { id: true } });
  if (!user) return undefined;
  const last = await prisma.message.findFirst({
    where: { sender: "user", conversation: { userId: user.id } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  return last?.createdAt;
}

export async function outsideServiceWindow(phone: string): Promise<boolean> {
  const last = await lastInboundAt(phone);
  return !last || Date.now() - last.getTime() > SERVICE_WINDOW_MS;
}

export type NoticeDelivery = "text" | "template" | "skipped";

// Aviso PROATIVO (o cliente não acabou de escrever): dentro da janela vai como texto; fora
// dela vai como template aprovado (LIA_TEMPLATE_ORDER_UPDATE, body "{{1}}" = rótulo dos itens — nunca o
// número do pedido (08/10 noite) —,
// "{{2}}" = texto) ou, sem template configurado, NÃO é enviado (falharia) — quem chama
// registra na nota do pedido (03/09: o aviso do chá morreu em silêncio por isso).
export async function deliverNotice(to: string, text: string, opts: { items?: unknown } = {}): Promise<NoticeDelivery> {
  if (!(await outsideServiceWindow(to))) {
    await whatsappAdapter.sendMessage(to, text);
    return "text";
  }
  const template = process.env.LIA_TEMPLATE_ORDER_UPDATE?.trim();
  if (!template) {
    console.warn("[notice:skipped-outside-window]", { to: to.slice(0, 7) + "***", reason: "sem LIA_TEMPLATE_ORDER_UPDATE" });
    return "skipped";
  }
  await whatsappAdapter.sendTemplateMessage(to, { name: template, bodyParams: [copy.orderTemplateLabel(opts.items), text] });
  return "template";
}

// ---------- dois papéis (15/09/2026) ----------
// Até aqui operador = dono: um número recebia "pedido pago, compre" e "pagamento fora do
// esperado, confira no provedor". Com um operador CONTRATADO os dois assuntos se separam.
// `LIA_OWNER_PHONE` é o dono; sem ele o dono continua sendo `LIA_OPERATOR_PHONE`, então
// nada muda enquanto o Joseph operar sozinho.
export type OperatorRole = "owner" | "operator";

function phoneList(...values: (string | undefined)[]): string[] {
  return values
    .flatMap((value) => (value ?? "").split(","))
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => normalizePhone(p));
}

export function ownerPhones(): string[] {
  const owner = process.env.LIA_OWNER_PHONE?.trim();
  return phoneList(owner || process.env.LIA_OPERATOR_PHONE, process.env.LIA_ADMIN_PHONES);
}

// Papel do remetente, ou `null` para cliente comum. O dono ganha a disputa quando os dois
// envs apontam para o mesmo número.
export function phoneRole(phone: string): OperatorRole | null {
  const normalized = normalizePhone(phone);
  if (ownerPhones().includes(normalized)) return "owner";
  const operator = process.env.LIA_OPERATOR_PHONE?.trim();
  if (operator && normalizePhone(operator) === normalized) return "operator";
  return null;
}

// Telefones com poder de operador: LIA_OPERATOR_PHONE (alertas) + LIA_OWNER_PHONE +
// LIA_ADMIN_PHONES (lista separada por vírgula). Só eles recebem o link de login do /ops.
export function isAdminPhone(phone: string): boolean {
  return phoneRole(phone) !== null;
}

// Janela em que existe alguém para comprar (`LIA_OPERATOR_HOURS`, "9-20" por padrão,
// horário de São Paulo). Só muda o que a Lia PROMETE ao cliente; não bloqueia nada.
export function withinOperatorHours(now = new Date(), range = process.env.LIA_OPERATOR_HOURS): boolean {
  const [rawStart, rawEnd] = (range ?? "9-20").split("-");
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) return true;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(now)
  );
  return hour >= start && hour < end;
}

// Existe um operador CONTRATADO? (número de compra diferente do número do dono). É o que
// decide alertas que só fazem sentido quando quem compra não é quem olha o painel.
export function operatorIsHired(): boolean {
  const operator = process.env.LIA_OPERATOR_PHONE?.trim();
  return Boolean(operator) && phoneRole(operator!) === "operator";
}

// Quem COMPRA: pedido pago, pedido parado, item somado, botões de compra.
export async function notifyOperator(text: string, customerPhone?: string) {
  return notifyRole(process.env.LIA_OPERATOR_PHONE?.trim(), text, customerPhone);
}

// Quem responde pelo DINHEIRO e pelos incidentes: cobrança falhada, pagamento fora do
// esperado, estorno automático, reclamação de cobrança indevida. Sem `LIA_OWNER_PHONE`
// cai no mesmo número de sempre.
export async function notifyOwner(text: string, customerPhone?: string) {
  return notifyRole(ownerPhones()[0], text, customerPhone);
}

async function notifyRole(to: string | undefined, text: string, customerPhone?: string) {
  if (!to) return;
  // Operador comprando/testando como cliente: o alerta interno iria pro MESMO chat da
  // conversa (26/08 P1.9 — "[operador] Pedido #..." apareceu no meio do teste). Loga e
  // suprime; o /ops continua sendo a fonte.
  if (customerPhone && normalizePhone(to) === normalizePhone(customerPhone)) {
    console.warn("[operator-alert:suppressed-self]", text.slice(0, 80));
    return;
  }
  // Linha de teste (10/10, rodada 5 g16): aviso sobre cliente fictício (+5500995…) nunca chega ao operador de verdade.
  // Dentro do turno da linha ele é capturado pelo adaptador (abaixo); fora dele (cron, webhook, cobrança em segundo
  // plano) não há captura, então é só log.
  if (customerPhone && isTestLinePhone(normalizePhone(customerPhone)) && !testLineCapture.getStore()) {
    console.warn("[operator-alert:suppressed-test-line]", text.slice(0, 80));
    return;
  }
  try {
    // Operador que não escreve pra Lia há 24h está fora da janela: sem template o alerta
    // morre (03/09). Com template vai por ele; sem, tenta texto e loga — o /ops é a fonte.
    const template = process.env.LIA_TEMPLATE_ORDER_UPDATE?.trim();
    if (template && (await outsideServiceWindow(to))) {
      await whatsappAdapter.sendTemplateMessage(to, { name: template, bodyParams: ["operador", text] });
      return;
    }
    await whatsappAdapter.sendMessage(to, text);
  } catch (error) {
    console.warn("[operator-alert:failed]", error instanceof Error ? error.message : error);
  }
}

// Where the operator hands the goods to the courier (their own base). Same-hour courier
// pickup is from HERE, never a store counter — so the retailer third-party-pickup document
// rules never apply. Configured once via env for same-hour operation.
// Your margin is baked into the product price (no separate fee line). O markup é
// PROGRESSIVO por faixa (23/08): vive em src/lib/pricing.ts — displayPrice é o ponto
// único; serviceFeeForItems/Subtotal mantêm o total consistente com os cards.

export function normalizePhone(phone?: string) {
  if (!phone) return "+550000000000";
  const cleaned = phone.replace("whatsapp:", "").trim();
  if (cleaned.startsWith("+")) return cleaned;
  const digits = cleaned.replace(/\D/g, "");
  return `+${digits}`;
}

export async function getOrCreateConvo(phone: string, name?: string) {
  // Duas mensagens do 1º contato chegando juntas (10/10, rodada 10 g30: "oi" + cadastro em paralelo): o upsert do Prisma
  // não é atômico no Postgres — o 2º insert batia no índice único de `phone` e o cliente ouvia "Deu um erro aqui".
  // Quem perdeu a corrida lê o usuário que o outro acabou de criar.
  const user = await prisma.user
    .upsert({
      where: { phone },
      update: name ? { name } : {},
      create: { phone, name }
    })
    .catch(async (error: unknown) => {
      if ((error as { code?: string })?.code !== "P2002") throw error;
      return prisma.user.findUniqueOrThrow({ where: { phone } });
    });
  let convo = await prisma.conversation.findFirst({
    where: { userId: user.id, status: "active" },
    orderBy: { updatedAt: "desc" }
  });
  if (!convo) {
    // Id DETERMINÍSTICO por cliente: duas mensagens simultâneas do mesmo número
    // convergem para a MESMA conversa, porque upsert por chave primária é atômico.
    // Com `create`, o ler-depois-criar abria DUAS conversas ativas — cada mensagem
    // caía numa, dividindo a cesta e furando o dedupe do webhook (que é por conversa).
    // Conversa nunca é desativada no produto, então reaproveitar o id é seguro.
    convo = await prisma.conversation.upsert({
      where: { id: `conv_${user.id}` },
      update: { status: "active" },
      create: { id: `conv_${user.id}`, userId: user.id, status: "active", currentStep: "delivery" }
    });
  }
  rememberCtxSnapshot(convo.id, convo.context ?? null);
  return { user, convo };
}

export function readCtx(context: string | null): DeliveryContext {
  try {
    return context ? pendingMeansChoosing(JSON.parse(context) as DeliveryContext) : {};
  } catch {
    return {};
  }
}

// Escolha aberta = passo "choosing" (10/10, rodada 5 A1/A3): uma busca que não achou nada com a escolha da vela
// (ou de duas trocas) na mesa gravava "collecting" e deixava a escolha órfã — "tira a vela" respondia "não vejo
// vela na lista", "pula essa" não tinha o que pular e os cards viravam "conversa antiga". Invariante num lugar só.
export function pendingMeansChoosing(ctx: DeliveryContext): DeliveryContext {
  if (ctx.pending?.length && (ctx.step === undefined || ctx.step === "collecting")) ctx.step = "choosing";
  return ctx;
}

// ---------- escrita CONDICIONAL de contexto (teste 26/08, P0.1) ----------
// O pior achado do teste em massa: um turno LENTO (busca fria de 45-120s) terminava
// depois de um "cancelar" e regravava a cesta antiga por cima do contexto limpo — a
// sessão 19 chegou ao Pix com 6 itens da sessão 18 cancelada. A cura estrutural:
// cada turno guarda o SNAPSHOT do contexto que leu (AsyncLocalStorage, sem mudar a
// assinatura dos 88 call sites) e toda escrita é compare-and-swap contra ele. Outra
// escrita no meio (cancelar, outro turno) → o CAS falha → TurnSupersededError → o
// turno velho PARA, sem gravar e sem falar mais nada.
import { AsyncLocalStorage } from "node:async_hooks";
import { noteShopperCep, runShopperScoped } from "./store-areas";
import { isTestLinePhone, testLineCapture } from "./test-line";

export class TurnSupersededError extends Error {
  constructor(convoId: string) {
    super(`turno superado: contexto de ${convoId} mudou por baixo`);
    this.name = "TurnSupersededError";
  }
}

export const turnStore = new AsyncLocalStorage<Map<string, string | null>>();

// Contador de RESPOSTAS do turno — a rede anti-silêncio absoluto (28/08: quatro
// sessões terminaram um turno sem NENHUMA mensagem de volta). Se o turno fechar com
// zero envios, handleDeliveryMessage manda um fallback pedindo reformulação.
// `routerQuery` (06/10): frase de busca que o roteador da IA já reescreveu neste turno — a
// extração não chama a IA de novo pra ela (até 10 s a menos; turnos passavam de 45 s).
// Guarda anti-repetição (rodada 2 do plano 100): `inboundText` = o que o cliente disse neste turno;
// `prevSent` = últimas falas da Lia (turnos anteriores, até 10 min); `sent` = o que saiu NESTE turno por reply().
// `skipDialogue` = resposta de pergunta reencaminhada pelo gerente (não consulta a IA de novo).
export const turnMeta = new AsyncLocalStorage<{
  replies: number;
  llmUsed?: boolean;
  routerQuery?: string;
  inboundText?: string;
  prevSent?: string[];
  sent?: string[];
  skipDialogue?: boolean;
  // Telefone do cliente deste turno (08/10): a recomendação em modo "test" só vale para dono/admins.
  phone?: string;
  // Edição composta (10/10, rodada 5 M2/M6): o total/oferta de juntar só sai depois da ÚLTIMA edição da mensagem.
  // `deferQuote` liga o adiamento; `quoteDeferred` marca que uma edição do meio pediu o total.
  deferQuote?: boolean;
  quoteDeferred?: boolean;
  // Prazo dito pelo cliente (ctx.neededBy) neste turno: a vitrine avisa quando as opções não chegam a tempo (10/10, rodada 6 g19).
  neededBy?: { date: string; label: string; morning?: boolean };
  // Aceite da troca de loja dito DEPOIS de uma edição na mesma mensagem (10/10, rodada 12 M5): a loja cuja troca já vale.
  acceptSwapFrom?: string;}>();

// A rede anti-silêncio conta QUALQUER envio ao cliente do turno, não só `reply()` (09/10, pedido
// do dono): com LIA_NATIVE_PIX=1 o Pix saía só como bolha nativa (`sendPixOrderDetails`), o
// contador ficava em zero e a Lia emendava "Me perdi aqui 😅 Me diz de novo o que você precisa?"
// logo depois do Pix. Todo `send*` do adaptador que de fato enviou (resultado não nulo) ao
// telefone do turno conta como resposta; aviso ao dono/operador no meio do turno não conta.
{
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
  for (const name of Object.keys(adapter)) {
    const original = adapter[name];
    if (!name.startsWith("send") || typeof original !== "function") continue;
    adapter[name] = async function (this: unknown, to: string, ...rest: unknown[]) {
      // Linha de teste (test-line.ts): dentro da captura nada sai pra Meta; o envio é gravado.
      const capture = testLineCapture.getStore();
      // Cliente fictício fora da captura (cron/webhook depois do turno): nada sai pra Meta (10/10, rodada 5 g16).
      if (!capture && isTestLinePhone(String(to))) {
        console.warn("[test-line:send-suppressed]", name, String(to));
        return null;
      }
      const result = capture
        ? (capture.out.push({ kind: name, to: String(to), args: rest }), { provider: "test-line", to, messages: [{ id: `wamid.testline.${capture.out.length}` }] })
        : await (original as (...args: unknown[]) => Promise<unknown>).apply(this, [to, ...rest]);
      const meta = turnMeta.getStore();
      if (meta && result != null && (!meta.phone || digits(to) === digits(meta.phone))) meta.replies += 1;
      return result;
    };
  }
}

export function runTurnScoped<T>(fn: () => Promise<T>): Promise<T> {
  return turnStore.run(new Map(), () => turnMeta.run({ replies: 0, llmUsed: false, sent: [] }, () => runShopperScoped(fn)));
}

export function rememberCtxSnapshot(convoId: string, context: string | null) {
  turnStore.getStore()?.set(convoId, context);
  // CEP do cliente vale para TODA busca do turno (store-areas.ts: loja regional fora da
  // área nem aparece).
  try {
    noteShopperCep(context ? (JSON.parse(context) as { cep?: string }).cep : undefined);
  } catch {
    /* contexto ilegível: sem CEP no escopo */
  }
}

// Loja pedida para a lista toda (10/10, rodada 5 M9): na 1ª gravação de cada escolha, as opções dessa loja vão na
// frente (ordem estável). Uma vez só por escolha — depois de mostrada, a numeração não muda por baixo do cliente.
function prioritizePreferredStore(ctx: DeliveryContext) {
  const wanted = ctx.preferredStore ? normalizeMsg(ctx.preferredStore) : "";
  if (!wanted) return;
  for (const p of ctx.pending ?? []) {
    if (p.storePrioritized || !p.options?.length) continue;
    p.storePrioritized = true;
    p.wantedStore = ctx.preferredStore;
    const isWanted = (o: { storeLabel?: string }) => normalizeMsg(o.storeLabel ?? "") === wanted;
    const mine = p.options.filter(isWanted);
    if (mine.length && mine.length < p.options.length) p.options = [...mine, ...p.options.filter((o) => !isWanted(o))];
  }
}

export async function writeCtx(convoId: string, ctx: DeliveryContext) {
  pendingMeansChoosing(ctx);
  prioritizePreferredStore(ctx);
  // Carimbo único da escolha pendente (ver DeliveryContext.pendingSince).
  if (ctx.pending?.length) ctx.pendingSince ??= Date.now();
  else delete ctx.pendingSince;
  const next = JSON.stringify(ctx);
  noteShopperCep(ctx.cep);
  const snapshots = turnStore.getStore();
  const snapshot = snapshots?.get(convoId);
  if (snapshots && snapshot !== undefined) {
    const updated = await prisma.conversation.updateMany({
      where: { id: convoId, context: snapshot },
      data: { context: next, currentStep: ctx.step ?? "delivery" }
    });
    if (!updated.count) {
      console.warn("[ctx:cas-conflict]", convoId, "— turno antigo descartado sem gravar");
      throw new TurnSupersededError(convoId);
    }
    snapshots.set(convoId, next);
    return;
  }
  // Fora de um turno (scripts, /ops, testes diretos): escrita simples de sempre.
  await prisma.conversation.update({
    where: { id: convoId },
    data: { context: next, currentStep: ctx.step ?? "delivery" }
  });
  snapshots?.set(convoId, next);
}

// A fresh context that keeps only the saved address (used after clear/cancel/paid).
export function addressOnlyCtx(ctx: DeliveryContext, userCep?: string | null): DeliveryContext {
  return {
    flow: "delivery",
    cep: ctx.cep ?? userCep ?? undefined,
    deliveryAddress: ctx.deliveryAddress,
    deliveryAddressVerified: ctx.deliveryAddressVerified
  };
}

// O que o resumo do total LÊ do contexto e precisa sobreviver a toda escrita entre o fechamento e a publicação
// (10/10, rodada 10 g30: a escolha de entrega barata × rápida regravava o contexto sem `listMisses` e o resumo saía
// sem "Ficou de fora: gelo em cubos" — 3ª rodada seguida; cada caminho copiava os campos à mão e um esquecia).
// Ponto único: quem reescreve o contexto de um pedido em fechamento espalha isto.
export function orderFactsCtx(ctx: DeliveryContext): Partial<DeliveryContext> {
  return {
    ...(ctx.lastChoice ? { lastChoice: ctx.lastChoice } : {}),
    ...(ctx.lastRemoved ? { lastRemoved: ctx.lastRemoved } : {}),
    ...(ctx.neededBy ? { neededBy: ctx.neededBy } : {}),
    ...(ctx.orderBudget ? { orderBudget: ctx.orderBudget } : {}),
    ...(ctx.listMisses?.length ? { listMisses: ctx.listMisses } : {}),
    ...(ctx.rehearsalRefused ? { rehearsalRefused: ctx.rehearsalRefused } : {})
  };
}

// TTL de abandono: cotação parada + cliente sumido = ele não quer mais aquilo. Lido a
// cada chamada (e não uma vez no módulo) porque os evals ajustam o env em tempo de teste.
export function quoteAbandonTtlMs(): number {
  const configured = Number(process.env.LIA_QUOTE_ABANDON_TTL_MS ?? 60 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? configured : 60 * 60 * 1000;
}

// Toque nos botões da escolha de entrega (barata × rápida).
export function isFreightChoicePayload(text: string): boolean {
  return /^frete:(barato|rapido)$/.test(normalizeMsg(text));
}

// A conversa não pode continuar apontando para um pedido que FECHOU (pago, cancelado,
// estornado): o cliente ouvia "ainda estou cotando" de um pedido morto e, em
// `choosing_freight`, o botão de frete caía num erro sem saída. Se ele JÁ começou outra
// cesta/outro pedido aqui, o contexto novo vale mais e nada é apagado.
export async function resetConversationForClosedOrder(
  order: { id: string; conversationId?: string | null },
  tag: string
) {
  if (!order.conversationId) return;
  try {
    const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
    if (!convo) return;
    const ctx = readCtx(convo.context);
    const movedOn = Boolean(ctx.deliveryOrderId) && ctx.deliveryOrderId !== order.id;
    // Escolha aberta (pending) também é missão nova em voo (04/09: item novo sem pergunta).
    const hasNewBasket = ((ctx.basket?.length ?? 0) > 0 || (ctx.pending?.length ?? 0) > 0) && ctx.deliveryOrderId !== order.id;
    if (movedOn || hasNewBasket) return;
    await writeCtx(convo.id, addressOnlyCtx(ctx));
  } catch (error) {
    console.warn(`[delivery:${tag}:ctx-reset]`, error instanceof Error ? error.message : error);
  }
}

// Item novo que ficou pendurado na pergunta "juntar ou pedido novo?" deste pedido.
export async function mergeDecisionRequestFor(order: { id: string; conversationId?: string | null }): Promise<string | undefined> {
  if (!order.conversationId) return undefined;
  try {
    const convo = await prisma.conversation.findUnique({ where: { id: order.conversationId } });
    const ctx = convo ? readCtx(convo.context) : undefined;
    return ctx?.mergeDecision?.orderId === order.id ? ctx.mergeDecision.request : undefined;
  } catch (error) {
    console.warn("[delivery:paid:merge-decision]", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function reply(phone: string, text: string) {
  const meta = turnMeta.getStore();
  if (meta) meta.replies += 1;
  // CPF nunca volta ao cliente em claro, em nenhuma etapa (rodada 4, M4): "não achei *Carolina cpf 529…*" ecoava o número.
  let out = text.length < 400 ? text.replace(/\d[\d.\s-]{9,16}\d/g, (m) => (/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(m.trim()) && extractCpf(m) ? maskCpf(m) : m)) : text;
  // Mesma mensagem duas vezes seguidas para falas diferentes do cliente (placar c02/c10/c24/c38/c64):
  // o gerente de diálogo escreve outra, sabendo o que já foi dito. Só prosa de conversa; dinheiro, link e Pix saem iguais.
  if (meta?.inboundText && meta.prevSent?.length && repeatGuardEnabled() && !isRepeatableVerbatim(text) && sameAsRecent(text, meta.prevSent)) {
    const recent = [...meta.prevSent, ...(meta.sent ?? [])].slice(-4);
    const alt = await rewriteRepeated({ customer: meta.inboundText, said: text, recent });
    console.log(`[dialogue:repeat] ${alt ? "reescrita" : "mantida (sem IA)"} said=${JSON.stringify(text.slice(0, 60))}`);
    if (alt) out = alt;
  }
  meta?.sent?.push(out);
  await whatsappAdapter.sendMessage(phone, out);
}

// Fim do turno: guarda as últimas falas da Lia no contexto (a guarda anti-repetição lê no turno seguinte).
// Direto no banco, com compare-and-swap: se o contexto mudou por baixo, simplesmente não grava.
export async function persistSentTexts(convoId: string): Promise<void> {
  const meta = turnMeta.getStore();
  if (!meta?.sent?.length || !repeatGuardEnabled()) return;
  try {
    const row = await prisma.conversation.findUnique({ where: { id: convoId }, select: { context: true } });
    const ctx = readCtx(row?.context ?? null);
    const merged = mergeSent(ctx.lastSent, meta.sent.map((t) => t.slice(0, 600)));
    if (!merged) return;
    ctx.lastSent = merged;
    await prisma.conversation.updateMany({ where: { id: convoId, context: row?.context ?? null }, data: { context: JSON.stringify(ctx) } });
  } catch (error) {
    console.warn("[dialogue:repeat:persist-failed]", error instanceof Error ? error.message : error);
  }
}

// Envios que não passam pelo reply() (cards, botões, resumos interativos) também
// contam como resposta do turno pra rede anti-silêncio.
export function markTurnReplied() {
  const meta = turnMeta.getStore();
  if (meta) meta.replies += 1;
}

// Quando o cliente falou/agiu pela última vez ANTES desta mensagem. Base dos dois TTLs
// (cesta parada, cotação abandonada). Usa a mensagem anterior da conversa — NÃO o
// `Conversation.updatedAt`: ele se move quando contexto é gravado E quando o lock de
// turno é reivindicado, então nunca serviria de relógio de inatividade; já a mensagem
// anterior é a atividade real (toda mensagem, do cliente ou da Lia, conta).
export async function lastActivityAt(convoId: string, exceptMessageId?: string): Promise<Date | undefined> {
  const previous = await prisma.message.findFirst({
    where: { conversationId: convoId, ...(exceptMessageId ? { id: { not: exceptMessageId } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  return previous?.createdAt;
}

// Mesmo texto da mensagem anterior do cliente, há menos de LIA_DUPLICATE_INBOUND_MS (3 min):
// reenvio por impaciência enquanto o turno anterior ainda roda (08/10). Quem decide se o texto
// merece o dedupe (pedido de produto) é o chamador; aqui só a comparação.
export function duplicateInboundWindowMs(): number {
  const value = Number(process.env.LIA_DUPLICATE_INBOUND_MS);
  return Number.isFinite(value) && value >= 0 ? value : 3 * 60_000;
}

export async function isRecentDuplicateInbound(convoId: string, exceptMessageId: string, text: string): Promise<boolean> {
  const previous = await prisma.message.findFirst({
    where: { conversationId: convoId, sender: "user", id: { not: exceptMessageId } },
    orderBy: { createdAt: "desc" },
    select: { text: true, createdAt: true }
  });
  if (!previous) return false;
  if (Date.now() - previous.createdAt.getTime() > duplicateInboundWindowMs()) return false;
  return normalizeMsg(previous.text) === normalizeMsg(text);
}

// Um turno POR VEZ por conversa (2ª revisão, 11/08). Duas mensagens simultâneas do
// mesmo cliente liam a mesma cesta e cada uma gravava o contexto INTEIRO — a última
// apagava o item da primeira. Lock cooperativo no banco (vale entre instâncias
// serverless): claim atômico via updateMany; TTL de 60s liberta conversa de turno
// travado; quem espera demais entra assim mesmo (o webhook não pode pendurar — melhor
// a corrida rara de antes do que mensagem sem resposta).
// Revisão 01/09: 60s era MENOR que um turno de busca fria (45–120s) — a mensagem
// seguinte roubava o lock no meio e a mais nova morria no CAS sem resposta. 180s cobre o
// maior turno observado; um turno travado de verdade prende a conversa por 3 min, não 1.
export const TURN_LOCK_TTL_MS = Number(process.env.LIA_TURN_LOCK_TTL_MS ?? 180_000);

// 26/08: 15s de espera + barge era a PORTA do P0.1 — busca fria dura 45-120s e a
// mensagem seguinte furava a trava no meio. Agora espera até 120s (o watchdog avisa o
// cliente) e o barge residual é inofensivo: o CAS do contexto mata a escrita perdedora.
export const TURN_LOCK_MAX_WAIT_MS = Number(process.env.LIA_TURN_LOCK_MAX_WAIT_MS ?? 120_000);

// FIFO por conversa (09/10, rodada 1): o polling puro deixava "quem acorda primeiro" ganhar —
// "arroz", "feijão", "macarrão" saíam fora de ordem e "pagar" passava na frente de "o primeiro".
// Sem migração: `turnLockAt` com `turnLock` NULL guarda a MARCA d'água (createdAt da última
// mensagem do cliente que já teve turno, ou que saiu antes do lock). Com a trava livre, um
// turno só reivindica se não houver mensagem do cliente MAIS ANTIGA que a sua e posterior à
// marca — essa ainda está na fila e passa primeiro. Quem cede espera no máximo
// LIA_TURN_FIFO_GRACE_MS com a trava livre (a da frente reivindica em ~400 ms; a espera só
// pesa quando a mensagem da frente saiu sem turno e não conseguiu avançar a marca).
export const TURN_FIFO_GRACE_MS = Number(process.env.LIA_TURN_FIFO_GRACE_MS ?? 3_000);

export type TurnTicket = { messageId: string; createdAt: Date };

async function hasEarlierQueued(convoId: string, ticket: TurnTicket, watermark: Date): Promise<boolean> {
  const earlier = await prisma.message.findMany({
    where: {
      conversationId: convoId,
      sender: "user",
      id: { not: ticket.messageId },
      createdAt: { gt: watermark, lte: ticket.createdAt }
    },
    select: { id: true, createdAt: true }
  });
  // Mesmo milissegundo: desempate estável pelo id.
  return earlier.some((m) => m.createdAt < ticket.createdAt || m.id < ticket.messageId);
}

export async function acquireTurnLock(convoId: string, ticket?: TurnTicket): Promise<string> {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + TURN_LOCK_MAX_WAIT_MS;
  let yieldingSince: number | undefined;
  for (;;) {
    const staleBefore = new Date(Date.now() - TURN_LOCK_TTL_MS);
    let mayClaim = true;
    if (ticket) {
      const convo = await prisma.conversation.findUnique({ where: { id: convoId }, select: { turnLock: true, turnLockAt: true } });
      const free = !convo?.turnLock || !convo.turnLockAt || convo.turnLockAt < staleBefore;
      if (!free) {
        mayClaim = false;
        yieldingSince = undefined;
      } else {
        // Sem marca (conversa antiga, trava vencida): só a janela recente conta como fila.
        const watermark =
          !convo?.turnLock && convo?.turnLockAt ? convo.turnLockAt : new Date(ticket.createdAt.getTime() - TURN_LOCK_MAX_WAIT_MS);
        if (await hasEarlierQueued(convoId, ticket, watermark)) {
          yieldingSince ??= Date.now();
          if (Date.now() - yieldingSince < TURN_FIFO_GRACE_MS) mayClaim = false;
          else console.warn("[turn-lock:fifo-grace]", convoId);
        }
      }
    }
    if (mayClaim) {
      const claimed = await prisma.conversation.updateMany({
        where: {
          id: convoId,
          OR: [{ turnLock: null }, { turnLockAt: null }, { turnLockAt: { lt: staleBefore } }]
        },
        data: { turnLock: token, turnLockAt: new Date() }
      });
      if (claimed.count) return token;
    }
    if (Date.now() >= deadline) {
      console.warn("[turn-lock:barge]", convoId);
      await prisma.conversation.updateMany({ where: { id: convoId }, data: { turnLock: token, turnLockAt: new Date() } });
      return token;
    }
    await sleep(400);
  }
}

export async function releaseTurnLock(convoId: string, token: string, ticket?: TurnTicket) {
  try {
    // Só solta se o lock ainda é NOSSO — quem entrou por barge/TTL não pode ser solto
    // por um turno velho terminando atrasado. Solto, `turnLockAt` vira a marca d'água FIFO.
    await prisma.conversation.updateMany({
      where: { id: convoId, turnLock: token },
      data: { turnLock: null, turnLockAt: ticket?.createdAt ?? null }
    });
  } catch (error) {
    console.warn("[turn-lock:release-failed]", error instanceof Error ? error.message : error);
  }
}

// Mensagem gravada que sai SEM turno (duplicata, figurinha, login do painel…): avança a marca
// pra não segurar a fila atrás dela. Só com a trava livre; ocupada, a próxima cede no máximo
// TURN_FIFO_GRACE_MS. Nunca lança.
export async function skipTurnTicket(convoId: string, ticket?: TurnTicket) {
  if (!ticket) return;
  try {
    await prisma.conversation.updateMany({
      where: { id: convoId, turnLock: null, OR: [{ turnLockAt: null }, { turnLockAt: { lt: ticket.createdAt } }] },
      data: { turnLockAt: ticket.createdAt }
    });
  } catch (error) {
    console.warn("[turn-lock:skip-failed]", error instanceof Error ? error.message : error);
  }
}

// Mensagens de ESPERA de cotação sempre saem com o botão "Cancelar pedido" no Meta
// (pedido do dono, 11/08: a saída tem que estar visível, não escondida num comando).
// Sem Meta (ou em falha), cai no texto puro — "cancelar" digitado funciona igual.
// Dispara "estou procurando" só se a busca passar de LIA_SEARCH_NOTICE_MS (2,5s) —
// busca de catálogo local (instantânea) nunca chega a mandar a mensagem.
export const lastSearchNoticeAt = new Map<string, number>();

export function searchNoticeTimer(phone: string): { cancel: () => void } {
  const delay = Number(process.env.LIA_SEARCH_NOTICE_MS ?? 2500);
  const timer = setTimeout(() => {
    // Um aviso por rajada: a busca inicial e o resgate de última chance criam timers
    // separados e o cliente via "Procurando…" DUAS vezes (teste real 19/08).
    const last = lastSearchNoticeAt.get(phone) ?? 0;
    if (Date.now() - last < 90_000) return;
    lastSearchNoticeAt.set(phone, Date.now());
    void reply(phone, copy.searchingWider()).catch(() => {});
  }, delay);
  return { cancel: () => clearTimeout(timer) };
}

export async function replyQuoteNotice(phone: string, text: string) {
  try {
    if (await whatsappAdapter.sendCancelableNotice(phone, text)) {
      markTurnReplied();
      return;
    }
  } catch (error) {
    console.warn("[whatsapp:cancel-notice:fallback-text]", error instanceof Error ? error.message : error);
  }
  await reply(phone, text);
}

// ---------- basket parsing + catalog matching ----------

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
