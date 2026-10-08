// Agregações do painel /ops/recomendacoes (08/10/2026). Puro: sem banco, sem rede.
import "./helpers/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRecommendReport,
  clampDays,
  emptyShelfQueue,
  groupRequests,
  maskPhone,
  normalizeRequest,
  recentRows,
  redFlagRows,
  summarize,
  type RecommendLogRow
} from "../src/lib/recommend-ops";

let n = 0;
function row(over: Partial<RecommendLogRow>): RecommendLogRow {
  n += 1;
  return {
    id: `r${n}`,
    createdAt: new Date(Date.UTC(2026, 9, 8, 12, n)),
    phone: "5511999991234",
    source: "dialogue",
    form: "need",
    need: null,
    product: null,
    symptom: null,
    planSource: "ai",
    redFlag: null,
    shelfIds: [],
    cardSkus: [],
    emptyShelves: [],
    chosenSku: null,
    outcome: "shown",
    mapMs: 100,
    searchMs: 200,
    judgeMs: 300,
    ...over
  };
}

const sample = (): RecommendLogRow[] => [
  row({ need: "Algo doce", shelfIds: ["mercado.doces", "mercado.chocolates"], cardSkus: ["a:1", "a:2"], outcome: "chosen", chosenSku: "a:1", phone: "5511999990001" }),
  row({ need: "algo  doce!", shelfIds: ["mercado.doces"], emptyShelves: ["mercado.sobremesas"], cardSkus: ["a:3"], outcome: "shown", phone: "5511999990002" }),
  row({ need: "Álgo doce", shelfIds: [], emptyShelves: ["mercado.sobremesas", "mercado.doces"], outcome: "none", planSource: "table", phone: "5511999990001" }),
  row({ symptom: "dor de barriga", form: "need", shelfIds: ["farmacia.colica"], cardSkus: ["f:9"], outcome: "shown", mapMs: 50, searchMs: 50, judgeMs: 900 }),
  row({ symptom: "dor no peito", redFlag: "dor no peito: procurar atendimento", outcome: "red_flag", planSource: "table", shelfIds: [] }),
  row({ product: "ração premium", form: "product_judged", outcome: null, planSource: "weird", mapMs: null, searchMs: null, judgeMs: null }),
  row({ outcome: "none" })
];

test("maskPhone: só os 4 últimos dígitos", () => {
  assert.equal(maskPhone("+55 (11) 99999-1234"), "••••1234");
  assert.equal(maskPhone("12"), "••••");
  assert.equal(maskPhone(null), "••••");
  assert.ok(!maskPhone("5511999991234").includes("5511999"));
});

test("normalizeRequest tira acento, pontuação e espaços repetidos", () => {
  assert.equal(normalizeRequest("  Álgo   DOCE!! "), "algo doce");
  assert.equal(normalizeRequest(null), "");
});

test("summarize: contagens, percentuais, latência e planSource", () => {
  const s = summarize(sample());
  assert.equal(s.total, 7);
  assert.deepEqual(s.counts, { shown: 2, chosen: 1, none: 2, redFlag: 1, pending: 1 });
  assert.equal(s.shownPct, 42.9); // 3/7
  assert.equal(s.chosenPct, 33.3); // 1/3
  assert.equal(s.nonePct, 28.6);
  assert.equal(s.redFlagPct, 14.3);
  assert.deepEqual(s.planSource, { ai: 4, table: 2, other: 1 });
  // totais: 600 ×5 (inclui red_flag e none), 1000, 0 (nulos) → ordenado [0,600×5,1000], n=7
  assert.equal(s.latency.p50Ms, 600);
  assert.equal(s.latency.avgMs, Math.round((600 * 5 + 1000 + 0) / 7));
  assert.equal(s.latency.p95Ms, 1000);
});

test("summarize: lista vazia não divide por zero", () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.chosenPct, 0);
  assert.equal(s.latency.p50Ms, 0);
});

