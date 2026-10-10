// Rodada 4, grupo g11 (09/10): aviso de loja pedida só para o item que a pediu (M1), nome/CPF nunca item nem eco (M4),
// aviso de tamanho que não contradiz as opções (M5/M7), prazo dito pelo cliente no total (M6), corte básico do frango (M8).
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, requestedStoreMissing, sizeGapFor, takeIdentityFromItems, looksLikeBareFirstNameFullName } from "../src/lib/delivery-service";
import { reply } from "../src/lib/turn-runtime";
import { parseNeededBy } from "../src/lib/lia-intents";
import { promiseMissesDeadline } from "../src/lib/live-freight";
import { claimsMissingWhatIsShown } from "../src/lib/dialogue/execute";
import { variantPenalty } from "../src/lib/stores/types";
import * as copy from "../src/lib/lia-copy";
import type { ChoiceOption } from "../src/lib/conversation-types";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5579${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;

const opt = (sku: string, name: string, storeKey = "mambo", storeLabel = "Mambo"): ChoiceOption => ({ sku, name, unitPrice: 10, storeKey, storeLabel });

async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

// M1 -------------------------------------------------------------------------------------------------------------
test("M1: toque em card 'optsku:mambo-8057' não é loja pedida; lista só vale no trecho do item; aviso nomeia o item", () => {
  const choice = { query: "feijão", qty: 1, options: [opt("a", "Feijão Carioca Camil 1kg", "petz", "Petz")] };
  assert.equal(requestedStoreMissing("optsku:mambo-8057", choice), null, "toque no card da Mambo não pediu Mambo");
  assert.equal(requestedStoreMissing("leite da mambo, feijão", choice), null, "a Mambo foi pedida para o leite, não para o feijão");
  assert.match(requestedStoreMissing("feijão da mambo", choice) ?? "", /Mambo/i);
  assert.match(requestedStoreMissing("leite, feijão da mambo", choice) ?? "", /Mambo/i);
  const text = copy.requestedStoreNotShown("Mambo", "feijão");
  assert.match(text, /^Pra \*feijão\*, não achei na \*Mambo\*/);
});

// M4 -------------------------------------------------------------------------------------------------------------
test("M4: nome sozinho no cadastro não vira item nem é ecoado", async (t) => {
  if (!dbOk) return t.skip("sem banco");
  const phone = `${PREFIX}0001`;
  const user = await prisma.user.create({ data: { phone } });
  await prisma.conversation.create({ data: { userId: user.id, status: "active", currentStep: "need_address", context: JSON.stringify({ flow: "delivery", step: "need_address" }) } });
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text: "Rafael Torres", messageId: `g11_${RUN}_${++seq}` });
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n");
  assert.doesNotMatch(out, /Anotei|1x Rafael|Rafael Torres/, out);
  const convo = await prisma.conversation.findFirstOrThrow({ where: { userId: user.id } });
  assert.doesNotMatch(convo.context ?? "", /pendingRequest/, "o nome não ficou na lista de itens");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).cpfName, "Rafael Torres");
});
test("M4: nome + CPF junto do CEP saem da lista e gravam o cadastro; nome comum é reconhecido, produto não", async (t) => {
  assert.ok(looksLikeBareFirstNameFullName("rafael torres"));
  assert.ok(!looksLikeBareFirstNameFullName("leite ninho"));
  if (!dbOk) return t.skip("sem banco");
  const user = await prisma.user.create({ data: { phone: `${PREFIX}0002` } });
  const rest = await takeIdentityFromItems(user.id, "Carolina Mendes cpf 52998224725, pão de forma");
  assert.equal(rest, "pão de forma");
  const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(saved.cpf, "52998224725");
  assert.equal(saved.cpfName, "Carolina Mendes");
});
test("M4: CPF nunca sai em claro numa resposta", async () => {
  const start = outbox.length;
  await reply(`${PREFIX}9999`, "Esses eu não achei: • Carolina Mendes cpf 52998224725");
  const out = outbox.slice(start).map((m) => m.text).join("\n");
  assert.doesNotMatch(out, /52998224725/);
  assert.match(out, /\*\*\*\.\*\*\*\.247-25/);
});

