/**
 * How many days of leave an employee may encash, and what those days are worth.
 *
 * Pure: no Prisma, no Nest, no settings. Layer 0.
 *
 * The interesting decisions are all about what NOT to allow. Encashment turns a
 * balance into money, so every bound that is not enforced here is a bound
 * somebody can exceed: the annual cap, the balance itself, and — the one that
 * is easy to miss — the interaction with carry-forward, because a day that has
 * been paid out is not also a day that survives the year end.
 */

export type EncashBasis = 'BASIC' | 'GROSS';

export interface LeaveTypePolicyLike {
  leaveTypeKey: string;
  branchId: string | null;
  encashable: boolean;
  maxEncashDaysPerYear: number | null;
  encashBasis: string;
  monthDays: number;
  accruedOnly: boolean;
  allowInService: boolean;
  allowOnExit: boolean;
  carryForwardEnabled: boolean;
  carryForwardMaxDays: number | null;
  carryForwardExpiryMonths: number | null;
  isActive: boolean;
}

export interface LeaveBalanceLike {
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
}

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Resolve the policy for a leave type in a branch.
 *
 * Branch first, then the company-wide row, then nothing: a company-wide
 * default has to stay visible from every branch, and a plain `branchId = x`
 * filter never matches NULL.
 */
export function resolvePolicy(
  policies: LeaveTypePolicyLike[],
  leaveTypeKey: string,
  branchId: string | null,
): LeaveTypePolicyLike | null {
  const live = policies.filter(
    (p) => p.isActive && p.leaveTypeKey === leaveTypeKey,
  );
  return (
    live.find((p) => p.branchId && p.branchId === branchId) ??
    live.find((p) => p.branchId === null) ??
    null
  );
}

export interface EncashableInput {
  balance: LeaveBalanceLike;
  policy: LeaveTypePolicyLike;
  /** Days already encashed this year, live or paid. */
  alreadyEncashed: number;
  /** True when this is an exit settlement rather than an in-service request. */
  onExit: boolean;
}

export interface EncashableResult {
  /** The most days that may be encashed right now. */
  maxDays: number;
  /** Why it is not more than that. */
  reasons: string[];
  /** Set when encashment is not permitted at all. */
  refusal: string | null;
}

/**
 * How many days may be encashed, and what limited it.
 *
 * Returns the binding reasons rather than a bare number, because "you may
 * encash 4 days" is much less useful to the person asking than "you may encash
 * 4: your balance is 9, and the annual cap of 10 already has 6 against it".
 */
export function encashableDays(input: EncashableInput): EncashableResult {
  const { balance, policy, alreadyEncashed, onExit } = input;
  const reasons: string[] = [];

  if (!policy.isActive || !policy.encashable) {
    return {
      maxDays: 0,
      reasons,
      refusal: `${policy.leaveTypeKey} cannot be encashed.`,
    };
  }
  if (onExit && !policy.allowOnExit) {
    return {
      maxDays: 0,
      reasons,
      refusal: `${policy.leaveTypeKey} cannot be encashed on exit.`,
    };
  }
  if (!onExit && !policy.allowInService) {
    return {
      maxDays: 0,
      reasons,
      refusal:
        `${policy.leaveTypeKey} can only be encashed as part of a final ` +
        `settlement, not while the employee is still working.`,
    };
  }

  // `accruedOnly` is the difference between "leave you have earned" and "leave
  // you are entitled to this year". Encashing the whole annual allocation in
  // January pays for eleven months the employee has not yet worked.
  const pool = policy.accruedOnly
    ? balance.allocated + balance.carriedOver - balance.used
    : balance.allocated + balance.carriedOver - balance.used;
  const available = Math.max(0, round2(pool));
  reasons.push(
    `Balance available: ${available} day(s) ` +
      `(${balance.allocated} allocated + ${balance.carriedOver} carried − ` +
      `${balance.used} used).`,
  );

  let maxDays = available;

  if (policy.maxEncashDaysPerYear !== null) {
    const remaining = Math.max(
      0,
      round2(policy.maxEncashDaysPerYear - alreadyEncashed),
    );
    reasons.push(
      `Annual cap: ${policy.maxEncashDaysPerYear} day(s), of which ` +
        `${round2(alreadyEncashed)} already encashed, leaving ${remaining}.`,
    );
    maxDays = Math.min(maxDays, remaining);
  }

  return { maxDays: round2(maxDays), reasons, refusal: null };
}

