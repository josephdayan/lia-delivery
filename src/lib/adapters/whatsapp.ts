import { carouselCardBodyFor, compactCardDelivery, fitCarouselCardParams } from "@/lib/meta-carousel-card";
import { metaReferralAcquisition } from "@/lib/acquisition";


type RawInbound = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        statuses?: Array<{ id?: string; status?: string; timestamp?: string; recipient_id?: string }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          text?: { body?: string };
          button?: { payload?: string; text?: string };
          interactive?: {
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
            // Resposta de um Flow (formulário dentro do chat): JSON serializado.
            nfm_reply?: { response_json?: string; body?: string; name?: string };
          };
          // Botão "Enviar localização" (04/09): coordenadas + endereço se o cliente quis.
          location?: { latitude?: number; longitude?: number; name?: string; address?: string };
          // Mídia (14/09): a Meta NÃO manda o arquivo no webhook, só o id — os bytes
          // saem de `downloadMetaMedia`. Áudio de voz vem como type "audio" com
          // `voice: true`; foto como "image" (com legenda opcional).
          audio?: { id?: string; mime_type?: string; voice?: boolean };
          image?: { id?: string; mime_type?: string; caption?: string };
          // Present on the first message opened from a click-to-WhatsApp ad.
          // `source_id` identifies the Meta source/ad and `ctwa_clid` identifies the click.
          referral?: {
            source_url?: string;
            source_type?: string;
            source_id?: string;
            headline?: string;
            body?: string;
            media_type?: string;
            image_url?: string;
            video_url?: string;
            thumbnail_url?: string;
            ctwa_clid?: string;
          };
          type?: string;
        }>;
      };
    }>;
  }>;
  from?: string;
  phone?: string;
  body?: string;
  text?: string;
  name?: string;
  profileName?: string;
  [key: string]: unknown;
};

export type PaymentConfirmation = {
  referenceId: string;
  credentialId?: string;
  last4?: string;
  status: string;
  phone?: string;
};

export type WhatsAppOrderDetailItem = {
  retailerId: string;
  name: string;
  quantity: number;
  unitAmount: number;
};

export type WhatsAppOrderDetailsInput = {
  referenceId: string;
  body: string;
  credentialId: string;
  last4: string;
  total: number;
  subtotal: number;
  shipping: number;
  tax: number;
  items: WhatsAppOrderDetailItem[];
};

export type WhatsAppOrderStatusInput = {
  referenceId: string;
  body: string;
  orderStatus?: "processing" | "canceled";
  paymentStatus: "captured" | "failed";
  timestamp?: number;
};

// Estrutural (revisão 02/09): o modelo Prisma `Product` era do motor ML de junho.
export type WhatsAppProduct = {
  id?: string;
  title: string;
  price: number;
  shippingPrice: number;
  imageUrl: string;
  productUrl: string;
  deliveryEstimate: string;
  deliveryHours?: number | null;
  source: string;
  automationLevel: string;
  [key: string]: unknown;
};

export type WhatsAppProductOption = {
  rank: number;
  reason: string;
  product: WhatsAppProduct;
};

export type WhatsAppRichReply = {
  text: string;
  options?: WhatsAppProductOption[];
  actions?: Array<{ id: string; title: string }>;
};

export type WhatsAppDeliveryChoice = {
  id: string;
  name: string;
  displayPrice: number;
  imageUrl?: string;
  delivery?: string;
  // "Você já pediu este" (04/09): destaque no card do produto já comprado.
  badge?: string;
  // Página real do produto (anúncio ML, página da loja): liga o botão "Ver detalhes"
  // do card — reviews, fotos e specs ficam a um toque (pedido do dono, 01/09).
  productUrl?: string;
  // Sku para o id de máquina do "Ver detalhes" (optinfo:<sku>), estável em card antigo.
  sku?: string;
};

function minorAmount(value: number) {
  return Math.round(Number(value.toFixed(2)) * 100);
}

