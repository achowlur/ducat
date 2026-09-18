import { describe, expect, it } from 'vitest';
import {
  makeCandidateFinder,
  REIMBURSE_CANDIDATE_LIMIT,
  REIMBURSE_LEAD_DAYS,
  REIMBURSE_WINDOW_DAYS,
  type PoolOutflow,
  REIMBURSE_SEARCH_LIMIT,
  searchCandidates,
} from './reimburseCandidates';

const DAY_MS = 86_400_000;
const day = (d: number) => new Date(Date.UTC(2026, 6, d, 12));

const out = (
  id: string,
  amount: number,
  d: number,
  extra: Partial<PoolOutflow> = {},
): PoolOutflow => ({
  id,
  amount: -amount,
  date: day(d),
  categoryId: null,
  normalizedMerchant: `merchant ${id}`,
  description: `DESC ${id.toUpperCase()}`,
  ...extra,
});

const CATEGORY_NAMES: Record<string, string> = { dining: 'Dining', rent: 'Rent & Housing' };
const categoryName = (categoryId: string | null): string | null =>
  categoryId === null ? null : (CATEGORY_NAMES[categoryId] ?? null);

describe('makeCandidateFinder', () => {
  // Pins the full projection — candidates, ORDER, and wording — because this
  // exact output now reaches the picker by two routes (embedded hint on the
  // page, suggestCandidates on open) and both must keep producing it.
  it('projects ranked candidates with labels, categories and evidence wording, in order', () => {
    const finder = makeCandidateFinder(
      [
        out('rent', 2000, 19, { categoryId: 'rent' }),
        out('dinner', 90, 17, { categoryId: 'dining' }),
        out('groceries', 30.01, 18),
      ],
      categoryName,
    );
    const candidates = finder({ amount: 30, date: day(20) });
    expect(candidates).toEqual([
      {
        id: 'dinner',
        label: 'Merchant Dinner',
        date: '2026-07-17',
        amount: 90,
        category: 'Dining',
        reason: '1/3 of $90.00',
        strong: true,
      },
      // Rent survives as weak "part of" evidence only: UNSPLITTABLE denies it
      // split arithmetic, so a clean 1/n of the rent is never claimed. It
      // sorts above groceries by date proximity — both carry the same weak
      // amount score, and rent is a day nearer.
      {
        id: 'rent',
        label: 'Merchant Rent',
        date: '2026-07-19',
        amount: 2000,
        category: 'Rent & Housing',
        reason: 'part of $2000.00',
        strong: false,
      },
      {
        id: 'groceries',
        label: 'Merchant Groceries',
        date: '2026-07-18',
        amount: 30.01,
        category: null,
        reason: 'part of $30.01',
        strong: false,
      },
    ]);
  });

  it('falls back to the description for a merchantless outflow', () => {
    const finder = makeCandidateFinder(
      [out('x', 45, 18, { normalizedMerchant: '' })],
      categoryName,
    );
    expect(finder({ amount: 45, date: day(20) })[0].label).toBe('Desc X');
  });

  /**
   * The inflow-side mirror of UNSPLITTABLE. Every strong hint on ledger page 1
   * was a brokerage dividend, two of them inside IRAs — the arithmetic worked
   * in each case, which is exactly why an arithmetic guard was never going to
   * catch it.
   */
  it('offers nothing for an inflow into an investment account', () => {
    const finder = makeCandidateFinder([out('dinner', 90, 17, { categoryId: 'dining' })], categoryName);
    expect(finder({ amount: 30, date: day(20) })).toHaveLength(1);
    expect(finder({ amount: 30, date: day(20), accountType: 'INVESTMENT' })).toEqual([]);
    expect(finder({ amount: 30, date: day(20), accountType: 'DEPOSITORY' })).toHaveLength(1);
  });

  /**
   * The picker used to print the RAIL as a candidate name, reintroducing
   * inside itself the unreviewable string the ledger's merchant column exists
   * to replace.
   */
  it('names the P2P counterparty, not the rail', () => {
    const finder = makeCandidateFinder(
      [
        out('z', 45, 18, {
          normalizedMerchant: 'zelle transfer',
          description: 'ZELLE TO FAIRLEY ROBIN ON 07/18 REF # PP0AAAAAAA',
        }),
      ],
      categoryName,
    );
    const [only] = finder({ amount: 45, date: day(20) });
    expect(only.label).not.toBe('Zelle Transfer');
    expect(only.label).toContain('Fairley');
  });

  it('denies split evidence to UNSPLITTABLE categories but allows repayment in full', () => {
    const finder = makeCandidateFinder([out('rent', 1750, 18, { categoryId: 'rent' })], categoryName);
    const [full] = finder({ amount: 1750, date: day(20) });
    expect(full).toMatchObject({ reason: 'exact amount', strong: true });
    const [part] = finder({ amount: 875, date: day(20) });
    expect(part).toMatchObject({ reason: 'part of $1750.00', strong: false });
  });

  // The picker offers more than the ranker's default five, and the two things
  // that raise has to leave alone are the CAP and the HINT: the panel must stay
  // a panel, and the collapsed dot on the row takes [0], which a longer list
  // shares with a shorter one.
  it('offers up to REIMBURSE_CANDIDATE_LIMIT candidates, keeping a match five slots would cut', () => {
    // Amounts near 45×5 with a 2% slack read as approximate fifths, so these
    // are STRONG and recent — the only thing that can outrank a strong older
    // match, and what the real ledger is full of.
    const pool = Array.from({ length: 30 }, (_, i) => out(`o${i}`, 200 + i, 20 - (i % 20)));
    // A clean 1/3, three weeks back. Its evidence is better and its date worse.
    pool.push(out('dinner', 135, 1, { categoryId: 'dining' }));
    const candidates = makeCandidateFinder(pool, categoryName)({ amount: 45, date: day(22) });

    expect(candidates).toHaveLength(REIMBURSE_CANDIDATE_LIMIT);
    const dinner = candidates.findIndex((c) => c.id === 'dinner');
    expect(dinner).toBeGreaterThanOrEqual(5); // five slots would have dropped it
    expect(candidates[dinner]).toMatchObject({ reason: '1/3 of $135.00', strong: true });
    // Strong evidence still never sorts below weak, however recent the weak one is.
    const firstWeak = candidates.findIndex((c) => !c.strong);
    if (firstWeak !== -1) expect(candidates.slice(firstWeak).every((c) => !c.strong)).toBe(true);
  });

  // The property the lazy picker depends on: the page ranks against ONE pool
  // spanning every inflow on the page, while the on-open action fetches only
  // the opened inflow's window. The ranker zeroes date evidence outside the
  // window and filtering preserves order, so both pools must produce the
  // IDENTICAL list for the same inflow.
  it('returns identical candidates from the page-wide pool and the per-inflow window pool', () => {
    // Two inflows three weeks apart make the page pool span ~66 days.
    const inflows = [
      { amount: 45, date: day(24) },
      { amount: 30, date: day(3) },
    ];
    const widePool = [
      out('a', 45, 23),
      out('b', 90, 20, { categoryId: 'dining' }),
      out('c', 2000, 19, { categoryId: 'rent' }),
      out('d', 45, 2),
      out('e', 60, 1),
      out('f', 45, -25), // June 5 — outside inflow 1's 45-day window, inside inflow 2's
      out('g', 120, 26), // after inflow 1 but within its lead
      out('h', 45, 70), // past BOTH inflows' 30-day lead — only the page pool holds it
    ];
    for (const inflow of inflows) {
      const narrowPool = widePool.filter(
        (o) =>
          o.date.getTime() >= inflow.date.getTime() - REIMBURSE_WINDOW_DAYS * DAY_MS &&
          o.date.getTime() <= inflow.date.getTime() + REIMBURSE_LEAD_DAYS * DAY_MS,
      );
      expect(narrowPool.length).toBeLessThan(widePool.length); // the test bites
      const fromWide = makeCandidateFinder(widePool, categoryName)(inflow);
      const fromNarrow = makeCandidateFinder(narrowPool, categoryName)(inflow);
      expect(fromWide.length).toBeGreaterThan(0);
      expect(fromNarrow).toEqual(fromWide);
    }
  });
});

