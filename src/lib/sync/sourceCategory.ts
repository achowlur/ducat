import { isP2P } from '../p2p';
import { isClosedBox } from './closedBox';

/**
 * The category a SOURCE assigned (a card issuer's export), when the pipeline
 * may use it. Shared by the import and its dry run, so the preview counts
 * exactly what the import writes.
 *
 * A rule outranks it: the operator's own rules are their decisions, and the
 * pack's names are measured. A P2P payment is never categorized unseen, by a
 * bank any more than by a rule (merchants-and-rules.md). A row inside an
 * investment account is the closed box's, and a transfer has no category.
 */
export function sourceCategoryToApply(
  t: { sourceCategory?: string; description: string; normalizedMerchant: string; flow: string },
  accountType: string | null | undefined,
  ruleApplied: boolean,
): string | null {
  if (t.sourceCategory === undefined || t.sourceCategory === '' || ruleApplied) return null;
  if (t.flow === 'TRANSFER' || isClosedBox(accountType) || isP2P(t)) return null;
  return t.sourceCategory;
}
