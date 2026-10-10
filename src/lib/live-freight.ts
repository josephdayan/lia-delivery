// Frete AO VIVO por CEP — a consulta que o próprio site faz quando o cliente digita o
// CEP no checkout (VTEX orderForms/simulation), feita pela Lia no fechamento da lista
// com a CESTA REAL da loja e o CEP REAL do cliente. É o nível final de precisão pedido
// pelo dono (10/08): frete exato por endereço, frete grátis aplicado pelo próprio site.
//
// Regras de projeto ("faz direito, e sem demorar"):
//   - Só lojas com checkout VTEX aberto (validado por fora em 10/08). Carrefour e Petz
//     bloqueiam consulta externa e ficam na tabela por política.
//   - Todas as consultas correm EM PARALELO com timeout curto (LIA_LIVE_FREIGHT_TIMEOUT_MS,
//     2500ms) — o fechamento nunca espera mais que um timeout, aconteça o que acontecer.
//   - A cesta simulada tem que ser EXATAMENTE a cesta da loja (frete grátis depende do
//     total); item com sku fora do padrão → desiste da consulta daquela loja (tabela).
//   - Resposta válida SEM opção de entrega = o site não entrega naquele CEP → quem chama
//     deve cair para a cotação manual do operador (não se cobra entrega que não existe).
//   - Qualquer erro/timeout → null → tabela. Nunca lança; nunca segura o cliente.
// `faster` (04/09, dono: "tem que dar a opção de super expressa"): a entrega mais rápida
// que a loja oferece para a cesta, quando é mais rápida que a mais barata e o extra cabe
// em LIA_FAST_FREIGHT_MAX_EXTRA (R$ 20). Quem escolhe é o cliente (botão).
import { storeFetch } from "./store-relay";
import { withStoreSlot } from "./store-throttle";
import { storeServesCep } from "./store-areas";
import { lookupCepAddress } from "./purchase/vtex-address";

// Coordenadas do CEP na simulação (08/10 noite, pedido real estornado): a entrega TURBO (30 min) da
// Drogarias Pacheco é por RAIO. Simulada só com o CEP, a loja localiza o CEP do jeito dela e oferece
// TURBO; a COMPRA manda as coordenadas do endereço (vtex-address.ts → BrasilAPI) e a TURBO some — a Lia
// prometeu 30 min, cobrou, e a compra estornou ("nenhuma entrega dentro do prazo prometido"). A vitrine e
// a cotação agora simulam com AS MESMAS coordenadas que a compra vai usar (mesma fonte), então nunca
// prometem um prazo que o checkout não oferece. Cache por CEP; sem coordenada, simula como antes (a
// compra também vai sem). `LIA_SIM_GEO=false` desliga (testes sem rede).
const GEO_TTL_MS = 6 * 60 * 60_000;
const geoCache = new Map<string, { at: number; geo: { lat: number; lng: number } | null }>();
let geoResolver: (cep: string) => Promise<{ lat: number; lng: number } | null> = async (cep) => (await lookupCepAddress(cep, fetch, 2_500))?.geo ?? null;
export function __setSimulationGeoForTests(fn: ((cep: string) => Promise<{ lat: number; lng: number } | null>) | null): void {
  geoResolver = fn ?? (async (cep) => (await lookupCepAddress(cep, fetch, 2_500))?.geo ?? null);
  geoCache.clear();
}
const geoInFlight = new Map<string, Promise<{ lat: number; lng: number } | null>>();
export async function simulationGeo(cep: string): Promise<{ lat: number; lng: number } | null> {
  if (process.env.LIA_SIM_GEO === "false") return null;
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const hit = geoCache.get(digits);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit.geo;
  // Uma consulta por CEP em voo: a vitrine simula dezenas de itens ao mesmo tempo.
  const flying = geoInFlight.get(digits);
  if (flying) return flying;
  const task = (async () => {
    let geo: { lat: number; lng: number } | null = null;
    try {
      geo = await geoResolver(digits);
    } catch {
      geo = null;
    }
    // Falha não fica no cache por muito tempo: a próxima tentativa pode achar.
    geoCache.set(digits, { at: geo ? Date.now() : Date.now() - GEO_TTL_MS + 60_000, geo });
    if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value as string);
    return geo;
  })().finally(() => geoInFlight.delete(digits));
  geoInFlight.set(digits, task);
  return task;
}
async function simulationBody(items: { id: string; quantity: number; seller: string }[], cep: string): Promise<string> {
  const geo = await simulationGeo(cep);
  return JSON.stringify({ items, postalCode: cep.replace(/\D/g, ""), country: "BRA", ...(geo ? { geoCoordinates: [geo.lng, geo.lat] } : {}) });
}

export type LiveFreightOutcome =
  // `unitPrices` (27/09): preço de CUSTO por unidade que a loja cobra AGORA (sellingPrice da
  // simulação), por sku da Lia — o total sai com ele, não com a foto do catálogo.
  | { kind: "ok"; fee: number; estimate?: string; faster?: { fee: number; estimate?: string; name?: string }; unitPrices?: Record<string, number> }
  | { kind: "no-delivery" }
  // O site respondeu, mas algum item da cesta não está disponível pra esse CEP (sem
  // estoque / não vendido na região). Cobrar pela tabela venderia o que a loja não
  // entrega — quem chama trata como o `no-delivery`: cotação manual do operador.
  | { kind: "item-unavailable" }
  | { kind: "unavailable" };

