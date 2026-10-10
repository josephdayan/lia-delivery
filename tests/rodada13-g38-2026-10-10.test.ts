// Rodada 13, grupo G38 (10/10): achados de /mnt/project-files/testes-whatsapp/rodada13/grupo-b.md (jornadas 301, 302,
// 303, 305, 307, 308). Conversas pelo caminho real (runTurnScoped + handleDeliveryMessage, como o webhook):
//   1. (A3) no fechamento, a Americanas recusou SÓ o guardanapo (a simulação da cesta devolve a linha dele só com
//      "Retirada" junto das 3 Cocas) e a Lia zerou a cesta inteira com "Não tenho estes itens…";
//   2. (M2/M10) "arroz 5kg" com o 1º card da Swift buscava só na Swift; "café em pó" não achava "torrado e moído"; fruta,
//      verdura e carne casavam com brinquedo, diluente de esmalte e salgadinho; "carne moída" 3x em "Ficou de fora";
//   3. (M3/M8) cesta em 3+ entregas sem como juntar: a Lia só dizia "se quiser, junto em menos lojas" — agora oferece trocar
//      o item que abre a entrega mais cara por um de loja que já está na cesta.
import "./helpers/load-env";
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// As lojas do caso real ficam ligadas só neste arquivo (o registry lê as flags na importação: o cérebro é importado
// DEPOIS, dentro do before).
process.env.LIA_ENABLE_AMERICANAS = "true";
process.env.LIA_ENABLE_MAMBO = "true";
process.env.LIA_ENABLE_SANTALUZIA = "true";
process.env.LIA_ENABLE_DROGARIASPACHECO = "true";

type Mods = {
  prisma: typeof import("../src/lib/prisma").prisma;
  handleDeliveryMessage: typeof import("../src/lib/delivery-service").handleDeliveryMessage;
  runTurnScoped: typeof import("../src/lib/delivery-service").runTurnScoped;
  setPreflight: typeof import("../src/lib/live-freight").__setPreflightForTests;
  liveStoreFreight: typeof import("../src/lib/live-freight").liveStoreFreightDetailed;
  clearLive: typeof import("../src/lib/live-availability").__clearLiveCheckCacheForTests;
  types: typeof import("../src/lib/stores/types");
  copy: typeof import("../src/lib/lia-copy");
};
let m: Mods;
let dialogue: typeof import("../src/lib/dialogue");

