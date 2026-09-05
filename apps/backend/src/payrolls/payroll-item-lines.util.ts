/**
 * Turning a payslip's twelve totals into the lines behind them.
 *
 * The totals stay authoritative. `PayrollItem`'s columns are what the employee
 * is paid, what the wage file carries and what every existing report reads;
 * lines are an additive explanation of them and are never summed to produce
 * money. That ordering is the whole reason this can ship on a live payroll.
 *
 * Pure: no Prisma, no Nest, no settings. Layer 0.
 */

/**
 * Which authoritative column a line rolls into.
 *
 * The reconciliation invariant is per-bucket, not per-category, and that is the
 * reason this field exists at all. The twelve columns are not "earnings and
 * deductions": `deduction`, `insurance` and `tax` are three separate deduction
 * columns computed by three different rules. Grouping only by category would
 * let a PF line reconcile against a garnishment and the invariant would pass
 * while the payslip lied.
 */
export type LineBucket =
  | 'baseSalary'
  | 'allowances'
  | 'bonus'
  | 'overtimePay'
  | 'foodAllowance'
  | 'siteAllowance'
  | 'leaveEncashment'
  | 'deduction'
  | 'garnishment'
  | 'otherRecovery'
  | 'insurance'
  | 'tax';

export type LineCategory = 'EARNING' | 'DEDUCTION';

/**
 * Every bucket, and the side of the payslip it belongs on.
 *
 * The mapping is fixed rather than supplied per line: a caller that could
 * declare PF an EARNING is a caller that can invert a payslip's arithmetic.
 */
export const BUCKET_CATEGORY: Readonly<Record<LineBucket, LineCategory>> = {
  baseSalary: 'EARNING',
  allowances: 'EARNING',
  bonus: 'EARNING',
  overtimePay: 'EARNING',
  foodAllowance: 'EARNING',
  siteAllowance: 'EARNING',
  leaveEncashment: 'EARNING',
  deduction: 'DEDUCTION',
  garnishment: 'DEDUCTION',
  otherRecovery: 'DEDUCTION',
  insurance: 'DEDUCTION',
  tax: 'DEDUCTION',
};

export const LINE_BUCKETS = Object.keys(BUCKET_CATEGORY) as LineBucket[];

export type LineSourceType =
  | 'SALARY_COMPONENT'
  | 'OVERTIME'
  | 'REWARD'
  | 'DISCIPLINE'
  | 'GARNISHMENT'
  | 'RECOVERY'
  | 'ENCASHMENT'
  | 'LOP'
  | 'STATUTORY'
  | 'CARRY_FORWARD'
  | 'MANUAL';

export interface LineSpec {
  code: string;
  /**
   * The human label, snapshotted at generation.
   *
   * Stored rather than derived so renaming a library item cannot rewrite what a
   * payslip issued two years ago says it paid.
   */
  label: string;
  category: LineCategory;
  bucket: LineBucket;
  /** ALWAYS POSITIVE. The sign lives in `category`. */
  amount: number;
  sourceType: LineSourceType;
  sourceId?: string | null;
  displayOrder: number;
}

/** Two decimal places, half-up, matching the engine's `roundMoney`. */
export const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A component as the builder needs it: already prorated, not yet rounded.
 */
export interface ComponentInput {
  code: string;
  label?: string;
  amount: number;
  bucket: 'baseSalary' | 'allowances';
  sourceId?: string | null;
}

/** One already-computed figure that becomes exactly one line. */
export interface FigureInput {
  code: string;
  label: string;
  amount: number;
  sourceType: LineSourceType;
  sourceId?: string | null;
}

export interface BuildLinesInput {
  /** The prorated earnings behind `baseSalary` and `allowances`. */
  components: ComponentInput[];
  /** Everything else, keyed by the bucket it rolls into. */
  figures: Partial<Record<LineBucket, FigureInput[]>>;
  /**
   * The authoritative column values from the PayrollItem.
   *
   * Lines are reconciled to these and the rounding residual is absorbed into
   * them, so they must be the stored figures, not a recomputation.
   */
  totals: Partial<Record<LineBucket, number>>;
}

/**
 * Spread a rounding residual across already-rounded lines.
 *
 * Necessary because `Σ round(xᵢ) ≠ round(Σ xᵢ)`. The engine scales a monthly
 * rate by `effectiveWorkDays / workDays` and rounds the total once; itemising
 * means rounding each part, and the parts can miss the whole by a cent per line.
 *
 * The residual goes to the LARGEST line of the bucket. That is the choice least
 * likely to be noticed and least likely to matter proportionally — putting a
 * cent on a 12,000 basic changes nothing anyone reads, while putting it on a
 * 50 telephone allowance is visible. A visible `ROUNDING` line was the
 * alternative; it is more honest and it puts a 0.01 row on nearly every
 * payslip, which is a worse daily experience for a rounding artefact.
 */
export function absorbResidual(
  lines: LineSpec[],
  bucketTotal: number,
): LineSpec[] {
  if (lines.length === 0) return lines;
  const sum = round2(lines.reduce((a, l) => a + l.amount, 0));
  const residual = round2(bucketTotal - sum);
  if (residual === 0) return lines;

  // Anything past a cent per line is not rounding, it is a real disagreement
  // between the builder and the engine, and silently papering over it is how a
  // payslip stops meaning anything.
  const tolerance = round2(0.01 * lines.length);
  if (Math.abs(residual) > tolerance) {
    throw new Error(
      `Payslip line residual ${residual} exceeds the rounding tolerance ` +
        `${tolerance} for ${lines.length} line(s) totalling ${sum} against ` +
        `${bucketTotal}. This is a calculation mismatch, not rounding.`,
    );
  }

  let targetIndex = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].amount > lines[targetIndex].amount) targetIndex = i;
  }
  const adjusted = round2(lines[targetIndex].amount + residual);
  // Never let the fix create a negative line; the sign lives in `category`.
  if (adjusted < 0) return lines;

  return lines.map((l, i) =>
    i === targetIndex ? { ...l, amount: adjusted } : l,
  );
}

