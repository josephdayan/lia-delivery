// Conversa com a Lia "como em produção", sem WhatsApp (09/10). Diferente do talk-lia.mts, o
// provedor fica em "meta": a Lia escolhe os MESMOS caminhos de produção (carrossel, botões,
// formulário da lista, bolha de Pix) e cada envio é capturado e impresso, em vez de ir pra Graph.
// Motivo: vários erros só aconteciam no WhatsApp (o "Me perdi aqui 😅" depois do Pix nativo),
// porque o talk-lia caía nos textos de fallback do provedor mock.
//
// Uso (banco LOCAL — nunca o de produção):
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/lia_test npx tsx scripts/talk-prod.mts "oi" "01310-100" "arroz"
//   ... interativo sem argumentos. Comandos: /form (envia o formulário da lista como veio), /cadastro [nome]
//   (responde o formulário de cadastro; com LIA_FLOW_SIGNUP_ID=qualquer a Lia manda o formulário como em produção), /quit.
//   Botão: digite o id ou o título que aparece entre [ ].
//
// Trava de dinheiro: sem MERCADO_PAGO_ACCESS_TOKEN / Pagar.me / Asaas o Pix e o cartão são mock.
// O script recusa rodar se encontrar credencial de pagamento ou um DATABASE_URL que não seja local.
import "./talk-env.mts";
import { createInterface } from "node:readline/promises";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) {
  console.error("talk-prod: DATABASE_URL precisa ser local (127.0.0.1/localhost).");
  process.exit(1);
}
for (const key of ["MERCADO_PAGO_ACCESS_TOKEN", "PAGARME_SECRET_KEY", "ASAAS_API_KEY", "WHATSAPP_ACCESS_TOKEN"]) delete process.env[key];

// Flags como em produção (docs/AGENTS.md). Quem quiser outra combinação passa no ambiente.
const prodFlags: Record<string, string> = {
  LIA_CAROUSEL: "true",
  LIA_LIST_FLOW: "true",
  LIA_NATIVE_PIX: "1",
  LIA_LIVE_SEARCH: "true",
  LIA_COVERAGE_PRESET: "estado-sp",
  LIA_PURCHASE_SUBMIT_OFF: "true",
  LIA_AUTO_PURCHASE_OFF: "true",
  LIA_SEND_PHOTOS: "true"
};
for (const [k, v] of Object.entries(prodFlags)) if (process.env[`KEEP_${k}`] === undefined) process.env[k] = process.env[`TALK_${k}`] ?? v;
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_PHONE_NUMBER_ID = "talk-prod";

const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");

// Captura TODO envio antes de o turn-runtime embrulhar o adaptador (a rede anti-silêncio conta
// esses envios como em produção).
type Out = { kind: string; text: string; buttons?: string[]; flowToken?: string };
const outbox: Out[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 1)?.slice(0, 1500) ?? "");
for (const name of Object.keys(adapter)) {
  if (!name.startsWith("send") || typeof adapter[name] !== "function") continue;
  adapter[name] = async (to: string, ...rest: unknown[]) => {
    const [first, second] = rest;
    const out: Out = { kind: name, text: "" };
    if (name === "sendMessage" || name === "sendMedia") out.text = String(first ?? "") + (name === "sendMedia" && second ? `\n[foto] ${second}` : "");
    else if (name === "sendFlowMessage") {
      const input = first as { body?: string; cta?: string; token?: string };
      out.text = `${input.body ?? ""}\n[formulário: ${input.cta ?? ""}] (responda /form)`;
      out.flowToken = input.token;
    } else if (name === "sendDeliveryCarousel" || name === "sendDeliveryChoices") {
      const options = (name === "sendDeliveryCarousel" ? second : first) as Array<{ id?: string; name?: string; title?: string; price?: number; priceLabel?: string; storeLabel?: string }>;
      out.text = `${name === "sendDeliveryCarousel" ? String(first ?? "") + "\n" : ""}${(options ?? []).map((o, i) => `  card ${i + 1}: ${show(o).replace(/\s+/g, " ").slice(0, 260)}`).join("\n")}`;
    } else out.text = `${rest.map(show).join("\n")}`;
    outbox.push(out);
    return { provider: "talk-prod", to, messages: [{ id: `wamid.talk${outbox.length}` }] };
  };
}
adapter.markReadWithTyping = async () => undefined;

const { prisma } = await import("../src/lib/prisma");
const { handleDeliveryMessage } = await import("../src/lib/delivery-service");
const { runTurnScoped } = await import("../src/lib/turn-runtime");

const PREFIX = "+5500994";
// Telefone por execução (TALK_PHONE fixa um, para retomar a conversa em outra execução com TALK_KEEP=1).
const phone = process.env.TALK_PHONE ?? `${PREFIX}${String(Date.now()).slice(-4)}${String(process.pid % 1000).padStart(3, "0")}`.slice(0, 14);
const RUN = Date.now().toString(36);
let seq = 0;
let lastFlowToken: string | undefined;

async function send(input: { text?: string; flowResponse?: Record<string, unknown> }) {
  const start = outbox.length;
  const t0 = Date.now();
  await runTurnScoped(() => handleDeliveryMessage({ phone, text: input.text ?? "", messageId: `talkprod_${RUN}_${++seq}`, flowResponse: input.flowResponse } as Parameters<typeof handleDeliveryMessage>[0]));
  const out = outbox.slice(start);
  for (const o of out) if (o.flowToken) lastFlowToken = o.flowToken;
  return { out, ms: Date.now() - t0 };
}

async function turn(line: string) {
  console.log(`\n🧑 ${line}`);
  // "/cadastro [nome]" (10/10, rodada 13 g37): responde o formulário de cadastro como o WhatsApp manda (nome, CPF, CEP, número).
  const signup = line.match(/^\/cadastro(?:\s+(.+))?$/);
  const input = signup
    ? { text: "", flowResponse: { nome: signup[1] ?? "Teste Silva", cpf: "52998224725", cep: "01310100", numero: "1000", complemento: "", flow_token: lastFlowToken ?? "lia-cadastro" } }
    : line === "/form" ? { text: "", flowResponse: { lia_lista: lastFlowToken ?? "" } } : { text: line };
  const { out, ms } = await send(input);
  if (!out.length) console.log("(sem resposta)");
  for (const o of out) console.log(`🤖 [${o.kind}] ${o.text.split("\n").join("\n     ")}`);
  console.log(`   ⏱ ${(ms / 1000).toFixed(1)} s`);
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { phone }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const convos = await prisma.conversation.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convos.map((c) => c.id) } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

console.log(`— talk-prod · fone ${phone} · NLU ${process.env.OPENAI_API_KEY ? "LLM" : "sem LLM"} —`);
try {
  const args = process.argv.slice(2);
  if (args.length) for (const a of args) await turn(a);
  else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("\n🧑 ")).trim();
      if (!line || line === "/quit") break;
      await turn(line);
    }
    rl.close();
  }
} finally {
  if (process.env.TALK_KEEP !== "1") await cleanup().catch(() => undefined);
  await prisma.$disconnect();
}
