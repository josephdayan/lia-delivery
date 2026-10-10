// Reenvio na linha de teste (10/10, rodada 7 A3): a linha cai ~25% das vezes (SSL reset) e o testador reenvia a
// MESMA mensagem. O webhook real deduplica pelo wamid (índice único conversationId+metadata); a linha de teste
// gerava um id aleatório por POST, então o reenvio virava um 2º turno. Agora: (1) quem manda `messageId` ganha o
// mesmo dedupe atômico do webhook; (2) sem id, texto idêntico ao da última mensagem do cliente ENQUANTO o turno
// dela ainda roda é o mesmo envio chegando de novo — não processa. Depois que o turno respondeu, repetir é
// intencional ("1" num carrossel e "1" no seguinte) e segue normal.
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { normalizeMsg } from "@/lib/lia-intents";
import { TURN_LOCK_TTL_MS } from "@/lib/turn-runtime";

export function testLineMessageId(clientId: string | undefined): string {
  return clientId ? `testline_${clientId}` : `testline_${randomUUID()}`;
}

export async function isInFlightResend(phone: string, text: string): Promise<boolean> {
  if (!text.trim()) return false;
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!user) return false;
  const convo = await prisma.conversation.findFirst({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true, turnLock: true, turnLockAt: true }
  });
  if (!convo?.turnLock || !convo.turnLockAt || Date.now() - convo.turnLockAt.getTime() > TURN_LOCK_TTL_MS) return false;
  const last = await prisma.message.findFirst({
    where: { conversationId: convo.id, sender: "user" },
    orderBy: { createdAt: "desc" },
    select: { text: true, createdAt: true }
  });
  if (!last || Date.now() - last.createdAt.getTime() > TURN_LOCK_TTL_MS) return false;
  return normalizeMsg(last.text ?? "") === normalizeMsg(text);
}

// Mesmo id já gravado = reenvio de um POST que já entrou (o turno rodou ou está rodando).
export async function isKnownMessageId(phone: string, messageId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (!user) return false;
  const hit = await prisma.message.findFirst({ where: { metadata: messageId, conversation: { userId: user.id } }, select: { id: true } });
  return Boolean(hit);
}
