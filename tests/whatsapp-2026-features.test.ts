// Recursos do WhatsApp ligados em 04/09: "digitando…", botão de localização, lista,
// Flow de endereço e boas-vindas. Payloads exatos da Cloud API + parsing do webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFlowPayload, buildListPayload, whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { flowAddressToText, locationToText } from "../src/lib/reverse-geocode";

function withMetaFetch(run: (bodies: Record<string, any>[]) => Promise<void>) {
  return async () => {
    const previous = { provider: process.env.WHATSAPP_PROVIDER, token: process.env.WHATSAPP_ACCESS_TOKEN, phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID, fetch: global.fetch };
    const bodies: Record<string, any>[] = [];
    process.env.WHATSAPP_PROVIDER = "meta";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-id";
    global.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await run(bodies);
    } finally {
      process.env.WHATSAPP_PROVIDER = previous.provider;
      process.env.WHATSAPP_ACCESS_TOKEN = previous.token;
      process.env.WHATSAPP_PHONE_NUMBER_ID = previous.phoneId;
      global.fetch = previous.fetch;
    }
  };
}

test("digitando: marca como lida e liga o indicador; desligável por env; nunca lança", withMetaFetch(async (bodies) => {
  await whatsappAdapter.markReadWithTyping("wamid.in");
  assert.deepEqual(bodies[0], { messaging_product: "whatsapp", status: "read", message_id: "wamid.in", typing_indicator: { type: "text" } });
  process.env.LIA_TYPING_OFF = "true";
  try {
    assert.equal(await whatsappAdapter.markReadWithTyping("wamid.in"), null);
  } finally {
    delete process.env.LIA_TYPING_OFF;
  }
  assert.equal(bodies.length, 1);
  assert.equal(await whatsappAdapter.markReadWithTyping(undefined), null);
}));

test("botão de localização: interactive location_request_message", withMetaFetch(async (bodies) => {
  await whatsappAdapter.sendLocationRequest("+55 11 99999-9999", "Me manda seu CEP?");
  assert.equal(bodies[0].to, "5511999999999");
  assert.equal(bodies[0].interactive.type, "location_request_message");
  assert.equal(bodies[0].interactive.action.name, "send_location");
  assert.equal(bodies[0].interactive.body.text, "Me manda seu CEP?");
}));

test("lista: no máximo 10 linhas, títulos cortados em 24 e descrições em 72", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Opção ${i} com um título bem comprido mesmo`, description: "x".repeat(100) }));
  const payload = buildListPayload("5511999999999", { body: "Escolha", buttonText: "Ver opções bem longas mesmo", sections: [{ title: "Seção", rows }] }) as any;
  assert.equal(payload.interactive.type, "list");
  assert.equal(payload.interactive.action.button.length, 20);
  assert.equal(payload.interactive.action.sections[0].rows.length, 10);
  assert.equal(payload.interactive.action.sections[0].rows[0].title.length, 24);
  assert.equal(payload.interactive.action.sections[0].rows[0].description.length, 72);
});

test("quantidade vira lista 1..6 + Outra (ids qty:N que o fluxo já entende)", withMetaFetch(async (bodies) => {
  await whatsappAdapter.sendQuantityChoices("5511999999999", "Arroz Camil 1kg");
  const rows = bodies[0].interactive.action.sections[0].rows;
  assert.deepEqual(rows.map((r: any) => r.id), ["qty:1", "qty:2", "qty:3", "qty:4", "qty:5", "qty:6", "qty:other"]);
  assert.match(bodies[0].interactive.body.text, /Quantas unidades de \*Arroz Camil 1kg\*\?/);
}));

test("flow: interactive flow com navigate, tela e dados pré-preenchidos", () => {
  const payload = buildFlowPayload("5511999999999", { body: "Confere seu endereço", cta: "Preencher endereço", flowId: "123", screen: "ADDRESS", data: { cep: "01229-000", rua: "Rua X" }, token: "tok" }) as any;
  assert.equal(payload.interactive.type, "flow");
  const p = payload.interactive.action.parameters;
  assert.equal(p.flow_message_version, "3");
  assert.equal(p.flow_id, "123");
  assert.equal(p.flow_action, "navigate");
  assert.deepEqual(p.flow_action_payload, { screen: "ADDRESS", data: { cep: "01229-000", rua: "Rua X" } });
  assert.equal(p.flow_cta, "Preencher endereço");
});

test("flow: data aceita JSON (array, objeto, booleano) sem tocar nos chamadores de string", () => {
  const data = { lista_id: "lst-1", faltas_visible: true, opts_1: [{ id: "a", title: "Vodka", image: "QUJD" }] };
  const payload = buildFlowPayload("5511999999999", { body: "Sua lista", cta: "Escolher minha lista", flowId: "9", screen: "LISTA", data, token: "lst-1" }) as any;
  assert.deepEqual(payload.interactive.action.parameters.flow_action_payload, { screen: "LISTA", data });
  assert.equal(payload.interactive.action.parameters.flow_token, "lst-1");
  assert.deepEqual(JSON.parse(JSON.stringify(payload)).interactive.action.parameters.flow_action_payload.data.opts_1, data.opts_1);
});

test("webhook: localização, boas-vindas e resposta de flow são reconhecidas", () => {
  const loc = whatsappAdapter.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: "5511999999999", id: "wamid.l", type: "location", location: { latitude: -23.55, longitude: -46.63, address: "Av. Paulista, 1000" } }] } }] }] });
  assert.deepEqual(loc.location, { latitude: -23.55, longitude: -46.63, address: "Av. Paulista, 1000", name: undefined });
  assert.equal(loc.text, "");
  const welcome = whatsappAdapter.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: "5511999999999", id: "wamid.w", type: "request_welcome" }] } }] }] });
  assert.equal(welcome.messageType, "request_welcome");
  const flow = whatsappAdapter.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: "5511999999999", id: "wamid.f", type: "interactive", interactive: { nfm_reply: { name: "flow", body: "Sent", response_json: JSON.stringify({ cep: "01229000", rua: "Rua das Flores", numero: "123", complemento: "ap 4", bairro: "Bela Vista", cidade: "São Paulo" }) } } }] } }] }] });
  assert.equal(flow.flowResponse?.numero, "123");
  assert.equal(flowAddressToText(flow.flowResponse!), "Rua das Flores, 123, ap 4, Bela Vista, São Paulo, CEP 01229-000");
  assert.equal(flowAddressToText({ rua: "X" }), null, "sem número/CEP não vira endereço");
});

test("localização → texto: só com CEP de 8 dígitos", () => {
  assert.equal(locationToText({ cep: "01229-000", street: "Rua X" }), "01229-000");
  assert.equal(locationToText({ street: "Rua X" }), null);
  assert.equal(locationToText(null), null);
});
