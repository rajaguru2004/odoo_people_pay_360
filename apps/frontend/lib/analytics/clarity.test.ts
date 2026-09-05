import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Clarity transport, driven the way the browser drives it.
 *
 * `clarity.ts` reads its project id at module scope — as Next requires for
 * `NEXT_PUBLIC_*` inlining — so each case re-imports it with the environment it
 * wants. A minimal `window` is stubbed because this is the node project: the
 * point of these cases is the QUEUE, not the DOM.
 */
async function loadClarity(projectId = 'y9zmq4qs0j', allowLocalhost = false) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID = projectId;
  if (allowLocalhost) {
    process.env.NEXT_PUBLIC_CLARITY_ALLOW_LOCALHOST = 'true';
  } else {
    delete process.env.NEXT_PUBLIC_CLARITY_ALLOW_LOCALHOST;
  }
  return import('./clarity');
}

/** Every command that reached the queue, as `[name, ...args]`. */
function queue(): unknown[][] {
  const clarity = (globalThis as { window?: { clarity?: { q?: unknown[] } } }).window?.clarity;
  return (clarity?.q ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

beforeEach(() => {
  vi.stubGlobal('window', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_CLARITY_ALLOW_LOCALHOST;
});

describe('clarity transport — switched off', () => {
  it('creates no queue and sends nothing without a project id', async () => {
    const { clarityCall, setClarityTags, identifyClarityUser } = await loadClarity('');

    clarityCall('event', 'anything');
    setClarityTags({ module: 'payroll' });
    identifyClarityUser('u_deadbeef', '/dashboard');

    expect((window as { clarity?: unknown }).clarity).toBeUndefined();
  });
});

describe('clarity transport — switched on', () => {
  it('points at the configured project', async () => {
    const { clarityScriptSrc } = await loadClarity();
    expect(clarityScriptSrc()).toBe('https://www.clarity.ms/tag/y9zmq4qs0j');
  });

  it('queues commands before the real tag has loaded', async () => {
    const { clarityCall } = await loadClarity();
    clarityCall('set', 'module', 'payroll');
    expect(queue()).toEqual([['set', 'module', 'payroll']]);
  });

  it('drops HR-sensitive tags and keeps the countable ones', async () => {
    const { setClarityTags } = await loadClarity();

    setClarityTags({
      module: 'payroll',
      screen: 'dashboard.payroll.:id',
      user_role: 'HR_MANAGER',
      // Everything below must never reach Microsoft.
      employeeId: 'e-1',
      netPay: 4200,
      email: 'employee1@company.com',
      reason: 'Requested early release of the January salary',
    });

    const keys = queue().map((command) => command[1]);
    expect(keys).toEqual(['module', 'screen', 'user_role']);
  });

  it('sends tag values as strings, which is all Clarity accepts', async () => {
    const { setClarityTags } = await loadClarity();
    setClarityTags({ module: 'leave', items: 12, is_wide: true });
    expect(queue()).toEqual([
      ['set', 'module', 'leave'],
      ['set', 'items', '12'],
      ['set', 'is_wide', 'true'],
    ]);
  });

  it('identifies with a pseudonym and the sanitised page, never a friendly name', async () => {
    const { identifyClarityUser } = await loadClarity();
    identifyClarityUser('u_724d42b4', '/dashboard/employees/:id');

    // Positional: custom-id, custom-session-id, custom-page-id, friendly-name.
    // The fourth is displayed in clear on the Clarity dashboard, so it is
    // deliberately absent.
    expect(queue()).toEqual([['identify', 'u_724d42b4', undefined, '/dashboard/employees/:id']]);
  });

  it('refuses to identify without an id rather than inventing one', async () => {
    const { identifyClarityUser } = await loadClarity();
    identifyClarityUser('', '/login');
    expect(queue()).toEqual([]);
  });

  it('cannot throw when the queue itself is blocked', async () => {
    const { clarityCall, setClarityTags, identifyClarityUser } = await loadClarity();
    (window as { clarity?: unknown }).clarity = () => {
      throw new Error('blocked by extension');
    };

    expect(() => clarityCall('event', 'x')).not.toThrow();
    expect(() => setClarityTags({ module: 'payroll' })).not.toThrow();
    expect(() => identifyClarityUser('u_724d42b4', '/dashboard')).not.toThrow();
  });
});

describe('where recording is allowed to happen', () => {
  it('refuses a developer machine, whatever it calls itself', async () => {
    const { isRecordableHost } = await loadClarity();
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'ess.localhost', 'macbook.local', '', undefined]) {
      expect(isRecordableHost(host), String(host)).toBe(false);
    }
  });

  it('allows the hosts the portal is actually served from', async () => {
    const { isRecordableHost } = await loadClarity();
    for (const host of ['demo.ess.tools.thefusionapps.com', 'hrm.skillhiveinnovations.com']) {
      expect(isRecordableHost(host), host).toBe(true);
    }
  });

  it('records from localhost only when a build opts in', async () => {
    // `npm run dev` and the Playwright suite run against seeded employees and
    // payroll runs. A session recording of that is a recording of THAT, which
    // is why the opt-in exists and why it is off by default.
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });

    const blocked = await loadClarity('y9zmq4qs0j');
    expect(blocked.clarityShouldStart()).toBe(false);

    const allowed = await loadClarity('y9zmq4qs0j', true);
    expect(allowed.clarityShouldStart()).toBe(true);
  });

  it('stays off on a real host when the project id is not valid', async () => {
    vi.stubGlobal('window', { location: { hostname: 'demo.ess.tools.thefusionapps.com' } });
    const { clarityShouldStart } = await loadClarity('changeme');
    expect(clarityShouldStart()).toBe(false);
  });

  it('answers no on the server, where there is no host to judge', async () => {
    vi.unstubAllGlobals();
    const { clarityShouldStart } = await loadClarity();
    expect(clarityShouldStart()).toBe(false);
  });
});
