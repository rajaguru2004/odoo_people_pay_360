import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { MotionGlobalConfig } from 'framer-motion';
import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { navigationState, resetRouterMock, routerMock } from './router-mock';

/** The box every mocked chart is measured into. */
const MOCK_CHART_WIDTH = 400;
const MOCK_CHART_HEIGHT = 300;

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

/**
 * Recharts' `ResponsiveContainer` measures its parent and renders nothing at
 * 0×0 — which is every element in jsdom, since jsdom has no layout engine and
 * `ResizeObserver` above is a no-op. Left alone, every chart test would assert
 * against an empty SVG and pass for the wrong reason.
 *
 * The real container does not merely WRAP its child: it clones it with explicit
 * `width` and `height` props, which is how the chart inside learns its size.
 * A mock that only renders a sized `<div>` leaves the chart at its default zero
 * and it still draws no marks — so the clone is the part that matters, and it
 * is why a test can find a bar, a legend entry or an axis label at all.
 *
 * Written with `createElement` rather than JSX so this file stays `.ts` and the
 * vitest config keeps pointing at it.
 */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      createElement(
        'div',
        { style: { width: MOCK_CHART_WIDTH, height: MOCK_CHART_HEIGHT } },
        isValidElement(children)
          ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
              width: MOCK_CHART_WIDTH,
              height: MOCK_CHART_HEIGHT,
            })
          : children,
      ),
  };
});
