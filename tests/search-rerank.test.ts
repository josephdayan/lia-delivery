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
  mockResponse({ lines: [{ exigencias: ["usb c"], aprovados: ["PM-1"], proximos: [] }, { exigencias: [], aprovados: [], proximos: [] }] });
  const out = await rerankShoppingOptions("carregador usb c e coca 2l", LINES);
  assert.deepEqual(out, {
    lines: [
      { skus: ["PM-1"], exigencias: ["usb c"], proximos: [] },
      { skus: [], exigencias: [], proximos: [] }
    ]
  });
});

test("rerank: sku inventado/duplicado é filtrado; corte em 3", async () => {
  mockResponse({ lines: [{ exigencias: [], aprovados: ["FAKE-9", "PM-1", "PM-1", "PETZ-1", "PETZ-2", "PETZ-2"], proximos: [] }, { exigencias: [], aprovados: ["CRF-1"], proximos: [] }] });
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
  mockResponse({ lines: [{ exigencias: [], aprovados: ["K-200", "K-1L", "MEL", "MAMBO", "OBRIGADO", "PURITY"], proximos: [] }] });
  const five = await rerankShoppingOptions("água de coco", coco, 5);
  // O Kero de 1L (variante de tamanho) cede a vaga pros distintos; sabor conta como
  // produto distinto; a tônica (reprovada pela IA) nunca entra.
  assert.deepEqual(five?.lines[0].skus, ["K-200", "MEL", "MAMBO", "OBRIGADO", "PURITY"]);

  mockResponse({ lines: [{ exigencias: [], aprovados: ["K-200", "K-1L", "MEL"], proximos: [] }] });
  const few = await rerankShoppingOptions("água de coco", coco, 5);
  // Menos distintos que vagas: a variante completa — mas só o que a IA aprovou.
  assert.deepEqual(few?.lines[0].skus, ["K-200", "MEL", "K-1L"]);
});

test("rerank: resposta com nº de linhas errado é descartada inteira (null)", async () => {
  mockResponse({ lines: [{ exigencias: [], aprovados: ["PM-1"], proximos: [] }] });
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

// Fase 3 (07/10): a IA julga cada candidato contra o que o cliente DISSE e devolve, à parte, o
// que é do tipo certo mas falha numa exigência ("o mais perto que tenho…"). O código só valida.
const KERASYS: RerankLine[] = [
  {
    query: "shampoo kerasys coco 1L",
    candidates: [
      { sku: "K-500", name: "Shampoo Kerasys Coco 500ml", brand: "Kerasys", price: 30, store: "Época" },
      { sku: "K-250", name: "Shampoo Kerasys Coco 250ml", brand: "Kerasys", price: 20, store: "Época" },
      { sku: "K-DANO", name: "Shampoo Kerasys Dano Severo 1L", brand: "Kerasys", price: 50, store: "Época" },
      { sku: "OUTRO", name: "Shampoo Seda Coco 1L", brand: "Seda", price: 15, store: "Mambo" }
    ]
  }
];

test("rerank: sem aprovados, devolve os 'mais próximos' validados (sku real, sem repetir, com a diferença)", async () => {
  mockResponse({
    lines: [
      {
        exigencias: ["marca Kerasys", "sabor coco", "1 L"],
        aprovados: [],
        proximos: [
          { sku: "K-500", falta: "é de 500 ml." },
          { sku: "FAKE", falta: "inventado" },
          { sku: "K-500", falta: "repetido" },
          { sku: "K-250", falta: "é de 250 ml" },
          { sku: "K-DANO", falta: "  " }
        ]
      }
    ]
  });
  const out = await rerankShoppingOptions("shampoo kerasys coco 1L", KERASYS);
  assert.deepEqual(out?.lines[0].skus, []);
  assert.deepEqual(out?.lines[0].exigencias, ["marca Kerasys", "sabor coco", "1 L"]);
  assert.deepEqual(out?.lines[0].proximos, [
    { sku: "K-500", falta: "é de 500 ml" },
    { sku: "K-250", falta: "é de 250 ml" }
  ]);
});

test("rerank: com aprovados, 'proximos' é descartado (não existe 'mais perto' quando o pedido foi atendido)", async () => {
  mockResponse({ lines: [{ exigencias: ["1 L"], aprovados: ["OUTRO"], proximos: [{ sku: "K-500", falta: "é de 500 ml" }] }] });
  const out = await rerankShoppingOptions("shampoo coco 1L", KERASYS);
  assert.deepEqual(out?.lines[0].skus, ["OUTRO"]);
  assert.deepEqual(out?.lines[0].proximos, []);
});

test("rerank: o pedido à IA manda o esquema por candidato e o prompt não cita produto específico", async () => {
  let body = "";
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ output_text: JSON.stringify({ lines: [{ exigencias: [], aprovados: [], proximos: [] }] }) }), { status: 200 });
  }) as typeof fetch;
  await rerankShoppingOptions("x", KERASYS);
  const parsed = JSON.parse(body) as { input: { content: string }[]; text: { format: { schema: { properties: { lines: { items: { required: string[] } } } } } } };
  assert.deepEqual(parsed.text.format.schema.properties.lines.items.required, ["exigencias", "aprovados", "exatos", "maisBarato", "proximos"]);
  const system = parsed.input[0].content;
  assert.match(system, /exigencias/);
  assert.match(system, /TIPO/);
  assert.match(system, /EXIGÊNCIAS/);
  // Princípio do projeto: nada de regra por produto/marca no juízo (os exemplos são ilustração de classe).
  assert.doesNotMatch(system, /kerasys|nude|havaianas|golden/i);
});

