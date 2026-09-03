-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "callType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "webSearchUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AiUsageLog_shopId_idx" ON "AiUsageLog"("shopId");

-- CreateIndex
CREATE INDEX "AiUsageLog_shopId_createdAt_idx" ON "AiUsageLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_callType_idx" ON "AiUsageLog"("callType");