describe('the picker', () => {
  // Invented figures, same shape as the case that prompted this: a repayment
  // that is no clean share of its expense, landing the day BEFORE the charge
  // posts, among plenty of older weak matches.
  const repayment = { amount: 17.2, date: day(14) };
  const dinner = out('dinner', 52.6, 15, { categoryId: 'dining', normalizedMerchant: 'harbor grill', description: 'HARBOR GRILL' });
  const noise = Array.from({ length: 24 }, (_, i) => out(`n${i}`, 60 + i * 7, 13 - (i % 12)));

  it('offers a next-day charge that is only "part of" the amount, among older weak matches', () => {
    const offered = makeCandidateFinder([...noise, dinner], categoryName)(repayment);
    expect(offered.map((c) => c.id)).toContain('dinner');
  });

  it('finds any expense in the window by merchant, description or amount', () => {
    const pool = [...noise, dinner];
    for (const q of ['harbor', 'GRILL', '52.60', '52', '$52.6']) {
      expect(searchCandidates(pool, categoryName, repayment, q).map((c) => c.id), q).toContain('dinner');
    }
    expect(searchCandidates(pool, categoryName, repayment, 'harbor')[0]).toMatchObject({
      id: 'dinner',
      amount: 52.6,
      category: 'Dining',
      label: 'Harbor Grill',
    });
  });

  it('ignores the amount rule — even an expense smaller than the repayment can be found', () => {
    const small = out('small', 9.5, 12, { normalizedMerchant: 'corner cafe', description: 'CORNER CAFE' });
    expect(makeCandidateFinder([small], categoryName)(repayment)).toEqual([]); // ranking refuses it
    expect(searchCandidates([small], categoryName, repayment, 'corner').map((c) => c.id)).toEqual(['small']);
    expect(searchCandidates([small], categoryName, repayment, 'corner')[0].reason).toBe('found by search');
  });

  it('lists matches closest in time first, capped, and needs two characters', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      out(`m${i}`, 20, 14 - Math.floor(i / 2), { normalizedMerchant: 'metro market', description: 'METRO MARKET' }),
    );
    const found = searchCandidates(many, categoryName, repayment, 'metro');
    expect(found).toHaveLength(REIMBURSE_SEARCH_LIMIT);
    const gaps = found.map((c) => Math.abs(Date.parse(c.date) - repayment.date.getTime()));
    expect([...gaps].sort((a, b) => a - b)).toEqual(gaps);
    expect(searchCandidates(many, categoryName, repayment, 'm')).toEqual([]);
    expect(searchCandidates(many, categoryName, repayment, '  ')).toEqual([]);
  });
});