const VTEX_LIVE: Record<string, { domain: string; sku: RegExp }> = {
  paguemenos: { domain: "www.paguemenos.com.br", sku: /^paguemenos-(\d+)$/ },
  drogariasp: { domain: "www.drogariasaopaulo.com.br", sku: /^dsp-(\d+)$/ },
  cobasi: { domain: "www.cobasi.com.br", sku: /^cobasi-(\d+)$/ },
  oba: { domain: "secure.obahortifruti.com.br", sku: /^oba-(\d+)$/ },
  swift: { domain: "loja.swift.com.br", sku: /^swift-(\d+)$/ },
  divvino: { domain: "www.divvino.com.br", sku: /^divvino-(\d+)$/ },
  kopenhagen: { domain: "www.kopenhagen.com.br", sku: /^kopenhagen-(\d+)$/ },
  rihappy: { domain: "www.rihappy.com.br", sku: /^rihappy-(\d+)$/ },
  // 02/09: o chá de R$4,49 foi cobrado com "tarifa padrão" e não tinha estoque no CEP —
  // a simulação do site responde isso (withoutStock) e agora barra antes de cobrar.
  naturaldaterra: { domain: "www.naturaldaterra.com.br", sku: /^naturaldaterra-(\d+)$/ },
  mambo: { domain: "www.mambo.com.br", sku: /^mambo-(\d+)$/ },
  americanas: { domain: "www.americanas.com.br", sku: /^americanas-(\d+)$/ },
  prezunic: { domain: "www.prezunic.com.br", sku: /^prezunic-(\d+)$/ },
  zonasul: { domain: "www.zonasul.com.br", sku: /^zonasul-(\d+)$/ },
  covabra: { domain: "www.covabra.com.br", sku: /^covabra-(\d+)$/ },
  savegnago: { domain: "www.savegnago.com.br", sku: /^savegnago-(\d+)$/ },
  wepink: { domain: "www.wepink.com.br", sku: /^wepink-(\d+)$/ },
  underarmour: { domain: "www.underarmour.com.br", sku: /^underarmour-(\d+)$/ },
  tokstok: { domain: "www.tokstok.com.br", sku: /^tokstok-(\d+)$/ },
  pbkids: { domain: "www.pbkids.com.br", sku: /^pbkids-(\d+)$/ },
  osklen: { domain: "www.osklen.com.br", sku: /^osklen-(\d+)$/ },
  motorola: { domain: "www.motorola.com.br", sku: /^motorola-(\d+)$/ },
  livrariascuritiba: { domain: "www.livrariascuritiba.com.br", sku: /^livrariascuritiba-(\d+)$/ },
  fila: { domain: "www.fila.com.br", sku: /^fila-(\d+)$/ },
  farmaciaindiana: { domain: "www.farmaciaindiana.com.br", sku: /^farmaciaindiana-(\d+)$/ },
  extrafarma: { domain: "www.extrafarma.com.br", sku: /^extrafarma-(\d+)$/ },
  drogariaspacheco: { domain: "www.drogariaspacheco.com.br", sku: /^drogariaspacheco-(\d+)$/ },
  drogariacatarinense: { domain: "www.drogariacatarinense.com.br", sku: /^drogariacatarinense-(\d+)$/ },
  santaluzia: { domain: "www.santaluzia.com.br", sku: /^santaluzia-(\d+)$/ },
  cea: { domain: "www.cea.com.br", sku: /^cea-(\d+)$/ },
  capodarte: { domain: "www.capodarte.com.br", sku: /^capodarte-(\d+)$/ },
  aramis: { domain: "www.aramis.com.br", sku: /^aramis-(\d+)$/ },
  epocacosmeticos: { domain: "www.epocacosmeticos.com.br", sku: /^epoca-(\d+)$/ },
  drogal: { domain: "www.drogal.com.br", sku: /^drogal-(\d+)$/ },
  martinsfontes: { domain: "www.martinsfontespaulista.com.br", sku: /^martinsfontes-(\d+)$/ },
  brinox: { domain: "www.brinox.com.br", sku: /^brinox-(\d+)$/ },
  creamy: { domain: "www.creamy.com.br", sku: /^creamy-(\d+)$/ },
  casaevideo: { domain: "www.casaevideo.com.br", sku: /^casaevideo-(\d+)$/ },
  telhanorte: { domain: "www.telhanorte.com.br", sku: /^telhanorte-(\d+)$/ },
  zonacriativa: { domain: "www.zonacriativa.com.br", sku: /^zonacriativa-(\d+)$/ },
  philco: { domain: "www.philco.com.br", sku: /^philco-(\d+)$/ },
  mondial: { domain: "www.mondial.com.br", sku: /^mondial-(\d+)$/ },
  oxford: { domain: "www.oxfordporcelanas.com.br", sku: /^oxford-(\d+)$/ },
  polishop: { domain: "www.polishop.com.br", sku: /^polishop-(\d+)$/ },
  obramax: { domain: "www.obramax.com.br", sku: /^obramax-(\d+)$/ }
};

function maxFastExtra(): number {
  return Number(process.env.LIA_FAST_FREIGHT_MAX_EXTRA ?? 20);
}

export function liveFreightEnabled(): boolean {
  return process.env.LIA_LIVE_FREIGHT_OFF !== "true";
}

function timeoutMs(): number {
  const value = Number(process.env.LIA_LIVE_FREIGHT_TIMEOUT_MS);
  // 4500ms: conexão FRIA a esses sites leva ~3s (TLS + VTEX); medido em 10/08 que 2500
  // cortava a primeira consulta e 6000 passava todas. As lojas rodam em paralelo, então
  // este valor é também o TETO de espera extra do fechamento, aconteça o que acontecer.
  return Number.isFinite(value) && value >= 500 ? value : 4500;
}

// Teto de sanidade: acima disso o número é suspeito (ou é transportadora de outro
// estado) — melhor o operador olhar do que cobrar automático.
function maxLiveFee(): number {
  const value = Number(process.env.LIA_LIVE_FREIGHT_MAX);
  return Number.isFinite(value) && value > 0 ? value : 150;
}

type Sla = { id?: string; name?: string; price?: number; shippingEstimate?: string; pickupStoreInfo?: { isPickupStore?: boolean }; availableDeliveryWindows?: DeliveryWindow[]; deliveryIds?: { warehouseId?: string; dockId?: string; courierId?: string }[] };
export type DeliveryWindow = { startDateUtc: string; endDateUtc: string; price?: number; lisPrice?: number; tax?: number };

