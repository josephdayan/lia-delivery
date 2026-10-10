import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleDeliveryMessage } from "@/lib/delivery-service";
import { runTurnScoped, TurnSupersededError } from "@/lib/turn-runtime";
import { isTestLinePhone, testLineCapture, type CapturedSend } from "@/lib/test-line";
import { genericError } from "@/lib/lia-copy";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Linha de teste em produção (09/10, OK do dono — ver src/lib/test-line.ts). POST manda UMA mensagem
// de um cliente fictício (+5500995…) pelo mesmo cérebro do webhook e devolve tudo o que a Lia
// teria enviado. DELETE apaga a conversa de teste. Autorização: header `x-test-line-token`, cujo
// sha256 fica no AppFlag `test_line_token_sha256` (sem ele, a rota não existe).
const TOKEN_FLAG = "test_line_token_sha256";

async function authorized(request: Request): Promise<boolean> {
  const token = request.headers.get("x-test-line-token") ?? "";
  if (token.length < 24) return false;
  const flag = await prisma.appFlag.findUnique({ where: { key: TOKEN_FLAG } }).catch(() => null);
  if (!flag?.value) return false;
  const got = Buffer.from(createHash("sha256").update(token).digest("hex"));
  const expected = Buffer.from(flag.value.trim().toLowerCase());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const bodySchema = z.object({
  phone: z.string(),
  text: z.string().max(4000).optional(),
  flowResponse: z.record(z.unknown()).optional()
});

// Status em que o pedido já está (ou passou) da cobrança: a linha de teste não fala mais nessa conversa.
const CHARGED_STATUSES = ["payment_issuing", "awaiting_payment", "paid", "operator_buying", "retailer_preparing", "retailer_out_for_delivery", "ready_for_pickup", "dispatched", "delivered", "refund_pending", "refunded"];

// Envio a outro número (aviso ao dono/operador) aparece marcado: foi capturado como as respostas e NÃO saiu (10/10,
// rodada 5 g16: o testador leu o aviso "Ensaio da compra" na lista e achou que tinha ido ao operador).
function render(send: CapturedSend, phone: string) {
  const [first, second] = send.args;
  return {
    kind: send.kind,
    to: send.to,
    ...(send.to !== phone ? { internal: "aviso interno capturado, não enviado" } : {}),
    ...(send.kind === "sendMessage" ? { text: first } : { args: send.args.length === 1 ? first : [first, second, ...send.args.slice(2)] })
  };
}

export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "envie {phone, text | flowResponse}" }, { status: 400 });
  const { phone, text, flowResponse } = parsed.data;
  if (!isTestLinePhone(phone)) return NextResponse.json({ error: "telefone precisa começar com +5500995" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (user) {
    const charged = await prisma.deliveryOrder.findFirst({ where: { userId: user.id, status: { in: CHARGED_STATUSES } }, select: { id: true, status: true } });
    if (charged) return NextResponse.json({ error: "pedido de teste chegou à cobrança; apague a conversa (DELETE) e recomece", order: charged }, { status: 409 });
  }

  const out: CapturedSend[] = [];
  const startedAt = Date.now();
  let error: string | undefined;
  try {
    await testLineCapture.run({ phone, out }, () =>
      runTurnScoped(() => handleDeliveryMessage({ phone, text: text ?? "", messageId: `testline_${randomUUID()}`, flowResponse }))
    );
  } catch (caught) {
    if (!(caught instanceof TurnSupersededError)) {
      error = caught instanceof Error ? caught.message : String(caught);
      // Igual ao webhook (10/10, rodada 7 A4): erro no turno ainda responde ao cliente — a linha de teste mostrava vazio.
      if (!out.some((send) => send.to === phone)) out.push({ kind: "sendMessage", to: phone, args: [genericError()] });
    }
  }
  return NextResponse.json({ ms: Date.now() - startedAt, replies: out.map((send) => render(send, phone)), ...(error ? { error } : {}) });
}

export async function DELETE(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const phone = new URL(request.url).searchParams.get("phone") ?? "";
  if (!isTestLinePhone(phone)) return NextResponse.json({ error: "telefone precisa começar com +5500995" }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (user) {
    const convos = await prisma.conversation.findMany({ where: { userId: user.id }, select: { id: true } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convos.map((c) => c.id) } } });
    await prisma.deliveryOrder.deleteMany({ where: { userId: user.id } });
    await prisma.conversation.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.waitlistLead.deleteMany({ where: { phone } });
  return NextResponse.json({ ok: true, deleted: Boolean(user) });
}
