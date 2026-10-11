// Rodada 17, grupo G48 (11/10): prazo por hora, pergunta no meio da cesta, cadastro + pedido na 1ª mensagem e orçamento,
// de /mnt/project-files/testes-whatsapp/rodada17/grupo-b.md (R17-1, R17-3, R17-4, R17-10, R17-13).
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBasketLines, parseNeededBy, parseNeededHour } from "../src/lib/lia-intents";
import { deadlineFit, deadlineVerdict, promiseHourFit, promiseMissesDeadline } from "../src/lib/live-freight";
import * as copy from "../src/lib/lia-copy";
import { isRepeatableVerbatim } from "../src/lib/dialogue/repeat";

// 21h10 em SP do sábado 10/10 (a hora da rodada).
const NIGHT = new Date("2026-10-11T00:10:00Z");

test("R17-1: 'antes das 7h' é prazo com hora — a próxima 7h, com o rótulo da hora", () => {
  const d = parseNeededBy("meu bebe acordou sem fralda, preciso fralda G pacote grande, lenço umedecido e uma mamadeira 260ml. tem que chegar antes das 7h", NIGHT);
  assert.deepEqual(d, { date: "2026-10-11", label: "amanhã às 7h", hour: 7 });
  // Com o dia dito ("amanhã cedo preciso…"), a hora entra no dia.
  const lanche = parseNeededBy("Maria Souza 52998224725 Av Paulista 1000 01310-100. amanhã cedo preciso pra lancheira do meu filho: pão de forma, presunto, queijo mussarela fatiado, 6 sucos de caixinha e banana. antes das 7h", NIGHT);
  assert.deepEqual(lanche, { date: "2026-10-11", label: "amanhã às 7h", hour: 7 });
  // De manhã, "até as 10h" ainda é hoje.
  assert.deepEqual(parseNeededBy("pão e leite, até as 10h", new Date("2026-10-11T11:00:00Z")), { date: "2026-10-11", label: "hoje às 10h", hour: 10 });
  assert.equal(parseNeededHour("até as 6 da tarde"), 18);
  // "amanhã cedo" com necessidade é prazo de manhã, mesmo com o "preciso" depois do dia.
  assert.equal(parseNeededBy("amanhã cedo preciso de pão", NIGHT)?.morning, true);
  // Orçamento e horário de funcionamento não são prazo.
  assert.equal(parseNeededHour("arroz até 50 reais"), null);
  assert.equal(parseNeededHour("abre às 7h?"), null);
});

test("R17-1: a hora do prazo nunca vira item", () => {
  const phrases = (t: string) => parseBasketLines(t).map((l) => l.phrase);
  assert.deepEqual(phrases("pão de forma, presunto, queijo mussarela fatiado, 6 sucos de caixinha e banana. antes das 7h"), ["pão de forma", "presunto", "queijo mussarela fatiado", "sucos de caixinha", "banana"]);
  assert.deepEqual(phrases("pão, leite, tem que chegar até as 10h"), ["pão", "leite"]);
  assert.deepEqual(phrases("pão, leite, bem cedo"), ["pão", "leite"]);
  assert.deepEqual(phrases("arroz até 50 reais"), ["arroz até 50 reais"]);
});

