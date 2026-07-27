import type { ConnectorType } from '../../types/contracts';
import type { ProviderTrustCard } from './types';

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
export const PROVIDER_TRUST_CARDS: Record<ConnectorType, ProviderTrustCard> = {
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
};
