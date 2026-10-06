"use client";
import { useEffect, useState } from "react";

// Botão do modo offline (06/10): ligado, todo cliente recebe o aviso de instabilidade e
// dono/admins seguem atendidos. Vale na hora, sem deploy.
export function OfflineSwitch() {
  const [state, setState] = useState<{ offline: boolean; forcedByEnv: boolean } | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/ops/offline", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);
  if (!state) return null;
  async function toggle() {
    if (!state) return;
    const next = !state.offline;
    if (next && !window.confirm("Desligar a Lia? Todo cliente vai receber o aviso de instabilidade.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/ops/offline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) });
      if (r.ok) setState(await r.json());
    } finally {
      setBusy(false);
    }
  }
  const off = state.offline;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 10, border: `1px solid ${off ? "#fda29b" : "#abefc6"}`, background: off ? "#fef3f2" : "#ecfdf3" }}>
      <strong style={{ color: off ? "#b42318" : "#067647" }}>{off ? "🔴 Lia OFFLINE" : "🟢 Lia ONLINE"}</strong>
      <span style={{ fontSize: 12, color: "#667085", flex: 1 }}>
        {off ? "Clientes recebem o aviso de instabilidade. Você continua passando." : "Atendendo clientes normalmente."}
      </span>
      <button
        onClick={toggle}
        disabled={busy || state.forcedByEnv}
        title={state.forcedByEnv ? "LIA_OFFLINE=true na Vercel força ligado" : undefined}
        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #d0d5dd", background: "white", cursor: "pointer", fontWeight: 600 }}
      >
        {busy ? "…" : off ? "Ligar a Lia" : "Desligar a Lia"}
      </button>
    </div>
  );
}
