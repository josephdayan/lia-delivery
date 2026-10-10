// Resumo do ESTADO da conversa para a IA do gerente de diálogo. Puro (sem I/O): o pedido em
// aberto, quando há, chega por parâmetro. Preços são os EXIBIDOS ao cliente (com o serviço
// embutido) e servem só para a IA reconhecer "o de R$ 34" — ela nunca devolve valor.
import { display, type BasketItem, type ChoiceOption, type DeliveryContext } from "../conversation-types";
import type { DialogueState, StateOption } from "./types";

export type OpenOrderView = { total: number; items: Pick<BasketItem, "name" | "qty" | "unitPrice" | "storeLabel" | "medicine">[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

function optionView(o: ChoiceOption, n: number, chosenSku?: string): StateOption {
  return {
    n,
    nome: o.name.slice(0, 90),
    preco: round2(display(o.unitPrice, o.medicine)),
    ...(o.storeLabel ? { loja: o.storeLabel } : {}),
    ...(o.delivery ? { prazo: o.delivery } : {}),
    ...(chosenSku && o.sku === chosenSku ? { escolhida: true } : {})
  };
}

export function buildDialogueState(ctx: DeliveryContext, opts: { hasAddress: boolean; order?: OpenOrderView | null }): DialogueState {
  // Escolha aberta vale pelo que está na mesa, não só pelo passo gravado (10/10, rodada 5 A1): com o passo em
  // "collecting" a vela pendente sumia do estado e a IA respondia "não vejo vela na lista".
  const choosing = (ctx.step === "choosing" || ctx.step === undefined || ctx.step === "collecting") && Boolean(ctx.pending?.length);
  const passo: DialogueState["passo"] =
    ctx.step === "awaiting_quote_confirmation"
      ? "total_na_mesa"
      : ctx.step === "choosing_freight"
        ? "escolhendo_frete"
        : choosing
          ? "escolhendo_opcao"
          : "montando_lista";

  const basketItems = ctx.basket?.length
    ? ctx.basket.map((i) => ({ nome: i.name, qtd: i.qty, loja: i.storeLabel, precoUnit: round2(display(i.unitPrice, i.medicine)) }))
    : (opts.order?.items ?? []).map((i) => ({ nome: i.name, qtd: i.qty, loja: i.storeLabel, precoUnit: round2(display(i.unitPrice, i.medicine)) }));
  const cesta = basketItems.map((i, idx) => ({ n: idx + 1, nome: i.nome.slice(0, 90), qtd: i.qtd, ...(i.loja ? { loja: i.loja } : {}), precoUnit: i.precoUnit }));

  const current = choosing ? ctx.pending![0] : undefined;
  const emEscolha = current
    ? {
        item: current.query,
        qtdPedida: current.qty,
        qtdDita: Boolean(current.qtyExplicit),
        ...(current.cap != null ? { tetoPreco: current.cap } : {}),
        opcoes: current.options.map((o, i) => optionView(o, i + 1))
      }
    : null;
  const fila = choosing
    ? ctx.pending!.slice(1).map((p, idx) => ({ n: cesta.length + idx + 1, item: p.query, qtd: p.qty }))
    : [];

  const last = !choosing ? ctx.lastChoice : undefined;
  const ultimaEscolha = last ? { item: last.query, opcoes: last.options.map((o, i) => optionView(o, i + 1, last.chosenSku)) } : null;

  const miss = ctx.lastMiss && Date.now() - ctx.lastMiss.at < 20 * 60_000 ? ctx.lastMiss : undefined;
  const freight = ctx.step === "choosing_freight" ? ctx.freightChoice : undefined;

  return {
    passo,
    enderecoSalvo: opts.hasAddress,
    cesta,
    fila,
    emEscolha,
    ultimaEscolha,
    naoAcheiRecente: miss ? { pedido: miss.query, qtd: miss.qty, jaTentouDeNovo: Boolean(miss.retried) } : null,
    totalNaMesa: ctx.step === "awaiting_quote_confirmation" && opts.order ? round2(opts.order.total) : null,
    cobrancaAberta: ctx.step === "awaiting_payment",
    opcoesDeFrete: freight
      ? [
          { n: 1, tipo: "barata", frete: round2(freight.barato.fee), ...(freight.barato.estimate ? { prazo: freight.barato.estimate } : {}) },
          { n: 2, tipo: "rapida", frete: round2(freight.rapido.fee), ...(freight.rapido.estimate ? { prazo: freight.rapido.estimate } : {}) }
        ]
      : null
  };
}
