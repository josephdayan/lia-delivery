// Flow "Escolher minha lista": montagem do `data` (limites da Meta, vagas, skip, orçamento de
// imagem, overflow) e leitura da resposta. Puro, sem banco nem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIST_FLOW_IMAGE_BUDGET,
  LIST_FLOW_MAX_OPTIONS,
  LIST_FLOW_MAX_SLOTS,
  buildListFlowData,
  isListFlowReply,
  parseListFlowReply,
  shortOptionTitle,
  type ListFlowSlotInput
} from "../src/lib/list-flow";
import { LIST_FLOW_CTA, LIST_FLOW_JSON } from "../src/lib/meta-setup";
import { createServer } from "node:http";
import sharp from "sharp";
import { clearThumbCache, fetchThumbs } from "../src/lib/flow-thumbs";

const display = (price: number) => Math.round(price * 1.1 * 100) / 100;

function slot(n: number, optionCount = 5, extra: Partial<ListFlowSlotInput> = {}): ListFlowSlotInput {
  return {
    lineKey: `linha-${n}`,
    label: `item numero ${n}`,
    qty: 2,
    suggestedSku: `s${n}-1`,
    options: Array.from({ length: optionCount }, (_, i) => ({
      sku: `s${n}-${i + 1}`,
      name: `Produto muito comprido da marca famosa ${n}-${i + 1} 998ml`,
      unitPrice: 10 + i,
      storeLabel: "Carrefour",
      delivery: "prazo da loja: entrega hoje"
    })),
    ...extra
  };
}

const build = (slots: ListFlowSlotInput[], thumbs?: Map<string, string>, extra: object = {}) =>
  buildListFlowData({ listaId: "lst-1", slots, thumbs, ...extra }, display);

test("lista: botão do Flow cabe em 20 caracteres", () => {
  assert.ok(LIST_FLOW_CTA.length <= 20, LIST_FLOW_CTA);
});

test("data: até 4 opções por vaga (a sugerida sempre entre elas), do mais barato ao mais caro, mais 'ver outras' e 'Não quero este item'", () => {
  const { data, slots } = build([slot(1, 6, { suggestedSku: "s1-5" })]);
  const opts = data.opts_1 as Array<{ id: string; title: string }>;
  assert.equal(opts.length, LIST_FLOW_MAX_OPTIONS + 2);
  assert.deepEqual(opts.slice(0, 4).map((o) => o.id), ["s1-1", "s1-2", "s1-3", "s1-5"], "a sugerida (mais cara) entra e a ordem é por preço");
  assert.equal(opts.at(-2)?.id, "more");
  assert.equal(opts.at(-2)?.title, "Nenhuma — ver outras");
  assert.equal(opts.at(-1)?.id, "skip");
  assert.equal(opts.at(-1)?.title, "Não quero este item");
  assert.deepEqual(slots[0].skus, ["s1-1", "s1-2", "s1-3", "s1-5"]);
  assert.equal(data.init_1, "s1-5");
  assert.equal((data.init_values as Record<string, string>).item_1, "s1-5");
});

test("resposta: 'Nenhuma — ver outras' vira kind more", () => {
  const sent = [{ lineKey: "a", skus: ["x", "y"], suggestedSku: "x" }];
  assert.deepEqual(parseListFlowReply({ lia_lista: "lst", item_1: "more" }, sent).choices, [{ lineKey: "a", kind: "more" }]);
});

test("data: a sugestão marcada continua a do envio", () => {
  const { data, slots } = build([slot(1, 6, { suggestedSku: "s1-3" })]);
  assert.deepEqual(slots[0].skus, ["s1-1", "s1-2", "s1-3", "s1-4"]);
  assert.equal(data.init_1, "s1-3");
  assert.equal((data.init_values as Record<string, string>).item_1, "s1-3");
});

test("data: rótulo, título e descrição respeitam os limites da Meta", () => {
  const { data } = build([slot(1), slot(2, 3, { label: "um nome de item absurdamente comprido para o rótulo" })]);
  for (const i of [1, 2]) {
    assert.ok((data[`label_${i}`] as string).length <= 30, String(data[`label_${i}`]));
    for (const o of data[`opts_${i}`] as Array<{ title: string; description?: string }>) {
      assert.ok(o.title.length <= 30, o.title);
      assert.ok((o.description ?? "").length <= 300);
    }
  }
  assert.equal(data.label_1, "Item numero 1 · 2x");
});

