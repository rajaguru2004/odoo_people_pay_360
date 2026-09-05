import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { navigationState } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { buildUser } from '@/test/render';
import ClarityProvider from './ClarityProvider';

/**
 * Both branches of the kill switch, and the privacy contract, from one file.
 *
 * `config.ts` is mocked rather than driven through the environment for the same
 * reason as in AnalyticsProvider.test.tsx: the component tree imports it at
 * module scope, so a test that has to re-import React to flip a flag stops
 * testing the component.
 */
const clarityState = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/lib/analytics/config', () => ({
  GA_MEASUREMENT_ID: '',
  GA_DEBUG: false,
  isAnalyticsEnabled: () => false,
  CLARITY_PROJECT_ID: 'y9zmq4qs0j',
  isClarityEnabled: () => clarityState.enabled,
  // jsdom serves every test from `localhost`, which the host rule refuses on
  // purpose. The rule itself is pinned in lib/analytics/clarity.test.ts; these
  // cases are about what the component does once it is allowed to record.
  CLARITY_ALLOW_LOCALHOST: true,
}));

vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => <script data-testid="clarity-script" {...props} />,
}));

/** Every command that reached the Clarity queue, as `[name, ...args]`. */
function queue(): unknown[][] {
  const q = (window.clarity as unknown as { q?: unknown[] } | undefined)?.q ?? [];
  return q.map((entry) => Array.from(entry as ArrayLike<unknown>));
}

/** Value of a custom tag, or undefined if it was never set. */
function tag(key: string): unknown {
  return queue().filter((c) => c[0] === 'set' && c[1] === key).at(-1)?.[2];
}

function identifies(): unknown[][] {
  return queue().filter((c) => c[0] === 'identify');
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

beforeEach(() => {
  clarityState.enabled = true;
  delete (window as { clarity?: unknown }).clarity;
  navigationState.pathname = '/dashboard';
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: true });
});

afterEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: false });
});

describe('ClarityProvider — switched off', () => {
  it('renders nothing and touches no queue when no project id is configured', async () => {
    clarityState.enabled = false;
    signIn('ADMIN');

    const { queryByTestId } = render(<ClarityProvider />);

    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull());
    expect(queryByTestId('clarity-script')).toBeNull();
    expect(window.clarity).toBeUndefined();
  });
});

describe('ClarityProvider — switched on', () => {
  it('loads the tag for the configured project', () => {
    const { getByTestId } = render(<ClarityProvider />);
    expect(getByTestId('clarity-script')).toHaveAttribute(
      'src',
      'https://www.clarity.ms/tag/y9zmq4qs0j',
    );
  });

  it('names the screen and its module on an anonymous page', async () => {
    navigationState.pathname = '/login';
    render(<ClarityProvider />);

    await waitFor(() => expect(tag('module')).toBe('auth'));
    expect(tag('screen')).toBe('login');
    expect(tag('page_path')).toBe('/login');
    // Nobody has authenticated: no identifier is invented for them.
    expect(identifies()).toHaveLength(0);
    expect(tag('user_role')).toBeUndefined();
  });

  it('identifies with a pseudonym and a page that carries no record id', async () => {
    navigationState.pathname = '/dashboard/employees/3f9a1c2e-1b44-4d0a-9e77-2b6f9c1d5a10/payroll';
    signIn('HR_MANAGER');
    render(<ClarityProvider />);

    await waitFor(() => expect(identifies()).toHaveLength(1));
    const [command, id, session, page] = identifies()[0];
    expect(command).toBe('identify');
    expect(id).toMatch(/^u_[0-9a-f]{8}$/);
    expect(session).toBeUndefined();
    expect(page).toBe('/dashboard/employees/:id/payroll');

    // The account id, the address and the record id are what a recording list
    // must never be able to show.
    const payload = JSON.stringify(queue());
    expect(payload).not.toContain(buildUser('HR_MANAGER').id);
    expect(payload).not.toContain('@company.com');
    expect(payload).not.toContain('3f9a1c2e');
  });

  it.each([
    ['ADMIN', 'global'],
    ['EMPLOYEE', 'scoped'],
  ] as const)('tags the session with %s and nothing more personal', async (role, branchAccess) => {
    signIn(role);
    render(<ClarityProvider />);

    await waitFor(() => expect(tag('user_role')).toBe(role));
    expect(tag('branch_access')).toBe(branchAccess);
  });

  it('re-identifies on every client navigation, as the API asks', async () => {
    signIn('EMPLOYEE');
    const { rerender } = render(<ClarityProvider />);
    await waitFor(() => expect(identifies()).toHaveLength(1));

    navigationState.pathname = '/dashboard/my-leaves';
    rerender(<ClarityProvider />);

    await waitFor(() => expect(identifies()).toHaveLength(2));
    expect(identifies()[1][3]).toBe('/dashboard/my-leaves');
    expect(tag('module')).toBe('self_service');
  });

  it('waits for the session to rehydrate before labelling anyone anonymous', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, hasHydrated: false });
    const { rerender } = render(<ClarityProvider />);

    expect(queue()).toEqual([]);

    signIn('ADMIN');
    rerender(<ClarityProvider />);
    await waitFor(() => expect(identifies()).toHaveLength(1));
  });

  it('cannot break the app when the queue itself is blocked', async () => {
    (window as { clarity?: unknown }).clarity = () => {
      throw new Error('blocked by extension');
    };

    signIn('ADMIN');
    expect(() => render(<ClarityProvider />)).not.toThrow();
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull());
  });
});
