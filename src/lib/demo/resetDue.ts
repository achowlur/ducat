import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';
import { DEFAULT_HEALTH_OPTIONS } from '../health/health';

/**
 * Whether tonight's demo cron has to reseed, or may leave the demo alone.
 *
 * A reseed rewrites every row, about 8,000 rows written and a few hundred
 * thousand read, and an untouched demo gains nothing from one but fresher
 * dates. So it reseeds only when:
 *   - a visitor CHANGED something since the last reseed (the data's content
 *     digest moved), which is what the reset exists to undo; or
 *   - the data is about to look stale: Providers calls a sync overdue after
 *     syncOverdueDays, and a demo whose newest "sync" is the last reseed would
 *     show that warning to every visitor. Reseeding once the last one is two
 *     UTC days old keeps the oldest a visitor can see under three; or
 *   - a new month began, so the month being lived in is never empty; or
 *   - a new release is serving it, whose demo data may differ (and the cron
 *     run by hand after a deploy is how the demo is refreshed on purpose).
 *
 * The check reads every data row once (the digest), a small fraction of what
 * the reseed it saves would spend.
 */

export const DEMO_RESET_KEY = 'demo.lastReset';

/** Reseed once the last reseed is this many UTC days old, even untouched. */
export const DEMO_MAX_AGE_DAYS = DEFAULT_HEALTH_OPTIONS.syncOverdueDays - 1;

/**
 * Every table a visitor can change, in copyDatabase.ts's TABLES order (a test
 * holds them equal). Settings the reset itself does not own are left out:
 * the login's one-use code floor (`auth.`), and this record (`demo.`).
 */
const DIGEST_TABLES = [
  'Account',
  'Category',
  'Setting',
  'SyncLog',
  'TrackedSubscription',
  'Insight',
  'Rule',
  'BalanceSnapshot',
  'ImportBatch',
  'Transaction',
] as const;

export function digestTables(): readonly string[] {
  return DIGEST_TABLES;
}

export interface DemoResetRecord {
  at: Date;
  digest: string;
  /** The commit the reseeding deployment was built from, when known. */
  release: string | null;
}

/** The commit this deployment was built from; null off Vercel. */
export function currentRelease(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? '';
  return sha === '' ? null : sha;
}

export interface DemoResetDecision {
  due: boolean;
  reason: string;
}

function utcDayNumber(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000);
}

/** The reason a reseed is due without reading the data, or null. */
export function resetDueUnseen(record: DemoResetRecord | null, now: Date, release: string | null): string | null {
  if (record === null) return 'no earlier reset is recorded';
  if (release !== null && record.release !== release) return 'a new release is serving the demo';
  if (record.at.toISOString().slice(0, 7) !== now.toISOString().slice(0, 7)) return 'a new month began';
  const days = utcDayNumber(now) - utcDayNumber(record.at);
  if (days >= DEMO_MAX_AGE_DAYS) return `the data was ${days} days old`;
  return null;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `n:${v.toString()}`;
    if (v instanceof Uint8Array) return `b:${Buffer.from(v).toString('hex')}`;
    return v;
  });
}

/** One digest over every row a visitor can change; row order cannot matter. */
export async function demoDigest(prisma: PrismaClient): Promise<string> {
  const hash = createHash('sha256');
  for (const table of DIGEST_TABLES) {
    const sql =
      table === 'Setting'
        ? `select * from "Setting" where "key" not like 'auth.%' and "key" not like 'demo.%'`
        : `select * from "${table}"`;
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql);
    const lines = rows.map(canonical).sort();
    hash.update(`${table}\x02${lines.join('\x01')}\x02`);
  }
  return hash.digest('hex').slice(0, 16);
}

export async function readDemoReset(prisma: PrismaClient): Promise<DemoResetRecord | null> {
  const row = await prisma.setting.findUnique({ where: { key: DEMO_RESET_KEY } });
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.value) as { at?: unknown; digest?: unknown; release?: unknown };
    if (typeof parsed.at !== 'string' || typeof parsed.digest !== 'string') return null;
    const at = new Date(parsed.at);
    const release = typeof parsed.release === 'string' ? parsed.release : null;
    return Number.isNaN(at.getTime()) ? null : { at, digest: parsed.digest, release };
  } catch {
    return null;
  }
}

export async function demoResetDue(prisma: PrismaClient, now: Date): Promise<DemoResetDecision> {
  const record = await readDemoReset(prisma);
  const unseen = resetDueUnseen(record, now, currentRelease());
  if (record === null || unseen !== null) return { due: true, reason: unseen ?? 'no earlier reset is recorded' };
  if ((await demoDigest(prisma)) !== record.digest) return { due: true, reason: 'visitors changed the data' };
  return { due: false, reason: `unchanged since the reset of ${record.at.toISOString().slice(0, 10)}` };
}

/** After a reseed: what the data looks like now, so tomorrow can tell. */
export async function recordDemoReset(prisma: PrismaClient, now: Date): Promise<void> {
  const value = JSON.stringify({ at: now.toISOString(), digest: await demoDigest(prisma), release: currentRelease() });
  await prisma.setting.upsert({ where: { key: DEMO_RESET_KEY }, update: { value }, create: { key: DEMO_RESET_KEY, value } });
}
