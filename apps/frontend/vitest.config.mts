import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Two projects, deliberately kept apart.
 *
 * **unit** — the frontend's PURE modules: schema construction, payload shaping,
 * error mapping, permission lookup, pay-basis derivation. Framework-free, node
 * environment, no DOM. This is the original suite and it runs in milliseconds.
 * Keep it that way: a module that needs a DOM does not belong here.
 *
 * **component** — React rendering, jsdom, Testing Library. Slower by an order of
 * magnitude because every test boots a DOM and a provider tree, which is exactly
 * why it is a separate project rather than a wider `include` on the first one.
 * `npm run test:unit` stays fast for the tight loop; `npm test` runs both.
 *
 * The split is by extension, not by directory: `*.test.ts` is pure, `*.test.tsx`
 * renders. Colocation with the module under test is preserved in both.
 *
 * Note on JSX: Next builds with `jsx: "preserve"` (tsconfig), leaving the
 * transform to SWC. Vitest uses esbuild instead, which would emit that untouched
 * JSX and fail at runtime — so the component project pins `jsx: 'automatic'`
 * itself. `@vitejs/plugin-react` is not used: it requires vite 8 while vitest 3
 * resolves vite 7, and nothing here needs Fast Refresh.
 */
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json.
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: { '@': resolve(__dirname, '.') },
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          // `e2e/` is not excluded wholesale: the browser specs are `*.spec.ts`
          // and so are never collected here, while `e2e/routes.test.ts` — pure
          // data about the route table — belongs in this fast project and must
          // run even when Docker is down.
          exclude: ['node_modules/**', '.next/**', 'e2e/.results/**', 'e2e/.report/**'],
        },
      },
      {
        resolve: {
          alias: { '@': resolve(__dirname, '.') },
        },
        esbuild: {
          jsx: 'automatic',
          jsxImportSource: 'react',
        },
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
