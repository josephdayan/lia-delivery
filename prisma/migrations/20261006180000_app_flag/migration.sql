-- CreateTable
CREATE TABLE "AppFlag" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppFlag_pkey" PRIMARY KEY ("key")
);
