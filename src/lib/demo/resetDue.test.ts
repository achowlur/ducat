import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TABLES } from '../../../scripts/copyDatabase';
import { PrismaClient } from '../../generated/prisma/client';
import { reseedDemo } from './reseed';
import {
  DEMO_MAX_AGE_DAYS,
  demoDigest,
  demoResetDue,
  digestTables,
  recordDemoReset,
  resetDueUnseen,
  type DemoResetRecord,
} from './resetDue';

const record = (at: string, release: string | null = 'abc123'): DemoResetRecord => ({
  at: new Date(at),
  digest: '0123456789abcdef',
  release,
});

describe('resetDueUnseen', () => {
  it('reseeds with no record, on a new release, in a new month, and once the data is two UTC days old', () => {
    const now = new Date('2026-03-16T23:20:00Z');
    expect(resetDueUnseen(null, now, 'abc123')).toBe('no earlier reset is recorded');
    expect(resetDueUnseen(record('2026-03-16T01:00:00Z', 'old999'), now, 'abc123')).toBe('a new release is serving the demo');
    expect(resetDueUnseen(record('2026-02-28T23:40:00Z'), new Date('2026-03-01T23:10:00Z'), 'abc123')).toBe('a new month began');
    expect(resetDueUnseen(record('2026-03-14T23:59:00Z'), now, 'abc123')).toBe('the data was 2 days old');
  });

  it('leaves a reset from the day before to the digest', () => {
    // 23:59 one night to 23:00 the next is under 24 hours, and still one UTC day.
    expect(resetDueUnseen(record('2026-03-15T23:59:00Z'), new Date('2026-03-16T23:00:00Z'), 'abc123')).toBeNull();
    expect(resetDueUnseen(record('2026-03-15T23:59:00Z', null), new Date('2026-03-16T23:00:00Z'), null)).toBeNull();
  });

  it('keeps the oldest data a visitor can see under the overdue-sync warning', () => {
    // Providers warns past 3 days; the cron fires once a UTC day.
    expect(DEMO_MAX_AGE_DAYS).toBe(2);
  });
});

describe('the digest', () => {
  it('covers every table the backup copies, in its order', () => {
    expect(digestTables()).toEqual(TABLES);
  });
});

describe('demoResetDue', () => {
  let dir: string;
  let prisma: PrismaClient;
  const SEEDED = new Date('2026-03-15T23:20:00Z');
  const NEXT_NIGHT = new Date('2026-03-16T23:20:00Z');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-reset-due-test-'));
    const url = `file:${join(dir, 'demo.db').replace(/\\/g, '/')}`;
    const conn = await new PrismaBetterSqlite3({ url }).connect();
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    for (const name of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      await conn.executeScript(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
    }
    await conn.dispose();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc123');
    await reseedDemo(prisma, SEEDED);
    await recordDemoReset(prisma, SEEDED);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an untouched demo alone, even after a visitor signs in', async () => {
    // The login's one-use code floor is auth state, not a change to the data.
    await prisma.setting.upsert({
      where: { key: 'auth.totpLastCounter' },
      update: { value: '99' },
      create: { key: 'auth.totpLastCounter', value: '99' },
    });
    expect(await demoResetDue(prisma, NEXT_NIGHT)).toEqual({
      due: false,
      reason: 'unchanged since the reset of 2026-03-15',
    });
  });

  it('reseeds once a visitor has changed anything', async () => {
    const before = await demoDigest(prisma);
    const txn = await prisma.transaction.findFirstOrThrow({ orderBy: { id: 'asc' } });
    await prisma.transaction.update({ where: { id: txn.id }, data: { groupLabel: 'A visitor was here' } });
    expect(await demoDigest(prisma)).not.toBe(before);
    expect(await demoResetDue(prisma, NEXT_NIGHT)).toEqual({ due: true, reason: 'visitors changed the data' });
  });
});
