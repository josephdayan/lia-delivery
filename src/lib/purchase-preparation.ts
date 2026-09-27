// Preparação de checkout por loja. Habilitar uma loja NÃO autoriza envio de pagamento.
// Apenas domínios de produto já usados pelos conectores do projeto.
export const PURCHASE_DOMAINS: Record<string, string> = {
  mercadolivre: "mercadolivre.com.br", paguemenos: "paguemenos.com.br",
  drogariasp: "drogariasaopaulo.com.br", cobasi: "cobasi.com.br", oba: "obahortifruti.com.br",
  swift: "swift.com.br", divvino: "divvino.com.br", kopenhagen: "kopenhagen.com.br",
  rihappy: "rihappy.com.br", naturaldaterra: "naturaldaterra.com.br",
  mambo: "mambo.com.br", epocacosmeticos: "epocacosmeticos.com.br", drogal: "drogal.com.br",
  martinsfontes: "martinsfontespaulista.com.br", brinox: "brinox.com.br", creamy: "creamy.com.br", casaevideo: "casaevideo.com.br", telhanorte: "telhanorte.com.br", zonacriativa: "zonacriativa.com.br",
  philco: "philco.com.br", mondial: "mondial.com.br", oxford: "oxfordporcelanas.com.br", polishop: "polishop.com.br", obramax: "obramax.com.br"
};
// Domínios adicionais por onde o checkout da loja passa (redirect de pagamento etc.).
// O Mercado Livre paga no Mercado Pago e usa o domínio .com para alguns fluxos.
export const PURCHASE_EXTRA_DOMAINS: Record<string, string[]> = {
  mercadolivre: ["mercadopago.com.br", "mercadolibre.com"]
};
export function purchaseDomains(storeKey: string): string[] {
  const primary = PURCHASE_DOMAINS[storeKey];
  return primary ? [primary, ...(PURCHASE_EXTRA_DOMAINS[storeKey] ?? [])] : [];
}
export function purchaseHostAllowed(storeKey: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return purchaseDomains(storeKey).some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// 15/09/2026 — operador humano: NENHUMA loja prepara carrinho sozinha por padrão. O
// default era "mercadolivre", então todo pedido pago de ML virava job do comprador local
// sem ninguém pedir. Quem quiser de volta lista em LIA_PURCHASE_PREP_STORES.
export function preparationStores(): string[] {
  return [...new Set((process.env.LIA_PURCHASE_PREP_STORES ?? "").split(",").map(s => s.trim()).filter(s => Boolean(PURCHASE_DOMAINS[s])))];
}
export function purchaseUrlAllowed(storeKey: string, value: string): boolean {
  if (!PURCHASE_DOMAINS[storeKey]) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      purchaseHostAllowed(storeKey, url.hostname) && url.pathname !== "/";
  } catch { return false; }
}
