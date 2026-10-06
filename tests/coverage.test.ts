import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCoverage, isSaoPauloState, isServedState, normalizeCity, coverageLabel, servedAreaLabel, ufFromCep } from "../src/lib/coverage";

// Guard the env we toggle so tests don't leak into each other.
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const cleanEnv = {
  LIA_COVERAGE_PRESET: undefined,
  LIA_COVERAGE_CITIES: undefined,
  LIA_COVERAGE_UFS: undefined,
  LIA_COVERAGE_CEP_PREFIXES: undefined,
  LIA_COVERAGE_OFF: undefined,
  LIA_COVERAGE_LABEL: undefined
};

test("normalizeCity strips accents and case", () => {
  assert.equal(normalizeCity("São Paulo"), "sao paulo");
  assert.equal(normalizeCity("  SANTO   ANDRÉ "), "santo andre");
});

test("active concierge boundary accepts all SP and rejects every other state", () => {
  assert.equal(isSaoPauloState({ city: "Campinas", uf: "SP", cep: "13010000" }), true);
  assert.equal(isSaoPauloState({ city: "Santos", uf: "sp", cep: "11010000" }), true);
  assert.equal(isSaoPauloState({ city: "Rio de Janeiro", uf: "RJ", cep: "20040000" }), false);
  assert.equal(isSaoPauloState({ cep: "13010000" }), true);
  assert.equal(isSaoPauloState({ cep: "20040000" }), false);
});

test("SP + RJ atendidos (06/10): ViaCEP manda; sem ViaCEP, a faixa do CEP decide", () => {
  withEnv({ LIA_SERVICE_UFS: undefined }, () => {
    assert.equal(isServedState({ city: "Rio de Janeiro", uf: "RJ", cep: "22041001" }), true);
    assert.equal(isServedState({ city: "Niterói", uf: "rj" }), true);
    assert.equal(isServedState({ city: "Campinas", uf: "SP", cep: "13010111" }), true);
    assert.equal(isServedState({ city: "Belo Horizonte", uf: "MG", cep: "30130010" }), false);
    assert.equal(isServedState({ cep: "22041001" }), true);
    assert.equal(isServedState({ cep: "29102100" }), false);
    assert.equal(isServedState({}), false);
    assert.equal(servedAreaLabel(), "os estados de São Paulo e Rio de Janeiro");
  });
  withEnv({ LIA_SERVICE_UFS: "SP" }, () => {
    assert.equal(isServedState({ city: "Rio de Janeiro", uf: "RJ" }), false);
    assert.equal(servedAreaLabel(), "o estado de São Paulo");
  });
});

test("ufFromCep: faixas dos Correios", () => {
  assert.equal(ufFromCep("01310-100"), "SP");
  assert.equal(ufFromCep("19999999"), "SP");
  assert.equal(ufFromCep("20000000"), "RJ");
  assert.equal(ufFromCep("28999999"), "RJ");
  assert.equal(ufFromCep("29000000"), "ES");
  assert.equal(ufFromCep("30130010"), "MG");
  assert.equal(ufFromCep("123"), undefined);
});

test("default coverage = São Paulo capital (city known)", () => {
  withEnv(cleanEnv, () => {
    assert.equal(checkCoverage({ city: "São Paulo", uf: "SP", cep: "01310100" }).covered, true);
    assert.equal(checkCoverage({ city: "SAO PAULO", uf: "SP" }).covered, true);
  });
});

test("known city outside area is blocked (even with a weird CEP prefix)", () => {
  withEnv(cleanEnv, () => {
    // Recife
    assert.equal(checkCoverage({ city: "Recife", uf: "PE", cep: "50030000" }).covered, false);
    // Guarulhos is Grande SP, NOT capital → blocked by default
    assert.equal(checkCoverage({ city: "Guarulhos", uf: "SP", cep: "07010000" }).covered, false);
    // Osasco → blocked by default
    assert.equal(checkCoverage({ city: "Osasco", uf: "SP" }).covered, false);
  });
});

test("city unknown (ViaCEP down) falls back to CEP prefix", () => {
  withEnv(cleanEnv, () => {
    // SP capital prefix → covered
    assert.equal(checkCoverage({ cep: "01310100" }).covered, true);
    assert.equal(checkCoverage({ cep: "05409000" }).covered, true);
    // Recife prefix → blocked
    assert.equal(checkCoverage({ cep: "50030000" }).covered, false);
    // Campinas (13xxx) → blocked
    assert.equal(checkCoverage({ cep: "13010000" }).covered, false);
  });
});

test("no city and no usable CEP → fail open (operator catches it)", () => {
  withEnv(cleanEnv, () => {
    assert.equal(checkCoverage({}).covered, true);
    assert.equal(checkCoverage({ cep: "123" }).covered, true);
  });
});

test("LIA_COVERAGE_CITIES widens coverage without code (rest-of-SP step)", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_CITIES: "São Paulo, Osasco, Santo André, Guarulhos" }, () => {
    assert.equal(checkCoverage({ city: "Osasco", uf: "SP" }).covered, true);
    assert.equal(checkCoverage({ city: "Santo André", uf: "SP" }).covered, true);
    assert.equal(checkCoverage({ city: "Guarulhos", uf: "SP" }).covered, true);
    // still blocks a city not on the list
    assert.equal(checkCoverage({ city: "Campinas", uf: "SP" }).covered, false);
  });
});

