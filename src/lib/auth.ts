import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// Em deploy (Vercel), segredo ausente é erro de configuração, nunca porta aberta: a
// checagem FALHA FECHADO. Localmente (dev/demo/testes) a ausência continua liberando,
// que é o que o dev:demo e a suíte esperam.
function missingSecret(name: string) {
  if (!process.env.VERCEL) return null;
  console.error(`[auth:missing-secret] ${name} não configurado — negando por segurança`);
  return NextResponse.json({ error: "Server auth not configured" }, { status: 401 });
}

export function requireApiToken(request: Request) {
  const expected = process.env.API_TOKEN;
  if (!expected) return missingSecret("API_TOKEN");

  const authorization = request.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();

  if (token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export function requireWebhookSecret(request: Request) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected) return missingSecret("WHATSAPP_WEBHOOK_SECRET");

  const secret = request.headers.get("x-webhook-secret");
  if (secret !== expected) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  return null;
}

export function requireMetaSignature(request: Request, rawBody: string) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return missingSecret("WHATSAPP_APP_SECRET");

  const signature = request.headers.get("x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) {
    return NextResponse.json({ error: "Missing Meta signature" }, { status: 401 });
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signature.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");

  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return NextResponse.json({ error: "Invalid Meta signature" }, { status: 401 });
  }

  return null;
}

// ---------- painel /ops ----------
// Revisão 01/09: sete cópias de `authed()` (5 rotas /api/ops + 2 petz-image) falhavam
// ABERTO sem OPS_TOKEN (um Preview da Vercel sem a env expunha a fila inteira, com
// telefone/endereço, e as ações de cancelar/estornar/despachar), comparavam com `===`
// (tempo variável), caíam em API_TOKEN e gravavam o PRÓPRIO token no cookie de 90 dias.
// Agora: fail-closed em deploy (mesma regra dos outros guards), comparação em tempo
// constante, sem fallback, e cookie = HMAC do token — quem rouba o cookie não leva a
// chave, e trocar OPS_TOKEN derruba todas as sessões.
function opsToken(): string | null {
  return process.env.OPS_TOKEN || null;
}

// ---------- dois papéis no /ops (15/09/2026) ----------
// A operação passou a ter um operador CONTRATADO, que não é o dono. Ele precisa da fila
// de pedidos para comprar, mas não das contas/senhas das lojas, do Pix de saída nem do
// setup da Meta. `OPS_OPERATOR_TOKEN` é um segundo segredo com acesso reduzido; sem ele
// nada muda (só existe o dono). Trocar o token do operador derruba só a sessão dele,
// porque o cookie é o HMAC do token que abriu a sessão.
export type OpsRole = "owner" | "operator";

function opsCredentials(): { role: OpsRole; token: string }[] {
  const owner = opsToken();
  const operator = process.env.OPS_OPERATOR_TOKEN || null;
  const list: { role: OpsRole; token: string }[] = [];
  if (owner) list.push({ role: "owner", token: owner });
  // Token de operador igual ao do dono não rebaixa ninguém: o dono é avaliado primeiro.
  if (operator && operator !== owner) list.push({ role: "operator", token: operator });
  return list;
}

function presentedSecrets(request: Request, allowQuery: boolean): { headers: string[]; cookie: string | null } {
  const header = request.headers.get("x-ops-key");
  const query = allowQuery ? new URL(request.url).searchParams.get("key") : null;
  const rawCookie = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)ops_session=([^;]+)/)?.[1];
  let cookie: string | null = null;
  if (rawCookie) {
    try {
      cookie = decodeURIComponent(rawCookie);
    } catch {
      cookie = rawCookie;
    }
  }
  return { headers: [header, query].filter((v): v is string => v != null), cookie };
}

// Papel de quem está chamando, ou `null` quando nenhum segredo bate.
export function opsRole(request: Request, options: { allowQuery?: boolean } = {}): OpsRole | null {
  const { headers, cookie } = presentedSecrets(request, Boolean(options.allowQuery));
  for (const { role, token } of opsCredentials()) {
    if (headers.some((value) => safeEqual(value, token))) return role;
    if (cookie != null && safeEqual(cookie, opsSessionCookieValue(token))) return role;
  }
  return isAgentRequest(request) ? "operator" : null;
}

// ---------- token do agente (Claude Code, dono 06/10) ----------
// Para o agente agir no /ops sem o dono abrir o painel. Entra como OPERADOR (rotas do dono
// barradas) e, além disso, nenhuma ação que devolva ou mova dinheiro (rota de pedidos).
// Só pelo header x-ops-key: fica fora do login, do cookie e do ?key=, e fora de
// opsCredentials (nunca assina link nem sessão).
export function isAgentRequest(request: Request): boolean {
  const agent = process.env.LIA_AGENT_OPS_TOKEN || null;
  const header = request.headers.get("x-ops-key");
  if (!agent || header == null) return false;
  if (agent === opsToken() || agent === process.env.OPS_OPERATOR_TOKEN) return false;
  return safeEqual(header, agent);
}

