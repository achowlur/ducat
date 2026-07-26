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
npx prisma migrate deploy       # create ./data/finance.db
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
| `npm run rules:install` | Install the starter category-rule pack |
| `npm run health` | Print the provider-health panel (no network) |
| `npm run repair:text` | Strip undecodable characters from imported names/descriptions (dry run; `-- --apply` writes) |

## Where your data lives

`./data/finance.db` (SQLite) — on your machine, gitignored. Delete it to start
over.
