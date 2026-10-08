import { storesForShopper } from "../store-areas";
import type { CatalogItem, StoreConnector, StoreUnit } from "./types";
import { conciergeMatchIsStrong, queryAliases, rankCatalog, sameProductVariant, scoreCatalogMatch, variantCount } from "./types";
import { liveSearchByCategory, liveSearchEnabled, liveSearchItems, mergeLiveWithSnapshot } from "./live-search";
import { isMedicine } from "./anvisa";
import type { ShelfNode, ShelfPick } from "../recommend/types";
import { storeServesCep } from "../store-areas";
import { medicineEnabled, medicineEquivalentFor } from "../medicine";
import { VTEX_API_STORES } from "../purchase/vtex-checkout";
import { petzStore } from "./petz";
import { boticarioStore } from "./boticario";
import { obaStore } from "./oba";
import { carrefourStore } from "./carrefour";
import { decathlonStore } from "./decathlon";
import { swiftStore } from "./swift";
import { mamboStore } from "./mambo";
import { americanasStore } from "./americanas";
import { prezunicStore } from "./prezunic";
import { zonasulStore } from "./zonasul";
import { covabraStore } from "./covabra";
import { savegnagoStore } from "./savegnago";
import { wepinkStore } from "./wepink";
import { underarmourStore } from "./underarmour";
import { tokstokStore } from "./tokstok";
import { pbkidsStore } from "./pbkids";
import { osklenStore } from "./osklen";
import { motorolaStore } from "./motorola";
import { livrariascuritibaStore } from "./livrariascuritiba";
import { filaStore } from "./fila";
import { farmaciaindianaStore } from "./farmaciaindiana";
import { extrafarmaStore } from "./extrafarma";
import { drogariaspachecoStore } from "./drogariaspacheco";
import { drogariacatarinenseStore } from "./drogariacatarinense";
import { santaluziaStore } from "./santaluzia";
import { ceaStore } from "./cea";
import { capodarteStore } from "./capodarte";
import { aramisStore } from "./aramis";
import { epocacosmeticosStore } from "./epocacosmeticos";
import { drogalStore } from "./drogal";
import { martinsfontesStore } from "./martinsfontes";
import { brinoxStore } from "./brinox";
import { creamyStore } from "./creamy";
import { casaevideoStore } from "./casaevideo";
import { telhanorteStore } from "./telhanorte";
import { zonacriativaStore } from "./zonacriativa";
import { philcoStore } from "./philco";
import { mondialStore } from "./mondial";
import { oxfordStore } from "./oxford";
import { polishopStore } from "./polishop";
import { obramaxStore } from "./obramax";
import { kalungaStore } from "./kalunga";
import { rihappyStore } from "./rihappy";
import { cacauShowStore } from "./cacaushow";
import { kopenhagenStore } from "./kopenhagen";
import { drogaRaiaStore } from "./drogaraia";
import { drogariaSpStore } from "./drogariasp";
import { pagueMenosStore } from "./paguemenos";
import { divvinoStore } from "./divvino";
import { imigrantesStore } from "./imigrantes";
import { naturalDaTerraStore } from "./naturaldaterra";
import { cobasiStore } from "./cobasi";
import { giulianaFloresStore } from "./giulianaflores";
import { mercadoLivreEnabled, mercadoLivreStore, prefetchMercadoLivre } from "./mercadolivre";

