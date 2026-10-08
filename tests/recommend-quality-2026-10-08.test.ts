// Rodada de QUALIDADE da recomendação (08/10/2026, noite): um teste por conserto, sem rede e sem banco.
// Placar de referência: scripts/bench-recommend.mts (linha de base final-r2: atende 73,5%, card errado
// 23,1%, restrição 81,3%, motivo verdadeiro 58,5%). Mapa/tabelas FAKE onde o conteúdo real muda.
import "./helpers/load-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributeRules,
  baseProductName,
  dietProofWhy,
  fastEtaCutoff,
  keepProvenAttributes,
  meetsAttributes,
  naturalDietWhy,
  provenAttributeWhy,
  shelfAtRisk,
  whyClaimsUnproven,
  parseConstraint,
  shelfSanityOk,
  violatesRule,
  whyIsFactual,
  withDietQueries,
  withPetCondition
} from "../src/lib/recommend/quality";
import { constraintRules, defaultTableDeps, eligibleCandidates, needEntryFor, normalizeRecommendRequest, planShelves, planShelvesFromTables, tableDepsFrom, violatesConstraint, wantsCold } from "../src/lib/recommend/fallback";
import { __setPlanShelvesForTests } from "../src/lib/recommend/ai";
import { applyHeadcount, askedMinutes, capPerStore, finalizeWhys, fitKitBudget, isHungerAsk, isStateAsk, productTypeOnly, quickOnly, withDeliveryNotes } from "../src/lib/recommend/handle";
import { biggerPackIndex, headcountOf, headcountPlan, requestHeadcount, sizeOf, suggestQuantity } from "../src/lib/recommend/quantity";
import * as copy from "../src/lib/lia-copy";
import { findNeed, findRedFlag, findSymptom } from "../src/lib/recommend/tables";
import { noteShopperCep, runShopperScoped, storesForShopper } from "../src/lib/store-areas";
import type { ChoiceOption } from "../src/lib/conversation-types";
import type { RecommendCard, RecommendRequest, ShelfCandidate, ShelfMap, ShelfPlan, SymptomTableEntry } from "../src/lib/recommend/types";

function req(over: Partial<RecommendRequest>): RecommendRequest {
  return { form: "need", text: "", criteria: [], constraints: [], source: "regex", ...over };
}
function opt(sku: string, name: string, over: Partial<ChoiceOption> = {}): ChoiceOption {
  return { sku, name, unitPrice: 10, storeKey: "a", ...over };
}
function cand(shelfId: string, sku: string, name: string, over: Partial<ChoiceOption> = {}, popularity?: number): ShelfCandidate {
  return { shelfId, option: opt(sku, name, over), ...(popularity != null ? { popularity } : {}) };
}
const rule = (c: string) => parseConstraint(c)!;

describe("causa 1 — loja regional fora do escopo do turno (churrasco/café da manhã sem carne nem pão)", () => {
  it("dentro do escopo sem CEP anotado, Mambo/Swift somem; com o CEP anotado (runChain faz), voltam", async () => {
    process.env.LIA_AUTO_PURCHASE_STORES = "mambo,swift,drogal";
    const stores = [{ key: "mambo" }, { key: "swift" }, { key: "drogal" }];
    const semCep = await runShopperScoped(async () => storesForShopper(stores).map((s) => s.key));
    assert.deepEqual(semCep, ["drogal"]);
    const comCep = await runShopperScoped(async () => {
      noteShopperCep("01310100");
      return storesForShopper(stores).map((s) => s.key);
    });
    assert.deepEqual(comCep, ["mambo", "swift", "drogal"]);
  });
});

