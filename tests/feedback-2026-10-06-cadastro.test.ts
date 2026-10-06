// Relatório do testador de 06/10/2026 — primeiro contato, cadastro e endereço. Cada teste
// guarda um defeito reproduzido (A1, A3, A4, A5, M1, M2, M6, M7, M9, M10, M11) e os extras dos
// outros testadores (pedido vago, história pessoal, pergunta antes do cadastro).
// Puros sempre; conversa com banco local.
import "./helpers/load-env";
import "./helpers/medicine-env";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { __setRouterInterpreterForTests } from "../src/lib/adapters/ai";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import { detectIntent, extractCep, withAddressComplement } from "../src/lib/lia-intents";
import {
  isKeepOldAddress,
  onboardingNote,
  parseHouseNumberReply,
  parsePriceAsk,
  splitAddressAndItems,
  typedCityMismatch
} from "../src/lib/address-parse";

// ---------- puros ----------

test("A1: endereço separado do pedido que veio junto", () => {
  assert.deepEqual(
    splitAddressAndItems("quero 2 sabonetes dove e um shampoo seda, entrega em Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo 01233020"),
    { address: "Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo", items: "quero 2 sabonetes dove e um shampoo seda" }
  );
  assert.deepEqual(splitAddressAndItems("Rua Augusta 1500, 01305-100. quero arroz e feijão"), { address: "Rua Augusta 1500", items: "quero arroz e feijão" });
  assert.deepEqual(splitAddressAndItems("na verdade entrega na casa da minha mãe, Rua Augusta 1500, 01305-100"), { address: "Rua Augusta 1500" });
  const long = splitAddressAndItems(
    "Olá, boa tarde! Meu nome é Teste Silva, uma amiga me indicou o serviço de vocês. Eu queria saber como funciona porque nunca usei, preciso comprar umas coisas pra casa: detergente ype, papel higiênico neve 12 rolos, esponja scotch brite e um amaciante comfort. Moro na Rua Augusta 1500 apto 32, Consolação, São Paulo, CEP 01305-100. Obrigada!"
  );
  assert.equal(long?.address, "Rua Augusta 1500 apto 32, Consolação, São Paulo");
  assert.deepEqual(onboardingNote(long!.items!).lines.map((l) => l.phrase), ["detergente ype", "papel higiênico neve 12 rolos", "esponja scotch brite", "amaciante comfort"]);
  // Endereço sozinho continua inteiro; telefone e traço sobrando saem (B4/B5).
  assert.deepEqual(splitAddressAndItems("Av Paulista 1000, Bela Vista, São Paulo, 01310-100"), { address: "Av Paulista 1000, Bela Vista, São Paulo" });
  assert.deepEqual(splitAddressAndItems("Rua Augusta 1500 apto 32, 01305-100, tel 11 91234-5678"), { address: "Rua Augusta 1500 apto 32" });
  assert.deepEqual(splitAddressAndItems("Rua Augusta, nº 1500 - Consolação - SP - 01305100"), { address: "Rua Augusta, nº 1500 - Consolação - SP" });
  assert.deepEqual(splitAddressAndItems("Al. Santos 1000, 01418-100"), { address: "Al. Santos 1000" });
  assert.equal(splitAddressAndItems("quero shampoo 01233020"), null);
});

test("A3: número e complemento bastam quando a rua veio do CEP", () => {
  const place = { street: "Rua Augusta", district: "Consolação", city: "São Paulo" };
  assert.deepEqual(parseHouseNumberReply("1500", place), { numero: "1500" });
  assert.deepEqual(parseHouseNumberReply("221 apto 13", place), { numero: "221", complemento: "apto 13" });
  assert.deepEqual(parseHouseNumberReply("o numero é 1500", place), { numero: "1500" });
  assert.deepEqual(parseHouseNumberReply("numero 221 ap 13", place), { numero: "221", complemento: "ap 13" });
  assert.deepEqual(parseHouseNumberReply("Augusta 1500", place), { numero: "1500" });
  for (const x of ["quero arroz", "2 leites", "ja mandei", "não entendi o que vc quer"]) assert.equal(parseHouseNumberReply(x, place), null, x);
});

test("A5: cidade escrita × cidade do CEP (só a cidade, depois do número)", () => {
  assert.equal(typedCityMismatch("Rua Augusta 1500, Consolação, São Paulo", "Rio de Janeiro", "RJ"), "São Paulo");
  assert.equal(typedCityMismatch("Rua Augusta 1500, Consolação, São Paulo", "São Paulo", "SP"), null);
  assert.equal(typedCityMismatch("Rua São Paulo 100, Centro", "Santo André", "SP"), null, "nome da rua não é cidade");
  assert.equal(typedCityMismatch("Rua Jaguaribe 300 Santa Cecília", "São Paulo", "SP"), null);
});