test("data: título cortado mantém o tamanho no fim e a descrição leva o nome completo", () => {
  assert.ok(shortOptionTitle("Vodka Smirnoff Tradicional Garrafa Premium 998ml").length <= 30);
  assert.match(shortOptionTitle("Vodka Smirnoff Tradicional Garrafa Premium 998ml"), /998ml$/);
  const { data } = build([slot(1, 1)]);
  const [first] = data.opts_1 as Array<{ title: string; description: string }>;
  assert.match(first.description, /^R\$ 11,00 cada · Carrefour · entrega hoje — Produto muito comprido/);
});

test("data: preço exibido passa pelo markup informado", () => {
  const { data } = build([slot(1, 1, { qty: 1 })]);
  assert.match((data.opts_1 as Array<{ description: string }>)[0].description, /^R\$ 11,00 · /);
});

test("data: sem sugestão o rótulo pede escolha e o init fica vazio", () => {
  const { data, slots } = build([slot(1, 3, { suggestedSku: null, qty: 1 })]);
  assert.equal(data.label_1, "Item numero 1 · escolha uma");
  assert.equal(data.init_1, "");
  assert.equal(slots[0].suggestedSku, null);
});

test("data: 15 vagas fixas, as não usadas ficam invisíveis com opção placeholder", () => {
  const { data } = build([slot(1), slot(2)]);
  assert.equal(data.visible_1, true);
  assert.equal(data.visible_2, true);
  for (let i = 3; i <= LIST_FLOW_MAX_SLOTS; i++) {
    assert.equal(data[`visible_${i}`], false);
    assert.equal((data[`opts_${i}`] as unknown[]).length, 1);
    assert.equal(data[`init_${i}`], "_");
  }
  assert.equal(data.lista_id, "lst-1");
  // o Flow declara exatamente as mesmas chaves que o data envia
  const declared = Object.keys((LIST_FLOW_JSON.screens[0] as any).data).sort();
  assert.deepEqual(Object.keys(data).sort(), declared);
});

test("data: acima de 15 linhas as 15 primeiras vão no Flow e o resto vira overflow", () => {
  const many = Array.from({ length: 18 }, (_, i) => slot(i + 1, 2));
  const built = build(many);
  assert.equal(built.slots.length, LIST_FLOW_MAX_SLOTS);
  assert.deepEqual(built.overflow.map((s) => s.lineKey), ["linha-16", "linha-17", "linha-18"]);
});

test("data: linha sem opção não ocupa vaga", () => {
  const built = build([slot(1), slot(2, 0), slot(3)]);
  assert.deepEqual(built.slots.map((s) => s.lineKey), ["linha-1", "linha-3"]);
});

test("data: faltantes aparecem só quando existem", () => {
  assert.equal(build([slot(1)]).data.faltas_visible, false);
  const withMiss = build([slot(1)], undefined, { misses: [{ query: "gelo", reason: "sem_resultado" }, { query: "carvão" }] });
  assert.equal(withMiss.data.faltas_visible, true);
  assert.equal(withMiss.data.faltas_texto, "Não achei: gelo, carvão");
  const ready = build([slot(1)], undefined, { faltasTexto: "Não achei *gelo*: ninguém entrega aí." });
  assert.equal(ready.data.faltas_texto, "Não achei *gelo*: ninguém entrega aí.");
});

test("imagem: miniatura entra com alt-text e o orçamento corta primeiro as não sugeridas", () => {
  const thumbs = new Map<string, string>();
  const slots = [slot(1, 4), slot(2, 4)];
  for (const s of slots) for (const o of s.options) thumbs.set(o.sku, "A".repeat(1000));
  const full = build(slots, thumbs);
  assert.equal(full.imageBytes, 8000);
  assert.ok((full.data.opts_1 as any[])[0]["alt-text"]);

  const tight = build(slots, thumbs, { imageBudgetBytes: 3000 });
  assert.ok(tight.imageBytes <= 3000);
  const all = [...(tight.data.opts_1 as any[]), ...(tight.data.opts_2 as any[])];
  const withImage = all.filter((o) => o.image).map((o) => o.id);
  // sobraram as sugeridas (s1-1, s2-1) e mais uma; nenhuma "alt-text" órfã
  assert.ok(withImage.includes("s1-1") && withImage.includes("s2-1"));
  for (const o of all) assert.equal(Boolean(o.image), Boolean(o["alt-text"]));

  const none = build(slots, thumbs, { imageBudgetBytes: 0 });
  assert.equal(none.imageBytes, 0);
  assert.equal([...(none.data.opts_1 as any[])].some((o) => o.image), false);
});

