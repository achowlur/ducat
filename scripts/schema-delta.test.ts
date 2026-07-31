import { describe, expect, it } from 'vitest';
import {
  columnDifference,
  diffSchema,
  isInternalTable,
  parseSchemaSql,
  statementsOf,
  whyCannotAdd,
  type Delta,
} from './schema-delta';

/** The real thing, trimmed to three tables: what `prisma migrate diff
 * --from-empty --to-schema prisma/schema.prisma --script` emits, and — verified
 * against the local database — the text SQLite keeps in sqlite_master. */
const SCHEMA = `
-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "balance" DECIMAL NOT NULL,
    "isStale" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "balance" DECIMAL NOT NULL,
    CONSTRAINT "BalanceSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "BalanceSnapshot_accountId_date_key" ON "BalanceSnapshot"("accountId", "date");
`;

const delta = (desired: string, actual: string): Delta =>
  diffSchema(parseSchemaSql(desired), parseSchemaSql(actual));

const summaries = (items: { summary: string }[]): string => items.map((i) => i.summary).join('\n');

describe('parseSchemaSql', () => {
  const parsed = parseSchemaSql(SCHEMA);

  it('reads tables, columns and indexes out of Prisma DDL', () => {
    expect(parsed.tables.map((t) => t.name)).toEqual(['Account', 'BalanceSnapshot', 'Setting']);
    expect(parsed.tables[0].columns.map((c) => c.name)).toEqual([
      'id',
      'externalId',
      'balance',
      'isStale',
      'createdAt',
    ]);
    expect(parsed.indexes).toHaveLength(1);
    expect(parsed.indexes[0]).toMatchObject({
      name: 'BalanceSnapshot_accountId_date_key',
      table: 'BalanceSnapshot',
      unique: true,
      columns: '"accountId", "date"',
    });
  });

  it('reads a column\'s constraints, not just its name', () => {
    const [id, , balance, , createdAt] = parsed.tables[0].columns;
    expect(id).toMatchObject({ type: 'TEXT', notNull: true, primaryKey: true, defaultExpr: null });
    expect(balance).toMatchObject({ type: 'DECIMAL', notNull: true, primaryKey: false });
    expect(createdAt).toMatchObject({ type: 'DATETIME', notNull: true, defaultExpr: 'CURRENT_TIMESTAMP' });
  });

  it('keeps a table constraint out of the column list', () => {
    const snapshot = parsed.tables[1];
    expect(snapshot.columns.map((c) => c.name)).toEqual(['id', 'accountId', 'date', 'balance']);
    expect(snapshot.constraints).toHaveLength(1);
    expect(snapshot.constraints[0]).toContain('FOREIGN KEY ("accountId")');
  });

  // A comma inside CHECK(…) is not an item separator, a comma inside a string
  // literal is not either, and a column may legitimately be called "unique".
  it('is not fooled by commas in expressions or by keywords used as names', () => {
    const [table] = parseSchemaSql(`CREATE TABLE "T" (
      "unique" TEXT NOT NULL DEFAULT 'a, b',
      "n" INTEGER CHECK ("n" BETWEEN 1 AND 10),
      CHECK ("n" <> 5)
    )`).tables;
    expect(table.columns.map((c) => c.name)).toEqual(['unique', 'n']);
    expect(table.columns[0].defaultExpr).toBe("'a, b'");
    expect(table.columns[0].unique).toBe(false);
    expect(table.constraints).toEqual(['CHECK ("n" <> 5)']);
  });

  it('reads DDL SQLite has rewritten, which is how an added column comes back', () => {
    // sqlite_master keeps the original text with ADD COLUMN's clause appended,
    // unquoted and lower-cased exactly as it was typed.
    const [table] = parseSchemaSql(`CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
, note text default null)`).tables;
    expect(table.columns.map((c) => c.name)).toEqual(['key', 'value', 'note']);
    expect(table.columns[2]).toMatchObject({ type: 'TEXT', notNull: false, defaultExpr: 'null' });
  });

  it('ignores statements that are not CREATE TABLE or CREATE INDEX', () => {
    const parsedOther = parseSchemaSql(
      `CREATE VIEW v AS SELECT 1; CREATE TRIGGER t AFTER INSERT ON "Setting" BEGIN SELECT 1; END; CREATE TABLE "Setting" ("key" TEXT);`,
    );
    expect(parsedOther.tables.map((t) => t.name)).toEqual(['Setting']);
  });
});

