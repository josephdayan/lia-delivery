// Sonda do gerente de diálogo contra a IA REAL (sem banco, sem lojas): frases difíceis x ação
// esperada, com a latência de cada chamada. Serve para comparar esforço de raciocínio/prompt.
//   LIA_DIALOGUE_LLM=true LIA_DIALOGUE_EFFORT=low npx tsx scripts/dialogue-probe.mts [--repeat 2]
import "./talk-env.mts";
process.env.LIA_DIALOGUE_LLM = "true";
const { callDialogueModel } = await import("../src/lib/dialogue/model");
const { buildDialogueState } = await import("../src/lib/dialogue/state");
const { planActions } = await import("../src/lib/dialogue/plan");

type Ctx = Parameters<typeof buildDialogueState>[0];
const opt = (sku: string, name: string, price: number, store: string) => ({ sku, name, unitPrice: price / 1.1, storeKey: store.toLowerCase(), storeLabel: store, delivery: "1 dia útil" });
const racao = [opt("R1", "Ração Pedigree Adultos Carne 10kg", 110, "Cobasi"), opt("R2", "Ração Dog Chow Frango 10kg", 120, "Mambo"), opt("R3", "Ração Golden Premium 10kg", 150, "Cobasi")];
const item = (sku: string, name: string, qty: number, price: number) => ({ sku, name, qty, unitPrice: price / 1.1, lineTotal: (price / 1.1) * qty, storeKey: "cobasi", storeLabel: "Cobasi" });

const screen: Ctx = { flow: "delivery", step: "choosing", basket: [], pending: [{ query: "ração cachorro", qty: 1, options: racao }] };
const screenQueue: Ctx = { ...screen, basket: [item("A", "Amora Congelada 400g", 1, 22)], pending: [{ query: "ração cachorro", qty: 1, options: racao }, { query: "sabonete", qty: 1, options: [] }] };
const afterPick: Ctx = { flow: "delivery", step: "collecting", basket: [item("R1", "Ração Pedigree Adultos Carne 10kg", 1, 110)], lastChoice: { query: "ração cachorro", qty: 1, options: racao, chosenSku: "R1" } };
const afterMiss: Ctx = { flow: "delivery", step: "collecting", basket: [], lastMiss: { query: "bola de tênis", qty: 1, at: Date.now() } };
const kerasys: Ctx = { flow: "delivery", step: "choosing", basket: [], pending: [{ query: "shampoo kerasys", qty: 1, options: [opt("K1", "Shampoo Kerasys Mise En Scène Perfect Serum 530ml", 140, "Drogaria São Paulo"), opt("K2", "Shampoo Kerasys Propolis Hair Bonding 600ml", 52, "Pague Menos")] }] };
const babolat: Ctx = { flow: "delivery", step: "choosing", basket: [], pending: [{ query: "bolas de tênis babolat", qty: 1, options: [opt("B1", "Tubo Bolas de Tênis Babolat Gold com 3 bolas", 40, "Decathlon"), opt("B2", "Tubo Bolas de Tênis Babolat Team com 3 bolas", 38, "Decathlon")] }] };
const oneItem: Ctx = { flow: "delivery", step: "collecting", basket: [item("A", "Arroz Camil 5kg", 1, 34)] };
const twoItems: Ctx = { flow: "delivery", step: "collecting", basket: [item("A", "Arroz Camil 5kg", 1, 34), item("B", "Feijão Carioca 1kg", 2, 9)] };

