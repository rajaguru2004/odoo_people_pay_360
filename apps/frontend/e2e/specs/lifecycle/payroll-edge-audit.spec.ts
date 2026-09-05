import { test, expect, ApiClient } from '../../fixtures';
import {
  auditFor,
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  historyOf,
  lockPayroll,
  marker,
  runEdgePayroll,
  twinPair,
  unlockPayroll,
  type AuditRow,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The audit trail behind a payroll run.
 *
 * ## What the catalogue asks for, and what actually exists
 *
 * The requirement is an immutable record of thirteen payroll actions, each naming
 * **user, timestamp, before/after values and an approval reference**. Measured
 * against the running system, that decomposes into four separate answers rather
 * than one:
 *
 *  | Property | Holds? |
 *  |---|---|
 *  | A row exists for every successful transition | **yes** — exactly one, no more |
 *  | User and timestamp | **yes** |
 *  | Branch | **yes** |
 *  | Which ACTION it was | **no** — every transition writes `CREATE` (G1) |
 *  | Before AND after in the same row | **no** — a row has one or the other (G33) |
 *  | The reason strings | **yes** — `unlockReason` and `rejectionReason` survive in the payload |
 *
 * ## Why both gaps have the same origin
 *
 * `PayrollsService` makes **zero** `AuditService.log()` calls. Everything comes
 * from the global `AuditInterceptor`, which derives `action` from the HTTP verb —
 * and every payroll lifecycle transition is a `POST`. The interceptor also
 * captures a pre-image separately from the response body, and for payroll those
 * two never both land on the same row.
 *
 * ## The contrast that proves it is fixable here
 *
 * `CountryBankingField` rows in the SAME audit table carry
 * `BANKING_FIELDS_SEEDED` — a named verb, from a direct `audit.log()` call in
 * `banking-config.service.ts`. The pattern exists, in this codebase, one module
 * away. That is asserted below, because "we cannot do that here" is the
 * objection this case exists to answer.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-audit-';
const MARK = marker(MARKER_PREFIX);

const GENERIC_ACTIONS = ['CREATE', 'UPDATE', 'DELETE'];

test.describe('the payroll audit trail', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_TRAIL: Period = edgePeriod(80);
  const P_REASONS: Period = edgePeriod(81);
  const ALL = [P_TRAIL, P_REASONS];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await clearPayrollLane(admin, branchId, ALL).catch(() => undefined);
    await admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
    });

    test('every successful transition leaves exactly one row, stamped with who and when', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-trail`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_TRAIL,
        employeeIds: [subject.id],
        carrier,
      });

      const after = async (): Promise<AuditRow[]> => auditFor(admin, 'Payroll', run.id, { limit: 300 });

      // Counted on the NAMED verbs. Two kinds of row exist per transition and
      // that is deliberate: the global `AuditInterceptor` records the HTTP call
      // (`CREATE`, derived from the verb) and `payrolls.service.ts` records the
      // domain event (`PAYROLL_APPROVED` …). The interceptor is global and not
      // payroll's to remove, so the assertion is that every transition produced
      // exactly one NAMED row — a missing one is worse than a duplicate, because
      // a duplicate can still be dated and attributed.
      // `GET /audit-logs` returns newest-first, so the rows are re-sorted into the
      // order the transitions actually happened before any sequence is asserted.
      const named = async (): Promise<string[]> =>
        (await after())
          .filter((r) => r.action.startsWith('PAYROLL_'))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .map((r) => r.action);

      await admin.post(`/payrolls/${run.id}/submit`, {});
      expect(await named(), 'submit is audited under its own name').toEqual(['PAYROLL_SUBMITTED']);

      await admin.post(`/payrolls/${run.id}/approve`, {});
      expect(await named(), 'approve too').toEqual(['PAYROLL_SUBMITTED', 'PAYROLL_APPROVED']);

      await lockPayroll(admin, run.id);
      expect((await named()).at(-1), 'lock too').toBe('PAYROLL_LOCKED');

      await unlockPayroll(admin, run.id, `${MARK} reversing for an audit check`);
      const verbs = await named();
      expect(verbs.at(-1), 'and the reversal').toBe('PAYROLL_UNLOCKED');
      expect(
        verbs,
        'four transitions, four named rows, in the order they happened',
      ).toEqual([
        'PAYROLL_SUBMITTED',
        'PAYROLL_APPROVED',
        'PAYROLL_LOCKED',
        'PAYROLL_UNLOCKED',
      ]);

      const rows = await after();
      expect(rows.length, 'and the run is audited at all').toBeGreaterThanOrEqual(verbs.length);

      for (const r of rows) {
        expect(r.userId, 'every row names the actor').toBeTruthy();
        expect(r.createdAt, 'and is timestamped').toBeTruthy();
        expect(r.branchId, 'and carries the branch it happened in').toBeTruthy();
        expect(r.resourceType, 'and the resource type').toBe('Payroll');
        expect(r.resourceId, 'and the record it is about').toBe(run.id);
      }
    });

    test('G1 FIXED: each transition records its own verb', async () => {
      // The finding, asserted directly. Create, submit, approve, lock and unlock
      // are five different things with five different meanings, five different
      // authorities and five different consequences, and the audit log calls all
      // of them the same word.
      //
      // When the eight named `audit.log()` calls land, THIS is the case that
      // fails, and the message says what to expect instead.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-verbs`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_REASONS,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);
      await unlockPayroll(admin, run.id, `${MARK} reversing to inspect the verbs`);

      const rows = await auditFor(admin, 'Payroll', run.id, { limit: 300 });
      const actions = [...new Set(rows.map((r) => r.action))];

      expect(rows.length, 'five transitions happened').toBeGreaterThanOrEqual(5);

      // The fix: each transition records its own verb, so the trail can say WHICH
      // one it was. Previously every row said `CREATE` and five different things
      // with five different authorities were indistinguishable.
      for (const verb of [
        'PAYROLL_SUBMITTED',
        'PAYROLL_APPROVED',
        'PAYROLL_LOCKED',
        'PAYROLL_UNLOCKED',
      ]) {
        expect(actions, `the trail names ${verb}`).toContain(verb);
      }

      const named = rows.filter((r) => !GENERIC_ACTIONS.includes(r.action));
      expect(
        named.length,
        'the lifecycle transitions are recorded under payroll verbs, not HTTP ones (G1)',
      ).toBeGreaterThanOrEqual(4);
      for (const r of named) {
        expect(r.action, `${r.action} reads as a payroll domain event`).toMatch(/^PAYROLL_[A-Z_]+$/);
      }
    });

    test('G33 FIXED: a payroll-written row carries both sides of the change', async () => {
      // The catalogue asks for before/after VALUES. Each row has one side of the
      // change, so reading "DRAFT became PENDING_APPROVAL, by this person, at this
      // time" requires joining rows by timestamp and inferring the pairing.
      //
      // `PayrollsService.getApprovalHistory()` works around exactly this by
      // reconstructing the trail from the Payroll row's own stamp columns instead
      // of reading `audit_logs` at all — which is the strongest evidence that the
      // audit trail is not usable for the question it exists to answer.
      const rows = await auditFor(admin, 'Payroll', '', { limit: 300 }).catch(() => []);
      const all = (
        await admin.get<unknown>('/audit-logs?resourceType=Payroll&limit=300')
      ) as unknown;
      const list = (Array.isArray(all) ? all : ((all as { data?: AuditRow[] })?.data ?? [])) as AuditRow[];
      expect(list.length, 'there are payroll audit rows to inspect').toBeGreaterThan(0);
      expect(rows.length, 'the helper filters by resource id').toBe(0);

      const hasBefore = (r: AuditRow) => !!r.oldData && Object.keys(r.oldData as object).length > 0;
      const hasAfter = (r: AuditRow) => !!r.newData && Object.keys(r.newData as object).length > 0;

      const both = list.filter((r) => hasBefore(r) && hasAfter(r));
      const either = list.filter((r) => hasBefore(r) || hasAfter(r));

      expect(either.length, 'every row carries at least one side of the change').toBe(list.length);

      // The fix: the payroll-written rows carry BOTH sides, so a single row
      // answers "what changed". The interceptor's own rows still carry one side —
      // that is its design and it is not payroll's to change — which is why this
      // asserts that SOME rows are complete rather than all of them.
      const named = list.filter((r) => r.action.startsWith('PAYROLL_'));
      expect(named.length, 'there are payroll-written rows to inspect').toBeGreaterThan(0);
      for (const r of named) {
        expect(
          hasBefore(r) && hasAfter(r),
          `${r.action} carries both a before and an after, so one row shows the transition (G33)`,
        ).toBe(true);
        expect(
          (r.oldData as { status?: string })?.status,
          `${r.action} records the status it moved FROM`,
        ).toBeTruthy();
        expect(
          (r.newData as { status?: string })?.status,
          `${r.action} records the status it moved TO`,
        ).toBeTruthy();
      }
      expect(both.length, 'so at least the payroll verbs are complete rows').toBeGreaterThan(0);
    });

    test('the reason a run was reversed survives in the record', async () => {
      // The half that DOES hold, and it is the half that matters most for a
      // reversal: an unlock is money moving backwards, and the trail keeps the
      // sentence the operator typed.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-reason`,
        branchId,
        baseSalary: 1500,
      });
      const period = edgePeriod(82);
      await clearPayrollLane(admin, branchId, [period]);
      const run = await runEdgePayroll(admin, {
        branchId,
        period,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      const REASON = `${MARK} overtime hours were wrong for one employee`;
      await unlockPayroll(admin, run.id, REASON);

      const rows = await auditFor(admin, 'Payroll', run.id, { limit: 300 });
      const carriesReason = rows.some((r) =>
        JSON.stringify(r.newData ?? {}).includes(REASON) ||
        JSON.stringify(r.oldData ?? {}).includes(REASON),
      );
      expect(
        carriesReason,
        'the unlock reason is recoverable from the audit payload, even though the ' +
          'ACTION does not say it was an unlock',
      ).toBe(true);

      await clearPayrollLane(admin, branchId, [period]);
    });

    test('G34 FIXED: the reversal is append-only — the lock survives an unlock', async () => {
      // ── The most compliance-relevant finding in this phase.
      //
      // A lock is the event that moves money: it settles leave encashment,
      // gratuity accrual and garnishment collections.
      // `getApprovalHistory()` derives its LOCKED step from
      // `Payroll.lockedAt`, and `unlockPayroll` sets `lockedAt` back to NULL. So
      // after a reversal the trail the product shows contains no evidence the run
      // was ever locked — and therefore none that the money ever moved.
      //
      // Nothing else fills the gap: `audit_logs` cannot say WHICH transition a row
      // was (G1) and carries only one side of each change (G33). What survives is
      // `unlockCount: 1` — a bare counter that records THAT a reversal happened
      // without recording what it reversed.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-erase`,
        branchId,
        baseSalary: 1500,
      });
      const period = edgePeriod(83);
      await clearPayrollLane(admin, branchId, [period]);
      const run = await runEdgePayroll(admin, {
        branchId,
        period,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      const locked = (await historyOf(admin, run.id)).map((h) => h.action);
      expect(locked, 'while locked, the trail names the lock').toContain('LOCKED');

      await unlockPayroll(admin, run.id, `${MARK} reversing an audited lock`);
      const afterUnlock = (await historyOf(admin, run.id)).map((h) => h.action);

      // The fix: the reversal is APPEND-ONLY. The lock stays on the record and the
      // unlock is recorded after it, so the trail shows both.
      expect(
        afterUnlock,
        'the LOCKED step SURVIVES the reversal — a lock that settled money is ' +
          'still evidenced after the run is unlocked (G34)',
      ).toContain('LOCKED');
      expect(
        afterUnlock,
        'and the reversal itself is recorded, rather than only a counter',
      ).toContain('UNLOCKED');
      expect(afterUnlock, 'with the earlier steps intact').toContain('APPROVED');

      // Order matters: the reversal comes after the thing it reversed.
      expect(
        afterUnlock.indexOf('UNLOCKED'),
        'the unlock is recorded AFTER the lock it reversed',
      ).toBeGreaterThan(afterUnlock.indexOf('LOCKED'));

      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        unlockCount: number;
        lockedAt: string | null;
        status: string;
      };
      expect(Number(payroll.unlockCount), 'the counter still records the reversal').toBe(1);
      expect(
        payroll.lockedAt,
        'and the lock timestamp is NO LONGER erased — that erasure was the defect',
      ).toBeTruthy();
      expect(payroll.status, 'the run is back to APPROVED').toBe('APPROVED');

      await clearPayrollLane(admin, branchId, [period]);
    });

    test('named audit verbs already exist in this codebase, one module away', async () => {
      // The objection this case answers is "the interceptor cannot know the verb".
      // It does not have to: `banking-config.service.ts` calls `audit.log()`
      // directly and writes `BANKING_FIELDS_SEEDED`. The same calls in
      // `payrolls.service.ts` would close the whole Audit & Compliance section.
      // Write the row HERE rather than relying on another spec having run. A case
      // that answers an objection is worthless if it skips on a fresh database —
      // which is exactly what it did in the first run of this file. The seed
      // route is idempotent and audits unconditionally, so a re-run costs a row
      // and changes nothing else.
      await admin.post('/banking-config/seed', {});

      const raw = await admin.get<unknown>(
        '/audit-logs?resourceType=CountryBankingField&limit=50',
      );
      const rows = (Array.isArray(raw) ? raw : ((raw as { data?: AuditRow[] })?.data ?? [])) as AuditRow[];
      expect(
        rows.length,
        'seeding the banking fields writes an audit row — if not, this contrast ' +
          'cannot be drawn and the case needs rewriting rather than skipping',
      ).toBeGreaterThan(0);

      const actions = [...new Set(rows.map((r) => r.action))];
      expect(
        actions.some((a) => !GENERIC_ACTIONS.includes(a)),
        `banking config writes named verbs (${actions.join(', ')}), so the pattern is ` +
          'available to payroll — G1 is a gap, not a platform limitation',
      ).toBe(true);
      expect(actions.join(','), 'and they read as domain events').toMatch(/BANKING_[A-Z_]+/);
    });
  });
});
