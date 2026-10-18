-- Counters for what this instance spends against its hosts' free-plan limits
-- (Turso rows read and written, pages served, SimpleFIN requests), kept by the
-- app itself. Operational, not financial data, and outside the backup's TABLES.
-- Additive only: a new table.
CREATE TABLE "UsageCount" (
    "period" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "count" BIGINT NOT NULL,

    PRIMARY KEY ("period", "metric")
);
