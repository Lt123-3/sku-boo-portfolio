-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT 'Larry',
    "role" TEXT NOT NULL DEFAULT 'operator',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AccessKey" ("active", "createdAt", "id", "role", "shopId", "userId") SELECT "active", "createdAt", "id", "role", "shopId", "userId" FROM "AccessKey";
DROP TABLE "AccessKey";
ALTER TABLE "new_AccessKey" RENAME TO "AccessKey";
CREATE INDEX "AccessKey_shopId_idx" ON "AccessKey"("shopId");
CREATE INDEX "AccessKey_userId_idx" ON "AccessKey"("userId");
CREATE UNIQUE INDEX "AccessKey_shopId_userId_key" ON "AccessKey"("shopId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
