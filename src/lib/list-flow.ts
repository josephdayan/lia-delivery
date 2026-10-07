// Flow "Escolher minha lista" (07/10): monta o `data` da tela LISTA (meta-setup.ts) a partir
// das linhas já buscadas e lê a resposta do cliente. Puro, sem DB nem rede: o cérebro cuida
// da cesta, daqui só saem o payload e a interpretação do retorno.
import { compactCardDelivery } from "@/lib/meta-carousel-card";
import type { ChoiceOption } from "@/lib/conversation-types";
import type { WhatsAppFlowDataValue } from "@/lib/adapters/whatsapp";

export const LIST_FLOW_MAX_SLOTS = 15;
export const LIST_FLOW_MAX_OPTIONS = 4;
// Rótulo gravado no histórico no lugar da resposta crua do formulário.
export const LIST_FLOW_MESSAGE = "🛒 Lista escolhida no formulário";
export const LIST_FLOW_SKIP_ID = "skip";
export const LIST_FLOW_SKIP_TITLE = "Não quero este item";
// Orçamento de miniaturas (base64) dentro do payload total de 1 MB da Meta.
export const LIST_FLOW_IMAGE_BUDGET = 600_000;
const LABEL_MAX = 30;
const TITLE_MAX = 30;
const DESCRIPTION_MAX = 300;
const PLACEHOLDER_ID = "_";

export type ListFlowOption = Pick<ChoiceOption, "sku" | "name" | "unitPrice"> &
  Partial<Pick<ChoiceOption, "storeLabel" | "delivery" | "medicine" | "freeShipping">>;

export type ListFlowSlotInput = {
  lineKey: string;
  // Nome do item como o cliente o chama ("vodka"); a quantidade vem em `qty`.
  label: string;
  qty: number;
  options: ListFlowOption[];
  // Sugestão da Lia (já na cesta). Null/ausente = sem pré-seleção ("escolha uma").
  suggestedSku?: string | null;
  closestFalta?: string;
};

export type ListFlowMiss = { query: string; reason?: string };

export type ListFlowSentSlot = {
  lineKey: string;
  // Só os produtos (sem "skip"), na ordem enviada; é contra isto que a resposta é validada.
  skus: string[];
  suggestedSku: string | null;
};

export type BuildListFlowInput = {
  listaId: string;
  slots: ListFlowSlotInput[];
  misses?: ListFlowMiss[];
  // Texto pronto do bloco "não achei" (lia-copy); sem ele, uma linha simples a partir de `misses`.
  faltasTexto?: string;
  cabecalho?: string;
  // sku → miniatura JPEG em base64 (flow-thumbs.ts).
  thumbs?: Map<string, string>;
  imageBudgetBytes?: number;
};

export type BuiltListFlow = {
  data: Record<string, WhatsAppFlowDataValue>;
  slots: ListFlowSentSlot[];
  // Linhas além das 15 vagas: o cérebro as mantém pela sugestão, editável por texto.
  overflow: ListFlowSlotInput[];
  imageBytes: number;
  payloadBytes: number;
};

const DEFAULT_HEADER = "Escolha uma opção em cada item. A sugestão da Lia já vem marcada.";

function brl(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  const base = atWord >= Math.floor(max * 0.5) ? cut.slice(0, atWord) : cut;
  return `${base.replace(/[\s,.\-–·]+$/, "")}…`;
}

const SIZE_TOKEN = /\b\d+(?:[.,]\d+)?\s?(?:ml|l|lt|g|gr|kg|mg|un|und|unid|cm|m)\b/i;

// Título ≤ 30. Nome longo corta no limite de palavra, mas o tamanho ("998ml") sobrevive
// no fim — é o que diferencia as opções de um mesmo produto.
export function shortOptionTitle(name: string, max = TITLE_MAX): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const size = SIZE_TOKEN.exec(clean)?.[0].replace(/\s+/g, "");
  if (size && size.length + 4 < max) {
    const head = clean.replace(SIZE_TOKEN, "").replace(/\s+/g, " ").trim();
    const room = max - size.length - 1;
    return `${ellipsize(head, room)} ${size}`;
  }
  return ellipsize(clean, max);
}

// Rótulo da vaga ≤ 30: "Vodka · 2x", e " · escolha uma" quando não há sugestão.
function slotLabel(label: string, qty: number, needsPick: boolean): string {
  const suffix = `${qty > 1 ? ` · ${qty}x` : ""}${needsPick ? " · escolha uma" : ""}`;
  const base = label.replace(/\s+/g, " ").trim() || "Item";
  const room = Math.max(6, LABEL_MAX - suffix.length);
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1);
  return `${ellipsize(capitalized, room)}${suffix}`.slice(0, LABEL_MAX);
}

function optionDescription(option: ListFlowOption, price: number, qty: number, truncated: boolean): string {
  const when = option.delivery ? compactCardDelivery(option.delivery) : "";
  const parts = [qty > 1 ? `${brl(price)} cada` : brl(price), option.storeLabel?.trim(), when].filter(Boolean);
  const line = parts.join(" · ");
  return (truncated ? `${line} — ${option.name.replace(/\s+/g, " ").trim()}` : line).slice(0, DESCRIPTION_MAX);
}

type FlowOptionRow = { id: string; title: string; description?: string; image?: string; "alt-text"?: string };

