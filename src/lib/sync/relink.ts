import type { PrismaClient } from '../../generated/prisma/client';
import { pollsForBalances } from '../health/health';
import { earliestOfAccount, regenerateSince } from '../insights/scope';
import { isClosedBox } from './closedBox';
import { claimSyncLock, releaseSyncLock } from './lock';
import { matchOverlap } from './overlap';
import { reapplyRules, releaseClosedBox } from './rulePack';

/**
 * Re-linking an account a RECONNECT forked.
 *
 * A feed account is known by the id the feed gives it (Account.externalId).
 * Delete a connection at the aggregator and add it again, and the same real
 * account can come back under a NEW id: the next sync creates a second
 * account beside the first, with up to 90 days of history the first already
 * holds, while the first stops updating at its last balance. Net worth counts
 * the money twice and every re-sent row is a copy without its category,
 * links or tags.
 *
 * This puts them back together, and only when asked. The sync records which
 * accounts the feed listed (FEED_ACCOUNTS_KEY); a pair is OFFERED when a
 * listed account and an unlisted one of the same connector sit at the same
 * institution under the same name (the same words and the same trailing
 * digits), the unlisted one older, and neither has any other candidate. Two
 * candidates is no offer: filing one account's history under another
 * corrupts both, invisibly, so a missed offer is the better failure, as
 * matchAccount decides for statements.
 *
 * Merging keeps the OLDER account (its id, name, type and every row with its
 * category, links and tags), moves the newer one's rows into it and drops
 * the ones it already holds, decided by the import's own duplicate rule
 * (overlap.ts): same amount to the cent, dates within RELINK_MATCH_DAYS, as a
 * multiset. A row the rule calls ambiguous is KEPT and counted for review. The
 * older account then takes the newer one's feed id, so the next sync lands
 * in it, and the newer one is deleted.
 */

/** Setting: the accounts each connector's feed listed at its latest sync. */
export const FEED_ACCOUNTS_KEY = 'sync.feedAccounts';
/** Setting: pairs the operator said are NOT the same account, as "old|new". */
export const RELINK_DISMISSED_KEY = 'accounts.relinkDismissed';
/** Setting prefix: what one merge changed, by the account kept, for its undo. */
export const RELINK_UNDO_PREFIX = 'accounts.relinkUndo:';
/** A re-sent row and the row it copies: the dates a feed reports one row under. */
export const RELINK_MATCH_DAYS = 3;

export type FeedAccounts = Record<string, { at: string; externalIds: string[] }>;

export function parseFeedAccounts(raw: string | null): FeedAccounts {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FeedAccounts = {};
    for (const [type, v] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = v as { at?: unknown; externalIds?: unknown };
      if (typeof entry?.at === 'string' && Array.isArray(entry.externalIds)) {
        out[type] = { at: entry.at, externalIds: entry.externalIds.filter((x): x is string => typeof x === 'string') };
      }
    }
    return out;
  } catch {
    return {}; // an unreadable record offers nothing; it never takes a page down
  }
}

/** Called by the sync, inside its lock, with every account the feed listed. */
export async function recordFeedAccounts(
  prisma: PrismaClient,
  connectorType: string,
  externalIds: string[],
  at: Date,
): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: FEED_ACCOUNTS_KEY } });
  const record = parseFeedAccounts(row?.value ?? null);
  record[connectorType] = { at: at.toISOString(), externalIds: [...new Set(externalIds)].sort() };
  const value = JSON.stringify(record);
  await prisma.setting.upsert({ where: { key: FEED_ACCOUNTS_KEY }, create: { key: FEED_ACCOUNTS_KEY, value }, update: { value } });
}

