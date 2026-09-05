process.env.LOAN_IMPORT_SIGNING_SECRET ??= 'loan-import-unit-test-secret';

import {
  LoanImportService,
  validateImportRow,
  signRow,
  verifyRowSignature,
  type ImportRowContext,
  type RawImportRow,
} from './loan-import.service';
import { LoanScheduleService } from './loan-schedule.service';

/**
 * Unit tests for the row rulebook that `preview` and `confirm` now SHARE.
 *
 * The reason this file exists at all: the rules used to be inline in `preview`,
 * so `confirm` — the endpoint that creates loans — validated nothing. Every
 * case below is a row shape `confirm` will now refuse, and every message is one
 * an operator (or an e2e spec) reads verbatim.
 */

/** A row that passes everything, so each test can break exactly one thing. */
const GOOD: RawImportRow = {
  employeeCode: 'EMP002',
  referenceNo: 'LN-UNIT-0001',
  type: 'LOAN',
  principal: 1200,
  interestMethod: 'NONE',
  interestRate: 0,
  installments: 12,
  emi: null,
  disbursedOn: '2026-01-15',
  firstDeductionPeriod: '2026-02',
  installmentsPaid: 0,
  amountRepaid: 0,
  status: 'ACTIVE',
  notes: 'unit',
};

const ctx = (over: Partial<ImportRowContext> = {}): ImportRowContext => ({
  employee: { startDate: new Date('2020-01-01T00:00:00.000Z') },
  maxInstallments: 12,
  interestEnabled: false,
  refsInDb: new Set<string>(),
  refsSeen: new Set<string>(),
  // Pinned: "Disbursed On cannot be in the future" is otherwise a test that
  // starts failing on its own one day.
  now: new Date('2026-06-01T00:00:00.000Z'),
  ...over,
});

const run = (over: Partial<RawImportRow> = {}, c: Partial<ImportRowContext> = {}) =>
  validateImportRow({ ...GOOD, ...over }, ctx(c));

