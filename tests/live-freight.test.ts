import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { liveStoreFreight } from "../src/lib/live-freight";

// Frete ao vivo: a validação da RESPOSTA é segurança de cobrança — preço vem em
// centavos, retirada nunca pode virar frete, "sem entrega" tem que virar rota pro
// operador e qualquer erro cai na tabela. Fetch mockado; o caminho real é auditado em
// produção pelo log [instant-quote:live] e pela nota "(ao vivo)" no /ops.

const realFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.LIA_LIVE_FREIGHT_OFF;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LIA_LIVE_FREIGHT_OFF;
  delete process.env.LIA_LIVE_FREIGHT_MAX;
});

function mockResponse(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const ITEMS = [{ sku: "paguemenos-1639750", qty: 2 }];

test("ao vivo: menor ENTREGA vence, retirada é ignorada, preço sai de centavos", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2 }],
    logisticsInfo: [
      {
        slas: [
          { name: "Retire em Loja", price: 0, pickupStoreInfo: { isPickupStore: true } },
          { name: "Expressa", price: 690, shippingEstimate: "2h" },
          { name: "Econômica", price: 490, shippingEstimate: "1bd" }
        ]
      }
    ]
  });
  const out = await liveStoreFreight("paguemenos", ITEMS, "01310-100");
  // 04/09: a Expressa (2h, +R$ 2,00) vira a alternativa `faster` — quem escolhe é o cliente.
  assert.deepEqual(out, { kind: "ok", fee: 4.9, estimate: "1bd", faster: { fee: 6.9, estimate: "2h", name: "Expressa" } });
});

test("ao vivo: resposta válida SEM entrega = site não atende o CEP (rota do operador)", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2 }],
    logisticsInfo: [{ slas: [{ name: "Retirar na Loja", price: 0, pickupStoreInfo: { isPickupStore: true } }] }]
  });
  assert.deepEqual(await liveStoreFreight("paguemenos", ITEMS, "01310100"), { kind: "no-delivery" });
});

test("ao vivo: sku fora do padrão, loja fora da lista, erro HTTP e exceção caem na tabela", async () => {
  mockResponse({ items: [{}], logisticsInfo: [] });
  assert.equal((await liveStoreFreight("paguemenos", [{ sku: "estranho-1", qty: 1 }], "01310100")).kind, "unavailable");
  assert.equal((await liveStoreFreight("carrefour", [{ sku: "CRF-PAD-007", qty: 1 }], "01310100")).kind, "unavailable");
  mockResponse({ error: "blocked" }, 403);
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
  globalThis.fetch = (async () => {
    throw new Error("timeout");
  }) as typeof fetch;
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
});

test("ao vivo: teto de sanidade e kill-switch", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2 }],
    logisticsInfo: [{ slas: [{ name: "Transportadora", price: 99000 }] }]
  });
  // R$990 estoura o teto (150 default) → tabela, não cobrança automática.
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
  process.env.LIA_LIVE_FREIGHT_OFF = "true";
  globalThis.fetch = (async () => {
    throw new Error("não era pra chamar rede");
  }) as typeof fetch;
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
});

// ---- cesta com VÁRIOS itens (achado da revisão 11/08) ----
// O código antigo achatava os SLAs de todos os itens e pegava o mais barato: uma cesta
// de N itens era cobrada pelo frete de UM. Frete no VTEX é por item (um logisticsInfo
// por item), então o do carrinho é a SOMA.

const TWO_ITEMS = [
  { sku: "paguemenos-1639750", qty: 1 },
  { sku: "paguemenos-1639751", qty: 2 }
];

