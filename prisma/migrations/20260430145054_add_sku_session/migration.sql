-- CreateTable
CREATE TABLE "SkuSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operator',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuSession_sessionId_key" ON "SkuSession"("sessionId");

-- CreateIndex
CREATE INDEX "SkuSession_sessionId_idx" ON "SkuSession"("sessionId");

-- CreateIndex
CREATE INDEX "SkuSession_shopId_idx" ON "SkuSession"("shopId");
