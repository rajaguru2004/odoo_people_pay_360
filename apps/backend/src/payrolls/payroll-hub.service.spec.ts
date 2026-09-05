import { BadRequestException } from '@nestjs/common';
import { PayrollHubService } from './payroll-hub.service';

/**
 * The Payroll hub aggregate.
 *
 * These cases pin the rules the rebuild exists to enforce, each of which the
 * old fan-out got wrong:
 *
 *  - money means LOCKED, and a month with no locked run reports `null` rather
 *    than a 0 that draws as "we paid nobody";
 *  - the open-run count comes from the database, not from a 20-row list;
 *  - readiness reuses the banking validator, and is UNKNOWN — never 100% —
 *    when a branch has no banking country to require anything of;
 *  - legacy company-wide runs are counted deliberately and excluded from
 *    everything else, rather than silently vanishing.
 */

jest.mock('../common/branch/branch-context', () => ({
  runWithBranchBypass: (fn: () => any) => fn(),
}));

const AUG = { month: 8, year: 2026 };
/** Anything inside the anchor month; the service only reads UTC month/year. */
const NOW = new Date('2026-08-25T00:00:00.000Z');

describe('PayrollHubService', () => {
  let payrolls: any[];
  let items: any[];
  let activeCount: number;
  let excludedCount: number;
  let excludedNames: any[];
  let legacyRuns: number;
  let carryForward: number;
  let settlementRows: any[];
  let lastWpsFile: any;
  let readinessEmployees: any[];
  let countryFields: Record<string, any[]>;

  const locked = (p: any) => p.status === 'LOCKED';
  const itemsFor = (pred: (p: any) => boolean) => {
    const ids = new Set(payrolls.filter(pred).map((p) => p.id));
    return items.filter((i) => ids.has(i.payrollId));
  };
  const sumNet = (rows: any[]) => rows.reduce((a, r) => a + Number(r.netSalary), 0);

  const prisma: any = {
    payroll: {
      findFirst: jest.fn(async () => {
        const sorted = [...payrolls].sort(
          (a, b) => b.year - a.year || b.month - a.month,
        );
        return sorted[0] ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.status === 'PENDING_APPROVAL') {
          return payrolls.filter((p) => p.status === 'PENDING_APPROVAL');
        }
        if (where?.status === 'REJECTED') {
          return payrolls.filter((p) => p.status === 'REJECTED');
        }
        return payrolls;
      }),
      groupBy: jest.fn(async () => {
        const counts = new Map<string, number>();
        for (const p of payrolls) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
        return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
      aggregate: jest.fn(async () => ({
        _min: {
          submittedAt:
            payrolls.find((p) => p.status === 'PENDING_APPROVAL')?.submittedAt ?? null,
        },
      })),
      count: jest.fn(async ({ where }: any) => {
        if (where?.branchId === null) return legacyRuns;
        // draftForClosedPeriod
        return payrolls.filter(
          (p) => p.status === 'DRAFT' && (p.year < 2026 || p.month < 8),
        ).length;
      }),
    },
    payrollItem: {
      aggregate: jest.fn(async ({ where, _sum }: any) => {
        const st = where.payroll.status;
        const rows = itemsFor(
          (p) =>
            p.month === where.payroll.month &&
            p.year === where.payroll.year &&
            (st ? p.status === st : true),
        );
        if (_sum && 'baseSalary' in _sum) {
          const col = (k: string) =>
            rows.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
          // Sum whatever the caller asked for, rather than a hand-written
          // subset — a hardcoded `insurance: 0` here silently made the
          // statutory card untestable.
          return {
            _sum: Object.fromEntries(
              Object.keys(_sum).map((k) => [k, col(k)]),
            ) as Record<string, number>,
            // Load-bearing: the previous month now sums the SAME columns as
            // the anchor, and `_count` is what separates "locked nothing" from
            // "locked a run that came to zero".
            _count: { _all: rows.length },
          };
        }
        return {
          _sum: { netSalary: rows.length ? sumNet(rows) : null },
          _count: { _all: rows.length },
        };
      }),
      findMany: jest.fn(async ({ where, select }: any) => {
        if (select?.payroll) {
          // anchor items, any status
          return itemsFor(
            (p) => p.month === where.payroll.month && p.year === where.payroll.year,
          ).map((i) => ({
            employeeId: i.employeeId,
            payroll: { status: payrolls.find((p) => p.id === i.payrollId)!.status },
          }));
        }
        // window items, LOCKED only
        return itemsFor(locked).map((i) => ({
          payrollId: i.payrollId,
          employeeId: i.employeeId,
          netSalary: i.netSalary,
          insurance: i.insurance ?? 0,
          baseSalary: i.baseSalary ?? 0,
          allowances: i.allowances ?? 0,
          bonus: i.bonus ?? 0,
          overtimePay: i.overtimePay ?? 0,
          foodAllowance: i.foodAllowance ?? 0,
          siteAllowance: i.siteAllowance ?? 0,
          reimbursement: i.reimbursement ?? 0,
          leaveEncashment: i.leaveEncashment ?? 0,
        }));
      }),
    },
    employee: {
      count: jest.fn(async ({ where }: any) =>
        where?.payrollItems ? excludedCount : activeCount,
      ),
      findMany: jest.fn(async ({ select }: any) =>
        select?.bankDetails ? readinessEmployees : excludedNames,
      ),
    },
    payrollCarryForward: { count: jest.fn(async () => carryForward) },
    finalSettlement: {
      groupBy: jest.fn(async () => settlementRows),
      aggregate: jest.fn(async () => ({ _sum: { netPayable: 1200 } })),
    },
    wpsFile: {
      findFirst: jest.fn(async () => lastWpsFile),
      aggregate: jest.fn(async () => ({ _sum: { rejectedCount: 3 } })),
    },
  };

  const bankingConfig: any = {
    getFieldsForCountry: jest.fn(async (c: string) => countryFields[c] ?? []),
  };

  /** A real Omani IBAN: 23 chars, bank code `018`, mod-97 checksum passes. */
  const VALID_OM_IBAN = 'OM040181000000000150461';
  /**
   * The same IBAN with its last digit changed: same country, same bank code,
   * same length — so the ONLY thing separating it from the one above is the
   * mod-97 checksum, which is exactly the failure a "has a bank record" count
   * cannot see.
   */
  const BAD_CHECKSUM_OM_IBAN = 'OM040181000000000150462';

  const IBAN_FIELD = {
    fieldKey: 'iban',
    label: 'IBAN',
    fieldType: 'TEXT',
    validationType: 'NONE',
    required: true,
    displayOrder: 1,
    isSensitive: true,
  };

  const employee = (id: string, over: any = {}) => ({
    id,
    employeeCode: `E-${id}`,
    fullName: `Person ${id}`,
    branch: { country: 'OM', bankingCountries: ['OM'] },
    bankDetails: [
      { data: { iban: 'OM123' }, bank: { country: 'OM', bankCode: 'BM', isActive: true } },
    ],
    bankChangeRequests: [],
    ...over,
  });

  const make = () => new PayrollHubService(prisma, bankingConfig);

  beforeEach(() => {
    payrolls = [
      { id: 'p-aug', ...AUG, status: 'LOCKED', submittedAt: null },
      { id: 'p-jul', month: 7, year: 2026, status: 'LOCKED', submittedAt: null },
    ];
    items = [
      { payrollId: 'p-aug', employeeId: 'e1', netSalary: 1000, baseSalary: 900, allowances: 200, deduction: 60, tax: 40, insurance: 0 },
      { payrollId: 'p-aug', employeeId: 'e2', netSalary: 500, baseSalary: 450, allowances: 100, deduction: 30, tax: 20, insurance: 0 },
      { payrollId: 'p-jul', employeeId: 'e1', netSalary: 900, baseSalary: 900, allowances: 0, deduction: 0, tax: 0, insurance: 0 },
    ];
    activeCount = 4;
    excludedCount = 2;
    excludedNames = [{ id: 'e3', employeeCode: 'E-e3', fullName: 'Person e3' }];
    legacyRuns = 0;
    carryForward = 1;
    settlementRows = [
      { status: 'DRAFT', _count: { _all: 2 } },
      { status: 'APPROVED', _count: { _all: 1 } },
    ];
    lastWpsFile = null;
    readinessEmployees = [employee('e1'), employee('e2')];
    countryFields = { OM: [IBAN_FIELD] };
    jest.clearAllMocks();
  });

  describe('the reporting window', () => {
    it('refuses a months value outside the offered list rather than defaulting', async () => {
      await expect(make().getSummary('7', NOW)).rejects.toThrow(BadRequestException);
      await expect(make().getSummary('0', NOW)).rejects.toThrow(BadRequestException);
      await expect(make().getSummary('abc', NOW)).rejects.toThrow(BadRequestException);
    });

    it('defaults to 6 months when none is asked for', async () => {
      const out = await make().getSummary(undefined, NOW);
      expect(out.months).toBe(6);
      expect(out.trend).toHaveLength(6);
    });

    it('accepts 12 and returns twelve buckets', async () => {
      const out = await make().getSummary('12', NOW);
      expect(out.trend).toHaveLength(12);
    });

    it('anchors on the current month when that month has a run', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.anchor).toMatchObject({
        month: 8,
        year: 2026,
        label: 'Aug 2026',
        resolvedFrom: 'current-month',
      });
    });

    it('anchors on the latest month WITH a run when the current one has none', async () => {
      // Runs stop in June; "today" is still August.
      payrolls = [{ id: 'p-jun', month: 6, year: 2026, status: 'LOCKED', submittedAt: null }];
      items = [{ payrollId: 'p-jun', employeeId: 'e1', netSalary: 700, baseSalary: 700, allowances: 0, deduction: 0, tax: 0 }];

      const out = await make().getSummary('6', NOW);
      expect(out.anchor).toMatchObject({
        month: 6,
        year: 2026,
        label: 'Jun 2026',
        resolvedFrom: 'latest-run',
      });
      // The trend ends on the anchor, not on today, or the chart and the cards
      // above it would describe different periods.
      expect(out.trend[out.trend.length - 1].key).toBe('2026-06');
    });

    it('falls back to the current month on a database with no payroll at all', async () => {
      payrolls = [];
      items = [];
      const out = await make().getSummary('6', NOW);
      expect(out.anchor).toMatchObject({ month: 8, year: 2026, resolvedFrom: 'current-month' });
      expect(out.money.net).toBeNull();
    });
  });

  describe('money means LOCKED', () => {
    it('sums netSalary of locked items only', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.money.net).toBe(1500);
      expect(out.money.previousNet).toBe(900);
    });

    it('reports null, not zero, when the anchor month has no locked run', async () => {
      payrolls = [{ id: 'p-aug', ...AUG, status: 'DRAFT', submittedAt: null }];
      items = [
        { payrollId: 'p-aug', employeeId: 'e1', netSalary: 1000, baseSalary: 900, allowances: 200, deduction: 60, tax: 40 },
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.money.net).toBeNull();
      // and the bar for that month is explicitly "not finalised"
      const aug = out.trend.find((b) => b.key === '2026-08')!;
      expect(aug.locked).toBe(false);
      expect(aug.net).toBeNull();
      expect(aug.runs).toBe(1);
    });

    it('reports gross, the statutory line and total deductions beside net', async () => {
      // The hub only ever answered "what did people take home". A payroll
      // officer is also asked what the run COST and what the regulator took,
      // and both used to require opening the reports screen.
      items = [
        { payrollId: 'p-aug', employeeId: 'e1', netSalary: 1000, baseSalary: 900, allowances: 200, deduction: 60, tax: 40, insurance: 100 },
        { payrollId: 'p-jul', employeeId: 'e1', netSalary: 900, baseSalary: 900, allowances: 100, deduction: 0, tax: 0, insurance: 80 },
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.money.gross).toBe(1100);
      expect(out.money.statutory).toBe(100);
      expect(out.money.deductions).toBe(200);
      // The previous month is summed over the SAME columns, or the delta on
      // the card compares a total against a subset.
      expect(out.money.previousGross).toBe(1000);
      expect(out.money.previousStatutory).toBe(80);
      expect(out.money.previousDeductions).toBe(80);
    });

    it('leaves the PREVIOUS month unknown when it locked nothing, rather than 0', async () => {
      // A delta drawn against a 0 that only means "not finalised" reports the
      // entire payroll as growth.
      payrolls = [
        { id: 'p-aug', ...AUG, status: 'LOCKED', submittedAt: null },
        { id: 'p-jul', month: 7, year: 2026, status: 'DRAFT', submittedAt: null },
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.money.net).toBe(1500);
      expect(out.money.previousNet).toBeNull();
      expect(out.money.previousGross).toBeNull();
      expect(out.money.previousStatutory).toBeNull();
    });

    it('carries a gross and a statutory series per month for the sparklines', async () => {
      items = [
        { payrollId: 'p-aug', employeeId: 'e1', netSalary: 1000, baseSalary: 900, allowances: 200, deduction: 60, tax: 40, insurance: 100 },
        { payrollId: 'p-jul', employeeId: 'e1', netSalary: 900, baseSalary: 900, allowances: 0, deduction: 0, tax: 0, insurance: 80 },
      ];

      const out = await make().getSummary('6', NOW);
      const aug = out.trend.find((b) => b.key === '2026-08')!;
      const jul = out.trend.find((b) => b.key === '2026-07')!;
      expect(aug.gross).toBe(1100);
      expect(aug.statutory).toBe(100);
      expect(jul.gross).toBe(900);
      expect(jul.statutory).toBe(80);
      // Same rule as `net`: an unfinalised month has no gross either.
      const jun = out.trend.find((b) => b.key === '2026-06')!;
      expect(jun.gross).toBeNull();
      expect(jun.statutory).toBeNull();
    });

    it('counts a paid employee once when two runs cover one month', async () => {
      // A per-branch run and a per-batch run, both locked, both holding e1.
      payrolls.push({ id: 'p-aug-b', ...AUG, status: 'LOCKED', submittedAt: null });
      items.push({
        payrollId: 'p-aug-b', employeeId: 'e1', netSalary: 300,
        baseSalary: 300, allowances: 0, deduction: 0, tax: 0,
      });

      const out = await make().getSummary('6', NOW);
      expect(out.employees.paid).toBe(2); // e1, e2 — not 3
      const aug = out.trend.find((b) => b.key === '2026-08')!;
      expect(aug.employees).toBe(2);
    });
  });

  describe('queues are counted in the database and are not windowed', () => {
    it('counts every open run, not a capped page of them', async () => {
      // 25 open runs — more than the `take: 20` the old KPI read from.
      payrolls = Array.from({ length: 25 }, (_, i) => ({
        id: `open-${i}`,
        month: ((i % 12) + 1),
        year: 2020 + Math.floor(i / 12),
        status: 'DRAFT',
        submittedAt: null,
      }));
      items = [];

      const out = await make().getSummary('6', NOW);
      expect(out.runs.inProgress).toBe(25);
      expect(out.runs.draft).toBe(25);
    });

    it('separates "every run is locked" from "there are no runs at all"', async () => {
      // Both leave inProgress at 0, and only one of them is good news. Without
      // `total` the card said "Every run is locked" over an empty database.
      const locked = await make().getSummary('6', NOW);
      expect(locked.runs.inProgress).toBe(0);
      expect(locked.runs.total).toBe(2);
      expect(locked.runs.locked).toBe(2);

      payrolls = [];
      items = [];
      const none = await make().getSummary('6', NOW);
      expect(none.runs.inProgress).toBe(0);
      expect(none.runs.total).toBe(0);
      expect(none.runs.locked).toBe(0);
    });

    it('splits the pipeline by status and names what is waiting', async () => {
      payrolls = [
        { id: 'a', ...AUG, status: 'PENDING_APPROVAL', submittedAt: new Date('2026-08-01T00:00:00Z') },
        { id: 'b', month: 7, year: 2026, status: 'PENDING_APPROVAL', submittedAt: new Date('2026-07-02T00:00:00Z') },
        { id: 'c', month: 6, year: 2026, status: 'REJECTED', submittedAt: null },
      ];
      items = [];

      const out = await make().getSummary('6', NOW);
      expect(out.runs.pendingApproval).toBe(2);
      expect(out.runs.rejected).toBe(1);
      expect(out.runs.oldestPendingAt).toBe('2026-08-01T00:00:00.000Z');
      expect(out.runs.pending.map((p) => p.label)).toEqual(['Aug 2026', 'Jul 2026']);
      expect(out.runs.rejectedRuns[0].label).toBe('Jun 2026');
    });
  });

  describe('payment readiness', () => {
    it('counts a valid bank record as ready', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.readiness).toMatchObject({
        population: 'run',
        total: 2,
        ready: 2,
        readyRate: 100,
      });
    });

    it('counts a MISSING bank record as not ready, and names the person', async () => {
      readinessEmployees = [employee('e1'), employee('e2', { bankDetails: [] })];

      const out = await make().getSummary('6', NOW);
      expect(out.readiness).toMatchObject({ ready: 1, noBankRecord: 1, readyRate: 50 });
      expect(out.readiness!.names.map((n) => n.id)).toContain('e2');
    });

    it('counts a PRESENT but invalid record as not ready — the case a count of missing records misses', async () => {
      // Real IBAN validation, not a stand-in: both are 23-character Omani
      // IBANs and differ only in the mod-97 check digits, so nothing but the
      // checksum separates the ready one from the broken one.
      countryFields = {
        OM: [{ ...IBAN_FIELD, validationType: 'IBAN' }],
      };
      const bank = { country: 'OM', bankCode: '018', isActive: true };
      readinessEmployees = [
        employee('e1', {
          bankDetails: [{ data: { iban: VALID_OM_IBAN }, bank }],
        }),
        employee('e2', {
          bankDetails: [{ data: { iban: BAD_CHECKSUM_OM_IBAN }, bank }],
        }),
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.readiness!.incompleteFields).toBe(1);
      expect(out.readiness!.ready).toBe(1);
      expect(out.readiness!.names.map((n) => n.id)).toEqual(['e2']);
    });

    it('reports a pending bank change as not ready — the money would go to the old account', async () => {
      readinessEmployees = [
        employee('e1'),
        employee('e2', { bankChangeRequests: [{ id: 'bc1' }] }),
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.readiness).toMatchObject({ pendingChange: 1, ready: 1 });
    });

    it('reports UNKNOWN, never 100%, when the branch has no banking country', async () => {
      readinessEmployees = [
        employee('e1', { branch: { country: null, bankingCountries: [] } }),
        employee('e2', { branch: { country: null, bankingCountries: [] } }),
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.readiness).toMatchObject({ unknown: 2, ready: 0 });
      // Nothing could be judged, so there is no rate — not a fabricated 100.
      expect(out.readiness!.readyRate).toBeNull();
    });

    it('flags a bank in a country the branch cannot pay into', async () => {
      readinessEmployees = [
        employee('e1'),
        employee('e2', {
          bankDetails: [
            { data: { iban: 'IN123' }, bank: { country: 'IN', bankCode: 'HDFC', isActive: true } },
          ],
        }),
      ];

      const out = await make().getSummary('6', NOW);
      expect(out.readiness!.countryNotAllowed).toBe(1);
    });

    it('fetches each country field-set once, not once per employee', async () => {
      readinessEmployees = [employee('e1'), employee('e2'), employee('e3'), employee('e4')];
      await make().getSummary('6', NOW);
      expect(bankingConfig.getFieldsForCountry).toHaveBeenCalledTimes(1);
    });

    it('falls back to the active workforce when the anchor month holds no run', async () => {
      payrolls = [];
      items = [];
      const out = await make().getSummary('6', NOW);
      expect(out.readiness!.population).toBe('active');
    });

    it('is null rather than an empty all-clear when there is nobody to judge', async () => {
      payrolls = [];
      items = [];
      readinessEmployees = [];
      const out = await make().getSummary('6', NOW);
      expect(out.readiness).toBeNull();
    });
  });

  describe('processing coverage', () => {
    it('separates people paid from people merely sitting in an open run', async () => {
      payrolls.push({ id: 'p-aug-open', ...AUG, status: 'DRAFT', submittedAt: null });
      items.push({
        payrollId: 'p-aug-open', employeeId: 'e9', netSalary: 100,
        baseSalary: 100, allowances: 0, deduction: 0, tax: 0,
      });

      const out = await make().getSummary('6', NOW);
      expect(out.employees.paid).toBe(2);
      expect(out.employees.inOpenRun).toBe(1);
      expect(out.employees.active).toBe(4);
      expect(out.employees.notInAnyRun).toBe(2);
    });

    it('does not double-count somebody who is both paid and in an open run', async () => {
      payrolls.push({ id: 'p-aug-open', ...AUG, status: 'DRAFT', submittedAt: null });
      items.push({
        payrollId: 'p-aug-open', employeeId: 'e1', netSalary: 100,
        baseSalary: 100, allowances: 0, deduction: 0, tax: 0,
      });

      const out = await make().getSummary('6', NOW);
      expect(out.employees.paid).toBe(2);
      expect(out.employees.inOpenRun).toBe(0);
    });
  });

  describe('money composition', () => {
    it('reports every earning and deduction column for the locked anchor', async () => {
      const out = await make().getSummary('6', NOW);
      const earn = Object.fromEntries(out.composition.earnings.map((r) => [r.key, r.amount]));
      const ded = Object.fromEntries(out.composition.deductions.map((r) => [r.key, r.amount]));
      expect(earn.baseSalary).toBe(1350);
      expect(earn.allowances).toBe(300);
      expect(ded.deduction).toBe(90);
      expect(ded.tax).toBe(60);
      expect(out.composition.grossReported).toBe(1650);
      expect(out.composition.deductionsTotal).toBe(150);
    });

    it('prints the residual rather than hiding a payslip that does not reconcile', async () => {
      const out = await make().getSummary('6', NOW);
      // 1650 earnings - 150 deductions - 1500 net = 0
      expect(out.composition.residual).toBe(0);
    });

    it('surfaces a non-zero residual when the columns do not add up to what was paid', async () => {
      // net is 100 short of earnings-minus-deductions.
      items = [
        { payrollId: 'p-aug', employeeId: 'e1', netSalary: 900, baseSalary: 900, allowances: 200, deduction: 60, tax: 40 },
        { payrollId: 'p-aug', employeeId: 'e2', netSalary: 500, baseSalary: 450, allowances: 100, deduction: 30, tax: 20 },
      ];
      const out = await make().getSummary('6', NOW);
      expect(out.composition.residual).toBe(100);
    });
  });

  describe('legacy company-wide runs', () => {
    it('counts them deliberately and keeps them out of every scoped figure', async () => {
      legacyRuns = 2;
      const out = await make().getSummary('6', NOW);
      expect(out.unscopedLegacyRuns).toBe(2);
      // The scoped counts are untouched by them.
      expect(out.runs.inProgress).toBe(0);
    });

    it('reports zero when there are none, so the strip stays quiet', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.unscopedLegacyRuns).toBe(0);
    });
  });

  describe('the adjacent summaries it folds in', () => {
    it('carries settlements on the same DRAFT/APPROVED definition the settlements screen uses', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.settlements).toEqual({ draft: 2, awaitingPayment: 1, openPayout: 1200 });
    });

    it('reports wps as null until a wage file has ever been produced', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.wps).toBeNull();
    });

    it('reports the last wage file once one exists', async () => {
      lastWpsFile = {
        generatedAt: new Date('2026-08-02T09:00:00Z'),
        status: 'SUBMITTED',
        fileName: 'wps-aug.csv',
      };
      const out = await make().getSummary('6', NOW);
      expect(out.wps).toEqual({
        lastFileAt: '2026-08-02T09:00:00.000Z',
        lastFileStatus: 'SUBMITTED',
        lastFileName: 'wps-aug.csv',
        rejected: 3,
      });
    });

    it('carries the outstanding carry-forward balance count', async () => {
      const out = await make().getSummary('6', NOW);
      expect(out.carryForward.outstanding).toBe(1);
    });
  });
});
