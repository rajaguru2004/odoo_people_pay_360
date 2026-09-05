/**
 * Court-ordered attachment of earnings — the allocation half.
 *
 * Kept pure and free of Prisma: the priority ladder is the part that must be
 * provable, and a rule you can only exercise by generating a payroll is a rule
 * nobody tests at its boundaries.
 *
 * Where this sits in the ladder:
 *
 *     statutory  ->  GARNISHMENT  ->  protected-net  ->  recovery
 *
 * A garnishment outranks every voluntary recovery and is NOT subject to the
 * minimum-take-home floor that protects those: a court order is not something
 * the employer may decline to honour because it leaves the employee short. It
 * is bounded only by pay actually available.
 *
 * When pay is not enough, the shortfall is CARRIED FORWARD rather than lapsing
 * (the decision recorded in docs/PAYROLL-EDGE-TASK-TRACKER.md): a legally
 * binding instruction is the last thing that should be silently under-paid.
 */

export interface AllocatableOrder {
  id: string;
  /** Exactly one of `amount` / `percentOfNet` is set — the DB CHECK guarantees it. */
  amount: number | null;
  /** Percentage OF NET-OF-STATUTORY PAY, never of gross. */
  percentOfNet: number | null;
  reference: string;
  priority: number;
  startDate: Date;
  endDate: Date | null;
  /** Finite debt; null = an open attachment with no ceiling. */
  totalCap: number | null;
  collected: number;
}

/** A shortfall a previous run could not take, owed against `sourceId`. */
export interface CarriedShortfall {
  id: string;
  sourceId: string | null;
  amount: number;
  amountRecovered: number;
}

export interface GarnishmentContext {
  employeeId: string;
  /** Net after statutory deductions, before ANY recovery. The whole pool. */
  netPreRecovery: number;
  /** Last day of the payroll period — what `startDate`/`endDate` are tested against. */
  periodEnd: Date;
  /** First day of the payroll period. */
  periodStart: Date;
}

export interface GarnishmentLine {
  orderId: string;
  reference: string;
  /** What the order asked for this period, arrears included. */
  due: number;
  /** What pay actually covered. */
  taken: number;
  /** `due - taken`, carried to the next run. */
  shortfall: number;
  /** How much of `taken` settled a previous period's shortfall. */
  arrearsTaken: number;
  /** The carry-forward rows this line settled, and by how much. */
  settled: Array<{ carryForwardId: string; amount: number }>;
}

export interface GarnishmentAllocation {
  /** Sum of `taken` — the figure written to `PayrollItem.garnishment`. */
  totalTaken: number;
  lines: GarnishmentLine[];
  noteLines: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * An order is live for a period when it has started on or before the period
 * END and has not ended before the period START.
 *
 * Deliberately generous at both edges: an order served mid-month attaches that
 * month's pay (the employer holds the whole month's earnings at the time it is
 * served), and one that expires mid-month still attaches the part of the month
 * it covered. Prorating a court order by days is a policy nobody asked for and
 * would silently under-pay the instrument.
 */
export function isOrderLive(
  order: Pick<AllocatableOrder, 'startDate' | 'endDate'>,
  periodStart: Date,
  periodEnd: Date,
): boolean {
  if (order.startDate > periodEnd) return false;
  if (order.endDate && order.endDate < periodStart) return false;
  return true;
}

/**
 * Total the ladder. `orders` may arrive in any sequence; `carried` holds every
 * OUTSTANDING shortfall for this employee.
 */
export function allocateGarnishments(
  ctx: GarnishmentContext,
  orders: AllocatableOrder[],
  carried: CarriedShortfall[],
): GarnishmentAllocation {
  const lines: GarnishmentLine[] = [];
  const noteLines: string[] = [];

  const live = orders
    .filter((o) => isOrderLive(o, ctx.periodStart, ctx.periodEnd))
    // Lower priority number first; ties break on the older order, then on id so
    // the ladder is TOTAL and two runs of the same data allocate identically.
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.startDate.getTime() - b.startDate.getTime() ||
        a.id.localeCompare(b.id),
    );

  if (live.length === 0) return { totalTaken: 0, lines, noteLines };

  // The pool a garnishment may reach. Never negative: a net of zero attaches
  // nothing, it does not attach backwards.
  let pool = Math.max(0, ctx.netPreRecovery);
  let totalTaken = 0;

  for (const order of live) {
    // 1. Arrears this order already owes, oldest first.
    const arrears = carried
      .filter((c) => c.sourceId === order.id)
      .map((c) => ({ row: c, owing: round2(c.amount - c.amountRecovered) }))
      .filter((c) => c.owing > 0);

    const arrearsDue = round2(arrears.reduce((s, a) => s + a.owing, 0));

    // 2. This period's own instalment.
    const instalment =
      order.amount !== null
        ? order.amount
        : round2((Math.max(0, ctx.netPreRecovery) * (order.percentOfNet ?? 0)) / 100);

    // 3. A finite order never collects past its total — arrears included, so a
    //    carried shortfall cannot push cumulative recovery over the debt.
    let due = round2(arrearsDue + instalment);
    if (order.totalCap !== null) {
      const remainingDebt = round2(order.totalCap - order.collected);
      due = Math.min(due, Math.max(0, remainingDebt));
    }
    if (due <= 0) continue;

    const taken = round2(Math.min(due, pool));
    const shortfall = round2(due - taken);

    // 4. Arrears are settled BEFORE the current instalment, so an order that is
    //    partly paid clears the oldest debt first and the carried rows close in
    //    the order they opened.
    const settled: Array<{ carryForwardId: string; amount: number }> = [];
    let toSettle = Math.min(taken, arrearsDue);
    const arrearsTaken = round2(toSettle);
    for (const a of arrears) {
      if (toSettle <= 0) break;
      const applied = round2(Math.min(a.owing, toSettle));
      settled.push({ carryForwardId: a.row.id, amount: applied });
      toSettle = round2(toSettle - applied);
    }

    pool = round2(pool - taken);
    totalTaken = round2(totalTaken + taken);

    lines.push({
      orderId: order.id,
      reference: order.reference,
      due,
      taken,
      shortfall,
      arrearsTaken,
      settled,
    });

    if (shortfall > 0) {
      noteLines.push(
        `Court order ${order.reference}: ${taken} of ${due} recovered; ` +
          `${shortfall} carried forward to the next payroll.`,
      );
    } else if (arrearsTaken > 0) {
      noteLines.push(
        `Court order ${order.reference}: ${taken} recovered ` +
          `(including ${arrearsTaken} carried forward from an earlier period).`,
      );
    } else {
      noteLines.push(`Court order ${order.reference}: ${taken} recovered.`);
    }
  }

  return { totalTaken, lines, noteLines };
}
