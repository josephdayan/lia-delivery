// Rodada 21, grupo G58 (11/10). Textos de /mnt/project-files/testes-whatsapp/rodada21/grupo-b.md (R21-2, R21-7, R21-8,
// R21-11): festa com lista e "recomendação" fantasma, aviso de frete, hidratante de mão, complemento pelo nome da caneca,
// "máximo 60 reais", vela de aniversário, luva de limpeza, faxina "hoje", endereço por texto e "o mais barato" lento.
import "./helpers/load-env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/lib/lia-copy";
import { parseNeededBy, parseOrderBudget } from "../src/lib/lia-intents";
import { applyPhraseSynonyms, contextSenseFor } from "../src/lib/query-sense";
import { conciergeMatchIsStrong, type CatalogItem } from "../src/lib/stores/types";
import { suggestComplement } from "../src/lib/recommend/complement";
import { canonicalTypedAddress } from "../src/lib/address-parse";
import type { DeliveryContext, PendingChoice } from "../src/lib/conversation-types";

const item = (name: string): CatalogItem => ({ sku: `t-${name}`, name, unitPrice: 10, unit: "un" }) as CatalogItem;

// ---------------------------------------------------------------- R21-7: aviso de frete da loja nova

test("R21-7: o aviso de loja nova diz 'frete a partir de' (o frete cresce com mais itens de lá)", () => {
  const note = copy.choiceDeliveryCostNote({ deliveries: 2, newStores: ["Obramax"], fee: 14.99 });
  assert.match(note, /passa a ter \*2 entregas\* \(\+ frete a partir de ~R\$ 14,99\)/, note);
  assert.doesNotMatch(note, /\(\+ ~R\$/);
});

// ---------------------------------------------------------------- R21-8: hidratante de mão, complemento, "máximo 60 reais"

test("R21-8: 'hidratante de mão' busca e casa 'creme para mãos'", () => {
  assert.equal(applyPhraseSynonyms("hidratante de mão"), "creme para mãos");
  assert.equal(applyPhraseSynonyms("hidratante pra mãos nivea"), "creme para mãos nivea");
  assert.equal(applyPhraseSynonyms("creme de mão"), "creme para mãos");
  assert.equal(applyPhraseSynonyms("hidratante corporal"), "hidratante corporal");
  assert.equal(conciergeMatchIsStrong("creme para mãos", item("Creme para Mãos Monange 75g")), true);
  assert.equal(conciergeMatchIsStrong("creme de mão", item("Creme Hidratante para Mãos Nivea 75g")), true);
  assert.equal(conciergeMatchIsStrong("creme para mãos", item("Carmed Hidratante Labial")), false);
});

test("R21-8: caneca 'Café e Chá' não dispara filtro de café nem mel; café em pó continua disparando", () => {
  const opts = { shelfById: () => null };
  assert.equal(suggestComplement([{ sku: "a", name: "Caneca Cerâmica 330ml Casual Home Frases Sortidas Café e Chá" }], opts), null);
  assert.equal(suggestComplement([{ sku: "b", name: "Xícara de Chá Porcelana 200ml" }], opts), null);
  assert.equal(suggestComplement([{ sku: "c", name: "Café Torrado e Moído Pilão 500g" }], opts)?.trigger, "café");
  assert.equal(suggestComplement([{ sku: "d", name: "Chá de Camomila Dr. Oetker 10 sachês" }], opts)?.trigger, "chá");
});

test("R21-8: 'amigo secreto, máximo 60 reais' é o teto do pedido (💰), como 'no máximo'", () => {
  const b = parseOrderBudget("oi, preciso montar um presente de amigo secreto, máximo 60 reais");
  assert.equal(b?.cap, 60);
  assert.doesNotMatch(b!.rest, /60|maximo|máximo/);
  assert.equal(parseOrderBudget("quero caneca e chocolate, máximo 60 reais")?.cap, 60);
  // Colado num item só, segue teto do item.
  assert.equal(parseOrderBudget("vinho máximo 40 reais"), null);
});

// ---------------------------------------------------------------- R21-11: baixos

test("R21-11 B3/B4: 'vela' na festa vira vela de aniversário; 'luva de borracha' é luva de limpeza", () => {
  const vela = contextSenseFor("vela", ["oi, vou fazer o aniversario do meu filho de 5 anos domingo"]);
  assert.ok(vela);
  assert.ok(vela.extraQueries.includes("vela de aniversario"));
  assert.equal(vela.rejects("Vela Copo 1 Unidade Kosher"), true);
  assert.equal(vela.rejects("Vela Castiçal I Kosher"), true);
  assert.equal(vela.rejects("Vela Branca Número 3 Prata 12g 8 unidades"), false);
  assert.equal(contextSenseFor("vela", ["jantar romântico em casa"]), null, "sem festa, nada muda");
  assert.equal(contextSenseFor("vela aromática", ["festa"]), null, "pedido com tipo fica");
  const luva = contextSenseFor("luva de borracha", []);
  assert.ok(luva);
  assert.equal(luva.rejects("Luva Segurança Tricô Azul Borracha Imbat Tam M Ca 41736"), true);
  assert.equal(luva.rejects("Luva de Látex Multiuso Mucambo Tamanho M"), false);
  assert.ok(contextSenseFor("luva", ["faxina pesada hoje"]));
  assert.equal(contextSenseFor("luva", ["presente de inverno"]), null);
});

test("R21-11 B4: 'faxina pesada hoje: ...' é prazo de hoje", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assert.equal(parseNeededBy("faxina pesada hoje: desinfetante, pano de chão, rodo, vassoura, luva e saco de lixo 100L", now)?.label, "hoje");
});

