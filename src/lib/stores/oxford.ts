import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./oxford-catalog";

// Oxford — louça e porcelana (pratos, xícaras, aparelhos de jantar). Entrega ~8 dias úteis.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const oxfordStore: StoreConnector = {
  key: "oxford",
  label: "Oxford Porcelanas",
  minOrder: Number(process.env.LIA_OXFORD_MIN_ORDER ?? 0),
  async searchItems(query: string, limit = 4) {
    return rankCatalog(query, ITEMS, limit);
  },
  listCatalog() {
    return ITEMS;
  },
  listUnits(): StoreUnit[] {
    return [];
  },
  pickupInstructions(orderNumber: string) {
    return `Pedido Oxford Porcelanas nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
