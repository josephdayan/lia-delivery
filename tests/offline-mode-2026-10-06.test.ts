import "./helpers/load-env";
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { isOfflineMode, parseOfflineCommand, setOfflineMode } from "../src/lib/offline-mode";
import { handleOperatorInbound } from "../src/lib/ops-actions-inbound";
import { offlineNotice } from "../src/lib/lia-copy";
import { POST } from "../src/app/api/whatsapp/webhook/route";

process.env.WHATSAPP_WEBHOOK_SECRET ??= "unit-webhook-secret";
process.env.LIA_OWNER_PHONE = "+5511999990001";
delete process.env.LIA_OFFLINE;
const sent: Array<{ to: string; text: string }> = [];
mock.method(whatsappAdapter, "sendMessage", async (to: string, text: string) => {
  sent.push({ to, text });
  return { provider: "mock", to, text };
});

function inbound(phone: string, text: string) {
  return new Request("http://local/api/whatsapp/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": process.env.WHATSAPP_WEBHOOK_SECRET! },
    body: JSON.stringify({ from: phone, body: text, messageId: `offline-${Date.now()}-${Math.random()}` }),
  });
}

after(async () => {
  await prisma.appFlag.deleteMany({ where: { key: "offline" } });
  await prisma.$disconnect();
});

test("comando do dono: exige 'lia' antes", () => {
  assert.equal(parseOfflineCommand("lia offline"), true);
  assert.equal(parseOfflineCommand("Lia desligar"), true);
  assert.equal(parseOfflineCommand("lia online"), false);
  assert.equal(parseOfflineCommand("offline"), null);
  assert.equal(parseOfflineCommand("quero arroz"), null);
});

test("offline: cliente recebe só o aviso, sem entrar no cérebro", async () => {
  await setOfflineMode(true, "test");
  sent.length = 0;
  const res = await POST(inbound("+5511988887777", "quero arroz"));
  assert.equal((await res.json()).offline, true);
  assert.deepEqual(sent, [{ to: "+5511988887777", text: offlineNotice() }]);
});

test("dono liga e desliga pelo WhatsApp; cliente volta a ser atendido", async () => {
  await setOfflineMode(false, "test");
  assert.equal(await handleOperatorInbound("+5511999990001", "lia offline"), "handled");
  assert.equal(await isOfflineMode(), true);
  assert.equal(await handleOperatorInbound("+5511999990001", "lia online"), "handled");
  assert.equal(await isOfflineMode(), false);
  sent.length = 0;
  const res = await POST(inbound("+5511988887778", "oi"));
  assert.notEqual((await res.json()).offline, true);
  assert.ok(!sent.some((m) => m.text === offlineNotice()));
});

test("offline: dono passa direto (continua testando)", async () => {
  await setOfflineMode(true, "test");
  sent.length = 0;
  const res = await POST(inbound("+5511999990001", "oi"));
  assert.notEqual((await res.json()).offline, true);
  assert.ok(!sent.some((m) => m.text === offlineNotice()));
  await setOfflineMode(false, "test");
});
