// Cadastro pelo formulário do WhatsApp (06/10/2026, dono: "precisa pedir CEP, nome e CPF" e
// "pode pedir tudo direto no começo"). Puros: leitura e validação da resposta do Flow. Com
// banco (npm run test:local): o primeiro contato recebe o formulário; a resposta salva tudo
// de uma vez; só a parte que falhou volta a ser pedida; sem Flow, o texto de sempre.
import "./helpers/load-env";

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import {
  buildSignupAddress,
  isSignupFormReply,
  normalizeSignupCep,
  normalizeSignupCpf,
  normalizeSignupName,
  parseSignupForm
} from "../src/lib/signup-form";
import { SIGNUP_FLOW_JSON, SIGNUP_FLOW_SCREEN } from "../src/lib/meta-setup";

// ---------- puros ----------

test("cadastro: CEP sem o zero da frente (campo numérico) volta com 8 dígitos", () => {
  assert.equal(normalizeSignupCep("1310100"), "01310-100");
  assert.equal(normalizeSignupCep("01310-100"), "01310-100");
  assert.equal(normalizeSignupCep(13560000), "13560-000");
  assert.equal(normalizeSignupCep("131010"), null);
  assert.equal(normalizeSignupCep(""), null);
});

test("cadastro: CPF com pontuação, sem zero da frente ou com dígito errado", () => {
  assert.equal(normalizeSignupCpf("529.982.247-25"), "52998224725");
  assert.equal(normalizeSignupCpf("52998224724"), null, "dígito verificador errado");
  assert.equal(normalizeSignupCpf("11111111111"), null, "repetido");
  // 012.345.678-90 é válido; o campo numérico pode entregar 1234567890.
  assert.equal(normalizeSignupCpf("1234567890"), "01234567890");
});

test("cadastro: nome exige nome e sobrenome e arruma as maiúsculas", () => {
  assert.equal(normalizeSignupName("maria da silva"), "Maria da Silva");
  assert.equal(normalizeSignupName("JOÃO P. SANTOS"), "João P Santos");
  assert.equal(normalizeSignupName("  Ana   Lima "), "Ana Lima");
  assert.equal(normalizeSignupName("Maria"), null);
  assert.equal(normalizeSignupName(""), null);
});

test("cadastro: resposta do Flow de cadastro × Flow de endereço", () => {
  assert.equal(isSignupFormReply({ nome: "a", cpf: "1", cep: "2", flow_token: "x" }), true);
  assert.equal(isSignupFormReply({ rua: "Rua A", numero: "1", cep: "01310100" }), false);
  assert.equal(isSignupFormReply(undefined), false);
  const form = parseSignupForm({ nome: "maria da silva", cpf: "52998224725", cep: "1310100", numero: " 1000 ", complemento: "" });
  assert.deepEqual(form, { name: "Maria da Silva", cpf: "52998224725", cep: "01310-100", numero: "1000", complemento: "" });
});

test("cadastro: endereço montado com a rua do CEP e o número do formulário", () => {
  assert.equal(
    buildSignupAddress({ street: "Avenida Paulista", numero: "1000", complemento: "apto 5", district: "Bela Vista", city: "São Paulo", uf: "SP" }),
    "Avenida Paulista, 1000, apto 5, Bela Vista, São Paulo - SP"
  );
  assert.equal(buildSignupAddress({ street: "Rua A", numero: "10", city: "Campinas", uf: "SP" }), "Rua A, 10, Campinas - SP");
});

test("cadastro: o Flow pede nome, CPF, CEP, número e complemento e devolve os cinco", () => {
  const screen = SIGNUP_FLOW_JSON.screens[0] as any;
  assert.equal(screen.id, SIGNUP_FLOW_SCREEN);
  const form = screen.layout.children.find((c: any) => c.type === "Form");
  const inputs = form.children.filter((c: any) => c.type === "TextInput").map((c: any) => c.name);
  assert.deepEqual(inputs, ["nome", "cpf", "cep", "numero", "complemento"]);
  const footer = form.children.find((c: any) => c.type === "Footer");
  const payload = footer["on-click-action"].payload;
  for (const name of inputs) assert.equal(payload[name], `\${form.${name}}`, name);
});

