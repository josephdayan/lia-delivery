// Retorno dos testadores em 06/10/2026 (família e grupo "Teste zap"), cada teste guarda um
// defeito real daquela manhã:
//   - Clara: "apto 4" mandado depois do endereço virou busca de placa de apartamento; quem
//     mandou rua e CEP em mensagens separadas nunca teve o CPF pedido; "de onde vc compra?"
//     não era respondido.
//   - Adely: "só amora" na vez da framboesa virou busca "framboesa só amora".
//   - Claire: "veja se tem kerasys de coco" repetia o shampoo sem coco; "qual a loja?" e
//     "você faz comparativo de preços?" tinham resposta vaga ou falsa.
//   - Tio Semy: pediu o tubo com 4 bolas e veio o de 3.
//   - Tati: Euthyrox (remédio de receita) recebia "não achei, me diz outra marca".
// Puros sempre; conversa com banco local (npm run test:local).
import "./helpers/load-env";
import "./helpers/medicine-env";

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage } from "../src/lib/delivery-service";
import {
  detectIntent,
  parseAddressComplement,
  parseAttributeAsk,
  parseBasketLines,
  parseOnlyKeep,
  withAddressComplement
} from "../src/lib/lia-intents";
import { isPrescriptionText, looksLikeMedicineName } from "../src/lib/medicine";
import { scoreCatalogMatch } from "../src/lib/stores/types";
import * as copy from "../src/lib/lia-copy";

// ---------- puros ----------

test("complemento sozinho é reconhecido; produto e frase comum não", () => {
  for (const [input, expected] of [
    ["apto 4", "apto 4"],
    ["sou apto 4", "apto 4"],
    ["ap 23", "ap 23"],
    ["Apto 52 bloco B", "Apto 52 bloco B"],
    ["bloco B apto 31", "bloco B apto 31"],
    ["casa 2", "casa 2"],
    ["20º andar", "20º andar"],
    ["apartamento 12", "apartamento 12"],
    ["esqueci de falar apto 4", "apto 4"]
  ] as const) {
    assert.equal(parseAddressComplement(input), expected, input);
  }
  for (const input of ["apto", "quero arroz", "bloco de notas", "2 leites", "casa", "Rua das Flores 10", "01310-100", "4"]) {
    assert.equal(parseAddressComplement(input), null, input);
  }
});

test("complemento entra depois do número; troca o do mesmo tipo e soma outro tipo", () => {
  assert.equal(withAddressComplement("rua engenheiro edgar egidio de souza 303", "apto 4"), "rua engenheiro edgar egidio de souza 303, apto 4");
  assert.equal(
    withAddressComplement("Avenida Paulista, 1000, Bela Vista, São Paulo - SP", "apto 4"),
    "Avenida Paulista, 1000, apto 4, Bela Vista, São Paulo - SP"
  );
  assert.equal(withAddressComplement("Rua Aracaju 201, apto Di", "apto 23"), "Rua Aracaju 201, apto 23");
  assert.equal(withAddressComplement("Rua A, 10, bloco B", "apto 31"), "Rua A, 10, bloco B, apto 31");
});

test("'só amora' / 'só essa' / 'só isso'", () => {
  assert.deepEqual(parseOnlyKeep("So amora"), { target: "amora" });
  assert.deepEqual(parseOnlyKeep("somente a amora"), { target: "amora" });
  assert.deepEqual(parseOnlyKeep("So essa"), { demonstrative: true });
  assert.equal(parseOnlyKeep("só isso"), null, "só isso continua sendo encerrar a lista");
  assert.equal(parseOnlyKeep("quero amora"), null);
});

test("pedido de característica do mesmo produto", () => {
  assert.equal(parseAttributeAsk("Veja se tem kerasys de coco"), "kerasys de coco");
  assert.equal(parseAttributeAsk("tem de coco?"), "de coco");
  assert.equal(parseAttributeAsk("Eu pedi com 4 bolas"), "com 4 bolas");
  assert.equal(parseAttributeAsk("quero 2 arroz"), null);
});

