# PDF statement import

`npm run import:pdf` reads a bank's PDF statements into history. Banks keep
statements online far longer than their CSV downloads reach (often seven years
against 90 days to 18 months), so for anything older than a CSV export can
give you, the statements are the record.

## Supported statements

| Layout | Statements |
| --- | --- |
| `chase-card` | Chase credit card |
| `wells-fargo-deposit` | Wells Fargo checking and savings |

Any other PDF is refused with a reason; nothing is guessed at. To add a layout,
see [Adding a layout](#adding-a-layout).

## Importing

Point it at statement files or at a folder of them, and preview first:

```bash
npm run import:pdf -- <statement.pdf | folder> [more...] --dry-run [--share]
npm run import:pdf -- <statement.pdf | folder> [more...]
```

Each statement lands in the account it belongs to, found by the last four
digits the statement prints. The account must already exist (a live feed or an
earlier import made it); a statement for an account the import cannot name is
skipped and reported. `--external-id=<id>` files every statement in the run
under that one account instead.

## What makes a statement acceptable

A statement is imported **whole or not at all**. It is refused when:

- it is a scan with no text layer (there is no OCR);
- its layout is not one listed above;
- its rows do not add up: the opening balance plus every row must equal the
  closing balance to the cent, and every subtotal the statement prints must
  match the rows it covers. This is what catches a dropped row, a missed page
  or a misread sign without anyone checking by hand.

## How duplicates are kept out

The same transaction can already be stored from the live feed or a CSV, under
an id of its own, so the import does not rely on ids alone. A statement row is
**already stored** when the same account holds a row with the same amount, to
the cent, dated within `--match-days` days of it (default 4: a statement lists
the transaction date, a feed often the posting date). Matching counts rows, so
two identical coffees on one day are two rows and only a surplus is new.

A card statement can list a late-posted row under the date the merchant gave
it, weeks or months before the statement it appears on. The money moved during
that statement's period, so a row dated more than a week before the statement
opens is dated on the statement's opening day, with the merchant's date kept in
its description: "(transaction date 03/11/2026)". It also counts as already
stored when a row of its amount was stored anywhere inside that statement's
period, which is when a feed saw it post. A posting lag of a few days keeps
the row's own date.

Every statement row ends up in one of four groups, and the dry run counts them:

- **Older history**: dated before anything stored for the account. Added.
- **Gap**: inside the dates already stored, with nothing matching. Added, and
  each one is listed in the dry run so you can look before it lands.
- **Already stored**: not added.
- **Ambiguous**: several rows of one amount on different days competing for
  fewer stored rows, so which one is missing cannot be told. **Never added**,
  and listed. Enter one by hand if you know which it is.

The dry run also lists rows already stored inside a statement's period that no
statement row accounts for. They are left as they are; a statement is the
bank's own record of its period, so they are worth a look.

The same file is never imported twice (it is recognised by its contents, not
its name), and neither is the same statement downloaded again as a different
file.

## Sharing the report

`--share` prints the report so it can be pasted to someone helping you: counts,
statement dates, refusal reasons and the page positions they mention stay
readable, while amounts, account digits and every listed row are masked the
way `npm run pdf:layout` masks a statement. Read it before you paste it.

## Balances

A statement import never changes an account's current balance. Each
statement's closing balance is written as a balance snapshot dated to the
statement's closing day, which gives net worth real month-end figures for the
imported months.

## What is recorded, and undoing an import

Every imported statement is recorded with its file name, a hash of the file,
the account and the period, and every row it added points at that record. That
is what lets a later run skip it, and what an undo would delete. There is no
undo command yet: take a backup before a large import (`npm run cloud:backup`
on a cloud instance), since that backup is the way back.

## On a cloud instance

The import writes rows, so run it against the cloud database, the only one
written to; the nightly mirror brings it down to local. Put the two Turso
variables in front of the command for that one run, and read the database label
it prints first:

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run import:pdf -- <folder> --dry-run
```

## Adding a layout

```bash
npm run pdf:layout -- <statement.pdf>
```

prints a statement the way the import reads it: one line per row of the page,
each piece of text with the x positions it starts and ends at. It is masked by
default: every digit prints as `#`, and every word that is not statement
vocabulary (your name and address, people paid by Zelle, every merchant)
prints as `Xxxx` of the same shape, while headings, column labels and
transaction types survive. That is enough to describe the layout without
carrying anything from the statement itself. A parser for a new layout is
written against those positions, and tested on invented text in the same
shape, never on a real statement.
