import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFormulationFirst, isMedicineLineExtension, medicineEquivalentFor, prescriptionDrugNameIn } from "../src/lib/medicine";

// Dono (08/10/2026): remédio de receita nomeado na recusa; marca "seca" mostra o básico antes das
// extensões de linha; marca sem estoque oferece o genérico (mesmo princípio ativo) como "mais perto".

test("recusa nomeia o remédio de receita que apareceu no pedido", () => {
  assert.equal(prescriptionDrugNameIn("quero rivotril 2mg")?.toLowerCase(), "rivotril");
  assert.equal(prescriptionDrugNameIn("amoxicilina 500mg e dipirona")?.toLowerCase(), "amoxicilina");
  assert.equal(prescriptionDrugNameIn("losartana 50 mg"), "losartana");
  assert.equal(prescriptionDrugNameIn("omeprazol 20mg")?.toLowerCase(), "omeprazol 20mg");
  assert.equal(prescriptionDrugNameIn("remédio de receita"), null, "sem nome, sem item para nomear");
  assert.equal(prescriptionDrugNameIn("dipirona"), null);
  assert.equal(prescriptionDrugNameIn("vitrine frontal"), null, "marca ambígua não conta");
});

test("extensão de linha: Sinus/DC/Bebê/12h/Mulher/DIP/Max/Composto/Muscular/Pediátrico; dose e contagem não", () => {
  const ext = (q: string, n: string) => isMedicineLineExtension(q, n);
  assert.equal(ext("tylenol", "Analgésico Tylenol 750mg 10 Comprimidos"), false);
  assert.equal(ext("tylenol", "Analgésico e Antitérmico Tylenol 200mg/ml 15ml Gotas"), false);
  assert.equal(ext("tylenol", "Analgésico e Descongestionante Tylenol Sinus 24 Comprimidos Revestidos"), true);
  assert.equal(ext("tylenol", "Analgésico Tylenol DC Múltiplas Dores 500mg + 65mg 4 Comprimidos"), true);
  assert.equal(ext("tylenol", "Analgésico e Antitérmico Tylenol Bebê 100mg/ml 15ml"), true);
  assert.equal(ext("tylenol", "Analgésico Tylenol Dor de Cabeça 500mg + 65mg 10 Comprimidos"), true);
  assert.equal(ext("advil", "Analgésico e Anti-inflamatório Advil 400mg 12 Cápsulas Liquidas"), false);
  assert.equal(ext("advil", "Analgésico e Anti-inflamatório Advil 12h 600mg 12 Comprimidos"), true);
  assert.equal(ext("advil", "Analgésico e Anti-inflamatório Advil Mulher 400mg 2 Cápsulas"), true);
  assert.equal(ext("dorflex", "Analgésico e Relaxante Muscular Dorflex 300mg + 35mg + 50mg 10 Comprimidos"), false);
  assert.equal(ext("dorflex", "Analgésico e Relaxante Muscular Dorflex DIP 1g 10 Comprimidos"), true);
  assert.equal(ext("dorflex", "Analgésico, Relaxante Muscular e Antitérmico Dorflex Max 600mg + 70mg + 100mg 16 Comprimidos"), true);
  assert.equal(ext("buscopan", "Analgésico e Antiespasmódico Buscopan 10mg 20 Drágeas"), false);
  assert.equal(ext("buscopan", "Analgésico e Antiespasmódico Buscopan Composto 10mg + 250mg 20 Comprimidos Revestido"), true);
  assert.equal(ext("buscopan", "Analgésico Buscopan Pediátrico 10mg/ml 20ml Gotas"), true);
  assert.equal(ext("neosaldina", "Analgésico, Antitérmico e Anti-inflamatório Neosaldina 30mg + 300mg + 30mg 10 Drágeas"), false);
  assert.equal(ext("neosaldina", "Analgésico e Relaxante Muscular Neosaldina Muscular 300mg 20 Comprimidos Revestidos"), true);
  assert.equal(ext("allegra", "Antialérgico Allegra 120mg 10 Comprimidos Revestidos"), false);
  assert.equal(ext("allegra", "Antialérgico Infantil Allegra Pediátrico 6mg/ml 60ml + Seringa Dosadora"), true);
  assert.equal(ext("luftal", "Antigases Luftal 75mg/ml 15ml Gotas"), false);
  assert.equal(ext("luftal", "Antigases Luftal Max Gel 250mg 10 Cápsulas Moles"), true);
  // A extensão PEDIDA não é extensão: "tylenol sinus" quer o Sinus.
  assert.equal(ext("tylenol sinus", "Analgésico e Descongestionante Tylenol Sinus 24 Comprimidos Revestidos"), false);
  assert.equal(ext("buscopan composto", "Buscopan Composto 10mg + 250mg 20 Comprimidos Revestidos"), false);
  // Sem a marca no nome, não há o que julgar.
  assert.equal(ext("tylenol", "Paracetamol 750mg Genérico EMS 20 Comprimidos"), false);
});

test("básico da marca primeiro, extensões depois, ordem estável; tudo extensão = ordem original", () => {
  const names = ["Tylenol Sinus 24 Comprimidos", "Tylenol 750mg 10 Comprimidos", "Tylenol DC 4 Comprimidos", "Tylenol 750mg 20 Comprimidos"].map((name) => ({ name }));
  assert.deepEqual(baseFormulationFirst("tylenol", names).map((o) => o.name), ["Tylenol 750mg 10 Comprimidos", "Tylenol 750mg 20 Comprimidos", "Tylenol Sinus 24 Comprimidos", "Tylenol DC 4 Comprimidos"]);
  const onlyExt = [{ name: "Tylenol Sinus 24" }, { name: "Tylenol DC 4" }];
  assert.deepEqual(baseFormulationFirst("tylenol", onlyExt), onlyExt);
});

test("equivalente de mesmo princípio ativo: marca → genérico e genérico → marca; sem tabela = null", () => {
  const t = medicineEquivalentFor("tylenol 750mg")!;
  assert.deepEqual(t.queries, ["paracetamol 750mg"]);
  assert.equal(t.falta, "é o genérico (paracetamol)");
  assert.equal(t.matches("Paracetamol 750mg Genérico EMS 20 Comprimidos"), true);
  assert.equal(t.matches("Analgésico Tylenol 750mg 10 Comprimidos"), false, "a própria marca não é 'o genérico'");
  const p = medicineEquivalentFor("paracetamol")!;
  assert.deepEqual(p.queries, ["tylenol"]);
  assert.equal(p.falta, "é o Tylenol (mesmo paracetamol)");
  assert.equal(p.matches("Analgésico Tylenol 750mg 10 Comprimidos"), true);
  const a = medicineEquivalentFor("ibuprofeno 400mg")!;
  assert.deepEqual(a.queries, ["advil 400mg", "alivium 400mg"]);
  assert.equal(medicineEquivalentFor("dorflex"), null, "sem genérico isento no catálogo: fora da tabela");
  assert.equal(medicineEquivalentFor("leite ninho"), null);
});
