// MAPEAR (IA) e JULGAR (IA) da recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md
// §1.2, §1.4 e §1.6). Duas chamadas gpt-6-luna (via liaTextModel) no padrão de src/lib/adapters/ai.ts:
// Responses API, json_schema strict, hedge contra a cauda lenta, nunca lança (falha = null e o
// fallback determinístico de fallback.ts assume). A IA ESCOLHE entre prateleiras do mapa e entre
// candidatos reais; a validação aqui descarta qualquer id/sku que não veio da entrada.
//
// Quem chama: fallback.ts (planShelves / judgeFitness), que também aplica as redes de segurança
// (sinal de alerta, porta do remédio, restrições por palavra).
import { hedged, liaTextModel } from "../adapters/ai";
import { displayPrice } from "../pricing";
import type { CustomerMemory, FitnessInput, FitnessVerdict, RecommendRequest, ShelfPick, ShelfPlan } from "./types";

// Liga/desliga da IA da recomendação: sem chave ou com LIA_RECOMMEND_AI=false, as duas etapas
// ficam só nas tabelas e regras (fallback.ts re-exporta).
export function recommendAiEnabled(): boolean {
  return process.env.LIA_RECOMMEND_AI !== "false" && Boolean(process.env.OPENAI_API_KEY);
}

function recommendReasoning(): { reasoning: { effort: string } } {
  return { reasoning: { effort: (process.env.LIA_RECOMMEND_EFFORT ?? process.env.LIA_AI_EFFORT ?? "low").trim() } };
}

// Motivo do card nunca promete efeito/cura/prazo (§1.6): o que bate aqui vira "" e o chamador usa
// o motivo da tabela ou um fato do candidato.
const PROMISE_RE = /\b(cura|curar|cur[ao]u|garant\w*|100 ?%|elimina\w*|resolve\w*|acaba com|chega agora|na hora|imediat\w*|milagr\w*|o melhor do mundo)\b/i;

export function sanitizeWhy(why: unknown, max = 70): string {
  const text = String(why ?? "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,\s]+$/, "");
  if (!text || PROMISE_RE.test(text)) return "";
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, "") : text;
}

type ResponsesPayload = { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };

async function callJson<T>(tag: string, system: string, user: unknown, schemaName: string, schema: object, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: liaTextModel(),
        ...recommendReasoning(),
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(user) }
        ],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } }
      })
    });
    if (!response.ok) {
      console.warn(`[ai:${tag}:fallback]`, response.status, await response.text().catch(() => ""));
      return null;
    }
    const payload = (await response.json()) as ResponsesPayload;
    const jsonText = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;
    if (!jsonText) return null;
    return JSON.parse(jsonText) as T;
  } catch (error) {
    // Cancelada porque a outra chamada (ou o prazo) já decidiu: não é falha.
    if (!signal.aborted) console.warn(`[ai:${tag}:error]`, error instanceof Error ? error.message : error);
    return null;
  }
}

function memorySummary(memory: CustomerMemory | undefined): Record<string, unknown> | undefined {
  if (!memory) return undefined;
  const out: Record<string, unknown> = {};
  if (memory.restrictions?.length) out.restricoes_ditas = memory.restrictions.map((r) => r.text);
  if (memory.pet) out.pet = [memory.pet.species, memory.pet.size].filter(Boolean).join(" ");
  if (memory.household?.people) out.pessoas_em_casa = memory.household.people;
  if (memory.brands?.length) out.marcas_preferidas = memory.brands.slice(0, 8).map((b) => (b.shelfId ? `${b.brand} (${b.shelfId})` : b.brand));
  if (memory.recentShelves?.length) out.prateleiras_recentes = memory.recentShelves.slice(0, 8).map((s) => s.shelfId);
  return Object.keys(out).length ? out : undefined;
}

