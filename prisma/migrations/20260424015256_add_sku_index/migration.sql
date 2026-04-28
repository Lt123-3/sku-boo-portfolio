-- CreateTable
CREATE TABLE "SkuIndex" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "skuNumber" TEXT NOT NULL,
    "taken" BOOLEAN NOT NULL DEFAULT false,
    "titleTaken" BOOLEAN NOT NULL DEFAULT false,
    "productId" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'free',
    "reservedAt" DATETIME,
    "reservedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SkuIndex_skuNumber_key" ON "SkuIndex"("skuNumber");
