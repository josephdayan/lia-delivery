import "./helpers/golden-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __clearLiveSearchCacheForTests, categorySlug, isPharmacyStore, liveSearchEnabled, liveSearchItems, mergeLiveWithSnapshot, parseLiveProducts } from "../src/lib/stores/live-search";
import type { CatalogItem } from "../src/lib/stores/types";

const product = (over: Record<string, unknown> = {}) => ({
  productName: "Bola De Tenis Championship Bolsa 12 Bolinhas Verde Werkon",
  brand: "Werkon",
  link: "/bola-de-tenis-championship/p",
  categories: ["/Esportes/Tenis/"],
  items: [{ itemId: "4163487", nameComplete: "Bola De Tenis Championship Bolsa 12 Bolinhas Verde Werkon", images: [{ imageUrl: "https://img/x.jpg" }], sellers: [{ sellerId: "1", commertialOffer: { Price: 89.9, AvailableQuantity: 10000 } }] }],
  ...over
});

test("produto da prateleira vira item com SKU no formato da cópia", () => {
  const [item] = parseLiveProducts("casaevideo", [product()]);
  assert.equal(item.sku, "casaevideo-4163487");
  assert.equal(item.unitPrice, 89.9);
  assert.equal(item.productUrl, "https://www.casaevideo.com.br/bola-de-tenis-championship/p");
  assert.equal(item.category, "esportes tenis");
});

test("só o que a própria loja vende e tem estoque entra", () => {
  const offered = (sellerId: string, qty: number) => product({ items: [{ itemId: "9", nameComplete: "Item", sellers: [{ sellerId, commertialOffer: { Price: 10, AvailableQuantity: qty } }] }] });
  assert.equal(parseLiveProducts("casaevideo", [offered("lojista-3p", 5)]).length, 0);
  assert.equal(parseLiveProducts("casaevideo", [offered("1", 0)]).length, 0);
  assert.equal(parseLiveProducts("casaevideo", [offered("1", 3)]).length, 1);
});

test("remédio nunca entra: categoria da loja e guardas ANVISA", () => {
  const named = (name: string, categories: string[]) => product({ productName: name, categories, items: [{ itemId: "55", nameComplete: name, sellers: [{ sellerId: "1", commertialOffer: { Price: 10, AvailableQuantity: 5 } }] }] });
  const byCategory = named("Algo Qualquer", ["/Medicamentos/"]);
  const byName = named("Dipirona Monoidratada 1g Genérico Cimed", ["/Higiene/"]);
  assert.equal(parseLiveProducts("drogariasp", [byCategory, byName]).length, 0);
});

test("farmácia amplia em qualquer categoria: o que barra remédio é a lista de bloqueio, não a cópia (08/10)", () => {
  // Caso real (placar r4): teste de gravidez, Havaianas e vitamina C existem na Drogaria SP e pilhas
  // recarregáveis na Pague Menos, mas a cópia nunca teve essas categorias — a allowlist escondia tudo.
  const snapshot: CatalogItem[] = [{ sku: "dsp-1", name: "Shampoo A", unitPrice: 10, category: "dermocosmeticos shampoo", popularity: 3 }];
  const live: CatalogItem[] = [
    { sku: "dsp-2", name: "Shampoo B", unitPrice: 12, category: "dermocosmeticos shampoo" },
    { sku: "dsp-3", name: "Teste de Gravidez Ever Care Caneta 1 Unidade", unitPrice: 16.99, category: "teste de gravidez" }
  ];
  assert.deepEqual(mergeLiveWithSnapshot("drogariasp", snapshot, live).map((i) => i.sku), ["dsp-1", "dsp-2", "dsp-3"]);
  assert.deepEqual(mergeLiveWithSnapshot("casaevideo", snapshot, live).map((i) => i.sku), ["dsp-1", "dsp-2", "dsp-3"]);
  assert.equal(isPharmacyStore("drogariasp"), true);
  assert.equal(isPharmacyStore("mambo"), false);
  // Prateleira de medicamento e nome de remédio continuam fora com a flag do MIP desligada.
  const named = (name: string, categories: string[]) => product({ productName: name, categories, items: [{ itemId: "77", nameComplete: name, sellers: [{ sellerId: "1", commertialOffer: { Price: 10, AvailableQuantity: 5 } }] }] });
  assert.equal(parseLiveProducts("drogariasp", [named("Teste de Gravidez Ever Care Caneta 1 Unidade", ["/Teste de Gravidez/"])]).length, 1);
  assert.equal(parseLiveProducts("drogariasp", [named("Analgésico Novalgina 1g Dipirona 20 comprimidos", ["/Remédios/"])]).length, 0);
  // Vitamina sem palavra de remédio é produto comum (como na cópia); remédio de receita pelo nome, nunca.
  assert.equal(parseLiveProducts("drogariasp", [named("Vitamina C 1g 30 Comprimidos Efervescentes", ["/Vitamina/"])]).length, 1);
  assert.equal(parseLiveProducts("drogariasp", [named("Isotretinoína 20mg 30 Cápsulas", ["/Pele/"])]).length, 0);
});