test("perguntas de loja e de comparação de preço viram resposta fixa", () => {
  for (const q of ["Qual a loja?", "mas de onde vc compra", "de que loja ela vem", "eh uma loja especifica?", "de qual mercado é?"]) {
    assert.deepEqual(detectIntent(q), { kind: "service_question", topic: "stores" }, q);
  }
  for (const q of ["Voce faz comparativo de precos?", "Como sei que este é o melhor valor?", "Ele nao faz pesquisa de precos ne?"]) {
    assert.deepEqual(detectIntent(q), { kind: "service_question", topic: "price_compare" }, q);
  }
  assert.equal(detectIntent("vcs tem loja física?").kind, "store_location_question");
  assert.notDeepEqual(detectIntent("mais barato"), { kind: "service_question", topic: "price_compare" });
  assert.match(copy.priceCompareAnswer(), /Comparo, sim/);
  assert.doesNotMatch(copy.priceCompareAnswer(), /não faço/i);
  assert.match(copy.storesAnswer([{ storeLabel: "Mambo" }, { storeLabel: "Mambo" }, { storeLabel: "Swift" }]), /\*1\)\* Mambo · \*2\)\* Mambo · \*3\)\* Swift/);
  assert.match(copy.storesAnswer([{ storeLabel: "Drogal" }]), /Essa opção é da loja \*Drogal\*/);
});

test("'quero comprar X' e 'quero pedir X' anotam só o produto", () => {
  assert.equal(parseBasketLines("Quero comprar shampoo kerasys")[0]?.phrase, "shampoo kerasys");
  assert.equal(parseBasketLines("Quero comprar fita isolante preta da 3M")[0]?.phrase, "fita isolante preta da 3M");
});

test("contagem na embalagem é identidade: tubo com 4 bolas não aceita o de 3", () => {
  const q = "tubo bola tenis babolat gold 4 bolas";
  assert.equal(scoreCatalogMatch(q, { name: "Bola De Tênis Babolat Gold Championship (tubo Com 3 Bolas)" } as never), 0);
  assert.ok(scoreCatalogMatch(q, { name: "Bola de Tênis Babolat Gold All Court Tubo com 4 Bolas" } as never) > 0);
  // Sem contagem no nome, nada muda; quantidade a comprar ("latas") fica fora da regra.
  assert.ok(scoreCatalogMatch("papel higienico 12 rolos", { name: "Papel Higiênico Neve Folha Dupla 12 Rolos" } as never) > 0);
  assert.equal(scoreCatalogMatch("papel higienico 12 rolos", { name: "Papel Higiênico Neve Folha Dupla 4 Rolos" } as never), 0);
});

test("Euthyrox é remédio de receita; nome com dose tem cara de remédio", () => {
  assert.equal(isPrescriptionText("2 cxs de Euthyrox 50mg"), true);
  assert.equal(looksLikeMedicineName("Euthyrox 50 mg"), true);
  assert.equal(looksLikeMedicineName("arroz 5kg"), false);
});

// ---------- conversa, com banco ----------

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5509${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
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
const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/viacep\.com\.br\/ws\/01310100/.test(url)) {
    return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await handleDeliveryMessage({ phone, text, messageId: `fb_${RUN}_${++seq}` });
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function customer(extra: Record<string, unknown> = {}) {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, cpf: "52998224725", cpfName: "Maria da Silva", ...extra } });
  return phone;
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
});
after(async () => {
  if (dbOk) await wipe();
  global.fetch = realFetch;
  await prisma.$disconnect();
});

test("Clara: 'apto 4' no meio da escolha entra no endereço e as opções voltam, sem busca", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero arroz");
  assert.match(first, /Responde \*1\*/, first.slice(0, 300));
  const out = await send(phone, "apto 4");
  assert.match(out, /Endereço atualizado: Rua das Flores, 123, apto 4, Bela Vista/);
  assert.match(out, /Responde \*1\*/, "a escolha aberta volta");
  assert.doesNotMatch(out, /apartamento|placa|Não achei esse item/i, out.slice(0, 400));
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(user.defaultAddress, "Rua das Flores, 123, apto 4, Bela Vista, São Paulo - SP");
});

test("Clara: rua numa mensagem e CEP noutra também pedem nome e CPF", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await send(phone, "oi");
  const saved = await send(phone, "Avenida Paulista 1000");
  assert.match(saved, /Falta o \*CEP\*/);
  const out = await send(phone, "01310100");
  assert.match(out, /nome completo[\s\S]*CPF/i, out.slice(0, 300));
});

