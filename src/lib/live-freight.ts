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
export type LiveFreightOutcome =
  | { kind: "ok"; fee: number; estimate?: string; faster?: { fee: number; estimate?: string; name?: string } }
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
  epocacosmeticos: { domain: "www.epocacosmeticos.com.br", sku: /^epoca-(\d+)$/ },
  drogal: { domain: "www.drogal.com.br", sku: /^drogal-(\d+)$/ },
  martinsfontes: { domain: "www.martinsfontespaulista.com.br", sku: /^martinsfontes-(\d+)$/ },
  brinox: { domain: "www.brinox.com.br", sku: /^brinox-(\d+)$/ },
  creamy: { domain: "www.creamy.com.br", sku: /^creamy-(\d+)$/ },
  casaevideo: { domain: "www.casaevideo.com.br", sku: /^casaevideo-(\d+)$/ },
  telhanorte: { domain: "www.telhanorte.com.br", sku: /^telhanorte-(\d+)$/ },
  zonacriativa: { domain: "www.zonacriativa.com.br", sku: /^zonacriativa-(\d+)$/ }
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

type Sla = { name?: string; price?: number; shippingEstimate?: string; pickupStoreInfo?: { isPickupStore?: boolean }; availableDeliveryWindows?: DeliveryWindow[] };
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
  return { ...sla, price: (sla.price ?? 0) + (w.price ?? 0), shippingEstimate: `${hours}h`, deliveryWindow: w };
}
type SimItem = { id?: string | number; quantity?: number; availability?: string };
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
export function humanEstimate(estimate?: string): string | undefined {
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
  const m = /^(\d+)\s*(bd|d|h|m)$/i.exec((estimate ?? "").trim());
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

export async function liveStoreFreight(
  storeKey: string,
  items: { sku: string; qty: number }[],
  cep: string
): Promise<LiveFreightOutcome> {
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
    const response = await fetch(`https://${store.domain}/api/checkout/pub/orderForms/simulation?sc=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      },
      body: JSON.stringify({ items: simItems, postalCode: cep.replace(/\D/g, ""), country: "BRA" }),
      signal: AbortSignal.timeout(timeoutMs())
    });
    if (!response.ok) return { kind: "unavailable" };
    const payload = (await response.json()) as { items?: SimItem[]; logisticsInfo?: LogisticsInfo[] };
    const simulated = Array.isArray(payload.items) ? payload.items : [];
    const logistics = Array.isArray(payload.logisticsInfo) ? payload.logisticsInfo : [];
    // O frete é POR ITEM no VTEX (um logisticsInfo por item). Uma resposta que não cobre
    // a cesta inteira não permite calcular o frete do carrinho — sem isso, uma cesta de
    // 5 itens era cobrada pelo frete de 1 (achatava todos os SLAs e pegava o mais barato).
    if (simulated.length !== simItems.length || logistics.length !== simItems.length) {
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
      return { kind: "item-unavailable" };
    }

    // logisticsInfo aponta pro item via itemIndex (quando presente); cada item precisa
    // de exatamente UMA entrada de logística — índice fora da faixa ou repetido é
    // resposta malformada e cai na tabela.
    const infoByItem = new Map<number, LogisticsInfo>();
    for (let i = 0; i < logistics.length; i++) {
      const index = typeof logistics[i].itemIndex === "number" ? logistics[i].itemIndex! : i;
      if (index < 0 || index >= simItems.length || infoByItem.has(index)) return { kind: "unavailable" };
      infoByItem.set(index, logistics[i]);
    }

    let fee = 0;
    const estimates: (string | undefined)[] = [];
    let fastFee = 0;
    const fastEstimates: (string | undefined)[] = [];
    const fastNames: string[] = [];
    for (const info of infoByItem.values()) {
      const deliveries = (info.slas ?? []).map((sla) => effectiveSla(sla)).filter(
        (sla) =>
          !sla.pickupStoreInfo?.isPickupStore &&
          !/retir/i.test(sla.name ?? "") &&
          // Preço AUSENTE não é frete grátis: sem número, não há o que cobrar com
          // segurança. Só `price: 0` explícito é grátis de verdade.
          typeof sla.price === "number" &&
          Number.isFinite(sla.price) &&
          sla.price >= 0
      );
      // Um item sem opção de entrega = a loja não entrega essa cesta nesse CEP.
      if (!deliveries.length) return { kind: "no-delivery" };
      const cheapest = deliveries.reduce((best, sla) => (sla.price! < best.price! ? sla : best));
      fee += cheapest.price! / 100;
      estimates.push(cheapest.shippingEstimate);
      // Mais rápida do item: menor prazo; empate → mais barata.
      const fastest = deliveries.reduce((best, sla) => {
        const a = estimateMinutes(sla.shippingEstimate);
        const b = estimateMinutes(best.shippingEstimate);
        if (a < 0) return best;
        if (b < 0) return sla;
        if (a !== b) return a < b ? sla : best;
        return sla.price! < best.price! ? sla : best;
      });
      fastFee += fastest.price! / 100;
      fastEstimates.push(fastest.shippingEstimate);
      if (fastest.name) fastNames.push(fastest.name);
    }
    fee = Math.round(fee * 100) / 100;
    if (!Number.isFinite(fee) || fee < 0 || fee > maxLiveFee()) return { kind: "unavailable" };
    const estimate = slowestEstimate(estimates);
    fastFee = Math.round(fastFee * 100) / 100;
    const fastEstimate = slowestEstimate(fastEstimates);
    const cheapMinutes = estimateMinutes(estimate);
    const fastMinutes = estimateMinutes(fastEstimate);
    const extra = Math.round((fastFee - fee) * 100) / 100;
    const faster =
      fastMinutes >= 0 && (cheapMinutes < 0 || fastMinutes < cheapMinutes) && extra >= 0 && extra <= maxFastExtra() && fastFee <= maxLiveFee()
        ? { fee: fastFee, estimate: fastEstimate, name: [...new Set(fastNames)].join(" + ") || undefined }
        : undefined;
    return { kind: "ok", fee, estimate, ...(faster ? { faster } : {}) };
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
export type LiveItemCheck = { sku: string; available: boolean; fee?: number; estimate?: string; etaMinutes?: number; fastFee?: number; fastEstimate?: string; fastEtaMinutes?: number };

export async function liveItemAvailability(storeKey: string, skus: string[], cep: string): Promise<Map<string, LiveItemCheck> | null> {
  const store = VTEX_LIVE[storeKey];
  if (!liveFreightEnabled() || !store || !skus.length) return null;
  const ids: { sku: string; id: string }[] = [];
  for (const sku of skus) {
    const m = store.sku.exec(sku);
    if (m) ids.push({ sku, id: m[1] });
  }
  if (!ids.length) return null;
  try {
    const response = await fetch(`https://${store.domain}/api/checkout/pub/orderForms/simulation?sc=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      },
      body: JSON.stringify({ items: ids.map((x) => ({ id: x.id, quantity: 1, seller: "1" })), postalCode: cep.replace(/\D/g, ""), country: "BRA" }),
      signal: AbortSignal.timeout(timeoutMs())
    });
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
      const cheapest = deliveries.reduce((best, sla) => (sla.price! < best.price! ? sla : best));
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
      result.set(entry.sku, {
        sku: entry.sku,
        available: true,
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