// Entrega AGENDADA (25/09, Mambo): a SLA diz "2h" e R$12,90, mas a loja exige escolher uma janela,
// que custa à parte (R$3) e começa amanhã cedo. Cotar pela SLA crua prometia 2h e cobrava menos do
// que a loja cobra — o comprador era recusado (`ORD006 janela obrigatória`) e, com janela, estouraria
// o teto. Aqui a SLA vira o que ela realmente é: preço + janela mais cedo, prazo até o FIM dela.
export function earliestWindow(windows: DeliveryWindow[] | undefined, now = new Date()): DeliveryWindow | null {
  const valid = (windows ?? []).filter((w) => Date.parse(w.endDateUtc) > now.getTime());
  valid.sort((a, b) => Date.parse(a.startDateUtc) - Date.parse(b.startDateUtc));
  return valid[0] ?? null;
}
export function effectiveSla<T extends Sla>(sla: T, now = new Date()): T & { deliveryWindow?: DeliveryWindow } {
  if (!sla.availableDeliveryWindows?.length) return sla;
  const w = earliestWindow(sla.availableDeliveryWindows, now);
  // Janelas todas no passado: sem entrega possível por essa SLA.
  if (!w) return { ...sla, price: undefined };
  const hours = Math.max(1, Math.ceil((Date.parse(w.endDateUtc) - now.getTime()) / 3_600_000));
  return { ...sla, price: (sla.price ?? 0) + (w.price ?? 0), shippingEstimate: `${hours}h@${w.startDateUtc}~${w.endDateUtc}`, deliveryWindow: w };
}
type SimItem = { id?: string | number; requestIndex?: number | null; quantity?: number; availability?: string; sellingPrice?: number; measurementUnit?: string; unitMultiplier?: number };
type LogisticsInfo = { itemIndex?: number; slas?: Sla[] };

// Loja com checkout consultável (mapa VTEX_LIVE), independente do kill-switch — o plano B
// usa isto para filtrar candidatos e injeta a simulação nos testes.
export function liveCheckConfigured(storeKey: string): boolean {
  return Boolean(VTEX_LIVE[storeKey]);
}

export function liveCheckSupported(storeKey: string): boolean {
  return liveFreightEnabled() && Boolean(VTEX_LIVE[storeKey]);
}

// Prazo da LOJA para o CEP do cliente, em português ("1bd" → "chega em 1 dia útil"). Só
// existe quando veio da simulação real — é o único prazo que pode aparecer num card.
// Redação (04/09, dono: "tava escrito que chegava em 90 min mas não acho que é verdade"):
// o prazo é DA LOJA e conta a partir da compra na loja — que hoje é manual. "Chega em 90
// min" fazia o relógio começar no toque do cliente. Agora a frase diz de quem é o prazo.
// Janela de entrega agendada (27/09): "17h@<início ISO>~<fim ISO>" — o número à esquerda é o
// prazo até o FIM da janela (compara como qualquer "17h"); a janela vira texto legível para o
// cliente ("em até 17h (seg. 11h–14h)"), em vez de um "17h" que parece horário.
function windowText(start: string, end: string): string {
  const tz = "America/Sao_Paulo";
  const day = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: tz });
  const s = new Date(start), e = new Date(end);
  const today = day(new Date()), tomorrow = day(new Date(Date.now() + 86_400_000));
  const when = day(s) === today ? "hoje" : day(s) === tomorrow ? "amanhã" : s.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "short" }).replace(".", "");
  const hour = (d: Date) => `${Number(d.toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", hour12: false }))}h`;
  const endHour = new Date(e.getTime() + 60_000); // janelas terminam em hh:00:59
  return `${when}, ${hour(s)}–${hour(endHour)}`;
}
// Dia em que a entrega cai (10/10, rodada 5 g16): "hoje", "amanhã" ou null (mais longe / não dá pra saber). A janela
// agendada ("9h@amanhã 6h–8h") tem prazo curto em horas mas cai amanhã — o cabeçalho "Chega hoje" mentia.
export function estimateDay(estimate: string | undefined, now: Date = new Date()): "hoje" | "amanhã" | null {
  const t = (estimate ?? "").trim();
  if (!t) return null;
  const tz = "America/Sao_Paulo";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const label = (d: Date) => (day(d) === day(now) ? "hoje" : day(d) === day(new Date(now.getTime() + 86_400_000)) ? "amanhã" : null);
  const windowed = /^\d+h@([^~]+)~/.exec(t);
  if (windowed) {
    const start = new Date(windowed[1]);
    return Number.isFinite(start.getTime()) ? label(start) : null;
  }
  const m = /^(\d+)\s*(bd|d|h|m)$/i.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d" || unit === "bd") return value === 0 ? "hoje" : null;
  // SLA em horas/minutos é o "entrega no dia" da loja (como no resto do fluxo); só a janela agendada tem data.
  return value * (unit === "h" ? 60 : 1) < 24 * 60 ? "hoje" : null;
}