function requestSummary(req: RecommendRequest): Record<string, unknown> {
  return {
    forma: req.form,
    texto: req.text,
    ...(req.need ? { necessidade: req.need } : {}),
    ...(req.product ? { produto: req.product } : {}),
    criterios: req.criteria,
    restricoes: req.constraints,
    ...(req.budget != null ? { orcamento_total_reais: req.budget } : {}),
    ...(req.recipient ? { pra_quem: req.recipient } : {}),
    ...(req.urgency ? { urgencia: true } : {}),
    ...(req.symptom ? { sintoma: req.symptom } : {})
  };
}

// ---------- MAPEAR ----------

export const PLAN_SYSTEM_PROMPT = (shelvesPrompt: string) => `Você é a Lia, concierge de compras no WhatsApp. O cliente pediu uma RECOMENDAÇÃO. Escolha, no MAPA DE PRATELEIRAS no fim (o que a Lia realmente vende), as prateleiras que mais ajudam e, para cada uma, a busca concreta e o motivo.

Entrada (JSON): forma ("need" = necessidade/estado/ocasião sem produto; "product_judged" = produto nomeado + pedido de julgamento), texto original, necessidade ou produto, critérios (fast = rápido, good = bom/melhor, cheap = barato, healthy = saudável), restrições, orçamento total em R$, pra quem, urgência, sintoma, hora local (0–23), itens já na cesta e memória do cliente.

Saída: "picks" em ORDEM do que mais ajuda primeiro — forma "need": 3 a 6 picks; forma "product_judged": 1 a 3. Cada pick:
- shelfId: EXATAMENTE um id da 1ª coluna do mapa. Nunca invente nem altere id.
- query: o que buscar nessa prateleira, curto e buscável (1 a 5 palavras); pode ser mais específico que a busca padrão ("chocolate ao leite", "sorvete pote 1,5l", "picanha", "kit presente perfume feminino"). Remédio: princípios ativos e marcas isentas separados por " | " ("loperamida | Imosec").
- why: motivo curto (2 a 6 palavras), factual, em português, sem emoji, dizendo o que ESSA prateleira tem de próprio ("doce e gelado", "crocante pra beliscar", "alivia gases", "clássico de churrasco"); cada pick com um why diferente. Nunca prometa efeito, cura ou prazo; nunca "o melhor", "garantido", "resolve", "bem avaliado".
- mipClass: só em prateleira com flag mip, a classe do remédio em minúsculas sem acento ("antidiarreico", "antiespasmodico", "antigases", "antiacido", "analgesico"); nas outras, "".

Regras:
1. VARIEDADE: prateleiras de TIPOS diferentes, que se completam (algo doce: chocolate, sorvete, biscoito recheado, bolo pronto). Prateleiras irmãs contam como o MESMO tipo e entram no máximo uma (chocolate em barra e bombom/trufa; cerveja e chope; salgadinho e batata chips) — exceto em product_judged, onde a vizinha pode ser a irmã. Cada prateleira no máximo uma vez. Forma "need": prefira 4 a 6 picks quando o mapa tiver opções boas.
2. RESTRIÇÕES são absolutas: "sem lactose" tira leite, queijo, iogurte, sorvete comum e chocolate ao leite (só versão zero lactose se a prateleira tiver); "sem chocolate" tira chocolate, bombom, trufa e tudo que leva chocolate; "vegano" tira carne, leite, ovo, mel; "zero açúcar"/"diabético" → versões zero/diet na query. Orçamento: só tire prateleira cujo item mais simples já passa do valor (um perfume feminino de até R$100 existe).
3. PRA QUEM manda: pet → só prateleiras pet da espécie certa (nunca comida humana pra pet nem ração pra gente); criança/bebê → infantil; presente → coisa presenteável (flag gift) que combine com quem recebe, o presente mais clássico primeiro (mãe: perfume feminino, kit banho, chocolate fino/bombom, flores, maquiagem; pai: perfume masculino, vinho/bebida, kit barba).
4. HORA e URGÊNCIA: entre 22h e 5h nada de café da manhã nem preparo demorado; fome/urgência → prontos pra comer (flag ready_to_eat) e o que serve na hora primeiro, depois o que exige preparo.
5. CESTA: não repita o que o cliente já tem na cesta.
6. SINTOMA/saúde: SÓ prateleiras com flag mip ou care, nunca comida comum; a classe mais indicada para o sintoma primeiro (dor de barriga: antiespasmódico, antigases, probiótico, antiácido — antidiarreico SÓ com diarreia dita; ressaca: só hidratação, nunca analgésico/anti-inflamatório/Engov depois de álcool; por último care como soro de reidratação), mipClass preenchido; why descreve a classe ("alivia cólica"), nunca cura. Sem sintoma, nenhuma prateleira mip. Pet doente: nenhum remédio (devolva vazio).
7. PRODUTO + JULGAMENTO: a prateleira do PRÓPRIO produto em 1º, com query = o produto + os atributos que o cliente deu (tipo de cabelo, espécie, sabor) — palavras de juízo ("bom", "melhor") NÃO entram na query; why = o critério pedido em fatos ("marcas mais vendidas", "o mais em conta", "versão zero açúcar"); depois 0 a 2 prateleiras vizinhas que combinam (chocolate → bombom/trufa).
8. OCASIÃO/KIT (churrasco, café da manhã, festa, noite de filme, limpeza): o essencial da ocasião em ordem de importância (churrasco: carne, carvão, pão de alho, cerveja ou refrigerante, gelo); número de pessoas não muda as prateleiras.
9. Nenhuma prateleira serve → devolva menos picks, ou nenhum. Vazio é melhor que errado.

MAPA (id | rótulo | busca padrão | flags):
${shelvesPrompt}

Responda apenas JSON válido.`;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { shelfId: { type: "string" }, query: { type: "string" }, why: { type: "string" }, mipClass: { type: "string" } },
        required: ["shelfId", "query", "why", "mipClass"]
      }
    }
  },
  required: ["picks"]
};

