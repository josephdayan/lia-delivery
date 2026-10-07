// Concordância do juiz com os rótulos humanos (evals/calibracao-rotulos.json). Meta: ≥ 95%.
//   npx tsx scripts/bench/calibrate.mts evals/results/conversations-...-calibracao.json
import { readFileSync } from "node:fs";
const file = process.argv[2];
const data = JSON.parse(readFileSync(file, "utf8"));
const { rotulos } = JSON.parse(readFileSync("evals/calibracao-rotulos.json", "utf8"));
const isClean = (v: any) => Boolean(v && v.goalReached && !v.wrongProduct && !v.falseClaim && !v.deadEnd && !(v.defects ?? []).some((d: any) => d.severity === "high"));
let agree = 0, total = 0;
const diff: string[] = [];
for (const r of data.results) {
  if (!(r.id in rotulos) || !r.verdict) continue;
  total++;
  const j = isClean(r.verdict);
  if (j === rotulos[r.id]) agree++;
  else diff.push(`${r.id}: juiz=${j ? "limpa" : "falha"} rótulo=${rotulos[r.id] ? "limpa" : "falha"} — ${r.verdict.summary.slice(0, 120)}`);
}
console.log(`concordância ${agree}/${total} = ${((100 * agree) / total).toFixed(1)}%`);
for (const d of diff) console.log("  " + d);
