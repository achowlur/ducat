# CSV import

`npm run import:csv` turns a bank's own export file into normalized accounts
and transactions. It is the zero-dependency path in, and the only way to load
history older than a live feed reaches.

## Mappings

Pass `--mapping=<id>` to say which bank's export shape the file has:

| Mapping | Export |
| --- | --- |
| `chase-checking` | Chase checking/savings |
| `chase-credit` | Chase credit card |
| `wells-fargo` | Wells Fargo checking/savings/credit card (pending rows are skipped) |
| `wells-fargo-headerless` | Wells Fargo's older headerless variant |
| `fidelity` | Fidelity brokerage history (trades, reinvestments and internal transfers are flagged TRANSFER; the disclaimer footer is skipped) |

## Importing one account

```bash
npm run import:csv -- <file.csv> --mapping=<id> --name="<account>" \
  --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution="<bank>" \
  [--external-id=<stable id>] [--currency=USD] [--until=YYYY-MM-DD]
```

`--external-id` identifies the account **across imports**. It defaults to a
slug of institution + name; reuse the same value when importing newer exports
of the same account so new rows deduplicate into it.

### Preview it first (`--dry-run`)

```bash
npm run import:csv -- <file.csv> --mapping=<id> --name="…" --type=… --institution="…" --dry-run
```

Reports what the import would do and writes nothing — no transactions, no
balance, no snapshot, no sync log. Worth doing before every file, because an
import has no undo: a re-downloaded export whose text differs by one character
re-imports rather than deduplicates, and nothing records which file produced
which rows.

It tells you which account each file would land in (and whether that means
creating one), how many rows are new against how many are already present, what
the balance write would be, how many rows your rules would categorize, and how
many payee decisions the grouped review would ask you for afterwards — the last
being the number that actually costs you time on a long backfill.

Two things it does **not** claim, because it cannot count them without writing:
transfer-pair linking and insight regeneration. Both still run during the real
import, which is why the payee count is an upper bound — every pair linked
takes two more rows out of the review queue.

### Backfilling behind a live feed

To load old history into an account a live connector already owns, pass
**that account's** `--external-id`, and cap the import with `--until` set to
the date the feed's coverage starts (the cap is exclusive).

`--until` matters because overlapping rows do **not** deduplicate across
sources: a CSV row's id is a hash of its own content, while a feed row carries
the feed's own id, so the same purchase arriving from both would land twice.
The cap keeps the two sources on either side of a date instead.

The cap has a second job its name does not suggest. An **un**capped import
reports the file's newest row as the account's *current* balance, and that write
lands even on an account another connector owns — so a forgotten `--until`
rolls a live balance back to whatever the file happened to end at, until the
next sync corrects it. With the cap set, the import writes no balance and no
snapshot at all. `--dry-run` prints which of the two you are about to do.

## Multi-account files (Fidelity)

Fidelity can export every account into one file. Omit `--external-id` and the
importer routes each row to an existing account by matching the file's account
number against the accounts it already knows:

```bash
npm run import:csv -- <file.csv> --mapping=fidelity [--until=YYYY-MM-DD] \
  [--account-column="Account Number"]
```

This needs existing accounts to route into — sync or import per-account
first. Rows that match no account are skipped and reported, never guessed at.
If your export names the account column differently, override it with
`--account-column`. Passing `--external-id` instead treats the whole file as
that one account, even under this mapping.

## Month-end balance snapshots (`import:balances`)

An investment account's value moves with the market, and market movement
leaves no transaction — so past balances cannot be rebuilt from transaction
history, and net worth refuses to chart a month it would have to guess. One
balance snapshot inside a month, per investment account, unlocks that month.
Your monthly statements carry exactly the number needed ("Ending Account
Value"). Cash and credit accounts need none of this: their transactions
explain them fully.

```bash
npm run import:balances -- --template [--months=24] > balances.csv
```

prints a fill-in CSV with one row per investment account per month that has
no snapshot yet, newest first. Fill in the balance column from each statement
and leave unknown months blank — blank rows are skipped, not written as zero.

```bash
npm run import:balances -- balances.csv --dry-run   # preview
npm run import:balances -- balances.csv             # write + regenerate insights
```

Details worth knowing:

- The `account` column matches by name, external id, masked account number,
  or any unambiguous fragment. Unresolvable rows are reported, never guessed.
- Dates take `YYYY-MM-DD` or `M/D/YYYY` (Excel rewrites dates on save).
- Balances are signed the way the app stores them: CREDIT and LOAN negative.
- A balance containing thousands separators must be quoted, or be the last
  column; an ambiguous one is skipped with a message.

## After an import

Rules categorize what they recognize; the rest lands in the grouped review on
the Transactions tab. One caveat on balances: only exports with a
running-balance column (of the shipped mappings, `chase-checking`) can state
the account's current balance — under the other mappings the true balance is
unknown and the account says so rather than guessing. A live feed, or
`import:balances`, is what supplies real balances there.
