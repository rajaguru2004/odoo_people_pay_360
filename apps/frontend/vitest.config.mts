import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Two projects, deliberately kept apart.
 *
 * **unit** — the frontend's PURE modules: schema construction, payload shaping,
 * error mapping, permission lookup, money formatting. Framework-free, node
 * environment, no DOM. It runs in milliseconds; keep it that way — a module
 * that needs a DOM does not belong here.
 *
 * **component** — React rendering, jsdom, Testing Library. Slower by an order of
 * magnitude because every test boots a DOM and a provider tree, which is exactly
 * why it is a separate project rather than a wider `include` on the first one.
 * `npm run test:unit` stays fast for the tight loop; `npm test` runs both.
 *
 * The split is by EXTENSION, not by directory: `*.test.ts` is pure, `*.test.tsx`
 * renders. Colocation with the module under test is preserved in both.
 *
 * Note on JSX: the transform is SWC's during a Next build, and tsconfig's `jsx`
 * setting (`react-jsx`, which Next 16 requires) only drives `tsc --noEmit`.
 * Vitest uses esbuild instead and does not read that setting, so the component
 * project pins `jsx: 'automatic'` itself; without it esbuild emits untouched JSX
 * and every render test fails at runtime.
 */
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json.
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    projects: [
      {
        resolve: { alias: { '@': resolve(__dirname, '.') } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          // `e2e/` is not excluded wholesale: browser specs are `*.spec.ts` and
          // are never collected here, while pure data tests under e2e/ belong in
          // this fast project and must run even when Docker is down.
          exclude: ['node_modules/**', '.next/**', 'e2e/.results/**', 'e2e/.report/**'],
        },
      },
      {
        resolve: { alias: { '@': resolve(__dirname, '.') } },
        esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['**/*.test.tsx'],
          exclude: ['node_modules/**', '.next/**', 'e2e/**'],
          setupFiles: ['./test/setup.ts'],
          // Rendering tests boot a provider tree per case; the node project's
          // default is too tight once a real DOM is involved.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
