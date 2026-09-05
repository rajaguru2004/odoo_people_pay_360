import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { MotionGlobalConfig } from 'framer-motion';
import { routerMock, navigationState, resetRouterMock } from './router-mock';

// App Router hooks throw outside a real router tree, and most screens call
// useRouter() during render. Mocked here so no test file has to repeat it.
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => navigationState.pathname,
  useSearchParams: () => navigationState.searchParams,
  useParams: () => navigationState.params,
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

/**
 * jsdom project setup. Runs once per test file, before any test.
 *
 * Everything stubbed here is a browser API this app calls during render that
 * jsdom does not implement. Each one is a real crash, not a convenience:
 * without them a component test fails inside a matchMedia/observer call and the
 * error points at the polyfill gap rather than at the component.
 */

afterEach(() => {
  cleanup();
  resetRouterMock();
  // Zustand stores are module singletons shared across tests in a file. Any
  // store seeded by renderWithProviders resets there; localStorage is cleared
  // here so a persisted store cannot leak a user into the next test.
  window.localStorage.clear();
});

/**
 * framer-motion runs its entrance animations on rAF, so a component mounts at
 * `initial` (`opacity: 0`) and only reaches `animate` a frame or more later. An
 * assertion that lands in that window — `toBeVisible()` right after a
 * `findBy*` — fails on the animation rather than on the component, and it does
 * so only under load, when the workers are busy enough to delay the frame.
 * `skipAnimations` makes every animation land on its final value instantly,
 * which is what a jsdom test should be asserting against anyway.
 */
MotionGlobalConfig.skipAnimations = true;

// next-themes, the responsive hooks and useMediaQuery all read this.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// framer-motion and react-intersection-observer both construct these.
class MockObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
vi.stubGlobal('IntersectionObserver', MockObserver);
vi.stubGlobal('ResizeObserver', MockObserver);

// Radix-style portals and some dropdowns measure with these.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.setPointerCapture = vi.fn();

// jsdom implements neither, and the avatar/export paths call both.
if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = vi.fn(() => 'blob:mock');
  window.URL.revokeObjectURL = vi.fn();
}
