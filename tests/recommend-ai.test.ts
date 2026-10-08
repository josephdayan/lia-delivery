import "./helpers/load-env";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setJudgeFitnessForTests, __setPlanShelvesForTests, sanitizeWhy, validatePlanPicks } from "../src/lib/recommend/ai";
import {
  constraintRules,
  judgeFitness,
  judgeFitnessByRules,
  planShelves,
  planShelvesFromTables,
  recommendAiEnabled,
  tableDepsFrom,
  violatesConstraint
} from "../src/lib/recommend/fallback";
import type { ChoiceOption } from "../src/lib/conversation-types";
import type { FitnessInput, NeedTableEntry, RecommendRequest, RedFlagRule, ShelfCandidate, ShelfMap, ShelfPlan, SymptomTableEntry } from "../src/lib/recommend/types";

// Recomendação (08/10/2026): MAPEAR/JULGAR sem rede — mapa e tabelas FAKE (não dependem do
// conteúdo real de shelf-map.ts/tables.ts) e IA por costura.

const MAP: ShelfMap = {
  generatedAt: "test",
  shelves: [
    { id: "doces.chocolate", label: "Chocolates e bombons", domain: "mercado", query: "chocolate", aliases: ["bombom", "barra de chocolate"], stores: ["a"], flags: ["ready_to_eat"] },
    { id: "doces.sorvete", label: "Sorvetes", domain: "mercado", query: "sorvete", stores: ["a"], flags: ["cold", "ready_to_eat"] },
    { id: "doces.biscoito", label: "Biscoitos recheados", domain: "mercado", query: "biscoito recheado", stores: ["a"], flags: ["ready_to_eat"] },
    { id: "doces.bolo", label: "Bolos prontos", domain: "mercado", query: "bolo pronto", stores: ["a"] },
    { id: "padaria.pao", label: "Pães", domain: "mercado", query: "pao de forma", stores: ["a"], flags: ["fresh"] },
    { id: "beleza.shampoo", label: "Shampoos", domain: "beleza", query: "shampoo", stores: ["b"] },
    { id: "farmacia.antidiarreico", label: "Antidiarreicos", domain: "farmacia", query: "loperamida", stores: ["f"], flags: ["mip"] },
    { id: "farmacia.antigases", label: "Antigases", domain: "farmacia", query: "simeticona", stores: ["f"], flags: ["mip"] },
    { id: "farmacia.soro", label: "Soro de reidratação", domain: "farmacia", query: "soro de reidratacao", stores: ["f"], flags: ["care"] }
  ]
};

const NEED_TABLE: NeedTableEntry[] = [
  {
    keys: ["algo doce", "doce"],
    picks: [
      { shelfId: "doces.chocolate", query: "chocolate", why: "pronto pra comer" },
      { shelfId: "doces.sorvete", query: "sorvete", why: "doce e gelado" },
      { shelfId: "doces.biscoito", query: "biscoito recheado", why: "pra beliscar" },
      { shelfId: "doces.bolo", query: "bolo pronto", why: "fatia na hora" }
    ],
    criteria: ["fast"]
  }
];
const SYMPTOM_TABLE: SymptomTableEntry[] = [
  {
    keys: ["dor de barriga", "diarreia"],
    picks: [
      { shelfId: "farmacia.antidiarreico", query: "loperamida | Imosec", why: "segura a diarreia", mipClass: "antidiarreico" },
      { shelfId: "farmacia.antigases", query: "simeticona | Luftal", why: "alivia gases", mipClass: "antigases" }
    ],
    care: [{ shelfId: "farmacia.soro", query: "soro de reidratacao", why: "repõe líquidos" }]
  }
];
const RED_FLAGS: RedFlagRule[] = [{ pattern: /\bsangue\b/, reason: "sangue nas fezes" }];

const deps = tableDepsFrom(MAP, { NEED_TABLE, SYMPTOM_TABLE, RED_FLAGS });

function req(over: Partial<RecommendRequest>): RecommendRequest {
  return { form: "need", text: "", criteria: [], constraints: [], source: "regex", ...over };
}

