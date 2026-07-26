import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * One adapter, two modes (Session 7):
 *   - `file:./data/ducat.db`  → local-first (no auth token, private default)
 *   - `libsql://<db>.turso.io`  → Turso cloud (TURSO_AUTH_TOKEN required)
 * `@prisma/adapter-libsql` accepts both URL schemes, so the whole app switches
 * between local and cloud by DATABASE_URL alone — no per-call-site change.
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const adapter = new PrismaLibSql({ url, authToken });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