export function parseDismissed(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export const pairKey = (oldId: string, newId: string) => `${oldId}|${newId}`;

export interface RelinkAccount {
  id: string;
  externalId: string;
  connectorType: string;
  institution: string;
  name: string;
  createdAt: Date;
  balanceDate: Date;
}

export interface RelinkPair {
  oldId: string;
  newId: string;
  oldName: string;
  newName: string;
  institution: string;
  /** When the older account last had a balance from the feed. */
  oldBalanceDate: Date;
}

/** The letters of a name as words, and its trailing digit run: what a reconnect keeps. */
function identity(name: string): string {
  const words = name.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const tail = /(\d{3,})\D*$/.exec(name)?.[1] ?? '';
  return `${words}#${tail}`;
}

/** Pairs to offer: pure, so the page and the command decide alike. */
export function findRelinkPairs(
  accounts: readonly RelinkAccount[],
  feed: FeedAccounts,
  dismissed: ReadonlySet<string>,
): RelinkPair[] {
  const pairs: RelinkPair[] = [];
  for (const [connectorType, listed] of Object.entries(feed)) {
    if (!pollsForBalances(connectorType)) continue;
    const seen = new Set(listed.externalIds);
    const mine = accounts.filter((a) => a.connectorType === connectorType);
    const listedNow = mine.filter((a) => seen.has(a.externalId));
    const gone = mine.filter((a) => !seen.has(a.externalId));
    const alike = (older: RelinkAccount, newer: RelinkAccount) =>
      older.institution === newer.institution &&
      identity(older.name) === identity(newer.name) &&
      older.createdAt.getTime() < newer.createdAt.getTime();
    for (const newer of listedNow) {
      const olders = gone.filter((g) => alike(g, newer));
      if (olders.length !== 1) continue;
      const older = olders[0];
      // The other direction too: one older account two new ones could claim is no offer.
      if (listedNow.filter((n) => alike(older, n)).length !== 1) continue;
      if (dismissed.has(pairKey(older.id, newer.id))) continue;
      pairs.push({
        oldId: older.id,
        newId: newer.id,
        oldName: older.name,
        newName: newer.name,
        institution: older.institution,
        oldBalanceDate: older.balanceDate,
      });
    }
  }
  return pairs.sort((a, b) => a.oldName.localeCompare(b.oldName));
}

/** The pairs offered right now, read from the database. */
export async function currentRelinkPairs(prisma: PrismaClient): Promise<RelinkPair[]> {
  const [accounts, settings] = await Promise.all([
    prisma.account.findMany({
      select: { id: true, externalId: true, connectorType: true, institution: true, name: true, createdAt: true, balanceDate: true },
    }),
    prisma.setting.findMany({ where: { key: { in: [FEED_ACCOUNTS_KEY, RELINK_DISMISSED_KEY] } } }),
  ]);
  const setting = (key: string) => settings.find((s) => s.key === key)?.value ?? null;
  return findRelinkPairs(accounts, parseFeedAccounts(setting(FEED_ACCOUNTS_KEY)), parseDismissed(setting(RELINK_DISMISSED_KEY)));
}

export async function dismissRelinkPair(prisma: PrismaClient, oldId: string, newId: string): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: RELINK_DISMISSED_KEY } });
  const dismissed = parseDismissed(row?.value ?? null);
  dismissed.add(pairKey(oldId, newId));
  const value = JSON.stringify([...dismissed].sort());
  await prisma.setting.upsert({ where: { key: RELINK_DISMISSED_KEY }, create: { key: RELINK_DISMISSED_KEY, value }, update: { value } });
}

// ---------------------------------------------------------------- the plan

export interface RelinkPlan {
  oldId: string;
  newId: string;
  /** Rows of the newer account moved into the older one as they are. */
  move: string[];
  /** Rows of the newer account the older one already holds: dropped, the older row kept. */
  duplicates: { dropId: string; keepId: string }[];
  /** Rows the duplicate rule could not decide: moved, and counted for review. */
  ambiguous: string[];
  /** Same-day snapshots: the older account's is replaced by the newer one's (the live feed's). */
  snapshotsReplaced: number;
  snapshotsMoved: number;
}

