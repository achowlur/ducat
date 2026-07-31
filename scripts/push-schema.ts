/**
 * The schema delta between this checkout and a database that already has data,
 * printed by default and applied only with `--apply`.
 *
 *   npm run schema:push                                   # LOCAL, report only
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run schema:push
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run schema:push -- --apply
 *
 * This is the last manual step in the upgrade path. `npm run upgrade` carries a
 * new version's RULES to an existing database; nothing carried its SCHEMA,
 * because `prisma migrate deploy` cannot reach libSQL over HTTP — so a column
 * added in a release reached the cloud only if someone remembered to hand-write
 * the ALTER. A green deploy says nothing about it: the build never touches the
 * database, and the first symptom is a PrismaClientValidationError on whichever
 * page reads the new field.
 *
 * `turso:push` is the sibling for an EMPTY database: it applies the whole
 * baseline and refuses anything else, because a baseline is not idempotent.
 * This one is the opposite case and is safe to run repeatedly — apply it, run
 * it again, and it reports nothing to do.
 *
 * It refuses far more than it applies, and that is the design. SQLite can add a
 * table, a column and an index; it cannot alter a column, drop a constraint, or
 * tell a rename from a drop-and-add. Everything outside the additive set is
 * printed under "cannot apply" with the row count at stake and left for a human
 * — and one refusal blocks the whole run, because a half-applied schema is
 * harder to reason about than one that was never touched.
 */
import 'dotenv/config';
import { createClient, type Client } from '@libsql/client';
import { baselineSql } from './copyDatabase';
import { printDatabase } from './database-label';
import { hasFlag } from './args';
import { diffSchema, isInternalTable, parseSchemaSql, statementsOf, type Delta } from './schema-delta';

/** The same filter `turso:push` uses to decide a database is empty, so the two
 * commands cannot disagree about which one you are supposed to run. */
const SCHEMA_SQL =
  "select sql from sqlite_master where type in ('table', 'index') and sql is not null" +
  " and name not like 'sqlite_%' and name not like 'libsql_%' and name not like '_litestream%'" +
  ' order by type, name';

/** What the database has, as the DDL that built it — the text SQLite kept. */
async function actualSchemaSql(client: Client): Promise<string> {
  const result = await client.execute(SCHEMA_SQL);
  return result.rows.map((r) => String(r.sql)).join(';\n');
}

/**
 * Rows per table, in ONE round trip rather than one per table — on Turso the
 * number of round trips is the cost, not the size of any of them.
 *
 * Needed BEFORE the diff, not after: whether a column can be added at all
 * depends on whether its table is empty (see whyCannotAdd). And a refusal that
 * says "2638 rows" tells the operator what is at stake, where one that says
 * "a table" makes them go and look.
 */
