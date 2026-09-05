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
npm run test:api       # jest supertest specs against the e2e database
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
- **The sign-in screen's demo-account panel is gated, and the gate REMOVES the
  credentials rather than hiding them.** On outside production, off in a
  production build unless `NEXT_PUBLIC_DEMO_LOGINS=true` is passed at build
  time. The rule is resolved in `next.config.ts` (`resolveDemoLogins`) and
  inlined, because Next substitutes a `NEXT_PUBLIC_*` value only when it is SET
  and leaves an unset one as a runtime lookup — which is not a constant, so
  nothing guarded by it folds and the account list shipped inside every bundle,
  unrendered but readable. Keep the decision alone in `utils/demoAccounts.ts`
  and the accounts in the panel component: the sign-in page imports the former
  unconditionally.
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

## Modules

Three HR modules sit on top of the base platform, each with a landing hub that
aggregates in ONE request rather than fanning out to list endpoints and counting
rows off them:

| Module | Hub | Owns |
| --- | --- | --- |
| Organisation | `/dashboard/organization` | branches, departments, the org chart, department change requests |
| People | `/dashboard/people` | the directory, teams, contracts, terminations, work permits |
| Time & attendance | `/dashboard/time` | attendance, corrections, logs, reports, the roster, biometric enrolment |

Their aggregates are `GET /organization/hub-summary`, `GET /employees/hub-summary`
and `GET /attendances/hub-summary`.

### Rules the hubs share

- **A rate is `null`, never `0`, when there was nothing to divide by.** An empty
  branch and an unreachable endpoint are different claims, and a card printing
  0.0% for both has told the reader something false about one of them. The
  frontend renders `null` as an em dash.
- **Attendance rates divide by `expected`** — the working calendar minus
  approved leave — never by headcount.
- **A count is counted in the database**, not taken from the length of a page.
  A queue longer than one page would otherwise be under-reported on the one card
  whose job is to say how much work is waiting.
- **The server owns every bucket label.** `Aug 2026` arrives formatted, so the
  browser does no calendar maths.
- **A named sample is not a count.** `attention.*.names` is capped; `count` is
  the true total.
- **An unoffered window is a 400, not a silent default.** `months=7` or
  `anchor=2026-13-45` is refused, because a page that answers for a period
  nobody asked about cannot show the reader that it did.

### Who reaches which hub

The rail must never offer a route the server refuses, so `NavGroup.hubRoles` in
`components/layout/navConfig.ts` mirrors the `@Roles` on the aggregate. Where a
role may see the group but not open its hub, `buildMenu` re-points the group
header at the first child that role CAN reach and keeps `basePath` so the group
still owns its URL prefix.

| | ADMIN | HR_MANAGER | PAYROLL_OFFICER | MANAGER | EMPLOYEE |
| --- | --- | --- | --- | --- | --- |
| `/organization/hub-summary` | ✓ | ✓ | | | |
| `/employees/hub-summary` | ✓ | ✓ | | | |
| `/attendances/hub-summary` | ✓ | ✓ | ✓ | ✓ | |
| Attendance list / today / summary | ✓ | ✓ | ✓ | ✓ | |
| Own attendance history | ✓ | ✓ | ✓ | ✓ | ✓ |
| Branch / department / employee lists | ✓ | ✓ | ✓ | ✓ | ✓ |
| Biometric enrolment | ✓ | ✓ | | | |

The workforce-wide attendance views answer BY NAME — who was absent, who arrived
late — which is why an employee is refused them while still being entitled to
their own history. That last row is enforced in the service rather than by
`@Roles`, because the answer depends on whose record it is and a decorator
cannot see that.

### Module-specific rules

- **A snapshot is the point of a change request.** `DepartmentChangeRequest`
  stores the old value as a column at raise time, so the queue keeps showing what
  it looked like when somebody objected, even if the department is edited since.
- **Approving a termination is the only place employment ends.** The contract and
  the employee record change together, in one transaction; neither moves while
  the request is merely pending.
- **A renewal never overwrites.** `EmployeeLegalDocument` demotes the old row to
  `RENEWED`/`isCurrent: false` and creates a successor pointing back at it — an
  auditor asks when a permit actually lapsed, about a date already past.
- **An approved correction stamps the attendance row `source: MANUAL`**, so a
  later import cannot silently undo a human decision.
- **A face descriptor travels one way.** It goes up at enrolment and never comes
  back: responses carry existence, quality and date, nothing matchable offline.
- **Per-branch settings are nullable and mean "inherit".** An explicit null, not
  a copied default, so changing the company value moves every branch that never
  overrode it.
- **`managerId` and `supervisorId` are different graphs.** One is where a person
  sits in the structure, the other is who signs their leave. Each has its own
  cycle guard.

## Adding a backend feature module

`src/<feature>/` with `<feature>.module.ts`, `.controller.ts`, `.service.ts` and
`dto/`. Register it in `app.module.ts` explicitly — never rely on a transitive
import. Guards go on the controller class (`@UseGuards(JwtAuthGuard, RolesGuard)`)
with `@Roles(...)` per route.

**Declare a literal route before its `:id` sibling.** `GET /departments/tree`
after `GET /departments/:id` is parsed as a uuid and answers 400. Where a
literal path belongs to a second controller (`/contracts/terminations`,
`/departments/change-requests`), list that controller FIRST in the module's
`controllers` array.

## Adding a frontend screen

Route under `app/dashboard/`, data through a hook in `hooks/` wrapping a class in
`services/`, types in `types/`. Query keys are built by a `<entity>Keys` object so
invalidation targets the whole subtree rather than a guessed key.