function metaMessagesUrl(phoneNumberId: string) {
  const version = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v21.0";
  return `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
}

function money(value: number) {
  return { value: minorAmount(value), offset: 100 };
}

// Pure payload builder: the result can be tested without Meta credentials. The
// WhatsApp Payments API expects integer minor units plus an explicit offset.
export function buildOrderDetailsPayload(to: string, input: WhatsAppOrderDetailsInput) {
  const itemsTotal = input.items.reduce((sum, item) => sum + minorAmount(item.unitAmount) * item.quantity, 0);
  const subtotal = minorAmount(input.subtotal);
  const shipping = minorAmount(input.shipping);
  const tax = minorAmount(input.tax);
  const total = minorAmount(input.total);
  if (itemsTotal !== subtotal || subtotal + shipping + tax !== total) {
    throw new Error("WhatsApp order details must balance item subtotal, shipping, tax and total");
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "order_details",
      body: { text: input.body.slice(0, 1024) },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: input.referenceId,
          type: "physical-goods",
          payment_type: "br",
          payment_settings: [{
            type: "offsite_card_pay",
            offsite_card_pay: {
              last_four_digits: input.last4,
              credential_id: input.credentialId
            }
          }],
          currency: "BRL",
          total_amount: money(input.total),
          order: {
            status: "pending",
            tax: { ...money(input.tax), description: "Taxa do cartão" },
            shipping: { ...money(input.shipping), description: "Entrega" },
            items: input.items.map((item) => ({
              retailer_id: item.retailerId,
              name: item.name.slice(0, 100),
              amount: money(item.unitAmount),
              quantity: item.quantity
            })),
            subtotal: money(input.subtotal)
          }
        }
      }
    }
  };
}

// Bolha nativa de Pix (order_details + pix_dynamic_code): o mesmo formato do One-Click,
// trocando o cartão por um código Pix dinâmico — total, "Pagar com Pix" e "Copy Pix code"
// dentro do chat. Diferente do offsite_card_pay, a doc pública da Meta não lista allowlist
// para Pix; a flag LIA_NATIVE_PIX liga o experimento e o copia-e-cola em texto continua
// saindo como rede de segurança (a entrega Meta é assíncrona e pode descartar sem erro).
export type WhatsAppPixOrderDetailsInput = {
  referenceId: string;
  body: string;
  itemName: string;
  total: number;
  pixCode: string;
  merchantName: string;
  key: string;
  keyType: "CPF" | "CNPJ" | "EMAIL" | "PHONE";
};

export function buildPixOrderDetailsPayload(to: string, input: WhatsAppPixOrderDetailsInput) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "order_details",
      body: { text: input.body.slice(0, 1024) },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: input.referenceId,
          type: "physical-goods",
          payment_type: "br",
          payment_settings: [{
            type: "pix_dynamic_code",
            pix_dynamic_code: {
              code: input.pixCode,
              merchant_name: input.merchantName.slice(0, 100),
              key: input.key,
              key_type: input.keyType
            }
          }],
          currency: "BRL",
          total_amount: money(input.total),
          order: {
            status: "pending",
            // Linha única = total: frete e taxa já estão embutidos no total cotado, e a
            // cobrança real é o código Pix — a bolha é apresentação, não contabilidade.
            items: [{
              retailer_id: input.referenceId,
              name: input.itemName.slice(0, 100),
              amount: money(input.total),
              quantity: 1
            }],
            subtotal: money(input.total)
          }
        }
      }
    }
  };
}

// Template aprovado na Meta (categoria Utility): o ÚNICO tipo de mensagem que passa fora
// da janela de 24h desde a última mensagem do cliente (erro 131047 "Re-engagement" nas
// mensagens livres — 03/09: aviso ao cliente e alerta ao operador falharam por isso).
// Parâmetros de body não aceitam quebra de linha nem 4+ espaços seguidos.
export type WhatsAppTemplateInput = { name: string; language?: string; bodyParams: string[] };

export function buildTemplatePayload(to: string, input: WhatsAppTemplateInput) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "template",
    template: {
      name: input.name,
      language: { code: input.language ?? process.env.LIA_TEMPLATE_LANG ?? "pt_BR" },
      components: [
        {
          type: "body",
          parameters: input.bodyParams.map((text) => ({
            type: "text",
            text: text.replace(/\s*\n+\s*/g, " · ").replace(/\s{4,}/g, "   ").trim().slice(0, 1024)
          }))
        }
      ]
    }
  };
}

// Carrossel da vitrine (dono, 07/09): UMA mensagem de template de marketing com 2–3 cards
// (foto + nome/preço/prazo + "Adicionar ao carrinho"/"Outras opções"). O template é fixo em número
// de cards (vitrine_carrossel_2/_3, criados em /api/ops/meta-setup?action=carousel); só o
// conteúdo é variável. Cobrado por envio (~R$0,33): liga com LIA_CAROUSEL=true.
export function carouselEnabled(): boolean {
  return process.env.LIA_CAROUSEL === "true";
}

function templateParam(text: string, max = 1024) {
  return text.replace(/\s*\n+\s*/g, " · ").replace(/\s{4,}/g, "   ").trim().slice(0, max) || "-";
}

// Os 3 parâmetros do corpo do card, já ajustados ao limite hidratado da Meta.
function cardBodyParams(option: WhatsAppDeliveryChoice, body?: string): [string, string, string] {
  const fitted = fitCarouselCardParams({
    // Carrossel (dono, 08/10 noite): o motivo da recomendação (2ª linha, "_…_") NÃO entra no card —
    // aparecia com o sublinhado cru e roubava o espaço do prazo ("Drogarias Pacheco ·…"). Cards soltos
    // e lista de texto continuam com o motivo.
    name: templateParam(option.badge ? `⭐ ${option.badge} · ${option.name.split("\n")[0]}` : option.name.split("\n")[0]),
    price: formatBRL(option.displayPrice),
    // O rótulo do prazo já está no template; o texto vai compacto (janela agendada = só a janela).
    delivery: templateParam(compactCardDelivery(option.delivery ?? "confirmo na cotação"))
  }, undefined, body);
  // Variável vazia é recusada pelo template: prazo sem espaço vira um traço.
  return [fitted.name || "-", fitted.price, fitted.delivery || "-"];
}

export function buildCarouselPayload(to: string, templateName: string, header: string, options: WhatsAppDeliveryChoice[]) {
  const cardBody = carouselCardBodyFor(templateName.replace(/_\d+$/, ""));
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: process.env.LIA_TEMPLATE_LANG ?? "pt_BR" },
      components: [
        // v5 (05/10): corpo fixo "Olha o que achei 👇", sem variável — o cabeçalho não vai.
        ...(/^vitrine_carrossel_v5_\d+$/.test(templateName) ? [] : [{ type: "body", parameters: [{ type: "text", text: templateParam(header) }] }]),
        {
          type: "carousel",
          cards: options.map((option, index) => ({
            card_index: index,
            components: [
              { type: "header", parameters: [{ type: "image", image: { link: safeMediaLink(option.imageUrl ?? "") } }] },
              {
                type: "body",
                // Os tetos por variável não bastam: a Meta mede o corpo JÁ HIDRATADO contra
                // 160 e recusa a mensagem inteira (#132018) — era o que derrubava o
                // carrossel em toda busca (produção, 15/09). `fitCarouselCardParams` divide
                // o orçamento real entre nome e prazo, sem nunca truncar o preço.
                parameters: cardBodyParams(option, cardBody).map((text) => ({ type: "text", text }))
              },
              { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: option.id.slice(0, 128) }] },
              // "Outras opções" em todo card (Meta: botões iguais em todos): volta como opt:outras.
              { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "opt:outras" }] }
            ]
          }))
        }
      ]
    }
  };
}

export type WhatsAppListInput = {
  body: string;
  buttonText: string;
  footer?: string;
  sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>;
};

export function buildListPayload(to: string, input: WhatsAppListInput) {
  let budget = 10;
  const sections = input.sections
    .map((section) => {
      const rows = section.rows.slice(0, Math.max(0, budget)).map((row) => ({
        id: row.id.slice(0, 200),
        title: row.title.slice(0, 24),
        ...(row.description ? { description: row.description.slice(0, 72) } : {})
      }));
      budget -= rows.length;
      return { ...(section.title ? { title: section.title.slice(0, 24) } : {}), rows };
    })
    .filter((section) => section.rows.length > 0);
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: input.body.slice(0, 1024) },
      ...(input.footer ? { footer: { text: input.footer.slice(0, 60) } } : {}),
      action: { button: input.buttonText.slice(0, 20), sections }
    }
  };
}

// Valores do `data` do Flow: string (endereço, cadastro) ou JSON (Flow da lista: arrays de
// opções, booleanos).
export type WhatsAppFlowDataValue = string | number | boolean | null | WhatsAppFlowDataValue[] | { [key: string]: WhatsAppFlowDataValue };

// Id do botão "Mudar minha lista" (volta como texto e reenvia o Flow da lista).
export const LIST_FLOW_REOPEN_ID = "mudar_lista";

export type WhatsAppFlowInput = {
  body: string;
  cta: string;
  flowId: string;
  screen: string;
  data?: Record<string, WhatsAppFlowDataValue>;
  token?: string;
  header?: string;
  footer?: string;
};

export function buildFlowPayload(to: string, input: WhatsAppFlowInput) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "flow",
      ...(input.header ? { header: { type: "text", text: input.header.slice(0, 60) } } : {}),
      body: { text: input.body.slice(0, 1024) },
      ...(input.footer ? { footer: { text: input.footer.slice(0, 60) } } : {}),
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: input.token ?? `lia-${Date.now()}`,
          flow_id: input.flowId,
          flow_cta: input.cta.slice(0, 20),
          flow_action: "navigate",
          flow_action_payload: { screen: input.screen, ...(input.data ? { data: input.data } : {}) }
        }
      }
    }
  };
}

export function buildOrderStatusPayload(to: string, input: WhatsAppOrderStatusInput) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "order_status",
      body: { text: input.body.slice(0, 1024) },
      action: {
        name: "review_order",
        parameters: {
          reference_id: input.referenceId,
          ...(input.orderStatus ? { order: { status: input.orderStatus } } : {}),
          payment: {
            status: input.paymentStatus,
            timestamp: input.timestamp ?? Math.floor(Date.now() / 1000)
          }
        }
      }
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function paymentConfirmationFrom(value: unknown): PaymentConfirmation | null {
  const outer = asRecord(value);
  if (!outer) return null;
  const payment = asRecord(outer.payment_method) ?? asRecord(outer.payment) ?? outer;
  const referenceId = optionalString(payment.reference_id) ?? optionalString(outer.reference_id);
  if (!referenceId) return null;
  const paymentMethod = optionalString(payment.payment_method) ?? optionalString(outer.payment_method);
  if (paymentMethod && paymentMethod !== "offsite_card_pay") return null;
  return {
    referenceId,
    credentialId: optionalString(payment.credential_id) ?? optionalString(outer.credential_id),
    last4: optionalString(payment.last_four_digits) ?? optionalString(outer.last_four_digits),
    status: optionalString(payment.status) ?? optionalString(outer.status) ?? "confirmed"
  };
}

// Meta's One-Click webhook is an inbound interactive payment_method message. The
// parser also accepts the earlier/status-shaped payloads seen in partner examples so
// a harmless shape change cannot make the provider retry this event in a burst.
export function parsePaymentConfirmation(payload: RawInbound): PaymentConfirmation | null {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;
  const rawValue = value as Record<string, unknown>;
  const messages = Array.isArray(rawValue.messages) ? rawValue.messages : [];
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const interactive = asRecord(record.interactive);
    const interactiveType = optionalString(interactive?.type);
    if (record.type === "payment" || interactiveType === "payment_method") {
      const confirmed = paymentConfirmationFrom(interactive ?? record);
      if (confirmed) return confirmed;
    }
  }
  const statuses = Array.isArray(rawValue.statuses) ? rawValue.statuses : [];
  for (const status of statuses) {
    const record = asRecord(status);
    if (!record) continue;
    if (record.type === "payment" || record.type === "payment_method" || record.payment || record.payment_method) {
      const confirmed = paymentConfirmationFrom(record);
      if (confirmed) return confirmed;
    }
  }
  return null;
}

function parseFlowResponse(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const whatsappAdapter = {
  parseInbound(payload: RawInbound) {
    const metaChange = payload.entry?.[0]?.changes?.[0]?.value;
    const metaMessage = metaChange?.messages?.[0];
    const metaContact = metaChange?.contacts?.[0];
    const parsedPaymentConfirmation = parsePaymentConfirmation(payload);
    // Bind the confirmation to the WhatsApp sender as well as to the opaque
    // reference id. Meta signs the webhook, but this prevents an implementation
    // mistake from ever charging an attempt for a different conversation.
    const paymentConfirmation = parsedPaymentConfirmation && metaMessage?.from
      ? { ...parsedPaymentConfirmation, phone: metaMessage.from }
      : parsedPaymentConfirmation;

    return {
      phone:
        metaMessage?.from ??
        payload.from ??
        payload.phone ??
        extractNestedString(payload, ["message", "from"]) ??
        "",
      text:
        metaMessage?.interactive?.button_reply?.id ??
        metaMessage?.interactive?.button_reply?.title ??
        metaMessage?.interactive?.list_reply?.id ??
        metaMessage?.interactive?.list_reply?.title ??
        metaMessage?.button?.payload ??
        metaMessage?.button?.text ??
        metaMessage?.text?.body ??
        payload.body ??
        payload.text ??
        extractNestedString(payload, ["message", "text"]) ??
        "",
      name:
        metaContact?.profile?.name ??
        payload.name ??
        payload.profileName ??
        extractNestedString(payload, ["profile", "name"]) ??
        undefined,
      messageId: metaMessage?.id ?? stringFromPayload(payload.messageId),
      acquisition: metaReferralAcquisition(metaMessage?.referral),
      // Localização compartilhada (tipo "location") — o webhook converte em CEP.
      location:
        metaMessage?.type === "location" && typeof metaMessage.location?.latitude === "number" && typeof metaMessage.location?.longitude === "number"
          ? { latitude: metaMessage.location.latitude, longitude: metaMessage.location.longitude, address: metaMessage.location.address, name: metaMessage.location.name }
          : undefined,
      // Resposta de Flow (formulário): objeto já parseado, ou undefined.
      flowResponse: parseFlowResponse(metaMessage?.interactive?.nfm_reply?.response_json),
      // Áudio/foto (14/09): só o id + o mime; os bytes vêm depois, por `downloadMetaMedia`
      // (a URL da Graph expira em ~5 min, então nada de guardar pra depois). A legenda da
      // foto entra aqui em vez de virar `text`, senão o cérebro trataria "quero 2 desse"
      // como pedido sem produto — o entendimento da imagem é que fecha a frase.
      media: metaMessage?.audio?.id
        ? { kind: "audio" as const, id: metaMessage.audio.id, mimeType: metaMessage.audio.mime_type }
        : metaMessage?.image?.id
          ? {
              kind: "image" as const,
              id: metaMessage.image.id,
              mimeType: metaMessage.image.mime_type,
              caption: stringFromPayload(metaMessage.image.caption)
            }
          : undefined,
      // Tipo do conteúdo Meta ("text", "reaction", "audio", "image", "sticker"…) — o
      // webhook decide o que ignorar (reação) e o que avisar ("só leio texto").
      messageType: (metaMessage as { type?: string } | undefined)?.type,
      eventType: paymentConfirmation ? "payment_confirmation" : metaMessage ? "message" : metaChange?.statuses?.length ? "status" : metaChange ? "meta_event" : "message",
      paymentConfirmation,
      // Só Meta (produção) e mock (dev/testes). Twilio saiu em 02/09.
      provider: metaChange ? "meta" : "mock"
    };
  },

  async sendMessage(to: string, text: string, metadata?: unknown) {
    if (process.env.WHATSAPP_PROVIDER === "meta") {
      return sendMetaMessage(to, text, (metadata as { noticeId?: string } | undefined)?.noticeId);
    }

    console.log("[whatsapp:mock]", { to, text, metadata });
    return { provider: "mock", to, text, metadata };
  },

  // Send a single image (public URL) with a caption. Used to show product photos in
  // the delivery flow. Falls back to a plain text message if media can't be sent, so
  // the customer always sees the caption.
  async sendMedia(to: string, text: string, mediaUrl: string) {
    if (!isPublicMediaUrl(mediaUrl)) return this.sendMessage(to, text);
    if (process.env.WHATSAPP_PROVIDER === "meta") return sendMetaImage(to, text, mediaUrl);
    console.log("[whatsapp:mock:media]", { to, text, mediaUrl });
    return { provider: "mock", to, text, mediaUrl };
  },

  // True only if this image URL can actually be delivered as WhatsApp media (https +
  // not an anti-bot-locked host like Petz's Akamai CDN). Lets callers pick the photo
  // layout vs. the single numbered-text list instead of sending broken/degraded media.
  canSendImage(url?: string) {
    return Boolean(url) && isPublicMediaUrl(url as string);
  },

  // Product choices used by the current delivery flow. On Meta each option becomes
  // its own card with an "Adicionar" reply button, so the button is visually tied
  // to the right photo/product. Other providers return null and keep the numbered
  // text fallback owned by delivery-service.
  async sendDeliveryChoices(to: string, options: WhatsAppDeliveryChoice[]) {
    if (process.env.WHATSAPP_PROVIDER !== "meta" || !options.length) return null;
    return sendMetaDeliveryChoices(to, options.slice(0, 3));
  },

  // Carrossel (uma mensagem) no lugar dos cards soltos. null = não deu (desligado, 1
  // opção, foto faltando/ruim, template não aprovado): o chamador cai nos cards de sempre.
  async sendDeliveryCarousel(to: string, header: string, options: WhatsAppDeliveryChoice[]) {
    if (process.env.WHATSAPP_PROVIDER !== "meta" || !carouselEnabled()) return null;
    // Até 5 cards no carrossel (10/09); os cards soltos do fallback seguem em 3.
    const cards = options.slice(0, 5);
    if (cards.length < 2) return null;
    if (cards.some((option) => !isPublicMediaUrl(option.imageUrl ?? ""))) return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    const alive = await Promise.all(cards.map((option) => mediaLinkAlive(safeMediaLink(option.imageUrl ?? ""))));
    if (alive.some((ok) => !ok)) return null;
    const { carouselTemplateName, activeCarouselPrefix } = await import("@/lib/meta-setup");
    try {
      const prefix = await activeCarouselPrefix(cards.length);
      const message = (await sendMetaPayload(phoneNumberId, token, buildCarouselPayload(to, carouselTemplateName(cards.length, prefix), header, cards))) as { messages?: Array<{ id?: string }> };
      // O wamid é a chave da rede de segurança: a Meta aceita (2xx) e pode descartar
      // DEPOIS (status "failed" no webhook, ex.: 131042 conta sem moeda, 08/09) — aí o
      // cérebro reenvia os cards soltos pelo id.
      return { provider: "meta", mode: "delivery_choice_carousel", to, message, messageId: message.messages?.[0]?.id };
    } catch (error) {
      console.warn("[whatsapp:meta:carousel:fallback-cards]", error instanceof Error ? error.message : error);
      return null;
    }
  },

  async sendQuantityChoices(to: string, productName: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    // Lista de 1 a 6 + "Outra" (04/09; antes 3 botões). O toque volta como qty:N e cai
    // no mesmo handler — digitar direto no chat continua valendo.
    return this.sendListMessage(to, {
      body: `Quantas unidades de *${productName}*?`,
      buttonText: "Escolher quantidade",
      footer: "Ou digita a quantidade direto aqui.",
      sections: [
        {
          rows: [
            ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `qty:${n}`, title: n === 1 ? "1 unidade" : `${n} unidades` })),
            { id: "qty:other", title: "Outra quantidade", description: "Eu digito o número" }
          ]
        }
      ]
    });
  },

  // Botões assinados do OPERADOR (11/09): o id volta em `text` pelo parseInbound e o webhook
  // roteia `op1.…` para ops-actions-inbound antes do cérebro. Fora do Meta devolve mock.
  async sendOperatorButtons(to: string, body: string, buttons: Array<{ id: string; title: string }>) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") {
      console.log("[whatsapp:mock:operator-buttons]", { to, body: body.slice(0, 80), buttons });
      return { provider: "mock", to, body, buttons };
    }
    return sendMetaSimpleButtons(to, body, buttons);
  },

  async sendPaymentChoices(to: string, pixTotal: number, cardTotal: number) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    // A saída sempre visível (pedido do dono, 11/08): dá pra desistir sem digitar nada.
    return sendMetaSimpleButtons(to, "Como prefere pagar?", [
      { id: "pix", title: "Pix" },
      { id: "cartao", title: "Cartão" },
      { id: "cancelar", title: "Cancelar" }
    ], `Pix ${formatBRL(pixTotal)} · Cartão ${formatBRL(cardTotal)}`);
  },

  // Escolha de entrega barata/lenta × rápida/cara (dono, 17/08: "tem q ter botão"). O
  // toque volta como o texto `frete:barato` / `frete:rapido`. O título do botão tem teto de
  // 20 caracteres no WhatsApp, então preço fica no corpo e a DATA vai no botão — é a
  // informação que diferencia as duas na hora do toque. Fora do Meta retorna null e o
  // chamador manda a lista numerada.
  async sendShippingChoices(
    to: string,
    body: string,
    barato: { estimate?: string },
    rapido: { estimate?: string }
  ) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    const title = (prefix: string, estimate?: string) => (estimate ? `${prefix} · ${estimate}` : prefix);
    return sendMetaSimpleButtons(to, body, [
      { id: "frete:barato", title: title("Mais barato", barato.estimate) },
      { id: "frete:rapido", title: title("Mais rápido", rapido.estimate) },
      { id: "cancelar", title: "Cancelar" }
    ]);
  },

  // Oferta de troca de loja pro pedido mínimo (24/08): o toque volta como
  // `minswap:yes` e o roteador aplica a troca; fora do Meta, texto puro com a dica.
  async sendStoreSwapOffer(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "minswap:yes", title: "Trocar de loja" },
      { id: "minswap:no", title: "Deixar como está" }
    ]);
  },

  // Oferta de juntar a cesta numa loja só (09/10): o toque volta como `consolidar:sim` / `consolidar:nao`.
  async sendConsolidationOffer(to: string, body: string, storeLabel: string, stores: number) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "consolidar:sim", title: `Juntar na ${storeLabel}`.slice(0, 20) },
      { id: "consolidar:nao", title: `Manter ${stores} lojas`.slice(0, 20) }
    ]);
  },

  // Aviso de espera de cotação com a saída SEMPRE visível (pedido do dono, 11/08): botão
  // "Cancelar pedido" cujo toque volta como o texto "cancelar" e cai no cancel contextual
  // que já existe. Fora do Meta retorna null e o chamador manda o texto puro.
  async sendCancelableNotice(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [{ id: "cancelar", title: "Cancelar pedido" }]);
  },

  // Resumo da cotação com botões "Trocar endereço" e "Editar itens" (dono, 01/09:
  // tinha total sem caminho visível pra tirar item). Os toques voltam como
  // `trocar_endereco` / `editar_itens` e caem nos fluxos que já existiam por texto.
  // Fora do Meta retorna null → texto puro com a dica escrita.
  async sendQuoteSummary(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "trocar_endereco", title: "Trocar endereço" },
      { id: "editar_itens", title: "Editar itens" }
    ]);
  },

  // Confirmação de recompra com cartão salvo SEM a Payments API da Meta: botões comuns
  // de resposta. O toque volta como texto `cardpay:<attemptId>` / `cardother` e o fluxo
  // cobra pelo Pagar.me — nenhum dado de cartão passa pelo chat.
  async sendSavedCardButtons(to: string, input: { attemptId: string; last4: string; total: number }) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(
      to,
      `Pagar ${formatBRL(input.total)} com o cartão salvo final ${input.last4}?`,
      [
        { id: `cardpay:${input.attemptId}`, title: `Pagar •••• ${input.last4}` },
        { id: "cardother", title: "Outro cartão" }
      ]
    );
  },

  async sendOrderDetailsCard(to: string, input: WhatsAppOrderDetailsInput) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") throw new Error("WhatsApp One-Click requires WHATSAPP_PROVIDER=meta");
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, buildOrderDetailsPayload(to, input));
  },

  async sendPixOrderDetails(to: string, input: WhatsAppPixOrderDetailsInput) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") throw new Error("Native Pix bubble requires WHATSAPP_PROVIDER=meta");
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, buildPixOrderDetailsPayload(to, input));
  },

  async sendOrderStatus(to: string, input: WhatsAppOrderStatusInput) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, buildOrderStatusPayload(to, input));
  },

  // Pós-escolha do concierge: o cliente acabou de confirmar um item e as três saídas
  // naturais viram botão (pedido do dono, 09/08). Os ids voltam como texto e caem nos
  // ramos que JÁ existem: "pagar" fecha a lista e cota, "adicionar_mais" pede o próximo
  // item, "cancelar" limpa a lista em montagem.
  async sendChoiceFollowUp(to: string, body: string, opts?: { qtyButton?: boolean; listFlowButton?: boolean }) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    // Depois do formulário da lista (dono, 08/10 noite): "Adicionar mais" e "Mudar minha lista" viram UM
    // botão ("Mudar ou adicionar" reabre o formulário e diz que item novo é só mandar o nome) e o
    // terceiro é "Cancelar".
    if (opts?.listFlowButton) {
      return sendMetaSimpleButtons(to, body, [
        { id: "pagar", title: "Pagar" },
        { id: LIST_FLOW_REOPEN_ID, title: "Mudar ou adicionar" },
        { id: "cancelar", title: "Cancelar" }
      ]);
    }
    return sendMetaSimpleButtons(to, body, [
      // Foi "Pagar"→"Ver total" (rodada 1) e voltou a "Pagar" por decisão do dono
      // (01/09): com a bolha nativa de Pix, o toque leva direto ao fluxo de pagamento
      // — total + formas na mesma resposta, cobrança em seguida.
      { id: "pagar", title: "Pagar" },
      { id: "adicionar_mais", title: "Adicionar mais" },
      // Teto Meta = 3 botões. Quando a quantidade acabou de ser assumida (1 un), o
      // terceiro vira "Mudar quantidade" (dono, 01/09) — "cancelar" digitado segue
      // funcionando em qualquer estado.
      opts?.qtyButton ? { id: "qtd_alterar", title: "Mudar quantidade" } : { id: "cancelar", title: "Cancelar" }
    ]);
  },

  // Pergunta "juntar no pedido parado ou pedido novo?" (01/09). Ids voltam como texto.
  async sendLongTailOfferButtons(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "longtail_sim", title: "Sim, procura" },
      { id: "longtail_nao", title: "Não precisa" }
    ]);
  },

  async sendMergeDecisionButtons(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "juntar_pedido", title: "Juntar no pedido" },
      { id: "pedido_novo", title: "Pedido novo" }
    ]);
  },

  // "Digitando…" (Cloud API, 2026): marca a mensagem recebida como lida e mostra o
  // indicador por até 25 s ou até a resposta sair. A busca leva de 5 a 25 s — sem isso o
  // cliente ficava no vácuo (princípio de zero espera do dono). Nunca lança.
  async markReadWithTyping(messageId: string | undefined) {
    if (!messageId || process.env.WHATSAPP_PROVIDER !== "meta" || process.env.LIA_TYPING_OFF === "true") return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return null;
    try {
      return await sendMetaPayload(phoneNumberId, token, {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" }
      });
    } catch (error) {
      console.warn("[whatsapp:meta:typing-failed]", error instanceof Error ? error.message : error);
      return null;
    }
  },

  // Baixa a mídia que o cliente mandou (áudio/foto). A Meta manda só o id no webhook:
  // são DOIS passos na Graph — o id devolve uma URL assinada de vida curta (~5 min) e a
  // URL devolve os bytes, e as duas chamadas precisam do Bearer. Nunca lança: falha vira
  // null e a Lia avisa que não entendeu, em vez de silêncio.
  // `LIA_MEDIA_MAX_BYTES` (12 MB) é o teto: transcrever um arquivo gigante estouraria o
  // turno antes de responder qualquer coisa.
  async downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!mediaId || !token) return null;
    const version = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v21.0";
    const timeout = Number(process.env.LIA_MEDIA_TIMEOUT_MS ?? 15000);
    const maxBytes = Number(process.env.LIA_MEDIA_MAX_BYTES ?? 12_000_000);
    try {
      const metaResponse = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
        cache: "no-store"
      });
      if (!metaResponse.ok) {
        console.warn("[whatsapp:meta:media-meta-failed]", metaResponse.status, await metaResponse.text().catch(() => ""));
        return null;
      }
      const info = (await metaResponse.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!info.url) return null;
      if (info.file_size && info.file_size > maxBytes) {
        console.warn("[whatsapp:meta:media-too-big]", info.file_size);
        return null;
      }
      // O download exige o MESMO Bearer: a URL assinada sozinha devolve 401.
      const fileResponse = await fetch(info.url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeout),
        cache: "no-store"
      });
      if (!fileResponse.ok) {
        console.warn("[whatsapp:meta:media-download-failed]", fileResponse.status);
        return null;
      }
      const bytes = new Uint8Array(await fileResponse.arrayBuffer());
      if (!bytes.length || bytes.length > maxBytes) {
        console.warn("[whatsapp:meta:media-size]", bytes.length);
        return null;
      }
      return { bytes, mimeType: info.mime_type ?? fileResponse.headers.get("content-type") ?? "application/octet-stream" };
    } catch (error) {
      console.warn("[whatsapp:meta:media-error]", error instanceof Error ? error.message : error);
      return null;
    }
  },

  // Botão "Enviar localização" junto do pedido de endereço (04/09): um toque no lugar de
  // digitar o CEP. O texto continua valendo — quem prefere digitar, digita.
  async sendLocationRequest(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppPhone(to),
      type: "interactive",
      interactive: { type: "location_request_message", body: { text: body.slice(0, 1024) }, action: { name: "send_location" } }
    });
  },

  // Mensagem de lista (até 10 linhas em uma mensagem só). Linha: título ≤ 24, descrição ≤ 72.
  async sendListMessage(to: string, input: WhatsAppListInput) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, buildListPayload(to, input));
  },

  // Flow (formulário dentro do chat): o id vem de LIA_FLOW_ADDRESS_ID depois de publicado
  // na Meta. `data` pré-preenche a tela (CEP/rua já conhecidos).
  async sendFlowMessage(to: string, input: WhatsAppFlowInput) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, buildFlowPayload(to, input));
  },

  async sendPlanBButtons(to: string, body: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, body, [
      { id: "planb_trocar", title: "Trocar" },
      { id: "planb_devolver", title: "Devolver o dinheiro" }
    ]);
  },

  async sendCartActions(to: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, "Quer ajustar antes de pagar?", [
      { id: "adicionar_mais", title: "Adicionar mais" },
      { id: "cancelar", title: "Cancelar pedido" }
    ]);
  },

  async sendAddressSetup(to: string, text: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") return null;
    return sendMetaSimpleButtons(to, text, [{ id: "cadastrar_endereco", title: "Cadastrar endereço" }]);
  },

  async sendInteractiveProductOptions(to: string, reply: WhatsAppRichReply) {
    if (!reply.options?.length) return null;
    if (process.env.WHATSAPP_PROVIDER === "meta") return sendMetaInteractiveProductOptions(to, reply);
    return null;
  },

  async sendRichReplyMessages(to: string, reply: WhatsAppRichReply) {
    return this.sendMessage(to, reply.text);
  },

  async sendTemplateMessage(to: string, input: WhatsAppTemplateInput, noticeId?: string) {
    if (process.env.WHATSAPP_PROVIDER !== "meta") {
      console.log("[whatsapp:mock:template]", { to, name: input.name, bodyParams: input.bodyParams });
      return { provider: "mock", to, template: input.name };
    }
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return sendMetaPayload(phoneNumberId, token, { ...buildTemplatePayload(to, input), ...(noticeId ? { biz_opaque_callback_data: noticeId } : {}) });
  }
};

async function sendMetaSimpleButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  footer?: string
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  return sendMetaPayload(phoneNumberId, token, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeWhatsAppPhone(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((button) => ({
          type: "reply",
          reply: { id: button.id.slice(0, 256), title: button.title.slice(0, 20) }
        }))
      }
    }
  });
}

// Formatos que a Meta aceita como imagem de card. WebP e AVIF NÃO entram: a Graph API
// aceita a mensagem e descarta o card DEPOIS, em silêncio (erro assíncrono 131053,
// "WebP image uploads are not currently supported" — caso real 16/08 com as fotos do
// Mercado Livre, que o CDN serve em .webp).
const META_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png"];
// Rótulo do botão do card interativo. A Meta corta em 20 caracteres e RECUSA a mensagem
// inteira se passar, então aqui fica a forma curta de "Adicionar ao carrinho" (21), que
// o carrossel usa por inteiro (teto 25). Pedido do dono, 15/09.
export const CARD_ADD_BUTTON = "Adicionar";

// Pré-flight da imagem do card (caso real 09/08: foto 404 no CDN; 16/08: foto WebP).
// Verifica DUAS coisas, porque só "a URL responde" não basta: status e CONTENT-TYPE.
// Só um 4xx definitivo (ou formato recusado) derruba a foto; timeout/erro de rede
// mantém (não punir CDN lento). O card degradado vai SEM header de imagem — produto,
// preço e botão sobrevivem, que é sempre melhor que card nenhum.
async function mediaLinkAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(Number(process.env.LIA_MEDIA_PREFLIGHT_TIMEOUT_MS ?? 1500)),
      cache: "no-store"
    });
    res.body?.cancel().catch(() => {});
    if (res.status >= 400 && res.status < 500) return false;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // Content-type ausente = CDN econômico; não dá pra provar que é ruim → mantém.
    if (contentType && !META_IMAGE_TYPES.includes(contentType)) {
      console.warn("[whatsapp:meta:image-format-rejected]", contentType, url.slice(0, 120));
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function sendMetaDeliveryChoices(to: string, options: WhatsAppDeliveryChoice[]) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }
  if (options.some((option) => !isPublicMediaUrl(option.imageUrl ?? ""))) {
    throw new Error("Refusing to send a WhatsApp product card without a deliverable image");
  }
  const imageAlive = await Promise.all(options.map((option) => mediaLinkAlive(safeMediaLink(option.imageUrl ?? ""))));

  const normalizedTo = normalizeWhatsAppPhone(to);
  const messages = [];
  // Each option is its own interactive card. The image header, product details and
  // reply button live in the SAME WhatsApp message, so there is no ambiguity about
  // which product "Adicionar" selects.
  for (const [index, option] of options.entries()) {
    const buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> = [
      { type: "reply", reply: { id: option.id.slice(0, 256), title: CARD_ADD_BUTTON } }
    ];
    // "Ver detalhes" quando o produto tem página real: o toque volta como
    // `optinfo:<sku>` e a Lia manda o link do anúncio (reviews, fotos, specs — tudo
    // que o cliente veria no ML/loja). Pedido do dono, 01/09.
    if (option.productUrl && option.sku) {
      buttons.push({ type: "reply", reply: { id: `optinfo:${option.sku}`.slice(0, 256), title: "Ver detalhes" } });
    }
    // O último card leva a saída "nenhuma dessas": o toque volta como o texto de
    // máquina `opt:outras` e cai no MESMO ramo do "mostra outras" digitado (paginação
    // sem repetir sku). Pedido do dono, 10/08. Teto Meta = 3 botões por card — com
    // "Ver detalhes" o último card fica exatamente no limite.
    if (index === options.length - 1) {
      buttons.push({ type: "reply", reply: { id: "opt:outras", title: "Outras opções" } });
    }
    const interactive: Record<string, unknown> = {
      type: "button",
      body: {
        text: [
          option.badge ? `⭐ ${option.badge}` : null,
          option.name,
          `*${formatBRL(option.displayPrice)}*`,
          option.delivery ? `Entrega: ${option.delivery}` : null
        ].filter(Boolean).join("\n").slice(0, 1024)
      },
      action: { buttons }
    };
    if (imageAlive[index]) {
      interactive.header = { type: "image", image: { link: safeMediaLink(option.imageUrl ?? "") } };
    }
    messages.push(await sendMetaPayload(phoneNumberId, token, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedTo,
      type: "interactive",
      interactive
    }));
  }
  return { provider: "meta", mode: "delivery_choice_cards", to, messages };
}

async function sendMetaMessage(to: string, text: string, noticeId?: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const response = await fetch(metaMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      ...(noticeId ? { biz_opaque_callback_data: noticeId } : {}),
      recipient_type: "individual",
      to: normalizeWhatsAppPhone(to),
      type: "text",
      text: {
        preview_url: false,
        body: text.slice(0, 4000)
      }
    }),
    signal: AbortSignal.timeout(10_000)
  });

  const payload = await response.json();
  if (!response.ok) {
    console.error("[whatsapp:meta:error]", payload);
    throw new Error(`Failed to send WhatsApp message (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return { provider: "meta", to, payload };
}

async function sendMetaInteractiveProductOptions(to: string, reply: WhatsAppRichReply) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const normalizedTo = normalizeWhatsAppPhone(to);
  const optionMessages = await Promise.all(
    (reply.options ?? []).slice(0, 3).map((option) =>
      sendMetaProductImageMessage(phoneNumberId, token, normalizedTo, option)
    )
  );
  const buttons = await sendMetaProductButtons(phoneNumberId, token, normalizedTo, reply);

  return {
    provider: "meta",
    mode: "interactive_buttons",
    to,
    optionMessages,
    buttons
  };
}

