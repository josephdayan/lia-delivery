// CONFERE A ALCANÇABILIDADE dos cenários do placar de conversas (Fase 0 do plano-conversa-100).
// Para cada cenário com expect "reach_pix" o campo `probe` lista as buscas de produto que o cliente
// vai precisar; cada uma precisa ter pelo menos 1 item COMPRÁVEL AO VIVO no CEP do endereço do
// cenário: busca inteligente das lojas da vitrine (oráculo, seller "1" com estoque) que casa com
// TODAS as palavras da busca, e estoque/entrega confirmados pela simulação da própria loja
// (checkCandidatesLive). cancel_ok também precisa de item (chega ao total antes de desistir).
// honest_not_found com `probe` é conferido ao contrário (falha se o item EXISTE: cenário injusto);
// answer_only só informa. "-palavra" exclui, "<=N" limita o preço do item e "a||b" aceita qualquer alternativa. Não cobra nada, não usa banco nem OpenAI.
//
//   npx tsx scripts/bench/check-scenarios.mts [--only c01,c02] [--set treino|prova] [--verbose]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const only = arg("only")?.split(",");
const onlySet = arg("set");
const verbose = args.includes("--verbose");

process.env.LIA_AUTO_PURCHASE_STORES ??=
  "drogariasp,cobasi,paguemenos,swift,kopenhagen,rihappy,mambo,epocacosmeticos,drogal,casaevideo,obramax,brinox,creamy,telhanorte,zonacriativa,philco,oxford,polishop";

type Scenario = { id: string; title: string; address: string; expect: string; probe?: string[]; set?: string };

const STOP = new Set(["de", "da", "do", "das", "dos", "com", "para", "pra", "e", "a", "o", "em", "um", "uma", "sem"]);
function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/(\d)\s*(litros?|lts?)\b/g, "$1l")
    .replace(/(\d)\s*(quilos?|kgs?)\b/g, "$1kg")
    .replace(/(\d)\s*(gramas?|gr)\b/g, "$1g")
    .replace(/(\d)\s*(mls?)\b/g, "$1ml")
    .replace(/(\d)\s*(kg|g|ml|l)\b/g, "$1$2")
    .replace(/(\d),(\d)/g, "$1.$2");
}
// "<=80" na busca limita o preço do item (orçamento de presente: já descontado um frete típico).
function priceCap(query: string): number {
  const m = query.match(/<=\s*(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".")) : Infinity;
}
function matches(query: string, name: string) {
  query = query.replace(/<=\s*\d+(?:[.,]\d+)?/, "");
  const n = norm(name);
  // "-palavra" na busca EXCLUI itens cujo nome tem a palavra (ex.: "bola de tenis -caes").
  const raw = norm(query).split(/\s+/);
  const banned = raw.filter((t) => t.startsWith("-") && t.length > 2).map((t) => t.slice(1));
  if (banned.some((b) => n.includes(b.length > 3 ? b.replace(/s$/, "") : b))) return false;
  const tokens = raw.filter((t) => !t.startsWith("-")).join(" ").split(/[^a-z0-9.]+/).filter((t) => t && !STOP.has(t));
  return tokens.every((t) => {
    if (/^\d+(\.\d+)?(kg|g|ml|l)$/.test(t)) return new RegExp(`(^|[^0-9.])${t.replace(".", "\\.")}($|[^a-z0-9])`).test(n);
    const stem = t.length > 3 ? t.replace(/s$/, "") : t;
    return n.includes(stem);
  });
}
const cepOf = (address: string) => (address.match(/\d{5}-?\d{3}/)?.[0] ?? "").replace(/\D/g, "");