test("groupRequests: normaliza, conta clientes, % escolhidas, prateleiras e vazias", () => {
  const groups = groupRequests(sample());
  const doce = groups[0]!;
  assert.equal(doce.count, 3);
  assert.equal(doce.customers, 2);
  assert.deepEqual(doce.kinds, ["need"]);
  assert.equal(doce.withCards, 2);
  assert.equal(doce.chosen, 1);
  assert.equal(doce.chosenPct, 50);
  assert.deepEqual(doce.topShelves[0], { id: "mercado.doces", count: 2 });
  assert.deepEqual(doce.emptyShelves[0], { id: "mercado.sobremesas", count: 2 });
  assert.equal(groups.length, 4); // doce, dor de barriga, dor no peito, ração; linha sem pedido fica de fora
  assert.ok(groups.some((g) => g.label === "ração premium" && g.kinds[0] === "product"));
});

test("groupRequests respeita o limite e ordena por frequência", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row({ need: `pedido ${i}` }));
  rows.push(row({ need: "pedido 7" }), row({ need: "pedido 7" }));
  const groups = groupRequests(rows, 30);
  assert.equal(groups.length, 30);
  assert.equal(groups[0]!.label, "pedido 7");
  assert.equal(groups[0]!.count, 3);
});

test("emptyShelfQueue: ordena por vezes vazia e traz exemplos de pedido", () => {
  const q = emptyShelfQueue(sample());
  assert.equal(q[0]!.id, "mercado.sobremesas");
  assert.equal(q[0]!.count, 2);
  assert.ok(q[0]!.requests[0]!.toLowerCase().includes("doce"));
  assert.equal(q[1]!.id, "mercado.doces");
});

test("recentRows: mais recentes primeiro, limite 50, telefone mascarado, nº de cards", () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ need: `p${i}`, cardSkus: ["x:1", "x:2"] }));
  const recent = recentRows(rows, 50);
  assert.equal(recent.length, 50);
  assert.equal(recent[0]!.request, "p59");
  assert.equal(recent[0]!.cards, 2);
  assert.equal(recent[0]!.phone, "••••1234");
  assert.ok(!JSON.stringify(recent).includes("5511999991234"));
  const pending = recentRows([row({ outcome: null })], 5)[0]!;
  assert.equal(pending.outcome, "pending");
});

test("redFlagRows: lista só alertas, com o motivo", () => {
  const flags = redFlagRows(sample());
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.reason, "dor no peito: procurar atendimento");
  assert.equal(flags[0]!.request, "dor no peito");
  const noReason = redFlagRows([row({ outcome: "red_flag", redFlag: null, need: "x" })]);
  assert.equal(noReason[0]!.reason, "(sem motivo registrado)");
});

test("json defeituoso (shelfIds/emptyShelves não-array, itens não-string) não quebra", () => {
  const bad = row({ need: "x", shelfIds: { a: 1 }, emptyShelves: [1, null, "ok.shelf", " "], cardSkus: "nope" });
  const report = buildRecommendReport([bad], 30);
  assert.deepEqual(report.requests[0]!.topShelves, []);
  assert.deepEqual(report.requests[0]!.emptyShelves, [{ id: "ok.shelf", count: 1 }]);
  assert.equal(report.recent[0]!.cards, 0);
});

test("buildRecommendReport aceita createdAt como string ISO", () => {
  const report = buildRecommendReport([row({ need: "x", createdAt: "2026-10-08T10:00:00.000Z" })], 7);
  assert.equal(report.days, 7);
  assert.equal(report.recent[0]!.at, "2026-10-08T10:00:00.000Z");
});

test("clampDays", () => {
  assert.equal(clampDays("90"), 90);
  assert.equal(clampDays("abc"), 30);
  assert.equal(clampDays(0), 1);
  assert.equal(clampDays(9999), 180);
  assert.equal(clampDays(null), 30);
});
