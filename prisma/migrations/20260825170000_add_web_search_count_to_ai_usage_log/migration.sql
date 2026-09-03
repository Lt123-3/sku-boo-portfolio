-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiUsageLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "callType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "webSearchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AiUsageLog" ("cacheCreationTokens", "cacheReadTokens", "callType", "createdAt", "id", "inputTokens", "model", "outputTokens", "shopId") SELECT "cacheCreationTokens", "cacheReadTokens", "callType", "createdAt", "id", "inputTokens", "model", "outputTokens", "shopId" FROM "AiUsageLog";
DROP TABLE "AiUsageLog";
ALTER TABLE "new_AiUsageLog" RENAME TO "AiUsageLog";
CREATE INDEX "AiUsageLog_shopId_idx" ON "AiUsageLog"("shopId");
CREATE INDEX "AiUsageLog_shopId_createdAt_idx" ON "AiUsageLog"("shopId", "createdAt");
CREATE INDEX "AiUsageLog_callType_idx" ON "AiUsageLog"("callType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
