import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./mondial-catalog";

// Mondial — eletroportáteis da marca (liquidificador, air fryer, ventilador). Entrega ~6 dias úteis.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const mondialStore: StoreConnector = {
  key: "mondial",
  label: "Mondial",
  minOrder: Number(process.env.LIA_MONDIAL_MIN_ORDER ?? 0),
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
    return `Pedido Mondial nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
