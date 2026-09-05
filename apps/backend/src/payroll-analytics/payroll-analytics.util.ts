import { money } from '../common/analytics/analytics.util';

/**
 * The pure half of the payroll analytics endpoint.
 *
 * Split out so the arithmetic that decides what a funnel and a bridge SAY can
 * be tested without a database behind it. Nothing here touches Prisma.
 */

/** The lifecycle the analytics page speaks, mirroring `types/payrollDashboard.ts`. */
export const RUN_STATUS = ['DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

/** How many names a capped sample carries before `count` has to speak for it. */
export const ATTENTION_NAME_CAP = 5;

/**
 * This repo's `PayrollStatus` in the analytics page's vocabulary.
 *
 * The two enums describe the same journey with different words:
 *
 * | stored             | reported    | why |
 * | ------------------ | ----------- | --- |
 * | `DRAFT`            | `DRAFT`     | same thing |
 * | `PENDING_APPROVAL` | `CALCULATED`| the figures exist and are waiting on a human |
 * | `APPROVED`         | `APPROVED`  | same thing |
 * | `LOCKED`           | `PAID`      | locking is what makes a run final here |
 * | `REJECTED`         | `CANCELLED` | sent back; not a stage anything reached |
 *
 * An unknown value maps to `DRAFT` rather than throwing: a status added to the
 * enum later should not take the whole dashboard down with it.
 */
export const toRunStatus = (stored: string): RunStatus => {
  switch (stored) {
    case 'PENDING_APPROVAL':
      return 'CALCULATED';
    case 'LOCKED':
      return 'PAID';
    case 'REJECTED':
      return 'CANCELLED';
    case 'APPROVED':
      return 'APPROVED';
    default:
      return 'DRAFT';
  }
};

export const emptyStatusCounts = (): Record<RunStatus, number> => ({
  DRAFT: 0,
  CALCULATED: 0,
  APPROVED: 0,
  PAID: 0,
  CANCELLED: 0,
});

/**
 * Gross for one payslip.
 *
 * The same expression `payrolls.service.ts` persists from, so the panel and the
 * payslip cannot drift: base plus every earning, less the in-period deduction
 * column, before statutory insurance and tax come off.
 */
export const grossOf = (item: Record<string, unknown>): number =>
  money(item.baseSalary) +
  money(item.allowances) +
  money(item.bonus) -
  money(item.deduction) +
  money(item.overtimePay) +
  money(item.foodAllowance) +
  money(item.siteAllowance);

interface RunTimestamps {
  status: string;
  submittedAt: Date | null;
  approvedAt: Date | null;
  lockedAt: Date | null;
}

/**
 * How far each run actually got, read from its TIMESTAMPS rather than its
 * current status.
 *
 * This is what makes it a funnel. Counting the status a run sits in right now
 * gives a shape that goes up and down — a run sent back for correction is in
 * `DRAFT` today but genuinely was computed and approved once, and its
 * `submittedAt` and `approvedAt` still say so. Reading the stamps makes the
 * series monotonically decreasing by construction.
 *
 * Cancelled runs are in no stage at all: they are excluded outright rather than
 * counted in `DRAFT`, because "reached draft" is a claim about progress and a
 * rejected run has made none.
 */
export const buildFunnel = (runs: RunTimestamps[]) => {
  const live = runs.filter((r) => r.status !== 'REJECTED');
  return [
    { stage: 'DRAFT' as const, label: 'Drafted', reached: live.length },
    {
      stage: 'CALCULATED' as const,
      label: 'Computed',
      reached: live.filter((r) => r.submittedAt || r.approvedAt || r.lockedAt).length,
    },
    {
      stage: 'APPROVED' as const,
      label: 'Validated',
      reached: live.filter((r) => r.approvedAt || r.lockedAt).length,
    },
    {
      stage: 'PAID' as const,
      label: 'Paid',
      reached: live.filter((r) => r.lockedAt).length,
    },
  ];
};

/**
 * Gross → net, as a waterfall.
 *
 * `netFloorResidual` is the part worth understanding. Every payslip floors its
 * own net at zero (`Math.max(0, gross - insurance - tax)`), so across a run
 * `Σnet ≥ Σgross − Σdeductions`. The difference is real money the floor added
 * back, and it gets its own step: a bridge whose bars do not reach its final
 * column is the one thing a bridge cannot get wrong. It is zero in the ordinary
 * case, and non-zero exactly when somebody's deductions exceeded their pay.
 */
export const buildBridge = (totals: { gross: number; deductions: number; net: number }) => {
  const residual = Number((totals.net - (totals.gross - totals.deductions)).toFixed(2));

  const steps: Array<{
    key: string;
    label: string;
    amount: number;
    kind: 'total' | 'add' | 'subtract';
  }> = [
    { key: 'GROSS', label: 'Gross', amount: totals.gross, kind: 'total' },
    { key: 'DEDUCTIONS', label: 'Deductions', amount: totals.deductions, kind: 'subtract' },
  ];

  if (residual !== 0) {
    steps.push({
      key: 'NET_FLOOR',
      label: 'Net floored at zero',
      amount: Math.abs(residual),
      kind: residual > 0 ? 'add' : 'subtract',
    });
  }

  steps.push({ key: 'NET', label: 'Net', amount: totals.net, kind: 'total' });

  return {
    steps,
    gross: totals.gross,
    deductions: totals.deductions,
    net: totals.net,
    netFloorResidual: residual,
  };
};
