import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { rerankShoppingOptions, type RerankLine } from "../src/lib/adapters/ai";

// O rerank por IA decide QUAIS candidatos aparecem pro cliente — então a validação da
// resposta é de segurança: sku inventado nunca pode passar, resposta desalinhada nunca
// pode ser aplicada e qualquer falha vira null (o chamador cai no determinístico).
// Aqui o fetch é mockado; a qualidade da decisão real é medida por scripts/eval-search.mts.

const LINES: RerankLine[] = [
  {
    query: "carregador usb c",
    candidates: [
      { sku: "PM-1", name: "Carregador De Parede Usb-C 20w", price: 98.9, store: "Pague Menos" },
      { sku: "PETZ-1", name: "Carregador Veicular 2 USB Branco", price: 49.4, store: "Petz" },
      { sku: "PETZ-2", name: "Carregador Veicular 2 USB Preto", price: 49.4, store: "Petz" }
    ]
  },
  {
    query: "coca cola 2 litros",
    candidates: [{ sku: "CRF-1", name: "Refrigerante Coca Cola 2L", price: 10.9, store: "Carrefour" }]
  }
];

const realFetch = globalThis.fetch;
let envBackup: string | undefined;

beforeEach(() => {
  envBackup = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.LIA_SEARCH_RERANK_OFF;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (envBackup === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = envBackup;
  delete process.env.LIA_SEARCH_RERANK_OFF;
});

function mockResponse(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ output_text: JSON.stringify(body) }), { status: 200 })) as typeof fetch;
}

test("rerank: aplica a ordem da IA e preserva lista vazia (nenhum serve)", async () => {
  mockResponse({ lines: [{ skus: ["PM-1"] }, { skus: [] }] });
  const out = await rerankShoppingOptions("carregador usb c e coca 2l", LINES);
  assert.deepEqual(out, { lines: [{ skus: ["PM-1"] }, { skus: [] }] });
});

test("rerank: sku inventado/duplicado é filtrado; corte em 3", async () => {
  mockResponse({ lines: [{ skus: ["FAKE-9", "PM-1", "PM-1", "PETZ-1", "PETZ-2", "PETZ-2"] }, { skus: ["CRF-1"] }] });
  const out = await rerankShoppingOptions("qualquer", LINES);
  assert.deepEqual(out?.lines[0].skus, ["PM-1", "PETZ-1", "PETZ-2"]);
});

// Vitrine do carrossel (dono, 28/09): "se tem 5, mostra as 5; se não tem, mostra as que
// tem". A IA só julga (o que serve + ordem); o código monta: todos os aprovados, produtos
// distintos primeiro, variantes (sabor/tamanho) depois, até o teto do chamador.
test("rerank: todos os aprovados entram, distintos antes das variantes, até o teto", async () => {
  const coco: RerankLine[] = [
    {
      query: "água de coco",
      candidates: [
        { sku: "K-200", name: "Água de Coco Kero Coco 200ml", brand: "Kero Coco", price: 4, store: "Mambo" },
        { sku: "K-1L", name: "Água de Coco Kero Coco 1L", brand: "Kero Coco", price: 11, store: "Mambo" },
        { sku: "MEL", name: "Água de Coco Sococo Sabor Melancia 200ml", brand: "Sococo", price: 3, store: "Drogal" },
        { sku: "MAMBO", name: "Água de Coco Momento Mambo 1L", brand: "Mambo", price: 10, store: "Mambo" },
        { sku: "OBRIGADO", name: "Água de Coco Obrigado 1L", brand: "Obrigado", price: 12, store: "Swift" },
        { sku: "PURITY", name: "Água de Coco Puraty 330ml", brand: "Puraty", price: 7, store: "Swift" },
        { sku: "TONICA", name: "Água Tônica Schweppes 350ml", brand: "Schweppes", price: 3, store: "Swift" }
      ]
    }
  ];
  mockResponse({ lines: [{ skus: ["K-200", "K-1L", "MEL", "MAMBO", "OBRIGADO", "PURITY"] }] });
  const five = await rerankShoppingOptions("água de coco", coco, 5);
  // O Kero de 1L (variante de tamanho) cede a vaga pros distintos; sabor conta como
  // produto distinto; a tônica (reprovada pela IA) nunca entra.
  assert.deepEqual(five?.lines[0].skus, ["K-200", "MEL", "MAMBO", "OBRIGADO", "PURITY"]);

  mockResponse({ lines: [{ skus: ["K-200", "K-1L", "MEL"] }] });
  const few = await rerankShoppingOptions("água de coco", coco, 5);
  // Menos distintos que vagas: a variante completa — mas só o que a IA aprovou.
  assert.deepEqual(few?.lines[0].skus, ["K-200", "MEL", "K-1L"]);
});

test("rerank: resposta com nº de linhas errado é descartada inteira (null)", async () => {
  mockResponse({ lines: [{ skus: ["PM-1"] }] });
  assert.equal(await rerankShoppingOptions("qualquer", LINES), null);
});

test("rerank: kill-switch e chave ausente desligam sem chamar rede", async () => {
  globalThis.fetch = (async () => {
    throw new Error("não era pra chamar fetch");
  }) as typeof fetch;
  process.env.LIA_SEARCH_RERANK_OFF = "true";
  assert.equal(await rerankShoppingOptions("qualquer", LINES), null);
  delete process.env.LIA_SEARCH_RERANK_OFF;
  process.env.OPENAI_API_KEY = "";
  assert.equal(await rerankShoppingOptions("qualquer", LINES), null);
});

test("rerank: erro de rede vira null (fallback determinístico)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  assert.equal(await rerankShoppingOptions("qualquer", LINES), null);
});

test("rerank: sem candidatos em nenhuma linha nem chama a IA", async () => {
  globalThis.fetch = (async () => {
    throw new Error("não era pra chamar fetch");
  }) as typeof fetch;
  assert.equal(await rerankShoppingOptions("qualquer", [{ query: "x", candidates: [] }]), null);
});
