/**
 * Applies the schema to the database named by DATABASE_URL, without the Turso CLI.
 *
 *   DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run turso:push
 *
 * Why this exists: the Turso CLI has no native Windows build — the documented
 * install is WSL-only — and DEPLOY.md's step 2 piped `prisma migrate diff` into
 * `turso db shell`. This does the same work over HTTPS with `@libsql/client`,
 * already a dependency because the Prisma adapter is built on it.
 *
 * It REFUSES a database that already has tables. A baseline is not idempotent:
 * run it twice and every CREATE TABLE fails, leaving a half-applied schema and
 * no clear signal of which half. Refusing is the whole safety story here, since
 * the destination is whatever DATABASE_URL happens to hold — including, if you
 * are careless, the SQLite file with all your real transactions in it.
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** The schema as one SQL script, derived from schema.prisma (not replayed from
 * prisma/migrations), so it is current by construction. Invoked directly rather
 * than through npm, which prepends its own banner to stdout.
 *
 * Runs Prisma's JS entrypoint under this same node, not `.bin/prisma`: since
 * the CVE-2024-27980 mitigation, Node refuses to spawn a Windows `.cmd` shim
 * without `shell: true`, and passing arguments through a shell is a worse
 * trade than resolving the entrypoint. */
function baselineSql(): string {
  const entry = createRequire(import.meta.url).resolve('prisma/build/index.js');
  return execFileSync(
    process.execPath,
    [entry, 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    // Deliberately no default. Falling back to the local file would silently
    // point a schema push at the operator's own data.
    throw new Error('DATABASE_URL is not set. Pass it inline:\n  DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run turso:push');
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url.startsWith('libsql://') && (authToken === undefined || authToken === '')) {
    throw new Error('TURSO_AUTH_TOKEN is required for a libsql:// URL.');
  }
  // The host is safe to print; a libsql:// URL carries no credentials (the
  // token travels in a header), unlike the SimpleFIN access URL.
  console.log(`Target: ${url.startsWith('file:') ? url : new URL(url).host}`);

  const client = createClient({ url, authToken });
  try {
    const existing = await client.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'libsql_%' and name not like '_litestream%' order by name",
    );
    const tables = existing.rows.map((r) => String(r.name));
    if (tables.length > 0) {
      console.error(`\nRefusing to push: this database already has ${tables.length} table(s).`);
      console.error(`  ${tables.join(', ')}`);
      console.error('\nA baseline only applies to an EMPTY database. If this is a fresh Turso');
      console.error('database you meant to reset, destroy and recreate it, then re-run.');
      process.exitCode = 1;
      return;
    }

    const sql = baselineSql();
    const statements = sql.split(';').filter((s) => s.trim() !== '').length;
    console.log(`Applying ${statements} statements…`);
    await client.executeMultiple(sql);

    const after = await client.execute(
      "select type, name from sqlite_master where name not like 'sqlite_%' order by type, name",
    );
    const created = after.rows.filter((r) => r.type === 'table').map((r) => String(r.name));
    const indexes = after.rows.filter((r) => r.type === 'index').length;
    console.log(`\nCreated ${created.length} tables and ${indexes} indexes:`);
    console.log(`  ${created.join(', ')}`);
    console.log('\nNext: seed the starter pack (DEPLOY.md step 3).');
  } finally {
    client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
