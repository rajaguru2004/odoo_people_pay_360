# People Pay 360 — working notes

HR and payroll platform. npm-workspaces monorepo: NestJS + Prisma API in
`apps/backend`, Next.js portal in `apps/frontend`.

## Commands

```bash
npm run dev            # both apps, prefixed output
npm run lint           # eslint, both apps
npm run typecheck      # tsc --noEmit, both apps
npm test               # vitest (unit + component) + jest
npm run test:e2e       # playwright — needs `npm run e2e:up` first
npm run db:push        # prisma db push
npm run db:seed        # idempotent bootstrap seed
```

## Ports

API 3011 · portal 3010 · Postgres 8074 · MinIO 9014 · e2e Postgres 8174.
Offset from the HRM/ESS checkout so both stacks run at once — do not "fix" them
back to 3000/3001.

## Non-obvious rules

- **One response envelope.** Success `{ success, data, message?, meta? }`,
  failure `{ success: false, statusCode, message, errors, timestamp, path }`.
  Set globally in `main.ts`; do not hand-roll a different shape in a controller.
- **The axios interceptor rejects with a FLAT object.** There is no `.response`
  on it. Read `err.message` or call `apiErrorMessage()` — reaching for
  `err.response.data.message` silently falls through to the generic fallback.
- **`NEXT_PUBLIC_*` is build-time.** Inlined by `next build`. Setting one on a
  running container does nothing; pass it as `--build-arg`.
- **`hasHydrated` before any session decision.** See `store/authStore.ts`.
- **Money.** `Decimal(18, 3)` in Prisma, never `Float`. `formatCurrency` takes
  its decimal count from the currency (OMR/KWD/BHD are thousandths).
- **Date-only values** (hire date, period start) go through `formatDateOnly`,
  which does not zone-convert. Putting `2026-01-15` through an instant parse
  makes it the 14th anywhere west of Greenwich.
- **Logical CSS properties** (`ps-*`, `me-*`, `start-*`), never `pl-*`/`left-*`
  — `dir="rtl"` has to flip the layout without a second stylesheet.
- **Soft delete.** Users deactivate, employees terminate, departments refuse to
  delete while occupied. Audit logs and payslips must keep resolving.
- **`turbopack.root` must be the MONOREPO root**, not `apps/frontend`. npm
  workspaces hoists `node_modules` to the repo root, so with the app as the
  root Turbopack refuses to compile anything outside it and the build dies with
  "We couldn't find the Next.js package". See `apps/frontend/next.config.ts`.
- **Permissions in `utils/permissions.ts` are UI affordances**, not a security
  boundary. Every one has a `RolesGuard` counterpart server-side; never let a
  hidden button be the only thing stopping an action.

## Adding a backend feature module

`src/<feature>/` with `<feature>.module.ts`, `.controller.ts`, `.service.ts` and
`dto/`. Register it in `app.module.ts` explicitly — never rely on a transitive
import. Guards go on the controller class (`@UseGuards(JwtAuthGuard, RolesGuard)`)
with `@Roles(...)` per route.

## Adding a frontend screen

Route under `app/dashboard/`, data through a hook in `hooks/` wrapping a class in
`services/`, types in `types/`. Query keys are built by a `<entity>Keys` object so
invalidation targets the whole subtree rather than a guessed key.