test("imagem: 15 vagas x 4 opções com miniaturas de 6 KB ficam no orçamento e abaixo de 1 MB", () => {
  const slots = Array.from({ length: 15 }, (_, i) => slot(i + 1, 4));
  const thumbs = new Map<string, string>();
  for (const s of slots) for (const o of s.options) thumbs.set(o.sku, "B".repeat(8000));
  const built = build(slots, thumbs);
  assert.ok(built.imageBytes <= LIST_FLOW_IMAGE_BUDGET, String(built.imageBytes));
  assert.ok(built.payloadBytes < 1_000_000, String(built.payloadBytes));
});

test("resposta: reconhece o payload da lista", () => {
  assert.equal(isListFlowReply({ lia_lista: "lst-1", item_1: "x" }), true);
  assert.equal(isListFlowReply({ nome: "A", cpf: "1" }), false);
  assert.equal(isListFlowReply({ lia_lista: "" }), false);
  assert.equal(isListFlowReply(undefined), false);
});

test("resposta: keep / skip / pick e sku inválido vira keep", () => {
  const sent = [
    { lineKey: "a", skus: ["a1", "a2", "a3"], suggestedSku: "a1" },
    { lineKey: "b", skus: ["b1", "b2"], suggestedSku: "b1" },
    { lineKey: "c", skus: ["c1", "c2"], suggestedSku: "c1" },
    { lineKey: "d", skus: ["d1"], suggestedSku: "d1" },
    { lineKey: "e", skus: ["e1", "e2"], suggestedSku: null },
    { lineKey: "f", skus: ["f1"], suggestedSku: "f1" }
  ];
  const { listaId, choices } = parseListFlowReply(
    { lia_lista: "lst-9", item_1: "a3", item_2: "skip", item_3: "c-que-nao-foi-enviado", item_4: "d1", item_5: "e2" /* item_6 ausente */ },
    sent
  );
  assert.equal(listaId, "lst-9");
  assert.deepEqual(choices, [
    { lineKey: "a", kind: "pick", sku: "a3" },
    { lineKey: "b", kind: "skip" },
    { lineKey: "c", kind: "keep" },
    { lineKey: "d", kind: "keep" }, // igual à sugestão = mantém
    { lineKey: "e", kind: "pick", sku: "e2" },
    { lineKey: "f", kind: "keep" }
  ]);
});

test("resposta: valores vazios, nulos ou não-string mantêm a sugestão", () => {
  const { choices } = parseListFlowReply({ lia_lista: "x", item_1: "", item_2: null, item_3: 7 }, [
    { lineKey: "a", skus: ["a1"] },
    { lineKey: "b", skus: ["b1"] },
    { lineKey: "c", skus: ["c1"] }
  ]);
  assert.deepEqual(choices.map((c) => c.kind), ["keep", "keep", "keep"]);
});

test("miniaturas: sem URL válida ou com falha não lança e devolve mapa vazio", async () => {
  const result = await fetchThumbs([{ sku: "x" }, { sku: "y", imageUrl: "não-é-url" }, { sku: "z", imageUrl: "http://127.0.0.1:9/nada.jpg" }], { timeoutMs: 300 });
  assert.equal(result.size, 0);
});

test("miniaturas: baixa uma imagem real, reduz para JPEG 96x96 e respeita o orçamento", async () => {
  clearThumbCache();
  const png = await sharp({ create: { width: 400, height: 250, channels: 4, background: "#cc3300" } }).png().toBuffer();
  const server = createServer((req, res) => {
    if (req.url === "/ok.png") return void res.writeHead(200, { "content-type": "image/png" }).end(png);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const thumbs = await fetchThumbs([{ sku: "a", imageUrl: `${base}/ok.png` }, { sku: "b", imageUrl: `${base}/nada.png` }], { timeoutMs: 2000 });
    assert.deepEqual([...thumbs.keys()], ["a"]);
    const meta = await sharp(Buffer.from(thumbs.get("a") as string, "base64")).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 96);
    assert.equal(meta.height, 96);
    clearThumbCache();
    const capped = await fetchThumbs([{ sku: "a", imageUrl: `${base}/ok.png` }], { timeoutMs: 2000, budgetBytes: 10 });
    assert.equal(capped.size, 0);
  } finally {
    server.close();
    clearThumbCache();
  }
});
