// Configuração do número da Lia na Meta via Graph API (04/09/2026): perfil comercial,
// boas-vindas + perguntas sugeridas ("ice breakers") e o Flow de endereço. Roda DENTRO
// da Vercel (rota /api/ops/meta-setup, protegida pela sessão do /ops) porque o token da
// Meta é sensível e não sai da Vercel. Cada ação é idempotente: repetir só regrava.
import { readFile } from "node:fs/promises";
import { CAROUSEL_CARD_BODY, carouselCardBodyFor } from "./meta-carousel-card";
import path from "node:path";

const GRAPH = "https://graph.facebook.com/v22.0";

export const META_PROFILE = {
  messaging_product: "whatsapp",
  about: "Compras do dia a dia pelo WhatsApp",
  description:
    "Lia é sua concierge de compras: peça qualquer item por mensagem, veja opções reais com preço e prazo, pague por Pix ou cartão aqui mesmo, e a loja entrega na sua casa.",
  email: "contato@liadelivery.com.br",
  websites: ["https://liadelivery.com.br"],
  vertical: "RETAIL"
};

// Até 4 perguntas sugeridas, ≤ 80 caracteres cada. Aparecem quando alguém abre o chat
// pela primeira vez; o toque chega como mensagem de texto normal.
export const META_PROMPTS = ["Quero um chá", "Ração pro meu cachorro", "Papel higiênico e sabão", "Um presente da Boticário"];

// Flow de endereço: CEP/rua/bairro/cidade pré-preenchidos (ViaCEP); o cliente completa
// número e complemento com validação. Terminal: o "complete" volta como nfm_reply.
export const ADDRESS_FLOW_JSON = {
  version: "7.0",
  screens: [
    {
      id: "ADDRESS",
      title: "Endereço de entrega",
      terminal: true,
      data: {
        cep: { type: "string", __example__: "01229-000" },
        rua: { type: "string", __example__: "Rua das Flores" },
        bairro: { type: "string", __example__: "Bela Vista" },
        cidade: { type: "string", __example__: "São Paulo" }
      },
      layout: {
        type: "SingleColumnLayout",
        children: [
          // O que já sabemos pelo CEP aparece como texto (TextInput não aceita valor
          // inicial na Meta — 2º publish falhou por isso); o cliente só digita o que falta.
          { type: "TextSubheading", text: "Confira seu endereço" },
          { type: "TextBody", text: "${data.rua}" },
          { type: "TextCaption", text: "${data.bairro}" },
          { type: "TextCaption", text: "${data.cidade}" },
          { type: "TextCaption", text: "${data.cep}" },
          {
            type: "Form",
            name: "form",
            children: [
              { type: "TextInput", name: "numero", label: "Número", required: true, "input-type": "number" },
              { type: "TextInput", name: "complemento", label: "Complemento", required: false },
              {
                type: "Footer",
                label: "Confirmar endereço",
                "on-click-action": {
                  name: "complete",
                  payload: {
                    cep: "${data.cep}",
                    rua: "${data.rua}",
                    bairro: "${data.bairro}",
                    cidade: "${data.cidade}",
                    numero: "${form.numero}",
                    complemento: "${form.complemento}"
                  }
                }
              }
            ]
          }
        ]
      }
    }
  ]
};

