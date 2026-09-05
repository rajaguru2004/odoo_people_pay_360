import { vi } from 'vitest';

/** Mutable navigation state a test can set before rendering. */
export const navigationState = {
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
  params: {} as Record<string, string>,
};

export const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

export function resetRouterMock() {
  Object.values(routerMock).forEach((fn) => fn.mockReset());
  navigationState.pathname = '/dashboard';
  navigationState.searchParams = new URLSearchParams();
  navigationState.params = {};
}
