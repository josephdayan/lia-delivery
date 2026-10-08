// Remédio isento no chat, ponta a ponta (29/09/2026): pedido → vitrine em texto → escolha →
// fechar → nome + CPF uma vez → cotação com a taxa da Lia em linha própria → pedido com o
// CPF do cliente. Com a flag desligada, a recusa de sempre. Banco local (npm run test:local).
import "./helpers/load-env";
import "./helpers/medicine-env";

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5507${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const TEST_ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
const CPF = "52998224725";
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const interactive: string[] = [];
(whatsappAdapter as { sendMessage: unknown }).sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
(whatsappAdapter as { sendMedia: unknown }).sendMedia = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
// Superfícies de COMPRA da Meta (carrossel de template, pagamento nativo) com remédio são
// falha de política. Cards soltos com foto e botões comuns Pix/Cartão valem (dono, 05/10).
for (const name of ["sendDeliveryCarousel", "sendPixOrderDetails", "sendOrderDetailsCard"] as const) {
  (whatsappAdapter as unknown as Record<string, unknown>)[name] = async () => {
    interactive.push(name);
    return null;
  };
}

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `med_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer(extra: { cpf?: string; cpfName?: string } = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: TEST_ADDRESS, ...extra } });
  return { phone, userId: user.id };
}
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
afterEach(() => {
  process.env.LIA_MEDICINE_MIP = "true";
  interactive.length = 0;
});
after(async () => {
  if (dbOk) await wipe();
  await prisma.$disconnect();
});

// Até a vitrine de dipirona e a escolha do 1º item. Devolve a vitrine e o preço mostrado.
async function pickDipirona(phone: string) {
  const vitrine = await send(phone, "quero dipirona");
  const first = vitrine.split("\n").find((l) => /^\*1\)\*/.test(l)) ?? "";
  const afterPick = await send(phone, "1");
  if (/quantas unidades/i.test(afterPick)) await send(phone, "1");
  return { vitrine, first };
}

test("remédio isento: vitrine sem carrossel, sem markup, CPF uma vez, cotação com a taxa da Lia separada", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const { vitrine, first } = await pickDipirona(c.phone);
  assert.doesNotMatch(vitrine, /não posso vender/i, vitrine.slice(0, 300));
  assert.match(first, /dipirona/i, `vitrine sem dipirona: ${vitrine.slice(0, 300)}`);
  assert.deepEqual(interactive, [], "vitrine de remédio nunca sai em carrossel");

  const asked = await send(c.phone, "só isso");
  assert.match(asked, /nome completo[\s\S]*CPF/i, `devia pedir nome e CPF: ${asked.slice(0, 300)}`);
  const noOrderYet = await prisma.deliveryOrder.count({ where: { phone: c.phone } });
  assert.equal(noOrderYet, 0, "nada é cotado antes do CPF");

  const invalid = await send(c.phone, "Maria da Silva 529.982.247-24");
  assert.match(invalid, /não confere/i);

  const quoted = await send(c.phone, "Maria da Silva 529.982.247-25");
  assert.match(quoted, /✅ Anotado/, "confirmação curta (dono, 05/10)");
  assert.doesNotMatch(quoted, /529\.982\.247-25|52998224725/, "CPF inteiro nunca volta no chat");
  assert.match(quoted, /Taxa de serviço da Lia: R\$ 4,90/, quoted.slice(0, 600));
  assert.doesNotMatch(quoted, /no seu nome e CPF/, "resumo sem o aviso longo (dono, 05/10)");
  assert.match(quoted, /pix[\s\S]*cart(ã|a)o/i, "pagamento oferecido");
  assert.deepEqual(interactive, [], `nenhuma superfície de compra da Meta: ${interactive.join(",")}`);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
  assert.equal(user.cpf, CPF);
  assert.equal(user.cpfName, "Maria da Silva");
  assert.ok(user.cpfConsentAt);
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { phone: c.phone }, orderBy: { createdAt: "desc" } });
  assert.equal(order.buyerDocument, CPF);
  assert.equal(order.buyerName, "Maria da Silva");
  const items = order.items as Array<{ medicine?: string; unitPrice: number; qty: number }>;
  assert.ok(items.every((i) => i.medicine === "mip"));
  assert.equal(order.serviceFee, 4.9, "sem markup no remédio: a margem é só a taxa");
  assert.equal(Math.round((order.itemsSubtotal + order.serviceFee + order.deliveryFee) * 100) / 100, order.total);
});

test("remédio isento: quem já deu o CPF não é perguntado de novo", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer({ cpf: CPF, cpfName: "Maria da Silva" });
  await pickDipirona(c.phone);
  const quoted = await send(c.phone, "só isso");
  assert.doesNotMatch(quoted, /nome completo/i);
  assert.match(quoted, /Taxa de serviço da Lia/);
  const order = await prisma.deliveryOrder.findFirstOrThrow({ where: { phone: c.phone }, orderBy: { createdAt: "desc" } });
  assert.equal(order.buyerDocument, CPF);
});

test("remédio isento: 'sem remédio' no pedido do CPF tira o remédio e segue sem pedir documento", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  await pickDipirona(c.phone);
  await send(c.phone, "só isso");
  const out = await send(c.phone, "sem remédio");
  assert.match(out, /Tirei o remédio|Carrinho limpo/i, out.slice(0, 300));
  const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
  assert.equal(user.cpf, null);
});

test("remédio de receita continua recusado, mesmo com a flag ligada", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const out = await send(c.phone, "quero amoxicilina 500mg");
  // Dono (08/10): a recusa NOMEIA o remédio e diz o porquê.
  assert.match(out, /\*Amoxicilina\* é remédio de receita, então esse eu não consigo comprar/i, out.slice(0, 300));
});

test("lista com isento + receita: o isento segue e a nota diz QUAL ficou de fora (dono, 08/10)", async (t) => {
  if (!dbOk) return t.skip();
  const c = await customer();
  const out = await send(c.phone, "quero dipirona e rivotril");
  assert.match(out, /\*Rivotril\* precisa de receita, então esse eu não consigo comprar — deixei de fora/i, out.slice(0, 400));
  assert.match(out, /dipirona/i, "a dipirona (isenta) continua na vitrine");
  // Pedido só de receita, sem nome na lista ("remédio de receita"): recusa genérica, sem inventar nome.
  const generic = await send(c.phone, "quero um remédio de receita");
  assert.match(generic, /^Remédio de receita eu não consigo comprar/i, generic.slice(0, 200));
});

test("flag desligada: remédio segue recusado como sempre", async (t) => {
  if (!dbOk) return t.skip();
  delete process.env.LIA_MEDICINE_MIP;
  const c = await customer();
  const out = await send(c.phone, "quero dipirona");
  assert.match(out, /Remédio eu não posso vender/i, out.slice(0, 300));
});

// 05/10 (dono): nome + CPF no CADASTRO, logo depois do 1º endereço, e o pedido guardado segue.
async function newCustomer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone } });
  return { phone, userId: user.id };
}

test("cadastro (05/10): CPF pedido logo depois do endereço; o pedido guardado roda em seguida", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newCustomer();
  await send(c.phone, "quero dipirona");
  await send(c.phone, "01310-100");
  const afterAddress = await send(c.phone, "Rua das Flores, 123, Bela Vista");
  assert.match(afterAddress, /Endereço salvo[\s\S]*nome completo[\s\S]*CPF/i, afterAddress.slice(0, 400));
  const out = await send(c.phone, "Maria da Silva 529.982.247-25");
  assert.match(out, /✅ Anotado/);
  assert.match(out, /dipirona/i, `o pedido guardado devia virar vitrine: ${out.slice(0, 300)}`);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
  assert.equal(user.cpf, CPF);
  // Daqui pra frente o remédio fecha sem perguntar de novo.
  await send(c.phone, "1");
  const quoted = await send(c.phone, "só isso");
  assert.doesNotMatch(quoted, /nome completo/i, quoted.slice(0, 300));
});

test("cadastro (05/10): resposta sem CPF não trava — segue como pedido normal", async (t) => {
  if (!dbOk) return t.skip();
  const c = await newCustomer();
  await send(c.phone, "oi");
  await send(c.phone, "01310-100");
  const afterAddress = await send(c.phone, "Rua das Flores, 123, Bela Vista");
  assert.match(afterAddress, /CPF/);
  const out = await send(c.phone, "quero dipirona");
  assert.doesNotMatch(out, /CPF não confere|nome completo/i, out.slice(0, 300));
  assert.match(out, /dipirona/i, out.slice(0, 300));
});
