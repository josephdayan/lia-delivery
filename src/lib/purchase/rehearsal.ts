// ENSAIO DA COMPRA antes de cobrar (08/10/2026, noite — pedido do dono: "a pessoa faz tudo, paga, e aí
// cancela e estorna; resolve isso"). Até aqui a Lia cobrava com base na SIMULAÇÃO por CEP e só
// descobria na COMPRA que a loja não aceitava: TURBO de 30 min que some com as coordenadas do endereço
// (Drogarias Pacheco, 08/10), item sem seller com estoque (Drogaria SP, 05/10), janela de entrega
// obrigatória (Mambo, 25/09). Cada um virou cliente cobrado e estornado.
//
// Agora, no instante de cobrar, a Lia roda os MESMOS passos da compra automática (vtex-runner.ts):
// mesmo endereço resolvido (com as mesmas coordenadas), mesmo perfil do comprador, mesma entrega
// prometida → cesta, perfil, endereço, entrega dentro do prazo prometido, Pix selecionado e a conferência
// (snapshot) — e PARA antes de fechar o pedido. Nada é criado na loja; a cesta é esvaziada no fim.
// Recusa da LOJA (item, entrega, endereço, pagamento) = nada é cobrado. Loja fora do ar/timeout não
// inventa recusa (a cobrança segue como antes e a compra tenta sozinha). `LIA_PURCHASE_REHEARSAL=false`
// desliga.
import { prisma } from "../prisma";
import { automaticPurchaseStores } from "../purchase-policy";
import { customerBuyerFor } from "../purchase-worker";
import { resolveVtexAddress } from "./vtex-address";
import { buyerProfile, customerBuyerProfile, serverBuyerEnabled } from "./vtex-runner";
import { VTEX_API_STORES, VtexCheckoutRejected, VtexCheckoutSession, type FetchLike, type VtexBuyerProfile } from "./vtex-checkout";

export type RehearsalItem = { sku: string; name: string; qty: number; storeKey: string; storeLabel?: string; medicine?: "mip" };
export type RehearsalOrder = {
  id: string;
  cep: string | null;
  deliveryAddress: string | null;
  customerName: string | null;
  phone: string;
  buyerDocument: string | null;
  buyerName: string | null;
  items: RehearsalItem[];
  fulfillments: unknown;
};
// `items`: item fora / sem estoque / quantidade; `delivery`: a entrega prometida (prazo) não existe pro
// endereço; `address`: a loja recusou o endereço; `checkout`: outro passo do checkout recusou.
export type RehearsalFailure = { storeKey: string; storeLabel: string; kind: "items" | "delivery" | "address" | "checkout"; detail: string; skus: string[] };

let override: ((order: RehearsalOrder) => Promise<RehearsalFailure | null>) | null = null;
export function __setPurchaseRehearsalForTests(fn: ((order: RehearsalOrder) => Promise<RehearsalFailure | null>) | null): void {
  override = fn;
}

export function rehearsalEnabled(): boolean {
  return process.env.LIA_PURCHASE_REHEARSAL !== "false" && serverBuyerEnabled();
}

// A entrega prometida para a loja (a mesma string que a compra recebe em `deliveryPromise`).
function promiseFor(fulfillments: unknown): string | undefined {
  if (!Array.isArray(fulfillments)) return undefined;
  const values = fulfillments
    .map((entry) => (entry && typeof entry === "object" ? (entry as { deliveryPromise?: unknown }).deliveryPromise : undefined))
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return values.length ? values.join(" · ") : undefined;
}

