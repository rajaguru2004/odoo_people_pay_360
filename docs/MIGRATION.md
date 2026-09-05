# Migration tracker — Organisation, People, Time & Attendance

Status of the three HR modules ported into this repo. Written as a fresh
implementation against this codebase's conventions rather than a copy: same
screens, same behaviour, new code.

**Legend** — ✅ done and verified · 🟡 done, not yet exercised end to end ·
⬜ not started · ⚠️ needs a decision

---

## 1. Where it stands

| Gate | Result |
| --- | --- |
| `npm run typecheck` (both apps) | ✅ clean |
| `npm run lint` (both apps) | ✅ 0 errors (12 pre-existing warnings) |
| Backend unit — Jest | ✅ 122 passing, 9 suites |
| Frontend unit + component — Vitest | ✅ 206 passing, 27 files |
| API integration — supertest | ✅ 75 passing, 4 suites |
| `npm run build` (both apps) | ✅ 24 dashboard routes compile |
| Browser — Playwright | ✅ 0 failures across the three migrated modules |

Roughly 42,000 lines of TypeScript across the two apps.

---

## 2. Data model ✅

Twelve models added to `apps/backend/prisma/schema.prisma`, plus thirteen enums.

| Area | Models |
| --- | --- |
| Organisation | `Branch` (extended), `Department` (extended: hierarchy, description), `DepartmentChangeRequest` |
| People | `Employee` (extended), `Team`, `TeamMember`, `Contract`, `TerminationRequest`, `EmployeeLegalDocument` |
| Time | `Attendance`, `AttendanceCorrection`, `WorkSchedule`, `Holiday`, `FaceEnrollment` |

Applied with `prisma db push`; client generated. See §7 for the deployment note.

---

## 3. Backend ✅

| Module | Endpoints | Tests |
| --- | --- | --- |
| `branches/` | list · get · create · update · delete-or-deactivate | ✅ |
| `departments/` | list · **tree** · **statistics** · get · create · update · delete | ✅ |
| `departments/change-requests/` | list · get (+impact) · raise · review · cancel | ✅ |
| `organization/` | `hub-summary` | ✅ |
| `employees/` | list · get · **hub-summary** · team · create · update · terminate | ✅ |
| `teams/` | CRUD + member add/update/remove | ✅ |
| `contracts/` | list · **expiring** · get · create · update · renew | ✅ |
| `contracts/terminations/` | list · raise · review | ✅ |
| `legal-documents/` | list · **summary** · **expiring** · get · create · update · renew · cancel · daily expiry sweep | ✅ |
| `attendances/` | list · today · summary · **hub-summary** · per-employee · get · check-in · check-out · create · update · delete · bulk | ✅ |
| `attendance-corrections/` | list · **stats** · get · raise · review · cancel | ✅ |
| `work-schedules/` | CRUD + bulk roster | ✅ |
| `holidays/` | CRUD | ✅ |
| `face-enrollments/` | list · per-employee · create · delete | ✅ |

All registered explicitly in `app.module.ts`; every literal route declared ahead
of its `:id` sibling.

---

## 4. Frontend ✅

**Shared kit** — `navConfig` (accordion rail + tile source), `ProtectedRoute`,
`pageHeaderStore`/`usePageHeader` (one `<h1>` for the whole shell), the
module-landing kit (`ModuleLandingPage`, `StatCard`/`KpiRow`, `AttentionStrip`,
`ModuleNavTiles`, `primitives` chart set), `/403`, and i18n namespaces in
English and Arabic.

| Module | Routes |
| --- | --- |
| Organisation | `/organization` · `/branches` (+ new, `[id]`, edit) · `/departments` (+ new, `[id]`, edit, **tree**, **change-requests** + `[id]`) |
| People | `/people` · `/employees` (+ new, `[id]`, edit) · `/teams` (+ new, `[id]`) · `/contracts` (+ new, `[id]`, **terminations**) · `/visa-reports` |
| Time & attendance | `/time` · `/attendance` · `/history` · `/corrections` · `/reports` · `/management` · `/face-management` |

---

## 5. Defaults and seed data ✅

20 system settings seeded as rows — the office window, grace period, weekly rest
days, half-day threshold, and the contract / probation / visa alert horizons.
They are rows rather than constants because a grace period that needs a deploy
to change is the wrong shape for a number a payroll manager adjusts on a Tuesday.

The seed is **idempotent** (verified across repeated runs) and **self-refreshing**:
fixtures positioned relative to today are re-dated on each run, so a demo run
months later still demonstrates something rather than showing an empty runway.

Seeded: 2 branches · 7 nested departments · 21 employees with reporting and
supervisory lines · 4 sign-in accounts · 4 teams · 21 contracts · 6 work permits ·
5 holidays · 14 rostered shifts · 600 attendance records over 30 days ·
3 pending corrections · 2 pending change requests · 1 termination awaiting
approval.