test("ao vivo: cesta com 2 itens soma o frete dos DOIS (não cobra só o mais barato)", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 1, availability: "available" }, { id: "1639751", quantity: 2, availability: "available" }],
    logisticsInfo: [
      { slas: [{ name: "Econômica", price: 490, shippingEstimate: "1bd" }] },
      { slas: [{ name: "Expressa", price: 690, shippingEstimate: "3bd" }] }
    ]
  });
  const out = await liveStoreFreight("paguemenos", TWO_ITEMS, "01310-100");
  // 4,90 + 6,90 — o antigo devolvia 4,90 e a Lia cobraria R$2 a menos que a loja.
  assert.deepEqual(out, { kind: "ok", fee: 11.8, estimate: "3bd" });
});

test("ao vivo: item indisponível na loja não vira frete de tabela — vai pro operador", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 1, availability: "available" }, { id: "1639751", quantity: 2, availability: "withoutStock" }],
    logisticsInfo: [{ slas: [{ name: "Econômica", price: 490 }] }, { slas: [{ name: "Econômica", price: 490 }] }]
  });
  assert.deepEqual(await liveStoreFreight("paguemenos", TWO_ITEMS, "01310100"), { kind: "item-unavailable" });
});

test("ao vivo: um item SEM entrega derruba a cesta inteira (não dá pra entregar em partes)", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 1 }, { id: "1639751", quantity: 2 }],
    logisticsInfo: [
      { slas: [{ name: "Econômica", price: 490 }] },
      { slas: [{ name: "Retire em Loja", price: 0, pickupStoreInfo: { isPickupStore: true } }] }
    ]
  });
  assert.deepEqual(await liveStoreFreight("paguemenos", TWO_ITEMS, "01310100"), { kind: "no-delivery" });
});

test("ao vivo: resposta que não cobre a cesta inteira cai na tabela (nunca frete parcial)", async () => {
  mockResponse({ items: [{ id: "1639750", quantity: 1 }], logisticsInfo: [{ slas: [{ name: "Econômica", price: 490 }] }] });
  assert.equal((await liveStoreFreight("paguemenos", TWO_ITEMS, "01310100")).kind, "unavailable");
});

test("ao vivo: SLA sem preço não é frete grátis — é dado faltando", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2 }],
    logisticsInfo: [{ slas: [{ name: "Normal", shippingEstimate: "2bd" }] }]
  });
  // Sem preço não há entrega cobrável: cai pro operador em vez de virar R$ 0,00.
  assert.deepEqual(await liveStoreFreight("paguemenos", ITEMS, "01310100"), { kind: "no-delivery" });
  // Já `price: 0` explícito é frete grátis de verdade.
  mockResponse({ items: [{ id: "1639750", quantity: 2 }], logisticsInfo: [{ slas: [{ name: "Grátis", price: 0, shippingEstimate: "3bd" }] }] });
  assert.deepEqual(await liveStoreFreight("paguemenos", ITEMS, "01310100"), { kind: "ok", fee: 0, estimate: "3bd" });
});

test("ao vivo: eco com id trocado, quantidade errada ou item repetido cai na tabela", async () => {
  // Contar linhas não basta (2ª revisão): a resposta tem que ser a NOSSA cesta.
  mockResponse({ items: [{ id: "9999999", quantity: 2 }], logisticsInfo: [{ slas: [{ name: "Econômica", price: 490 }] }] });
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
  mockResponse({ items: [{ id: "1639750", quantity: 7 }], logisticsInfo: [{ slas: [{ name: "Econômica", price: 490 }] }] });
  assert.equal((await liveStoreFreight("paguemenos", ITEMS, "01310100")).kind, "unavailable");
  mockResponse({
    items: [{ id: "1639750", quantity: 1 }, { id: "1639750", quantity: 1 }],
    logisticsInfo: [{ slas: [{ name: "Econômica", price: 490 }] }, { slas: [{ name: "Econômica", price: 490 }] }]
  });
  assert.equal((await liveStoreFreight("paguemenos", TWO_ITEMS, "01310100")).kind, "unavailable");
  // itemIndex repetido/fora da faixa = resposta malformada.
  mockResponse({
    items: [{ id: "1639750", quantity: 1 }, { id: "1639751", quantity: 2 }],
    logisticsInfo: [{ itemIndex: 0, slas: [{ name: "Econômica", price: 490 }] }, { itemIndex: 0, slas: [{ name: "Econômica", price: 690 }] }]
  });
  assert.equal((await liveStoreFreight("paguemenos", TWO_ITEMS, "01310100")).kind, "unavailable");
});

