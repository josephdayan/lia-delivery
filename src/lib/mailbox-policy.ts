// Classificação PURA dos e-mails transacionais das lojas (Fase 4, 11/09). Mesmo espírito de
// explicitTrackingStatus: frases explícitas por remetente, número do pedido obrigatório,
// nada de inferência. O corpo do e-mail nunca é gravado; só o veredito.
// delivery_code (14/09): a Cobasi manda o código que o entregador pede na porta num e-mail
// SEM número do pedido ("Seu pedido já está a caminho … 6065 … Informe apenas após receber").
export type StoreMailKind = "created" | "paid" | "invoiced" | "shipped" | "out_for_delivery" | "delivered" | "canceled" | "delivery_code";
export type StoreMailVerdict = { kind: StoreMailKind; storeOrderNumber: string; trackingUrl?: string; deliveryCode?: string };

// `senders`: domínio de plataforma compartilhada (VTEX) aceito só com o nome de exibição exato da loja.
type Rule = {
  domains: string[];
  senders?: { domain: string; name: string }[];
  number: RegExp;
  kinds: { kind: StoreMailKind; subject: RegExp }[];
  // E-mail do código de recebimento: assunto literal + onde o código está no texto.
  codeMail?: { subject: RegExp; code: RegExp };
};
const VTEX_KINDS: Rule["kinds"] = [
  { kind: "delivered", subject: /(pedido|compra) (foi )?entregu[eo]|entrega (conclu[ií]da|realizada)/i },
  // 27/09: só a ÚLTIMA MILHA vira "saiu pra entrega". "A caminho"/"enviado"/"transportadora"
  // numa loja de dias quer dizer "despachado" — vira "shipped" (mensagem de envio, sem hora).
  { kind: "out_for_delivery", subject: /sa[ií]u para (a )?entrega|em rota de entrega|saiu com o entregador|est[aá] com o entregador/i },
  { kind: "invoiced", subject: /nota fiscal|faturad[oa]/i },
  { kind: "shipped", subject: /a caminho|enviad[oa]|despachad[oa]|transportadora|postad[oa]|em tr[aâ]nsito|em transporte/i },
  { kind: "canceled", subject: /cancelad[oa]/i },
  { kind: "paid", subject: /pagamento (foi )?(aprovado|confirmado)/i },
  { kind: "created", subject: /pedido (recebido|realizado|confirmado|criado)|recebemos seu pedido/i },
];
const VTEX_NUMBER = /\b(\d{9,13}-\d{2})\b/;
export const STORE_MAIL_RULES: Record<string, Rule> = {
  swift: { domains: ["swift.com.br"], senders: [{ domain: "vtexcommerce.com.br", name: "Loja Online Swift" }], number: VTEX_NUMBER, kinds: VTEX_KINDS },
  // Cobasi numera como v146373290cbs-01 (E3 real, 13/09).
  // Remetentes reais (E3, 14/09): chave de acesso "no reply <…@vtexcommerce.com.br>"; pedido
  // "Cobasi <…@ct.vtex.com.br>" (pagamento aprovado, faturado, encaminhado à transportadora);
  // código de recebimento "Cobasi <noreply@cobasi.com.br>".
  cobasi: {
    domains: ["cobasi.com.br"],
    senders: [{ domain: "vtexcommerce.com.br", name: "no reply" }, { domain: "ct.vtex.com.br", name: "Cobasi" }],
    number: /\b(v?\d{9,13}[a-z]{0,4}-\d{2})\b/i,
    kinds: VTEX_KINDS,
    codeMail: { subject: /c[oó]digo de seguran[cç]a para recebimento/i, code: /\b(\d{4,8})\s+Informe apenas ap[oó]s receber/i },
  },
  rihappy: { domains: ["rihappy.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  kopenhagen: { domains: ["kopenhagen.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  mambo: { domains: ["mambo.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  americanas: { domains: ["americanas.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  covabra: { domains: ["covabra.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  savegnago: { domains: ["savegnago.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  wepink: { domains: ["wepink.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  underarmour: { domains: ["underarmour.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  tokstok: { domains: ["tokstok.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  pbkids: { domains: ["pbkids.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  osklen: { domains: ["osklen.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  motorola: { domains: ["motorola.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  livrariascuritiba: { domains: ["livrariascuritiba.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  fila: { domains: ["fila.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  farmaciaindiana: { domains: ["farmaciaindiana.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  extrafarma: { domains: ["extrafarma.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  drogariaspacheco: { domains: ["drogariaspacheco.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  drogariacatarinense: { domains: ["drogariacatarinense.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  santaluzia: { domains: ["santaluzia.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  cea: { domains: ["cea.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  capodarte: { domains: ["capodarte.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  aramis: { domains: ["aramis.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  epocacosmeticos: { domains: ["epocacosmeticos.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  drogal: { domains: ["drogal.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  martinsfontes: { domains: ["martinsfontespaulista.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  brinox: { domains: ["brinox.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  creamy: { domains: ["creamy.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  casaevideo: { domains: ["casaevideo.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  telhanorte: { domains: ["telhanorte.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  zonacriativa: { domains: ["zonacriativa.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  philco: { domains: ["philco.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  mondial: { domains: ["mondial.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  oxford: { domains: ["oxfordporcelanas.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  polishop: { domains: ["polishop.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  obramax: { domains: ["obramax.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  // Drogaria SP numera como v79835708dgsp-01 e o assunto é "Pagamento foi aprovado" (25/09, pedido real).
  drogariasp: { domains: ["drogariasaopaulo.com.br"], number: /\b(v?\d{8,13}[a-z]{0,4}-\d{2})\b/i, kinds: VTEX_KINDS },
  naturaldaterra: { domains: ["naturaldaterra.com.br"], number: VTEX_NUMBER, kinds: VTEX_KINDS },
  paguemenos: { domains: ["paguemenos.com.br"], number: VTEX_NUMBER, kinds: VTEX_KINDS },
  mercadolivre: {
    domains: ["mercadolivre.com.br", "mercadolivre.com", "mercadopago.com.br"],
    number: /\b(2\d{15})\b/,
    kinds: [
      { kind: "delivered", subject: /(foi |está )?entregu[eo]|chegou/i },
      { kind: "out_for_delivery", subject: /saiu para entrega|a caminho|chega hoje/i },
      { kind: "canceled", subject: /cancelad[oa]/i },
      { kind: "paid", subject: /pagamento aprovado|compra aprovada/i },
      { kind: "created", subject: /voc[êe] comprou|compra realizada|pedido recebido/i },
    ],
  },
};
function senderMatches(from: string, rule: Rule) {
  const hit = (d: string, x: string) => d === x || d.endsWith(`.${x}`);
  const domains = (from.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) ?? []).map((a) => a.split("@")[1]);
  if (domains.some((d) => rule.domains.some((x) => hit(d, x)))) return true;
  const name = from.split("<")[0].replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ").toLowerCase();
  return (rule.senders ?? []).some((s) => name === s.name.toLowerCase() && domains.some((d) => hit(d, s.domain)));
}
export function classifyStoreMail(storeKey: string, mail: { from: string; subject: string; text: string }): StoreMailVerdict | null {
  const rule = STORE_MAIL_RULES[storeKey];
  if (!rule || !senderMatches(mail.from, rule)) return null;
  if (rule.codeMail?.subject.test(mail.subject)) {
    const code = `${mail.subject}\n${mail.text}`.replace(/\s+/g, " ").match(rule.codeMail.code)?.[1];
    if (!code) return null;
    const number = `${mail.subject}\n${mail.text}`.match(rule.number)?.[1] ?? "";
    return { kind: "delivery_code", storeOrderNumber: number, deliveryCode: code };
  }
  const subject = mail.subject.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const match = rule.kinds.find((k) => k.subject.test(subject));
  if (!match) return null;
  const haystack = `${mail.subject}\n${mail.text}`;
  const number = haystack.match(rule.number)?.[1];
  if (!number) return null;
  const tracking = haystack.match(/https:\/\/[^\s"'<>]+(rastre|tracking|track|envio|shipment)[^\s"'<>]*/i)?.[0];
  return { kind: match.kind, storeOrderNumber: number, ...(tracking ? { trackingUrl: tracking } : {}) };
}