export type PlanShelvesOpts = { shelvesPrompt: string; shelfIds: Set<string>; hour?: number; memory?: CustomerMemory; basketNames?: string[] };

// Saída da IA → picks válidos: id do mapa, sem repetição, query não vazia, até 6.
export function validatePlanPicks(raw: unknown, shelfIds: Set<string>, limit = 6): ShelfPick[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: ShelfPick[] = [];
  for (const item of list) {
    const p = item as Partial<ShelfPick> | null;
    const shelfId = String(p?.shelfId ?? "").trim();
    const query = String(p?.query ?? "").replace(/\s+/g, " ").trim();
    if (!shelfId || !shelfIds.has(shelfId) || seen.has(shelfId) || !query) continue;
    seen.add(shelfId);
    const mipClass = String(p?.mipClass ?? "").trim();
    out.push({ shelfId, query: query.slice(0, 80), why: sanitizeWhy(p?.why), ...(mipClass ? { mipClass } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

async function planShelvesWithAiReal(req: RecommendRequest, opts: PlanShelvesOpts): Promise<ShelfPlan | null> {
  if (!recommendAiEnabled() || !opts.shelfIds.size || !opts.shelvesPrompt.trim()) return null;
  const user = {
    ...requestSummary(req),
    ...(opts.hour != null ? { hora_local: opts.hour } : {}),
    ...(opts.basketNames?.length ? { ja_na_cesta: opts.basketNames.slice(0, 30) } : {}),
    ...(memorySummary(opts.memory) ? { memoria: memorySummary(opts.memory) } : {})
  };
  const system = PLAN_SYSTEM_PROMPT(opts.shelvesPrompt);
  const result = await hedged(
    async (signal) => {
      const parsed = await callJson<{ picks?: unknown }>("recommend-plan", system, user, "shelf_plan", PLAN_SCHEMA, signal);
      if (!parsed) return null;
      const picks = validatePlanPicks(parsed.picks, opts.shelfIds);
      // Menos de 1 pick válido = resposta inútil (ids inventados): conta como falha.
      return picks.length ? ({ picks, source: "ai" } as ShelfPlan) : null;
    },
    {
      hedgeMs: Number(process.env.LIA_RECOMMEND_MAP_HEDGE_MS ?? 2500),
      deadlineMs: Number(process.env.LIA_RECOMMEND_MAP_TIMEOUT_MS ?? 7000)
    }
  );
  if (!result) console.warn("[ai:recommend-plan:error]", "sem plano utilizável da IA no prazo");
  return result;
}

let planImpl: typeof planShelvesWithAiReal = planShelvesWithAiReal;

export function planShelvesWithAi(req: RecommendRequest, opts: PlanShelvesOpts): Promise<ShelfPlan | null> {
  return planImpl(req, opts).catch(() => null);
}

// Costura de TESTE: injeta o plano da IA sem rede (ignora a chave/flag de propósito).
export function __setPlanShelvesForTests(fn: typeof planShelvesWithAiReal | null) {
  planImpl = fn ?? planShelvesWithAiReal;
}

// ---------- JULGAR ----------

export const JUDGE_SYSTEM_PROMPT = `Você é a Lia, concierge de compras no WhatsApp, agora como JUIZ da recomendação. Recebe o pedido do cliente e, para cada prateleira escolhida (na ordem do plano), os candidatos REAIS com estoque e prazo no CEP. Escolha NO MÁXIMO 1 candidato por prateleira — o que melhor atende o pedido e o critério — e devolva os cards do que mais ajuda ao que menos.

Critério de escolha:
- fast (rápido/urgência/fome): menor prazo primeiro ("prazo_min"; verificado=true é mais confiável) e pronto pra usar/comer; os cards também em ordem de prazo.
- good (bom/melhor): marca reconhecida e mais vendida (popularidade 1 = mais vendido), faixa de preço média-alta; NUNCA o mais barato só por ser barato.
- cheap (barato): menor preço.
- healthy (saudável): versão integral/zero/light/natural quando existir.
- Sem critério: o mais vendido de marca conhecida, com preço razoável.
- Sintoma (remedio=true): mantenha a ordem das prateleiras do plano (classe mais indicada primeiro); dentro da prateleira, a apresentação BÁSICA da marca antes das extensões de linha (Sinus, DC, PM, Max, Composto, Plus, 12h, Noite, Dia), depois a mais vendida; infantil só se for pra criança.

Corte (candidato fica FORA): viola restrição ("sem lactose" com leite/queijo comum; "sem chocolate" com chocolate ou cobertura de chocolate; "vegano" com carne/leite/ovo), não é pra quem foi pedido (humano × pet, espécie errada, adulto × infantil), estoura o orçamento total, ou não é o tipo da prateleira. Prateleira sem candidato que sirva = sem card (vazio é melhor que errado).

why: 1 linha curta (2 a 8 palavras), português, sem emoji, escrita a partir de FATOS do candidato ou da prateleira: "chega em 2h", "o mais vendido", "marca líder", "o mais em conta", "alivia cólica", "versão zero açúcar". Linguagem de cliente: nunca cite nome de campo nem número interno ("popularidade 3", "ref", "prazo_min", "versão básica"); popularidade 1 = "o mais vendido", 2 a 5 = "dos mais vendidos". Remédio (remedio=true): o why descreve a classe, a partir de "motivo_do_plano" ("alivia cólica", "contra diarreia"), nunca popularidade. Nunca prometa efeito, cura ou "chega agora"; não invente fato que não está na entrada.

Use "ref" exatamente como veio. Responda apenas JSON válido.`;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { ref: { type: "string" }, why: { type: "string" } },
        required: ["ref", "why"]
      }
    }
  },
  required: ["cards"]
};

export function etaLabel(minutes: number | undefined): string | undefined {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes < 60) return `${Math.max(5, Math.round(minutes / 5) * 5)} min`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  const days = Math.round(minutes / (24 * 60));
  return days <= 1 ? "1 dia" : `${days} dias`;
}

