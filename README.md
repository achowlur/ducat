# Ducat

A local-only personal finance tracker with an insights engine. It runs entirely
on your machine — **your financial data never leaves `127.0.0.1`.** You bring
your own bank connection (a SimpleFIN token) or import CSVs; there is no hosted
service, no account to create, and no third party that custodies your data.

## Trust model

These are enforced, not just promised:

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
Prisma + SQLite. Charts are hand-rolled SVG (no chart library, no webfonts).

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
npm run import:csv -- <file.csv> --mapping=<chase-checking|chase-credit|wells-fargo|fidelity> \
  --name="<account>" --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution="<bank>"
```

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server, bound to `127.0.0.1` |
| `npm test` | Vitest suite |
| `npm run db:seed` | Load deterministic fixture data (wipes insights) |
| `npm run insights:generate` | Regenerate insights (`-- --granularity=WEEK\|MONTH\|QUARTER\|YEAR`) |
| `npm run sync:simplefin` | Sync from your SimpleFIN feed |
| `npm run import:csv` | Import a CSV (see above) |
| `npm run rules:retarget` | Point rules at a different category and re-apply (dry run; `-- --apply` writes) — names the database first |
| `npm run rules:install` | Install the starter category-rule pack |
| `npm run goals` | Declare savings goals shown on /insights (`-- --add --name=… --target=… --by=YYYY-MM --accounts=…`) — names the database first |
| `npm run health` | Print the provider-health panel (no network) |
| `npm run subs:audit` | Report what subscription detection missed and which gate rejected it (read-only) |
| `npm run repair:text` | Strip undecodable characters from imported names/descriptions (dry run; `-- --apply` writes) |
| `npm run repair:merchants` | Re-normalize stored merchant names after a normalizer change (dry run; `-- --apply` writes) |
| `npm run turso:push` | Apply the schema to a fresh cloud database (see [DEPLOY.md](DEPLOY.md)) |
| `npm run turso:copy` | Copy this database into a fresh cloud one (dry run; `-- --apply` writes) |
| `npm run cloud:backup` | Pull the cloud database into a dated file under `data/backups/` |

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
everywhere. Use `preview_start prod` for that, never `npm run dev`.

## Where your data lives

`./data/ducat.db` (SQLite) — on your machine, gitignored. Delete it to start
over.
