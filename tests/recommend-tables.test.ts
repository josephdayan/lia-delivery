// Tabelas curadas da recomendação (08/10/2026, plano docs/plano-recomendacoes-2026-10-08.md §1.2 e
// §1.6): necessidade → prateleiras, sintoma → classe isenta (ordem do mais indicado), sinais de
// alerta. Frases reais de cliente, informais. Puro: sem rede, sem banco.
import "./helpers/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";

import { NEED_TABLE, RED_FLAGS, SYMPTOM_TABLE, findNeed, findRedFlag, findSymptom } from "../src/lib/recommend/tables";
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

test("dor de barriga: começa por antiespasmódico/antidiarreico; cuidado sem remédio", () => {
  const entry = findSymptom("dor de barriga")!;
  assert.ok(["farmacia.antiespasmodico", "farmacia.antidiarreico"].includes(entry.picks[0].shelfId));
  const ids = entry.picks.map((p) => p.shelfId);
  assert.ok(ids.includes("farmacia.antidiarreico") && ids.includes("farmacia.antiespasmodico") && ids.includes("farmacia.antigases"));
  for (const pick of entry.picks) assert.ok(pick.mipClass, `${pick.shelfId} sem mipClass`);
  assert.ok((entry.care ?? []).length > 0);
  for (const c of entry.care ?? []) assert.equal(c.mipClass, undefined);
  assert.match(entry.picks.find((p) => p.shelfId === "farmacia.antidiarreico")!.query, /loperamida/);
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
