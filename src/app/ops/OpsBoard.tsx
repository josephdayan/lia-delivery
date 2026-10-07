"use client";

import { useCallback, useEffect, useState } from "react";
import { PurchaseAccounts, PurchaseReview, type PurchaseReviewJob } from "./PurchaseControl";
import { OfflineSwitch } from "./OfflineSwitch";
import { hasCancelRequest, hasPendingRefund, isCardCharge, isRetailerDeliveryOrder } from "@/lib/order-flags";
import { parseMoneyInput } from "@/lib/pricing";
import { operatorStoreItemUrl } from "@/lib/operator-store-links";

type BasketItem = { qty: number; name: string; lineTotal: number; storeKey?: string; productUrl?: string };
type Fulfillment = {
  storeKey: string;
  storeLabel: string;
  unitLabel?: string;
  unitAddress?: string;
  deliveryFee: number;
  deliveryMode?: string;
  deliveryPromise?: string;
  retailerTotal?: number;
};

type DeliveryOrder = {
  purchaseJobs?: PurchaseReviewJob[];
  manualPurchase?: boolean;
  events?: { id: string; kind: string; deliveryStatus: string; lastError?: string | null; occurredAt: string }[];
  id: string;
  phone: string;
  customerName?: string | null;
  deliveryAddress?: string | null;
  cep?: string | null;
  storeKey?: string | null;
  storeLabel: string;
  storeUnit?: string | null;
  storeAddress?: string | null;
  storeOrderNumber?: string | null;
  items: BasketItem[];
  fulfillments?: Fulfillment[] | null;
  itemsSubtotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  status: string;
  notes?: string | null;
  pixCopiaECola?: string | null;
  courierKey?: string | null;
  courierTrackingUrl?: string | null;
  createdAt: string;
  paidAt?: string | null;
  quoteExpiresAt?: string | null;
  acquisitionTouch?: {
    source: string;
    campaignCode?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    headline?: string | null;
  } | null;
};

type AcquisitionSummary = {
  windowDays: number;
  touches: number;
  conversations: number;
  orders: number;
  paidOrders: number;
  refundedOrders: number;
  retainedRevenue: number;
  groups: Array<{
    key: string;
    conversations: number;
    orders: number;
    paidOrders: number;
    refundedOrders: number;
    retainedRevenue: number;
  }>;
};

type WaitlistRegion = { city: string; uf?: string | null; leads: number; hits: number; lastAt: string };
type WaitlistLead = { id: string; phone: string; cep: string; city?: string | null; uf?: string | null; reason?: string | null; hits: number; updatedAt: string };
type WaitlistData = { total: number; regions: WaitlistRegion[]; recent: WaitlistLead[] };

const COURIER_LABEL: Record<string, string> = {
  retailer_delivery: "entrega do varejista",
  concierge: "motoboy da Lia",
  uber_direct: "Uber Direct",
  lalamove: "Lalamove",
  loggi: "Loggi"
};

const STATUS_LABEL: Record<string, string> = {
  awaiting_operator_quote: "🧮 Cotar (concierge)",
  awaiting_supplier_validation: "🔎 Confirmando carrinho na loja",
  awaiting_quote_confirmation: "⏱️ Cotação enviada — aguardando pagamento",
  payment_issuing: "💳 Gerando pagamento para cliente",
  awaiting_payment: "⏳ Aguardando o cliente pagar (Pix/cartão emitido)",
  paid: "💳 Pago — comprar na loja",
  retailer_preparing: "📦 Loja preparando a entrega",
  retailer_out_for_delivery: "🚚 Saiu para entrega pela loja",
  operator_buying: "🛒 Comprado — em preparação",
  ready_for_pickup: "📦 Pronto — courier autorizado",
  dispatched: "🛵 Saiu pra entrega",
  refund_pending: "↩️ Estorno pendente",
  delivered: "Entregue", refunded: "Estornado", canceled: "Cancelado"
};