function classify(error: unknown): { kind: RehearsalFailure["kind"]; refusal: boolean; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof VtexCheckoutRejected) {
    const stage = error.stage;
    // 5xx/0 = loja instável, não é recusa; catálogo que não respondeu (seller ≠ 200) também não.
    if (error.status >= 500 || (error.status === 0 && stage !== "sku") || (stage === "seller" && error.status !== 200)) return { kind: "checkout", refusal: false, detail };
    // Bloqueio de robô/instabilidade no checkout (403/429) não é recusa do pedido.
    if (error.status === 403 || error.status === 429) return { kind: "checkout", refusal: false, detail };
    if (stage === "items" || stage === "seller" || stage === "sku") return { kind: "items", refusal: true, detail };
    if (stage === "sla") return { kind: "delivery", refusal: true, detail };
    if (stage === "shippingData") return { kind: /entrega|deliver|logist/i.test(detail) ? "delivery" : "address", refusal: true, detail };
    return { kind: "checkout", refusal: true, detail };
  }
  // Erros da conferência (snapshot) são da loja/cesta: "Janela de entrega não selecionada", "Produto
  // divergente ou sem estoque", "Pix não está selecionado"…
  if (/janela|entrega|prazo/i.test(detail)) return { kind: "delivery", refusal: true, detail };
  if (/estoque|divergente|produto/i.test(detail)) return { kind: "items", refusal: true, detail };
  if (/timeout|fetch failed|ECONN|socket|aborted|network/i.test(detail)) return { kind: "checkout", refusal: false, detail };
  // Consulta de CEP (BrasilAPI/ViaCEP) que não respondeu não é recusa da loja; endereço sem número é.
  if (/CEP sem rua\/cidade/i.test(detail)) return { kind: "address", refusal: false, detail };
  if (/endere|CEP|número/i.test(detail)) return { kind: "address", refusal: true, detail };
  return { kind: "checkout", refusal: true, detail };
}

// Ensaia cada loja de compra automática da cesta. null = pode cobrar.
export async function rehearsePurchase(order: RehearsalOrder, fetchImpl?: FetchLike): Promise<RehearsalFailure | null> {
  if (override) return override(order);
  if (!rehearsalEnabled() || !order.cep || !order.deliveryAddress) return null;
  const auto = automaticPurchaseStores();
  const byStore = new Map<string, RehearsalItem[]>();
  for (const item of order.items) {
    if (!VTEX_API_STORES[item.storeKey] || !auto.includes(item.storeKey)) continue;
    byStore.set(item.storeKey, [...(byStore.get(item.storeKey) ?? []), item]);
  }
  if (!byStore.size) return null;
  const promise = promiseFor(order.fulfillments);
  const receiverName = (order.customerName ?? order.buyerName ?? "").trim() || "Cliente Lia";
  const results = await Promise.all(
    [...byStore].map(async ([storeKey, items]): Promise<RehearsalFailure | null> => {
      const storeLabel = items[0].storeLabel ?? VTEX_API_STORES[storeKey].label;
      const skus = items.map((i) => i.sku);
      const account = await prisma.purchaseAccount.findUnique({ where: { storeKey } }).catch(() => null);
      // Sem conta da loja a compra automática nem nasce (vai para a fila manual): nada a ensaiar.
      if (!account?.email) return null;
      let profile: VtexBuyerProfile;
      try {
        const buyer = customerBuyerFor({ deliveryOrder: { buyerDocument: order.buyerDocument, buyerName: order.buyerName, items: order.items }, items: items.map((i) => ({ requestedSku: i.sku })) });
        profile = buyer ? customerBuyerProfile(account.email, buyer, order.phone) : buyerProfile(account.email, order.phone);
      } catch (error) {
        // Configuração do comprador (CNPJ/CPF): a compra falharia igual — não cobra.
        return { storeKey, storeLabel, kind: "checkout", detail: error instanceof Error ? error.message : String(error), skus };
      }
      const session = new VtexCheckoutSession(storeKey, fetchImpl, 20_000);
      const started = Date.now();
      try {
        const address = await resolveVtexAddress({ receiverName, cep: order.cep!, addressText: order.deliveryAddress!, ...(fetchImpl ? { fetchImpl } : {}) });
        await session.prepare({ items: items.map((i) => ({ sku: i.sku, qty: i.qty })), profile, address, deliveryPromise: promise });
        session.snapshot({ cartHash: "rehearsal", customerAddress: order.deliveryAddress!, items: items.map((i) => ({ sku: i.sku })) });
        console.log(`[purchase-rehearsal] ok ${storeKey} ${order.id} ms=${Date.now() - started}`);
        return null;
      } catch (error) {
        const c = classify(error);
        console.warn(`[purchase-rehearsal] ${c.refusal ? "RECUSA" : "instável"} ${storeKey} ${order.id} kind=${c.kind} ms=${Date.now() - started}: ${c.detail.slice(0, 200)}`);
        return c.refusal ? { storeKey, storeLabel, kind: c.kind, detail: c.detail.slice(0, 300), skus } : null;
      } finally {
        await session.clearCart().catch(() => undefined);
      }
    })
  );
  return results.find((r): r is RehearsalFailure => r !== null) ?? null;
}