async function rowCounts(client: Client, tables: string[]): Promise<Map<string, number>> {
  if (tables.length === 0) return new Map();
  const result = await client.execute(
    tables
      .map((t) => `select '${t.replace(/'/g, "''")}' as t, count(*) as c from "${t.replace(/"/g, '""')}"`)
      .join(' union all '),
  );
  return new Map(result.rows.map((r) => [String(r.t), Number(r.c)]));
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function report(delta: Delta, counts: Map<string, number>): void {
  // One refusal blocks the whole run, so the additive list must not be headed
  // "will apply" when it will not — the two lists are the entire point of the
  // output and a heading that overstates one of them is the way to be misread.
  const blocked = delta.refusals.length > 0;
  if (delta.changes.length > 0) {
    const statements = statementsOf(delta).length;
    console.log(
      blocked
        ? `\nCOULD APPLY — ${plural(delta.changes.length, 'safe change')}, BLOCKED by the list below:`
        : `\nWILL APPLY — ${plural(delta.changes.length, 'change')}, ${plural(statements, 'statement')}:`,
    );
    for (const change of delta.changes) {
      console.log(`  + ${change.kind.padEnd(14)} ${change.summary}`);
      const rows = counts.get(change.table);
      if (change.cautionIfRows !== undefined && rows !== undefined && rows > 0) {
        console.log(`      caution: ${change.table} holds ${plural(rows, 'row')} — ${change.cautionIfRows}`);
      }
    }
  }

  if (delta.refusals.length > 0) {
    console.log(`\nCANNOT APPLY — ${plural(delta.refusals.length, 'change')} this cannot make safely:`);
    for (const refusal of delta.refusals) {
      const rows = counts.get(refusal.table);
      console.log(`  ! ${refusal.summary}${rows === undefined ? '' : `  (${plural(rows, 'row')})`}`);
      console.log(`      ${refusal.reason}`);
    }
  }

  if (delta.notices.length > 0) {
    console.log(`\nLEFT ALONE — ${plural(delta.notices.length, 'thing')} the schema does not declare:`);
    for (const notice of delta.notices) {
      console.log(`  · ${notice.summary}`);
      console.log(`      ${notice.reason}`);
    }
  }
}

/**
 * The way out, and it has to be exact: `--from-url` was REMOVED in Prisma 7,
 * and the replacement takes its URL from prisma.config.ts — which reads
 * DATABASE_URL. So the backup file is named by the environment variable, not by
 * a flag, and the flag that looks right fails with a usage dump.
 */
function printByHandRoute(): void {
  console.error('\nTo make these by hand, have Prisma write the migration against a COPY of');
  console.error('the database, read it, and run the parts you mean:');
  console.error('  npm run cloud:backup     # a local .db copy of the cloud database');
  console.error('  DATABASE_URL="file:./data/backups/<file>" npx prisma migrate diff \\');
  console.error('      --from-config-datasource --to-schema prisma/schema.prisma --script');
  console.error('That script has the table rebuilds SQLite needs and this cannot do. It also');
  console.error('DROPS what this refuses to drop, rows and all, so read it before running any.');
}

async function main(): Promise<void> {
  // First line, before anything is read or written. Two databases exist and the
  // same command against the wrong one is the mistake this whole convention is
  // built to stop.
  printDatabase();

  const apply = hasFlag('apply');
  const configured = process.env.DATABASE_URL;
  if (apply && (configured === undefined || configured === '')) {
    throw new Error(
      'DATABASE_URL is not set, and --apply will not fall back to the local default.\n' +
        'Name the database you mean:\n' +
        '  DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run schema:push -- --apply',
    );
  }
  const url = configured ?? 'file:./data/ducat.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url.startsWith('libsql://') && (authToken === undefined || authToken === '')) {
    throw new Error('TURSO_AUTH_TOKEN is required for a libsql:// URL.');
  }

  const desired = parseSchemaSql(baselineSql());
  if (desired.tables.length === 0) {
    throw new Error('Prisma produced no CREATE TABLE from prisma/schema.prisma. Refusing to compare against nothing.');
  }

  const client = createClient({ url, authToken });
  try {
    const actual = parseSchemaSql(await actualSchemaSql(client));
    // Counted apart, or the header reads as a delta of its own: a database made
    // by `prisma migrate` carries _prisma_migrations and one made by
    // `turso:push` does not, and neither is a difference in the schema.
    const internal = actual.tables.filter((t) => isInternalTable(t.name));
    console.log(
      `Schema:   prisma/schema.prisma — ${plural(desired.tables.length, 'table')}, ${plural(desired.indexes.length, 'index', 'indexes')}`,
    );
    console.log(
      `Database: ${plural(actual.tables.length - internal.length, 'table')}, ${plural(actual.indexes.length, 'index', 'indexes')}` +
        (internal.length === 0 ? '' : `, plus ${internal.map((t) => t.name).join(', ')} (not compared)`),
    );

    if (actual.tables.length === 0) {
      console.error('\nThis database is EMPTY — there is no delta to take against nothing.');
      console.error('Apply the baseline instead, which creates every table in one go:');
      console.error('  DATABASE_URL="…" TURSO_AUTH_TOKEN="…" npm run turso:push');
      console.error('Then `npm run rules:install` for the starter pack (DEPLOY.md step 3).');
      process.exitCode = 1;
      return;
    }

    const counts = await rowCounts(
      client,
      actual.tables.filter((t) => !isInternalTable(t.name)).map((t) => t.name),
    );
    const delta = diffSchema(desired, actual, counts);
    report(delta, counts);

    if (delta.changes.length === 0 && delta.refusals.length === 0) {
      console.log('\nUp to date — this database matches prisma/schema.prisma.');
      return;
    }

    const statements = statementsOf(delta);
    if (delta.refusals.length > 0) {
      console.error(
        `\nRefusing to apply anything${delta.changes.length > 0 ? `, including the ${plural(delta.changes.length, 'change')} above that would have been safe` : ''}.`,
      );
      console.error('A half-applied schema is harder to reason about than one nothing has touched.');
      printByHandRoute();
      console.error('\nThen re-run this: what is left will be the additive part, and it will apply.');
      process.exitCode = 1;
      return;
    }

    console.log('\nSQL:');
    for (const statement of statements) console.log(`  ${statement.replace(/\n/g, '\n  ')};`);

    if (!apply) {
      console.log(`\nDry run — nothing written. Re-run with \`-- --apply\` to run ${plural(statements.length, 'statement')}.`);
      return;
    }

    if (url.startsWith('file:')) {
      console.log('\nNote: this is a local file. `npx prisma migrate dev` is the normal path here —');
      console.log('it writes a migration under prisma/migrations/ as well as changing the database.');
    }

    // One transaction: DDL is transactional in SQLite, so a statement that
    // fails (a UNIQUE index over rows that already hold a duplicate) takes the
    // whole batch with it rather than leaving half a schema behind. Verified,
    // not assumed — a failing index left an earlier CREATE TABLE unapplied.
    try {
      await client.batch(statements, 'write');
    } catch (e) {
      // Said plainly, because the engine's own message does not: a bare
      // SQLITE_CONSTRAINT leaves the operator unsure how much of it landed.
      console.error('\nThe batch FAILED, and NOTHING was applied — the statements run in one');
      console.error('transaction, so the database is exactly as it was:');
      console.error(`  ${e instanceof Error ? e.message : String(e)}`);
      console.error('\nFix the data the statement objects to, then re-run.');
      process.exitCode = 1;
      return;
    }
    console.log(`\nApplied ${plural(statements.length, 'statement')}.`);

    // Re-read rather than assume. The claim being made is that the database now
    // matches the schema, and only the database can say so. Same counts: DDL
    // moved no rows, and without them a surviving delta would be explained
    // wrongly ("may hold rows") in the one place accuracy still matters.
    const after = diffSchema(desired, parseSchemaSql(await actualSchemaSql(client)), counts);
    if (after.changes.length > 0 || after.refusals.length > 0) {
      console.error('\nVerification FAILED — a delta survives the apply:');
      report(after, counts);
      process.exitCode = 1;
      return;
    }
    console.log('Verified: this database now matches prisma/schema.prisma.');
    console.log('\nRun `npm run upgrade` too if this version also ships rules — DATA does not travel with git push.');
  } finally {
    client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
