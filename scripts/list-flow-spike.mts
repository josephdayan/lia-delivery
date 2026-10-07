// Protótipo do Flow "Escolher minha lista" (Etapa 0): roda uma lista pela busca existente,
// gera as miniaturas, monta o `data` e (com --send) manda o Flow para UM número de teste.
//
//   npx tsx scripts/list-flow-spike.mts                       # só mede e resume (sem envio)
//   npx tsx scripts/list-flow-spike.mts --list "2 vodkas, 3 sucos de laranja, gelo"
//   npx tsx scripts/list-flow-spike.mts --nosuggest 2          # vaga 2 sem sugestão (testa init-value vazio)
//   npx tsx scripts/list-flow-spike.mts --dump out.json        # grava o `data` completo
//   npx tsx scripts/list-flow-spike.mts --publish              # ensureListFlow() na Meta
//   npx tsx scripts/list-flow-spike.mts --send 5511999999999   # envia (precisa WHATSAPP_* no .env)
//
// --send e --publish falam com a Meta de verdade: só o dono roda. O talk-env trava o
// WHATSAPP_PROVIDER em "mock"; com --send/--publish o script o restaura para "meta".
import "./talk-env.mts";
import { writeFileSync } from "node:fs";
import { gatherCrossStoreCandidates } from "../src/lib/stores";
import { conciergeMatchIsStrong, diversifyOptions } from "../src/lib/stores/types";
import { displayPrice } from "../src/lib/pricing";
import { buildListFlowData, type ListFlowSlotInput } from "../src/lib/list-flow";
import { fetchThumbs } from "../src/lib/flow-thumbs";
import { LIST_FLOW_CTA, LIST_FLOW_SCREEN, activeListFlowId, ensureListFlow } from "../src/lib/meta-setup";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : "true";
};

const listFlag = flag("list");
const LIST = listFlag && listFlag !== "true" ? listFlag : "2 vodkas, 3 sucos de laranja, 3 red bull e gelo";
const noSuggest = Number(flag("nosuggest") ?? 0);

// Parser mínimo só do spike (o resolvedor de verdade é a Etapa 1).
function parseList(text: string): Array<{ qty: number; query: string }> {
  return text
    .split(/,|\se\s/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(\d+)\s*x?\s+(.+)$/i.exec(part);
      return m ? { qty: Number(m[1]), query: m[2] } : { qty: 1, query: part };
    });
}

const singular = (q: string) => q.replace(/\b(\w{4,})s\b/gi, "$1");

async function main() {
  if (flag("send") || flag("publish")) process.env.WHATSAPP_PROVIDER = "meta";
  if (flag("publish")) {
    console.log("ensureListFlow:", JSON.stringify(await ensureListFlow(), null, 2));
    return;
  }

  const slots: ListFlowSlotInput[] = [];
  const misses: Array<{ query: string; reason: string }> = [];
  for (const { qty, query } of parseList(LIST)) {
    const q = singular(query);
    const candidates = await gatherCrossStoreCandidates(q, 12).catch(() => []);
    const shown = diversifyOptions(q, candidates.map((c) => c.item), 4).filter((item) => conciergeMatchIsStrong(q, item));
    if (!shown.length) {
      misses.push({ query: q, reason: "sem_resultado" });
      continue;
    }
    const storeOf = (sku: string) => candidates.find((c) => c.item.sku === sku)?.store.label;
    const options = shown.map((item) => ({ sku: item.sku, name: item.name, unitPrice: item.unitPrice, imageUrl: item.imageUrl, storeLabel: storeOf(item.sku), delivery: "entrega hoje" }));
    slots.push({ lineKey: q, label: q, qty, options, suggestedSku: shown[0].sku });
  }
  if (noSuggest && slots[noSuggest - 1]) slots[noSuggest - 1].suggestedSku = null;

  const t0 = Date.now();
  const thumbs = await fetchThumbs(slots.flatMap((s) => s.options.map((o) => ({ sku: o.sku, imageUrl: (o as { imageUrl?: string }).imageUrl }))), { timeoutMs: 1500 });
  const thumbMs = Date.now() - t0;
  const built = buildListFlowData({ listaId: `spike-${Date.now().toString(36)}`, slots, misses, thumbs }, (price) => displayPrice(price));

  const optionCount = slots.reduce((n, s) => n + s.options.length, 0);
  console.log(`lista: ${LIST}`);
  console.log(`vagas: ${built.slots.length} (overflow ${built.overflow.length}) · faltantes: ${misses.map((m) => m.query).join(", ") || "-"}`);
  console.log(`opções: ${optionCount} · miniaturas: ${thumbs.size} em ${thumbMs} ms`);
  console.log(`imagens: ${built.imageBytes} bytes base64 · data total: ${built.payloadBytes} bytes (limite Meta: 1 MB)`);
  built.slots.forEach((s, i) => console.log(`  ${i + 1}. ${built.data[`label_${i + 1}`]} · init=${built.data[`init_${i + 1}`] || "(vazio)"} · ${s.skus.length} opções`));
  const dump = flag("dump");
  if (dump && dump !== "true") writeFileSync(dump, JSON.stringify(built.data, null, 2));

  const to = flag("send");
  if (!to || to === "true") return;
  const flowId = await activeListFlowId();
  if (!flowId) throw new Error("Flow da lista não publicado (rode --publish ou defina LIA_FLOW_LIST_ID)");
  const sent = await whatsappAdapter.sendFlowMessage(to, {
    body: "Montei sua lista. Toque abaixo para conferir e trocar o que quiser.",
    cta: LIST_FLOW_CTA,
    flowId,
    screen: LIST_FLOW_SCREEN,
    data: built.data,
    token: String(built.data.lista_id)
  });
  console.log("enviado:", JSON.stringify(sent).slice(0, 300));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
