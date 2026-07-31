/**
 * The difference between the schema this checkout declares and the schema a
 * database actually has — parsed from DDL on both sides, and split into what
 * can be applied additively and what cannot be applied at all.
 *
 * BOTH SIDES GO THROUGH ONE PARSER, deliberately. The desired side is Prisma's
 * `migrate diff --from-empty` script; the actual side is the CREATE statements
 * SQLite kept in `sqlite_master`, which for a database built by `turso:push` is
 * byte-identical to the first (verified). Reading each side with its own reader
 * — a parser here and `PRAGMA table_info` there — would let the two disagree
 * about nothing at all, and a schema tool that invents a delta is worse than
 * one that finds none.
 *
 * Everything here is pure: text in, a classified delta out. The database work
 * lives in push-schema.ts, so the classification — which is the part that
 * decides whether a financial database gets written to — is testable without
 * one.
 *
 * What SQLite can do additively is a short list, and it is the whole design:
 * CREATE TABLE, ADD COLUMN, CREATE INDEX. There is no ALTER COLUMN, no DROP
 * CONSTRAINT, and adding a NOT NULL column with no default is refused by SQLite
 * itself. Everything outside that list needs the twelve-step table rebuild, so
 * it is REPORTED and REFUSED rather than guessed at.
 *
 * `sqlite_autoindex_*` rows carry a null `sql` and so never reach this parser.
 * That is correct: an implicit index is SQLite's rendering of a UNIQUE or
 * PRIMARY KEY written inside CREATE TABLE, and that text is already compared as
 * part of the table.
 */

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'word' | 'string' | 'quoted' | 'number' | 'punct';
  /** For a quoted identifier, the unquoted name; otherwise the source text. */
  text: string;
  start: number;
  end: number;
}

const QUOTE_CLOSER: Record<string, string> = { '"': '"', '`': '`', '[': ']' };

/**
 * SQL text to tokens, dropping whitespace and comments.
 *
 * Quote-aware because everything downstream is: a column named "unique", a
 * default of 'NOT NULL', or a comma inside a CHECK expression all read as
 * structure to a regex and as data here.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const closer = QUOTE_CLOSER[ch];
      const start = i;
      let text = '';
      i++;
      while (i < sql.length) {
        if (sql[i] === closer) {
          // "" inside a "…" is an escaped quote; ]] is not a thing in SQLite.
          if (closer !== ']' && sql[i + 1] === closer) {
            text += closer;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += sql[i];
        i++;
      }
      tokens.push({ kind: 'quoted', text, start, end: i });
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ kind: 'word', text: sql.slice(start, i), start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < sql.length && /[0-9A-Za-z._+-]/.test(sql[i])) {
        // Only consume a sign as part of an exponent (1e-5), never as an operator.
        if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1] ?? '')) break;
        i++;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, i), start, end: i });
      continue;
    }
    tokens.push({ kind: 'punct', text: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

const isWord = (t: Token | undefined, word: string): boolean =>
  t !== undefined && t.kind === 'word' && t.text.toUpperCase() === word;

const isPunct = (t: Token | undefined, char: string): boolean =>
  t !== undefined && t.kind === 'punct' && t.text === char;

const isIdentifier = (t: Token | undefined): boolean =>
  t !== undefined && (t.kind === 'word' || t.kind === 'quoted');

/** Index of the `)` closing the `(` at `open`, or -1. */
function closingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Token ranges between top-level commas, e.g. the items of a CREATE TABLE body. */
function splitOnCommas(tokens: Token[], from: number, to: number): Token[][] {
  const items: Token[][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) depth--;
    else if (depth === 0 && isPunct(tokens[i], ',')) {
      items.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (start < to) items.push(tokens.slice(start, to));
  return items.filter((item) => item.length > 0);
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Case- and whitespace-insensitive, because SQLite is and hand-applied DDL varies. */
const same = (a: string | null, b: string | null): boolean =>
  collapse(a ?? '').toUpperCase() === collapse(b ?? '').toUpperCase();

// ------------------------------------------------------------------- shapes

export interface Column {
  name: string;
  /** Uppercased declared type; '' when the column was declared without one. */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  references: boolean;
  /** Raw text of the DEFAULT expression, null when there is no DEFAULT. */
  defaultExpr: string | null;
  /** The whole definition, whitespace-collapsed — what ADD COLUMN replays. */
  sql: string;
}

export interface Table {
  name: string;
  columns: Column[];
  /** Table-level items: CONSTRAINT/FOREIGN KEY/PRIMARY KEY/UNIQUE/CHECK. */
  constraints: string[];
  /** Anything after the closing paren: WITHOUT ROWID, STRICT. */
  tail: string;
  /** Source text from the table name onward, so a re-emitted CREATE keeps it. */
  fromName: string;
}

export interface Index {
  name: string;
  table: string;
  unique: boolean;
  /** Indexed columns/expressions, whitespace-collapsed. */
  columns: string;
  /** A partial index's WHERE clause, whitespace-collapsed. */
  tail: string;
  fromName: string;
}

export interface ParsedSchema {
  tables: Table[];
  indexes: Index[];
}

/** Bookkeeping tables that belong to a tool, not to this schema.
 *
 * `_prisma_migrations` is the one that matters: a database created by
 * `prisma migrate` has it and a cloud database created by `turso:push` does
 * not, so comparing it would report a permanent, meaningless delta in one
 * direction. Nothing reads it at runtime (DEPLOY.md step 2 says so). */
export function isInternalTable(name: string): boolean {
  return (
    name === '_prisma_migrations' ||
    name.startsWith('sqlite_') ||
    name.startsWith('libsql_') ||
    name.startsWith('_litestream')
  );
}

// ------------------------------------------------------------------ parsing

/** Words that end the type name and begin the constraints of a column. */
const COLUMN_CONSTRAINT_WORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
]);