// Carrossel da vitrine (dono, 07/09: "eu quero fazer carrossel"). Na Meta, carrossel só
// existe como TEMPLATE de MARKETING (não há carrossel livre na janela de 24h): cada envio
// é cobrado (~R$0,33 no Brasil) e o número de cards é FIXO por template — por isso um
// template por tamanho (2 e 3 cards; 1 opção continua no card simples). O texto do card
// e o payload do botão são variáveis: nome, preço, prazo e `optsku:<sku>` entram na hora
// do envio; a foto vem por link. O toque em "Adicionar ao carrinho" volta como `button.payload`,
// que o parseInbound já lê. Limites: body do card ≤ 160, botão ≤ 25, corpo ≤ 1024, e o
// corpo não pode terminar em variável.
// v2 (07/09, dono: "precisa ter o botão outras opções"): 2 botões por card e iguais em
// todos → "Adicionar ao carrinho" + "Outras opções"; a página do produto fica por texto
// ("detalhes 2"). Nome novo porque template editado volta pra revisão.
export const CAROUSEL_TEMPLATE_PREFIX = process.env.LIA_CAROUSEL_TEMPLATE?.trim() || "vitrine_carrossel_v3";
// v3 (15/09, dono): o botão do card virou "Adicionar ao carrinho" (21 chars — cabe no
// carrossel, teto 25). O card interativo do fallback tem teto 20 e usa "Adicionar"
// (CARD_ADD_BUTTON em adapters/whatsapp.ts). Texto de botão é parte do template, então
// mudança = template novo (nome novo; editar aprovado volta pra revisão do mesmo jeito).
export const CAROUSEL_ADD_BUTTON = "Adicionar ao carrinho";
export const CAROUSEL_CARD_COUNTS = [2, 3, 4, 5] as const;
// Variável não pode abrir nem fechar o texto (2ª recusa da Meta, 07/09).
export const CAROUSEL_BODY = "Olha o que achei 👇 {{1}} Desliza pros lados e toca em *Adicionar ao carrinho* no card que preferir. Pra ver a página de um produto, escreva *detalhes* e o número dele.";
// O texto do card e o ajuste dos parâmetros ao limite de 160 hidratados vivem num módulo
// folha, porque `adapters/whatsapp` precisa do mesmo texto para caber nele (15/09).
export { CAROUSEL_CARD_BODY } from "./meta-carousel-card";
export const CAROUSEL_BUTTONS = [
  { type: "quick_reply", text: CAROUSEL_ADD_BUTTON },
  { type: "quick_reply", text: "Outras opções" }
] as const;

// v4 (28/09): card sem "(contado da compra)". Criado sozinho pelo cron /api/cron/meta-templates;
// o envio usa v4 só quando a Meta aprovar o template daquele número de cards.
export const CAROUSEL_V4_PREFIX = "vitrine_carrossel_v4";

export function carouselTemplateName(cards: number, prefix = CAROUSEL_TEMPLATE_PREFIX): string {
  return `${prefix}_${cards}`;
}

export function buildCarouselTemplate(cards: number, headerHandle: string, prefix = CAROUSEL_TEMPLATE_PREFIX) {
  const card = {
    components: [
      { type: "header", format: "image", example: { header_handle: [headerHandle] } },
      { type: "body", text: carouselCardBodyFor(prefix), example: { body_text: [["Ração Golden Adulto 15kg", "R$ 189,90", "1 dia útil"]] } },
      { type: "buttons", buttons: CAROUSEL_BUTTONS.map((b) => ({ ...b })) }
    ]
  };
  return {
    name: carouselTemplateName(cards, prefix),
    language: "pt_BR",
    category: "marketing",
    components: [
      { type: "body", text: CAROUSEL_BODY, example: { body_text: [["Opções de *ração pra cachorro*:"]] } },
      { type: "carousel", cards: Array.from({ length: cards }, () => JSON.parse(JSON.stringify(card))) }
    ]
  };
}

function creds() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error("WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID não configurados");
  return { token, phoneId };
}

async function graph(token: string, pathname: string, init: RequestInit & { raw?: boolean } = {}) {
  const res = await fetch(`${GRAPH}/${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !init.raw ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${JSON.stringify(json).slice(0, 600)}`);
  return json as Record<string, unknown>;
}

async function ids(token: string) {
  const dbg = (await graph(token, `debug_token?input_token=${encodeURIComponent(token)}`)) as {
    data?: { app_id?: string; granular_scopes?: Array<{ scope: string; target_ids?: string[] }> };
  };
  const appId = dbg.data?.app_id;
  // Tokens permanentes de System User podem ter a permissão correta sem expor
  // `target_ids` no debug_token. Nesse caso usamos o WABA explícito do número.
  const waba =
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ||
    dbg.data?.granular_scopes?.find((s) => s.scope === "whatsapp_business_management")?.target_ids?.[0];
  return { appId, waba };
}

