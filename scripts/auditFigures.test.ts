import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditSource } from './auditFigures';

const DIR = join('data', 'backups');

describe('auditSource', () => {
  it('reads the newest canonical backup by default', () => {
    const names = ['ducat-2026-03-01-0100.db', 'ducat-2026-03-03-0100.db', 'ducat-2026-03-02-0100.db', 'mirror-state.json'];
    expect(auditSource(undefined, names, DIR)).toEqual({ path: join(DIR, 'ducat-2026-03-03-0100.db') });
  });

  it('never takes an unverified file for the newest', () => {
    const names = ['ducat-2026-03-02-0100.db', 'ducat-2026-03-03-0100.db.partial', 'ducat-2026-03-04-0100.db.unverified'];
    expect(auditSource(undefined, names, DIR)).toEqual({ path: join(DIR, 'ducat-2026-03-02-0100.db') });
  });

  // The audit writes insight rows to whatever it opens: the live local
  // database, a quarantined file and the cloud are refused by name.
  it('refuses anything that is not a canonical backup', () => {
    for (const from of [join('data', 'ducat.db'), 'ducat-2026-03-03-0100.db.partial', 'libsql://example.turso.io']) {
      expect(auditSource(from, [], DIR)).toHaveProperty('refusal');
    }
    expect(auditSource(join(DIR, 'ducat-2026-03-02-0100.db'), [], DIR)).toEqual({ path: join(DIR, 'ducat-2026-03-02-0100.db') });
  });

  it('says so when there is no backup', () => {
    expect(auditSource(undefined, ['mirror-state.json'], DIR)).toHaveProperty('refusal');
  });
});
