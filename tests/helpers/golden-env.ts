// Env do golden de busca: roster COMPLETO de produção (nenhuma vitrine desabilitada —
// o caso do carregador precisa da Pague Menos, que o load-env dos evals de conversa
// desliga), seeds em vez de busca ao vivo e SEM OpenAI (o teste unitário mede o piso
// determinístico; a camada de IA é medida por scripts/eval-search.mts).
//
// Importar ANTES de qualquer módulo de stores: o registry é montado no import.
// Seguro porque o node --test roda cada arquivo em processo próprio.
process.env.OPENAI_API_KEY = "";
process.env.WHATSAPP_PROVIDER = "mock";
// Busca ao vivo nas lojas usa rede: testes ficam na cópia do catálogo.
process.env.LIA_LIVE_SEARCH = "false";
// Gerente de diálogo usa IA: testes ficam no caminho determinístico (os testes do dialogue ligam sozinhos).
process.env.LIA_DIALOGUE_LLM = "false";
process.env.LIA_RETAILER_TEST_SEED = "true";
process.env.LIA_SEND_PHOTOS = "false";
// 27/09/2026: o golden mede a busca no ELENCO DE PRODUÇÃO — as lojas com compra por API (as
// opt-in ficam desligadas, como na Vercel). Antes media um elenco histórico de 18 lojas que
// já não existe em produção (sem Mambo, com Carrefour), e o drift semanal de catálogo o
// derrubava sem dizer nada sobre o que o cliente vê.
for (const store of ["CARREFOUR", "OBA", "PETZ", "BOTICARIO", "DECATHLON", "KALUNGA", "CACAUSHOW", "DROGARAIA", "DIVVINO", "IMIGRANTES", "NATURALDATERRA", "GIULIANAFLORES"]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
for (const store of ["DROGARIASP", "COBASI", "PAGUEMENOS", "SWIFT", "KOPENHAGEN", "RIHAPPY", "MAMBO", "AMERICANAS", "COVABRA", "SAVEGNAGO", "WEPINK", "UNDERARMOUR", "TOKSTOK", "PBKIDS", "OSKLEN", "MOTOROLA", "LIVRARIASCURITIBA", "FILA", "FARMACIAINDIANA", "EXTRAFARMA", "DROGARIASPACHECO", "DROGARIACATARINENSE", "SANTALUZIA", "CEA", "CAPODARTE", "ARAMIS", "EPOCACOSMETICOS", "DROGAL", "BRINOX", "CREAMY", "CASAEVIDEO", "TELHANORTE", "ZONACRIATIVA", "PHILCO", "OXFORD", "POLISHOP", "OBRAMAX"]) {
  process.env[`LIA_ENABLE_${store}`] = "true";
}
// 06/10: mercados do Rio ficam fora do golden — o golden é a vitrine de um cliente de SP, e em
// produção a área por loja (store-areas.ts) nunca mostra Zona Sul/Prezunic para CEP de SP.
for (const store of ["ZONASUL", "PREZUNIC"]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
// 29/09: desligadas em produção (ORD062 no fechamento por API; as outras 7 religaram com telefone).
for (const store of ["MARTINSFONTES", "MONDIAL"]) {
  process.env[`LIA_ENABLE_${store}`] = "false";
}
