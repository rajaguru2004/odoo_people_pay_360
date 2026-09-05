import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { buildUser } from '@/test/render';
import AnalyticsProvider from './AnalyticsProvider';

/**
 * Both branches of the kill switch, from one file.
 *
 * `config.ts` is mocked rather than driven through the environment because the
 * component tree imports it at module scope, and a test that has to re-import
 * React to flip a flag stops testing the component.
 */
const analyticsState = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/lib/analytics/config', () => ({
  GA_MEASUREMENT_ID: 'G-TEST123456',
  GA_DEBUG: false,
  isAnalyticsEnabled: () => analyticsState.enabled,
}));

// next/script renders asynchronously through Next's own loader in the real app;
// in jsdom a plain tag is enough to assert that the loader was mounted at all.
vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => <script data-testid="ga-script" {...props} />,
}));

/** Every gtag command that reached the queue, as `[name, ...args]`. */
function commands(): unknown[][] {
  return ((window.dataLayer ?? []) as unknown[]).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

function eventsNamed(name: string): Record<string, unknown>[] {
  return commands()
    .filter((c) => c[0] === 'event' && c[1] === name)
    .map((c) => (c[2] ?? {}) as Record<string, unknown>);
}

function signIn(role: Parameters<typeof buildUser>[0], overrides = {}) {
  useAuthStore.setState({
    user: buildUser(role, overrides),
    isAuthenticated: true,
    isLoading: false,
    error: null,
    hasHydrated: true,
  });
}

beforeEach(async () => {
  analyticsState.enabled = true;
  window.dataLayer = [];
  delete window.gtag;
  navigationState.pathname = '/dashboard';
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: true });
  window.sessionStorage.clear();
  // page_view de-duplication is module state; each case starts fresh.
  const { resetPageViewDedupe } = await import('@/lib/analytics/events');
  resetPageViewDedupe();
});

afterEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: false });
});

describe('AnalyticsProvider — switched off', () => {
  it('renders nothing and touches no queue when no measurement id is configured', async () => {
    analyticsState.enabled = false;
    signIn('ADMIN');

    const { queryByTestId } = render(<AnalyticsProvider />);

    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull());
    expect(queryByTestId('ga-script')).toBeNull();
    expect(commands()).toEqual([]);
  });
});

describe('AnalyticsProvider — switched on', () => {
  it('loads gtag.js for the configured stream', () => {
    const { getByTestId } = render(<AnalyticsProvider />);
    expect(getByTestId('ga-script')).toHaveAttribute(
      'src',
      'https://www.googletagmanager.com/gtag/js?id=G-TEST123456',
    );
  });

  it('configures the stream before anything is measured, with automatic page views off', async () => {
    render(<AnalyticsProvider />);

    await waitFor(() => expect(commands().length).toBeGreaterThan(0));
    const [first, second] = commands();
    expect(first[0]).toBe('js');
    expect(second[0]).toBe('config');
    expect(second[1]).toBe('G-TEST123456');
    expect(second[2]).toMatchObject({ send_page_view: false });
    // Any unrecognised config key is forwarded to EVERY hit as a custom event
    // parameter, so the config object carries nothing but real gtag settings.
    expect(Object.keys(second[2] as object)).toEqual(['send_page_view']);
  });

  it('sends a page_view carrying the module, not the record id', async () => {
    navigationState.pathname = '/dashboard/employees/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10/payroll';
    render(<AnalyticsProvider />);

    await waitFor(() => expect(eventsNamed('page_view')).toHaveLength(1));
    expect(eventsNamed('page_view')[0]).toMatchObject({
      page_path: '/dashboard/employees/:id/payroll',
      module: 'people',
    });
    expect(JSON.stringify(commands())).not.toContain('3f9a1c2e');
  });

  it('sends one page_view per screen, not one per re-render', async () => {
    const { rerender } = render(<AnalyticsProvider />);
    await waitFor(() => expect(eventsNamed('page_view')).toHaveLength(1));

    rerender(<AnalyticsProvider />);
    navigationState.pathname = '/dashboard';
    rerender(<AnalyticsProvider />);

    expect(eventsNamed('page_view')).toHaveLength(1);
  });

  it.each([
    ['ADMIN', 'global'],
    ['EMPLOYEE', 'scoped'],
  ] as const)('attaches %s as a role dimension with no personal data', async (role, branchAccess) => {
    signIn(role);
    render(<AnalyticsProvider />);

    await waitFor(() => expect(eventsNamed('session_restored')).toHaveLength(1));

    const setUserId = commands().find((c) => c[0] === 'set' && typeof c[1] === 'object');
    expect((setUserId?.[1] as Record<string, string>).user_id).toMatch(/^u_[0-9a-f]{8}$/);

    const props = commands().find((c) => c[0] === 'set' && c[1] === 'user_properties');
    expect(props?.[2]).toEqual({ user_role: role, branch_access: branchAccess });

    // The account id and address are what a GA report must never be able to show.
    const payload = JSON.stringify(commands());
    expect(payload).not.toContain(buildUser(role).id);
    expect(payload).not.toContain('@company.com');
  });

  it('reports session_restored once per browser session, not once per reload', async () => {
    signIn('ADMIN');
    const first = render(<AnalyticsProvider />);
    await waitFor(() => expect(eventsNamed('session_restored')).toHaveLength(1));
    first.unmount();

    // A reload keeps sessionStorage and loses everything else — modelled by a
    // fresh mount against a cleared queue.
    window.dataLayer = [];
    render(<AnalyticsProvider />);
    await waitFor(() => expect(commands().length).toBeGreaterThan(0));

    expect(eventsNamed('session_restored')).toHaveLength(0);
  });

  it('still measures when sessionStorage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    signIn('ADMIN');

    expect(() => render(<AnalyticsProvider />)).not.toThrow();
    await waitFor(() => expect(eventsNamed('session_restored')).toHaveLength(1));

    getItem.mockRestore();
  });

  it('detaches the identity when the session ends', async () => {
    signIn('ADMIN');
    const { rerender } = render(<AnalyticsProvider />);
    await waitFor(() => expect(eventsNamed('session_restored')).toHaveLength(1));

    useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: true });
    rerender(<AnalyticsProvider />);

    await waitFor(() => {
      const cleared = commands().filter(
        (c) => c[0] === 'set' && c[1] === 'user_properties' && (c[2] as Record<string, unknown>).user_role === null,
      );
      expect(cleared).toHaveLength(1);
    });
  });

  it('waits for the session to rehydrate before deciding nobody is signed in', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: false });
    render(<AnalyticsProvider />);

    await waitFor(() => expect(eventsNamed('page_view')).toHaveLength(1));
    expect(commands().some((c) => c[0] === 'set')).toBe(false);
  });

  it('cannot break the app when the queue itself throws', async () => {
    window.dataLayer = {
      push: () => {
        throw new Error('blocked by extension');
      },
    } as unknown as unknown[];

    signIn('ADMIN');
    expect(() => render(<AnalyticsProvider />)).not.toThrow();
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull());
  });
});
