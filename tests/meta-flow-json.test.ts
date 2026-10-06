// Limites do Flow JSON da Meta que já derrubaram um publish (04/09): rótulo de TextInput
// ≤ 20, título de tela ≤ 30, rótulo de Footer ≤ 35, todo campo de `data` com __example__.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_FLOW_JSON, META_PROMPTS, SIGNUP_FLOW_CTA, SIGNUP_FLOW_JSON } from "../src/lib/meta-setup";

for (const [label, flow] of [["endereço", ADDRESS_FLOW_JSON], ["cadastro", SIGNUP_FLOW_JSON]] as const) {
  test(`flow de ${label} respeita os limites da Meta`, () => {
    for (const screen of flow.screens as any[]) {
      assert.match(screen.id, /^[A-Z_]+$/);
      assert.ok(screen.title.length <= 30, screen.title);
      for (const [key, spec] of Object.entries((screen.data ?? {}) as Record<string, any>)) assert.ok(spec.__example__, key);
      const walk = (nodes: any[]) => {
        for (const n of nodes) {
          if (n.type === "TextInput") assert.ok(n.label.length <= 20, `${n.name}: "${n.label}" (${n.label.length})`);
          if (n.type === "TextInput" && n["helper-text"]) assert.ok(n["helper-text"].length <= 80, n.name);
          if (n.type === "Footer") assert.ok(n.label.length <= 35, n.label);
          assert.equal("init-value" in n, false, `${n.type} ${n.name ?? ""}: init-value não é aceito pela Meta`);
          if (n.children) walk(n.children);
        }
      };
      walk(screen.layout.children);
    }
  });
}

test("botão do formulário de cadastro cabe no limite de 20 caracteres", () => {
  assert.ok(SIGNUP_FLOW_CTA.length <= 20, SIGNUP_FLOW_CTA);
});

test("ice breakers: até 4, cada um ≤ 80 caracteres", () => {
  assert.ok(META_PROMPTS.length <= 4);
  for (const p of META_PROMPTS) assert.ok(p.length <= 80, p);
});
