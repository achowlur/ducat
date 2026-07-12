-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectorType" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "errorText" TEXT,
    "feedErrors" JSONB NOT NULL,
    "accountsSeen" INTEGER NOT NULL,
    "transactionsImported" INTEGER NOT NULL,
    "transactionsSkipped" INTEGER NOT NULL,
    "rulesApplied" INTEGER NOT NULL,
    "transfersLinked" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "TrackedSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "merchantPattern" TEXT NOT NULL,
    "expectedAmount" DECIMAL NOT NULL,
    "cadence" TEXT NOT NULL,
    "anchorDate" DATETIME NOT NULL,
    "notes" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