/** Words that start a table-level item rather than a column. */
const TABLE_CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

function parseColumn(sql: string, tokens: Token[]): Column {
  const name = tokens[0].text;
  const rest = tokens.slice(1);

  let typeEnd = 0;
  let depth = 0;
  for (const token of rest) {
    if (isPunct(token, '(')) depth++;
    else if (isPunct(token, ')')) depth--;
    else if (depth === 0 && token.kind === 'word' && COLUMN_CONSTRAINT_WORDS.has(token.text.toUpperCase())) break;
    typeEnd++;
  }
  const type =
    typeEnd === 0 ? '' : collapse(sql.slice(rest[0].start, rest[typeEnd - 1].end)).toUpperCase();

  let notNull = false;
  let primaryKey = false;
  let unique = false;
  let references = false;
  let defaultExpr: string | null = null;
  depth = 0;
  for (let i = typeEnd; i < rest.length; i++) {
    const token = rest[i];
    if (isPunct(token, '(')) depth++;
    else if (isPunct(token, ')')) depth--;
    if (depth !== 0 || token.kind !== 'word') continue;
    const word = token.text.toUpperCase();
    if (word === 'NOT' && isWord(rest[i + 1], 'NULL')) notNull = true;
    else if (word === 'PRIMARY' && isWord(rest[i + 1], 'KEY')) primaryKey = true;
    else if (word === 'UNIQUE') unique = true;
    else if (word === 'REFERENCES') references = true;
    else if (word === 'DEFAULT') {
      const value = rest[i + 1];
      if (value !== undefined) {
        // A parenthesised default is an expression and spans to its own close.
        const end = isPunct(value, '(') ? closingParen(rest, i + 1) : i + 1;
        defaultExpr = collapse(sql.slice(value.start, rest[end === -1 ? i + 1 : end].end));
      }
    }
  }

  return {
    name,
    type,
    notNull,
    primaryKey,
    unique,
    references,
    defaultExpr,
    sql: collapse(sql.slice(tokens[0].start, tokens[tokens.length - 1].end)),
  };
}

