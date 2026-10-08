import { test } from "node:test";
import assert from "node:assert/strict";
import { relayAllowed, relayKey, relayKeyMatches, storeFetch } from "../src/lib/store-relay";

// Repasse por São Paulo (08/10): Obramax e Casa & Vídeo recusam acesso de fora do Brasil. Não pode virar
// proxy aberto: só hosts da lista, só caminhos de API VTEX, só com a chave derivada do segredo do servidor.

function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T> | T) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    const out = run();
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (e) { restore(); throw e; }
}

test("só lojas da lista e só caminhos de API VTEX passam pelo repasse", () => {
  withEnv({ LIA_STORE_RELAY_HOSTS: undefined }, () => {
    assert.equal(relayAllowed("https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1"), true);
    assert.equal(relayAllowed("https://www.casaevideo.com.br/api/io/_v/api/intelligent-search/product_search/?query=x"), true);
    assert.equal(relayAllowed("https://www.obramax.com.br/api/catalog_system/pub/products/search?fq=skuId:1"), true);
    assert.equal(relayAllowed("https://www.obramax.com.br/"), false, "página da loja não");
    assert.equal(relayAllowed("https://www.obramax.com.br/api/vtexid/pub/authentication"), false, "login não");
    assert.equal(relayAllowed("http://www.obramax.com.br/api/checkout/pub/x"), false, "só https");
    assert.equal(relayAllowed("https://www.drogariasaopaulo.com.br/api/checkout/pub/x"), false, "loja fora da lista vai direto");
    assert.equal(relayAllowed("https://evil.example/api/checkout/pub/x"), false);
    assert.equal(relayAllowed("não é url"), false);
  });
});

test("chave: derivada do segredo do servidor; sem segredo, repasse desligado", () => {
  withEnv({ LIA_STORE_RELAY_KEY: undefined, CRON_SECRET: "s3cr3t" }, () => {
    const key = relayKey()!;
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, "s3cr3t", "o segredo nunca vai em claro");
    assert.equal(relayKeyMatches(key), true);
    assert.equal(relayKeyMatches("x".repeat(64)), false);
    assert.equal(relayKeyMatches(undefined), false);
  });
  withEnv({ LIA_STORE_RELAY_KEY: undefined, CRON_SECRET: undefined }, () => {
    assert.equal(relayKey(), null);
    assert.equal(relayKeyMatches("qualquer"), false);
  });
});

test("fora da Vercel (testes, nuvem do agente) a chamada vai direto, como antes", async () => {
  await withEnv({ VERCEL: undefined, LIA_STORE_RELAY_URL: undefined, CRON_SECRET: "s3cr3t" }, async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => { seen.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await storeFetch("https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1", { method: "POST", body: "{}" });
      assert.deepEqual(seen, ["https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1"]);
    } finally { globalThis.fetch = real; }
  });
});

test("na Vercel fora de SP: loja da lista vai pelo repasse com a chave; status, corpo e cookies voltam", async () => {
  await withEnv({ VERCEL: "1", VERCEL_REGION: "pdx1", VERCEL_URL: "lia-abc.vercel.app", LIA_STORE_RELAY_URL: undefined, LIA_STORE_RELAY_OFF: undefined, CRON_SECRET: "s3cr3t" }, async () => {
    const real = globalThis.fetch;
    const calls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 200, contentType: "application/json", setCookie: ["checkout.vtex.com=__ofid=abc; Path=/"], body: "{\"items\":[]}" }), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await storeFetch("https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1", { method: "POST", headers: { Accept: "application/json" }, body: "{}" });
      assert.equal(calls[0].url, "https://lia-abc.vercel.app/api/store-relay");
      assert.equal(calls[0].init.headers["x-lia-relay-key"], relayKey());
      assert.equal(JSON.parse(calls[0].init.body).url, "https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { items: [] });
      assert.deepEqual(res.headers.getSetCookie(), ["checkout.vtex.com=__ofid=abc; Path=/"]);
      // Loja fora da lista: direto.
      calls.length = 0;
      await storeFetch("https://www.drogariasaopaulo.com.br/api/checkout/pub/orderForms/simulation?sc=1", { method: "POST", body: "{}" });
      assert.equal(calls[0].url, "https://www.drogariasaopaulo.com.br/api/checkout/pub/orderForms/simulation?sc=1");
    } finally { globalThis.fetch = real; }
  });
  // Já em São Paulo (a própria rota): nunca repassa para si mesma.
  await withEnv({ VERCEL: "1", VERCEL_REGION: "gru1", VERCEL_URL: "lia-abc.vercel.app", CRON_SECRET: "s3cr3t" }, async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => { seen.push(String(url)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await storeFetch("https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1", { method: "POST", body: "{}" });
      assert.deepEqual(seen, ["https://www.obramax.com.br/api/checkout/pub/orderForms/simulation?sc=1"]);
    } finally { globalThis.fetch = real; }
  });
});
