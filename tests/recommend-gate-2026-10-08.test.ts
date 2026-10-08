// Recomendação em modo "test" (dono, 08/10, noite): até o placar bater a meta, só dono/admins recebem
// recomendação; "all" liga para todos; "false" desliga. Fora de um turno (placar, scripts) vale.
import "./helpers/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendEnabled } from "../src/lib/recommend/types";
import { turnMeta } from "../src/lib/turn-runtime";

const withMode = (mode: string | undefined, fn: () => void) => {
  const before = process.env.LIA_RECOMMEND;
  if (mode === undefined) delete process.env.LIA_RECOMMEND;
  else process.env.LIA_RECOMMEND = mode;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.LIA_RECOMMEND;
    else process.env.LIA_RECOMMEND = before;
  }
};
const inTurn = (phone: string, fn: () => void) => turnMeta.run({ replies: 0, phone }, fn);

test("modo test (padrão): só dono/admin dentro de um turno; fora de turno vale", () => {
  process.env.LIA_ADMIN_PHONES = "5511999990000";
  withMode(undefined, () => {
    assert.equal(recommendEnabled(), true, "sem turno (placar/scripts) vale");
    inTurn("5511999990000", () => assert.equal(recommendEnabled(), true, "admin recebe"));
    inTurn("5511888880000", () => assert.equal(recommendEnabled(), false, "cliente comum não recebe"));
  });
});

test("modo all liga para todos; false desliga até para admin", () => {
  process.env.LIA_ADMIN_PHONES = "5511999990000";
  withMode("all", () => inTurn("5511888880000", () => assert.equal(recommendEnabled(), true)));
  withMode("true", () => inTurn("5511888880000", () => assert.equal(recommendEnabled(), true)));
  withMode("false", () => inTurn("5511999990000", () => assert.equal(recommendEnabled(), false)));
});
