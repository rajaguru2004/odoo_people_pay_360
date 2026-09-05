/**
 * The Muscat payroll demo's remaining fixtures.
 *
 * Government identifiers for the wage-file warnings, and an itemisation
 * backfill so an installation that switches on itemised payslips does not find
 * every existing payslip empty while the flag says the feature is live.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  buildItemLines,
  type BuildLinesInput,
  type ComponentInput,
  type FigureInput,
  type LineBucket,
} from '../payrolls/payroll-item-lines.util';

export type PrismaLike = PrismaClient;

export interface MuscatPayrollOptions {
  /** Defaults to the sample dataset's Oman branch. */
  branchCode?: string;
  /** Calendar year to lay out pay periods for. Defaults to the current year. */
  year?: number;
  say?: (message: string) => void;
  info?: (message: string) => void;
}

/** Reference prefix for the rows this module creates and re-finds. */
const TAG = 'MCT-DEMO';

const dU = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));
const n2 = (n: number) => Math.round(n * 100) / 100;

interface Emp {
  id: string;
  employeeCode: string;
  fullName: string;
  baseSalary: Prisma.Decimal | null;
  startDate: Date | null;
  departmentId: string | null;
}

/**
 * The om-cbo format declares LABOUR_CARD and CIVIL_ID as WARNING-severity
 * identifiers. They do not block the file, but with neither on file every
 * employee raised two warnings and the demo had to be talked past them.
 * `Employee.idCard` cannot stand in — onboarding sets it to the employee code,
 * so it is an internal code, not a government number.
 */
async function seedIdentifiers(
  prisma: PrismaLike,
  emps: Emp[],
  createdById: string | null,
): Promise<number> {
  let created = 0;
  for (const e of emps) {
    const suffix = e.employeeCode.replace(/\D/g, '').slice(-3).padStart(3, '0');
    const series = e.employeeCode.startsWith('NX') ? '1' : '2';
    const wanted = [
      {
        category: 'LABOUR_CARD' as const,
        documentNumber: `OMLC${series}${suffix}`,
        documentType: 'Labour Card',
        issuingAuthority: 'Ministry of Labour',
        issueDate: dU(2025, 1, 15),
        // Far past any demo payment date: an expired identifier is its own
        // finding, and this is not the place to demonstrate that one.
        expiryDate: dU(2029, 1, 14),
      },
      {
        category: 'CIVIL_ID' as const,
        documentNumber: `${series}${suffix}${series}${suffix}`.slice(0, 8),
        documentType: 'Civil ID',
        issuingAuthority: 'Royal Oman Police — Civil Status',
        issueDate: dU(2024, 6, 1),
        expiryDate: dU(2029, 5, 31),
      },
    ];

    for (const w of wanted) {
      const exists = await prisma.employeeLegalDocument.findFirst({
        where: { employeeId: e.id, category: w.category, isCurrent: true },
      });
      if (exists) continue;
      await prisma.employeeLegalDocument.create({
        data: {
          employeeId: e.id,
          category: w.category,
          documentNumber: w.documentNumber,
          documentType: w.documentType,
          country: 'Oman',
          nationality: 'OM',
          issueDate: w.issueDate,
          expiryDate: w.expiryDate,
          issuingAuthority: w.issuingAuthority,
          placeOfIssue: 'Muscat',
          status: 'ACTIVE',
          isCurrent: true,
          createdById,
          remarks: TAG,
        },
      });
      created += 1;
    }
  }
  return created;
}

/** Which PayrollItem column becomes which line, and what a payslip calls it. */
const FIGURE_LINES: {
  bucket: LineBucket;
  column: string;
  code: string;
  label: string;
  sourceType: FigureInput['sourceType'];
}[] = [
  { bucket: 'bonus', column: 'bonus', code: 'BONUS', label: 'Bonus', sourceType: 'REWARD' },
  { bucket: 'overtimePay', column: 'overtimePay', code: 'OVERTIME', label: 'Overtime', sourceType: 'OVERTIME' },
  { bucket: 'foodAllowance', column: 'foodAllowance', code: 'FOOD_ALLOWANCE', label: 'Food Allowance', sourceType: 'OVERTIME' },
  { bucket: 'siteAllowance', column: 'siteAllowance', code: 'SITE_ALLOWANCE', label: 'Site Allowance', sourceType: 'SALARY_COMPONENT' },
  { bucket: 'deduction', column: 'deduction', code: 'DEDUCTION', label: 'Deduction', sourceType: 'MANUAL' },
  { bucket: 'insurance', column: 'insurance', code: 'SPF', label: 'Social Protection Fund', sourceType: 'STATUTORY' },
  { bucket: 'tax', column: 'tax', code: 'TAX', label: 'Tax', sourceType: 'STATUTORY' },
];

