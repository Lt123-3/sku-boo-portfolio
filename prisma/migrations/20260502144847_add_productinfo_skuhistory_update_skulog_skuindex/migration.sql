-- AlterTable
ALTER TABLE "SkuIndex" ADD COLUMN "syncedAt" DATETIME;

-- AlterTable
ALTER TABLE "SkuLog" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "SkuLog" ADD COLUMN "problems" TEXT;
ALTER TABLE "SkuLog" ADD COLUMN "shopId" TEXT;
ALTER TABLE "SkuLog" ADD COLUMN "skuNumber" TEXT;
ALTER TABLE "SkuLog" ADD COLUMN "status" TEXT DEFAULT 'active';
ALTER TABLE "SkuLog" ADD COLUMN "warehouseStatus" TEXT;

-- CreateTable
CREATE TABLE "ProductInfo" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuNumber" TEXT,
    "title" TEXT,
    "vendor" TEXT,
    "price" TEXT,
    "weight" TEXT,
    "condition" TEXT,
    "inventory" TEXT,
    "collections" TEXT,
    "imageUrl" TEXT,
    "imageCount" INTEGER,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "syncedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SkuHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuNumber" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL DEFAULT 'system'
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT 'admin',
    "role" TEXT NOT NULL DEFAULT 'operator',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AccessKey" ("active", "createdAt", "id", "role", "shopId", "userId", "username") SELECT "active", "createdAt", "id", "role", "shopId", "userId", "username" FROM "AccessKey";
DROP TABLE "AccessKey";
ALTER TABLE "new_AccessKey" RENAME TO "AccessKey";
CREATE INDEX "AccessKey_shopId_idx" ON "AccessKey"("shopId");
CREATE INDEX "AccessKey_userId_idx" ON "AccessKey"("userId");
CREATE UNIQUE INDEX "AccessKey_shopId_userId_key" ON "AccessKey"("shopId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ProductInfo_productId_key" ON "ProductInfo"("productId");

-- CreateIndex
CREATE INDEX "ProductInfo_shopId_idx" ON "ProductInfo"("shopId");

-- CreateIndex
CREATE INDEX "ProductInfo_skuNumber_idx" ON "ProductInfo"("skuNumber");

-- CreateIndex
CREATE INDEX "ProductInfo_shopId_skuNumber_idx" ON "ProductInfo"("shopId", "skuNumber");

-- CreateIndex
CREATE INDEX "SkuHistory_shopId_idx" ON "SkuHistory"("shopId");

-- CreateIndex
CREATE INDEX "SkuHistory_productId_idx" ON "SkuHistory"("productId");

-- CreateIndex
CREATE INDEX "SkuHistory_skuNumber_idx" ON "SkuHistory"("skuNumber");

-- CreateIndex
CREATE INDEX "SkuHistory_shopId_productId_idx" ON "SkuHistory"("shopId", "productId");

-- CreateIndex
CREATE INDEX "SkuHistory_field_idx" ON "SkuHistory"("field");

-- CreateIndex
CREATE INDEX "SkuHistory_changedAt_idx" ON "SkuHistory"("changedAt");
