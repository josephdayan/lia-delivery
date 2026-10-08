// EXECUTAR + APRENDER (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.3–1.6, §3): a
// recomendação de ponta a ponta — MAPEAR (planShelves: IA ou tabelas, com sinal de alerta antes) →
// BUSCAR (gatherShelfCandidates por prateleira, no CEP, sem Mercado Livre; remédio só em prateleira
// mip) → estoque/prazo AO VIVO (a mesma conferência da vitrine: toChoiceOption + confirmOptionsLive do
// delivery-service) → JULGAR (judgeFitness: IA validada ou regras) → 4 cards (um por prateleira) numa
// PendingChoice normal com `recommendation` → RecommendLog (mostrado / escolhido / nada / alerta).
//
// Quem chama: dialogue/execute.ts (ação `recommend`) e delivery-service (`handleSearch`, pedido
// guardado no onboarding, "outras"/"mais barato"/refino sobre uma escolha de recomendação). As
// funções do delivery-service chegam por `setRecommendDeps` (sem import circular).
//
// Decisão da BUSCA (08/10): NÃO usamos `searchOptionsForPlanB` por prateleira — ele roda extração +
// rerank de IA por consulta (1 chamada a mais por prateleira, até 6) e não sabe da porta do remédio
// por prateleira. A busca da prateleira (gatherShelfCandidates) + a conferência ao vivo do
// delivery-service (confirmOptionsLive, a mesma de paginação/refino) dão os candidatos compráveis no
// CEP; quem escolhe entre eles é o juiz de aptidão (1 chamada só, com fallback por regras).
import type { CatalogItem } from "../stores/types";
import type { BasketItem, ChoiceOption, DeliveryContext, PendingChoice, RecommendationState } from "../conversation-types";
import type { Intent } from "../lia-intents";
import { normalizeMsg } from "../lia-intents";
import * as copy from "../lia-copy";
import { prisma } from "../prisma";
import { medicineEnabled } from "../medicine";
import { reply, writeCtx } from "../turn-runtime";
import { noteShopperCep } from "../store-areas";
import { gatherShelfCandidates } from "../stores";
import { withDeadline } from "../stores/live-search";
import { shelfHeadMatch } from "../stores/types";
import {
  constraintRules,
  defaultTableDeps,
  eligibleCandidates,
  emergencyFlag,
  judgeFitness,
  judgeFitnessByRules,
  normalizeRecommendRequest,
  TYPICAL_FREIGHT,
  normRec,
  planShelves,
  planShelvesFromTables,
  violatesConstraint,
  type RecommendTableDeps
} from "./fallback";
import { suggestComplement, type ComplementSuggestion } from "./complement";
import { attributeRules, baseProductName, withDietQueries, withPetCondition, dietProofWhy, fastEtaCutoff, isAllergenRule, meetsAttributes, wantsFast, whyIsFactual } from "./quality";
import { loadCustomerMemory, memoryWantsHealthy, type LoadedMemory } from "./memory";
import { recommendEnabled } from "./types";
import type { RecommendCard, RecommendCriterion, RecommendOutcome, RecommendRequest, ShelfCandidate, ShelfPick, ShelfPlan } from "./types";

export type RecommendEnv = {
  phone: string;
  convoId: string;
  userId?: string;
  userCep: string | null | undefined;
  ctx: DeliveryContext;
};

// Funções do delivery-service que a execução reusa (registradas por ele na carga do módulo).
export type RecommendDeps = {
  // Busca de UMA consulta no funil de verdade (extração → candidatos → estoque/prazo no CEP → rerank).
  // Mantida no contrato (bench/plano B); a execução usa a busca por prateleira abaixo.
  searchOptions: (query: string, cep: string, opts?: { shelfId?: string }) => Promise<ChoiceOption[]>;
  // Mostra uma escolha pendente (cards/tela) e grava o contexto.
  sendChoices: (phone: string, p: PendingChoice, header?: string) => Promise<void>;
  // Prossegue a fila de escolhas / fecha quando acabou.
  advancePending: (phone: string, convoId: string, ctx: DeliveryContext, userCep: string | null | undefined) => Promise<void>;
  // Item de catálogo → opção de card (preço/link/remédio), exatamente como a vitrine faz.
  toChoiceOption: (item: CatalogItem, storeRef: { storeKey: string; storeLabel: string }) => ChoiceOption;
  // Conferência AO VIVO no site da loja para o CEP: preço/prazo/frete reais; sem operador, o que a
  // loja não confirmou sai (a mesma regra da vitrine).
  confirmOptionsLive: (pool: ChoiceOption[], cep: string | null | undefined) => Promise<ChoiceOption[]>;
};

let deps: RecommendDeps | null = null;
export function setRecommendDeps(d: RecommendDeps): void {
  deps = d;
}
export function recommendDeps(): RecommendDeps {
  if (!deps) throw new Error("recommend deps não registradas (delivery-service ainda não carregou)");
  return deps;
}

// Costura de TESTE: tabelas/mapa próprios (o mapa real é gerado e muda; o teste não depende dele).
let tablesOverride: RecommendTableDeps | null = null;
export function __setRecommendTablesForTests(d: RecommendTableDeps | null): void {
  tablesOverride = d;
}
function tableDeps(): RecommendTableDeps {
  return tablesOverride ?? defaultTableDeps();
}

const MAX_PICKS = 6;
// Candidatos guardados por prateleira na escolha (para "mais barato"/"outras" sem nova busca).
const KEEP_PER_SHELF = 8;

export function recommendMaxCards(): number {
  const n = Number(process.env.LIA_RECOMMEND_MAX_CARDS);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : 4;
}

// Hora de São Paulo (0–23): "fome" às 23h não sugere café da manhã.
export function saoPauloHour(now = new Date()): number {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(now));
  return Number.isFinite(h) ? h % 24 : now.getHours();
}

const keyOf = (o: { storeKey?: string; sku: string }) => `${o.storeKey ?? ""}:${o.sku}`;

// ---------------------------------------------------------------- BUSCAR

// Prazos da BUSCA (08/10/2026, placar: 9 de 31 pedidos estouravam 150 s com prateleira que nunca
// respondia). Cada prateleira tem até `PICK_BUDGET_MS` (busca + conferência ao vivo) e a busca inteira
// até `LIA_RECOMMEND_SEARCH_BUDGET_MS` (30 s); prateleira que não respondeu conta como vazia e o
// cliente recebe os cards das que chegaram.
const PICK_BUDGET_MS = 15_000;
export function recommendSearchBudgetMs(): number {
  const value = Number(process.env.LIA_RECOMMEND_SEARCH_BUDGET_MS);
  return Number.isFinite(value) && value >= 1000 ? value : 30_000;
}

// Piso de relevância da prateleira (o juiz por regras não confere o tipo): o item precisa responder a
// uma das consultas — a da pick (alternativas " | "), a da prateleira ou um alias — pelo
// SUBSTANTIVO-CABEÇA em posição de título (`shelfHeadMatch`, 08/10): "bolo pronto" aceita "Bolo de
// Chocolate Ana Maria" e recusa uva e esmalte "Bolo de Chocolate"; "perfume" não aceita absorvente.
export function shelfFloorTerms(pick: Pick<ShelfPick, "query">, shelf?: { query?: string; aliases?: readonly string[] }): string[] {
  return [...pick.query.split("|"), shelf?.query ?? "", ...(shelf?.aliases ?? [])].map((q) => q.trim()).filter(Boolean);
}

