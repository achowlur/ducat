import { describe, expect, it } from 'vitest';
import { cronSummary, STATUS_CHIP, STATUS_DOT } from './providers';
import vercelConfig from '../../../vercel.json';

describe('cronSummary', () => {
  /**
   * The page reads this from vercel.json rather than retyping it, so the
   * sentence cannot drift from the cron that actually fires. This test is what
   * makes that guarantee real: change the schedule and the words change with
   * it, or this fails.
   */
  it('puts the SHIPPED schedule into words', () => {
    expect(vercelConfig.crons[0].schedule).toBe('0 23 * * *');
    expect(cronSummary(vercelConfig.crons[0].schedule)).toBe('once a day at 23:00 UTC');
  });

  it('pads a single-digit hour, so it reads as a clock time', () => {
    expect(cronSummary('0 7 * * *')).toBe('once a day at 07:00 UTC');
    expect(cronSummary('0 0 * * *')).toBe('once a day at 00:00 UTC');
  });

  /**
   * Anything that is not the daily shape is printed VERBATIM. A trust page
   * saying "once a day" over a cron that fires four times would be exactly the
   * kind of confidently-wrong claim this page refuses to make.
   */
  it('refuses to translate a shape it does not understand', () => {
    expect(cronSummary('*/15 * * * *')).toBe('on the schedule `*/15 * * * *` (UTC)');
    expect(cronSummary('0 9,21 * * *')).toBe('on the schedule `0 9,21 * * *` (UTC)');
    expect(cronSummary('0 23 * * 1')).toBe('on the schedule `0 23 * * 1` (UTC)');
  });
});

describe('provider status colours', () => {
  /**
   * Overview and /providers paint the same status, and used to disagree:
   * Overview's fallback painted UNKNOWN amber while this table painted it
   * grey. Escalation only reads as escalation when the levels agree.
   */
  it('gives every status a dot and a chip, and keeps WARN distinct from UNKNOWN', () => {
    for (const status of ['OK', 'WARN', 'ERROR', 'UNKNOWN']) {
      expect(STATUS_DOT[status]).toBeDefined();
      expect(STATUS_CHIP[status]).toBeDefined();
    }
    expect(STATUS_CHIP.WARN).not.toBe(STATUS_CHIP.UNKNOWN);
    expect(STATUS_DOT.WARN).not.toBe(STATUS_DOT.UNKNOWN);
  });
});
