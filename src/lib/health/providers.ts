import type { ProviderId, ProviderTrustCard } from './types';
import { FRED_SERIES_ID, FRED_SERIES_TITLE } from '../rates/mortgageRate';

/**
 * Every third-party data provider the app can use, with standing risk
 * context. Add a card here when adding a connector — the health panel
 * refuses to render a provider it has no card for.
 *
 * A card describes the CONNECTOR — how data reaches the app, and what you are
 * trusting to get it here. Where the data then RESTS is a property of the
 * deployment, not of the connector, and is stated once on `/providers` from
 * `isCloudMode()`. Keeping that split is what stopped these cards claiming
 * "fully local" from a cloud instance.
 */
export const PROVIDER_TRUST_CARDS: Record<ProviderId, ProviderTrustCard> = {
  SIMPLEFIN: {
    connectorType: 'SIMPLEFIN',
    displayName: 'SimpleFIN Bridge',
    dataPath:
      'Your bank → MX (upstream aggregator) → SimpleFIN Bridge → this app (read-only feed). ' +
      'Bank credentials live only in the aggregator\'s hosted flow — never in this app.',
    residualRisks: [
      'MX-level bugs (like the 2025-05-28 incident) can corrupt or stall the feed — rare, but demonstrated non-zero. Detected here only by its symptoms: stale balances and transaction gaps.',
      'Key-person risk: SimpleFIN Bridge is maintained by one person (Matt Haggard). If maintenance stops the service degrades; exposure is capped at read-only data and ~$15/yr.',
      'Your transaction history exists on MX\'s and SimpleFIN\'s servers at all times — inherent to any aggregator, including Plaid.',
    ],
    revocation:
      'Delete the app in the SimpleFIN Bridge dashboard (bridge.simplefin.org) — the access URL dies instantly. Then remove SIMPLEFIN_ACCESS_URL from wherever this instance reads its environment, so it cannot be put back by accident.',
  },
  CSV: {
    connectorType: 'CSV',
    displayName: 'CSV import',
    dataPath:
      'Bank export file on your disk → this app. No third party is involved in the transfer: the file is read directly and nothing about it is sent anywhere.',
    residualRisks: [
      'Manual and point-in-time: data is only as fresh as your last export, and balances are unknown when the export lacks a running-balance column.',
    ],
    revocation: 'Nothing to revoke — delete the CSV files when done importing.',
  },
  FRED: {
    connectorType: 'FRED',
    displayName: 'FRED mortgage-rate index',
    dataPath:
      `Optimal Blue (daily rate-lock averages) → FRED, the Federal Reserve Bank of St. Louis → this app: one small GET per sync for the latest ${FRED_SERIES_TITLE} (${FRED_SERIES_ID}) observation, stored locally and rendered from the store. ` +
      'The request carries your FRED API key and the series id — no account, transaction, or balance data ever rides it, in either direction.',
    residualRisks: [
      'The API key is a persistent identity: FRED can see that this key asked for this series at your sync times, from your IP. That is the whole exposure — the request body names no money.',
      'A national average is nobody\'s actual rate. The readiness panel treats the index as a stand-in and a typed personal quote always overrides it; the disclosure names the series so the two cannot be confused.',
      'The series can stall (holiday, publication change, revoked key) while the app keeps rendering the last stored observation — dated, and flagged by provider health once it ages past the alarm.',
    ],
    revocation:
      'Remove FRED_API_KEY from wherever this instance reads its environment — the fetch is gated on it and stops immediately, keeping the last stored observation. Delete the key itself at fredaccount.stlouisfed.org to revoke it everywhere.',
  },
};
