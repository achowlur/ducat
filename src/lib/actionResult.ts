import { databaseFailure } from "./ui/dbHealth";

/**
 * What a server action returns when it REFUSES: a sentence for the person who
 * asked, shown beside the control they used.
 *
 * A refusal is a value, never a throw. Next replaces a thrown error's message
 * with a fixed placeholder in production builds, so a refusal thrown as an
 * Error reached the reader either as that placeholder (where a client printed
 * `e.message`) or as the whole-page error boundary (where nothing caught it).
 * Either way the one thing they needed, why it was refused, never arrived.
 * `syncNow` (app/actions.ts) already worked this way.
 *
 * Only the UNEXPECTED still throws: a database that cannot be reached, a row
 * that vanished. That is what the boundary is for, and it says so honestly
 * without knowing which (app/error.tsx).
 */
export type Refusal = { ok: false; message: string };

export type ActionResult<T extends object = object> = ({ ok: true } & T) | Refusal;

export function refuse(message: string): Refusal {
  return { ok: false, message };
}

/**
 * The database's own failure, named, for an action that would otherwise hand
 * its raw text to the reader ("BLOCKED: Operation was blocked: SQL read
 * operations are forbidden..."). Null for anything databaseFailure cannot
 * positively identify, which the caller reports as it did before.
 */
export function databaseRefusal(error: unknown): Refusal | null {
  const failure = databaseFailure(error);
  if (failure === null) return null;
  switch (failure.kind) {
    case "usage-blocked":
      return refuse(
        `The database host blocked ${failure.detail ?? "access"}: its plan's usage limit for the month is spent. ` +
          "Nothing stored was lost, and this works again once the allowance resets or the plan is raised.",
      );
    case "unreachable":
      return refuse("The database did not answer. Anything already saved is kept; try again in a few minutes.");
    default:
      return refuse("The database could not be used. Check that DATABASE_URL points at it.");
  }
}

/**
 * Awaits a server action from a client control and turns a call that never
 * came back (a function stopped at its time limit, a dropped connection) into
 * a refusal shown beside the control. Uncaught, it fell through to the whole
 * page's error boundary, which cannot say what happened.
 */
export async function settleAction<T extends { ok: boolean; message: string }>(
  call: () => Promise<T>,
  noAnswer: string,
): Promise<T | Refusal> {
  try {
    return await call();
  } catch {
    return refuse(noAnswer);
  }
}
