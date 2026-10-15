import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import type { NetWorthGrowthPayload } from '../../types/contracts';
import type { ParsedStatement } from '../connectors/pdf/statement';
import { planStatementImport, writeStatementImport } from './statementImport';

/**
 * Its own database: net worth is only drawn when EVERY account is known, so
 * the other import tests' accounts would hide what this one is about.
 */
const utc = (m: number, d: number) => new Date(Date.UTC(2025, m - 1, d, 12));

let dir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ducat-statement-insights-'));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const conn = await new PrismaBetterSqlite3({ url }).connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('the insights an import regenerates', () => {
  // The import regenerates insights inside its sync. An investment account it
  // creates is known to net worth only through its statement snapshots, so
  // they must be stored BEFORE that, or every month comes out unknown.
  it('see the statement snapshots the import writes', async () => {
    const statement: ParsedStatement = {
      layout: 'test',
      institution: 'Example Brokerage',
      accountType: 'INVESTMENT',
      accountLast4: '0009',
      periodStart: utc(1, 1),
      periodEnd: utc(1, 31),
      openingBalance: 0,
      closingBalance: 2716.43,
      rows: [{ date: utc(1, 14), description: 'EFT FUNDS RECEIVED', amount: 2716.43 }],
      checks: [],
    };
    const plan = await planStatementImport(
      prisma,
      [{ fileName: 'report.pdf', fileSha256: 'f9'.padEnd(64, '0'), statement }],
      { windowDays: 4, createAccount: { last4: '0009' } },
    );
    await writeStatementImport(prisma, plan);

    const row = await prisma.insight.findFirst({ where: { type: 'NET_WORTH_GROWTH', period: '2025-01' } });
    expect((row?.payload as unknown as NetWorthGrowthPayload | undefined)?.netWorth).toBe(2716.43);
  });
});
