-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "priority" INTEGER NOT NULL,
    "matchField" TEXT NOT NULL,
    "matchOperator" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "setCategoryId" TEXT,
    "setFlow" TEXT,
    "enabled" BOOLEAN NOT NULL,
    CONSTRAINT "Rule_setCategoryId_fkey" FOREIGN KEY ("setCategoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Rule" ("enabled", "id", "matchField", "matchOperator", "matchValue", "priority", "setCategoryId", "setFlow") SELECT "enabled", "id", "matchField", "matchOperator", "matchValue", "priority", "setCategoryId", "setFlow" FROM "Rule";
DROP TABLE "Rule";
ALTER TABLE "new_Rule" RENAME TO "Rule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