test("M7: CEP com espaço ou ponto; CPF e telefone não viram CEP", () => {
  assert.equal(extractCep("01305 100"), "01305-100");
  assert.equal(extractCep("Rua Augusta 1500, 01.305-100"), "01305-100");
  assert.equal(detectIntent("01305 100").kind, "cep");
  for (const x of ["529.982.247-25", "52998224725", "11 91234-5678", "12.345.678/0001-90"]) assert.equal(extractCep(x), undefined, x);
});

test("M10: 'apto 45' substitui o 'ap 13' do meio do endereço", () => {
  assert.equal(
    withAddressComplement("Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo", "apto 45"),
    "Rua Eng. Edgar Egidio de Souza 221 apto 45 Santa Cecília São Paulo"
  );
});

test("M1/M2 e testadores: cortesia, pedido vago e história pessoal não viram item", () => {
  for (const x of ["Oi Lia, sou a Clara Souza", "Bom dia! Tudo bem? Gostaria de fazer um pedido", "quero algo pra comer", "me surpreende", "me liga", "tchau", "11987654321"]) {
    assert.equal(onboardingNote(x).text, "", x);
  }
  assert.equal(onboardingNote("Oi! Vi o anúncio de vocês. Vcs entregam remédio? Preciso de dipirona").text, "dipirona");
  assert.equal(onboardingNote("me lembra amanhã de comprar ração").text, "ração");
  assert.equal(onboardingNote("https://www.drogariasaopaulo.com.br/protetor-solar").text, "protetor solar");
  assert.deepEqual(
    onboardingNote("bom dia lia, semana passada meu marido viajou e eu fiquei sozinha com as crianças, e hoje acabou tudo aqui, preciso de leite, pão de forma e fralda pampers tamanho G").lines.map((l) => l.phrase),
    ["leite", "pão de forma", "fralda pampers tamanho G"]
  );
  assert.deepEqual(
    onboardingNote("oi, minha filha tá doente com febre desde ontem e o pediatra falou pra dar bastante líquido e dipirona, preciso de soro e dipirona gotas, moro em SP").lines.map((l) => l.phrase),
    ["dipirona", "soro", "dipirona gotas"]
  );
  assert.equal(parsePriceAsk("boa noite, quanto ta o leite ninho?"), "leite ninho");
  assert.equal(parsePriceAsk("quanto custa o serviço"), null);
  assert.equal(isKeepOldAddress("deixa o endereço antigo"), true);
  assert.equal(isKeepOldAddress("esquece, usa o endereço de antes"), true);
  assert.equal(isKeepOldAddress("não sei meu cep"), false);
});