test("Clara: 'de onde vc compra' no cadastro tem resposta", async (t) => {
  if (!dbOk) return t.skip();
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  await send(phone, "oi");
  const out = await send(phone, "mas de onde vc compra");
  assert.match(out, /dezenas de lojas online/);
  assert.doesNotMatch(out, /Falta o \*endereço\*/);
});

test("Adely: 'só arroz' na vez do feijão fecha a lista com o arroz escolhido", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero arroz e feijão");
  const afterPick = await send(phone, "1");
  assert.match(afterPick, /feij/i, afterPick.slice(0, 300));
  const out = await send(phone, "só arroz");
  assert.match(out, /Fechado, fica só o que você escolheu\. Tirei da lista: \*feij/i, out.slice(0, 400));
  const convo = await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  const ctx = JSON.parse(convo.context ?? "{}");
  assert.equal(ctx.pending?.length ?? 0, 0, "nada pendente");
  assert.ok(ctx.basket?.some((i: { name: string }) => /arroz/i.test(i.name)) || /arroz/i.test(out), "o arroz continua");
});

test("Claire: 'veja se tem de coco' busca o shampoo de coco e não repete o outro", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const first = await send(phone, "quero shampoo");
  assert.match(first, /Responde \*1\*/, first.slice(0, 300));
  const out = await send(phone, "veja se tem de coco");
  const options = out.split("\n").filter((line) => /^\*\d\)\*/.test(line));
  assert.ok(options.length >= 1, out.slice(0, 400));
  assert.ok(options.every((line) => /coco/i.test(line)), `só opções de coco: ${options.join(" | ")}`);
});

test("Claire: marca + característica que não existem juntas viram 'não achei', nunca outra marca", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero shampoo");
  const out = await send(phone, "veja se tem kerasys de coco");
  const options = out.split("\n").filter((line) => /^\*\d\)\*/.test(line));
  assert.ok(options.every((line) => !/coco/i.test(line) || /kerasys/i.test(line)), `nenhum coco de outra marca como se fosse kerasys: ${options.join(" | ")}`);
  assert.match(out, /kerasys coco/i, out.slice(0, 300));
});

test("Claire: dois produtos no meio da escolha trocam a escolha e enfileiram o outro", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero shampoo");
  const out = await send(phone, "quero shampoo cuide-se bem feira oleo de coco, condicionador cuide-se bem feira oleo de coco");
  const options = out.split("\n").filter((line) => /^\*\d\)\*/.test(line));
  assert.ok(options.length >= 1, out.slice(0, 400));
  assert.match(options[0] ?? "", /shampoo[\s\S]*coco/i, `escolha trocada pelo shampoo de coco: ${options.join(" | ")}`);
  assert.match(out, /condicionador/i, "o condicionador entra na fila (ou já na cesta)");
});

test("Claire: 'qual a loja?' nomeia a loja das opções; comparação de preço é verdadeira", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  await send(phone, "quero shampoo");
  const stores = await send(phone, "Qual a loja?");
  assert.match(stores, /loja \*\w|Cada opção é de uma loja: \*1\)\* \w/, stores);
  const compare = await send(phone, "Voce faz comparativo de precos?");
  assert.match(compare, /Comparo, sim/);
});

test("Tati: Euthyrox é recusado como remédio de receita, sem 'me diz outra marca'", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, "Ola quero 2 cxs de Euthyrox 50mg");
  assert.match(out, /receita/i, out);
  assert.doesNotMatch(out, /outra marca/i);
});

test("dono (06/10): toda opção mostra a loja junto do prazo", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customer();
  const out = await send(phone, "quero arroz");
  const options = out.split("\n").filter((line) => /^\*\d\)\*/.test(line));
  assert.ok(options.length >= 1, out.slice(0, 300));
  assert.ok(options.every((line) => / · _[A-ZÀ-Ú][^_]*_/.test(line)), `loja em cada linha: ${options.join(" | ")}`);
  assert.ok(options.every((line) => !/prazo da loja:/.test(line)), "o rótulo genérico some quando a loja aparece");
});
