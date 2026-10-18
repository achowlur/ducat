import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { countedPartway, paceShareOf, readUsage, TURSO_FREE, usageLines, type UsageReading } from './limits';
import { flushUsage, recordUsage, resetUsageMeter } from './meter';

const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  month: '2026-03',
  monthly: {},
  simplefinToday: 0,
  simplefinBusiestDay: 0,
  countedSince: null,
  ...over,
});

describe('paceShareOf', () => {
  it('projects the month-to-date rate to the month end', () => {
    // March 1-11 is a third of the month: 100M read projects to ~300M.
    const now = new Date('2026-03-11T08:00:00Z');
    expect(paceShareOf(100_000_000, 500_000_000, reading(), now)).toBeCloseTo(0.6, 2);
  });

  it('projects from when counting began, so a month counted partway is not called quiet', () => {
    const now = new Date('2026-03-21T00:00:00Z');
    const since = new Date('2026-03-11T00:00:00Z');
    // 10 days counted, 11 to go: 50M becomes 105M, not the 77.5M a whole-month rate says.
    expect(paceShareOf(50_000_000, 100_000_000, reading({ countedSince: since }), now)).toBeCloseTo(1.05, 2);
  });

  it('refuses under a day of counting', () => {
    expect(paceShareOf(5, 100, reading(), new Date('2026-03-01T20:00:00Z'))).toBeNull();
  });
});

describe('usageLines', () => {
  const now = new Date('2026-03-16T00:00:00Z');

  it('warns at 80% used, or when the pace passes the limit', () => {
    const lines = usageLines(
      reading({ monthly: { 'turso.rowsRead': 300_000_000, 'turso.rowsWritten': 8_000_000, 'app.requests': 10 } }),
      now,
    );
    const byLabel = Object.fromEntries(lines.map((l) => [`${l.service} ${l.label}`, l]));
    expect(byLabel['Turso rows read'].share).toBeCloseTo(0.6);
    expect(byLabel['Turso rows read'].warn).toBe(true); // on pace for ~120%
    expect(byLabel['Turso rows written'].warn).toBe(true); // 80% used
    expect(byLabel['Vercel requests served'].warn).toBe(false);
  });

  it('warns on SimpleFIN when any day this month came near 24', () => {
    const [simplefin] = usageLines(reading({ simplefinToday: 1, simplefinBusiestDay: 20 }), now).filter(
      (l) => l.service === 'SimpleFIN',
    );
    expect(simplefin.used).toBe(1);
    expect(simplefin.warn).toBe(true);
  });

  it('survives a month with nothing counted', () => {
    const lines = usageLines(reading(), now);
    expect(lines.every((l) => l.used === 0 && !l.warn)).toBe(true);
  });
});

describe('countedPartway', () => {
  it('is true only when counting began after the month did', () => {
    expect(countedPartway(reading({ countedSince: new Date('2026-03-01T00:20:00Z') }))).toBe(false);
    expect(countedPartway(reading({ countedSince: new Date('2026-03-09T14:00:00Z') }))).toBe(true);
    expect(countedPartway(reading())).toBe(false);
  });
});

describe('readUsage', () => {
  let dir: string;
  let prisma: PrismaClient;
  let bare: PrismaClient;

  const open = async (name: string, withUsageTable: boolean) => {
    const url = `file:${join(dir, name).replace(/\\/g, '/')}`;
    const conn = await new PrismaBetterSqlite3({ url }).connect();
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    for (const m of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      if (!withUsageTable && m.endsWith('_add_usage_count')) continue;
      await conn.executeScript(readFileSync(join(migrations, m, 'migration.sql'), 'utf8'));
    }
    await conn.dispose();
    return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-usage-test-'));
    prisma = await open('usage.db', true);
    bare = await open('behind.db', false);
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await bare.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads back what two flushes wrote, adding rather than replacing', async () => {
    resetUsageMeter();
    const run = (sql: string, args: (string | number)[]) => prisma.$executeRawUnsafe(sql, ...args);
    const day1 = new Date('2026-03-09T14:00:00Z');
    const day2 = new Date('2026-03-10T09:00:00Z');
    recordUsage('turso.rowsRead', 4_000, day1);
    recordUsage('simplefin.requests', 3, day1);
    await flushUsage(run, day1);
    recordUsage('turso.rowsRead', 1_000, day2);
    recordUsage('simplefin.requests', 1, day2);
    await flushUsage(run, day2);
    resetUsageMeter();

    const got = await readUsage(prisma, day2);
    expect(got).toEqual({
      month: '2026-03',
      monthly: { 'turso.rowsRead': 5_000, 'meter.since': Math.floor(day1.getTime() / 1000) },
      simplefinToday: 1,
      simplefinBusiestDay: 3,
      countedSince: new Date(Math.floor(day1.getTime() / 1000) * 1000),
    });
    expect(TURSO_FREE.rowsRead).toBe(500_000_000);
  });

  it('keeps the EARLIEST start when a later process marks its own', async () => {
    resetUsageMeter();
    const run = (sql: string, args: (string | number)[]) => prisma.$executeRawUnsafe(sql, ...args);
    const later = new Date('2026-03-12T10:00:00Z');
    recordUsage('app.requests', 1, later);
    await flushUsage(run, later);
    resetUsageMeter();
    expect((await readUsage(prisma, later))?.countedSince).toEqual(new Date('2026-03-09T14:00:00Z'));
  });

  it('returns null on a database one schema push behind, instead of failing the page', async () => {
    expect(await readUsage(bare, new Date('2026-03-10T09:00:00Z'))).toBeNull();
  });
});
