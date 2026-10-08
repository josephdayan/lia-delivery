import RecomendacoesBoard from "./RecomendacoesBoard";

export const dynamic = "force-dynamic";

// Recomendações da Lia (08/10/2026, plano §1.5): o que o cliente pede de forma vaga ("algo
// doce", "tô com dor de barriga"), o que vira escolha e onde o mapa de prateleiras falhou.
export default function RecomendacoesPage() {
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: 24, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Lia · Recomendações</h1>
      <p style={{ color: "#667085", marginTop: 6 }}>
        Pedidos em que o cliente não nomeou o produto e a Lia indicou opções. Veja o que mais pedem, o que vira escolha e quais
        prateleiras do mapa vieram vazias (fila de revisão do mapa).
      </p>
      <RecomendacoesBoard />
    </main>
  );
}
