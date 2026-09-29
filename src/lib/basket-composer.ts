// Cesta como CONJUNTO (P1.8 — problema nº 2 por frequência nas rodadas 3-5): quando
// cada linha escolhe sua loja sozinha, a compra semanal fragmenta em 3-4 entregas e o
// frete come o valor dos produtos (caso real: R$53,70 de frete em R$71 de produto).
// Este módulo escolhe, entre as opções já APROVADAS de cada linha (piso de relevância
// + rerank), a combinação que minimiza produtos+frete — guloso, uma troca por vez,
// só aceitando movimentos que reduzem o total. Puro e sem IO: testável em unidade.

export type ComposeOption = {
  sku: string;
  name: string;
  unitPrice: number;
  storeKey?: string;
  storeLabel?: string;
  medicine?: string;
};

export type ComposeLine = { qty: number; options: ComposeOption[] };

export type ComposeMove = {
  line: number;
  fromName: string;
  fromStore?: string;
  toName: string;
  toStore?: string;
  // positivo = o produto novo custa mais (compensado pelo frete)
  priceDelta: number;
};

export type ComposeOutcome = {
  picks: number[];
  moves: ComposeMove[];
  before: { products: number; freight: number; total: number; stores: number };
  after: { products: number; freight: number; total: number; stores: number };
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export function composeBasket(
  lines: ComposeLine[],
  display: (unitPrice: number, medicine?: string) => number,
  freightFor: (storeKey: string, storeLabel: string | undefined, storeDisplaySubtotal: number) => number
): ComposeOutcome {
  const storeOf = (o: ComposeOption) => o.storeKey ?? "concierge";
  const lineDisplay = (i: number, pick: number) =>
    round2(display(lines[i].options[pick].unitPrice, lines[i].options[pick].medicine) * Math.max(1, lines[i].qty));
  const lineRaw = (i: number, pick: number) =>
    round2(lines[i].options[pick].unitPrice * Math.max(1, lines[i].qty));

  const evaluate = (picks: number[]) => {
    const perStore = new Map<string, { label?: string; rawSubtotal: number }>();
    let products = 0;
    picks.forEach((pick, i) => {
      const opt = lines[i].options[pick];
      const value = lineDisplay(i, pick);
      products = round2(products + value);
      const key = storeOf(opt);
      const entry = perStore.get(key) ?? { label: opt.storeLabel, rawSubtotal: 0 };
      // O limiar de frete grátis pertence ao checkout da loja e usa o preço de
      // prateleira, não o preço exibido pela Lia com margem. Misturar os dois fazia a
      // composição anunciar frete grátis que desaparecia na cotação final.
      entry.rawSubtotal = round2(entry.rawSubtotal + lineRaw(i, pick));
      perStore.set(key, entry);
    });
    let freight = 0;
    for (const [key, entry] of perStore) {
      freight = round2(freight + Math.max(0, freightFor(key, entry.label, entry.rawSubtotal)));
    }
    return { products, freight, total: round2(products + freight), stores: perStore.size };
  };

  const picks = lines.map(() => 0);
  const before = evaluate(picks);

  // Guloso: a melhor troca de UMA linha por vez, enquanto reduzir o total.
  for (let iter = 0; iter < 50; iter++) {
    let bestGain = 0.009;
    let bestLine = -1;
    let bestPick = -1;
    const current = evaluate(picks);
    for (let i = 0; i < lines.length; i++) {
      for (let alt = 0; alt < lines[i].options.length; alt++) {
        if (alt === picks[i]) continue;
        const trial = picks.slice();
        trial[i] = alt;
        const outcome = evaluate(trial);
        // O compositor existe para combater fragmentação. Uma alternativa muito
        // barata em uma terceira loja pode reduzir centavos do total, mas piorar a
        // experiência com mais uma entrega; esse movimento nunca é aceito.
        if (outcome.stores > current.stores) continue;
        const gain = round2(current.total - outcome.total);
        if (gain > bestGain) {
          bestGain = gain;
          bestLine = i;
          bestPick = alt;
        }
      }
    }
    if (bestLine < 0) break;
    picks[bestLine] = bestPick;
  }

  const after = evaluate(picks);
  const moves: ComposeMove[] = [];
  picks.forEach((pick, i) => {
    if (pick === 0) return;
    const from = lines[i].options[0];
    const to = lines[i].options[pick];
    moves.push({
      line: i,
      fromName: from.name,
      fromStore: from.storeLabel ?? from.storeKey,
      toName: to.name,
      toStore: to.storeLabel ?? to.storeKey,
      priceDelta: round2(lineDisplay(i, pick) - lineDisplay(i, 0))
    });
  });

  return { picks, moves, before, after };
}
