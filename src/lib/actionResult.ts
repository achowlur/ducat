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
