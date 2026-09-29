import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { withoutMedicine } from "./anvisa";
import { CATALOG } from "./drogariacatarinense-catalog";

// Drogaria Catarinense — VTEX com checkout aberto por API (fechamento real provado pela sondagem em 2026-09-29).
// Catálogo real colhido da API pública de www.drogariacatarinense.com.br (scripts/add-vtex-store.mts). Compra pelo servidor,
// Pix da loja pago pela Lia; entrega pela própria loja. SEM medicamento (ANVISA): deny na colheita + withoutMedicine.
const ITEMS = withoutMedicine(catalogWithImages(CATALOG));

export const drogariacatarinenseStore: StoreConnector = {
  key: "drogariacatarinense",
  label: "Drogaria Catarinense",
  minOrder: Number(process.env.LIA_DROGARIACATARINENSE_MIN_ORDER ?? 0),
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
    return `Pedido Drogaria Catarinense nº ${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.`;
  }
};
