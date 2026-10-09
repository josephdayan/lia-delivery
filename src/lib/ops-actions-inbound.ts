// Ramificação do webhook para o telefone do operador (11/09): botões `op1.…` e, quando há
// uma pergunta pendente de número do pedido, a próxima mensagem numérica. Qualquer outra
// mensagem do operador segue o fluxo normal (ele também é cliente da Lia).
import { prisma } from "./prisma";
import { isAdminPhone, phoneRole } from "./turn-runtime";
import { parseOfflineCommand, setOfflineMode } from "./offline-mode";
import { parseStoreToggleCommand, pauseStore, resumeStore } from "./store-pause";
import { whatsappAdapter } from "./adapters/whatsapp";
import { parseOpsActionButton, consumeOpsAction, mirrorOpsAction } from "./ops-actions";
import { ownerConfirmCartBought, ownerDeclineCart, ownerStoreNumber, approveCheckout, refuseReceiver, retryAfterPixFailure, approveReceiverAndPay, heldPixCode } from "./purchase-execution";
import { opsPurchaseFailedRefund } from "./ops-lifecycle";
import { createOpsAction } from "./ops-actions";
import * as copy from "./lia-copy";
import { listStores } from "./stores";

// Rótulo da loja do job. Sem `getStore` de propósito: ele cai numa loja PADRÃO quando a
// chave é desconhecida, e um nome errado é pior que nenhum numa mensagem de operação.
function storeLabelOf(storeKey: string | null | undefined): string {
  return listStores().find((store) => store.key === storeKey)?.label ?? String(storeKey ?? "");
}

const STORE_NUMBER_RE = /^#?\s*(\d{6,20})\s*$/;

