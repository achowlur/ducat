-- Statement-import provenance: one ImportBatch row per statement file, and
-- the batch each imported row came from. The Transaction column is nullable
-- with no default and no foreign key, so a populated table (local and cloud
-- both hold rows) takes it as a plain additive ADD COLUMN; the new table and
-- the index are additive too.
ALTER TABLE "Transaction" ADD COLUMN "importBatchId" TEXT;

CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "rowsAdded" INTEGER NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");