async function sendMetaProductImageMessage(
  phoneNumberId: string,
  token: string,
  to: string,
  option: WhatsAppProductOption
) {
  const total = option.product.price + option.product.shippingPrice;
  const caption = [
    `${option.rank}) ${option.product.title}`,
    `Total: R$ ${total.toFixed(2)}`,
    `Entrega: ${option.product.deliveryEstimate}`,
    option.product.source === "mercado_livre" && option.product.automationLevel.startsWith("real_")
      ? `Link: ${option.product.productUrl}`
      : null
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1024);

  if (!isPublicMediaUrl(option.product.imageUrl)) {
    return sendMetaMessage(to, caption);
  }

  return sendMetaPayload(phoneNumberId, token, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: {
      link: safeMediaLink(option.product.imageUrl),
      caption
    }
  });
}

async function sendMetaProductButtons(phoneNumberId: string, token: string, to: string, reply: WhatsAppRichReply) {
  const options = (reply.options ?? []).slice(0, 3);
  return sendMetaPayload(phoneNumberId, token, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "Escolha uma opção:".slice(0, 1024)
      },
      action: {
        buttons: options.map((option) => ({
          type: "reply",
          reply: {
            id: String(option.rank),
            title: String(option.rank)
          }
        }))
      }
    }
  });
}

