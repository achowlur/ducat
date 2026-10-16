import { payeeKey } from './grouping';
import { suggestP2PCategories, type SuggestionReason } from './p2pSuggest';
import { PACK_RULES } from './rulePack';
import type { RuleData } from './rules';

/**
 * A suggested category for each payee waiting in the grouped review, so a long
 * backlog is read and confirmed rather than decided one payee at a time.
 * Nothing here writes: a suggestion pre-fills the payee's choice, and becomes
 * a rule only when the operator applies it.
 *
 * Every source below was scored before it shipped by hiding each payee an
 * operator had categorized and asking what the source would have guessed.
 * Sources right nearly every time are STRONG and pre-fill the choice; the one
 * that is right about three times in four is a GUESS, offered but never
 * pre-filled, so "apply all" never applies a guess nobody looked at.
 *
 * In order, first that fires:
 *  BEFORE      the same payee, categorized by the operator before;
 *  TWIN        the same payee spelled another way (store numbers, punctuation
 *              and phone digits stripped), already categorized;
 *  WORDING     money IN described as interest or a deposit: Income. The rule
 *              pack cannot say this, because it cannot see the sign, and on a
 *              loan "interest payment" is money out;
 *  MONTHLY     the same amount every month: Subscriptions;
 *  MEMO        for a P2P payee, the words of the memo the sender typed
 *              ("pizza") read by the pack's own generic words;
 *  P2P         (a guess) for a P2P payee, the per-row suggestion
 *              (p2pSuggest.ts) when every waiting payment agrees;
 *  SHARED WORD (a guess) a distinctive word the payee shares with payees the
 *              operator categorized, all one way.
 * A P2P payee is never matched to another by spelling or by a shared word: a
 * person's name says nothing about what they were paid for.
 */

export interface SuggestRow {
  id: string;
  amount: number; // signed
  date: Date;
  description: string;
  normalizedMerchant: string;
}

export interface SuggestGroup {
  key: string;
  isP2P: boolean;
  rows: SuggestRow[];
}

/** A categorized row the suggestions learn from: not a transfer, not inside an investment account. */
export interface HistoryRow {
  amount: number;
  date: Date;
  description: string;
  normalizedMerchant: string;
  categoryId: string;
  isP2P: boolean;
}

export type GroupReason =
  | { kind: 'BEFORE'; count: number }
  | { kind: 'TWIN'; like: string }
  | { kind: 'WORDING'; what: 'interest' | 'a deposit' }
  | { kind: 'MONTHLY'; amount: number }
  | { kind: 'P2P'; reason: SuggestionReason }
  | { kind: 'MEMO'; word: string }
  | { kind: 'SHARED_WORD'; word: string; like: string };

export interface GroupSuggestion {
  categoryId: string;
  reason: GroupReason;
  /** STRONG pre-fills the choice; a GUESS is offered and never pre-filled. */
  strength: 'strong' | 'guess';
}

/** Words that are the bank's bookkeeping rather than the payee's name. */
const BOOKKEEPING = new Set([
  'purchase', 'authorized', 'recurring', 'payment', 'debit', 'credit', 'card', 'online', 'transfer', 'check',
  'deposit', 'withdrawal', 'atm', 'pos', 'ach', 'web', 'pmts', 'llc', 'inc', 'corp', 'company', 'the', 'and',
  'store', 'https', 'www', 'com', 'net', 'org',
]);

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter((w) => w.length > 1);

/**
 * A payee with its decoration stripped: its first two words of letters. Two
 * spellings of one store ("marigold cafe llc", "marigold cafe,llc"; a store number
 * before or after) meet here. Null when there is too little name left, or the
 * first word is the bank's own bookkeeping ("purchase authorized on ...").
 */
export function skeleton(key: string): string | null {
  const w = words(key);
  if (w.length === 0 || BOOKKEEPING.has(w[0])) return null;
  const s = w.slice(0, 2).join(' ');
  return s.replace(/ /g, '').length >= 5 ? s : null;
}

/** The key a non-P2P row groups under, as groupByPayee keys it. */
const merchantGroupKey = (r: { normalizedMerchant: string; description: string }) =>
  r.normalizedMerchant !== '' ? r.normalizedMerchant : payeeKey(r.description);

