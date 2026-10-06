// Modo offline (06/10/2026): enquanto o Pix de saída do Asaas não libera, o dono quer que
// todo cliente receba "a Lia está fora do ar" em vez de uma conversa que trava no fim.
// Interruptor no BANCO (liga e desliga sem deploy): /ops, POST /api/ops/offline ou o dono
// mandando "lia offline" / "lia online" no WhatsApp. `LIA_OFFLINE=true` força ligado.
// Dono e admins passam direto, para continuar testando.
import { prisma } from "./prisma";

const KEY = "offline";
const CACHE_MS = 10_000;
let cache: { at: number; on: boolean } | null = null;

export async function isOfflineMode(): Promise<boolean> {
  if (process.env.LIA_OFFLINE === "true") return true;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.on;
  try {
    const flag = await prisma.appFlag.findUnique({ where: { key: KEY } });
    cache = { at: Date.now(), on: flag?.value === "on" };
  } catch (error) {
    // Banco fora: segue o último valor conhecido; sem nenhum, a Lia continua atendendo.
    console.error("[offline-mode:read-failed]", error instanceof Error ? error.message : error);
    return cache?.on ?? false;
  }
  return cache.on;
}

export async function setOfflineMode(on: boolean, by: string): Promise<boolean> {
  const value = on ? "on" : "off";
  await prisma.appFlag.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedBy: by }, update: { value, updatedBy: by } });
  cache = { at: Date.now(), on };
  console.warn(`[offline-mode] ${value} por ${by}`);
  return on;
}

// Comando do dono no WhatsApp. Exige o prefixo "lia" para não disparar com "offline" solto.
export function parseOfflineCommand(text: string): boolean | null {
  const normalized = text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/^lia\s+(offline|off|desligar?|pausar?)$/.test(normalized)) return true;
  if (/^lia\s+(online|on|ligar?|voltar?)$/.test(normalized)) return false;
  return null;
}