describe("causa 2 — restrição é dura: prova no nome ou prateleira que por natureza cumpre", () => {
  it("sem lactose: biscoito Alpino e iogurte comum saem; sorvete 'sem lactose' e suco passam", () => {
    const r = rule("sem lactose");
    assert.equal(violatesRule("Biscoito Recheado Nestlé Passatempo Sabor Alpino 90g", r, "doces.biscoito_doce"), true);
    assert.equal(violatesRule("Iogurte Grego Tradicional Vigor 90g", r, "frios.iogurte"), true);
    assert.equal(violatesRule("Picolé Kibon Tablito Sabor 3 Chocolates 61g", r, "doces.sorvete"), true);
    assert.equal(violatesRule("Sorvete Proteico Açaí Sem Lactose IcePro 150ml", r, "doces.sorvete"), false);
    assert.equal(violatesRule("Suco Del Valle Sabor Maçã 200ml", r, "bebidas.suco"), false);
    assert.equal(violatesRule("Leite em Pó Molico Zero Lactose 260g", r, "frios.leite"), false);
    // compatível com o contrato antigo (sem prateleira = só palavra que fere)
    assert.equal(violatesConstraint("Biscoito de Polvilho", constraintRules(["sem lactose"])), false);
  });

  it("sem glúten: amendoim japonês e Cheetos saem; castanha e pipoca passam; 'sem glúten' no rótulo passa", () => {
    const r = rule("sem glúten");
    assert.equal(violatesRule("Amendoim Japonês Mendorato Santa Helena 90g", r, "snacks.amendoim_castanhas"), true);
    assert.equal(violatesRule("Salgadinho Cheetos Onda Sabor Requeijão 105g", r, "snacks.salgadinho"), true);
    assert.equal(violatesRule("Castanha de Caju Iracema 50g", r, "snacks.amendoim_castanhas"), false);
    assert.equal(violatesRule("Pipoca Premium Yoki 400g", r, "snacks.salgadinho"), false);
    assert.equal(violatesRule("Biscoito de Arroz Sem Glúten Camil", r, "snacks.biscoito_salgado"), false);
  });

  it("vegano e vegetariano: trufa e hot pocket saem; fruta, feijão e pizza de mussarela (vegetariano) passam", () => {
    const vegan = rule("vegano");
    assert.equal(violatesRule("Minitrufa Amarga Frutas Vermelhas 12G", vegan, "doces.chocolate"), true);
    assert.equal(violatesRule("Banana Prata (unidade ~190 g)", vegan, "hortifruti.frutas"), false);
    assert.equal(violatesRule("Feijão Carioca Tipo 1 Camil 1kg", vegan, "mercado.feijao"), false);
    const veg = rule("vegetariano");
    assert.equal(veg.kind, "vegetarian");
    assert.equal(violatesRule("Sanduiche Hot Pocket X-Bacon Sadia 145g", veg, "lanches.sanduiche"), true);
    assert.equal(violatesRule("Pizza de Mussarela Congelada Seara 220g", veg, "congelados.pizza"), false);
    assert.equal(violatesRule("Pizza Calabresa com Queijo Seara", veg, "congelados.pizza"), true);
    assert.equal(violatesRule("Iogurte Grego Vigor", veg, "frios.iogurte"), false);
  });

  it("'sem X' vira a família: porco, álcool, dipirona, cafeína, amendoim, zero açúcar", () => {
    const porco = rule("sem porco");
    assert.equal(violatesRule("Picanha Suína Temperada Prieto Kg", porco), true);
    assert.equal(violatesRule("Linguiça Toscana Sadia", porco), true);
    assert.equal(violatesRule("Picanha Swift Legado 1855", porco), false);
    assert.equal(violatesRule("Linguiça de Frango Seara", porco), false);
    const alcool = rule("sem bebida alcoólica");
    assert.equal(violatesRule("Cerveja Lager Heineken Lata 350ml", alcool), true);
    assert.equal(violatesRule("Vinho Tinto Malbec 750ml", alcool), true);
    assert.equal(violatesRule("Cerveja Heineken Sem Álcool 0,0 350ml", alcool), false);
    const dipirona = rule("sem dipirona (alergia)");
    assert.equal(violatesRule("Novalgina 1g 10 Comprimidos", dipirona), true);
    assert.equal(violatesRule("Dorflex 36 Comprimidos", dipirona), true);
    assert.equal(violatesRule("Paracetamol 750mg Genérico Cimed", dipirona), false);
    const cafeina = rule("sem cafeína");
    assert.equal(violatesRule("Chá Preto Leão 16g", cafeina), true);
    assert.equal(violatesRule("Café Solúvel Descafeinado Nescafé", cafeina), false);
    assert.equal(violatesRule("Chá Leão Camomila 10 Sachês", cafeina), false);
    assert.equal(violatesRule("Paçoca Rolha Amor 20 Unidades", rule("nada de amendoim")), true);
    const acucar = rule("zero açúcar");
    assert.equal(acucar.kind, "sugar");
    assert.equal(violatesRule("Chocolate Lacta ao Leite 90g", acucar, "doces.chocolate"), true);
    assert.equal(violatesRule("Chocolate Zero Açúcar Hershey's 82g", acucar, "doces.chocolate"), false);
    assert.equal(violatesRule("Iogurte Natural Zero Lactose", acucar, "frios.iogurte"), true);
  });

  it("pick com alternativas: 'sem dipirona' tira só a dipirona da busca do analgésico", () => {
    process.env.LIA_MEDICINE_MIP = "true";
    const map: ShelfMap = {
      generatedAt: "t",
      shelves: [
        { id: "farmacia.analgesico", label: "Analgésicos", domain: "farmacia", query: "paracetamol", stores: ["f"], flags: ["mip"] },
        { id: "farmacia.anti_inflamatorio", label: "Anti-inflamatórios", domain: "farmacia", query: "ibuprofeno", stores: ["f"], flags: ["mip"] }
      ]
    };
    const SYMPTOM: SymptomTableEntry[] = [
      {
        keys: ["dor de cabeca"],
        picks: [
          { shelfId: "farmacia.analgesico", query: "dipirona | paracetamol | neosaldina", why: "alivia a dor", mipClass: "analgesico" },
          { shelfId: "farmacia.anti_inflamatorio", query: "ibuprofeno | advil", why: "alivia dor e inflamação", mipClass: "anti_inflamatorio" }
        ]
      }
    ];
    const deps = tableDepsFrom(map, { NEED_TABLE: [], SYMPTOM_TABLE: SYMPTOM, RED_FLAGS: [] });
    const plan = planShelvesFromTables(req({ text: "dor de cabeça, sou alérgica a dipirona", symptom: "dor de cabeça", constraints: ["sem dipirona (alergia)"] }), deps);
    assert.deepEqual(plan?.picks.map((p) => [p.shelfId, p.query]), [["farmacia.analgesico", "paracetamol"], ["farmacia.anti_inflamatorio", "ibuprofeno | advil"]]);
    const semIbu = planShelvesFromTables(req({ text: "dor de cabeça", symptom: "dor de cabeça", constraints: ["sem ibuprofeno"] }), deps);
    assert.deepEqual(semIbu?.picks.map((p) => p.shelfId), ["farmacia.analgesico"]);
  });

  it("eligibleCandidates aplica a prova por prateleira", () => {
    const input = {
      request: req({ text: "algo gelado e doce sem lactose", constraints: ["sem lactose"] }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [
        cand("doces.biscoito_doce", "b1", "Biscoito Recheado Passatempo Alpino 90g"),
        cand("doces.sorvete", "s1", "Sorvete Açaí Sem Lactose IcePro 150ml"),
        cand("bebidas.agua_coco", "a1", "Água de Coco Sococo 200ml")
      ]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["s1", "a1"]);
  });
});

describe("causa 3 — produto julgado: o tipo e o atributo pedidos", () => {
  it("cacheado tira anticaspa; coador tira copo/cápsula/solúvel; dente sensível tira clareadora comum", () => {
    const cache = attributeRules(["cabelo cacheado"]);
    assert.equal(meetsAttributes("Widi Care Higienizando a Juba - Shampoo 500ml", cache), true);
    assert.equal(meetsAttributes("Shampoo Vichy Dercos Anticaspa Cabelos Cacheados", cache), false);
    const coador = attributeRules(["coador"]);
    assert.equal(meetsAttributes("Café Torrado e Moído Tradicional Pilão 500g", coador), true);
    assert.equal(meetsAttributes("Eco Copo Café Kopenhagen 450ml", coador), false);
    assert.equal(meetsAttributes("Cápsulas Dolce Gusto Cappuccino", coador), false);
    const sens = attributeRules(["dentes sensíveis"]);
    assert.equal(meetsAttributes("Creme Dental Sensodyne Rápido Alívio", sens), true);
    assert.equal(meetsAttributes("Creme Dental Tripla Ação Menta Original Colgate 90g", sens), false);
    assert.deepEqual(attributeRules(["orçamento total até R$ 80", "sem lactose"]), []);
  });

  it("eligibleCandidates no produto julgado: com algum candidato que cumpre o atributo, só ele fica", () => {
    const input = {
      request: req({ form: "product_judged", text: "qual pasta de dente é boa pra dente sensível", product: "creme dental dente sensível", constraints: ["dentes sensíveis"] }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [
        cand("higiene.creme_dental", "c1", "Creme Dental Sensodyne Clinical Repair Dentes Sensíveis 100g"),
        cand("higiene.creme_dental", "c2", "Creme Dental Close Up Dentes + Brancos 90g")
      ]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["c1"]);
  });

  it("productTypeOnly: shampoo pra cacheado tira anticaspa, kit e infantil (se sobrar shampoo de adulto)", () => {
    const r = req({ form: "product_judged", text: "qual o melhor shampoo pra cabelo cacheado", product: "shampoo cabelo cacheado", constraints: ["cabelo cacheado"] });
    const cands = [
      cand("beleza.shampoo", "1", "Widi Care Higienizando a Juba - Shampoo 500ml"),
      cand("beleza.shampoo", "2", "Shampoo Infantil Baby Dove Hidratação Cabelos Cacheados"),
      cand("beleza.shampoo", "3", "Lola Cosmetics Kit - Máscara + Shampoo Cacheados"),
      cand("beleza.shampoo", "4", "Refil Shampoo Anticaspa DS Vichy Dercos Cabelos Cacheados"),
      cand("beleza.shampoo", "5", "Shampoo Salon Line Cachos Definidos 300ml")
    ];
    assert.deepEqual(productTypeOnly(r, cands).map((c) => c.option.sku), ["1", "5"]);
    const kid = req({ form: "product_judged", text: "shampoo pro meu filho cacheado", product: "shampoo infantil cacheado", constraints: ["cabelo cacheado"] });
    assert.ok(productTypeOnly(kid, cands).some((c) => c.option.sku === "2"));
  });

  it("mesmo produto em outro pacote não é opção diferente", () => {
    assert.equal(baseProductName("Fraldas Pampers Premium Care Recém-Nascido RN 36 Unidades"), baseProductName("Fralda Pampers Premium Care Recém-Nascido RN 20 Unidades").replace(/^fralda /, "fraldas "));
    assert.notEqual(baseProductName("Fralda Huggies Rápida Absorção Recém Nascido P 38 Unidades"), baseProductName("Fralda Pampers Premium Care RN 20"));
  });
});

describe("causa 4 — o item é do tipo da prateleira", () => {
  it("hortifrúti sem Ruffles/Gatorade/trufa; café sem copo; carvão sem churrasqueira elétrica", () => {
    assert.equal(shelfSanityOk("hortifruti.legumes", "Batata Ruffles Elma Chips Sabor Original 33g"), false);
    assert.equal(shelfSanityOk("hortifruti.frutas", "Gatorade Frutas Cítricas 500ml"), false);
    assert.equal(shelfSanityOk("hortifruti.frutas", "Minitrufa Amarga Frutas Vermelhas 12G"), false);
    assert.equal(shelfSanityOk("hortifruti.frutas", "Banana Prata (unidade ~190 g)"), true);
    assert.equal(shelfSanityOk("hortifruti.legumes", "Batata Doce Rosada kg"), true);
    assert.equal(shelfSanityOk("hortifruti.legumes", "Brócolis Congelado Pratigel 300g"), true);
    assert.equal(shelfSanityOk("mercado.cafe", "Eco Copo Café Kopenhagen 450ml"), false);
    assert.equal(shelfSanityOk("mercado.cafe", "Café Torrado e Moído Pilão 500g"), true);
    assert.equal(shelfSanityOk("casa.churrasco", "Churrasqueira Elétrica Philco PCQ1500D 127V"), false);
    assert.equal(shelfSanityOk("casa.churrasco", "Carvão Vegetal Swift 5kg"), true);
    assert.equal(shelfSanityOk("frios.iogurte", "Kit Aptanutri & Bepantol Fórmula Infantil Premium 3 800g"), false);
  });
});

describe("causa 5 — motivo (why) só com fato do card", () => {
  it("popularidade, liderança, prazo e comparação solta não são fato", () => {
    for (const bad of ["o mais vendido", "dos mais vendidos", "marca líder", "chega em 3h", "chega amanhã", "o mais em conta", "opções para sensibilidade", "marca reconhecida e bem vendida"]) {
      assert.equal(whyIsFactual(bad), false, bad);
    }
    for (const ok of ["zero lactose no rótulo", "pra assar na brasa", "alivia a cólica abdominal", "pote de 1,5 L pra dividir", "marca Kibon"]) {
      assert.equal(whyIsFactual(ok), true, ok);
    }
  });

  it("finalizeWhys: 'o mais em conta' só no mais barato; restrição provada vira o motivo; popularidade cai pro papel do plano", () => {
    const card = (shelfId: string, sku: string, name: string, unitPrice: number, why: string): RecommendCard => ({ sku, name, unitPrice, storeKey: "a", shelfId, why });
    const plan: ShelfPlan = {
      picks: [
        { shelfId: "doces.sorvete", query: "sorvete", why: "doce e gelado" },
        { shelfId: "bebidas.suco", query: "suco", why: "refrescante" },
        { shelfId: "doces.balas", query: "bala", why: "o doce mais pedido" }
      ],
      source: "ai"
    };
    const cards = [
      card("doces.sorvete", "s", "Sorvete Açaí Sem Lactose IcePro 150ml", 23.9, "o mais vendido"),
      card("bebidas.suco", "j", "Suco Del Valle Maçã 200ml", 5.09, "marca conhecida e mais vendido"),
      card("doces.balas", "b", "Bala de Goma Fini 90g", 7.99, "o mais em conta")
    ];
    const out = finalizeWhys(cards, req({ text: "algo gelado sem lactose", constraints: ["sem lactose"], criteria: ["cheap", "good"] }), plan);
    assert.equal(out[0].why, "zero lactose no rótulo");
    assert.equal(out[1].why, "o mais em conta dos 3");
    assert.equal(out[2].why, "");
    // preço não é o 1º critério: ninguém vira "o mais em conta"
    assert.ok(!finalizeWhys(cards, req({ text: "festa", criteria: ["good", "cheap"] }), plan).some((c) => c.why.startsWith("o mais em conta")));
    const remedio = finalizeWhys([{ ...card("farmacia.antigases", "r", "Simeticona 75mg", 7, "dos mais vendidos"), medicine: "mip" }], req({ symptom: "gases" }), {
      picks: [{ shelfId: "farmacia.antigases", query: "simeticona", why: "alivia gases e estufamento", mipClass: "antigases" }],
      source: "table"
    });
    assert.equal(remedio[0].why, "alivia gases e estufamento");
  });

  it("prova de dieta no nome vira motivo", () => {
    assert.equal(dietProofWhy("Leite Zero Lactose Piracanjuba", constraintRules(["sem lactose"])), "zero lactose no rótulo");
    assert.equal(dietProofWhy("Chocolate Diet Garoto 25g", constraintRules(["zero açúcar"])), "versão diet");
  });
});

describe("causa 6 — urgência: o que chega no dia antes do que leva um dia; até 2 cards por loja", () => {
  it("fastEtaCutoff: com item de 3h, o corte é 6h; sem nada abaixo de 12h, não corta", () => {
    assert.equal(fastEtaCutoff([180, 1260, 1440]), 360);
    assert.equal(fastEtaCutoff([30, 180]), 360);
    assert.equal(fastEtaCutoff([1260, 1440]), undefined);
    assert.equal(fastEtaCutoff([undefined]), undefined);
  });

  it("quickOnly tira o de amanhã sempre que há algo que chega no dia (plano de urgência é largo)", () => {
    const cands = [
      cand("snacks.salgadinho", "s1", "Doritos 32g", { etaMinutes: 180 }),
      cand("doces.biscoito_doce", "b1", "Negresco 90g", { etaMinutes: 180 }),
      cand("lanches.sanduiche", "h1", "Hot Pocket X-Burguer", { etaMinutes: 1260 })
    ];
    assert.deepEqual(quickOnly(cands).map((c) => c.option.sku), ["s1", "b1"]);
    const one = [cands[0], cands[2]];
    assert.deepEqual(quickOnly(one).map((c) => c.option.sku), ["s1"]);
    const slow = [cands[2]];
    assert.deepEqual(quickOnly(slow).map((c) => c.option.sku), ["h1"]);
  });

  it("fitKitBudget: kit com teto soma os cards + frete típico; presente (alternativas) não soma", () => {
    const card = (sku: string, unitPrice: number): RecommendCard => ({ sku, name: sku, unitPrice, storeKey: "a", shelfId: `s.${sku}`, why: "" });
    const kit = [card("racao", 66.9), card("tapete", 82.42), card("shampoo", 22.8), card("bola", 22.4)];
    assert.deepEqual(fitKitBudget(kit, req({ text: "ganhei um cachorro filhote, preciso de tudo, ate 200", budget: 200 })).map((c) => c.sku), ["racao", "tapete", "shampoo"]);
    assert.equal(fitKitBudget(kit, req({ text: "presente pro meu pai até 200", need: "presente", budget: 200 })).length, 4);
  });

  it("capPerStore: a 3ª da mesma loja vira a da outra loja na mesma prateleira", () => {
    const map: ShelfMap = { generatedAt: "t", shelves: [] };
    const td = tableDepsFrom(map, { NEED_TABLE: [], SYMPTOM_TABLE: [], RED_FLAGS: [] });
    const candidates = [
      cand("a.x", "1", "Água Lindoya", { storeKey: "drogal" }),
      cand("a.y", "2", "Suco Del Valle", { storeKey: "drogal" }),
      cand("a.z", "3", "Isotônico Gatorade", { storeKey: "drogal" }),
      cand("a.z", "4", "Isotônico Powerade", { storeKey: "mambo" })
    ];
    const cards = candidates.slice(0, 3).map((c) => ({ ...c.option, shelfId: c.shelfId, why: "" }));
    const input = { request: req({ text: "sede" }), plan: { picks: [], source: "table" } as ShelfPlan, candidates };
    const out = capPerStore(cards, input, td, false);
    assert.deepEqual(out.map((c) => `${c.storeKey}:${c.sku}`), ["drogal:1", "drogal:2", "mambo:4"]);
  });
});

describe("causa 7 — sintoma: classes diretas; 'tosse que não para' não é 'há dias'", () => {
  it("dor de barriga só antiespasmódico + antigases; gases só antigases; azia só antiácido; picada sem soro nasal", () => {
    assert.deepEqual(findSymptom("dor de barriga")!.picks.map((p) => p.shelfId), ["farmacia.antiespasmodico", "farmacia.antigases"]);
    assert.deepEqual(findSymptom("gases")!.picks.map((p) => p.shelfId), ["farmacia.antigases"]);
    assert.deepEqual(findSymptom("to com azia horrivel")!.picks.map((p) => p.shelfId), ["farmacia.antiacido"]);
    assert.deepEqual(findSymptom("comi demais")!.picks.map((p) => p.shelfId), ["farmacia.antiacido", "farmacia.hepatoprotetor", "farmacia.antigases"]);
    const picada = findSymptom("picada de mosquito cocando muito")!;
    assert.deepEqual([...picada.picks, ...(picada.care ?? [])].map((p) => p.shelfId), ["farmacia.antialergico", "farmacia.repelente"]);
    assert.ok(findSymptom("rinite alergica")!.picks.some((p) => p.shelfId === "farmacia.descongestionante"));
  });

  it("'tosse seca que não para' recomenda; 'diarreia que não para' e 'tosse que não passa' seguem alertando", () => {
    assert.equal(findRedFlag("tosse seca que nao para"), null);
    assert.equal(findSymptom("tosse seca que nao para")?.picks[0].shelfId, "farmacia.antitussigeno");
    assert.equal(findRedFlag("diarreia que nao para")?.reason, "há vários dias");
    assert.equal(findRedFlag("tosse que nao passa")?.reason, "há vários dias");
    assert.equal(findRedFlag("tosse faz uma semana")?.reason, "há vários dias");
  });
});

describe("corpus difícil (08/10, noite) — h28/h13 sem remédio, h11/h27 tópico de criança, h09 pet, h04 comida, h26/h17 motivo", () => {
  it("h28 'sem remédio': o plano do sintoma fica só no cuidado; candidato de remédio sai", async () => {
    process.env.LIA_MEDICINE_MIP = "true";
    __setPlanShelvesForTests(null);
    const plan = await planShelves(req({ text: "to com dor nas costas de ficar sentado o dia todo, sem remedio por favor", need: "dor nas costas", symptom: "dor nas costas", constraints: ["sem remedio"] }));
    assert.ok(plan.picks.length > 0);
    assert.ok(plan.picks.every((p) => !p.mipClass && !p.shelfId.startsWith("farmacia.")), plan.picks.map((p) => p.shelfId).join(","));
    const input = {
      request: req({ text: "dor nas costas sem remédio", constraints: ["sem remédio"] }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("farmacia.relaxante_muscular", "d", "Dorflex 36 Comprimidos", { medicine: "mip" }), cand("casa.almofada", "a", "Almofada de Apoio Lombar")]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["a"]);
  });

  it("h11/h27: assadura de bebê de 8 meses e piolho de filha de 10 anos NÃO alertam; febre de bebê alerta", async () => {
    process.env.LIA_MEDICINE_MIP = "true";
    __setPlanShelvesForTests(null);
    const assadura = await planShelves(req({ text: "meu bebe de 8 meses ta com assadura feia", need: "assadura no bebê de 8 meses", symptom: "assadura", recipient: "bebê de 8 meses" }));
    assert.equal(assadura.redFlag, undefined);
    assert.equal(assadura.picks[0]?.shelfId, "farmacia.pomada_assadura");
    const piolho = await planShelves(req({ text: "minha filha de 10 anos ta com piolho", need: "piolho", symptom: "piolho", recipient: "filha de 10 anos" }));
    assert.equal(piolho.redFlag, undefined);
    assert.deepEqual(piolho.picks.map((p) => p.shelfId), ["farmacia.piolho", "beleza.acessorios_cabelo"]);
    const febre = await planShelves(req({ text: "meu bebe de 8 meses ta com febre", need: "febre", symptom: "febre", recipient: "bebê" }));
    assert.ok(febre.redFlag);
  });

  it("h09: cachorro com pulga vira higiene pet; nenhuma prateleira de gente", async () => {
    __setPlanShelvesForTests(async () => ({ picks: [{ shelfId: "farmacia.repelente", query: "repelente para cachorro", why: "" }], source: "ai" }));
    const r = req({ form: "product_judged", text: "meu cachorro ta cheio de pulga, o que compro?", product: "cheio de pulga", recipient: "cachorro", criteria: ["good"] });
    const n = normalizeRecommendRequest(r);
    assert.equal(n.form, "need");
    const plan = await planShelves(r);
    __setPlanShelvesForTests(null);
    assert.ok(plan.picks.length > 0);
    assert.ok(plan.picks.every((p) => p.shelfId.startsWith("pet.")), plan.picks.map((p) => p.shelfId).join(","));
  });

  it("h04: 'o que posso comer' com refluxo não vira remédio; refluxo vira o que evitar", () => {
    const n = normalizeRecommendRequest(req({ text: "tenho refluxo, o que posso comer de noite sem passar mal?", need: "algo para comer de noite", symptom: "refluxo" }), defaultTableDeps());
    assert.equal(n.symptom, undefined);
    assert.ok(n.constraints.includes("sem café") && n.constraints.includes("sem chocolate"));
    const remedio = normalizeRecommendRequest(req({ text: "tenho refluxo, que remédio eu tomo?", symptom: "refluxo" }), defaultTableDeps());
    assert.equal(remedio.symptom, "refluxo");
  });

  it("h23: produto 'julgado' que é sintoma da tabela vira sintoma; h15/h01: sintoma só da tabela de necessidade vira necessidade", () => {
    const unha = normalizeRecommendRequest(req({ form: "product_judged", text: "to com unha encravada doendo, o que faço", product: "unha encravada doendo" }));
    assert.equal(unha.form, "need");
    assert.equal(unha.symptom, "unha encravada doendo");
    const queda = normalizeRecommendRequest(req({ text: "meu cabelo ta caindo muito, tem algo?", need: "queda de cabelo", symptom: "queda de cabelo" }));
    assert.equal(queda.symptom, undefined);
    const derm = normalizeRecommendRequest(req({ text: "to com dermatite atopica", need: "algo para dermatite atópica", symptom: "dermatite atópica" }));
    assert.equal(derm.symptom, undefined);
  });

  it("h26: motivo do atributo é o que o cliente disse (pele sensível ≠ dente sensível); h17: alergia avisa traços", () => {
    const plan: ShelfPlan = { picks: [{ shelfId: "beleza.protetor_solar", query: "protetor", why: "" }], source: "ai" };
    const c: RecommendCard = { sku: "p", name: "Protetor Solar Dauf Mineral Peles Sensíveis FPS50", unitPrice: 51, storeKey: "a", shelfId: "beleza.protetor_solar", why: "" };
    const out = finalizeWhys([c], req({ form: "product_judged", product: "protetor solar pele sensivel", constraints: ["pele sensível", "rosácea"] }), plan);
    assert.equal(out[0].why, "pra pele sensível");
    const s: RecommendCard = { sku: "s", name: "Salgadinho Doritos 32g", unitPrice: 5, storeKey: "a", shelfId: "snacks.salgadinho", why: "o mais vendido" };
    const alerg = finalizeWhys([s], req({ form: "product_judged", product: "salgadinho", constraints: ["sem amendoim"] }), plan);
    assert.match(alerg[0].why, /confira traços no rótulo/);
  });

  it("h24: orçamento é total — frete desconhecido conta R$ 10", () => {
    const input = {
      request: req({ text: "só tenho 20 reais", budget: 20 }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("doces.chocolate", "c", "Chocolate 90g", { unitPrice: 10.29 }), cand("doces.biscoito_doce", "b", "Biscoito 90g", { unitPrice: 2.95 }), cand("snacks.salgadinho", "f", "Salgadinho", { unitPrice: 12, freightFee: 0 })]
    };
    assert.deepEqual(eligibleCandidates(input).map((x) => x.option.sku), ["b", "f"]);
  });
});

describe("rodada q2 (08/10, noite) — achados do placar principal q2 e do difícil q1", () => {
  it("sintoma com critério rápido NÃO corta o remédio por prazo (dor de barriga ficava só com água de coco)", () => {
    // quickOnly só roda fora de sintoma: a regra mora em pickCards; aqui a prova é que o corte existe e
    // o remédio (1440 min) sairia dele.
    const cands = [cand("farmacia.antiespasmodico", "m", "Buscopan", { etaMinutes: 1440 }), cand("bebidas.agua_coco", "a", "Água de coco", { etaMinutes: 180 })];
    assert.deepEqual(quickOnly(cands).map((c) => c.option.sku), ["a"]);
  });

  it("busca de dieta leva a prova no nome na frente ('sorvete sem lactose' acha o IcePro)", () => {
    const rules = constraintRules(["sem lactose"]);
    assert.equal(withDietQueries("sorvete zero lactose", "doces.sorvete", rules), "sorvete sem lactose | sorvete zero lactose");
    assert.equal(withDietQueries("picanha", "carnes.bovina", rules), "picanha");
    assert.equal(withDietQueries("barra de cereal", "mercado.barra_cereal", constraintRules(["vegano"])), "barra de cereal vegano | barra de cereal");
  });

  it("natural vale pelo nome do produto: castanha passa, Doritos 'Queijo Nacho' não (celíaca)", () => {
    const g = parseConstraint("sem glúten")!;
    assert.equal(violatesRule("Castanha de Caju Iracema 50g", g, "snacks.amendoim_castanhas"), false);
    assert.equal(violatesRule("Salgadinho Queijo Nacho Doritos 32g", g, "snacks.salgadinho"), true);
  });

  it("vegano: 'Vegana ... ao Leite' fere mesmo com a palavra vegana", () => {
    const v = parseConstraint("vegano")!;
    assert.equal(violatesRule("Barra de Proteína Vegana Chocolate ao Leite 45g", v, "mercado.barra_cereal"), true);
    assert.equal(violatesRule("Barra de Proteína Vegana Amendoim 45g", v, "mercado.barra_cereal"), false);
    assert.equal(violatesRule("Cereal Matinal Nestlé KitKat Sabor Chocolate 300g", v, "mercado.cereal_matinal"), true);
  });

  it("sem cafeína tira achocolatado (Toddy)", () => {
    const c = parseConstraint("sem cafeína")!;
    assert.equal(violatesRule("Achocolatado em Pó Original Toddy 370g", c, "mercado.achocolatado"), true);
  });

  it("prateleira certa: lenço nasal fora dos umedecidos; pastilha de garganta fora do antisséptico; curativo de acne fora do curativo", () => {
    assert.equal(shelfSanityOk("bebe.lenco_umedecido", "Lenço Umedecido Nasal Ever Baby"), false);
    assert.equal(shelfSanityOk("bebe.lenco_umedecido", "Lenço Umedecido Huggies 48un"), true);
    assert.equal(shelfSanityOk("farmacia.antisseptico_cicatrizante", "Antisséptico e Anestésico para Garganta"), false);
    assert.equal(shelfSanityOk("farmacia.curativo", "Curativo Hidrocoloide Para Acnes e Espinhas"), false);
    assert.equal(shelfSanityOk("farmacia.curativo", "Curativo Band-Aid 40un"), true);
  });

  it("orçamento com folga: na prateleira que tem item que cabe com o frete típico, o que só cabe com frete mínimo sai", () => {
    const input = {
      request: req({ text: "presente até 100", budget: 100 }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [
        cand("beleza.perfume", "caro", "Perfume A", { unitPrice: 85, freightFee: 0 }),
        cand("beleza.perfume", "ok", "Perfume B", { unitPrice: 60, freightFee: 0 }),
        cand("presente.caneca", "so", "Caneca", { unitPrice: 85, freightFee: 0 })
      ]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["ok", "so"]);
  });

  it("pet: ração pro gato com problema nos rins é compra de ração, não alerta de bicho doente", () => {
    const r = req({ text: "raçao pro meu gato castrado que tem problema nos rins", need: "ração para gato castrado com problema nos rins", recipient: "gato", symptom: "problema nos rins" });
    const n = normalizeRecommendRequest(r, defaultTableDeps());
    assert.equal(n.symptom, undefined);
    const plan = planShelvesFromTables(n, defaultTableDeps());
    assert.equal(plan?.redFlag, undefined);
    const sick = planShelvesFromTables(req({ text: "meu gato ta vomitando e doente", need: "gato vomitando", symptom: "vomitando", recipient: "gato" }), defaultTableDeps())!;
    assert.ok(sick.redFlag);
  });

  it("jantar leve / comer de noite com refluxo: banana, iogurte natural, sopa, aveia, chá (sem castanha nem sanduíche)", () => {
    const n = normalizeRecommendRequest(req({ text: "tenho refluxo, o que posso comer de noite sem passar mal?", need: "algo para comer de noite sem passar mal", symptom: "refluxo" }), defaultTableDeps());
    const plan = planShelvesFromTables(n, defaultTableDeps())!;
    assert.ok(plan.picks.some((p) => p.shelfId === "frios.iogurte"));
    assert.ok(!plan.picks.some((p) => p.shelfId === "snacks.amendoim_castanhas" || p.shelfId === "lanches.sanduiche"));
    const gord = constraintRules(n.constraints);
    assert.equal(violatesConstraint("Castanha de Caju Torrada", gord, "snacks.amendoim_castanhas"), true);
  });

  it("q3: ração pro gato com rins/castrado leva a linha na frente da consulta; outras prateleiras ficam como estão", () => {
    assert.equal(withPetCondition("racao gato", "pet.racao_gato", "raçao pro meu gato castrado que tem problema nos rins"), "racao renal gato | racao gato castrado | racao gato");
    assert.equal(withPetCondition("shampoo", "pet.higiene", "gato com rins"), "shampoo");
  });

  it("q3: 'nada caro'/'barato' dito como restrição vira critério de preço; lenço íntimo e panettone saem da prateleira errada", () => {
    const n = normalizeRecommendRequest(req({ text: "lembrancinha pra professora, nada caro", need: "lembrancinha", constraints: ["barato"], criteria: ["good"] }), defaultTableDeps());
    assert.equal(n.criteria[0], "cheap");
    assert.equal(shelfSanityOk("bebe.lenco_umedecido", "Lenço Umedecido Íntimo K-Y"), false);
    assert.equal(shelfSanityOk("hortifruti.frutas", "Panettone Bauducco Frutas Cristalizadas 500g"), false);
    assert.equal(shelfSanityOk("hortifruti.ovos", "Tempero Fit Ovos BR Spices 55g"), false);
    assert.equal(shelfSanityOk("farmacia.antisseptico_cicatrizante", "Antisséptico Cystex 15mg"), false);
  });

  it("q3: pulga no cachorro usa a entrada da tabela (higiene pet) mesmo com a IA trazendo brinquedo", async () => {
    __setPlanShelvesForTests(null);
    const plan = await planShelves(req({ text: "meu cachorro ta cheio de pulga", need: "pulga no cachorro", recipient: "cachorro" }));
    assert.ok(plan.picks.length && plan.picks.every((p) => p.shelfId.startsWith("pet.")));
    assert.ok(!plan.picks.some((p) => p.shelfId === "pet.brinquedo"));
  });

  it("q5: alergia — processado só passa com 'sem amendoim' no rótulo; fruta e água passam; 'sem adição de açúcar' não é zero açúcar", () => {
    const a = parseConstraint("sem amendoim")!;
    assert.equal(violatesRule("Salgadinho Queijo Nacho Doritos 32g", a, "snacks.salgadinho"), true);
    assert.equal(violatesRule("Biscoito Água e Sal Adria 170g", a, "snacks.biscoito_salgado"), true);
    assert.equal(violatesRule("Salgadinho Sem Amendoim Nutty 40g", a, "snacks.salgadinho"), false);
    assert.equal(violatesRule("Maçã Turma da Mônica Pacote 1kg", a, "hortifruti.frutas"), false);
    assert.equal(violatesRule("Paçoca Santa Helena 20g", a, "hortifruti.frutas"), true);
    const z = parseConstraint("zero açúcar")!;
    assert.equal(violatesRule("Iogurte de Ameixa Sem Adição de Açúcar Batavo Pense Zero 170g", z, "frios.iogurte"), true);
    assert.equal(violatesRule("Refrigerante Coca-Cola Zero Açúcar 350ml", z, "bebidas.refrigerante"), false);
  });

  it("q6: castanha da Índia (remédio) fora do petisco; pulga só com 'pulga' no nome; bebê só com linha baby; alergia sem item = copy honesta", () => {
    assert.equal(shelfSanityOk("snacks.amendoim_castanhas", "Castanha da Índia Varivax 30 comprimidos"), false);
    assert.equal(shelfSanityOk("snacks.amendoim_castanhas", "Castanha de Caju Torrada 100g"), true);
    const pulga = eligibleCandidates({
      request: req({ need: "pulga no cachorro", text: "cachorro com pulga" }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("pet.higiene", "a", "Shampoo Cloresten Antifúngico"), cand("pet.higiene", "b", "Shampoo Antipulgas Pet Clean"), cand("pet.coleira", "c", "Coleira para Cachorro")]
    });
    // (q9) Agora o nome precisa dizer pulga/carrapato em TODA prateleira de higiene/coleira: a coleira sem a palavra sai.
    assert.deepEqual(pulga.map((c) => c.option.sku).sort(), ["b"]);
    const baby = productTypeOnly(req({ form: "product_judged", text: "repelente pra bebe", product: "repelente", recipient: "bebê" }), [
      cand("beleza.protetor_solar", "1", "Repelente Off Baby Gel"),
      cand("beleza.protetor_solar", "2", "Repelente SBP Baby Bebê"),
      cand("beleza.protetor_solar", "3", "Repelente Spray Above Protect")
    ]);
    assert.deepEqual(baby.map((c) => c.option.sku), ["1", "2"]);
    const none = copy.recommendNone({ form: "product_judged", product: "salgadinho", criteria: ["good"], constraints: ["sem amendoim"] });
    assert.match(none, /alergia a \*amendoim\*/);
    assert.match(none, /confira sempre o rótulo/);
  });

  it("q8: repelente de bebê não vira protetor solar bebê; criança de 10 anos não recebe livro magnético", () => {
    const baby = productTypeOnly(req({ form: "product_judged", text: "melhor repelente pra bebe", product: "repelente", recipient: "bebê" }), [
      cand("beleza.protetor_solar", "1", "Protetor Solar Bebê Granado"),
      cand("beleza.protetor_solar", "2", "Protetor Solar Granado Bebê"),
      cand("beleza.protetor_solar", "3", "Repelente Spray Above Protect"),
      cand("beleza.protetor_solar", "4", "Repelente Off Baby Gel")
    ]);
    assert.deepEqual(baby.map((c) => c.option.sku), ["3", "4"]);
    const kid = eligibleCandidates({
      request: req({ text: "presente pro meu sobrinho de 10 anos", recipient: "sobrinho de 10 anos" }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("brinquedo.infantil", "a", "Livro Magnético Infantil Princesas"), cand("brinquedo.carrinho", "b", "Carrinho Hot Wheels")]
    });
    assert.deepEqual(kid.map((c) => c.option.sku), ["b"]);
  });
});


// ===================================================================================================
// Rodada q9 (08/10/2026, noite) — principal q8 (atende 88,6%) e difícil q7 (atende 73,9%, card errado 19%)
// ===================================================================================================

function card(shelfId: string, sku: string, name: string, over: Partial<RecommendCard> = {}): RecommendCard {
  return { ...opt(sku, name), shelfId, why: "", ...over };
}

describe("q9 / causa 1 — quantidade por número de pessoas (r26 churrasco pra 12, r30 festa pra 15)", () => {
  it("headcountOf: 'pra 12', 'pra uns 15 amigos', 'somos oito'; idade, reais e kg não são gente", () => {
    assert.equal(headcountOf("vou fazer um churrasco pra 12, sem porco"), 12);
    assert.equal(headcountOf("festinha de aniversario pra 15 pessoas ate 300 reais"), 15);
    assert.equal(headcountOf("churras sábado pra uns 15 amigos"), 15);
    assert.equal(headcountOf("somos oito aqui"), 8);
    assert.equal(headcountOf("presente pra menino de 5 anos"), undefined);
    assert.equal(headcountOf("algo pra comer pra 20 reais"), undefined);
    assert.equal(headcountOf("churrasco pra 2"), undefined, "1–2 pessoas não pedem sugestão de quantidade");
    assert.equal(requestHeadcount(req({ text: "presente pra 4 amigos", need: "presente" })), undefined, "presente é alternativa, não kit");
    assert.equal(requestHeadcount(req({ text: "tosse pra 5 pessoas", symptom: "tosse" })), undefined);
  });

  it("churrasco pra 12: picanha de ~2,1 kg → 3 peças; carvão de 5 kg → 2 sacos; pão de alho → 3; refri 2 L → 3", () => {
    const plan = headcountPlan(req({ text: "vou fazer um churrasco pra 12", need: "churrasco pra 12 pessoas" }), ["carnes.bovina", "casa.churrasco"])!;
    assert.equal(plan.churrasco, true);
    assert.equal(suggestQuantity("carnes.bovina", { name: "Picanha Linha Mais de 1,1kg a 2,1kg (unidade ~2,1 kg)" }, plan)?.qty, 3);
    assert.equal(suggestQuantity("carnes.bovina", { name: "Picanha", unitWeightKg: 2.1 }, plan)?.qty, 3);
    assert.equal(suggestQuantity("casa.churrasco", { name: "Carvão Especial Vegetal Ecológico Momento Mambo 5kg" }, plan)?.qty, 2);
    assert.equal(suggestQuantity("casa.churrasco", { name: "Acendedor de Churrasco Gel 500ml" }, plan), null, "só carvão leva a regra do carvão");
    assert.equal(suggestQuantity("padaria.pao_de_alho", { name: "Pão de Alho Tradicional Santa Massa 400g" }, plan)?.qty, 3);
    assert.equal(suggestQuantity("bebidas.refrigerante", { name: "Refrigerante Coca-Cola Garrafa Pet 2 Litros" }, plan)?.qty, 3);
    const s = suggestQuantity("carnes.bovina", { name: "Picanha ~2,1 kg" }, plan)!;
    assert.match(s.text, /pra 12 pessoas, 3x/);
    // linguiça junto: a carne principal cai pra 300 g por pessoa
    const com = headcountPlan(req({ text: "churrasco pra 12", need: "churrasco pra 12" }), ["carnes.bovina", "carnes.linguica"])!;
    assert.equal(suggestQuantity("carnes.bovina", { name: "Alcatra 1kg" }, com)?.qty, 4, "12 × 300 g = 3,6 kg → 4 peças de 1 kg");
  });

  it("festa pra 15: bolo de 300 g → 5; salgadinho de 110 g → 5; sem tamanho no nome não chuta", () => {
    const plan = headcountPlan(req({ text: "festinha de aniversario pra 15 pessoas ate 300 reais", need: "festa de aniversário pra 15 pessoas", budget: 300 }), [])!;
    assert.equal(plan.churrasco, false);
    assert.equal(suggestQuantity("doces.bolo", { name: "Bolo de Laranja Panco 300g" }, plan)?.qty, 5);
    assert.equal(suggestQuantity("snacks.salgadinho", { name: "Salgadinho Tostitos 110g" }, plan)?.qty, 5);
    assert.equal(suggestQuantity("doces.bolo", { name: "Bolo Caseiro" }, plan), null);
    assert.equal(suggestQuantity("casa.descartaveis", { name: "Prato Raso Descartável Copobrás 17,5cm com 10 unidades" }, plan)?.qty, 2);
    assert.equal(sizeOf({ name: "Cerveja Lata 350ml 12 latas" }, "ml"), 4200);
  });

  it("bolo/torta maior da prateleira ganha do bolinho, mas kit e preço absurdo por grama não", () => {
    const small = { option: opt("1", "Bolo de Laranja Panco 300g", { unitPrice: 15 }) };
    const big = { option: opt("2", "Torta de Chocolate Confeitaria 1kg", { unitPrice: 45 }) };
    const kit = { option: opt("3", "Kit Presente Bolo Gourmet 1,5kg", { unitPrice: 90 }) };
    const pricey = { option: opt("4", "Bolo Artesanal Premium 1kg", { unitPrice: 190 }) };
    assert.equal(biggerPackIndex("doces.bolo", small, [small, big, kit, pricey]), big);
    assert.equal(biggerPackIndex("doces.bolo", small, [small, kit]), undefined);
    assert.equal(biggerPackIndex("casa.churrasco", small, [small, big]), undefined, "só prateleira de dividir (bolo, salgadinho, refri)");
  });

  it("applyHeadcount: card ganha suggestedQty e 'sugestão: Nx pra N pessoas'; orçamento total encolhe a quantidade", () => {
    const hp = headcountPlan(req({ text: "festa pra 15 pessoas até 100 reais", need: "festa pra 15 pessoas", budget: 100 }), [])!;
    const cards = [
      card("snacks.salgadinho", "s", "Salgadinho Tostitos 110g", { unitPrice: 8, why: "pacote de dividir", freightFee: 5 }),
      card("doces.bolo", "b", "Bolo de Laranja Panco 300g", { unitPrice: 15, freightFee: 5 })
    ];
    const free = applyHeadcount(cards, req({ text: "festa pra 15 pessoas", need: "festa pra 15 pessoas" }), hp);
    assert.deepEqual(free.map((c) => c.suggestedQty), [5, 5]);
    assert.match(free[0].why, /pacote de dividir — sugestão: pra 15 pessoas, 5x/);
    const capped = applyHeadcount(cards, req({ text: "festa pra 15 pessoas até 100 reais", need: "festa pra 15 pessoas", budget: 100 }), hp);
    const total = capped.reduce((sum, c) => sum + c.unitPrice * (c.suggestedQty ?? 1), 0) + 5;
    assert.ok(total <= 100, `total ${total}`);
    assert.ok(capped.every((c) => (c.suggestedQty ?? 1) >= 1));
  });
});

describe("q9 / causa 2 — fome pede refeição; orçamento de fome são alternativas, não kit", () => {
  it("a tabela de fome começa por macarrão instantâneo/sanduíche/prato pronto antes de petisco e é curada (sem IA)", () => {
    const fome = findNeed("to com fome")!;
    assert.equal(fome.curated, true);
    assert.deepEqual(fome.picks.slice(0, 3).map((p) => p.shelfId), ["mercado.macarrao_instantaneo", "lanches.sanduiche", "congelados.pratos_prontos"]);
    assert.ok(fome.picks.some((p) => p.shelfId === "hortifruti.frutas") && fome.picks.some((p) => p.shelfId === "snacks.amendoim_castanhas"), "cauda livre de restrição");
    assert.equal(findNeed("fome de doce")!.picks[0].shelfId, "doces.chocolate", "vontade específica de doce não vira refeição");
  });

  it("plano de fome sai da tabela sem chamar a IA", async () => {
    let called = 0;
    __setPlanShelvesForTests(async () => {
      called++;
      return { picks: [{ shelfId: "doces.chocolate", query: "chocolate", why: "" }], source: "ai" };
    });
    const plan = await planShelves(req({ text: "tô com muita fome", need: "fome", criteria: ["fast"], urgency: true }));
    __setPlanShelvesForTests(null);
    assert.equal(called, 0);
    assert.equal(plan.source, "table");
    assert.equal(plan.picks[0].shelfId, "mercado.macarrao_instantaneo");
  });

  it("restrição de dieta põe as prateleiras de risco DEPOIS das livres (h02: 'não posso comer leite' nunca zera)", () => {
    const plan = planShelvesFromTables(req({ text: "oq eu posso comer que chega agora? nao posso comer leite", need: "algo pra comer", constraints: ["sem leite"], criteria: ["fast"], urgency: true }), defaultTableDeps());
    const ids = plan!.picks.map((p) => p.shelfId);
    assert.deepEqual(ids.slice(0, 2), ["snacks.amendoim_castanhas", "hortifruti.frutas"]);
    assert.ok(shelfAtRisk({ kind: "lactose" }, "frios.iogurte") && !shelfAtRisk({ kind: "lactose" }, "hortifruti.frutas") && !shelfAtRisk({ kind: "word" }, "frios.iogurte"));
  });

  it("isHungerAsk e isStateAsk", () => {
    assert.equal(isHungerAsk(req({ text: "tô com muita fome", need: "fome" })), true);
    assert.equal(isHungerAsk(req({ text: "só tenho 20 reais e to com fome", need: "fome com 20 reais" })), true);
    assert.equal(isHungerAsk(req({ text: "fome de doce", need: "fome de doce" })), false);
    assert.equal(isHungerAsk(req({ text: "vou fazer um churrasco pra 12 e comer muito", need: "churrasco" })), false);
    assert.equal(isStateAsk(req({ text: "só tenho 20 reais e to com fome", need: "fome com 20 reais" })), true);
    assert.equal(isStateAsk(req({ text: "tô morrendo de sede", need: "sede" })), true);
    assert.equal(isStateAsk(req({ text: "filhote preciso de tudo até 200", need: "cachorro novo" })), false, "kit continua somando");
    assert.equal(isStateAsk(req({ text: "churrasco pra 12", need: "churrasco pra 12 pessoas" })), false);
  });

  it("sem restrição, o macarrão instantâneo sabor tomate prova vegetariano; sabor galinha não", () => {
    const veg = parseConstraint("vegetariano")!;
    assert.equal(violatesRule("Macarrão Instantâneo Nissin Turma da Mônica Sabor Tomate Suave 85g", veg, "mercado.macarrao_instantaneo"), false);
    assert.equal(violatesRule("Macarrão Instantâneo Nissin Lámen Sabor Galinha Caipira 85g", veg, "mercado.macarrao_instantaneo"), true);
  });
});

describe("q9 / causa 3 — atributo pedido que o nome precisa provar (h10 renal, h09 pulga)", () => {
  const ask = "raçao pro meu gato castrado que tem problema nos rins";
  it("ração renal: só quem diz renal fica; ração comum sai da prateleira", () => {
    const c = [
      cand("pet.racao_gato", "1", "Ração Golden Special Gatos Adultos Frango e Carne 10,1 kg"),
      cand("pet.racao_gato", "2", "Ração Fórmula Natural Vet Care Gatos Renal 1,5 kg"),
      cand("pet.racao_gato", "3", "Ração Vet Life Natural Feline Renal 400 g")
    ];
    assert.deepEqual(keepProvenAttributes(c, ask).map((x) => x.option.sku), ["2", "3"]);
    // sem nenhum que prove: atributo de saúde (strict) esvazia a prateleira — a Lia diz que não achou
    assert.deepEqual(keepProvenAttributes([c[0]], ask), []);
    // castrado (não strict) sozinho: sem prova, ficam todos (e o motivo não afirma "castrado")
    assert.deepEqual(keepProvenAttributes([c[0]], "ração pro meu gato castrado").map((x) => x.option.sku), ["1"]);
    assert.equal(provenAttributeWhy("Ração Vet Life Natural Feline Renal 400 g", ask), "linha renal, pra problema nos rins");
  });

  it("eligibleCandidates aplica: h09 shampoo antifúngico não é antipulgas", () => {
    const input = {
      request: req({ text: "meu cachorro ta cheio de pulga", need: "pulga no cachorro", recipient: "cachorro" }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("pet.higiene", "a", "Shampoo Cloresten Antifúngico e Bacteriano Dr.Clean Cães e Gatos 200 ml"), cand("pet.cama", "c", "Cama para Cachorro Pelúcia")]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["c"], "sem antipulgas na higiene, a prateleira sai; a cama não é do atributo");
    const ok = eligibleCandidates({ ...input, candidates: [...input.candidates, cand("pet.higiene", "b", "Shampoo e Condicionador Antipulgas Cães 3 em 1 Petbrilho 500 ml")] });
    assert.deepEqual(ok.map((c) => c.option.sku).sort(), ["b", "c"]);
  });

  it("motivo que afirma atributo sem prova no nome é descartado (h10, h09, 'sem lactose')", () => {
    assert.equal(whyClaimsUnproven("para gato castrado com problema renal", "Ração Golden Special Gatos Adultos 10,1 kg", "pet.racao_gato"), true);
    assert.equal(whyClaimsUnproven("para problema renal", "Ração Vet Care Gatos Renal 1,5 kg", "pet.racao_gato"), false);
    assert.equal(whyClaimsUnproven("banho ajuda a tirar as pulgas", "Shampoo Cloresten Antifúngico", "pet.higiene"), true);
    assert.equal(whyClaimsUnproven("sem lactose", "Biscoito Recheado Alpino 90g", "doces.biscoito_doce"), true);
    assert.equal(whyClaimsUnproven("doce e naturalmente sem lactose", "Maçã Turma da Mônica 1kg", "hortifruti.frutas"), false, "fruta é livre por natureza");
    assert.equal(whyClaimsUnproven("pronto pra comer", "Salgadinho Ruffles", "snacks.salgadinho"), false);
  });

  it("finalizeWhys: ração comum não sai com motivo renal; ração renal sai com o motivo provado", () => {
    const r = req({ form: "product_judged", text: ask, product: "ração gato castrado", criteria: ["good"] });
    const plan: ShelfPlan = { picks: [{ shelfId: "pet.racao_gato", query: "racao renal gato", why: "para gato castrado com problema renal" }], source: "ai" };
    const out = finalizeWhys(
      [card("pet.racao_gato", "1", "Ração Golden Special Gatos Adultos 10,1 kg", { why: "para gato castrado com problema renal" }), card("pet.racao_gato", "2", "Ração Vet Care Gatos Renal 1,5 kg")],
      r,
      plan
    );
    assert.equal(out[0].why, "");
    assert.equal(out[1].why, "linha renal, pra problema nos rins");
  });
});

describe("q9 / causa 4 — 'algo gelado' exige prateleira gelada; gelado e doce é sobremesa", () => {
  it("wantsCold só no pedido de algo gelado (não 'cerveja gelada' do churrasco)", () => {
    assert.equal(wantsCold(req({ text: "algo gelado e doce, sem lactose", need: "algo gelado e doce" })), true);
    assert.equal(wantsCold(req({ text: "quero um geladinho" })), true);
    assert.equal(wantsCold(req({ text: "churrasco com cerveja gelada", need: "churrasco" })), false);
  });

  it("plano de 'gelado e doce' vem da tabela curada: sorvete e iogurte antes de suco; fruta nunca", () => {
    const e = findNeed("algo gelado e doce sem lactose")!;
    assert.equal(e.curated, true);
    assert.deepEqual(e.picks.map((p) => p.shelfId), ["doces.sorvete", "frios.iogurte"], "suco e refrigerante não são sobremesa gelada");
    const plan = planShelvesFromTables(req({ text: "algo gelado e doce, sem lactose", need: "algo gelado e doce", constraints: ["sem lactose"] }), defaultTableDeps());
    const ids = plan!.picks.map((p) => p.shelfId);
    assert.ok(ids.includes("doces.sorvete"), "sorvete 'sem lactose' é buscado pela prova, não cortado pela palavra");
    assert.ok(!ids.includes("hortifruti.frutas"));
  });

  it("filterPicks: com 'algo gelado', prateleira sem a flag cold sai (maçã nunca é gelado)", () => {
    const map: ShelfMap = {
      generatedAt: "t",
      shelves: [
        { id: "hortifruti.frutas", label: "Frutas", domain: "mercado", query: "maca", stores: ["a"], flags: ["fresh"] },
        { id: "doces.sorvete", label: "Sorvetes", domain: "mercado", query: "sorvete", stores: ["a"], flags: ["cold"] }
      ]
    };
    const deps = tableDepsFrom(map, {
      NEED_TABLE: [{ keys: ["algo gelado"], picks: [{ shelfId: "hortifruti.frutas", query: "maca", why: "fruta" }, { shelfId: "doces.sorvete", query: "sorvete", why: "gelado" }] }],
      SYMPTOM_TABLE: [],
      RED_FLAGS: []
    });
    const plan = planShelvesFromTables(req({ text: "algo gelado", need: "algo gelado" }), deps);
    assert.deepEqual(plan!.picks.map((p) => p.shelfId), ["doces.sorvete"]);
  });

  it("nada gelado cumpre: a Lia diz isso (copy honesta)", () => {
    const none = copy.recommendNone({ form: "need", need: "algo gelado e doce", criteria: ["good"], constraints: ["sem lactose"] });
    assert.match(none, /nada \*gelado\* sem lactose/);
  });
});

describe("q9 / causa 5 e 6 — prazo honesto (sono 'até tarde', ressaca 'em 1 hora')", () => {
  it("withDeliveryNotes: em pedido urgente o card de amanhã diz o prazo; o mais rápido diz que não dá no prazo pedido", () => {
    const r = req({ text: "tô morrendo de sono e preciso estudar até tarde, chega agora?", criteria: ["fast"], urgency: true });
    const cards = [
      card("doces.chocolate", "a", "Chocolate Snickers 40g", { etaMinutes: 30, delivery: "prazo da loja: 30 min", why: "pronto pra comer" }),
      card("mercado.cafe", "b", "Café Torrado e Moído 500g", { etaMinutes: 1140, delivery: "prazo da loja: em até 19h (amanhã, 8h–11h)", why: "a cafeína ajuda a despertar" })
    ];
    const out = withDeliveryNotes(cards, r);
    assert.equal(out[0].why, "pronto pra comer");
    assert.equal(out[1].why, "a cafeína ajuda a despertar — só chega amanhã, 8h–11h");
    // sem urgência nada muda
    assert.deepEqual(withDeliveryNotes(cards, req({ text: "café", criteria: ["good"] })), cards);
  });

  it("h20 'chegue em 1 hora' sem ninguém em 1 h: só o MAIS rápido diz o prazo real", () => {
    assert.equal(askedMinutes("to de ressaca, algo que chegue em 1 hora"), 60);
    assert.equal(askedMinutes("preciso em meia hora"), 30);
    assert.equal(askedMinutes("quero pra hoje"), undefined);
    const r = req({ text: "to de ressaca, algo que chegue em 1 hora", criteria: ["fast"], urgency: true });
    const cards = [
      card("bebidas.isotonico", "a", "Isotônico 500ml", { etaMinutes: 180, delivery: "prazo da loja: 3h", why: "repõe sais" }),
      card("bebidas.agua", "b", "Água 900ml", { etaMinutes: 180, delivery: "prazo da loja: 3h", why: "hidratação" })
    ];
    const out = withDeliveryNotes(cards, r);
    assert.equal(out[0].why, "repõe sais — o mais rápido que achei chega em 3h");
    assert.equal(out[1].why, "hidratação");
    // alguém cumpre (30 min): sem nota
    assert.deepEqual(withDeliveryNotes([{ ...cards[0], etaMinutes: 30, delivery: "prazo da loja: 30 min" }], r)[0].why, "repõe sais");
  });

  it("ressaca: sem soro de reidratação oral (mip); isotônico, água de coco e água são o plano", () => {
    process.env.LIA_MEDICINE_MIP = "true";
    const e = findSymptom("to de ressaca")!;
    assert.deepEqual(e.picks, []);
    assert.deepEqual((e.care ?? []).map((p) => p.shelfId).slice(0, 3), ["bebidas.isotonico", "bebidas.agua_coco", "bebidas.agua"]);
    const plan = planShelvesFromTables(req({ text: "ressaca braba hj, me ajuda", need: "ressaca", criteria: ["fast"], urgency: true }), defaultTableDeps());
    assert.ok(plan!.picks.length >= 3 && plan!.picks.every((p) => !p.mipClass && p.shelfId !== "farmacia.hidratacao_oral"));
  });

  it("corte por prazo: conta só o que passa nas regras e pede 3 prateleiras rápidas fora de fome (quickOnly intacto)", () => {
    const list = [
      cand("doces.chocolate", "a", "Chocolate", { etaMinutes: 30 }),
      cand("mercado.cafe", "b", "Café", { etaMinutes: 1140 })
    ];
    assert.deepEqual(quickOnly(list).map((c) => c.option.sku), ["a"]);
  });
});

describe("q9 / causa 7 — unha encravada, refluxo, e plano de urgência que nunca zera", () => {
  it("h23: unha encravada = antisséptico (Povidine/clorexidina, busca livre) + curativo, sem remédio nem lixa", () => {
    const e = findSymptom("to com unha encravada doendo")!;
    assert.deepEqual(e.picks, []);
    const care = e.care ?? [];
    assert.ok(care.some((p) => p.shelfId === "produto" && /povidine/.test(p.query) && /clorexidina/.test(p.query)));
    assert.ok(care.some((p) => p.shelfId === "farmacia.curativo"));
    assert.ok(care.every((p) => p.shelfId !== "beleza.esmalte"), "o juiz reprovou lixa/cortador (piora a unha encravada)");
    const plan = planShelvesFromTables(req({ text: "to com unha encravada doendo, o que faço", need: "unha encravada", symptom: "unha encravada", criteria: ["fast"] }), defaultTableDeps());
    assert.deepEqual(plan!.picks.map((p) => p.shelfId), ["produto", "farmacia.curativo"]);
    assert.ok(plan!.picks.every((p) => !p.mipClass));
  });

  it("h04: jantar leve sem sopa de pacote (cebola/tempero); banana, iogurte natural, aveia, torrada, camomila", () => {
    const e = findNeed("jantar leve pra quem tem refluxo")!;
    assert.deepEqual(e.picks.map((p) => p.shelfId), ["hortifruti.frutas", "frios.iogurte", "mercado.cereal_matinal", "snacks.biscoito_salgado", "mercado.cha"]);
    assert.ok(e.picks.every((p) => p.shelfId !== "mercado.sopa"));
  });

  it("h02: prateleira de risco não sai do plano pela palavra (sorvete/iogurte 'sem lactose' são buscados pela prova)", () => {
    const plan = planShelvesFromTables(req({ text: "algo doce sem lactose", need: "algo doce", constraints: ["sem lactose"] }), defaultTableDeps());
    const ids = plan!.picks.map((p) => p.shelfId);
    assert.ok(ids.includes("doces.sorvete"));
    assert.ok(!ids.includes("doces.chocolate"), "chocolate comum continua fora");
  });
});

describe("q9 / shelfSanity e prova — Dragê de banana não é fruta; barril não é cerveja de churrasco; macarrão tomate prova vegetariano", () => {
  it("shelfSanityOk", () => {
    assert.equal(shelfSanityOk("hortifruti.frutas", "Pouch Dragê Banana Passa Minions 85G"), false);
    assert.equal(shelfSanityOk("hortifruti.frutas", "Banana Prata (unidade ~190 g)"), true);
    assert.equal(shelfSanityOk("bebidas.cerveja", "Cerveja Barril Heineken 5L"), false);
    assert.equal(shelfSanityOk("bebidas.cerveja", "Cerveja Heineken Long Neck 330ml"), true);
  });
});

describe("q9 / motivo e filtros finos — frio quentinho, castanha, dieta natural, combinação", () => {
  it("pedido 'quentinho' tira chá gelado/ice tea; sem alternativa, não esvazia", () => {
    const input = {
      request: req({ text: "tá um frio danado aqui, queria algo quentinho", need: "algo quentinho" }),
      plan: { picks: [], source: "table" } as ShelfPlan,
      candidates: [cand("mercado.cha", "1", "Chá Matte Ice Tea Leão Limão 450ml"), cand("mercado.sopa", "2", "Sopão Maggi Carne com Legumes 200g")]
    };
    assert.deepEqual(eligibleCandidates(input).map((c) => c.option.sku), ["2"]);
    assert.deepEqual(eligibleCandidates({ ...input, candidates: [input.candidates[0]] }).map((c) => c.option.sku), ["1"]);
  });

  it("motivo 'bebida quente' em ice tea e 'castanhas' em amendoim japonês são descartados", () => {
    assert.equal(whyClaimsUnproven("bebida quente para aquecer", "Chá Matte Ice Tea Leão Limão 450ml", "mercado.cha"), true);
    assert.equal(whyClaimsUnproven("bebida quente para aquecer", "Chá Leão Camomila 10 Sachês", "mercado.cha"), false);
    assert.equal(whyClaimsUnproven("castanhas pra beliscar", "Amendoim Japonês Mendorato Santa Helena 400g", "snacks.amendoim_castanhas"), true);
    assert.equal(whyClaimsUnproven("castanhas pra beliscar", "Mix de Castanhas Iracema 100g", "snacks.amendoim_castanhas"), false);
  });

  it("naturalDietWhy: fruta/suco/café/leite dizem o que é natural; o que fere ou é processado não", () => {
    const lac = [parseConstraint("sem lactose")!];
    const both = [parseConstraint("sem lactose")!, parseConstraint("sem glúten")!];
    assert.equal(naturalDietWhy("Suco Del Valle Sabor Maçã 200ml", "bebidas.suco", lac), "suco de fruta, naturalmente sem lactose");
    assert.equal(naturalDietWhy("Maçã Turma da Mônica 1kg", "hortifruti.frutas", both), "fruta, naturalmente sem lactose e sem glúten");
    assert.equal(naturalDietWhy("Café Torrado e Moído Pilão 500g", "mercado.cafe", both), "café, naturalmente sem lactose e sem glúten");
    assert.equal(naturalDietWhy("Leite Longa Vida Sem Lactose Parmalat 1 L", "frios.leite", both), "leite, naturalmente sem glúten", "o 'sem lactose' é prova do nome, não natural");
    assert.equal(naturalDietWhy("Suco de Laranja com Leite Condensado", "bebidas.suco", lac), undefined);
    assert.equal(naturalDietWhy("Biscoito Recheado", "doces.biscoito_doce", lac), undefined);
  });

  it("finalizeWhys junta a prova do nome com o natural: 'zero lactose no rótulo; leite, naturalmente sem glúten'", () => {
    const r = req({ text: "intolerante a lactose e a glúten, café da manhã", need: "café da manhã", constraints: ["sem lactose", "sem glúten"] });
    const out = finalizeWhys([card("frios.leite", "1", "Leite Molico Zero Lactose 260g")], r, { picks: [], source: "ai" });
    assert.equal(out[0].why, "zero lactose no rótulo; leite, naturalmente sem glúten");
  });

  it("alergia a amendoim não zera prateleira que não é comida (brinquedo, livro, eletrônico)", () => {
    const r = parseConstraint("sem amendoim")!;
    assert.equal(violatesRule("Livro Infantil Aventuras no Zoológico", r, "livraria.infantil"), false);
    assert.equal(violatesRule("Carrinho Hot Wheels", r, "brinquedo.carrinho"), false);
    assert.equal(violatesRule("Biscoito Recheado Passatempo 90g", r, "doces.biscoito_doce"), true);
  });

  it("queda de cabelo (strict): Koleston de reparo e whey não são antiqueda; sensível: só quem prova", () => {
    const c = [
      cand("beleza.shampoo", "1", "Shampoo Antiqueda Phytoervas 250ml"),
      cand("beleza.tratamento_capilar", "2", "Tratamento Capilar Koleston Poderoso Reparo de Danos 170ml"),
      cand("farmacia.suplementos", "3", "Whey Protein Morango Swift Pro&Fit 900g"),
      cand("farmacia.suplementos", "4", "Biotina 45mcg Cabelo e Unhas 60 cápsulas")
    ];
    assert.deepEqual(keepProvenAttributes(c, "meu cabelo ta caindo muito, tem algo? queda de cabelo").map((x) => x.option.sku), ["1", "4"]);
    const sol = [
      cand("beleza.protetor_solar", "a", "Protetor Solar Facial Isdin FPS 50 Foto Ultra Redness Peles Sensíveis e Reativas"),
      cand("beleza.protetor_solar", "b", "Protetor Solar Watery Fluid FPS 50")
    ];
    assert.deepEqual(keepProvenAttributes(sol, "protetor solar pele sensível com rosácea").map((x) => x.option.sku), ["a"]);
    assert.equal(whyClaimsUnproven("feito pra pele sensível", "Protetor Solar Watery Fluid FPS 50", "beleza.protetor_solar"), true);
  });

  it("needEntryFor: a chave mais longa vence entre o need e o texto ('vegano e proteico' > 'algo pra comer')", () => {
    const deps = defaultTableDeps();
    const e = needEntryFor(req({ text: "quero algo pra comer que seja vegano e proteico", need: "algo pra comer" }), deps);
    assert.ok(e?.keys.includes("vegano e proteico"));
    const f = needEntryFor(req({ text: "tô com fome", need: "fome" }), deps);
    assert.ok(f?.keys.includes("fome"));
  });
});