test("LIA_COVERAGE_CITIES accepts Cidade/UF form", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_CITIES: "São Paulo/SP, Osasco/SP" }, () => {
    assert.equal(checkCoverage({ city: "Osasco", uf: "SP" }).covered, true);
  });
});

test("LIA_COVERAGE_CEP_PREFIXES override changes the fallback net", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_CEP_PREFIXES: "06,07" }, () => {
    // now 06/07 (Grande SP) pass the unknown-city fallback, 01 no longer does
    assert.equal(checkCoverage({ cep: "06233000" }).covered, true);
    assert.equal(checkCoverage({ cep: "01310100" }).covered, false);
  });
});

test("LIA_COVERAGE_OFF disables the gate entirely", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_OFF: "true" }, () => {
    assert.equal(checkCoverage({ city: "Recife", uf: "PE", cep: "50030000" }).covered, true);
  });
});

test("coverageLabel reads env with a sane default", () => {
  withEnv(cleanEnv, () => assert.equal(coverageLabel(), "São Paulo capital"));
  withEnv({ ...cleanEnv, LIA_COVERAGE_LABEL: "Grande São Paulo" }, () => assert.equal(coverageLabel(), "Grande São Paulo"));
});

test("preset default = capital (Grande SP blocked)", () => {
  withEnv(cleanEnv, () => {
    assert.equal(checkCoverage({ city: "São Paulo" }).covered, true);
    assert.equal(checkCoverage({ city: "Osasco" }).covered, false);
    assert.equal(coverageLabel(), "São Paulo capital");
  });
});

test("preset grande-sp covers the whole RMSP, still blocks interior", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "grande-sp" }, () => {
    for (const c of ["São Paulo", "Osasco", "Guarulhos", "Santo André", "São Bernardo do Campo", "Barueri", "Mogi das Cruzes", "Salesópolis"]) {
      assert.equal(checkCoverage({ city: c, uf: "SP" }).covered, true, `deveria cobrir ${c}`);
    }
    // interior fora da RMSP
    assert.equal(checkCoverage({ city: "Campinas", uf: "SP" }).covered, false);
    assert.equal(checkCoverage({ city: "Santos", uf: "SP" }).covered, false);
    assert.equal(checkCoverage({ city: "Recife", uf: "PE" }).covered, false);
    assert.equal(coverageLabel(), "São Paulo e região (Grande SP)");
  });
});

test("preset grande-sp: prefixo '0' cobre metro quando cidade desconhecida (ViaCEP down)", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "grande-sp" }, () => {
    assert.equal(checkCoverage({ cep: "06233-030" }).covered, true); // Osasco
    assert.equal(checkCoverage({ cep: "09015-000" }).covered, true); // Santo André
    assert.equal(checkCoverage({ cep: "13010-000" }).covered, false); // Campinas (1xxxx)
  });
});

test("env LIA_COVERAGE_CITIES sobrepõe o preset", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "grande-sp", LIA_COVERAGE_CITIES: "São Paulo" }, () => {
    assert.equal(checkCoverage({ city: "Osasco" }).covered, false); // preset ignorado
    assert.equal(checkCoverage({ city: "São Paulo" }).covered, true);
  });
});

test("preset estado-sp: qualquer cidade de SP cobre, outros estados não", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "estado-sp" }, () => {
    for (const c of ["São Paulo", "Campinas", "Santos", "Ribeirão Preto", "Bauru", "Presidente Prudente"]) {
      assert.equal(checkCoverage({ city: c, uf: "SP" }).covered, true, `deveria cobrir ${c}/SP`);
    }
    assert.equal(checkCoverage({ city: "Rio de Janeiro", uf: "RJ" }).covered, false);
    assert.equal(checkCoverage({ city: "Recife", uf: "PE" }).covered, false);
    assert.equal(coverageLabel(), "o estado de São Paulo");
  });
});

test("preset estado-sp: prefixos 0 e 1 quando ViaCEP cai", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "estado-sp" }, () => {
    assert.equal(checkCoverage({ cep: "13010-000" }).covered, true); // Campinas
    assert.equal(checkCoverage({ cep: "11010-000" }).covered, true); // Santos
    assert.equal(checkCoverage({ cep: "01310-100" }).covered, true); // capital
    assert.equal(checkCoverage({ cep: "20040-000" }).covered, false); // Rio (2xxxx)
  });
});

test("LIA_COVERAGE_UFS cobre por UF mesmo sem preset", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_UFS: "SP" }, () => {
    assert.equal(checkCoverage({ city: "Campinas", uf: "SP" }).covered, true);
    assert.equal(checkCoverage({ city: "Rio de Janeiro", uf: "RJ" }).covered, false);
    // cidade da lista default (capital) continua cobrindo por cidade
    assert.equal(checkCoverage({ city: "São Paulo", uf: "SP" }).covered, true);
  });
});

test("preset desconhecido cai em capital", () => {
  withEnv({ ...cleanEnv, LIA_COVERAGE_PRESET: "brasil-inteiro" }, () => {
    assert.equal(checkCoverage({ city: "São Paulo" }).covered, true);
    assert.equal(checkCoverage({ city: "Osasco" }).covered, false);
  });
});
