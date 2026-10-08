// Loads .env into process.env BEFORE any prisma/adapter module is imported (Next.js
// does this automatically; the plain node test runner does not). Import this FIRST in
// every test file that touches the database. Also pins the flags that make the
// conversation deterministic: mock WhatsApp provider, no OpenAI (heuristic fallback),
// no live scraping.
import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const raw = readFileSync(join(__dirname, "..", "..", ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env — tests that need the DB will fail loudly on connect
}

// Fronteira teste × produção (revisão 02/09): com TEST_DATABASE_URL definida, TODA a
// suíte fala com esse banco (nunca com o DATABASE_URL de produção do .env). Sem ela, o
// destino é uma porta local fechada. LIA_REQUIRE_DB=1 (CI) exige configuração explícita.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.TEST_DIRECT_URL ?? process.env.TEST_DATABASE_URL;
}
// Sem destino explícito, nenhum teste pode herdar o banco real do .env.
else {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/lia_test";
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  if (process.env.LIA_REQUIRE_DB === "1") throw new Error("Defina TEST_DATABASE_URL ou use npm run test:local.");
}
// Testes não herdam credenciais de cobrança nem de scraping do projeto.
delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
delete process.env.PAGARME_SECRET_KEY;
delete process.env.APIFY_API_TOKEN;

process.env.WHATSAPP_PROVIDER = "mock";
// Busca ao vivo nas lojas usa rede: testes ficam na cópia do catálogo.
process.env.LIA_LIVE_SEARCH = "false";
// Gerente de diálogo usa IA: testes ficam no caminho determinístico (os testes do dialogue ligam sozinhos).
process.env.LIA_DIALOGUE_LLM = "false";
process.env.OPENAI_API_KEY = "";
process.env.LIA_RETAILER_TEST_SEED = "true";
process.env.LIA_SEND_PHOTOS = "false";
// Remédio isento (29/09): desligado por padrão; o teste que liga a flag liga sozinho.
delete process.env.LIA_MEDICINE_MIP;
// Modelo de preço (08/10): produção = service_fee (preço da loja + taxa em linha própria, nota no
// CPF do cliente). A suíte antiga foi escrita com a margem embutida e fica nela; o modelo novo tem
// teste próprio (tests/service-fee-mode.test.ts), que liga sozinho.
process.env.LIA_PRICING_MODE ??= "markup";
// Recomendação (08/10): em produção o padrão é "test" (só dono/admins); a suíte usa telefones de teste.
process.env.LIA_RECOMMEND ??= "all";
// Complemento no fechamento (08/10, recomendação fase 4): em produção vem LIGADO ("quem leva carvão
// costuma levar pão de alho" antes do total). A suíte antiga fecha a lista esperando o total direto e
// fica sem ele; tests/recommend-complement-2026-10-08.test.ts liga sozinho.
process.env.LIA_RECOMMEND_COMPLEMENT ??= "false";
// Frete ao vivo consulta a rede (checkout das lojas) — nos testes fica desligado para
// os E2E de cotação instantânea serem determinísticos (tabela semeada).
process.env.LIA_LIVE_FREIGHT_OFF = "true";
// Produção (03/09) só cobra automático o que a loja confirmou AO VIVO; nos evals a
// simulação está desligada, então a tabela semeada continua valendo para exercitar o
// caminho da cotação instantânea. O modo estrito tem teste próprio
// (tests/paid-order-watchdog.test.ts).
process.env.LIA_CHARGE_ONLY_VERIFIED ??= "false";
// Sem operador (27/09): em produção o que a loja não confirma é recusado na hora. Os evals
// antigos exercitam a cotação do operador, então o harness mantém o caminho antigo ligado;
// o comportamento novo tem teste próprio (manual-concierge: "sem operador").
process.env.LIA_OPERATOR_QUOTE ??= "true";
// Mercado Livre é vitrine AO VIVO (rede + custo por busca): fica desligado nos testes,
// como em produção por padrão. Seus próprios testes vivem em mercadolivre-store.test.ts.
process.env.LIA_ENABLE_MERCADOLIVRE = "false";
// Compra automática: nenhuma loja liberada por padrão nos testes (cada teste liga a sua).
process.env.LIA_AUTO_PURCHASE_STORES ??= "";
// Comprador VTEX no servidor (25/09): desligado na suíte. Ele dispara no pagamento
// (order-payments → waitUntil) e roubaria o job dos testes do comprador do Mac, chamando a
// loja REAL. tests/vtex-runner.test.ts liga explicitamente e usa a loja de mentira.
process.env.LIA_SERVER_BUYER_OFF ??= "true";
// Preparação de carrinho: desde 15/09 o default do produto é VAZIO (operador humano
// compra; nenhuma loja monta carrinho sozinha). A suíte do comprador automático precisa
// do mundo antigo para exercitar lease, aprovação e Pix, então fixa o ML aqui. O default
// novo tem teste próprio: tests/operador-humano.test.ts.
process.env.LIA_PURCHASE_PREP_STORES ??= "mercadolivre";
// The conversation evals assert NLU/choice/payment behavior, not the store roster, and
// were written for the world that passed 210/210: Carrefour (mercado, min R$30, arroz),
// Petz (pet), Boticário (beleza), Decathlon (creatina), plus Oba (the catalog-gaps Oba
// tests). Pin the test registry to that set so routing stays deterministic; production
// keeps all 18 vitrines. Every later vitrine is disabled so it can't shift routing —
// as provou a rodada de 02/08, em que a conveniência da Pague Menos passou a ganhar o
// item barato do Carrefour e derrubou os evals de pedido mínimo (as novas vitrines têm
// mínimo 0). Ao somar uma vitrine, acrescente a chave aqui.
for (const store of [
  "SWIFT",
  "KALUNGA",
  "RIHAPPY",
  "CACAUSHOW",
  "KOPENHAGEN",
  "DROGARAIA",
  "DROGARIASP",
  "PAGUEMENOS",
  "DIVVINO",
  "IMIGRANTES",
  "NATURALDATERRA",
  "COBASI",
  "GIULIANAFLORES",
  "MAMBO",
  "AMERICANAS",
  "PREZUNIC",
  "ZONASUL",
  "COVABRA",
  "SAVEGNAGO",
  "WEPINK",
  "UNDERARMOUR",
  "TOKSTOK",
  "PBKIDS",
  "OSKLEN",
  "MOTOROLA",
  "LIVRARIASCURITIBA",
  "FILA",
  "FARMACIAINDIANA",
  "EXTRAFARMA",
  "DROGARIASPACHECO",
  "DROGARIACATARINENSE",
  "SANTALUZIA",
  "CEA",
  "CAPODARTE",
  "ARAMIS",
  "EPOCACOSMETICOS",
  "DROGAL",
  "MARTINSFONTES",
  "BRINOX",
  "CREAMY",
  "CASAEVIDEO",
  "TELHANORTE",
  "ZONACRIATIVA",
  "PHILCO",
  "MONDIAL",
  "OXFORD",
  "POLISHOP",
  "OBRAMAX"
]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
// 25/09/2026: em produção só as lojas que fecham por API ficam ligadas por padrão (registry
// opt-in). Os evals continuam no mundo original acima, então o elenco é ligado aqui de forma
// explícita — a política de vitrine de produção tem teste próprio (vtex-checkout.test.ts).
for (const store of ["CARREFOUR", "PETZ", "BOTICARIO", "DECATHLON", "OBA"]) {
  process.env[`LIA_ENABLE_${store}`] = "true";
}
