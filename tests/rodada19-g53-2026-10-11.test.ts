// Rodada 19, grupo G53 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada19/grupo-b.md e grupo-a.md (R19-*, R19a-*).
import "./helpers/load-env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { whatsappAdapter } from "../src/lib/adapters/whatsapp";
import { handleDeliveryMessage, runTurnScoped } from "../src/lib/delivery-service";
import { __setDialogueModelForTests } from "../src/lib/dialogue";
import { __setPreSignupModelForTests } from "../src/lib/dialogue/presignup";
import { __setPreflightForTests } from "../src/lib/live-freight";
import { applyPetHint, baseSenseFor, cleanAskPhrase, petHintForTurn, petHintFrom } from "../src/lib/query-sense";
import { otherBrandAsk, splitNegatedTerms } from "../src/lib/lia-intents";
import { productKindConflict, variantPenalty } from "../src/lib/stores/types";
import { suggestComplement } from "../src/lib/recommend/complement";
import * as copy from "../src/lib/lia-copy";

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5527${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const adapter = whatsappAdapter as unknown as Record<string, unknown>;
const original = { ...adapter };
for (const key of Object.keys(adapter)) {
  if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
  adapter[key] = async (to: string, text: unknown, more?: unknown) => {
    outbox.push({ to, kind: key, text: [text, more].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ") });
    return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
  };
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
beforeEach(() => {
  __setDialogueModelForTests(null);
  __setPreSignupModelForTests(null);
  __setPreflightForTests(async () => null);
  delete process.env.LIA_DIALOGUE_LLM;
});
after(async () => {
  __setPreflightForTests(null);
  if (dbOk) await wipe();
  Object.assign(adapter, original);
  await prisma.$disconnect();
});

async function customer() {
  const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
  const user = await prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: "collecting", context: JSON.stringify({ flow: "delivery", step: "collecting", cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true }) }
  });
  return { phone };
}
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await runTurnScoped(() => handleDeliveryMessage({ phone, text, messageId: `g53_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}

// ---------------------------------------------------------------- R19-2: espécie dita antes vale para a busca

test("R19-2: 'tenho uma gata castrada de 4 anos' dá a espécie e a fase; 'ração' sem espécie ganha as duas", () => {
  const hint = petHintFrom(["preciso de ração pra ela", "tenho uma gata castrada de 4 anos"]);
  assert.deepEqual(hint, { species: "gato", stage: "castrado" });
  assert.equal(applyPetHint("ração", hint), "ração pra gato castrado");
  assert.equal(applyPetHint("petisco", hint), "petisco pra gato");
  // Frase que já diz a espécie, ou que não é comida de pet, fica como está.
  assert.equal(applyPetHint("ração de cachorro", hint), "ração de cachorro");
  assert.equal(applyPetHint("areia sanitária", hint), "areia sanitária");
  assert.deepEqual(petHintFrom(["tenho um cachorro de 10 anos"]), { species: "cachorro", stage: "senior" });
  // Espécie oposta citada no turno atual desliga a da conversa.
  assert.equal(petHintForTurn(["e um petisco pro cachorro"], ["tenho uma gata"]), null);
  assert.equal(petHintFrom(["oi, tudo bem?"]), null);
});

test("R19-2: depois de 'tenho uma gata castrada', 'preciso de ração pra ela' só mostra ração de gato", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await customer();
  await send(phone, "tenho uma gata castrada de 4 anos");
  const out = await send(phone, "preciso de ração pra ela");
  assert.match(out, /Gat/i, out);
  assert.doesNotMatch(out, /C[aã]es|Cachorro|C[aã]o Adulto/i, out);
});

// ---------------------------------------------------------------- R19-3: "base" com contexto de maquiagem

test("R19-3: 'base' num pedido de make tira base de unha; contexto de unha tira base de rosto; sem contexto, nada", () => {
  const makeup = baseSenseFor("base", ["e aí mano, preciso de uns trem de make hj, base, batom vermelho e um gloss, tipo mt barato"]);
  assert.equal(makeup?.kind, "maquiagem");
  assert.equal(makeup?.rejects("Base Fortilon Salva Unhas Recuperador 7ml"), true);
  assert.equal(makeup?.rejects("Base Primer Fortalecedora Risqué Diamond Gel 9,5ml"), true);
  assert.equal(makeup?.rejects("Base Líquida Vult Matte Hidraluronic V270 26ml"), false);
  assert.equal(makeup?.rejects("Base BB Cream L'Oréal Paris Efeito Matte FPS 50 Cor Média 30ml"), false);
  const nail = baseSenseFor("base", ["base e esmalte vermelho"]);
  assert.equal(nail?.kind, "unha");
  assert.equal(nail?.rejects("Base Líquida Vult Matte Hidraluronic V270 26ml"), true);
  assert.equal(nail?.rejects("Base Fortalecedora Colorama Cuidados 8ml"), false);
  // A conversa decide quando a mensagem não diz.
  assert.equal(baseSenseFor("base", ["quero uma base", "comprei um batom ontem"])?.kind, "maquiagem");
  assert.equal(baseSenseFor("base", ["quero uma base"]), null);
  // Frase que já diz o tipo não passa pelo sentido.
  assert.equal(baseSenseFor("base de unha", ["batom e base de unha"]), null);
});

test("R19-3: 'preciso de base, batom vermelho e gloss' não oferece base de unha", async (t) => {
  if (!dbOk) return t.skip();
  const { phone } = await customer();
  const out = await send(phone, "preciso de maquiagem: base, batom vermelho e gloss");
  assert.doesNotMatch(out, /Unhas|Fortilon|Risqu[eé]|Fortalecedor/i, out);
});

// ---------------------------------------------------------------- R19-8: Natal sem ocasião de Natal

test("R19-8: papel de presente de Natal vai depois quando o cliente não fala de Natal; 'não natal' é negação", () => {
  assert.ok(variantPenalty("papel de presente", "Papel de Presente Natal 70x100cm Cromus Couchê 80g") > variantPenalty("papel de presente", "Papel Presente Diver 70x100 cm 100 Folhas Cromus Sortido"));
  assert.equal(variantPenalty("papel de presente natal", "Papel de Presente Natal 70x100cm Cromus Couchê 80g"), 0);
  assert.deepEqual(splitNegatedTerms("mas é aniversário, não natal. tem papel de presente infantil de aniversário?").excluded, ["natal"]);
  assert.deepEqual(splitNegatedTerms("na verdade é pra um periquito, não calopsita").excluded, ["calopsita"]);
  // "não" + verbo não é termo negado.
  for (const t of ["não precisa", "não sei", "não, obrigado", "pode ser, não tem problema"]) assert.deepEqual(splitNegatedTerms(t).excluded, [], t);
  assert.match(copy.choicesWithoutTerm("papel de presente", ["natal"]), /Sem \*natal\*/);
  assert.match(copy.onlyChoicesWithTerm("papel de presente", ["natal"]), /só tenho com \*natal\*/);
});

// ---------------------------------------------------------------- R19-10: outra marca com prazo

test("R19-10: 'e fralda de outra marca que chegue hoje, tem?' é pedido de outra marca do item", () => {
  assert.deepEqual(otherBrandAsk("e fralda de outra marca que chegue hoje, tem?"), { item: "fralda" });
  assert.deepEqual(otherBrandAsk("tem fralda de outra marca?"), { item: "fralda" });
  assert.deepEqual(otherBrandAsk("lenço umedecido de outra marca até as 20h"), { item: "lenco umedecido" });
  // Outro produto no rabo, ou troca explícita: não é isto.
  assert.equal(otherBrandAsk("fralda de outra marca e um sabonete"), null);
  assert.equal(otherBrandAsk("quero pagar"), null);
  assert.match(copy.otherBrandNotOnTime("fralda", "hoje", "Fralda Pampers M"), /nenhuma chega até \*hoje\*.*Fralda Pampers M/);
});

// ---------------------------------------------------------------- R19-12

test("R19-12 (703): juntar com o mesmo produto não lista a 'troca' por ele mesmo", () => {
  const same = { fromName: "Lenço Umedecido Piquitucho Premium Capim Limão 60 Unidades", fromPrice: 10.57, toName: "Lenço Umedecido Piquitucho Premium Capim Limão 60 Unidades", toPrice: 10.57 };
  const other = { fromName: "Pomada Hipoglós 40g", fromPrice: 27.17, toName: "Pomada Bepantol Baby 30g", toPrice: 25.5 };
  const both = copy.basketConsolidated("Drogal", [same, other], 0, { saved: 6.9 });
  assert.doesNotMatch(both, /Piquitucho/);
  assert.match(both, /Bepantol/);
  assert.match(copy.basketConsolidated("Drogal", [same], 0, { saved: 6.9 }), /só muda a loja/);
});

test("R19-12 (707): copo de 50 ml vai depois do copo de festa quando não pediram medida", () => {
  assert.ok(variantPenalty("copo descartavel", "Copo Descartável Bello Festas 50ml Poliestireno Branco 50 Unidades") > variantPenalty("copo descartavel", "Copo Descartável Transparente Copobras 200ml 100 Unidades"));
  assert.equal(variantPenalty("copo descartavel 50ml", "Copo Descartável Bello Festas 50ml Poliestireno Branco 50 Unidades"), 0);
  assert.equal(variantPenalty("copo para cafe", "Copo Descartável para Café 50ml"), 0);
});

test("R19-12 (705): frete de mais da metade dos produtos em 2 entregas tem aviso", () => {
  const note = copy.expensiveShippingNote(188.76, 118.2, 2);
  assert.equal(note.length, 1);
  assert.match(note[0], /passa da metade/);
  assert.equal(copy.expensiveShippingNote(188.76, 40, 2).length, 0);
  assert.equal(copy.expensiveShippingNote(100, 40, 1).length, 0);
});

test("R19-12 (704/707): churrasco com pão de alho não recebe 'Pão pede uma manteiga'", () => {
  const shelfById = () => null;
  const churrasco = [
    { name: "Carvão Fogozão Especial Pacote 3kg", sku: "a" },
    { name: "Pão de Alho Baguete Tradicional Santa Massa 400g", sku: "b" },
    { name: "Refrigerante Coca-Cola 2 Litros", sku: "c" }
  ];
  assert.notEqual(suggestComplement(churrasco, { shelfById })?.query, "manteiga");
  assert.equal(suggestComplement([{ name: "Pão Francês 500g", sku: "d" }], { shelfById })?.query, "manteiga");
});

// ---------------------------------------------------------------- R19a-7 / R19a-10

test("R19a-7: tesoura de poda não é troca de tesoura escolar", () => {
  assert.equal(productKindConflict("Tesoura Escolar Sem Ponta Tris tesoura escolar", "Tesoura de Poda Bolder"), true);
  assert.equal(productKindConflict("Tesoura Escolar Sem Ponta Tris", "Tesoura Escolar Leonora 13cm"), false);
});

test("R19a-10: 'tem poleiro de qualquer material então' busca 'poleiro'", () => {
  assert.equal(cleanAskPhrase("tem poleiro de qualquer material então"), "poleiro");
  assert.equal(cleanAskPhrase("poleiro de madeira"), "poleiro de madeira");
  assert.equal(cleanAskPhrase("tempero baiano"), "tempero baiano");
});
