// Recolhe TODAS as vitrines automatizáveis e mostra o que mudou de preço.
// Uso:  npm run catalog:refresh          (recolhe tudo e escreve os arquivos)
//       npm run catalog:refresh -- --dry (só compara, não escreve)
//       npm run catalog:refresh -- oba divvino   (só essas lojas)
//
// Por que existe: os catálogos são arquivos .ts estáticos — rápidos, sem rede no turno da
// conversa e sem depender de navegador remoto. O preço de vitrine é referência (a autoridade
// é a cotação do operador), mas referência velha gera atrito: o cliente vê R$ 10 e o operador
// cota R$ 14. Rodar isto uma vez por mês mantém a distância pequena.
//
// Depois de rodar: revise o resumo, `git add src/lib/stores/*-catalog.ts`, commit e deploy.
// Lojas que NÃO entram aqui (colheita manual, sem API): giulianaflores (client-rendered,
// precisa de navegador), carrefour/petz/boticario (anti-bot), kalunga/cacaushow/decathlon/
// drogaraia (seeds pequenos escritos à mão).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Source = {
  key: string;
  origin: string;
  max: number;
  /** Farmácia: allowlist de categorias seguras (ANVISA). Ver src/lib/stores/README.md. */
  categories?: string;
  deny?: string;
  seller?: string;
  /**
   * Varreduras complementares por busca de texto (separadas por ";"). O top-vendas
   * esconde nicho que cliente real pede — caso 17/08: "sorvete que não engorda" existia
   * na Natural da Terra (Sorvete Zero Nestlé/Yamo) e nunca entrava no top 1000.
   */
  ft?: string;
  /** Loja que devolve links no host técnico da VTEX (…vtexcommercestable): troca pelo site público. */
  rewriteHost?: string;
  /** Prefixo de SKU do catálogo quando difere da chave (drogariasp → "dsp", epocacosmeticos → "epoca"). */
  skuPrefix?: string;
};

// O deny-regex de medicamento é o mesmo das duas farmácias. A terceira guarda
// (withoutMedicine, em runtime) continua valendo mesmo se este regex falhar.
const PHARMACY_DENY =
  "medicament|remedio|rem[eé]dio|vitamina|polivitam|suplement|vacina|manipula|generico|gen[eé]rico|" +
  "comprimido|c[aá]psula|dipirona|paracetamol|ibuprofeno|amoxicilina|antibi[oó]tico|xarope|" +
  "anti-inflamat|analg[eé]sico|antit[eé]rmico|insulina|soro fisiol|teste de|exame";

// Termos "fit/congelados" dos mercados: demanda real que o top-vendas não cobre.
const GROCER_FT = "sorvete;acai;zero acucar;sem acucar;proteico;yopro;whey;diet;light;sem lactose;sem gluten";

