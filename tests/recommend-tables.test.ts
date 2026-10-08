// Tabelas curadas da recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.2 e
// §1.6): necessidade → prateleiras, sintoma → classe isenta (ordem do mais indicado), sinais de
// alerta. Frases reais de cliente, informais. Puro: sem rede, sem banco.
import "./helpers/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";

import { NEED_TABLE, PET_SICK_REASON, RED_FLAGS, SYMPTOM_TABLE, findEmergencyFlag, findNeed, findRedFlag, findSymptom, symptomKeyAllowed } from "../src/lib/recommend/tables";
import { normalizeText } from "../src/lib/stores/types";
import { isPrescriptionText } from "../src/lib/medicine";

test("tabelas: tamanhos mínimos e chaves normalizadas", () => {
  assert.ok(NEED_TABLE.length >= 40, `NEED_TABLE: ${NEED_TABLE.length}`);
  assert.ok(SYMPTOM_TABLE.length >= 20, `SYMPTOM_TABLE: ${SYMPTOM_TABLE.length}`);
  assert.ok(RED_FLAGS.length >= 10, `RED_FLAGS: ${RED_FLAGS.length}`);
  for (const e of [...NEED_TABLE, ...SYMPTOM_TABLE]) {
    assert.ok(e.keys.length > 0 && e.picks.length > 0);
    for (const k of e.keys) assert.equal(k, normalizeText(k), `chave não normalizada: "${k}"`);
    for (const pick of e.picks) {
      assert.ok(pick.query.trim() && pick.why.trim(), `${e.keys[0]} → ${pick.shelfId} sem query/why`);
      assert.ok(!/\bcura\b|\bcurar\b|garant/i.test(pick.why), `promessa no why: ${pick.why}`);
    }
  }
  for (const r of RED_FLAGS) assert.equal(r.pattern.global, false, "regex com /g é stateful em .test()");
});

test("sintomas: só isentos — nenhuma consulta nomeia remédio de receita", () => {
  for (const e of SYMPTOM_TABLE) {
    for (const pick of [...e.picks, ...(e.care ?? [])]) {
      assert.equal(isPrescriptionText(pick.query), false, `${e.keys[0]}: ${pick.query}`);
      assert.doesNotMatch(pick.query, /antibiotic|amoxicilina|azitromicina|prednisona|dexametasona|tarja|clonazepam|tramadol|codeina/i);
    }
  }
});

const NEEDS: [string, string][] = [
  // [frase do cliente, primeira prateleira esperada]
  ["tô com fome", "snacks.salgadinho"],
  ["to com uma larica absurda", "snacks.salgadinho"],
  ["bateu a fome aqui", "snacks.salgadinho"],
  ["tô morrendo de fome", "snacks.salgadinho"],
  ["to com muita fome, quero algo doce", "doces.chocolate"],
  ["quero algo doce", "doces.chocolate"],
  ["me vê um docinho", "doces.chocolate"],
  ["queria algo salgado pra petiscar", "snacks.salgadinho"],
  ["algo gelado", "doces.sorvete"],
  ["que calor, quero algo pra beber", "bebidas.agua"],
  ["to com frio", "mercado.sopa"],
  ["to com sono preciso acordar", "mercado.cafe"],
  ["vou fazer um churrasco pra 8 pessoas", "casa.churrasco"],
  ["café da manhã de domingo", "padaria.pao"],
  ["noite de filme com a namorada", "snacks.salgadinho"],
  ["festa infantil do meu filho", "festa.artigos"],
  ["happy hour aqui em casa", "bebidas.cerveja"],
  ["preciso limpar o banheiro", "limpeza.desinfetante"],
  ["dia de faxina", "limpeza.multiuso"],
  ["vou pra praia amanhã", "beleza.protetor_solar"],
  ["vou viajar no fim de semana", "moda.bolsa_mochila"],
  ["adotei um cachorro", "pet.racao_cachorro"],
  ["peguei um gatinho novo", "pet.racao_gato"],
  ["presente pra minha mãe", "beleza.perfume_feminino"],
  ["presente pro meu pai", "beleza.perfume_masculino"],
  ["presente pra namorada", "beleza.perfume_feminino"],
  ["presente pro meu marido", "beleza.perfume_masculino"],
  ["presente pra menino de 5 anos", "brinquedo.carrinho"],
  ["presente pra menina de 4 anos", "brinquedo.boneca"],
  ["presente pro meu sobrinho de 10 anos", "brinquedo.lego_blocos"],
  ["amigo secreto até 50 reais", "doces.chocolate_presente"],
  ["jantar romântico", "bebidas.vinho"],
  ["queria algo leve e saudável", "hortifruti.frutas"],
  ["lanche da escola", "frios.iogurte"],
  ["to de ressaca", "bebidas.isotonico"],
  ["quero dar um presente", "beleza.perfume"],
  ["volta às aulas", "papelaria.material_escolar"],
  ["jantar rápido, não quero cozinhar", "congelados.pratos_prontos"]
];

