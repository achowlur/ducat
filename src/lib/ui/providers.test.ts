import { describe, expect, it } from 'vitest';
import type { ProviderHealth } from '../health/types';
import { cronSummary, providersVerdict, showsProvider, STATUS_CHIP, STATUS_DOT } from './providers';
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

describe('which provider cards /providers shows', () => {
  it('shows every connector, set up or not, so its deal is readable before connecting', () => {
    for (const id of ['SIMPLEFIN', 'CSV', 'PDF'] as const) expect(showsProvider(id, null, false)).toBe(true);
  });

  // The operator's call (2026-10-15): an unused rates index is noise there.
  it('shows FRED only once it is in use: its key set, or a rate stored before', () => {
    expect(showsProvider('FRED', null, false)).toBe(false);
    expect(showsProvider('FRED', null, true)).toBe(true);
    expect(showsProvider('FRED', { connectorType: 'FRED' } as ProviderHealth, false)).toBe(true);
  });
});

describe('providersVerdict', () => {
  const ok = [{ name: 'SimpleFIN', status: 'OK' as const }];

  it('reads as one line when everything is fine', () => {
    const v = providersVerdict({ feeds: ok, backup: { status: 'OK', calendarDays: 0 }, plan: { label: '3%', warn: false } });
    expect(v.level).toBe('OK');
    expect(v.parts.join(' · ')).toBe('All feeds OK · backup verified today · free plan 3%');
  });

  it('names the feed that needs a look, and the worst level wins', () => {
    const v = providersVerdict({
      feeds: [...ok, { name: 'FRED', status: 'WARN' }, { name: 'CSV', status: 'ERROR' }],
      backup: null,
      plan: null,
    });
    expect(v.level).toBe('ERROR');
    expect(v.parts).toEqual(['FRED, CSV need a look']);
  });

  it('leaves out a part that has no signal rather than reassuring', () => {
    const v = providersVerdict({ feeds: ok, backup: null, plan: null });
    expect(v.parts).toEqual(['All feeds OK']);
  });

  it('does not call a backup fine when its own status is not', () => {
    const v = providersVerdict({ feeds: ok, backup: { status: 'WARN', calendarDays: 3 }, plan: null });
    expect(v.level).toBe('WARN');
    expect(v.parts[1]).toBe('backup needs a look (last verified 3 days ago)');
  });

  it('says yesterday, and carries a plan warning into the level', () => {
    const v = providersVerdict({ feeds: ok, backup: { status: 'OK', calendarDays: 1 }, plan: { label: '85%', warn: true } });
    expect(v.level).toBe('WARN');
    expect(v.parts).toEqual(['All feeds OK', 'backup verified yesterday', 'free plan 85%']);
  });

  it('is not all-clear when no feed has reported', () => {
    const v = providersVerdict({ feeds: [{ name: 'FRED', status: 'UNKNOWN' }], backup: null, plan: null });
    expect(v.parts).toEqual(['No feed signals yet']);
  });
});