function parseCreateTable(sql: string, tokens: Token[]): Table | null {
  let i = 1;
  if (isWord(tokens[i], 'TEMP') || isWord(tokens[i], 'TEMPORARY')) i++;
  if (!isWord(tokens[i], 'TABLE')) return null;
  i++;
  if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'EXISTS')) i += 3;
  if (!isIdentifier(tokens[i])) return null;
  const nameToken = tokens[i];
  let name = nameToken.text;
  i++;
  if (isPunct(tokens[i], '.') && isIdentifier(tokens[i + 1])) {
    // schema-qualified: main."Account" — the schema part is not the name.
    name = tokens[i + 1].text;
    i += 2;
  }
  if (!isPunct(tokens[i], '(')) return null;
  const close = closingParen(tokens, i);
  if (close === -1) return null;

  const columns: Column[] = [];
  const constraints: string[] = [];
  for (const item of splitOnCommas(tokens, i + 1, close)) {
    const head = item[0];
    if (head.kind === 'word' && TABLE_CONSTRAINT_WORDS.has(head.text.toUpperCase())) {
      constraints.push(collapse(sql.slice(head.start, item[item.length - 1].end)));
    } else if (isIdentifier(head)) {
      columns.push(parseColumn(sql, item));
    }
  }

  // Bounded by this statement's last token, never by the end of the script:
  // `tokens` is one statement's slice, but `sql` is the whole file, and slicing
  // to its end swept every following statement into this one's tail.
  const end = tokens[tokens.length - 1].end;
  return {
    name,
    columns,
    constraints,
    tail: collapse(sql.slice(tokens[close].end, end)),
    fromName: sql.slice(nameToken.start, end).trim(),
  };
}

function parseCreateIndex(sql: string, tokens: Token[]): Index | null {
  let i = 1;
  const unique = isWord(tokens[i], 'UNIQUE');
  if (unique) i++;
  if (!isWord(tokens[i], 'INDEX')) return null;
  i++;
  if (isWord(tokens[i], 'IF') && isWord(tokens[i + 1], 'NOT') && isWord(tokens[i + 2], 'EXISTS')) i += 3;
  if (!isIdentifier(tokens[i])) return null;
  const nameToken = tokens[i];
  let name = nameToken.text;
  i++;
  if (isPunct(tokens[i], '.') && isIdentifier(tokens[i + 1])) {
    name = tokens[i + 1].text;
    i += 2;
  }
  if (!isWord(tokens[i], 'ON')) return null;
  i++;
  if (!isIdentifier(tokens[i])) return null;
  const table = tokens[i].text;
  i++;
  if (!isPunct(tokens[i], '(')) return null;
  const close = closingParen(tokens, i);
  if (close === -1) return null;

  const end = tokens[tokens.length - 1].end;
  return {
    name,
    table,
    unique,
    columns: splitOnCommas(tokens, i + 1, close)
      .map((item) => collapse(sql.slice(item[0].start, item[item.length - 1].end)))
      .join(', '),
    tail: collapse(sql.slice(tokens[close].end, end)),
    fromName: sql.slice(nameToken.start, end).trim(),
  };
}

/**
 * Every CREATE TABLE and CREATE INDEX in a script. Statements it does not
 * recognise (views, triggers, INSERTs) are ignored rather than guessed at —
 * neither side of this comparison produces any.
 */
export function parseSchemaSql(sql: string): ParsedSchema {
  const tables: Table[] = [];
  const indexes: Index[] = [];
  const all = tokenize(sql);

  let start = 0;
  let depth = 0;
  const flush = (end: number): void => {
    const tokens = all.slice(start, end);
    start = end + 1;
    if (tokens.length === 0 || !isWord(tokens[0], 'CREATE')) return;
    const table = parseCreateTable(sql, tokens);
    if (table !== null) {
      tables.push(table);
      return;
    }
    const index = parseCreateIndex(sql, tokens);
    if (index !== null) indexes.push(index);
  };
  for (let i = 0; i < all.length; i++) {
    if (isPunct(all[i], '(')) depth++;
    else if (isPunct(all[i], ')')) depth--;
    else if (depth === 0 && isPunct(all[i], ';')) flush(i);
  }
  flush(all.length);

  return { tables, indexes };
}

// -------------------------------------------------------------------- delta

export interface Change {
  kind: 'create table' | 'add column' | 'create index' | 'replace index';
  /** The table it lands on, so the caller can price it in rows. */
  table: string;
  summary: string;
  statements: string[];
  /** Printed as a caution when `table` turns out to hold rows. */
  cautionIfRows?: string;
}

