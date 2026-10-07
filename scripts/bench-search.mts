// PLACAR DA BUSCA (06/10/2026). Passa cada pedido de evals/search-requests.json pela busca
// de produção da Lia (extração → candidatos → checagem ao vivo no CEP → rerank) e confronta
// com um ORÁCULO independente: o que as lojas reais vendem (busca inteligente ao vivo),
// julgado por um modelo mais forte (scripts/bench/judge.mts). Mede o que importa:
//   precisão  — nunca mostrar produto errado (principalmente na 1ª opção)
//   cobertura — achou quando existe para entregar
//   honestidade — disse "não achei" quando não existe (e nunca vendeu remédio)
//
//   npx tsx scripts/bench-search.mts --label antes [--limit 40] [--cat mercado] [--concurrency 4]
// Escreve evals/results/search-<data>-<label>.json e imprime o placar. Não cobra nem envia nada;
// usa Postgres embutido próprio (porta 54339). Precisa de OPENAI_API_KEY no .env.
import "./talk-env.mts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { startBenchDb } from "./bench/db.mts";

// A IA da Lia (extração/rerank) pode falhar (429 sem crédito, timeout): a busca cai no
// fallback determinístico e o resultado deixa de representar a produção. Cada pedido
// registra isso e vira "ia_indisponivel", fora das métricas — nunca uma nota enganosa.
const aiScope = new AsyncLocalStorage<{ aiFailed: string[] }>();
const originalWarn = console.warn.bind(console);
console.warn = (...parts: unknown[]) => {
  const head = String(parts[0] ?? "");
  const scope = aiScope.getStore();
  if (scope && /^\[ai:(rerank|extractShoppingList)(:fallback|:error)/.test(head)) scope.aiFailed.push(`${head} ${String(parts[1] ?? "").slice(0, 20)}`);
  originalWarn(...parts);
};

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const label = arg("label", "run")!;
const limit = Number(arg("limit", "0"));
const onlyCat = arg("cat");
const only = arg("only");
const concurrency = Number(arg("concurrency", "4"));

// Vitrine de produção (06/10): lojas de compra automática. A lista real é sensível (Vercel);
// este é o palpite do golden (AUTO_ROSTER) e vale igual antes/depois.
// Remédio isento (MIP) está LIGADO em produção desde 05/10: o placar mede a mesma Lia.
process.env.LIA_MEDICINE_MIP ??= "true";
process.env.LIA_AUTO_PURCHASE_STORES ??=
  "drogariasp,cobasi,paguemenos,swift,kopenhagen,rihappy,mambo,epocacosmeticos,drogal,casaevideo,obramax,brinox,creamy,telhanorte,zonacriativa,philco,oxford,polishop";

function benchCep(): string {
  if (process.env.BENCH_CEP) return process.env.BENCH_CEP;
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".retail-buyer", "config.json"), "utf8"));
    if (cfg?.probe?.cep) return String(cfg.probe.cep);
  } catch { /* sem config privado */ }
  return "01310100";
}

type Req = { id: string; text: string; cat: string; origin: string };
type Shown = { id: string; store: string; name: string; brand: string; price: number };

