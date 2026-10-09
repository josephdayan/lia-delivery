import { recordDeliveryReceipt } from "@/lib/delivery-events";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { requireMetaSignature, requireWebhookSecret } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { handleDeliveryMessage, recoverFailedCarousel, runTurnScoped, TurnSupersededError } from "@/lib/delivery-service";
import { notifyOperator, isAdminPhone, notifyOwner, turnMeta } from "@/lib/turn-runtime";
import { startWhatsAppCardChargeWorkflow } from "@/lib/payments/whatsapp-pay-dispatch";
import { genericError, offlineNotice, turnStillWorking } from "@/lib/lia-copy";
import { isOfflineMode } from "@/lib/offline-mode";
import { whatsappAdapter } from "@/lib/adapters/whatsapp";
import { flowAddressToText, locationToText, reverseGeocode } from "@/lib/reverse-geocode";
import { locationNotResolved } from "@/lib/lia-copy";

export const dynamic = "force-dynamic";
// Real Mercado Livre search via Apify can take up to ~55s on a cold start, so the
// function needs a longer budget than the default. Replies go out through the
// WhatsApp provider API, so the user still gets results even if the inbound HTTP
// request times out.
export const maxDuration = 300;

// Entradas que não são texto mas viram texto para o cérebro (04/09):
// - request_welcome (cliente abriu o chat pela 1ª vez, boas-vindas ligadas na Meta) → "oi";
// - location (botão "Enviar localização") → CEP via geocodificação reversa;
// - nfm_reply (Flow de endereço) → linha de endereço completo.
async function normalizeInbound(inbound: ReturnType<typeof whatsappAdapter.parseInbound>): Promise<typeof inbound | null> {
  if (inbound.messageType === "request_welcome") return { ...inbound, text: "oi" };
  if (inbound.location) {
    const geo = await reverseGeocode(inbound.location.latitude, inbound.location.longitude);
    const text = locationToText(geo);
    if (!text) {
      try {
        await whatsappAdapter.sendMessage(inbound.phone, locationNotResolved());
      } catch (error) {
        console.error("[whatsapp:location:notify-failed]", error);
      }
      return null;
    }
    return { ...inbound, text };
  }
  if (inbound.flowResponse) {
    const text = flowAddressToText(inbound.flowResponse);
    if (text) return { ...inbound, text };
  }
  return inbound;
}

async function processDeliveryMessage(raw: ReturnType<typeof whatsappAdapter.parseInbound>) {
  const inbound = await normalizeInbound(raw);
  if (!inbound) return;
  try {
    // WATCHDOG anti-silêncio (caso real 19/08: o turno morreu no teto da função e o
    // cliente ficou sem NENHUMA resposta). Se o processamento passar do prazo, avisa o
    // cliente que a Lia continua nele — a resposta de verdade chega em seguida quando o
    // turno terminar; se a função for morta, ao menos o silêncio absoluto não existe.
    // 09/10 (latência): o aviso sai com 8 s (antes 45 s) — o cliente tolera 15 s de busca se souber que algo está acontecendo.
    const deadlineMs = Number(process.env.LIA_TURN_DEADLINE_MS ?? 8000);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    // runTurnScoped arma o CAS de contexto: se outro turno (ex.: um "cancelar") gravar
    // no meio deste, a próxima escrita DESTE falha e ele para — cesta velha nunca
    // ressuscita por cima da nova (P0.1 do teste de 26/08).
    // `repliesSoFar` lê o contador de envios DESTE turno: o aviso de espera só sai se o cliente ainda não recebeu nada
    // (09/10: "Só um instante" aparecia DEPOIS do total, parecendo um segundo turno).
    let repliesSoFar = () => 0;
    const work = runTurnScoped(() => {
      const meta = turnMeta.getStore();
      repliesSoFar = () => meta?.replies ?? 0;
      return handleDeliveryMessage(inbound);
    });
    const raced = await Promise.race([
      work.then(() => "done" as const),
      new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
      })
    ]);
    if (raced === "deadline") {
      console.warn(`[turn:deadline] ${inbound.phone} passou de ${deadlineMs}ms sem resposta`);
      try {
        if (repliesSoFar() === 0) await whatsappAdapter.sendMessage(inbound.phone, turnStillWorking());
      } catch (notifyError) {
        console.error(`[turn:deadline:notify-failed]`, notifyError);
      }
    }
    clearTimeout(deadlineTimer);
    await work;
  } catch (error) {
    // Turno superado NÃO é erro pro cliente: outro turno mais novo já respondeu por
    // ele. Falar "tive um problema" aqui seria ruído depois de uma resposta certa.
    if (error instanceof TurnSupersededError) {
      console.warn(`[whatsapp:${inbound.provider}:turn-superseded]`, inbound.phone);
      return;
    }
    console.error(`[whatsapp:${inbound.provider}:delivery-error]`, error);
    try {
      await whatsappAdapter.sendMessage(inbound.phone, genericError());
    } catch (sendError) {
      console.error(`[whatsapp:${inbound.provider}:fallback-error]`, sendError);
    }
  }
}