export interface Refusal {
  table: string;
  summary: string;
  reason: string;
}

export interface Notice {
  summary: string;
  reason: string;
}

export interface Delta {
  changes: Change[];
  refusals: Refusal[];
  notices: Notice[];
}

const key = (name: string): string => name.toLowerCase();
const byName = <T extends { name: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [key(item.name), item]));

const quote = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const createTable = (t: Table): string => `CREATE TABLE IF NOT EXISTS ${t.fromName}`;

const createIndex = (i: Index): string =>
  `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${i.fromName}`;

/**
 * Why SQLite will not add this column to a table holding `rows`, or null if it
 * will. These are the engine's own limits, so attempting one fails the batch
 * rather than doing something regrettable — reporting them up front is the
 * difference between reading a plan and reading a stack trace.
 *
 * MEASURED against libSQL 3.45.1 (scripts probing every combination on an empty
 * table and a populated one), not taken from the documentation, which describes
 * all of these as unconditional and is wrong about three:
 *
 *   PRIMARY KEY / UNIQUE            rejected always
 *   NOT NULL with no DEFAULT        rejected only when the table has rows
 *   non-constant DEFAULT            rejected only when the table has rows
 *   REFERENCES + non-NULL default   rejected only when the table has rows
 *
 * Which is why this takes a row count at all. The two databases differ in which
 * tables are EMPTY — `TrackedSubscription` holds nothing locally and two rows in
 * the cloud — so a row-blind answer is wrong on one of them whichever way it
 * goes: refuse always and the empty side is sent off to hand-write a rebuild it
 * did not need; allow always and the dry run promises the populated side
 * something the engine will reject.
 *
 * An unknown count reads as "has rows", so a caller that forgets to pass one is
 * over-strict rather than over-permissive.
 */
export function whyCannotAdd(column: Column, rows: number | undefined): string | null {
  if (column.primaryKey) return 'SQLite cannot ADD a PRIMARY KEY column, empty table or not.';
  if (column.unique) return 'SQLite cannot ADD a UNIQUE column, empty table or not.';
  if (rows === 0) return null;
  const held = rows === undefined ? 'may hold rows' : `holds ${rows} row${rows === 1 ? '' : 's'}`;
  if (column.notNull && column.defaultExpr === null) {
    return `SQLite adds a NOT NULL column with no DEFAULT only to an EMPTY table, and this one ${held} — they would have nothing to put in it.`;
  }
  if (column.defaultExpr !== null && !isConstantDefault(column.defaultExpr)) {
    return `SQLite adds a column whose DEFAULT is not a constant only to an EMPTY table, and this one ${held}: ${column.defaultExpr} is evaluated per row.`;
  }
  if (column.references && column.defaultExpr !== null && !same(column.defaultExpr, 'NULL')) {
    return `SQLite adds a REFERENCES column with a non-NULL default only to an EMPTY table, and this one ${held}.`;
  }
  return null;
}

function isConstantDefault(expr: string): boolean {
  if (expr.startsWith('(')) return false;
  return !/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(expr);
}

const REBUILD = 'SQLite has no ALTER COLUMN: this needs the table rebuilt (create the new shape, copy the rows across, drop, rename).';

/** The first way these two disagree, phrased database → schema, or null. */
export function columnDifference(want: Column, have: Column): string | null {
  if (!same(want.type, have.type)) return `type ${have.type || '(none)'} → ${want.type || '(none)'}`;
  if (want.notNull !== have.notNull) return have.notNull ? 'NOT NULL → nullable' : 'nullable → NOT NULL';
  if (!same(want.defaultExpr, have.defaultExpr)) {
    return `default ${have.defaultExpr ?? '(none)'} → ${want.defaultExpr ?? '(none)'}`;
  }
  if (want.primaryKey !== have.primaryKey) return have.primaryKey ? 'drops PRIMARY KEY' : 'adds PRIMARY KEY';
  if (want.unique !== have.unique) return have.unique ? 'drops UNIQUE' : 'adds UNIQUE';
  return null;
}