/** Read-only: what merging `newId` into `oldId` would do. */
export async function planRelink(prisma: PrismaClient, oldId: string, newId: string): Promise<RelinkPlan> {
  const select = { id: true, externalId: true, date: true, amount: true } as const;
  const [olds, news, oldSnaps, newSnaps] = await Promise.all([
    prisma.transaction.findMany({ where: { accountId: oldId }, select }),
    prisma.transaction.findMany({ where: { accountId: newId }, select }),
    prisma.balanceSnapshot.findMany({ where: { accountId: oldId }, select: { date: true } }),
    prisma.balanceSnapshot.findMany({ where: { accountId: newId }, select: { date: true } }),
  ]);

  // The same feed row under its own id again: a duplicate whatever its date.
  const oldByExternal = new Map(olds.map((t) => [t.externalId, t.id]));
  const duplicates: RelinkPlan['duplicates'] = [];
  const rest = [];
  for (const t of news) {
    const keep = oldByExternal.get(t.externalId);
    if (keep === undefined) rest.push(t);
    else duplicates.push({ dropId: t.id, keepId: keep });
  }
  const taken = new Set(duplicates.map((d) => d.keepId));
  const stored = olds.filter((t) => !taken.has(t.id)).map((t) => ({ id: t.id, date: t.date, amount: Number(t.amount) }));
  const historyStart = olds.length === 0 ? null : new Date(Math.min(...olds.map((t) => t.date.getTime())));
  const { verdicts } = matchOverlap(
    rest.map((t) => ({ key: t.id, date: t.date, amount: Number(t.amount) })),
    stored,
    RELINK_MATCH_DAYS,
    historyStart,
  );
  const move: string[] = [];
  const ambiguous: string[] = [];
  for (const t of rest) {
    const v = verdicts.get(t.id);
    if (v?.kind === 'MATCHED') duplicates.push({ dropId: t.id, keepId: v.storedId });
    else if (v?.kind === 'AMBIGUOUS') ambiguous.push(t.id);
    else move.push(t.id);
  }

  const oldDays = new Set(oldSnaps.map((s) => s.date.getTime()));
  const snapshotsReplaced = newSnaps.filter((s) => oldDays.has(s.date.getTime())).length;
  return { oldId, newId, move, duplicates, ambiguous, snapshotsReplaced, snapshotsMoved: newSnaps.length };
}

// ---------------------------------------------------------------- the merge

type TxnRow = Awaited<ReturnType<PrismaClient['transaction']['findMany']>>[number];
type SnapshotRow = Awaited<ReturnType<PrismaClient['balanceSnapshot']['findMany']>>[number];
type AccountRow = Awaited<ReturnType<PrismaClient['account']['findMany']>>[number];

/** What one merge changed, enough to put every row back as it was. */
export interface RelinkUndo {
  at: string;
  oldAccount: AccountRow;
  newAccount: AccountRow;
  /** Rows moved from the newer account into the older one. */
  movedIds: string[];
  /** Every other row the merge rewrote or deleted, as it was before. */
  txnsBefore: TxnRow[];
  deletedTxnIds: string[];
  movedSnapshotIds: string[];
  deletedSnapshots: SnapshotRow[];
  movedBatchIds: string[];
  settingsBefore: { key: string; value: string }[];
}

export interface RelinkResult {
  moved: number;
  duplicates: number;
  ambiguous: number;
  /** Transfer links a dropped duplicate held that could not move to its kept row: the partner was left unpaired. */
  unpaired: number;
}

/** Every string equal to `from` anywhere in a JSON value becomes `to`; string arrays then drop repeats. */
function replaceId(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) {
    const mapped = value.map((v) => replaceId(v, from, to));
    return mapped.every((v) => typeof v === 'string') ? [...new Set(mapped as string[])] : mapped;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceId(v, from, to)]));
  }
  return value;
}

/**
 * Merge the pair: under the sync lock, so no sync writes into either account
 * meanwhile. Refuses (returns a sentence) when the pair is no longer offered.
 */
