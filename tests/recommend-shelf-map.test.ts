// Mapa de prateleiras da recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md
// §1.2): o arquivo gerado por scripts/build-shelf-map.mts tem o tamanho do contrato, ids únicos,
// nenhum remédio de receita, e toda prateleira citada nas tabelas curadas existe. Puro: sem rede,
// sem banco.
import "./helpers/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";

import { SHELF_MAP } from "../src/lib/recommend/shelf-map";
import { NEED_TABLE, SYMPTOM_TABLE, shelfById, shelvesForPrompt } from "../src/lib/recommend/tables";
import { isPrescriptionDrugName, isPrescriptionText } from "../src/lib/medicine";
import type { ShelfDomain } from "../src/lib/recommend/types";

const DOMAINS: ShelfDomain[] = ["mercado", "farmacia", "pet", "beleza", "casa", "brinquedo", "eletronico", "moda", "livraria", "presente"];

test("mapa gerado: 150–250 nós, ids únicos e ordenados, campos obrigatórios", () => {
  const shelves = SHELF_MAP.shelves;
  assert.ok(shelves.length >= 150 && shelves.length <= 250, `nós: ${shelves.length}`);
  assert.match(SHELF_MAP.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
  const ids = shelves.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "ids duplicados");
  assert.deepEqual([...ids].sort(), ids, "saída tem de vir ordenada por id (determinística)");
  for (const s of shelves) {
    assert.match(s.id, /^[a-z]+\.[a-z0-9_]+$/, s.id);
    assert.ok(s.label.trim(), `${s.id} sem label`);
    assert.ok(s.query.trim(), `${s.id} sem query`);
    assert.ok(DOMAINS.includes(s.domain), `${s.id} domínio ${s.domain}`);
    assert.ok(s.stores.length > 0, `${s.id} sem loja`);
    assert.ok((s.itemCount ?? 0) >= 8, `${s.id} com menos de 8 itens`);
  }
});

test("nenhum nó carrega nome de remédio de receita; nós MIP são farmacia.<classe>", () => {
  for (const s of SHELF_MAP.shelves) {
    const text = [s.label, s.query, ...(s.aliases ?? [])].join(" ");
    assert.equal(isPrescriptionText(text), false, `${s.id}: ${text}`);
    assert.equal(isPrescriptionDrugName(text), false, `${s.id}: ${text}`);
    if (s.flags?.includes("mip")) {
      assert.equal(s.domain, "farmacia", s.id);
      assert.match(s.id, /^farmacia\./, s.id);
      // Isento só sai pelas farmácias com lista MIP (src/lib/medicine.ts MIP_STORE_KEYS).
      for (const store of s.stores) assert.ok(["drogariasp", "paguemenos"].includes(store), `${s.id} em ${store}`);
    }
  }
  const mip = SHELF_MAP.shelves.filter((s) => s.flags?.includes("mip")).map((s) => s.id);
  for (const id of ["farmacia.analgesico", "farmacia.antitermico", "farmacia.antiacido", "farmacia.antidiarreico", "farmacia.antiespasmodico",
    "farmacia.antigases", "farmacia.antialergico", "farmacia.descongestionante", "farmacia.antitussigeno", "farmacia.probiotico",
    "farmacia.hidratacao_oral", "farmacia.vitaminas", "farmacia.colirio"]) {
    assert.ok(mip.includes(id), `falta nó MIP ${id}`);
  }
});

test("prateleiras-chave existem (doce, fome, dor de barriga, churrasco, presente pra mãe)", () => {
  const byQuery = (q: string) => SHELF_MAP.shelves.find((s) => s.query === q || (s.aliases ?? []).includes(q));
  assert.ok(byQuery("chocolate"), "chocolate");
  assert.ok(byQuery("sorvete"), "sorvete");
  assert.ok(byQuery("racao cachorro"), "racao cachorro");
  for (const id of ["doces.chocolate", "doces.sorvete", "doces.bolo", "doces.biscoito_doce", "snacks.salgadinho", "lanches.sanduiche",
    "frios.iogurte", "farmacia.antidiarreico", "farmacia.antiespasmodico", "pet.racao_cachorro", "pet.racao_gato", "casa.churrasco",
    "carnes.bovina", "padaria.pao_de_alho", "bebidas.cerveja", "beleza.perfume_feminino", "doces.chocolate_presente", "presente.flores"]) {
    assert.ok(shelfById(id), `falta ${id}`);
  }
  assert.ok(shelfById("doces.chocolate")!.flags?.includes("ready_to_eat"));
  assert.ok(shelfById("doces.sorvete")!.flags?.includes("cold"));
  assert.ok(shelfById("presente.flores")!.flags?.includes("gift"));
  assert.ok(shelfById("pet.racao_cachorro")!.flags?.includes("pet"));
  assert.equal(shelfById("nao.existe"), null);
});

test("todo id citado nas tabelas curadas existe no mapa; isento só em nó MIP", () => {
  const missing: string[] = [];
  for (const e of NEED_TABLE) for (const pick of e.picks) if (!shelfById(pick.shelfId)) missing.push(`need ${e.keys[0]} → ${pick.shelfId}`);
  for (const e of SYMPTOM_TABLE) {
    // "produto" (q9, 08/10) = busca textual livre, sem prateleira (Povidine na unha encravada); só como cuidado, nunca remédio.
    for (const pick of [...e.picks, ...(e.care ?? [])]) if (!shelfById(pick.shelfId) && !(pick.shelfId === "produto" && !pick.mipClass && (e.care ?? []).includes(pick))) missing.push(`sintoma ${e.keys[0]} → ${pick.shelfId}`);
    for (const pick of e.picks) {
      const node = shelfById(pick.shelfId);
      if (!node) continue;
      if (pick.mipClass) {
        assert.ok(node.flags?.includes("mip"), `${pick.shelfId} não é MIP`);
        assert.equal(pick.shelfId, `farmacia.${pick.mipClass}`);
      } else assert.ok(!node.flags?.includes("mip"), `${pick.shelfId} é MIP sem mipClass`);
    }
    for (const pick of e.care ?? []) assert.ok(!shelfById(pick.shelfId)?.flags?.includes("mip"), `cuidado ${pick.shelfId} não pode ser remédio`);
  }
  for (const e of NEED_TABLE) for (const pick of e.picks) assert.ok(!shelfById(pick.shelfId)?.flags?.includes("mip"), `necessidade ${e.keys[0]} aponta remédio ${pick.shelfId}`);
  assert.deepEqual(missing, []);
});

test("shelvesForPrompt: uma linha por nó, cabe no prompt", () => {
  const text = shelvesForPrompt();
  const lines = text.split("\n");
  assert.equal(lines.length, SHELF_MAP.shelves.length);
  for (const line of lines) assert.equal(line.split(" | ").length, 4, line);
  // ~6–8k tokens no máximo (≈ 4 caracteres por token).
  assert.ok(text.length < 32_000, `prompt com ${text.length} caracteres`);
  // Agrupado por domínio, na ordem mercado → farmácia → pet → … → presente.
  const domains = lines.map((l) => shelfById(l.split(" | ")[0])!.domain);
  const order = domains.filter((d, i) => i === 0 || domains[i - 1] !== d);
  assert.equal(new Set(order).size, order.length, "domínio aparece em mais de um bloco");
  assert.deepEqual(order, DOMAINS.filter((d) => order.includes(d)));
  assert.equal(shelvesForPrompt(), text, "determinística");
});