Every governance and deadline card has a real population — one joiner, one
starter ahead, one probation ending, one contract expiring in 21 days, one visa
inside the alert window, one headless department. A demo where every card reads
zero cannot show that the cards work.

---

## 6. Verification 🟡

Four layers, three of them green:

1. **Unit** — pure logic. The attendance calendar is covered to the boundary:
   DST spring-forward, a shift crossing midnight, an arrival exactly on the
   grace edge, exactly half the expected hours.
2. **Component** — screens rendered in jsdom, including the null-vs-zero
   behaviour on every hub.
3. **API integration** — the real app over HTTP against the e2e database, so the
   response envelope, the guards and `forbidNonWhitelisted` are asserted against
   the app as assembled.
4. **Browser** — Playwright, per role: **102 passing, 0 failing** (2 skipped by
   design, where the role being tested is entitled to the route). A spec
   declares its roles in its filename, so a project the name does not list never
   loads it and no browser opens only to assert a 403.

### Running the browser suite

```bash
npm run e2e:db reset                     # clean database (not `e2e:up`, see below)
bash scripts/test-api.sh                 # optional: API layer
cd apps/backend && set -a && . ./.env.test && set +a && node dist/src/main.js &
cd apps/frontend && npm run test:e2e     # builds and starts the portal itself
```

`e2e:db reset` rather than `e2e:up`: the latter re-seeds a database that is
already running, and some of what these suites write is HISTORY the application
deliberately never deletes — an approved change request, a renewed permit. That
accumulates across runs, which is correct behaviour, but it means no assertion
may depend on a whole-table count. Two of ours did, and were rewritten to filter
to the pending queue instead.

Playwright's browsers are not vendored: `npx playwright install chromium` once.

---

## 7. Screen-depth gap ⚠️

Route coverage is complete; **screen depth was not**. An audit comparing
non-test source per area against the system this was ported from found several
screens at a fraction of their original — the attendance log shipped as a flat
paginated list where it should be a month grid, and the employee directory at
about a sixth of its original size.

The full measurement and the per-screen list is in
[MIGRATION-GAPS.md](MIGRATION-GAPS.md). Most of it is one repeated omission: a
view switcher, a stats bar, a filter panel and an export sit on almost every
list screen in the original and on none of the first cut here.

The product is targeting **MVP — the core features plus UI parity with the
existing system** — so that document is a decision record rather than an open
list: what is being closed now, and what is deferred with the reason. Nothing
already working is being replaced to get there; the attendance log is the one
exception, and only because it is wrong rather than thin.

Recorded rather than quietly fixed because it is the useful lesson: route parity
is not feature parity, and counting routes said this migration was done when it
was not.

## 7b. Employee self-service ⚠️ in progress

The EMPLOYEE role was missed almost entirely in the first pass: signed in as an
employee the rail offered Dashboard, Payroll and Settings and nothing else. That
was a deliberate decision when the navigation was written — not to declare
routes nobody was building — and it was the wrong one.

Being closed now as a PORT rather than a redesign: the original works and is
going to keep being used against this backend, so endpoint paths, request bodies
and response field names are carried across unchanged. Where the original emits
`fullName` this one emits `fullName` too, joined in the service, even though the
schema stores `firstName`/`lastName`.

Two adaptations were unavoidable and are the only ones: imports rewired to this
repo's `PrismaService` and guards, and money at `Decimal(18, 3)` rather than
`(12, 2)` — the currencies this runs on are thousandths.

**Schema is done**: twenty models added, validated and pushed — leave (requests,
attachments, balances, per-type balances), overtime (requests, policies), the
approval engine (workflows, steps, per-request rows), employee documents,
letters, assets, training, grievances, and the `LibraryItem` pick lists.

**Screens being ported**: approvals · my team · my attendance · biometric
verification · my calendar · my leaves · my overtime · my payslips · my
documents · my letters · my assets · my training · my grievances · my profile ·
settings, plus the role-aware dashboard.

**Excluded by instruction**: reimbursements, advances and loans, travel,
end-of-service, projects. Also excluded because nothing in the employee screens
reaches them: appraisals, the messaging integrations, and the document ENGINE
(the small vault behind My Documents IS in scope).

## 8. Open items ⚠️

