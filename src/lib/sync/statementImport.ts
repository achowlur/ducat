import { createHash } from 'node:crypto';
import type { AccountType } from '../../types/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { matchAccount } from '../connectors/matchAccount';
import { PdfStatementConnector, type PdfImportRow } from '../connectors/pdf/connector';
import { transactionDateNote, type ParsedStatement, type StatementRow } from '../connectors/pdf/statement';
import { crossesTheBoundary } from './closedBox';
import { matchOverlap, type OverlapVerdict } from './overlap';
import { runSync, transactionKey, type SyncResult } from './sync';

/**
 * Statement import, planned then written.
 *
 * The PLAN is read-only and is shared by both paths: the dry run reports it
 * and `writeStatementImport` carries it out, so what the dry run prints is
 * what the write does. It decides, per statement row, whether the database
 * already holds it (under this row's own id, or under another source's: see
 * overlap.ts), and only the rows it decides to add reach the connector.
 */

/** A statement that parsed and reconciled, with the file it came from. */
export interface StatementFile {
  fileName: string;
  fileSha256: string;
  statement: ParsedStatement;
}

export interface TargetAccount {
  id: string;
  externalId: string;
  name: string;
  institution: string;
  type: AccountType;
  currency: string;
}

export type RowVerdict = OverlapVerdict | { kind: 'PRESENT' };

export interface PlannedRow {
  row: StatementRow;
  externalId: string;
  verdict: RowVerdict;
}

export interface PlannedStatement {
  file: StatementFile;
  account: TargetAccount;
  /** Deterministic per file, so a re-run after a failed write files rows under the same batch. */
  batchId: string;
  rows: PlannedRow[];
}

export interface SkippedFile {
  fileName: string;
  reason: string;
}

export interface PlannedSnapshot {
  accountId: string;
  date: Date;
  balance: number;
}

export interface StatementImportPlan {
  windowDays: number;
  statements: PlannedStatement[];
  skipped: SkippedFile[];
  /** Per account: stored rows inside the planned periods that no statement row accounts for. */
  storedOnly: Map<string, { date: Date; amount: number; description: string }[]>;
  /** Statement closing balances with no snapshot on that date yet. */
  snapshots: PlannedSnapshot[];
}

export interface PlanOptions {
  /** Dates may differ by this many days between a statement and another source. */
  windowDays: number;
  /** File every statement under this account instead of matching by its last four digits. */
  externalId?: string;
}

const DAY_MS = 86_400_000;

/**
 * The batch a statement is recorded under: one per file AND account, since a
 * brokerage report covers several accounts. The same file read again gives
 * the same ids, which is what lets a re-run after a failed write file its
 * rows under the record it then writes.
 */
export function batchIdFor(fileSha256: string, accountLast4: string): string {
  return `pdf-${createHash('sha256').update(`${fileSha256}|${accountLast4}`).digest('hex').slice(0, 24)}`;
}

/**
 * A row's own id: a hash of what the statement prints, plus an occurrence
 * counter so two identical rows in one statement stay two rows. The same
 * statement read twice yields the same ids, so it dedupes on the stored key.
 */
function rowIds(rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const fingerprint = `${r.date.toISOString().slice(0, 10)}|${r.amount.toFixed(2)}|${r.description}`;
    const nth = (seen.get(fingerprint) ?? 0) + 1;
    seen.set(fingerprint, nth);
    return `pdf-${createHash('sha256').update(`${fingerprint}|${nth}`).digest('hex').slice(0, 24)}`;
  });
}