export type MetaSetupAction = "status" | "name" | "register" | "profile" | "picture" | "welcome" | "flow" | "flow_update" | "flow_errors" | "carousel" | "templates" | "carousel_test";

// Estado real do display name (25/09): o WhatsApp Manager só mostrava "In Review" e o
// suporte da Meta não respondia. Campo a campo porque alguns são beta e um campo
// desconhecido derruba a leitura inteira com #100.
async function nameStatus(token: string, phoneId: string) {
  const fields = ["display_phone_number", "verified_name", "name_status", "new_name_status", "new_display_name", "messaging_limit_tier", "quality_rating", "status", "platform_type"];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const res = await graph(token, `${phoneId}?fields=${field}`).catch((e) => ({ [field]: `erro: ${String(e).slice(0, 200)}` }));
    out[field] = (res as Record<string, unknown>)[field] ?? null;
  }
  return out;
}

// Erros de validação de um Flow (a Meta cria o rascunho mesmo inválido e recusa publicar).
async function flowErrors(token: string, flowId: string) {
  return graph(token, `${flowId}?fields=id,name,status,validation_errors`);
}

// Atualiza o JSON de um Flow existente (multipart, asset FLOW_JSON) e tenta publicar.
async function flowUpdateAndPublish(token: string, flowId: string) {
  const form = new FormData();
  form.append("name", "flow.json");
  form.append("asset_type", "FLOW_JSON");
  form.append("file", new Blob([JSON.stringify(ADDRESS_FLOW_JSON)], { type: "application/json" }), "flow.json");
  const updated = await graph(token, `${flowId}/assets`, { method: "POST", raw: true, body: form });
  const errors = await flowErrors(token, flowId);
  const list = (errors as { validation_errors?: unknown[] }).validation_errors ?? [];
  if (list.length) return { updated, published: false, validation_errors: list };
  const published = await graph(token, `${flowId}/publish`, { method: "POST" });
  return { updated, published, status: await flowErrors(token, flowId) };
}

