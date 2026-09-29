import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { withoutMedicine } from "./anvisa";
import { CATALOG } from "./drogariaspacheco-catalog";

// Drogarias Pacheco — VTEX com checkout aberto por API (fechamento real provado pela sondagem em 2026-09-29).
// Catálogo real colhido da API pública de www.drogariaspacheco.com.br (scripts/add-vtex-store.mts). Compra pelo servidor,
// Pix da loja pago pela Lia; entrega pela própria loja. SEM medicamento (ANVISA): deny na colheita + withoutMedicine.
const ITEMS = withoutMedicine(catalogWithImages(CATALOG));

export const drogariaspachecoStore: StoreConnector = {
  key: "drogariaspacheco",
  label: "Drogarias Pacheco",
  minOrder: Number(process.env.LIA_DROGARIASPACHECO_MIN_ORDER ?? 0),
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
    return `Pedido Drogarias Pacheco nº ${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.`;
  }
};