type Case = { msg: string; ctx: Ctx; expect: string; check?: (a: Awaited<ReturnType<typeof callDialogueModel>>) => boolean };
const first = (d: any) => d?.actions?.[0];
const cases: Case[] = [
  { msg: "acho que o 1 taakku", ctx: screen, expect: "pick 1", check: (d) => first(d)?.type === "pick" && first(d)?.option === 1 },
  { msg: "a do meio", ctx: screen, expect: "pick 2", check: (d) => first(d)?.type === "pick" && first(d)?.option === 2 },
  { msg: "quero a mais barata", ctx: screen, expect: "pick 1", check: (d) => first(d)?.type === "pick" && first(d)?.option === 1 },
  { msg: "mais 3 rações", ctx: afterPick, expect: "add_qty target 1 delta 3", check: (d) => first(d)?.type === "add_qty" && first(d)?.target === 1 && first(d)?.delta === 3 },
  { msg: "troca pelo de R$ 120", ctx: afterPick, expect: "pick 2 (R$ 120 = Dog Chow)", check: (d) => first(d)?.type === "pick" && first(d)?.option === 2 },
  { msg: "pode tentar em outra loja", ctx: afterMiss, expect: "search retry", check: (d) => first(d)?.type === "search" && first(d)?.retry === true },
  { msg: "só essa", ctx: oneItem, expect: "close_list", check: (d) => first(d)?.type === "close_list" },
  { msg: "tem sem corante?", ctx: screen, expect: "refine", check: (d) => first(d)?.type === "refine" },
  { msg: "não gostei, quero da Royal Canin", ctx: screen, expect: "refine Royal Canin", check: (d) => first(d)?.type === "refine" && /royal/i.test(first(d)?.attribute ?? "") },
  { msg: "e um sabonete também", ctx: screen, expect: "search sabonete", check: (d) => first(d)?.type === "search" && !first(d)?.replace },
  { msg: "tira o arroz e bota 2 pães", ctx: twoItems, expect: "remove 1 + search", check: (d) => d?.actions?.[0]?.type === "remove" && d?.actions?.[0]?.target === 1 && d?.actions?.[1]?.type === "search" },
  { msg: "o feijão são 3 na verdade", ctx: twoItems, expect: "set_qty target 2 qty 3", check: (d) => first(d)?.type === "set_qty" && first(d)?.target === 2 && first(d)?.qty === 3 },
  { msg: "só a amora", ctx: screenQueue, expect: "only_keep 1", check: (d) => first(d)?.type === "only_keep" && first(d)?.target === 1 },
  { msg: "vcs cobram alguma taxa?", ctx: oneItem, expect: "answer service_fee", check: (d) => first(d)?.type === "answer" && first(d)?.topic === "service_fee" },
  { msg: "chega hoje?", ctx: screen, expect: "answer delivery_time (ou status)", check: (d) => ["answer", "status"].includes(first(d)?.type) },
  { msg: "quero falar com alguém", ctx: oneItem, expect: "human", check: (d) => first(d)?.type === "human" },
  { msg: "é de qual loja o 2?", ctx: screen, expect: "answer stores", check: (d) => first(d)?.type === "answer" && first(d)?.topic === "stores" },
  { msg: "esse não, pula", ctx: screen, expect: "skip_current", check: (d) => first(d)?.type === "skip_current" },
  { msg: "hmm", ctx: screen, expect: "smalltalk/unclear", check: (d) => ["smalltalk", "unclear"].includes(first(d)?.type) },
  { msg: "Você consegue comprar qualquer coisa? Tava pensando em sabão em pó.", ctx: { flow: "delivery", step: "collecting", basket: [] }, expect: "search sabão em pó", check: (d) => first(d)?.type === "search" && /sab[aã]o em p[oó]/i.test(first(d)?.query ?? "") && !/consegue|qualquer/i.test(first(d)?.query ?? "") },
  { msg: "Queria algo salgado e prático, tipo um hambúrguer. O que vc recomenda?", ctx: { flow: "delivery", step: "collecting", basket: [] }, expect: "search hambúrguer", check: (d) => first(d)?.type === "search" && /hamb/i.test(first(d)?.query ?? "") && !/recomenda|pr[aá]tico/i.test(first(d)?.query ?? "") },
  { msg: "Pode tentar de qualquer marca, não precisa ser uma específica.", ctx: afterMiss, expect: "search retry", check: (d) => first(d)?.type === "search" && first(d)?.retry === true },
  { msg: "Consegue tentar procurar em outra loja? Quero exatamente esse de coco 1L.", ctx: kerasys, expect: "refine coco 1L", check: (d) => first(d)?.type === "refine" && /coco/i.test(first(d)?.attribute ?? "") && !/consegue|loja/i.test(first(d)?.attribute ?? "") },
  { msg: "Pode tentar outra versão da Babolat, mas tem que vir com 4 bolas.", ctx: babolat, expect: "refine 4 bolas", check: (d) => first(d)?.type === "refine" && /4 bolas/i.test(first(d)?.attribute ?? "") },
  { msg: "ah esquece, quero ração de gato", ctx: screen, expect: "search replace", check: (d) => first(d)?.type === "search" && first(d)?.replace === true }
];

const repeat = Number(process.argv.includes("--repeat") ? process.argv[process.argv.indexOf("--repeat") + 1] : 1);
let ok = 0, total = 0, ms = 0, worst = 0, invalid = 0;
for (const c of cases) {
  for (let r = 0; r < repeat; r++) {
    const state = buildDialogueState(c.ctx, { hasAddress: true });
    const t0 = Date.now();
    const decision = await callDialogueModel({ text: c.msg, state });
    const took = Date.now() - t0;
    const pass = Boolean(decision && c.check?.(decision));
    const plan = decision ? planActions(decision, state) : null;
    if (decision && plan && !plan.ok) invalid++;
    total++; ok += pass ? 1 : 0; ms += took; worst = Math.max(worst, took);
    console.log(`${pass ? "ok " : "ERR"} ${String(took).padStart(5)}ms  ${c.msg.padEnd(34)} -> ${decision ? decision.actions.map((a) => `${a.type}${a.option ? ` ${a.option}` : ""}${a.target != null ? ` t${a.target}` : ""}${a.delta ? ` d${a.delta}` : ""}${a.qty ? ` q${a.qty}` : ""}${a.query ? ` "${a.query}"` : ""}${a.attribute ? ` [${a.attribute}]` : ""}${a.topic ? ` ${a.topic}` : ""}${a.retry ? " retry" : ""}${a.replace ? " replace" : ""}`).join(" + ") : "null"}${pass ? "" : `   (esperado: ${c.expect})`}${plan && !plan.ok ? `  PLANO INVALIDO ${plan.reason}` : ""}`);
  }
}
console.log(`\nacertos ${ok}/${total}  média ${Math.round(ms / total)}ms  pior ${worst}ms  planos inválidos ${invalid}  esforço=${process.env.LIA_DIALOGUE_EFFORT ?? "low"}`);
process.exit(0);
