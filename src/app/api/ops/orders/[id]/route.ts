import { NextResponse } from "next/server";
import { isAgentRequest, opsOrderActionDenied, opsRole, requireOpsKey } from "@/lib/auth";
import { parseMoneyInput } from "@/lib/pricing";
import {
  opsCancelRefund,
  opsConfirmRefund,
  opsMarkBought,
  opsMarkDelivered,
  opsMarkRetailerOutForDelivery,
  opsNotifyCustomer,
  opsPublishManualQuote,
  opsRefundViaProvider,
  opsPurchaseFailedRefund,
  opsSetRecipient,
  opsSetStoreCost
} from "@/lib/delivery-service";

export const dynamic = "force-dynamic";

// Guarda compartilhada (src/lib/auth.ts): fail-closed em deploy, tempo constante,
// cookie HMAC. `?key=` continua aceito só por compatibilidade com scripts do operador.
function authed(request: Request) {
  return requireOpsKey(request, { allowQuery: true }) === null;
}

// 15/09/2026 — operador contratado: ele compra, avisa e fecha o pedido. O que move
// dinheiro por decisão (cancelar um pedido pago, estornar à mão, registrar referência de
// estorno) continua sendo do dono. "Não consegui comprar → estornar" fica com ele de
// propósito: é a saída honesta quando a loja falha, e o valor volta para o CLIENTE — não
// há para onde desviar. Sem OPS_OPERATOR_TOKEN não existe operador e nada muda.
// A lista e a regra do agente (sem ações de dinheiro) vivem em opsOrderActionDenied (auth.ts).

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    storeOrderNumber?: string;
    text?: string;
    trackingUrl?: string;
    recipientName?: string;
    refundReference?: string;
    refundAmount?: number | string;
    // Financeiro (23/09): valor real pago na loja (produtos + frete), do comprovante.
    paidTotal?: number | string;
    itemsSubtotal?: number | string;
    deliveryFee?: number | string;
    deliveryMode?: "operator_courier" | "retailer_delivery";
    deliveryPromise?: string;
    etaMinutes?: number | string;
  };
  const id = params.id;
  if (opsOrderActionDenied(body.action, opsRole(request, { allowQuery: true }), isAgentRequest(request))) {
    return NextResponse.json({ error: "Essa ação é do dono da operação. Avise pelo WhatsApp." }, { status: 403 });
  }
  try {
    switch (body.action) {
      case "publish_quote": {
        // Dinheiro digitado ("27,90") é validado aqui também — o servidor nunca confia
        // no Number() do cliente (revisão 01/09: vírgula virava frete zero).
        const itemsSubtotal = parseMoneyInput(body.itemsSubtotal);
        const deliveryFee = body.deliveryFee == null || body.deliveryFee === "" ? 0 : parseMoneyInput(body.deliveryFee);
        if (itemsSubtotal == null || itemsSubtotal <= 0) {
          return NextResponse.json({ error: "Custo dos produtos inválido (ex.: 27,90)." }, { status: 400 });
        }
        if (deliveryFee == null || deliveryFee < 0) {
          return NextResponse.json({ error: "Frete inválido (ex.: 12,90)." }, { status: 400 });
        }
        await opsPublishManualQuote(id, {
          itemsSubtotal,
          deliveryFee,
          deliveryMode: body.deliveryMode,
          deliveryPromise: body.deliveryPromise?.toString().trim() || undefined,
          etaMinutes: body.etaMinutes != null && body.etaMinutes !== "" ? Number(body.etaMinutes) : undefined
        });
        break;
      }
      case "bought": {
        const paidTotal = body.paidTotal == null || body.paidTotal === "" ? undefined : parseMoneyInput(body.paidTotal);
        if (paidTotal === null || (paidTotal != null && paidTotal < 0)) {
          return NextResponse.json({ error: "Valor pago na loja inválido (ex.: 87,90)." }, { status: 400 });
        }
        await opsMarkBought(id, String(body.storeOrderNumber ?? "").trim(), body.trackingUrl, paidTotal);
        break;
      }
      case "set_store_cost": {
        const paidTotal = parseMoneyInput(body.paidTotal);
        if (paidTotal == null || paidTotal < 0) {
          return NextResponse.json({ error: "Valor pago na loja inválido (ex.: 87,90)." }, { status: 400 });
        }
        await opsSetStoreCost(id, paidTotal);
        break;
      }
      case "set_recipient":
        await opsSetRecipient(id, String(body.recipientName ?? ""));
        break;
      case "retailer_out_for_delivery":
        await opsMarkRetailerOutForDelivery(id, body.trackingUrl);
        break;
      case "delivered":
        await opsMarkDelivered(id);
        break;
      case "cancel":
        await opsCancelRefund(id);
        break;
      case "purchase_failed_refund": {
        await opsPurchaseFailedRefund(id, String(body.text ?? "").trim() || undefined);
        break;
      }
      case "refund_provider": {
        const refundAmount = body.refundAmount == null || body.refundAmount === "" ? undefined : parseMoneyInput(body.refundAmount);
        if (refundAmount === null) return NextResponse.json({ error: "Valor do estorno inválido (ex.: 12,90)." }, { status: 400 });
        await opsRefundViaProvider(id, refundAmount);
        break;
      }
      case "confirm_refund": {
        const refundAmount = body.refundAmount == null || body.refundAmount === "" ? undefined : parseMoneyInput(body.refundAmount);
        if (refundAmount === null) return NextResponse.json({ error: "Valor do estorno inválido (ex.: 12,90)." }, { status: 400 });
        await opsConfirmRefund(id, String(body.refundReference ?? ""), refundAmount);
        break;
      }
      case "notify": {
        const text = String(body.text ?? "").trim();
        // Client-input problem, not a server failure — answer 400, not 500.
        if (!text) return NextResponse.json({ error: "empty text" }, { status: 400 });
        await opsNotifyCustomer(id, text);
        break;
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[ops:action:error]", id, body.action, error);
    // Erros de domínio ("o pedido mudou de estado", "informe a referência") são a
    // orientação que o operador precisa LER — não um 500 mudo (revisão 01/09).
    const message =
      error instanceof Error && error.message && !/prisma|ECONN|timed? ?out|ETIMEDOUT/i.test(error.message)
        ? error.message.slice(0, 200)
        : "action failed";
    return NextResponse.json({ ok: false, error: message }, { status: message === "action failed" ? 500 : 409 });
  }
}
