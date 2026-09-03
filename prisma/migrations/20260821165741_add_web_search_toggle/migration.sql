-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "titleSystemPrompt" TEXT,
    "descriptionSystemPrompt" TEXT,
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-5',
    "webSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AiSettings" ("apiKeyEncrypted", "createdAt", "descriptionSystemPrompt", "id", "model", "shopId", "titleSystemPrompt", "updatedAt", "updatedBy") SELECT "apiKeyEncrypted", "createdAt", "descriptionSystemPrompt", "id", "model", "shopId", "titleSystemPrompt", "updatedAt", "updatedBy" FROM "AiSettings";
DROP TABLE "AiSettings";
ALTER TABLE "new_AiSettings" RENAME TO "AiSettings";
CREATE UNIQUE INDEX "AiSettings_shopId_key" ON "AiSettings"("shopId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
