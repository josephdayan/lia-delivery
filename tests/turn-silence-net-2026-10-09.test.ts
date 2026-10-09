// "Me perdi aqui 😅" logo depois do Pix (pedido do dono, 09/10): com LIA_NATIVE_PIX=1 o Pix sai
// só como bolha nativa, por um `send*` do adaptador que não passa por `reply()`. A rede
// anti-silêncio achava que o turno não tinha respondido nada. Agora todo envio ao cliente conta.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurnScoped, turnMeta } from "../src/lib/turn-runtime";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";

const PHONE = "+5500993000001";

async function repliesAfter(fn: () => Promise<unknown>) {
  return runTurnScoped(async () => {
    const meta = turnMeta.getStore()!;
    meta.phone = PHONE;
    await fn();
    return meta.replies;
  });
}

test("rede anti-silêncio: envio direto do adaptador ao cliente conta como resposta", async () => {
  assert.equal(await repliesAfter(() => whatsappAdapter.sendMessage(PHONE, "Pix copia-e-cola")), 1);
});

test("rede anti-silêncio: aviso pra outro telefone (dono/operador) não conta", async () => {
  assert.equal(await repliesAfter(() => whatsappAdapter.sendMessage("+5500993999999", "aviso ao dono")), 0);
});

test("rede anti-silêncio: envio que não aconteceu (null) não conta", async () => {
  // Fora da Meta, os cards devolvem null e o chamador cai no texto numerado.
  assert.equal(await repliesAfter(() => whatsappAdapter.sendDeliveryChoices(PHONE, [])), 0);
});