const SOURCES: Source[] = [
  { key: "oba", origin: "https://secure.obahortifruti.com.br", max: 1500, ft: GROCER_FT },
  { key: "divvino", origin: "https://www.divvino.com.br", max: 1000 },
  { key: "naturaldaterra", origin: "https://www.naturaldaterra.com.br", max: 1000, ft: GROCER_FT },
  { key: "cobasi", origin: "https://www.cobasi.com.br", max: 1000 },
  { key: "rihappy", origin: "https://www.rihappy.com.br", max: 1200 },
  { key: "swift", origin: "https://loja.swift.com.br", max: 1000, ft: GROCER_FT },
  { key: "kopenhagen", origin: "https://www.kopenhagen.com.br", max: 300 },
  {
    key: "paguemenos",
    origin: "https://www.paguemenos.com.br",
    max: 400,
    categories: "200,300,400,600",
    deny: PHARMACY_DENY
  },
  // 25–27/09: lojas da compra por API (sem operador). Mesmos parâmetros da colheita original.
  // 28/09: Americanas (VTEX, fechou por API; mínimo R$30; "Entrega 2h" no endereço do dono).
  // Marketplace: só o seller "1" (a própria Americanas). Categorias do dia a dia; remédio,
  // gift card e seguro fora.
  {
    key: "americanas", origin: "https://www.americanas.com.br", max: 6000, seller: "1",
    categories: "322,1087,1251,1522,3052,3714,4084,4254,3600,1402,3125,2709,1639,2547,3902",
    deny: `${PHARMACY_DENY}|gift ?card|vale.?presente|seguro|recarga`,
    ft: "arroz;feijao;leite;cafe;acucar;oleo;macarrao;biscoito;chocolate;papel higienico;detergente;sabao em po;amaciante;desinfetante;fralda;lenco umedecido;shampoo;condicionador;sabonete;desodorante;creme dental;racao;areia gato;pilha;lampada;panela",
  },
  { key: "aramis", origin: "https://www.aramis.com.br", max: 1500 },
  { key: "capodarte", origin: "https://www.capodarte.com.br", max: 1500 },
  { key: "cea", origin: "https://www.cea.com.br", max: 4000 },
  { key: "santaluzia", origin: "https://www.santaluzia.com.br", max: 4000, ft: "arroz;feijao;azeite;queijo;vinho;cafe;chocolate;massa;biscoito;leite;manteiga;pao" },
  { key: "drogariacatarinense", origin: "https://www.drogariacatarinense.com.br", max: 3000, deny: PHARMACY_DENY, ft: "shampoo;condicionador;sabonete;fralda;desodorante;creme dental;escova de dente;protetor solar;absorvente;lenco umedecido;hidratante;papel higienico;maquiagem;perfume;algodao" },
  { key: "drogariaspacheco", origin: "https://www.drogariaspacheco.com.br", max: 4000, deny: PHARMACY_DENY, ft: "shampoo;condicionador;sabonete;fralda;desodorante;creme dental;escova de dente;protetor solar;absorvente;lenco umedecido;hidratante;papel higienico;maquiagem;perfume;algodao" },
  { key: "extrafarma", origin: "https://www.extrafarma.com.br", max: 3000, deny: PHARMACY_DENY, ft: "shampoo;condicionador;sabonete;fralda;desodorante;creme dental;escova de dente;protetor solar;absorvente;lenco umedecido;hidratante;papel higienico;maquiagem;perfume;algodao" },
  { key: "farmaciaindiana", origin: "https://www.farmaciaindiana.com.br", max: 3000, deny: PHARMACY_DENY, ft: "shampoo;condicionador;sabonete;fralda;desodorante;creme dental;escova de dente;protetor solar;absorvente;lenco umedecido;hidratante;papel higienico;maquiagem;perfume;algodao" },
  { key: "fila", origin: "https://www.fila.com.br", max: 1500 },
  { key: "livrariascuritiba", origin: "https://www.livrariascuritiba.com.br", max: 4000, ft: "romance;infantil;autoajuda;negocios;quadrinhos;didatico;biografia;ficcao" },
  { key: "motorola", origin: "https://www.motorola.com.br", max: 500 },
  { key: "osklen", origin: "https://www.osklen.com.br", max: 1500 },
  { key: "pbkids", origin: "https://www.pbkids.com.br", max: 3000 },
  { key: "tokstok", origin: "https://www.tokstok.com.br", max: 4000 },
  { key: "underarmour", origin: "https://www.underarmour.com.br", max: 1500 },
  { key: "wepink", origin: "https://www.wepink.com.br", max: 1000 },
  { key: "savegnago", origin: "https://www.savegnago.com.br", max: 5000, ft: "arroz;feijao;leite;cafe;acucar;oleo;macarrao;pao;ovos;queijo;presunto;manteiga;iogurte;agua;refrigerante;cerveja;suco;biscoito;chocolate;papel higienico;detergente;sabao;amaciante;banana;tomate;cebola;batata;frango;carne;peixe" },
  { key: "covabra", origin: "https://www.covabra.com.br", max: 5000, ft: "arroz;feijao;leite;cafe;acucar;oleo;macarrao;pao;ovos;queijo;presunto;manteiga;iogurte;agua;refrigerante;cerveja;suco;biscoito;chocolate;papel higienico;detergente;sabao;amaciante;banana;tomate;cebola;batata;frango;carne;peixe" },
  { key: "zonasul", origin: "https://www.zonasul.com.br", max: 5000 },
  { key: "prezunic", origin: "https://www.prezunic.com.br", max: 5000 },
  { key: "mambo", origin: "https://www.mambo.com.br", max: 6000, ft: "arroz;feijao;leite;cafe;acucar;oleo;macarrao;pao;ovos;queijo;presunto;manteiga;iogurte;agua;refrigerante;cerveja;suco;biscoito;chocolate;papel higienico;detergente;sabao;amaciante;banana;tomate;cebola;batata;frango;carne;peixe" },
  { key: "epocacosmeticos", origin: "https://www.epocacosmeticos.com.br", max: 1200, rewriteHost: "www.epocacosmeticos.com.br", skuPrefix: "epoca" },
  {
    key: "drogal", origin: "https://www.drogal.com.br", max: 1500,
    categories: "1,3,5,7,30,38,52,62,77,90,94,121,195,372,382,329,456,258",
    deny: "(analg[eé]s|antit[eé]rm|anti-?inflam|antibi[oó]t|antial[eé]rg|antigrip|dipirona|paracetamol|ibuprofen|loratadina|omeprazol|nimesulida|dorflex|neosaldina|vitamina|suplement|nutrac|polivitam|medicament|rem[eé]dio|comprimid|c[aá]psula|xarope|col[ií]rio|anest[eé]s|antiss[eé]ptico|descongest|nasal|gotas|mg\\b)"
  },
  { key: "martinsfontes", origin: "https://www.martinsfontespaulista.com.br", max: 4000, ft: "romance;literatura brasileira;ficcao;fantasia;suspense;filosofia;historia;psicologia;arte;arquitetura;design;fotografia;infantil;juvenil;quadrinhos;manga;poesia;biografia;culinaria;autoajuda;negocios;economia;politica;sociologia;direito;ciencia;religiao;viagem;dicionario;classicos" },
  { key: "brinox", origin: "https://www.brinox.com.br", max: 2000, ft: "panela;frigideira;faqueiro;talher;pote;garrafa;assadeira;chaleira;travessa;jarra;caneca;copo;prato;tabua;espremedor;escorredor;organizador;lixeira;utensilio;forma" },
  { key: "creamy", origin: "https://www.creamy.com.br", max: 600 },
  { key: "casaevideo", origin: "https://www.casaevideo.com.br", max: 4000, rewriteHost: "www.casaevideo.com.br", ft: "toalha;lencol;travesseiro;edredom;cortina;tapete;panela;copo;prato;organizador;ventilador;liquidificador;cafeteira;ferro;aspirador;luminaria;espelho;cabide;cesto;pote;garrafa;talher;jogo de cama;almofada;vaso" },
  { key: "telhanorte", origin: "https://www.telhanorte.com.br", max: 3000, ft: "tinta;lampada;torneira;chuveiro;fechadura;parafuso;furadeira;extensao;tomada;interruptor;cola;fita;pincel;rolo;veda;silicone;registro;ralo;vaso sanitario;assento;prateleira;suporte;escada;mangueira;ferramenta" },
  { key: "zonacriativa", origin: "https://www.zonacriativa.com.br", max: 2000, ft: "caneca;copo;garrafa;luminaria;vela;quadro;almofada;organizador;presente;decoracao;jogo;brinquedo;pelucia;chaveiro;mochila;necessaire;papelaria;agenda;caderno;cozinha" },
  { key: "philco", origin: "https://www.philco.com.br", max: 1500, ft: "ventilador;liquidificador;air fryer;fritadeira;cafeteira;micro-ondas;aspirador;ferro;sanduicheira;batedeira;tv;caixa de som;fone;panela eletrica;secador;chapinha;umidificador;purificador;forno" },
  { key: "mondial", origin: "https://www.mondial.com.br", max: 1500, ft: "liquidificador;ventilador;air fryer;fritadeira;cafeteira;sanduicheira;batedeira;mixer;processador;panela;grill;secador;chapinha;espremedor;ferro;aspirador;torradeira;forno;chaleira" },
  { key: "oxford", origin: "https://www.oxfordporcelanas.com.br", max: 1200, ft: "prato;xicara;caneca;bowl;tigela;travessa;jogo de jantar;aparelho de jantar;sobremesa;sopa;bule;pires;saladeira;porcelana" },
  { key: "polishop", origin: "https://www.polishop.com.br", max: 1500, ft: "aspirador;air fryer;panela;faca;ventilador;massageador;organizador;limpeza;cozinha;beleza;fitness;travesseiro;colchao;cafeteira;grill" },
  { key: "obramax", origin: "https://www.obramax.com.br", max: 2500, ft: "tinta;lampada;torneira;chuveiro;fechadura;parafuso;furadeira;extensao;tomada;interruptor;cola;fita;pincel;rolo;silicone;registro;ralo;vaso sanitario;prateleira;escada;mangueira;ferramenta;piso;argamassa;cimento" },
  {
    key: "drogariasp",
    skuPrefix: "dsp",
    origin: "https://www.drogariasaopaulo.com.br",
    max: 200,
    categories:
      "873,1135,1161,1192,1160,893,1165,1123,1238,1240,1241,1242,1243,1244,1245,1246,1257,1267," +
      "1269,1273,1303,1304,1308,1318,1319,1328,1334,1496,1500,1528,1554",
    deny: PHARMACY_DENY
  }
];

