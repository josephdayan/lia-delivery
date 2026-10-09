// Linha de teste em produção (09/10): dentro da captura nada sai pra Meta e cobrança é recusada.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnScoped, turnMeta } from "../src/lib/turn-runtime";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { pixAdapter, checkoutAdapter } from "../src/lib/payments/mercadopago";
import { isTestLinePhone, testLineCapture, TestLineChargeBlocked, type CapturedSend } from "../src/lib/test-line";

const PHONE = "+5500995000001";

test("linha de teste: envios são capturados (cliente e dono) e contam como resposta", async () => {
  const out: CapturedSend[] = [];
  const replies = await testLineCapture.run({ phone: PHONE, out }, () =>
    runTurnScoped(async () => {
      turnMeta.getStore()!.phone = PHONE;
      await whatsappAdapter.sendMessage(PHONE, "oi");
      await whatsappAdapter.sendDeliveryChoices(PHONE, []);
      await whatsappAdapter.sendMessage("+5511999999999", "aviso ao dono");
      return turnMeta.getStore()!.replies;
    })
  );
  assert.deepEqual(out.map((o) => [o.kind, o.to]), [["sendMessage", PHONE], ["sendDeliveryChoices", PHONE], ["sendMessage", "+5511999999999"]]);
  assert.equal(replies, 2);
});

test("linha de teste: Pix e link de cartão são recusados dentro da captura", async () => {
  await testLineCapture.run({ phone: PHONE, out: [] }, async () => {
    await assert.rejects(pixAdapter.createPix({ orderId: "x", amount: 10 }), TestLineChargeBlocked);
    await assert.rejects(checkoutAdapter.createLink({ orderId: "x", amount: 10 } as Parameters<typeof checkoutAdapter.createLink>[0]), TestLineChargeBlocked);
  });
});

test("linha de teste: só telefones +5500995", () => {
  assert.equal(isTestLinePhone(PHONE), true);
  assert.equal(isTestLinePhone("+5511976366065"), false);
  assert.equal(isTestLinePhone("+5500994000001"), false);
});
