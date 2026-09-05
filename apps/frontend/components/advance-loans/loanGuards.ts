import { AdvanceLoanRequest, LoanPayoffQuote, LoanScheduleRow } from '@/types/advanceLoan';

/**
 * Client-side preconditions for the loan lifecycle operations.
 *
 * Why this exists as a separate, framework-free module:
 *
 * 1. The server already refuses every one of these cases with a precise,
 *    actionable message. But the round trip is wasted when the answer is
 *    knowable from data already on screen — asking to skip instalment 50 of a
 *    one-instalment loan is answerable without the network, and answering it
 *    locally means the reason appears instantly and the typed form survives.
 *
 * 2. It is pure, so it is testable under the existing node-environment vitest
 *    setup. The component that renders these strings is not — there is no jsdom
 *    here on purpose (see vitest.config.mts). Putting the *rules* in a pure
 *    function is what makes them verifiable at all; leaving them inline in JSX
 *    is what made them unverifiable before.
 *
 * The contract: return `null` when the operation may proceed, or the exact
 * sentence to show the user. Never return a vague string — "Invalid input" is
 * the failure mode this module exists to eliminate. Each message says what is
 * wrong AND what to do about it, matching the backend's own wording style so
 * the two layers never contradict each other.
 *
 * IMPORTANT: these checks are a courtesy, never a security boundary. The server
 * re-checks all of them (`loan-lifecycle.service.ts`) plus the money ceilings
 * and role rules that must not be client-visible. Removing a check here can only
 * ever cost a round trip; it can never authorise anything.
 */

export type LoanOp =
  | 'disburse'
  | 'rateChange'
  | 'topup'
  | 'prepay'
  | 'close'
  | 'foreclose'
  | 'writeOff'
  | 'reinstate'
  | 'waive'
  | 'hold'
  | 'resume'
  | 'skip'
  | 'convert';

export interface GuardContext {
  loan: Pick<AdvanceLoanRequest, 'status' | 'type'>;
  quote: LoanPayoffQuote | null;
  schedule: LoanScheduleRow[];
}

/** Statuses where money can still move. Mirrors LOAN_TERMINAL_STATUSES server-side. */
const LIVE = ['APPROVED', 'DISBURSED', 'ACTIVE', 'ON_HOLD'];

/** A schedule row is still open only when it is SCHEDULED. */
const SKIPPABLE = 'SCHEDULED';

/**
 * The server's own epsilon for "this principal is effectively zero"
 * (`loan-lifecycle.service.ts`: `if (principal > 0.005)`).
 *
 * It must match exactly. A stricter client would refuse a foreclosure the server
 * would have allowed, which is a worse bug than the round trip this check saves:
 * a false refusal has no workaround, whereas a missing check costs one request.
 */
const PRINCIPAL_EPSILON = 0.005;

/** Today, as the `YYYY-MM-DD` a date input produces. */
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Minimum `reason` length, from the class-validator rules on
 * `dto/loan-lifecycle.dto.ts`. Write-off is stricter because it forgives company
 * money. Mirrored here only so the client and server give the SAME answer —
 * never a different one.
 */
const REASON_MIN: Partial<Record<LoanOp, number>> = {
  disburse: 0, // no reason field
  rateChange: 5,
  topup: 5,
  prepay: 0, // no reason field
  writeOff: 10,
  close: 5,
  foreclose: 5,
  reinstate: 5,
  waive: 5,
  hold: 5,
  resume: 5,
  skip: 5,
  convert: 5,
};

/**
 * Parse a money/count field the way a user actually types it.
 *
 * `Number('')` is 0, which would let an empty amount field read as a deliberate
 * zero and produce "must be greater than 0" for a field the user simply had not
 * filled in yet. Those are different mistakes and deserve different sentences.
 */
function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
}

/** Human list of the instalment numbers still open, e.g. "1, 2 and 3". */
function listOpenInstallments(schedule: LoanScheduleRow[]): string {
  const open = schedule
    .filter((r) => r.status === SKIPPABLE)
    .map((r) => r.installmentNo)
    .sort((a, b) => a - b);
  if (open.length === 0) return '';
  if (open.length === 1) return String(open[0]);
  if (open.length === 2) return `${open[0]} and ${open[1]}`;
  return `${open.slice(0, -1).join(', ')} and ${open[open.length - 1]}`;
}

/**
 * The one entry point. `form` is the raw string map the modal collects.
 */