async function sendMetaPayload(phoneNumberId: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(metaMessagesUrl(phoneNumberId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });

  const payload = await response.json();
  if (!response.ok) {
    console.error("[whatsapp:meta:error]", payload);
    throw new Error(`Failed to send WhatsApp message (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return payload;
}

async function sendMetaImage(to: string, text: string, mediaUrl: string) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return sendMetaMessage(to, text);
  try {
    return await sendMetaPayload(phoneNumberId, token, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppPhone(to),
      type: "image",
      image: { link: safeMediaLink(mediaUrl), caption: text.slice(0, 1024) }
    });
  } catch (error) {
    console.warn("[whatsapp:meta:media:fallback-text]", error instanceof Error ? error.message : error);
    return sendMetaMessage(to, text);
  }
}

// Hosts that block server-side fetches (Akamai/anti-bot) — WhatsApp can't load
// them, so we skip media and fall back to text (never ship a broken image). Petz
// self-hosts product photos behind Akamai: only a real browser that solved the JS sensor
// can fetch them, so their URLs 403 for Twilio (a retailer VTEX CDN is permissive and
// works). The Petz imageUrls stay in the catalog for the /ops dashboard and for a future
// re-host to a public CDN — once re-hosted, drop the host here. Override via
// LIA_MEDIA_BLOCK_HOSTS (comma-separated hostnames; empty string disables the blocklist).
const MEDIA_BLOCK_HOSTS = (process.env.LIA_MEDIA_BLOCK_HOSTS ?? "images.petz.com.br")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

// URLs de catálogo podem carregar caracteres fora do ASCII no path — caso real:
// "hastes-flexiveis-cotonetes®-150-unidades…" da Pague Menos. A Graph API ACEITA a
// mensagem (2xx) e o fetcher da Meta descarta o download depois, silenciosamente: o
// cliente vê o header "Achei essas opções" e nenhum card (produção, 07/08). Percent-
// encoda só quando há byte não-ASCII, para nunca re-encodar %XX legítimo já presente.
export function safeMediaLink(url: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(url) ? encodeURI(url) : url;
}

function formatBRL(value: number) {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function isPublicMediaUrl(url: string) {
  if (!/^https:\/\/.+/i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (MEDIA_BLOCK_HOSTS.some((blocked) => host === blocked || host.endsWith("." + blocked))) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function normalizeWhatsAppPhone(phone: string) {
  return phone.replace(/\D/g, "");
}

function stringFromPayload(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractNestedString(payload: RawInbound, path: string[]) {
  let cursor: unknown = payload;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}