function diffColumns(want: Table, have: Table, rows: number | undefined, delta: Delta): void {
  const haveColumns = byName(have.columns);
  const wantColumns = byName(want.columns);
  const missing = want.columns.filter((c) => !haveColumns.has(key(c.name)));
  const extra = have.columns.filter((c) => !wantColumns.has(key(c.name)));

  for (const column of missing) {
    // A column missing here while another sits there unaccounted for is exactly
    // what a rename looks like, and adding one without dropping the other would
    // leave the values stranded in a column nothing reads.
    if (extra.length > 0) {
      delta.refusals.push({
        table: want.name,
        summary: `${want.name}.${column.name} — in the schema, not in the database`,
        reason: `${extra.map((c) => `${want.name}.${c.name}`).join(', ')} ${extra.length === 1 ? 'is' : 'are'} in the database and not in the schema, so this may be a RENAME rather than a new column. Adding it would leave the old values behind in a column nothing reads.`,
      });
      continue;
    }
    const blocked = whyCannotAdd(column, rows);
    if (blocked !== null) {
      delta.refusals.push({
        table: want.name,
        summary: `${want.name}.${column.name} — in the schema, not in the database`,
        reason: blocked,
      });
      continue;
    }
    delta.changes.push({
      kind: 'add column',
      table: want.name,
      summary: `${want.name}.${column.name}  ${column.sql.slice(column.name.length + 2).trim()}`,
      statements: [`ALTER TABLE ${quote(want.name)} ADD COLUMN ${column.sql}`],
    });
  }

  for (const column of extra) {
    delta.refusals.push({
      table: want.name,
      summary: `${want.name}.${column.name} — in the database, not in the schema`,
      reason:
        missing.length > 0
          ? 'This may be the other half of a rename. Either way, dropping a column destroys its values, so nothing here drops it.'
          : 'Dropping a column destroys its values, so nothing here drops it. Drop it by hand if the field is gone for good.',
    });
  }

  for (const column of want.columns) {
    const existing = haveColumns.get(key(column.name));
    if (existing === undefined) continue;
    const difference = columnDifference(column, existing);
    if (difference !== null) {
      delta.refusals.push({
        table: want.name,
        summary: `${want.name}.${column.name} — ${difference}`,
        reason: REBUILD,
      });
    }
  }
}

function diffConstraints(want: Table, have: Table, delta: Delta): void {
  const norm = (items: string[]): string[] => items.map((c) => collapse(c).toUpperCase()).sort();
  const wanted = norm(want.constraints);
  const held = norm(have.constraints);
  const added = want.constraints.filter((c) => !held.includes(collapse(c).toUpperCase()));
  const removed = have.constraints.filter((c) => !wanted.includes(collapse(c).toUpperCase()));

  for (const constraint of added) {
    delta.refusals.push({
      table: want.name,
      summary: `${want.name} — the schema declares a table constraint the database does not have`,
      reason: `${constraint}\n      SQLite cannot add a table constraint (a foreign key, a table-level UNIQUE, a CHECK) to a table that exists. ${REBUILD}`,
    });
  }
  for (const constraint of removed) {
    delta.refusals.push({
      table: want.name,
      summary: `${want.name} — the database has a table constraint the schema does not declare`,
      reason: `${constraint}\n      SQLite cannot drop a table constraint. ${REBUILD}`,
    });
  }
  if (!same(want.tail, have.tail)) {
    delta.refusals.push({
      table: want.name,
      summary: `${want.name} — table options ${have.tail || '(none)'} → ${want.tail || '(none)'}`,
      reason: REBUILD,
    });
  }
}

