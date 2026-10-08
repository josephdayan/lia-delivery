"use client";

import { useEffect, useState } from "react";
import type { RecommendReport } from "@/lib/recommend-ops";

const OUTCOME: Record<string, string> = { shown: "mostrou", chosen: "escolheu", none: "sem nada", red_flag: "alerta", pending: "—" };
const KIND: Record<string, string> = { need: "necessidade", product: "produto", symptom: "sintoma" };

function when(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

const num = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

export default function RecomendacoesBoard() {
  const [days, setDays] = useState(30);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<RecommendReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Troca ?key= pelo cookie ops_session uma vez e limpa a URL (igual /ops/catalogo).
  useEffect(() => {
    (async () => {
      const key = new URLSearchParams(window.location.search).get("key");
      if (key) {
        try {
          await fetch(`/api/ops/login?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        } catch {
          /* ignora: a API responde 401 se não valeu */
        }
        window.history.replaceState({}, "", "/ops/recomendacoes");
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setError(null);
    fetch(`/api/ops/recomendacoes?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "Sem acesso — abra com /ops/recomendacoes?key=SEU_TOKEN uma vez." : `Erro ${res.status}`);
        return (await res.json()) as RecommendReport;
      })
      .then((json) => alive && setData(json))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [days, ready]);

  const cell = { padding: "8px 10px", borderBottom: "1px solid #eaecf0", textAlign: "left" as const, fontSize: 13, verticalAlign: "top" as const };
  const h2 = { fontSize: 17, fontWeight: 600, margin: "28px 0 8px" };
  const scroll = { overflowX: "auto" as const };
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 };

  const s = data?.summary;
  const cards = s
    ? [
        { label: "Recomendações", value: String(s.total), hint: `${s.counts.pending} sem resultado` },
        { label: "Com cards", value: `${num(s.shownPct)}%`, hint: `${s.counts.shown + s.counts.chosen} de ${s.total}` },
        { label: "Escolhidas", value: `${num(s.chosenPct)}%`, hint: `${s.counts.chosen} de ${s.counts.shown + s.counts.chosen} com cards` },
        { label: "Sem nada", value: `${num(s.nonePct)}%`, hint: `${s.counts.none} pedidos` },
        { label: "Alerta", value: `${num(s.redFlagPct)}%`, hint: `${s.counts.redFlag} pedidos` },
        { label: "Latência", value: ms(s.latency.avgMs), hint: `p50 ${ms(s.latency.p50Ms)} · p95 ${ms(s.latency.p95Ms)}` },
        { label: "Plano", value: `${s.planSource.ai} IA · ${s.planSource.table} tabela`, hint: s.planSource.other ? `${s.planSource.other} outro` : "mapa + juiz" }
      ]
    : [];

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
      {data && s && (
        <>
          <h2 style={h2}>Resumo</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {cards.map((c) => (
              <div key={c.label} style={{ border: "1px solid #eaecf0", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, color: "#667085" }}>{c.label}</div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{c.value}</div>
                <div style={{ fontSize: 12, color: "#667085" }}>{c.hint}</div>
              </div>
            ))}
          </div>

          <h2 style={h2}>O que as pessoas pedem</h2>
          {data.requests.length === 0 ? (
            <p style={{ color: "#667085", fontSize: 13 }}>Nenhuma recomendação no período.</p>
          ) : (
            <div style={scroll}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cell}>Pedido</th>
                    <th style={cell}>Vezes</th>
                    <th style={cell}>Clientes</th>
                    <th style={cell}>Escolhidas</th>
                    <th style={cell}>Prateleiras mais usadas</th>
                    <th style={cell}>Prateleiras vazias</th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((g) => (
                    <tr key={g.label.toLowerCase()}>
                      <td style={{ ...cell, fontWeight: 600 }}>
                        {g.label} <span style={{ color: "#98a2b3", fontWeight: 400 }}>({g.kinds.map((k) => KIND[k] ?? k).join(", ")})</span>
                      </td>
                      <td style={cell}>{g.count}</td>
                      <td style={cell}>{g.customers}</td>
                      <td style={cell}>{g.withCards ? `${num(g.chosenPct)}% (${g.chosen}/${g.withCards})` : "—"}</td>
                      <td style={{ ...cell, ...mono }}>{g.topShelves.map((x) => `${x.id} ×${x.count}`).join(", ") || "—"}</td>
                      <td style={{ ...cell, ...mono, color: g.emptyShelves.length ? "#b42318" : undefined }}>
                        {g.emptyShelves.map((x) => `${x.id} ×${x.count}`).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={h2}>Fila de revisão do mapa</h2>
          <p style={{ color: "#667085", fontSize: 13, marginTop: 0 }}>
            Prateleiras que o plano escolheu e vieram sem item com entrega no CEP: o mapa ou o estoque falhou aqui.
          </p>
          {data.emptyShelfQueue.length === 0 ? (
            <p style={{ color: "#667085", fontSize: 13 }}>Nenhuma prateleira vazia no período.</p>
          ) : (
            <div style={scroll}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cell}>Prateleira</th>
                    <th style={cell}>Vezes vazia</th>
                    <th style={cell}>Pedidos que caíram aqui</th>
                    <th style={cell}>Última</th>
                  </tr>
                </thead>
                <tbody>
                  {data.emptyShelfQueue.map((e) => (
                    <tr key={e.id}>
                      <td style={{ ...cell, ...mono, fontWeight: 600 }}>{e.id}</td>
                      <td style={cell}>{e.count}</td>
                      <td style={cell}>{e.requests.join(" · ") || "—"}</td>
                      <td style={cell}>{when(e.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={h2}>Alertas (red flag)</h2>
          {data.redFlags.length === 0 ? (
            <p style={{ color: "#667085", fontSize: 13 }}>Nenhum alerta no período.</p>
          ) : (
            <div style={scroll}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cell}>Quando</th>
                    <th style={cell}>Telefone</th>
                    <th style={cell}>Pedido</th>
                    <th style={cell}>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.redFlags.map((r, i) => (
                    <tr key={r.id ?? `${r.at}-${i}`}>
                      <td style={cell}>{when(r.at)}</td>
                      <td style={cell}>{r.phone}</td>
                      <td style={cell}>{r.request || "—"}</td>
                      <td style={{ ...cell, color: "#b42318" }}>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={h2}>Últimas {data.recent.length} recomendações</h2>
          <div style={scroll}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={cell}>Quando</th>
                  <th style={cell}>Telefone</th>
                  <th style={cell}>Forma</th>
                  <th style={cell}>Pedido</th>
                  <th style={cell}>Prateleiras</th>
                  <th style={cell}>Cards</th>
                  <th style={cell}>Resultado</th>
                  <th style={cell}>SKU escolhido</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r, i) => (
                  <tr key={r.id ?? `${r.at}-${i}`}>
                    <td style={cell}>{when(r.at)}</td>
                    <td style={cell}>{r.phone}</td>
                    <td style={cell}>{r.form === "product_judged" ? "produto" : r.form === "need" ? "necessidade" : r.form}</td>
                    <td style={{ ...cell, fontWeight: 600 }}>{r.request || "—"}</td>
                    <td style={{ ...cell, ...mono }}>{r.shelfIds.join(", ") || "—"}</td>
                    <td style={cell}>{r.cards}</td>
                    <td style={{ ...cell, color: r.outcome === "red_flag" ? "#b42318" : undefined }}>{OUTCOME[r.outcome] ?? r.outcome}</td>
                    <td style={{ ...cell, ...mono }}>{r.chosenSku ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