async function searchPick(pick: ShelfPick, cep: string, td: RecommendTableDeps, wide = false): Promise<ShelfCandidate[]> {
  const d = recommendDeps();
  // shelfId "produto": produto julgado sem prateleira no mapa — busca textual, nunca remédio.
  const shelf = pick.shelfId === "produto" ? undefined : td.shelfById(pick.shelfId) ?? undefined;
  try {
    // Produto julgado (1 prateleira, 4 cards de marcas diferentes com o atributo pedido): busca mais larga.
    const all = await gatherShelfCandidates(pick, shelf, { limit: wide ? 14 : KEEP_PER_SHELF, perStore: wide ? 5 : 3, cep });
    // O que veio da prateleira inteira da loja (categoria VTEX) já é da prateleira e passa direto.
    const terms = shelfFloorTerms(pick, shelf);
    const floor = all.filter((c) => Boolean(shelf?.categoryPaths?.[c.store.key]) || terms.some((q) => shelfHeadMatch(q, c.item)));
    // (08/10, rodada de qualidade) O que responde à consulta DA PICK vem antes do que só casa com um alias
    // da prateleira: "carvão" no churrasco não pode virar churrasqueira elétrica de R$ 400 (alias
    // "churrasqueira"), "picanha" não vira carne moída. Só os alias quando a pick não achou nada.
    const pickTerms = pick.query.split("|").map((q) => q.trim()).filter(Boolean);
    const own = floor.filter((c) => pickTerms.some((q) => shelfHeadMatch(q, c.item)));
    // Com 1 só resposta da pick, os alias ficam: o juiz escolhe. Produto julgado (busca larga) não corta —
    // o atributo pedido decide depois ("café em pó pra coador" casava só com os solúveis).
    const found = !wide && own.length >= 2 ? own : floor;
    if (!found.length) return [];
    const popularity = new Map(found.map((c) => [`${c.store.key}:${c.item.sku}`, c.item.popularity]));
    const options = found.map((c) => d.toChoiceOption(c.item, { storeKey: c.store.key, storeLabel: c.store.label }));
    const live = await d.confirmOptionsLive(options, cep);
    return live.map((option) => ({ shelfId: pick.shelfId, option, ...(popularity.get(keyOf(option)) != null ? { popularity: popularity.get(keyOf(option)) } : {}) }));
  } catch (error) {
    console.warn("[recommend:search:error]", pick.shelfId, error instanceof Error ? error.message : error);
    return [];
  }
}

async function searchPicks(picks: ShelfPick[], cep: string, td: RecommendTableDeps, deadline = Date.now() + recommendSearchBudgetMs(), wide = false): Promise<{ candidates: ShelfCandidate[]; emptyShelves: string[] }> {
  const perPick = await Promise.all(
    picks.map((pick) => {
      const ms = Math.min(PICK_BUDGET_MS, deadline - Date.now());
      return withDeadline(searchPick(pick, cep, td, wide && picks.length <= 2), ms, [] as ShelfCandidate[], () => console.warn(`[recommend:search:timeout] ${pick.shelfId} passou de ${ms} ms; prateleira conta como vazia`));
    })
  );
  const seen = new Set<string>();
  const candidates: ShelfCandidate[] = [];
  const emptyShelves: string[] = [];
  perPick.forEach((list, i) => {
    let kept = 0;
    for (const c of list) {
      // O mesmo item em duas prateleiras ("chocolate" e "bombom") conta só na primeira.
      const key = keyOf(c.option);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
      kept++;
    }
    if (!kept) emptyShelves.push(picks[i].shelfId);
  });
  return { candidates, emptyShelves };
}

// ---------------------------------------------------------------- JULGAR

const sameName = (a: ChoiceOption, b: ChoiceOption) => normRec(a.name) === normRec(b.name);

function toCard(c: ShelfCandidate, why: string): RecommendCard {
  return { ...c.option, shelfId: c.shelfId, why };
}

// Cards na ordem do juiz (1 por prateleira). Produto julgado (1 a 3 prateleiras) completa até o teto
// com os próximos melhores da(s) mesma(s) prateleira(s), pelo MESMO critério (regras, sem IA).
//
// Rodada de qualidade (08/10, noite), tudo determinístico e testado em tests/recommend-quality-2026-10-08:
//   - URGÊNCIA (fome, "agora", "hoje"): havendo item que chega em até 6 h, o que leva um dia sai antes do
//     juiz (se sobrarem ≥ 2 prateleiras) e os cards vão do menor prazo ao maior;
//   - necessidade: o juiz de IA que devolveu poucos cards é completado pelas regras nas prateleiras que
//     ficaram de fora; no máximo 2 cards da mesma loja quando a prateleira tem outra loja;
//   - produto julgado: marcas/linhas diferentes antes de repetir (Pampers RN 20 e RN 36 é o mesmo);
//   - motivo: só fato que o card sustenta (finalizeWhys).
async function pickCards(req: RecommendRequest, plan: ShelfPlan, candidatesIn: ShelfCandidate[], hour: number, td: RecommendTableDeps, max: number, opts: { rulesOnly?: boolean; memory?: LoadedMemory } = {}): Promise<RecommendCard[]> {
  if (!candidatesIn.length) return [];
  const memory = opts.memory;
  // Memória (fase 2, 08/10): diabetes/"não como açúcar" dito pelo cliente pede o critério "saudável"
  // (zero/diet primeiro) — só no julgamento, a copy do pedido não muda. Nunca em sintoma.
  const judged: RecommendRequest =
    memoryWantsHealthy(memory) && !isSymptomPlan(req, plan) && !req.criteria.includes("healthy") ? { ...req, criteria: [...req.criteria, "healthy"] } : req;
  const fast = wantsFast(judged.criteria, judged.urgency);
  // Sintoma não é fome: o remédio chega em 1 dia e é a resposta certa — quickOnly só vale em comida/coisa
  // (placar q2: dor de barriga "rápido" ficava só com água de coco).
  let candidates = candidatesIn;
  if (fast && !isSymptomPlan(req, plan)) {
    // Só corta pelo prazo se sobrarem 2+ prateleiras (placar q3: "algo leve pro jantar" ficava com 1 castanha).
    const quick = quickOnly(candidatesIn);
    const shelvesOf = (list: ShelfCandidate[]) => new Set(list.map((c) => c.shelfId)).size;
    if (shelvesOf(quick) >= Math.min(2, shelvesOf(candidatesIn))) candidates = quick;
  }
  if (req.form === "product_judged") candidates = productTypeOnly(req, candidates);
  const input = { request: judged, plan, candidates, hour, ...(memory ? { memory } : {}) };
  // Sintoma (rodada de qualidade 08/10): o juiz é a REGRA do remédio (apresentação básica, mais vendido,
  // preço) na ordem da tabela — determinístico, sem os 5–11 s do juiz de IA (que caía no prazo no placar).
  const verdict = opts.rulesOnly || isSymptomPlan(req, plan) ? judgeFitnessByRules(input, td) : await judgeFitness(input, td);
  const byKey = new Map(candidates.map((c) => [`${c.shelfId}|${keyOf(c.option)}`, c]));
  let cards: RecommendCard[] = [];
  const brandOf = (o: ChoiceOption) => normRec(o.brand) || normRec(o.name).split(" ").slice(0, 2).join(" ");
  const add = (shelfId: string, sku: string, storeKey: string, why: string, brandCap = Number.POSITIVE_INFINITY): boolean => {
    const c = byKey.get(`${shelfId}|${storeKey}:${sku}`);
    if (!c || cards.some((x) => keyOf(x) === keyOf(c.option) || sameName(x, c.option))) return false;
    if (req.form === "product_judged") {
      const base = baseProductName(c.option.name);
      if (cards.some((x) => baseProductName(x.name) === base)) return false;
      if (cards.filter((x) => brandOf(x) === brandOf(c.option)).length >= brandCap) return false;
    }
    cards.push(toCard(c, why || plan.picks.find((p) => p.shelfId === shelfId)?.why || ""));
    return true;
  };
  for (const card of verdict.cards) add(card.shelfId, card.sku, card.storeKey, card.why, req.form === "product_judged" ? 1 : Number.POSITIVE_INFINITY);
  if (req.form === "product_judged") {
    // 1ª volta: marcas novas; 2ª: até 2 da mesma marca (linha diferente).
    for (const brandCap of [1, 2]) {
      for (let round = 0; round < max && cards.length < max; round++) {
        const rest = candidates.filter((c) => !cards.some((x) => keyOf(x) === keyOf(c.option) || sameName(x, c.option)));
        if (!rest.length) break;
        const more = rankAll({ ...input, candidates: rest }, td);
        const before = cards.length;
        for (const card of more) if (cards.length < max) add(card.shelfId, card.sku, card.storeKey, "", brandCap);
        if (cards.length === before) break;
      }
    }
  } else {
    // O juiz de IA deixou prateleira com candidato elegível de fora e mostrou pouco: completa pelas regras.
    const eligibleShelves = [...new Set(eligibleCandidates(input).map((c) => c.shelfId))];
    const target = Math.min(max, 3, eligibleShelves.length);
    if (cards.length < target && verdict.source === "ai") {
      const covered = new Set(cards.map((c) => c.shelfId));
      const rest = candidates.filter((c) => !covered.has(c.shelfId));
      for (const card of judgeFitnessByRules({ ...input, candidates: rest }, td).cards) {
        if (cards.length >= target) break;
        add(card.shelfId, card.sku, card.storeKey, card.why);
      }
    }
    cards = capPerStore(cards, input, td, fast);
  }
  if (isSymptomPlan(req, plan)) {
    // Sintoma: a ordem é a da tabela (classe mais indicada primeiro, cuidado no fim), nunca a do prazo.
    const order = (c: RecommendCard) => {
      const i = plan.picks.findIndex((p) => p.shelfId === c.shelfId);
      return i < 0 ? plan.picks.length : i;
    };
    cards = cards.map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i).map((x) => x.c);
  } else if (fast) {
    const eta = (c: RecommendCard) => c.etaMinutes ?? Number.POSITIVE_INFINITY;
    cards = cards.map((c, i) => ({ c, i })).sort((a, b) => (eta(a.c) === eta(b.c) ? a.i - b.i : eta(a.c) - eta(b.c))).map((x) => x.c);
  }
  return preferUsualBrand(finalizeWhys(fitKitBudget(cards.slice(0, max), judged), judged, plan, memory), input, max);
}

