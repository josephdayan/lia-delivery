import type { StoreConnector, StoreUnit } from "./types";
import { catalogWithImages, rankCatalog } from "./types";
import { withoutMedicine } from "./anvisa";
import { CATALOG } from "./americanas-catalog";

// Americanas — loja de departamentos (mercado, bebê, beleza, limpeza, pet, casa, papelaria,
// brinquedos, livros, eletroportáteis). VTEX com checkout aberto por API: pedido real criado
// em 28/09/2026 no endereço do dono, Pix dinâmico (Stark Infra) no formato que a Lia paga.
// Só o seller "1" (a própria Americanas): "Entrega" 1 dia útil e "Entrega 2h" na capital.
// A loja exige R$30 no carrinho (ORD079). SEM medicamento (ANVISA): deny na colheita +
// `withoutMedicine` em runtime. Recebedor do Pix é "Americanas s.a - em Recup" (recuperação
// judicial): pós-venda/estorno da loja é risco a acompanhar.
const ITEMS = withoutMedicine(catalogWithImages(CATALOG));

export const americanasStore: StoreConnector = {
  key: "americanas",
  label: "Americanas",
  minOrder: Number(process.env.LIA_AMERICANAS_MIN_ORDER ?? 30),
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
    return `Pedido Americanas nº ${orderNumber}: comprado por API e entregue pela própria loja; sem retirada por courier.`;
  }
};
