import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { fingerprintOf } from './fingerprintDatabase';

/**
 * The overall digest of the fixture below, PINNED. The serialisation this
 * hashes includes two control-character separators (\x01 between fields,
 * \x02 between rows) that are load-bearing and nearly invisible: extracting
 * the core out of fingerprint-db.ts silently dropped them once, which changed
 * every digest and would have made the scheduled backup's cloud-vs-file
 * comparison FAIL on identical data. If this constant ever changes, the
 * algorithm changed — and every recorded digest (the mirror-proof ones in
 * DEPLOY.md's procedure, the backup.lastRun Settings) becomes incomparable
 * with new output. Do not update the constant without meaning exactly that.
 */
const PINNED_OVERALL = '1f1dd7c8d37afed0';

const SCHEMA = `
  create table "Account" (id text primary key, name text, balance real);
  create table "Category" (id text primary key, name text);
  create table "Setting" ("key" text primary key, "value" text);
  create table "SyncLog" (id text primary key);
  create table "TrackedSubscription" (id text primary key);
  create table "Insight" (id text primary key, dismissed integer);
  create table "Rule" (id text primary key);
  create table "BalanceSnapshot" (id text primary key);
  create table "Transaction" (id text primary key, amount real, date text);
`;

async function fixture(rowSql: string[]): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await db.executeMultiple(SCHEMA + rowSql.join(';\n'));
  return db;
}

const ROWS = [
  `insert into "Account" values ('a1','Checking',1200.5),('a2','Card',-350)`,
  `insert into "Category" values ('c1','Dining')`,
  `insert into "Setting" values ('backup.lastRun','{"at":"2026-08-04T23:52:00.000Z"}')`,
  `insert into "Insight" values ('i1',1)`,
  `insert into "Transaction" values ('t1',-42.13,'2026-08-01'),('t2',5,'2026-08-02')`,
];

describe('fingerprintOf', () => {
  it('matches the pinned digest — the serialisation bytes are frozen', async () => {
    const db = await fixture(ROWS);
    const fp = await fingerprintOf(db);
    expect(fp.overall).toBe(PINNED_OVERALL);
    expect(fp.tables['Transaction'].rows).toBe(2);
  });

  it('is independent of physical insert order', async () => {
    const reversed = await fixture([
      `insert into "Transaction" values ('t2',5,'2026-08-02'),('t1',-42.13,'2026-08-01')`,
      `insert into "Insight" values ('i1',1)`,
      `insert into "Setting" values ('backup.lastRun','{"at":"2026-08-04T23:52:00.000Z"}')`,
      `insert into "Category" values ('c1','Dining')`,
      `insert into "Account" values ('a2','Card',-350),('a1','Checking',1200.5)`,
    ]);
    expect((await fingerprintOf(reversed)).overall).toBe(PINNED_OVERALL);
  });

  it('one changed field changes that table digest and the overall — what row counts are blind to', async () => {
    const edited = await fixture([...ROWS.slice(0, 3), `insert into "Insight" values ('i1',0)`, ROWS[4]]);
    const base = await fingerprintOf(await fixture(ROWS));
    const fp = await fingerprintOf(edited);
    expect(fp.tables['Insight'].rows).toBe(base.tables['Insight'].rows);
    expect(fp.tables['Insight'].digest).not.toBe(base.tables['Insight'].digest);
    expect(fp.overall).not.toBe(base.overall);
    expect(fp.tables['Transaction'].digest).toBe(base.tables['Transaction'].digest);
  });
});