function opt(sku: string, name: string, over: Partial<ChoiceOption> = {}): ChoiceOption {
  return { sku, name, unitPrice: 10, storeKey: "a", ...over };
}
function cand(shelfId: string, sku: string, name: string, over: Partial<ChoiceOption> = {}, popularity?: number): ShelfCandidate {
  return { shelfId, option: opt(sku, name, over), ...(popularity != null ? { popularity } : {}) };
}

const savedMip = process.env.LIA_MEDICINE_MIP;
afterEach(() => {
  __setPlanShelvesForTests(null);
  __setJudgeFitnessForTests(null);
  if (savedMip === undefined) delete process.env.LIA_MEDICINE_MIP;
  else process.env.LIA_MEDICINE_MIP = savedMip;
  delete process.env.LIA_RECOMMEND_MEDICINE;
});

describe("recomendação — MAPEAR pelas tabelas (sem IA)", () => {
  it("IA desligada no harness (sem chave)", () => {
    assert.equal(recommendAiEnabled(), false);
  });

  it("necessidade → prateleiras da tabela, em ordem", () => {
    const plan = planShelvesFromTables(req({ text: "tô com muita fome, quero algo doce", need: "algo doce" }), deps);
    assert.equal(plan?.source, "table");
    assert.deepEqual(plan?.picks.map((p) => p.shelfId), ["doces.chocolate", "doces.sorvete", "doces.biscoito", "doces.bolo"]);
  });

  it("restrição 'sem chocolate' tira a prateleira de chocolate; 'sem lactose' tira sorvete e chocolate", () => {
    const semChoc = planShelvesFromTables(req({ text: "algo doce sem chocolate", need: "algo doce", constraints: ["sem chocolate"] }), deps);
    assert.ok(!semChoc?.picks.some((p) => p.shelfId === "doces.chocolate"));
    assert.equal(semChoc?.picks.length, 3);
    const semLac = planShelvesFromTables(req({ text: "algo doce sem lactose", need: "algo doce", constraints: ["sem lactose"] }), deps);
    assert.deepEqual(semLac?.picks.map((p) => p.shelfId), ["doces.biscoito", "doces.bolo"]);
  });

  it("o que já está na cesta não é recomendado de novo", () => {
    const plan = planShelvesFromTables(req({ text: "algo doce", need: "algo doce" }), deps, { basketNames: ["Chocolate Lacta ao Leite 90g"] });
    assert.ok(!plan?.picks.some((p) => p.shelfId === "doces.chocolate"));
  });

  it("sintoma → classes isentas na ordem da tabela + cuidado no fim (porta do remédio aberta)", () => {
    process.env.LIA_MEDICINE_MIP = "true";
    const plan = planShelvesFromTables(req({ text: "tô com dor de barriga", need: "dor de barriga", symptom: "dor de barriga" }), deps);
    assert.deepEqual(plan?.picks.map((p) => p.shelfId), ["farmacia.antidiarreico", "farmacia.antigases", "farmacia.soro"]);
    assert.equal(plan?.picks[0].mipClass, "antidiarreico");
  });

  it("sintoma com a porta do remédio fechada → só o cuidado", () => {
    delete process.env.LIA_MEDICINE_MIP;
    const plan = planShelvesFromTables(req({ text: "tô com dor de barriga", need: "dor de barriga", symptom: "dor de barriga" }), deps);
    assert.deepEqual(plan?.picks.map((p) => p.shelfId), ["farmacia.soro"]);
    process.env.LIA_MEDICINE_MIP = "true";
    process.env.LIA_RECOMMEND_MEDICINE = "false";
    const off = planShelvesFromTables(req({ text: "tô com dor de barriga", need: "dor de barriga", symptom: "dor de barriga" }), deps);
    assert.deepEqual(off?.picks.map((p) => p.shelfId), ["farmacia.soro"]);
  });

  it("sinal de alerta → plano vazio com o motivo", () => {
    process.env.LIA_MEDICINE_MIP = "true";
    const plan = planShelvesFromTables(req({ text: "dor de barriga com sangue", need: "dor de barriga", symptom: "dor de barriga" }), deps);
    assert.deepEqual(plan, { picks: [], redFlag: "sangue nas fezes", source: "table" });
  });

  it("produto + julgamento → a prateleira do produto (por query/alias); sem prateleira → pick 'produto'", () => {
    const choc = planShelvesFromTables(req({ form: "product_judged", text: "me recomenda um chocolate bom", product: "chocolate", criteria: ["good"] }), deps);
    assert.deepEqual(choc?.picks, [{ shelfId: "doces.chocolate", query: "chocolate", why: "" }]);
    const bombom = planShelvesFromTables(req({ form: "product_judged", text: "qual o melhor bombom", product: "bombom", criteria: ["good"] }), deps);
    assert.equal(bombom?.picks[0].shelfId, "doces.chocolate");
    const shampoo = planShelvesFromTables(req({ form: "product_judged", text: "melhor shampoo pra cacheado", product: "shampoo cabelo cacheado", criteria: ["good"] }), deps);
    assert.deepEqual(shampoo?.picks, [{ shelfId: "beleza.shampoo", query: "shampoo cabelo cacheado", why: "" }]);
    const nada = planShelvesFromTables(req({ form: "product_judged", text: "melhor furadeira", product: "furadeira", criteria: ["good"] }), deps);
    assert.deepEqual(nada?.picks, [{ shelfId: "produto", query: "furadeira", why: "" }]);
  });

  it("necessidade fora das tabelas → null", () => {
    assert.equal(planShelvesFromTables(req({ text: "preciso de algo pra viagem", need: "algo pra viagem" }), deps), null);
  });
});

