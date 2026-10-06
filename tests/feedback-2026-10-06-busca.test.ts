// Retorno do teste adversarial de 06/10 (busca, quantidade e frete). Cada caso aqui falhava
// no código anterior; os nomes citam o código do achado no relatório (M2, A3, A8…).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { liveStoreFreight, pickCartSla } from "../src/lib/live-freight";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Body = { items: { id: string; quantity: number }[] };
function mockSimulation(respond: (body: Body, call: number) => unknown) {
  let call = 0;
  const calls: Body[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    calls.push(body);
    return new Response(JSON.stringify(respond(body, call++)), { status: 200 });
  }) as typeof fetch;
  return calls;
}
const dock = [{ warehouseId: "1_5093", dockId: "2_5093", courierId: "5093_9" }];
const agendada = (price: number) => ({ id: "Entrega agendada", name: "Entrega agendada", price, shippingEstimate: "5h", deliveryIds: dock });
const umDia = (price: number) => ({ id: "Receba em 1 dia útil", name: "Receba em 1 dia útil", price, shippingEstimate: "1bd", deliveryIds: dock });
const ARROZ_FEIJAO = [{ sku: "swift-7694", qty: 1 }, { sku: "swift-7695", qty: 1 }];

// ---------- M2: frete dobrado na mesma loja ----------
test("M2: arroz + feijão Swift com rateio normal = UM frete (8,89 + 9,01 = 17,90)", async () => {
  mockSimulation(() => ({
    items: [{ id: "7694", quantity: 1, availability: "available" }, { id: "7695", quantity: 1, availability: "available" }],
    logisticsInfo: [{ itemIndex: 0, slas: [agendada(889)] }, { itemIndex: 1, slas: [agendada(901), umDia(800)] }]
  }));
  const out = await liveStoreFreight("swift", ARROZ_FEIJAO, "01233020");
  assert.equal(out.kind, "ok");
  // Antes: arroz na agendada (8,89) + feijão no "1 dia útil" (8,00) = duas entregas.
  assert.equal(out.kind === "ok" && out.fee, 17.9);
});

test("M2: resposta SEM rateio (17,90 em cada linha, mesmo armazém) vira um frete só, conferido com o item sozinho", async () => {
  const calls = mockSimulation((body) =>
    body.items.length === 1
      ? { items: [{ id: body.items[0].id, quantity: 1, availability: "available" }], logisticsInfo: [{ itemIndex: 0, slas: [agendada(1790)] }] }
      : {
          items: [{ id: "7694", quantity: 1, availability: "available" }, { id: "7695", quantity: 1, availability: "available" }],
          logisticsInfo: [{ itemIndex: 0, slas: [agendada(1790)] }, { itemIndex: 1, slas: [agendada(1790), umDia(1590)] }]
        }
  );
  const out = await liveStoreFreight("swift", ARROZ_FEIJAO, "01233020");
  assert.equal(out.kind === "ok" && out.fee, 17.9, "era R$ 35,80 (16,90+17,90 ou 17,90+17,90)");
  assert.equal(calls.length, 2, "uma simulação extra, só porque a resposta era ambígua");
});

test("M2: rateio IGUAL de verdade (dois itens de mesmo valor, Pacheco 345 + 345) continua somado", async () => {
  const normal = (price: number) => ({ id: "NORMAL", name: "NORMAL", price, shippingEstimate: "1bd" });
  mockSimulation((body) =>
    body.items.length === 1
      ? { items: [{ id: body.items[0].id, quantity: 1, availability: "available" }], logisticsInfo: [{ itemIndex: 0, slas: [normal(690)] }] }
      : {
          items: [{ id: "1", quantity: 1, availability: "available" }, { id: "2", quantity: 1, availability: "available" }],
          logisticsInfo: [{ itemIndex: 0, slas: [normal(345)] }, { itemIndex: 1, slas: [normal(345)] }]
        }
  );
  const out = await liveStoreFreight("drogariaspacheco", [{ sku: "drogariaspacheco-1", qty: 1 }, { sku: "drogariaspacheco-2", qty: 1 }], "01233020");
  assert.equal(out.kind === "ok" && out.fee, 6.9);
});

test("M2 (puro): sem SLA em comum, cada linha na sua e o frete soma (duas entregas de verdade)", () => {
  const pick = pickCartSla(
    [
      { sku: "a", slas: [{ id: "X", price: 490, shippingEstimate: "1bd" }] },
      { sku: "b", slas: [{ id: "Y", price: 690, shippingEstimate: "3bd" }] }
    ],
    (a, b) => a.fee < b.fee
  );
  assert.equal(pick?.fee, 1180);
  assert.equal(pick?.estimate, "3bd");
});
