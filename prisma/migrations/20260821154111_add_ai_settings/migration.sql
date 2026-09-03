-- CreateTable
CREATE TABLE "AiSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shopId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "titleSystemPrompt" TEXT,
    "descriptionSystemPrompt" TEXT,
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-5',
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSettings_shopId_key" ON "AiSettings"("shopId");
