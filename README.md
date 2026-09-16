# Ducat

A local-first personal finance tracker with an insights engine. By default it
runs entirely on your machine — **your financial data never leaves
`127.0.0.1`.** You bring your own bank connection (a SimpleFIN token) or import
CSVs; there is no hosted service, no account to create, and no third party that
custodies your data. An **optional** single-tenant cloud deployment (your own
Turso + Vercel, still nobody else's servers) is covered in
[DEPLOY.md](DEPLOY.md).

New here? [docs/getting-started.md](docs/getting-started.md) walks the first
run end to end.

## Trust model

These are enforced, not just promised. They describe the default local mode;
what changes in the optional cloud mode is spelled out in
[DEPLOY.md](DEPLOY.md).

- **Nothing leaves the machine.** The only outbound network call the app ever
  makes is to your SimpleFIN feed. A strict Content-Security-Policy
  (`connect-src 'self'`) blocks any other fetch/XHR/WebSocket/beacon at the
  browser boundary, so even a compromised dependency can't exfiltrate data.
  No analytics, no telemetry (Next.js telemetry is disabled per-repo), no
  third-party CDNs, no fonts loaded over the network, no LLM/AI API calls.
- **Localhost only.** The server binds to `127.0.0.1`, and a host-allowlist
  middleware rejects any request whose `Host` isn't loopback (anti-DNS-rebinding).
- **No bank credentials, ever.** Bank auth happens entirely in SimpleFIN's
  hosted flow. This app only ever holds a revocable, read-only *access URL*,
  read from `.env` and kept in memory — never written to disk by the app,
  never displayed in the UI.
- **Secrets stay out of git.** `.env` and the SQLite database (`./data/`) are
  gitignored.

## Stack

Next.js 15 (App Router) · TypeScript (strict) · Tailwind + shadcn/ui ·
Prisma + libSQL (a SQLite file locally; Turso in the optional cloud mode).
Charts are hand-rolled SVG (no chart library, no webfonts).

## Setup

```bash
npm install
cp .env.example .env            # then edit .env (see below)
npx prisma migrate deploy       # create ./data/ducat.db
npm run dev                     # http://127.0.0.1:3000
```

### Getting data in

**Option A — try it immediately with fixture data:**

```bash
npm run db:seed                 # deterministic sample accounts/transactions
npm run insights:generate       # db:seed wipes insights — regenerate after
```

**Option B — connect real accounts via SimpleFIN** (bring your own token,
~$15/yr paid by you to SimpleFIN; the maintainer custodies nothing):

```bash
npm run simplefin:claim -- <setup-token>   # prints an access URL
# paste the printed SIMPLEFIN_ACCESS_URL into .env, then:
npm run sync:simplefin
```

**Option C — import CSVs** (zero dependencies):

```bash
npm run import:csv -- <file.csv> \
  --mapping=<chase-checking|chase-credit|wells-fargo|wells-fargo-headerless|fidelity> \
  --name="<account>" --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution="<bank>"
```

See [docs/csv-import.md](docs/csv-import.md) for the mappings, backfilling
behind a live feed (`--external-id`, `--until`), and month-end balance
snapshots for investment accounts.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server, bound to `127.0.0.1` |
| `npm test` | Vitest suite |
| `npm run db:seed` | Load deterministic fixture data — destructive: wipes accounts, transactions, rules and insights; refuses over existing transactions without `-- --yes` |
| `npm run db:reset` | Wipe every row **including** `Setting`, so the next sync refetches full history rather than a short incremental window — destructive and irreversible; refuses without `-- --yes` |
| `npm run insights:generate` | Regenerate insights (`-- --granularity=WEEK\|MONTH\|QUARTER\|YEAR`) — names the database first |
| `npm run simplefin:claim` | Exchange a one-time SimpleFIN setup token (`-- <setup-token>`) for the permanent access URL — prints the `SIMPLEFIN_ACCESS_URL` line to paste into `.env`, and never writes a secret to a file itself |
| `npm run sync:simplefin` | Sync from your SimpleFIN feed (`-- --since=YYYY-MM-DD` widens the window, `--granularity=MONTH`) — names the database first |
| `npm run import:csv` | Import a CSV (see above; `-- --dry-run` reports what it would do and writes nothing) — names the database first |
| `npm run import:balances` | Import month-end balance snapshots for investment accounts (`-- --template [--months=N]` prints a fill-in CSV; `--dry-run` previews) — names the database first |
| `npm run upgrade` | After `git pull`, bring this database up to the checked-out code: install missing pack rules if any are pending, then regenerate the monthly insight rows — always, so a release that changed only analyzer math reaches the screens too (`-- --check` reports without writing). Writes rows on every real run, so run it against the CLOUD; the nightly backup mirrors local from it — names the database first |
| `npm run rules:retarget` | Edit existing rules in place — category, match field or match operator — and re-apply (`-- --match=<value,value>` plus at least one of `--category="<Name>"`, `--field=<FIELD>`, `--operator=<OP>`; dry run, `--apply` writes) — names the database first |
| `npm run rules:install` | Install the starter category-rule pack and retroactively categorize existing transactions (idempotent: re-running adds only what is missing) — names the database first |
| `npm run rules:audit` | Report rules that match more merchants than the one they were built from (read-only) — names the database first |
| `npm run rules:simulate` | Report every disagreement between the current and the retired CONTAINS matcher, over real rows plus generated probes (read-only) — names the database first |
| `npm run goals` | List/declare savings goals shown on /insights (`-- --add --name=… --target=…` or `--house-price=… [--down=20 --closing=3]`, `--accounts=<list>` or `--accounts=cash`, optional `--by=YYYY-MM`; `--remove=…`) — names the database first |
| `npm run readiness` | List/declare the house-readiness config behind /insights' readiness panel (`-- --floor=… --rate=… --term=… --tax=… --insurance=… --pmi=… --closing=… --down=…`, all equals-form; `--as-of=YYYY-MM-DD` dates a typed rate, `--fetched-rate` uses the stored FRED observation instead, `--clear` removes the panel) — names the database first |
| `npm run accounts:cash` | List which accounts count as spendable cash; mark non-checking ones (`-- --add=…` / `-- --remove=…`) — names the database first |
| `npm run health` | Print the provider-health panel and the tracked-subscription reconciliation (read-only, no network) |
| `npm run subs:audit` | Report what subscription detection missed and which gate rejected it (read-only) — names the database first |
| `npm run repair:text` | Strip undecodable characters from imported names/descriptions (dry run; `-- --apply` writes) |
| `npm run repair:merchants` | Re-normalize stored merchant names after a normalizer change (dry run; `-- --apply` writes) |
| `npm run auth:set-password` | Generate the login gate's `AUTH_PASSWORD_HASH` and `SESSION_SECRET` — you type the password into the terminal (echo muted, 8 characters minimum, asked twice); the values are printed to paste into `.env` or Vercel and nothing is stored |
| `npm run auth:set-totp` | Generate the opt-in second factor `AUTH_TOTP_SECRET` and prove enrollment before deploying it — asks for one code from your authenticator and refuses the secret if it does not verify (offline; nothing stored). Enabling or rotating it logs out every session |
| `npm run turso:push` | Apply the schema to a fresh cloud database (see [DEPLOY.md](DEPLOY.md)) |
| `npm run schema:push` | Diff `prisma/schema.prisma` against a database that already has data and apply the additive part (dry run; `-- --apply` writes) — names the database first |
| `npm run turso:copy` | Copy this database into a fresh cloud one (dry run; `-- --apply` writes) |
| `npm run cloud:backup` | Pull the cloud database into a dated file under `data/backups/` |
| `npm run backup:scheduled` | The nightly cloud→local backup the 23:50 UTC task fires: copy, fingerprint-verify (a mismatch quarantines as `.unverified`), prune retention, make `data/ducat.db` a copy of the verified file (only if nothing has written to local since its last mirror; otherwise local is left untouched and the refusal shows on /providers), then record `backup.lastRun`. Credentials come from `.env.backup` only, never `.env` or the shell. `-- --dry-run` still copies and verifies, and skips the pruning, the mirror and the Setting |
| `npm run db:mirror` | Make `data/ducat.db` a copy of the newest verified backup, on demand — reports both digests and whether local changed since its last mirror, and writes nothing without `-- --confirm` (which first keeps the current local as `data/ducat-superseded-<date>.db`). Run it once to start the nightly mirror |
| `npm run db:fingerprint` | Print per-table and whole-database content digests — the read-only proof that two databases hold identical rows, where counts and sums are blind (a changed category, a flipped `dismissed`) — names the database first |

Commands marked "names the database first" print which database they are about
to touch as their first line — read it. Code travels with `git pull`; data does
not, so anything that writes rows or settings has to be run once **per
database**. [docs/lifecycle.md](docs/lifecycle.md) explains the model, and
[docs/troubleshooting.md](docs/troubleshooting.md) covers the common failure
symptoms.

## Measuring performance

Time has to be measured on the **deployment**, not localhost — localhost has no
network, no cold start, a `file:` database instead of HTTP round trips, and a
desktop CPU instead of a phone. Open `/api/diag/timing` on the deployed app
(session-gated, read-only, sends nothing anywhere) for per-query round-trip
costs, whether the invocation paid a cold start, and a `Server-Timing` header
that DevTools renders under Network → Timing. Subtract its `pagePaysMs` from the
page's TTFB to get render time.

Localhost is still the right place to measure *structure* — DOM node counts,
how many queries a page issues, payload composition — since those are identical
everywhere. Measure against a production build (`npm run build`, then
`npm run start`), never against `npm run dev` — and never build while the dev
server is running (see [docs/troubleshooting.md](docs/troubleshooting.md)).

## Where your data lives

`./data/ducat.db` (SQLite) — on your machine, gitignored. Delete it to start
over. In the optional cloud mode it lives in your own Turso database instead
(see [DEPLOY.md](DEPLOY.md)).

## Project status

This is a personal project, published as a portfolio piece rather than a
product. There are no releases and no roadmap — what's in `main` is what
exists. It isn't supported: issues and pull requests are welcome but may not
get a response, and there's no guarantee of ongoing maintenance. It's licensed
under AGPL-3.0 (see [LICENSE](LICENSE)).
