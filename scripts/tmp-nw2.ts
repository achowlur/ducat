import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
async function main(): Promise<void> {
  const rows = await prisma.insight.findMany({ where: { type: 'NET_WORTH_GROWTH' }, orderBy: { period: 'asc' } });
  const m = rows.filter((r) => r.period.length === 7);
  console.log(`net worth points: ${m.length}\n`);
  console.log('period    net worth      change    market gains   inv flows');
  for (const r of m) {
    const p = r.payload as { netWorth: number; previousNetWorth: number | null; marketGains: number | null; investmentNetFlows: number };
    const chg = p.previousNetWorth === null ? '' : `${p.netWorth - p.previousNetWorth >= 0 ? '+' : ''}${(p.netWorth - p.previousNetWorth).toFixed(0)}`;
    console.log(`${r.period}  ${p.netWorth.toFixed(2).padStart(12)}  ${chg.padStart(9)}  ${(p.marketGains ?? 0).toFixed(2).padStart(12)}  ${p.investmentNetFlows.toFixed(2).padStart(10)}`);
  }
}
main().catch((e: unknown) => console.error(e)).finally(() => prisma.$disconnect());