describe('an unchanged schema', () => {
  it('has no delta against itself', () => {
    expect(delta(SCHEMA, SCHEMA)).toEqual({ changes: [], refusals: [], notices: [] });
  });

  it('ignores _prisma_migrations, which one database has and the other never will', () => {
    const withMigrations = `${SCHEMA}
CREATE TABLE "_prisma_migrations" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL);`;
    expect(delta(SCHEMA, withMigrations)).toEqual({ changes: [], refusals: [], notices: [] });
    expect(isInternalTable('_prisma_migrations')).toBe(true);
    expect(isInternalTable('Transaction')).toBe(false);
  });
});

describe('what it will apply', () => {
  it('creates a missing table, guarded by IF NOT EXISTS', () => {
    const actual = SCHEMA.replace(/CREATE TABLE "Setting"[^;]+;/, '');
    const result = delta(SCHEMA, actual);
    expect(result.refusals).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe('create table');
    expect(result.changes[0].statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "Setting" \(/);
  });

  it('adds a nullable column', () => {
    const desired = SCHEMA.replace('"value" TEXT NOT NULL', '"value" TEXT NOT NULL,\n    "note" TEXT');
    const result = delta(desired, SCHEMA);
    expect(result.refusals).toEqual([]);
    expect(result.changes[0].statements).toEqual(['ALTER TABLE "Setting" ADD COLUMN "note" TEXT']);
  });

  it('adds a NOT NULL column when it carries a constant default', () => {
    const desired = SCHEMA.replace(
      '"value" TEXT NOT NULL',
      '"value" TEXT NOT NULL,\n    "enabled" BOOLEAN NOT NULL DEFAULT true',
    );
    const result = delta(desired, SCHEMA);
    expect(result.refusals).toEqual([]);
    expect(result.changes[0].statements).toEqual([
      'ALTER TABLE "Setting" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true',
    ]);
  });

  it('creates a missing index, guarded by IF NOT EXISTS', () => {
    const actual = SCHEMA.replace(/CREATE UNIQUE INDEX[^;]+;/, '');
    const result = delta(SCHEMA, actual);
    expect(result.refusals).toEqual([]);
    expect(result.changes[0].statements[0]).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "BalanceSnapshot_accountId_date_key" ON "BalanceSnapshot"("accountId", "date")',
    );
    // A unique index over rows that already hold a duplicate fails; the caller
    // prints this only when the table turns out to have rows.
    expect(result.changes[0].cautionIfRows).toContain('UNIQUE index fails');
  });

  it('replaces an index whose columns changed, since an index holds no data', () => {
    const actual = SCHEMA.replace('("accountId", "date")', '("accountId")');
    const result = delta(SCHEMA, actual);
    expect(result.refusals).toEqual([]);
    expect(result.changes[0].kind).toBe('replace index');
    expect(result.changes[0].statements).toEqual([
      'DROP INDEX IF EXISTS "BalanceSnapshot_accountId_date_key"',
      'CREATE UNIQUE INDEX IF NOT EXISTS "BalanceSnapshot_accountId_date_key" ON "BalanceSnapshot"("accountId", "date")',
    ]);
  });

  it('orders statements tables → columns → indexes, so a new index can land on a new table', () => {
    const desired = `${SCHEMA}
CREATE TABLE "Goal" ("id" TEXT NOT NULL PRIMARY KEY, "target" DECIMAL NOT NULL);
CREATE INDEX "Goal_target_idx" ON "Goal"("target");`;
    const withColumn = desired.replace('"value" TEXT NOT NULL', '"value" TEXT NOT NULL,\n    "note" TEXT');
    const kinds = statementsOf(delta(withColumn, SCHEMA)).map((s) => s.split(' ').slice(0, 3).join(' '));
    expect(kinds).toEqual(['CREATE TABLE IF', 'ALTER TABLE "Setting"', 'CREATE INDEX IF']);
  });
});

