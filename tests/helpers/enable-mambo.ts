// Liga a Mambo no registry de teste ANTES de qualquer módulo de loja ser importado (o
// load-env desliga as vitrines novas; o registry lê as flags na importação).
process.env.LIA_ENABLE_MAMBO = "true";