// ---- disponibilidade por item para um CEP (03/09) ----
import { humanEstimate, liveItemAvailability } from "../src/lib/live-freight";

test("por item: withoutStock e sem SLA de entrega viram indisponível; disponível traz frete e prazo", async () => {
  mockResponse({
    items: [
      { id: "165908", quantity: 1, availability: "withoutStock" },
      { id: "155042", quantity: 1, availability: "available" },
      { id: "999", quantity: 1, availability: "available" }
    ],
    logisticsInfo: [
      { itemIndex: 0, slas: [] },
      { itemIndex: 1, slas: [{ name: "Normal", price: 990, shippingEstimate: "1bd" }, { name: "Retire em Loja", price: 0, pickupStoreInfo: { isPickupStore: true } }] },
      { itemIndex: 2, slas: [{ name: "Retire em Loja", price: 0, pickupStoreInfo: { isPickupStore: true } }] }
    ]
  });
  const result = await liveItemAvailability("naturaldaterra", ["naturaldaterra-165908", "naturaldaterra-155042", "naturaldaterra-999"], "01229-000");
  assert.ok(result);
  assert.equal(result!.get("naturaldaterra-165908")?.available, false, "sem estoque");
  const ok = result!.get("naturaldaterra-155042");
  assert.equal(ok?.available, true);
  assert.equal(ok?.fee, 9.9);
  assert.equal(ok?.estimate, "1bd");
  assert.equal(ok?.etaMinutes, 24 * 60);
  assert.equal(result!.get("naturaldaterra-999")?.available, false, "só retirada = não entrega no CEP");
});

test("por item: loja fora da simulação, sku fora do padrão ou erro de rede → null (desconhecido, nunca 'indisponível')", async () => {
  mockResponse({}, 500);
  assert.equal(await liveItemAvailability("naturaldaterra", ["naturaldaterra-1"], "01229-000"), null);
  assert.equal(await liveItemAvailability("petz", ["PETZ-1"], "01229-000"), null);
  assert.equal(await liveItemAvailability("naturaldaterra", ["xyz"], "01229-000"), null);
  process.env.LIA_LIVE_FREIGHT_OFF = "true";
  assert.equal(await liveItemAvailability("naturaldaterra", ["naturaldaterra-1"], "01229-000"), null);
});

test("prazo humano só a partir do formato da loja", () => {
  assert.equal(humanEstimate("1bd"), "prazo da loja: 1 dia útil");
  assert.equal(humanEstimate("3bd"), "prazo da loja: 3 dias úteis");
  assert.equal(humanEstimate("2h"), "prazo da loja: 2h");
  assert.equal(humanEstimate("45m"), "prazo da loja: 45 min");
  assert.equal(humanEstimate("2d"), "prazo da loja: 2 dias");
  assert.equal(humanEstimate("0bd"), "prazo da loja: hoje");
  assert.equal(humanEstimate("amanhã"), undefined);
  assert.equal(humanEstimate(undefined), undefined);
});