function faltasFrom(input: BuildListFlowInput): string {
  if (input.faltasTexto?.trim()) return input.faltasTexto.trim();
  const queries = (input.misses ?? []).map((m) => m.query.trim()).filter(Boolean);
  return queries.length ? `Não achei: ${queries.join(", ")}` : "";
}

// Corta miniaturas até caber no orçamento: primeiro as das opções NÃO sugeridas (da última
// vaga para a primeira), depois as das sugeridas.
function applyImageBudget(rows: FlowOptionRow[][], suggested: Array<string | null>, budget: number): number {
  const size = (r: FlowOptionRow) => r.image?.length ?? 0;
  let total = rows.reduce((sum, slot) => sum + slot.reduce((s, r) => s + size(r), 0), 0);
  for (const pass of ["others", "suggested"] as const) {
    for (let i = rows.length - 1; i >= 0 && total > budget; i--) {
      for (let j = rows[i].length - 1; j >= 0 && total > budget; j--) {
        const row = rows[i][j];
        const isSuggested = row.id === suggested[i];
        if (!row.image || (pass === "others") === isSuggested) continue;
        total -= size(row);
        delete row.image;
        delete row["alt-text"];
      }
    }
  }
  return total;
}

export function buildListFlowData(
  input: BuildListFlowInput,
  display: (unitPrice: number, option?: ListFlowOption) => number
): BuiltListFlow {
  const usable = input.slots.filter((s) => s.options.length > 0);
  const sent = usable.slice(0, LIST_FLOW_MAX_SLOTS);
  const overflow = usable.slice(LIST_FLOW_MAX_SLOTS);

  const rows: FlowOptionRow[][] = [];
  const sentSlots: ListFlowSentSlot[] = [];
  const labels: string[] = [];
  const inits: string[] = [];

  for (const slot of sent) {
    const seen = new Set<string>();
    const unique = slot.options.filter((o) => (seen.has(o.sku) ? false : (seen.add(o.sku), true)));
    const suggested = slot.suggestedSku ? unique.find((o) => o.sku === slot.suggestedSku) : undefined;
    const ordered = [...(suggested ? [suggested] : []), ...unique.filter((o) => o !== suggested)].slice(0, LIST_FLOW_MAX_OPTIONS);
    const slotRows: FlowOptionRow[] = ordered.map((option) => {
      const title = shortOptionTitle(option.name);
      const row: FlowOptionRow = {
        id: option.sku,
        title,
        description: optionDescription(option, display(option.unitPrice, option), slot.qty, title !== option.name.trim())
      };
      const thumb = input.thumbs?.get(option.sku);
      if (thumb) {
        row.image = thumb;
        row["alt-text"] = title;
      }
      return row;
    });
    slotRows.push({ id: LIST_FLOW_SKIP_ID, title: LIST_FLOW_SKIP_TITLE });
    rows.push(slotRows);
    sentSlots.push({ lineKey: slot.lineKey, skus: ordered.map((o) => o.sku), suggestedSku: suggested?.sku ?? null });
    labels.push(slotLabel(slot.label, slot.qty, !suggested));
    inits.push(suggested?.sku ?? "");
  }

  const imageBytes = applyImageBudget(rows, sentSlots.map((s) => s.suggestedSku), input.imageBudgetBytes ?? LIST_FLOW_IMAGE_BUDGET);

  const faltas = faltasFrom(input);
  const data: Record<string, WhatsAppFlowDataValue> = {
    lista_id: input.listaId,
    cabecalho: input.cabecalho ?? DEFAULT_HEADER,
    faltas_texto: faltas || "-",
    faltas_visible: Boolean(faltas)
  };
  for (let i = 1; i <= LIST_FLOW_MAX_SLOTS; i++) {
    const used = i <= sent.length;
    data[`label_${i}`] = used ? labels[i - 1] : "-";
    data[`visible_${i}`] = used;
    data[`init_${i}`] = used ? inits[i - 1] : PLACEHOLDER_ID;
    data[`opts_${i}`] = used ? rows[i - 1] : [{ id: PLACEHOLDER_ID, title: "-" }];
  }
  return { data, slots: sentSlots, overflow, imageBytes, payloadBytes: Buffer.byteLength(JSON.stringify(data)) };
}

// ---------- resposta ----------

export function isListFlowReply(payload: Record<string, unknown> | null | undefined): payload is Record<string, unknown> {
  return Boolean(payload && typeof payload === "object" && typeof payload.lia_lista === "string" && payload.lia_lista);
}

export type ListFlowChoice =
  | { lineKey: string; kind: "keep" }
  | { lineKey: string; kind: "skip" }
  | { lineKey: string; kind: "pick"; sku: string };

// Por vaga, na ordem enviada: campo ausente/vazio, igual à sugestão ou com sku que não foi
// oferecido = mantém (nunca troca a cesta por um valor que a Lia não enviou).
export function parseListFlowReply(
  payload: Record<string, unknown>,
  slots: Array<{ lineKey: string; skus: string[]; suggestedSku?: string | null }>
): { listaId: string; choices: ListFlowChoice[] } {
  const choices = slots.map((slot, index): ListFlowChoice => {
    const raw = payload[`item_${index + 1}`];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === LIST_FLOW_SKIP_ID) return { lineKey: slot.lineKey, kind: "skip" };
    if (value && value !== slot.suggestedSku && slot.skus.includes(value)) return { lineKey: slot.lineKey, kind: "pick", sku: value };
    return { lineKey: slot.lineKey, kind: "keep" };
  });
  return { listaId: String(payload.lia_lista ?? ""), choices };
}
