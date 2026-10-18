import { describe, expect, it } from 'vitest';
import { databaseRefusal, settleAction } from './actionResult';

/**
 * "Sync now" handed the reader whatever its catch held: Turso's raw refusal
 * text when the plan's reads were spent, and nothing at all (the whole-page
 * error boundary) when the function was stopped at its time limit.
 */

const readsBlocked = () =>
  Object.assign(
    new Error(
      'Invalid `prisma.setting.findUnique()` invocation:\n\nDatabase error. Code: `N/A`. Message: `BLOCKED: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)`',
    ),
    { name: 'PrismaClientKnownRequestError', code: 'P2039', clientVersion: '7.10.0', meta: {} },
  );

describe('databaseRefusal', () => {
  it('names a host that blocked reads, in a sentence with none of the driver text', () => {
    const refusal = databaseRefusal(readsBlocked());
    expect(refusal?.ok).toBe(false);
    expect(refusal?.message).toContain('blocked reads');
    expect(refusal?.message).toContain('usage limit');
    expect(refusal?.message).not.toMatch(/BLOCKED|prisma|invocation/);
    expect(refusal?.message).not.toContain('—');
  });

  it('names a database that did not answer', () => {
    const outage = Object.assign(new Error('Server returned HTTP status 502'), { clientVersion: '7.10.0' });
    expect(databaseRefusal(outage)?.message).toMatch(/did not answer/);
  });

  it('stays out of the way of anything that is not the database', () => {
    expect(databaseRefusal(new Error('SimpleFIN request failed: 403 Forbidden'))).toBeNull();
    expect(databaseRefusal('not even an error')).toBeNull();
  });
});

describe('settleAction', () => {
  it('turns a call that never came back into a refusal beside the control', async () => {
    const timedOut = () => Promise.reject(new Error('An unexpected response was received from the server.'));
    expect(await settleAction(timedOut, 'The sync stopped answering.')).toEqual({ ok: false, message: 'The sync stopped answering.' });
  });

  it('passes an answer through untouched, refusals included', async () => {
    const answer = { ok: true, message: 'Synced 3 new transactions.' };
    expect(await settleAction(() => Promise.resolve(answer), 'unused')).toBe(answer);
    const refused = { ok: false, message: 'A sync is already running.' };
    expect(await settleAction(() => Promise.resolve(refused), 'unused')).toBe(refused);
  });
});
