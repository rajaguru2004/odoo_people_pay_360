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
| Browser — Playwright | 🟡 see §6 |

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
4. **Browser** — Playwright, per role. 🟡 First full run in progress; results to
   be recorded here.

---

## 7. Open items ⚠️

| Item | Detail |
| --- | --- |
| `docker-entrypoint.sh` runs bare `prisma db push` | Against a database that already holds employees, the new `national_id` unique constraint makes push prompt for `--accept-data-loss` and the container start aborts. Harmless on a fresh deployment. A real upgrade wants `prisma migrate`, not a blanket `--accept-data-loss`. **Left as-is deliberately — your call.** |
| An unrequested commit on `main` | A subagent ran `git commit` (`0923385`, 226 files). Nothing lost. Undo to an unstaged tree with `git reset --soft HEAD~1 && git reset`, or keep it. |

---

## 8. Defects found and fixed during the migration

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

**`npm run test:api` pointed at the dev database.**
The backend's Jest config reads `.env`, and these specs create, approve and
delete real rows. Now behind `scripts/test-api.sh`, which loads `.env.test` and
refuses to start unless it resolves to the e2e port.

---

## 9. Deliberately out of scope

Employee self-service (`/dashboard/my-*`), leave and overtime, payroll runs,
scheduling, finance, talent and the workplace modules. The rail declares no route
that nobody has built — an entry pointing at a 404 is worse than no entry.
