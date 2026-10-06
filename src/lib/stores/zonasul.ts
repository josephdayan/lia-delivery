import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./zonasul-catalog";

// Zona Sul — VTEX com checkout aberto por API (fechamento real provado pela sondagem em 2026-10-06).
// Catálogo real colhido da API pública de www.zonasul.com.br (scripts/add-vtex-store.mts). Compra pelo servidor,
// Pix da loja pago pela Lia; entrega pela própria loja.
const ITEMS = catalogWithImages(CATALOG);

export const zonasulStore: StoreConnector = {
  key: "zonasul",
  label: "Zona Sul",
  minOrder: Number(process.env.LIA_ZONASUL_MIN_ORDER ?? 0),
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
    return `Pedido Zona Sul nº ${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.`;
  }
};