const RUN = `${Date.now().toString(36)}${process.pid}`;
const PREFIX = `+5538${String(Date.now()).slice(-5)}${String(process.pid).slice(-2)}`;
const ADDRESS = "Avenida Paulista, 1000, Bela Vista, São Paulo - SP";
let seq = 0;
let dbOk = false;
const outbox: { to: string; kind: string; text: string }[] = [];
const realFetch = globalThis.fetch;
const STRICT_ENV = { LIA_LIVE_FREIGHT_OFF: "false", LIA_CHARGE_ONLY_VERIFIED: "true", LIA_OPERATOR_QUOTE: "false" } as const;
const savedEnv: Record<string, string | undefined> = {};
function strictMode() {
  for (const [k, v] of Object.entries(STRICT_ENV)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

// Simulação VTEX como a Americanas respondeu em 10/10 (medido): o guardanapo 8845181 sozinho tem "Entrega"; junto da
// cesta, só "Retirada". As outras linhas (e as outras lojas) sempre têm entrega.
const PICKUP_ONLY_IN_BASKET = new Set(["8845181"]);
function mockVtex() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/viacep\.com\.br/.test(url)) return new Response(JSON.stringify({ logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" }), { status: 200 });
    if (!url.includes("orderForms/simulation")) return new Response("{}", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { items: { id: string; quantity: number }[] };
    const n = body.items.length;
    return new Response(
      JSON.stringify({
        items: body.items.map((i) => ({ id: i.id, quantity: i.quantity, sellingPrice: 1000, availability: "available" })),
        logisticsInfo: body.items.map((i, itemIndex) => ({
          itemIndex,
          slas:
            n > 1 && PICKUP_ONLY_IN_BASKET.has(i.id)
              ? [{ id: "Retirada (l029)", name: "Retirada (l029)", price: 0, shippingEstimate: "2h", pickupStoreInfo: { isPickupStore: true } }]
              : [{ id: "Entrega", name: "Entrega", price: Math.round(1290 / n), shippingEstimate: "2bd" }]
        }))
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

async function wipe() {
  const users = await m.prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await m.prisma.message.deleteMany({ where: { conversation: { userId: { in: ids } } } });
  await m.prisma.deliveryOrder.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.conversation.deleteMany({ where: { userId: { in: ids } } });
  await m.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  const { prisma } = await import("../src/lib/prisma");
  const service = await import("../src/lib/delivery-service");
  const freight = await import("../src/lib/live-freight");
  const live = await import("../src/lib/live-availability");
  const { whatsappAdapter } = await import("../src/lib/adapters/whatsapp");
  dialogue = await import("../src/lib/dialogue");
  m = {
    prisma,
    handleDeliveryMessage: service.handleDeliveryMessage,
    runTurnScoped: service.runTurnScoped,
    setPreflight: freight.__setPreflightForTests,
    liveStoreFreight: freight.liveStoreFreightDetailed,
    clearLive: live.__clearLiveCheckCacheForTests,
    types: await import("../src/lib/stores/types"),
    copy: await import("../src/lib/lia-copy")
  };
  const adapter = whatsappAdapter as unknown as Record<string, unknown>;
  for (const key of Object.keys(adapter)) {
    if (typeof adapter[key] !== "function" || !key.startsWith("send")) continue;
    adapter[key] = async (to: string, ...rest: unknown[]) => {
      outbox.push({ to, kind: key, text: rest.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") });
      return key === "sendMessage" || key === "sendMedia" ? { provider: "test", to } : null;
    };
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
    await wipe();
  } catch (error) {
    if (process.env.LIA_REQUIRE_DB === "1") throw error;
  }
});
beforeEach(() => {
  m.setPreflight(async () => null);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  m.clearLive();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
after(async () => {
  m.setPreflight(null);
  globalThis.fetch = realFetch;
  if (dbOk) await wipe();
  await m.prisma.$disconnect();
});

const newPhone = () => `${PREFIX}${String(++seq).padStart(4, "0")}`;
async function send(phone: string, text: string): Promise<string> {
  const start = outbox.length;
  await m.runTurnScoped(() => m.handleDeliveryMessage({ phone, text, messageId: `g38_${RUN}_${++seq}` }));
  return outbox.slice(start).filter((o) => o.to === phone).map((o) => o.text).join("\n---\n");
}
async function ctxOf(phone: string) {
  const convo = await m.prisma.conversation.findFirstOrThrow({ where: { user: { phone } } });
  return JSON.parse(convo.context ?? "{}") as import("../src/lib/conversation-types").DeliveryContext;
}
async function customerWith(ctxExtra: Record<string, unknown>, step = "collecting") {
  const phone = newPhone();
  const user = await m.prisma.user.create({ data: { phone, cep: "01310-100", defaultAddress: ADDRESS, name: "Maria da Silva" } });
  await m.prisma.conversation.create({
    data: { userId: user.id, status: "active", currentStep: step, context: JSON.stringify({ flow: "delivery", step, cep: "01310-100", deliveryAddress: ADDRESS, deliveryAddressVerified: true, storeKey: "concierge", ...ctxExtra }) }
  });
  return phone;
}
const line = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string, qty = 1, ask?: string) =>
  ({ sku, name, qty, unitPrice, lineTotal: unitPrice * qty, storeKey, storeLabel, ...(ask ? { ask } : {}) });
const opt = (sku: string, name: string, unitPrice: number, storeKey: string, storeLabel: string) => ({ sku, name, unitPrice, storeKey, storeLabel });

// ---------------- 1. A3: a cesta não some quando a loja recusa um item ----------------

test("A3: a simulação diz QUAL linha não tem entrega — só ela sai, não a loja inteira", async () => {
  strictMode();
  mockVtex();
  const out = await m.liveStoreFreight("americanas", [{ sku: "americanas-8817266", qty: 1 }, { sku: "americanas-8845181", qty: 1 }, { sku: "americanas-3951884", qty: 3 }], "01310100");
  assert.equal(out.kind, "no-delivery");
  assert.deepEqual(out.refusedSkus, ["americanas-8845181"]);
  const alone = await m.liveStoreFreight("americanas", [{ sku: "americanas-8817266", qty: 1 }, { sku: "americanas-3951884", qty: 3 }], "01310100");
  assert.equal(alone.kind, "ok");
});

test("A3 (308): guardanapo recusado no fechamento — vela e Coca ficam, e o guardanapo volta com opção de outra loja", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  const vela = line("americanas-8817266", "Vela de Aniversário Treze Estrelas Nº 4 com 8 Unidades", 8.99, "americanas", "Americanas", 1, "vela de aniversário");
  const guardanapo = line("americanas-8845181", "Guardanapo Papel 33x33cm Snob 50 Unidades", 4.49, "americanas", "Americanas", 1, "guardanapo");
  const coca = line("americanas-3951884", "Refrigerante Coca-Cola 2L Original", 12.99, "americanas", "Americanas", 3, "refrigerante 2L");
  const phone = await customerWith({
    basket: [vela, guardanapo, coca],
    recentShown: [{ sku: guardanapo.sku, options: [opt("americanas-8845181", guardanapo.name, 4.49, "americanas", "Americanas"), opt("mambo-6911", "Guardanapo Kitchen 22,7cm x 22,8cm com 50 unidades", 3.62, "mambo", "Mambo")] }],
    consolidationTried: [vela, guardanapo, coca].map((i) => `${i.sku}x${i.qty}`).sort().join("|")
  });
  const out = await send(phone, "só isso");
  assert.doesNotMatch(out, /Não tenho estes itens/, out.slice(0, 600));
  assert.match(out, /Guardanapo[^\n]*Americanas/, out.slice(0, 600));
  assert.match(out, /resto da cesta continua/i, out.slice(0, 600));
  assert.match(out, /Guardanapo Kitchen/, "a opção de outra loja que entrega aparece");
  const ctx = await ctxOf(phone);
  assert.deepEqual((ctx.basket ?? []).map((i) => i.sku).sort(), [coca.sku, vela.sku].sort(), "vela e Coca continuam na cesta");
  assert.equal(ctx.step, "choosing");
  assert.equal(ctx.pending?.[0]?.options[0]?.sku, "mambo-6911");
  // Escolhe a de outra loja: a cesta volta a ter os 3 itens.
  await send(phone, "1");
  const after = await ctxOf(phone);
  const skus = [...(after.basket ?? []), ...((await m.prisma.deliveryOrder.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } }))?.items as Array<{ sku: string }> ?? [])].map((i) => i.sku);
  for (const sku of [vela.sku, coca.sku, "mambo-6911"]) assert.ok(skus.includes(sku), `${sku} na cesta/pedido: ${skus.join(",")}`);
});

test("A3: a loja inteira recusa e não há opção que entregue — diz o item E a loja", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  const guardanapo = line("americanas-8845181", "Guardanapo Papel 33x33cm Snob 50 Unidades", 34.49, "americanas", "Americanas", 1, "guardanapo");
  const vela = line("americanas-8817266", "Vela de Aniversário Treze Estrelas Nº 4", 8.99, "americanas", "Americanas");
  const phone = await customerWith({ basket: [guardanapo, vela] });
  PICKUP_ONLY_IN_BASKET.add("8817266");
  try {
    const out = await send(phone, "só isso");
    assert.match(out, /Não tenho estes itens[\s\S]*Guardanapo[^\n]*\(Americanas\)[\s\S]*Vela[^\n]*\(Americanas\)/, out.slice(0, 600));
  } finally {
    PICKUP_ONLY_IN_BASKET.delete("8817266");
  }
});

// ---------------- 2. M2/M10: busca ----------------

test("M4: 'café em pó' também procura pelo nome do catálogo ('torrado e moído')", () => {
  assert.deepEqual(m.types.queryAliases("cafe em po 2kg"), ["cafe torrado e moido 2kg"]);
  assert.ok(m.types.conciergeMatchIsStrong("café em pó", { sku: "s", name: "Café Torrado e Moído Tradicional Almofada Pilão 500g", unitPrice: 26.8 } as never));
  // 308 (baixa): "bexiga" é o balão de látex da festa.
  assert.ok(m.types.queryAliases("bexigas").includes("balao de latex"));
  assert.ok(m.types.conciergeMatchIsStrong("bexiga", { sku: "s", name: "Balão de Látex Sortidos Regina 50 Unidades", unitPrice: 39.8 } as never));
});

test("M10: alimento fresco nunca casa com brinquedo, diluente de esmalte ou salgadinho com o sabor", () => {
  const strong = (q: string, name: string, brand?: string) => m.types.conciergeMatchIsStrong(q, { sku: "s", name, unitPrice: 5, ...(brand ? { brand } : {}) } as never);
  for (const name of ["Brinquedo Double Banana Buddy", "Óleo Banana Farmax 60ml", "Banana Bread Wickbold", "Minitrufa Banana"]) assert.equal(strong("banana", name), false, name);
  for (const name of ["Patê de Peito de Peru Sadia", "Batata Lay's Sabor Peito de Peru", "Biscoito Pit Stop Peito de Peru"]) assert.equal(strong("peito de peru", name), false, name);
  assert.equal(strong("banana", "Banana Nanica (unidade ~180 g)"), true);
  assert.equal(strong("peito de peru", "Peito de Peru Defumado Sadia 200g"), true);
  assert.equal(strong("peito de peru", "Sadia Peito de Peru Fatiado", "Sadia"), true);
  assert.equal(strong("tomate", "Molho de Tomate Pomarola"), false);
  assert.equal(strong("carne moída", "Carne Moída Combo 1kg"), true);
});

test("M1 (baixa): a mesma falta dita 3 vezes sai uma vez em 'Ficou de fora'", () => {
  const out = m.copy.leftOutNote(["carne moída 1kg", "alface", "tomate", "carne moída", "carne moída patinho"]);
  assert.equal(out.match(/carne/gi)?.length, 1, out);
  assert.match(out, /alface[\s\S]*tomate/, out);
});

test("M2 (301): 'arroz 5kg' com o 1º card de uma loja procura nas outras lojas também", async (t) => {
  if (!dbOk) return t.skip();
  const phone = await customerWith(
    {
      pending: [{ query: "arroz", qty: 1, options: [opt("santaluzia-26549", "Arroz Thai Jasmin Aromático Blue Ville 1kg", 16.9, "santaluzia", "Casa Santa Luzia"), opt("mambo-825", "Arroz Polido Tipo 1 Tio João 1kg", 5.79, "mambo", "Mambo")] }]
    },
    "choosing"
  );
  // O gerente de diálogo (IA) lê "arroz 5kg" como refino do item na tela, como em produção.
  process.env.LIA_DIALOGUE_LLM = "true";
  dialogue.__setDialogueModelForTests(async () => ({ actions: [{ type: "refine", attribute: "5kg" }] }) as never);
  let out: string;
  try {
    out = await send(phone, "arroz 5kg");
  } finally {
    dialogue.__setDialogueModelForTests(null);
    process.env.LIA_DIALOGUE_LLM = "false";
  }
  assert.doesNotMatch(out, /Não achei \*arroz 5kg\*/, out.slice(0, 600));
  const ctx = await ctxOf(phone);
  const options = ctx.pending?.[0]?.options ?? [];
  assert.ok(options.length >= 1 && options.every((o) => /5 ?kg/i.test(o.name)), options.map((o) => o.name).join(" | "));
});

// ---------------- 3. M3/M8: frete pesando sem como juntar ----------------

test("M3: frete pesa com 3+ entregas ou acima de 25% do total", async () => {
  const { freightWeighs } = await import("../src/lib/delivery-service");
  assert.equal(freightWeighs(3, 100, 10), true);
  assert.equal(freightWeighs(2, 49.04, 42.88), true);
  assert.equal(freightWeighs(2, 100, 20), false);
  assert.equal(freightWeighs(1, 10, 30), false, "uma loja só não tem entrega a tirar");
});

test("M3 (302/305): 3 entregas sem loja que junte tudo — oferece trocar o item da entrega mais cara; 'pula' mantém", async (t) => {
  if (!dbOk) return t.skip();
  strictMode();
  mockVtex();
  // Nenhuma junção confirmada pela loja (o caso do relatório: "nenhuma tem tudo").
  m.setPreflight(async (items) => ({ storeKey: items[0].storeKey, kind: "no-delivery", skus: [items[0].sku] }));
  const vela = { ...line("americanas-8817266", "Vela de Aniversário Treze Estrelas Nº 4", 38.99, "americanas", "Americanas", 1, "vela de aniversário"), freightFee: 12.9 };
  const guardanapo = { ...line("mambo-6911", "Guardanapo Kitchen 22,7cm x 22,8cm com 50 unidades", 3.62, "mambo", "Mambo", 1, "guardanapo"), freightFee: 15.9 };
  const papel = { ...line("drogariaspacheco-888516", "Papel Higiênico Deluxe Cotton Folha Dupla 20m 12 Rolos", 11.99, "drogariaspacheco", "Drogarias Pacheco", 1, "papel higiênico 12 rolos"), freightFee: 6.9 };
  const phone = await customerWith({ basket: [vela, guardanapo, papel] });
  const out = await send(phone, "só isso");
  assert.match(out, /3 entregas[\s\S]*\*Mambo\*[\s\S]*Guardanapo Kitchen/, out.slice(0, 700));
  assert.match(out, /Guardanapo Papel 33x33cm Snob|Guardanapo Descartável/, "opção da Americanas, que já está na cesta");
  const ctx = await ctxOf(phone);
  assert.equal(ctx.pending?.[0]?.replaceSku, "mambo-6911");
  assert.ok((ctx.pending?.[0]?.options ?? []).every((o) => o.storeKey !== "mambo"));
  // A Americanas confere a troca JUNTO da vela: o Snob (que lá só tem retirada junto da cesta) não é oferecido.
  assert.ok(!(ctx.pending?.[0]?.options ?? []).some((o) => o.sku === "americanas-8845181"), (ctx.pending?.[0]?.options ?? []).map((o) => o.sku).join(","));
  assert.equal(ctx.basket?.length, 3, "o atual fica até escolher");
  const kept = await send(phone, "pula");
  assert.match(kept, /mantive \*Guardanapo Kitchen/i, kept.slice(0, 500));
  assert.doesNotMatch(kept, /Deixei .*de fora/i);
  const after = await ctxOf(phone);
  const order = await m.prisma.deliveryOrder.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } });
  const skus = [...(after.basket ?? []), ...((order?.items as Array<{ sku: string }> | undefined) ?? [])].map((i) => i.sku);
  assert.ok(skus.includes("mambo-6911"), skus.join(","));
});

test("M4 (303): 'café em pó 2 kg' só com 500 g — o aviso diz que 4 pacotes dão 2 kg", async () => {
  const { withPacksToReach } = await import("../src/lib/delivery-service");
  assert.equal(withPacksToReach("café em pó 2kg", "é de 500 g", "Café Torrado e Moído Pilão 500g"), "é de 500 g — 4 pacotes dão 2 kg");
  assert.equal(withPacksToReach("café em pó 2kg", "é de 750 g", "Café 750g"), "é de 750 g", "conta que não fecha não vira conversão");
  assert.equal(withPacksToReach("ração 1kg", "é de 3 kg", "Ração 3kg"), "é de 3 kg", "pacote maior que o pedido não é conversão");
});