async function main() {
  const { storeServesCep } = await import("../../src/lib/store-areas");
  const { automaticPurchaseStores } = await import("../../src/lib/purchase-policy");
  const { VTEX_API_STORES } = await import("../../src/lib/purchase/vtex-checkout");
  const { checkCandidatesLive, liveKey } = await import("../../src/lib/live-availability");
  const { oraclePool } = await import("./oracle.mts");

  let scenarios: Scenario[] = JSON.parse(readFileSync(join(process.cwd(), "evals", "conversation-scenarios.json"), "utf8"));
  if (only) scenarios = scenarios.filter((s) => only.includes(s.id));
  if (onlySet) scenarios = scenarios.filter((s) => s.set === onlySet);

  const rows: Array<Record<string, string>> = [];
  let bad = 0;
  const cache = new Map<string, { buyable: number; matched: number; best: string }>();
  // "a||b" = qualquer uma das alternativas serve (presentes: perfume OU bombons OU kit).
  async function probeOne(query: string, cep: string): Promise<{ buyable: number; matched: number; best: string }> {
    if (query.includes("||")) {
      const parts = await Promise.all(query.split("||").map((q) => probeOne(q.trim(), cep)));
      const hit = parts.find((r) => r.buyable > 0);
      return hit ?? { buyable: 0, matched: parts.reduce((n, r) => n + r.matched, 0), best: "" };
    }
    const key = `${cep}|${query}`;
    if (cache.has(key)) return cache.get(key)!;
    const stores = automaticPurchaseStores().filter((k) => storeServesCep(k, cep) && VTEX_API_STORES[k]).map((k) => ({ key: k, domain: VTEX_API_STORES[k].domain, label: VTEX_API_STORES[k].label, prefix: VTEX_API_STORES[k].skuPrefix }));
    const searchText = query.replace(/<=\s*\d+(?:[.,]\d+)?/, "").replace(/(^|\s)-\S+/g, "").trim();
    const pool = await oraclePool(searchText, stores, 8);
    const cap = priceCap(query);
    const matched = pool.filter((p) => p.price <= cap && matches(query, `${p.brand} ${p.name}`)).sort((a, b) => a.price - b.price);
    let out = { buyable: 0, matched: matched.length, best: "" };
    if (matched.length) {
      const probe = matched.slice(0, 12);
      // A simulação das lojas tem timeout curto e oscila: até 3 tentativas antes de dar "sem item".
      let alive: typeof probe = [];
      for (let attempt = 0; attempt < 3 && !alive.length; attempt++) {
        const live = await checkCandidatesLive(probe.map((p) => ({ storeKey: p.storeKey, sku: p.sku })), cep);
        alive = probe.filter((p) => live.checks.get(liveKey(p.storeKey, p.sku))?.available === true);
      }
      out = { buyable: alive.length, matched: matched.length, best: alive[0] ? `${alive[0].store}: ${alive[0].name.slice(0, 48)} R$${alive[0].price.toFixed(2)}` : "" };
    }
    cache.set(key, out);
    return out;
  }

  // Modo exploração: --q "arroz 5kg|cafe em po" [--cep 01304001,01451001,...] sonda buscas soltas.
  const adhoc = arg("q");
  if (adhoc) {
    const ceps = (arg("cep") ?? "01304001,01451001,01426001,01310100").split(",");
    for (const q of adhoc.split("|")) {
      for (const cep of ceps) {
        const r = await probeOne(q.trim(), cep);
        rows.push({ probe: q.trim(), cep, result: r.buyable > 0 ? `ok (${r.buyable}/${r.matched})` : `SEM ITEM (${r.matched} casam)`, best: r.best });
      }
    }
    for (const r of rows) console.log(`${r.result.padEnd(22)} ${r.probe.padEnd(34)} ${r.cep} ${r.best}`);
    process.exit(0);
  }

  for (const s of scenarios) {
    const cep = cepOf(s.address);
    if (s.expect === "reach_pix" || s.expect === "cancel_ok") {
      if (!s.probe?.length) { rows.push({ id: s.id, set: s.set ?? "-", cep, probe: "(sem probe)", result: "FALTA PROBE", best: "" }); bad++; continue; }
      for (const q of s.probe) {
        const r = await probeOne(q, cep);
        const ok = r.buyable > 0;
        if (!ok) bad++;
        rows.push({ id: s.id, set: s.set ?? "-", cep, probe: q, result: ok ? `ok (${r.buyable}/${r.matched})` : `SEM ITEM (${r.matched} casam)`, best: r.best });
      }
    } else if (s.probe?.length) {
      const absent = s.expect === "honest_not_found";
      for (const q of s.probe) {
        const r = await probeOne(q, cep);
        const exists = r.buyable > 0;
        rows.push({ id: s.id, set: s.set ?? "-", cep, probe: q, result: absent ? (exists ? `AVISO: EXISTE (${r.buyable})` : "ok (ausente)") : (exists ? `info: existe (${r.buyable})` : "info: ausente"), best: r.best });
        if (absent && exists) bad++;
      }
    } else if (verbose) rows.push({ id: s.id, set: s.set ?? "-", cep, probe: `(${s.expect})`, result: "-", best: "" });
  }
  console.log(["id".padEnd(5), "set".padEnd(6), "cep".padEnd(8), "busca".padEnd(40), "resultado".padEnd(24), "melhor item comprável"].join(" "));
  for (const r of rows) console.log([r.id.padEnd(5), r.set.padEnd(6), r.cep.padEnd(8), r.probe.slice(0, 39).padEnd(40), r.result.padEnd(24), r.best].join(" "));
  console.log(bad ? `\n✖ ${bad} problema(s)` : "\n✔ todos os cenários reach_pix têm item comprável ao vivo");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
