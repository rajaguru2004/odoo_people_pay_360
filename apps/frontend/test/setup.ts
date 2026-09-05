import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { MotionGlobalConfig } from 'framer-motion';
import { navigationState, resetRouterMock, routerMock } from './router-mock';

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
 * jsdom project setup, run once per test file.
 *
 * Everything stubbed here is a browser API this app calls during render that
 * jsdom does not implement. Each is a real crash, not a convenience: without
 * them a component test fails inside a matchMedia/observer call and the error
 * points at the polyfill gap rather than at the component.
 */
afterEach(() => {
  cleanup();
  resetRouterMock();
  // Zustand stores are module singletons shared across the tests in a file, and
  // `persist` reads localStorage — clearing it stops one test's session leaking
  // into the next.
  window.localStorage.clear();
});

/**
 * framer-motion runs entrance animations on rAF, so a component mounts at
 * `initial` (opacity 0) and reaches `animate` a frame or more later. An
 * assertion landing in that window fails on the animation rather than on the
 * component — and only under load, when workers are busy enough to delay the
 * frame. skipAnimations makes every animation land on its final value at once,
 * which is what a jsdom test should assert against anyway.
 */
MotionGlobalConfig.skipAnimations = true;

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

class MockObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
vi.stubGlobal('IntersectionObserver', MockObserver);
vi.stubGlobal('ResizeObserver', MockObserver);

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = vi.fn(() => 'blob:mock');
  window.URL.revokeObjectURL = vi.fn();
}