// Imigrantes não é VTEX: tem coletor próprio (páginas server-rendered).
const CUSTOM: Array<{ key: string; script: string; args: (out: string) => string[] }> = [
  {
    key: "imigrantes",
    script: "scripts/harvest-imigrantes-catalog.mts",
    args: (out) => [out, "900"]
  }
];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry");
const only = new Set(argv.filter((a) => !a.startsWith("--")));
const wanted = (key: string) => only.size === 0 || only.has(key);

function catalogPath(key: string): string {
  return `src/lib/stores/${key}-catalog.ts`;
}

/** sku -> preço, lido de um arquivo de catálogo gerado. */
function readPrices(file: string): Map<string, number> {
  const prices = new Map<string, number>();
  if (!existsSync(file)) return prices;
  const raw = readFileSync(file, "utf8");
  // Os arquivos gerados usam chaves sem aspas (sku: "x", ... unitPrice: 9.9).
  const re = /sku:\s*"([^"]+)"[\s\S]{0,400}?unitPrice:\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) prices.set(m[1], Number(m[2]));
  return prices;
}

function run(script: string, args: string[]): boolean {
  try {
    execFileSync("node", ["--import", "tsx", script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: Buffer }).stderr ?? "") : "";
    console.error(`   ✖ falhou: ${stderr.split("\n").slice(-3).join(" ").trim() || error}`);
    return false;
  }
}