test("findNeed: frases reais → prateleira certa em primeiro", () => {
  assert.ok(NEEDS.length >= 25);
  for (const [phrase, first] of NEEDS) {
    const entry = findNeed(normalizeText(phrase));
    assert.ok(entry, `sem entrada: "${phrase}"`);
    assert.equal(entry!.picks[0].shelfId, first, `"${phrase}" → ${entry!.keys[0]}`);
  }
  // fome implica pressa
  assert.deepEqual(findNeed("to com fome")!.criteria, ["fast"]);
  // sem casamento → null (a copy honesta pergunta)
  assert.equal(findNeed("xpto qwerty"), null);
  assert.equal(findNeed(""), null);
});

const SYMPTOMS: [string, string][] = [
  ["to com dor de barriga", "farmacia.antiespasmodico"],
  ["diarreia desde ontem", "farmacia.antidiarreico"],
  ["dor de barriga com diarreia", "farmacia.antidiarreico"],
  ["azia depois do almoço", "farmacia.antiacido"],
  ["to estufado de gases", "farmacia.antigases"],
  ["dor de cabeça", "farmacia.analgesico"],
  ["enxaqueca", "farmacia.analgesico"],
  ["to com febre", "farmacia.antitermico"],
  ["dor nas costas", "farmacia.relaxante_muscular"],
  ["dor de garganta", "farmacia.garganta"],
  ["tosse seca chata", "farmacia.antitussigeno"],
  ["tosse com catarro", "farmacia.expectorante"],
  ["acho que to gripado", "farmacia.antigripal"],
  ["nariz entupido", "farmacia.descongestionante"],
  ["crise de rinite", "farmacia.antialergico"],
  ["remédio pra ressaca", "farmacia.hidratacao_oral"],
  ["cólica menstrual", "farmacia.antiespasmodico"],
  ["não consigo dormir", "farmacia.calmante_natural"],
  ["assadura no bebê", "farmacia.pomada_assadura"],
  ["olho seco", "farmacia.colirio"],
  ["intestino preso", "farmacia.laxante"],
  ["dor de dente", "farmacia.analgesico"],
  ["afta", "farmacia.boca"],
  ["micose no pé", "farmacia.antifungico"],
  ["queimadura de sol", "farmacia.analgesico"]
];

test("findSymptom: sintoma → classe isenta mais indicada em primeiro", () => {
  assert.ok(SYMPTOMS.length >= 15);
  for (const [phrase, first] of SYMPTOMS) {
    const entry = findSymptom(normalizeText(phrase));
    assert.ok(entry, `sem entrada: "${phrase}"`);
    assert.equal(entry!.picks[0].shelfId, first, `"${phrase}" → ${entry!.keys[0]}`);
  }
  assert.equal(findSymptom("quero um chocolate"), null);
});

// Regra mudada na revisão adversarial de 08/10 (A6): loperamida só com diarreia dita; dor de barriga
// genérica = antiespasmódico, antigases, probiótico, antiácido.
test("dor de barriga: antiespasmódico e antigases (classes diretas), SEM antidiarreico; loperamida só em diarreia; cuidado sem remédio", () => {
  const entry = findSymptom("dor de barriga")!;
  assert.equal(entry.picks[0].shelfId, "farmacia.antiespasmodico");
  const ids = entry.picks.map((p) => p.shelfId);
  assert.ok(!ids.includes("farmacia.antidiarreico"), "loperamida fora da dor de barriga genérica");
  // Rodada de qualidade (08/10, noite): só as classes diretas (cólica e gases); probiótico e antiácido saíram.
  assert.deepEqual(ids, ["farmacia.antiespasmodico", "farmacia.antigases"]);
  for (const pick of entry.picks) assert.ok(pick.mipClass, `${pick.shelfId} sem mipClass`);
  assert.ok((entry.care ?? []).length > 0);
  for (const c of entry.care ?? []) assert.equal(c.mipClass, undefined);
  for (const pick of entry.picks) assert.doesNotMatch(pick.query, /loperamida|imosec|diasec/i);
  const diarreia = findSymptom("diarreia")!;
  assert.equal(diarreia.picks[0].shelfId, "farmacia.antidiarreico");
  assert.match(diarreia.picks[0].query, /loperamida/);
});

