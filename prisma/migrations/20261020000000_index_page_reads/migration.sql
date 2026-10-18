-- Indexes for the reads pages make as history grows. Turso bills rows read:
-- the ledger, the period reports and the trip view filter or order by date and
-- label, health reads a connector's latest run, and the insight pages read one
-- type or period. Without these each is a scan of the whole table.
-- Additive only: plain CREATE INDEX on existing columns.
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

CREATE INDEX "Transaction_groupLabel_idx" ON "Transaction"("groupLabel");

CREATE INDEX "BalanceSnapshot_date_idx" ON "BalanceSnapshot"("date");

CREATE INDEX "Insight_type_period_idx" ON "Insight"("type", "period");

CREATE INDEX "SyncLog_connectorType_finishedAt_idx" ON "SyncLog"("connectorType", "finishedAt");
