// Revisão adversarial da recomendação (08/10/2026): regressões com as FRASES citadas na revisão, sobre
// as tabelas e o mapa REAIS (tables.ts, shelf-map.ts). Puro: sem rede (IA por costura), sem banco.
// A1 classe terapêutica · A2 emergência em todo pedido · A3 pet doente · A4 criança/idoso/comorbidade ·
// A5 IA presa à tabela · B1 prateleira do produto · C2/C3 estado e chave ambígua · C5 limitador.
import "./helpers/load-env";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __setJudgeFitnessForTests, __setPlanShelvesForTests } from "../src/lib/recommend/ai";
import { detectRecommendation } from "../src/lib/recommend/detect";
import { defaultTableDeps, emergencyFlag, findShelfForProduct, isSymptomRequest, judgeFitness, judgeFitnessByRules, planShelves, planShelvesFromTables } from "../src/lib/recommend/fallback";
import { SHELF_MAP } from "../src/lib/recommend/shelf-map";
import { PET_SICK_REASON } from "../src/lib/recommend/tables";
import type { RecommendRequest, ShelfCandidate, ShelfPlan } from "../src/lib/recommend/types";
import { createFetchLimiter } from "../src/lib/stores/index";

const deps = defaultTableDeps();
const req = (over: Partial<RecommendRequest>): RecommendRequest => ({ form: "need", text: "", criteria: [], constraints: [], source: "dialogue", ...over });
// Pedido como as regras o leem (o mesmo que o caminho sem IA usa).
const detected = (text: string): RecommendRequest => {
  const r = detectRecommendation(text);
  assert.ok(r, `detect devolveu null: "${text}"`);
  return r!;
};
const plan = (r: RecommendRequest) => planShelves(r, { deps });
const ids = (p: ShelfPlan) => p.picks.map((x) => x.shelfId);

const saved = { mip: process.env.LIA_MEDICINE_MIP, recMed: process.env.LIA_RECOMMEND_MEDICINE };
beforeEach(() => {
  process.env.LIA_MEDICINE_MIP = "true";
  delete process.env.LIA_RECOMMEND_MEDICINE;
});
afterEach(() => {
  __setPlanShelvesForTests(null);
  __setJudgeFitnessForTests(null);
  if (saved.mip === undefined) delete process.env.LIA_MEDICINE_MIP;
  else process.env.LIA_MEDICINE_MIP = saved.mip;
  if (saved.recMed === undefined) delete process.env.LIA_RECOMMEND_MEDICINE;
  else process.env.LIA_RECOMMEND_MEDICINE = saved.recMed;
});

describe("A1 — classe terapêutica passa pela porta do remédio (alerta de contexto)", () => {
  it("'qual o melhor antitérmico pro meu bebê de 6 meses' → alerta (não prateleira mip)", async () => {
    const p = await plan(detected("qual o melhor antitérmico pro meu bebê de 6 meses"));
    assert.equal(p.redFlag, "bebê ou criança pequena");
    assert.equal(p.redFlagKind, "context");
    assert.deepEqual(p.picks, []);
  });

  it("'me recomenda um analgésico pra criança' → alerta de criança", async () => {
    const p = await plan(detected("me recomenda um analgésico pra criança"));
    assert.equal(p.redFlag, "criança");
    assert.deepEqual(p.picks, []);
  });

  it("'qual o melhor anti-inflamatório' (adulto, sem contexto) → prateleira isenta; com criança → alerta", async () => {
    const adult = await plan(detected("qual o melhor anti-inflamatório"));
    assert.equal(adult.redFlag, undefined);
    assert.deepEqual(ids(adult), ["farmacia.anti_inflamatorio"]);
    // O mesmo produto julgado vindo da IA com pra quem (sem sintoma): a prateleira mip exige o alerta.
    const kid = await plan(req({ form: "product_judged", text: "qual o melhor anti-inflamatório pro meu filho", product: "anti-inflamatório", recipient: "filho", criteria: ["good"] }));
    assert.equal(kid.redFlag, "criança");
    assert.deepEqual(kid.picks, []);
  });
});