test("R17-1: entrega × prazo com hora — janela, SLA curto e prazo em dias", () => {
  const d = { date: "2026-10-11", hour: 7 };
  // Janela inteira antes da hora, janela que atravessa a hora, janela depois.
  assert.equal(promiseHourFit("Mambo · amanhã, 5h–7h", d, NIGHT), "ok");
  assert.equal(promiseHourFit("Mambo · amanhã, 5h–8h", d, NIGHT), "unsure");
  assert.equal(promiseHourFit("prazo da loja: em até 14h (amanhã, 8h–11h)", d, NIGHT), "late");
  // 60 min às 21h10 chega hoje à noite: a tempo. "1 dia útil" chega amanhã sem hora — antes das 8h a loja não entrega.
  assert.equal(promiseHourFit("Drogaria São Paulo · 60 min", d, NIGHT), "ok");
  assert.equal(promiseHourFit("Casa Santa Luzia · 1 dia útil", d, NIGHT), "late");
  assert.equal(promiseHourFit("Casa Santa Luzia · 1 dia útil", { date: "2026-10-11", hour: 14 }, NIGHT), "unsure");
  // SLA que cairia de madrugada fica pra manhã.
  assert.equal(promiseHourFit("prazo da loja: 6h", d, NIGHT), "late");
  // A API booleana: só "late" é "não chega"; janela incerta é `null`.
  assert.equal(promiseMissesDeadline("Casa Santa Luzia · 1 dia útil", d, NIGHT), true);
  assert.equal(promiseMissesDeadline("Mambo · amanhã, 5h–8h", d, NIGHT), null);
  assert.equal(promiseMissesDeadline("Drogaria São Paulo · 60 min", d, NIGHT), false);
  // Sem hora, o comportamento de antes (só o dia).
  assert.equal(promiseMissesDeadline("Casa Santa Luzia · 1 dia útil", "2026-10-11", NIGHT), false);
  // O resumo: "4 dias úteis" não chega; "1 dia útil" pra "amanhã às 7h" também não; janela é incerta.
  const label = { ...d, label: "amanhã às 7h" };
  assert.equal(deadlineFit("prazo da loja: 4 dias úteis", label, NIGHT), "late");
  assert.equal(deadlineFit("prazo da loja: 1 dia útil", label, NIGHT), "late");
  assert.equal(deadlineFit("prazo da loja: em até 11h (amanhã, 5h–8h)", label, NIGHT), "unsure");
});

test("R17-1: a vitrine separa quem chega, quem pode chegar e quem atrasa; a copy diz a hora", () => {
  const options = [
    { delivery: "Casa Santa Luzia · 4 dias úteis", storeLabel: "Casa Santa Luzia" },
    { delivery: "Mambo · amanhã, 5h–8h", storeLabel: "Mambo" },
    { delivery: "Farmácia Indiana · 4 dias úteis", storeLabel: "Farmácia Indiana" }
  ];
  const v = deadlineVerdict(options, { date: "2026-10-11", hour: 7 }, NIGHT);
  assert.equal(v?.onTime.length, 0);
  assert.equal(v?.late.length, 2);
  assert.deepEqual(v?.unsure?.map((o) => o.storeLabel), ["Mambo"]);
  const note = copy.choicesDeadlineNote("amanhã às 7h", [], { store: "Casa Santa Luzia", promise: "4 dias úteis" }, "pão de forma", ["Mambo"]);
  assert.match(note, /só \*Mambo\* pode chegar a tempo/);
  assert.doesNotMatch(note, /nenhuma opção/);
  // Resumo e pergunta com prazo com hora: o "sem garantia" fala do dia e da hora, nunca "amanhã às 7h, mas sem hora marcada".
  const unsure = copy.deadlineFitNote({ label: "amanhã às 7h" }, "unsure");
  assert.match(unsure, /Chega \*amanhã\*, mas pode não chegar até as 7h/);
  assert.match(copy.deadlineFitNote({ label: "amanhã", morning: true }, "unsure"), /pode não ser de manhã/);
  // Oferta de juntar com janela incerta: "pode chegar", não "chega".
  const join = copy.consolidationDeadlineNote("amanhã às 7h", false, true, "prazo da loja: em até 11h (amanhã, 5h–8h)", "prazo da loja: 2 dias úteis", true);
  assert.match(join ?? "", /juntando pode chegar a tempo/);
  // O aviso de prazo por item é o mesmo modelo para cada item: a guarda anti-repetição não pode reescrever.
  assert.equal(isRepeatableVerbatim("⏰ Você precisa pra *amanhã às 7h*: de *presunto*, só *Mambo* pode chegar a tempo (a janela de entrega começa antes) — as outras opções demoram mais."), true);
});
