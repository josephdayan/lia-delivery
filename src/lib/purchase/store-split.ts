// Pedido com várias lojas (09/10/2026, dono: "pedido de duas coisas de lojas diferentes tem que
// fechar"). Comprar em três lojas é comprar três vezes: um trabalho de compra por loja dentro do
// MESMO pedido, cada um com a sua parte da cesta, o seu frete, o seu prazo, o seu teto e o seu Pix
// de saída. Este módulo é puro (sem banco): é a única régua de "o que é a parte da loja X".
//
// Pedido de UMA loja continua exatamente como antes: a parte da loja é o pedido inteiro, com o
// frete e o prazo do pedido (o hash do carrinho não muda para os pedidos antigos).
import { purchaseCartHash } from "../purchase-worker";
import { serviceFeeForItems } from "../pricing";

export type SplitItem = {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  storeKey: string;
  storeLabel?: string;
  productUrl?: string;
  medicine?: "mip";
  lineTotal?: number;
};

// Uma entrada por loja em `DeliveryOrder.fulfillments` (gravada na cotação de cesta com 2+ lojas).
export type StoreShareFulfillment = {
  storeKey: string;
  storeLabel: string;
  deliveryMode: "retailer_delivery";
  deliveryPromise?: string;
  deliveryFee: number;
  // Custo dos produtos na loja (o que o checkout dela soma) e a margem da Lia sobre eles.
  itemsSubtotal: number;
  retailerTotal: number;
  serviceFee: number;
  // O que o cliente pagou por esta loja (produtos + margem + frete). A soma das partes é o total
  // do pedido, ao centavo: é o valor devolvido quando só esta loja falha.
  customerShare: number;
};

export type StoreScope = {
  storeKey: string;
  storeLabel: string;
  multi: boolean;
  items: SplitItem[];
  deliveryFee: number;
  promise?: string;
  // Teto do checkout da loja (produtos + frete), em centavos.
  ceilingCents: number;
  // Parte do cliente, em centavos.
  shareCents: number;
};

type OrderLike = {
  items: unknown;
  fulfillments: unknown;
  deliveryFee: number;
  itemsSubtotal: number;
  total: number;
  cep?: string | null;
  deliveryAddress?: string | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const cents = (value: number) => Math.round(value * 100);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function orderItems(items: unknown): SplitItem[] {
  return (Array.isArray(items) ? items : []).filter(
    (item): item is SplitItem => Boolean(item) && typeof item === "object" && typeof (item as SplitItem).storeKey === "string"
  );
}

// Lojas do pedido, na ordem em que aparecem na cesta.
export function orderStoreKeys(items: unknown): string[] {
  return [...new Set(orderItems(items).map((item) => item.storeKey).filter(Boolean))];
}

export function isMultiStoreOrder(order: { items: unknown }): boolean {
  return orderStoreKeys(order.items).length > 1;
}

function fulfillmentList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
}

export function storeFulfillment(fulfillments: unknown, storeKey: string): Record<string, unknown> | undefined {
  return fulfillmentList(fulfillments).find((entry) => entry.storeKey === storeKey);
}

// Cesta de várias lojas cotada POR LOJA (frete e parte do cliente de cada uma). Pedido antigo de 2+
// lojas, cotado com um frete só, não tem como dividir: nunca vira compra automática.
export function perStoreQuoteReady(order: { items: unknown; fulfillments: unknown }): boolean {
  const stores = orderStoreKeys(order.items);
  if (stores.length < 2) return true;
  return stores.every((storeKey) => {
    const f = storeFulfillment(order.fulfillments, storeKey);
    return Boolean(f) && num(f!.deliveryFee) != null && num(f!.customerShare) != null;
  });
}

function joinedPromise(fulfillments: unknown): string | undefined {
  const values = fulfillmentList(fulfillments)
    .map((entry) => entry.deliveryPromise)
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return values.length ? values.join(" · ") : undefined;
}

// A parte da loja no pedido. null = a loja não está no pedido ou o pedido de várias lojas não foi
// cotado por loja.
export function storeScope(order: OrderLike, storeKey: string): StoreScope | null {
  const all = orderItems(order.items);
  const stores = orderStoreKeys(order.items);
  if (!stores.includes(storeKey)) return null;
  const items = all.filter((item) => item.storeKey === storeKey);
  const storeLabel = items[0]?.storeLabel ?? storeKey;
  if (stores.length === 1) {
    return {
      storeKey,
      storeLabel,
      multi: false,
      items: all,
      deliveryFee: order.deliveryFee,
      promise: joinedPromise(order.fulfillments),
      ceilingCents: cents(order.itemsSubtotal + order.deliveryFee),
      shareCents: cents(order.total)
    };
  }
  const f = storeFulfillment(order.fulfillments, storeKey);
  const fee = num(f?.deliveryFee);
  const share = num(f?.customerShare);
  if (!f || fee == null || share == null) return null;
  const subtotal = items.reduce((sum, item) => sum + round2(item.unitPrice * item.qty), 0);
  return {
    storeKey,
    storeLabel: typeof f.storeLabel === "string" ? f.storeLabel : storeLabel,
    multi: true,
    items,
    deliveryFee: fee,
    promise: typeof f.deliveryPromise === "string" && f.deliveryPromise.trim() ? f.deliveryPromise : undefined,
    ceilingCents: cents(subtotal + fee),
    shareCents: cents(share)
  };
}

