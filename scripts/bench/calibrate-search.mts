// Concordância do juiz da BUSCA com rótulos à mão (evals/calibracao-busca-rotulos.json). Meta: ≥ 95%.
//   npx tsx scripts/bench/calibrate-search.mts [--repeat 3]
// "acceptable" e "exact" contam como o mesmo lado (bom); a meta é acertar bom × errado, que é o que o placar usa.
import "../talk-env.mts";
import { readFileSync } from "node:fs";
import { judge } from "./judge.mts";
const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1] || 1) || 1;
const { casos } = JSON.parse(readFileSync("evals/calibracao-busca-rotulos.json", "utf8")) as { casos: Array<{ pedido: string; produto: string; loja: string; esperado: string }> };
const good = (v: string | undefined) => v === "exact" || v === "acceptable";
let agree = 0, total = 0;
const diff: string[] = [];
for (let round = 0; round < repeat; round++) {
  await Promise.all(casos.map(async (c, i) => {
    const out = await judge({ request: c.pedido, items: [{ id: `P${i}`, store: c.loja, name: c.produto, brand: "", price: 0 }] });
    const got = out?.kind === "medicine" ? "wrong" : out?.verdicts[`P${i}`];
    total++;
    if (good(got) === good(c.esperado)) agree++;
    else diff.push(`r${round + 1} "${c.pedido}" × ${c.produto.slice(0, 60)} → juiz=${got} rótulo=${c.esperado} (${out?.note?.slice(0, 90)})`);
  }));
}
console.log(`concordância bom×errado ${agree}/${total} = ${((100 * agree) / total).toFixed(1)}% (votos por chamada: ${process.env.BENCH_JUDGE_VOTES ?? 3})`);
for (const d of diff) console.log("  " + d);
process.exit(0);