function sameInstitution(statement: string, stored: string): boolean {
  const a = statement.toLowerCase();
  const b = stored.toLowerCase();
  return a.includes(b) || b.includes(a);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function planStatementImport(
  prisma: PrismaClient,
  files: StatementFile[],
  options: PlanOptions,
): Promise<StatementImportPlan> {
  const skipped: SkippedFile[] = [];
  const accounts = await prisma.account.findMany({
    select: { id: true, externalId: true, name: true, institution: true, type: true, currency: true },
  });
  const priorBatches = await prisma.importBatch.findMany({
    select: { fileName: true, fileSha256: true, accountId: true, periodStart: true, periodEnd: true, importedAt: true },
  });

  const forced =
    options.externalId === undefined ? null : (accounts.find((a) => a.externalId === options.externalId) ?? null);
  if (options.externalId !== undefined && forced === null) {
    throw new Error(`No account has externalId "${options.externalId}".`);
  }

  // A file can hold several accounts (an investment report covers them all).
  // --external-id names ONE account, so it cannot say where each of them goes.
  const accountsInFile = new Map<string, Set<string>>();
  for (const file of files) {
    const held = accountsInFile.get(file.fileSha256) ?? new Set<string>();
    held.add(file.statement.accountLast4);
    accountsInFile.set(file.fileSha256, held);
  }

  // Which statements go ahead, and into which account.
  const accepted: { file: StatementFile; account: TargetAccount }[] = [];
  for (const file of files) {
    const s = file.statement;
    const twin = accepted.find(
      (a) => a.file.fileSha256 === file.fileSha256 && a.file.statement.accountLast4 === s.accountLast4,
    );
    if (twin !== undefined) {
      skipped.push({ fileName: file.fileName, reason: `the same file as ${twin.file.fileName}, earlier in this run` });
      continue;
    }
    const held = accountsInFile.get(file.fileSha256)?.size ?? 1;
    if (forced !== null && held > 1) {
      skipped.push({
        fileName: file.fileName,
        reason: `it holds ${held} accounts and --external-id names one, so the account ending in ${s.accountLast4} is left out (run it without --external-id)`,
      });
      continue;
    }

    const account =
      (forced as TargetAccount | null) ??
      (matchAccount(
        s.accountLast4,
        accounts.filter((a) => a.type === s.accountType && sameInstitution(s.institution, a.institution)),
      ) as TargetAccount | null);
    if (account === null) {
      skipped.push({
        fileName: file.fileName,
        reason: `no single ${s.institution} ${s.accountType.toLowerCase()} account ending in ${s.accountLast4} (pass --external-id to choose one)`,
      });
      continue;
    }

    const imported = priorBatches.find((b) => b.fileSha256 === file.fileSha256 && b.accountId === account.id);
    if (imported !== undefined) {
      skipped.push({ fileName: file.fileName, reason: `already imported on ${day(imported.importedAt)}, as ${imported.fileName}` });
      continue;
    }

    // Periods that share more than a boundary day hold the same rows twice (a
    // quarterly report beside a monthly one), and rows are matched against the
    // database, never against another statement in the run.
    const overlaps = (start: Date, end: Date, accountId: string) =>
      accountId === account.id && start.getTime() < s.periodEnd.getTime() && end.getTime() > s.periodStart.getTime();
    const prior = priorBatches.find((b) => overlaps(b.periodStart, b.periodEnd, b.accountId));
    const earlier = accepted.find((a) => overlaps(a.file.statement.periodStart, a.file.statement.periodEnd, a.account.id));
    const other = prior ?? earlier?.file.statement;
    if (other !== undefined) {
      const same = other.periodStart.getTime() === s.periodStart.getTime() && other.periodEnd.getTime() === s.periodEnd.getTime();
      const where = prior !== undefined ? `imported, from ${prior.fileName}` : `in this run, as ${earlier?.file.fileName}`;
      skipped.push({
        fileName: file.fileName,
        reason: same
          ? `this ${day(s.periodStart)} to ${day(s.periodEnd)} statement is already ${where}`
          : `this ${day(s.periodStart)} to ${day(s.periodEnd)} statement overlaps the ${day(other.periodStart)} to ${day(other.periodEnd)} one already ${where}`,
      });
      continue;
    }
    accepted.push({ file, account });
  }

  const accountIds = [...new Set(accepted.map((a) => a.account.id))];
  const storedOnly = new Map<string, { date: Date; amount: number; description: string }[]>();
  if (accepted.length === 0) {
    return { windowDays: options.windowDays, statements: [], skipped, storedOnly, snapshots: [] };
  }

  // Every stored row the statements could overlap, in one read; and where each
  // account's history begins, in another.
  // A row can be dated outside its statement's period (a late-posting
  // merchant), so the range is the rows' own dates as well as the periods'.
  const slack = (options.windowDays + 1) * DAY_MS;
  const times = accepted.flatMap((a) => [
    a.file.statement.periodStart.getTime(),
    a.file.statement.periodEnd.getTime(),
    ...a.file.statement.rows.map((r) => r.date.getTime()),
  ]);
  const from = new Date(Math.min(...times) - slack);
  const to = new Date(Math.max(...times) + slack);
  const stored = await prisma.transaction.findMany({
    where: { accountId: { in: accountIds }, date: { gte: from, lte: to } },
    select: { id: true, accountId: true, externalId: true, date: true, amount: true, description: true },
  });
  const starts = await prisma.transaction.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accountIds } },
    _min: { date: true },
  });
  const historyStart = new Map(starts.map((s) => [s.accountId, s._min.date]));

  const statements: PlannedStatement[] = [];
  for (const accountId of accountIds) {
    const mine = accepted.filter((a) => a.account.id === accountId);
    const storedHere = stored.filter((t) => t.accountId === accountId);
    const storedIds = new Map(storedHere.map((t) => [transactionKey(t.accountId, t.externalId), t.id]));

    const planned = mine.map(({ file, account }) => {
      const ids = rowIds(file.statement.rows);
      return {
        file,
        account,
        batchId: batchIdFor(file.fileSha256, file.statement.accountLast4),
        rows: file.statement.rows.map((row, i): PlannedRow => ({
          row,
          externalId: ids[i],
          verdict: storedIds.has(transactionKey(accountId, ids[i])) ? { kind: 'PRESENT' } : { kind: 'NEW' },
        })),
      };
    });

    // Rows stored under THIS import's ids are matched already; the overlap
    // match runs on what is left, on both sides.
    const presentIds = new Set(
      planned.flatMap((p) =>
        p.rows.filter((r) => r.verdict.kind === 'PRESENT').map((r) => storedIds.get(transactionKey(accountId, r.externalId))),
      ),
    );
    // Feeds disagree on an investment transfer's SIGN (SimpleFIN stores a
    // brokerage deposit negative, Fidelity's CSV and statement positive), so
    // in an investment account a row matches on its magnitude.
    const matched = mine[0].account.type === 'INVESTMENT' ? Math.abs : (amount: number) => amount;
    const incoming = planned.flatMap((p, s) => {
      const { periodStart, periodEnd } = p.file.statement;
      const lateBefore = periodStart.getTime() - options.windowDays * DAY_MS;
      return p.rows
        .map((r, i) => ({
          key: `${s}:${i}`,
          date: r.row.date,
          amount: matched(r.row.amount),
          kind: r.verdict.kind,
          ...(r.row.transactionDate !== undefined || r.row.date.getTime() < lateBefore
            ? { postedWithin: { from: periodStart, to: periodEnd } }
            : {}),
        }))
        .filter((r) => r.kind !== 'PRESENT');
    });
    const candidates = storedHere
      .filter((t) => !presentIds.has(t.id))
      .map((t) => ({ id: t.id, date: t.date, amount: matched(Number(t.amount)) }));
    const { verdicts, claimed } = matchOverlap(incoming, candidates, options.windowDays, historyStart.get(accountId) ?? null);
    planned.forEach((p, s) =>
      p.rows.forEach((r, i) => {
        const v = verdicts.get(`${s}:${i}`);
        if (v !== undefined) r.verdict = v;
      }),
    );

    // Stored rows inside a planned period that nothing on a statement explains:
    // worth seeing, since a statement is the bank's own record of the period.
    // An investment statement lists only money crossing the account, so the
    // trades and dividends a feed stored inside it are never on one.
    const inAPeriod = (date: Date) =>
      mine.some((m) => date.getTime() >= m.file.statement.periodStart.getTime() && date.getTime() <= m.file.statement.periodEnd.getTime() + DAY_MS - 1);
    const listed = (description: string) => mine[0].account.type !== 'INVESTMENT' || crossesTheBoundary(description);
    const unexplained = storedHere
      .filter((t) => !claimed.has(t.id) && !presentIds.has(t.id) && inAPeriod(t.date) && listed(t.description))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    if (unexplained.length > 0) {
      storedOnly.set(
        accountId,
        unexplained.map((t) => ({ date: t.date, amount: Number(t.amount), description: t.description })),
      );
    }
    statements.push(...planned);
  }
  statements.sort(
    (a, b) => a.account.name.localeCompare(b.account.name) || a.file.statement.periodStart.getTime() - b.file.statement.periodStart.getTime(),
  );

  // One closing-balance snapshot per statement, where none exists that day.
  const closes = statements.map((p) => ({
    accountId: p.account.id,
    date: p.file.statement.periodEnd,
    balance: p.file.statement.closingBalance,
  }));
  const existing = await prisma.balanceSnapshot.findMany({
    where: { accountId: { in: accountIds }, date: { in: closes.map((c) => c.date) } },
    select: { accountId: true, date: true },
  });
  const taken = new Set(existing.map((e) => `${e.accountId}|${e.date.getTime()}`));
  const snapshots = closes.filter((c) => !taken.has(`${c.accountId}|${c.date.getTime()}`));

  return { windowDays: options.windowDays, statements, skipped, storedOnly, snapshots };
}