function diffIndexes(desired: ParsedSchema, actual: ParsedSchema, delta: Delta): void {
  const held = byName(actual.indexes);
  const wanted = byName(desired.indexes);
  const knownTables = new Set(desired.tables.map((t) => key(t.name)));

  for (const index of desired.indexes) {
    const existing = held.get(key(index.name));
    if (existing === undefined) {
      delta.changes.push({
        kind: 'create index',
        table: index.table,
        summary: `${index.name}  ${index.unique ? 'unique ' : ''}on ${index.table}(${index.columns})`,
        statements: [createIndex(index)],
        cautionIfRows: index.unique
          ? 'a UNIQUE index fails, and takes the whole batch with it, if those rows already hold a duplicate'
          : undefined,
      });
      continue;
    }
    const differs =
      existing.unique !== index.unique ||
      !same(existing.table, index.table) ||
      !same(existing.columns, index.columns) ||
      !same(existing.tail, index.tail);
    if (differs) {
      // An index carries no data of its own, so replacing one loses nothing —
      // the only additive-adjacent statement here that is allowed to drop.
      delta.changes.push({
        kind: 'replace index',
        table: index.table,
        summary: `${index.name}  ${existing.unique ? 'unique ' : ''}on ${existing.table}(${existing.columns}) → ${index.unique ? 'unique ' : ''}on ${index.table}(${index.columns})`,
        statements: [`DROP INDEX IF EXISTS ${quote(index.name)}`, createIndex(index)],
        cautionIfRows: index.unique
          ? 'a UNIQUE index fails, and takes the whole batch with it, if those rows already hold a duplicate'
          : undefined,
      });
    }
  }

  for (const index of actual.indexes) {
    // An index on a table the schema does not have is already covered by that
    // table's own refusal; reporting it again is noise.
    if (wanted.has(key(index.name)) || !knownTables.has(key(index.table)) || isInternalTable(index.table)) continue;
    delta.notices.push({
      summary: `${index.name} on ${index.table}(${index.columns}) is in the database and not in the schema`,
      reason: index.unique
        ? 'Left alone — it may be yours. Note that a UNIQUE index still enforces a constraint the schema no longer declares, so a write the app now considers legal will fail.'
        : 'Left alone — an extra index costs write time and nothing else, and it may be one you added on purpose.',
    });
  }
}

/**
 * What it would take to make `actual` match `desired`.
 *
 * A missing table plus an unaccounted-for table is the ambiguous case this
 * cannot resolve and does not try to: a rename needs the rows carried across
 * and a drop-plus-add does not, and no amount of DDL comparison tells them
 * apart. Both halves are refused, loudly, rather than half-guessed.
 *
 * `rows` is how many rows each existing table holds, which decides three of the
 * five ADD COLUMN limits (see whyCannotAdd). Omitting it is safe and strict.
 */
export function diffSchema(
  desired: ParsedSchema,
  actual: ParsedSchema,
  rows: ReadonlyMap<string, number> = new Map(),
): Delta {
  const delta: Delta = { changes: [], refusals: [], notices: [] };

  const held = byName(actual.tables.filter((t) => !isInternalTable(t.name)));
  const wanted = byName(desired.tables);
  const missing = desired.tables.filter((t) => !held.has(key(t.name)));
  const extra = [...held.values()].filter((t) => !wanted.has(key(t.name)));

  for (const table of missing) {
    delta.changes.push({
      kind: 'create table',
      table: table.name,
      summary: `${table.name}  new table, ${table.columns.length} columns`,
      statements: [createTable(table)],
    });
  }

  for (const table of extra) {
    delta.refusals.push({
      table: table.name,
      summary: `${table.name} — table is in the database and not in the schema`,
      reason:
        missing.length > 0
          ? `Nothing here can tell a removed model from a table renamed to ${missing.map((t) => t.name).join(' / ')}, and a rename means moving the rows across first. Sort it out by hand.`
          : 'Dropping a table destroys every row in it, so nothing here drops it. Drop it by hand if the model is gone for good.',
    });
  }

  for (const table of desired.tables) {
    const existing = held.get(key(table.name));
    if (existing === undefined) continue;
    diffColumns(table, existing, rows.get(existing.name), delta);
    diffConstraints(table, existing, delta);
  }

  diffIndexes(desired, actual, delta);
  return delta;
}

/** Every statement in the order it must run: tables, then columns, then indexes. */
export function statementsOf(delta: Delta): string[] {
  const order: Change['kind'][] = ['create table', 'add column', 'replace index', 'create index'];
  return order.flatMap((kind) =>
    delta.changes.filter((c) => c.kind === kind).flatMap((c) => c.statements),
  );
}
