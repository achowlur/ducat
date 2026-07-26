import 'dotenv/config';
import { getProviderHealth } from '../src/lib/health/health';
import { getSubscriptionStatuses } from '../src/lib/health/subscriptions';
import { prisma } from '../src/lib/prisma';

/**
 * Prints what the Session 5 launch panel will render: per-provider status
 * from local signals, trust cards, and tracked-subscription reconciliation.
 * Usage: npm run health
 */
async function main(): Promise<void> {
  const providers = await getProviderHealth(prisma);
  console.log('=== Provider health ===\n');
  if (providers.length === 0) {
    console.log('No providers in use yet.');
  }
  for (const p of providers) {
    console.log(`[${p.status}] ${p.trustCard.displayName} (${p.accountCount} accounts)`);
    for (const reason of p.reasons) console.log(`  - ${reason}`);
    if (p.lastSync !== null) {
      console.log(`  Last sync: ${p.lastSync.at.toISOString()} (${p.lastSync.ok ? 'ok' : 'FAILED'})`);
    }
    console.log(`  Data path: ${p.trustCard.dataPath}`);
    console.log('  Residual risks you are accepting:');
    for (const risk of p.trustCard.residualRisks) console.log(`    * ${risk}`);
    console.log(`  Revocation: ${p.trustCard.revocation}\n`);
  }

  const subs = await getSubscriptionStatuses(prisma);
  console.log('=== Tracked subscriptions ===\n');
  if (subs.length === 0) {
    console.log('None registered.');
  }
  for (const s of subs) {
    console.log(`${s.name}: $${s.expectedAmount} ${s.cadence}`);
    console.log(`  Next payment: ${s.nextPaymentDate.toISOString().slice(0, 10)} (in ${s.daysUntilNextPayment} days)`);
    if (s.lastCharge !== null) {
      console.log(`  Last charge: $${s.lastCharge.amount} on ${s.lastCharge.date.toISOString().slice(0, 10)}`);
    }
    if (s.priceDrift !== null) {
      const delta = s.priceDrift.deltaPct;
      const pct = delta === null ? "n/a" : `${(delta * 100).toFixed(1)}%`;
      console.log(`  !! PRICE CHANGE: expected $${s.priceDrift.expected}, charged $${s.priceDrift.actual} (${pct})`);
    }
    console.log('');
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
