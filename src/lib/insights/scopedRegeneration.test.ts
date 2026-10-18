import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDatabase, type TempDatabase } from '../demo/tempDatabase';
import { reseedDemo } from '../demo/reseed';
import { generateInsights, SCOPE_LOOKBACK_MONTHS } from './engine';
import { monthKeyBack } from './periods';
import { earliestTouched, regenerateForRows } from './scope';

/**
 * A scoped run after an edit must leave the Insight table exactly as a full
 * run would: same rows, same payloads to the byte, same dismissals. The edits
 * below are random (a fixed seed), across the whole history and both flows, so
 * a cross-period dependency the margin does not cover shows up as a
 * difference between the two dumps.
 */

const NOW = new Date('2026-03-15T12:00:00Z');

let db: TempDatabase;

async function dump(): Promise<string> {
  const rows = await db.prisma.insight.findMany();
  return JSON.stringify(
    rows
      .map((r) => ({ type: r.type, period: r.period, payload: r.payload, dismissed: r.dismissed }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** Small deterministic generator: the same edits every run. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

beforeAll(async () => {
  db = await createTempDatabase('scoped');
  await reseedDemo(db.prisma, NOW);
}, 120_000);

afterAll(async () => {
  await db.dispose();
});

describe('scoped regeneration', () => {
  it('writes the rows a full run writes, for edits anywhere in the history', async () => {
    const { prisma } = db;
    const categories = await prisma.category.findMany({ select: { id: true } });
    const all = await prisma.transaction.findMany({
      where: { flow: { not: 'TRANSFER' } },
      select: { id: true, date: true, flow: true },
      orderBy: { date: 'asc' },
    });
    const pick = lcg(7);
    const chosen = [
      all[0], // the very first row on record
      all[all.length - 1], // the newest
      ...Array.from({ length: 6 }, () => all[Math.floor(pick() * all.length)]),
      ...Array.from({ length: 3 }, () => all.filter((t) => t.flow === 'INFLOW')[Math.floor(pick() * 40)]),
    ];

    // A dismissal the carry-forward must keep, in a scoped period and outside it.
    const anomalies = await prisma.insight.findMany({ where: { type: 'ANOMALY' }, orderBy: { period: 'asc' } });
    expect(anomalies.length).toBeGreaterThan(2);
    await prisma.insight.update({ where: { id: anomalies[0].id }, data: { dismissed: true } });
    await prisma.insight.update({ where: { id: anomalies[anomalies.length - 1].id }, data: { dismissed: true } });

    for (const t of chosen) {
      const category = categories[Math.floor(pick() * categories.length)];
      await prisma.transaction.update({ where: { id: t.id }, data: { categoryId: category.id, categorySource: 'MANUAL' } });
      await regenerateForRows(prisma, { id: t.id });
      const scoped = await dump();
      await generateInsights(prisma);
      expect(scoped, `edit of ${t.date.toISOString().slice(0, 10)}`).toBe(await dump());
    }
  }, 240_000);

  it('rewrites only the periods in scope', async () => {
    const { prisma } = db;
    const all = await prisma.insight.findMany({ select: { id: true, period: true } });
    const newest = (await prisma.transaction.aggregate({ _max: { date: true } }))._max.date!;
    const idsBefore = new Map(all.map((r) => [r.id, r.period]));
    await generateInsights(prisma, { since: newest });
    const after = await prisma.insight.findMany({ select: { id: true, period: true } });
    const floor = monthKeyBack(newest, SCOPE_LOOKBACK_MONTHS);
    const untouched = after.filter((r) => idsBefore.get(r.id) !== undefined);
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.every((r) => r.period < floor)).toBe(true);
    expect(after.length).toBe(all.length);
  }, 120_000);

  it('carries a dismissal across a scoped run, and clears stray granularities on a full one', async () => {
    const { prisma } = db;
    const target = await prisma.insight.findFirstOrThrow({ where: { type: 'RECURRING_CHARGE' } });
    await prisma.insight.update({ where: { id: target.id }, data: { dismissed: true } });
    await prisma.insight.createMany({
      data: ['2026-W10', '2026-Q1', '2026'].map((period) => ({ type: 'CASH_FLOW_TREND', period, payload: {}, dismissed: false })),
    });
    const newest = (await prisma.transaction.aggregate({ _max: { date: true } }))._max.date!;
    await generateInsights(prisma, { since: newest });
    const kept = await prisma.insight.findMany({ where: { type: 'RECURRING_CHARGE', dismissed: true } });
    expect(kept.map((r) => (r.payload as { merchant: string }).merchant)).toContain((target.payload as { merchant: string }).merchant);
    // A scoped run leaves other tables' strays alone; the full run removes them.
    expect(await prisma.insight.count({ where: { period: { in: ['2026-W10', '2026-Q1', '2026'] } } })).toBe(3);
    await generateInsights(prisma);
    expect(await prisma.insight.count({ where: { period: { in: ['2026-W10', '2026-Q1', '2026'] } } })).toBe(0);
  }, 120_000);

  it('runs in full when the edit touched no row', async () => {
    expect(await earliestTouched(db.prisma, { id: 'no-such-row' })).toBeNull();
  });
});