// Rota /api/ops/orders/[id]. Operador contratado: sem cancelar pedido pago nem estornar à
// mão. Agente: pode abrir o estorno ("cancel" só leva o pago a refund_pending), mas nada que
// devolva ou mova dinheiro — esse toque é sempre do dono.
const OPERATOR_DENIED_ORDER_ACTIONS = new Set(["cancel", "refund_provider", "confirm_refund"]);
const AGENT_DENIED_ORDER_ACTIONS = new Set(["refund_provider", "confirm_refund", "purchase_failed_refund"]);
export function opsOrderActionDenied(action: string | undefined, role: OpsRole | null, agent: boolean): boolean {
  if (!action) return false;
  if (agent) return AGENT_DENIED_ORDER_ACTIONS.has(action);
  return role === "operator" && OPERATOR_DENIED_ORDER_ACTIONS.has(action);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function opsSessionCookieValue(token: string): string {
  return createHmac("sha256", `lia-ops-session:${token}`).update("ops_session").digest("hex");
}

// `true`/`false` quando há token configurado; sem token, vale a regra local/deploy de
// `missingSecret` (libera em dev, nega na Vercel).
export function opsKeyMatches(value: string | null | undefined): boolean {
  const expected = opsToken();
  if (!expected) return !process.env.VERCEL;
  return opsKeyRole(value) !== null;
}

// Chave crua do DONO (rotas que nunca foram do operador). Mantém a regra local de
// `opsKeyMatches`: sem OPS_TOKEN, libera fora da Vercel.
export function ownerKeyMatches(value: string | null | undefined): boolean {
  if (!opsToken()) return !process.env.VERCEL;
  return opsKeyRole(value) === "owner";
}

// Papel de uma chave crua (?key=…), para o login saber qual cookie gravar.
export function opsKeyRole(value: string | null | undefined): OpsRole | null {
  if (value == null) return null;
  return opsCredentials().find((c) => safeEqual(value, c.token))?.role ?? null;
}

export function requireOpsKey(request: Request, options: { allowQuery?: boolean } = {}) {
  const expected = opsToken();
  if (!expected) return missingSecret("OPS_TOKEN");
  if (!opsRole(request, options)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

// Rotas que mexem em credencial de loja, dinheiro de saída ou configuração do canal: o
// operador contratado é barrado no SERVIDOR, não só escondido na tela.
export function requireOpsOwner(request: Request, options: { allowQuery?: boolean } = {}) {
  const denied = requireOpsKey(request, options);
  if (denied) return denied;
  if (opsRole(request, options) !== "owner")
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
  return null;
}

// ---------- login do /ops pelo WhatsApp (04/09) ----------
// O dono não conseguia abrir o painel: buscar OPS_TOKEN na Vercel a cada sessão era a
// barreira. Agora o operador manda "ops" pra Lia e recebe um link de uso curto, assinado
// com o PRÓPRIO OPS_TOKEN (nada novo pra guardar): /api/ops/login?login=<exp>.<nonce>.<hmac>.
// Vale 10 min; ao abrir, vira o mesmo cookie ops_session de sempre. Quem pode pedir o link
// é só telefone de operador (LIA_OPERATOR_PHONE / LIA_ADMIN_PHONES) — a Meta garante o
// remetente. Sem OPS_TOKEN não há link (fail-closed como o resto).
export const OPS_LOGIN_TTL_MS = 10 * 60_000;
export const OPS_SESSION_MAX_AGE_S = 60 * 60 * 24 * 365;

function loginSignature(secret: string, exp: string, nonce: string): string {
  return createHmac("sha256", `lia-ops-login:${secret}`).update(`${exp}.${nonce}`).digest("hex");
}

// O papel viaja no PRÓPRIO segredo que assina o link: quem entra pelo token do operador
// abre uma sessão de operador. O formato (exp.nonce.hmac) não mudou.
export function createOpsLoginToken(now = Date.now(), role: OpsRole = "owner"): string | null {
  // Nunca promover o operador por falha de configuração. Se o segundo segredo estiver
  // ausente (ou igual ao do dono, portanto descartado por opsCredentials), o login do
  // operador falha fechado em vez de assinar silenciosamente uma sessão de owner.
  const secret = opsCredentials().find((c) => c.role === role)?.token ?? null;
  if (!secret) return null;
  const exp = String(now + OPS_LOGIN_TTL_MS);
  const nonce = randomBytes(8).toString("hex");
  return `${exp}.${nonce}.${loginSignature(secret, exp, nonce)}`;
}

export function opsLoginRole(token: string | null | undefined, now = Date.now()): OpsRole | null {
  if (!token) return null;
  const [exp, nonce, sig] = token.split(".");
  if (!exp || !nonce || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return null;
  for (const { role, token: secret } of opsCredentials()) {
    if (safeEqual(sig, loginSignature(secret, exp, nonce))) return role;
  }
  return null;
}

export function verifyOpsLoginToken(token: string | null | undefined, now = Date.now()): boolean {
  return opsLoginRole(token, now) !== null;
}

// Segredo que abriu a sessão, para o cookie sair com o HMAC do papel certo.
export function opsTokenForRole(role: OpsRole): string | null {
  return opsCredentials().find((c) => c.role === role)?.token ?? null;
}

// ---------- botões do operador no WhatsApp (11/09) ----------
// O id do botão é `op1.<opsActionId>.<escolha>.<hmac32>`; a assinatura amarra ação e
// tipo com o MESMO OPS_TOKEN. Sem OPS_TOKEN não há botão (fail-closed): cai no texto + link.
export function signOpsAction(actionId: string, kind: string): string | null {
  const secret = opsToken();
  if (!secret) return null;
  return createHmac("sha256", `lia-ops-action:${secret}`).update(`${kind}.${actionId}`).digest("hex").slice(0, 32);
}
export function verifyOpsActionSignature(actionId: string, kind: string, sig: string): boolean {
  const expected = signOpsAction(actionId, kind);
  return Boolean(expected && sig && safeEqual(sig, expected));
}

export function opsLoginUrl(token: string): string {
  const base = (process.env.LIA_PUBLIC_URL ?? "https://liadelivery.com.br").replace(/\/$/, "");
  return `${base}/api/ops/login?login=${encodeURIComponent(token)}`;
}
