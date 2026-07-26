import type { TransactionFlow } from '../../types/contracts';

/**
 * P2P payment processors: the payment rail says nothing about what the
 * money was FOR ("ZELLE TO JOHN SMITH" could be rent or a reimbursement),
 * so automated rules in the pack/heuristic bands never categorize these —
 * only explicit user rules (priority < USER_PRIORITY_MAX) may.
 */
export const P2P_PATTERN =
  /\b(zelle|venmo|cash ?app|paypal|apple cash|google pay|western union|moneygram|wire transfer)\b/i;

/** Rules below this priority are user-authored and may categorize P2P. */
export const USER_PRIORITY_MAX = 100;

/** Plain shapes so the matcher stays pure and unit-testable. */
export interface RuleData {
  id: string;
  priority: number; // lower number = higher priority
  matchField: 'MERCHANT' | 'DESCRIPTION' | 'AMOUNT' | 'ACCOUNT';
  matchOperator: 'CONTAINS' | 'EQUALS' | 'REGEX' | 'GT' | 'LT';
  matchValue: string;
  /** null = flow-only rule (e.g. "this payee is a TRANSFER", which carries no category). */
  setCategoryId: string | null;
  setFlow: TransactionFlow | null;
  enabled: boolean;
}

export interface RuleTxn {
  id: string;
  amount: number; // signed
  description: string;
  normalizedMerchant: string;
  accountName: string;
  categorySource: 'AGGREGATOR' | 'RULE' | 'MANUAL';
}

/**
 * A stored transaction row as applyRules wants it: Decimal to number, the
 * account's name flattened. Written once here rather than in each caller —
 * sync.ts and rulePack.ts had byte-identical copies. Structural parameter
 * types keep this module Prisma-free, which is what makes it testable as a
 * pure function.
 */
export function toRuleTxns(
  rows: {
    id: string;
    amount: unknown;
    description: string;
    normalizedMerchant: string;
    categorySource: string;
    account: { name: string };
  }[],
): RuleTxn[] {
  return rows.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    description: t.description,
    normalizedMerchant: t.normalizedMerchant,
    accountName: t.account.name,
    categorySource: t.categorySource as RuleTxn['categorySource'],
  }));
}

export interface RuleApplication {
  txnId: string;
  ruleId: string;
  categoryId: string | null;
  flow: TransactionFlow | null;
}

/** Lowercase and squeeze runs of whitespace, so bank padding can't defeat a match. */
function collapse(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matches(rule: RuleData, txn: RuleTxn): boolean {
  if (rule.matchField === 'AMOUNT') {
    // Numeric comparisons run against the SIGNED amount: "GT -50" means
    // outflows smaller than $129.59, "LT -500" means outflows over $500.
    const target = Number(rule.matchValue);
    if (!Number.isFinite(target)) return false;
    switch (rule.matchOperator) {
      case 'EQUALS':
        return txn.amount === target;
      case 'GT':
        return txn.amount > target;
      case 'LT':
        return txn.amount < target;
      default:
        return false; // CONTAINS/REGEX are meaningless for numbers
    }
  }

  const value =
    rule.matchField === 'MERCHANT' ? txn.normalizedMerchant
    : rule.matchField === 'DESCRIPTION' ? txn.description
    : txn.accountName;
  switch (rule.matchOperator) {
    // Whitespace is collapsed on BOTH sides. Banks pad descriptions into fixed
    // columns — Wells Fargo writes "ZELLE TO  LENA" and "WF Credit Card   AUTO
    // PAY" — while every payee string the app derives has its runs collapsed.
    // Comparing them literally means a rule the user just created silently
    // matches nothing. REGEX is left raw so an author's own \s+ still applies.
    case 'CONTAINS':
      return collapse(value).includes(collapse(rule.matchValue));
    case 'EQUALS':
      return collapse(value) === collapse(rule.matchValue);
    case 'REGEX':
      try {
        return new RegExp(rule.matchValue, 'i').test(value);
      } catch {
        return false; // a malformed user regex must not break the sync
      }
    default:
      return false; // GT/LT are meaningless for strings
  }
}

/**
 * First matching rule by ascending priority wins. MANUAL categorizations
 * are never overridden — a human already decided.
 */
export function applyRules(rules: RuleData[], txns: RuleTxn[]): RuleApplication[] {
  const active = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  const applications: RuleApplication[] = [];
  for (const txn of txns) {
    if (txn.categorySource === 'MANUAL') continue;
    const isP2p = P2P_PATTERN.test(txn.normalizedMerchant) || P2P_PATTERN.test(txn.description);
    const applicable = isP2p ? active.filter((r) => r.priority < USER_PRIORITY_MAX) : active;
    const rule = applicable.find((r) => matches(r, txn));
    if (rule !== undefined) {
      applications.push({
        txnId: txn.id,
        ruleId: rule.id,
        categoryId: rule.setCategoryId,
        flow: rule.setFlow,
      });
    }
  }
  return applications;
}