export function humanEstimate(estimate?: string): string | undefined {
  const windowed = /^(\d+)h@([^~]+)~(.+)$/.exec((estimate ?? "").trim());
  if (windowed) return `prazo da loja: em até ${windowed[1]}h (${windowText(windowed[2], windowed[3])})`;
  const m = /^(\d+)\s*(bd|d|h|m)$/i.exec((estimate ?? "").trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  // "0bd"/"0d" = entrega no mesmo dia (Oba responde assim) — nunca "0 dias úteis".
  if (value === 0 && (unit === "d" || unit === "bd")) return "prazo da loja: hoje";
  if (unit === "m") return `prazo da loja: ${value} min`;
  if (unit === "h") return `prazo da loja: ${value}h`;
  if (unit === "d") return value === 1 ? "prazo da loja: 1 dia" : `prazo da loja: ${value} dias`;
  return value === 1 ? "prazo da loja: 1 dia útil" : `prazo da loja: ${value} dias úteis`;
}

// "3bd" (dias úteis), "2d", "6h", "45m" → minutos, para comparar prazos entre itens.
// Dia útil vale 1 dia aqui: a comparação só serve para dizer QUAL item chega por
// último; a promessa exibida continua sendo a string original da loja.
export function estimateMinutes(estimate?: string): number {
  const m = /^(\d+)\s*(bd|d|h|m)(?:@.*)?$/i.exec((estimate ?? "").trim());
  if (!m) return -1;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 24 * 60;
}

// A cesta inteira só chega quando o item MAIS LENTO chega.
export function slowestEstimate(estimates: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestMinutes = -1;
  for (const estimate of estimates) {
    if (!estimate) continue;
    const minutes = estimateMinutes(estimate);
    if (best === undefined || minutes > bestMinutes) {
      best = estimate;
      bestMinutes = minutes;
    }
  }
  return best;
}

async function postSimulation(domain: string, items: { id: string; quantity: number; seller: string }[], cep: string): Promise<{ items?: SimItem[]; logisticsInfo?: LogisticsInfo[] } | null> {
  const body = await simulationBody(items, cep);
  const response = await storeFetch(`https://${domain}/api/checkout/pub/orderForms/simulation?sc=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    },
    body,
    signal: AbortSignal.timeout(timeoutMs())
  });
  if (!response.ok) return null;
  return (await response.json()) as { items?: SimItem[]; logisticsInfo?: LogisticsInfo[] };
}

// ---------- frete da CESTA de uma loja (06/10, M2) ----------
// O VTEX devolve o frete POR LINHA: numa cesta de uma entrega só, cada linha traz a sua FATIA
// (Swift, arroz + feijão: 8,89 + 9,01 = 17,90 — o frete de um item sozinho). Duas falhas
// cobravam o frete em dobro ("Entrega R$ 35,80 · pela própria loja"):
//   1. A entrega mais barata era escolhida POR LINHA: arroz na "Agendada" e feijão no "1 dia
//      útil" viram DUAS entregas. Uma loja = uma entrega: vale a SLA que TODAS as linhas têm,
//      a de menor total; linhas sem SLA em comum (raro) seguem separadas, somadas.
//   2. A mesma simulação, repetida, às vezes devolve o frete INTEIRO em cada linha (1790 +
//      1790, mesmo armazém/doca/transportadora — medido em 06/10, ~1 em 3 respostas, também
//      no orderForm de verdade). Sinal: ≥2 skus distintos, mesma SLA, mesmo preço em todas as
//      linhas. Ambíguo com o rateio igual (Pacheco: 345 + 345 = 690 de um item só), então quem
//      decide é a simulação de um item sozinho: se o item sozinho custa o mesmo P, a resposta
//      não rateou — o frete da cesta é P, não n×P.
export type CartLine = { sku: string; slas: (Sla & { price: number })[] };
type CartPick = { fee: number; estimate?: string; name?: string; slaId?: string; unapportioned?: boolean };
function slaKey(sla: Sla): string {
  return String(sla.id ?? sla.name ?? "");
}
// Cesta respondida sem rateio? (todas as linhas com o mesmo preço P > 0 na SLA, ≥2 skus).
export function looksUnapportioned(lines: { sku: string; price: number }[]): boolean {
  if (lines.length < 2 || new Set(lines.map((l) => l.sku)).size < 2) return false;
  const first = lines[0].price;
  return first > 0 && lines.every((l) => l.price === first);
}
// Escolhe a entrega da cesta. `pick` decide entre as SLAs de cada linha (mais barata ou mais
// rápida); `soloPrice(slaId)` = preço dessa SLA para o 1º item SOZINHO (desambigua o rateio).
export function pickCartSla(
  lines: CartLine[],
  better: (a: { fee: number; minutes: number }, b: { fee: number; minutes: number }) => boolean,
  soloPrice?: (slaId: string) => number | undefined
): CartPick | null {
  if (!lines.length || lines.some((l) => !l.slas.length)) return null;
  const common = lines[0].slas.map(slaKey).filter((key) => key && lines.every((l) => l.slas.some((s) => slaKey(s) === key)));
  let best: (CartPick & { minutes: number }) | null = null;
  for (const key of new Set(common)) {
    const chosen = lines.map((l) => l.slas.filter((s) => slaKey(s) === key).reduce((a, b) => (b.price < a.price ? b : a)));
    const perLine = chosen.map((sla, i) => ({ sku: lines[i].sku, price: sla.price }));
    const sum = perLine.reduce((total, l) => total + l.price, 0);
    const unapportioned = looksUnapportioned(perLine) && soloPrice?.(key) === perLine[0].price;
    const fee = unapportioned ? perLine[0].price : sum;
    const estimate = slowestEstimate(chosen.map((s) => s.shippingEstimate));
    const candidate = { fee, estimate, name: chosen[0].name, slaId: key, minutes: estimateMinutes(estimate), ...(unapportioned ? { unapportioned: true } : {}) };
    if (!best || better(candidate, best)) best = candidate;
  }
  if (best) {
    const { minutes: _minutes, ...pick } = best;
    return pick;
  }
  // Sem SLA em comum: cada linha na sua (entregas separadas, frete somado de verdade).
  let fee = 0;
  const estimates: (string | undefined)[] = [];
  const names: string[] = [];
  for (const line of lines) {
    const own = line.slas.map((s) => ({ fee: s.price, minutes: estimateMinutes(s.shippingEstimate), sla: s })).reduce((a, b) => (better(b, a) ? b : a));
    fee += own.fee;
    estimates.push(own.sla.shippingEstimate);
    if (own.sla.name) names.push(own.sla.name);
  }
  return { fee, estimate: slowestEstimate(estimates), name: [...new Set(names)].join(" + ") || undefined };
}
const cheaper = (a: { fee: number; minutes: number }, b: { fee: number; minutes: number }) =>
  a.fee < b.fee || (a.fee === b.fee && a.minutes >= 0 && (b.minutes < 0 || a.minutes < b.minutes));
// Mais rápida: menor prazo; empate → mais barata. Prazo ilegível nunca vence um legível.
const quicker = (a: { fee: number; minutes: number }, b: { fee: number; minutes: number }) => {
  if (a.minutes < 0) return false;
  if (b.minutes < 0) return true;
  return a.minutes < b.minutes || (a.minutes === b.minutes && a.fee < b.fee);
};

// `refusedSkus` (10/10, rodada 13 A3): QUAIS itens da cesta a loja recusou, quando a resposta diz (linha sem entrega,
// linha sem estoque). Ausente = a loja inteira (fora da área, resposta sem culpado). O fechamento tira só esses.
export type LiveFreightDetailed = LiveFreightOutcome & { refusedSkus?: string[] };

export async function liveStoreFreight(storeKey: string, items: { sku: string; qty: number }[], cep: string): Promise<LiveFreightOutcome> {
  const { refusedSkus: _refused, ...outcome } = await liveStoreFreightDetailed(storeKey, items, cep);
  return outcome as LiveFreightOutcome;
}

export async function liveStoreFreightDetailed(
  storeKey: string,
  items: { sku: string; qty: number }[],
  cep: string
): Promise<LiveFreightDetailed> {
  // Loja regional fora da área do CEP: resposta definitiva, sem rede (store-areas.ts).
  if (items.length && !storeServesCep(storeKey, cep)) return { kind: "no-delivery" };
  const store = VTEX_LIVE[storeKey];
  if (!liveFreightEnabled() || !store || !items.length) return { kind: "unavailable" };

  const simItems: { id: string; quantity: number; seller: string }[] = [];
  for (const item of items) {
    const m = store.sku.exec(item.sku);
    // Cesta parcial simularia frete errado (o grátis depende do total) — desiste.
    if (!m) return { kind: "unavailable" };
    simItems.push({ id: m[1], quantity: Math.max(1, item.qty), seller: "1" });
  }

  try {
    const payload = await postSimulation(store.domain, simItems, cep);
    if (!payload) return { kind: "unavailable" };
    let simulated = Array.isArray(payload.items) ? payload.items : [];
    let logistics = Array.isArray(payload.logisticsInfo) ? payload.logisticsInfo : [];
    // Brinde da loja (10/10, rodada 4, M5): a Época devolve uma 2ª linha (SKU que não pedimos, requestIndex nulo, preço 0)
    // com promoção de brinde. Ela não é da nossa cesta: sai da conferência (e da logística), senão o item escolhido
    // "não era confirmado" no fechamento.
    const askedIds = new Set(simItems.map((item) => item.id));
    const isGift = (item: SimItem) => !askedIds.has(String(item.id ?? "")) && (item.requestIndex == null || item.sellingPrice === 0);
    if (simulated.some(isGift)) {
      const remap = new Map<number, number>();
      const kept: SimItem[] = [];
      simulated.forEach((item, index) => {
        if (isGift(item)) return;
        remap.set(index, kept.length);
        kept.push(item);
      });
      logistics = logistics
        .map((info, position) => ({ info, from: typeof info.itemIndex === "number" ? info.itemIndex : position }))
        .filter(({ from }) => remap.has(from))
        .map(({ info, from }) => ({ ...info, itemIndex: remap.get(from)! }));
      simulated = kept;
    }
    // O frete é POR ITEM no VTEX (um logisticsInfo por item). Uma resposta que não cobre
    // a cesta inteira não permite calcular o frete do carrinho — sem isso, uma cesta de
    // 5 itens era cobrada pelo frete de 1 (achatava todos os SLAs e pegava o mais barato).
    // A loja pode DIVIDIR a mesma linha em várias (promoção "leve 2": 1 un a R$7,57 + 1 un a
    // R$10,82 — Drogarias Pacheco, 05/10). Cada linha devolvida tem sua logística; o eco por
    // multiconjunto abaixo garante que a soma ainda é a nossa cesta. Antes, contar linhas
    // tratava a divisão como erro e o item "não tinha" para o CEP.
    if (simulated.length < simItems.length || logistics.length !== simulated.length) {
      return { kind: "unavailable" };
    }
    // O ECO tem que ser a NOSSA cesta (2ª revisão, 11/08): contar linhas não basta —
    // resposta com id trocado, quantidade errada ou item repetido produziria o frete de
    // outra cesta. Compara o multiconjunto (id → quantidade total) pedido × devolvido.
    const wanted = new Map<string, number>();
    for (const item of simItems) wanted.set(item.id, (wanted.get(item.id) ?? 0) + item.quantity);
    const echoed = new Map<string, number>();
    for (const item of simulated) {
      const id = String(item.id ?? "");
      const qty = typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : NaN;
      if (!id || !Number.isFinite(qty)) return { kind: "unavailable" };
      echoed.set(id, (echoed.get(id) ?? 0) + qty);
    }
    if (echoed.size !== wanted.size) return { kind: "unavailable" };
    for (const [id, qty] of wanted) if (echoed.get(id) !== qty) return { kind: "unavailable" };
    // Item que a loja não vende/não tem pra esse CEP: cobrar pela tabela venderia o que
    // ela não entrega. Vai pro operador. (`availability` ausente = a loja não informou;
    // não inventamos indisponibilidade.)
    if (simulated.some((item) => item.availability && item.availability !== "available")) {
      const missing = new Set(simulated.filter((item) => item.availability && item.availability !== "available").map((item) => String(item.id ?? "")));
      return { kind: "item-unavailable", refusedSkus: items.filter((item) => missing.has(store.sku.exec(item.sku)?.[1] ?? "")).map((item) => item.sku) };
    }

    // logisticsInfo aponta pro item via itemIndex (quando presente); cada item precisa
    // de exatamente UMA entrada de logística — índice fora da faixa ou repetido é
    // resposta malformada e cai na tabela.
    const infoByItem = new Map<number, LogisticsInfo>();
    for (let i = 0; i < logistics.length; i++) {
      const index = typeof logistics[i].itemIndex === "number" ? logistics[i].itemIndex! : i;
      if (index < 0 || index >= simulated.length || infoByItem.has(index)) return { kind: "unavailable" };
      infoByItem.set(index, logistics[i]);
    }

    const lines: CartLine[] = [];
    // Linhas sem entrega para o CEP (10/10, rodada 13 A3): a Americanas devolve o guardanapo só com "Retirada"
    // quando vai junto de 3 Cocas — antes a cesta inteira (vela, guardanapo, Coca) caía; agora sai só o guardanapo.
    const undeliverable = new Set<string>();
    for (const index of [...infoByItem.keys()].sort((a, b) => a - b)) {
      const info = infoByItem.get(index)!;
      const deliveries = (info.slas ?? []).map((sla) => effectiveSla(sla)).filter(
        (sla): sla is typeof sla & { price: number } =>
          !sla.pickupStoreInfo?.isPickupStore &&
          !/retir/i.test(sla.name ?? "") &&
          // Preço AUSENTE não é frete grátis: sem número, não há o que cobrar com
          // segurança. Só `price: 0` explícito é grátis de verdade.
          typeof sla.price === "number" &&
          Number.isFinite(sla.price) &&
          sla.price >= 0
      );
      // Um item sem opção de entrega = a loja não entrega essa cesta nesse CEP.
      if (!deliveries.length) {
        undeliverable.add(String(simulated[index]?.id ?? ""));
        continue;
      }
      lines.push({ sku: String(simulated[index]?.id ?? index), slas: deliveries });
    }
    if (undeliverable.size) return { kind: "no-delivery", refusedSkus: items.filter((item) => undeliverable.has(store.sku.exec(item.sku)?.[1] ?? "")).map((item) => item.sku) };
    // Uma entrega por loja (06/10, M2): a SLA comum de menor total; resposta sem rateio é
    // conferida com o 1º item sozinho (1 simulação a mais, só quando ambígua).
    const ambiguous = new Set<string>();
    const probe = (key: string) => {
      ambiguous.add(key);
      return undefined;
    };
    pickCartSla(lines, cheaper, probe);
    pickCartSla(lines, quicker, probe);
    let solo: Map<string, number> | null = null;
    if (ambiguous.size) {
      const first = simItems.find((item) => item.id === lines[0].sku) ?? simItems[0];
      const alone = await postSimulation(store.domain, [first], cep).catch(() => null);
      const slas = alone?.logisticsInfo?.[0]?.slas ?? [];
      solo = new Map(slas.map((sla) => effectiveSla(sla)).filter((sla) => typeof sla.price === "number").map((sla) => [slaKey(sla), sla.price!]));
    }
    const soloPrice = (key: string) => solo?.get(key);
    const cheap = pickCartSla(lines, cheaper, soloPrice);
    const fast = pickCartSla(lines, quicker, soloPrice);
    if (!cheap || !fast) return { kind: "no-delivery" };
    if (cheap.unapportioned) console.log("[live-freight:unapportioned]", storeKey, cheap.slaId, `${lines.length}×${cheap.fee}`);
    const fee = Math.round(cheap.fee) / 100;
    if (!Number.isFinite(fee) || fee < 0 || fee > maxLiveFee()) return { kind: "unavailable" };
    const estimate = cheap.estimate;
    const fastFee = Math.round(fast.fee) / 100;
    const fastEstimate = fast.estimate;
    const cheapMinutes = estimateMinutes(estimate);
    const fastMinutes = estimateMinutes(fastEstimate);
    const extra = Math.round((fastFee - fee) * 100) / 100;
    const faster =
      fastMinutes >= 0 && (cheapMinutes < 0 || fastMinutes < cheapMinutes) && extra >= 0 && extra <= maxFastExtra() && fastFee <= maxLiveFee()
        ? { fee: fastFee, estimate: fastEstimate, name: fast.name }
        : undefined;
    const unitPrices: Record<string, number> = {};
    for (const item of items) {
      const m = store.sku.exec(item.sku);
      // Linha dividida em preços diferentes: o preço unitário é a média ponderada — é o que
      // a loja cobra pela quantidade inteira.
      const rows = m ? simulated.filter((x) => String(x.id ?? "") === m[1]) : [];
      if (!rows.length || rows.some((x) => typeof x.sellingPrice !== "number" || !Number.isFinite(x.sellingPrice) || x.sellingPrice <= 0)) continue;
      const qty = rows.reduce((sum, x) => sum + (x.quantity ?? 0), 0);
      const cents = rows.reduce((sum, x) => sum + x.sellingPrice! * (x.quantity ?? 0), 0);
      if (qty > 0) unitPrices[item.sku] = cents / qty / 100;
    }
    return { kind: "ok", fee, estimate, ...(faster ? { faster } : {}), ...(Object.keys(unitPrices).length ? { unitPrices } : {}) };
  } catch {
    return { kind: "unavailable" };
  }
}

// Disponibilidade e prazo POR ITEM para um CEP (03/09): uma simulação por loja com os
// candidatos da vitrine (qty 1 cada). `available: false` = sem estoque OU sem opção de
// entrega no endereço — nos dois casos o item não pode aparecer como opção. Item que a
// loja não ecoou fica fora do mapa (desconhecido). null = loja não consultável/erro.
// `fast*` (04/09): a entrega mais rápida que a loja oferece pro item — usada quando o cliente
// pede "pra hoje" (o card mostra esse prazo e a cotação oferece a opção rápida).
// `unitPrice` (05/10): preço de CUSTO que a loja cobra AGORA por 1 unidade (sellingPrice da
// simulação). A vitrine mostra este, não a foto semanal do catálogo — o card dizia R$15,29 e
// o fechamento corrigia para R$14,19 ("a loja mudou o preço" logo depois de escolher).
// `unitWeightKg` (06/10, A3): item vendido POR PESO (VTEX measurementUnit kg/g + unitMultiplier):
// 1 unidade do carrinho = ~unitWeightKg (Banana Nanica "Kg" = 0,18 kg por R$1,79, não 1 kg).
export type LiveItemCheck = { sku: string; available: boolean; fee?: number; estimate?: string; etaMinutes?: number; fastFee?: number; fastEstimate?: string; fastEtaMinutes?: number; unitPrice?: number; unitWeightKg?: number };

// Peso de 1 unidade do carrinho quando a loja vende por peso; undefined = vende por unidade.
export function unitWeightKgOf(item: { measurementUnit?: string; unitMultiplier?: number }): number | undefined {
  const unit = (item.measurementUnit ?? "").toLowerCase();
  const mult = Number(item.unitMultiplier);
  if (!Number.isFinite(mult) || mult <= 0 || mult === 1) return undefined;
  if (unit === "kg") return mult;
  if (unit === "g") return mult / 1000;
  return undefined;
}

// 06/10 (teste real): UMA simulação POR SKU. Com vários itens no mesmo carrinho o VTEX
// RATEIA o frete entre eles (Drogal: R$4,90 virou 4,14 + 0,53 + 0,23) e o frete grátis
// olha o total dos candidatos somados — o card dizia "frete R$2,03" e o total cobrava
// R$4,90. Sozinho no carrinho, o frete do card é o mesmo que a cotação cobra por 1 unidade.
export async function liveItemAvailability(storeKey: string, skus: string[], cep: string, qtys?: Record<string, number>): Promise<Map<string, LiveItemCheck> | null> {
  const store = VTEX_LIVE[storeKey];
  if (!liveFreightEnabled() || !store || !skus.length) return null;
  const ids: { sku: string; id: string }[] = [];
  for (const sku of skus) {
    const m = store.sku.exec(sku);
    if (m) ids.push({ sku, id: m[1] });
  }
  if (!ids.length) return null;
  const partials = await Promise.all(ids.map((entry) => simulateItems(store.domain, [{ ...entry, qty: qtys?.[entry.sku] ?? 1 }], cep)));
  if (partials.every((p) => p === null)) return null;
  const result = new Map<string, LiveItemCheck>();
  for (const partial of partials) for (const [sku, check] of partial ?? []) result.set(sku, check);
  return result;
}

// Entrega mais barata de UM item; no empate de preço vale a de menor prazo — a mesma regra que fecha a
// cesta (`cheaper` em pickCartSla). Sem isso o card dizia "7 dias úteis" e o resumo, ao fechar, "1 dia útil"
// para a mesma loja e o mesmo frete (rodada 2, c58: duas SLAs de R$7,90, a econômica vinha primeiro).
export function cheapestDelivery<T extends { price?: number; shippingEstimate?: string }>(deliveries: T[]): T {
  return deliveries.reduce((best, sla) => {
    if (sla.price! !== best.price!) return sla.price! < best.price! ? sla : best;
    const a = estimateMinutes(sla.shippingEstimate);
    const b = estimateMinutes(best.shippingEstimate);
    return a >= 0 && (b < 0 || a < b) ? sla : best;
  });
}

async function simulateItems(domain: string, ids: { sku: string; id: string; qty?: number }[], cep: string): Promise<Map<string, LiveItemCheck> | null> {
  try {
    const body = await simulationBody(ids.map((x) => ({ id: x.id, quantity: Math.max(1, x.qty ?? 1), seller: "1" })), cep);
    // Fila (store-throttle.ts, 08/10): uma simulação por SKU × 4 linhas estourava o timeout de todas.
    const response = await withStoreSlot(() =>
      storeFetch(`https://${domain}/api/checkout/pub/orderForms/simulation?sc=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
        },
        body,
        signal: AbortSignal.timeout(timeoutMs())
      })
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { items?: SimItem[]; logisticsInfo?: LogisticsInfo[] };
    const simulated = Array.isArray(payload.items) ? payload.items : [];
    const logistics = Array.isArray(payload.logisticsInfo) ? payload.logisticsInfo : [];
    const infoByIndex = new Map<number, LogisticsInfo>();
    logistics.forEach((info, i) => infoByIndex.set(typeof info.itemIndex === "number" ? info.itemIndex : i, info));
    const result = new Map<string, LiveItemCheck>();
    simulated.forEach((item, i) => {
      const id = String(item.id ?? "");
      const entry = ids.find((x) => x.id === id);
      if (!entry) return;
      if (item.availability && item.availability !== "available") {
        result.set(entry.sku, { sku: entry.sku, available: false });
        return;
      }
      const deliveries = (infoByIndex.get(i)?.slas ?? []).map((sla) => effectiveSla(sla)).filter(
        (sla) =>
          !sla.pickupStoreInfo?.isPickupStore &&
          !/retir/i.test(sla.name ?? "") &&
          typeof sla.price === "number" &&
          Number.isFinite(sla.price) &&
          sla.price >= 0
      );
      if (!deliveries.length) {
        result.set(entry.sku, { sku: entry.sku, available: false });
        return;
      }
      const cheapest = cheapestDelivery(deliveries);
      const minutes = estimateMinutes(cheapest.shippingEstimate);
      const fastest = deliveries.reduce((best, sla) => {
        const a = estimateMinutes(sla.shippingEstimate);
        const b = estimateMinutes(best.shippingEstimate);
        if (a < 0) return best;
        if (b < 0) return sla;
        if (a !== b) return a < b ? sla : best;
        return sla.price! < best.price! ? sla : best;
      });
      const fastMinutes = estimateMinutes(fastest.shippingEstimate);
      const livePrice = typeof item.sellingPrice === "number" && Number.isFinite(item.sellingPrice) && item.sellingPrice > 0 ? item.sellingPrice / 100 : undefined;
      const unitWeightKg = unitWeightKgOf(item);
      result.set(entry.sku, {
        sku: entry.sku,
        available: true,
        ...(livePrice != null ? { unitPrice: livePrice } : {}),
        ...(unitWeightKg ? { unitWeightKg } : {}),
        fee: cheapest.price! / 100,
        estimate: cheapest.shippingEstimate,
        ...(minutes >= 0 ? { etaMinutes: minutes } : {}),
        ...(fastMinutes >= 0 ? { fastFee: fastest.price! / 100, fastEstimate: fastest.shippingEstimate, fastEtaMinutes: fastMinutes } : {})
      });
    });
    return result;
  } catch {
    return null;
  }
}

