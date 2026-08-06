/**
 * Telling "the database did not answer" apart from "the code is broken".
 *
 * On 2026-08-04 Turso answered every query with HTTP 502 for over two hours and
 * every page fell through to the generic error boundary — the same "Something
 * went wrong" it shows for a null dereference. This module is the classifier
 * that lets a page say which one it is. It is a pure function of a caught error
 * so it can be tested without a database (docs/conventions/ui-and-pages.md).
 *
 * The shapes below were MEASURED against @prisma/client 7.8.0 +
 * @prisma/adapter-libsql, not inferred, and three of the measurements contradict
 * what the outage notes recorded — see the evidence file. The two that decide
 * the code:
 *
 *  - `code` IS NOT A DISCRIMINATOR. A model query (`prisma.account.findMany`)
 *    throws a bare `DriverAdapterError` with NO `code` at all; only the raw path
 *    (`$queryRaw`, which is what /api/diag/timing uses — and where the recorded
 *    `P2010` actually came from) gets wrapped in a `PrismaClientKnownRequestError`.
 *    And `P2010` fires just as happily for a SQL typo against a healthy database.
 *    So the classification hangs on the MESSAGE chain, which is the one field
 *    present in every case.
 *
 *  - `clientVersion` IS THE GATE. A dead Turso host and a dead FRED host both
 *    throw a byte-identical `TypeError: fetch failed` with an ENOTFOUND cause.
 *    The only thing separating them is that Prisma stamps `clientVersion` onto
 *    anything it rethrows from a query. Without this gate a failed rates fetch
 *    inside the same try block reports itself as a database outage — measured,
 *    not theorised.
 */

/** The condition, at the granularity a reader needs a DIFFERENT sentence for. */
export type DatabaseFailureKind =
  /** Nothing answered, or the far end answered with something that was not a result. */
  | "unreachable"
  /** A local file that could not be opened at all — usually a path that isn't there. */
  | "unopenable"
  /** A local file that opened and is not SQLite. */
  | "not-a-database"
  /** Reached and opened, but the table this query needs does not exist. */
  | "no-tables";

export interface DatabaseFailure {
  kind: DatabaseFailureKind;
  /**
   * The one OBSERVED fact about how the attempt ended — a transport code, an
   * HTTP status, a table name. Printed as evidence, never as a diagnosis: the
   * app cannot tell a provider incident from a revoked token from a lapsed
   * plan, and none of them is worth guessing at on a page.
   */
  detail: string | null;
}

/**
 * Node/undici transport codes. Every one of these means the request never came
 * back with an HTTP response, so nothing at the far end ever saw the query.
 */
const TRANSPORT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "HRANA_WEBSOCKET_ERROR",
  "HRANA_CLOSED_ERROR",
]);

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === "object" && value !== null;
}

/**
 * Every link in the `cause` chain, plus the driver error Prisma buries under
 * `meta.driverAdapterError` on the raw path — where it is NOT reachable through
 * `cause`, because that shape has no `cause` at all.
 */
function chain(error: unknown): Loose[] {
  const links: Loose[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && isObject(current); depth += 1) {
    links.push(current);
    const meta = current.meta;
    if (isObject(meta) && isObject(meta.driverAdapterError)) {
      const buried = meta.driverAdapterError;
      links.push(buried);
      if (isObject(buried.cause)) links.push(buried.cause);
    }
    current = current.cause;
  }
  return links;
}

function messagesOf(error: unknown): string[] {
  const messages: string[] = [];
  for (const link of chain(error)) {
    if (typeof link.message === "string") messages.push(link.message);
    // The libSQL adapter's own wrapper keeps the real text here and nowhere else.
    if (typeof link.originalMessage === "string") messages.push(link.originalMessage);
  }
  return messages;
}

function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  for (const link of chain(error)) {
    // A local open failure carries `code: ""` — the property exists and is a
    // string, so an emptiness check is load-bearing rather than defensive.
    if (typeof link.code === "string" && link.code !== "") codes.push(link.code);
  }
  return codes;
}

function firstMatch(messages: string[], pattern: RegExp): RegExpExecArray | null {
  for (const message of messages) {
    const hit = pattern.exec(message);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The condition, or `null` for anything this cannot positively identify —
 * which is every ordinary bug, and must stay that way. Guessing here would put
 * "the database is unreachable" on top of a null dereference and undo the whole
 * point of the exercise.
 */
export function databaseFailure(error: unknown): DatabaseFailure | null {
  if (!isObject(error)) return null;
  if (typeof error.clientVersion !== "string") return null;

  const messages = messagesOf(error);
  const codes = codesOf(error);

  const transport = codes.find((code) => TRANSPORT_CODES.has(code));
  if (transport !== undefined) return { kind: "unreachable", detail: transport };

  // The far end answered, just not with a result. This is the 2026-08-04 shape.
  const status = firstMatch(messages, /Server returned HTTP status (\d{3})/);
  if (status !== null) return { kind: "unreachable", detail: `HTTP ${status[1]}` };

  // A transport failure with no code of its own (undici's blocked-port refusal
  // arrives as a bare `Error: bad port` under a `TypeError: fetch failed`).
  if (messages.some((message) => message.includes("fetch failed"))) {
    return { kind: "unreachable", detail: null };
  }

  if (
    messages.some(
      (message) =>
        message.startsWith("ConnectionFailed(") ||
        message.includes("Unable to open connection to local database"),
    )
  ) {
    return { kind: "unopenable", detail: null };
  }

  if (
    messages.some(
      (message) => message.includes("SQLITE_NOTADB") || message.includes("file is not a database"),
    )
  ) {
    return { kind: "not-a-database", detail: null };
  }

  // libSQL CREATES a missing file rather than refusing it, so this — not an
  // open failure — is what a missing data/ducat.db actually looks like.
  const table = firstMatch(messages, /no such table:\s*(?:main\.)?([A-Za-z_][A-Za-z0-9_]*)/);
  if (table !== null) return { kind: "no-tables", detail: table[1] };

  return null;
}

export function isDatabaseFailure(error: unknown): boolean {
  return databaseFailure(error) !== null;
}

/**
 * What the reader is being told the app could not reach — the Turso HOST or the
 * local file path, never the URL itself: a libSQL URL can carry `?authToken=`,
 * and this string is rendered on a page. Mirrors what /api/diag/timing already
 * prints for the same reason.
 */
export function databaseTarget(url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length).split("?")[0];
    return path === "" ? null : path;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