describe("recomendação — planShelves (IA por costura + redes de segurança)", () => {
  it("IA com ids fora do mapa → descartados; nada válido → tabela", async () => {
    __setPlanShelvesForTests(async () => ({ picks: [{ shelfId: "doces.inventado", query: "doce", why: "x" }], source: "ai" }));
    const plan = await planShelves(req({ text: "algo doce", need: "algo doce" }), { deps });
    assert.equal(plan.source, "table");
    assert.equal(plan.picks[0].shelfId, "doces.chocolate");
  });

  it("IA com parte válida → fica só a parte válida, fonte ai", async () => {
    __setPlanShelvesForTests(async () => ({
      picks: [
        { shelfId: "doces.sorvete", query: "sorvete pote", why: "gelado" },
        { shelfId: "nao.existe", query: "x", why: "" },
        { shelfId: "doces.bolo", query: "bolo de cenoura", why: "fatia pronta" }
      ],
      source: "ai"
    }));
    const plan = await planShelves(req({ text: "algo doce", need: "algo doce" }), { deps });
    assert.equal(plan.source, "ai");
    assert.deepEqual(plan.picks.map((p) => p.shelfId), ["doces.sorvete", "doces.bolo"]);
  });

  it("sintoma: picks da IA fora de mip/care são filtrados e a mipClass da tabela é injetada", async () => {
    process.env.LIA_MEDICINE_MIP = "true";
    __setPlanShelvesForTests(async () => ({
      picks: [
        { shelfId: "doces.chocolate", query: "chocolate", why: "conforto" },
        { shelfId: "farmacia.antigases", query: "simeticona", why: "alivia gases" },
        { shelfId: "farmacia.soro", query: "soro", why: "hidrata" }
      ],
      source: "ai"
    }));
    const plan = await planShelves(req({ text: "tô com dor de barriga", need: "dor de barriga", symptom: "dor de barriga" }), { deps });
    assert.equal(plan.source, "ai");
    assert.deepEqual(plan.picks.map((p) => p.shelfId), ["farmacia.antigases", "farmacia.soro"]);
    assert.equal(plan.picks[0].mipClass, "antigases");
  });

  it("sinal de alerta sai ANTES da IA (a IA nem é chamada)", async () => {
    let called = false;
    __setPlanShelvesForTests(async () => {
      called = true;
      return null;
    });
    const plan = await planShelves(req({ text: "diarreia com sangue há 3 dias", need: "diarreia", symptom: "diarreia" }), { deps });
    assert.equal(plan.redFlag, "sangue nas fezes");
    assert.equal(plan.picks.length, 0);
    assert.equal(called, false);
  });

  it("IA fora e tabela sem entrada → plano vazio (nunca lança)", async () => {
    __setPlanShelvesForTests(async () => {
      throw new Error("boom");
    });
    const plan = await planShelves(req({ text: "algo pra viagem", need: "algo pra viagem" }), { deps });
    assert.deepEqual(plan, { picks: [], source: "table" });
  });

  it("validatePlanPicks: dedupe, query vazia fora, teto 6; sanitizeWhy derruba promessa", () => {
    const ids = new Set(MAP.shelves.map((s) => s.id));
    const picks = validatePlanPicks(
      [
        { shelfId: "doces.chocolate", query: "chocolate", why: "cura a fome garantido", mipClass: "" },
        { shelfId: "doces.chocolate", query: "bombom", why: "", mipClass: "" },
        { shelfId: "doces.sorvete", query: "  ", why: "", mipClass: "" }
      ],
      ids
    );
    assert.deepEqual(picks, [{ shelfId: "doces.chocolate", query: "chocolate", why: "" }]);
    assert.equal(sanitizeWhy("alivia cólica."), "alivia cólica");
  });
});