describe("A2 — emergência em QUALQUER pedido, antes da IA", () => {
  it("'tô com o peito apertado e suando frio' (regras) → alerta de emergência", async () => {
    const p = await plan(detected("tô com o peito apertado e suando frio"));
    assert.equal(p.redFlag, "dor no peito");
    assert.equal(p.redFlagKind, "emergency");
  });

  it("mesmo sem sintoma (IA leu como 'algo quente'/'aparelho'), a emergência sai e a IA nem é chamada", async () => {
    let called = false;
    __setPlanShelvesForTests(async () => {
      called = true;
      return { picks: [{ shelfId: "mercado.sopa", query: "sopa", why: "quente" }], source: "ai" };
    });
    const sopa = await plan(req({ text: "tô com o peito apertado e suando frio", need: "algo quente" }));
    assert.equal(sopa.redFlag, "dor no peito");
    const ar = await plan(req({ form: "product_judged", text: "tô com falta de ar, qual aparelho é bom?", product: "aparelho de saúde" }));
    assert.equal(ar.redFlag, "falta de ar");
    assert.equal(ar.redFlagKind, "emergency");
    assert.equal(called, false);
  });

  it("emergencyFlag: frase solta; padrões estreitos não disparam", () => {
    assert.equal(emergencyFlag("tô com falta de ar"), "falta de ar");
    assert.equal(emergencyFlag("meu cachorro tá sangrando"), PET_SICK_REASON, "pet com emergência = veterinário");
    assert.equal(emergencyFlag("me indica um vinho sangue de boi bom"), null);
    assert.equal(emergencyFlag("ventilador pra casa sem ar condicionado"), null);
    assert.equal(emergencyFlag("tô com fome"), null);
    assert.equal(emergencyFlag(""), null);
  });
});

describe("A3 — pet doente: só veterinário, zero remédio humano", () => {
  it("'meu cachorro tá com diarreia, o que dar' → alerta pet, nenhuma prateleira", async () => {
    const p = await plan(detected("meu cachorro tá com diarreia, o que dar"));
    assert.equal(p.redFlag, PET_SICK_REASON);
    assert.deepEqual(p.picks, []);
    // IA com pra quem = gato e sintoma (sem "meu" no texto) também
    const gato = await plan(req({ text: "gato vomitando, o que dou", need: "vômito", symptom: "enjoo", recipient: "gato" }));
    assert.equal(gato.redFlag, PET_SICK_REASON);
  });

  it("pedido claramente de produto pet não é sintoma: 'ração pra cachorro com estômago sensível' → ração", async () => {
    const p = await plan(req({ form: "product_judged", text: "qual a melhor ração pra cachorro com estômago sensível", product: "ração pra cachorro estômago sensível", recipient: "cachorro", criteria: ["good"] }));
    assert.equal(p.redFlag, undefined);
    assert.equal(ids(p)[0], "pet.racao_cachorro");
    const plain = await plan(req({ form: "product_judged", text: "ração pra cachorro boa", product: "ração pra cachorro", criteria: ["good"] }));
    assert.equal(plain.redFlag, undefined);
  });
});

describe("A4 — criança, idoso, comorbidade e combinações de sintoma alertam", () => {
  const CASES: [string, string][] = [
    ["meu filho de 2 anos tá com febre", "criança"],
    ["meu filho tá com febre", "criança"],
    ["meu neto de 4 anos tá com tosse", "criança"],
    ["meu pai de 75 anos tá com dor", "idoso"],
    ["tô com dor de cabeça e uso anticoagulante", "uso de anticoagulante"],
    ["tenho úlcera e tô com dor de cabeça", "úlcera ou gastrite"],
    ["dor de barriga e febre", "dor na barriga com febre"],
    ["dor de barriga do lado direito", "dor no lado direito da barriga"],
    ["dor de cabeça com febre e pescoço duro", "febre com pescoço duro"],
    ["tenho pressão alta e tô gripado", "pressão alta"],
    ["sou diabético e tô com dor de cabeça", "diabetes"],
    ["dor ao urinar", "dor ao urinar"]
  ];
  for (const [text, reason] of CASES) {
    it(`'${text}' → ${reason}`, async () => {
      const p = await plan(detected(text));
      assert.equal(p.redFlag, reason);
      assert.deepEqual(p.picks, []);
    });
  }

  it("pra quem da IA também conta (recipient 'filho 2 anos', 'pai 75 anos')", async () => {
    assert.equal((await plan(req({ text: "tá com febre", need: "febre", symptom: "febre", recipient: "filho 2 anos" }))).redFlag, "criança");
    assert.equal((await plan(req({ text: "tá com dor", need: "dor", symptom: "dor", recipient: "pai 75 anos" }))).redFlag, "idoso");
    assert.equal((await plan(req({ text: "tá com dor de cabeça", need: "dor de cabeça", symptom: "dor de cabeça", recipient: "filho 16 anos" }))).redFlag, undefined);
  });

  it("negativos: 'dor de barriga leve', 'assadura do bebê', 'presente pra mãe gestante', 'ração pra cachorro'", async () => {
    const leve = await plan(detected("dor de barriga leve"));
    assert.equal(leve.redFlag, undefined);
    assert.equal(ids(leve)[0], "farmacia.antiespasmodico");
    assert.ok(!ids(leve).includes("farmacia.antidiarreico"), "loperamida fora da dor de barriga genérica (A6)");
    const assadura = await plan(detected("assadura do bebê"));
    assert.equal(assadura.redFlag, undefined);
    assert.equal(ids(assadura)[0], "farmacia.pomada_assadura");
    const gestante = await plan(detected("presente pra mãe gestante"));
    assert.equal(gestante.redFlag, undefined);
    assert.ok(gestante.picks.length > 0);
    const racao = await plan(req({ form: "product_judged", text: "ração pra cachorro", product: "ração pra cachorro", criteria: ["good"] }));
    assert.equal(racao.redFlag, undefined);
    assert.equal(ids(racao)[0], "pet.racao_cachorro");
  });
});

