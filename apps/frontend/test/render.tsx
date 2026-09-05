import { ReactElement, ReactNode } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import enMessages from '@/messages/en';
import { useAuthStore } from '@/store/authStore';
import { useBrandingStore } from '@/store/brandingStore';
import { useBranchStore } from '@/store/branchStore';
import { setDefaultCurrency, setDefaultDateFormat } from '@/utils/formatters';
import type { User, UserRole } from '@/types/auth';

/**
 * One render helper, because every component here needs the same four things
 * and getting any of them wrong produces a confusing failure rather than a
 * clear one.
 *
 * 1. **next-intl.** Labels come from message keys, and `LocaleProvider` is
 *    mounted inside `DashboardLayout` — not at the root — so a component
 *    rendered on its own has no translations and `useTranslations` throws.
 * 2. **react-query.** Only ~10 files use it, but those that do need a client,
 *    and it must have `retry: false` or a failing-request test waits out the
 *    default backoff.
 * 3. **The auth store.** `usePermission`, the Sidebar and most screens branch on
 *    `user.role`. Tests declare the role they mean; nothing is inferred.
 * 4. **`utils/formatters` module-level globals.** `setDefaultDateFormat` and
 *    `setDefaultCurrency` are set once from `DashboardLayout` in the real app.
 *    Unset, currency and date assertions read whatever the previous test left
 *    behind — so they are pinned to a fixed default on every render.
 *
 * Stores are zustand module singletons, so they are reset *before* each render
 * rather than after: a test that renders twice with different roles must not
 * see the first role's state.
 */

/** Deterministic users, one per role. Override any field via `user`. */
const BASE_USERS: Record<UserRole, User> = {
  ADMIN: {
    id: 'u-admin',
    email: 'admin@company.com',
    role: 'ADMIN',
    isActive: true,
    employeeId: 'e-admin',
    isGlobalBranchAccess: true,
    homeBranchId: 'br-ho',
    accessibleBranches: [],
  },
  HR_MANAGER: {
    id: 'u-hr',
    email: 'hr.manager@company.com',
    role: 'HR_MANAGER',
    isActive: true,
    employeeId: 'e-hr',
    isGlobalBranchAccess: false,
    homeBranchId: 'br-ho',
    accessibleBranches: [{ id: 'br-ho', code: 'HO', name: 'Head Office' }],
  },
  MANAGER: {
    id: 'u-manager',
    email: 'manager@company.com',
    role: 'MANAGER',
    isActive: true,
    employeeId: 'e-manager',
    isGlobalBranchAccess: false,
    homeBranchId: 'br-ho',
    accessibleBranches: [{ id: 'br-ho', code: 'HO', name: 'Head Office' }],
  },
  EMPLOYEE: {
    id: 'u-employee',
    email: 'employee1@company.com',
    role: 'EMPLOYEE',
    isActive: true,
    employeeId: 'e-employee',
    isGlobalBranchAccess: false,
    homeBranchId: 'br-ho',
    accessibleBranches: [{ id: 'br-ho', code: 'HO', name: 'Head Office' }],
  },
};

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Role to seed the auth store with. `null` renders logged-out. */
  role?: UserRole | null;
  /** Field-level overrides on top of the role's base user. */
  user?: Partial<User>;
  /** Branding/system-settings overrides — feature flags live here. */
  branding?: Partial<ReturnType<typeof useBrandingStore.getState>['branding']>;
  /** Active branch id, as the BranchPicker would set it. */
  selectedBranchId?: string | null;
  /** Date-display preference. Pinned so date assertions are stable. */
  dateFormat?: string;
  /** Currency triple: code, symbol, display mode. */
  currency?: { code?: string; symbol?: string; display?: 'symbol' | 'code' };
}

export function buildUser(role: UserRole, overrides: Partial<User> = {}): User {
  return { ...BASE_USERS[role], ...overrides };
}

/** Seeds the zustand singletons and the formatter globals. Idempotent. */
function seedStores(opts: RenderWithProvidersOptions): void {
  const {
    role = 'ADMIN',
    user: userOverrides,
    branding,
    selectedBranchId = null,
    dateFormat = 'DD/MM/YYYY',
    currency,
  } = opts;

  const user = role ? buildUser(role, userOverrides) : null;
  useAuthStore.setState({
    user,
    isAuthenticated: !!user,
    isLoading: false,
    error: null,
  });

  if (branding) {
    useBrandingStore.setState({
      branding: { ...useBrandingStore.getState().branding, ...branding },
    });
  }

  useBranchStore.setState({ selectedBranchId });

  setDefaultDateFormat(dateFormat);
  setDefaultCurrency(currency?.code ?? 'INR', currency?.symbol ?? '₹', currency?.display ?? 'symbol');
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // No retries: a test asserting an error state should reach it at once.
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Renders `ui` inside the full provider tree.
 *
 * Returns Testing Library's result plus a pre-bound `user` event instance, so
 * callers do not each construct one:
 *
 *     const { user } = renderWithProviders(<LeaveForm />, { role: 'EMPLOYEE' });
 *     await user.click(screen.getByTestId('leave-submit'));
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { user: ReturnType<typeof userEvent.setup>; queryClient: QueryClient } {
  seedStores(options);

  const queryClient = makeQueryClient();
  const { role, user: _u, branding, selectedBranchId, dateFormat, currency, ...rtlOptions } = options;

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale="en"
        messages={enMessages as Record<string, unknown>}
        // A missing key should not abort the render — the test is about the
        // component's behaviour, not translation completeness.
        onError={() => {}}
        getMessageFallback={({ key }) => key}
      >
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </NextIntlClientProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...rtlOptions });
  return { ...result, user: userEvent.setup(), queryClient };
}

export * from '@testing-library/react';
export { userEvent };