| Item | Detail |
| --- | --- |
| `docker-entrypoint.sh` runs bare `prisma db push` | Against a database that already holds employees, the new `national_id` unique constraint makes push prompt for `--accept-data-loss` and the container start aborts. Harmless on a fresh deployment. A real upgrade wants `prisma migrate`, not a blanket `--accept-data-loss`. **Left as-is deliberately — your call.** |
| Unrequested commits on `main` | Four commits appeared during this work (`0923385`, `6dc781e`, `4f995ae`, `4628897`) that nobody asked for. There is no git hook configured, so they came either from a subagent or from one of the other Claude sessions open in this checkout. Nothing is lost and `main` is not pushed. To unwind them all to an unstaged tree: `git reset --soft 4ad16e6 && git reset`. Left in place because they may not be mine to undo. |
| Playwright browsers | Not vendored — `npx playwright install chromium` before the first browser run. |

---

## 9. Defects found and fixed during the migration

Each was found by a test or a live probe, and fixed rather than worked around.

**A correction could rewrite a day it did not belong to.**
`AttendanceCorrection.create` checked that the check-out followed the check-in
but never that either instant fell on the correction's own date. A request filed
for September accepting a January check-in produced a **5,864-hour working day**
that flowed into the attendance report and from there into pay. Now range-checked
in the employee's effective zone, with a night shift's check-out allowed on the
following morning, and re-checked on the approve path.

**Attendance reads had no authorisation.**
No `@Roles`, no principal narrowing: any employee could read
`/attendances`, `/today`, `/summary` and `/hub-summary`, which answer **by name**
— who was absent, who arrived late. Now gated to the four management roles, with
own-history still open to everyone through a service-side self-or-privileged
check, because the answer depends on whose record it is and a decorator cannot
see that.

**The rail offered a route the server refuses.**
A payroll officer saw Organisation and People, whose hubs are ADMIN/HR-only —
clicking landed them on `/403` via their own sidebar. `NavGroup.hubRoles` now
mirrors the `@Roles` on each aggregate, and the group header re-points to the
first screen the role can actually reach.

**The Attendance Manager could not save.**
The frontend sent `{ employeeIds[], status }` while the endpoint takes
`{ entries[] }` behind `forbidNonWhitelisted` — a guaranteed 400 on a grid the
user had just filled in. The endpoint's shape is also the better one (one call,
mixed verdicts), so the screen was aligned to it and the contract pinned by tests
on both sides.

**A moving key duplicated a contract.**
Contract numbers were derived from the hire *year*, which moves for a relative
date — the upsert inserted a second contract instead of updating the first,
leaving one employee holding two.

**`next start` could not serve a build.**
`output: "standalone"` was set unconditionally for the Docker image, and
`next start` refuses to run against a standalone build — it warns and serves
nothing. That took away the ordinary build-and-look-at-it loop and the browser
suite with it, since Playwright deliberately tests a production build rather
than `next dev`. Now opt-in via `NEXT_OUTPUT_STANDALONE`, which the Dockerfile
sets and nothing else needs to.

**The demo-account panel shipped its credentials even when switched off.**
The panel added to the sign-in screen is gated to non-production builds, but the
first implementation only stopped it RENDERING: `next build` substitutes a
`NEXT_PUBLIC_*` value only when it is set and leaves an unset one as a runtime
lookup, so the guard was never a constant, nothing was folded, and the four
account emails and the password sat in the production bundle in plain text.
The rule now resolves in `next.config.ts` and is inlined, so the guard folds and
the component — with its credentials — is dropped. Verified by grepping a built
bundle both ways.

**The shell scrolled away with the page.**
`app/dashboard/layout.tsx` was `min-h-dvh`, so the document itself grew and the
rail and header scrolled off the top of any page longer than the window — taking
the navigation and the sign-out control with them. The shell is now `h-dvh
overflow-hidden` with `<main>` as the only scroller, the rail scrolling
internally (a fully-expanded accordion can outgrow the window) and the header
`shrink-0`.

**The breadcrumb trail was in the header bar.**
It described the page but lived in the frame, squeezed above the heading in a
64px row where it read as a caption rather than a route. It now renders at the
top of the content area. The heading stays in the bar; both read one derivation
(`usePageChrome`) so they cannot drift apart.

**`npm run test:api` pointed at the dev database.**
The backend's Jest config reads `.env`, and these specs create, approve and
delete real rows. Now behind `scripts/test-api.sh`, which loads `.env.test` and
refuses to start unless it resolves to the e2e port.

---

## 10. Built alongside, by another session

A **Schedules** module (`/dashboard/schedules`, `src/schedules/`) was added and
merged from a `schedules` branch while this work was in progress — it is not
part of this migration. It shares the shell, so the layout changes above apply
to it too. Its own specs (`e2e/specs/schedules.*.spec.ts`) belong with it.

## 11. Deliberately out of scope

Employee self-service (`/dashboard/my-*`), leave and overtime, payroll runs,
scheduling, finance, talent and the workplace modules. The rail declares no route
that nobody has built — an entry pointing at a 404 is worse than no entry.