type Report = {
  key: string;
  before: number;
  after: number;
  changed: number;
  added: number;
  removed: number;
  avgDeltaPct: number;
  biggest: Array<{ sku: string; from: number; to: number }>;
};

function compare(key: string, before: Map<string, number>, after: Map<string, number>): Report {
  let changed = 0;
  let deltaSum = 0;
  const moves: Array<{ sku: string; from: number; to: number }> = [];
  for (const [sku, newPrice] of after) {
    const oldPrice = before.get(sku);
    if (oldPrice == null) continue;
    if (Math.abs(oldPrice - newPrice) < 0.005) continue;
    changed += 1;
    deltaSum += (newPrice - oldPrice) / oldPrice;
    moves.push({ sku, from: oldPrice, to: newPrice });
  }
  moves.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  let added = 0;
  for (const sku of after.keys()) if (!before.has(sku)) added += 1;
  let removed = 0;
  for (const sku of before.keys()) if (!after.has(sku)) removed += 1;
  return {
    key,
    before: before.size,
    after: after.size,
    changed,
    added,
    removed,
    avgDeltaPct: changed ? (deltaSum / changed) * 100 : 0,
    biggest: moves.slice(0, 3)
  };
}

const reports: Report[] = [];
const failed: string[] = [];
// No modo --dry a colheita vai para um arquivo temporário e o catálogo real não é tocado.
// Colheita SEMPRE em arquivo temporário (27/09, rotina semanal sem supervisão): o catálogo real
// só é trocado se a nova colheita tiver pelo menos MIN_KEEP do tamanho anterior — loja que
// bloqueou ou mudou de layout nunca apaga um catálogo bom.
const work = mkdtempSync(join(tmpdir(), "lia-catalog-"));
const scratch = dryRun ? work : null;
const MIN_KEEP = Number(process.env.LIA_CATALOG_MIN_KEEP ?? 0.6);
function accept(key: string, tempFile: string, target: string, before: Map<string, number>, after: Map<string, number>, rewriteHost?: string): boolean {
  const prefixOf = (m: Map<string, number>) => [...m.keys()][0]?.replace(/\d+$/, "");
  if (before.size && after.size && prefixOf(before) !== prefixOf(after)) {
    console.error(`   ✖ prefixo de SKU mudou (${prefixOf(before)} → ${prefixOf(after)}) — catálogo anterior preservado`);
    return false;
  }
  if (after.size === 0 || (before.size > 0 && after.size < before.size * MIN_KEEP)) {
    console.error(`   ✖ colheita encolheu (${before.size} → ${after.size}) — catálogo anterior preservado`);
    return false;
  }
  if (!dryRun) {
    let text = readFileSync(tempFile, "utf8");
    if (rewriteHost) text = text.replace(/https:\/\/[a-z0-9-]+\.vtexcommercestable\.com\.br/g, `https://${rewriteHost}`);
    writeFileSync(target, text);
  }
  return true;
}