const genericSchema = z
  .object({
    from: z.string().optional(),
    phone: z.string().optional(),
    body: z.string().optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    profileName: z.string().optional()
  })
  .passthrough();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }

  return NextResponse.json({ error: "Invalid verify token" }, { status: 403 });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  // Assinatura ANTES de qualquer parse (revisão 02/09): corpo malformado anônimo não
  // chega ao JSON.parse/zod. Meta assina tudo que manda; o formato mock (dev/testes e
  // curl interno) exige o segredo compartilhado.
  const looksLikeMeta = /"object"\s*:\s*"whatsapp_business_account"/.test(rawBody) || /"entry"\s*:/.test(rawBody);
  if (looksLikeMeta) {
    const unauthorized = requireMetaSignature(request, rawBody);
    if (unauthorized) return unauthorized;
  } else {
    const unauthorized = requireWebhookSecret(request);
    if (unauthorized) return unauthorized;
  }
  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = genericSchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  const inbound = whatsappAdapter.parseInbound(rawPayload);
  // Em deploy, só o provedor configurado entra: um payload mock assinado com o segredo
  // não pode injetar mensagem "de" um telefone qualquer em produção.
  if (process.env.VERCEL && process.env.WHATSAPP_PROVIDER === "meta" && inbound.provider !== "meta") {
    return NextResponse.json({ error: "Unsupported WhatsApp provider" }, { status: 400 });
  }

  // Recibos também podem vir em lotes que contêm uma mensagem ou pagamento.
  if (inbound.provider === "meta") {
    try {
      const entries = (rawPayload as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<Record<string, unknown>> } }> }> }).entry ?? [];
      for (const entry of entries) for (const change of entry.changes ?? []) {
        for (const status of change.value?.statuses ?? []) await recordDeliveryReceipt(status);
      }
    } catch {
      return NextResponse.json({ ok: false, error: "receipt persistence unavailable" }, { status: 503 });
    }
  }

  // One-Click confirmation has no user text. It must be handled before the generic
  // receipt/message gate below or the current webhook would either ignore it or 400.
  if (inbound.provider === "meta" && inbound.eventType === "payment_confirmation" && inbound.paymentConfirmation) {
    try {
      const runId = await startWhatsAppCardChargeWorkflow(inbound.paymentConfirmation);
      return NextResponse.json({ ok: true, provider: "meta", event: "payment_confirmation", runId });
    } catch (error) {
      // A non-2xx response asks Meta to retry. We have not called Pagar.me yet; the
      // workflow's claim and provider idempotency then make a replay harmless.
      console.error("[whatsapp:meta:payment-workflow-start]", error);
      return NextResponse.json({ ok: false, error: "payment workflow unavailable" }, { status: 503 });
    }
  }

  // Meta sends delivery/read receipts to the same webhook. They are not customer
  // messages, but must be acknowledged with 200 or Meta retries them in bursts.
  if (inbound.provider === "meta" && inbound.eventType !== "message") {
    // Falha ASSÍNCRONA de entrega chega aqui como status "failed" — a Graph API aceita
    // a mensagem (2xx) e o WhatsApp descarta depois (ex.: header de imagem que o fetcher
    // rejeitou). Ignorar isso em silêncio custou um dia de "cadê os cards?" (07/08):
    // o cliente via só o header e nada de opção, e nenhum log contava o porquê. O erro
    // da Meta (code/title/details) agora fica gritando no runtime log da Vercel.
    try {
      const entries = (rawPayload as { entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> & { statuses?: Array<Record<string, unknown>> } }> }> }).entry ?? [];
      for (const entry of entries) {
        for (const change of entry.changes ?? []) {
          // Decisão do display name (25/09). Aprovado NÃO vale sozinho na Cloud API: é
          // preciso re-registrar o número em até 14 dias, senão expira e volta pra revisão.
          // Esse aviso era descartado em silêncio — provável motivo de "Lia Delivery"
          // nunca ter aparecido depois de três pedidos.
          if (change.field === "phone_number_name_update") {
            const detail = JSON.stringify(change.value ?? {}).slice(0, 800);
            console.warn("[whatsapp:meta:name-update]", detail);
            await notifyOwner(`📛 Meta decidiu o nome do WhatsApp: ${detail}. Se APPROVED, re-registrar o número em até 14 dias (POST /api/ops/meta-setup {action:"register", pin}).`);
          }
          for (const status of change.value?.statuses ?? []) {
            if (status.status === "failed") {
              const detail = JSON.stringify(status).slice(0, 1500);
              console.error("[whatsapp:meta:status-failed]", detail);
              // Runtime log do plano Hobby retém só 1h — a falha também vai pro BANCO,
              // como Message da conversa do destinatário, senão o diagnóstico evapora
              // antes de alguém olhar (scripts/tail-messages.mts lê depois).
              const digits = String(status.recipient_id ?? "").replace(/\D/g, "");
              // Carrossel descartado pela Meta → cards soltos no lugar (08/09). Conta sem
              // moeda/cobrança (131042) é problema do dono: avisa uma vez por falha.
              const errors = (status.errors as Array<{ code?: number; title?: string; error_data?: { details?: string } }> | undefined) ?? [];
              const failure = errors.map((e) => `${e.code} ${e.title ?? ""} ${e.error_data?.details ?? ""}`).join(" | ");
              if (digits && (await recoverFailedCarousel(String(status.id ?? ""), digits, failure))) {
                console.warn("[carousel:recovered-as-cards]", status.id);
                if (errors.some((e) => e.code === 131042)) {
                  await notifyOwner(`⚠️ Carrossel recusado pela Meta (131042: conta WhatsApp Business sem moeda/cobrança). Reenviei como cards soltos. Configure a moeda no Business Manager (billing_hub) ou deixe LIA_CAROUSEL=false.`, `+${digits}`);
                }
              }
              if (digits) {
                const user = await prisma.user.findUnique({ where: { phone: `+${digits}` } });
                const convo = user
                  ? await prisma.conversation.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } })
                  : null;
                if (convo) {
                  await prisma.message.create({
                    data: { conversationId: convo.id, sender: "meta-status-failed", text: detail }
                  });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      // diagnóstico nunca pode derrubar o ACK — Meta re-tentaria em rajada
      console.error("[whatsapp:meta:status-log-error]", error instanceof Error ? error.message : error);
    }
    return NextResponse.json({ ok: true, provider: "meta", ignored: inbound.eventType });
  }

  if (!inbound.phone) {
    return NextResponse.json({ error: "Invalid WhatsApp payload" }, { status: 400 });
  }

  // Reação (👍 num balão) não é mensagem — responder viraria spam. ACK e pronto.
  if (inbound.provider === "meta" && inbound.messageType === "reaction") {
    return NextResponse.json({ ok: true, provider: "meta", ignored: "reaction" });
  }

  // Mensagem SEM texto legível (áudio, imagem, figurinha, contato…): segue pro fluxo,
  // que responde "só leio texto" — antes era um 400 mudo e o cliente ficava no vácuo
  // (28/08 S2: "👍" e figurinhas morriam sem nenhuma resposta).
  if (!inbound.text && inbound.provider !== "meta") {
    return NextResponse.json({ error: "Invalid WhatsApp payload" }, { status: 400 });
  }

  // Botões assinados do OPERADOR (`op1.…`) e o número do pedido do ML que ele responde
  // (11/09): tratados ANTES do cérebro. Qualquer outra mensagem dele segue como cliente.
  if (inbound.text && isAdminPhone(inbound.phone)) {
    try {
      const { handleOperatorInbound } = await import("@/lib/ops-actions-inbound");
      if ((await handleOperatorInbound(inbound.phone, inbound.text)) === "handled")
        return NextResponse.json({ ok: true, provider: inbound.provider, operator: true });
    } catch (error) {
      console.error("[ops-action:inbound-error]", error instanceof Error ? error.message : error);
    }
  }

  // Modo offline (06/10): cliente comum recebe só o aviso; dono e admins seguem normal.
  if (await isOfflineMode()) {
    if (!isAdminPhone(inbound.phone)) {
      console.warn("[offline-mode:customer-blocked]", inbound.phone, (inbound.text ?? "").slice(0, 80));
      try {
        await whatsappAdapter.sendMessage(inbound.phone, offlineNotice());
      } catch (error) {
        console.error("[offline-mode:notify-failed]", error instanceof Error ? error.message : error);
      }
      return NextResponse.json({ ok: true, provider: inbound.provider, offline: true });
    }
  }

  if (inbound.provider === "meta") {
    // "Digitando…" + lido, na hora: a resposta pode levar até 25 s (04/09). Fire-and-forget.
    if (inbound.messageType !== "request_welcome") waitUntil(whatsappAdapter.markReadWithTyping(inbound.messageId).then(() => undefined));
    // A product lookup can take tens of seconds. Acknowledge the webhook first so
    // Meta does not retry the same message while the conversation runs.
    waitUntil(processDeliveryMessage(inbound));
    return NextResponse.json({ ok: true, provider: "meta" });
  }

  // Provedor mock (dev/testes/curl interno): processa em linha e responde.
  await processDeliveryMessage(inbound);
  return NextResponse.json({ ok: true, provider: "mock" });
}
