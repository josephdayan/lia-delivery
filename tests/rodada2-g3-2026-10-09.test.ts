// Rodada 2, grupo A (09/10): "faltou o café" em coleta não é reclamação; lista nova avisa o que descartou.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/lib/lia-copy";
import { isMissingItemOnlyComplaint, detectIntent } from "../src/lib/lia-intents";

test("faltou o/a/um/uma + item sozinho é esquecimento; outras reclamações continuam", () => {
  for (const t of ["faltou o café", "faltou o café e o açúcar", "faltou a manteiga", "faltou um sabonete"]) {
    assert.equal(isMissingItemOnlyComplaint(t), true, t);
  }
  for (const t of ["faltou o café e veio errado o leite", "o pedido veio errado", "absurdo, faltou o café", "faltou café"]) {
    assert.equal(isMissingItemOnlyComplaint(t), false, t);
  }
  assert.equal(detectIntent("faltou o café").kind, "complaint", "a intenção pura segue reclamação; o serviço decide pelo pedido");
});

test("aviso de lista nova cita o que saiu", () => {
  const m = copy.newListDropped(["Arroz Camil 5kg", "leite"]);
  assert.match(m, /Arroz Camil 5kg/);
  assert.match(m, /adiciona/);
  assert.match(copy.newListDropped(["a", "b", "c", "d", "e", "f"]), /e mais 2/);
});
