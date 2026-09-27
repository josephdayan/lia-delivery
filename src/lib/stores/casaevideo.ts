import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./casaevideo-catalog";

// Casa & Vídeo — cama, mesa, banho, utilidades e pequenos eletros (marketplace: seller resolvido na hora). ~5 dias úteis.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const casaevideoStore: StoreConnector = {
  key: "casaevideo",
  label: "Casa & Vídeo",
  minOrder: Number(process.env.LIA_CASAEVIDEO_MIN_ORDER ?? 0),
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
    return `Pedido Casa & Vídeo nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