/** Whether a planned row is written. AMBIGUOUS never is: a guess is worse than a report. */
export function isAdded(verdict: RowVerdict): boolean {
  return verdict.kind === 'NEW' || verdict.kind === 'GAP';
}

/** The connector both paths hand on: the dry run to previewImport, the write to runSync. */
export function connectorFor(plan: StatementImportPlan): PdfStatementConnector {
  const accounts = new Map<string, TargetAccount & { lastPeriodEnd: Date }>();
  const rows: PdfImportRow[] = [];
  for (const p of plan.statements) {
    const known = accounts.get(p.account.externalId);
    const end = p.file.statement.periodEnd;
    if (known === undefined || known.lastPeriodEnd.getTime() < end.getTime()) {
      accounts.set(p.account.externalId, { ...p.account, lastPeriodEnd: end });
    }
    for (const r of p.rows) {
      if (!isAdded(r.verdict)) continue;
      rows.push({
        accountExternalId: p.account.externalId,
        externalId: r.externalId,
        date: r.row.date,
        amount: r.row.amount,
        description:
          r.row.transactionDate === undefined
            ? r.row.description
            : `${r.row.description} ${transactionDateNote(r.row.transactionDate)}`,
        merchantText: r.row.description,
        importBatchId: p.batchId,
      });
    }
  }
  return new PdfStatementConnector([...accounts.values()], rows);
}