export async function handleOperatorInbound(phone: string, text: string): Promise<"handled" | "ignored"> {
  if (!isAdminPhone(phone)) return "ignored";
  const offline = parseOfflineCommand(text);
  if (offline !== null && phoneRole(phone) === "owner") {
    await setOfflineMode(offline, `wa:${phone}`);
    await reply(phone, copy.ownerOfflineToggled(offline));
    return "handled";
  }
  // "lia loja drogal on|off" (09/10): religa ou tira uma loja da vitrine. Só o dono.
  const toggle = parseStoreToggleCommand(text);
  if (toggle && phoneRole(phone) === "owner") {
    if (toggle.on) await resumeStore(toggle.storeKey, `wa:${phone}`);
    else await pauseStore(toggle.storeKey, "pausada pelo dono", `wa:${phone}`);
    await reply(phone, copy.ownerStoreToggled(toggle.storeKey, toggle.on));
    return "handled";
  }
  const button = parseOpsActionButton(text);
  if (button) {
    await runOperatorButton(phone, button);
    return "handled";
  }
  const number = text.trim().match(STORE_NUMBER_RE);
  if (!number) return "ignored";
  const pending = await prisma.opsAction.findFirst({
    where: { kind: "await_store_number", status: "pending", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!pending?.purchaseJobId) return "ignored";
  try {
    const action = await prisma.$transaction(async (tx) => {
      const consumed = await consumeOpsAction(tx, { id: pending.id, choice: "number", by: `wa:${phone}`, expectKind: "await_store_number" });
      await mirrorOpsAction(tx, consumed, `number ${number[1]}`, `wa:${phone}`);
      return consumed;
    });
    const job = await ownerStoreNumber(pending.purchaseJobId, number[1], action.id);
    await reply(phone, copy.operatorStoreNumberSaved(job.deliveryOrderId.slice(-6).toUpperCase(), number[1], storeLabelOf(job.storeKey)));
  } catch (error) {
    await reply(phone, copy.operatorActionFailed(error instanceof Error ? error.message : "falha"));
  }
  return "handled";
}

async function runOperatorButton(phone: string, button: { id: string; choice: string; sig: string }) {
  try {
    const action = await prisma.$transaction(async (tx) => {
      const consumed = await consumeOpsAction(tx, { id: button.id, choice: button.choice, sig: button.sig, by: `wa:${phone}` });
      await mirrorOpsAction(tx, consumed, button.choice, `wa:${phone}`);
      return consumed;
    });
    if (action.kind === "ml_cart_ready" && action.purchaseJobId) {
      if (button.choice === "bought") {
        const job = await ownerConfirmCartBought(action.purchaseJobId, action.id);
        await reply(phone, copy.operatorAskStoreNumber(job.deliveryOrderId.slice(-6).toUpperCase(), storeLabelOf(job.storeKey)));
        return;
      }
      if (button.choice === "failed") {
        const job = await ownerDeclineCart(action.purchaseJobId, action.id);
        await reply(phone, copy.operatorCartDeclined(job.deliveryOrderId.slice(-6).toUpperCase()));
        return;
      }
    }
    if (action.purchaseJobId) {
      const job = await prisma.purchaseJob.findUniqueOrThrow({ where: { id: action.purchaseJobId } });
      const shortId = job.deliveryOrderId.slice(-6).toUpperCase();
      // Recebedor novo: "pagar" precisa do copia-e-cola, que só o navegador tem. O toque
      // aprova o recebedor; o comprador (que está esperando com o modal aberto) paga.
      if (action.kind === "receiver_new") {
        if (button.choice === "pay") {
          await prisma.purchaseReceiver.updateMany({ where: { storeKey: job.storeKey, status: "pending", receiverDoc: String((action.payload as { receiverDoc?: string } | null)?.receiverDoc ?? "") }, data: { status: "approved", approvedBy: `wa:${phone}`, approvedAt: new Date() } });
          // Comprador no servidor (25/09): o código ficou guardado; paga aqui mesmo, uma vez.
          const held = await heldPixCode(job.id);
          if (held) {
            const paid = await approveReceiverAndPay(job.id, held, `wa:${phone}`);
            await reply(phone, paid.status === "paid" || paid.status === "submitted" ? copy.operatorReceiverApproved(shortId) : copy.operatorPixFailed(shortId, paid.status));
            return;
          }
          await reply(phone, copy.operatorReceiverApproved(shortId));
          return;
        }
        await refuseReceiver(job.id, `wa:${phone}`);
        await reply(phone, copy.operatorCartDeclined(shortId));
        return;
      }
      if (action.kind === "pix_failed") {
        if (button.choice === "retry") { await retryAfterPixFailure(job.id, `wa:${phone}`); await reply(phone, copy.operatorRetryQueued(shortId)); return; }
        await opsPurchaseFailedRefund(job.deliveryOrderId, "pagamento à loja não concluído");
        await reply(phone, copy.operatorRefundDone(shortId));
        return;
      }
      if (action.kind === "store_silent") {
        if (button.choice === "confirm") {
          await prisma.$transaction((tx) => createOpsAction(tx, { kind: "await_store_number", purchaseJobId: job.id, deliveryOrderId: job.deliveryOrderId, payload: { from: action.id } }));
          await reply(phone, copy.operatorAskStoreNumber(shortId, storeLabelOf(job.storeKey)));
          return;
        }
        await opsPurchaseFailedRefund(job.deliveryOrderId, "loja não confirmou o pedido");
        await reply(phone, copy.operatorRefundDone(shortId));
        return;
      }
      if (action.kind === "over_limit") {
        if (button.choice === "approve") {
          const hash = String((action.payload as { checkoutHash?: string } | null)?.checkoutHash ?? "");
          await approveCheckout(job.id, hash);
          await reply(phone, copy.operatorApproved(shortId));
          return;
        }
        await opsPurchaseFailedRefund(job.deliveryOrderId, "compra não autorizada");
        await reply(phone, copy.operatorRefundDone(shortId));
        return;
      }
    }
    await reply(phone, copy.operatorActionUnknown());
  } catch (error) {
    await reply(phone, copy.operatorActionFailed(error instanceof Error ? error.message : "falha"));
  }
}

async function reply(phone: string, text: string) {
  try {
    await whatsappAdapter.sendMessage(phone, text);
  } catch (error) {
    console.warn("[ops-action:reply-failed]", error instanceof Error ? error.message : error);
  }
}