// ---------- conversa, com banco ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5508${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Rua das Flores, 123, Bela Vista, São Paulo - SP";
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
const VIACEP: Record<string, Record<string, string>> = {
  "01310100": { logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" },
  "01305100": { logradouro: "Rua Augusta", bairro: "Consolação", localidade: "São Paulo", uf: "SP" },
  "01233020": { logradouro: "Rua Engenheiro Edgar Egidio de Souza", bairro: "Santa Cecília", localidade: "São Paulo", uf: "SP" },
  "01418100": { logradouro: "Alameda Santos", bairro: "Cerqueira César", localidade: "São Paulo", uf: "SP" },
  "20040002": { logradouro: "Avenida Rio Branco", bairro: "Centro", localidade: "Rio de Janeiro", uf: "RJ" },
  "30130000": { logradouro: "", bairro: "Centro", localidade: "Belo Horizonte", uf: "MG" }
};
const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = url.match(/viacep\.com\.br\/ws\/(\d{8})/);
  if (m) return new Response(JSON.stringify(VIACEP[m[1]] ?? { erro: true }), { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `cad_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function customer() {
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva" } });
  return phone;
}
async function ctxOf(phone: string) {
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}");
}
const userOf = (phone: string) => prisma.user.findUniqueOrThrow({ where: { phone } });
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
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
  global.fetch = realFetch;
  __setRouterInterpreterForTests(null);
  await prisma.$disconnect();
});

test("A1: pedido + endereço na mesma mensagem salva só o endereço e guarda os itens", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "quero 2 sabonetes dove e um shampoo seda, entrega em Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo 01233020");
  assert.match(out, /Endereço salvo: Rua Eng\. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo — CEP 01233-020/);
  assert.match(out, /Anotei:[\s\S]*2x sabonetes dove[\s\S]*shampoo seda/);
  assert.equal((await userOf(phone)).defaultAddress, "Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo");
  const ctx = await ctxOf(phone);
  assert.match(ctx.pendingRequest ?? "", /sabonetes dove[\s\S]*shampoo seda/, "itens guardados para depois do CPF");
});

test("A1: 'Rua Augusta 1500, 01305-100. quero arroz e feijão'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "Rua Augusta 1500, 01305-100. quero arroz e feijão");
  assert.equal((await userOf(phone)).defaultAddress, "Rua Augusta 1500");
  assert.match((await ctxOf(phone)).pendingRequest ?? "", /arroz[\s\S]*feij/);
});

test("A3: CEP sozinho, depois só o número — confirma a rua do CEP e salva", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  const ask = await send(phone, "01305-100");
  assert.match(ask, /CEP 01305-100: \*Rua Augusta\*, Consolação[\s\S]*falta só o \*número\*/);
  const saved = await send(phone, "1500");
  assert.match(saved, /Endereço salvo: Rua Augusta, 1500, Consolação, São Paulo - SP/);
  assert.match(saved, /nome completo[\s\S]*CPF/i);
  assert.doesNotMatch(saved, /Falta o \*endereço\*/);
});

test("A3: '221 apto 13' e 'meu cep é X e o número é Y' também fecham o endereço", async (t) => {
  if (!dbOk) return t.skip();
  const a = newPhone();
  await send(a, "01233020");
  await send(a, "221 apto 13");
  assert.equal((await userOf(a)).defaultAddress, "Rua Engenheiro Edgar Egidio de Souza, 221, apto 13, Santa Cecília, São Paulo - SP");
  const b = newPhone();
  const out = await send(b, "meu cep é 01305-100 e o número é 1500");
  assert.match(out, /Endereço salvo: Rua Augusta, 1500/);
});

test("A3: 'Rua Augusta, 01305-100' sem número pede só o número e não vira item", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "Rua Augusta, 01305-100");
  assert.match(out, /falta só o \*número\*/);
  assert.equal((await ctxOf(phone)).pendingRequest, undefined);
});

test("A4: cadastrado manda CEP solto — pergunta, não apaga; 'deixa o antigo' mantém", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const ask = await send(phone, "01305-100");
  assert.match(ask, /Quer trocar o endereço de entrega para o CEP \*01305-100\*/);
  assert.equal((await userOf(phone)).cep, "01310-100", "nada gravado antes do sim");
  const kept = await send(phone, "deixa o endereço antigo");
  assert.match(kept, /continua o mesmo endereço[\s\S]*Rua das Flores/);
  const ctx = await ctxOf(phone);
  assert.equal(ctx.deliveryAddressVerified, true);
  assert.doesNotMatch(await send(phone, "quero sabonete dove"), /Falta o \*endereço\*/);
});

test("A4: CEP solto e depois um produto segue com o endereço de sempre", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "01305-100");
  const out = await send(phone, "quero arroz");
  assert.doesNotMatch(out, /Falta o \*endereço\*|falta só o/);
  assert.equal((await userOf(phone)).cep, "01310-100");
  assert.equal((await ctxOf(phone)).cepSwap, undefined);
});

test("A4: 'sim' troca; no meio da troca, 'usa o de antes' volta o endereço anterior", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "01305-100");
  const ask = await send(phone, "sim");
  assert.match(ask, /Rua Augusta[\s\S]*falta só o \*número\*/);
  const back = await send(phone, "usa o de antes");
  assert.match(back, /continua o mesmo endereço[\s\S]*Rua das Flores/);
  const user = await userOf(phone);
  assert.equal(user.cep, "01310-100");
  assert.equal(user.defaultAddress, ADDRESS);
});

test("A5: rua de São Paulo com CEP do Rio pergunta antes de salvar", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const ask = await send(phone, "Rua Augusta 1500, Consolação, São Paulo, 20040-002");
  assert.match(ask, /CEP \*20040-002\* é de \*Rio de Janeiro\*[\s\S]*\*São Paulo\*/);
  const user = await userOf(phone);
  assert.equal(user.defaultAddress, null);
  assert.equal(user.cep, null);
  assert.match(await send(phone, "não"), /CEP certo/);
  const fixed = await send(phone, "Rua Augusta 1500, Consolação, São Paulo, 01305-100");
  assert.match(fixed, /Endereço salvo: Rua Augusta 1500, Consolação, São Paulo — CEP 01305-100/);
});

test("A5: 'sim' confirma o CEP de outra cidade", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "Rua Augusta 1500, Consolação, São Paulo, 20040-002");
  const out = await send(phone, "sim");
  assert.match(out, /Endereço salvo: Rua Augusta 1500, Consolação, São Paulo — CEP 20040-002/);
});

test("M7 + M6: CEP com espaço, 'Augusta 1500' sem 'Rua', 'Al. Santos' e 'não sei meu cep'", async (t) => {
  if (!dbOk) return t.skip();
  const a = newPhone();
  await send(a, "Rua Augusta 1500, 01305 100");
  assert.equal((await userOf(a)).defaultAddress, "Rua Augusta 1500");
  const b = newPhone();
  await send(b, "Augusta 1500, 01305-100");
  assert.equal((await userOf(b)).defaultAddress, "Rua Augusta, 1500, Consolação, São Paulo - SP");
  const c = newPhone();
  await send(c, "Al. Santos 1000, 01418-100");
  assert.equal((await userOf(c)).defaultAddress, "Al. Santos 1000");
  const d = newPhone();
  await send(d, "oi");
  assert.match(await send(d, "não sei meu cep"), /buscacep\.correios\.com\.br/);
});

test("M2: 'quanto tá o leite ninho?' no 1º contato anota o produto", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  const out = await send(phone, "boa noite, quanto ta o leite ninho?");
  assert.match(out, /preço de \*leite ninho\*/);
  assert.match(out, /Já anotei:\n• 1x leite ninho/);
  assert.equal((await ctxOf(phone)).pendingRequest, "leite ninho");
});

test("M1: apresentação e cortesia não são anotadas", async (t) => {
  if (!dbOk) return t.skip();
  for (const text of ["Oi Lia, sou a Clara Souza", "Bom dia! Tudo bem? Gostaria de fazer um pedido", "quero algo pra comer", "me liga"]) {
    const phone = newPhone();
    const out = await send(phone, text);
    assert.doesNotMatch(out, /anotei/i, `${text}: ${out.slice(0, 200)}`);
  }
  const phone = newPhone();
  const out = await send(phone, "Oi! Vi o anúncio de vocês. Vcs entregam remédio? Preciso de dipirona");
  assert.match(out, /Já anotei:\n• 1x dipirona\n\n/);
});

test("testadores: pergunta antes do cadastro é respondida e o endereço é pedido com CEP", async (t) => {
  if (!dbOk) return t.skip();
  __setRouterInterpreterForTests(async () => ({ action: "question", reply: "Não sou do iFood: sou a Lia, compro nas lojas pra você 🙂" }) as never);
  try {
    const phone = newPhone();
    const out = await send(phone, "vocês são do iFood?");
    assert.match(out, /Não sou do iFood/);
    assert.match(out, /endereço com CEP/);
    assert.doesNotMatch(out, /Falta o \*endereço\*/);
  } finally {
    __setRouterInterpreterForTests(null);
  }
});

test("M9: fora da área, a mensagem seguinte lembra o motivo e mostra a saída", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  assert.match(await send(phone, "Av Afonso Pena 1000, Centro, Belo Horizonte, 30130-000"), /Ainda não chego em Belo Horizonte/);
  const out = await send(phone, "quero shampoo");
  assert.match(out, /Ainda não entrego em Belo Horizonte[\s\S]*São Paulo ou Rio de Janeiro/);
  assert.doesNotMatch(out, /8 números/);
});

test("M10: 'apto 45' substitui o complemento do endereço salvo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await prisma.user.create({ data: { phone, cep: "01233-020", defaultAddress: "Rua Eng. Edgar Egidio de Souza 221 ap 13 Santa Cecília São Paulo", cpf: "52998224725", cpfName: "Maria da Silva" } });
  const out = await send(phone, "apto 45");
  assert.match(out, /Endereço atualizado: Rua Eng\. Edgar Egidio de Souza 221 apto 45 Santa Cecília São Paulo/);
});

test("M11: cadastro começando pelo CEP — nome e CPF não viram item; 1º endereço é 'salvo'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = newPhone();
  await send(phone, "oi");
  await send(phone, "quero ração de gato");
  await send(phone, "01233020");
  await send(phone, "Teste Silva");
  const cpf = await send(phone, "529.982.247-25");
  assert.match(cpf, /Anotei seu nome e CPF/);
  assert.equal((await userOf(phone)).cpfName, "Teste Silva");
  assert.doesNotMatch((await ctxOf(phone)).pendingRequest ?? "", /Teste|529/);
  const out = await send(phone, "Rua Jaguaribe 300 Santa Cecília São Paulo 01233020");
  assert.match(out, /Endereço salvo/);
  assert.doesNotMatch(out, /Endereço atualizado|Teste Silva|529/);
});
