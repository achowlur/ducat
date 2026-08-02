-- Trip/project grouping: a nullable tag on Transaction. Nullable with no
-- default so a populated table (local and cloud both hold rows) can take it
-- as a plain additive ADD COLUMN.
ALTER TABLE "Transaction" ADD COLUMN "groupLabel" TEXT;
