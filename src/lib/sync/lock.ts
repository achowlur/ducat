import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * One sync at a time, across every server instance.
 *
 * The nightly cron and a tap on "Sync now" can overlap: the feed takes seconds
 * to answer, so both runs are waiting on it at once and neither has inserted
 * when the other checks what is stored. Measured on a test database: with the
 * account already known, the second insert fails on the (accountId,
 * externalId) unique; on a first sync, both runs CREATE the account, and the
 * same real account is stored twice with every row in each.
 *
 * The lock is a Setting row, claimed by compare-and-set the way the TOTP
 * replay floor is (app/login/actions.ts): create it, or replace it only from
 * the exact value read. Its value carries an expiry, because a run the host
 * kills at maxDuration never reaches its release, and a lock that outlived it
 * would refuse every sync after.
 */
export const SYNC_LOCK_KEY = 'sync.running';

/**
 * How long a claim stands without its owner. The hosted functions stop at
 * 60s; this leaves a slow local import (import:csv, import:pdf) room to finish
 * without a second run taking the lock from under it.
 */
export const SYNC_LOCK_TTL_MS = 5 * 60_000;

export class SyncAlreadyRunningError extends Error {
  /** When the running claim lapses, if its owner never lets go. */
  readonly expiresAt: Date;
  constructor(expiresAt: Date) {
    super('A sync is already running.');
    this.name = 'SyncAlreadyRunningError';
    this.expiresAt = expiresAt;
  }
}

function expiryOf(value: string): Date {
  const at = new Date(value.slice(0, value.indexOf('|')));
  // An unreadable value is treated as lapsed: refusing forever on a row
  // nothing can parse would be the stuck lock this exists to prevent.
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}

/** Claims the lock or throws SyncAlreadyRunningError. Returns the claim to release. */
export async function claimSyncLock(prisma: PrismaClient, now: Date = new Date()): Promise<string> {
  const claim = `${new Date(now.getTime() + SYNC_LOCK_TTL_MS).toISOString()}|${randomUUID()}`;
  const held = await prisma.setting.findUnique({ where: { key: SYNC_LOCK_KEY } });
  if (held === null) {
    try {
      await prisma.setting.create({ data: { key: SYNC_LOCK_KEY, value: claim } });
      return claim;
    } catch {
      // Unique-key loss: another run created the row between our read and write.
      const winner = await prisma.setting.findUnique({ where: { key: SYNC_LOCK_KEY } });
      throw new SyncAlreadyRunningError(winner === null ? new Date(now.getTime() + SYNC_LOCK_TTL_MS) : expiryOf(winner.value));
    }
  }
  const expiresAt = expiryOf(held.value);
  if (expiresAt > now) throw new SyncAlreadyRunningError(expiresAt);
  // Lapsed: take it over, but only from the value just read, so two runs
  // finding the same stale claim cannot both win it.
  const taken = await prisma.setting.updateMany({
    where: { key: SYNC_LOCK_KEY, value: held.value },
    data: { value: claim },
  });
  if (taken.count !== 1) throw new SyncAlreadyRunningError(new Date(now.getTime() + SYNC_LOCK_TTL_MS));
  return claim;
}

/** Lets go of this run's claim, and never of one another run has since taken over. */
export async function releaseSyncLock(prisma: PrismaClient, claim: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SYNC_LOCK_KEY, value: claim } });
}