test("R21-11 B5: endereço por texto com o bairro do jeito do cliente sai no formato do cadastro (com UF)", () => {
  const place = { street: "Rua Oscar Freire", district: "Cerqueira César", city: "São Paulo", uf: "SP" };
  assert.equal(canonicalTypedAddress("Rua Oscar Freire 800, Jardins, São Paulo", place), "Rua Oscar Freire, 800, Cerqueira César, São Paulo - SP");
  assert.equal(canonicalTypedAddress("Rua Oscar Freire 800 apto 12, Jardins, São Paulo", place), "Rua Oscar Freire, 800, apto 12, Cerqueira César, São Paulo - SP");
  assert.match(copy.signupDoneByText("Maria", copy.addressSavedPrefix("Rua Oscar Freire, 800, Cerqueira César, São Paulo - SP", "01426-001", "SP")), /^✅ Cadastro feito, Maria!\n📍 Endereço salvo: Rua Oscar Freire, 800/);
});

test("R21-11 B8: 'o mais barato' de 9 dias úteis diz qual chega antes e por quanto", async () => {
  const { cheapestForOrder } = await import("../src/lib/delivery-service");
  const p: PendingChoice = {
    query: "algodão",
    qty: 1,
    options: [
      { sku: "a", name: "Algodão Bella Cotton Maxi Bebê Com 50 Unidades", unitPrice: 23.29, storeKey: "drogariacatarinense", storeLabel: "Drogaria Catarinense", delivery: "9 dias úteis" },
      { sku: "b", name: "Algodão Higiene Bebê Basic+ Care Baby 100 un", unitPrice: 27.99, storeKey: "americanas", storeLabel: "Americanas", delivery: "2 dias úteis" }
    ]
  } as PendingChoice;
  const r = cheapestForOrder({} as DeliveryContext, p, []);
  assert.equal(r.index, 0, "a escolha continua a mais barata");
  assert.match(r.note ?? "", /só chega em \*9 dias úteis\*.*Algodão Higiene Bebê Basic\+ Care Baby 100 un.*Americanas.*chega em \*2 dias úteis\*/, r.note);
});

// ---------------------------------------------------------------- R21-2 (e2e): lista depois do contexto da festa

