import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./polishop-catalog";

// Polishop — casa, cozinha, beleza e fitness. Entrega padrão grátis ~3 dias úteis.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const polishopStore: StoreConnector = {
  key: "polishop",
  label: "Polishop",
  minOrder: Number(process.env.LIA_POLISHOP_MIN_ORDER ?? 0),
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
    return `Pedido Polishop nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
