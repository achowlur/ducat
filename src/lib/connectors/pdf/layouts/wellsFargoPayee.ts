/**
 * The payee inside a Wells Fargo deposit statement's description.
 *
 * The statement writes the bank's bookkeeping AROUND the payee: before it
 * ("Purchase authorized on 03/02"), after it (the card's S-number, "Card
 * 1234", a reference code, the holder's name), or both. Those parts differ on
 * every row, so a description read whole gives no two charges from one
 * merchant the same key: the grouped review offers one decision per ROW, and
 * no rule written for a payee can match it. The shared normalizer cannot
 * help, because it cuts at a marker AFTER the payee, and here the payee comes
 * after the marker (`connectors.test.ts` pins why "authorized on" is no marker
 * of its own).
 *
 * Each shape below was observed on real statements. A description matching
 * none comes back as it is, and Zelle is left alone on purpose: its rows key
 * on the person through `payeeKey`, which already reads them.
 */

/** "Purchase authorized on 03/02 Corner Cafe Springfield IL S000000000000001 Card 1234": the merchant. */
const CARD = /\bauthorized on \d{1,2}\/\d{1,2} (.+?)(?: [A-Z]\d{8,})? Card \d{4}$/i;

/** "ATM Check Deposit on 03/02 1 Main St Springfield IL ... Card 1234": the kind, never the place. */
const ATM = /^(ATM [A-Za-z ]+?) (?:authorized )?on \d{1,2}\/\d{1,2}\b/i;

/** "Online Transfer Ref #Ib0000000 to Example Card Xxxxxxxxxxxx1234 on 03/02/26": a transfer between accounts. */
const TRANSFER = /^(?:Online )?Transfer\b/i;

/** An ACH line, "Example Payroll Direct Dep 260302 0000000001 Doe, Jane": the payee runs to its first code. */
const CODE = /^\S*\d{3,}\S*$/;

export function wellsFargoPayee(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (/^Zelle\b/i.test(text)) return text;

  // Before CARD: an ATM withdrawal is "authorized on" too, and its "place" is a street.
  const atm = ATM.exec(text);
  if (atm !== null) return atm[1];

  const card = CARD.exec(text);
  if (card !== null) return card[1];

  if (TRANSFER.test(text)) {
    const kept = text
      .replace(/\bRef #\s*\S+/gi, ' ')
      .replace(/\bon \d{1,2}\/\d{1,2}(\/\d{2,4})?\b/gi, ' ')
      .split(' ')
      .filter((word) => !/\d{4,}$/.test(word))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return kept === '' ? text : kept;
  }

  const words = text.split(' ');
  const firstCode = words.findIndex((word) => CODE.test(word));
  return firstCode > 0 ? words.slice(0, firstCode).join(' ') : text;
}