describe('validateImportRow — the rulebook preview and confirm share', () => {
  it('accepts a clean row and hands back the schedule it approved', () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.schedule).toBeDefined();
    expect(r.schedule!.rows).toHaveLength(12);
    expect(r.derived!.emi).toBe(100);
  });

  it('normalizes a JSON row and a spreadsheet row to the same thing', () => {
    // The whole point of the shared validator: `1200` off a cell and `'1200'`
    // off a JSON body must not be able to diverge.
    const fromJson = run({ principal: 1200, installments: 12 });
    const fromSheet = run({ principal: '1200', installments: '12', type: ' loan ' });
    expect(fromSheet.errors).toEqual([]);
    expect(fromSheet.data).toEqual(fromJson.data);
    expect(signRow(fromSheet.data)).toBe(signRow(fromJson.data));
  });

  it('collapses an ADVANCE to a single instalment however many the row claims', () => {
    const r = run({ type: 'ADVANCE', installments: 9 });
    expect(r.errors).toEqual([]);
    expect(r.data.installments).toBe(1);
  });

  // ── who the loan belongs to ─────────────────────────────────────────────
  describe('the employee', () => {
    it('refuses a blank code', () => {
      expect(run({ employeeCode: '' }, { employee: null }).errors).toContain(
        'Employee Code is required',
      );
    });

    it('refuses a code that resolved to nobody — the §2 MGR001 mutation', () => {
      expect(run({ employeeCode: 'MGR001' }, { employee: null }).errors).toContain(
        'No employee with code MGR001',
      );
    });
  });

  // ── the reference number ────────────────────────────────────────────────
  describe('the reference number', () => {
    it('refuses a blank, a malformed and an already-used reference', () => {
      expect(run({ referenceNo: '' }).errors).toContain('Loan Reference No is required');
      expect(run({ referenceNo: 'no spaces here' }).errors).toContain(
        'Loan Reference No must be 3-40 chars of letters, digits, / _ or -',
      );
      expect(
        run({}, { refsInDb: new Set(['LN-UNIT-0001']) }).errors,
      ).toContain('Loan Reference No LN-UNIT-0001 already exists');
    });

    it('refuses the second use of a reference inside one batch', () => {
      const shared = ctx();
      const first = validateImportRow({ ...GOOD }, shared);
      const second = validateImportRow({ ...GOOD }, shared);
      expect(first.errors).toEqual([]);
      expect(second.errors).toContain(
        'Loan Reference No LN-UNIT-0001 is duplicated in this file',
      );
    });
  });

  // ── the money ───────────────────────────────────────────────────────────
  describe('the money', () => {
    it('refuses a zero, a negative and an implausible principal', () => {
      expect(run({ principal: 0 }).errors).toContain('Principal Amount must be greater than 0');
      expect(run({ principal: -500 }).errors).toContain(
        'Principal Amount must be greater than 0',
      );
      expect(run({ principal: 1e12 }).errors).toContain('Principal Amount is implausibly large');
    });

    it('refuses a third decimal rather than rounding it away (§24)', () => {
      expect(run({ principal: 1000.125 }).errors).toContain(
        'Principal Amount cannot have more than 2 decimal places',
      );
      expect(run({ principal: 1000.12 }).errors).toEqual([]);
      // Trailing zeros are not decimals anyone typed.
      expect(run({ principal: '1000.100' }).errors).toEqual([]);
    });

    it('refuses more repaid than borrowed, and a third decimal on it', () => {
      expect(run({ amountRepaid: 5000 }).errors).toContain(
        'Amount Already Repaid exceeds the principal',
      );
      expect(run({ amountRepaid: -1 }).errors).toContain(
        'Amount Already Repaid must be 0 or more',
      );
      expect(run({ amountRepaid: 100.125 }).errors).toContain(
        'Amount Already Repaid cannot have more than 2 decimal places',
      );
    });

    it('checks a supplied EMI against the derived one instead of trusting it', () => {
      expect(run({ emi: 999 }).errors).toContain(
        'EMI Amount 999 does not match the derived instalment of 100 for these terms',
      );
      expect(run({ emi: 100 }).errors).toEqual([]);
    });
  });

  // ── interest, and the kill-switch (§11) ─────────────────────────────────
  describe('interest', () => {
    it('refuses an unknown method and an out-of-range rate', () => {
      expect(run({ interestMethod: 'COMPOUND' }).errors).toContain(
        'Interest Method must be NONE, FLAT or REDUCING_BALANCE',
      );
      expect(
        run({ interestMethod: 'FLAT', interestRate: 101 }, { interestEnabled: true }).errors,
      ).toContain('Annual Interest Rate must be between 0 and 100');
    });

    it('refuses a rate with no method to apply it', () => {
      expect(run({ interestRate: 5 }).errors).toContain(
        'An interest rate was given but the method is NONE',
      );
    });

    it('refuses an interest-bearing row while loan_interest_enabled is off', () => {
      for (const method of ['FLAT', 'REDUCING_BALANCE']) {
        expect(run({ interestMethod: method, interestRate: 12 }).errors).toContain(
          `Interest is switched off in this system, so a loan with Interest Method ${method} cannot be imported. Turn on loan_interest_enabled or set the method to NONE.`,
        );
      }
    });

    it('refuses a zero-rate FLAT too, because the RECORD would still say FLAT', () => {
      // The engine downgrades a zero rate to NONE, but `interestMethod` is
      // persisted verbatim and every reader keys off it.
      expect(run({ interestMethod: 'FLAT', interestRate: 0 }).errors).toHaveLength(1);
    });

    it('accepts the same row once interest is switched on', () => {
      const r = run(
        { interestMethod: 'REDUCING_BALANCE', interestRate: 12 },
        { interestEnabled: true },
      );
      expect(r.errors).toEqual([]);
      expect(r.derived!.totalInterest).toBeGreaterThan(0);
    });

    it('never refuses a NONE row for the kill-switch', () => {
      expect(run({}, { interestEnabled: false }).errors).toEqual([]);
    });
  });

  // ── the repayment period ────────────────────────────────────────────────
  describe('the instalments', () => {
    it('refuses a missing, zero or fractional instalment count', () => {
      const msg = 'Total Installments must be a whole number of at least 1';
      expect(run({ installments: '' }).errors).toContain(msg);
      expect(run({ installments: 0 }).errors).toContain(msg);
      expect(run({ installments: 1.5 }).errors).toContain(msg);
    });

    it('WARNS above the configured maximum and does not refuse — history is not capped', () => {
      const r = run({ installments: 240 });
      expect(r.errors).toEqual([]);
      expect(r.warnings).toContain('Installments (240) exceed the configured maximum of 12');
    });

    it('refuses more instalments paid than exist', () => {
      expect(run({ installments: 6, installmentsPaid: 9 }).errors).toContain(
        'Installments Already Paid exceeds Total Installments',
      );
      expect(run({ installmentsPaid: -1 }).errors).toContain(
        'Installments Already Paid must be 0 or more',
      );
    });
  });

  // ── the dates (§24) ─────────────────────────────────────────────────────
  describe('the dates', () => {
    it('refuses a misshapen date', () => {
      expect(run({ disbursedOn: '15-01-2026' }).errors).toContain(
        'Disbursed On must be YYYY-MM-DD',
      );
    });

    it('refuses an impossible date instead of rolling it into March', () => {
      // `new Date('2025-02-31')` is 3 March 2025, so the old shape-only check
      // let the row through AND moved the disbursement three days.
      const r = run({ disbursedOn: '2025-02-31', firstDeductionPeriod: '2025-03' });
      expect(r.errors).toContain('Disbursed On is not a real calendar date');
    });

    it('refuses a future disbursement even when the employee code did not resolve', () => {
      const r = run(
        { employeeCode: 'NOPE', disbursedOn: '2026-09-01', firstDeductionPeriod: '2026-10' },
        { employee: null },
      );
      expect(r.errors).toContain('Disbursed On cannot be in the future');
      expect(r.errors).toContain('No employee with code NOPE');
    });

    it('refuses a disbursement before the employee joined', () => {
      const r = run(
        { disbursedOn: '2019-06-01', firstDeductionPeriod: '2019-07' },
        { employee: { startDate: new Date('2020-01-01T00:00:00.000Z') } },
      );
      expect(r.errors).toContain('Disbursed On is before the employee joined');
    });

    it('refuses a misshapen and an impossible first deduction month', () => {
      expect(run({ firstDeductionPeriod: '2026/02' }).errors).toContain(
        'First Deduction Month must be YYYY-MM',
      );
      expect(run({ firstDeductionPeriod: '2026-13' }).errors).toContain(
        'First Deduction Month is not a real calendar month',
      );
    });

    it('refuses a first deduction that falls due before the money went out', () => {
      expect(run({ firstDeductionPeriod: '2025-01' }).errors).toContain(
        'First Deduction Month is before Disbursed On',
      );
    });

    it('allows a first deduction in the SAME month as the disbursement', () => {
      expect(run({ firstDeductionPeriod: '2026-01' }).errors).toEqual([]);
    });
  });

  // ── status ──────────────────────────────────────────────────────────────
  it('refuses a status outside ACTIVE / CLOSED / ON_HOLD', () => {
    expect(run({ status: 'FROZEN' }).errors).toContain(
      'Status must be ACTIVE, CLOSED or ON_HOLD',
    );
    for (const status of ['ACTIVE', 'CLOSED', 'ON_HOLD']) {
      expect(run({ status }).errors).toEqual([]);
    }
  });

  it('refuses a type outside ADVANCE / LOAN', () => {
    expect(run({ type: 'GIFT' }).errors).toContain('Type must be ADVANCE or LOAN');
  });

  // ── the mid-life reconciliation warning ─────────────────────────────────
  it('warns, rather than refuses, when the repaid figure and the consumed instalments disagree', () => {
    const r = run({ installmentsPaid: 3, amountRepaid: 500 });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('will be booked as an import adjustment');
  });
});

