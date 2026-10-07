import FaltantesBoard from "./FaltantesBoard";

export const dynamic = "force-dynamic";

// Itens que o cliente pediu e não tínhamos (07/10/2026): a demanda real que a Lia não atendeu,
// agrupada por pedido. Serve para escolher lojas e catálogo.
export default function FaltantesPage() {
  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Lia · Itens que faltaram</h1>
      <p style={{ color: "#667085", marginTop: 6 }}>
        O que o cliente pediu e não achamos (nenhuma loja tem) ou não conseguimos comprar (nenhuma loja entrega no CEP dele). Agrupado
        por pedido; quanto mais clientes diferentes pediram, mais vale ter o item.
      </p>
      <FaltantesBoard />
    </main>
  );
}