// ---------- pré-voo antes de cobrar (04/09) ----------
// A cotação pode ter horas (operador) ou minutos (instantânea); a loja é consultada de
// novo no instante da cobrança, com a cesta inteira e as quantidades reais. Só um "não"
// definitivo (sem estoque / sem entrega no CEP) barra a cobrança; loja não consultável
// ou fora do ar não inventa indisponibilidade.
export type PreflightFailure = { storeKey: string; kind: "item-unavailable" | "no-delivery"; skus: string[] };
type PreflightFn = (items: { sku: string; qty: number; storeKey: string }[], cep: string) => Promise<PreflightFailure | null>;
let preflightOverride: PreflightFn | null = null;
export function __setPreflightForTests(fn: PreflightFn | null) {
  preflightOverride = fn;
}

export async function preflightBasket(items: { sku: string; qty: number; storeKey: string }[], cep: string | null | undefined): Promise<PreflightFailure | null> {
  // Trava estática ANTES de qualquer cobrança (06/10): loja regional fora da área do CEP
  // nunca é cobrada, consultável ou não, com ou sem simulação injetada.
  const outOfArea = items.filter((item) => !storeServesCep(item.storeKey, cep));
  if (outOfArea.length) {
    const storeKey = outOfArea[0].storeKey;
    return { storeKey, kind: "no-delivery", skus: outOfArea.filter((i) => i.storeKey === storeKey).map((i) => i.sku) };
  }
  if (preflightOverride) return preflightOverride(items, cep ?? "");
  if (!liveFreightEnabled() || !cep || !items.length) return null;
  const byStore = new Map<string, { sku: string; qty: number }[]>();
  for (const item of items) {
    if (!liveCheckSupported(item.storeKey)) continue;
    byStore.set(item.storeKey, [...(byStore.get(item.storeKey) ?? []), { sku: item.sku, qty: item.qty }]);
  }
  const results = await Promise.all(
    [...byStore].map(async ([storeKey, list]) => {
      const outcome = await liveStoreFreight(storeKey, list, cep);
      if (outcome.kind === "item-unavailable" || outcome.kind === "no-delivery") {
        return { storeKey, kind: outcome.kind, skus: list.map((i) => i.sku) } as PreflightFailure;
      }
      return null;
    })
  );
  return results.find((r): r is PreflightFailure => r !== null) ?? null;
}

