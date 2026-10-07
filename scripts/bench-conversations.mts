// PLACAR DE CONVERSAS (06/10/2026). Um "cliente" (LLM, objetivo + persona + armadilhas) conversa
// com a Lia de verdade (cérebro completo, lojas ao vivo, IA real, Postgres embutido próprio,
// pagamento SEMPRE simulado — o cliente para quando aparece o Pix) e um JUIZ mais forte lê a
// transcrição com um roteiro fixo. Os cenários nascem de conversas e reclamações REAIS
// (evals/conversation-scenarios.json). Mede: objetivo cumprido, produto certo, mentira/promessa
// falsa, beco sem saída, erro técnico e tempo de resposta.
//
//   npx tsx scripts/bench-conversations.mts --label antes [--only c01,c02] [--concurrency 2] [--verbose]
import "./talk-env.mts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBenchDb } from "./bench/db.mts";

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const label = arg("label", "run")!;
const only = arg("only")?.split(",");
const concurrency = Number(arg("concurrency", "2"));
const verbose = args.includes("--verbose");
const MAX_TURNS = Number(arg("turns", "18"));

process.env.LIA_AUTO_PURCHASE_STORES ??=
  "drogariasp,cobasi,paguemenos,swift,kopenhagen,rihappy,mambo,epocacosmeticos,drogal,casaevideo,obramax,brinox,creamy,telhanorte,zonacriativa,philco,oxford,polishop";

type Scenario = {
  id: string; title: string; origin: string; persona: string; goal: string; opening: string;
  name: string; cpf: string; address: string; traps?: string; expect: "reach_pix" | "honest_not_found" | "cancel_ok" | "answer_only";
};

async function llm(model: string, system: string, user: string, schema?: object): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model, input: [{ role: "system", content: system }, { role: "user", content: user }], ...(schema ? { text: { format: { type: "json_schema", name: "out", strict: true, schema } } } : {}) })
      });
      if (!res.ok) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      const p = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const t = p.output_text ?? p.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text;
      if (t) return t;
    } catch { /* retry */ }
  }
  return "";
}

const SIM_SYSTEM = (s: Scenario) => `Você é um cliente brasileiro real conversando com a Lia, uma assistente de compras no WhatsApp. Escreva como pessoa de verdade: curto, informal, às vezes sem acento. UMA mensagem por vez, sem aspas, sem explicar.
Persona: ${s.persona}
Objetivo: ${s.goal}
Seus dados (só dê quando a Lia pedir): nome ${s.name}; CPF ${s.cpf}; endereço de entrega ${s.address}.
${s.traps ? `Comportamentos a testar durante a conversa (faça no momento natural): ${s.traps}` : ""}
Regras: responda só o que a Lia perguntou ou ofereceu. Quando a Lia mostrar opções, escolha pelo número ou descrevendo (como uma pessoa faria). Quando perguntar a forma de pagamento, escolha Pix. Quando a Lia enviar o código Pix copia-e-cola (ou disser que gerou a cobrança), responda exatamente FIM. Se o objetivo for impossível (a Lia disse que não achou/não tem), reaja como uma pessoa (pode tentar outra coisa uma vez) e depois diga FIM. Se estiver confuso, irritado ou em loop depois de 2 tentativas, diga FIM. Nunca diga que é uma IA nem fale de teste.`;

const JUDGE_SYSTEM = `Você é um auditor rigoroso de qualidade de um serviço de compras no WhatsApp (a "Lia"). Recebe o CENÁRIO (objetivo e comportamento esperado do cliente) e a TRANSCRIÇÃO (cliente × Lia, com tempo de resposta em segundos). Avalie friamente, como um cliente exigente:
- goalReached: o objetivo foi cumprido? (expect=reach_pix: chegou ao Pix com os produtos certos; honest_not_found: disse com clareza que não achou e não vendeu nada errado; cancel_ok: cancelou/limpou certo; answer_only: respondeu corretamente a pergunta).
- wrongProduct: mostrou/ofereceu/adicionou produto que NÃO é o pedido (tipo errado, atributo violado)?
- falseClaim: disse algo falso ou prometeu o que não pode cumprir (taxa, prazo, estoque, estorno, "separando", quem recebe o Pix, remédio…)?
- deadEnd: o cliente ficou sem caminho (laço, mesma pergunta repetida, "não entendi" seguido, erro técnico, sem resposta)?
- confusing: respostas longas demais, redundantes, ignorou o que o cliente disse, perguntou o que já sabia, tom ruim.
- slow: alguma resposta demorou mais de 20 s?
Liste cada defeito concreto em "defects" (turno, descrição curta, gravidade high/medium/low). Seja específico e não elogie por educação.`;

const JUDGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["goalReached", "wrongProduct", "falseClaim", "deadEnd", "confusing", "slow", "defects", "summary"],
  properties: {
    goalReached: { type: "boolean" }, wrongProduct: { type: "boolean" }, falseClaim: { type: "boolean" }, deadEnd: { type: "boolean" }, confusing: { type: "boolean" }, slow: { type: "boolean" },
    summary: { type: "string" },
    defects: { type: "array", items: { type: "object", additionalProperties: false, required: ["turn", "what", "severity"], properties: { turn: { type: "integer" }, what: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] } } } }
  }
};

async function main() {
  await (await import("./bench/preflight.mts")).assertOpenAiAlive();
  const db = await startBenchDb();
  try {
    const { prisma } = await import("../src/lib/prisma");
    const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
    const { handleDeliveryMessage, runTurnScoped } = await import("../src/lib/delivery-service");
    let scenarios: Scenario[] = JSON.parse(readFileSync(join(process.cwd(), "evals", "conversation-scenarios.json"), "utf8"));
    if (only) scenarios = scenarios.filter((s) => only.includes(s.id));
    console.log(`bench-conversations "${label}" · ${scenarios.length} cenários · cliente gpt-5.4 · juiz ${process.env.BENCH_JUDGE_MODEL ?? "gpt-5.5"}`);

    // Saída por telefone (as conversas rodam em paralelo no mesmo processo).
    const outbox = new Map<string, string[]>();
    (whatsappAdapter as any).sendMessage = async (to: string, text: string) => { (outbox.get(to.replace(/\D/g, "")) ?? outbox.set(to.replace(/\D/g, ""), []).get(to.replace(/\D/g, ""))!).push(text); return { provider: "bench", to, text }; };
    (whatsappAdapter as any).sendMedia = async (to: string, text: string, url?: string) => (whatsappAdapter as any).sendMessage(to, `${text}${url ? `\n[foto]` : ""}`);

    const results: any[] = [];
    let next = 0;
    let seq = 0;
    async function runScenario(s: Scenario, index: number) {
      const phone = `+5500994${String(100000 + index * 7 + (Date.now() % 7)).slice(-6)}${String(process.pid % 100).padStart(2, "0")}`;
      const key = phone.replace(/\D/g, "");
      const transcript: Array<{ who: "cliente" | "lia"; text: string; sec?: number }> = [];
      let userMsg = s.opening;
      let latencyMax = 0;
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        transcript.push({ who: "cliente", text: userMsg });
        outbox.set(key, []);
        const t0 = Date.now();
        try {
          await runTurnScoped(() => handleDeliveryMessage({ phone, text: userMsg, messageId: `bench_${s.id}_${Date.now()}_${++seq}` }));
        } catch (error) {
          transcript.push({ who: "lia", text: `[ERRO INTERNO: ${error instanceof Error ? error.message.slice(0, 120) : error}]`, sec: (Date.now() - t0) / 1000 });
        }
        const sec = (Date.now() - t0) / 1000;
        latencyMax = Math.max(latencyMax, sec);
        const replies = outbox.get(key) ?? [];
        transcript.push({ who: "lia", text: replies.length ? replies.join("\n---\n") : "(sem resposta)", sec: Math.round(sec * 10) / 10 });
        if (userMsg.trim().toUpperCase() === "FIM") break;
        const history = transcript.map((m) => `${m.who === "cliente" ? "VOCÊ" : "LIA"}: ${m.text}`).join("\n");
        const reply = (await llm("gpt-5.4", SIM_SYSTEM(s), `Conversa até agora:\n${history}\n\nSua próxima mensagem (ou FIM):`)).trim().replace(/^"|"$/g, "");
        userMsg = reply || "FIM";
        if (/c[oó]pia e cola|copia e cola|00020126/i.test(replies.join(" "))) userMsg = "FIM";
        if (userMsg.toUpperCase() === "FIM") { transcript.push({ who: "cliente", text: "FIM" }); break; }
      }
      const rendered = transcript.map((m, i) => `[${i}] ${m.who === "cliente" ? "CLIENTE" : `LIA (${m.sec ?? "?"}s)`}: ${m.text}`).join("\n");
      const verdictText = await llm(process.env.BENCH_JUDGE_MODEL ?? "gpt-5.5", JUDGE_SYSTEM, `CENÁRIO\nTítulo: ${s.title}\nObjetivo do cliente: ${s.goal}\nComportamento esperado (expect): ${s.expect}\n${s.traps ? `Armadilhas: ${s.traps}\n` : ""}\nTRANSCRIÇÃO\n${rendered}`, JUDGE_SCHEMA);
      let verdict: any = null;
      try { verdict = JSON.parse(verdictText); } catch { /* juiz falhou */ }
      const ended = transcript.some((m) => m.who === "cliente" && m.text.trim().toUpperCase() === "FIM");
      results.push({ id: s.id, title: s.title, origin: s.origin, expect: s.expect, turns: transcript.filter((m) => m.who === "cliente").length, latencyMax, ended, verdict, transcript });
      if (verbose) console.log(`\n=== ${s.id} ${s.title}\n${rendered}\n→ ${JSON.stringify(verdict)}`);
      process.stdout.write(verdict ? (verdict.goalReached && !verdict.wrongProduct && !verdict.falseClaim && !verdict.deadEnd ? "." : "F") : "?");
      // limpeza do telefone de teste
      const user = await prisma.user.findUnique({ where: { phone } });
      if (user) {
        const convos = await prisma.conversation.findMany({ where: { userId: user.id }, select: { id: true } });
        await prisma.message.deleteMany({ where: { conversationId: { in: convos.map((c) => c.id) } } });
        await prisma.deliveryOrder.deleteMany({ where: { userId: user.id } });
        await prisma.conversation.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      }
    }
    async function worker() { for (;;) { const i = next++; const s = scenarios[i]; if (!s) return; await runScenario(s, i); } }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log("\n");

    const judged = results.filter((r) => r.verdict);
    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
    const summary = {
      label, at: new Date().toISOString(), scenarios: results.length, judged: judged.length,
      goalReached: pct(judged.filter((r) => r.verdict.goalReached).length, judged.length),
      wrongProduct: pct(judged.filter((r) => r.verdict.wrongProduct).length, judged.length),
      falseClaim: pct(judged.filter((r) => r.verdict.falseClaim).length, judged.length),
      deadEnd: pct(judged.filter((r) => r.verdict.deadEnd).length, judged.length),
      confusing: pct(judged.filter((r) => r.verdict.confusing).length, judged.length),
      slow: pct(judged.filter((r) => r.verdict.slow).length, judged.length),
      clean: pct(judged.filter((r) => r.verdict.goalReached && !r.verdict.wrongProduct && !r.verdict.falseClaim && !r.verdict.deadEnd).length, judged.length),
      highSeverityDefects: judged.reduce((n, r) => n + r.verdict.defects.filter((d: any) => d.severity === "high").length, 0)
    };
    mkdirSync(join(process.cwd(), "evals", "results"), { recursive: true });
    const file = join(process.cwd(), "evals", "results", `conversations-${new Date().toISOString().slice(0, 10)}-${label}.json`);
    writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    console.log(`\nArquivo: ${file}`);
  } finally {
    await db.stop();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