for (const source of SOURCES) {
  if (!wanted(source.key)) continue;
  const target = catalogPath(source.key);
  const out = join(work, `${source.key}.ts`);
  const before = readPrices(target);
  process.stdout.write(`→ ${source.key.padEnd(16)}`);
  // O 2º argumento do coletor vira o prefixo do SKU: tem de ser o MESMO do catálogo em uso,
  // senão todos os SKUs mudam (27/09: drogariasp virou "drogariasp-" e quebraria a busca/compra).
  const args = [source.origin, source.skuPrefix ?? source.key, out, String(source.max)];
  if (source.categories) args.push(`--categories=${source.categories}`);
  if (source.deny) args.push(`--deny=${source.deny}`);
  if (source.seller) args.push(`--seller=${source.seller}`);
  if (source.ft) args.push(`--ft=${source.ft}`);
  if (!run("scripts/harvest-vtex-catalog.mts", args)) {
    failed.push(source.key);
    continue;
  }
  const after = readPrices(out);
  if (!accept(source.key, out, target, before, after, source.rewriteHost)) {
    failed.push(source.key);
    continue;
  }
  const report = compare(source.key, before, after);
  reports.push(report);
  console.log(
    `${String(report.after).padStart(5)} itens · ${report.changed} preços mudaram · +${report.added}/-${report.removed}`
  );
}

for (const custom of CUSTOM) {
  if (!wanted(custom.key)) continue;
  const target = catalogPath(custom.key);
  const out = join(work, `${custom.key}.ts`);
  const before = readPrices(target);
  process.stdout.write(`→ ${custom.key.padEnd(16)}`);
  if (!run(custom.script, custom.args(out))) {
    failed.push(custom.key);
    continue;
  }
  const after = readPrices(out);
  if (!accept(custom.key, out, target, before, after)) {
    failed.push(custom.key);
    continue;
  }
  const report = compare(custom.key, before, after);
  reports.push(report);
  console.log(
    `${String(report.after).padStart(5)} itens · ${report.changed} preços mudaram · +${report.added}/-${report.removed}`
  );
}

// Remédio isento (29/09): uma colheita, dois catálogos (Drogaria SP e Pague Menos). Mesma trava
// das outras lojas: colheita que encolhe ou muda de prefixo não substitui o catálogo em uso.
if (wanted("mip")) {
  console.log(`→ ${"mip".padEnd(16)}`);
  if (!run("scripts/harvest-mip-catalog.mts", [`--out-dir=${work}`])) {
    failed.push("mip");
  } else {
    for (const key of ["drogariasp-mip", "paguemenos-mip"]) {
      const target = catalogPath(key);
      const out = join(work, `${key}-catalog.ts`);
      const before = readPrices(target);
      const after = readPrices(out);
      process.stdout.write(`  ${key.padEnd(16)}`);
      if (!accept(key, out, target, before, after)) {
        failed.push(key);
        continue;
      }
      const report = compare(key, before, after);
      reports.push(report);
      console.log(`${String(report.after).padStart(5)} itens · ${report.changed} preços mudaram · +${report.added}/-${report.removed}`);
    }
  }
}

console.log("\n" + "─".repeat(72));
console.log(dryRun ? "SIMULAÇÃO (nenhum arquivo alterado)" : "CATÁLOGOS ATUALIZADOS");
console.log("─".repeat(72));

const totalAfter = reports.reduce((sum, r) => sum + r.after, 0);
const totalChanged = reports.reduce((sum, r) => sum + r.changed, 0);
for (const r of reports) {
  const drift = r.changed ? ` · variação média ${r.avgDeltaPct >= 0 ? "+" : ""}${r.avgDeltaPct.toFixed(1)}%` : "";
  console.log(`${r.key.padEnd(16)} ${String(r.after).padStart(5)} itens${drift}`);
  for (const m of r.biggest) {
    console.log(`                 ${m.sku}: R$ ${m.from.toFixed(2)} → R$ ${m.to.toFixed(2)}`);
  }
}
console.log(`\n${totalAfter} itens nas lojas recolhidas · ${totalChanged} preços mudaram desde a última colheita`);
if (failed.length) console.log(`⚠️  falharam (catálogo antigo preservado): ${failed.join(", ")}`);

console.log(
  "\nLojas fora desta rotina (colheita manual): giulianaflores (navegador), carrefour, petz,\n" +
    "boticario (anti-bot), kalunga, cacaushow, decathlon, drogaraia (seeds pequenos)."
);
if (!dryRun) {
  console.log("\nPróximo passo: conferir o resumo, rodar `npm test`, commitar os *-catalog.ts e implantar.");
}
// Resumo legível por máquina (rotina semanal): uma linha JSON no fim.
console.log(`\nREFRESH_SUMMARY ${JSON.stringify({ stores: reports.length, items: totalAfter, changed: totalChanged, failed })}`);
