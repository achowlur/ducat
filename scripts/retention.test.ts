import { describe, expect, it } from 'vitest';
import { BACKUP_FILE, backupFileName, DAILY_DATES_KEPT, planRetention } from './retention';

/** ducat-YYYY-MM-DD-HHMM.db for a date offset in days before a fixed anchor. */
function fileFor(daysAgo: number, time = '2350'): string {
  const d = new Date(Date.UTC(2026, 7, 4) - daysAgo * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  return `ducat-${iso}-${time}.db`;
}

describe('backupFileName', () => {
  it('produces names its own parser accepts — writer and regex cannot drift', () => {
    const name = backupFileName(new Date(2026, 6, 26, 21, 45));
    expect(name).toBe('ducat-2026-07-26-2145.db');
    expect(BACKUP_FILE.test(name)).toBe(true);
  });

  it('pads single-digit fields', () => {
    expect(backupFileName(new Date(2026, 0, 5, 3, 7))).toBe('ducat-2026-01-05-0307.db');
  });
});

describe('planRetention', () => {
  it('keeps everything when fewer than the daily quota of dates exist', () => {
    const files = [fileFor(0), fileFor(1), fileFor(2), fileFor(9)];
    const plan = planRetention(files);
    expect(plan.keep.sort()).toEqual([...files].sort());
    expect(plan.remove).toEqual([]);
  });

  it('keeps every file of a kept date, not just the newest — a manual backup beside the scheduled one survives', () => {
    const files = [fileFor(0, '1854'), fileFor(0, '2350'), fileFor(1)];
    const plan = planRetention(files);
    expect(plan.keep.sort()).toEqual([...files].sort());
    expect(plan.remove).toEqual([]);
  });

  it('counts distinct DATES, not files: a week of downtime still leaves 14 restore points', () => {
    // 20 distinct dates; the 6 oldest fall past the daily window.
    const files = Array.from({ length: 20 }, (_, i) => fileFor(i));
    const plan = planRetention(files);
    const keptDaily = files.slice(0, DAILY_DATES_KEPT);
    for (const f of keptDaily) expect(plan.keep).toContain(f);
    // The 6 older dates are all in the same month here → newest of them survives.
    expect(plan.keep).toContain(files[DAILY_DATES_KEPT]);
    expect(plan.remove.sort()).toEqual(files.slice(DAILY_DATES_KEPT + 1).sort());
  });

  it('keeps the newest file per month beyond the daily window', () => {
    const recent = Array.from({ length: DAILY_DATES_KEPT }, (_, i) => fileFor(i));
    const juneOld = 'ducat-2026-06-03-2350.db';
    const juneNew = 'ducat-2026-06-28-2350.db';
    const may = 'ducat-2026-05-31-2350.db';
    const plan = planRetention([...recent, juneOld, juneNew, may]);
    expect(plan.keep).toContain(juneNew);
    expect(plan.keep).toContain(may);
    expect(plan.remove).toEqual([juneOld]);
  });

  it('same-date files beyond the window: the later TIME is the month keeper', () => {
    const recent = Array.from({ length: DAILY_DATES_KEPT }, (_, i) => fileFor(i));
    const early = 'ducat-2026-06-28-0910.db';
    const late = 'ducat-2026-06-28-2350.db';
    const plan = planRetention([...recent, early, late]);
    expect(plan.keep).toContain(late);
    expect(plan.remove).toEqual([early]);
  });

  it('never touches names outside the exact pattern — including quarantined failures', () => {
    const foreign = [
      'backup.log',
      'ducat.db',
      'ducat-superseded-20260804.db',
      'ducat-2026-08-04-1854.db.tmp',
      'notes.txt',
      // What a crashed or failed run leaves behind: these must NEVER become
      // candidates, or a corrupt leftover can be elected a month's keeper.
      'ducat-2026-08-04-2350.db.partial',
      'ducat-2026-08-04-2350.db.unverified',
    ];
    const plan = planRetention([...foreign, fileFor(0)]);
    expect(plan.ignored.sort()).toEqual([...foreign].sort());
    expect(plan.remove).toEqual([]);
  });

  it('keep and remove partition the dated set — nothing is dropped from the plan', () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => fileFor(i)),
      'ducat-2026-05-01-0100.db',
      'ducat-2026-05-20-0100.db',
      'ducat-2026-04-11-0100.db',
    ];
    const plan = planRetention(files);
    expect([...plan.keep, ...plan.remove].sort()).toEqual([...files].sort());
    expect(plan.keep.filter((f) => plan.remove.includes(f))).toEqual([]);
  });

  it("today's real directory listing survives untouched — the first live run deletes nothing", () => {
    const plan = planRetention(['ducat-2026-07-26-2145.db', 'ducat-2026-08-04-1854.db', 'ducat-2026-08-04-1903.db']);
    expect(plan.remove).toEqual([]);
  });
});