// Remédio isento AO VIVO (08/10): a mesma lista positiva da colheita (harvest-mip-catalog.mts).
function withMip<T>(run: () => T): T {
  const saved = process.env.LIA_MEDICINE_MIP;
  process.env.LIA_MEDICINE_MIP = "true";
  try { return run(); } finally { if (saved === undefined) delete process.env.LIA_MEDICINE_MIP; else process.env.LIA_MEDICINE_MIP = saved; }
}
const shelf = (name: string, categories: string[], extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
  product({ productName: name, categories, ...extra, items: [{ itemId: String(Math.abs(hash(name))), nameComplete: name, sellers: [{ sellerId: "1", commertialOffer: { Price: 10, AvailableQuantity: 5 } }], ...item }] });
function hash(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

test("MIP ligado, Drogaria SP: prateleira 'Remédios' entra marcada mip; 'Medicamentos' só 'Sem Tarja'; receita nunca", () => {
  withMip(() => {
    const items = parseLiveProducts("drogariasp", [
      shelf("Analgésico e Antitérmico Novalgina 1g Dipirona Adulto 20 comprimidos", ["/Remédios/"]),
      shelf("Dipirona Monoidratada 1g Genérico Cimed 10 Comprimidos", ["/Medicamentos/"], { properties: [{ name: "Classificação", values: ["Sem Tarja"] }, { name: "Prescrição Médica", values: ["Sem Retenção De Receita"] }] }),
      shelf("Dipirona 500mg Genérico Prati Donaduzzi 30 Comprimidos", ["/Medicamentos/"], { properties: [{ name: "Classificação", values: ["Tarja Vermelha"] }] }),
      shelf("Produto Sem Classificação 10 Comprimidos", ["/Medicamentos/"]),
      shelf("Amoxicilina 500mg 21 Cápsulas", ["/Remédios/"]),
      shelf("Rivotril 2mg 30 Comprimidos", ["/Medicamentos/"], { properties: [{ name: "Classificação", values: ["Sem Tarja"] }] })
    ]);
    assert.deepEqual(items.map((i) => i.name.split(" ")[0]), ["Analgésico", "Dipirona"]);
    assert.ok(items.every((i) => i.medicine === "mip"));
    // Revisão 08/10: a prateleira "Remédios" NÃO dispensa tarja/prescrição/classe — as mesmas checagens da colheita.
    const tarjaNaPrateleira = parseLiveProducts("drogariasp", [
      shelf("Produto Y 30 Comprimidos", ["/Remédios/"], { properties: [{ name: "Classificação", values: ["Tarja Vermelha"] }] }),
      shelf("Produto Z 30 Comprimidos", ["/Remédios/"], { properties: [{ name: "Prescrição Médica", values: ["Venda Sob Prescrição Médica"] }] }),
      shelf("Produto W 30 Comprimidos", ["/Remédios/"], { properties: [{ name: "Classe dos Remédios", values: ["Antibióticos"] }] })
    ]);
    assert.deepEqual(tarjaNaPrateleira, []);
  });
  // Flag desligada: a mesma prateleira não devolve nada.
  assert.equal(parseLiveProducts("drogariasp", [shelf("Analgésico Novalgina 1g Dipirona 20 comprimidos", ["/Remédios/"])]).length, 0);
});

test("MIP ligado, Pague Menos: só código de barras de um isento da Drogaria SP e sem marca de antibiótico/controlado", () => {
  withMip(() => {
    const cat = ["/Medicamentos e Saúde/Dor, Febre e inflamação/"];
    const items = parseLiveProducts("paguemenos", [
      shelf("Dipirona Monoidratada 1g 10 Comprimidos Neo Química Genérico", cat, {}, { ean: "7896714207551" }), // EAN do catálogo MIP da DSP
      shelf("Dipirona Sódica 1g 20 Comprimidos Genérico Prati-Donaduzzi", cat, {}, { ean: "7898108640609" }), // código de barras fora da lista
      shelf("Remédio Qualquer 10 Comprimidos", cat, { properties: [{ name: "Antibiotico", values: ["Sim"] }] }, { ean: "7896714207551" }),
      shelf("Sem código de barras", cat)
    ]);
    assert.deepEqual(items.map((i) => i.sku.startsWith("paguemenos-") && i.medicine), [ "mip" ]);
    assert.equal(items[0].ean, "7896714207551");
    // Drogal não fecha MIP pela Lia: prateleira de medicamento continua fora.
    assert.equal(parseLiveProducts("drogal", [shelf("Dipirona 1g 10 Comprimidos", ["/Medicamentos/"], {}, { ean: "7896714207551" })]).length, 0);
  });
});

test("MIP ligado: fora da prateleira de medicamento, item com cara de remédio sai pela porta do MIP; produto comum segue comum", () => {
  withMip(() => {
    const items = parseLiveProducts("drogariasp", [
      shelf("Vitamina C 1g Drogarias São Paulo 30 Comprimidos Efervescentes", ["/Vitamina/"]),
      shelf("Pomada para Assaduras Bepantriz Dexpantenol 30g", ["/Creme Para Assadura/"]),
      shelf("Teste de Gravidez Ever Care Caneta 1 Unidade", ["/Teste de Gravidez/"]),
      shelf("Sandália Havaianas Top Preto Tamanho 37/38 1 Par", ["/Chinelo/"]),
      shelf("Isotretinoína 20mg 30 Cápsulas", ["/Pele/"]) // receita pelo nome: nunca
    ]);
    const byName = Object.fromEntries(items.map((i) => [i.name.split(" ")[0], i.medicine ?? "comum"]));
    // Vitamina sem palavra de remédio segue produto comum (a guarda ANVISA não a marca). Fora da prateleira
    // de medicamento, item com cara de remédio SÓ entra como MIP com código de barras da lista positiva
    // da Drogaria SP (revisão 08/10: a loja guarda remédio em categoria cosmética — clindamicina em
    // "Acne", mupirocina em "Primeiros Socorros" — e esses não podem entrar). Sem EAN da lista: fora.
    assert.deepEqual(byName, { Vitamina: "comum", Teste: "comum", Sandália: "comum" });
    const comEan = parseLiveProducts("drogariasp", [
      shelf("Analgésico e Antitérmico Dipirona Sódica 1g Neo Química 10 Comprimidos", ["/Promoções/"], {}, { ean: "7896714207551" }),
      shelf("Clindamicina 1% Gel 30g", ["/Dermocosméticos/Acne/"], {}, { ean: "7898108640609" }),
      shelf("Mupirocina 20mg/g Pomada 15g", ["/Primeiros Socorros/"])
    ]);
    assert.deepEqual(comEan.map((i) => [i.name.split(" ")[0], i.medicine]), [["Analgésico", "mip"]]);
  });
});

test("o ao vivo atualiza preço/nome da cópia e preserva a popularidade", () => {
  const snapshot: CatalogItem[] = [{ sku: "mambo-1", name: "Leite velho", unitPrice: 5, popularity: 7, category: "x" }];
  const live: CatalogItem[] = [{ sku: "mambo-1", name: "Leite novo", unitPrice: 6.5, category: "x" }];
  const [merged] = mergeLiveWithSnapshot("mambo", snapshot, live);
  assert.equal(merged.unitPrice, 6.5);
  assert.equal(merged.name, "Leite novo");
  assert.equal(merged.popularity, 7);
});

test("busca ao vivo: falha ou timeout = lista vazia (a cópia responde sozinha); sucesso vai pro cache", async () => {
  __clearLiveSearchCacheForTests();
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => ({ products: [product()] }) }; };
  assert.equal((await liveSearchItems("casaevideo", "bola de tenis", 12, ok)).length, 1);
  assert.equal((await liveSearchItems("casaevideo", "Bola de Tenis", 12, ok)).length, 1);
  assert.equal(calls, 1, "segunda busca igual vem do cache");
  const boom = async () => { throw new Error("rede"); };
  assert.deepEqual(await liveSearchItems("mambo", "leite", 12, boom), []);
  const http500 = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(await liveSearchItems("swift", "leite", 12, http500), []);
  assert.deepEqual(await liveSearchItems("loja-que-nao-existe", "leite", 12, ok), []);
});

test("padrão ligado; LIA_LIVE_SEARCH=false desliga", () => {
  const saved = process.env.LIA_LIVE_SEARCH;
  try {
    delete process.env.LIA_LIVE_SEARCH;
    assert.equal(liveSearchEnabled(), true);
    process.env.LIA_LIVE_SEARCH = "false";
    assert.equal(liveSearchEnabled(), false);
    process.env.LIA_LIVE_SEARCH = "true";
    assert.equal(liveSearchEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.LIA_LIVE_SEARCH; else process.env.LIA_LIVE_SEARCH = saved;
  }
    assert.equal(categorySlug(["/Dermocosméticos/Shampoo/"]), "dermocosmeticos shampoo");
});
