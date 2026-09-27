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
// 25/09/2026: em produção só as lojas que fecham por API ficam ligadas por padrão. O golden
// mede o BUSCADOR sobre o roster HISTÓRICO de 18 vitrines, então liga essas explicitamente aqui.
// As lojas somadas em 25/09 (Mambo, Época, Drogal) ficam FORA do golden: com elas, "agua" cai em
// "água perfumada para tecidos" no piso determinístico e "cabo usb-c" passa a existir (Drogal).
// Caso registrado em PENDENCIAS 25/09 para regra principial no scorer antes de incluí-las.
for (const store of ["CARREFOUR", "OBA", "PETZ", "BOTICARIO", "DECATHLON", "SWIFT", "KALUNGA", "RIHAPPY", "CACAUSHOW", "KOPENHAGEN", "DROGARAIA", "DROGARIASP", "PAGUEMENOS", "DIVVINO", "IMIGRANTES", "NATURALDATERRA", "COBASI", "GIULIANAFLORES"]) {
  process.env[`LIA_ENABLE_${store}`] = "true";
}
for (const store of ["MAMBO", "EPOCACOSMETICOS", "DROGAL", "MARTINSFONTES", "BRINOX", "CREAMY", "CASAEVIDEO", "TELHANORTE", "ZONACRIATIVA"]) process.env[`LIA_ENABLE_${store}`] = "false";