describe('what it refuses', () => {
  it('refuses a dropped column, and says what it would cost', () => {
    const desired = SCHEMA.replace('    "isStale" BOOLEAN NOT NULL,\n', '');
    const result = delta(desired, SCHEMA);
    expect(result.changes).toEqual([]);
    expect(summaries(result.refusals)).toContain('Account.isStale — in the database, not in the schema');
    expect(result.refusals[0].reason).toContain('destroys its values');
  });

  it('refuses a changed type, a changed nullability and a changed default', () => {
    expect(columnDifference(
      { name: 'a', type: 'INTEGER', notNull: true, primaryKey: false, unique: false, references: false, defaultExpr: null, sql: '' },
      { name: 'a', type: 'TEXT', notNull: true, primaryKey: false, unique: false, references: false, defaultExpr: null, sql: '' },
    )).toBe('type TEXT → INTEGER');

    const nullable = SCHEMA.replace('"externalId" TEXT NOT NULL', '"externalId" TEXT');
    expect(summaries(delta(SCHEMA, nullable).refusals)).toContain('Account.externalId — nullable → NOT NULL');
    expect(summaries(delta(nullable, SCHEMA).refusals)).toContain('Account.externalId — NOT NULL → nullable');

    const defaulted = SCHEMA.replace('"externalId" TEXT NOT NULL', `"externalId" TEXT NOT NULL DEFAULT 'x'`);
    expect(summaries(delta(SCHEMA, defaulted).refusals)).toContain("default 'x' → (none)");
  });

  // Every line here was measured against libSQL 3.45.1 before it was written
  // down (scripts/…/probe3.ts in the session that added this): the published
  // rules describe all five as unconditional, and three of them are not.
  it('refuses a column SQLite itself would reject, which depends on the rows', () => {
    const column = {
      name: 'c',
      type: 'TEXT',
      notNull: true,
      primaryKey: false,
      unique: false,
      references: false,
      defaultExpr: null,
      sql: '',
    };
    const populated = 12;

    // Rejected however many rows there are.
    expect(whyCannotAdd({ ...column, notNull: false, unique: true }, 0)).toContain('UNIQUE');
    expect(whyCannotAdd({ ...column, notNull: false, primaryKey: true }, 0)).toContain('PRIMARY KEY');

    // Rejected only once the table holds rows.
    expect(whyCannotAdd(column, populated)).toContain('NOT NULL column with no DEFAULT');
    expect(whyCannotAdd({ ...column, defaultExpr: 'CURRENT_TIMESTAMP' }, populated)).toContain('evaluated per row');
    expect(whyCannotAdd({ ...column, defaultExpr: '(1 + 1)' }, populated)).toContain('evaluated per row');
    expect(whyCannotAdd({ ...column, notNull: false, references: true, defaultExpr: "'x'" }, populated)).toContain(
      'REFERENCES',
    );
    expect(whyCannotAdd(column, 0)).toBeNull();
    expect(whyCannotAdd({ ...column, defaultExpr: 'CURRENT_TIMESTAMP' }, 0)).toBeNull();

    // Allowed either way.
    expect(whyCannotAdd({ ...column, defaultExpr: "'x'" }, populated)).toBeNull();
    expect(whyCannotAdd({ ...column, notNull: false, references: true, defaultExpr: null }, populated)).toBeNull();

    // An unknown count is read as "has rows", so forgetting to pass one is
    // over-strict rather than over-permissive.
    expect(whyCannotAdd(column, undefined)).toContain('may hold rows');
  });

  // The @default(now()) case, which is the one a real schema change hits: it
  // reads as an ordinary added column, and whether SQLite will have it turns
  // entirely on whether that table is empty in THIS database.
  it('refuses an added createdAt on a populated table and allows it on an empty one', () => {
    const desired = SCHEMA.replace(
      '"value" TEXT NOT NULL',
      '"value" TEXT NOT NULL,\n    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
    );
    const parsedDesired = parseSchemaSql(desired);
    const parsedActual = parseSchemaSql(SCHEMA);

    const populated = diffSchema(parsedDesired, parsedActual, new Map([['Setting', 4]]));
    expect(populated.changes).toEqual([]);
    expect(populated.refusals[0].reason).toContain('holds 4 rows');

    const empty = diffSchema(parsedDesired, parsedActual, new Map([['Setting', 0]]));
    expect(empty.refusals).toEqual([]);
    expect(empty.changes[0].statements).toEqual([
      'ALTER TABLE "Setting" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]);
  });

  it('refuses an added relation, because a foreign key is a table constraint', () => {
    const desired = SCHEMA.replace(
      '    "value" TEXT NOT NULL\n',
      '    "value" TEXT NOT NULL,\n    "accountId" TEXT,\n    CONSTRAINT "Setting_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE\n',
    );
    const result = delta(desired, SCHEMA);
    expect(summaries(result.refusals)).toContain('Setting — the schema declares a table constraint');
    expect(result.refusals[0].reason).toContain('rebuilt');
    // The column half is additive on its own, but one refusal blocks the run,
    // so it must not be presented as something that will happen.
    expect(result.changes.map((c) => c.summary)).toEqual(['Setting.accountId  TEXT']);
  });

  it('refuses a dropped table', () => {
    const desired = SCHEMA.replace(/CREATE TABLE "Setting"[^;]+;/, '');
    const result = delta(desired, SCHEMA);
    expect(summaries(result.refusals)).toContain('Setting — table is in the database and not in the schema');
    expect(result.refusals[0].reason).toContain('destroys every row');
  });

  it('refuses a table rename in both directions, naming it as a rename', () => {
    const desired = SCHEMA.replace(/"Setting"/g, '"Preference"');
    const result = delta(desired, SCHEMA);
    // The new table is still offered — but the old one's refusal blocks the run
    // and says why, because nothing here can tell a rename from a drop-and-add.
    expect(result.changes.map((c) => c.kind)).toEqual(['create table']);
    expect(result.refusals[0].reason).toContain('renamed to Preference');
  });

  it('refuses a column rename rather than adding one and stranding the other', () => {
    const desired = SCHEMA.replace('"externalId" TEXT NOT NULL', '"feedId" TEXT NOT NULL');
    const result = delta(desired, SCHEMA);
    expect(result.changes).toEqual([]);
    expect(result.refusals[0].reason).toContain('may be a RENAME');
    expect(result.refusals[0].reason).toContain('leave the old values behind');
  });

  it('refuses a changed table option', () => {
    const actual = SCHEMA.replace('    "value" TEXT NOT NULL\n)', '    "value" TEXT NOT NULL\n) WITHOUT ROWID');
    expect(summaries(delta(SCHEMA, actual).refusals)).toContain('table options WITHOUT ROWID → (none)');
  });
});

describe('what it leaves alone', () => {
  it('reports an extra index without dropping it', () => {
    const actual = `${SCHEMA}\nCREATE INDEX "Account_externalId_idx" ON "Account"("externalId");`;
    const result = delta(SCHEMA, actual);
    expect(result.changes).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(result.notices[0].summary).toContain('Account_externalId_idx on Account("externalId")');
    expect(result.notices[0].reason).toContain('may be one you added on purpose');
  });

  it('warns that an extra UNIQUE index still enforces what the schema dropped', () => {
    const actual = `${SCHEMA}\nCREATE UNIQUE INDEX "Account_externalId_key" ON "Account"("externalId");`;
    expect(delta(SCHEMA, actual).notices[0].reason).toContain('will fail');
  });

  it('does not report indexes belonging to a table it has already refused', () => {
    const desired = SCHEMA.replace(/CREATE TABLE "BalanceSnapshot"[^;]+;/, '').replace(/CREATE UNIQUE INDEX[^;]+;/, '');
    const result = delta(desired, SCHEMA);
    expect(result.notices).toEqual([]);
    expect(result.refusals).toHaveLength(1);
  });
});
