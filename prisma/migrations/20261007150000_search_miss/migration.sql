-- CreateTable
CREATE TABLE "SearchMiss" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phoneHash" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cepPrefix" TEXT,

    CONSTRAINT "SearchMiss_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchMiss_createdAt_idx" ON "SearchMiss"("createdAt");

-- CreateIndex
CREATE INDEX "SearchMiss_query_idx" ON "SearchMiss"("query");
