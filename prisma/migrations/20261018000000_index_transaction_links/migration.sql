-- Indexes on Transaction's foreign-key CHILD columns. Deleting a transaction
-- (or a category) makes SQLite look for rows still pointing at it; without an
-- index each look scans the whole table, so deleting every row scanned it once
-- per row: the demo's nightly reset read ~100 million rows to delete 7,097.
-- Additive only: plain CREATE INDEX on existing nullable columns.
CREATE INDEX "Transaction_transferPairId_idx" ON "Transaction"("transferPairId");

CREATE INDEX "Transaction_reimbursesId_idx" ON "Transaction"("reimbursesId");

CREATE INDEX "Transaction_categoryId_idx" ON "Transaction"("categoryId");

-- The other foreign-key child columns, on smaller tables, for the same reason.
CREATE INDEX "ImportBatch_accountId_idx" ON "ImportBatch"("accountId");

CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

CREATE INDEX "Rule_setCategoryId_idx" ON "Rule"("setCategoryId");
