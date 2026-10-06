// Onde a Lia entrega HOJE. Cobertura é DADO, não código: a operação ativa é o estado de
// São Paulo. O fluxo legado ainda pode usar presets mais estreitos por env. Puro e
// unit-testado (sem DB, sem rede). O cérebro chama checkCoverage() logo depois de resolver
// o CEP; se estiver fora da área, grava um lead na lista de espera em vez de aceitar um
// pedido pago que não consegue entregar.
//
// Config por env (todas opcionais):
//   LIA_COVERAGE_PRESET        — fase de cobertura: "capital" (default) | "grande-sp" |
//                                "estado-sp". Escolhe cidades/UFs+prefixos+label de uma vez;
//                                as envs abaixo sobrepõem campo a campo.
//   LIA_COVERAGE_CITIES        — cidades atendidas, separadas por vírgula (acento/caixa
//                                ignorados). Ex.: "São Paulo, Osasco, Santo André".
//                                Default: "São Paulo".
//   LIA_COVERAGE_UFS           — estados inteiros atendidos ("SP" ou "SP,RJ"). Cidade OU UF
//                                cobre; a guarda de frete decide a entregabilidade real.
//   LIA_COVERAGE_CEP_PREFIXES  — prefixos de CEP usados SÓ como rede de segurança quando
//                                a cidade não pôde ser resolvida (ViaCEP fora do ar).
//                                Default: "01,02,03,04,05,08" (SP capital).
//   LIA_COVERAGE_LABEL         — nome da área, usado na mensagem ao cliente.
//                                Default: "São Paulo capital".
//   LIA_COVERAGE_OFF=true      — desliga a trava (tudo vira coberto). Kill-switch/testes.

export type CoverageInput = { cep?: string; city?: string; uf?: string };
export type CoverageResult = { covered: boolean; city?: string; uf?: string };

/**
 * Hard geographic boundary of the active concierge. ViaCEP is authoritative when it
 * returns a UF; the CEP prefix is the safe fallback when ViaCEP is unavailable.
 * This deliberately ignores LIA_COVERAGE_OFF and the legacy city presets: production
 * concierge traffic must never be accepted outside São Paulo state.
 */
export function isSaoPauloState(input: CoverageInput): boolean {
  const uf = input.uf?.trim().toUpperCase();
  if (uf) return uf === "SP";
  const digits = (input.cep ?? "").replace(/\D/g, "");
  return digits.length === 8 && /^[01]/.test(digits);
}

// Faixas de CEP por UF (Correios). Usado quando o ViaCEP não responde e pela trava de
// área das lojas regionais (store-areas.ts).
const CEP_UF_RANGES: Array<[number, number, string]> = [
  [1000, 19999, "SP"], [20000, 28999, "RJ"], [29000, 29999, "ES"], [30000, 39999, "MG"],
  [40000, 48999, "BA"], [49000, 49999, "SE"], [50000, 56999, "PE"], [57000, 57999, "AL"],
  [58000, 58999, "PB"], [59000, 59999, "RN"], [60000, 63999, "CE"], [64000, 64999, "PI"],
  [65000, 65999, "MA"], [66000, 68899, "PA"], [68900, 68999, "AP"], [69000, 69299, "AM"],
  [69300, 69399, "RR"], [69400, 69899, "AM"], [69900, 69999, "AC"], [70000, 72799, "DF"],
  [72800, 72999, "GO"], [73000, 73699, "DF"], [73700, 76799, "GO"], [76800, 76999, "RO"],
  [77000, 77999, "TO"], [78000, 78899, "MT"], [79000, 79999, "MS"], [80000, 87999, "PR"],
  [88000, 89999, "SC"], [90000, 99999, "RS"]
];