export async function applyRelink(
  prisma: PrismaClient,
  oldId: string,
  newId: string,
): Promise<{ ok: true; result: RelinkResult } | { ok: false; message: string }> {
  const claim = await claimSyncLock(prisma);
  try {
    const offered = (await currentRelinkPairs(prisma)).some((p) => p.oldId === oldId && p.newId === newId);
    if (!offered) return { ok: false, message: 'These two accounts are no longer offered as a pair. Reload to see the current state.' };

    const plan = await planRelink(prisma, oldId, newId);
    const since = await earliestOfAccount(prisma, newId);
    const [oldAccount, newAccount] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id: oldId } }),
      prisma.account.findUniqueOrThrow({ where: { id: newId } }),
    ]);

    // Rows a dropped duplicate is tied to: its kept twin, its transfer partner,
    // and anything it is the bill of. Read whole, so the undo can restore them.
    const dropIds = plan.duplicates.map((d) => d.dropId);
    const keepIds = plan.duplicates.map((d) => d.keepId);
    const tied = await prisma.transaction.findMany({
      where: {
        OR: [
          { id: { in: [...dropIds, ...keepIds] } },
          { transferPairId: { in: dropIds } },
          { reimbursesId: { in: dropIds } },
        ],
      },
    });
    const byId = new Map(tied.map((t) => [t.id, t]));
    const touched = new Map<string, TxnRow>();
    const note = (t: TxnRow) => touched.set(t.id, t);

    const updates: { id: string; data: Record<string, unknown> }[] = [];
    let unpaired = 0;
    for (const { dropId, keepId } of plan.duplicates) {
      const drop = byId.get(dropId)!;
      const keep = byId.get(keepId)!;
      note(drop);
      // The kept row takes the copy's feed id: the next sync re-sends its
      // last week under the new ids, and dedupe knows a row only by its id.
      note(keep);
      updates.push({ id: keep.id, data: { externalId: drop.externalId } });
      const partnerId = drop.transferPairId;
      if (partnerId !== null && partnerId !== keepId) {
        const partner = byId.get(partnerId) ?? (await prisma.transaction.findUnique({ where: { id: partnerId } }));
        if (partner !== null) {
          note(partner);
          if (keep.transferPairId === null && keep.categorySource !== 'MANUAL') {
            // The pair the sync made with the copy is the kept row's pair: as
            // pairing itself writes it, a transfer with no category.
            updates.push({ id: keep.id, data: { transferPairId: partner.id, flow: 'TRANSFER', categoryId: null } });
            updates.push({ id: partner.id, data: { transferPairId: keep.id } });
          } else {
            updates.push({ id: partner.id, data: { transferPairId: null } });
            unpaired++;
          }
        }
      }
      for (const repayment of tied.filter((t) => t.reimbursesId === dropId)) {
        note(repayment);
        updates.push({ id: repayment.id, data: { reimbursesId: keepId } });
      }
      if (drop.reimbursesId !== null && keep.reimbursesId === null) {
        updates.push({ id: keep.id, data: { reimbursesId: drop.reimbursesId } });
      }
    }

    const [newSnaps, oldSnaps, batches, settings] = await Promise.all([
      prisma.balanceSnapshot.findMany({ where: { accountId: newId } }),
      prisma.balanceSnapshot.findMany({ where: { accountId: oldId } }),
      prisma.importBatch.findMany({ where: { accountId: newId }, select: { id: true } }),
      prisma.setting.findMany(),
    ]);
    const newDays = new Set(newSnaps.map((s) => s.date.getTime()));
    const replacedSnaps = oldSnaps.filter((s) => newDays.has(s.date.getTime()));

    const settingsBefore: { key: string; value: string }[] = [];
    const settingWrites: { key: string; value: string }[] = [];
    for (const s of settings) {
      if (s.key.startsWith(RELINK_UNDO_PREFIX) || !s.value.includes(newId)) continue;
      try {
        const next = JSON.stringify(replaceId(JSON.parse(s.value), newId, oldId));
        if (next !== s.value) {
          settingsBefore.push({ key: s.key, value: s.value });
          settingWrites.push({ key: s.key, value: next });
        }
      } catch {
        // Not JSON: a plain value naming the account is replaced whole.
        if (s.value === newId) {
          settingsBefore.push({ key: s.key, value: s.value });
          settingWrites.push({ key: s.key, value: oldId });
        }
      }
    }

    const undo: RelinkUndo = {
      at: new Date().toISOString(),
      oldAccount,
      newAccount,
      movedIds: [...plan.move, ...plan.ambiguous],
      txnsBefore: [...touched.values()],
      deletedTxnIds: dropIds,
      movedSnapshotIds: newSnaps.map((s) => s.id),
      deletedSnapshots: replacedSnaps,
      movedBatchIds: batches.map((b) => b.id),
      settingsBefore,
    };

    await prisma.$transaction([
      // A dropped row first lets go of its own links, so deleting it frees nothing still pointed at.
      prisma.transaction.updateMany({ where: { id: { in: dropIds } }, data: { transferPairId: null, reimbursesId: null } }),
      ...updates.map((u) => prisma.transaction.update({ where: { id: u.id }, data: u.data })),
      prisma.transaction.deleteMany({ where: { id: { in: dropIds } } }),
      prisma.transaction.updateMany({ where: { id: { in: undo.movedIds } }, data: { accountId: oldId } }),
      prisma.balanceSnapshot.deleteMany({ where: { id: { in: replacedSnaps.map((s) => s.id) } } }),
      prisma.balanceSnapshot.updateMany({ where: { accountId: newId }, data: { accountId: oldId } }),
      prisma.importBatch.updateMany({ where: { accountId: newId }, data: { accountId: oldId } }),
      prisma.account.delete({ where: { id: newId } }),
      prisma.account.update({
        where: { id: oldId },
        data: {
          externalId: newAccount.externalId,
          balance: newAccount.balance,
          balanceDate: newAccount.balanceDate,
          isStale: newAccount.isStale,
          currency: newAccount.currency,
        },
      }),
      ...settingWrites.map((s) => prisma.setting.update({ where: { key: s.key }, data: { value: s.value } })),
      prisma.setting.upsert({
        where: { key: RELINK_UNDO_PREFIX + oldId },
        create: { key: RELINK_UNDO_PREFIX + oldId, value: JSON.stringify(undo) },
        update: { value: JSON.stringify(undo) },
      }),
    ]);

    // Rows moved across the closed box take the kept account's side of it,
    // as a retype on /accounts moves them (app/accounts/actions.ts).
    if (isClosedBox(newAccount.type) !== isClosedBox(oldAccount.type)) {
      if (isClosedBox(newAccount.type)) await releaseClosedBox(prisma, oldId);
      await reapplyRules(prisma);
    }
    await regenerateSince(prisma, since);
    return {
      ok: true,
      result: { moved: plan.move.length, duplicates: plan.duplicates.length, ambiguous: plan.ambiguous.length, unpaired },
    };
  } finally {
    await releaseSyncLock(prisma, claim);
  }
}

