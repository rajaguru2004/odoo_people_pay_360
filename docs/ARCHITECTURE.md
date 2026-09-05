# Architecture

## Shape of the repo

npm workspaces, two apps, no shared package yet. The root `package.json` owns
only orchestration scripts and `concurrently`; every real dependency belongs to
the app that uses it. That is deliberate — a shared `packages/` directory earns
its place once two apps actually need the same code, and adding it before then
buys a build step and buys nothing else.

## Backend

### Request lifecycle

```
request
  → JwtAuthGuard      (skipped for @Public)
  → RolesGuard        (no @Roles = any authenticated caller)
  → ValidationPipe    (whitelist + forbidNonWhitelisted + transform)
  → controller → service → PrismaService
  → TransformInterceptor  { success: true, data }
  → AllExceptionsFilter   { success: false, statusCode, message, ... }
```

Both the interceptor and the filter are global, so there is exactly one response
shape in the system and the portal has exactly one contract to unwrap.

### Authentication

`JwtStrategy.validate()` does not trust the token's claims for authorisation. It
takes the subject and calls `AuthService.buildPrincipal()`, which re-reads the
user. Two consequences, both wanted:

- deactivating an account takes effect on the **next request**, not at token
  expiry;
- a non-HTTP entry point added later resolves an identical `req.user`, so a
  caller cannot gain scope by arriving over a different transport.

The login path compares a bcrypt hash even when the account does not exist, and
returns the same message either way. Different messages make the endpoint an
account-enumeration oracle; skipping the hash leaks the same fact through
response timing.

### Data

Prisma, PostgreSQL, snake_case in the database and camelCase in the client via
`@map`/`@@map`. Ids are `gen_random_uuid()` so a row inserted by hand or by a
migration is indistinguishable from one the app made.

Money is `Decimal(18, 3)`. Never `Float`: binary floating point cannot represent
0.1, and a payroll that does not balance is not a payroll. Three decimals
because OMR, KWD and BHD are thousandths.

Payslip lines denormalise their label and type. A payslip is a legal record of
what was paid, so it must still read correctly after the component behind it is
renamed or retired — resolving the label through the component at display time
would silently rewrite history.

### Module aggregates

Each of the three HR modules answers its landing page with ONE endpoint —
`/organization/hub-summary`, `/employees/hub-summary`, `/attendances/hub-summary`
— rather than letting the page fan out to half a dozen list endpoints and count
rows off them. Two things follow from that, and both are load-bearing:

A count is counted in the database. Reading the length of a list response
under-reports every queue longer than one page, on precisely the card whose job
is to say how much work is waiting.

A rate is `number | null`, and `null` is not `0`. An empty branch, a role-gated
endpoint and a failed request all produce "no number"; a card that renders 0.0%
for any of them has made a claim the data does not support. The portal renders
`null` as an em dash, and the hub hooks expose a `failed` flag so a page can tell
"nothing happened" from "we do not know".

Attendance goes one step further: every rate there divides by `expected` — the
branch's working calendar, minus holidays and weekly rest, minus approved leave,
adjusted by any roster override — never by headcount. Dividing by headcount
reports a weekend as a catastrophe.

The window is validated rather than defaulted. `months=7` and
`anchor=2026-13-45` are refused with a 400, because a page that quietly answers
for a period nobody asked about cannot show the reader that it did so.

### Deletion

There is almost none. Users deactivate; employees terminate; departments refuse
to delete while anyone is assigned; a branch with attendance history behind it
deactivates instead of deleting, because those rows record where a punch
happened and must keep resolving. Audit logs and payslips reference these rows
and have to keep naming who acted and who was paid.

The same instinct shapes the request records. A department change request
snapshots the old value into its own columns when it is raised, so the queue
keeps showing what somebody objected to even after the department moves on. A
permit renewal demotes the superseded row to `RENEWED` and creates a successor
pointing back at it, rather than editing the dates in place — an auditor asks
when a visa actually lapsed, which is a question about a date that has already
passed.

