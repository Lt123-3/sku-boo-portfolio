/*
  Warnings:

  - Added the required column `shopId` to the `SkuIndex` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "AccessKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operator',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SkuIndex" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "skuNumber" TEXT NOT NULL,
    "taken" BOOLEAN NOT NULL DEFAULT false,
    "titleTaken" BOOLEAN NOT NULL DEFAULT false,
    "productId" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'free',
    "problems" TEXT,
    "warehouseStatus" TEXT,
    "reservedAt" DATETIME,
    "reservedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SkuIndex" ("id", "productId", "reservedAt", "reservedBy", "skuNumber", "status", "taken", "title", "titleTaken", "updatedAt") SELECT "id", "productId", "reservedAt", "reservedBy", "skuNumber", "status", "taken", "title", "titleTaken", "updatedAt" FROM "SkuIndex";
DROP TABLE "SkuIndex";
ALTER TABLE "new_SkuIndex" RENAME TO "SkuIndex";
CREATE UNIQUE INDEX "SkuIndex_skuNumber_key" ON "SkuIndex"("skuNumber");
CREATE INDEX "SkuIndex_shopId_idx" ON "SkuIndex"("shopId");
CREATE INDEX "SkuIndex_status_idx" ON "SkuIndex"("status");
CREATE INDEX "SkuIndex_shopId_status_idx" ON "SkuIndex"("shopId", "status");
CREATE INDEX "SkuIndex_shopId_status_skuNumber_idx" ON "SkuIndex"("shopId", "status", "skuNumber");
CREATE INDEX "SkuIndex_warehouseStatus_idx" ON "SkuIndex"("warehouseStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AccessKey_shopId_idx" ON "AccessKey"("shopId");

-- CreateIndex
CREATE INDEX "AccessKey_userId_idx" ON "AccessKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessKey_shopId_userId_key" ON "AccessKey"("shopId", "userId");