async function main() {
  await (await import("./bench/preflight.mts")).assertOpenAiAlive();
  const db = await startBenchDb();
  try {
    const { runShopperScoped, storeServesCep } = await import("../src/lib/store-areas");
    const brain = (await import("../src/lib/delivery-service")) as { searchOptionsForBench?: (q: string, cep: string) => Promise<{ options: any[]; closest: any[] }>; searchOptionsForPlanB: (q: string, cep: string) => Promise<any[]> };
    // Código antigo (sem o "mais perto") não tem searchOptionsForBench: o placar compara os dois.
    const searchOptionsForBench = brain.searchOptionsForBench ?? (async (q: string, c: string) => ({ options: await brain.searchOptionsForPlanB(q, c), closest: [] as any[] }));
    const { automaticPurchaseStores } = await import("../src/lib/purchase-policy");
    const { VTEX_API_STORES } = await import("../src/lib/purchase/vtex-checkout");
    const { oraclePool } = await import("./bench/oracle.mts");
    const { judge } = await import("./bench/judge.mts");
    const cep = benchCep();
    const stores = automaticPurchaseStores().filter((k) => storeServesCep(k, cep) && VTEX_API_STORES[k]).map((k) => ({ key: k, domain: VTEX_API_STORES[k].domain, label: VTEX_API_STORES[k].label, prefix: VTEX_API_STORES[k].skuPrefix }));
    let reqs: Req[] = JSON.parse(readFileSync(join(process.cwd(), "evals", arg("file", "search-requests.json")!), "utf8"));
    if (onlyCat) reqs = reqs.filter((r) => r.cat === onlyCat);
    if (only) reqs = reqs.filter((r) => r.text.toLowerCase().includes(only.toLowerCase()));
    if (limit) reqs = reqs.slice(0, limit);
    console.log(`bench-search "${label}" · ${reqs.length} pedidos · ${stores.length} lojas no oráculo · juiz ${process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna"} · Lia ${process.env.OPENAI_MODEL ?? "gpt-6-luna"}`);

    const results: any[] = [];
    let next = 0;
    async function worker() {
      for (;;) {
        const r = reqs[next++];
        if (!r) return;
        const t0 = Date.now();
        let shown: Shown[] = [];
        let closest: Array<{ store: string; name: string; price: number }> = [];
        let error: string | undefined;
        const scope = { aiFailed: [] as string[] };
        try {
          const found = await aiScope.run(scope, () => runShopperScoped(() => searchOptionsForBench(r.text, cep)));
          const options = found.options;
          // "Mais próximo" (Lia avisa a diferença; o cliente escolhe): fora da conta de acerto, só listado.
          closest = found.closest.map((o) => ({ store: o.storeLabel ?? o.storeKey ?? "", name: o.name, price: o.unitPrice }));
          shown = options.map((o, i) => ({ id: `S${i + 1}`, store: o.storeLabel ?? o.storeKey ?? "", name: o.name, brand: o.brand ?? "", price: o.unitPrice, _sku: `${o.storeKey}:${o.sku}` } as Shown));
        } catch (e) { error = e instanceof Error ? e.message.slice(0, 160) : String(e); }
        const ms = Date.now() - t0;
        const pool = (await oraclePool(r.text, stores, Number(process.env.BENCH_ORACLE_PER_STORE ?? 5))).map((p, i) => ({ ...p, jid: `O${i + 1}` }));
        const items = [...shown.map((s) => ({ id: s.id, store: s.store, name: s.name, brand: s.brand, price: s.price })), ...pool.map((p) => ({ id: p.jid, store: p.store, name: p.name, brand: p.brand, price: p.price }))];
        const verdict = await judge({ request: r.text, items });
        const v = verdict?.verdicts ?? {};
        const good = (id: string) => v[id] === "exact" || v[id] === "acceptable";
        const shownGood = shown.filter((s) => good(s.id));
        // "Existe" = existe E entrega no CEP: o oráculo só conta item que a simulação ao vivo da própria
        // loja confirma para o endereço (Swift/Mambo regionais, estoque por CEP).
        let poolGood = pool.filter((p) => good(p.jid));
        if (poolGood.length) {
          const { checkCandidatesLive, liveKey } = await import("../src/lib/live-availability");
          const probe = poolGood.slice(0, 6);
          const live = await checkCandidatesLive(probe.map((p) => ({ storeKey: p.storeKey, sku: p.sku })), cep);
          const alive = new Set(live.kept.map((c) => liveKey(c.storeKey, c.sku)));
          poolGood = probe.filter((p) => alive.has(liveKey(p.storeKey, p.sku)));
        }
        const kind = verdict?.kind ?? "product";
        let outcome: string;
        if (!verdict) outcome = "judge_failed";
        else if (error) outcome = "error";
        else if (scope.aiFailed.length) outcome = "ia_indisponivel";
        else if (kind === "medicine") outcome = shown.length ? "medicine_leak" : "medicine_ok";
        else if (!shown.length) outcome = poolGood.length ? "miss" : "honest_none";
        else if (!good(shown[0].id)) outcome = poolGood.length || shownGood.length ? "wrong_top1" : "false_positive";
        else outcome = shown.some((s) => !good(s.id)) ? "found_with_wrong_extra" : "found";
        results.push({ ...r, outcome, kind, ms, shown: shown.map((s) => ({ store: s.store, name: s.name, price: s.price, verdict: v[s.id] })), closest: closest.length ? closest : undefined, oracleGood: poolGood.slice(0, 5).map((p) => ({ store: p.store, name: p.name, price: p.price })), oracleSize: pool.length, note: verdict?.note, error, aiFailed: scope.aiFailed.length ? scope.aiFailed : undefined });
        process.stdout.write(`${outcome === "found" || outcome === "honest_none" || outcome === "medicine_ok" ? "." : outcome[0].toUpperCase()}`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log("\n");

    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    const nonMed = results.filter((r) => r.kind !== "medicine" && !["judge_failed", "ia_indisponivel", "error"].includes(r.outcome));
    const exists = nonMed.filter((r) => r.outcome === "found" || r.outcome === "found_with_wrong_extra" || r.outcome === "miss" || r.outcome === "wrong_top1");
    const found = nonMed.filter((r) => r.outcome === "found" || r.outcome === "found_with_wrong_extra");
    const noExist = nonMed.filter((r) => r.outcome === "honest_none" || r.outcome === "false_positive");
    const allShown = results.filter((r) => !["judge_failed", "ia_indisponivel", "error"].includes(r.outcome)).flatMap((r) => r.shown);
    const goodShown = allShown.filter((s: any) => s.verdict === "exact" || s.verdict === "acceptable");
    const medicine = results.filter((r) => r.kind === "medicine" && !["judge_failed", "ia_indisponivel", "error"].includes(r.outcome));
    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
    const lat = results.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      label, at: new Date().toISOString(), requests: results.length, cep: cep.slice(0, 5) + "-***", stores: stores.length,
      liaModel: process.env.OPENAI_MODEL ?? "gpt-6-luna", judgeModel: process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna",
      outcomes: Object.fromEntries([...new Set(results.map((r) => r.outcome))].map((o) => [o, count(o)])),
      top1WrongRate: pct(count("wrong_top1") + count("false_positive"), nonMed.length),
      precisionItems: pct(goodShown.length, allShown.length),
      coverage: pct(found.length, exists.length),
      honesty: pct(noExist.filter((r) => r.outcome === "honest_none").length, noExist.length),
      closestOffered: results.filter((r) => r.closest?.length).length,
      medicineLeaks: `${count("medicine_leak")}/${medicine.length}`,
      latencyMs: { p50: lat[Math.floor(lat.length * 0.5)], p90: lat[Math.floor(lat.length * 0.9)], max: lat[lat.length - 1] }
    };
    const byCat: Record<string, any> = {};
    for (const r of results) {
      const c = (byCat[r.cat] ??= { n: 0, found: 0, miss: 0, wrong: 0, honest: 0 });
      c.n++;
      if (r.outcome === "found" || r.outcome === "found_with_wrong_extra") c.found++;
      else if (r.outcome === "miss") c.miss++;
      else if (r.outcome === "wrong_top1" || r.outcome === "false_positive" || r.outcome === "medicine_leak") c.wrong++;
      else if (r.outcome === "honest_none" || r.outcome === "medicine_ok") c.honest++;
    }
    mkdirSync(join(process.cwd(), "evals", "results"), { recursive: true });
    const file = join(process.cwd(), "evals", "results", `search-${new Date().toISOString().slice(0, 10)}-${label}.json`);
    writeFileSync(file, JSON.stringify({ summary, byCat, results }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    console.table(byCat);
    console.log(`\nArquivo: ${file}`);
  } finally {
    await db.stop();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
