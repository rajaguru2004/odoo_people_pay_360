import { vi } from 'vitest';

/**
 * The App Router hooks a component test cannot get for free.
 *
 * `useRouter()` throws outside a real app-router tree, and most screens here
 * call it during render — so the mock is installed globally in setup.ts rather
 * than repeated in every file. It lives in its own module so tests can assert
 * navigation without importing the setup file:
 *
 *     import { routerMock } from '@/test/router-mock';
 *     expect(routerMock.push).toHaveBeenCalledWith('/dashboard/employees');
 *
 * `navigationState` is what the mocked hooks read. Set it before render when a
 * test depends on the current path or query string.
 */
export const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

export const navigationState = {
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
  params: {} as Record<string, string | string[]>,
};

/** Clears recorded calls and restores the default route. Called from setup.ts. */
export function resetRouterMock(): void {
  Object.values(routerMock).forEach((fn) => fn.mockClear());
  navigationState.pathname = '/dashboard';
  navigationState.searchParams = new URLSearchParams();
  navigationState.params = {};
}
