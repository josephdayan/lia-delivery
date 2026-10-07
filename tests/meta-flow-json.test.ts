// Limites do Flow JSON da Meta que já derrubaram um publish (04/09): rótulo de TextInput
// ≤ 20, título de tela ≤ 30, rótulo de Footer ≤ 35, todo campo de `data` com __example__.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_FLOW_JSON, LIST_FLOW_CTA, LIST_FLOW_JSON, LIST_FLOW_SCREEN, LIST_FLOW_SLOTS, META_PROMPTS, SIGNUP_FLOW_CTA, SIGNUP_FLOW_JSON } from "../src/lib/meta-setup";

for (const [label, flow] of [["endereço", ADDRESS_FLOW_JSON], ["cadastro", SIGNUP_FLOW_JSON], ["lista", LIST_FLOW_JSON]] as const) {
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
          // A Meta recusa init-value no TextInput (04/09) e no RadioButtonsGroup (07/10): a
          // pré-seleção da lista vai no Form (`init-values`).
          if (!(label === "lista" && n.type === "RadioButtonsGroup")) {
            assert.equal("init-value" in n, false, `${n.type} ${n.name ?? ""}: init-value não é aceito pela Meta`);
          }
          if (n.type === "RadioButtonsGroup") assert.ok(n.label.length <= 30 || n.label.startsWith("${"), n.label);
          if (n.children) walk(n.children);
        }
      };
      walk(screen.layout.children);
    }
  });
}

test("formulário de cadastro: dentro do Form só campos e o botão (como no Flow de endereço publicado)", () => {
  const form = (SIGNUP_FLOW_JSON.screens[0] as any).layout.children.find((c: any) => c.type === "Form");
  for (const child of form.children) assert.ok(["TextInput", "Footer"].includes(child.type), child.type);
});

test("botão do formulário de cadastro cabe no limite de 20 caracteres", () => {
  assert.ok(SIGNUP_FLOW_CTA.length <= 20, SIGNUP_FLOW_CTA);
});

test("ice breakers: até 4, cada um ≤ 80 caracteres", () => {
  assert.ok(META_PROMPTS.length <= 4);
  for (const p of META_PROMPTS) assert.ok(p.length <= 80, p);
});

test("flow da lista: tela terminal, 15 grupos dentro do Form, ligados ao data, dentro dos limites", () => {
  const screen = LIST_FLOW_JSON.screens[0] as any;
  assert.equal(screen.id, LIST_FLOW_SCREEN);
  assert.equal(screen.terminal, true);
  const form = screen.layout.children.find((c: any) => c.type === "Form");
  const groups = form.children.filter((c: any) => c.type === "RadioButtonsGroup");
  assert.equal(groups.length, LIST_FLOW_SLOTS);
  const footer = form.children.at(-1);
  assert.equal(footer.type, "Footer");
  assert.equal(footer["on-click-action"].name, "complete");
  const payload = footer["on-click-action"].payload;
  assert.equal(payload.lia_lista, "${data.lista_id}");
  groups.forEach((g: any, i: number) => {
    const n = i + 1;
    assert.equal(g.name, `item_${n}`);
    assert.equal(g.required, false);
    assert.equal(g.label, `\${data.label_${n}}`);
    assert.equal(g.visible, `\${data.visible_${n}}`);
    assert.equal(g["data-source"], `\${data.opts_${n}}`);
    assert.equal(payload[`item_${n}`], `\${form.item_${n}}`);
    // toda referência ${data.x} aponta para um campo declarado (com __example__)
    for (const ref of JSON.stringify(g).matchAll(/\$\{data\.([a-z_0-9]+)\}/g)) assert.ok(screen.data[ref[1]], ref[1]);
  });
  for (const ref of JSON.stringify(screen.layout).matchAll(/\$\{data\.([a-z_0-9]+)\}/g)) assert.ok(screen.data[ref[1]], ref[1]);
  assert.ok(JSON.stringify(LIST_FLOW_JSON).length < 1_000_000);
  assert.ok(LIST_FLOW_CTA.length <= 20);
});
