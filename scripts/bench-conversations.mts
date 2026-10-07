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
const onlySet = arg("set"); // treino | prova
const repeat = Math.max(1, Number(arg("repeat", "1")));
const concurrency = Number(arg("concurrency", "2"));
const verbose = args.includes("--verbose");
const MAX_TURNS = Number(arg("turns", "18"));

process.env.LIA_AUTO_PURCHASE_STORES ??=
  "drogariasp,cobasi,paguemenos,swift,kopenhagen,rihappy,mambo,epocacosmeticos,drogal,casaevideo,obramax,brinox,creamy,telhanorte,zonacriativa,philco,oxford,polishop";

type Scenario = {
  id: string; title: string; origin: string; persona: string; goal: string; opening: string;
  name: string; cpf: string; address: string; traps?: string; expect: "reach_pix" | "honest_not_found" | "cancel_ok" | "answer_only";
  set?: "treino" | "prova";
};

async function llm(model: string, system: string, user: string, schema?: object): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model, ...(model.includes("terra") || model.includes("sol") || model.includes("5.5") ? { reasoning: { effort: "low" } } : {}), input: [{ role: "system", content: system }, { role: "user", content: user }], ...(schema ? { text: { format: { type: "json_schema", name: "out", strict: true, schema } } } : {}) })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (body.includes("insufficient_quota")) { console.error("\n✖ OpenAI sem crédito — abortando."); process.exit(3); }
        console.error(`[llm:${model}] HTTP ${res.status} (tentativa ${attempt + 1}) ${body.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      const p = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      const t = p.output_text ?? p.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text;
      if (t) return t;
    } catch (error) {
      console.error(`[llm:${model}] ${error instanceof Error ? error.message.slice(0, 100) : error} (tentativa ${attempt + 1})`);
    }
  }
  return "";
}

const SIM_SYSTEM = (s: Scenario) => `Você é um cliente brasileiro real conversando com a Lia, uma assistente de compras no WhatsApp. Escreva como pessoa de verdade: curto, informal, às vezes sem acento. UMA mensagem por vez, sem aspas, sem explicar.
Persona: ${s.persona}
Objetivo: ${s.goal}
Seus dados (só dê quando a Lia pedir): nome ${s.name}; CPF ${s.cpf}; endereço de entrega ${s.address}.
${s.traps ? `Comportamentos a testar durante a conversa (faça no momento natural): ${s.traps}` : ""}
Regras: responda só o que a Lia perguntou ou ofereceu. Quando a Lia mostrar opções, escolha pelo número ou descrevendo (como uma pessoa faria). Quando perguntar a forma de pagamento, escolha Pix. Quando a Lia enviar o código Pix copia-e-cola (ou disser que gerou a cobrança), responda exatamente FIM. Se o objetivo for impossível (a Lia disse que não achou/não tem), reaja como uma pessoa (pode tentar outra coisa uma vez) e depois diga FIM. Se estiver confuso, irritado ou em loop depois de 2 tentativas, diga FIM. REGRA DE OURO: FIM só vale quando (a) apareceu o código Pix, ou (b) a Lia disse que não tem/não pode e você já tentou uma alternativa, ou (c) você ficou travado depois de 2 tentativas. NUNCA diga FIM na 1ª ou 2ª resposta da Lia: se ela pediu seu endereço, mande o endereço; se mostrou opções, escolha uma. Nunca diga que é uma IA nem fale de teste.`;

const JUDGE_SYSTEM = `Você é um auditor rigoroso de qualidade de um serviço de compras no WhatsApp (a "Lia"). Recebe o CENÁRIO (objetivo e comportamento esperado do cliente) e a TRANSCRIÇÃO (cliente × Lia, com tempo de resposta em segundos). Avalie friamente, como um cliente exigente:
- goalReached: o objetivo foi cumprido? (expect=reach_pix: chegou ao Pix com os produtos certos; honest_not_found: disse com clareza que não achou e não vendeu nada errado; cancel_ok: cancelou/limpou certo; answer_only: respondeu corretamente a pergunta).
- wrongProduct: mostrou/ofereceu/adicionou produto que NÃO é o pedido (tipo errado, atributo violado)?
- falseClaim: disse algo falso ou prometeu o que não pode cumprir (taxa, prazo, estoque, estorno, "separando", quem recebe o Pix, remédio…)?
- deadEnd: o cliente ficou sem caminho (laço, mesma pergunta repetida, "não entendi" seguido, erro técnico, sem resposta)?
- confusing: respostas longas demais, redundantes, ignorou o que o cliente disse, perguntou o que já sabia, tom ruim.
- slow: alguma resposta demorou mais de 20 s?
Liste cada defeito concreto em "defects" (turno, descrição curta, gravidade high/medium/low). Seja específico e não elogie por educação.

FATOS DO SERVIÇO (verdadeiros — não os trate como promessa falsa nem como defeito):
- Quando o cliente pede atendente, reclama, pede CNPJ/dados da empresa ou diz que um pedido sumiu, o sistema AVISA o responsável no WhatsApp dele na hora. "Avisei o responsável" é verdade. A resposta humana chega fora desta conversa de teste: NÃO conte como falha a ausência de resposta humana na transcrição; conte como falha se a Lia repetir a mesma frase, prometer prazo que não existe ou ignorar o que o cliente disse.
- Fora de SP e RJ o contato entra numa lista de espera por cidade (o dono vê e chama quando abrir). "Anotei seu contato e te chamo quando chegar aí" é verdade.
- A Lia Delivery é MEI: o Pix vai para a conta da empresa e o banco mostra o nome do responsável (pessoa física). Isso é verdade.
- A Lia pede o endereço com CEP UMA vez antes de mostrar opções (precisa dele para conferir estoque e frete da loja), guardando o pedido já feito. Isso é o fluxo normal, não defeito — defeito é perder o pedido ou pedir o endereço de novo.
- A Lia não vende medicamento (lei). Recusar remédio é correto.
- O responsável responde no WhatsApp das 9h às 20h (horário de atendimento configurado). Dizer isso é verdade.
- Estorno automático: pedido pago que a loja não confirmou é estornado sozinho em até 6 h, e o cliente é avisado. "Se algo não vier, o valor é estornado" é verdade.
- A loja vende por embalagem: ajustar a quantidade para a embalagem disponível é aceitável SE a Lia avisar ANTES de cobrar.
- Orçamento que o cliente disser vale para o TOTAL (produto + frete): a Lia deve respeitar ou avisar que não cabe.
- "(sandbox: responda paguei pra simular)" e códigos MOCKPIX são do ambiente de teste — ignore.
- "Me pede qualquer coisa" na saudação é exagero: conte como falseClaim leve só se a conversa depois contradisser (ex.: recusar algo comum sem explicar).

DEFEITOS GRAVES (gravidade "high", mesmo que o objetivo tenha sido cumprido):
- A Lia trata pedaço de frase do cliente como produto ("*Você consegue qualquer coisa* eu não achei", "*prático* eu não achei", "*Pode tentar de qualquer marca…* eu não achei").
- Ignora uma preferência EXPLÍCITA do cliente: "o mais barato" (as opções devem vir com a mais barata primeiro ou a Lia escolher a mais barata), marca, tamanho, "sem açúcar", orçamento.
- Pede de novo um dado que o cliente já deu (endereço, produto), ou duplica um item na cesta, ou muda a quantidade sem o cliente pedir.
- Repete a MESMA resposta duas vezes seguidas para mensagens diferentes do cliente. (Dizer "não achei" de novo para um produto NOVO/diferente que o cliente pediu NÃO é repetição.)
- Ignora um pedido de troca/alteração feito pelo cliente.
Lentidão (> 20 s) vai só no campo "slow" — nunca é defeito grave por si só. Produto que cumpre a função pedida com nome técnico diferente (ex.: "módulo carregador USB-C de tomada" para "carregador usb c") é aceitável, não é produto errado.`;

const JUDGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["goalReached", "wrongProduct", "falseClaim", "deadEnd", "confusing", "slow", "defects", "summary"],
  properties: {
    goalReached: { type: "boolean" }, wrongProduct: { type: "boolean" }, falseClaim: { type: "boolean" }, deadEnd: { type: "boolean" }, confusing: { type: "boolean" }, slow: { type: "boolean" },
    summary: { type: "string" },
    defects: { type: "array", items: { type: "object", additionalProperties: false, required: ["turn", "what", "severity"], properties: { turn: { type: "integer" }, what: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] } } } }
  }
};

// "Limpa" (07/10): objetivo cumprido, sem produto errado, sem promessa falsa, sem beco e SEM defeito grave.
function isClean(v: any) {
  return Boolean(v && v.goalReached && !v.wrongProduct && !v.falseClaim && !v.deadEnd && !(v.defects ?? []).some((d: any) => d.severity === "high"));
}
function passAtN(results: any[]) {
  const by = new Map<string, any[]>();
  for (const r of results) (by.get(r.id) ?? by.set(r.id, []).get(r.id)!).push(r);
  const ids = [...by.keys()];
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  const cleanIds = ids.filter((id) => by.get(id)!.every((r) => isClean(r.verdict)));
  const goalIds = ids.filter((id) => by.get(id)!.every((r) => r.verdict?.goalReached));
  const sets = ["treino", "prova"].map((set) => {
    const inSet = ids.filter((id) => by.get(id)![0].set === set);
    return [set, { cenarios: inSet.length, limpos: pct(inSet.filter((id) => cleanIds.includes(id)).length, inSet.length), objetivo: pct(inSet.filter((id) => goalIds.includes(id)).length, inSet.length) }];
  });
  return { cleanAllRuns: pct(cleanIds.length, ids.length), goalAllRuns: pct(goalIds.length, ids.length), porConjunto: Object.fromEntries(sets), falhando: ids.filter((id) => !cleanIds.includes(id)) };
}

function renderTranscript(transcript: Array<{ who: string; text: string; sec?: number }>) {
  return transcript.map((m, i) => `[${i}] ${m.who === "cliente" ? "CLIENTE" : `LIA (${m.sec ?? "?"}s)`}: ${m.text}`).join("\n");
}
// Voto da maioria entre N julgamentos (07/10: o mesmo juiz deu 95% e 85% de concordância em duas passadas).
// O veredito devolvido é o primeiro que concorda com a maioria em "limpa".
async function judgeScenario(s: Scenario, transcript: Array<{ who: string; text: string; sec?: number }>) {
  const votes = Number(process.env.BENCH_JUDGE_VOTES ?? 3);
  const prompt = `CENÁRIO\nTítulo: ${s.title}\nObjetivo do cliente: ${s.goal}\nComportamento esperado (expect): ${s.expect}\n${s.traps ? `Armadilhas: ${s.traps}\n` : ""}\nTRANSCRIÇÃO\n${renderTranscript(transcript)}`;
  const verdicts = (await Promise.all(Array.from({ length: votes }, async () => {
    const text = await llm(process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna", JUDGE_SYSTEM, prompt, JUDGE_SCHEMA);
    try { return JSON.parse(text); } catch { return null; }
  }))).filter(Boolean);
  if (!verdicts.length) return null;
  const cleanVotes = verdicts.filter((v) => isClean(v)).length;
  const majorityClean = cleanVotes * 2 > verdicts.length;
  const chosen = verdicts.find((v) => isClean(v) === majorityClean) ?? verdicts[0];
  return { ...chosen, votes: `${cleanVotes}/${verdicts.length} limpa` };
}

// --rejudge <arquivo>: julga de novo só as conversas que ficaram sem veredito (rate limit etc.).
async function rejudge(file: string) {
  const scenarios: Scenario[] = JSON.parse(readFileSync(join(process.cwd(), "evals", "conversation-scenarios.json"), "utf8"));
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const r of data.results) {
    if (r.verdict) continue;
    const sc = scenarios.find((x) => x.id === r.id)!;
    r.verdict = await judgeScenario(sc, r.transcript);
    process.stdout.write(r.verdict ? "." : "?");
  }
  const judged = data.results.filter((r: any) => r.verdict);
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  const clean = (r: any) => isClean(r.verdict);
  data.summary = { ...data.summary, judged: judged.length,
    goalReached: pct(judged.filter((r: any) => r.verdict.goalReached).length, judged.length),
    wrongProduct: pct(judged.filter((r: any) => r.verdict.wrongProduct).length, judged.length),
    falseClaim: pct(judged.filter((r: any) => r.verdict.falseClaim).length, judged.length),
    deadEnd: pct(judged.filter((r: any) => r.verdict.deadEnd).length, judged.length),
    confusing: pct(judged.filter((r: any) => r.verdict.confusing).length, judged.length),
    slow: pct(judged.filter((r: any) => r.verdict.slow).length, judged.length),
    clean: pct(judged.filter(clean).length, judged.length),
    highSeverityDefects: judged.reduce((n: number, r: any) => n + r.verdict.defects.filter((d: any) => d.severity === "high").length, 0),
    ...passAtN(data.results) };
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log("\n" + JSON.stringify(data.summary, null, 1));
  process.exit(0);
}

async function main() {
  const rejudgeFile = arg("rejudge");
  if (rejudgeFile) return rejudge(rejudgeFile);
  await (await import("./bench/preflight.mts")).assertOpenAiAlive();
  const db = await startBenchDb();
  try {
    const { prisma } = await import("../src/lib/prisma");
    const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
    const { handleDeliveryMessage, runTurnScoped } = await import("../src/lib/delivery-service");
    let scenarios: Scenario[] = JSON.parse(readFileSync(join(process.cwd(), "evals", "conversation-scenarios.json"), "utf8"));
    if (only) scenarios = scenarios.filter((s) => only.includes(s.id));
    if (onlySet) scenarios = scenarios.filter((s) => (s.set ?? "treino") === onlySet);
    // Unidades de execução: cada cenário roda `repeat` vezes (o cliente simulado varia).
    const units = scenarios.flatMap((s) => Array.from({ length: repeat }, (_, rep) => ({ s, rep })));
    console.log(`bench-conversations "${label}" · ${scenarios.length} cenários × ${repeat} · cliente gpt-6-luna · juiz ${process.env.BENCH_JUDGE_MODEL ?? "gpt-6-luna"}`);

    // Saída por telefone (as conversas rodam em paralelo no mesmo processo).
    const outbox = new Map<string, string[]>();
    (whatsappAdapter as any).sendMessage = async (to: string, text: string) => { (outbox.get(to.replace(/\D/g, "")) ?? outbox.set(to.replace(/\D/g, ""), []).get(to.replace(/\D/g, ""))!).push(text); return { provider: "bench", to, text }; };
    (whatsappAdapter as any).sendMedia = async (to: string, text: string, url?: string) => (whatsappAdapter as any).sendMessage(to, `${text}${url ? `\n[foto]` : ""}`);

    const results: any[] = [];
    let next = 0;
    let seq = 0;
    async function runScenario(s: Scenario, index: number, rep = 0) {
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
        const reply = (await llm(process.env.BENCH_SIM_MODEL ?? "gpt-6-luna", SIM_SYSTEM(s), `Conversa até agora:\n${history}\n\nSua próxima mensagem (ou FIM):`)).trim().replace(/^"|"$/g, "");
        userMsg = reply || "FIM";
        // Cliente simulado desistindo cedo demais é falha do simulador, não da Lia: pede de novo uma vez.
        if (userMsg.trim().toUpperCase() === "FIM" && turn < 2 && !/00020126|copia e cola|copia-e-cola/i.test(replies.join(" "))) {
          const again = (await llm(process.env.BENCH_SIM_MODEL ?? "gpt-6-luna", SIM_SYSTEM(s), `Conversa até agora:\n${history}\n\nA conversa mal começou: NÃO diga FIM. Responda ao que a Lia pediu ou ofereceu (endereço, escolha etc.):`)).trim().replace(/^"|"$/g, "");
          if (again && again.toUpperCase() !== "FIM") userMsg = again;
        }
        if (/c[oó]pia e cola|copia e cola|00020126/i.test(replies.join(" "))) userMsg = "FIM";
        if (userMsg.toUpperCase() === "FIM") { transcript.push({ who: "cliente", text: "FIM" }); break; }
      }
      const rendered = renderTranscript(transcript);
      const verdict: any = await judgeScenario(s, transcript);
      const ended = transcript.some((m) => m.who === "cliente" && m.text.trim().toUpperCase() === "FIM");
      results.push({ id: s.id, rep, set: s.set ?? "treino", title: s.title, origin: s.origin, expect: s.expect, turns: transcript.filter((m) => m.who === "cliente").length, latencyMax, ended, verdict, transcript });
      if (verbose) console.log(`\n=== ${s.id} ${s.title}\n${rendered}\n→ ${JSON.stringify(verdict)}`);
      process.stdout.write(verdict ? (isClean(verdict) ? "." : "F") : "?");
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
    async function worker() { for (;;) { const i = next++; const u = units[i]; if (!u) return; await runScenario(u.s, i, u.rep); } }
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
      clean: pct(judged.filter((r) => isClean(r.verdict)).length, judged.length),
      highSeverityDefects: judged.reduce((n, r) => n + r.verdict.defects.filter((d: any) => d.severity === "high").length, 0),
      // pass@N: o cenário só conta se TODAS as execuções dele forem limpas / cumprirem o objetivo.
      repeat,
      ...passAtN(results)
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