const doceRequest = (over: Partial<RecommendRequest> = {}) => req({ text: "algo doce", need: "algo doce", ...over });
const docePlan: ShelfPlan = {
  picks: [
    { shelfId: "doces.chocolate", query: "chocolate", why: "pronto pra comer" },
    { shelfId: "doces.sorvete", query: "sorvete", why: "doce e gelado" },
    { shelfId: "doces.bolo", query: "bolo pronto", why: "fatia na hora" }
  ],
  source: "table"
};

describe("recomendação — JULGAR por regras", () => {
  const candidates: ShelfCandidate[] = [
    cand("doces.chocolate", "c-barato", "Chocolate Genérico 80g", { unitPrice: 3.5, etaMinutes: 300 }, 40),
    cand("doces.chocolate", "c-lider", "Chocolate Lacta ao Leite 90g", { brand: "Lacta", unitPrice: 7.9, etaMinutes: 2000 }, 1),
    cand("doces.chocolate", "c-rapido", "Chocolate Garoto 90g", { brand: "Garoto", unitPrice: 6.5, etaMinutes: 90, verified: true }, 5),
    cand("doces.chocolate", "c-zero", "Chocolate Zero Açúcar 80g", { unitPrice: 9.9, etaMinutes: 400 }, 20),
    cand("doces.sorvete", "s-1", "Sorvete Kibon Pote 1,5L", { brand: "Kibon", unitPrice: 25, etaMinutes: 60 }, 2),
    cand("doces.sorvete", "s-2", "Sorvete Marca Própria 2L", { unitPrice: 15, etaMinutes: 120 }, 10),
    cand("doces.bolo", "b-1", "Bolo Pronto de Cenoura Integral", { unitPrice: 12, etaMinutes: 30 }, 8),
    cand("doces.bolo", "b-2", "Bolo Pronto de Chocolate", { unitPrice: 11, etaMinutes: 45 }, 3)
  ];
  const input = (over: Partial<RecommendRequest>, cands = candidates, plan = docePlan): FitnessInput => ({ request: doceRequest(over), plan, candidates: cands });

  it("1 card por prateleira; nunca sku fora dos candidatos", () => {
    const v = judgeFitnessByRules(input({}), deps);
    assert.equal(v.source, "rule");
    assert.deepEqual(v.cards.map((c) => c.shelfId).sort(), ["doces.bolo", "doces.chocolate", "doces.sorvete"]);
    const skus = new Set(candidates.map((c) => c.option.sku));
    assert.ok(v.cards.every((c) => skus.has(c.sku) && c.storeKey === "a"));
  });

  it("good → o mais vendido (popularidade), não o mais barato", () => {
    const v = judgeFitnessByRules(input({ criteria: ["good"] }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.chocolate")?.sku, "c-lider");
    assert.deepEqual(v.cards.map((c) => c.shelfId), ["doces.chocolate", "doces.sorvete", "doces.bolo"]);
  });

  it("good sem popularidade → marca e preço médio-alto, nunca o mais barato", () => {
    const noPop = candidates.filter((c) => c.shelfId === "doces.chocolate").map((c) => ({ ...c, popularity: undefined }));
    const v = judgeFitnessByRules(input({ criteria: ["good"] }, noPop), deps);
    assert.notEqual(v.cards[0].sku, "c-barato");
    assert.ok(["c-lider", "c-rapido"].includes(v.cards[0].sku));
  });

  it("cheap → o menor preço por prateleira, motivo do plano", () => {
    const v = judgeFitnessByRules(input({ criteria: ["cheap"] }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.chocolate")?.sku, "c-barato");
    assert.equal(v.cards.find((c) => c.shelfId === "doces.sorvete")?.sku, "s-2");
  });

  it("fast → menor prazo por prateleira; cards prontos-pra-comer primeiro e por prazo; motivo = prazo real", () => {
    const v = judgeFitnessByRules(input({ criteria: ["fast"] }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.chocolate")?.sku, "c-rapido");
    // sorvete (ready, 60 min) → chocolate (ready, 90 min) → bolo (sem flag ready, 30 min)
    assert.deepEqual(v.cards.map((c) => c.shelfId), ["doces.sorvete", "doces.chocolate", "doces.bolo"]);
    assert.equal(v.cards[0].why, "chega em 1h");
    assert.equal(v.cards[2].why, "chega em 30 min");
  });

  it("urgência sem critério também ordena por prazo", () => {
    const v = judgeFitnessByRules(input({ urgency: true }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.chocolate")?.sku, "c-rapido");
  });

  it("healthy → versão integral/zero primeiro", () => {
    const v = judgeFitnessByRules(input({ criteria: ["healthy"] }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.chocolate")?.sku, "c-zero");
    assert.equal(v.cards.find((c) => c.shelfId === "doces.bolo")?.sku, "b-1");
  });

  it("restrição filtra por palavra: 'sem chocolate' tira chocolate até no bolo; prateleira sem candidato some", () => {
    const v = judgeFitnessByRules(input({ constraints: ["sem chocolate"], criteria: ["good"] }), deps);
    assert.ok(!v.cards.some((c) => c.shelfId === "doces.chocolate"));
    assert.equal(v.cards.find((c) => c.shelfId === "doces.bolo")?.sku, "b-1");
  });

  it("orçamento total corta o que estoura (preço + frete)", () => {
    const v = judgeFitnessByRules(input({ budget: 20, criteria: ["good"] }), deps);
    assert.equal(v.cards.find((c) => c.shelfId === "doces.sorvete")?.sku, "s-2");
  });

  it("sintoma → ordem das classes do plano; apresentação básica antes da extensão de linha", () => {
    process.env.LIA_MEDICINE_MIP = "true";
    const plan: ShelfPlan = {
      picks: [
        { shelfId: "farmacia.antidiarreico", query: "loperamida | Imosec", why: "segura a diarreia", mipClass: "antidiarreico" },
        { shelfId: "farmacia.antigases", query: "simeticona | Luftal", why: "alivia gases", mipClass: "antigases" }
      ],
      source: "table"
    };
    const cands = [
      cand("farmacia.antigases", "g-max", "Luftal Max 125mg 10 Cápsulas", { brand: "Luftal", unitPrice: 20, medicine: "mip", storeKey: "f" }, 1),
      cand("farmacia.antigases", "g-base", "Luftal 40mg 20 Comprimidos", { brand: "Luftal", unitPrice: 15, medicine: "mip", storeKey: "f" }, 2),
      cand("farmacia.antidiarreico", "d-1", "Imosec 2mg 12 Comprimidos", { brand: "Imosec", unitPrice: 18, medicine: "mip", storeKey: "f" }, 1)
    ];
    const v = judgeFitnessByRules({ request: req({ text: "dor de barriga", need: "dor de barriga", symptom: "dor de barriga" }), plan, candidates: cands }, deps);
    assert.deepEqual(v.cards.map((c) => c.sku), ["d-1", "g-base"]);
    assert.equal(v.cards[1].why, "alivia gases");
    assert.equal(v.cards[1].storeKey, "f");
  });

  it("remédio com a porta fechada nunca vira card", () => {
    delete process.env.LIA_MEDICINE_MIP;
    const plan: ShelfPlan = { picks: [{ shelfId: "farmacia.antigases", query: "simeticona", why: "alivia gases", mipClass: "antigases" }], source: "table" };
    const v = judgeFitnessByRules({ request: req({ text: "gases", symptom: "gases" }), plan, candidates: [cand("farmacia.antigases", "g", "Luftal 40mg", { medicine: "mip" })] }, deps);
    assert.equal(v.cards.length, 0);
  });

  it("constraintRules/violatesConstraint: versão declarada 'zero lactose' passa", () => {
    const rules = constraintRules(["sem lactose"]);
    assert.equal(violatesConstraint("Leite Integral Italac 1L", rules), true);
    assert.equal(violatesConstraint("Leite Zero Lactose Piracanjuba 1L", rules), false);
    assert.equal(violatesConstraint("Biscoito de Polvilho", rules), false);
    assert.equal(violatesConstraint("Bis Xtra Ao Leite", constraintRules(["sem chocolate"])), true);
  });
});

describe("recomendação — judgeFitness (IA por costura + validação)", () => {
  const candidates = [
    cand("doces.chocolate", "c1", "Chocolate Lacta 90g", { brand: "Lacta" }, 1),
    cand("doces.sorvete", "s1", "Sorvete Kibon 1,5L", { brand: "Kibon" }, 1)
  ];
  const input: FitnessInput = { request: doceRequest(), plan: docePlan, candidates };

  it("IA devolvendo sku inexistente → regras", async () => {
    __setJudgeFitnessForTests(async () => ({ cards: [{ shelfId: "doces.chocolate", sku: "nao-existe", storeKey: "a", why: "x" }], source: "ai" }));
    const v = await judgeFitness(input, deps);
    assert.equal(v.source, "rule");
    assert.deepEqual(v.cards.map((c) => c.sku), ["c1", "s1"]);
  });

  it("IA devolvendo 0 cards com candidatos → regras", async () => {
    __setJudgeFitnessForTests(async () => ({ cards: [], source: "ai" }));
    const v = await judgeFitness(input, deps);
    assert.equal(v.source, "rule");
    assert.equal(v.cards.length, 2);
  });

  it("IA válida → fica a ordem e o motivo dela; repetição de prateleira cai; motivo vazio herda o do plano", async () => {
    __setJudgeFitnessForTests(async () => ({
      cards: [
        { shelfId: "doces.sorvete", sku: "s1", storeKey: "a", why: "marca líder" },
        { shelfId: "doces.sorvete", sku: "s1", storeKey: "a", why: "dup" },
        { shelfId: "doces.chocolate", sku: "c1", storeKey: "a", why: "" }
      ],
      source: "ai"
    }));
    const v = await judgeFitness(input, deps);
    assert.equal(v.source, "ai");
    assert.deepEqual(v.cards, [
      { shelfId: "doces.sorvete", sku: "s1", storeKey: "a", why: "marca líder" },
      { shelfId: "doces.chocolate", sku: "c1", storeKey: "a", why: "pronto pra comer" }
    ]);
  });

  it("IA que escolhe candidato que fere restrição → card cai", async () => {
    __setJudgeFitnessForTests(async () => ({
      cards: [
        { shelfId: "doces.chocolate", sku: "c1", storeKey: "a", why: "o mais vendido" },
        { shelfId: "doces.sorvete", sku: "s1", storeKey: "a", why: "gelado" }
      ],
      source: "ai"
    }));
    const v = await judgeFitness({ ...input, request: doceRequest({ constraints: ["sem chocolate"] }) }, deps);
    assert.deepEqual(v.cards.map((c) => c.sku), ["s1"]);
  });

  it("sem candidatos → vazio, sem chamar a IA", async () => {
    let called = false;
    __setJudgeFitnessForTests(async () => {
      called = true;
      return null;
    });
    const v = await judgeFitness({ ...input, candidates: [] }, deps);
    assert.deepEqual(v, { cards: [], source: "rule" });
    assert.equal(called, false);
  });
});
