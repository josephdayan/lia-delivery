// Remédio isento no CPF do cliente (29/09/2026). Unidade, sem banco: política, catálogo,
// preço, cotação, perfil de compra e nota fiscal. A conversa ponta a ponta está em
// tests/medicine-chat.db.test.ts.
import "./helpers/load-env";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractCpf, extractFullName, isPrescriptionText, isValidCpf, isValidGtin, looksLikeCpfAttempt,
  looksLikePrescriptionRequest, maskCpf, matchesOperationalEmail, medicineBuyerEmail, medicineServiceFee, splitName,
} from "../src/lib/medicine";
import { medicineFeeForItems, serviceFeeForItems } from "../src/lib/pricing";
import { display } from "../src/lib/conversation-types";
import { mipOnly, isMedicine } from "../src/lib/stores/anvisa";
import { MIP_CATALOG as DSP_MIP } from "../src/lib/stores/drogariasp-mip-catalog";
import { MIP_CATALOG as PM_MIP } from "../src/lib/stores/paguemenos-mip-catalog";
import { drogariaSpStore } from "../src/lib/stores/drogariasp";
import { pagueMenosStore } from "../src/lib/stores/paguemenos";
import * as copy from "../src/lib/lia-copy";
import { invoiceLinkFrom } from "../src/lib/store-mail-reader";
import { customerBuyerProfile } from "../src/lib/purchase/vtex-runner";
import { VtexCheckoutRejected, VtexCheckoutSession } from "../src/lib/purchase/vtex-checkout";
import { fakeVtex } from "./helpers/fake-vtex";

const CPF = "52998224725"; // CPF de teste com dígitos verificadores válidos
afterEach(() => {
  delete process.env.LIA_MEDICINE_MIP;
  delete process.env.LIA_MEDICINE_SERVICE_FEE;
  delete process.env.LIA_MEDICINE_BUYER_EMAIL_TEMPLATE;
});

test("CPF: dígitos verificadores, extração no meio do texto e máscara", () => {
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false, "sequência repetida nunca é CPF");
  assert.equal(extractCpf("Maria da Silva 529.982.247-25"), CPF);
  assert.equal(extractCpf("meu cpf é 529 982 247 25"), CPF);
  assert.equal(extractCpf("cep 01310-100"), null, "CEP não é CPF");
  assert.equal(extractCpf("529.982.247-24"), null);
  assert.equal(looksLikeCpfAttempt("529.982.247-24"), true, "11 dígitos inválidos = tentativa (resposta: CPF não confere)");
  assert.equal(maskCpf(CPF), "***.***.247-25");
});

test("nome completo: exige nome e sobrenome, ignora o CPF e as palavras de apoio", () => {
  assert.equal(extractFullName("Maria da Silva 529.982.247-25"), "Maria da Silva");
  assert.equal(extractFullName("meu nome é JOÃO PEDRO santos"), "João Pedro Santos");
  assert.equal(extractFullName("529.982.247-25"), null);
  assert.equal(extractFullName("Maria"), null, "só o primeiro nome não serve para a nota");
  assert.deepEqual(splitName("Maria da Silva"), { firstName: "Maria", lastName: "da Silva" });
});

test("receita: barra antibiótico, controlado, marca de receita e pedido de receita; isento passa", () => {
  for (const t of ["amoxicilina 500mg", "Rivotril 2mg", "ozempic", "remédio tarja preta", "tenho a receita do antibiótico", "omeprazol 20mg", "anticoncepcional"]) {
    assert.equal(looksLikePrescriptionRequest(t), true, t);
  }
  for (const t of ["dipirona", "dorflex", "um antigripal", "sal de fruta eno", "loratadina 10mg", "omeprazol 10mg"]) {
    assert.equal(looksLikePrescriptionRequest(t), false, t);
  }
});