// Exato antes de variante (08/10, placar r4): a IA marca quais aprovados são o básico pedido; eles abrem a
// vitrine mesmo que a IA tenha listado uma variante primeiro. Sku "exato" fora dos aprovados é ignorado.
const BISCOITO: RerankLine[] = [
  {
    query: "bolacha maizena",
    candidates: [
      { sku: "CHOCO", name: "Biscoito Integral Maizena Choco Bis 80g", price: 6, store: "Mambo" },
      { sku: "MAIZENA", name: "Biscoito de Maizena Bauducco 170g", price: 5, store: "Mambo" },
      { sku: "OUTRO", name: "Biscoito Maizena Piraquê 175g", price: 5.5, store: "Swift" }
    ]
  }
];
test("rerank: exatos abrem a vitrine e só UMA variante depois; exato que não foi aprovado não entra", async () => {
  mockResponse({ lines: [{ exigencias: [], aprovados: ["CHOCO", "MAIZENA", "OUTRO"], exatos: ["MAIZENA", "OUTRO", "FANTASMA"], proximos: [] }] });
  const out = await rerankShoppingOptions("bolacha maizena", BISCOITO);
  assert.deepEqual(out?.lines[0].skus, ["MAIZENA", "OUTRO", "CHOCO"]);
  // O conjunto segue para a vitrine, que ordena exato antes do prazo de entrega.
  assert.deepEqual(out?.lines[0].exatos, ["MAIZENA", "OUTRO"]);
  // Um exato e duas variantes aprovadas: o exato e só a 1ª variante.
  const TRES: RerankLine[] = [{ query: "filé de tilápia", candidates: [
    { sku: "EMP", name: "Filé de Tilápia Empanado 500g", price: 30, store: "Swift" },
    { sku: "FILE", name: "Filé de Tilápia 400g", price: 35, store: "Swift" },
    { sku: "INF", name: "Filé de Tilápia Croc Infantil 300g", price: 25, store: "Mambo" }
  ] }];
  mockResponse({ lines: [{ exigencias: [], aprovados: ["EMP", "FILE", "INF"], exatos: ["FILE"], proximos: [] }] });
  const one = await rerankShoppingOptions("filé de tilápia", TRES);
  assert.deepEqual(one?.lines[0].skus, ["FILE", "EMP"]);
  // Sem "exatos" (resposta antiga), a ordem continua a da IA.
  mockResponse({ lines: [{ exigencias: [], aprovados: ["CHOCO", "MAIZENA"], proximos: [] }] });
  const old = await rerankShoppingOptions("bolacha maizena", BISCOITO);
  assert.deepEqual(old?.lines[0].skus.slice(0, 1), ["CHOCO"]);
});

// Preferência explícita de preço ("a mais barata"): quem decide que foi pedida é a IA (lê a
// mensagem); a ORDEM é do código — mais barato primeiro entre os aprovados, sem diversificar.
const PAPEL: RerankLine[] = [
  {
    query: "papel higiênico",
    candidates: [
      { sku: "P-CARO", name: "Papel Higiênico Neve Folha Tripla 12un", price: 32, store: "Mambo" },
      { sku: "P-MEIO", name: "Papel Higiênico Personal Folha Dupla 8un", price: 18, store: "Swift" },
      { sku: "P-BARATO", name: "Papel Higiênico Mili Folha Simples 4un", price: 7.5, store: "Drogal" },
      { sku: "P-LIXA", name: "Lixa de Parede", price: 3, store: "Obramax" }
    ]
  }
];

test("rerank: 'a mais barata' pedida → aprovados saem do mais barato ao mais caro", async () => {
  mockResponse({ lines: [{ exigencias: [], aprovados: ["P-CARO", "P-MEIO", "P-BARATO"], maisBarato: true, proximos: [] }] });
  const out = await rerankShoppingOptions("papel higiênico, a mais barata", PAPEL, 5);
  assert.deepEqual(out?.lines[0].skus, ["P-BARATO", "P-MEIO", "P-CARO"]);
  assert.equal(out?.lines[0].maisBarato, true);
});

test("rerank: sem preferência de preço, a ordem da IA (com diversificação) é mantida", async () => {
  mockResponse({ lines: [{ exigencias: [], aprovados: ["P-CARO", "P-MEIO", "P-BARATO"], maisBarato: false, proximos: [] }] });
  const out = await rerankShoppingOptions("papel higiênico", PAPEL, 5);
  assert.equal(out?.lines[0].skus[0], "P-CARO");
  assert.equal(out?.lines[0].maisBarato, undefined);
});
