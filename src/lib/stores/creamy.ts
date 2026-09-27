import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./creamy-catalog";

// Creamy — skincare (sérum, protetor, hidratante). Pix com desconto; entrega DHL em ~3 dias.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const creamyStore: StoreConnector = {
  key: "creamy",
  label: "Creamy",
  minOrder: Number(process.env.LIA_CREAMY_MIN_ORDER ?? 0),
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
    return `Pedido Creamy nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
