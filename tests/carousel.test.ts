// Carrossel da vitrine (dono, 07/09): template de marketing com 2–3 cards, conteúdo
// variável, botão "Adicionar ao carrinho" voltando como optsku:<sku>. Fallback pros cards soltos
// quando não dá (desligado, 1 opção, foto ruim, template recusado pela Meta).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAROUSEL_CARD_COUNTS, CAROUSEL_TEMPLATE_PREFIX, CAROUSEL_V4_PREFIX, CAROUSEL_V5_PREFIX, buildCarouselTemplate, carouselTemplateName } from "../src/lib/meta-setup";
import { CAROUSEL_CARD_MAX_LINE_BREAKS } from "../src/lib/meta-carousel-card";
import { buildCarouselPayload, whatsappAdapter } from "../src/lib/adapters/whatsapp";

const FIVE = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `optsku:s${i}`, sku: `s${i}`, name: `Relógio ${i + 1}`, displayPrice: 10 * (i + 1), imageUrl: `https://example.com/${i}.jpg` }));
const OPTIONS = [
  { id: "optsku:petz-1", sku: "petz-1", name: "Ração Golden Adulto 15kg", displayPrice: 189.9, imageUrl: "https://example.com/a.jpg", delivery: "prazo da loja: 1 dia útil" },
  { id: "optsku:ml-2", sku: "ml-2", name: "Ração Premier Adulto 15kg\nRaças médias", displayPrice: 210, imageUrl: "https://example.com/b.jpg", badge: "Você já pediu este" },
  { id: "optsku:cobasi-3", sku: "cobasi-3", name: "Ração Royal Canin 15kg", displayPrice: 320.5, imageUrl: "https://example.com/c.jpg", delivery: "prazo da loja: 2 dias" }
];

// Todo prefixo que o cron cria passa pelas mesmas regras (06/10: o card do v4 tinha 3 quebras
// de linha e a Meta recusou os 8 templates v4/v5 a cada hora — este teste só montava o v3).
test("template do carrossel respeita os limites da Meta (2 a 5 cards, v3/v4/v5)", () => {
  assert.deepEqual([...CAROUSEL_CARD_COUNTS], [2, 3, 4, 5]);
  for (const prefix of [CAROUSEL_TEMPLATE_PREFIX, CAROUSEL_V4_PREFIX, CAROUSEL_V5_PREFIX]) {
    for (const cards of CAROUSEL_CARD_COUNTS) {
      const t = buildCarouselTemplate(cards, "4::handle", prefix) as any;
      assert.equal(t.name, carouselTemplateName(cards, prefix));
      assert.equal(t.category, "marketing");
      assert.equal(t.language, "pt_BR");
      const body = t.components[0];
      assert.ok(body.text.length <= 1024);
      for (const text of [body.text, t.components[1].cards[0].components[1].text]) {
        assert.doesNotMatch(text, /\{\{\d+\}\}\s*$/, `não pode terminar em variável: ${text}`);
        assert.doesNotMatch(text, /^\s*\{\{\d+\}\}/, `não pode começar com variável: ${text}`);
      }
      // v5: corpo fixo, sem variável e sem exemplo.
      assert.equal((body.example?.body_text?.[0] ?? []).length, (body.text.match(/\{\{\d+\}\}/g) ?? []).length);
      const carousel = t.components[1];
      assert.equal(carousel.cards.length, cards);
      const first = JSON.stringify(carousel.cards[0]);
      for (const card of carousel.cards) {
        assert.equal(JSON.stringify(card), first, "todos os cards têm os mesmos componentes");
        const cardBody = card.components.find((c: any) => c.type === "body");
        assert.ok(cardBody.text.length <= 160);
        const breaks = (cardBody.text.match(/\n/g) ?? []).length;
        assert.ok(breaks <= CAROUSEL_CARD_MAX_LINE_BREAKS, `${t.name}: ${breaks} quebras de linha no card`);
        assert.equal(cardBody.example.body_text[0].length, 3);
        const buttons = card.components.find((c: any) => c.type === "buttons").buttons;
        assert.ok(buttons.length <= 2);
        for (const b of buttons) assert.ok(b.text.length <= 25, b.text);
        assert.deepEqual(buttons.map((b: any) => b.text), ["Adicionar ao carrinho", "Outras opções"]);
        assert.equal(card.components.find((c: any) => c.type === "header").format, "image");
      }
    }
  }
});

