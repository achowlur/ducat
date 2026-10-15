/**
 * The mask `pdf:layout` prints statements through, so its output can describe
 * a layout to someone writing a parser without carrying the statement's
 * contents.
 *
 * Every digit becomes #, and every word becomes x's of the same case and
 * length UNLESS it is statement vocabulary below: the words headings, column
 * labels and transaction types are made of. A parser keys on exactly those,
 * and on positions and shapes, never on a name. So the account holder's name
 * and address, a person paid by Zelle, an employer and every merchant come out
 * as `Xxxxx Xxxxxx`, while "Beginning balance", "Purchase authorized on" and
 * "Zelle to" survive.
 *
 * A word missing from the list costs a reader one masked heading; a name
 * wrongly ON it would publish a person. So the list holds only words that
 * cannot identify anyone, and a statement-specific word is added only when a
 * layout cannot be read without it.
 */
// Bank and product names are deliberately absent: Chase, Wells, Sapphire,
// Bill, Cash, Page, Day and Post are all people's names, and "Zelle to Chase
// Xxxxx" would print one. The bank is known from which statement it is.
const VOCABULARY = new Set(
  `
  a an and as at by for from in into of on or per the this that to with your you
  account accounts activity summary statement statements period periods
  opening closing beginning ending begin end start through date dates days daily
  year month monthly annual cycle billing previous new last first next current
  balance balances total totals subtotal amount amounts number type description
  details detail detailed history continued see other important information
  transaction transactions merchant name payment payments credit credits debit
  debits purchase purchases advance advances transfer transfers fee fees
  charged charge charges interest rate rates percentage apr minimum due available
  limit line access rewards points earned redeemed adjustments adjustment
  deposit deposits additions withdrawal withdrawals subtractions check checks paid
  posted posting pending effective card cards checking savings
  authorized online mobile recurring thank thanks web autopay auto pay
  ach atm pos zelle ppd ccd id ref reference ret return returned reversal refund
  service overdraft item items deposited direct
  `
    .split(/\s+/)
    .filter(Boolean),
);

function maskWord(word: string): string {
  return VOCABULARY.has(word.toLowerCase()) ? word : word.replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x');
}

export function maskLayoutText(text: string): string {
  return text.replace(/\d/g, '#').replace(/[A-Za-z]+/g, maskWord);
}

/**
 * For the import's own messages, which are made of its own words: amounts
 * become #.## and four-digit runs (account digits) become ####, while x
 * positions and statement dates (2025-05-16) stay, since a refusal is
 * diagnosed by where text sat on the page and which statement it was.
 */
export function maskFigures(text: string): string {
  return text
    .replace(/-?\$?(\d{1,3}(,\d{3})+|\d+)\.\d{2}\b/g, '#.##')
    .replace(/(?<![\d-])\d{4,}(?![\d-])/g, (run) => '#'.repeat(run.length));
}

/** Digits only: words, names included, are kept. For a reader who has read the output first. */
export function maskDigits(text: string): string {
  return text.replace(/\d/g, '#');
}
