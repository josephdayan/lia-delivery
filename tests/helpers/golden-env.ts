// Env do golden de busca: roster COMPLETO de produção (nenhuma vitrine desabilitada —
// o caso do carregador precisa da Pague Menos, que o load-env dos evals de conversa
// desliga), seeds em vez de busca ao vivo e SEM OpenAI (o teste unitário mede o piso
// determinístico; a camada de IA é medida por scripts/eval-search.mts).
//
// Importar ANTES de qualquer módulo de stores: o registry é montado no import.
// Seguro porque o node --test roda cada arquivo em processo próprio.
process.env.OPENAI_API_KEY = "";
process.env.WHATSAPP_PROVIDER = "mock";
process.env.LIA_RETAILER_TEST_SEED = "true";
process.env.LIA_SEND_PHOTOS = "false";
// 27/09/2026: o golden mede a busca no ELENCO DE PRODUÇÃO — as lojas com compra por API (as
// opt-in ficam desligadas, como na Vercel). Antes media um elenco histórico de 18 lojas que
// já não existe em produção (sem Mambo, com Carrefour), e o drift semanal de catálogo o
// derrubava sem dizer nada sobre o que o cliente vê.
for (const store of ["CARREFOUR", "OBA", "PETZ", "BOTICARIO", "DECATHLON", "KALUNGA", "CACAUSHOW", "DROGARAIA", "DIVVINO", "IMIGRANTES", "NATURALDATERRA", "GIULIANAFLORES"]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
for (const store of ["DROGARIASP", "COBASI", "PAGUEMENOS", "SWIFT", "RIHAPPY", "MAMBO", "AMERICANAS", "DROGAL", "BRINOX", "CREAMY", "PHILCO", "OXFORD"]) {
  process.env[`LIA_ENABLE_${store}`] = "true";
}
// 28/09: desligadas em produção (o fechamento por API falhou no teste de Pix loja a loja).
for (const store of ["MARTINSFONTES", "TELHANORTE", "MONDIAL", "OBRAMAX", "EPOCACOSMETICOS", "CASAEVIDEO", "KOPENHAGEN", "POLISHOP", "ZONACRIATIVA"]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