// ---------------------------------------------------------------- undo

const lastSyncKey = (connectorType: string) => `lastSync:${connectorType}`;

/**
 * Put a merge back exactly. Refused once a sync has run since it: that sync
 * wrote into the kept account under the feed id the merge gave it, and
 * splitting those rows back out would be a guess.
 */
export async function undoRelink(
  prisma: PrismaClient,
  oldId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const claim = await claimSyncLock(prisma);
  try {
    const row = await prisma.setting.findUnique({ where: { key: RELINK_UNDO_PREFIX + oldId } });
    if (row === null) return { ok: false, message: 'No merge into that account is on record.' };
    const undo = JSON.parse(row.value) as RelinkUndo;
    const lastSync = await prisma.setting.findUnique({ where: { key: lastSyncKey(undo.newAccount.connectorType) } });
    if (lastSync !== null && new Date(lastSync.value) > new Date(undo.at)) {
      return { ok: false, message: 'A sync has run since this merge, so it can no longer be undone exactly. Restore the backup taken before it instead.' };
    }
    const date = (v: unknown) => new Date(v as string);
    const acct = (a: AccountRow) => ({ ...a, balanceDate: date(a.balanceDate), createdAt: date(a.createdAt) });
    const txn = (t: TxnRow) => ({ ...t, date: date(t.date), importedAt: date(t.importedAt) });
    const deleted = undo.txnsBefore.filter((t) => undo.deletedTxnIds.includes(t.id));
    const rewritten = undo.txnsBefore.filter((t) => !undo.deletedTxnIds.includes(t.id));

    await prisma.$transaction([
      prisma.account.create({ data: acct(undo.newAccount) }),
      prisma.account.update({ where: { id: oldId }, data: acct(undo.oldAccount) }),
      prisma.transaction.updateMany({ where: { id: { in: undo.movedIds } }, data: { accountId: undo.newAccount.id } }),
      // Deleted rows come back without links first, then every row takes its old links.
      ...deleted.map((t) => prisma.transaction.create({ data: { ...txn(t), transferPairId: null, reimbursesId: null } })),
      ...[...deleted, ...rewritten].map((t) => prisma.transaction.update({ where: { id: t.id }, data: txn(t) })),
      prisma.balanceSnapshot.updateMany({ where: { id: { in: undo.movedSnapshotIds } }, data: { accountId: undo.newAccount.id } }),
      ...undo.deletedSnapshots.map((s) => prisma.balanceSnapshot.create({ data: { ...s, date: date(s.date) } })),
      prisma.importBatch.updateMany({ where: { id: { in: undo.movedBatchIds } }, data: { accountId: undo.newAccount.id } }),
      ...undo.settingsBefore.map((s) => prisma.setting.update({ where: { key: s.key }, data: { value: s.value } })),
      prisma.setting.delete({ where: { key: RELINK_UNDO_PREFIX + oldId } }),
    ]);
    if (isClosedBox(undo.newAccount.type) !== isClosedBox(undo.oldAccount.type)) await reapplyRules(prisma);
    await regenerateSince(prisma, await earliestOfAccount(prisma, undo.newAccount.id));
    return { ok: true };
  } finally {
    await releaseSyncLock(prisma, claim);
  }
}
