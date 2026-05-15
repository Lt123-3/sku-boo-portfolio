-- AlterTable
ALTER TABLE "SkuIndex" ADD COLUMN "excludedProblems" TEXT;

-- CreateTable
CREATE TABLE "ProblemLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuNumber" TEXT,
    "action" TEXT NOT NULL,
    "problemType" TEXT,
    "changedBy" TEXT NOT NULL DEFAULT 'system',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProblemLog_shopId_idx" ON "ProblemLog"("shopId");

-- CreateIndex
CREATE INDEX "ProblemLog_productId_idx" ON "ProblemLog"("productId");

-- CreateIndex
CREATE INDEX "ProblemLog_skuNumber_idx" ON "ProblemLog"("skuNumber");

-- CreateIndex
CREATE INDEX "ProblemLog_shopId_createdAt_idx" ON "ProblemLog"("shopId", "createdAt");