// ---- entrega mais rápida da loja (04/09: "tem que dar a opção de super expressa") ----
test("ao vivo: loja com SUPER EXPRESSA devolve `faster` (mais rápida, extra dentro do teto); sem opção mais rápida, nada", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2, availability: "available" }],
    logisticsInfo: [
      {
        slas: [
          { name: "RETIRE NA LOJA", price: 0, shippingEstimate: "30m", pickupStoreInfo: { isPickupStore: true } },
          { name: "NORMAL", price: 690, shippingEstimate: "1bd" },
          { name: "SUPER EXPRESSA", price: 890, shippingEstimate: "60m" },
          { name: "EXPRESSA", price: 890, shippingEstimate: "6h" },
          { name: "SEDEX", price: 994, shippingEstimate: "5bd" }
        ]
      }
    ]
  });
  const out = await liveStoreFreight("paguemenos", ITEMS, "01229-000");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.fee, 6.9);
  assert.equal(out.estimate, "1bd");
  assert.deepEqual(out.faster, { fee: 8.9, estimate: "60m", name: "SUPER EXPRESSA" });

  // Extra acima do teto: sem oferta.
  process.env.LIA_FAST_FREIGHT_MAX_EXTRA = "1";
  const capped = await liveStoreFreight("paguemenos", ITEMS, "01229-000");
  delete process.env.LIA_FAST_FREIGHT_MAX_EXTRA;
  assert.equal(capped.kind === "ok" && capped.faster, undefined);

  // Só uma opção de entrega: nada de faster.
  mockResponse({ items: [{ id: "1639750", quantity: 2 }], logisticsInfo: [{ slas: [{ name: "NORMAL", price: 690, shippingEstimate: "1bd" }] }] });
  const single = await liveStoreFreight("paguemenos", ITEMS, "01229-000");
  assert.equal(single.kind === "ok" && single.faster, undefined);
});

test("cotação: entrega agendada custa SLA + janela e o prazo vai até o fim da janela mais cedo", async () => {
  const { effectiveSla } = await import("../src/lib/live-freight");
  const now = new Date("2026-09-25T20:30:00Z");
  const sla = { name: "Entrega Agendada", price: 1290, shippingEstimate: "2h", availableDeliveryWindows: [
    { startDateUtc: "2026-09-26T11:00:00+00:00", endDateUtc: "2026-09-26T14:00:59+00:00", price: 300 },
    { startDateUtc: "2026-09-26T10:00:00+00:00", endDateUtc: "2026-09-26T13:00:59+00:00", price: 300 },
  ] };
  const eff = effectiveSla(sla, now);
  assert.equal(eff.price, 1590);
  assert.match(eff.shippingEstimate!, /^17h@2026-09-26T10:00:00\+00:00~/);
  const { estimateMinutes, humanEstimate, promisedMinutes } = await import("../src/lib/live-freight");
  assert.equal(estimateMinutes(eff.shippingEstimate), 17 * 60);
  const text = humanEstimate(eff.shippingEstimate)!;
  assert.match(text, /^prazo da loja: em até 17h \((sáb|amanhã|hoje), 7h–10h\)$/);
  assert.equal(promisedMinutes(`pela própria loja · ${text}`), 17 * 60, "a promessa guardada compara pelo prazo, não pelo horário da janela");
  assert.equal(eff.deliveryWindow?.startDateUtc, "2026-09-26T10:00:00+00:00");
  assert.equal(effectiveSla({ ...sla, availableDeliveryWindows: [{ startDateUtc: "2026-09-25T10:00:00Z", endDateUtc: "2026-09-25T13:00:00Z", price: 300 }] }, now).price, undefined, "só janelas passadas: sem entrega");
  assert.equal(effectiveSla({ name: "Normal", price: 690, shippingEstimate: "1bd" }, now).price, 690, "SLA sem janela não muda");
});

test("ao vivo: devolve o preço que a loja cobra AGORA (sellingPrice em centavos, por unidade)", async () => {
  mockResponse({
    items: [{ id: "1639750", quantity: 2, sellingPrice: 1299 }],
    logisticsInfo: [{ slas: [{ name: "Econômica", price: 490, shippingEstimate: "1bd" }] }]
  });
  const out = await liveStoreFreight("paguemenos", ITEMS, "01310-100");
  assert.equal(out.kind, "ok");
  assert.deepEqual(out.kind === "ok" ? out.unitPrices : null, { "paguemenos-1639750": 12.99 });
});
