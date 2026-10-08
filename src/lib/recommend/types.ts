// Recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md): contratos entre as
// cinco etapas — ENTENDER (detect.ts + gerente de diálogo) → MAPEAR (ai.ts/fallback.ts sobre
// shelf-map.ts + tables.ts) → BUSCAR (stores/index.ts gatherShelfCandidates) → JULGAR (ai.ts
// judgeFitness + fallback) → EXECUTAR/APRENDER (handle.ts). Este arquivo é só tipos: nenhuma
// etapa importa a outra por fora destes contratos. Mudar um contrato = avisar todas as etapas.
import type { ChoiceOption } from "../conversation-types";
import { isAdminPhone, turnMeta } from "../turn-runtime";

// ---------- ENTENDER ----------

// Forma do pedido. "product": produto nomeado sem julgamento — NÃO é recomendação (busca de
// sempre); fica aqui só para a tabela-ouro rotular. "product_judged": produto nomeado + pedido
// de julgamento ("me recomenda um chocolate bom", "qual o melhor shampoo pra cacheado").
// "need": necessidade/estado/ocasião sem produto ("tô com fome", "dor de barriga", "algo doce",
// "churrasco pra 8", "presente pra minha mãe").
export type RecommendForm = "product" | "product_judged" | "need";

// Critério que ordena os cards. fast = menor prazo real no CEP e pronto-pra-usar; good = marca
// reconhecida + popularidade (nunca o mais barato por padrão); cheap = preço; healthy = versão
// integral/zero/natural quando existir.
export type RecommendCriterion = "fast" | "good" | "cheap" | "healthy";

export type RecommendSource = "dialogue" | "regex" | "presignup";

export type RecommendRequest = {
  form: Exclude<RecommendForm, "product">;
  // A mensagem original (ou o pedido guardado antes do CEP), intacta.
  text: string;
  // form=product_judged: o produto nomeado, limpo ("chocolate", "shampoo cabelo cacheado").
  product?: string;
  // form=need: a necessidade como o cliente disse, limpa de enfeite ("algo doce", "fome",
  // "dor de barriga", "churrasco pra 8 pessoas", "presente pra minha mãe").
  need?: string;
  criteria: RecommendCriterion[];
  // Restrições ditas: "sem lactose", "sem chocolate", "zero açúcar", "vegano". Sem orçamento (vai em budget).
  constraints: string[];
  // Teto TOTAL com entrega, em reais, quando dito.
  budget?: number;
  // Pra quem: "mãe", "namorada", "cachorro", "gato", "criança 5 anos", "bebê".
  recipient?: string;
  // "agora", "hoje", "tô com fome" (fome implica urgência).
  urgency?: boolean;
  // Sintoma normalizado quando o pedido é de saúde ("dor de barriga", "dor de cabeça", "azia").
  symptom?: string;
  source: RecommendSource;
};

// ---------- MAPEAR ----------

export type ShelfDomain = "mercado" | "farmacia" | "pet" | "beleza" | "casa" | "brinquedo" | "eletronico" | "moda" | "livraria" | "presente";

// mip = remédio isento (só sai pela porta do remédio, com CPF e copy de cuidado);
// ready_to_eat = pronto pra comer sem preparo; cold = gelado/congelado; fresh = perecível;
// kids/pet = público; gift = presenteável; care = produto de saúde não-remédio (soro, chá, compressa).
export type ShelfFlag = "mip" | "ready_to_eat" | "cold" | "fresh" | "kids" | "pet" | "gift" | "care";

// Um nó do mapa de prateleiras: o que a Lia VENDE, numa página que cabe no prompt. Gerado dos
// catálogos por scripts/build-shelf-map.mts (nunca escrito à mão, exceto `aliases`/`flags` curados).
export type ShelfNode = {
  // Estável, em snake/ponto: "doces.chocolate", "farmacia.antidiarreico", "pet.racao_cachorro".
  id: string;
  // Como aparece pro modelo e pro /ops: "Chocolates e bombons".
  label: string;
  domain: ShelfDomain;
  // Consulta textual padrão que acha a prateleira na busca de hoje ("chocolate").
  query: string;
  // Consultas alternativas que também acham a prateleira ("bombom", "barra de chocolate").
  aliases?: string[];
  // storeKey → caminho de categoria da busca inteligente VTEX ("mercearia/chocolates"); só onde
  // o gerador conseguiu derivar da `category` dos itens. Sem caminho = busca textual.
  categoryPaths?: Record<string, string>;
  // storeKeys que têm itens nessa prateleira (derivado dos catálogos).
  stores: string[];
  flags?: ShelfFlag[];
  // Quantos itens dos catálogos caíram aqui (sinal de cobertura, não de qualidade).
  itemCount?: number;
};

export type ShelfMap = { generatedAt: string; shelves: ShelfNode[] };

// Uma prateleira escolhida para a necessidade: `query` é o que vai pra busca (pode ser mais
// específica que a padrão da prateleira: "chocolate ao leite"), `why` é o motivo de 1 linha que
// pode aparecer no card ("alivia cólica e gases", "o mais vendido"), em fatos — nunca promessa.
export type ShelfPick = {
  shelfId: string;
  query: string;
  why: string;
  // Só remédio: classe terapêutica da tabela (ex.: "antiespasmodico"), para a ordem e a copy.
  mipClass?: string;
};