export interface StatementImportResult {
  sync: SyncResult;
  batchesRecorded: number;
  snapshotsWritten: number;
}

/**
 * Carries out a plan: the rows through runSync, then the closing-balance
 * snapshots, then one ImportBatch per statement.
 *
 * Batches go LAST and count what is actually stored under them: a batch is
 * what makes a later run skip the file, so it is written only once
 * everything the file owes has landed. A write that fails midway records no
 * batch, the re-run is not refused as "already imported", and since its rows
 * carry the same deterministic batch id, the re-run's record covers them too.
 */
export async function writeStatementImport(
  prisma: PrismaClient,
  plan: StatementImportPlan,
): Promise<StatementImportResult> {
  const sync = await runSync(prisma, connectorFor(plan), { since: new Date(0) });

  if (plan.snapshots.length > 0) {
    await prisma.balanceSnapshot.createMany({ data: plan.snapshots });
  }

  const batchIds = plan.statements.map((p) => p.batchId);
  const counts = await prisma.transaction.groupBy({
    by: ['importBatchId'],
    where: { importBatchId: { in: batchIds } },
    _count: true,
  });
  const added = new Map(counts.map((c) => [c.importBatchId, c._count]));
  await prisma.importBatch.createMany({
    data: plan.statements.map((p) => ({
      id: p.batchId,
      source: 'PDF' as const,
      fileName: p.file.fileName,
      fileSha256: p.file.fileSha256,
      accountId: p.account.id,
      periodStart: p.file.statement.periodStart,
      periodEnd: p.file.statement.periodEnd,
      rowsAdded: added.get(p.batchId) ?? 0,
    })),
  });
  return { sync, batchesRecorded: plan.statements.length, snapshotsWritten: plan.snapshots.length };
}