// Produto julgado (rodada de qualidade 08/10): o card é do produto pedido, com o atributo pedido. Cada corte
// só vale se sobrar candidato: (1) atributo no nome ("cacheado", "de coador", "sensível"); (2) kit/combo só
// se o cliente pediu kit ("Kit Máscara + Shampoo" não é shampoo); (3) infantil só pra criança.
const KID_RE = /\b(crianc\w*|bebe|bebes|filh\w*|infantil|kids?|menin\w*|sobrinh\w*|recem nascid\w*|rn)\b/;
export function productTypeOnly(req: RecommendRequest, candidates: ShelfCandidate[]): ShelfCandidate[] {
  const ask = normRec(`${req.product ?? ""} ${req.text} ${req.recipient ?? ""} ${req.constraints.join(" ")}`);
  let out = candidates;
  const keep = (f: (c: ShelfCandidate) => boolean) => {
    const kept = out.filter(f);
    if (kept.length) out = kept;
  };
  const attrs = attributeRules(req.constraints);
  if (attrs.length) keep((c) => meetsAttributes(c.option.name, attrs));
  if (!/\b(kit|kits|combo|conjunto)\b/.test(ask)) keep((c) => !/\b(kit|kits|combo|conjunto)\b/.test(normRec(c.option.name)));
  // Repelente/produto pra BEBÊ (placar difícil q1): "Off Kids" é de criança maior — linha baby/bebê primeiro.
  if (/\b(bebe|bebes|recem nascid\w*|nenem)\b/.test(ask)) keep((c) => !/\bkids?\b/.test(normRec(c.option.name)));
  if (!KID_RE.test(ask)) keep((c) => !/\b(infantil|kids?|baby|bebe|junior|teen)\b/.test(normRec(c.option.name)));
  return out;
}

// Todos os candidatos de uma volta das regras, 1 por prateleira (a 1ª escolha de cada).
function rankAll(input: Parameters<typeof judgeFitnessByRules>[0], td: RecommendTableDeps) {
  return judgeFitnessByRules(input, td).cards;
}

// Urgência: só o que chega no prazo curto, se sobrarem ≥ 2 prateleiras (ou todas as que havia).
export function quickOnly(candidates: ShelfCandidate[]): ShelfCandidate[] {
  const cutoff = fastEtaCutoff(candidates.map((c) => c.option.etaMinutes));
  if (cutoff == null) return candidates;
  const quick = candidates.filter((c) => (c.option.etaMinutes ?? Number.POSITIVE_INFINITY) <= cutoff);
  // Placar q1: misturar "chega em 3h" com "amanhã" fazia o juiz reprovar a fome; com o plano de urgência
  // largo (até 6 prateleiras), basta 1 prateleira que chegue no dia.
  return quick.length ? quick : candidates;
}

// Kit com orçamento (placar q1: "filhote, preciso de tudo, até 200" somava R$ 194 + frete): os cards somados
// + frete típico cabem no teto; sai o card de menor prioridade (o último) até caber. Presente = alternativas.
export function fitKitBudget(cards: RecommendCard[], req: RecommendRequest): RecommendCard[] {
  const budget = req.budget;
  if (!budget || req.form !== "need" || /\b(presente|presentes|lembranc\w*|amigo secreto|amigo oculto)\b/.test(normRec(`${req.need ?? ""} ${req.text}`))) return cards;
  const out = [...cards];
  const total = () => out.reduce((sum, c) => sum + c.unitPrice, 0) + TYPICAL_FREIGHT;
  while (out.length > 1 && total() > budget) out.pop();
  return out;
}

// No máximo `cap` cards da mesma loja quando a prateleira tem item de outra loja (mesma regra do juiz por
// regras; em urgência, a troca não pode chegar mais de 1 h depois).
export function capPerStore(cards: RecommendCard[], input: Parameters<typeof judgeFitnessByRules>[0], td: RecommendTableDeps, fast: boolean, cap = 2): RecommendCard[] {
  const out = [...cards];
  const eligible = eligibleCandidates(input);
  const storeOf = (o: { storeKey?: string }) => o.storeKey ?? "";
  for (let i = 0; i < out.length; i++) {
    const store = storeOf(out[i]);
    if (out.slice(0, i).filter((c) => storeOf(c) === store).length < cap) continue;
    const eta = out[i].etaMinutes ?? Number.POSITIVE_INFINITY;
    const alts = eligible.filter(
      (c) =>
        c.shelfId === out[i].shelfId &&
        storeOf(c.option) !== store &&
        out.filter((x) => storeOf(x) === storeOf(c.option)).length < cap &&
        !out.some((x) => keyOf(x) === keyOf(c.option) || sameName(x, c.option)) &&
        (!fast || (c.option.etaMinutes ?? Number.POSITIVE_INFINITY) <= eta + 60)
    );
    if (!alts.length) continue;
    const best = judgeFitnessByRules({ ...input, candidates: alts }, td).cards[0];
    const chosen = best && alts.find((c) => c.option.sku === best.sku && storeOf(c.option) === best.storeKey);
    if (chosen) out[i] = toCard(chosen, "");
  }
  return out;
}