const RED: [string, string][] = [
  ["dor de barriga muito forte", "dor forte"],
  ["dor de cabeça insuportável", "dor forte"],
  ["vomitei sangue", "sangue"],
  ["cocô com sangue", "sangue"],
  ["febre de 39,5", "febre alta"],
  ["febre alta no meu filho", "febre alta"],
  ["diarreia há 3 dias", "há vários dias"],
  ["tosse faz uma semana", "há vários dias"],
  ["sou grávida e to com azia", "gestante ou amamentando"],
  ["to amamentando, posso tomar?", "gestante ou amamentando"],
  ["meu bebê de 8 meses com febre", "bebê ou criança pequena"],
  ["recém-nascido com cólica", "bebê ou criança pequena"],
  ["to com falta de ar", "falta de ar"],
  ["dor no peito", "dor no peito"],
  ["desmaiei agora", "desmaio ou convulsão"],
  ["minha mãe tá confusa", "confusão mental"],
  ["já tomei dipirona e paracetamol", "mistura de remédios"],
  ["boca inchada depois do remédio", "alergia grave ou inchaço"],
  ["não para de vomitar", "vômito persistente"]
];

test("findRedFlag: sinais de alerta positivos", () => {
  for (const [phrase, reason] of RED) {
    const flag = findRedFlag(normalizeText(phrase));
    assert.ok(flag, `não marcou: "${phrase}"`);
    assert.equal(flag!.reason, reason, phrase);
  }
});

test("findRedFlag: sintomas comuns sem alerta", () => {
  for (const phrase of ["to com dor de barriga", "dor de cabeça", "febre de 38", "azia depois do almoço", "assadura no bebê", "tosse seca",
    "nariz entupido", "cólica menstrual", "to de ressaca", "comi demais e to com dor de cabeça", "dor nas costas de dormir mal",
    "quero um chocolate", "presente pra minha mãe", ""]) {
    assert.equal(findRedFlag(normalizeText(phrase)), null, `alerta indevido: "${phrase}"`);
  }
});

// ---------------------------------------------------------------- revisão adversarial (08/10)


test("revisão A2: emergência separada do contexto; emergência casa frase fora de saúde", () => {
  const EMERG: [string, string][] = [
    ["to com o peito apertado e suando frio", "dor no peito"],
    ["to com falta de ar", "falta de ar"],
    ["suando frio do nada", "suor frio"],
    ["meu pai desmaiou", "desmaio ou convulsão"],
    ["vomitei sangue", "sangue"],
    ["garganta fechando depois do camarão", "alergia grave ou inchaço"]
  ];
  for (const [phrase, reason] of EMERG) {
    const flag = findEmergencyFlag(normalizeText(phrase));
    assert.equal(flag?.reason, reason, phrase);
    assert.equal(flag?.kind, "emergency", phrase);
  }
  // contexto NUNCA é emergência
  for (const phrase of ["meu bebê de 8 meses com febre", "sou grávida e to com azia", "diarreia há 3 dias", "tenho pressão alta", "minha mãe tá confusa"]) {
    assert.equal(findEmergencyFlag(normalizeText(phrase)), null, phrase);
    assert.equal(findRedFlag(normalizeText(phrase))?.kind, "context", phrase);
  }
  // padrões estreitos: "sem ar condicionado", o vinho "Sangue de Boi", "sangue bom"
  for (const phrase of ["ventilador pra casa sem ar condicionado", "um vinho sangue de boi", "ele é sangue bom", "apaguei no sofá ontem"]) {
    assert.equal(findEmergencyFlag(normalizeText(phrase)), null, phrase);
  }
  // emergência vem antes do contexto em findRedFlag
  assert.equal(findRedFlag(normalizeText("meu filho tá com falta de ar"))?.reason, "falta de ar");
});

