import { prisma } from "../prisma";
import { periodCoverage, type AccountCoverage, type PeriodCoverage } from "../insights/coverage";

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

/** Coverage for one period, or null when there's nothing to warn about. */
export async function getPeriodCoverage(period: string): Promise<PeriodCoverage | null> {
  if (period === "") return null;
  const accounts = await getAccountCoverage();
  if (accounts.length === 0) return null;
  try {
    const coverage = periodCoverage(period, accounts);
    return coverage.complete ? null : coverage;
  } catch {
    return null; // unparseable period key — nothing useful to say
  }
}