// Upload resumable da imagem da marca → handle usável em perfil e em exemplo de template.
async function uploadBrandImage(token: string): Promise<string> {
  const { appId } = await ids(token);
  if (!appId) throw new Error("app_id não veio do debug_token");
  const file = path.join(process.cwd(), "public/brand/lia-whatsapp-profile-hd.png");
  const bytes = await readFile(file);
  const session = (await graph(token, `${appId}/uploads?file_length=${bytes.length}&file_type=image/png`, { method: "POST" })) as { id: string };
  const upload = (await graph(token, session.id, {
    method: "POST",
    raw: true,
    headers: { file_offset: "0", "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bytes)
  })) as { h: string };
  return upload.h;
}

export async function runMetaSetup(action: MetaSetupAction, opts: { flowId?: string; pin?: string } = {}): Promise<Record<string, unknown>> {
  const { token, phoneId } = creds();
  if (action === "name") return nameStatus(token, phoneId);
  if (action === "register") {
    // Aplica um display name APROVADO (Cloud API exige re-registro em até 14 dias).
    // PIN = verificação em duas etapas do número; nunca vai pra log nem pra env.
    const pin = (opts.pin ?? "").trim();
    if (!/^\d{6}$/.test(pin)) throw new Error("pin de 6 dígitos obrigatório");
    const registered = await graph(token, `${phoneId}/register`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", pin }) });
    return { registered, name: await nameStatus(token, phoneId) };
  }
  if (action === "flow_errors" || action === "flow_update") {
    const flowId = (opts.flowId ?? process.env.LIA_FLOW_ADDRESS_ID ?? "").trim();
    if (!/^\d{6,}$/.test(flowId)) throw new Error("flow_id ausente (?flow_id=<id do Flow>)");
    return action === "flow_errors" ? flowErrors(token, flowId) : flowUpdateAndPublish(token, flowId);
  }
  if (action === "status") {
    const profile = await graph(token, `${phoneId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`);
    // Leitura é como CAMPO do número (o POST é na sub-rota; o GET na sub-rota dá "#100
    // nonexisting field" — visto em 04/09).
    const automation = await graph(token, `${phoneId}?fields=conversational_automation`).catch((e) => ({ error: String(e).slice(0, 300) }));
    const { appId, waba } = await ids(token);
    let flows: unknown = null;
    if (waba) flows = await graph(token, `${waba}/flows?fields=id,name,status`).catch((e) => ({ error: String(e).slice(0, 300) }));
    return { profile, automation, hasAppId: Boolean(appId), hasWaba: Boolean(waba), flows, flowEnv: process.env.LIA_FLOW_ADDRESS_ID ?? null };
  }
  if (action === "profile") {
    return graph(token, `${phoneId}/whatsapp_business_profile`, { method: "POST", body: JSON.stringify(META_PROFILE) });
  }
  if (action === "picture") {
    const handle = await uploadBrandImage(token);
    return graph(token, `${phoneId}/whatsapp_business_profile`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", profile_picture_handle: handle })
    });
  }
  if (action === "carousel_test") {
    // Manda um carrossel de amostra pro telefone do operador (prova real de entrega: a
    // Graph aceita e o webhook diz se a Meta descartou — 08/09, erro 131042).
    const to = process.env.LIA_OPERATOR_PHONE?.trim();
    if (!to) throw new Error("LIA_OPERATOR_PHONE não configurado");
    const { whatsappAdapter } = await import("@/lib/adapters/whatsapp");
    const image = "https://liadelivery.com.br/brand/lia-whatsapp-profile-hd.png";
    const sent = await whatsappAdapter.sendDeliveryCarousel(to, "Teste do carrossel — opções de *relógio barato*:", [
      { id: "optsku:teste-1", sku: "teste-1", name: "Relógio Digital Esportivo (amostra)", displayPrice: 39.9, imageUrl: image, delivery: "prazo da loja: 2 dias úteis" },
      { id: "optsku:teste-2", sku: "teste-2", name: "Relógio Clássico Pulseira de Couro (amostra)", displayPrice: 89.9, imageUrl: image, delivery: "prazo da loja: 1 dia útil" }
    ]);
    return { sent: Boolean(sent), messageId: sent?.messageId ?? null, enabled: process.env.LIA_CAROUSEL === "true" };
  }
  if (action === "templates") {
    const { waba } = await ids(token);
    if (!waba) throw new Error("WABA id não veio do debug_token");
    const names = CAROUSEL_CARD_COUNTS.map((n) => carouselTemplateName(n));
    const list = (await graph(token, `${waba}/message_templates?fields=name,status,category,rejected_reason,quality_score&limit=100`)) as { data?: Array<{ name: string }> };
    return { carousel: (list.data ?? []).filter((t) => names.includes(t.name)), expected: names, enabled: process.env.LIA_CAROUSEL === "true" };
  }
  if (action === "carousel") {
    const { waba } = await ids(token);
    if (!waba) throw new Error("WABA id não veio do debug_token");
    // A imagem de exemplo do header é só para a revisão da Meta; na hora do envio cada
    // card recebe a foto do produto por link.
    const handle = await uploadBrandImage(token);
    const results: Record<string, unknown> = {};
    for (const cards of CAROUSEL_CARD_COUNTS) {
      const body = buildCarouselTemplate(cards, handle);
      results[body.name] = await graph(token, `${waba}/message_templates`, { method: "POST", body: JSON.stringify(body) }).catch((e) => ({ error: String(e).slice(0, 600) }));
    }
    return results;
  }
  if (action === "welcome") {
    return graph(token, `${phoneId}/conversational_automation`, {
      method: "POST",
      body: JSON.stringify({ enable_welcome_message: true, prompts: META_PROMPTS })
    });
  }
  if (action === "flow") {
    const { waba } = await ids(token);
    if (!waba) throw new Error("WABA id não veio do debug_token");
    try {
      return await graph(token, `${waba}/flows`, {
        method: "POST",
        body: JSON.stringify({
          name: `endereco_entrega_${Date.now().toString(36)}`,
          categories: ["OTHER"],
          flow_json: JSON.stringify(ADDRESS_FLOW_JSON),
          publish: true
        })
      });
    } catch (error) {
      // "Flow was created, but publishing failed": devolve os erros de validação do
      // rascunho que ficou, em vez de deixar o operador sem saber o quê consertar.
      const message = error instanceof Error ? error.message : String(error);
      const created = message.match(/Flow ID: (\d+)/)?.[1];
      if (!created) throw error;
      return { created_id: created, published: false, ...(await flowErrors(token, created)) };
    }
  }
  throw new Error(`ação desconhecida: ${String(action)}`);
}


// ---------- Carrossel v4 automático (28/09) ----------
// Cron: cria na Meta os templates v4 que faltam (uma vez) e devolve o status de cada um.
export async function ensureCarouselV4(): Promise<Record<string, string>> {
  const { token } = creds();
  const { waba } = await ids(token);
  if (!waba) throw new Error("WABA id não veio do debug_token");
  const names = CAROUSEL_CARD_COUNTS.map((n) => carouselTemplateName(n, CAROUSEL_V4_PREFIX));
  const list = (await graph(token, `${waba}/message_templates?fields=name,status,rejected_reason&limit=200`)) as { data?: Array<{ name: string; status: string; rejected_reason?: string }> };
  const existing = new Map((list.data ?? []).filter((t) => names.includes(t.name)).map((t) => [t.name, t.rejected_reason && t.rejected_reason !== "NONE" ? `${t.status}:${t.rejected_reason}` : t.status]));
  const missing = CAROUSEL_CARD_COUNTS.filter((n) => !existing.has(carouselTemplateName(n, CAROUSEL_V4_PREFIX)));
  if (missing.length) {
    const handle = await uploadBrandImage(token);
    for (const cards of missing) {
      const body = buildCarouselTemplate(cards, handle, CAROUSEL_V4_PREFIX);
      const created = await graph(token, `${waba}/message_templates`, { method: "POST", body: JSON.stringify(body) }).catch((e) => ({ error: String(e).slice(0, 300) }));
      existing.set(body.name, (created as { status?: string; error?: string }).status ?? `ERRO ${(created as { error?: string }).error ?? ""}`);
    }
  }
  return Object.fromEntries(existing);
}

// Envio: prefixo do template a usar para N cards. LIA_CAROUSEL_TEMPLATE força um prefixo;
// senão v4 se APROVADO na Meta (consulta com cache de 10 min por instância), senão v3.
const approvedCache: { at: number; approved: Set<string> } = { at: 0, approved: new Set() };
export async function activeCarouselPrefix(cards: number): Promise<string> {
  if (process.env.LIA_CAROUSEL_TEMPLATE?.trim()) return CAROUSEL_TEMPLATE_PREFIX;
  if (Date.now() - approvedCache.at > 10 * 60_000) {
    try {
      const { token } = creds();
      const { waba } = await ids(token);
      if (waba) {
        const list = (await graph(token, `${waba}/message_templates?fields=name,status&limit=200`)) as { data?: Array<{ name: string; status: string }> };
        approvedCache.approved = new Set((list.data ?? []).filter((t) => t.status === "APPROVED" && t.name.startsWith(CAROUSEL_V4_PREFIX)).map((t) => t.name));
      }
    } catch (error) {
      console.warn("[meta:carousel-prefix]", error instanceof Error ? error.message : error);
    }
    approvedCache.at = Date.now();
  }
  return approvedCache.approved.has(carouselTemplateName(cards, CAROUSEL_V4_PREFIX)) ? CAROUSEL_V4_PREFIX : CAROUSEL_TEMPLATE_PREFIX;
}