test("payload do envio: header por link, 3 variáveis por card e botões com sku", () => {
  const p = buildCarouselPayload("+5511999999999", "vitrine_carrossel_v3_3", "Opções de *ração*:", OPTIONS) as any;
  assert.equal(p.type, "template");
  assert.equal(p.template.name, "vitrine_carrossel_v3_3");
  assert.equal(p.template.components[0].parameters[0].text, "Opções de *ração*:");
  const cards = p.template.components[1].cards;
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c: any) => c.card_index), [0, 1, 2]);
  assert.equal(cards[0].components[0].parameters[0].image.link, "https://example.com/a.jpg");
  const body = cards[1].components[1].parameters.map((x: any) => x.text);
  assert.equal(body.length, 3);
  assert.match(body[0], /⭐ Você já pediu este · Ração Premier/);
  assert.doesNotMatch(body[0], /\n/, "parâmetro de template não aceita quebra de linha");
  assert.equal(body[1], "R$ 210,00");
  assert.equal(body[2], "confirmo na cotação");
  assert.equal(cards[2].components[1].parameters[2].text, "2 dias");
  assert.equal(cards[0].components[2].parameters[0].payload, "optsku:petz-1");
  for (const card of cards) assert.equal(card.components[3].parameters[0].payload, "opt:outras");
});