// Monta a entrada do juiz com referências curtas (c1, c2…): o sku sozinho não é único entre lojas.
export function judgeRefs(input: FitnessInput): { ref: string; index: number }[] {
  return input.candidates.map((_, index) => ({ ref: `c${index + 1}`, index }));
}

async function judgeFitnessWithAiReal(input: FitnessInput): Promise<FitnessVerdict | null> {
  if (!recommendAiEnabled() || !input.candidates.length) return null;
  const order = input.plan.picks.map((p) => p.shelfId);
  const refs = judgeRefs(input);
  const byShelf = new Map<string, { ref: string; index: number }[]>();
  for (const r of refs) {
    const shelfId = input.candidates[r.index].shelfId;
    if (!byShelf.has(shelfId)) byShelf.set(shelfId, []);
    byShelf.get(shelfId)!.push(r);
  }
  const shelves = [...order.filter((id) => byShelf.has(id)), ...[...byShelf.keys()].filter((id) => !order.includes(id))];
  const user = {
    pedido: requestSummary(input.request),
    ...(input.hour != null ? { hora_local: input.hour } : {}),
    ...(memorySummary(input.memory) ? { memoria: memorySummary(input.memory) } : {}),
    prateleiras: shelves.map((shelfId) => {
      const pick = input.plan.picks.find((p) => p.shelfId === shelfId);
      return {
        prateleira: shelfId,
        busca: pick?.query ?? "",
        motivo_do_plano: pick?.why ?? "",
        ...(pick?.mipClass ? { classe_remedio: pick.mipClass } : {}),
        candidatos: (byShelf.get(shelfId) ?? []).slice(0, 12).map(({ ref, index }) => {
          const c = input.candidates[index];
          const o = c.option;
          return {
            ref,
            nome: o.name,
            marca: o.brand ?? "",
            preco: displayPrice(o.unitPrice),
            ...(o.freightFee != null ? { frete: o.freightFee } : {}),
            loja: o.storeLabel ?? o.storeKey ?? "",
            prazo: o.delivery ?? etaLabel(o.etaMinutes) ?? "",
            ...(o.etaMinutes != null ? { prazo_min: o.etaMinutes } : {}),
            ...(o.verified ? { verificado: true } : {}),
            ...(c.popularity != null ? { popularidade: c.popularity } : {}),
            ...(o.medicine === "mip" ? { remedio: true } : {})
          };
        })
      };
    })
  };
  const valid = new Map(refs.map((r) => [r.ref, r.index]));
  const result = await hedged(
    async (signal) => {
      const parsed = await callJson<{ cards?: Array<{ ref?: string; why?: string }> }>("recommend-judge", JUDGE_SYSTEM_PROMPT, user, "fitness_verdict", JUDGE_SCHEMA, signal);
      if (!parsed || !Array.isArray(parsed.cards)) return null;
      const seenShelves = new Set<string>();
      const cards: FitnessVerdict["cards"] = [];
      for (const card of parsed.cards) {
        const index = valid.get(String(card?.ref ?? "").trim());
        if (index == null) continue;
        const c = input.candidates[index];
        if (seenShelves.has(c.shelfId)) continue;
        seenShelves.add(c.shelfId);
        const pickWhy = input.plan.picks.find((p) => p.shelfId === c.shelfId)?.why ?? "";
        cards.push({ shelfId: c.shelfId, sku: c.option.sku, storeKey: c.option.storeKey ?? "", why: sanitizeWhy(card.why) || pickWhy });
      }
      return { cards, source: "ai" } as FitnessVerdict;
    },
    {
      hedgeMs: Number(process.env.LIA_RECOMMEND_JUDGE_HEDGE_MS ?? 4000),
      deadlineMs: Number(process.env.LIA_RECOMMEND_JUDGE_TIMEOUT_MS ?? 8000)
    }
  );
  if (!result) console.warn("[ai:recommend-judge:error]", "sem veredito utilizável da IA no prazo");
  return result;
}

let judgeImpl: typeof judgeFitnessWithAiReal = judgeFitnessWithAiReal;

export function judgeFitnessWithAi(input: FitnessInput): Promise<FitnessVerdict | null> {
  return judgeImpl(input).catch(() => null);
}

// Costura de TESTE: injeta o veredito da IA sem rede (ignora a chave/flag de propósito).
export function __setJudgeFitnessForTests(fn: typeof judgeFitnessWithAiReal | null) {
  judgeImpl = fn ?? judgeFitnessWithAiReal;
}
