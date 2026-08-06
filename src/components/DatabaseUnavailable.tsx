import type { DatabaseFailure } from "../lib/ui/dbHealth";

/**
 * The page state for "the database did not answer", so it stops being
 * indistinguishable from a bug. Pages do not import this directly — they wrap
 * their render in `withDatabaseNotice` (DatabaseNotice.tsx), which is what reads
 * the environment and hands the four facts below in.
 *
 * PURE AND SYNCHRONOUS ON PURPOSE: no `headers()`, no `process.env`, no
 * `isCloudMode()`. Everything it needs arrives as a prop, so its real markup can
 * be rendered and asserted in a test — the MiniDonut precedent, and the only way
 * to honour the trap this whole state was built around. Any check that a string
 * is ABSENT passes on a page that never rendered at all; during the outage both
 * the login redirect and the error boundary came back "clean" for probes looking
 * for removed text. So the test asserts on what is PRESENT, which requires the
 * component to be renderable outside Next.
 *
 * Three things the copy must not do, all of them learned on 2026-08-04:
 *
 *  1. NAME NO CULPRIT. A provider incident, a revoked token and a lapsed plan
 *     produce the same silence — diagnosing the real one took a log read, a
 *     probe, and finally the provider's own console failing in a browser. The
 *     page prints what it OBSERVED (a transport code, an HTTP status) and stops.
 *  2. NEVER IMPLY THE DATA IS GONE. Failing to reach a database is a failure to
 *     SERVE and says nothing about what is stored. Which is exactly why the
 *     missing-table state carries NO such reassurance: a table that is not there
 *     is a real absence, and "nothing was lost" would be the fabrication this
 *     app refuses everywhere else.
 *  3. GIVE THE ADVICE THAT FITS THE MODE. "It may be temporary, try again" is
 *     right for a cloud outage and useless for a checkout that was never
 *     migrated.
 */

export interface Advice {
  heading: string;
  /** The condition, stated plainly. */
  what: string;
  /** What the reader may conclude about their data — null when nothing honest can be said. */
  reassurance: string | null;
  /** What to do next, each already a complete instruction. */
  next: React.ReactNode[];
}

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="font-money text-[0.8rem]">{children}</code>;
}