/** The clear winner among categories, or null on a tie. */
function clearMajority(categoryIds: string[]): { categoryId: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const c of categoryIds) counts.set(c, (counts.get(c) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return { categoryId: ranked[0][0], count: ranked[0][1] };
}

const INTEREST = /\binterest (payment|paid|earned|credit)\b/i;
const DEPOSIT = /\b(check deposit|mobile deposit|remote deposit|cash deposit|atm deposit|edeposit)\b/i;

/** The pack's generic words for a category (the 900 band), to read a memo with. */
const GENERIC_WORDS = PACK_RULES.filter(
  (r) => r.matchOperator === 'REGEX' && r.priority >= 900 && r.priority < 960 && r.category !== null,
).map((r) => ({ re: new RegExp(r.matchValue, 'i'), category: r.category as string }));

/** What follows a P2P reference code is the sender's memo, when there is one. */
const memoOf = (description: string) => description.match(/\bref\s*#\s*\S+\s+(.+)$/i)?.[1] ?? '';

/** Every amount within a cent of the first, a month apart (25 to 35 days) each time. */
function monthly(rows: SuggestRow[]): number | null {
  if (rows.length < 3 || rows.some((r) => r.amount >= 0)) return null;
  const first = Math.abs(rows[0].amount);
  if (rows.some((r) => Math.abs(Math.abs(r.amount) - first) > 0.01)) return null;
  const days = rows.map((r) => r.date.getTime()).sort((a, b) => a - b);
  const gaps = days.slice(1).map((d, i) => (d - days[i]) / 86_400_000);
  return gaps.every((g) => g >= 25 && g <= 35) ? first : null;
}

/** Words of place, which a descriptor's town and state are made of, never of what was bought. */
const PLACE = new Set([
  'north', 'south', 'east', 'west', 'beach', 'springs', 'spring', 'city', 'county', 'park', 'lake', 'heights',
  'valley', 'island', 'port', 'harbor', 'harbour', 'village', 'town', 'center', 'centre', 'downtown', 'saint',
  'fort', 'mount', 'new', 'york', 'jersey', 'florida', 'texas', 'california', 'carolina', 'virginia', 'brooklyn',
  'manhattan', 'queens', 'boston', 'chicago', 'miami', 'seattle', 'austin', 'denver',
]);

/** The words of a payee's NAME: its first two, past the bank's bookkeeping, at least four letters, not a place. */
function nameWords(key: string): string[] {
  const w = words(key).filter((x) => !BOOKKEEPING.has(x));
  return [...new Set(w.slice(0, 2))].filter((x) => x.length >= 4 && !PLACE.has(x));
}

/** A word distinctive enough to suggest by: in at most this many categorized payees. */
const SHARED_WORD_MAX_PAYEES = 3;

/** Spellings of one payee that may share a skeleton before it reads as a generic phrase. */
const TWIN_MAX_SIBLINGS = 2;

export function suggestGroupCategories(
  groups: SuggestGroup[],
  history: HistoryRow[],
  userRules: RuleData[],
  categoryIdByName: Map<string, string>,
): Map<string, GroupSuggestion> {
  // Non-P2P history, by payee: the evidence BEFORE, TWIN and SHARED WORD read.
  const byPayee = new Map<string, string[]>();
  for (const h of history) {
    if (h.isP2P) continue;
    const key = merchantGroupKey(h);
    if (key === '') continue;
    byPayee.set(key, [...(byPayee.get(key) ?? []), h.categoryId]);
  }
  const payeeCategory = new Map<string, string>();
  for (const [key, cats] of byPayee) {
    const m = clearMajority(cats);
    if (m !== null) payeeCategory.set(key, m.categoryId);
  }
  const bySkeleton = new Map<string, { key: string; categoryId: string }[]>();
  const byWord = new Map<string, { key: string; categoryId: string }[]>();
  for (const [key, categoryId] of payeeCategory) {
    const s = skeleton(key);
    if (s !== null) bySkeleton.set(s, [...(bySkeleton.get(s) ?? []), { key, categoryId }]);
    for (const w of nameWords(key)) byWord.set(w, [...(byWord.get(w) ?? []), { key, categoryId }]);
  }

  // P2P: the per-row suggestions, computed once for every waiting payment.
  const p2pRows = groups.filter((g) => g.isP2P).flatMap((g) => g.rows);
  const perRow =
    p2pRows.length === 0
      ? new Map()
      : suggestP2PCategories(
          p2pRows.map((r) => ({ ...r, accountName: '', categorySource: 'AGGREGATOR' as const })),
          history.filter((h) => h.isP2P).map((h) => ({ amount: h.amount, date: h.date, description: h.description, categoryId: h.categoryId })),
          userRules,
        );

  const income = categoryIdByName.get('Income');
  const subscriptions = categoryIdByName.get('Subscriptions');
  const out = new Map<string, GroupSuggestion>();

  for (const g of groups) {
    if (g.rows.length === 0) continue;
    const strong = (categoryId: string, reason: GroupReason) => out.set(g.key, { categoryId, reason, strength: 'strong' });

    if (g.isP2P) {
      // The memo first: words the sender typed about THIS money.
      const memo = g.rows.map((r) => memoOf(r.description)).join(' ');
      const hit = memo === '' ? undefined : GENERIC_WORDS.find((w) => w.re.test(memo));
      const id = hit === undefined ? undefined : categoryIdByName.get(hit.category);
      if (hit !== undefined && id !== undefined) {
        strong(id, { kind: 'MEMO', word: (memo.match(hit.re)?.[0] ?? '').toLowerCase() });
        continue;
      }
      // The person's past payments are only a GUESS here: scored on a real
      // history, they named the category six times in ten, because a friend
      // is paid back for dinner one month and a trip the next.
      const each = g.rows.map((r) => perRow.get(r.id));
      if (each.every((s) => s !== undefined) && new Set(each.map((s) => s!.categoryId)).size === 1) {
        out.set(g.key, { categoryId: each[0]!.categoryId, reason: { kind: 'P2P', reason: each[0]!.reason }, strength: 'guess' });
      }
      continue;
    }

    const before = byPayee.get(g.key);
    const beforeWinner = before === undefined ? null : clearMajority(before);
    if (beforeWinner !== null) {
      strong(beforeWinner.categoryId, { kind: 'BEFORE', count: beforeWinner.count });
      continue;
    }

    // A real second spelling has a sibling or two. Many payees under one
    // skeleton means the first two words are generic ("main street ..."), not
    // one store, and none of them is a twin.
    const s = skeleton(g.key);
    const siblings = s === null ? [] : (bySkeleton.get(s) ?? []).filter((t) => t.key !== g.key);
    const twins = siblings.length > TWIN_MAX_SIBLINGS ? [] : siblings;
    const twin = clearMajority(twins.map((t) => t.categoryId));
    if (twin !== null) {
      strong(twin.categoryId, { kind: 'TWIN', like: twins.find((t) => t.categoryId === twin.categoryId)!.key });
      continue;
    }

    if (income !== undefined && g.rows.every((r) => r.amount > 0)) {
      if (g.rows.every((r) => INTEREST.test(r.description))) {
        strong(income, { kind: 'WORDING', what: 'interest' });
        continue;
      }
      if (g.rows.every((r) => DEPOSIT.test(r.description))) {
        strong(income, { kind: 'WORDING', what: 'a deposit' });
        continue;
      }
    }

    const amount = subscriptions === undefined ? null : monthly(g.rows);
    if (amount !== null && subscriptions !== undefined) {
      strong(subscriptions, { kind: 'MONTHLY', amount });
      continue;
    }

    // Only the NAME's words: a descriptor ends in the town it was bought in,
    // and scored on a real history a shared town ("lakeview heights") was the
    // commonest wrong guess, a dentist filed as Income.
    for (const w of nameWords(g.key)) {
      const sharing = (byWord.get(w) ?? []).filter((p) => p.key !== g.key);
      if (sharing.length === 0 || sharing.length > SHARED_WORD_MAX_PAYEES) continue;
      if (new Set(sharing.map((p) => p.categoryId)).size !== 1) continue;
      out.set(g.key, { categoryId: sharing[0].categoryId, reason: { kind: 'SHARED_WORD', word: w, like: sharing[0].key }, strength: 'guess' });
      break;
    }
  }
  return out;
}
