// Onde cada loja ENTREGA (06/10/2026, expansão pro Rio). Regra do dono: "só mostrar e
// aceitar compra se tiver perto". A maioria das lojas da vitrine é e-commerce nacional
// (entrega no país todo; quem decide prazo e frete é a simulação ao vivo). Algumas são
// REGIONAIS — mercado do Rio não entrega em SP e vice-versa. Para elas vale uma trava
// estática, sem rede: fora da área a loja nem entra na busca, nem na vitrine, nem na
// cotação, nem na cobrança. Dentro da área, a simulação ao vivo ainda precisa confirmar
// (e, se a loja não responder, o item regional sai da vitrine — falha fechada).
//
// Medido em 06/10 com a simulação de frete de cada loja em 11 CEPs (SP capital, Guarulhos,
// Campinas, Ribeirão, Santos, Rio (3 bairros), Niterói, BH): só estas não entregam fora da
// própria região. Loja nova regional = 1 linha aqui.
//
// Puro (sem DB/rede), com um escopo por turno (AsyncLocalStorage) para que TODA busca do
// turno filtre pela área do cliente sem passar o CEP pelos ~10 pontos de busca do cérebro.
import { AsyncLocalStorage } from "node:async_hooks";
import { pausedStoresSnapshot } from "./store-pause";
import { ufFromCep } from "./coverage";
import { automaticPurchaseStores } from "./purchase-policy";

type StoreArea = { ufs: string[]; cepPrefixes?: string[] };

const REGIONAL_STORES: Record<string, StoreArea> = {
  // Mercado de SP capital (06/10: Paulista e Faria Lima sim; Guarulhos, Campinas, Rio não).
  mambo: { ufs: ["SP"], cepPrefixes: ["01", "02", "03", "04", "05", "08"] },
  // Covabra: Campinas, Guarulhos, Santos e parte da capital; nada fora de SP.
  covabra: { ufs: ["SP"] },
  // Savegnago: interior (Campinas e Ribeirão responderam; capital e Santos não).
  savegnago: { ufs: ["SP"], cepPrefixes: ["13", "14"] },
  // Swift: estado de SP; nada no Rio nem em BH.
  swift: { ufs: ["SP"] },
  // Mercados do Rio (06/10: Copacabana com entrega no dia / 2h).
  zonasul: { ufs: ["RJ"] },
  prezunic: { ufs: ["RJ"] }
};

export function isRegionalStore(storeKey: string): boolean {
  return Boolean(REGIONAL_STORES[storeKey]);
}

// A loja entrega neste CEP? Loja nacional: sim (a simulação ao vivo decide o resto).
// Loja regional sem CEP conhecido: NÃO — não dá para provar que é perto.
export function storeServesCep(storeKey: string, cep: string | null | undefined): boolean {
  const area = REGIONAL_STORES[storeKey];
  if (!area) return true;
  const digits = (cep ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return false;
  const uf = ufFromCep(digits);
  if (!uf || !area.ufs.includes(uf)) return false;
  return !area.cepPrefixes || area.cepPrefixes.some((prefix) => digits.startsWith(prefix));
}

// ---------- escopo do turno ----------
// Dentro de um turno do WhatsApp, o CEP do cliente fica aqui (lido do contexto e
// atualizado a cada gravação). Fora de turno (scripts, golden, /ops) não há escopo e a
// busca não filtra — quem tem o CEP explícito (vitrine ao vivo, cotação, cobrança)
// aplica `storeServesCep` diretamente.
const shopperScope = new AsyncLocalStorage<{ cep?: string }>();

export function runShopperScoped<T>(fn: () => Promise<T>): Promise<T> {
  return shopperScope.run({}, fn);
}

export function noteShopperCep(cep: string | null | undefined) {
  const scope = shopperScope.getStore();
  const digits = (cep ?? "").replace(/\D/g, "");
  if (scope && digits.length === 8) scope.cep = digits;
}

export function currentShopperCep(): string | undefined {
  return shopperScope.getStore()?.cep;
}

// Vitrine = só loja de compra automática (dono, 06/10: "é só as lojas automáticas"). Um
// pedido no Mercado Livre caiu na fila manual porque a loja aparecia na busca sem estar em
// LIA_AUTO_PURCHASE_STORES. Lista vazia (dev/testes) não filtra.
function automaticOnly<T extends { key: string }>(stores: T[]): T[] {
  const automatic = automaticPurchaseStores();
  return automatic.length ? stores.filter((store) => automatic.includes(store.key)) : stores;
}

export function storesForShopper<T extends { key: string }>(stores: T[]): T[] {
  const scope = shopperScope.getStore();
  // Loja pausada (09/10, store-pause.ts): não começou um pedido comprado no prazo → fora da vitrine.
  const paused = pausedStoresSnapshot();
  const sellable = automaticOnly(stores).filter((store) => !paused.has(store.key));
  if (!scope) return sellable;
  return sellable.filter((store) => storeServesCep(store.key, scope.cep));
}