export function adviceFor(failure: DatabaseFailure, cloud: boolean): Advice {
  if (failure.kind === "unreachable") {
    return {
      heading: "Database unreachable",
      what: "Ducat could not get an answer from its database, so there is nothing to show on this page.",
      reassurance:
        "This is not your figures being wrong, and it does not mean anything was lost — failing to reach a database says nothing about what is stored in it.",
      next: [
        "It may be temporary. Reloading is safe and changes nothing.",
        cloud
          ? "If it persists, check the database host, its access token, and the plan it runs on — from here an outage, a revoked token and a lapsed plan all look the same."
          : "If it persists, check that DATABASE_URL points where you think it does, and that whatever serves it is running.",
      ],
    };
  }

  if (failure.kind === "unopenable") {
    return {
      heading: "Database file could not be opened",
      what: "Ducat found no database it could open at this path, so there is nothing to show on this page.",
      // SQLITE_CANTOPEN (14) is all the driver reports, and it covers a missing
      // folder, a path naming a directory, and a permissions refusal alike. So
      // the copy states that the OPEN failed and lists where to look, rather
      // than naming the cause the way an earlier draft did.
      reassurance:
        "Nothing was read and nothing was written. The open itself did not succeed, which says nothing about the contents of any database at that path.",
      next: [
        "Check DATABASE_URL against the path below: that it names the database file rather than the folder holding it, that the folder above it exists, and that this account may read and write there.",
        <>
          On a fresh checkout, create the database with <Cmd>npx prisma migrate deploy</Cmd>.
        </>,
      ],
    };
  }

  if (failure.kind === "not-a-database") {
    return {
      heading: "That file is not a database",
      what: "The file DATABASE_URL points at opened, but it is not a SQLite database, so no query can run against it.",
      reassurance:
        "Ducat has not changed that file. If the path is simply wrong, your real database is untouched wherever it actually lives.",
      next: [
        "Check DATABASE_URL — a truncated download or a half-finished copy reads exactly like this.",
      ],
    };
  }

  // no-tables. Carries NO reassurance, deliberately: the table genuinely is not
  // there, and this is the one branch where "nothing was lost" would be a claim
  // the evidence cannot support.
  //
  // It states BOTH causes because one missing table cannot distinguish them. A
  // database one release behind — the schema:push split this repo documents as
  // a routine hazard — throws exactly the same error as an empty one, while
  // holding a year of real transactions. An earlier draft read "this app's
  // schema has never been applied to it", which is flatly false in that case.
  return {
    heading: "Database schema is incomplete",
    what:
      failure.detail === null
        ? "The database answered, but it does not have the tables this app reads."
        : `The database answered, but it has no ${failure.detail} table — either its schema was never applied, or it was applied before the release that added that table.`,
    reassurance: null,
    next: cloud
      ? [
          <>
            If the database is empty, apply the baseline: <Cmd>npm run turso:push</Cmd>. If it
            holds data and is merely behind, it is <Cmd>npm run schema:push</Cmd>, then the same
            command with <Cmd>-- --apply</Cmd>. DEPLOY.md covers both.
          </>,
          "If this instance was meant to read a different database, check DATABASE_URL — a database that exists but has never had the schema applied looks exactly like this, while a name that does not exist is refused outright and reports itself as unreachable.",
        ]
      : [
          <>
            Bring the schema up to date with <Cmd>npx prisma migrate deploy</Cmd>. On a fresh
            checkout, <Cmd>npm run db:seed</Cmd> then adds fixture data.
          </>,
          "If you expected your own data here, check DATABASE_URL — a missing file is created empty rather than refused, so a typo looks exactly like this.",
        ],
  };
}

export function DatabaseUnavailable({
  failure,
  cloud,
  target,
  path,
}: {
  failure: DatabaseFailure;
  cloud: boolean;
  /** The host or file path that did not answer. Never the URL — it can carry a token. */
  target: string | null;
  /** Where "Try again" goes: the page the reader was actually on. */
  path: string;
}) {
  const advice = adviceFor(failure, cloud);
  // Only the unreachable case has a detail worth a separate evidence line: a
  // transport code or an HTTP status is the thing a reader would otherwise have
  // to dig a log out to find. The missing-table name is already in the sentence
  // above, and repeating it as "Reported: Setting" reads like a second fact.
  const reported = failure.kind === "unreachable" ? failure.detail : null;

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-3 py-10">
      <h1 className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">{advice.heading}</h1>
      <p className="text-[0.85rem] text-faint">{advice.what}</p>
      {advice.reassurance !== null && (
        <p className="text-[0.85rem] text-faint">{advice.reassurance}</p>
      )}
      <ul className="flex list-none flex-col gap-1.5 text-[0.85rem] text-faint">
        {advice.next.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {/* Evidence, not diagnosis — and the two facts that cost a log read to
          recover during the outage this was built for. */}
      {(target !== null || reported !== null) && (
        <p className="text-[0.75rem] text-faint">
          {target !== null && (
            <>
              {cloud ? "Host" : "Path"}: <span className="font-money">{target}</span>
            </>
          )}
          {target !== null && reported !== null && " · "}
          {reported !== null && (
            <>
              Reported: <span className="font-money">{reported}</span>
            </>
          )}
        </p>
      )}
      <div className="flex gap-2">
        {/* A plain anchor, not <Link>: a soft navigation re-uses the router
            cache, and the entire point of this control is to ask again. */}
        <a
          href={path}
          className="tap44 inline-flex items-center rounded border-2 border-ink px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip"
        >
          Try again
        </a>
      </div>
    </div>
  );
}
