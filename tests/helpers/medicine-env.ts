// Liga o remédio isento e a vitrine da Drogaria SP ANTES de qualquer módulo de loja ser
// carregado (o registro de lojas lê as flags na importação; `import` sobe pro topo, então
// atribuir no corpo do teste chega tarde). Importar logo depois de ./load-env.
process.env.LIA_MEDICINE_MIP = "true";
process.env.LIA_ENABLE_DROGARIASP = "true";
