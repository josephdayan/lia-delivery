// Rodada 1 de testes no WhatsApp (09/10), grupo f3: embalagem "Und", remédio no meio da lista, marca com "e"/"&",
// tamanho trocado avisado em todo item, abreviação "req.", polimento de copy e nome normalizado nos cabeçalhos.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/lib/lia-copy";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { declaredPack, handleDeliveryMessage, packAdjusted } from "../src/lib/delivery-service";
import { resolveListItems } from "../src/lib/list-items";
import { parseBasketLines } from "../src/lib/lia-intents";
import { displayQueryName } from "../src/lib/query-display";

test("A1: '10 Und' é embalagem de 10; 'uma dúzia de ovos' nunca vira 12 caixas", () => {
  for (const name of ["Ovo Branco Jumbo Mantiqueira 10 Und", "Ovos 12 Unid", "Ovos Caipira 30 Unidades", "Ovo Branco 10 un"]) {
    assert.ok(declaredPack(name) >= 10, name);
  }
  assert.equal(declaredPack("Ovo Branco Jumbo Mantiqueira 10 Und"), 10);
  const adjusted = packAdjusted("Ovo Branco Jumbo Mantiqueira 10 Und", 12, "uma duzia de ovos");
  assert.equal(adjusted.qty, 2, "12 ovos com caixa de 10 = 2 caixas (a conversa ainda PERGUNTA antes), nunca 12");
  assert.match(adjusted.note ?? "", /ovos|unidades|embalag/i);
});

test("A2: marcas com 'e'/'&' no nome não são quebradas em dois itens", () => {
  const phrases = (text: string) => resolveListItems(text).map((l) => l.phrase.toLowerCase());
  assert.deepEqual(phrases("shampoo head e shoulders"), ["shampoo head e shoulders"]);
  assert.deepEqual(phrases("arroz 5kg\nshampoo head e shoulders\nlego classic"), ["arroz 5kg", "shampoo head e shoulders", "lego classic"]);
  assert.deepEqual(phrases("shampoo head & shoulders e condicionador"), ["shampoo head & shoulders", "condicionador"]);
  assert.equal(phrases("sabonete johnson e johnson").length, 1);
  assert.equal(phrases("perfume dolce e gabbana").length, 1);
  // continua separando o que são dois itens
  assert.equal(phrases("sabonete dove e lux").length, 2);
  assert.equal(phrases("shampoo e condicionador").length, 2);
});

test("A5: abreviação 'req.' é requeijão antes da busca", () => {
  const phrases = parseBasketLines("cerva skol lata 350, req. tirolez, papel hig neve, pão").map((l) => l.phrase);
  assert.ok(phrases.some((p) => /requeij/i.test(p) && /tirolez/i.test(p)), JSON.stringify(phrases));
  assert.ok(!phrases.some((p) => /^req\b/i.test(p)), JSON.stringify(phrases));
  assert.ok(phrases.some((p) => /cerveja/i.test(p)), JSON.stringify(phrases));
});

test("A4/A7: cabeçalho da fila avisa o tamanho que não existe e fala 'falta 1' no singular", () => {
  assert.equal(copy.nextChoiceHeader("feijão", 2), "Agora *feijão* — depois falta 1.");
  assert.equal(copy.nextChoiceHeader("feijão", 3), "Agora *feijão* — depois faltam 2.");
  assert.equal(copy.nextChoiceHeader("feijão", 1), "Agora *feijão*.");
  const withFalta = copy.nextChoiceHeader("azeite gallo 1l", 3, "é de 500 ml");
  assert.match(withFalta, /Não achei \*azeite gallo 1l\* exatamente\. O mais perto que tenho é de 500 ml/);
});

test("A7c: o cabeçalho usa o nome normalizado, não a digitação errada", () => {
  const options = [{ name: "Sabão em Pó Omo Limpeza Perfeita 400g" }, { name: "Detergente Líquido Ypê Clear 500ml", brand: "Ypê" }];
  assert.equal(displayQueryName("sabão em pó omu", options), "sabão em pó Omo");
  assert.equal(displayQueryName("detergente ype", options), "detergente Ypê");
  assert.equal(displayQueryName("detergente ypê", options), "detergente ypê");
  // plural/flexão e palavras que já batem ficam como o cliente escreveu
  assert.equal(displayQueryName("sabão em pó omo", options), "sabão em pó omo");
  assert.equal(displayQueryName("ração gatos", [{ name: "Ração Whiskas Gato Adulto 1kg" }]), "ração gatos");
  assert.equal(displayQueryName("qualquer coisa", []), "qualquer coisa");
});

// ---------- conversa (remédio no meio da lista) ----------
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const RUN = `${Date.now().toString(36)}${process.pid}`;
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
(whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
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
  await prisma.$disconnect();
});

test("A3: remédio no meio da lista sai com a explicação curta e o resto segue", async (t) => {
  if (!dbOk) return t.skip();
  delete process.env.LIA_MEDICINE_MIP;
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: "Rua das Flores, 123, Bela Vista, São Paulo - SP" } });
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text: "quero dipirona 1g e leite integral, arroz", messageId: `r1f3_${RUN}_${++seq}` });
  const out = outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
  assert.doesNotMatch(out, /^Remédio eu não posso vender — por lei/m, "não derruba a lista inteira");
  assert.match(out, /Remédio eu não posso vender, então deixei ele de fora/, out.slice(0, 400));
  assert.match(out, /leite|arroz/i, `o resto da lista segue: ${out.slice(0, 400)}`);
});