export function validateLoanOp(
  op: LoanOp,
  form: Record<string, string>,
  ctx: GuardContext,
): string | null {
  const { loan, quote, schedule } = ctx;

  // ── status gates ───────────────────────────────────────────────────────────
  // Checked first: an operation on a dead loan is wrong regardless of the form.
  const isLive = LIVE.includes(loan.status);
  const isHeld = loan.status === 'ON_HOLD';

  if (op === 'reinstate') {
    if (loan.status !== 'WRITTEN_OFF') {
      return 'Only a written-off loan can be reinstated. This loan has nothing written off to put back.';
    }
  } else if (!isLive) {
    return `This loan is ${loan.status.toLowerCase().replace(/_/g, ' ')} and can no longer be changed.`;
  }

  if (isHeld && (op === 'prepay' || op === 'skip' || op === 'hold')) {
    return 'Recovery is paused on this loan. Resume it before recording payments or changing the schedule.';
  }
  if (op === 'resume' && !isHeld) {
    return 'This loan is not on hold, so there is nothing to resume.';
  }
  if (op === 'convert' && loan.type !== 'ADVANCE') {
    return 'Only an advance can be converted into a loan.';
  }

  const outstandingPrincipal = quote?.outstandingPrincipal ?? 0;
  const outstandingInterest = quote?.outstandingInterest ?? 0;
  const payoff = quote?.payoffAmount ?? 0;

  // ── per-operation field rules ──────────────────────────────────────────────
  // Wrapped so the REASON check can run afterwards: the operation's primary
  // field is what the user is thinking about, and reporting a missing reason
  // while the instalment number is also wrong sends them to the wrong box.
  const fieldProblem = ((): string | null => {
    switch (op) {
      case 'prepay': {
        const amount = parseNumber(form.amount);
        if (amount === null) return 'Enter the amount that was paid.';
        if (Number.isNaN(amount)) return 'The amount must be a number.';
        if (amount <= 0) return 'The prepayment must be greater than 0.';
        // Guarded on a loaded quote: with no quote the payoff reads 0 and every
        // payment would look like an overpayment.
        if (quote && amount > payoff) {
          return `That is more than this loan is worth. The full payoff today is ${payoff}; paying exactly that closes it.`;
        }
        return null;
      }

      case 'skip': {
        const no = parseNumber(form.installmentNo);
        if (no === null) return 'Enter which instalment number to skip.';
        if (Number.isNaN(no)) return 'The instalment number must be a number.';
        if (!Number.isInteger(no) || no < 1) {
          return 'The instalment number must be a whole number of at least 1.';
        }
        // Only judge against the schedule when one was actually loaded. An empty
        // array can mean "not loaded" as easily as "no schedule", and refusing on
        // the strength of that would block a legitimate skip.
        if (schedule.length > 0) {
          const row = schedule.find((r) => r.installmentNo === no);
          if (!row) {
            const highest = Math.max(...schedule.map((r) => r.installmentNo));
            return `There is no instalment ${no}. This loan has ${highest} instalment${highest === 1 ? '' : 's'}, numbered 1 to ${highest}.`;
          }
          if (row.status !== SKIPPABLE) {
            const open = listOpenInstallments(schedule);
            const status = row.status.toLowerCase().replace(/_/g, ' ');
            return open
              ? `Instalment ${no} is already ${status} and cannot be skipped. Still open: ${open}.`
              : `Instalment ${no} is already ${status}, and no instalment on this schedule is still open.`;
          }
        }
        return null;
      }

      case 'disburse': {
        // Only the two things the client can know. The window, the branch and
        // the role are the server's to judge.
        const amount = parseNumber(form.disbursedAmount);
        if (Number.isNaN(amount)) return 'The amount must be a number.';
        if (amount !== null && amount <= 0) {
          return 'The disbursed amount must be greater than 0. Leave it blank to pay out the full principal less any fee.';
        }
        if (form.disbursementDate && form.disbursementDate > todayIso()) {
          return 'A disbursement cannot be dated in the future — it has not happened yet.';
        }
        return null;
      }

      case 'rateChange': {
        const rate = parseNumber(form.newRate);
        if (rate === null) return 'Enter the new annual interest rate.';
        if (Number.isNaN(rate)) return 'The rate must be a number.';
        if (rate < 0 || rate > 100) return 'The rate must be between 0 and 100.';
        const method = form.newMethod || 'NONE';
        if (method === 'NONE' && rate > 0) {
          return 'Choose an interest method, or set the rate to 0 to make the loan interest-free.';
        }
        if (method !== 'NONE' && rate <= 0) {
          return `Interest method ${method} needs a rate above 0.`;
        }
        return null;
      }

      case 'topup': {
        const amount = parseNumber(form.amount);
        if (amount === null) return 'Enter the total principal of the new loan.';
        if (Number.isNaN(amount)) return 'The amount must be a number.';
        if (amount <= 0) return 'The new principal must be greater than 0.';
        // A top-up that is not larger than the balance is a part-payment, and
        // the server says so too — checking here saves the round trip.
        if (quote && amount <= outstandingPrincipal) {
          return `A top-up has to be larger than the ${outstandingPrincipal} still owed. To pay part of it, record a payment instead.`;
        }
        const n = parseNumber(form.installments);
        if (n === null) return 'Enter how many instalments the new loan should run over.';
        if (!Number.isInteger(n) || n < 1) {
          return 'Instalments must be a whole number of at least 1.';
        }
        return null;
      }

      case 'convert': {
        const n = parseNumber(form.installments);
        if (n === null) return 'Enter how many instalments the new loan should run over.';
        if (Number.isNaN(n)) return 'The instalment count must be a number.';
        if (!Number.isInteger(n) || n < 1) {
          return 'Instalments must be a whole number of at least 1.';
        }
        if (quote && outstandingPrincipal <= 0) {
          return 'This advance has nothing left to convert — its balance is already zero.';
        }
        return null;
      }

      case 'writeOff': {
        const amount = parseNumber(form.amount);
        if (Number.isNaN(amount)) return 'The amount must be a number.';
        if (amount !== null && amount <= 0) {
          return 'The write-off must be greater than 0. Leave the field blank to write off the whole balance.';
        }
        if (amount !== null && quote && amount > outstandingPrincipal) {
          return `A write-off of ${amount} is more than the ${outstandingPrincipal} outstanding on this loan.`;
        }
        // The server enforces 10 characters; saying so before the round trip
        // saves the user losing the rest of the form to a rejection.
        const reason = form.reason?.trim() ?? '';
        if (reason.length < 10) {
          return 'A write-off needs a reason of at least 10 characters — it permanently forgives company money and is audited.';
        }
        return null;
      }

      case 'waive': {
        const amount = parseNumber(form.amount);
        if (Number.isNaN(amount)) return 'The amount must be a number.';
        if (amount !== null && amount <= 0) {
          return 'The waiver must be greater than 0. Leave the field blank to waive the whole balance.';
        }
        const type = form.waiveType || 'BOTH';
        const cap =
          type === 'INTEREST'
            ? outstandingInterest
            : type === 'PRINCIPAL'
              ? outstandingPrincipal
              : payoff;
        if (amount !== null && quote && amount > cap) {
          const label =
            type === 'INTEREST' ? 'interest' : type === 'PRINCIPAL' ? 'principal' : 'total';
          return `A waiver of ${amount} is more than the ${label} balance of ${cap}.`;
        }
        return null;
      }

      case 'foreclose': {
        if (quote && outstandingPrincipal > PRINCIPAL_EPSILON) {
          return `This loan still has ${outstandingPrincipal} of principal outstanding. Record a prepayment of the payoff amount first, or use write-off or waive.`;
        }
        return null;
      }

      case 'close': {
        // Deliberately NOT checked here. The threshold is the configurable
        // `loan_rounding_tolerance` setting, which the client cannot see; guessing
        // it would refuse closes the server would have allowed the moment an admin
        // raised it. The server's own refusal names both the balance and the
        // tolerance, and now reaches the user intact, so there is nothing to add.
        return null;
      }

      case 'hold': {
        const until = form.until?.trim();
        if (until) {
          const parsed = new Date(until);
          if (Number.isNaN(parsed.getTime())) {
            return 'That is not a valid date. Leave it blank to pause until you resume it by hand.';
          }
        }
        return null;
      }

      case 'resume':
        return null;

      default:
        return null;
    }
  })();

  if (fieldProblem) return fieldProblem;

  // Reason length last, so the primary field is reported first. Write-off is
  // excluded: it enforces its own stricter rule above, with its own wording.
  const min = REASON_MIN[op] ?? 0;
  if (min > 0 && op !== 'writeOff') {
    const reason = form.reason?.trim() ?? '';
    if (reason.length < min) {
      return `Give a reason of at least ${min} characters — it goes on the audit trail.`;
    }
  }

  return null;
}