// ---------- conversa, com banco ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const flows: { to: string; body: string; cta: string; screen: string; flowId: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { sendMessage: adapter.sendMessage, sendMedia: adapter.sendMedia, sendFlowMessage: adapter.sendFlowMessage, sendLocationRequest: adapter.sendLocationRequest };
adapter.sendMessage = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { provider: "test", to, text };
};
adapter.sendMedia = adapter.sendMessage;
adapter.sendLocationRequest = async (to: string, text: string) => {
  outbox.push({ to, text });
  return { messageId: "loc" };
};
adapter.sendFlowMessage = async (to: string, input: { body: string; cta: string; screen: string; flowId: string }) => {
  flows.push({ to, ...input });
  return { messageId: "flow" };
};

// ViaCEP de mentira: o cadastro consulta a rua pelo CEP.
const VIACEP: Record<string, object> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" },
  "20040020": { logradouro: "Rua da Assembleia", bairro: "Centro", localidade: "Rio de Janeiro", uf: "RJ" },
  "13560000": { logradouro: "", bairro: "", localidade: "São Carlos", uf: "SP" }
};
const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const viacep = url.match(/viacep\.com\.br\/ws\/(\d{8})\/json/);
  if (viacep) return new Response(JSON.stringify(VIACEP[viacep[1]] ?? { erro: true }), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("graph.facebook.com")) return new Response("{}", { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;

const VALID = { nome: "maria da silva", cpf: "529.982.247-25", cep: "1310100", numero: "1000", complemento: "apto 5" };

function newPhone() {
  return `${PREFIX}${String(++seq).padStart(4, "0")}`;
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `signup_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function submit(phone: string, form: Record<string, string>): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text: "", messageId: `signup_${RUN}_${++seq}`, flowResponse: { ...form, flow_token: "lia-cadastro-test" } });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
function withMetaFlow() {
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.LIA_FLOW_SIGNUP_ID = "999000111";
}
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
before(async () => {
  process.env.LIA_MEDICINE_MIP = "true";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
afterEach(() => {
  process.env.WHATSAPP_PROVIDER = "mock";
  delete process.env.LIA_FLOW_SIGNUP_ID;
  delete process.env.LIA_ADMIN_PHONES;
});
after(async () => {
  if (dbOk) await wipe();
  global.fetch = realFetch;
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

test("primeiro contato: 'oi' recebe o formulário de cadastro, sem pergunta de endereço em texto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  withMetaFlow();
  const text = await send(phone, "oi");
  const form = flows.filter((f) => f.to === phone);
  assert.equal(form.length, 1, "um formulário");
  assert.equal(form[0].screen, "CADASTRO");
  assert.equal(form[0].cta, "Fazer cadastro");
  assert.equal(form[0].flowId, "999000111");
  assert.match(form[0].body, /Sou a Lia/);
  assert.match(form[0].body, /nome, CPF e endereço/);
  assert.equal(text, "", `nada em texto além do formulário: ${text}`);
});

test("cadastro completo: salva CEP, endereço, nome e CPF de uma vez e não grava o CPF no histórico", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  withMetaFlow();
  await send(phone, "oi");
  process.env.WHATSAPP_PROVIDER = "mock";
  const out = await submit(phone, VALID);
  assert.match(out, /✅ Cadastro feito, Maria!/);
  assert.match(out, /Avenida Paulista, 1000, apto 5, Bela Vista, São Paulo - SP/);
  assert.match(out, /O que você precisa\?/);
  assert.doesNotMatch(out, /52998224725|529\.982\.247-25/, "CPF inteiro nunca volta no chat");
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cep, "01310-100", "CEP com o zero da frente");
  assert.equal(user.defaultAddress, "Avenida Paulista, 1000, apto 5, Bela Vista, São Paulo - SP");
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.cpfName, "Maria da Silva");
  assert.ok(user.cpfConsentAt);
  const messages = await prisma.message.findMany({ where: { conversation: { userId: user.id } }, select: { text: true } });
  assert.ok(messages.some((m) => m.text === "📝 Cadastro enviado pelo formulário"));
  assert.ok(messages.every((m) => !/52998224725|529\.982\.247/.test(m.text ?? "")), "histórico sem CPF");
  // Depois do cadastro, a próxima mensagem já é pedido: nada de endereço ou CPF de novo.
  const next = await send(phone, "oi");
  assert.doesNotMatch(next, /CPF|endereço completo/i, next);
  assert.equal(flows.filter((f) => f.to === phone).length, 1, "formulário não volta");
});

test("itens no primeiro contato entram no formulário como 'Já anotei' e saem do estoque depois do cadastro", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  withMetaFlow();
  await send(phone, "quero arroz e leite");
  const form = flows.filter((f) => f.to === phone);
  assert.equal(form.length, 1);
  assert.match(form[0].body, /Já anotei:[\s\S]*arroz/);
  process.env.WHATSAPP_PROVIDER = "mock";
  const out = await submit(phone, VALID);
  assert.match(out, /✅ Cadastro feito, Maria!/);
  assert.doesNotMatch(out, /O que você precisa\?/, "com pedido guardado, a Lia já vai buscar");
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  assert.equal(JSON.parse(convo.context ?? "{}").pendingRequest, undefined, "pedido guardado foi consumido");
});

test("cliente novo que ignora o formulário e escreve recebe o formulário de novo, sem a apresentação", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  withMetaFlow();
  await send(phone, "oi");
  const text = await send(phone, "quero pasta de dente");
  const form = flows.filter((f) => f.to === phone);
  assert.equal(form.length, 2, "segundo formulário");
  assert.doesNotMatch(form[1].body, /Sou a Lia/);
  assert.match(form[1].body, /Anotei:[\s\S]*pasta de dente/);
  assert.match(form[1].body, /falta o cadastro/);
  assert.equal(text, "");
});

test("CPF inválido: endereço fica salvo e a Lia pede só nome e CPF por texto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await submit(phone, { ...VALID, cpf: "52998224724" });
  assert.match(out, /Endereço salvo: Avenida Paulista, 1000/);
  assert.match(out, /CPF\* não confere/);
  let user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cep, "01310-100");
  assert.ok(user.defaultAddress);
  assert.equal(user.cpf, null);
  const fixed = await send(phone, "Maria da Silva 529.982.247-25");
  assert.match(fixed, /Anotado/);
  user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.cpfName, "Maria da Silva");
});

test("nome sem sobrenome: endereço salvo, pede nome completo e CPF", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await submit(phone, { ...VALID, nome: "Maria" });
  assert.match(out, /Faltou o \*sobrenome\*/);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.ok(user.defaultAddress);
  assert.equal(user.cpf, null);
});

test("CEP fora do estado de SP: lista de espera, sem guardar CEP nem CPF", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await submit(phone, { ...VALID, cep: "20040020" });
  assert.match(out, /Ainda não chego em Rio de Janeiro/);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cep, null);
  assert.equal(user.cpf, null, "sem entrega, o CPF não fica");
  assert.equal(await prisma.waitlistLead.count({ where: { phone } }), 1);
});

test("CEP que não existe: guarda nome e CPF e pede o CEP de novo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await submit(phone, { ...VALID, cep: "99999999" });
  assert.match(out, /Não achei o CEP 99999-999/);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cpf, "52998224725");
  assert.equal(user.defaultAddress, null);
});

test("CEP geral sem rua: guarda CEP e CPF, pede a rua e não pede o CPF de novo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await submit(phone, { ...VALID, cep: "13560000" });
  assert.match(out, /não achei a rua/);
  let user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.cep, "13560-000");
  assert.equal(user.cpf, "52998224725");
  const saved = await send(phone, "Rua Episcopal, 1500, São Carlos");
  assert.match(saved, /Endereço salvo/);
  assert.doesNotMatch(saved, /CPF/);
  user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.match(user.defaultAddress ?? "", /Rua Episcopal, 1500/);
});

test("sem Flow publicado (ou fora da Meta), o primeiro contato pede o endereço por texto como antes", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const text = await send(phone, "oi");
  assert.equal(flows.filter((f) => f.to === phone).length, 0);
  assert.match(text, /endereço completo/);
});

test("dono manda 'cadastro' e recebe o formulário mesmo já cadastrado", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: "Rua das Flores, 123, Bela Vista, São Paulo - SP" } });
  withMetaFlow();
  process.env.LIA_ADMIN_PHONES = phone;
  await send(phone, "cadastro");
  assert.equal(flows.filter((f) => f.to === phone).length, 1);
});