async function withMeta(fn: (bodies: any[], fail?: { current: boolean }) => Promise<void>) {
  const previous = { provider: process.env.WHATSAPP_PROVIDER, token: process.env.WHATSAPP_ACCESS_TOKEN, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID, carousel: process.env.LIA_CAROUSEL, fetch: global.fetch };
  const bodies: any[] = [];
  const fail = { current: false };
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
  process.env.LIA_CAROUSEL = "true";
  global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
    bodies.push(JSON.parse(String(init.body)));
    if (fail.current) return new Response(JSON.stringify({ error: { message: "Template name does not exist" } }), { status: 400 });
    return new Response(JSON.stringify({ messages: [{ id: `m${bodies.length}` }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await fn(bodies, fail);
  } finally {
    process.env.WHATSAPP_PROVIDER = previous.provider;
    process.env.WHATSAPP_ACCESS_TOKEN = previous.token;
    process.env.WHATSAPP_PHONE_NUMBER_ID = previous.phoneId;
    if (previous.carousel === undefined) delete process.env.LIA_CAROUSEL;
    else process.env.LIA_CAROUSEL = previous.carousel;
    global.fetch = previous.fetch;
  }
}

test("Meta: 2 opções viram UMA mensagem de template vitrine_carrossel_v3_2", async () => {
  await withMeta(async (bodies) => {
    const result = await whatsappAdapter.sendDeliveryCarousel("+5511999999999", "Opções de *ração*:", OPTIONS.slice(0, 2));
    assert.equal(result?.mode, "delivery_choice_carousel");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].template.name, "vitrine_carrossel_v3_2");
    assert.equal(bodies[0].template.components[1].cards.length, 2);
  });
});

test("Meta: 5 opções viram vitrine_carrossel_v3_5 com 5 cards; 6 cortam em 5; fallback solto fica em 3", async () => {
  await withMeta(async (bodies) => {
    const five = await whatsappAdapter.sendDeliveryCarousel("+5511999999999", "Opções:", FIVE(6));
    assert.equal(five?.mode, "delivery_choice_carousel");
    assert.equal(bodies[0].template.name, "vitrine_carrossel_v3_5");
    assert.equal(bodies[0].template.components[1].cards.length, 5);
    const before = bodies.length;
    await whatsappAdapter.sendDeliveryChoices("+5511999999999", FIVE(5));
    assert.equal(bodies.length - before, 3, "cards soltos: no máximo 3 mensagens");
  });
});

test("Meta: 1 opção, desligado ou template recusado → null (cai nos cards soltos)", async () => {
  await withMeta(async (bodies, fail) => {
    assert.equal(await whatsappAdapter.sendDeliveryCarousel("+5511999999999", "x", OPTIONS.slice(0, 1)), null);
    process.env.LIA_CAROUSEL = "false";
    assert.equal(await whatsappAdapter.sendDeliveryCarousel("+5511999999999", "x", OPTIONS), null);
    process.env.LIA_CAROUSEL = "true";
    fail!.current = true;
    assert.equal(await whatsappAdapter.sendDeliveryCarousel("+5511999999999", "x", OPTIONS), null);
    assert.equal(bodies.length, 1, "só a tentativa recusada foi ao Graph");
  });
});

// Caso real 08/09: a Meta aceitou o carrossel e descartou depois (131042). O wamid gravado
// permite reenviar os cards soltos quando o status "failed" chega no webhook.
test("falha assíncrona do carrossel → cards soltos pelo wamid (idempotente)", async (t) => {
  await import("./helpers/load-env");
  const { prisma } = await import("../src/lib/prisma");
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return t.skip();
  }
  const { recoverFailedCarousel } = await import("../src/lib/delivery-service");
  const phone = `+5503${String(Date.now()).slice(-9)}`;
  const user = await prisma.user.create({ data: { phone } });
  const convo = await prisma.conversation.create({ data: { userId: user.id, status: "active" } });
  const pending = { query: "relógio barato", qty: 1, options: [
    { sku: "ml-1", name: "Relógio Digital Esportivo", unitPrice: 39.9, imageUrl: "https://example.com/1.jpg", storeKey: "mercadolivre", storeLabel: "Mercado Livre" },
    { sku: "ml-2", name: "Relógio Casio Clássico", unitPrice: 89.9, imageUrl: "https://example.com/2.jpg", storeKey: "mercadolivre", storeLabel: "Mercado Livre" }
  ] };
  await prisma.message.create({ data: { conversationId: convo.id, sender: "carousel", metadata: "wamid.TEST1", text: JSON.stringify({ header: "Opções de *relógio barato*:", pending }) } });
  const adapters = await import("../src/lib/adapters/whatsapp");
  const sent: string[] = [];
  const prev = { sendMessage: adapters.whatsappAdapter.sendMessage, sendDeliveryChoices: adapters.whatsappAdapter.sendDeliveryChoices };
  (adapters.whatsappAdapter as any).sendMessage = async (_to: string, text: string) => { sent.push(`text:${text}`); return {}; };
  (adapters.whatsappAdapter as any).sendDeliveryChoices = async (_to: string, options: any[]) => { sent.push(`cards:${options.map((o) => o.id).join(",")}`); return { mode: "delivery_choice_cards" }; };
  try {
    assert.equal(await recoverFailedCarousel("wamid.NAO_EXISTE", phone.slice(1)), false);
    assert.equal(await recoverFailedCarousel("wamid.TEST1", phone.slice(1), "131042 Business eligibility payment issue"), true);
    assert.deepEqual(sent, ["text:Opções de *relógio barato*:", "cards:optsku:ml-1,optsku:ml-2"]);
    assert.equal(await recoverFailedCarousel("wamid.TEST1", phone.slice(1)), false, "segundo status failed não reenvia");
  } finally {
    (adapters.whatsappAdapter as any).sendMessage = prev.sendMessage;
    (adapters.whatsappAdapter as any).sendDeliveryChoices = prev.sendDeliveryChoices;
    await prisma.message.deleteMany({ where: { conversationId: convo.id } });
    await prisma.conversation.delete({ where: { id: convo.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});

test("v5 (05/10): corpo fixo 'Olha o que achei 👇' — template sem variável e envio sem parâmetro de corpo", async () => {
  const { buildCarouselTemplate, CAROUSEL_V5_PREFIX } = await import("../src/lib/meta-setup");
  const template = buildCarouselTemplate(3, "handle", CAROUSEL_V5_PREFIX) as any;
  assert.equal(template.name, "vitrine_carrossel_v5_3");
  assert.deepEqual(template.components[0], { type: "body", text: "Olha o que achei 👇" });
  assert.match(template.components[1].cards[0].components[1].text, /Toque abaixo para adicionar/, "card igual ao v4");
  const p = buildCarouselPayload("+5511999999999", "vitrine_carrossel_v5_3", "Opções de *ração*:", OPTIONS) as any;
  assert.equal(p.template.components.length, 1, "só o carrossel");
  assert.equal(p.template.components[0].type, "carousel");
});
