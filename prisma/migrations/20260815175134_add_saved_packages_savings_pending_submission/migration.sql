-- CreateTable
CREATE TABLE "SavedPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderSaving" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "originalWeightLb" REAL NOT NULL,
    "ogPrice" REAL NOT NULL,
    "twoLbPrice" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PendingSubmission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "weightLb" REAL NOT NULL,
    "address" TEXT NOT NULL,
    "lineItems" TEXT NOT NULL,
    "rate" REAL,
    "ratedAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SavedPackage_shopId_idx" ON "SavedPackage"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPackage_shopId_name_key" ON "SavedPackage"("shopId", "name");

-- CreateIndex
CREATE INDEX "OrderSaving_shopId_idx" ON "OrderSaving"("shopId");

-- CreateIndex
CREATE INDEX "OrderSaving_shopifyOrderId_idx" ON "OrderSaving"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "PendingSubmission_shopId_idx" ON "PendingSubmission"("shopId");

-- CreateIndex
CREATE INDEX "PendingSubmission_orderId_idx" ON "PendingSubmission"("orderId");
