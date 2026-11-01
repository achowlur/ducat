# PDF statement import

`npm run import:pdf` reads a bank's PDF statements into history. Banks keep
statements online far longer than their CSV downloads reach (often seven years
against 90 days to 18 months), so for anything older than a CSV export can
give you, the statements are the record.

## Supported statements

| Layout | Statements |
| --- | --- |
| `chase-card` | Chase credit card |
| `wells-fargo-card` | Wells Fargo credit card, including statements scanned from paper (see [Scanned statements](#scanned-statements)) |
| `wells-fargo-deposit` | Wells Fargo checking and savings |
| `fidelity-report` | Fidelity Investment Report, every account in it (see [Investment accounts](#investment-accounts)) |

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
under that one account instead; a file holding several accounts is skipped
under it, since one id cannot say where each goes.

## What makes a statement acceptable

A statement is imported **whole or not at all**. It is refused when:

- it is a scan with no text layer (there is no OCR inside the import;
  [Scanned statements](#scanned-statements) is the way round);
- its layout is not one listed above;
- its rows do not add up: the opening balance plus every row must equal the
  closing balance to the cent (for an investment account, plus the market
  change the statement prints), and every subtotal the statement prints must
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
file. A statement whose dates overlap another one for the same account, such
as a quarterly report beside the monthly ones, is skipped with the reason,
since the two would list the same rows.

## Investment accounts

A Fidelity Investment Report holds every account in one file. Each account is
read as its own statement, and if any of them does not add up, none is
imported. For each account the import keeps:

- **its value**: the ending account value becomes a balance snapshot, which is
  what net worth reads for an investment account;
- **money in and out**: the rows behind every line under Additions and
  Subtractions in its account summary (deposits, withdrawals, exchanges), each
  read from the section of the same name, or for an exchange from the
  "Transferred From/To" rows of the account's activity; and securities moved
  between accounts in kind, one row per security at the value of the
  transaction the report prints for it.

Trades, dividends, reinvestments and the sweep into the core position stay
inside the account, so they are not read at all; what the account earned is
the statement's own "Change in Investment Value". Fees and transaction costs
the account pays count with that change, as Ducat already counts an advisory
fee inside an investment account, and are not rows. The check is the
beginning value plus every row plus the printed change and costs, which must
equal the ending value to the cent.

In an investment account a row already stored matches on its amount whichever
sign it was stored with: the live feed records a brokerage deposit as negative
where the statement and Fidelity's own export print it positive. The year-end report is refused: it summarises the whole
year at once, and the monthly reports carry its months. If an account moved
money through a summary line that no
section lists, or the summary holds a line the import cannot place, the file is
refused with that line's name.

## Sharing the report

`--share` prints the report so it can be pasted to someone helping you: counts,
statement dates, refusal reasons and the page positions they mention stay
readable, while amounts, account digits and every listed row are masked the
way `npm run pdf:layout` masks a statement. Read it before you paste it.

## Balances

A statement import never changes an existing account's current balance. Each
statement's closing balance is written as a balance snapshot dated to the
statement's closing day, which gives net worth real month-end figures for the
imported months. When an account's first statement opens at zero and Ducat
holds nothing for it before that, the account was opened in that period: the
zero is recorded on the statement's first day too, so net worth can count the
account as holding nothing before it existed. A statement already imported is
never read again, so this happens on the first import of that statement.

## An account Ducat never had

Statements can cover an account no feed ever reached, typically one closed
before the feed was connected. Its statements are skipped with the reason
"no single ... account ending in 1234", and the account can be added from them:

```bash
npm run import:pdf -- <folder> --dry-run --create-account=1234 --account-name="Managed account (closed)"
```

The account is created with that name and its last four digits (so later runs
match it like any other), and its balance is its last statement's closing
value. An investment account closed at zero stays zero in net worth for every
month after it closed, since there is nothing left for the market to move. An
account that already exists is matched, never created again.

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

## Scanned statements

A statement that only ever existed on paper (mailed, then scanned) is an
image, and the import refuses it: there is no text to read positions from.
`npm run pdf:ocr` makes PDFs it can read, with two programs installed on the
machine first:

```bash
winget install --id UB-Mannheim.TesseractOCR -e
winget install --id oschwartz10612.Poppler -e
npm run pdf:ocr -- <scan.pdf> [more...] --out=<folder>
npm run import:pdf -- <folder> --dry-run
```

Every page is rasterised, levelled (a fed sheet sits a few degrees off, and
then the words of one row land on different lines), OCR'd by Tesseract into
a searchable page, and placed by the header its own text now carries: the
statement period and "Page N of M". Sheets can be fed in any order and split
across several scans; each statement's pages are joined in printed order into
`statement-<closing date>.pdf`. Pages whose header could not be read (the
terms on the back of a sheet, inserts, blank backs, or a header OCR spoiled)
are listed by position and left out. Nothing is run on the import's own
path: it reads the files as it reads any other PDF.

OCR is not exact, and the checks are what make it safe to use. The
`wells-fargo-card` layout absorbs what a scan does to a page (a column set a
few points off its rows, two dates read as one, a letter where a digit was),
and the balance and section checks refuse a statement whose amounts came out
wrong, whole, as they refuse any other. Expect a share of statements to be
refused on a first pass, each with its reason; a cleaner scan of that
statement, at 300 dpi, is the fix. The one error no check can see is a date
misread as another date inside the same period: the money is right, the day
can be off. The scan itself, with your name and address, never leaves the
machine; the OCR runs locally.

## Adding a layout

```bash
npm run pdf:layout -- <statement.pdf>
```

prints a statement the way the import reads it (`--pages=4-6` for some pages,
or `--pages-with="Exchanges In"` for the pages holding a phrase, found in the
real text even when the mask hides it): one line per row of the page,
each piece of text with the x positions it starts and ends at. It is masked by
default: every digit prints as `#`, and every word that is not statement
vocabulary (your name and address, people paid by Zelle, every merchant)
prints as `Xxxx` of the same shape, while headings, column labels and
transaction types survive. That is enough to describe the layout without
carrying anything from the statement itself. A parser for a new layout is
written against those positions, and tested on invented text in the same
shape, never on a real statement.
