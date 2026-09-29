// Consultas de banco do remédio isento (29/09). Separado de medicine.ts (puro, sem I/O)
// e dos módulos de pagamento (que se importam entre si).
import { prisma } from "@/lib/prisma";
import { hasMip, medicineEnabled } from "@/lib/medicine";

// Pedido com remédio isento: sem pagamento nativo da Meta (bolha Pix, One-Click).
export async function orderHasMedicine(orderId: string): Promise<boolean> {
  if (!medicineEnabled()) return false;
  const order = await prisma.deliveryOrder.findUnique({ where: { id: orderId }, select: { items: true } });
  return hasMip(order?.items as unknown as Array<{ medicine?: string }>);
}