// M5 / M7 --------------------------------------------------------------------------------------------------------
test("M5: 'não achei de 8 unidades' com card de 8 unidades na tela é contradição; sem o card, não", () => {
  const withEight = [opt("1", "Bombom Chocolate ao Leite Ferrero Rocher 8 Unidades 100g", "americanas", "Americanas")];
  assert.ok(claimsMissingWhatIsShown("Não achei a opção de Ferrero Rocher de 8 unidades. Escolhe uma das caixas abaixo.", withEight));
  assert.ok(!claimsMissingWhatIsShown("Não achei a opção de Ferrero Rocher de 8 unidades.", [opt("2", "Ferrero Rocher 16 Unidades 200g")]));
  assert.ok(!claimsMissingWhatIsShown("Escolhe uma das caixas abaixo.", withEight));
});
test("M7: Omo de 1 kg com só 1,6 kg e 2,2 kg → aviso de tamanho com o mais próximo na frente", () => {
  const options = [opt("a", "Lava Roupas em Pó Omo 2,2kg"), opt("b", "Lava Roupas em Pó Omo 1,6kg")];
  const gap = sizeGapFor("sabão em pó Omo 1kg", options);
  assert.ok(gap);
  assert.equal(gap.falta, "é de 1,6 kg");
  assert.equal(gap.options[0].sku, "b");
  assert.match(copy.closestHeader("sabão em pó Omo 1kg", gap.falta), /O mais perto que tenho é de 1,6 kg/);
  assert.equal(sizeGapFor("sabão em pó Omo 1kg", [opt("c", "Lava Roupas Omo 1kg"), opt("d", "Lava Roupas Omo 1,6kg")]), null, "uma do tamanho: sem aviso");
  assert.equal(sizeGapFor("sabão em pó Omo", options), null, "sem tamanho pedido: sem aviso");
  assert.equal(sizeGapFor("sabão Omo 1kg", [opt("e", "Sabão Omo líquido")]), null, "sem medida no nome: não conclui");
});

// M6 -------------------------------------------------------------------------------------------------------------
test("M6: prazo dito pelo cliente é lido e a promessa que não cumpre vira uma linha no total", () => {
  const now = new Date("2026-10-09T15:00:00Z"); // sexta
  assert.deepEqual(parseNeededBy("é aniversario da minha mae amanha", now), { date: "2026-10-10", label: "amanhã" });
  assert.deepEqual(parseNeededBy("preciso pra hoje", now), { date: "2026-10-09", label: "hoje" });
  assert.deepEqual(parseNeededBy("preciso até quarta", now), { date: "2026-10-14", label: "quarta" });
  assert.equal(parseNeededBy("pode ser amanhã", now), null, "afirmação não é prazo");
  assert.equal(parseNeededBy("pago amanhã", now), null);
  assert.equal(promiseMissesDeadline("pela própria loja · prazo da loja: 2 dias úteis", "2026-10-10", now), true);
  assert.equal(promiseMissesDeadline("prazo da loja: 1 dia útil", "2026-10-10", now), false);
  assert.equal(promiseMissesDeadline("pela própria loja · prazo da loja: em até 9h (hoje, 12h–15h)", "2026-10-09", now), false);
  assert.equal(promiseMissesDeadline("prazo da loja: 2 dias úteis", "2026-10-14", now), false);
  assert.equal(promiseMissesDeadline("sem prazo legível", "2026-10-10", now), null);
  const out = copy.manualQuoteSummary({ items: [{ qty: 1, name: "Perfume" }], produtos: 100, frete: 10, total: 110, deliveryPromise: "pela própria loja · prazo da loja: 2 dias úteis", deadlineMiss: { label: "amanhã" } });
  const lines = out.split("\n");
  const total = lines.findIndex((l) => l.startsWith("*Total"));
  assert.match(lines[total + 1], /amanhã.*2 dias úteis/);
  assert.doesNotMatch(copy.manualQuoteSummary({ items: [{ qty: 1, name: "Perfume" }], produtos: 100, frete: 10, total: 110 }), /Você precisou/);
});

// M8 -------------------------------------------------------------------------------------------------------------
test("M8: 'frango' genérico: peito/coxa/filé tem penalidade menor que passarinho", () => {
  assert.ok(variantPenalty("frango 1kg", "Filé de Frango Congelado 1kg") < variantPenalty("frango 1kg", "Frango a Passarinho Seara 1kg"));
  assert.ok(variantPenalty("frango 1kg", "Peito de Frango sem osso 1kg") < variantPenalty("frango 1kg", "Frango a Passarinho Sadia 1kg"));
});
