import { describe, expect, it } from 'vitest';
import { screenshotVerdict } from './screenshotSync';

describe('screenshotVerdict', () => {
  it('lets a change that touches no pictured screen through', () => {
    expect(screenshotVerdict(['scripts/backup-scheduled.ts', 'docs/lifecycle.md'], '').ok).toBe(true);
  });

  it('fails a change to a pictured screen with no retake and no reason, naming what changed', () => {
    const v = screenshotVerdict(['src/app/trends/page.tsx', 'README.md'], 'Tweaks the trends table.');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('src/app/trends/page.tsx');
    expect(v.reason).toContain('npm run screenshots');
  });

  it('counts shared components, UI helpers, analyzers and the demo data as pictured', () => {
    for (const f of ['src/components/MiniDonut.tsx', 'src/lib/ui/format.ts', 'src/lib/insights/digest.ts', 'scripts/demoData.ts', 'src/app/globals.css']) {
      expect(screenshotVerdict([f], '').ok, f).toBe(false);
    }
    // Pages that are not pictured stay free.
    expect(screenshotVerdict(['src/app/providers/page.tsx', 'src/app/accounts/page.tsx'], '').ok).toBe(true);
  });

  it('passes when the screenshots are retaken in the same change', () => {
    const v = screenshotVerdict(['src/app/page.tsx', 'docs/assets/screenshots/overview.png'], '');
    expect(v).toEqual({ ok: true, reason: 'screenshots retaken in this change' });
  });

  it('passes on a stated reason, on a line of its own', () => {
    const body = 'Refactor only.\n\nscreenshots: unchanged — renames a prop, nothing renders differently\n';
    const v = screenshotVerdict(['src/components/CategoryPicker.tsx'], body);
    expect(v).toEqual({ ok: true, reason: 'waived: renames a prop, nothing renders differently' });
    // A plain hyphen works too, since not every keyboard types an em dash.
    expect(screenshotVerdict(['src/lib/ui/format.ts'], 'screenshots: unchanged - comment-only change').ok).toBe(true);
  });

  it('refuses a waiver with no real reason, or one buried mid-sentence', () => {
    expect(screenshotVerdict(['src/lib/ui/format.ts'], 'screenshots: unchanged —').ok).toBe(false);
    expect(screenshotVerdict(['src/lib/ui/format.ts'], 'screenshots: unchanged — ok').ok).toBe(false);
    expect(screenshotVerdict(['src/lib/ui/format.ts'], 'I think screenshots: unchanged — fine here').ok).toBe(false);
  });

  it('normalises Windows path separators', () => {
    expect(screenshotVerdict(['src\\app\\insights\\page.tsx'], '').ok).toBe(false);
  });
});
