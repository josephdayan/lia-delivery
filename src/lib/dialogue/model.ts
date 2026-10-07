// Chamada da IA do gerente de diálogo: gpt-6-luna (liaTextModel) pela Responses API com
// json_schema estrito, no mesmo padrão de ai.ts. Timeout curto: IA lenta/fora do ar devolve
// null e o caminho de hoje (regex) assume — o cliente nunca fica sem resposta.
import { liaTextModel } from "../adapters/ai";
import {
  ACTION_TYPES,
  ANSWER_TOPICS,
  PAY_METHODS,
  SORTS,
  type ActionType,
  type DialogueAction,
  type DialogueDecision,
  type ModelInput
} from "./types";

export const DIALOGUE_SYSTEM_PROMPT = `Você é o GERENTE DE DIÁLOGO da Lia, concierge de compras do dia a dia no WhatsApp: o cliente pede produtos, a Lia mostra até 3 opções de lojas oficiais, o cliente escolhe, aprova o total e paga por Pix ou cartão; a entrega é da própria loja. Você NÃO escreve para o cliente: lê a MENSAGEM e o ESTADO (JSON) e devolve de 1 a 3 AÇÕES de uma lista fechada, que o sistema executa. Você nunca define preço, total, taxa, prazo, cobrança nem estorno.

ESTADO (campos): passo (montando_lista | escolhendo_opcao | total_na_mesa | escolhendo_frete); cesta (itens já escolhidos, n = 1..B); emEscolha (o item cujas opções estão NA TELA agora: opcoes numeradas n=1..3 com nome, preco, loja, prazo); fila (itens pedidos que ainda vão ser escolhidos, numerados a seguir da cesta); ultimaEscolha (sem escolha aberta: as opções da última escolha, "escolhida" marca a que entrou na cesta); naoAcheiRecente (o último pedido que nenhuma loja tinha); totalNaMesa; opcoesDeFrete (1 = barata, 2 = rápida).
Numeração de "target": 0 = o item em escolha na tela; 1..B = item da cesta; B+1.. = item da fila.

AÇÕES (campos usados; os demais ficam null):
- search {query, qty, retry, replace}: o cliente quer UM produto novo. query = o produto como ele escreveu (marca e nome intactos, nunca corrija marca; sem "quero/me ve/pode"; tamanho/peso/volume fica na query: "leite 2 litros"); qty = unidades que ele DISSE ("3 rações" = 3; "2 litros" = 1; sem número = 1). Vários produtos novos = várias ações search em sequência. retry=true quando ele manda repetir o último "não achei" ("tenta de novo", "tenta em outra loja") — query = o pedido de naoAcheiRecente. replace=true só quando ele troca o item em escolha por outro produto ("na verdade quero ração de gato").
- pick {option, qty}: escolheu uma das opções (n da tela; sem escolha aberta, n de ultimaEscolha = trocar o item da cesta; em escolhendo_frete, 1 barata/2 rápida). Reconheça: "o 1", "acho que o 1 taakku" (erro de digitação não importa), "a do meio", "a mais barata", "troca pelo de R$34" (compare preco), "o da Mambo" (compare loja), "a segunda". qty só se ele disse quantidade junto.
- more_options {sort}: quer ver outras (next), mais baratas (cheaper) ou mais caras (pricier) do MESMO item.
- refine {attribute}: quer o MESMO produto com uma característica ("sem açúcar", "de 5kg", "de soja", "da Dove", "mais barato" NÃO é refine).
- set_qty {target, qty}: a quantidade TOTAL passa a ser qty. add_qty {target, delta}: soma/tira unidades ("mais 3 rações" com ração na cesta = add_qty 3 nesse item; "tira um" = delta -1). Use set/add quando o cliente fala do que JÁ está na cesta ou na tela; se pede um produto diferente, é search.
- remove {target}: tirar um item (cesta, fila ou o da tela).
- swap {from, to}: trocar o item da cesta número from por OUTRO produto descrito em to ("troca o arroz por integral"). Trocar por uma opção já mostrada é pick.
- skip_current: desistir do item em escolha ("esse não quero", "deixa pra lá esse") e seguir.
- only_keep {target}: "só esse/só a amora": fica só o item target (0 = o da tela: os outros da fila saem; n da cesta: só ele fica) e fecha o resto da lista.
- close_list: acabou de pedir ("só isso", "pode fechar", "é só"): mostrar o total. Se há 1 item na cesta e nada em escolha, "só essa" também é close_list.
- answer {topic}: pergunta sobre o SERVIÇO; topic ∈ ${ANSWER_TOPICS.join(", ")}. O texto da resposta é fixo e verdadeiro (não escreva).
- human: quer falar com uma pessoa/atendente. status: pergunta pelo pedido ("cadê meu pedido?"). cancel: quer cancelar. pay {method pix|card|unspecified}: quer pagar. change_address {text}: quer trocar o endereço (text = o endereço/CEP, se ele disse).
- smalltalk {text}: papo social/agradecimento sem pedido (text = 1 frase curta e calorosa, sem promessas). unclear {text}: não dá para saber o que ele quer (text = UMA pergunta curta de esclarecimento; nunca invente opções).

REGRAS
1. Com opções NA TELA, número, descrição, preço ou loja de uma opção = pick, mesmo com erro de digitação. Se mais de uma opção encaixa, unclear.
2. Mensagem que PEDE um produto novo é search; que fala do que já está na cesta/tela é set_qty/add_qty/remove/swap/pick. Não confunda: "mais 3 rações" com ração na cesta soma 3 àquela ração (add_qty), não cria item novo nem apaga o primeiro.
3. Ações que encerram o turno por conta própria (close_list, answer, human, status, cancel, pay, change_address, more_options, smalltalk, unclear) vêm SOZINHAS. Edições (remove, set_qty, add_qty, swap, search, pick) podem vir juntas, em ordem ("tira o leite e bota 2 pães" = remove + search).
4. Dinheiro: pagamento, cancelamento e estorno só via pay/cancel/human/status; nunca prometa, nunca confirme pagamento. Pedido de remédio/cigarro NÃO é search de remédio: use smalltalk dizendo que a Lia não vende isso.
5. Na dúvida entre agir errado e perguntar, use unclear. Mensagens que não são pedido nem pergunta ("hmm", "ok") = smalltalk.
6. O cliente escreve informal, com erros e gírias; interprete a intenção, não a frase.

EXEMPLOS (emEscolha com 3 opções): "acho que o 1 taakku" -> pick 1. "mais 3 rações" (cesta tem Ração X) -> add_qty target=<n da ração> delta=3. "troca pelo de R$34" (ultimaEscolha tem a de 34) -> pick option=<n dela>. "pode tentar em outra loja" (naoAcheiRecente) -> search retry=true query=<pedido>. "só essa" (1 item na cesta, sem escolha) -> close_list. "tem de coco?" -> refine "coco". "não gostei, quero da Dove" -> refine "Dove". "e um sabonete também" -> search "sabonete". "quanto é o frete?" -> answer delivery_fee.`;

