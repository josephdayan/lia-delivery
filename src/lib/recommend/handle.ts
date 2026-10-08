// EXECUTAR (08/10/2026): a recomendação de ponta a ponta — plano de prateleiras → busca por
// prateleira no CEP → juiz de aptidão → cards → registro. STUB do orquestrador: a implementação
// real chega na etapa 5 do plano; até lá responde com a copy de pedido vago (comportamento de hoje).
// Quem chama: dialogue/execute.ts (ação `recommend`) e delivery-service (`handleSearch` via detect.ts).
// As funções do delivery-service chegam por `setRecommendDeps` (sem import circular).
import type { DeliveryContext, ChoiceOption } from "../conversation-types";
import * as copy from "../lia-copy";
import { reply } from "../turn-runtime";
import type { RecommendOutcome, RecommendRequest } from "./types";

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
  searchOptions: (query: string, cep: string, opts?: { shelfId?: string }) => Promise<ChoiceOption[]>;
  // Mostra uma escolha pendente (cards/tela) e grava o contexto.
  sendChoices: (phone: string, p: DeliveryContext["pending"] extends (infer T)[] | undefined ? T : never, header?: string) => Promise<void>;
  // Prossegue a fila de escolhas / fecha quando acabou.
  advancePending: (phone: string, convoId: string, ctx: DeliveryContext, userCep: string | null | undefined) => Promise<void>;
};

let deps: RecommendDeps | null = null;
export function setRecommendDeps(d: RecommendDeps): void {
  deps = d;
}
export function recommendDeps(): RecommendDeps {
  if (!deps) throw new Error("recommend deps não registradas (delivery-service ainda não carregou)");
  return deps;
}

export async function handleRecommend(env: RecommendEnv, req: RecommendRequest): Promise<void> {
  void req;
  await reply(env.phone, copy.vagueRequestAnswer());
}

// Entrada do placar (scripts/bench-recommend.mts): mesma cadeia, sem WhatsApp nem contexto.
export async function recommendForBench(req: RecommendRequest, cep: string): Promise<RecommendOutcome> {
  void cep;
  return { request: req, plan: { picks: [], source: "table" }, cards: [], emptyShelves: [], timings: { mapMs: 0, searchMs: 0, judgeMs: 0 } };
}
