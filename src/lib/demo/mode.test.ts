import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from '../../middleware';
import { demoMisconfiguration, demoPassword, isDemo } from './mode';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demo mode', () => {
  it('is off unless DUCAT_DEMO_PASSWORD is set, and an empty value is off', () => {
    vi.stubEnv('DUCAT_DEMO_PASSWORD', '');
    expect(isDemo()).toBe(false);
    expect(demoPassword()).toBeNull();
    vi.stubEnv('DUCAT_DEMO_PASSWORD', 'demo-pass');
    expect(isDemo()).toBe(true);
    expect(demoPassword()).toBe('demo-pass');
  });

  it('refuses a demo that holds a SimpleFIN access URL, and nothing else', () => {
    vi.stubEnv('SIMPLEFIN_ACCESS_URL', 'https://user:pass@example.com/simplefin');
    vi.stubEnv('DUCAT_DEMO_PASSWORD', '');
    expect(demoMisconfiguration()).toBeNull(); // a real instance with a feed is the normal case
    vi.stubEnv('DUCAT_DEMO_PASSWORD', 'demo-pass');
    expect(demoMisconfiguration()).toMatch(/must never reach a real bank feed/);
    vi.stubEnv('SIMPLEFIN_ACCESS_URL', '');
    expect(demoMisconfiguration()).toBeNull();
  });
});

describe('middleware and a misconfigured demo', () => {
  const cloudDemoWithFeed = () => {
    vi.stubEnv('DATABASE_URL', 'libsql://demo-example.turso.io');
    vi.stubEnv('AUTH_PASSWORD_HASH', 'scrypt:placeholder');
    vi.stubEnv('SESSION_SECRET', 'placeholder-session-secret');
    vi.stubEnv('DUCAT_DEMO_PASSWORD', 'demo-pass');
    vi.stubEnv('SIMPLEFIN_ACCESS_URL', 'https://user:pass@example.com/simplefin');
  };

  it('serves nothing — pages, the login page and the cron alike', async () => {
    cloudDemoWithFeed();
    for (const path of ['/', '/login', '/api/cron/sync']) {
      const res = await middleware(new NextRequest(`https://demo.example${path}`));
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toMatch(/remove SIMPLEFIN_ACCESS_URL/);
      // The message carries an em dash; without a charset it renders as "â€”".
      expect(res.headers.get('content-type'), path).toBe('text/plain; charset=utf-8');
    }
  });

  it('lets the same demo through to its login once the feed is removed', async () => {
    cloudDemoWithFeed();
    vi.stubEnv('SIMPLEFIN_ACCESS_URL', '');
    const res = await middleware(new NextRequest('https://demo.example/'));
    expect(res.status).toBe(307); // redirected to /login, the ordinary gate
    expect(res.headers.get('location')).toContain('/login');
  });
});
