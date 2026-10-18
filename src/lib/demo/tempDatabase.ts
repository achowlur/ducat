import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { createClient } from '@libsql/client';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * A scratch SQLite database carrying every migration, for tests that need the
 * real schema (and its indexes) rather than a mock. Never a real database.
 */
export const fileUrl = (file: string) => `file:${file.split('\\').join('/')}`;

/** Runs every migration (or those `keep` allows) against a new database file. */
export async function migrateFile(file: string, keep: (name: string) => boolean = () => true): Promise<void> {
  const db = createClient({ url: fileUrl(file) });
  const dir = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    if (keep(name)) await db.executeMultiple(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
  }
  db.close();
}

export interface TempDatabase {
  dir: string;
  file: string;
  prisma: PrismaClient;
  /** Disconnects and removes the folder; Windows may keep a handle, which is not a failure. */
  dispose(): Promise<void>;
}

export async function createTempDatabase(prefix: string): Promise<TempDatabase> {
  const dir = mkdtempSync(join(tmpdir(), `ducat-${prefix}-`));
  const file = join(dir, 'test.db');
  await migrateFile(file);
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: fileUrl(file) }) });
  return {
    dir,
    file,
    prisma,
    async dispose() {
      await prisma.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // libSQL's native handle can outlive close() on Windows.
      }
    },
  };
}