describe("A5 — a IA não escolhe classe de remédio fora da tabela", () => {
  it("com entrada da tabela: só isentos + cuidado da entrada (antigripal pra dor de cabeça cai)", async () => {
    __setPlanShelvesForTests(async () => ({
      picks: [
        { shelfId: "farmacia.antigripal", query: "cimegripe", why: "gripe" },
        { shelfId: "farmacia.analgesico", query: "dipirona", why: "alivia dor", mipClass: "analgesico" },
        { shelfId: "bebidas.agua", query: "agua", why: "hidrata" }
      ],
      source: "ai"
    }));
    const p = await plan(req({ text: "tô com dor de cabeça", need: "dor de cabeça", symptom: "dor de cabeça" }));
    assert.equal(p.source, "ai");
    assert.deepEqual(ids(p), ["farmacia.analgesico", "bebidas.agua"]);
  });

  it("sintoma sem entrada na tabela: nada de mip (só cuidado)", async () => {
    __setPlanShelvesForTests(async () => ({
      picks: [
        { shelfId: "farmacia.analgesico", query: "dipirona", why: "dor" },
        { shelfId: "bebidas.isotonico", query: "isotonico", why: "hidrata" }
      ],
      source: "ai"
    }));
    const p = await plan(req({ text: "tô com formigamento na mão", need: "formigamento", symptom: "formigamento" }));
    assert.deepEqual(ids(p), ["bebidas.isotonico"]);
  });

  it("necessidade sem sintoma e produto julgado não-remédio: nenhuma prateleira mip", async () => {
    __setPlanShelvesForTests(async () => ({
      picks: [
        { shelfId: "doces.chocolate", query: "chocolate", why: "doce" },
        { shelfId: "farmacia.calmante_natural", query: "melatonina", why: "relaxa" }
      ],
      source: "ai"
    }));
    const need = await plan(req({ text: "quero algo doce", need: "algo doce" }));
    assert.deepEqual(ids(need), ["doces.chocolate"]);
    const judged = await plan(req({ form: "product_judged", text: "me recomenda um chocolate bom", product: "chocolate", criteria: ["good"] }));
    assert.deepEqual(ids(judged), ["doces.chocolate"]);
  });
});

describe("B1 — prateleira do produto por cobertura de tokens (mapa real)", () => {
  const shelf = (product: string) => findShelfForProduct(product, SHELF_MAP.shelves)?.id;
  it("as frases da revisão", () => {
    assert.equal(shelf("ração pro cachorro"), "pet.racao_cachorro");
    assert.equal(shelf("areia pra gato"), "pet.areia_gato");
    assert.equal(shelf("pomada pra assadura"), "farmacia.pomada_assadura");
    assert.equal(shelf("creme pra espinhas"), "beleza.skincare_facial");
    assert.equal(shelf("algo pra dormir"), undefined, "nunca o pijama por palpite");
    assert.equal(shelf("dormir"), undefined);
    // "qual ração vale a pena pro meu gato" → produto "ração pro gato"
    assert.equal(detected("qual ração vale a pena pro meu gato").product, "ração pro gato");
    assert.equal(shelf("ração pro gato"), "pet.racao_gato");
  });

  it("sem prateleira → busca textual 'produto'; 'me indica algo pra dormir' vira necessidade (relaxar/dormir)", async () => {
    const p = planShelvesFromTables(req({ form: "product_judged", text: "melhor furadeira de impacto xyz", product: "xyzfuradeira", criteria: ["good"] }), deps);
    assert.deepEqual(p?.picks, [{ shelfId: "produto", query: "xyzfuradeira", why: "" }]);
    const dormir = await plan(detected("me indica algo pra dormir"));
    assert.equal(dormir.redFlag, undefined);
    assert.ok(!ids(dormir).includes("moda.pijama"));
    assert.equal(ids(dormir)[0], "mercado.cha");
  });

  it("o que já funcionava continua", () => {
    assert.equal(shelf("shampoo cabelo cacheado"), "beleza.shampoo");
    assert.equal(shelf("chocolate"), "doces.chocolate");
    assert.equal(shelf("bombom"), "doces.chocolate");
    assert.equal(shelf("anti-inflamatório"), "farmacia.anti_inflamatorio");
  });
});

