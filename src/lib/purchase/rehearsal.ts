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
// Recusa da LOJA (item, entrega, endereço, pagamento, PREÇO acima do cotado) = nada é cobrado. Antes de
// tudo, o que a compra automática nem executaria (cesta de 2 lojas, loja fora da API, item sem link) também
// é recusa — TODA compra é por API, não existe fila manual. Loja fora do ar/timeout não inventa recusa (a
// cobrança segue como antes e a compra tenta sozinha). O ensaio inteiro tem um orçamento de tempo
// (LIA_PURCHASE_REHEARSAL_BUDGET_MS, 45 s): estourou = loja instável, não recusa.
// `LIA_PURCHASE_REHEARSAL=false` desliga.
import { prisma } from "../prisma";
import { automaticPurchaseStores } from "../purchase-policy";
import { purchaseUrlAllowed } from "../purchase-preparation";
import { customerBuyerFor } from "../purchase-worker";
import { withDeadline } from "../stores/live-search";
import { resolveVtexAddress } from "./vtex-address";
import { buyerProfile, customerBuyerProfile, serverBuyerEnabled } from "./vtex-runner";
import { VTEX_API_STORES, VtexCheckoutRejected, VtexCheckoutSession, type FetchLike, type VtexBuyerProfile } from "./vtex-checkout";

export type RehearsalItem = { sku: string; name: string; qty: number; storeKey: string; storeLabel?: string; unitPrice?: number; productUrl?: string; medicine?: "mip" };
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
  // Teto do que foi cotado ao cliente (o mesmo teto que a conferência da compra usa): a loja
  // cobrando mais que isso na hora = o preço mudou = não cobra, recota.
  itemsSubtotal?: number;
  deliveryFee?: number;
};
// `items`: item fora / sem estoque / quantidade / sem link de compra; `delivery`: a entrega prometida (prazo)
// não existe pro endereço; `address`: a loja recusou o endereço; `price`: a loja está cobrando mais que o
// cotado; `checkout`: outro passo do checkout recusou; `store`: a Lia não compra nessa loja por API (não é
// loja VTEX por API, não está liberada ou está sem conta) — `skus` = todos os itens dela; `split`: cesta de
// mais de uma loja (a compra automática fecha UMA loja por pedido) — `skus` = os itens que saem,
// `storeKey/storeLabel` = a loja que fica.
export type RehearsalFailure = { storeKey: string; storeLabel: string; kind: "items" | "delivery" | "address" | "price" | "checkout" | "store" | "split"; detail: string; skus: string[] };

let override: ((order: RehearsalOrder) => Promise<RehearsalFailure | null>) | null = null;
export function __setPurchaseRehearsalForTests(fn: ((order: RehearsalOrder) => Promise<RehearsalFailure | null>) | null): void {
  override = fn;
}

export function rehearsalEnabled(): boolean {
  return process.env.LIA_PURCHASE_REHEARSAL !== "false" && serverBuyerEnabled();
}

