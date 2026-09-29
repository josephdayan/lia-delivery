-- Remédio isento no CPF do cliente (29/09/2026). Colunas opcionais: nada muda sem a flag.
ALTER TABLE "User" ADD COLUMN "cpf" TEXT;
ALTER TABLE "User" ADD COLUMN "cpfName" TEXT;
ALTER TABLE "User" ADD COLUMN "cpfConsentAt" TIMESTAMP(3);
ALTER TABLE "DeliveryOrder" ADD COLUMN "buyerDocument" TEXT;
ALTER TABLE "DeliveryOrder" ADD COLUMN "buyerName" TEXT;
