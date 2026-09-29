import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { mipOnly, withoutMedicine } from "./anvisa";
import { CATALOG } from "./drogariasp-catalog";
import { MIP_CATALOG } from "./drogariasp-mip-catalog";
import { medicineEnabled } from "../medicine";

// Drogaria São Paulo — farmácia SEM MEDICAMENTO (ANVISA). Catálogo real gerado da API pública
// VTEX de drogariasaopaulo.com.br em 2026-08-02, restrito a uma allowlist de categorias
// seguras (fralda, protetor solar, cabelo, dermocosmético, higiene bucal, maquiagem, papel,
// absorvente, lenço, repelente…) e passado por um deny-regex de medicamento como segunda
// guarda independente. As categorias 800/868 (Medicamentos/Remédios), 862/1014 (Vitamina,
// Polivitamínicos), 1228+ (Vacina/Teste/Exame/Injetáveis) NUNCA entram.
// Ao regenerar, manter as duas guardas: allowlist de categoria E deny-regex.
// `withoutMedicine` é a terceira guarda, em runtime: a loja classifica medicamento dentro de
// categorias cosméticas (ex.: esmalte antifúngico com ciclopirox), então o filtro final é código.
const ITEMS = withoutMedicine(catalogWithImages(CATALOG));
// Remédio isento (29/09): só com LIA_MEDICINE_MIP=true, e só pela porta `mipOnly`.
const WITH_MIP = [...ITEMS, ...mipOnly(catalogWithImages(MIP_CATALOG))];
const items = () => (medicineEnabled() ? WITH_MIP : ITEMS);

export const drogariaSpStore: StoreConnector = {
  key: "drogariasp",
  label: "Drogaria São Paulo",
  minOrder: Number(process.env.LIA_DROGARIASP_MIN_ORDER ?? 0),
  async searchItems(query: string, limit = 4) {
    return rankCatalog(query, items(), limit);
  },
  listCatalog() {
    return items();
  },
  listUnits(): StoreUnit[] {
    return [];
  },
  pickupInstructions(orderNumber: string) {
    return `Pedido Drogaria São Paulo nº ${orderNumber}: SEM medicamento (ANVISA). Fulfillment do concierge; sem retirada por courier no balcão.`;
  }
};
