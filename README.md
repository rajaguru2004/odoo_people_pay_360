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
      branches/     physical locations and their working calendars
      departments/  org units, the hierarchy, and the change-request queue
      organization/ the Organisation hub aggregate
      employees/    people records and the People hub aggregate
      teams/        working groups inside a department
      contracts/    terms of employment and the termination queue
      legal-documents/  visas and other expiring identifiers
      attendances/  daily records, the calendar, the Time hub aggregate
      attendance-corrections/  disputed punches and their review
      work-schedules/   the roster, where it deviates from the branch calendar
      holidays/     non-working days, company-wide or per branch
      face-enrollments/ biometric templates (write-only)
      users/        account administration
      system-settings/  branding and per-module defaults
      health/       liveness + readiness
    test/           supertest specs against the e2e database
  frontend/         Next.js portal
    app/            App Router: (auth)/login, dashboard/*
    components/     ui primitives, layout shell, module-landing kit
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

The sign-in screen offers the seeded accounts under **Demo accounts** — one
click fills the form. The panel is on outside production and off in a production
build unless `NEXT_PUBLIC_DEMO_LOGINS=true` is passed at build time; it prints
an administrator email and inlines its password, so it belongs only where the
data is throwaway.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend and frontend together, prefixed output |
| `npm run build` | Builds both apps |
| `npm run lint` | ESLint across both apps |
| `npm run typecheck` | `tsc --noEmit` across both apps |
| `npm test` | Vitest (unit + component) and Jest |
| `npm run test:e2e` | Playwright, against the e2e stack |
| `npm run test:api` | Backend supertest specs, against the e2e database |
| `npm run e2e:up` / `e2e:down` | e2e Postgres up (schema + seed) / down |
| `npm run db:push` / `db:seed` / `db:studio` | Prisma schema, seed, studio |

## Conventions worth knowing

- **One response envelope.** Every success is `{ success, data, message?, meta? }` and every failure is `{ success: false, statusCode, message, ... }`. The axios interceptor unwraps exactly that one shape, and it rejects with a FLAT object — read `err.message`, or use `apiErrorMessage()`.
- **`NEXT_PUBLIC_*` is build-time.** `next build` inlines it. Setting one on a running container does nothing; Docker takes them as `--build-arg`.
- **`JWT_SECRET` has no default.** The API refuses to boot without it, so a deployment cannot silently share a defaulted signing key.
- **Money is `Decimal(18, 3)`.** OMR/KWD/BHD are thousandths, and `formatCurrency` picks its decimal count from the currency, never from a hardcoded 2.
- **Rebranding is one import.** `apps/frontend/theme/index.ts` chooses the active preset; every page, component and chart follows.
- **Logical CSS properties only** (`ps-*`, `me-*`, `start-*`), so `dir="rtl"` flips the layout without a second stylesheet.
- **A rate is `null`, never `0`, when there was nothing to divide by.** An empty branch and an unreachable endpoint are different claims; the portal renders `null` as an em dash rather than asserting a zero the data does not support.

## Modules

| Module | Hub | Screens |
| --- | --- | --- |
| Organisation | `/dashboard/organization` | Branches · Departments · Organisational chart · Change requests |
| People | `/dashboard/people` | Employee directory · Teams · Contracts · Terminations · Visa reports |
| Time & attendance | `/dashboard/time` | Overview · Requests · Logs · Reports · Manager · Biometric enrolment |

Each hub answers in ONE aggregate request rather than fanning out to list
endpoints and counting rows off them — a queue longer than a page would
otherwise be under-reported on the card whose job is to say how much work is
waiting. See [CLAUDE.md](CLAUDE.md) for the rules they share.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the longer version.