describe("C2/C3 — estado vira necessidade; chave ambígua não vira sintoma", () => {
  it("'tô de dieta, o que você indica' → algo leve/saudável; 'tô muito ansioso…' → relaxar", async () => {
    const dieta = await plan(detected("tô de dieta, o que você indica"));
    assert.equal(ids(dieta)[0], "hortifruti.frutas");
    const ansioso = await plan(detected("tô muito ansioso, o que você recomenda"));
    assert.equal(ids(ansioso)[0], "mercado.cha");
    assert.ok(!ansioso.picks.some((p) => p.shelfId.startsWith("farmacia.")), "estado não é sintoma: nada de calmante");
  });

  it("'corte de carne pro churrasco' (IA leu como necessidade) → churrasco, nunca curativo", async () => {
    const r = req({ text: "corte de carne pro churrasco", need: "corte de carne pro churrasco" });
    assert.equal(isSymptomRequest(r, deps), false);
    const p = await plan(r);
    assert.ok(!ids(p).some((id) => id.startsWith("farmacia.")), ids(p).join(","));
    assert.equal(ids(p)[0], "casa.churrasco");
  });
});

describe("JULGAR — ajustes baixos da revisão", () => {
  const c = (shelfId: string, sku: string, name: string, popularity: number, over: Partial<ShelfCandidate["option"]> = {}): ShelfCandidate => ({
    shelfId,
    option: { sku, name, unitPrice: 20, storeKey: "a", ...over },
    popularity
  });

  it("o juiz de IA recebe só candidatos elegíveis (restrição já aplicada)", async () => {
    let seen: string[] = [];
    __setJudgeFitnessForTests(async (input) => {
      seen = input.candidates.map((x) => x.option.sku);
      return null;
    });
    const candidates = [c("doces.chocolate", "choc", "Chocolate Lacta", 1), c("doces.sorvete", "sorv", "Sorvete de Creme", 1)];
    await judgeFitness({ request: req({ text: "algo doce sem chocolate", need: "algo doce", constraints: ["sem chocolate"] }), plan: { picks: [], source: "table" }, candidates }, deps);
    assert.deepEqual(seen, ["sorv"]);
  });

  it("sintoma da IA num produto julgado sem remédio no plano não força o modo 'symptom'", () => {
    const candidates = [c("beleza.shampoo", "max", "Shampoo Anticaspa Max", 1), c("beleza.shampoo", "base", "Shampoo Anticaspa", 2)];
    const v = judgeFitnessByRules(
      {
        request: req({ form: "product_judged", text: "qual o melhor shampoo pra caspa", product: "shampoo", symptom: "caspa", criteria: ["good"] }),
        plan: { picks: [{ shelfId: "beleza.shampoo", query: "shampoo anticaspa", why: "" }], source: "table" },
        candidates
      },
      deps
    );
    assert.equal(v.cards[0].sku, "max", "good = o mais vendido (a regra de extensão de linha é só de remédio)");
  });
});

describe("C5 — limitador de buscas ao vivo em voo", () => {
  it("nunca passa do teto e roda tudo, na ordem de chegada", async () => {
    const limiter = createFetchLimiter(3);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          done.push(i);
          return i;
        })
      )
    );
    assert.equal(peak, 3);
    assert.equal(done.length, 10);
    assert.equal(limiter.active, 0);
    assert.equal(limiter.queued, 0);
  });

  it("falha numa tarefa libera a vaga (sem travar a fila)", async () => {
    const limiter = createFetchLimiter(1);
    await assert.rejects(limiter.run(async () => Promise.reject(new Error("boom"))));
    assert.equal(await limiter.run(async () => 42), 42);
  });
});