function budgetMs(): number {
  const configured = Number(process.env.LIA_PURCHASE_REHEARSAL_BUDGET_MS ?? 45_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
}

type Fulfillment = { storeKey?: unknown; deliveryPromise?: unknown; itemsSubtotal?: unknown; retailerTotal?: unknown; deliveryFee?: unknown };
function fulfillmentsOf(value: unknown): Fulfillment[] {
  return Array.isArray(value) ? value.filter((entry): entry is Fulfillment => Boolean(entry) && typeof entry === "object") : [];
}

// A entrega prometida para a loja (a mesma string que a compra recebe em `deliveryPromise`): a da loja
// quando o pedido tem uma por loja; senão, todas juntas (cesta de uma loja só).
function promiseFor(fulfillments: Fulfillment[], storeKey: string): string | undefined {
  const own = fulfillments.filter((f) => f.storeKey === storeKey);
  const values = (own.length ? own : fulfillments)
    .map((f) => f.deliveryPromise)
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return values.length ? values.join(" · ") : undefined;
}

const money = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
// Teto em centavos do que a loja pode cobrar (itens + frete) — o mesmo critério de checkCheckout
// ("Total da loja acima do teto do pedido"), por loja quando o pedido tem a cotação por loja.
function ceilingCents(order: RehearsalOrder, fulfillments: Fulfillment[], storeKey: string, items: RehearsalItem[]): number | null {
  const own = fulfillments.find((f) => f.storeKey === storeKey);
  if (own) {
    const subtotal = Math.max(money(own.itemsSubtotal) ?? 0, money(own.retailerTotal) ?? 0);
    const fee = money(own.deliveryFee) ?? 0;
    if (subtotal > 0) return Math.round((subtotal + fee) * 100);
  }
  const lines = items.map((i) => (money(i.unitPrice) ?? 0) * i.qty);
  if (lines.every((v) => v > 0) && money(order.deliveryFee) != null) return Math.round((lines.reduce((a, b) => a + b, 0) + order.deliveryFee!) * 100);
  if (money(order.itemsSubtotal) != null && money(order.deliveryFee) != null && money(order.itemsSubtotal)! > 0) return Math.round((order.itemsSubtotal! + order.deliveryFee!) * 100);
  return null;
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

// TODA compra é por API (decisão de 25/09; dono, 08/10: "não temos mais compra que não é por API"). O que
// a compra automática não executa NÃO pode ser cobrado — antes virava job na "fila manual" que ninguém
// compra e acabava em estorno (Pague Menos 23/09, Mercado Livre 06/10). Espelha `preparationEligible` +
// `ensurePurchaseJobForPaidOrder` (purchase-worker.ts): uma loja por pedido, loja VTEX por API liberada e
// com conta pronta, item com quantidade inteira, preço e link de compra da loja.
export async function executabilityFailure(order: Pick<RehearsalOrder, "items">): Promise<RehearsalFailure | null> {
  const items = order.items.filter(Boolean);
  if (!items.length) return null;
  const stores = [...new Set(items.map((i) => i.storeKey))];
  const labelOf = (key: string) => items.find((i) => i.storeKey === key)?.storeLabel ?? VTEX_API_STORES[key]?.label ?? key;
  if (stores.length > 1) {
    // Fica a loja com a maior parte da cesta (em R$); as outras saem e são fechadas depois.
    const subtotal = (key: string) => items.filter((i) => i.storeKey === key).reduce((sum, i) => sum + (money(i.unitPrice) ?? 0) * i.qty, 0);
    const kept = [...stores].sort((a, b) => subtotal(b) - subtotal(a) || items.findIndex((i) => i.storeKey === a) - items.findIndex((i) => i.storeKey === b))[0];
    return { storeKey: kept, storeLabel: labelOf(kept), kind: "split", detail: `cesta de ${stores.length} lojas (${stores.join(", ")}); a compra automática fecha uma loja por pedido`, skus: items.filter((i) => i.storeKey !== kept).map((i) => i.sku) };
  }
  const storeKey = stores[0];
  const skus = items.map((i) => i.sku);
  const storeFail = (detail: string): RehearsalFailure => ({ storeKey, storeLabel: labelOf(storeKey), kind: "store", detail, skus });
  if (!VTEX_API_STORES[storeKey]) return storeFail(`${labelOf(storeKey)} não fecha por API`);
  if (!automaticPurchaseStores().includes(storeKey)) return storeFail(`${labelOf(storeKey)} não está liberada para compra automática (LIA_AUTO_PURCHASE_STORES)`);
  const account = await prisma.purchaseAccount.findUnique({ where: { storeKey } }).catch(() => null);
  if (!account?.email || !account.enabled || !account.loginReady || !account.paymentReady) return storeFail(`${labelOf(storeKey)} sem conta de compra pronta no /ops`);
  const bad = items.filter((i) => !(Number.isInteger(i.qty) && i.qty > 0) || !((money(i.unitPrice) ?? 0) > 0) || !purchaseUrlAllowed(storeKey, i.productUrl ?? ""));
  if (bad.length) return { storeKey, storeLabel: labelOf(storeKey), kind: "items", detail: `item sem link de compra/preço/quantidade válidos: ${bad.map((i) => i.sku).join(", ")}`, skus: bad.map((i) => i.sku) };
  return null;
}

// Ensaia a compra da cesta. null = pode cobrar.
export async function rehearsePurchase(order: RehearsalOrder, fetchImpl?: FetchLike): Promise<RehearsalFailure | null> {
  if (override) return override(order);
  if (!rehearsalEnabled() || !order.cep || !order.deliveryAddress) return null;
  const notExecutable = await executabilityFailure(order);
  if (notExecutable) {
    console.warn(`[purchase-rehearsal] RECUSA ${notExecutable.storeKey} ${order.id} kind=${notExecutable.kind}: ${notExecutable.detail}`);
    return notExecutable;
  }
  const byStore = new Map<string, RehearsalItem[]>();
  for (const item of order.items) byStore.set(item.storeKey, [...(byStore.get(item.storeKey) ?? []), item]);
  const fulfillments = fulfillmentsOf(order.fulfillments);
  const receiverName = (order.customerName ?? order.buyerName ?? "").trim() || "Cliente Lia";
  const startedAll = Date.now();
  const results = await withDeadline<(RehearsalFailure | null)[] | null>(
    Promise.all(
      [...byStore].map(async ([storeKey, items]): Promise<RehearsalFailure | null> => {
        const storeLabel = items[0].storeLabel ?? VTEX_API_STORES[storeKey].label;
        const skus = items.map((i) => i.sku);
        const promise = promiseFor(fulfillments, storeKey);
        const account = await prisma.purchaseAccount.findUnique({ where: { storeKey } }).catch(() => null);
        // Conta conferida em `executabilityFailure`; sumir aqui = banco instável, não recusa.
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
          const evidence = session.snapshot({ cartHash: "rehearsal", customerAddress: order.deliveryAddress!, items: items.map((i) => ({ sku: i.sku })) });
          // Preço: a loja cobrando mais que o cotado ao cliente viraria CHECKOUT_MISMATCH depois do
          // pagamento ("Total da loja acima do teto do pedido") — e estorno. Aqui vira recotação.
          const ceiling = ceilingCents(order, fulfillments, storeKey, items);
          if (ceiling != null && evidence.totalCents > ceiling) {
            const detail = `preço na loja ${(evidence.totalCents / 100).toFixed(2)} acima do cotado ${(ceiling / 100).toFixed(2)}`;
            console.warn(`[purchase-rehearsal] RECUSA ${storeKey} ${order.id} kind=price ms=${Date.now() - started}: ${detail}`);
            return { storeKey, storeLabel, kind: "price", detail, skus };
          }
          console.log(`[purchase-rehearsal] ok ${storeKey} ${order.id} ms=${Date.now() - started} total=${evidence.totalCents} ceiling=${ceiling ?? "-"}`);
          return null;
        } catch (error) {
          const c = classify(error);
          console.warn(`[purchase-rehearsal] ${c.refusal ? "RECUSA" : "instável"} ${storeKey} ${order.id} kind=${c.kind} ms=${Date.now() - started}: ${c.detail.slice(0, 200)}`);
          return c.refusal ? { storeKey, storeLabel, kind: c.kind, detail: c.detail.slice(0, 300), skus } : null;
        } finally {
          await session.clearCart().catch(() => undefined);
        }
      })
    ),
    budgetMs(),
    null,
    () => console.warn(`[purchase-rehearsal] orçamento de ${budgetMs()}ms estourou ${order.id} (loja instável, cobra como antes) ms=${Date.now() - startedAll}`)
  );
  if (!results) return null;
  return results.find((r): r is RehearsalFailure => r !== null) ?? null;
}
