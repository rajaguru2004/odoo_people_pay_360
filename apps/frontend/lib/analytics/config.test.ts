import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The kill switch. `config.ts` reads the environment once at module scope — as
 * Next requires for `NEXT_PUBLIC_*` inlining — so each case re-imports it.
 */
async function loadConfig(measurementId?: string) {
  vi.resetModules();
  if (measurementId === undefined) {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  } else {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = measurementId;
  }
  return import('./config');
}

/** Same shape of test for the Clarity switch, which reads its id the same way. */
async function loadClarityConfig(projectId?: string) {
  vi.resetModules();
  if (projectId === undefined) {
    delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  } else {
    process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = projectId;
  }
  return import('./config');
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  delete process.env.NEXT_PUBLIC_GA_DEBUG;
  delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
});

describe('isAnalyticsEnabled', () => {
  it('is off when nothing is configured', async () => {
    const { isAnalyticsEnabled } = await loadConfig();
    expect(isAnalyticsEnabled()).toBe(false);
  });

  it('is off for an empty or half-substituted value', async () => {
    for (const value of ['', '   ', 'G-', 'changeme', '${GA_ID}', 'UA-12345-1']) {
      const { isAnalyticsEnabled } = await loadConfig(value);
      expect(isAnalyticsEnabled(), value).toBe(false);
    }
  });

  it('is on for a real measurement id, whitespace and all', async () => {
    const { isAnalyticsEnabled, GA_MEASUREMENT_ID } = await loadConfig('  G-ABCD123456  ');
    expect(isAnalyticsEnabled()).toBe(true);
    expect(GA_MEASUREMENT_ID).toBe('G-ABCD123456');
  });
});

describe('isClarityEnabled', () => {
  it('is off when nothing is configured', async () => {
    const { isClarityEnabled } = await loadClarityConfig();
    expect(isClarityEnabled()).toBe(false);
  });

  it('is off for the values that turn up by accident', async () => {
    // `changeme` and `yourproject` are letters only; `1234567890` is digits
    // only; the GA id belongs in the OTHER variable and would 404 on
    // clarity.ms — each would otherwise cost a failed request per page load.
    for (const value of ['', '   ', 'changeme', 'yourproject', '1234567890', '${CLARITY_ID}', 'G-KDF29Q2V54', 'y9zmq']) {
      const { isClarityEnabled } = await loadClarityConfig(value);
      expect(isClarityEnabled(), value).toBe(false);
    }
  });

  it('is on for a real project id, whitespace and all', async () => {
    const { isClarityEnabled, CLARITY_PROJECT_ID } = await loadClarityConfig('  y9zmq4qs0j  ');
    expect(isClarityEnabled()).toBe(true);
    expect(CLARITY_PROJECT_ID).toBe('y9zmq4qs0j');
  });
});