// Store registry. Adding a supply source = write one connector file and register it
// here (e.g. farmácia for higiene/beleza depth, Petz/Cobasi for pet). Nothing else
// in the system needs to change — the chat flow and operator dashboard are
// store-agnostic.
// 25/09/2026 — decisão do dono: a Lia opera SEM operador. Só fica ligada por padrão a loja
// que fecha pedido por API (checkout VTEX aberto + Pix, provado ou sondado no endereço do
// dono): Drogaria SP, Cobasi, Pague Menos, Swift, Kopenhagen, Ri Happy. As demais viraram
// opt-in (LIA_ENABLE_X=true) e ficam fora até fecharem sem humano: Carrefour e Petz
// (barram o servidor), Boticário e Droga Raia (403), Oba e Divvino (sem Pix), Imigrantes,
// Giuliana Flores, Decathlon, Kalunga, Cacau Show (não são VTEX abertas), Natural da Terra
// (sem entrega no endereço de sondagem). Mercado Livre continua como estava (decisão pendente).
const STORES: Record<string, StoreConnector> = {
  // Carrefour is the broadest vitrine (hipermercado, 1.094 seed items with real deep
  // links). Checkout automation stays OFF (the retailer blocked it on 19/07); in the
  // concierge product the operator buys by hand and the operator quote is the price
  // authority, so the seed serves as reference vitrine only.
  ...(process.env.LIA_ENABLE_CARREFOUR === "true" ? { [carrefourStore.key]: carrefourStore } : {}),
  // Oba is the groceries/essentials source. Catálogo colhido da API pública VTEX.
  ...(process.env.LIA_ENABLE_OBA === "true" ? { [obaStore.key]: obaStore } : {}),
  // Petz is the pet vertical. Delivery is by the retailer; no courier pickup is used.
  ...(process.env.LIA_ENABLE_PETZ === "true" ? { [petzStore.key]: petzStore } : {}),
  // Boticário is the beauty vertical. Seed colhido; recolheita é manual (anti-bot).
  ...(process.env.LIA_ENABLE_BOTICARIO === "true" ? { [boticarioStore.key]: boticarioStore } : {}),
  // Decathlon: sports vitrine (small real seed; concierge/operator fulfills).
  ...(process.env.LIA_ENABLE_DECATHLON === "true" ? { [decathlonStore.key]: decathlonStore } : {}),
  // Concierge vitrines added 2026-07-23 (real seeds harvested from each store's public
  // site; the operator buys by hand and the quote is the price authority).
  ...(process.env.LIA_ENABLE_SWIFT !== "false" ? { [swiftStore.key]: swiftStore } : {}),
  ...(process.env.LIA_ENABLE_KALUNGA === "true" ? { [kalungaStore.key]: kalungaStore } : {}),
  ...(process.env.LIA_ENABLE_RIHAPPY !== "false" ? { [rihappyStore.key]: rihappyStore } : {}),
  ...(process.env.LIA_ENABLE_CACAUSHOW === "true" ? { [cacauShowStore.key]: cacauShowStore } : {}),
  ...(process.env.LIA_ENABLE_KOPENHAGEN !== "false" ? { [kopenhagenStore.key]: kopenhagenStore } : {}), // religada 29/09: fecha com telefone no perfil
  ...(process.env.LIA_ENABLE_DROGARAIA === "true" ? { [drogaRaiaStore.key]: drogaRaiaStore } : {}),
  // Vitrines adicionadas em 2026-08-02 para fechar as lacunas de demanda mapeadas
  // (farmácia não-remédio, bebidas, hortifruti, flores/presente e redundância de pet).
  // Farmácia: catálogo restrito por allowlist de categoria + deny-regex de medicamento.
  ...(process.env.LIA_ENABLE_DROGARIASP !== "false" ? { [drogariaSpStore.key]: drogariaSpStore } : {}),
  ...(process.env.LIA_ENABLE_PAGUEMENOS !== "false" ? { [pagueMenosStore.key]: pagueMenosStore } : {}),
  ...(process.env.LIA_ENABLE_DIVVINO === "true" ? { [divvinoStore.key]: divvinoStore } : {}),
  ...(process.env.LIA_ENABLE_IMIGRANTES === "true" ? { [imigrantesStore.key]: imigrantesStore } : {}),
  ...(process.env.LIA_ENABLE_NATURALDATERRA === "true" ? { [naturalDaTerraStore.key]: naturalDaTerraStore } : {}),
  ...(process.env.LIA_ENABLE_COBASI !== "false" ? { [cobasiStore.key]: cobasiStore } : {}),
  ...(process.env.LIA_ENABLE_GIULIANAFLORES === "true" ? { [giulianaFloresStore.key]: giulianaFloresStore } : {}),
  // 25/09/2026: lojas somadas pela varredura de checkout VTEX aberto (compra por API no servidor).
  ...(process.env.LIA_ENABLE_MAMBO !== "false" ? { [mamboStore.key]: mamboStore } : {}),
  // 28/09/2026: Americanas fechou por API (Pix Stark Infra); mínimo R$30, entrega 2h na capital.
  ...(process.env.LIA_ENABLE_AMERICANAS !== "false" ? { [americanasStore.key]: americanasStore } : {}),
  // 06/10/2026: mercados do Rio (expansão RJ). Só aparecem para CEP do Rio (store-areas.ts).
  // Zona Sul (grupo 1666863616742) e Prezunic (PZ2456030, carrinho mínimo R$80) fecharam pedido
  // real por API em Copacabana com Pix obtido: ligados.
  ...(process.env.LIA_ENABLE_PREZUNIC !== "false" ? { [prezunicStore.key]: prezunicStore } : {}),
  ...(process.env.LIA_ENABLE_ZONASUL !== "false" ? { [zonasulStore.key]: zonasulStore } : {}),
  ...(process.env.LIA_ENABLE_COVABRA !== "false" ? { [covabraStore.key]: covabraStore } : {}),
  ...(process.env.LIA_ENABLE_SAVEGNAGO !== "false" ? { [savegnagoStore.key]: savegnagoStore } : {}),
  ...(process.env.LIA_ENABLE_WEPINK !== "false" ? { [wepinkStore.key]: wepinkStore } : {}),
  ...(process.env.LIA_ENABLE_UNDERARMOUR !== "false" ? { [underarmourStore.key]: underarmourStore } : {}),
  ...(process.env.LIA_ENABLE_TOKSTOK !== "false" ? { [tokstokStore.key]: tokstokStore } : {}),
  ...(process.env.LIA_ENABLE_PBKIDS !== "false" ? { [pbkidsStore.key]: pbkidsStore } : {}),
  ...(process.env.LIA_ENABLE_OSKLEN !== "false" ? { [osklenStore.key]: osklenStore } : {}),
  ...(process.env.LIA_ENABLE_MOTOROLA !== "false" ? { [motorolaStore.key]: motorolaStore } : {}),
  ...(process.env.LIA_ENABLE_LIVRARIASCURITIBA !== "false" ? { [livrariascuritibaStore.key]: livrariascuritibaStore } : {}),
  ...(process.env.LIA_ENABLE_FILA !== "false" ? { [filaStore.key]: filaStore } : {}),
  ...(process.env.LIA_ENABLE_FARMACIAINDIANA !== "false" ? { [farmaciaindianaStore.key]: farmaciaindianaStore } : {}),
  ...(process.env.LIA_ENABLE_EXTRAFARMA !== "false" ? { [extrafarmaStore.key]: extrafarmaStore } : {}),
  ...(process.env.LIA_ENABLE_DROGARIASPACHECO !== "false" ? { [drogariaspachecoStore.key]: drogariaspachecoStore } : {}),
  ...(process.env.LIA_ENABLE_DROGARIACATARINENSE !== "false" ? { [drogariacatarinenseStore.key]: drogariacatarinenseStore } : {}),
  ...(process.env.LIA_ENABLE_SANTALUZIA !== "false" ? { [santaluziaStore.key]: santaluziaStore } : {}),
  ...(process.env.LIA_ENABLE_CEA !== "false" ? { [ceaStore.key]: ceaStore } : {}),
  ...(process.env.LIA_ENABLE_CAPODARTE !== "false" ? { [capodarteStore.key]: capodarteStore } : {}),
  ...(process.env.LIA_ENABLE_ARAMIS !== "false" ? { [aramisStore.key]: aramisStore } : {}),
  ...(process.env.LIA_ENABLE_EPOCACOSMETICOS !== "false" ? { [epocacosmeticosStore.key]: epocacosmeticosStore } : {}), // religada 29/09: fecha com telefone no perfil
  ...(process.env.LIA_ENABLE_DROGAL !== "false" ? { [drogalStore.key]: drogalStore } : {}),
  // 27/09/2026: livros, casa, construção, presentes e skincare — fora de farmácia/mercado.
  // 28–29/09: teste de Pix loja a loja. Martins Fontes e Mondial recusam criar o pedido (ORD062
  // "Acesso negado", provável login obrigatório): DESLIGADAS. Sete lojas recusavam o Pix (CHK0223)
  // só porque o perfil de convidado ia sem telefone; com telefone fecham: religadas em 29/09.
  ...(process.env.LIA_ENABLE_MARTINSFONTES === "true" ? { [martinsfontesStore.key]: martinsfontesStore } : {}), // DESLIGADA 28/09: fechamento por API falhou
  ...(process.env.LIA_ENABLE_BRINOX !== "false" ? { [brinoxStore.key]: brinoxStore } : {}),
  ...(process.env.LIA_ENABLE_CREAMY !== "false" ? { [creamyStore.key]: creamyStore } : {}),
  ...(process.env.LIA_ENABLE_CASAEVIDEO !== "false" ? { [casaevideoStore.key]: casaevideoStore } : {}), // religada 29/09: fecha com telefone no perfil
  ...(process.env.LIA_ENABLE_TELHANORTE !== "false" ? { [telhanorteStore.key]: telhanorteStore } : {}), // religada 29/09: fecha com telefone no perfil
  ...(process.env.LIA_ENABLE_ZONACRIATIVA !== "false" ? { [zonacriativaStore.key]: zonacriativaStore } : {}), // religada 29/09: fecha com telefone no perfil
  // 27/09 (2ª leva): eletro e casa — Philco, Mondial, Oxford, Polishop, Obramax.
  ...(process.env.LIA_ENABLE_PHILCO !== "false" ? { [philcoStore.key]: philcoStore } : {}),
  ...(process.env.LIA_ENABLE_MONDIAL === "true" ? { [mondialStore.key]: mondialStore } : {}), // DESLIGADA 28/09: fechamento por API falhou
  ...(process.env.LIA_ENABLE_OXFORD !== "false" ? { [oxfordStore.key]: oxfordStore } : {}),
  ...(process.env.LIA_ENABLE_POLISHOP !== "false" ? { [polishopStore.key]: polishopStore } : {}), // religada 29/09: fecha com telefone no perfil
  ...(process.env.LIA_ENABLE_OBRAMAX !== "false" ? { [obramaxStore.key]: obramaxStore } : {}), // religada 29/09: fecha com telefone no perfil
  // Mercado Livre: vitrine de CAUDA LONGA, ao vivo (decisão do dono 16/08). Fica por
  // ÚLTIMO no registry de propósito: as lojas locais decidem o "hoje"; o ML entra pra
  // resolver o que ninguém tem. Desligado por padrão — LIA_ENABLE_MERCADOLIVRE=true.
  ...(mercadoLivreEnabled() ? { [mercadoLivreStore.key]: mercadoLivreStore } : {}),
};

