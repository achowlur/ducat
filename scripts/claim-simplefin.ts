import 'dotenv/config';
import { claimSetupToken } from '../src/lib/connectors/simplefin';

/**
 * Exchanges a one-time SimpleFIN setup token for a permanent access URL.
 * The access URL is printed for you to paste into .env — this script
 * deliberately never writes secrets to files itself.
 *
 * Usage: npm run simplefin:claim -- <setup-token>
 */
async function main(): Promise<void> {
  const token = process.argv[2];
  if (token === undefined || token.trim() === '') {
    console.error('Usage: npm run simplefin:claim -- <setup-token>');
    console.error('Get a setup token at https://bridge.simplefin.org (New App / setup token).');
    process.exit(1);
  }

  const accessUrl = await claimSetupToken(token);
  console.log('Success! Add this line to your .env file (never commit it):\n');
  console.log(`SIMPLEFIN_ACCESS_URL="${accessUrl}"`);
  console.log('\nThen run: npm run sync:simplefin');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
