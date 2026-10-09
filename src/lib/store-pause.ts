// Loja pausada (09/10/2026, dono: "se não for dar certo, a gente tem que tirar essa loja"). A Drogal
// recebeu pedido e Pix (08/10, Expressa 30 min) e nunca começou a separar: o pedido ficou 13 h em
// "pagamento aprovado" sem ninguém saber. Regra: loja que não começa um pedido comprado dentro do
// prazo SAI DA VITRINE sozinha (vtex-status.ts) e só volta quando o dono manda "lia loja <loja> on".
//
// Interruptor no BANCO (AppFlag `store_paused:<loja>`, valor = motivo), como o modo offline: vale sem
// deploy, entre instâncias. `storesForShopper` (síncrono) lê o retrato em memória, que o turno do
// WhatsApp e o cron renovam (`refreshPausedStores`, cache de 30 s).
import { prisma } from "./prisma";

const PREFIX = "store_paused:";
const CACHE_MS = 30_000;
let snapshot: { at: number; paused: Map<string, string> } = { at: 0, paused: new Map() };

export function pausedStoresSnapshot(): ReadonlyMap<string, string> {
  return snapshot.paused;
}

export async function refreshPausedStores(force = false): Promise<ReadonlyMap<string, string>> {
  if (!force && Date.now() - snapshot.at < CACHE_MS) return snapshot.paused;
  try {
    const rows = await prisma.appFlag.findMany({ where: { key: { startsWith: PREFIX } } });
    snapshot = { at: Date.now(), paused: new Map(rows.filter((r) => r.value !== "off").map((r) => [r.key.slice(PREFIX.length), r.value])) };
  } catch (error) {
    // Banco fora: fica o último retrato (nunca "despausa" uma loja por falha de leitura).
    console.error("[store-pause:read-failed]", error instanceof Error ? error.message : error);
  }
  return snapshot.paused;
}

// Devolve true se a loja passou a estar pausada agora (false = já estava).
export async function pauseStore(storeKey: string, reason: string, by: string): Promise<boolean> {
  const key = `${PREFIX}${storeKey}`;
  const before = await prisma.appFlag.findUnique({ where: { key } });
  const value = reason.slice(0, 300) || "pausada";
  await prisma.appFlag.upsert({ where: { key }, create: { key, value, updatedBy: by }, update: { value, updatedBy: by } });
  snapshot.paused.set(storeKey, value);
  console.warn(`[store-pause] ${storeKey} pausada por ${by}: ${value}`);
  return !before || before.value === "off";
}

export async function resumeStore(storeKey: string, by: string): Promise<void> {
  const key = `${PREFIX}${storeKey}`;
  await prisma.appFlag.upsert({ where: { key }, create: { key, value: "off", updatedBy: by }, update: { value: "off", updatedBy: by } });
  snapshot.paused.delete(storeKey);
  console.warn(`[store-pause] ${storeKey} religada por ${by}`);
}

// Comando do dono no WhatsApp: "lia loja drogal on" / "lia loja drogal off" (também religar/pausar).
export function parseStoreToggleCommand(text: string): { storeKey: string; on: boolean } | null {
  const n = text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const m = /^lia\s+loja\s+([a-z0-9]+)\s+(on|ligar|ligada|religar|voltar|off|desligar|pausar|tirar)$/.exec(n);
  if (!m) return null;
  return { storeKey: m[1], on: /^(on|ligar|ligada|religar|voltar)$/.test(m[2]) };
}

export function __resetPausedStoresForTests() {
  snapshot = { at: 0, paused: new Map() };
}