// Pick the single store for an order (one order = one store, one retailer delivery). For each
// item query, the store whose best match scores highest "wins" that query (so a
// pet-specific item like "ração premier" goes to Petz instead of the broader Oba);
// the store winning the most queries gets the order. Ties go to the default grocery store.
// Dicas de vertical pra desempate do roteador: "base"/"perfume" empatando entre
// Oba e Boticário devem ir pra loja de beleza; "ração" empatada vai pra Petz.
const BEAUTY_HINT_RE = /\b(perfume|colonia|maquiagem|batom|base|rimel|gloss|hidratante|corretivo|blush|serum)\b/;
const PET_HINT_RE = /\b(racao|petisco|cachorro|gato|caes|pet|aquario|areia (de|pro|para) gato)\b/;
// Verticais novas (02/08): sem estas dicas, "vinho" e "buque" empatam com a vitrine larga
// (Carrefour) e o pedido vai para a loja errada — mesmo bug que "ração" tinha em 23/07.
const DRINK_HINT_RE = /\b(vinho|cerveja|whisky|whiskey|vodka|gin|cachaca|espumante|champagne|champanhe|licor|rum|tequila|destilado|chopp|heineken|budweiser|corona|brahma|skol)\b/;
const FLOWER_HINT_RE = /\b(flor|flores|buque|buques|rosa|rosas|girassol|girassois|orquidea|orquideas|lirio|lirios|arranjo|floricultura|ramalhete)\b/;

