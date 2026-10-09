// Linha de teste em produção (09/10, OK do dono): conversa de cliente FICTÍCIO (+5500995…) que
// entra pelo mesmo cérebro do webhook, com o env e o banco de produção, mas cujas respostas são
// gravadas em vez de irem para a Meta. Achou bug que só existe em produção (flags, formulários,
// carrossel) sem usar o celular de ninguém.
// Travas: (1) dentro do contexto de captura NENHUM envio de WhatsApp sai — nem para o cliente
// fictício nem aviso ao dono/operador; (2) cobrança (Pix e link de cartão) é recusada antes de
// chegar ao Mercado Pago, então nenhum pedido de teste vira pago e nada é comprado.
import { AsyncLocalStorage } from "node:async_hooks";
import { checkoutAdapter, pixAdapter } from "@/lib/payments/mercadopago";

export const TEST_LINE_PREFIX = "+5500995";

export type CapturedSend = { kind: string; to: string; args: unknown[] };
export const testLineCapture = new AsyncLocalStorage<{ phone: string; out: CapturedSend[] }>();

export function isTestLinePhone(phone: string): boolean {
  return phone.startsWith(TEST_LINE_PREFIX) && /^\+\d{13,14}$/.test(phone);
}

export class TestLineChargeBlocked extends Error {
  constructor() {
    super("linha de teste: cobrança bloqueada");
    this.name = "TestLineChargeBlocked";
  }
}

{
  const block = (target: Record<string, unknown>, name: string) => {
    const original = target[name] as (...args: unknown[]) => Promise<unknown>;
    target[name] = async function (this: unknown, ...args: unknown[]) {
      if (testLineCapture.getStore()) throw new TestLineChargeBlocked();
      return original.apply(this, args);
    };
  };
  block(pixAdapter as unknown as Record<string, unknown>, "createPix");
  block(checkoutAdapter as unknown as Record<string, unknown>, "createLink");
}
