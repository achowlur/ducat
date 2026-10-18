import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../generated/prisma/client';
import { flushUsage, meteredFetch, type SqlRunner } from './usage/meter';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * One adapter, two modes (Session 7):
 *   - `file:./data/ducat.db`  → local-first (no auth token, private default)
 *   - `libsql://<db>.turso.io`  → Turso cloud (TURSO_AUTH_TOKEN required)
 * `@prisma/adapter-libsql` accepts both URL schemes, so the whole app switches
 * between local and cloud by DATABASE_URL alone — no per-call-site change.
 *
 * Over the network the client fetches through the usage meter, which reads the
 * rows Turso bills off each response (src/lib/usage/meter.ts).
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const remote = !url.startsWith('file:');
  const adapter = new PrismaLibSql(remote ? { url, authToken, fetch: meteredFetch } : { url, authToken });
  const client = new PrismaClient({ adapter });
  // A command run by hand (npm run upgrade, a sync from the terminal) has no
  // request to flush after, so it writes its counts as it exits. Once: the
  // flush is itself a statement, and its own rows wait for the next writer.
  if (remote && process.env.NEXT_RUNTIME === undefined) {
    process.once('beforeExit', () => void flushUsage(prismaRunner(client)));
  }
  return client;
}

export function prismaRunner(client: PrismaClient): SqlRunner {
  return (sql, args) => client.$executeRawUnsafe(sql, ...args);
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