// Hash do carrinho da loja: o mesmo de sempre (purchaseCartHash), sobre a parte da loja.
export function storeCartHash(order: OrderLike, scope: StoreScope): string {
  return purchaseCartHash(
    scope.items.map((item) => ({ ...item, storeLabel: item.storeLabel ?? "" })),
    scope.deliveryFee,
    scope.promise,
    { cep: order.cep ?? null, deliveryAddress: order.deliveryAddress ?? null }
  );
}

// Cotação de cesta com 2+ lojas: uma entrada por loja. A margem da loja é a dos itens dela
// (serviceFeeForItems); o que sobrar de arredondamento ou taxa fixa (remédio contado uma vez só no
// pedido) vai para a maior parte, para a soma bater com o total ao centavo.
export function buildStoreFulfillments(
  items: SplitItem[],
  stores: Array<{ storeKey: string; storeLabel: string; fee: number; promise?: string }>,
  total: number
): StoreShareFulfillment[] {
  const entries = stores.map((store) => {
    const own = items.filter((item) => item.storeKey === store.storeKey);
    const itemsSubtotal = round2(own.reduce((sum, item) => sum + round2(item.unitPrice * item.qty), 0));
    const serviceFee = serviceFeeForItems(own);
    const deliveryFee = round2(store.fee);
    return {
      storeKey: store.storeKey,
      storeLabel: store.storeLabel,
      deliveryMode: "retailer_delivery" as const,
      ...(store.promise ? { deliveryPromise: store.promise } : {}),
      deliveryFee,
      itemsSubtotal,
      retailerTotal: itemsSubtotal,
      serviceFee,
      customerShare: round2(itemsSubtotal + serviceFee + deliveryFee)
    };
  });
  if (!entries.length) return entries;
  const residual = round2(total - entries.reduce((sum, entry) => sum + entry.customerShare, 0));
  if (Math.abs(residual) >= 0.005) {
    const biggest = entries.reduce((a, b) => (b.customerShare > a.customerShare ? b : a));
    biggest.customerShare = round2(biggest.customerShare + residual);
    biggest.serviceFee = round2(biggest.serviceFee + residual);
  }
  return entries;
}

// Progresso de UMA loja dentro do pedido, pelo que já aconteceu com ela.
export const STORE_STAGE_RANK = { paid: 0, bought: 1, shipped: 2, out_for_delivery: 3, delivered: 4 } as const;
export type StoreStage = keyof typeof STORE_STAGE_RANK;

// Status do pedido = o da loja mais atrasada entre as que seguem (as devolvidas não contam):
// "pago" enquanto alguma ainda não foi comprada, "entregue" só quando todas chegaram.
export function aggregateOrderStatus(stages: StoreStage[]): string | null {
  if (!stages.length) return null;
  const rank = Math.min(...stages.map((stage) => STORE_STAGE_RANK[stage]));
  return rank === 0 ? "paid" : rank === 1 ? "retailer_preparing" : rank === 4 ? "delivered" : "retailer_out_for_delivery";
}

// Prefixo do evento de entrega por loja (dedupe): `${orderId}:${storeKey}:${kind}`.
export function storeEventKey(orderId: string, storeKey: string, kind: string): string {
  return `${orderId}:${storeKey}:${kind}`;
}

export function storeStageFromKeys(orderId: string, storeKey: string, keys: string[]): StoreStage {
  const own = new Set(keys);
  for (const stage of ["delivered", "out_for_delivery", "shipped", "bought"] as const) {
    if (own.has(storeEventKey(orderId, storeKey, stage))) return stage;
  }
  return "paid";
}

// Trabalho de compra cuja parte do cliente já foi devolvida (falha só desta loja).
export const STORE_SHARE_REFUNDED = "STORE_SHARE_REFUNDED";
// Assinatura de acompanhamento do pedido de várias lojas: uma por pedido (a tabela é 1:1), e o
// vigia olha cada loja comprada dentro dela.
export const MULTI_STORE_TRACKING_KEY = "multi";