type Brain = typeof import("../src/lib/delivery-service");
let brain: Brain;
let prisma: typeof import("../src/lib/prisma").prisma;
const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5521${String(Date.now()).slice(-6)}${String(process.pid).slice(-2)}`;
let seq = 0;
let dbOk = false;
const outbox: { to: string; text: string }[] = [];
const realFetch = global.fetch;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await brain.runTurnScoped(() => brain.handleDeliveryMessage({ phone, text, messageId: `g58_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((m) => m.to === phone).map((m) => m.text).join("\n---\n");
}
async function wipe() {
  const users = await prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.recommendLog.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  if (!ids.length) return;
  await prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await prisma.waitlistLead.deleteMany({ where: { phone: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
before(async () => {
  brain = await import("../src/lib/delivery-service");
  ({ prisma } = await import("../src/lib/prisma"));
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  for (const key of Object.keys(whatsappAdapter) as (keyof typeof whatsappAdapter)[]) {
    if (typeof whatsappAdapter[key] !== "function" || !String(key).startsWith("send")) continue;
    (whatsappAdapter as Record<string, unknown>)[key] = async (to: string, text: unknown) => {
      outbox.push({ to, text: typeof text === "string" ? text : JSON.stringify(text) });
      return key === "sendDeliveryChoices" || key === "sendChoiceFollowUp" ? false : { provider: "test", to };
    };
  }
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/viacep\.com\.br\/ws\/01310100/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
after(async () => {
  global.fetch = realFetch;
  if (dbOk) await wipe();
  await prisma?.$disconnect();
});

test("R21-2/M4: festa com lista — nada de 'recomendação de festa infantil'; depois do endereço vêm os itens pedidos", async (t) => {
  if (!dbOk) return t.skip();
  const prev = process.env.LIA_RECOMMEND;
  process.env.LIA_RECOMMEND = "all";
  try {
    const phone = `${PREFIX}${String(++seq).padStart(4, "0")}`;
    await prisma.user.create({ data: { phone } });
    const first = await send(phone, "oi, vou fazer o aniversario do meu filho de 5 anos domingo, tenho 150 reais pra gastar");
    const ctx1 = JSON.parse((await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } })).context ?? "{}") as DeliveryContext;
    assert.ok(ctx1.pendingRecommend, `a festa é guardada como recomendação: ${first}`);
    const list = await send(phone, "preciso de balao, vela, prato de papel, copo descartavel e guardanapo");
    assert.match(list, /balao[\s\S]*vela[\s\S]*prato de papel[\s\S]*copo descartavel[\s\S]*guardanapo/i, list);
    assert.doesNotMatch(list, /recomenda[cç][aã]o de festa/i, list);
    assert.match(list, /R\$ 150,00/, "o teto segue anotado");
    const after = await send(phone, "Av Paulista 1000, Bela Vista, São Paulo, 01310-100");
    assert.doesNotMatch(after, /Pra \*festa infantil\*/, after);
    const ctx = JSON.parse((await prisma.conversation.findFirstOrThrow({ where: { user: { phone } } })).context ?? "{}") as DeliveryContext;
    assert.equal(ctx.pendingRecommend, undefined);
    assert.ok(!(ctx.pending ?? []).some((p) => p.recommendation), "nenhuma escolha de recomendação na mesa");
    // Os itens da lista foram buscados (escolha aberta ou "não achei" com o nome deles), não ficaram só no log.
    assert.match(after, /bal[aã]o|vela|prato|copo|guardanapo/i, after);
  } finally {
    if (prev === undefined) delete process.env.LIA_RECOMMEND;
    else process.env.LIA_RECOMMEND = prev;
  }
});

// ---------------------------------------------------------------- reteste do grupo A: R21a-6, R21a-7

test("R21a-6: 'parafuso' solto não mostra o de vaso/lavatório/telha; pedido com o tipo continua achando", () => {
  assert.equal(conciergeMatchIsStrong("parafuso", item("Parafuso para Vaso Sanitário e Bidê B10 80mm Inox")), false);
  assert.equal(conciergeMatchIsStrong("parafuso", item("Parafuso para Lavatório e Coluna com Bucha")), false);
  assert.equal(conciergeMatchIsStrong("parafuso", item("Parafuso Para Telha 5/16\" X 110mm 4 Peças Fixtil")), false);
  assert.equal(conciergeMatchIsStrong("parafuso", item("Parafuso Atarraxante Phillips Cabeça Panela 3,9x32 Fixtil")), true);
  assert.equal(conciergeMatchIsStrong("parafuso para telha", item("Parafuso Para Telha 5/16\" X 110mm 4 Peças Fixtil")), true);
});

test("R21a-6: 'tesoura' na lista da escola (ou 'tesoura escolar') tira a multiuso da frente", () => {
  const s = contextSenseFor("tesoura", ["papel de presente, tesoura e 2 apontadores"]);
  assert.ok(s);
  assert.equal(s.rejects("Tesoura Multiuso Reta Aço Inox Vonder"), true);
  assert.equal(s.rejects("Tesoura Escolar Sem Ponta Tramontina 13cm"), false);
  assert.ok(contextSenseFor("tesoura escolar", []));
  assert.equal(contextSenseFor("tesoura", ["vou fazer um frango assado"]), null);
});

test("R21a-7: 'sábado ao meio dia' guarda a hora; o fim da escolha diz que os botões são do pedido", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assert.deepEqual(parseNeededBy("preciso que chegue sábado ao meio dia", now), { date: "2026-10-17", label: "sábado às 12h", hour: 12 });
  assert.match(copy.conciergeChooseNext(), /toca em \*Pagar\* aí embaixo/);
  assert.doesNotMatch(copy.conciergeChooseNext(), /Escolhe aí embaixo/);
});
