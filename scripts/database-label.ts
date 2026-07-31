/**
 * Which database a command is about to touch, printed before it touches it.
 *
 * Every script that writes rows says this first, because CODE ships through git
 * and DATA does not, so the same command run twice against two `DATABASE_URL`s
 * is the normal way to finish a change — and running it twice against the SAME
 * one is the normal way to think you have.
 *
 * `sync:simplefin` was the one command that did not say it, and it cost an hour:
 * a shell still holding the cloud URL from an earlier command ran a "local"
 * sync against Turso, which reported `0 imported` because Turso already had
 * everything. That reads exactly like "you are up to date" while local sat two
 * transactions and several balances behind. `0 imported` is ambiguous about
 * WHICH database is up to date; the label is what disambiguates it.
 *
 * The host of a `libsql://` URL is safe to print — the credential is the
 * separate TURSO_AUTH_TOKEN, never the URL.
 */
export function databaseLabel(url: string = process.env.DATABASE_URL ?? 'file:./data/ducat.db'): string {
  return url.startsWith('libsql://') ? `CLOUD — ${new URL(url).host}` : `LOCAL — ${url}`;
}

/** The same label as a line, for commands that lead with it. */
export function printDatabase(): void {
  console.log(`\nDatabase: ${databaseLabel()}`);
}
