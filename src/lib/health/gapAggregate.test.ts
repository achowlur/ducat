import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDatabase, type TempDatabase } from '../demo/tempDatabase';
import { reseedDemo } from '../demo/reseed';
import { DEFAULT_HEALTH_OPTIONS, findGappedAccounts, getProviderHealth } from './health';

/**
 * Overview's health read counts rows per account in the database instead of
 * loading one row per transaction. The signal must be the one the loaded rows
 * give: here the aggregate path (getProviderHealth) is held to the pure
 * function over every row, on the demo's data, with a feed that went quiet.
 */

const NOW = new Date('2026-03-15T12:00:00Z');
let db: TempDatabase;

beforeAll(async () => {
  db = await createTempDatabase('gaps');
  await reseedDemo(db.prisma, NOW);
}, 120_000);

afterAll(async () => {
  await db.dispose();
});

describe('gap detection from aggregates', () => {
  it('flags the accounts the loaded rows flag, with the same figures', async () => {
    const { prisma } = db;
    // Silence one polling account's recent weeks so there is a gap to find.
    const account = await prisma.account.findFirstOrThrow({ where: { type: 'DEPOSITORY', connectorType: 'SIMPLEFIN' } });
    const cutoff = new Date(NOW.getTime() - DEFAULT_HEALTH_OPTIONS.gapWindowDays * 86_400_000);
    await prisma.transaction.updateMany({ where: { accountId: account.id, date: { gte: cutoff } }, data: { date: new Date('2024-01-02T12:00:00Z') } });

    const accounts = await prisma.account.findMany({
      where: { connectorType: 'SIMPLEFIN' },
      select: { id: true, name: true, type: true, balanceDate: true, isStale: true },
    });
    const rows = await prisma.transaction.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) } },
      select: { accountId: true, date: true },
    });
    const expected = findGappedAccounts(accounts, rows, NOW, DEFAULT_HEALTH_OPTIONS);

    // Present, not absent: an empty pair would agree about nothing.
    expect(expected.map((g) => g.accountId)).toContain(account.id);

    const health = await getProviderHealth(prisma, DEFAULT_HEALTH_OPTIONS, NOW);
    const simplefin = health.find((h) => h.connectorType === 'SIMPLEFIN');
    expect(simplefin).toBeDefined();
    expect(simplefin!.gappedAccounts).toEqual(expected);
  }, 60_000);
});
