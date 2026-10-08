-- CreateTable
CREATE TABLE "RecommendLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "need" TEXT,
    "product" TEXT,
    "symptom" TEXT,
    "criteria" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "planSource" TEXT NOT NULL,
    "redFlag" TEXT,
    "shelfIds" JSONB NOT NULL,
    "cardSkus" JSONB NOT NULL,
    "emptyShelves" JSONB NOT NULL,
    "chosenSku" TEXT,
    "outcome" TEXT,
    "mapMs" INTEGER NOT NULL,
    "searchMs" INTEGER NOT NULL,
    "judgeMs" INTEGER NOT NULL,

    CONSTRAINT "RecommendLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendLog_createdAt_idx" ON "RecommendLog"("createdAt");

-- CreateIndex
CREATE INDEX "RecommendLog_phone_idx" ON "RecommendLog"("phone");
