import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./prezunic-catalog";

// Prezunic — VTEX com checkout aberto por API (fechamento real provado pela sondagem em 2026-10-06).
// Catálogo real colhido da API pública de www.prezunic.com.br (scripts/add-vtex-store.mts). Compra pelo servidor,
// Pix da loja pago pela Lia; entrega pela própria loja.
const ITEMS = catalogWithImages(CATALOG);

export const prezunicStore: StoreConnector = {
  key: "prezunic",
  label: "Prezunic",
  minOrder: Number(process.env.LIA_PREZUNIC_MIN_ORDER ?? 80), // ORD079: carrinho mínimo R$80 (06/10)
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
    return `Pedido Prezunic nº ${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.`;
  }
};
