import type { PrismaClient } from '../../generated/prisma/client';
import { ACCOUNT_NAMES_KEY, HIDDEN_ON_OVERVIEW_KEY, accountNumber } from '../accountDisplay';
import { pollsForBalances } from '../health/health';
import { earliestOfAccount, regenerateSince } from '../insights/scope';
import { claimSyncLock, releaseSyncLock } from './lock';
import { replaceId } from './relink';

/**
 * Combining two accounts that are ONE pot of money under two numbers: a
 * brokerage that moves an account into a managed one opens a new account
 * number and leaves the old one open and empty. Ducat would show two
 * accounts, the old one's history ending where the new one's begins.
 *
 * Unlike a re-link (relink.ts), nothing here is a copy: both accounts are
 * real and their rows are different rows, so every row of the old account
 * moves into the kept one and none is dropped. Balances are a SUM on any day
 * both have one (one pot, two parts), except the old account's run of zero
 * balances at its end: that zero is the money having LEFT for the kept
 * account, which in those days may have no balance of its own on record, and
 * kept it would read the pot as empty. Without them the engine carries the
 * last real balance across the gap, marked estimated, as it does for any
 * investment account with a day missing.
 *
 * The old account's feed id goes on a skip list (IGNORED_FEED_ACCOUNTS_KEY),
 * so a brokerage that keeps listing the empty account does not bring it back
 * at the next sync. Operator-run only (npm run accounts:combine): there is no
 * evidence a page could offer it from, as there is for a reconnect.
 */

/** Setting: { [connectorType]: feed ids } the sync passes over. */
export const IGNORED_FEED_ACCOUNTS_KEY = 'sync.ignoredFeedAccounts';
/** Setting prefix: what one combine changed, by the account kept, for its undo. */
export const COMBINE_UNDO_PREFIX = 'accounts.combineUndo:';

