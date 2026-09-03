-- AlterTable
ALTER TABLE "AccessKey" ADD COLUMN "initials" TEXT;

-- CreateTable
CREATE TABLE "CollectionSequence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionSequence_shopId_initials_date_key" ON "CollectionSequence"("shopId", "initials", "date");