// Motivo do card (rodada de qualidade 08/10): só FATO que o card sustenta. Remédio: a classe ("alivia
// cólica"). Comida/coisa: a restrição provada no nome ("zero lactose no rótulo"), o atributo pedido
// ("linha pra dente sensível"), "o mais em conta dos N" só no card mais barato quando o critério é preço,
// ou o papel da prateleira ("pra assar", "pronto pra comer"). Popularidade, liderança e prazo prometido
// saem (o card mostra o prazo; o juiz do placar marcava "o mais vendido" como falso).
export function finalizeWhys(cards: RecommendCard[], req: RecommendRequest, plan: ShelfPlan, memory?: LoadedMemory): RecommendCard[] {
  const rules = constraintRules(req.constraints, memory);
  const attrs = req.form === "product_judged" ? attributeRules(req.constraints) : [];
  // "o mais em conta" só quando preço é O critério (o 1º); num kit de tipos diferentes a comparação confunde.
  const cheap = req.criteria[0] === "cheap" && cards.length >= 2 ? [...cards].sort((a, b) => a.unitPrice - b.unitPrice)[0] : undefined;
  // Alergia (corpus difícil h17): o nome não prova ausência de traços — o motivo avisa.
  const allergen = rules.find(isAllergenRule);
  const allergenWord = allergen && allergen.kind === "word" ? allergen.word.replace(/\s*\(.*$/, "") : undefined;
  // Urgência (h02/h20/h24): o card que chega ANTES de todos os outros diz isso (o card mostra o prazo).
  const eta = (c: RecommendCard) => c.etaMinutes ?? Number.POSITIVE_INFINITY;
  const sorted = [...cards].sort((a, b) => eta(a) - eta(b));
  const fastest = wantsFast(req.criteria, req.urgency) && sorted.length >= 2 && eta(sorted[0]) < eta(sorted[1]) ? sorted[0] : undefined;
  return cards.map((card) => {
    const pickWhy = plan.picks.find((p) => p.shelfId === card.shelfId)?.why;
    const own = whyIsFactual(card.why) ? card.why : "";
    const fromPlan = whyIsFactual(pickWhy) ? pickWhy! : "";
    let why: string;
    if (card.medicine === "mip") why = own || fromPlan;
    else if (allergenWord) why = `sem ${allergenWord} no nome; confira traços no rótulo`;
    else if (cheap && keyOf(card) === keyOf(cheap)) why = `o mais em conta dos ${cards.length}`;
    else if (fastest && keyOf(card) === keyOf(fastest)) {
      // O prazo vem do card (o juiz do placar marcava "chega mais rápido" solto como promessa sem base).
      const when = (card.delivery ?? "").replace(/^prazo da loja:\s*/i, "").trim();
      why = when ? `chega mais rápido dos ${cards.length}: ${when}` : "o que chega mais rápido daqui";
    }
    else why = dietProofWhy(card.name, rules) ?? (attrs.length && meetsAttributes(card.name, attrs) ? attrs[0].why : undefined) ?? (own || fromPlan);
    return { ...card, why };
  });
}

function isSymptomPlan(req: RecommendRequest, plan: ShelfPlan): boolean {
  return Boolean(req.symptom?.trim()) || plan.picks.some((p) => p.mipClass);
}

// "A marca de sempre" (fase 2, 08/10): marca que o cliente comprou 2+ vezes NA MESMA prateleira sobe pra
// 1º dentro da prateleira, com o motivo "a marca que você costuma levar". Só quando o critério é "bom"
// ou nenhum (preço, pressa e saudável mandam mais que o hábito) e nunca em sintoma/remédio. O candidato
// precisa passar pelas MESMAS regras do juiz (restrição, orçamento, porta do remédio).
function preferUsualBrand(cards: RecommendCard[], input: { request: RecommendRequest; plan: ShelfPlan; candidates: ShelfCandidate[]; memory?: LoadedMemory }, max: number): RecommendCard[] {
  const memory = input.memory;
  const req = input.request;
  if (!memory?.brands.length || !cards.length || isSymptomPlan(req, input.plan) || req.urgency) return cards;
  // `req` já é o pedido julgado: diabetes lembrada pôs "healthy" — aí a ordem saudável manda, não o hábito.
  if (req.criteria.some((c) => c !== "good")) return cards;
  const eligible = eligibleCandidates({ request: req, plan: input.plan, candidates: input.candidates, memory });
  const brandOf = (c: ShelfCandidate) => normRec(c.option.brand);
  const usual = (c: ShelfCandidate) =>
    memory.brands.find((b) => {
      if (b.shelfId ? b.shelfId !== c.shelfId : c.shelfId !== "produto") return false;
      const brand = normRec(b.brand);
      if (!brand) return false;
      return brandOf(c) === brand || new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normRec(c.option.name));
    });
  const out = [...cards];
  const shelves = [...new Set(out.map((c) => c.shelfId))];
  for (const shelfId of shelves) {
    const best = eligible.filter((c) => c.shelfId === shelfId && usual(c)).sort((a, b) => (usual(b)?.count ?? 0) - (usual(a)?.count ?? 0))[0];
    if (!best) continue;
    const card = toCard(best, copy.usualBrandWhy());
    const firstIdx = out.findIndex((c) => c.shelfId === shelfId);
    // Produto julgado (todos os cards na mesma prateleira): a marca vai pro 1º lugar e a linha que ela
    // ocupava (o mesmo item ou um de mesmo nome) sai; prateleiras diferentes: troca o card da prateleira.
    const same = out.findIndex((c) => keyOf(c) === keyOf(best.option) || sameName(c, best.option));
    const singleShelf = shelves.length === 1;
    if (same >= 0) out.splice(same, 1);
    else if (!singleShelf) out.splice(firstIdx, 1);
    out.splice(Math.min(firstIdx, out.length), 0, card);
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------- cadeia

type Chain = {
  plan: ShelfPlan;
  picks: ShelfPick[];
  candidates: ShelfCandidate[];
  cards: RecommendCard[];
  emptyShelves: string[];
  timings: { mapMs: number; searchMs: number; judgeMs: number };
};

// "pra hoje", "agora", "rápido", "urgente" no texto = urgência (rodada de qualidade 08/10: "me surpreende
// hj" recebia só item de amanhã). O detector nem sempre marca; a cadeia confere de novo.
const URGENT_TEXT_RE = /\b(hj|hoje|agora|rapido|rapidinho|urgente|urgencia|correndo|madrugada|chegue logo|chega logo|hoje a noite)\b|\bem (1|uma|meia|2|duas) horas?\b|\bem \d+ ?min/;

async function runChain(reqIn: RecommendRequest, cep: string, opts: { basketNames?: string[]; mustHave?: string; hour?: number; memory?: LoadedMemory } = {}): Promise<Chain> {
  const td = tableDeps();
  // Mesmos ajustes que o MAPEAR faz (sintoma × comida, pet com pulga, produto que é sintoma): o JULGAR e o
  // filtro de candidatos precisam ver o mesmo pedido.
  const norm = normalizeRecommendRequest(reqIn, td);
  const req: RecommendRequest = !norm.urgency && URGENT_TEXT_RE.test(normRec(norm.text)) ? { ...norm, urgency: true } : norm;
  const hour = opts.hour ?? saoPauloHour();
  // (08/10, rodada de qualidade) O CEP da cadeia vale também para o escopo do turno: sem ele,
  // `storesForShopper` (cópia/ao vivo) tirava TODA loja regional (Mambo, Swift) — carne, pão, pão de
  // alho, cerveja e sanduíche chegavam vazios (placar: churrasco/café da manhã só com refrigerante).
  // Fora de escopo é no-op; dentro, é o mesmo CEP que o turno já anotaria.
  noteShopperCep(cep);
  const t0 = Date.now();
  // Memória (fase 2): restrições ditas entram nos filtros e no prompt do plano (fallback.ts/ai.ts).
  const plan = await planShelves(req, { hour, basketNames: opts.basketNames, deps: td, ...(opts.memory ? { memory: opts.memory } : {}) });
  const t1 = Date.now();
  if (plan.redFlag) return { plan, picks: [], candidates: [], cards: [], emptyShelves: [], timings: { mapMs: t1 - t0, searchMs: 0, judgeMs: 0 } };
  // Refino positivo ("de morango"): a palavra entra na busca de cada prateleira e vira exigência no nome.
  const must = normRec(opts.mustHave);
  const dietRules = constraintRules(req.constraints, opts.memory);
  const picks = plan.picks
    .slice(0, MAX_PICKS)
    .map((p) => (must ? { ...p, query: p.query.split("|").map((q) => `${q.trim()} ${opts.mustHave!.trim()}`).join(" | ") } : p))
    .map((p) => (dietRules.length && p.shelfId !== "produto" ? { ...p, query: withDietQueries(p.query, p.shelfId, dietRules) } : p))
    .map((p) => ({ ...p, query: withPetCondition(p.query, p.shelfId, `${req.text} ${req.need ?? ""}`) }));
  const searched = await searchPicks(picks, cep, td, Date.now() + recommendSearchBudgetMs(), req.form === "product_judged");
  let candidates = searched.candidates;
  if (must) {
    // Tem a palavra pedida E continua sendo da prateleira ("sorvete morango" não aceita a fruta solta).
    const words = must.split(" ").filter((w) => w.length >= 3);
    // Mesmo piso da busca (substantivo-cabeça, 08/10): "bolo pronto" + "de morango" aceita "Bolo de Morango".
    const original = new Map(plan.picks.map((p) => [p.shelfId, shelfFloorTerms(p, p.shelfId === "produto" ? undefined : td.shelfById(p.shelfId) ?? undefined)]));
    candidates = candidates.filter(
      (c) =>
        words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(normRec(c.option.name))) &&
        (original.get(c.shelfId) ?? []).some((q) => shelfHeadMatch(q, c.option))
    );
  }
  // Remédio pra adulto: apresentação infantil/pediátrica só quando o pedido é pra criança/bebê.
  if (req.symptom && !/\b(crianc|bebe|filh|nenem|menin|infantil|pediatr)/.test(normRec(`${req.recipient ?? ""} ${req.text}`))) {
    candidates = candidates.filter((c) => !/\b(pediatric\w*|infantil|kids?|baby|bebe)\b/.test(normRec(c.option.name)));
  }
  const emptyShelves = picks.map((p) => p.shelfId).filter((id) => !candidates.some((c) => c.shelfId === id));
  const t2 = Date.now();
  const cards = await pickCards(req, { ...plan, picks }, candidates, hour, td, recommendMaxCards(), { memory: opts.memory });
  const t3 = Date.now();
  return { plan: { ...plan, picks }, picks, candidates, cards, emptyShelves, timings: { mapMs: t1 - t0, searchMs: t2 - t1, judgeMs: t3 - t2 } };
}

function shelfLabels(ids: string[]): string[] {
  const td = tableDeps();
  return ids.map((id) => td.shelfById(id)?.label ?? "").filter(Boolean);
}

// Memória do cliente pra cadeia (cacheada 5 min em memory.ts; erro = vazia). Sem userId: nenhuma.
async function memoryFor(env: Pick<RecommendEnv, "userId">): Promise<LoadedMemory | undefined> {
  if (!env.userId) return undefined;
  return loadCustomerMemory(env.userId, { shelves: tableDeps().shelves });
}

// Quais restrições LEMBRADAS de fato tiraram algo desta recomendação: algum candidato buscado que o juiz
// descartou por elas, ou alguma prateleira que o plano das tabelas (sem memória) teria e que elas cortam.
// Restrição que o cliente repetiu no próprio pedido não conta (ele acabou de dizer).
export function memoryActedOn(memory: LoadedMemory | undefined, req: RecommendRequest, chain: Pick<Chain, "candidates">, td: RecommendTableDeps = tableDeps()): string[] {
  if (!memory?.said.length) return [];
  const own = constraintRules(req.constraints).map((r) => JSON.stringify(r));
  let tablePicks: ShelfPick[] = [];
  try {
    tablePicks = planShelvesFromTables({ ...req, constraints: req.constraints }, td)?.picks ?? [];
  } catch {
    tablePicks = [];
  }
  const out: string[] = [];
  for (const s of memory.said) {
    const rules = constraintRules(s.filters).filter((r) => !own.includes(JSON.stringify(r)));
    if (!rules.length) continue;
    const hitCandidate = chain.candidates.some((c) => violatesConstraint(`${c.option.name} ${c.option.brand ?? ""}`, rules));
    const hitShelf = tablePicks.some((p) => violatesConstraint(`${p.query} ${td.shelfById(p.shelfId)?.label ?? ""}`, rules));
    if (hitCandidate || hitShelf) out.push(s.whoLabel ? `${s.label} (${s.whoLabel})` : s.label);
  }
  return out;
}

function withMemoryNote(header: string, acted: string[]): string {
  return acted.length ? `${copy.recommendMemoryNote(acted)}\n${header}` : header;
}

function cardOption(card: RecommendCard): ChoiceOption {
  const { shelfId: _shelf, why, ...option } = card;
  return { ...option, ...(why ? { why } : {}) };
}

// Candidatos guardados na escolha (sem campos que não servem pra re-julgar).
function keepCandidates(list: ShelfCandidate[]): ShelfCandidate[] {
  const perShelf = new Map<string, number>();
  return list.filter((c) => {
    const n = perShelf.get(c.shelfId) ?? 0;
    if (n >= KEEP_PER_SHELF) return false;
    perShelf.set(c.shelfId, n + 1);
    return true;
  });
}

// ---------------------------------------------------------------- APRENDER

type LogInput = {
  env: Pick<RecommendEnv, "phone" | "userId">;
  req: RecommendRequest;
  plan: ShelfPlan;
  cards: RecommendCard[];
  emptyShelves: string[];
  outcome: "shown" | "none" | "red_flag";
  timings: Chain["timings"];
};

async function recordRecommendation(input: LogInput): Promise<string | undefined> {
  try {
    const row = await prisma.recommendLog.create({
      data: {
        phone: input.env.phone,
        userId: input.env.userId ?? null,
        source: input.req.source,
        form: input.req.form,
        need: input.req.need ?? null,
        product: input.req.product ?? null,
        symptom: input.req.symptom ?? null,
        criteria: input.req.criteria,
        constraints: input.req.constraints,
        planSource: input.plan.source,
        redFlag: input.plan.redFlag ?? null,
        shelfIds: input.plan.picks.map((p) => p.shelfId),
        cardSkus: input.cards.map((c) => `${c.storeKey ?? ""}:${c.sku}`),
        emptyShelves: input.emptyShelves,
        outcome: input.outcome,
        mapMs: input.timings.mapMs,
        searchMs: input.timings.searchMs,
        judgeMs: input.timings.judgeMs
      },
      select: { id: true }
    });
    return row.id;
  } catch (error) {
    console.warn("[recommend:log:error]", error instanceof Error ? error.message : error);
    return undefined;
  }
}

// A escolha fechou (confirmChosenOption) numa PendingChoice de recomendação.
export async function markRecommendChosen(recommendation: RecommendationState | undefined, chosen: ChoiceOption): Promise<void> {
  if (!recommendation?.logId) return;
  try {
    await prisma.recommendLog.update({ where: { id: recommendation.logId }, data: { chosenSku: `${chosen.storeKey ?? ""}:${chosen.sku}`, outcome: "chosen" } });
  } catch (error) {
    console.warn("[recommend:log:chosen:error]", error instanceof Error ? error.message : error);
  }
}

function logLine(req: RecommendRequest, chain: Chain, cards: number, ms: number) {
  const what = req.form === "product_judged" ? `product=${JSON.stringify(req.product ?? "")}` : `need=${JSON.stringify(req.need ?? "")}`;
  console.log(
    `[recommend] form=${req.form} ${what}${req.symptom ? ` symptom=${JSON.stringify(req.symptom)}` : ""} plan=${chain.plan.source}${chain.plan.redFlag ? ` redFlag=${JSON.stringify(chain.plan.redFlag)}` : ""} picks=${chain.picks.length} cards=${cards} empty=${chain.emptyShelves.length} ms=${ms} (map=${chain.timings.mapMs} search=${chain.timings.searchMs} judge=${chain.timings.judgeMs})`
  );
}

// ---------------------------------------------------------------- EXECUTAR

export async function handleRecommend(env: RecommendEnv, req: RecommendRequest): Promise<void> {
  const { phone, convoId, ctx } = env;
  if (!recommendEnabled()) {
    await reply(phone, copy.vagueRequestAnswer());
    return;
  }
  const cep = env.userCep ?? ctx.cep;
  // Emergência (revisão de segurança 08/10): dor no peito, falta de ar, sangue… sai NA HORA, antes de
  // pedir CEP — o cliente cadastrado sem CEP recebia o alerta só depois de mandar o endereço.
  const emergency = emergencyFlag(req.text, req.recipient);
  if (emergency) {
    const plan: ShelfPlan = { picks: [], redFlag: emergency, redFlagKind: "emergency", source: "table" };
    console.log(`[recommend] form=${req.form} emergency=${JSON.stringify(emergency)} (antes do CEP)`);
    await reply(phone, copy.recommendRedFlag(emergency, "emergency"));
    await recordRecommendation({ env, req, plan, cards: [], emptyShelves: [], outcome: "red_flag", timings: { mapMs: 0, searchMs: 0, judgeMs: 0 } });
    return;
  }
  if (!cep) {
    // Sem CEP não há estoque nem prazo (dono, 08/10): guarda a frase inteira e pede o CEP.
    ctx.pendingRecommend = req.text;
    ctx.flow = "delivery";
    ctx.step = "need_cep";
    await writeCtx(convoId, ctx);
    await reply(phone, copy.notedAskCep([copy.recommendNoted(req)]));
    return;
  }
  const started = Date.now();
  const memory = await memoryFor(env);
  const chain = await runChain(req, cep, { basketNames: ctx.basket?.map((b) => b.name), memory });
  const max = recommendMaxCards();
  if (chain.plan.redFlag) {
    logLine(req, chain, 0, Date.now() - started);
    await reply(phone, copy.recommendRedFlag(chain.plan.redFlag, chain.plan.redFlagKind));
    await recordRecommendation({ env, req, plan: chain.plan, cards: [], emptyShelves: [], outcome: "red_flag", timings: chain.timings });
    return;
  }
  const shown = chain.cards.slice(0, max);
  logLine(req, chain, shown.length, Date.now() - started);
  if (!shown.length) {
    await reply(phone, copy.recommendNone(req, shelfLabels(chain.emptyShelves)));
    await recordRecommendation({ env, req, plan: chain.plan, cards: [], emptyShelves: chain.emptyShelves, outcome: "none", timings: chain.timings });
    return;
  }
  const logId = await recordRecommendation({ env, req, plan: chain.plan, cards: shown, emptyShelves: chain.emptyShelves, outcome: "shown", timings: chain.timings });
  const options = shown.map(cardOption);
  const pending: PendingChoice = {
    query: copy.recommendLabel(req),
    qty: 1,
    options,
    shownSkus: options.map((o) => o.sku),
    shownOptions: options,
    recommendation: {
      request: req,
      plan: chain.plan,
      shownShelfIds: [...new Set(shown.map((c) => c.shelfId))],
      emptyShelves: chain.emptyShelves,
      candidates: keepCandidates(chain.candidates),
      ...(logId ? { logId } : {})
    }
  };
  // Recomendação entra NA FRENTE se já havia escolha aberta (é o que o cliente acabou de pedir).
  ctx.flow = "delivery";
  ctx.step = "choosing";
  ctx.pending = [pending, ...(ctx.pending ?? [])];
  ctx.pendingSince = Date.now();
  await writeCtx(convoId, ctx);
  await showRecommendation(phone, pending, withFastestNote(withMemoryNote(copy.recommendIntro(req), memoryActedOn(memory, req, chain)), req, shown));
}

// Urgência sem entrega na hora (corpus difícil h02/h20/h24): a copy diz o MELHOR prazo real, sem prometer.
function withFastestNote(header: string, req: RecommendRequest, cards: RecommendCard[]): string {
  const urgent = wantsFast(req.criteria, req.urgency) || URGENT_TEXT_RE.test(normRec(req.text));
  const etas = cards.map((c) => c.etaMinutes).filter((m): m is number => typeof m === "number" && m > 0);
  if (!urgent || !etas.length) return header;
  const min = Math.min(...etas);
  return min >= 60 ? `${copy.recommendFastestNote(min)}\n${header}` : header;
}

// Cards + (remédio isento) a copy de cuidado ANTES deles. O CPF é pedido no fluxo de sempre quando
// ele escolher; a regra Meta de remédio (cards soltos, sem carrossel) já está em sendChoices.
async function showRecommendation(phone: string, pending: PendingChoice, header: string, opts: { care?: boolean } = {}) {
  if ((opts.care ?? true) && medicineEnabled() && pending.options.some((o) => o.medicine === "mip")) await reply(phone, copy.recommendMedicineCare());
  await recommendDeps().sendChoices(phone, pending, header);
}

function remember(current: PendingChoice, next: ChoiceOption[], shelves: string[]) {
  const rec = current.recommendation!;
  const known = new Set((current.shownOptions ?? current.options).map(keyOf));
  current.shownOptions = [...(current.shownOptions ?? current.options), ...next.filter((o) => !known.has(keyOf(o)))];
  current.shownSkus = [...new Set([...(current.shownSkus ?? current.options.map((o) => o.sku)), ...next.map((o) => o.sku)])];
  current.options = next;
  current.closestFalta = undefined;
  rec.shownShelfIds = [...new Set([...rec.shownShelfIds, ...shelves])];
}

// "outras" numa escolha de recomendação: primeiro as prateleiras do plano que ainda não apareceram;
// depois o próximo melhor de cada prateleira já mostrada; nada novo → diz que eram essas.
export async function recommendMore(env: RecommendEnv, current: PendingChoice): Promise<void> {
  const rec = current.recommendation;
  if (!rec) return;
  const td = tableDeps();
  const hour = saoPauloHour();
  const max = recommendMaxCards();
  const shown = new Set([...(current.shownOptions ?? []), ...current.options].map(keyOf));
  const fresh = (rec.candidates ?? []).filter((c) => !shown.has(keyOf(c.option)));
  const unshownShelves = fresh.filter((c) => !rec.shownShelfIds.includes(c.shelfId));
  const memory = await memoryFor(env);
  let next = unshownShelves.length ? await pickCards(rec.request, rec.plan, unshownShelves, hour, td, max, { rulesOnly: true, memory }) : [];
  if (!next.length && fresh.length) next = await pickCards(rec.request, rec.plan, fresh, hour, td, max, { rulesOnly: true, memory });
  // Variante do que já está na mesa não é "outra ideia".
  next = next.filter((card) => !current.options.some((o) => sameName(o, card))).slice(0, max);
  if (!next.length) {
    await reply(env.phone, copy.recommendMoreNone());
    return;
  }
  const options = next.map(cardOption);
  remember(current, options, next.map((c) => c.shelfId));
  await writeCtx(env.convoId, env.ctx);
  await showRecommendation(env.phone, current, copy.moreChoicesHeader(current.query), { care: false });
}

// "mais barato"/"mais caro" numa escolha de recomendação: re-julga os MESMOS candidatos pelo preço
// (sem nova busca) e mostra do mais barato ao mais caro (ou o contrário).
export async function recommendByPrice(env: RecommendEnv, current: PendingChoice, dir: "asc" | "desc"): Promise<void> {
  const rec = current.recommendation;
  if (!rec) return;
  const td = tableDeps();
  const criteria: RecommendCriterion[] = dir === "asc" ? ["cheap"] : ["good"];
  const req: RecommendRequest = { ...rec.request, criteria };
  const pool = rec.candidates?.length ? rec.candidates : current.options.map((option) => ({ shelfId: "produto", option }));
  const cards = await pickCards(req, rec.plan, pool, saoPauloHour(), td, recommendMaxCards(), { rulesOnly: dir === "desc", memory: await memoryFor(env) });
  const price = (o: ChoiceOption) => o.unitPrice;
  const sorted = [...cards]
    .sort((a, b) => (dir === "asc" ? price(a) - price(b) : price(b) - price(a)))
    .slice(0, recommendMaxCards())
    // "o mais em conta" só é verdade no primeiro; nos outros o motivo do plano (ou nenhum).
    .map((card, i) => (dir === "asc" && i > 0 && card.why.startsWith("o mais em conta") ? { ...card, why: rec.plan.picks.find((p) => p.shelfId === card.shelfId)?.why ?? "" } : card));
  if (!sorted.length) {
    await recommendDeps().sendChoices(env.phone, current);
    return;
  }
  rec.request = req;
  const options = sorted.map(cardOption);
  remember(current, options, sorted.map((c) => c.shelfId));
  await writeCtx(env.convoId, env.ctx);
  await recommendDeps().sendChoices(env.phone, current, copy.priceSortedHeader(current.query, dir === "asc"));
}

// Refino ("sem chocolate", "de morango", "zero açúcar") numa escolha de recomendação: a restrição
// entra no pedido (ou a palavra vira exigência) e MAPEAR+BUSCAR+JULGAR rodam de novo.
export type RecommendRefinement = { constraint?: string; want?: string };

export async function recommendRefine(env: RecommendEnv, current: PendingChoice, refinement: RecommendRefinement): Promise<void> {
  const rec = current.recommendation;
  if (!rec) return;
  const cep = env.userCep ?? env.ctx.cep;
  if (!cep) {
    await recommendDeps().sendChoices(env.phone, current);
    return;
  }
  const constraints = refinement.constraint && !rec.request.constraints.includes(refinement.constraint) ? [...rec.request.constraints, refinement.constraint] : rec.request.constraints;
  const want = refinement.want?.trim();
  const req: RecommendRequest = {
    ...rec.request,
    constraints,
    ...(want && rec.request.form === "need" ? { need: `${rec.request.need ?? ""} de ${want}`.trim() } : {}),
    ...(want && rec.request.form === "product_judged" ? { product: `${rec.request.product ?? ""} de ${want}`.trim() } : {})
  };
  const started = Date.now();
  const basketNames = env.ctx.basket?.map((b) => b.name);
  // O re-plano usa a necessidade/produto ORIGINAL (é o que casa nas tabelas e no mapa); a palavra
  // pedida ("morango") entra na busca de cada prateleira e vira exigência no nome.
  const memory = await memoryFor(env);
  const chain = await runChain({ ...req, need: rec.request.need, product: rec.request.product }, cep, { basketNames, mustHave: want, memory });
  const shown = chain.cards.slice(0, recommendMaxCards());
  logLine(req, chain, shown.length, Date.now() - started);
  if (!shown.length) {
    await reply(env.phone, copy.recommendNone(req, shelfLabels(chain.emptyShelves)));
    return;
  }
  const options = shown.map(cardOption);
  rec.request = req;
  rec.plan = chain.plan;
  rec.emptyShelves = chain.emptyShelves;
  rec.candidates = keepCandidates(chain.candidates);
  current.query = copy.recommendLabel(req);
  remember(current, options, []);
  // Plano novo: só as prateleiras desta tela contam como mostradas.
  rec.shownShelfIds = [...new Set(shown.map((c) => c.shelfId))];
  await writeCtx(env.convoId, env.ctx);
  await showRecommendation(env.phone, current, withMemoryNote(copy.recommendIntro(req), memoryActedOn(memory, req, chain)), { care: false });
}

// Texto de refino sobre uma recomendação na tela. Só é chamado com `recommendation` na escolha
// (fora disso "sem chocolate" é remoção da cesta e "de morango" é atributo de busca).
const REFINE_NOISE = /\b(entrega|frete|pix|cartao|desconto|cupom|prazo|hoje|amanha|endereco|cep|pagar|pagamento)\b/;
export function parseRecommendRefine(text: string): RecommendRefinement | null {
  let n = normalizeMsg(text).replace(/[?!.]+$/g, "").trim();
  if (!n || n.length > 50 || REFINE_NOISE.test(n)) return null;
  n = n.replace(/^(?:mas|e|so|ok|entao|ah|hmm)\s+/, "").replace(/^(?:quero|queria|prefiro|preferia|tem|teria|tem algum[a]?|algum[a]?|pode ser|me ve|ve)\s+(?:algo\s+|um[a]?\s+|outr[oa]s?\s+)?/, "");
  const neg = n.match(/^(?:sem|nada de|nao quero|nao pode ter|tira o|tira a|tira)\s+(.{2,30})$/);
  if (neg) return { constraint: `sem ${neg[1].trim()}` };
  const zero = n.match(/^zero\s+(.{2,20})$/);
  if (zero) return { constraint: `zero ${zero[1].trim()}` };
  if (/^(?:vegan[oa]s?|vegetarian[oa]s?|diet|light|integral|sem lactose|sem gluten|natural)$/.test(n)) return { constraint: n };
  const want = n.match(/^(?:de|com|sabor|do tipo|tipo)\s+(.{2,25})$/);
  if (want && !/^(?:o |a )?\d+$/.test(want[1])) return { want: want[1].trim() };
  return null;
}

// Gancho do roteador (antes da escolha comum): "outras"/"mais barato"/"mais caro" e refino sobre uma
// escolha de recomendação. Devolve true quando tratou.
export async function recommendFollowUp(env: RecommendEnv, text: string, intent: Intent): Promise<boolean> {
  const current = env.ctx.pending?.[0];
  if (!current?.recommendation || !recommendEnabled()) return false;
  if (intent.kind === "more_options") {
    if (intent.cheaper === true) await recommendByPrice(env, current, "asc");
    else if (/\bmais caro/.test(normalizeMsg(text))) await recommendByPrice(env, current, "desc");
    else await recommendMore(env, current);
    return true;
  }
  const refine = parseRecommendRefine(text);
  if (refine) {
    await recommendRefine(env, current, refine);
    return true;
  }
  return false;
}

// Refino que chegou pelos caminhos de sempre (refineOptions / researchChoice: gerente de diálogo,
// "tem de morango?"). `wanted` = a frase com a base; o que sobra depois da base é o refino.
export async function recommendRefineFromAttribute(env: RecommendEnv, current: PendingChoice, attribute: string): Promise<void> {
  const base = normalizeMsg(current.baseQuery ?? current.query);
  let attr = normalizeMsg(attribute);
  if (attr.startsWith(base)) attr = attr.slice(base.length).trim();
  const parsed = parseRecommendRefine(attr) ?? (attr ? { want: attr } : null);
  if (!parsed) {
    await recommendDeps().sendChoices(env.phone, current);
    return;
  }
  await recommendRefine(env, current, parsed);
}

// Entrada do placar (scripts/bench-recommend.mts): mesma cadeia, sem WhatsApp nem contexto.
export async function recommendForBench(req: RecommendRequest, cep: string): Promise<RecommendOutcome> {
  const chain = await runChain(req, cep);
  return { request: req, plan: chain.plan, cards: chain.cards.slice(0, recommendMaxCards()), emptyShelves: chain.emptyShelves, timings: chain.timings };
}

// ---------------------------------------------------------------- COMPLEMENTO NO FECHAMENTO (fase 4)

// No fechamento ("só isso"), UM item que costuma ir junto do que está na cesta (complement.ts escolhe a
// prateleira pela tabela), pelo MESMO funil da recomendação: busca da prateleira no CEP → conferência ao
// vivo → melhor pelas regras (critério "bom", restrições lembradas valendo). Nada comprável ou mais de
// `timeoutMs` (4 s) = null e o fechamento segue direto pro total.
export type ComplementFound = { suggestion: ComplementSuggestion; option: ChoiceOption; ms: number };

export async function findComplement(input: {
  cep: string;
  basket: readonly BasketItem[];
  declined?: readonly string[];
  userId?: string;
  timeoutMs?: number;
}): Promise<ComplementFound | null> {
  const td = tableDeps();
  noteShopperCep(input.cep);
  const suggestion = suggestComplement(input.basket, { shelfById: td.shelfById, recentlyDeclined: input.declined });
  if (!suggestion) return null;
  const started = Date.now();
  const work = (async (): Promise<ComplementFound | null> => {
    const pick: ShelfPick = { shelfId: suggestion.shelfId, query: suggestion.query, why: suggestion.why };
    const inBasket = new Set(input.basket.map((b) => `${b.storeKey ?? ""}:${b.sku}`));
    const basketSkus = new Set(input.basket.map((b) => b.sku));
    const candidates = (await searchPick(pick, input.cep, td)).filter((c) => !inBasket.has(keyOf(c.option)) && !basketSkus.has(c.option.sku) && c.option.medicine !== "mip");
    if (!candidates.length) return null;
    const memory = input.userId ? await loadCustomerMemory(input.userId, { shelves: td.shelves }) : undefined;
    const req: RecommendRequest = { form: "product_judged", text: suggestion.query, product: suggestion.query, criteria: [], constraints: [], source: "regex" };
    // Mesmas regras do juiz (restrição lembrada, porta do remédio); a escolha é o BÁSICO da prateleira:
    // conferido ao vivo, mais vendido, preço perto da mediana — complemento não é hora de item premium.
    const eligible = eligibleCandidates({ request: req, plan: { picks: [pick], source: "table" }, candidates, ...(memory ? { memory } : {}) });
    if (!eligible.length) return null;
    const prices = eligible.map((c) => c.option.unitPrice).sort((a, b) => a - b);
    const median = prices[Math.floor((prices.length - 1) / 2)];
    const pop = (c: ShelfCandidate) => c.popularity ?? Number.POSITIVE_INFINITY;
    const chosen = [...eligible].sort(
      (a, b) =>
        Number(Boolean(b.option.verified)) - Number(Boolean(a.option.verified)) ||
        (pop(a) === pop(b) ? 0 : pop(a) === Number.POSITIVE_INFINITY ? 1 : pop(b) === Number.POSITIVE_INFINITY ? -1 : pop(a) - pop(b)) ||
        Math.abs(a.option.unitPrice - median) - Math.abs(b.option.unitPrice - median) ||
        a.option.unitPrice - b.option.unitPrice
    )[0];
    return { suggestion, option: chosen.option, ms: Date.now() - started };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), input.timeoutMs ?? 4000);
  });
  try {
    const found = await Promise.race([work.catch(() => null), timeout]);
    if (!found && Date.now() - started >= (input.timeoutMs ?? 4000)) console.warn("[recommend:complement:timeout]", suggestion.trigger);
    return found;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// RecommendLog do complemento: source "complement", outcome shown → accepted/declined.
export async function recordComplementOffer(env: { phone: string; userId?: string }, found: ComplementFound): Promise<string | undefined> {
  try {
    const row = await prisma.recommendLog.create({
      data: {
        phone: env.phone,
        userId: env.userId ?? null,
        source: "complement",
        form: "need",
        need: `complemento de ${found.suggestion.trigger}`,
        product: found.suggestion.query,
        symptom: null,
        criteria: ["good"],
        constraints: [],
        planSource: "table",
        redFlag: null,
        shelfIds: [found.suggestion.shelfId],
        cardSkus: [`${found.option.storeKey ?? ""}:${found.option.sku}`],
        emptyShelves: [],
        outcome: "shown",
        mapMs: 0,
        searchMs: found.ms,
        judgeMs: 0
      },
      select: { id: true }
    });
    return row.id;
  } catch (error) {
    console.warn("[recommend:complement:log:error]", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function markComplementOutcome(logId: string | undefined, outcome: "accepted" | "declined", chosenSku?: string): Promise<void> {
  if (!logId) return;
  try {
    await prisma.recommendLog.update({ where: { id: logId }, data: { outcome, ...(chosenSku ? { chosenSku } : {}) } });
  } catch (error) {
    console.warn("[recommend:complement:log:outcome:error]", error instanceof Error ? error.message : error);
  }
}
