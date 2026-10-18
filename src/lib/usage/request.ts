import { after } from 'next/server';
import { isCloudMode } from '../auth/mode';
import { prisma, prismaRunner } from '../prisma';
import { flushUsage, recordUsage } from './meter';

/**
 * Counts one request served and writes the meter's counts AFTER the response,
 * so the reader never waits on it. Called by every page (withDatabaseNotice)
 * and by the cron.
 *
 * Cloud mode only. Locally there is no host allowance to count against, and a
 * local database is a mirror that must not be written on a page view.
 */
export function meterRequest(): void {
  if (!isCloudMode()) return;
  recordUsage('app.requests', 1);
  try {
    after(() => flushUsage(prismaRunner(prisma)));
  } catch {
    // Outside a request (a test rendering a page): nothing to schedule. The
    // counts stay pending for the next request that can write them.
  }
}