// Prazo PROMETIDO ao cliente ("pela própria loja · prazo da loja: 7 dias úteis", "prazo da
// loja: 16h", "hoje") → minutos, para o comprador aceitar qualquer entrega da loja igual ou
// mais rápida (15/09: a comparação por texto exato quebrava com o prefixo "pela própria loja").
export function promisedMinutes(promise?: string): number | null {
  const t = (promise ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!t) return null;
  if (/\bhoje\b/.test(t)) return 24 * 60;
  const m = /(\d+)\s*(dias? uteis|dias?|h\b|horas?|min)/.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith("min")) return value;
  if (unit.startsWith("h")) return value * 60;
  return value * 24 * 60;
}

// A entrega prometida cumpre o prazo que o cliente disse ("amanhã", "até sexta")? (rodada 4, M6). `null` = não dá pra
// concluir (promessa sem prazo legível); true = NÃO cumpre. Dia útil conta como dia corrido (limite inferior).
export function promiseMissesDeadline(promise: string | undefined | null, neededByDate: string, now: Date = new Date()): boolean | null {
  const t = (promise ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!t) return null;
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const days = Math.round((Date.parse(`${neededByDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  const dayUnits = /(\d+)\s*(?:dias?\s+uteis|dias?)\b/.exec(t);
  if (dayUnits) return Number(dayUnits[1]) > days;
  // A promessa diz o dia (10/10, rodada 14 g41: "amanhã, 5h–8h" contava como "chega a tempo pra hoje" na pizza — o teto de
  // 24h abaixo trata "hoje" como 1 dia): amanhã não serve pra hoje; depois de amanhã não serve pra amanhã.
  if (/\bdepois de amanha\b/.test(t)) return days < 2;
  if (/\bamanha\b/.test(t)) return days < 1;
  if (/\bhoje\b/.test(t)) return false;
  const minutes = promisedMinutes(promise ?? undefined);
  if (minutes == null) return null;
  return minutes > Math.max(1, days) * 24 * 60;
}

// Prazo dito × entrega (10/10, rodada 10 g29): "ok" chega a tempo; "late" não chega; "unsure" chega no dia mas o cliente
// pediu "de manhã" e a loja só promete o dia (prazo em dias, sem hora). `null` = promessa sem prazo legível.
export function deadlineFit(promise: string | undefined | null, d: { date: string; morning?: boolean }, now: Date = new Date()): "ok" | "late" | "unsure" | null {
  const miss = promiseMissesDeadline(promise, d.date, now);
  if (miss == null) return null;
  if (miss) return "late";
  if (d.morning) {
    const t = (promise ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const dayUnits = /(\d+)\s*(?:dias?\s+uteis|dias?)\b/.exec(t);
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const days = Math.round((Date.parse(`${d.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    if (dayUnits && Number(dayUnits[1]) >= days) return "unsure";
  }
  return "ok";
}

// Vitrine com prazo dito (10/10, rodada 6 g19): quais opções chegam a tempo e qual a mais rápida das que não chegam.
// `null` = nenhuma promessa legível (não dá pra dizer nada). Só opções com prazo real entram.
export function deadlineVerdict<T extends { delivery?: string }>(
  options: T[],
  neededByDate: string,
  now: Date = new Date()
): { onTime: T[]; late: T[]; fastest?: T } | null {
  const onTime: T[] = [];
  const late: T[] = [];
  for (const o of options) {
    const miss = promiseMissesDeadline(o.delivery, neededByDate, now);
    if (miss === true) late.push(o);
    else if (miss === false) onTime.push(o);
  }
  if (!onTime.length && !late.length) return null;
  const minutes = (o: T) => promisedMinutes(o.delivery) ?? Number.POSITIVE_INFINITY;
  const fastest = [...late].sort((a, b) => minutes(a) - minutes(b))[0];
  return { onTime, late, ...(fastest ? { fastest } : {}) };
}