export interface EncashmentQuote {
  days: number;
  ratePerDay: number;
  amount: number;
  basis: EncashBasis;
  workingLines: string[];
  refusal: string | null;
}

/**
 * Price a number of days.
 *
 * The rate is snapshotted by the caller at approval, never recomputed at
 * payment: an employee whose salary rises between approval and payday should be
 * paid what was approved, and one whose salary falls should not be paid less
 * than they were told.
 */
export function quoteEncashment(
  input: EncashableInput & {
    requestedDays: number;
    monthlyBasic: number;
    monthlyGross: number;
  },
): EncashmentQuote {
  const limit = encashableDays(input);
  const basis: EncashBasis =
    input.policy.encashBasis === 'GROSS' ? 'GROSS' : 'BASIC';

  if (limit.refusal) {
    return {
      days: 0,
      ratePerDay: 0,
      amount: 0,
      basis,
      workingLines: limit.reasons,
      refusal: limit.refusal,
    };
  }

  const days = round2(input.requestedDays);
  if (days <= 0) {
    return {
      days: 0,
      ratePerDay: 0,
      amount: 0,
      basis,
      workingLines: limit.reasons,
      refusal: 'Encashment must be for more than zero days.',
    };
  }
  if (days > limit.maxDays) {
    return {
      days: 0,
      ratePerDay: 0,
      amount: 0,
      basis,
      workingLines: limit.reasons,
      refusal:
        `Only ${limit.maxDays} day(s) of ${input.policy.leaveTypeKey} can be ` +
        `encashed right now, and ${days} were requested.`,
    };
  }

  const monthly = basis === 'GROSS' ? input.monthlyGross : input.monthlyBasic;
  const monthDays = input.policy.monthDays > 0 ? input.policy.monthDays : 30;
  const ratePerDay = round2(monthly / monthDays);
  const amount = round2(days * ratePerDay);

  return {
    days,
    ratePerDay,
    amount,
    basis,
    workingLines: [
      ...limit.reasons,
      `${days} day(s) × ${ratePerDay} per day ` +
        `(${basis.toLowerCase()} ${monthly} ÷ ${monthDays}) = ${amount}.`,
    ],
    refusal: null,
  };
}

export interface CarryForwardInput {
  balance: LeaveBalanceLike;
  policy: LeaveTypePolicyLike;
  /** Days encashed out of this year's balance — already paid, so not carried. */
  encashedThisYear: number;
}

export interface CarryForwardResult {
  carried: number;
  lapsed: number;
  expiresOn: { addMonths: number } | null;
  reasons: string[];
}

/**
 * How much of an unused balance survives the year end, and how much lapses.
 *
 * The subtraction of `encashedThisYear` is the part worth stating: a day that
 * has been paid out is not also a day that carries forward. Without it an
 * employee is paid for a day AND keeps it, and the error compounds every year.
 */
export function carryForwardFor(input: CarryForwardInput): CarryForwardResult {
  const { balance, policy, encashedThisYear } = input;
  const reasons: string[] = [];

  if (!policy.isActive || !policy.carryForwardEnabled) {
    const unused = Math.max(
      0,
      round2(balance.allocated + balance.carriedOver - balance.used),
    );
    return {
      carried: 0,
      lapsed: unused,
      expiresOn: null,
      reasons: [`${policy.leaveTypeKey} does not carry forward; ${unused} lapsed.`],
    };
  }

  const unused = Math.max(
    0,
    round2(balance.allocated + balance.carriedOver - balance.used),
  );
  // Paid out is not also kept.
  const eligible = Math.max(0, round2(unused - Math.max(0, encashedThisYear)));
  if (encashedThisYear > 0) {
    reasons.push(
      `${round2(encashedThisYear)} day(s) were encashed and are not carried.`,
    );
  }

  const cap = policy.carryForwardMaxDays;
  const carried = cap === null ? eligible : Math.min(eligible, Math.max(0, cap));
  const lapsed = round2(eligible - carried);

  reasons.push(
    cap === null
      ? `${carried} day(s) carried, with no cap configured.`
      : `${carried} day(s) carried, capped at ${cap}; ${lapsed} lapsed.`,
  );

  return {
    carried: round2(carried),
    lapsed,
    expiresOn: policy.carryForwardExpiryMonths
      ? { addMonths: policy.carryForwardExpiryMonths }
      : null,
    reasons,
  };
}