// Where the operator double-checks the live price/stock before buying, per store.
// Prefer a real deep link to the exact product (Boticário has these); otherwise search.
// One-click purchase prep: open every item of the order on the store's search page
// (one tab each — the operator only clicks "adicionar" per tab). A true pre-filled
// cart link is blocked by both stores' anti-bot edge (tested live 2026-07-01), so
// tabs + clipboard is the fastest SAFE path today.
function openAllItems(order: DeliveryOrder) {
  for (const it of order.items ?? []) {
    window.open(operatorStoreItemUrl(it, order.storeKey), "_blank", "noopener");
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// A lista copiada é o que o operador confere contra o carrinho da loja. Só "2x Arroz" não
// permite checar valor nem loja — ele teria que voltar ao card item a item. Espelha
// exatamente o que o card mostra (lineTotal), para não existir dois preços diferentes.
function shoppingListText(order: DeliveryOrder): string {
  return (order.items ?? [])
    .map((it) => `${it.qty}x ${it.name} — ${brl(it.lineTotal)}${it.storeKey ? ` (${it.storeKey})` : ""}`)
    .join("\n");
}

// Endereço copiado = o que o checkout da loja pede: quem recebe, onde e um telefone de
// contato para a entrega. Sem o nome e o telefone o operador refazia isso à mão.
function deliveryAddressText(order: DeliveryOrder): string {
  return [order.customerName, order.deliveryAddress, order.cep, order.phone]
    .map((v) => (v ?? "").toString().trim())
    .filter(Boolean)
    .join(" — ");
}

const brl = (v: number) => `R$ ${Number(v ?? 0).toFixed(2).replace(".", ",")}`;

// Idade em dias → horas → minutos (pedido do dono, 04/09: "há 46h05" confundia com hora
// do relógio). Ex.: "há 1d 22h 5min", "há 5h 12min", "há 12min". O absoluto vai no title.
function ageLabel(iso?: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `há ${d}d ${h}h ${m}min`;
  if (h > 0) return `há ${h}h ${m}min`;
  return `há ${m}min`;
}
function absLabel(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OpsBoard() {
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [acquisition, setAcquisition] = useState<AcquisitionSummary | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistData | null>(null);
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  // Financeiro (23/09): valor real pago na loja, lido do comprovante na hora da compra.
  const [paidTotals, setPaidTotals] = useState<Record<string, string>>({});
  const [quotes, setQuotes] = useState<
    Record<string, { itemsSubtotal: string; deliveryFee: string; deliveryMode: string; deliveryPromise: string; etaMinutes: string }>
  >({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [refundReferences, setRefundReferences] = useState<Record<string, string>>({});
  const [refundAmounts, setRefundAmounts] = useState<Record<string, string>>({});
  const [notify, setNotify] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // "owner" enquanto o servidor não responde: o dono nunca perde botão por um piscar de
  // carregamento, e o operador perde os botões no primeiro load (a rota nega de todo jeito).
  // Desconhecido até o servidor responder: o operador chegava a ver a UI de dono por um
  // instante. Enquanto não sabemos, mostramos o painel reduzido — o erro seguro.
  const [role, setRole] = useState<"owner" | "operator" | null>(null);
  const isOwner = role === "owner";
  const [copied, setCopied] = useState<string | null>(null);

  async function copyWithFeedback(key: string, text: string) {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    }
  }

  // On first load, if the URL carries ?key=, exchange it for a long-lived cookie and
  // strip it from the URL — after that the operator just opens /ops (no token in link).
  useEffect(() => {
    (async () => {
      const key = new URLSearchParams(window.location.search).get("key");
      if (key) {
        try {
          await fetch(`/api/ops/login?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        } catch {
          /* ignore — load() will surface auth failures */
        }
        window.history.replaceState({}, "", "/ops");
      }
      setReady(true);
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ops/orders`, { cache: "no-store" });
      if (res.status === 401) {
        setDenied(true);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { orders?: DeliveryOrder[]; role?: "owner" | "operator"; acquisition?: AcquisitionSummary };
        setOrders(data.orders ?? []);
        setAcquisition(data.acquisition ?? null);
        if (data.role) setRole(data.role);
        setDenied(false);
      }
      // Waitlist is best-effort: a failure here must never blank the order queue.
      try {
        const wr = await fetch(`/api/ops/waitlist`, { cache: "no-store" });
        if (wr.ok) setWaitlist((await wr.json()) as WaitlistData);
      } catch {
        /* ignore */
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [ready, load]);

  async function act(
    id: string,
    action: string,
    extra?: {
      storeOrderNumber?: string;
      text?: string;
      trackingUrl?: string;
      recipientName?: string;
      refundReference?: string;
      refundAmount?: number;
      paidTotal?: string;
      itemsSubtotal?: number;
      deliveryFee?: number;
      deliveryMode?: string;
      deliveryPromise?: string;
      etaMinutes?: number;
    }
  ): Promise<boolean> {
    setBusy(`${id}:${action}`);
    try {
      const res = await fetch(`/api/ops/orders/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra })
      });
      if (!res.ok) {
        // A silent failure here means the operator believes something happened that
        // didn't (e.g. "the customer was warned") — always surface it, WITH the reason
        // the server gave (revisão 01/09: antes todo erro virava "confira a sessão").
        const detail = await res
          .json()
          .then((b: { error?: string }) => b?.error)
          .catch(() => undefined);
        alert(
          res.status === 401
            ? "Sessão expirada. Mande \"ops\" pra Lia no WhatsApp e toque no link que ela responder."
            : detail && detail !== "action failed"
              ? `Não deu: ${detail}`
              : `A ação falhou (${res.status}). Tente de novo.`
        );
        await load();
        return false;
      }
      await load();
      return true;
    } catch {
      alert("A ação falhou (sem conexão?). Tente de novo.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function sendNotify(id: string) {
    const text = (notify[id] ?? "").trim();
    if (!text) return;
    const ok = await act(id, "notify", { text });
    // Keep the typed message on failure so the operator can retry.
    if (ok) setNotify((n) => ({ ...n, [id]: "" }));
  }

  if (!ready) return null;
  if (denied) {
    return (
      <p style={{ marginTop: 24, color: "#b42318" }}>
        Acesso negado. Mande <strong>ops</strong> pra Lia no WhatsApp (do número do operador) e toque no
        link que ela responder: o painel abre logado por 1 ano neste aparelho.
        {new URLSearchParams(window.location.search).get("expired") ? " Esse link já venceu (vale 10 minutos) — peça outro." : ""}
        {" "}Alternativa: <code>/ops?key=SEU_TOKEN</code> uma vez.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 20, display: "grid", gap: 14 }}>
      {isOwner && <OfflineSwitch />}
      {isOwner && <PurchaseAccounts />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#667085" }}>Compras e entregas: confira os pedidos que precisam de ação.</span>
        {isOwner && (
          <a href="/ops/catalogo" style={{ color: "#e4002b", fontSize: 13, textDecoration: "none" }}>
            📚 catálogo
          </a>
        )}
        <a href="/ops/faltantes" style={{ color: "#e4002b", fontSize: 13, textDecoration: "none" }} title="Itens que o cliente pediu e não tínhamos, agrupados por pedido">
          🔎 faltantes
        </a>
        {isOwner && (
          <a href="/ops/financeiro" style={{ color: "#e4002b", fontSize: 13, textDecoration: "none" }} title="P&L por pedido: cliente pagou, taxa, custo na loja, sobrou — e CSV pra planilha">
            💰 financeiro
          </a>
        )}
      </div>
      {isOwner && acquisition && (
        <div style={{ ...card, borderColor: "#b7d838", background: "#fbffe9" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#0f3d3a" }}>
            Aquisição · últimos {acquisition.windowDays} dias
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6, fontSize: 13, color: "#475467" }}>
            <span><strong>{acquisition.conversations}</strong> conversas</span>
            <span><strong>{acquisition.orders}</strong> pedidos</span>
            <span><strong>{acquisition.paidOrders}</strong> pagos</span>
            <span><strong>{acquisition.refundedOrders}</strong> estornados/pendentes</span>
            <span><strong>{brl(acquisition.retainedRevenue)}</strong> recebido e não estornado</span>
          </div>
          {acquisition.groups.length > 0 && (
            <div style={{ marginTop: 8, display: "grid", gap: 3, fontSize: 12, color: "#667085" }}>
              {acquisition.groups.slice(0, 8).map((group) => (
                <div key={group.key}>
                  <strong>{group.key}</strong>: {group.conversations} conversas · {group.orders} pedidos · {group.paidOrders} pagos · {brl(group.retainedRevenue)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {loading && <p style={{ color: "#667085" }}>Carregando…</p>}
      {!loading && orders.length === 0 && <p style={{ color: "#667085" }}>Nenhum pedido na fila. 🎉</p>}
      {orders.map((o) => {
        const cancelRequested = hasCancelRequest(o.notes);
        const refundPending = hasPendingRefund(o.notes) || o.status === "refund_pending";
        const urgent = (o.notes ?? "").includes("⚡ URGENTE");
        const isCard = isCardCharge(o);
        const retailerDelivery = isRetailerDeliveryOrder(o);
        const primaryFulfillment = o.fulfillments?.[0];
        const paymentReceived =
          Boolean(o.paidAt) ||
          ["paid", "retailer_preparing", "retailer_out_for_delivery", "operator_buying", "ready_for_pickup", "dispatched"].includes(o.status);
        const quote =
          quotes[o.id] ?? { itemsSubtotal: "", deliveryFee: "", deliveryMode: "retailer_delivery", deliveryPromise: "", etaMinutes: "" };
        const setQuote = (patch: Partial<typeof quote>) => setQuotes((prev) => ({ ...prev, [o.id]: { ...quote, ...patch } }));
        return (
          <div key={o.id} style={{ ...card, ...(cancelRequested ? cancelCard : {}) }}>
            {cancelRequested && (
              <div style={cancelBanner}>⚠️ O cliente pediu CANCELAMENTO — falar com ele antes de comprar/despachar.</div>
            )}
            {refundPending && <div style={refundBanner}>↩️ ESTORNO PENDENTE — só confirmar ao cliente após registrar a referência.</div>}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <strong>
                #{o.id.slice(-6).toUpperCase()}{" "}
                <span title={`${o.paidAt ? "pago em" : "criado em"} ${absLabel(o.paidAt ?? o.createdAt)}`} style={{ color: "#98a2b3", fontWeight: 400, fontSize: 12 }}>{ageLabel(o.paidAt ?? o.createdAt)}</span>
              </strong>
              <span>
                {urgent && <span style={urgentBadge}>⚡ quer HOJE</span>}{" "}
                <span style={badge}>{STATUS_LABEL[o.status] ?? o.status}</span>{" "}
                <span style={payBadge}>{isCard ? "💳 cartão" : "⚡ Pix"}</span>
                {o.acquisitionTouch && (
                  <span style={sourceBadge} title={o.acquisitionTouch.headline ?? "Origem do anúncio"}>
                    anúncio · {o.acquisitionTouch.campaignCode ?? o.acquisitionTouch.sourceId?.slice(-10) ?? "Meta"}
                  </span>
                )}
              </span>
            </div>
            {(o.manualPurchase || o.purchaseJobs?.some(j => j.status === "manual_queue")) && (
              <div style={manualBanner}>🛒 COMPRA MANUAL — esta loja/cesta não tem execução automática: compre no site e registre o número abaixo.</div>
            )}
            <div style={{ color: "#475467", fontSize: 14, marginTop: 6 }}>
              {o.customerName ?? o.phone}{" "}
              {paymentReceived && (
                <button
                  style={{ ...smallBtn, marginLeft: 6 }}
                  disabled={busy === `${o.id}:set_recipient`}
                  onClick={() => {
                    const recipientName = window.prompt("Nome de quem recebe (vai na etiqueta da loja):", o.customerName ?? "") ?? "";
                    if (recipientName.trim() && recipientName.trim() !== o.customerName) void act(o.id, "set_recipient", { recipientName });
                  }}
                  title="Nome que vai na etiqueta da loja — corrija se o cliente mandou errado"
                >
                  {o.customerName ? "✏️ corrigir destinatário" : "✏️ definir destinatário"}
                </button>
              )}
              {isOwner && (
                <a
                  href={`https://wa.me/${o.phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: "#0f3d3a" }}
                  title="Abrir conversa no WhatsApp"
                >
                  💬 WhatsApp
                </a>
              )}{" "}
              · {o.deliveryAddress ?? o.cep ?? "endereço pendente"}
            </div>
            <ul style={{ margin: "10px 0", paddingLeft: 18 }}>
              {(o.items ?? []).map((it, i) => (
                <li key={i} style={{ fontSize: 14 }}>
                  {it.qty}x {it.name} — {brl(it.lineTotal)}{" "}
                  <a
                    href={operatorStoreItemUrl(it, o.storeKey)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: "#0f3d3a" }}
                    title={it.productUrl ? "Abrir o produto exato na loja" : "Conferir preço/estoque real na loja"}
                  >
                    🔎 ver
                  </a>
                </li>
              ))}
            </ul>
            <div style={{ fontSize: 13, color: "#475467" }}>
              Custo {o.storeLabel} {brl(o.itemsSubtotal)} · Frete {brl(o.deliveryFee)}
              {o.courierKey ? ` (${COURIER_LABEL[o.courierKey] ?? o.courierKey})` : ""} · Margem {brl(o.serviceFee)} ·{" "}
              <strong>Cliente pagou {brl(o.total)}</strong>
            </div>
            {retailerDelivery && (
              <div style={{ fontSize: 13, color: "#475467", marginTop: 4 }}>
                🚚 <strong>{o.storeLabel} entrega diretamente ao cliente</strong>
                {primaryFulfillment?.deliveryPromise ? ` · ${primaryFulfillment.deliveryPromise}` : " · prazo pendente"}
                {o.quoteExpiresAt && o.status === "awaiting_quote_confirmation"
                  ? ` · cotação válida até ${new Date(o.quoteExpiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </div>
            )}
            {(o.fulfillments?.length ?? 0) > 1 ? (
              <div style={{ fontSize: 13, color: "#667085", marginTop: 4 }}>
                {o.fulfillments!.map((f) => (
                  <div key={`${f.storeKey}:${f.unitLabel ?? f.deliveryMode ?? "primary"}`}>
                    🏬 <strong>{f.storeLabel}</strong>
                    {f.deliveryMode === "retailer_delivery"
                      ? ` entrega · ${f.deliveryPromise ?? "prazo pendente"}`
                      : `: ${f.unitLabel ?? "unidade pendente"}${f.unitAddress ? ` — ${f.unitAddress}` : ""}`}
                    {` · frete ${brl(f.deliveryFee)}`}
                  </div>
                ))}
              </div>
            ) : null}
            {o.events?.length ? <div style={{ marginTop: 8, fontSize: 12 }}>
              <strong>Avisos ao cliente</strong>
              {o.events.map(e => <div key={e.id}>
                {{ bought: "Compra", out_for_delivery: "Saiu para entrega", delivered: "Entrega" }[e.kind] ?? e.kind}: {{ pending: "aguarda envio", sending: "enviando", accepted: "aceito pelo WhatsApp, sem recibo", delivered: "mensagem entregue", read: "mensagem lida", failed: "falhou — revisar", unknown: "envio incerto — revisar antes de reenviar", suppressed: "aviso antigo dispensado" }[e.deliveryStatus] ?? e.deliveryStatus}
                {e.lastError ? <span style={{ color: "#b54708" }}> · {e.lastError}</span> : null}
              </div>)}
            </div> : null}
            {isOwner && o.purchaseJobs?.map(job => <PurchaseReview key={job.id} job={job} refresh={() => { void load(); }} />)}
            {o.notes && <div style={{ fontSize: 12, color: "#98a2b3", marginTop: 4, whiteSpace: "pre-wrap" }}>{o.notes}</div>}

            {o.status === "awaiting_operator_quote" && (
              <div style={quoteBox}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#0f3d3a" }}>🧮 Cotar e enviar ao cliente</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    placeholder="custo produtos R$"
                    inputMode="decimal"
                    value={quote.itemsSubtotal}
                    onChange={(e) => setQuote({ itemsSubtotal: e.target.value })}
                    style={{ ...input, minWidth: 140 }}
                  />
                  <input
                    placeholder="frete R$"
                    inputMode="decimal"
                    value={quote.deliveryFee}
                    onChange={(e) => setQuote({ deliveryFee: e.target.value })}
                    style={{ ...input, minWidth: 110 }}
                  />
                  <select value={quote.deliveryMode} onChange={(e) => setQuote({ deliveryMode: e.target.value })} style={{ ...input, minWidth: 180 }}>
                    <option value="retailer_delivery">🚚 entrega do varejista</option>
                  </select>
                  <input
                    placeholder="prazo (ex.: hoje até 19h)"
                    value={quote.deliveryPromise}
                    onChange={(e) => setQuote({ deliveryPromise: e.target.value })}
                    style={{ ...input, minWidth: 200 }}
                  />
                  <input
                    placeholder="ETA min"
                    inputMode="numeric"
                    value={quote.etaMinutes}
                    onChange={(e) => setQuote({ etaMinutes: e.target.value })}
                    style={{ ...input, minWidth: 90 }}
                  />
                  <button
                    style={primary}
                    disabled={
                      busy === `${o.id}:publish_quote` ||
                      !((parseMoneyInput(quote.itemsSubtotal) ?? 0) > 0) ||
                      (quote.deliveryFee.trim() !== "" && parseMoneyInput(quote.deliveryFee) == null)
                    }
                    onClick={() =>
                      act(o.id, "publish_quote", {
                        // "12,90" (teclado pt-BR) era NaN → frete R$ 0 cobrado do cliente.
                        itemsSubtotal: parseMoneyInput(quote.itemsSubtotal) ?? 0,
                        deliveryFee: parseMoneyInput(quote.deliveryFee) ?? 0,
                        deliveryMode: quote.deliveryMode,
                        deliveryPromise: quote.deliveryPromise.trim() || undefined,
                        etaMinutes: quote.etaMinutes ? Number(quote.etaMinutes) : undefined
                      })
                    }
                  >
                    Enviar cotação ao cliente
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "#667085" }}>
                  A margem entra sozinha por faixa (10% até R$ 200; 6%, 4% e 3% nas fatias acima). O cliente aprova e paga por Pix/cartão; nada é cobrado antes.
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
              {o.status === "paid" && (
                <>
                  <button
                    style={secondary}
                    onClick={() => openAllItems(o)}
                    title="Abre uma aba por item, já na busca da loja — é só clicar em adicionar em cada uma. Se só abrir 1 aba, permita pop-ups deste site."
                  >
                    🛒 Abrir itens na loja ({(o.items ?? []).length})
                  </button>
                  <button style={secondary} onClick={() => void copyWithFeedback(`${o.id}:list`, shoppingListText(o))}>
                    {copied === `${o.id}:list` ? "✅ copiado" : "📋 Copiar lista"}
                  </button>
                  {(o.deliveryAddress || o.cep) && (
                    <button
                      style={secondary}
                      onClick={() =>
                        void copyWithFeedback(`${o.id}:addr`, deliveryAddressText(o))
                      }
                      title="Quem recebe, endereço, CEP e telefone — o que o checkout da loja pede"
                    >
                      {copied === `${o.id}:addr` ? "✅ copiado" : "📍 Copiar endereço"}
                    </button>
                  )}
                </>
              )}
              {o.status === "paid" && (
                <>
                  <input
                    placeholder="nº do pedido na loja"
                    value={numbers[o.id] ?? ""}
                    onChange={(e) => setNumbers((n) => ({ ...n, [o.id]: e.target.value }))}
                    style={input}
                  />
                  {/* Link de acompanhamento colado JÁ na compra (a página do pedido no ML
                      está aberta nessa hora): o cliente recebe junto com o aviso de compra
                      e passa a ver o andamento na fonte, sem depender de marcação nossa. */}
                  <input
                    placeholder="link https de acompanhamento (opcional)"
                    value={tracking[o.id] ?? ""}
                    onChange={(e) => setTracking((current) => ({ ...current, [o.id]: e.target.value }))}
                    style={{ ...input, minWidth: 240 }}
                    title="Cole aqui a página do pedido na loja (ex.: Mercado Livre). A Lia manda esse link pro cliente ao avisar da compra."
                  />
                  {/* Financeiro (23/09): o total do comprovante (produtos + frete) entra aqui,
                      na hora em que está na tela. Opcional: sem ele o P&L usa a cotação e
                      marca "custo estimado" até alguém registrar. */}
                  <input
                    placeholder="total pago na loja R$ (opcional)"
                    inputMode="decimal"
                    value={paidTotals[o.id] ?? ""}
                    onChange={(e) => setPaidTotals((current) => ({ ...current, [o.id]: e.target.value }))}
                    style={{ ...input, minWidth: 200 }}
                    title="Quanto saiu de verdade no checkout da loja, produtos + frete. Vai pro financeiro do pedido."
                  />
                  <button
                    style={primary}
                    disabled={busy === `${o.id}:bought` || (paidTotals[o.id]?.trim() !== "" && paidTotals[o.id] != null && parseMoneyInput(paidTotals[o.id]) == null)}
                    onClick={() =>
                      act(o.id, "bought", {
                        storeOrderNumber: numbers[o.id] ?? "",
                        trackingUrl: tracking[o.id] ?? "",
                        paidTotal: paidTotals[o.id]?.trim() || undefined
                      })
                    }
                  >
                    Confirmar compra na loja
                  </button>
                  <button
                    style={ghost}
                    disabled={busy === `${o.id}:purchase_failed_refund`}
                    title="Sem estoque, loja não entrega no CEP, mínimo da loja… Estorna pelo provedor e explica ao cliente com o motivo."
                    onClick={() => {
                      const reason = window.prompt(
                        "Não consegui comprar — motivo curto para o cliente (ex.: 'sem estoque para o seu endereço'):",
                        ""
                      );
                      if (reason === null) return;
                      if (window.confirm(`Estornar ${o.total.toFixed(2).replace(".", ",")} pelo provedor e avisar o cliente?`)) {
                        void act(o.id, "purchase_failed_refund", { text: reason });
                      }
                    }}
                  >
                    ↩️ Não consegui comprar → estornar
                  </button>
                </>
              )}
              {retailerDelivery && (o.status === "retailer_preparing" || o.status === "operator_buying") && (
                <>
                  <input
                    placeholder="link https de rastreio (se houver)"
                    value={tracking[o.id] ?? ""}
                    onChange={(e) => setTracking((current) => ({ ...current, [o.id]: e.target.value }))}
                    style={{ ...input, minWidth: 240 }}
                  />
                  <button
                    style={primary}
                    disabled={busy === `${o.id}:retailer_out_for_delivery`}
                    onClick={() =>
                      act(o.id, "retailer_out_for_delivery", { trackingUrl: tracking[o.id] ?? "" })
                    }
                  >
                    🚚 Loja saiu para entrega
                  </button>
                </>
              )}
              {(o.status === "retailer_out_for_delivery" || o.status === "dispatched") && (
                <>
                  {o.courierTrackingUrl && (
                    <a href={o.courierTrackingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                      rastreio
                    </a>
                  )}
                  <button style={primary} disabled={busy === `${o.id}:delivered`} onClick={() => act(o.id, "delivered")}>
                    Marcar entregue
                  </button>
                </>
              )}
              {!isOwner ? (
                // Operador contratado: dinheiro que SAI (cancelar pedido, concluir
                // estorno) é decisão do dono. "Não consegui comprar → estornar" fica com
                // ele logo acima: é a saída honesta quando a loja falha e o valor volta
                // pro cliente. A rota nega de novo no servidor.
                (o.status === "refund_pending" || paymentReceived) && (
                  <span style={{ fontSize: 13, color: "#667085" }}>
                    {o.status === "refund_pending"
                      ? "↩️ Estorno em aberto — quem conclui é o responsável pela operação."
                      : "Precisa cancelar este pedido pago? Chame o responsável pela operação."}
                  </span>
                )
              ) : o.status === "refund_pending" ? (
                <>
                  <input
                    placeholder="referência do estorno no provedor"
                    value={refundReferences[o.id] ?? ""}
                    onChange={(e) =>
                      setRefundReferences((current) => ({ ...current, [o.id]: e.target.value }))
                    }
                    style={{ ...input, minWidth: 240 }}
                  />
                  <input
                    inputMode="decimal"
                    placeholder="valor estornado (vazio = total)"
                    value={refundAmounts[o.id] ?? ""}
                    onChange={(e) =>
                      setRefundAmounts((current) => ({ ...current, [o.id]: e.target.value }))
                    }
                    style={{ ...input, width: 190 }}
                  />
                  <button
                    style={primary}
                    disabled={busy === `${o.id}:confirm_refund` || !(refundReferences[o.id] ?? "").trim()}
                    onClick={() => {
                      if (
                        window.confirm(
                          "O provedor já confirmou o estorno? Esta ação avisará o cliente."
                        )
                      ) {
                        void act(o.id, "confirm_refund", {
                          refundReference: refundReferences[o.id] ?? "",
                          refundAmount: parseMoneyInput(refundAmounts[o.id]) ?? undefined
                        });
                      }
                    }}
                  >
                    ✅ Confirmar estorno concluído
                  </button>
                  <button
                    style={primary}
                    disabled={busy === `${o.id}:refund_provider`}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Estornar AGORA pelo provedor (Mercado Pago/Pagar.me)? O valor volta ao cliente e a referência entra sozinha. Vazio = total."
                        )
                      ) {
                        void act(o.id, "refund_provider", { refundAmount: parseMoneyInput(refundAmounts[o.id]) ?? undefined });
                      }
                    }}
                  >
                    ↩️ Estornar pelo provedor
                  </button>
                </>
              ) : !paymentReceived ? (
                <button
                  style={ghost}
                  disabled={busy === `${o.id}:cancel`}
                  onClick={() => {
                    if (window.confirm("Cancelar este pedido sem pagamento?")) void act(o.id, "cancel");
                  }}
                >
                  Cancelar pedido
                </button>
              ) : (
                // Ação EXCEPCIONAL do operador (o cliente não cancela pós-pago pelo chat):
                // abre refund_pending; o estorno real é feito no provedor e confirmado
                // com a referência. O botão tinha sumido em 02/08 e o runbook seguia
                // mandando clicar nele (revisão 01/09).
                <button
                  style={ghost}
                  disabled={busy === `${o.id}:cancel`}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Cancelar este pedido PAGO e abrir o estorno? O cliente será avisado agora; o estorno em si é feito no Mercado Pago/Pagar.me e confirmado depois com a referência."
                      )
                    )
                      void act(o.id, "cancel");
                  }}
                >
                  ↩️ Cancelar e solicitar estorno
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                placeholder='avisar cliente (ex.: "o arroz acabou; vou estornar esse item")'
                value={notify[o.id] ?? ""}
                onChange={(e) => setNotify((n) => ({ ...n, [o.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void sendNotify(o.id);
                }}
                style={{ ...input, flex: 1, minWidth: 240 }}
              />
              <button style={secondary} disabled={busy === `${o.id}:notify`} onClick={() => void sendNotify(o.id)}>
                Enviar 💬
              </button>
            </div>
          </div>
        );
      })}

      {isOwner && waitlist && waitlist.total > 0 && (
        <div style={waitCard}>
          <button style={waitHeader} onClick={() => setShowWaitlist((v) => !v)}>
            <span>
              📍 Lista de espera — <strong>{waitlist.total}</strong> fora da área
              {waitlist.regions[0] && waitlist.regions[0].city !== "—" ? ` · +pedida: ${waitlist.regions[0].city} (${waitlist.regions[0].leads})` : ""}
            </span>
            <span style={{ color: "#98a2b3" }}>{showWaitlist ? "▲ ocultar" : "▼ ver demanda"}</span>
          </button>

          {showWaitlist && (
            <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
              <div>
                <div style={waitSubtitle}>Onde tem gente pedindo (expanda por aqui)</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {waitlist.regions.map((r, i) => (
                    <span key={i} style={regionChip}>
                      {r.city === "—" ? "cidade?" : r.city}
                      {r.uf ? `/${r.uf}` : ""} · <strong>{r.leads}</strong>
                      {r.hits > r.leads ? ` (${r.hits} pedidos)` : ""}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div style={waitSubtitle}>Últimos contatos</div>
                <div style={{ display: "grid", gap: 4 }}>
                  {waitlist.recent.map((l) => (
                    <div key={l.id} style={{ fontSize: 13, color: "#475467" }}>
                      <span style={l.reason === "too_far" ? reasonFar : reasonOut}>
                        {l.reason === "too_far" ? "longe" : "fora"}
                      </span>{" "}
                      {l.city ?? "cidade?"}
                      {l.uf ? `/${l.uf}` : ""} · {l.cep} ·{" "}
                      <a href={`https://wa.me/${l.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" style={{ color: "#0f3d3a" }}>
                        💬 {l.phone}
                      </a>
                      {l.hits > 1 ? ` · ${l.hits}×` : ""} · {ageLabel(l.updatedAt)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid #e4e7ec", borderRadius: 12, padding: 16, background: "#fff" };
const cancelCard: React.CSSProperties = { border: "2px solid #f04438", background: "#fffbfa" };
const cancelBanner: React.CSSProperties = {
  background: "#fee4e2",
  color: "#b42318",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13,
  marginBottom: 10,
  fontWeight: 600
};
const smallBtn: React.CSSProperties = { fontSize: 11, padding: "2px 8px", border: "1px solid #d0d5dd", borderRadius: 6, background: "#fff", cursor: "pointer" };
const manualBanner: React.CSSProperties = { background: "#fff7e6", border: "1px solid #f0c36d", color: "#7a4b00", padding: "6px 10px", borderRadius: 8, fontSize: 12, marginBottom: 8 };
const refundBanner: React.CSSProperties = {
  background: "#fff4e5",
  color: "#93370d",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13,
  marginBottom: 10,
  fontWeight: 600
};
const badge: React.CSSProperties = { fontSize: 12, color: "#0f3d3a", background: "#d6fbf4", borderRadius: 999, padding: "2px 10px" };
// Urgência: o cliente falou "urgente"/"pra hoje" — decide o canal da compra (Rappi/
// retirada agora vs. ML/dia seguinte). Laranja para saltar aos olhos na fila.
const urgentBadge: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#93370d", background: "#ffead5", borderRadius: 999, padding: "2px 10px" };
const payBadge: React.CSSProperties = { fontSize: 12, color: "#475467", background: "#f2f4f7", borderRadius: 999, padding: "2px 10px" };
const sourceBadge: React.CSSProperties = { fontSize: 12, color: "#175cd3", background: "#eff8ff", borderRadius: 999, padding: "2px 10px", marginLeft: 4 };
const input: React.CSSProperties = { padding: "8px 10px", border: "1px solid #d0d5dd", borderRadius: 8, fontSize: 14, minWidth: 180 };
const primary: React.CSSProperties = { padding: "8px 14px", background: "#0f3d3a", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer" };
const secondary: React.CSSProperties = { padding: "8px 14px", background: "#eef2f1", color: "#0f3d3a", border: "1px solid #d0d5dd", borderRadius: 8, fontSize: 14, cursor: "pointer" };
const waitCard: React.CSSProperties = { border: "1px dashed #d0d5dd", borderRadius: 12, padding: 16, background: "#fcfcfd" };
const waitHeader: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, width: "100%", background: "none", border: "none", padding: 0, fontSize: 14, color: "#344054", cursor: "pointer", textAlign: "left" };
const waitSubtitle: React.CSSProperties = { fontSize: 12, color: "#98a2b3", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" };
const regionChip: React.CSSProperties = { fontSize: 13, color: "#0f3d3a", background: "#eef2f1", border: "1px solid #e4e7ec", borderRadius: 999, padding: "3px 10px" };
const reasonOut: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: "#93370d", background: "#fef0c7", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" };
const reasonFar: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: "#5925dc", background: "#ebe9fe", borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" };
const ghost: React.CSSProperties = { padding: "8px 12px", background: "transparent", color: "#b42318", border: "1px solid #fda29b", borderRadius: 8, fontSize: 13, cursor: "pointer" };
const quoteBox: React.CSSProperties = { marginTop: 10, padding: 10, border: "1px dashed #0f3d3a", borderRadius: 8, background: "#f2fbf9", display: "grid", gap: 8 };
