# Backend E2E Tests

End-to-end tests that boot a real NestJS app against the configured database and
drive HTTP endpoints with `supertest`. The engine of the product is verified here
so production users never hit branch-isolation errors.

## Two layers

| Suite | Boots | Use |
|-------|-------|-----|
| **in-process** (`*.e2e-spec.ts`) | a faithful multi-branch slice of the app inside Jest | fast, hermetic, CI gate |
| **live cycle** (`*.live-e2e.ts`) | nothing — drives a **running server** over HTTP | pre-ship smoke of the real deployed process (all modules, real `main.ts`) |

## Run

```bash
# In-process: all e2e specs
npm run test:e2e

# In-process: just the multi-branch suite
npm run test:e2e:branch

# Live cycle against a running server (server must already be up)
API_BASE_URL=http://localhost:3001 npm run test:e2e:live

# FULL HR lifecycle — one run verifies every core flow end to end
API_BASE_URL=http://localhost:3001 npm run test:e2e:full
```

Requires `DATABASE_URL` / `DIRECT_URL` in `.env` (a dev DB — tests create and
delete their own data). `BRANCH_ENFORCEMENT` defaults to `on`.

### Live cycle — `live/live-cycle.live-e2e.ts` (10 ordered steps)

Black-box HTTP against `API_BASE_URL` (default `http://localhost:${PORT:-3001}`).
Seeds users/branches via Prisma against the same DB, then drives the whole
lifecycle over HTTP: health → envelope → branch create → onboard (both branches,
**employee-code regression guard**) → scoped list → IDOR 404 → scoped-HR pin →
foreign-branch 403 + audit → attendance scope → delete-guard. Self-cleaning by
`runId`. Waits up to 30s for the server to answer, so it can front a
start-server step in CI.

### Full HR lifecycle — `live/full-lifecycle.live-e2e.ts` (20 steps, single command)

`npm run test:e2e:full` drives one employee through **every core backend flow**
against a running server, so one green run means the whole engine works:

1. **Auth** — admin + onboarded-employee login, `/auth/me`.
2. **Contract & salary** — create ACTIVE contract, add BASIC salary component.
3. **Attendance** — employee check-in → check-out → `/attendances/my` → branch-scoped list.
4. **Corrections** — employee files a correction, admin approves (upserts the row).
5. **Leave** — balance auto-init, employee requests UNPAID leave, admin approves.
6. **Overtime** — admin files OT (outside work hours) for the employee, approves.
7. **Reimbursement** — employee files, admin approves.
8. **Rewards & discipline** — admin grants a reward, records a discipline note.
9. **Org admin** — department create/update/read, holiday create + public list.
10. **Payroll** — batch → run (synchronous, 1 item) → submit → approve → lock → payslip.

Seeds one admin + one employee (+ dept + geofence-off branch), toggles feature
flags deterministically and **restores them after**, then bulk-deletes by `runId`.
Handles the response-envelope inconsistency (overtime/reimbursement/corrections
return raw entities; the rest wrap in `{ success, data }`). OT/reimbursement steps
degrade to a logged skip if disabled by config rather than failing.

## What's covered — `multi-branch.e2e-spec.ts` (27 cases)

| Area | Verifies |
|------|----------|
| Auth envelope | login returns `isGlobalBranchAccess` / `homeBranchId` / `accessibleBranches`; scoped user never sees foreign branches; unauth → 401 |
| Branch CRUD + RBAC | list/create/update/soft-delete; duplicate code → 409; delete-with-employees → 400; EMPLOYEE create → 403 |
| Employee scoping | `X-Branch-Id` narrows the list; global "All Branches"; scoped user pinned; foreign branch → 403 |
| Object-level IDOR | cross-branch `GET /employees/:id` → 404 (no existence leak); in-scope → 200 |
| Onboarding | stamps the active branch; honours explicit in-scope branch; foreign branch → 404; own branch → 201 |
| Attendance scoping | relation/denormalized branch filter on the list |
| Per-branch config | `getGeofencingPolicy(branchId)` / `getOfficeHours(branchId)` override chain (branch → global → default) |
| Audit | `ACCESS_DENIED` rows written on cross-branch attempts |
| Enforcement mode | `BRANCH_ENFORCEMENT=off` disables scoping + denials |

## Design

- **`utils/test-app.module.ts`** — a faithful multi-branch slice of the prod
  `AppModule`. Same global wiring (BranchContextMiddleware, ordered
  BranchContextInterceptor + AuditInterceptor, per-controller JwtAuthGuard/RolesGuard,
  Prisma `$use` scoping). Excludes branch-irrelevant heavy modules (chatbot/embeddings
  uses an ESM dynamic `import()` that Jest's CJS VM rejects; face-recognition/TensorFlow;
  projects; payroll batches; cron). Branch scoping is enforced globally at the Prisma
  + interceptor layer, so this slice exhibits identical branch behaviour.
- **`utils/fixtures.ts`** — creates two branches, three users (global admin /
  scoped HR / employee) and two employees, all tagged with a unique `runId` and
  `@test.local` emails. `cleanup()` bulk-deletes by that tag in FK-safe order.
  Never touches production rows.

## CI wiring (future)

`npm run test:e2e` is CI-ready (exit non-zero on failure, `--forceExit`,
`maxWorkers: 1`). Point it at a disposable Postgres, run after `prisma db push`
+ seed. Example step:

```yaml
- run: npm ci --prefix apps/backend
- run: npx prisma db push --skip-generate --schema apps/backend/prisma/schema.prisma
- run: npm run test:e2e --prefix apps/backend
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
    DIRECT_URL: ${{ secrets.TEST_DATABASE_URL }}
    BRANCH_ENFORCEMENT: 'on'
```
