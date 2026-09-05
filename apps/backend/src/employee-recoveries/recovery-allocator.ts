/**
 * How much of each employer recovery one payslip can bear.
 *
 * Pure: no Prisma, no Nest. Layer 0. Shaped after
 * `src/garnishments/garnishment-allocator.ts`, deliberately — the two solve the
 * same problem and a reader who knows one should recognise the other.
 *
 * Position in the ladder:
 *
 *   statutory -> garnishment -> protected-net -> advance -> loan -> RECOVERY
 *
 * A recovery yields to a loan, and the reason is worth stating: a loan is money
 * the employee ASKED for on an agreed schedule, while a recovery is a claim the
 * EMPLOYER has asserted. When pay is short, honouring the agreed schedule and
 * deferring the disputed claim is the defensible order, and it means a recovery
 * can never be the reason a loan instalment is missed. The opposite order is
 * defensible too, which is why `payroll_recovery_ladder_position` exists rather
 * than this being hard-coded.
 *
 * A recovery is NEVER exempt from the take-home floor. A court order may ignore
 * it; an employer's own claim may not.
 */

export interface RecoveryOrder {
  id: string;
  kind: string;
  reference: string | null;
  totalAmount: number;
  amountRecovered: number;
  /** null = take whatever is available this period. */
  instalmentAmount: number | null;
  startDate: Date;
  endDate: Date | null;
  priority: number;
  status: string;
}

export interface RecoveryContext {
  employeeId: string;
  /** What is left after statutory, garnishment, advance and loan. */
  available: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface RecoveryLine {
  recoveryId: string;
  kind: string;
  reference: string | null;
  amount: number;
  /** What this period could not take. */
  shortfall: number;
  /** True when this instalment settles the whole debt. */
  closes: boolean;
}

export interface RecoveryAllocation {
  totalTaken: number;
  lines: RecoveryLine[];
  /** Payslip sentences, produced here so every caller words it identically. */
  noteLines: string[];
}

export const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** Is this recovery live for the period being paid? */
export function isRecoveryLive(
  order: RecoveryOrder,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  if (order.status !== 'ACTIVE') return false;
  if (order.startDate > periodEnd) return false;
  if (order.endDate && order.endDate < periodStart) return false;
  return order.amountRecovered < order.totalAmount;
}

/**
 * Decide what each live recovery takes from the pay that is left.
 *
 * Ordered by `priority`, then `startDate`, then `id` — a TOTAL order, so two
 * runs over the same data allocate identically. A partial order would let a
 * regenerated payroll differ from the one it replaced for no reason anybody
 * could explain.
 */
export function allocateRecoveries(
  ctx: RecoveryContext,
  orders: RecoveryOrder[],
): RecoveryAllocation {
  const live = orders
    .filter((o) => isRecoveryLive(o, ctx.periodStart, ctx.periodEnd))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.startDate.getTime() - b.startDate.getTime() ||
        a.id.localeCompare(b.id),
    );

  let pool = Math.max(0, round2(ctx.available));
  const lines: RecoveryLine[] = [];
  const noteLines: string[] = [];

  for (const order of live) {
    const outstanding = round2(order.totalAmount - order.amountRecovered);
    if (outstanding <= 0) continue;

    // Never collect past the debt, whatever the instalment says.
    const wanted = order.instalmentAmount
      ? Math.min(order.instalmentAmount, outstanding)
      : outstanding;
    const taken = round2(Math.min(wanted, pool));
    const shortfall = round2(wanted - taken);

    if (taken > 0) {
      pool = round2(pool - taken);
      lines.push({
        recoveryId: order.id,
        kind: order.kind,
        reference: order.reference,
        amount: taken,
        shortfall,
        closes: round2(order.amountRecovered + taken) >= order.totalAmount,
      });
      noteLines.push(
        `${labelFor(order.kind)}${order.reference ? ` ${order.reference}` : ''}: ` +
          `${taken} recovered` +
          (shortfall > 0 ? `, ${shortfall} carried to the next payroll.` : '.'),
      );
    } else if (shortfall > 0) {
      // Recorded even when nothing was taken, so "why was nothing recovered in
      // June?" is answerable from the payslip rather than by re-deriving it.
      lines.push({
        recoveryId: order.id,
        kind: order.kind,
        reference: order.reference,
        amount: 0,
        shortfall,
        closes: false,
      });
      noteLines.push(
        `${labelFor(order.kind)}${order.reference ? ` ${order.reference}` : ''}: ` +
          `nothing could be recovered this period; ${shortfall} carried forward.`,
      );
    }
  }

  return {
    totalTaken: round2(lines.reduce((a, l) => a + l.amount, 0)),
    lines,
    noteLines,
  };
}

/** What a payslip should call each kind. */
export function labelFor(kind: string): string {
  switch (kind) {
    case 'ASSET_DAMAGE':
      return 'Asset damage recovery';
    case 'ASSET_LOSS':
      return 'Unreturned asset recovery';
    case 'TRAINING_BOND':
      return 'Training bond';
    case 'NOTICE_SHORTFALL':
      return 'Short notice recovery';
    default:
      return 'Recovery';
  }
}