/**
 * Backfill the itemisation for payslips generated before
 * `payroll_item_lines_enabled` was switched on — without it the breakdown on
 * every existing payslip is empty while the flag says the feature is live.
 *
 * Safe on a LOCKED run precisely because lines are additive: the columns stay
 * authoritative, `buildItemLines` reconciles the lines to them and absorbs the
 * rounding residual. No money moves.
 */
async function backfillItemLines(
  prisma: PrismaLike,
  branchId: string,
): Promise<{ items: number; lines: number }> {
  const payrolls = await prisma.payroll.findMany({
    where: { branchId },
    select: { id: true },
  });

  let items = 0;
  let lines = 0;
  for (const p of payrolls) {
    const rows = await prisma.payrollItem.findMany({ where: { payrollId: p.id } });
    for (const item of rows) {
      const already = await prisma.payrollItemLine.count({ where: { payrollItemId: item.id } });
      if (already > 0) continue;

      const components = await prisma.salaryComponent.findMany({
        where: { employeeId: item.employeeId, isActive: true },
      });
      const baseColumn = Number(item.baseSalary ?? 0);
      const allowanceColumn = Number(item.allowances ?? 0);

      // Scale the contracted components onto the stored columns. The columns are
      // what was paid; the components are the shape of it. Scaling keeps the
      // proportions the employee's structure actually has rather than inventing
      // one unnamed "Basic" line for the whole amount.
      const scale = (
        list: typeof components,
        target: number,
        bucket: ComponentInput['bucket'],
      ): ComponentInput[] => {
        if (target <= 0) return [];
        const sum = list.reduce((a, c) => a + Number(c.amount), 0);
        if (list.length === 0 || sum <= 0) {
          return bucket === 'baseSalary'
            ? [{ code: 'BASIC', label: 'Basic', amount: target, bucket }]
            : [{ code: 'ALLOWANCE', label: 'Allowance', amount: target, bucket }];
        }
        const factor = target / sum;
        return list.map((c) => ({
          code: c.componentType,
          amount: Number(c.amount) * factor,
          bucket,
          sourceId: c.id,
        }));
      };

      const input: BuildLinesInput = {
        components: [
          ...scale(components.filter((c) => c.componentType === 'BASIC'), baseColumn, 'baseSalary'),
          ...scale(components.filter((c) => c.componentType !== 'BASIC'), allowanceColumn, 'allowances'),
        ],
        figures: {},
        totals: { baseSalary: baseColumn, allowances: allowanceColumn },
      };
      for (const f of FIGURE_LINES) {
        const amount = Number((item as unknown as Record<string, unknown>)[f.column] ?? 0);
        if (amount <= 0) continue;
        input.figures[f.bucket] = [
          { code: f.code, label: f.label, amount, sourceType: f.sourceType },
        ];
        input.totals[f.bucket] = amount;
      }

      const built = buildItemLines(input);
      if (built.length === 0) continue;
      await prisma.payrollItemLine.createMany({
        data: built.map((l) => ({
          payrollItemId: item.id,
          code: l.code,
          label: l.label,
          category: l.category,
          bucket: l.bucket,
          amount: dec(l.amount),
          sourceType: l.sourceType,
          sourceId: l.sourceId ?? null,
          displayOrder: l.displayOrder,
        })),
      });
      items += 1;
      lines += built.length;
    }
  }
  return { items, lines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function seedMuscatPayrollDemo(
  prisma: PrismaLike,
  opts: MuscatPayrollOptions = {},
): Promise<Record<string, number>> {
  const branchCode = opts.branchCode ?? 'SMP-MCT';
  const say = opts.say ?? (() => {});
  const info = opts.info ?? (() => {});

  const branch = await prisma.branch.findUnique({ where: { code: branchCode } });
  if (!branch) {
    info(`Muscat payroll demo skipped — branch ${branchCode} does not exist.`);
    return {};
  }

  say('Completing the Muscat payroll story (identifiers, payslip itemisation)…');

  const emps: Emp[] = await prisma.employee.findMany({
    where: { branchId: branch.id },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      baseSalary: true,
      startDate: true,
      departmentId: true,
    },
    orderBy: { employeeCode: 'asc' },
  });
  if (emps.length === 0) {
    info(`Muscat payroll demo skipped — no employees in ${branchCode}.`);
    return {};
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' as never },
    select: { id: true },
  });
  const actorId = admin?.id ?? null;

  const identifiers = await seedIdentifiers(prisma, emps, actorId);
  const payslipLines = await backfillItemLines(prisma, branch.id);

  return {
    identifiers,
    payslipItemsItemised: payslipLines.items,
    payslipLines: payslipLines.lines,
  };
}
