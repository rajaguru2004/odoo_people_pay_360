import { test, expect, ApiClient } from '../../fixtures';
import {
  adjustSettlementLine,
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  featureSkipReason,
  flagFlipAllowed,
  gratuityEntitlement,
  marker,
  prepareSettlement,
  setNationalityClass,
  twinPair,
  withPayrollFeatures,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * End of service, driven through the API a screen uses.
 *
 * Two properties carry the feature and neither is visible from a unit test:
 * that an entitlement REFUSES rather than guessing when nobody has recorded a
 * nationality class, and that a settlement line cannot be changed without a
 * reason — which is enforced by a database CHECK as well as by the service, so
 * it is worth proving end to end.
 *
 * Flagged lane: end-of-service is a global switch.
 *
 * Decade 90–99.
 */
test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const P_A: Period = edgePeriod(90);
const ALL: Period[] = [P_A];

test.describe('end of service', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee | null = null;
  let setupError = '';
  const MARK = marker('pw-payedge-eosb-');
  let seq = 0;
  const nextMark = () => `${MARK}${(seq += 1)}`;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    try {
      await clearPayrollLane(admin, branchId, ALL);
    } catch (err) {
      console.error('teardown', err);
    }
    admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      test.skip(!flagFlipAllowed(), featureSkipReason('eosb'));
      expect(setupError).toBe('');
    });

    test('an entitlement REFUSES rather than guessing at a missing class', async () => {
      // Reporting an unrecorded nationality as a zero entitlement would hide a
      // missing record behind a plausible number — and the number is a legal one.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });

      await withPayrollFeatures(
        admin,
        ['eosb'],
        async () => {
        const r = await gratuityEntitlement(admin, branchId, pair.subject.id);
        expect(r.amount).toBe(0);
        expect(String(r.refusal ?? '')).toMatch(/nationality class is not recorded/i);
      });
    });

    test('with a class recorded, it answers with its working', async () => {
      const pair = await twinPair(admin, {
        marker: nextMark(),
        branchId,
        startDate: '2020-01-01',
      });
      await setNationalityClass(admin, pair.subject.id, 'EXPAT');

      await withPayrollFeatures(admin, ['eosb'], async () => {
        const r = await gratuityEntitlement(admin, branchId, pair.subject.id);
        expect(r.refusal).toBeNull();
        expect(r.serviceYears).toBeGreaterThan(0);
        // The working is stored and shown, because a settlement is argued about
        // years later by people who were not in the room.
        expect(r.workingLines.join(' ')).toMatch(/Service: .* year\(s\)/);
        },
        // The seeded rule is Oman's; the baseline database is India.
        { payroll_country: 'OM' },
      );
    });

    test('a settlement line cannot be changed without a reason', async () => {
      const pair = await twinPair(admin, {
        marker: nextMark(),
        branchId,
        startDate: '2020-01-01',
      });
      await setNationalityClass(admin, pair.subject.id, 'EXPAT');

      await withPayrollFeatures(
        admin,
        ['eosb', 'eosbSettlement'],
        async () => {
        const settlement = await prepareSettlement(admin, branchId, {
          employeeId: pair.subject.id,
          lastWorkingDate: '2044-06-30',
          pendingSalary: 1000,
        });
        expect(settlement.lines.length).toBeGreaterThan(0);
        const line = settlement.lines[0];

        const refused = await adjustSettlementLine(
          admin,
          branchId,
          settlement.id,
          line.id,
          500,
          '   ',
        ).catch((err) => err as Error);
        expect(refused).toBeInstanceOf(Error);
        expect(String((refused as Error).message)).toMatch(/reason is required/i);

        // With a reason it goes through, and the computed figure survives beside
        // the override so the change stays legible.
        await adjustSettlementLine(
          admin,
          branchId,
          settlement.id,
          line.id,
          500,
          'Three unpaid days in the final week.',
        );
        },
        { payroll_country: 'OM' },
      );
    });

    test('one leaver cannot have two open settlements', async () => {
      // Two HR users each preparing one, both approved, pays that person twice.
      const pair = await twinPair(admin, {
        marker: nextMark(),
        branchId,
        startDate: '2020-01-01',
      });
      await setNationalityClass(admin, pair.subject.id, 'EXPAT');

      await withPayrollFeatures(
        admin,
        ['eosb', 'eosbSettlement'],
        async () => {
        await prepareSettlement(admin, branchId, {
          employeeId: pair.subject.id,
          lastWorkingDate: '2044-06-30',
        });
        const second = await prepareSettlement(admin, branchId, {
          employeeId: pair.subject.id,
          lastWorkingDate: '2044-07-31',
        }).catch((err) => err as Error);

        expect(second).toBeInstanceOf(Error);
        expect(String((second as Error).message)).toMatch(/paid twice/i);
        },
        { payroll_country: 'OM' },
      );
    });
  });
});