export function parseIgnoredFeedAccounts(raw: string | null): Record<string, string[]> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [type, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[type] = ids.filter((x): x is string => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

/** The feed ids the sync passes over for one connector. */
export async function ignoredFeedAccounts(prisma: PrismaClient, connectorType: string): Promise<Set<string>> {
  const row = await prisma.setting.findUnique({ where: { key: IGNORED_FEED_ACCOUNTS_KEY } });
  return new Set(parseIgnoredFeedAccounts(row?.value ?? null)[connectorType] ?? []);
}

/** An account by id, or by its account number when exactly one account carries it. */
export async function findAccount(prisma: PrismaClient, ref: string) {
  const byId = await prisma.account.findUnique({ where: { id: ref } });
  if (byId !== null) return byId;
  const all = await prisma.account.findMany();
  const byNumber = all.filter((a) => accountNumber(a.name) === ref);
  return byNumber.length === 1 ? byNumber[0] : null;
}

export interface CombinePlan {
  fromId: string;
  intoId: string;
  rowsMoved: number;
  /** The old account's zero balances at its end, dropped (see the header). */
  trailingZerosDropped: number;
  /** Days both accounts have a balance: the kept account's becomes the sum. */
  snapshotsSummed: number;
  snapshotsMoved: number;
  /** Feed ids both accounts hold a row under: a combine would break the dedupe key, so it is refused. */
  clashingRowIds: number;
}

type Snapshot = Awaited<ReturnType<PrismaClient['balanceSnapshot']['findMany']>>[number];

function splitSnapshots(fromSnaps: Snapshot[], intoSnaps: Snapshot[]) {
  const ordered = [...fromSnaps].sort((a, b) => a.date.getTime() - b.date.getTime());
  let cut = ordered.length;
  while (cut > 0 && Number(ordered[cut - 1].balance) === 0) cut--;
  // Only a run at the END is the money having left; and an account that was
  // only ever zero keeps its rows (nothing to carry, nothing misread).
  const zeros = cut === 0 ? [] : ordered.slice(cut);
  const kept = ordered.slice(0, ordered.length - zeros.length);
  const intoByDay = new Map(intoSnaps.map((s) => [s.date.getTime(), s]));
  const summed = kept.filter((s) => intoByDay.has(s.date.getTime()));
  const moved = kept.filter((s) => !intoByDay.has(s.date.getTime()));
  return { zeros, summed, moved, intoByDay };
}

export async function planCombine(prisma: PrismaClient, fromId: string, intoId: string): Promise<CombinePlan> {
  const [fromRows, intoRows, fromSnaps, intoSnaps] = await Promise.all([
    prisma.transaction.findMany({ where: { accountId: fromId }, select: { externalId: true } }),
    prisma.transaction.findMany({ where: { accountId: intoId }, select: { externalId: true } }),
    prisma.balanceSnapshot.findMany({ where: { accountId: fromId } }),
    prisma.balanceSnapshot.findMany({ where: { accountId: intoId } }),
  ]);
  const intoIds = new Set(intoRows.map((t) => t.externalId));
  const { zeros, summed, moved } = splitSnapshots(fromSnaps, intoSnaps);
  return {
    fromId,
    intoId,
    rowsMoved: fromRows.length,
    trailingZerosDropped: zeros.length,
    snapshotsSummed: summed.length,
    snapshotsMoved: moved.length,
    clashingRowIds: fromRows.filter((t) => intoIds.has(t.externalId)).length,
  };
}

type AccountRow = Awaited<ReturnType<PrismaClient['account']['findMany']>>[number];

export interface CombineUndo {
  at: string;
  fromAccount: AccountRow;
  movedRowIds: string[];
  /** The old account's snapshots as they were: every one is restored to it. */
  fromSnapshots: Snapshot[];
  /** The kept account's snapshots a sum rewrote, as they were. */
  intoSnapshotsBefore: Snapshot[];
  movedBatchIds: string[];
  settingsBefore: { key: string; value: string | null }[];
}

export async function applyCombine(
  prisma: PrismaClient,
  fromId: string,
  intoId: string,
): Promise<{ ok: true; plan: CombinePlan } | { ok: false; message: string }> {
  if (fromId === intoId) return { ok: false, message: 'An account cannot be combined with itself.' };
  const claim = await claimSyncLock(prisma);
  try {
    const [from, into] = await Promise.all([
      prisma.account.findUnique({ where: { id: fromId } }),
      prisma.account.findUnique({ where: { id: intoId } }),
    ]);
    if (from === null || into === null) return { ok: false, message: 'One of the two accounts is not here.' };
    const plan = await planCombine(prisma, fromId, intoId);
    if (plan.clashingRowIds > 0) {
      return { ok: false, message: `${plan.clashingRowIds} rows sit in both accounts under the same feed id; these are copies, not two accounts. Use accounts:relink instead.` };
    }

    const since = await earliestOfAccount(prisma, fromId);
    const [fromRows, fromSnaps, intoSnaps, batches, settings] = await Promise.all([
      prisma.transaction.findMany({ where: { accountId: fromId }, select: { id: true } }),
      prisma.balanceSnapshot.findMany({ where: { accountId: fromId } }),
      prisma.balanceSnapshot.findMany({ where: { accountId: intoId } }),
      prisma.importBatch.findMany({ where: { accountId: fromId }, select: { id: true } }),
      prisma.setting.findMany(),
    ]);
    const { zeros, summed, moved, intoByDay } = splitSnapshots(fromSnaps, intoSnaps);

    // Settings: the old account's id becomes the kept one's wherever a value
    // names it; its own name and hidden flag go with it; its feed id joins
    // the skip list when its feed would otherwise bring it back.
    const settingsBefore: CombineUndo['settingsBefore'] = [];
    const writes: { key: string; value: string }[] = [];
    const byKey = new Map(settings.map((s) => [s.key, s.value]));
    for (const s of settings) {
      if (s.key.startsWith(COMBINE_UNDO_PREFIX) || s.key.startsWith('accounts.relinkUndo:')) continue;
      if (s.key === ACCOUNT_NAMES_KEY || s.key === HIDDEN_ON_OVERVIEW_KEY) continue;
      if (!s.value.includes(fromId)) continue;
      try {
        const next = JSON.stringify(replaceId(JSON.parse(s.value), fromId, intoId));
        if (next !== s.value) {
          settingsBefore.push({ key: s.key, value: s.value });
          writes.push({ key: s.key, value: next });
        }
      } catch {
        // not JSON and not an id: left alone
      }
    }
    const names = byKey.get(ACCOUNT_NAMES_KEY);
    if (names !== undefined) {
      const parsed = JSON.parse(names) as Record<string, string>;
      if (fromId in parsed) {
        delete parsed[fromId];
        settingsBefore.push({ key: ACCOUNT_NAMES_KEY, value: names });
        writes.push({ key: ACCOUNT_NAMES_KEY, value: JSON.stringify(parsed) });
      }
    }
    const hidden = byKey.get(HIDDEN_ON_OVERVIEW_KEY);
    if (hidden !== undefined) {
      const ids = (JSON.parse(hidden) as string[]).filter((id) => id !== fromId);
      if (JSON.stringify(ids) !== hidden) {
        settingsBefore.push({ key: HIDDEN_ON_OVERVIEW_KEY, value: hidden });
        writes.push({ key: HIDDEN_ON_OVERVIEW_KEY, value: JSON.stringify(ids) });
      }
    }
    if (pollsForBalances(from.connectorType)) {
      const raw = byKey.get(IGNORED_FEED_ACCOUNTS_KEY) ?? null;
      const ignored = parseIgnoredFeedAccounts(raw);
      ignored[from.connectorType] = [...new Set([...(ignored[from.connectorType] ?? []), from.externalId])].sort();
      settingsBefore.push({ key: IGNORED_FEED_ACCOUNTS_KEY, value: raw });
      writes.push({ key: IGNORED_FEED_ACCOUNTS_KEY, value: JSON.stringify(ignored) });
    }

    const undo: CombineUndo = {
      at: new Date().toISOString(),
      fromAccount: from,
      movedRowIds: fromRows.map((t) => t.id),
      fromSnapshots: fromSnaps,
      intoSnapshotsBefore: summed.map((s) => intoByDay.get(s.date.getTime())!),
      movedBatchIds: batches.map((b) => b.id),
      settingsBefore,
    };

    await prisma.$transaction([
      prisma.transaction.updateMany({ where: { accountId: fromId }, data: { accountId: intoId } }),
      ...summed.map((s) => {
        const target = intoByDay.get(s.date.getTime())!;
        return prisma.balanceSnapshot.update({
          where: { id: target.id },
          data: { balance: (Number(target.balance) + Number(s.balance)).toFixed(2) },
        });
      }),
      prisma.balanceSnapshot.deleteMany({ where: { id: { in: [...zeros, ...summed].map((s) => s.id) } } }),
      prisma.balanceSnapshot.updateMany({ where: { id: { in: moved.map((s) => s.id) } }, data: { accountId: intoId } }),
      prisma.importBatch.updateMany({ where: { accountId: fromId }, data: { accountId: intoId } }),
      prisma.account.delete({ where: { id: fromId } }),
      ...writes.map((w) =>
        prisma.setting.upsert({ where: { key: w.key }, create: { key: w.key, value: w.value }, update: { value: w.value } }),
      ),
      prisma.setting.upsert({
        where: { key: COMBINE_UNDO_PREFIX + intoId },
        create: { key: COMBINE_UNDO_PREFIX + intoId, value: JSON.stringify(undo) },
        update: { value: JSON.stringify(undo) },
      }),
    ]);
    await regenerateSince(prisma, since);
    return { ok: true, plan };
  } finally {
    await releaseSyncLock(prisma, claim);
  }
}

/** Put a combine back: the old account, its rows, its balances and every setting as they were. */
export async function undoCombine(
  prisma: PrismaClient,
  intoId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const claim = await claimSyncLock(prisma);
  try {
    const row = await prisma.setting.findUnique({ where: { key: COMBINE_UNDO_PREFIX + intoId } });
    if (row === null) return { ok: false, message: 'No combine into that account is on record.' };
    const undo = JSON.parse(row.value) as CombineUndo;
    const date = (v: unknown) => new Date(v as string);
    const from = undo.fromAccount;
    await prisma.$transaction([
      prisma.account.create({ data: { ...from, balanceDate: date(from.balanceDate), createdAt: date(from.createdAt) } }),
      prisma.transaction.updateMany({ where: { id: { in: undo.movedRowIds } }, data: { accountId: from.id } }),
      // The old account's balances: the moved ones go back, the rest are recreated.
      prisma.balanceSnapshot.deleteMany({ where: { id: { in: undo.fromSnapshots.map((s) => s.id) } } }),
      ...undo.fromSnapshots.map((s) => prisma.balanceSnapshot.create({ data: { ...s, date: date(s.date) } })),
      ...undo.intoSnapshotsBefore.map((s) =>
        prisma.balanceSnapshot.update({ where: { id: s.id }, data: { balance: String(s.balance) } }),
      ),
      prisma.importBatch.updateMany({ where: { id: { in: undo.movedBatchIds } }, data: { accountId: from.id } }),
      ...undo.settingsBefore.map((s) =>
        s.value === null
          ? prisma.setting.deleteMany({ where: { key: s.key } })
          : prisma.setting.upsert({ where: { key: s.key }, create: { key: s.key, value: s.value }, update: { value: s.value } }),
      ),
      prisma.setting.delete({ where: { key: COMBINE_UNDO_PREFIX + intoId } }),
    ]);
    await regenerateSince(prisma, await earliestOfAccount(prisma, from.id));
    return { ok: true };
  } finally {
    await releaseSyncLock(prisma, claim);
  }
}
