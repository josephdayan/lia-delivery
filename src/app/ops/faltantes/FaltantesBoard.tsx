"use client";

import { useEffect, useState } from "react";

type Group = { query: string; count: number; customers: number; reasons: string[]; lastAt: string };
type Data = { total: number; groups: Group[] };

const REASON: Record<string, string> = { not_found: "ninguém tem", unbuyable: "sem entrega no CEP" };

function when(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function FaltantesBoard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetch(`/api/ops/search-misses?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "Sem acesso — abra o /ops pelo link do WhatsApp." : `Erro ${res.status}`);
        return (await res.json()) as Data;
      })
      .then((json) => alive && setData(json))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [days]);

  const cell = { padding: "8px 10px", borderBottom: "1px solid #eaecf0", textAlign: "left" as const, fontSize: 14 };
  return (
    <section>
      <label style={{ fontSize: 14, color: "#344054" }}>
        Período:{" "}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 dias</option>
          <option value={30}>30 dias</option>
          <option value={90}>90 dias</option>
        </select>
      </label>
      {error && <p style={{ color: "#b42318" }}>{error}</p>}
      {!data && !error && <p style={{ color: "#667085" }}>Carregando…</p>}
      {data && (
        <>
          <p style={{ color: "#667085", fontSize: 13 }}>
            {data.total} pedido{data.total === 1 ? "" : "s"} sem resposta, {data.groups.length} item{data.groups.length === 1 ? "" : "s"} diferente
            {data.groups.length === 1 ? "" : "s"}.
          </p>
          {data.groups.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={cell}>Pedido do cliente</th>
                  <th style={cell}>Vezes</th>
                  <th style={cell}>Clientes</th>
                  <th style={cell}>Motivo</th>
                  <th style={cell}>Última</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.query}>
                    <td style={{ ...cell, fontWeight: 600 }}>{g.query}</td>
                    <td style={cell}>{g.count}</td>
                    <td style={cell}>{g.customers}</td>
                    <td style={cell}>{g.reasons.map((r) => REASON[r] ?? r).join(", ")}</td>
                    <td style={cell}>{when(g.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