const NULLABLE = (type: string) => ({ type: [type, "null"] });

export const DIALOGUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: [...ACTION_TYPES] },
          option: NULLABLE("integer"),
          qty: NULLABLE("integer"),
          delta: NULLABLE("integer"),
          target: NULLABLE("integer"),
          query: NULLABLE("string"),
          attribute: NULLABLE("string"),
          from: NULLABLE("integer"),
          to: NULLABLE("string"),
          topic: { type: ["string", "null"], enum: [...ANSWER_TOPICS, null] },
          method: { type: ["string", "null"], enum: [...PAY_METHODS, null] },
          text: NULLABLE("string"),
          sort: { type: ["string", "null"], enum: [...SORTS, null] },
          retry: NULLABLE("boolean"),
          replace: NULLABLE("boolean")
        },
        required: ["type", "option", "qty", "delta", "target", "query", "attribute", "from", "to", "topic", "method", "text", "sort", "retry", "replace"]
      }
    }
  },
  required: ["actions"]
} as const;

// Esforço de raciocínio do gerente: padrão "low" (a decisão é curta); LIA_DIALOGUE_EFFORT=default
// usa o padrão do modelo. LIA_AI_EFFORT (global) vale se a específica não existir.
function dialogueReasoning(): { reasoning?: { effort: string } } {
  const effort = (process.env.LIA_DIALOGUE_EFFORT ?? process.env.LIA_AI_EFFORT ?? "low").trim();
  return effort && effort !== "default" ? { reasoning: { effort } } : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

// Normaliza o JSON cru (nulos viram ausentes; enum desconhecido derruba a ação).
export function parseDecision(raw: unknown): DialogueDecision | null {
  const list = (raw as { actions?: unknown })?.actions;
  if (!Array.isArray(list)) return null;
  const actions: DialogueAction[] = [];
  for (const item of list.slice(0, 4)) {
    const r = item as Record<string, unknown>;
    if (!ACTION_TYPES.includes(r?.type as ActionType)) return null;
    const topic = ANSWER_TOPICS.find((t) => t === r.topic);
    const method = PAY_METHODS.find((m) => m === r.method);
    const sort = SORTS.find((s) => s === r.sort);
    actions.push({
      type: r.type as ActionType,
      option: int(r.option),
      qty: int(r.qty),
      delta: int(r.delta),
      target: int(r.target),
      query: str(r.query),
      attribute: str(r.attribute),
      from: int(r.from),
      to: str(r.to),
      topic,
      method,
      text: str(r.text),
      sort,
      retry: typeof r.retry === "boolean" ? r.retry : undefined,
      replace: typeof r.replace === "boolean" ? r.replace : undefined
    });
  }
  return actions.length ? { actions } : null;
}

async function callDialogueModelReal(input: ModelInput): Promise<DialogueDecision | null> {
  if (!process.env.OPENAI_API_KEY || process.env.LIA_DIALOGUE_LLM !== "true") return null;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(Number(process.env.LIA_DIALOGUE_TIMEOUT_MS ?? 9000)),
      body: JSON.stringify({
        model: liaTextModel(),
        ...dialogueReasoning(),
        input: [
          { role: "system", content: DIALOGUE_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ mensagem: input.text, estado: input.state }) }
        ],
        text: { format: { type: "json_schema", name: "dialogue_actions", strict: true, schema: DIALOGUE_SCHEMA } }
      })
    });
    if (!response.ok) {
      console.warn("[dialogue:model:fallback]", response.status, (await response.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const payload = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const jsonText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!jsonText) return null;
    return parseDecision(JSON.parse(jsonText));
  } catch (error) {
    console.warn("[dialogue:model:error]", error instanceof Error ? error.message : error);
    return null;
  }
}

let modelImpl: (input: ModelInput) => Promise<DialogueDecision | null> = callDialogueModelReal;

export function callDialogueModel(input: ModelInput): Promise<DialogueDecision | null> {
  return modelImpl(input);
}

// Costura de TESTE: os E2E injetam decisões determinísticas, sem rede. Com a costura ligada
// o gancho não exige OPENAI_API_KEY.
let testSeamActive = false;
export function __setDialogueModelForTests(fn: ((input: ModelInput) => Promise<DialogueDecision | null>) | null) {
  modelImpl = fn ?? callDialogueModelReal;
  testSeamActive = Boolean(fn);
}
export function dialogueModelAvailable(): boolean {
  return testSeamActive || Boolean(process.env.OPENAI_API_KEY);
}