describe('the preview signature — binding a confirm to the preview that produced it', () => {
  it('verifies a row that came back untouched', () => {
    const { data } = run();
    expect(verifyRowSignature(data, signRow(data))).toBe(true);
  });

  it('refuses the §2 in-range mutation, which re-validation alone cannot catch', () => {
    // 1,200 over 12 becomes 750,000 over 240. Both are figures an operator
    // could legitimately have in a sheet — no rule refuses the second — so the
    // ONLY thing that can tell them apart is the signature.
    const previewed = run().data;
    const signature = signRow(previewed);

    const mutated = run({ principal: 750000, installments: 240 });
    expect(mutated.errors).toEqual([]); // re-validation is happy
    expect(verifyRowSignature(mutated.data, signature)).toBe(false);
  });

  it('refuses an employee swapped after the preview', () => {
    const signature = signRow(run().data);
    const swapped = run({ employeeCode: 'MGR001' }).data;
    expect(verifyRowSignature(swapped, signature)).toBe(false);
  });

  it('refuses a missing, empty or garbage signature', () => {
    const { data } = run();
    expect(verifyRowSignature(data, undefined)).toBe(false);
    expect(verifyRowSignature(data, '')).toBe(false);
    expect(verifyRowSignature(data, 'v1.not-a-signature')).toBe(false);
  });

  it('survives a JSON round-trip, which is how the modal returns the row', () => {
    const { data } = run();
    const signature = signRow(data);
    const roundTripped = JSON.parse(JSON.stringify({ ...data, signature }));
    expect(verifyRowSignature(roundTripped, roundTripped.signature)).toBe(true);
  });

  it('ignores `signature` itself when signing, so a signed row can be re-signed', () => {
    const { data } = run();
    const signature = signRow(data);
    expect(signRow({ ...data, signature })).toBe(signature);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `outstandingInterest` on an imported loan
//
// The column was REDEFINED by the §1 fix: it is employee-borne interest
// ACCRUED AND UNPAID (live rows whose dueDate has passed), not the loan's
// remaining lifetime interest. The importer wrote the old lifetime figure, and
// `loan-settlement.service.ts` reads the column directly — so an imported loan
// settled against interest nobody had earned yet. These two cases pin the new
// meaning at the point the importer writes it.
// ───────────────────────────────────────────────────────────────────────────

interface StoredSchedule {
  requestId: string;
  version: number;
  installmentNo: number;
  dueDate: Date;
  dueMonth: number;
  dueYear: number;
  status: string;
  interestComponent: number;
  employerSubsidyComponent: number;
  paidInterest: number;
  [k: string]: unknown;
}

/**
 * Enough Prisma to run one `confirm` transaction in memory.
 *
 * `loanSchedule.findMany` implements the two shapes the code under test uses:
 * the deduction backfill's `{ requestId, version }` + take, and
 * `accruedUnpaidInterest`'s `{ dueDate: { lte }, status: { in } }`.
 */
function fakePrisma(employee: { id: string; employeeCode: string; fullName: string; startDate: Date }) {
  const loans: Record<string, Record<string, unknown>> = {};
  const schedules: StoredSchedule[] = [];
  const deductions: unknown[] = [];
  let seq = 0;

  const client: any = {
    employee: { findMany: async () => [employee] },
    advanceLoanRequest: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        const id = `loan-${++seq}`;
        loans[id] = { id, ...data };
        return loans[id];
      },
      update: async ({ where, data }: any) => {
        Object.assign(loans[where.id], data);
        return loans[where.id];
      },
    },
    loanSchedule: {
      createMany: async ({ data }: any) => {
        for (const r of data) schedules.push({ ...r, dueDate: new Date(r.dueDate) });
        return { count: data.length };
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let out = schedules.filter(
          (r) => r.requestId === where.requestId && r.version === where.version,
        );
        if (where.dueDate?.lte) out = out.filter((r) => r.dueDate <= where.dueDate.lte);
        if (where.status?.in) out = out.filter((r) => where.status.in.includes(r.status));
        if (orderBy) out = [...out].sort((a, b) => a.installmentNo - b.installmentNo);
        return take ? out.slice(0, take) : out;
      },
    },
    advanceLoanDeduction: { createMany: async ({ data }: any) => { deductions.push(...data); return { count: data.length }; } },
    loanTransaction: { create: async () => ({}) },
    $transaction: async (fn: any) => fn(client),
  };
  return { client, loans, schedules, deductions };
}

/** Runs one row through the real `confirm`, with the real schedule service. */
async function importOne(row: RawImportRow, opts: { interestEnabled?: boolean } = {}) {
  const employee = {
    id: 'emp-1',
    employeeCode: 'EMP002',
    fullName: 'Imported Employee',
    startDate: new Date('2020-01-01T00:00:00.000Z'),
  };
  const fake = fakePrisma(employee);
  const settings: any = {
    getSetting: async (key: string, fallback: string) =>
      key === 'loan_interest_enabled'
        ? String(opts.interestEnabled ?? true)
        : fallback,
  };
  // The real service, so the meaning of `outstandingInterest` is the one the
  // contract defines rather than a second copy written for the test.
  const schedules = new LoanScheduleService(fake.client, settings, {} as any);
  const svc = new LoanImportService(fake.client, settings, schedules);

  const res: any = await svc.confirm([row], { id: 'admin-1' });
  const loan = Object.values(fake.loans)[0] as Record<string, any>;
  return { res, loan, schedules: fake.schedules, deductions: fake.deductions };
}

describe('confirm writes ACCRUED-AND-UNPAID interest, not the lifetime total', () => {
  const MIDLIFE: RawImportRow = {
    employeeCode: 'EMP002',
    referenceNo: 'LN-ACCRUAL-1',
    type: 'LOAN',
    principal: 1200,
    interestMethod: 'FLAT',
    interestRate: 12,
    installments: 12,
    emi: null,
    disbursedOn: '2024-06-01',
    firstDeductionPeriod: '2024-07',
    installmentsPaid: 3,
    amountRepaid: 0,
    status: 'ACTIVE',
    notes: 'accrual case',
  };

  afterEach(() => jest.useRealTimers());

  it('a loan whose first deduction is still ahead has accrued NOTHING', async () => {
    // FLAT 12% on 1,200 over 12 is 144 of lifetime interest. The old write
    // (`totalInterest - consumedInterest`) would have parked all 144 in the
    // column on a loan where not one instalment has fallen due.
    jest.useFakeTimers({ now: new Date('2026-01-15T00:00:00.000Z') });
    const { res, loan } = await importOne({
      ...MIDLIFE,
      disbursedOn: '2026-01-10',
      firstDeductionPeriod: '2026-02',
      installmentsPaid: 0,
    });

    expect(res.results[0].success).toBe(true);
    expect(Number(loan.outstandingInterest)).toBe(0);
    // The lifetime figure still exists — under its own name, for reporting.
    expect(Number(loan.interestAccrued)).toBe(144);
    expect(Number(loan.interestPaid)).toBe(0);
  });

  it('a mid-life loan carries only the interest genuinely accrued and unpaid', async () => {
    // As of 15 Jan 2025 instalments 1-6 have fallen due (31 Jul 2024 .. 31 Dec
    // 2024) and 7-12 have not. Rows 1-3 were backfilled PAID, so what is owed
    // is rows 4, 5 and 6: three months of FLAT interest at 12 each.
    jest.useFakeTimers({ now: new Date('2025-01-15T00:00:00.000Z') });
    const { res, loan, schedules, deductions } = await importOne(MIDLIFE);

    expect(res.results[0].success).toBe(true);
    expect(Number(loan.outstandingInterest)).toBe(36);

    // Not merely "some smaller number": the OLD lifetime write for this very
    // row would have been 144 - 36 = 108, so the fix is visible, and it is not
    // the degenerate zero the future-dated case returns either.
    expect(Number(loan.interestAccrued) - Number(loan.interestPaid)).toBe(108);
    expect(Number(loan.outstandingInterest)).toBeLessThan(108);

    // The mid-life backfill is untouched by the change: three PAID rows, three
    // ledger entries, and the interest they carried booked as collected.
    expect(schedules.filter((r) => r.status === 'PAID')).toHaveLength(3);
    expect(deductions).toHaveLength(3);
    expect(Number(loan.interestPaid)).toBe(36);
  });

  it('an interest-free import writes 0 whatever has fallen due', async () => {
    jest.useFakeTimers({ now: new Date('2025-01-15T00:00:00.000Z') });
    const { res, loan } = await importOne(
      { ...MIDLIFE, referenceNo: 'LN-ACCRUAL-2', interestMethod: 'NONE', interestRate: 0 },
      { interestEnabled: false },
    );

    expect(res.results[0].success).toBe(true);
    expect(Number(loan.outstandingInterest)).toBe(0);
    expect(Number(loan.interestAccrued)).toBe(0);
  });
});
