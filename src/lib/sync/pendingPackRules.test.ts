import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { installRulePack, PACK_RULES, pendingPackRules } from './rulePack';

let dir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ducat-pending-pack-test-'));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const conn = await new PrismaBetterSqlite3({ url }).connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of migrations) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('pendingPackRules on a fresh install', () => {
  it('reports nothing on a database with nothing in it', async () => {
    expect(await pendingPackRules(prisma)).toBe(0);
  });

  // A first SimpleFIN sync writes accounts and transactions and no category:
  // only the demo seed installed the pack. This said 0 here, so neither
  // Overview's review panel nor `npm run upgrade` ever offered it.
  it('reports the whole pack once a sync has brought transactions but no categories', async () => {
    const account = await prisma.account.create({
      data: {
        externalId: 'test-checking',
        connectorType: 'SIMPLEFIN',
        institution: 'Test Bank',
        name: 'Checking',
        type: 'DEPOSITORY',
        currency: 'USD',
        balance: 1000,
        balanceDate: new Date(Date.UTC(2026, 6, 20, 12)),
        isStale: false,
      },
    });
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        externalId: 'first-sync-1',
        date: new Date(Date.UTC(2026, 6, 10, 12)),
        amount: -42.5,
        description: 'CORNER GROCER',
        normalizedMerchant: 'corner grocer',
        flow: 'OUTFLOW',
        categorySource: 'AGGREGATOR',
        source: 'SIMPLEFIN',
      },
    });
    expect(await pendingPackRules(prisma)).toBe(PACK_RULES.length);
  });

  it('reports nothing once the pack is installed', async () => {
    await installRulePack(prisma);
    expect(await pendingPackRules(prisma)).toBe(0);
  });
});