/**
 * Build the lines for one payslip.
 *
 * Deterministic: the output order is components in input order, then figures in
 * the fixed bucket order of `LINE_BUCKETS`, then figures in input order within
 * a bucket. Two runs over the same data produce byte-identical lines, which is
 * what lets a regenerated payslip be compared to the one it replaced.
 */
export function buildItemLines(input: BuildLinesInput): LineSpec[] {
  const out: LineSpec[] = [];
  let order = 0;

  const emit = (
    bucket: LineBucket,
    code: string,
    label: string,
    amount: number,
    sourceType: LineSourceType,
    sourceId?: string | null,
  ) => {
    out.push({
      code,
      label,
      category: BUCKET_CATEGORY[bucket],
      bucket,
      amount: round2(amount),
      sourceType,
      sourceId: sourceId ?? null,
      displayOrder: order++,
    });
  };

  // ── Earnings from contracted components ─────────────────────────────────
  for (const bucket of ['baseSalary', 'allowances'] as const) {
    const inBucket = input.components.filter((c) => c.bucket === bucket);
    // A zero-valued component is dropped rather than shown: an employee who has
    // no transport allowance should not read a "Transport 0.00" line.
    const rounded = inBucket
      .map((c) => ({ ...c, amount: round2(c.amount) }))
      .filter((c) => c.amount > 0);
    if (rounded.length === 0) continue;

    const start = out.length;
    for (const c of rounded) {
      emit(
        bucket,
        c.code,
        c.label ?? humanise(c.code),
        c.amount,
        'SALARY_COMPONENT',
        c.sourceId,
      );
    }
    const total = input.totals[bucket];
    if (typeof total === 'number') {
      const fixed = absorbResidual(out.slice(start), total);
      for (let i = 0; i < fixed.length; i++) out[start + i] = fixed[i];
    }
  }

  // ── Everything already computed as a figure ─────────────────────────────
  for (const bucket of LINE_BUCKETS) {
    if (bucket === 'baseSalary' || bucket === 'allowances') continue;
    const figures = (input.figures[bucket] ?? []).filter(
      (f) => round2(f.amount) > 0,
    );
    if (figures.length === 0) continue;

    const start = out.length;
    for (const f of figures) {
      emit(bucket, f.code, f.label, f.amount, f.sourceType, f.sourceId);
    }
    const total = input.totals[bucket];
    if (typeof total === 'number') {
      const fixed = absorbResidual(out.slice(start), total);
      for (let i = 0; i < fixed.length; i++) out[start + i] = fixed[i];
    }
  }

  return out;
}

/** `HOUSING_ALLOWANCE` -> `Housing Allowance`. Only used when no label is given. */
export function humanise(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export interface BucketDelta {
  bucket: LineBucket;
  lines: number;
  column: number;
  delta: number;
}

export interface ReconcileResult {
  ok: boolean;
  deltas: BucketDelta[];
  /** Only the buckets that disagree — what an error message should name. */
  mismatches: BucketDelta[];
}

/**
 * Check that each bucket's lines sum to its column.
 *
 * Not a database constraint: it is a cross-row aggregate compared against a
 * different table, so expressing it in SQL means a CONSTRAINT TRIGGER firing
 * per row on a thousand-employee run — and, decisively, one that would need a
 * "no lines means no assertion" special case to survive the feature being
 * switched off. A rule that is only conditionally true is a rule nobody can
 * rely on, so this is enforced in code, at the two points that write lines.
 *
 * The tolerance is half a cent: anything the rounding residual already handled
 * is exactly zero by the time it gets here, so a non-zero delta is a real
 * disagreement.
 */
export function reconcileLines(
  totals: Partial<Record<LineBucket, number>>,
  lines: Array<Pick<LineSpec, 'bucket' | 'amount'>>,
  tolerance = 0.005,
): ReconcileResult {
  const summed = new Map<LineBucket, number>();
  for (const l of lines) {
    summed.set(l.bucket, (summed.get(l.bucket) ?? 0) + l.amount);
  }

  const deltas: BucketDelta[] = [];
  for (const bucket of LINE_BUCKETS) {
    const column = round2(totals[bucket] ?? 0);
    const lineSum = round2(summed.get(bucket) ?? 0);
    // A bucket with neither lines nor a column is not evidence of anything.
    if (column === 0 && lineSum === 0) continue;
    deltas.push({
      bucket,
      lines: lineSum,
      column,
      delta: round2(column - lineSum),
    });
  }

  const mismatches = deltas.filter((d) => Math.abs(d.delta) > tolerance);
  return { ok: mismatches.length === 0, deltas, mismatches };
}

/** The sentence an operator should see when reconciliation fails. */
export function describeMismatch(result: ReconcileResult): string {
  return result.mismatches
    .map(
      (m) =>
        `${m.bucket}: lines total ${m.lines} but the payslip says ${m.column} ` +
        `(off by ${m.delta})`,
    )
    .join('; ');
}
