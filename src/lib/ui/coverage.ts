import { prisma } from "../prisma";
import { periodCoverage, type AccountCoverage, type PeriodCoverage } from "../insights/coverage";
import { periodEndExclusive, periodStart } from "../insights/periods";

/** Each account's earliest transaction — how far back its history actually reaches. */
export async function getAccountCoverage(): Promise<AccountCoverage[]> {
  const [accounts, firsts] = await Promise.all([
    prisma.account.findMany({ select: { id: true, name: true } }),
    prisma.transaction.groupBy({ by: ["accountId"], _min: { date: true } }),
  ]);
  const firstByAccount = new Map(firsts.map((f) => [f.accountId, f._min.date]));
  return accounts.map((a) => ({
    accountId: a.id,
    name: a.name,
    firstTransaction: firstByAccount.get(a.id) ?? null,
  }));
}

/**
 * Coverage for one period, or null when there's nothing to warn about.
 *
 * Loads what each short account actually contributed, because a count of
 * accounts is not a magnitude: the notice once shouted about a transit card
 * holding $104.32 of a $11,009.59 month in exactly the tone it would use for a
 * missing mortgage. The extra query only runs when coverage is incomplete, so
 * a fully-covered period still costs one round trip.
 */
export async function getPeriodCoverage(period: string): Promise<PeriodCoverage | null> {
  if (period === "") return null;
  const accounts = await getAccountCoverage();
  if (accounts.length === 0) return null;
  // The catch covers the PARSE and nothing else. It used to wrap the query
  // below as well, which turned a database failure into a silently absent
  // coverage notice — on the one notice whose job is to say data is missing,
  // and on the two pages (/trends, /insights) that would otherwise now name
  // the condition. Narrowed 2026-08-06 alongside the unreachable state.
  let rough: PeriodCoverage;
  try {
    rough = periodCoverage(period, accounts);
  } catch {
    return null; // unparseable period key — nothing useful to say
  }
  if (rough.complete) return null;

  const spend = await prisma.transaction.groupBy({
    by: ["accountId"],
    where: {
      flow: "OUTFLOW",
      date: { gte: periodStart(period), lt: periodEndExclusive(period) },
    },
    _sum: { amount: true },
  });
  const byAccount = new Map(spend.map((s) => [s.accountId, Math.abs(Number(s._sum.amount ?? 0))]));
  return periodCoverage(
    period,
    accounts.map((a) => ({ ...a, periodSpending: byAccount.get(a.accountId) ?? 0 })),
  );
}