test("catálogo MIP: toda entrada é isenta pela guarda de receita; Pague Menos só com código de barras da Drogaria SP", () => {
  assert.ok(DSP_MIP.length > 500, `Drogaria SP com poucos isentos: ${DSP_MIP.length}`);
  assert.ok(PM_MIP.length > 200, `Pague Menos com poucos isentos: ${PM_MIP.length}`);
  for (const item of [...DSP_MIP, ...PM_MIP]) {
    assert.equal(item.medicine, "mip", item.name);
    assert.equal(isPrescriptionText(`${item.name} ${item.category ?? ""}`), false, `receita no catálogo MIP: ${item.name}`);
  }
  const dspEans = new Set(DSP_MIP.map((i) => i.ean).filter(Boolean));
  for (const item of PM_MIP) {
    assert.ok(isValidGtin(item.ean) && dspEans.has(item.ean), `Pague Menos sem prova de isento: ${item.name}`);
  }
  assert.equal(isValidGtin("123456789101112"), false, "código de kit falso da Pague Menos");
  // A porta única descarta item sem a marca e item de receita, mesmo vindo do arquivo.
  assert.deepEqual(mipOnly([{ sku: "x", name: "Amoxicilina 500mg", unitPrice: 10, medicine: "mip" }, { sku: "y", name: "Dipirona 1g", unitPrice: 5 }]), []);
});

test("vitrine da farmácia: sem a flag, nenhum remédio; com a flag, o isento aparece marcado", async () => {
  assert.equal(drogariaSpStore.listCatalog().some((i) => isMedicine(i) || i.medicine), false);
  assert.equal((await drogariaSpStore.searchItems("dipirona", 10)).some((i) => i.medicine === "mip"), false);
  process.env.LIA_MEDICINE_MIP = "true";
  const found = await drogariaSpStore.searchItems("dipirona", 10);
  assert.ok(found.length > 0 && found.every((i) => i.medicine === "mip"), found.map((i) => i.name).join(" | "));
  assert.ok((await pagueMenosStore.searchItems("dorflex", 10)).some((i) => i.medicine === "mip"));
  assert.equal((await drogariaSpStore.searchItems("amoxicilina", 10)).some((i) => i.medicine === "mip"), false);
});

test("preço: remédio sem markup; taxa fixa da Lia uma vez por pedido com remédio", () => {
  assert.equal(display(10, "mip"), 10);
  assert.equal(display(10), 11);
  assert.equal(medicineServiceFee(), 4.9);
  const onlyMedicine = [{ unitPrice: 10, qty: 2, medicine: "mip" }, { unitPrice: 6, qty: 1, medicine: "mip" }];
  assert.equal(serviceFeeForItems(onlyMedicine), 4.9);
  assert.equal(medicineFeeForItems(onlyMedicine), 4.9);
  const mixed = [...onlyMedicine, { unitPrice: 20, qty: 1 }];
  assert.equal(serviceFeeForItems(mixed), 6.9, "R$2 de markup do shampoo + R$4,90 da taxa");
  assert.equal(serviceFeeForItems([{ unitPrice: 20, qty: 1 }]), 2, "sem remédio, nada muda");
  process.env.LIA_MEDICINE_SERVICE_FEE = "3,50";
  assert.equal(serviceFeeForItems(onlyMedicine), 3.5);
});

test("cotação: taxa da Lia em linha própria e aviso de compra no nome do cliente", () => {
  const text = copy.manualQuoteSummary({
    items: [{ qty: 1, name: "Dipirona 1g", lineTotal: 5.33 }], produtos: 5.33, serviceLine: 4.9, frete: 6.9, total: 17.13,
  });
  assert.match(text, /Produtos: R\$ 5,33/);
  assert.match(text, /Taxa de serviço da Lia: R\$ 4,90/);
  assert.match(text, /no seu nome e CPF/);
  const plain = copy.manualQuoteSummary({ items: [{ qty: 1, name: "Shampoo" }], produtos: 22, frete: 6.9, total: 28.9 });
  assert.doesNotMatch(plain, /Taxa de serviço|CPF/);
});

