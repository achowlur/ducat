import { describe, expect, it } from "vitest";
import { databaseFailure, databaseTarget, isDatabaseFailure } from "./dbHealth";

/**
 * Every fixture here is a MEASURED shape, reproduced against @prisma/client
 * 7.8.0 + @prisma/adapter-libsql on 2026-08-06 — not a guess at what Prisma
 * throws. The three that matter most are the ones that contradict the outage
 * notes: a model query carries NO `code`, `P2010` also fires for a healthy
 * database asked a bad question, and `P1001`/`P1017` are unreachable through
 * this adapter entirely.
 */

/** A model query (findMany) against a Turso host answering 502 — the 2026-08-04 outage. */
const serverError = () =>
  Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 502"), {
    name: "DriverAdapterError",
    clientVersion: "7.8.0",
    cause: {
      originalMessage: "SERVER_ERROR: Server returned HTTP status 502",
      kind: "sqlite",
      extendedCode: 1,
    },
  });

/** The SAME outage down the $queryRaw path, which is where the recorded P2010 came from. */
const serverErrorRaw = () =>
  Object.assign(
    new Error(
      "Invalid `prisma.$queryRaw()` invocation:\n\nRaw query failed. Code: `N/A`. Message: `SERVER_ERROR: Server returned HTTP status 502`",
    ),
    {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
      clientVersion: "7.8.0",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalMessage: "SERVER_ERROR: Server returned HTTP status 502", kind: "sqlite" },
        },
      },
    },
  );

/** A hostname that does not resolve. Prisma stamps clientVersion on undici's own TypeError. */
const dnsFailure = () =>
  Object.assign(new TypeError("fetch failed"), {
    clientVersion: "7.8.0",
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND ducat-nope.turso.io"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    }),
  });

/** A host that swallows packets: undici's 10s connect timeout, the slow failure. */
const connectTimeout = () =>
  Object.assign(new TypeError("fetch failed"), {
    clientVersion: "7.8.0",
    cause: Object.assign(new Error("Connect Timeout Error (timeout: 10000ms)"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });

/** file: whose parent directory is missing — the one local case that fails to OPEN. */
const cannotOpen = () =>
  Object.assign(new Error('ConnectionFailed("Unable to open connection to local database ./data/nope/x.db: 14")'), {
    code: "",
    clientVersion: "7.8.0",
  });

/** file: pointing at something that is not SQLite. */
const notADatabase = () =>
  Object.assign(new Error("SQLITE_NOTADB: file is not a database"), {
    name: "DriverAdapterError",
    clientVersion: "7.8.0",
    cause: { originalMessage: "SQLITE_NOTADB: file is not a database", kind: "sqlite" },
  });

/** A missing data/ducat.db. libSQL CREATES the file, so this — not an open failure — is the symptom. */
const noSuchTable = () =>
  Object.assign(new Error("SQLITE_ERROR: no such table: main.Setting"), {
    name: "DriverAdapterError",
    clientVersion: "7.8.0",
    cause: { originalCode: "1", originalMessage: "SQLITE_ERROR: no such table: main.Setting", kind: "sqlite" },
  });

describe("databaseFailure", () => {
  it("reports the 502 outage as unreachable, and carries the status as evidence", () => {
    expect(databaseFailure(serverError())).toEqual({ kind: "unreachable", detail: "HTTP 502" });
  });

  it("reads the same outage through the P2010 wrapper the raw path adds", () => {
    // The status lives at meta.driverAdapterError.cause, which has no `cause`
    // chain of its own — walking `cause` alone would miss it entirely.
    expect(databaseFailure(serverErrorRaw())).toEqual({ kind: "unreachable", detail: "HTTP 502" });
  });

  it("reports a transport failure by its own code, fast or slow", () => {
    expect(databaseFailure(dnsFailure())).toEqual({ kind: "unreachable", detail: "ENOTFOUND" });
    expect(databaseFailure(connectTimeout())).toEqual({
      kind: "unreachable",
      detail: "UND_ERR_CONNECT_TIMEOUT",
    });
  });

  it("separates a file that will not open from a file that is not a database", () => {
    // `code` is the EMPTY STRING here: the property exists and is falsy, so a
    // predicate written as `if (e.code)` skips this case silently.
    expect(databaseFailure(cannotOpen())).toEqual({ kind: "unopenable", detail: null });
    expect(databaseFailure(notADatabase())).toEqual({ kind: "not-a-database", detail: null });
  });

  it("names the missing table, because a missing local database presents as one", () => {
    expect(databaseFailure(noSuchTable())).toEqual({ kind: "no-tables", detail: "Setting" });
  });

  /**
   * The false positives that decide the design. Each of these reaches a page's
   * try/catch during ordinary operation, and classifying any of them as a
   * database outage would put a soothing "it may be temporary" on top of a bug —
   * the exact indistinguishability this state exists to end, running backwards.
   */
  it("refuses a failed FRED or SimpleFIN fetch, which is byte-identical but for one field", () => {
    const appFetch = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.stlouisfed.org"), { code: "ENOTFOUND" }),
    });
    // Same constructor, same message, same cause code. Only `clientVersion` —
    // which Prisma stamps on anything it rethrows from a query — separates them.
    expect(databaseFailure(appFetch)).toBeNull();
  });

  it("refuses P2010 from a healthy database asked a bad question", () => {
    const sqlTypo = Object.assign(
      new Error("Invalid `prisma.$queryRawUnsafe()` invocation: Raw query failed. Code: `1`. Message: `SQLITE_ERROR: near \"SELEKT\": syntax error`"),
      {
        name: "PrismaClientKnownRequestError",
        code: "P2010",
        clientVersion: "7.8.0",
        meta: {
          driverAdapterError: {
            cause: { originalCode: "1", originalMessage: 'SQLITE_ERROR: near "SELEKT": syntax error', kind: "sqlite" },
          },
        },
      },
    );
    expect(databaseFailure(sqlTypo)).toBeNull();
  });

  it("refuses ordinary bugs and ordinary Prisma errors", () => {
    const ordinary: unknown[] = [
      new TypeError("Cannot read properties of undefined (reading 'balance')"),
      "a string throw",
      null,
      undefined,
      { message: "no clientVersion here", code: "P2010" },
      Object.assign(new Error("Unique constraint failed on the fields: (`externalId`)"), {
        code: "P2002",
        clientVersion: "7.8.0",
      }),
    ];
    for (const error of ordinary) expect(isDatabaseFailure(error)).toBe(false);
  });
});

describe("databaseTarget", () => {
  it("prints the host for a cloud URL and never the URL itself", () => {
    // A libSQL URL can carry ?authToken=, and this string is rendered on a page.
    const target = databaseTarget("libsql://ducat-prod.turso.io?authToken=SECRET-VALUE");
    expect(target).toBe("ducat-prod.turso.io");
  });

  it("prints the file path in local mode", () => {
    expect(databaseTarget("file:./data/ducat.db")).toBe("./data/ducat.db");
  });

  it("has nothing to print when DATABASE_URL is unset or unparseable", () => {
    expect(databaseTarget(undefined)).toBeNull();
    expect(databaseTarget("")).toBeNull();
    expect(databaseTarget("not-a-url")).toBeNull();
  });
});