test("revisão A3/A4: pet doente, criança, idoso, comorbidade e combinações de sintoma", () => {
  const CTX: [string, string][] = [
    ["meu cachorro tá com diarreia, o que dar", PET_SICK_REASON],
    ["meu filho de 2 anos tá com febre", "criança"],
    ["meu filho tá com febre", "criança"],
    ["meu neto de 4 anos tá com tosse", "criança"],
    ["meu pai de 75 anos tá com dor", "idoso"],
    ["minha avó tá com dor de cabeça", "idoso"],
    ["tô com dor de cabeça e uso anticoagulante", "uso de anticoagulante"],
    ["tenho úlcera e tô com dor de cabeça", "úlcera ou gastrite"],
    ["dor de barriga e febre", "dor na barriga com febre"],
    ["dor de barriga do lado direito", "dor no lado direito da barriga"],
    ["dor de cabeça com febre e pescoço duro", "febre com pescoço duro"],
    ["tenho pressão alta e tô gripado", "pressão alta"],
    ["sou diabético e tô com dor de cabeça", "diabetes"],
    ["dor ao urinar", "dor ao urinar"],
    ["tenho asma e tô gripada", "asma"]
  ];
  for (const [phrase, reason] of CTX) {
    assert.equal(findRedFlag(normalizeText(phrase))?.reason, reason, phrase);
  }
  // criança de 12+ e adulto: sem alerta de criança
  assert.equal(findRedFlag(normalizeText("minha filha de 25 anos tá com dor de cabeça")), null);
  assert.equal(findRedFlag(normalizeText("meu filho de 14 anos tá com dor de cabeça")), null);
  // negativos da revisão (findRedFlag puro; "presente pra mãe gestante" e "ração pra cachorro" são
  // negativos no PLANO, que só aplica contexto a pedido de saúde — ver recommend-review-2026-10-08)
  for (const phrase of ["dor de barriga leve", "assadura do bebê", "assadura no bebe do meu filho"]) {
    assert.equal(findRedFlag(normalizeText(phrase)), null, phrase);
  }
});

test("revisão C3: chave de sintoma de 1 palavra ambígua exige contexto de saúde", () => {
  assert.equal(findSymptom(normalizeText("corte de carne pro churrasco")), null);
  assert.equal(findSymptom(normalizeText("botijão de gás")), null);
  assert.equal(findSymptom(normalizeText("fungo pro jardim")), null);
  assert.equal(findSymptom(normalizeText("tô com um corte no dedo"))?.picks[0].shelfId, "farmacia.antisseptico_cicatrizante");
  assert.equal(findSymptom(normalizeText("tô com gases"))?.picks[0].shelfId, "farmacia.antigases");
  assert.equal(findSymptom(normalizeText("algo pra afta"))?.picks[0].shelfId, "farmacia.boca");
  assert.equal(findSymptom("afta")?.picks[0].shelfId, "farmacia.boca", "a mensagem inteira vale");
  assert.equal(symptomKeyAllowed("corte", "corte de carne pro churrasco"), false);
  assert.equal(symptomKeyAllowed("gripe", "qualquer coisa"), true, "chave não ambígua passa");
});

test("revisão A6: ressaca só hidratação (sem Engov/AAS, AINE, paracetamol); antigripal avisa pressão alta", () => {
  const ressaca = findSymptom("to de ressaca")!;
  const all = [...ressaca.picks, ...(ressaca.care ?? [])];
  assert.deepEqual(ressaca.picks.map((p) => p.shelfId), ["farmacia.hidratacao_oral"]);
  assert.deepEqual((ressaca.care ?? []).map((p) => p.shelfId).sort(), ["bebidas.agua", "bebidas.agua_coco", "bebidas.isotonico"]);
  for (const p of all) assert.doesNotMatch(`${p.shelfId} ${p.query}`, /engov|aas|aspirina|dipirona|paracetamol|ibuprofeno|analgesico|anti_inflamatorio|sonrisal/i);
  const gripe = findSymptom("to gripado")!;
  assert.match(gripe.picks.find((p) => p.shelfId === "farmacia.antigripal")!.why, /pressão alta/);
});
