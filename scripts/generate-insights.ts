import 'dotenv/config';
import { generateInsights } from '../src/lib/insights/engine';
import { prisma } from '../src/lib/prisma';
import type { PeriodGranularity } from '../src/types/contracts';

const GRANULARITIES: PeriodGranularity[] = ['WEEK', 'MONTH', 'QUARTER', 'YEAR'];

function parseGranularity(): PeriodGranularity {
  const arg = process.argv.find((a) => a.startsWith('--granularity='))?.split('=')[1] ?? 'MONTH';
  const upper = arg.toUpperCase() as PeriodGranularity;
  if (!GRANULARITIES.includes(upper)) {
    console.error(`Unknown granularity "${arg}". Use one of: ${GRANULARITIES.join(', ')}`);
    process.exit(1);
  }
  return upper;
}

async function main(): Promise<void> {
  const granularity = parseGranularity();
  const result = await generateInsights(prisma, { granularity });

  console.log(`Generated ${result.created} insights at ${result.granularity} granularity`);
  console.log(`Periods: ${result.periods[0]} .. ${result.periods[result.periods.length - 1]} (${result.periods.length})`);
  console.log('By type:', result.byType);

  const latest = result.periods[result.periods.length - 1];
  const sample = await prisma.insight.findMany({
    where: { period: latest },
    orderBy: { type: 'asc' },
  });
  console.log(`\nInsights for ${latest}:`);
  for (const row of sample) {
    console.log(`\n[${row.type}]`);
    console.log(JSON.stringify(row.payload, null, 2));
  }
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
