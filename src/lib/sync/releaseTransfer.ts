import { flowByAmount, isClosedBox } from './closedBox';

/**
 * A transfer flagged by WORDING is a guess about a payee, and one payment from
 * that payee can be something else: a person who usually moves money between
 * their own accounts sends a Zelle that pays back cash withdrawn for them.
 * The ledger offered that row nothing (a transfer carries no category control
 * and the reimbursement picker is for INFLOW rows), so the repayment could not
 * be linked at all.
 *
 * Releasing gives the row the flow its own amount has and marks it MANUAL
 * (its category still empty): a rule that matched by wording never re-flags a
 * row a person decided, and pairing skips MANUAL rows the same way. A sync
 * will not take the decision back.
 *
 * Only a transfer flagged by WORDS is released. A row paired with its other
 * side in another account is one movement of the operator's own money, seen
 * from both ends, and inside an investment account every row is a transfer by
 * the account's type (closedBox.ts), not by any rule a person can disagree
 * with one row at a time.
 */
export type ReleaseDecision =
  | { ok: true; data: { flow: 'INFLOW' | 'OUTFLOW'; categoryId: null; categorySource: 'MANUAL' } }
  | { ok: false; message: string };

export function releaseTransfer(row: {
  flow: string;
  amount: number;
  transferPairId: string | null;
  accountType: string | null | undefined;
}): ReleaseDecision {
  if (row.flow !== 'TRANSFER') {
    return { ok: false, message: 'This row is no longer a transfer. Reload to see it as it is now.' };
  }
  if (isClosedBox(row.accountType)) {
    return { ok: false, message: 'Inside an investment account every row is a transfer by the account, not by a rule.' };
  }
  if (row.transferPairId !== null) {
    return { ok: false, message: 'This transfer is paired with its other side in another account, so it stays one.' };
  }
  return { ok: true, data: { flow: flowByAmount(row.amount), categoryId: null, categorySource: 'MANUAL' } };
}
