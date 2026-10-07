// Guarda anti-repetição (rodada 2 do plano-conversa-100, 07/10/2026). Placar: a Lia mandava a MESMA
// mensagem duas vezes seguidas para falas diferentes do cliente ("não achei…", "ainda não entrego
// em BH…", a despedida para cada 👍). A guarda mora no `reply()` (turn-runtime): se o texto é igual
// a uma fala recente da Lia, o gerente de diálogo escreve uma resposta DIFERENTE, sabendo o que
// já foi dito. IA fora do ar ou resposta que repete = o texto original sai (caminho de hoje).
import { liaTextModel, sanitizeRouterReply } from "../adapters/ai";
import { normalizeMsg } from "../lia-intents";

export const REPEAT_WINDOW_MS = 10 * 60_000;
const KEEP = 4;

export type RepeatInput = {
  // O que o cliente acabou de dizer.
  customer: string;
  // O texto que a Lia ia mandar de novo.
  said: string;
  // As últimas falas da Lia (a mais recente por último): os únicos fatos que a resposta pode usar.
  recent: string[];
};

export function repeatGuardEnabled(): boolean {
  return process.env.LIA_DIALOGUE_LLM === "true";
}

// Texto que pode ser re-enviado igual de propósito: dinheiro, link, código Pix, resumo do pedido.
// A guarda só mexe em prosa de conversa.
export function isRepeatableVerbatim(text: string): boolean {
  return /R\$|https?:\/\/|\b00020\d|pix copia|copia e cola|\bpedido\b.*\btotal\b/i.test(text);
}

const canon = (text: string) => normalizeMsg(text).replace(/\s+/g, " ").trim();

// Mesma frase com outro nome de produto ("*tubo bolas…* eu não achei em nenhuma loja agora…"): sem o trecho em
// negrito/itálico o resto é o mesmo modelo de resposta. Só vale para prosa longa — "Anotei *leite*" é curto.
function withoutHighlights(text: string): string {
  return canon(text.replace(/\*[^*\n]+\*|_[^_\n]+_/g, " "));
}

// Família de "o responsável foi avisado" (modo atendimento): as quatro variantes de confirmação dizem a mesma coisa
// para o cliente que reclama de novo; a segunda deve responder ao que ele disse agora.
function gistFamily(text: string): string | null {
  const n = canon(text);
  if (/\brespons[aá]vel\b/.test(n) && /\brespond/.test(n)) return "atendimento";
  if (/\bele (?:te )?responde\b|\bresposta vem aqui\b/.test(n)) return "atendimento";
  return null;
}

// `gist` = conta também a mesma família de resposta (detecção da repetição). A fala NOVA escrita pela IA só precisa
// diferir das anteriores no texto — ela pode, sim, continuar no assunto do atendimento.
export function sameAsRecent(text: string, recent: string[], gist = true): boolean {
  const key = canon(text);
  if (!key) return false;
  const stripped = withoutHighlights(text);
  const family = gist ? gistFamily(text) : null;
  return recent.some(
    (previous) =>
      canon(previous) === key ||
      (stripped.length >= 40 && withoutHighlights(previous) === stripped) ||
      (family !== null && gistFamily(previous) === family)
  );
}

// Guarda as últimas falas: junta as deste turno às anteriores e fica com as KEEP mais recentes.
export function mergeSent(previous: { texts: string[]; at: number } | undefined, sentNow: string[], now = Date.now()): { texts: string[]; at: number } | undefined {
  if (!sentNow.length) return previous;
  const base = previous && now - previous.at < REPEAT_WINDOW_MS ? previous.texts : [];
  return { texts: [...base, ...sentNow].slice(-KEEP), at: now };
}

