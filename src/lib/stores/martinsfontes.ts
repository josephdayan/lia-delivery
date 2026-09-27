import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { CATALOG } from "./martinsfontes-catalog";

// Livraria Martins Fontes Paulista — livros (literatura, humanas, arte, arquitetura, infantil). Entrega Loggi/Sedex em 2–3 dias úteis.
// Catálogo real colhido da API pública VTEX em 2026-09-27; compra por API do servidor
// (checkout aberto + Pix sondado no endereço do dono).
const ITEMS = catalogWithImages(CATALOG);

export const martinsfontesStore: StoreConnector = {
  key: "martinsfontes",
  label: "Martins Fontes",
  minOrder: Number(process.env.LIA_MARTINSFONTES_MIN_ORDER ?? 0),
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
    return `Pedido Martins Fontes nº ${orderNumber}: comprado por API e entregue pela própria loja.`;
  }
};