export function ufFromCep(cep: string | null | undefined): string | undefined {
  const digits = (cep ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return undefined;
  const head = Number(digits.slice(0, 5));
  return CEP_UF_RANGES.find(([from, to]) => head >= from && head <= to)?.[2];
}

// Estados atendidos hoje (06/10/2026: SP + RJ). `LIA_SERVICE_UFS` troca sem deploy de código
// ("SP" volta ao corte antigo). Dentro do estado, quem decide se dá pra entregar é a loja
// (store-areas.ts + simulação ao vivo por CEP).
const UF_NAMES: Record<string, string> = { SP: "São Paulo", RJ: "Rio de Janeiro", MG: "Minas Gerais", ES: "Espírito Santo", PR: "Paraná" };

export function servedUfs(): string[] {
  const list = (process.env.LIA_SERVICE_UFS ?? "SP,RJ").split(",").map((u) => u.trim().toUpperCase()).filter(Boolean);
  return list.length ? [...new Set(list)] : ["SP"];
}

export function isServedState(input: CoverageInput): boolean {
  const uf = input.uf?.trim().toUpperCase() || ufFromCep(input.cep);
  return Boolean(uf && servedUfs().includes(uf));
}

// "o estado de São Paulo" / "os estados de São Paulo e Rio de Janeiro".
export function servedAreaLabel(): string {
  const names = servedUfs().map((uf) => UF_NAMES[uf] ?? uf);
  if (names.length === 1) return `o estado de ${names[0]}`;
  return `os estados de ${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

export function normalizeCity(s?: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Presets de cobertura em código: escolher a fase inteira por UMA env (LIA_COVERAGE_PRESET)
// em vez de colar uma lista gigante de cidades. Precedência campo-a-campo: env explícita
// (LIA_COVERAGE_CITIES/UFS/CEP_PREFIXES/LABEL) > preset > default.
type CoveragePreset = { cities: string[]; ufs?: string[]; cepPrefixes: string[]; label: string };

const PRESETS: Record<string, CoveragePreset> = {
  capital: {
    cities: ["São Paulo"],
    cepPrefixes: ["01", "02", "03", "04", "05", "08"],
    label: "São Paulo capital"
  },
  // 39 municípios da Região Metropolitana de São Paulo (RMSP).
  "grande-sp": {
    cities: [
      "São Paulo", "Guarulhos", "Osasco", "Barueri", "Carapicuíba", "Cotia", "Taboão da Serra",
      "Embu das Artes", "Itapecerica da Serra", "Santo André", "São Bernardo do Campo",
      "São Caetano do Sul", "Diadema", "Mauá", "Ribeirão Pires", "Rio Grande da Serra",
      "Mogi das Cruzes", "Suzano", "Poá", "Ferraz de Vasconcelos", "Itaquaquecetuba", "Arujá",
      "Santa Isabel", "Guararema", "Biritiba Mirim", "Salesópolis", "Caieiras", "Franco da Rocha",
      "Francisco Morato", "Mairiporã", "Cajamar", "Jandira", "Itapevi", "Pirapora do Bom Jesus",
      "Santana de Parnaíba", "Vargem Grande Paulista", "Embu-Guaçu", "Juquitiba", "São Lourenço da Serra"
    ],
    // CEPs 0xxxx-xxx = capital + Grande SP; o interior de SP começa em 1xxxx. Fallback só
    // quando o ViaCEP cai; a guarda de frete (freight-guard.ts) é quem decide entregabilidade.
    cepPrefixes: ["0"],
    label: "São Paulo e região (Grande SP)"
  },
  // Estado inteiro: cobertura por UF (645 municípios não cabem numa lista). Quem decide se
  // uma cidade é ENTREGÁVEL é a guarda de frete: sem loja a ≤12km, recusa educada + lead.
  "estado-sp": {
    cities: [],
    ufs: ["SP"],
    cepPrefixes: ["0", "1"], // CEPs de SP: 01000-000 a 19999-999
    label: "o estado de São Paulo"
  }
};

function activePreset(): CoveragePreset {
  const key = (process.env.LIA_COVERAGE_PRESET ?? "capital").trim().toLowerCase();
  const preset = PRESETS[key];
  if (!preset) {
    console.warn(`[coverage] preset desconhecido "${key}" — usando "capital"`);
    return PRESETS.capital;
  }
  return preset;
}

// Tolera "Cidade/UF" e "Cidade" — só a cidade importa pro match hoje (piloto é 1 estado).
function coveredCities(): Set<string> {
  const cities = process.env.LIA_COVERAGE_CITIES ? process.env.LIA_COVERAGE_CITIES.split(",") : activePreset().cities;
  return new Set(cities.map((c) => normalizeCity(c.split("/")[0])).filter(Boolean));
}

function coveredUfs(): Set<string> {
  const ufs = process.env.LIA_COVERAGE_UFS ? process.env.LIA_COVERAGE_UFS.split(",") : (activePreset().ufs ?? []);
  return new Set(ufs.map((u) => u.trim().toUpperCase()).filter(Boolean));
}

function coveredPrefixes(): string[] {
  const list = process.env.LIA_COVERAGE_CEP_PREFIXES ? process.env.LIA_COVERAGE_CEP_PREFIXES.split(",") : activePreset().cepPrefixes;
  return list.map((p) => p.replace(/\D/g, "")).filter(Boolean);
}

export function coverageLabel(): string {
  return process.env.LIA_COVERAGE_LABEL ?? activePreset().label;
}

export function checkCoverage(input: CoverageInput): CoverageResult {
  const uf = input.uf ? input.uf.toUpperCase() : undefined;
  if (process.env.LIA_COVERAGE_OFF === "true") return { covered: true, city: input.city, uf };

  const city = normalizeCity(input.city);
  if (city) {
    // Cidade conhecida (ViaCEP respondeu) = sinal autoritativo. Cobre por cidade OU por UF
    // (preset estado-sp cobre "SP" inteiro; a guarda de frete decide a entregabilidade).
    const byCity = coveredCities().has(city);
    const byUf = uf ? coveredUfs().has(uf) : false;
    return { covered: byCity || byUf, city: input.city, uf };
  }

  // Cidade desconhecida (ViaCEP fora do ar) → rede de segurança por prefixo de CEP.
  const digits = (input.cep ?? "").replace(/\D/g, "");
  if (digits.length === 8) {
    return { covered: coveredPrefixes().some((p) => digits.startsWith(p)), uf };
  }

  // Sem cidade e sem CEP usável: fail-open — o operador vê o pedido e pega o caso raro,
  // mesmo espírito do "falha de rede → salva e segue" que o cérebro já usa no ViaCEP.
  return { covered: true, uf };
}