const REPEAT_SYSTEM_PROMPT = `Você é o GERENTE DE DIÁLOGO da Lia, concierge de compras do dia a dia no WhatsApp (compra em lojas oficiais; o cliente aprova o total e paga por Pix ou cartão antes de qualquer cobrança; a entrega é da própria loja). O sistema ia mandar ao cliente EXATAMENTE a mesma mensagem que a Lia já mandou ("lia_ia_repetir"), mas o cliente acabou de dizer outra coisa ("cliente"). Escreva a resposta nova da Lia.
REGRAS:
1. Responda ao que o cliente disse AGORA, em português do Brasil, informal, até 2 frases curtas e no máximo 1 emoji. Não repita a frase anterior.
2. Use SÓ fatos que aparecem em "falas_recentes_da_lia". Nunca invente preço, prazo, loja, estoque, telefone nem promessa; nada de desconto, cupom ou confirmar pagamento/estorno.
3. Despedida, agradecimento ou emoji ("👍", "ok", "valeu", "tchau", "FIM"): uma confirmação curta e calorosa ("Combinado! Quando precisar é só chamar 💚"), sem repetir o resto.
4. Se o cliente pede de novo algo que a Lia já disse que não consegue (produto que nenhuma loja tem, região fora da área): reconheça que ele insistiu, diga que o resultado é o mesmo e repita só o próximo passo possível que já foi dito (outra marca, endereço de outra cidade atendida…), com outras palavras.
5. Se o cliente pediu para ser avisado ou para a Lia anotar algo e as falas dizem que isso já foi feito, confirme em uma frase.
6. Se não dá para responder sem inventar, devolva text vazio.
Responda apenas JSON.`;

const REPEAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"]
} as const;

async function callRepeatModelReal(input: RepeatInput): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY || !repeatGuardEnabled()) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.LIA_DIALOGUE_TIMEOUT_MS ?? 9000)),
      body: JSON.stringify({
        model: liaTextModel(),
        reasoning: { effort: (process.env.LIA_DIALOGUE_EFFORT ?? process.env.LIA_AI_EFFORT ?? "low").trim() },
        input: [
          { role: "system", content: REPEAT_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ cliente: input.customer, lia_ia_repetir: input.said, falas_recentes_da_lia: input.recent })
          }
        ],
        text: { format: { type: "json_schema", name: "repeat_rewrite", strict: true, schema: REPEAT_SCHEMA } }
      })
    });
    if (!response.ok) {
      console.warn("[dialogue:repeat:fallback]", response.status);
      return null;
    }
    const payload = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const jsonText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch (error) {
    console.warn("[dialogue:repeat:error]", error instanceof Error ? error.message : error);
    return null;
  }
}

let modelImpl: (input: RepeatInput) => Promise<string | null> = callRepeatModelReal;
let seamActive = false;
// Costura de TESTE (como a do gerente): decisões determinísticas, sem rede.
export function __setRepeatModelForTests(fn: ((input: RepeatInput) => Promise<string | null>) | null) {
  modelImpl = fn ?? callRepeatModelReal;
  seamActive = Boolean(fn);
}

// Confirmações curtas para o cliente que só agradece/despede/manda 👍 (c10): quando a IA não traz uma fala
// nova, a próxima da lista que ainda não foi dita. Nada aqui promete nada.
const SHORT_ACKS = ["👍", "Tudo certo 💚", "Por nada! 💚", "Combinado 🙂", "Fechado 💚", "Até a próxima 💚"];

function shortAck(input: RepeatInput): string | null {
  const n = canon(input.customer);
  if (!n || n.split(" ").length > 4 || /\?/.test(input.customer)) return null;
  return SHORT_ACKS.find((ack) => !sameAsRecent(ack, input.recent, false)) ?? null;
}

// Texto novo no lugar da repetição, ou null (a mensagem original sai como sempre saiu).
export async function rewriteRepeated(input: RepeatInput): Promise<string | null> {
  if (!repeatGuardEnabled()) return null;
  if (seamActive || process.env.OPENAI_API_KEY) {
    const raw = await modelImpl(input).catch(() => null);
    const clean = sanitizeRouterReply(raw ?? undefined);
    if (clean && !sameAsRecent(clean, input.recent, false)) return clean;
  }
  return shortAck(input);
}
