# People Pay 360

HR and payroll platform. NestJS + Prisma API and a Next.js portal in one npm-workspaces monorepo.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | npm workspaces (`apps/*`), `concurrently` for the dev loop |
| Backend | NestJS 11, Prisma 5.22, PostgreSQL 16, Passport JWT, Swagger, Jest |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, TanStack Query 5, Zustand 5, Vitest, Playwright |
| Infra | Docker Compose (Postgres, MinIO, API, portal), per-service multi-stage Dockerfiles |

## Layout

```
apps/
  backend/          NestJS API
    prisma/         schema.prisma + idempotent seed
    src/
      auth/         JWT login, guards, role decorator
      common/       filters, interceptors, decorators, config, utils
      employees/    people records
      departments/  org units
      users/        account administration
      system-settings/  branding served to the portal
      health/       liveness + readiness
    test/           jest e2e specs
  frontend/         Next.js portal
    app/            App Router: (auth)/login, dashboard/*
    components/     ui primitives, layout shell, shared pieces
    hooks/          TanStack Query hooks, auth guard, media query
    lib/            axios instance, api base resolver, query provider
    services/       one class per API surface
    store/          Zustand: auth, branding, locale, page header
    theme/          design tokens + presets, applied as CSS vars at runtime
    e2e/            Playwright config, per-role global setup, specs
    test/           Vitest jsdom setup and helpers
scripts/            e2e database lifecycle
docs/               architecture and conventions
```

## Ports

Offset from the HRM/ESS checkout so both stacks run side by side.

| Service | Dev | Docker (host) |
| --- | --- | --- |
| API | 3011 | 8075 |
| Portal | 3010 | 7014 |
| PostgreSQL | 8074 | 8074 |
| MinIO API / console | 9014 / 9899 | 9014 / 9899 |
| e2e PostgreSQL | 8174 | — |

## Getting started

```bash
# 1. Install (npm workspaces installs both apps)
npm install

# 2. Environment — both files ship with working local defaults
cp apps/backend/.env.example apps/backend/.env        # already present; copy only to reset
cp apps/frontend/.env.example apps/frontend/.env.local

# 3. Database
docker compose up -d postgres
npm run db:push
npm run db:seed        # creates admin@peoplepay360.com / Admin@123

# 4. Run both apps
npm run dev
```

- Portal: http://localhost:3010
- API: http://localhost:3011
- Swagger: http://localhost:3011/api/docs

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend and frontend together, prefixed output |
| `npm run build` | Builds both apps |
| `npm run lint` | ESLint across both apps |
| `npm run typecheck` | `tsc --noEmit` across both apps |
| `npm test` | Vitest (unit + component) and Jest |
| `npm run test:e2e` | Playwright, against the e2e stack |
| `npm run e2e:up` / `e2e:down` | e2e Postgres up (schema + seed) / down |
| `npm run db:push` / `db:seed` / `db:studio` | Prisma schema, seed, studio |

## Conventions worth knowing

- **One response envelope.** Every success is `{ success, data, message?, meta? }` and every failure is `{ success: false, statusCode, message, ... }`. The axios interceptor unwraps exactly that one shape, and it rejects with a FLAT object — read `err.message`, or use `apiErrorMessage()`.
- **`NEXT_PUBLIC_*` is build-time.** `next build` inlines it. Setting one on a running container does nothing; Docker takes them as `--build-arg`.
- **`JWT_SECRET` has no default.** The API refuses to boot without it, so a deployment cannot silently share a defaulted signing key.
- **Money is `Decimal(18, 3)`.** OMR/KWD/BHD are thousandths, and `formatCurrency` picks its decimal count from the currency, never from a hardcoded 2.
- **Rebranding is one import.** `apps/frontend/theme/index.ts` chooses the active preset; every page, component and chart follows.
- **Logical CSS properties only** (`ps-*`, `me-*`, `start-*`), so `dir="rtl"` flips the layout without a second stylesheet.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the longer version.