test("perfil de compra no CPF: e-mail próprio por CPF, conferência só aceita esse apelido", () => {
  const profile = customerBuyerProfile("contato@liadelivery.com.br", { document: CPF, name: "Maria da Silva" }, "5511999990000");
  assert.equal(profile.documentType, "cpf");
  assert.equal(profile.document, CPF);
  assert.equal(profile.firstName, "Maria");
  assert.equal(profile.lastName, "da Silva");
  assert.equal(profile.strictDocument, true);
  assert.match(profile.email, /^contato\+c[0-9a-f]{10}@liadelivery\.com\.br$/);
  assert.equal(profile.email, medicineBuyerEmail("contato@liadelivery.com.br", CPF), "mesmo CPF, mesmo e-mail");
  assert.notEqual(profile.email, medicineBuyerEmail("contato@liadelivery.com.br", "11144477735"));
  assert.equal(matchesOperationalEmail("contato@liadelivery.com.br", profile.email, CPF), true);
  assert.equal(matchesOperationalEmail("contato@liadelivery.com.br", profile.email, null), false, "sem CPF no pedido o apelido não vale");
  assert.equal(matchesOperationalEmail("contato@liadelivery.com.br", "contato+outro@liadelivery.com.br", CPF), false);
  assert.throws(() => customerBuyerProfile("contato@liadelivery.com.br", { document: "52998224724", name: "Maria da Silva" }));
  process.env.LIA_MEDICINE_BUYER_EMAIL_TEMPLATE = "remedio+{tag}@liadelivery.com.br";
  assert.match(medicineBuyerEmail("contato@liadelivery.com.br", CPF), /^remedio\+c[0-9a-f]{10}@liadelivery\.com\.br$/);
});

test("checkout no CPF: loja que devolve perfil mascarado ou outro documento aborta antes do pedido", async () => {
  const address = { receiverName: "Maria da Silva", postalCode: "01233020", street: "Rua X", number: "1", complement: "", neighborhood: "Centro", city: "São Paulo", state: "SP" };
  const profile = customerBuyerProfile("compras@example.test", { document: CPF, name: "Maria da Silva" });
  const fake = fakeVtex();
  const masked: typeof fake.fetchImpl = async (url, init) => {
    const response = await fake.fetchImpl(url, init);
    if (!String(url).endsWith("/attachments/clientProfileData")) return response;
    const body = (await response.json()) as Record<string, unknown>;
    body.clientProfileData = { ...(body.clientProfileData as object), document: "***.***.***-25", isCorporate: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const session = new VtexCheckoutSession("drogariasp", masked);
  await assert.rejects(session.prepare({ items: [{ sku: "dsp-354260", qty: 1 }], profile, address }), (error: unknown) =>
    error instanceof VtexCheckoutRejected && error.stage === "clientProfileData");
  assert.equal(fake.calls.some((c) => c.url.includes("/transaction")), false, "nenhum pedido criado");
});

test("nota fiscal: acha o link da NF-e no HTML do e-mail e ignora descadastro e redes", () => {
  const html = `<a href="https://www.drogariasaopaulo.com.br/unsubscribe?x=1">sair</a>
    <a href="https://instagram.com/dsp">insta</a>
    <a href="https://nfe.fazenda.sp.gov.br/ConsultaNFe/consulta?chave=3526&amp;x=1">Ver nota fiscal</a>`;
  assert.equal(invoiceLinkFrom(html), "https://nfe.fazenda.sp.gov.br/ConsultaNFe/consulta?chave=3526&x=1");
  assert.equal(invoiceLinkFrom(`<a href="https://loja.com/rastreio/123">acompanhe</a>`), undefined);
  assert.match(copy.medicineInvoiceNotice("ABC123", "Drogaria São Paulo", "https://nfe.x/1"), /#ABC123.*Drogaria São Paulo.*https:\/\/nfe\.x\/1/);
});
