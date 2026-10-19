import { describe, expect, it } from 'vitest';
import { payerNames, type PayerRow } from './samePayer';

// Invented: an employer paying every other Friday whose bank renames its
// paycheck descriptor in June, and employers that are genuinely different.

const DAY = 86_400_000;
const fortnightly = (from: string, count: number, amount: number, payer: string): PayerRow[] =>
  Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 14 * DAY).toISOString().slice(0, 10),
    amount,
    payer,
  }));

describe('payerNames', () => {
  it('follows one employer across a renamed descriptor, a raise included, under its newest name', () => {
    const names = payerNames([
      ...fortnightly('2026-01-02', 12, 2000, 'acme payroll direct dep'), // last 2026-06-05
      ...fortnightly('2026-06-19', 8, 2080, 'acme payroll'),
    ]);
    expect(names.get('acme payroll direct dep')).toBe('acme payroll');
    expect(names.get('acme payroll')).toBe('acme payroll');
  });

  it('keeps a different employer apart: no shared name word', () => {
    const names = payerNames([
      ...fortnightly('2026-01-02', 12, 2000, 'acme payroll'),
      ...fortnightly('2026-06-19', 8, 2080, 'birchwood labs payroll'),
    ]);
    expect(names.get('acme payroll')).toBe('acme payroll');
    expect(names.get('birchwood labs payroll')).toBe('birchwood labs payroll');
  });

  it('keeps two payers paying in the same weeks apart, a shared word or not', () => {
    const names = payerNames([
      ...fortnightly('2026-01-02', 20, 2000, 'acme payroll'),
      ...fortnightly('2026-03-06', 10, 2000, 'acme payroll direct dep'),
    ]);
    expect(names.get('acme payroll direct dep')).toBe('acme payroll direct dep');
    expect(names.get('acme payroll')).toBe('acme payroll');
  });

  it('never merges on a generic word alone, nor on a payroll service', () => {
    const generic = payerNames([
      ...fortnightly('2026-01-02', 12, 2000, 'direct dep'),
      ...fortnightly('2026-06-19', 8, 2000, 'birchwood direct dep'),
    ]);
    expect(generic.get('direct dep')).toBe('direct dep');
    const service = payerNames([
      ...fortnightly('2026-01-02', 12, 2000, 'gusto acme'),
      ...fortnightly('2026-06-19', 8, 2000, 'gusto birchwood'),
    ]);
    expect(service.get('gusto acme')).toBe('gusto acme');
  });

  it('keeps a name apart whose pay is off the run, more than a raise away', () => {
    const names = payerNames([
      ...fortnightly('2026-01-02', 12, 2000, 'acme payroll direct dep'),
      ...fortnightly('2026-06-19', 8, 3200, 'acme payroll'),
    ]);
    expect(names.get('acme payroll direct dep')).toBe('acme payroll direct dep');
  });
});
