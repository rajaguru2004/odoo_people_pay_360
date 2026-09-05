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

### Deletion

There is almost none. Users deactivate; employees terminate; departments refuse
to delete while anyone is assigned. Audit logs and payslips reference these rows
and have to keep naming who acted and who was paid.

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
**filename** (`employees.hr-admin.spec.ts`). A project whose role the name does
not list never loads the file — which matters because `test.skip()` in a body
still schedules the test and still opens a browser window before skipping it.

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