export async function pickStoreForQueries(queries: string[]): Promise<StoreConnector> {
  // Mercado Livre is a manual-concierge long-tail fallback, never the locked store
  // for the legacy one-store/automated flow.
  const stores = storesForShopper(listStores()).filter((store) => store.key !== mercadoLivreStore.key);
  if (stores.length <= 1 || queries.length === 0) return stores[0] ?? getStore();
  const wins = new Map<string, number>(stores.map((s) => [s.key, 0]));
  for (const q of queries) {
    // Accent-stripped so the vocation hints match "ração"/"coração de gato" etc.; the
    // regexes are written without accents. Without this, a broad store (Carrefour) wins
    // pet/beauty ties because the +hint never fired.
    const qHint = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    let winner: StoreConnector | null = null;
    let bestScore = 0;
    for (const store of stores) {
      const top = (await store.searchItems(q, 1))[0];
      let score = top ? scoreCatalogMatch(q, top) : 0;
      if (score > 0) {
        // desempate por vocação da loja (peso 2 para vencer o empate com folga)
        if (store.key === "boticario" && BEAUTY_HINT_RE.test(qHint)) score += 2;
        if (store.key === "petz" && PET_HINT_RE.test(qHint)) score += 2;
        if ((store.key === "divvino" || store.key === "imigrantes") && DRINK_HINT_RE.test(qHint)) score += 2;
        if (store.key === "giulianaflores" && FLOWER_HINT_RE.test(qHint)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        winner = store;
      }
    }
    if (winner) wins.set(winner.key, (wins.get(winner.key) ?? 0) + 1);
  }
  let best = stores[0];
  let bestWins = -1;
  for (const store of stores) {
    const w = wins.get(store.key) ?? 0;
    if (w > bestWins) {
      bestWins = w;
      best = store;
    }
  }
  return best;
}

// Broadest vitrine wins ties and fallbacks. (The DeliveryOrder DB column default is
// "oba" from the 19/07 migration; code paths always set storeKey explicitly, so the
// two defaults never conflict in practice.)
export const DEFAULT_STORE_KEY = carrefourStore.key;

export function getStore(key?: string | null): StoreConnector {
  // Fall back through the requested key → configured default → first enabled store, so a
  // disabled default (e.g. LIA_ENABLE_CARREFOUR=false) never yields undefined.
  return STORES[key ?? DEFAULT_STORE_KEY] ?? STORES[DEFAULT_STORE_KEY] ?? Object.values(STORES)[0];
}

export function listStores(): StoreConnector[] {
  return Object.values(STORES);
}

// Search EVERY registered store and tag each hit with the store that carries it.
// This is the foundation of the "qualquer coisa, de qualquer loja, num WhatsApp só"
// moat — the three active verticals spread automatically through this registry.
// Cópia do catálogo + prateleira ao vivo da loja (live-search.ts), em paralelo. Sem ao vivo
// (desligado, loja não-VTEX, falha/timeout) o resultado é exatamente o da cópia, como antes.
async function searchStoreItems(store: StoreConnector, query: string, limitPerStore: number): Promise<CatalogItem[]> {
  const wantLive = liveSearchEnabled() && Boolean(VTEX_API_STORES[store.key]);
  const [snapshot, live] = await Promise.all([
    store.searchItems(query, limitPerStore),
    wantLive ? liveSearchItems(store.key, query, Math.max(12, limitPerStore * 3)) : Promise.resolve([] as CatalogItem[])
  ]);
  if (!live.length) return snapshot;
  const pool = mergeLiveWithSnapshot(store.key, snapshot, live);
  return rankCatalog(query, pool, limitPerStore);
}

async function searchSelectedStores(stores: StoreConnector[], query: string, limitPerStore: number) {
  const perStore = await Promise.all(
    stores.map(async (store) => {
      const items = await searchStoreItems(store, query, limitPerStore);
      return items.map((item) => ({ store, item }));
    })
  );
  return perStore.flat();
}

export async function searchAcrossStores(query: string, limitPerStore = 4) {
  return searchSelectedStores(storesForShopper(listStores()), query, limitPerStore);
}

function rankStoreCandidates(query: string, hits: StoreCandidate[]): StoreCandidate[] {
  return hits
    .map((hit) => ({ hit, score: scoreCatalogMatch(query, hit.item) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        variantCount(query, a.hit.item) - variantCount(query, b.hit.item) ||
        a.hit.item.unitPrice - b.hit.item.unitPrice
    )
    .map((entry) => entry.hit);
}

export function needsLongTailSearch(query: string, localCandidates: StoreCandidate[]): boolean {
  return !localCandidates.some((candidate) => conciergeMatchIsStrong(query, candidate.item));
}

// Larga a busca fria do ML ANTES da extração de IA, quando o parser determinístico já
// mostra que a linha vai precisar de cauda longa. A busca local é em memória (ms), então
// o palpite custa quase nada; o run do actor (~21s) roda em paralelo com a IA e o
// `searchItems` de verdade se acopla ao MESMO run (dedupe em voo no conector). Se a IA
// reescrever a frase, o prefetch se perde — aceitável: a frase determinística e a da IA
// coincidem na maioria dos casos.
export async function prefetchLongTailIfNeeded(query: string): Promise<void> {
  if (!mercadoLivreEnabled()) return;
  const localStores = storesForShopper(listStores()).filter((store) => store.key !== mercadoLivreStore.key);
  const localHits = await searchSelectedStores(localStores, query, 4);
  if (needsLongTailSearch(query, rankStoreCandidates(query, localHits))) prefetchMercadoLivre(query);
}

// Candidatos LARGOS para uma linha do pedido, vindos de TODAS as vitrines. Existe
// porque eleger uma loja única por palpite léxico esconde o item certo: no empate, a
// ordem do registry decidia — foi assim que "carregador usb c" caiu na Petz (3
// veiculares) com o carregador de parede USB-C parado na Pague Menos. Quem decide o
// que aparece é a camada de cima (rerank semântico; fallback = este ranking global).
export type StoreCandidate = { store: StoreConnector; item: CatalogItem };
// Cauda longa AUTOMÁTICA (dono, 07/09: "não tem que perguntar se ele quer no Mercado
// Livre, só tem pesquisar"): quando nenhuma vitrine local passa no piso de relevância (e,
// no resgate, quando o rerank da IA descartou tudo), o Mercado Livre entra na mesma
// busca, sem pergunta. `LIA_LONGTAIL_OPTIN=true` volta ao modo de 02/09, em que o ML só
// rodava depois de um "sim" (mantido como kill-switch de custo; os testes da oferta o usam).
export function longTailOptInEnabled(): boolean {
  return process.env.LIA_LONGTAIL_OPTIN === "true";
}

export async function gatherCrossStoreCandidates(
  query: string,
  limit = 12,
  perStore = 4,
  // `longTailQuery`: frase COMPLETA do cliente para o ML quando a IA encurtou a linha
  // ("isqueiro pra charuto" → "isqueiro"); as vitrines locais continuam com a frase curta.
  // `noLongTail` (08/10, recomendação): o Mercado Livre nem entra — recomendação só mostra o que a
  // Lia compra sozinha. `onlyStores`: restringe a busca a essas lojas (prateleira do mapa).
  options?: { onLongTailSearch?: () => void; forceLongTail?: boolean; longTailQuery?: string; noLongTail?: boolean; onlyStores?: readonly string[] }
): Promise<StoreCandidate[]> {
  // Loja regional fora da área do cliente (mercado do Rio para quem está em SP) nem entra
  // na busca: não ocupa vaga de candidato e não aparece em nenhum caminho (store-areas.ts).
  const allowed = options?.onlyStores?.length ? new Set(options.onlyStores) : null;
  const stores = storesForShopper(listStores()).filter(
    (store) => (!allowed || allowed.has(store.key)) && !(options?.noLongTail && store.key === mercadoLivreStore.key)
  );
  const longTail = options?.noLongTail ? undefined : stores.find((store) => store.key === mercadoLivreStore.key);
  const localStores = stores.filter((store) => store.key !== mercadoLivreStore.key);
  const localHits = await searchSelectedStores(localStores, query, perStore);
  let localRanked = rankStoreCandidates(query, localHits);
  // Nome equivalente do mesmo produto (06/10, A9: "sabão em pó" ↔ "lava roupas em pó",
  // "xampu" ↔ "shampoo"): cada frase é ranqueada por ela mesma; a equivalente vem primeiro
  // porque é o nome do catálogo (o rerank julga as duas juntas).
  for (const alias of queryAliases(query)) {
    const aliasRanked = rankStoreCandidates(alias, await searchSelectedStores(localStores, alias, perStore));
    const seen = new Set(aliasRanked.map((c) => `${c.store.key}:${c.item.sku}`));
    localRanked = [...aliasRanked, ...localRanked.filter((c) => !seen.has(`${c.store.key}:${c.item.sku}`))];
  }
  // Remédio (dono, 08/10): marca ↔ genérico de MESMO princípio ativo entram como RESERVA, no fim
  // da lista (até 3 vagas), para a vitrine oferecer "o mais perto" quando a marca pedida falta.
  // Não disputam as vagas do pedido em si e só valem para item isento (medicine: "mip").
  const equivalents: StoreCandidate[] = [];
  const equivalent = medicineEnabled() ? medicineEquivalentFor(query) : null;
  if (equivalent) {
    const have = new Set(localRanked.map((c) => `${c.store.key}:${c.item.sku}`));
    const perQuery = await Promise.all(equivalent.queries.map(async (eqQuery) => rankStoreCandidates(eqQuery, await searchSelectedStores(localStores, eqQuery, perStore))));
    for (const c of perQuery.flat()) {
      const key = `${c.store.key}:${c.item.sku}`;
      if (have.has(key) || c.item.medicine !== "mip" || !equivalent.matches(c.item.name)) continue;
      have.add(key);
      equivalents.push(c);
    }
  }

  // The ML actor is slow and paid. It only runs when no local candidate clears the
  // concierge relevance floor; registry order alone would still await it through
  // Promise.all on every everyday query.
  // `forceLongTail`: a linha JÁ falhou no pipeline completo (piso/rerank descartaram
  // tudo) e o cliente ia ouvir "não tenho". Aí o ML entra mesmo havendo match local
  // "forte" — caso real 17/08: "violão" casava com "Brinquedo Musical Violão Patrulha
  // Canina" (Ri Happy), o gate achava que a busca local resolveu, o rerank descartava o
  // brinquedo com razão e o cliente ficava sem violão nenhum.
  let ranked = localRanked;
  if (longTail && (options?.forceLongTail || (!longTailOptInEnabled() && needsLongTailSearch(query, localRanked)))) {
    options?.onLongTailSearch?.();
    const longTailHits = await searchSelectedStores([longTail], options?.longTailQuery ?? query, perStore);
    ranked = rankStoreCandidates(query, [...localHits, ...longTailHits]);
  }
  // Variantes do mesmo produto (cada loja manda seu top-4, que costuma ser a mesma
  // ração em 4 tamanhos) não podem esgotar as vagas: produtos DISTINTOS ocupam as
  // vagas primeiro e as variantes só preenchem o que sobrar — senão nem o rerank de
  // IA consegue diversificar, porque os 12 candidatos já chegam quase iguais.
  const distinct: StoreCandidate[] = [];
  const variants: StoreCandidate[] = [];
  for (const cand of ranked) {
    (distinct.some((d) => sameProductVariant(query, d.item, cand.item)) ? variants : distinct).push(cand);
  }
  const main = [...distinct, ...variants];
  if (!equivalents.length) return main.slice(0, limit);
  const keep = Math.min(2, equivalents.length);
  return [...main.slice(0, Math.max(0, limit - keep)), ...equivalents.slice(0, keep)];
}

// ---------- Busca por PRATELEIRA (08/10/2026, plano de recomendação, etapa BUSCAR) ----------
// Uma prateleira do mapa vira candidatos comprávei no CEP: a união de VÁRIAS consultas (a da pick,
// com alternativas separadas por " | ", depois a consulta e os aliases da prateleira) mais, onde o
// mapa tem `categoryPaths`, a prateleira inteira da loja pela busca de categoria da VTEX. Cada
// consulta passa pelo mesmo funil da lista de itens (`gatherCrossStoreCandidates`: cópia + ao vivo
// + equivalentes). Regras duras:
// - Mercado Livre nunca roda aqui: recomendação só mostra o que a Lia compra sozinha;
// - remédio: prateleira `mip` só aceita item `medicine: "mip"` (porta do remédio isento); qualquer
//   outra prateleira (inclusive pick sem prateleira conhecida) nunca devolve remédio;
// - sem duplicata (`loja:sku`), ordem = pick.query, depois aliases, depois a prateleira inteira.
const SHELF_MAX_QUERIES = 6;
const SHELF_CATEGORY_RESERVE = 4;
const normShelf = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

export function shelfQueryAlternatives(query: string): string[] {
  const seen = new Set<string>();
  return query
    .split("|")
    .map((part) => part.trim())
    .filter((part) => {
      const key = normShelf(part);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// A consulta da prateleira já está contida em alguma alternativa da pick (todas as palavras)?
function shelfTermCovered(term: string, alternatives: string[]): boolean {
  const words = normShelf(term).split(" ").filter(Boolean);
  return alternatives.some((alt) => {
    const altWords = new Set(normShelf(alt).split(" "));
    return words.every((word) => altWords.has(word));
  });
}

export async function gatherShelfCandidates(
  pick: ShelfPick,
  shelf: ShelfNode | undefined,
  opts: { limit?: number; perStore?: number; cep?: string | null } = {}
): Promise<StoreCandidate[]> {
  const limit = opts.limit ?? 12;
  const perStore = opts.perStore ?? 4;
  const mip = Boolean(shelf?.flags?.includes("mip"));
  if (mip && !medicineEnabled()) return []; // remédio isento desligado: nada de remédio, nem pela porta

  const cepDigits = (opts.cep ?? "").replace(/\D/g, "");
  const shelfStores = shelf?.stores?.length ? shelf.stores.filter((key) => key !== mercadoLivreStore.key) : undefined;
  const storeOk = (key: string) => key !== mercadoLivreStore.key && (!cepDigits || storeServesCep(key, cepDigits)) && (!shelfStores || shelfStores.includes(key));
  // Lojas da busca: as da prateleira (ou todas) que entregam no CEP. Lista vazia = nada a buscar.
  const searchKeys = shelfStores ? shelfStores.filter(storeOk) : cepDigits ? listStores().map((store) => store.key).filter(storeOk) : undefined;
  if (searchKeys && !searchKeys.length) return [];
  const gather = (query: string) => gatherCrossStoreCandidates(query, Math.max(limit, 12), perStore, { noLongTail: true, onlyStores: searchKeys });
  const accept = (candidate: StoreCandidate) =>
    storeOk(candidate.store.key) &&
    (mip ? candidate.item.medicine === "mip" : !candidate.item.medicine && !isMedicine(candidate.item));

  const alternatives = shelfQueryAlternatives(pick.query);
  if (!alternatives.length && shelf?.query) alternatives.push(shelf.query);
  const shelfTerms = shelf ? [shelf.query, ...(shelf.aliases ?? [])] : [];
  const extraTerms = shelfTerms.filter((term, index) => term.trim() && shelfTerms.findIndex((other) => normShelf(other) === normShelf(term)) === index && !shelfTermCovered(term, alternatives));
  const primary = alternatives.slice(0, SHELF_MAX_QUERIES);

  const seen = new Set<string>();
  const merged: StoreCandidate[] = [];
  const push = (list: StoreCandidate[]) => {
    for (const candidate of list) {
      const key = `${candidate.store.key}:${candidate.item.sku}`;
      if (seen.has(key) || !accept(candidate)) continue;
      seen.add(key);
      merged.push(candidate);
    }
  };

  // Prateleira inteira pela categoria da loja (só ao vivo; sem caminho no mapa = só texto).
  const categoryTask = (async () => {
    const paths = Object.entries(shelf?.categoryPaths ?? {}).filter(([key, path]) => path && storeOk(key) && key !== mercadoLivreStore.key);
    if (!paths.length || !liveSearchEnabled()) return [] as StoreCandidate[];
    const perShelfStore = await Promise.all(
      paths.map(async ([key, path]) => {
        const store = listStores().find((s) => s.key === key);
        if (!store) return [] as StoreCandidate[];
        const items = await liveSearchByCategory(key, path, Math.max(12, perStore * 3));
        const hits = items.map((item) => ({ store, item }));
        // Ordem dentro da prateleira: quem mais casa com a consulta da pick primeiro (zeros ficam, na ordem da loja).
        return hits
          .map((hit, index) => ({ hit, index, score: Math.max(0, ...alternatives.map((alt) => scoreCatalogMatch(alt, hit.item))) }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((entry) => entry.hit)
          .slice(0, perStore);
      })
    );
    return perShelfStore.flat();
  })();

  const primaryLists = await Promise.all(primary.map((query) => gather(query)));
  const categoryHits = await categoryTask;
  primaryLists.forEach(push);
  // Consultas da prateleira que a pick não cobre; se a pick sozinha deu pouco, amplia também com as cobertas.
  const widen = merged.length < limit;
  const secondary = (widen ? shelfTerms.filter((term, index) => term.trim() && shelfTerms.findIndex((other) => normShelf(other) === normShelf(term)) === index && !primary.some((p) => normShelf(p) === normShelf(term))) : extraTerms).slice(0, Math.max(0, SHELF_MAX_QUERIES - primary.length));
  const secondaryLists = await Promise.all(secondary.map((query) => gather(query)));
  secondaryLists.forEach(push);

  const catExtras: StoreCandidate[] = [];
  for (const candidate of categoryHits) {
    const key = `${candidate.store.key}:${candidate.item.sku}`;
    if (seen.has(key) || !accept(candidate)) continue;
    seen.add(key);
    catExtras.push(candidate);
  }
  if (!catExtras.length) return merged.slice(0, limit);
  const keep = Math.min(SHELF_CATEGORY_RESERVE, catExtras.length, limit);
  return [...merged.slice(0, Math.max(0, limit - keep)), ...catExtras.slice(0, keep)];
}

export type { CatalogItem, StoreConnector, StoreUnit };
