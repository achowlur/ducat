import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every foreign key's CHILD column carries an index. Deleting a parent makes
 * SQLite look for rows still pointing at it, and without an index that look is
 * a scan of the whole child table per deleted row. Turso bills rows READ: the
 * demo's nightly reset deleted 7,097 transactions against two unindexed
 * self-references and read ~100 million rows each time, and on 2026-10-17 a
 * handful of resets spent the hosting plan's month of reads in a day
 * (docs/conventions/performance.md).
 */
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

function unindexedForeignKeys(text: string): string[] {
  const missing: string[] = [];
  for (const [, model, body] of text.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const keys = [...body.matchAll(/@relation\([^)]*fields: \[(\w+)\]/g)].map((m) => m[1]);
    // An index or unique constraint LEADING with the column serves the lookup.
    const leading = [...body.matchAll(/@@(?:index|unique)\(\[(\w+)/g)].map((m) => m[1]);
    const own = [...body.matchAll(/^\s*(\w+)\s+\S+.*@(?:id|unique)\b/gm)].map((m) => m[1]);
    for (const key of keys) if (!leading.includes(key) && !own.includes(key)) missing.push(`${model}.${key}`);
  }
  return missing;
}

describe('foreign key indexes', () => {
  it('indexes every foreign key column', () => {
    expect(unindexedForeignKeys(schema)).toEqual([]);
  });

  it('notices one that is missing', () => {
    const bare = 'model A {\n  id String @id\n  bId String\n  b B @relation(fields: [bId], references: [id])\n}';
    expect(unindexedForeignKeys(bare)).toEqual(['A.bId']);
    expect(unindexedForeignKeys(bare.replace('\n}', '\n  @@index([bId])\n}'))).toEqual([]);
  });
});
