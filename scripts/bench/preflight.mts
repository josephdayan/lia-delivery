// Antes de gastar 1 hora de benchmark: a chave da OpenAI tem crédito? (06/10: o crédito
// acabou no meio de um placar e metade das notas virou "juiz falhou" / fallback sem IA.)
export async function assertOpenAiAlive(models = [process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna", process.env.OPENAI_MODEL ?? "gpt-6-luna", process.env.BENCH_SIM_MODEL ?? "gpt-6-luna"]) {
  // Regra do dono (08/10, "falei mil vezes"): NADA roda em gpt-6-sol — nem juiz, nem cliente
  // simulado, nem a Lia. Só gpt-6-luna. Aborta antes de gastar um centavo.
  const forbidden = models.filter((m) => /sol/i.test(m));
  if (forbidden.length) {
    console.error(`\n✖ Modelo proibido pelo dono: ${forbidden.join(", ")}. Tudo roda em gpt-6-luna (OPENAI_MODEL, BENCH_JUDGE_MODEL, BENCH_SIM_MODEL).`);
    process.exit(4);
  }
  for (const model of models) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model, input: "ok", max_output_tokens: 16 })
    }).catch(() => null);
    if (!res || !res.ok) {
      const body = res ? (await res.text()).slice(0, 220) : "sem rede";
      console.error(`\n✖ OpenAI indisponível para ${model}: HTTP ${res?.status ?? "—"} ${body}\n  Se for "no credits remaining": adicione crédito em platform.openai.com/settings/organization/billing e rode de novo.`);
      process.exit(3);
    }
  }
}