## Frontend

### State, split three ways

- **Server state** — TanStack Query. Anything the API owns.
- **Session and app state** — Zustand. `authStore`, `brandingStore`,
  `localeStore`, `pageHeaderStore`.
- **Local state** — `useState`, in the component that owns it.

The rule that keeps this from blurring: if the server is the source of truth, it
does not go in Zustand.

### The hydration gate

`authStore.hasHydrated` exists because `user: null, isAuthenticated: false` is
ambiguous — it is both "storage not read yet" and "signed out". Anything that
*decides* from the session waits for the flag; the dashboard layout renders a
spinner until it flips. Without it, every reload flashes /login to a signed-in
user.

### The shell

`app/dashboard/layout.tsx` is exactly one viewport tall and does not scroll;
`<main>` is the only scroller inside it. With a growing document the rail and
the header scrolled off the top of a long page, taking the navigation and the
sign-out control with them.

Two consequences follow. The rail carries its own `overflow-y-auto`, because a
fully-expanded accordion can be taller than the window and a rail that cannot
reach its last entry is no better than one that scrolled away. And the header
bar is `shrink-0`, so it keeps its height instead of being squeezed by the
content below it.

The header owns the single `<h1>` for the whole shell — a page declares its text
through `usePageHeader` rather than painting a second heading. The breadcrumb
trail is deliberately NOT in the header: it describes the page rather than the
frame, so it renders at the top of the content area instead. Both read the same
derivation (`usePageChrome`), which is what stops the heading and the trail
drifting apart.

### Theming

`theme/presets/*` are plain objects. `ThemeProvider` writes them onto `<html>` as
CSS custom properties, and `app/globals.css` maps those to Tailwind utilities
via `@theme inline`. So `bg-brand-primary` resolves at runtime, and rebranding is
changing one export in `theme/index.ts` — no rebuild of component styles, no
find-and-replace across the codebase.

Charts are the exception: Recharts reads hex values rather than CSS variables,
so `theme/chartColors.ts` is kept in sync by the same effect that writes the
variables.

### Testing

Two Vitest projects split by **extension**, not directory: `*.test.ts` is pure
and runs in node in milliseconds; `*.test.tsx` renders in jsdom and costs an
order of magnitude more. `npm run test:unit` stays fast for the tight loop.

Playwright projects are per role, and a spec declares its roles in its
**filename** (`people.hr-admin.spec.ts`). A project whose role the name does not
list never loads the file — which matters because `test.skip()` in a body still
schedules the test and still opens a browser window before skipping it.

There is a third layer between the two: `apps/backend/test/*.e2e-spec.ts` drives
the real application over HTTP against the e2e database, so the response
envelope, the guards and the `forbidNonWhitelisted` behaviour are asserted
against the app as assembled rather than against a service in isolation. Run
them with `npm run test:api`, which loads `.env.test` itself and refuses to
start if that file does not point at port 8174 — these specs create and approve
real rows, and running them against the dev database would rewrite it.

## Configuration

`NEXT_PUBLIC_*` is inlined by `next build`. It is a build input, not a runtime
one, which is why `docker-compose.yml` passes it under `build.args` and why
setting it in `environment` would do nothing. `BACKEND_INTERNAL_URL` is the
opposite — server-side only, honoured at runtime, never sent to the browser.

`JWT_SECRET` has no default and the app crashes at boot without it. A defaulted
signing key is worse than a missing one: every deployment that forgot to set it
shares the same key, and nothing about that is visible until it is exploited.

## Odoo integration

Off by default (`ODOO_ENABLED=false`). Every call is a no-op while disabled, so
a checkout with no Odoo reachable still boots and serves the whole application.
Credentials belong in `system_settings` encrypted with `SETTINGS_ENCRYPTION_KEY`
— which is kept out of the database it protects, and separate from `JWT_SECRET`
so a leaked token key cannot be escalated into decrypting stored credentials.