export type ShelfPlan = {
  picks: ShelfPick[];
  // Sintoma com sinal de alerta (dor forte, sangue, febre alta, gestante, bebê…): NÃO recomenda;
  // a copy de alerta sai e o cliente compra só se nomear o isento. `redFlag` = o motivo curto.
  redFlag?: string;
  // (08/10, revisão adversarial A2) "emergency" = sinal de emergência (dor no peito, falta de ar,
  // desmaio, sangue…), vale em QUALQUER pedido e sai antes de tudo; "context" = sinal que só pesa em
  // pedido de saúde/remédio (bebê, criança, idoso, gestante, comorbidade, há N dias, pet doente).
  // Opcional (compatível): ausente = "context".
  redFlagKind?: "emergency" | "context";
  source: "ai" | "table";
};

// ---------- TABELAS CURADAS (tables.ts) ----------

export type NeedTableEntry = {
  // Chaves normalizadas (sem acento, minúsculas) que casam com a necessidade: ["fome", "com fome"].
  keys: string[];
  // Prateleiras em ordem do que mais ajuda (ids do mapa) com a consulta e o motivo prontos.
  picks: ShelfPick[];
  // Critério implícito da necessidade (fome → fast).
  criteria?: RecommendCriterion[];
};

export type SymptomTableEntry = {
  // "dor de barriga", "diarreia", "azia"…
  keys: string[];
  // Classes isentas em ordem do mais indicado: cada uma com a prateleira do mapa, a consulta
  // (princípios ativos/marcas isentas separadas por "|" para a busca de alias) e o motivo.
  picks: ShelfPick[];
  // Produtos de cuidado não-remédio que ajudam (soro, chá, compressa) — entram depois dos isentos.
  care?: ShelfPick[];
};

export type RedFlagRule = {
  // Regex (sobre texto normalizado) que marca sinal de alerta.
  pattern: RegExp;
  reason: string;
  // (08/10, revisão A2) emergência vale em todo pedido; contexto só em saúde/remédio. Ausente = "context".
  kind?: "emergency" | "context";
};

// ---------- BUSCAR ----------

export type ShelfCandidate = {
  shelfId: string;
  option: ChoiceOption;
  // Posição do item no catálogo da loja (1 = mais vendido), quando conhecida.
  popularity?: number;
};

// ---------- JULGAR ----------

export type FitnessInput = {
  request: RecommendRequest;
  plan: ShelfPlan;
  candidates: ShelfCandidate[];
  // Hora local do cliente (0–23), para "fome" às 23h não sugerir café da manhã.
  hour?: number;
  // Memória do cliente (fase 2): restrições ditas, marcas repetidas, categorias recentes.
  memory?: CustomerMemory;
};

export type FitnessVerdict = {
  // Melhor item por prateleira, do que mais ajuda ao que menos; 1 por prateleira; nunca sku
  // fora dos candidatos. `why` pode vir do juiz (reescrito) ou do pick.
  cards: { shelfId: string; sku: string; storeKey: string; why: string }[];
  source: "ai" | "rule";
};

// ---------- MEMÓRIA (fase 2) ----------

export type CustomerMemory = {
  // Só o que o cliente DISSE, com a data: "sem lactose", "diabético", "vegano".
  restrictions: { text: string; at: string }[];
  pet?: { species: "cachorro" | "gato" | "outro"; size?: string; at: string };
  household?: { people?: number; at: string };
  // Marcas escolhidas 2+ vezes, por prateleira.
  brands: { shelfId?: string; brand: string; count: number }[];
  // Prateleiras dos últimos pedidos pagos (mais recente primeiro).
  recentShelves: { shelfId: string; at: string }[];
};

// ---------- EXECUTAR ----------

// Card de recomendação = opção de escolha + prateleira + motivo. `ChoiceOption.why` existe
// desde a fase 1 (conversation-types) para o card exibir o motivo.
export type RecommendCard = ChoiceOption & { shelfId: string; why: string };

// O que a execução registra (RecommendLog) e o bench lê.
export type RecommendOutcome = {
  request: RecommendRequest;
  plan: ShelfPlan;
  cards: RecommendCard[];
  // Prateleiras do plano que ficaram sem item comprável no CEP.
  emptyShelves: string[];
  timings: { mapMs: number; searchMs: number; judgeMs: number };
};

// LIA_RECOMMEND (dono, 08/10, noite): "test" (padrão) = só dono/admins (LIA_OWNER_PHONE / LIA_ADMIN_PHONES /
// LIA_OPERATOR_PHONE) recebem recomendação até o placar bater a meta (atende ≥ 90%); "all"/"true" = todo
// cliente; "false" = desligada. Fora de um turno de WhatsApp (placar, scripts, testes com a flag "all") vale.
export function recommendEnabled(): boolean {
  const mode = (process.env.LIA_RECOMMEND ?? "test").trim().toLowerCase();
  if (mode === "false" || mode === "off") return false;
  if (mode === "true" || mode === "all") return true;
  const phone = turnMeta.getStore()?.phone;
  return !phone || isAdminPhone(phone);
}

// Remédio isento por sintoma (dono, 08/10): liga junto com LIA_MEDICINE_MIP; desliga sozinho
// com LIA_RECOMMEND_MEDICINE=false.
export function recommendMedicineEnabled(): boolean {
  return process.env.LIA_RECOMMEND_MEDICINE !== "false";
}
