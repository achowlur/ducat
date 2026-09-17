# Getting started

Ducat runs entirely on your machine. This walks the first run: clone, install,
get data in, sync, and what each screen is for.

## Install

You need **Node.js 22 or newer** and **git**.

```bash
git clone https://github.com/achowlur/ducat.git && cd ducat
npm install
cp .env.example .env            # defaults work as-is for local use
npx prisma migrate deploy       # creates ./data/ducat.db
npm run dev                     # http://127.0.0.1:3000
```

There is no login locally — the server only answers on `127.0.0.1`, and the
auth gate exists for the optional cloud deployment ([DEPLOY.md](../DEPLOY.md)).

## Getting data in — pick a path

**Seed, to explore first.** Invented demo data dated up to today: two years of
history across checking, savings, a card, two investment accounts and a loan,
with savings goals, house readiness, a price-rise subscription, a one-off
purchase, a tagged trip, and P2P payments waiting for you to confirm. It
installs the rule pack and builds insights itself, so every screen is ready.

```bash
npm run db:seed
```

Seeding is destructive (it wipes accounts, transactions, rules and insights), so
it refuses to run over existing transactions unless you pass `-- --yes`.

**SimpleFIN, for live accounts.** [SimpleFIN](https://bridge.simplefin.org) is
a read-only bank-feed bridge: you authenticate with your bank inside
SimpleFIN's own hosted flow (Ducat never sees or asks for bank credentials),
and pay SimpleFIN — not this project — about $15/yr. Create a setup token
there, then:

```bash
npm run simplefin:claim -- <setup-token>   # exchanges it for an access URL
# paste the printed SIMPLEFIN_ACCESS_URL line into .env, then:
npm run sync:simplefin
```

The access URL is a revocable, read-only credential; revoke it at the bridge
at any time. To try the plumbing without a bank, `.env.example` lists
SimpleFIN's public demo feed. Note the feed reaches back about 90 days —
history accumulates from there, and CSV import is the backfill path.

**CSV, for backfill or no subscription.** Zero dependencies; works from the
export files your bank already gives you:

```bash
npm run import:csv -- <file.csv> --mapping=<id> --name="<account>" \
  --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution="<bank>"
```

See [csv-import.md](csv-import.md) for the mappings and the backfill flags.

## What a sync does

Every sync (SimpleFIN or CSV) runs the same pipeline: upsert accounts, record
a balance snapshot, import new transactions (deduplicated), apply
categorization rules, detect transfer pairs between your own accounts, and
regenerate insights. Transfers are excluded from all spending analytics, and a
category you set by hand is never overridden.

## The six tabs

- **Overview** (`/`) — where things stand now: balances, net worth, cash and
  what it covers, and a "needs review" panel that also says when nothing does.
- **Trends** (`/trends`) — how it has changed: spending by category, cash
  flow, and net worth over time.
- **Insights** (`/insights`) — am I on track: where this month is heading,
  what changed and what it costs if it holds, upcoming commitments, savings
  goals. Projections are labelled as projections.
- **Transactions** (`/transactions`) — the ledger. Every row, paginated,
  filterable; categorize, group-review, and link reimbursements here.
- **Accounts** (`/accounts`) — what you have, per account.
- **Providers** (`/providers`) — can I trust the data: per-connector health,
  what each provider can see, and how to revoke it.

Some panels stay quiet on purpose: net worth history draws nothing for months
it cannot fully know (investment accounts need a balance snapshot inside the
month — see [csv-import.md](csv-import.md)), and pace projections wait until
enough of the month has elapsed. An empty panel early on is normal.

## Where to next

- [csv-import.md](csv-import.md) — CSV mappings, backfilling behind a live
  feed, month-end balance snapshots.
- [lifecycle.md](lifecycle.md) — code, data and schema upgrade separately:
  what to run after a `git pull`, and where data changes go if you also run
  the cloud version.
- [troubleshooting.md](troubleshooting.md) — symptoms and their fixes.
- [../DEPLOY.md](../DEPLOY.md) — the optional self-hosted cloud deployment.

Maintainer-depth material lives in docs/conventions/.
