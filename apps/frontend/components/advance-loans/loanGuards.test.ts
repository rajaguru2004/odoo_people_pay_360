/**
 * Client-side preconditions for the loan lifecycle operations.
 *
 * The rule every test here enforces: a refused operation must produce a sentence
 * that names the actual limit. "Invalid input" and "The operation could not be
 * completed" are the failure mode this module exists to eliminate, so the suite
 * asserts on the content of the message, not merely that one was returned.
 */
import { describe, it, expect } from 'vitest';
import { validateLoanOp, GuardContext, LoanOp } from './loanGuards';
import { LoanScheduleRow, LoanPayoffQuote } from '@/types/advanceLoan';

function row(
  installmentNo: number,
  status: LoanScheduleRow['status'] = 'SCHEDULED',
  emi = 1500,
): LoanScheduleRow {
  return {
    id: `row-${installmentNo}`,
    installmentNo,
    dueDate: '2026-08-31',
    dueMonth: 8,
    dueYear: 2026,
    openingBalance: emi,
    principalComponent: emi,
    interestComponent: 0,
    employerSubsidyComponent: 0,
    feeComponent: 0,
    emiAmount: emi,
    closingBalance: 0,
    status,
    paidAmount: 0,
  };
}

function quoteOf(principal: number, interest = 0): LoanPayoffQuote {
  return {
    loanId: 'loan-1',
    status: 'ACTIVE',
    outstandingPrincipal: principal,
    outstandingInterest: interest,
    payoffAmount: principal + interest,
    asOf: '2026-08-12',
  } as LoanPayoffQuote;
}

function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return {
    loan: { status: 'ACTIVE', type: 'LOAN' } as any,
    quote: quoteOf(1500),
    schedule: [row(1)],
    ...over,
  };
}

/** Nothing may reach the user without saying what the limit is. */
function expectExplains(message: string | null, ...mustMention: string[]) {
  expect(message).not.toBeNull();
  expect(message).not.toMatch(/could not be completed|invalid input|something went wrong/i);
  for (const fragment of mustMention) {
    expect(message!.toLowerCase()).toContain(fragment.toLowerCase());
  }
}

describe('skip — the case that reached production', () => {
  /**
   * The reported incident: a one-instalment OMR 1,500 advance, "Skip
   * instalment" opened, instalment number typed as 50, mode Extend. The server
   * correctly answered 404 "Instalment not found on the live schedule" and the
   * screen showed "The operation could not be completed".
   */
  it('refuses instalment 50 on a one-instalment loan and says why', () => {
    const msg = validateLoanOp(
      'skip',
      { installmentNo: '50', mode: 'EXTEND', reason: 'Requested by HOD' },
      ctx({ schedule: [row(1)] }),
    );
    expectExplains(msg, 'no instalment 50', '1 instalment', '1 to 1');
  });

  it('names the real range on a longer schedule', () => {
    const msg = validateLoanOp(
      'skip',
      { installmentNo: '13', reason: 'x' },
      ctx({ schedule: [row(1), row(2), row(3), row(4), row(5), row(6)] }),
    );
    expectExplains(msg, 'no instalment 13', '6 instalments', '1 to 6');
  });

  it('refuses an instalment that is already paid and lists the ones still open', () => {
    const msg = validateLoanOp(
      'skip',
      { installmentNo: '1', reason: 'x' },
      ctx({ schedule: [row(1, 'PAID'), row(2), row(3)] }),
    );
    expectExplains(msg, 'already paid', 'still open: 2 and 3');
  });

  it('handles the last-instalment case without claiming something is still open', () => {
    const msg = validateLoanOp(
      'skip',
      { installmentNo: '1', reason: 'x' },
      ctx({ schedule: [row(1, 'WAIVED')] }),
    );
    expectExplains(msg, 'already waived', 'no instalment on this schedule is still open');
  });

  it('rejects 0, negatives and fractions distinctly from a missing value', () => {
    expectExplains(
      validateLoanOp('skip', { installmentNo: '0', reason: 'x' }, ctx()),
      'whole number of at least 1',
    );
    expectExplains(
      validateLoanOp('skip', { installmentNo: '1.5', reason: 'x' }, ctx()),
      'whole number of at least 1',
    );
    expectExplains(
      validateLoanOp('skip', { installmentNo: 'abc', reason: 'x' }, ctx()),
      'must be a number',
    );
    // Empty is "you have not filled this in", NOT "must be greater than 0" —
    // Number('') is 0 and would otherwise produce the wrong sentence.
    expectExplains(
      validateLoanOp('skip', { installmentNo: '', reason: 'x' }, ctx()),
      'enter which instalment',
    );
  });

  it('requires the audit reason', () => {
    expectExplains(
      validateLoanOp('skip', { installmentNo: '1', reason: '   ' }, ctx()),
      'reason',
      'audit trail',
    );
  });

  it('allows a legitimate skip', () => {
    expect(
      validateLoanOp('skip', { installmentNo: '1', reason: 'Requested by HOD' }, ctx()),
    ).toBeNull();
  });

  it('does not refuse when the schedule simply has not loaded', () => {
    // An empty array means "unknown" as often as "none". Blocking on it would
    // break a legitimate skip whenever the schedule fetch was slow or failed.
    expect(
      validateLoanOp('skip', { installmentNo: '3', reason: 'schedule not loaded' }, ctx({ schedule: [] })),
    ).toBeNull();
  });
});

describe('status gates', () => {
  const dead = ['COMPLETED', 'CLOSED', 'REJECTED', 'CANCELLED', 'SETTLED'];
  it.each(dead)('refuses every money op on a %s loan', (status) => {
    for (const op of ['prepay', 'skip', 'waive', 'close', 'writeOff'] as LoanOp[]) {
      const msg = validateLoanOp(
        op,
        { amount: '10', installmentNo: '1', reason: 'a reason long enough' },
        ctx({ loan: { status, type: 'LOAN' } as any }),
      );
      expectExplains(msg, status.toLowerCase(), 'no longer be changed');
    }
  });

  it('explains a held loan rather than letting the server 400 it', () => {
    expectExplains(
      validateLoanOp('prepay', { amount: '10' }, ctx({ loan: { status: 'ON_HOLD', type: 'LOAN' } as any })),
      'paused',
      'resume it',
    );
  });

  it('refuses resume on a loan that is not held', () => {
    expectExplains(validateLoanOp('resume', {}, ctx()), 'not on hold');
  });

  it('allows resume on a held loan', () => {
    expect(
      validateLoanOp('resume', { reason: 'resuming recovery' }, ctx({ loan: { status: 'ON_HOLD', type: 'LOAN' } as any })),
    ).toBeNull();
  });

  it('refuses reinstate unless the loan was written off', () => {
    expectExplains(validateLoanOp('reinstate', {}, ctx()), 'written-off', 'nothing written off');
    expect(
      validateLoanOp('reinstate', { reason: 'employee rehired' }, ctx({ loan: { status: 'WRITTEN_OFF', type: 'LOAN' } as any })),
    ).toBeNull();
  });

  it('refuses convert on a LOAN, allows it on an ADVANCE', () => {
    expectExplains(
      validateLoanOp('convert', { installments: '3' }, ctx()),
      'only an advance',
    );
    expect(
      validateLoanOp('convert', { installments: '3', reason: 'converting this advance' }, ctx({ loan: { status: 'ACTIVE', type: 'ADVANCE' } as any })),
    ).toBeNull();
  });
});

describe('prepay', () => {
  it('quotes the exact payoff when the amount is too large', () => {
    expectExplains(
      validateLoanOp('prepay', { amount: '5000' }, ctx({ quote: quoteOf(1500) })),
      'more than this loan is worth',
      '1500',
    );
  });

  it('separates an empty field from a deliberate zero', () => {
    expectExplains(validateLoanOp('prepay', { amount: '' }, ctx()), 'enter the amount');
    expectExplains(validateLoanOp('prepay', { amount: '0' }, ctx()), 'greater than 0');
    expectExplains(validateLoanOp('prepay', { amount: '-5' }, ctx()), 'greater than 0');
  });

  it('accepts a payment of exactly the payoff', () => {
    expect(validateLoanOp('prepay', { amount: '1500' }, ctx({ quote: quoteOf(1500) }))).toBeNull();
  });

  it('does not invent an overpayment when no quote has loaded', () => {
    expect(validateLoanOp('prepay', { amount: '1500' }, ctx({ quote: null }))).toBeNull();
  });
});

describe('write-off', () => {
  it('demands the 10-character reason the server requires', () => {
    expectExplains(
      validateLoanOp('writeOff', { amount: '100', reason: 'too short' }, ctx()),
      'at least 10 characters',
    );
  });

  it('refuses more than the outstanding balance, naming both figures', () => {
    expectExplains(
      validateLoanOp('writeOff', { amount: '9000', reason: 'Uncollectable after exit' }, ctx({ quote: quoteOf(1500) })),
      '9000',
      '1500',
    );
  });

  it('treats a blank amount as "write off everything"', () => {
    expect(
      validateLoanOp('writeOff', { amount: '', reason: 'Uncollectable after exit' }, ctx()),
    ).toBeNull();
  });
});

describe('waive', () => {
  it('caps against the interest balance when waiving interest only', () => {
    expectExplains(
      validateLoanOp('waive', { amount: '900', waiveType: 'INTEREST' }, ctx({ quote: quoteOf(1500, 0) })),
      'interest balance of 0',
    );
  });

  it('caps against the principal balance when waiving principal only', () => {
    expectExplains(
      validateLoanOp('waive', { amount: '9000', waiveType: 'PRINCIPAL' }, ctx({ quote: quoteOf(1500, 200) })),
      'principal balance of 1500',
    );
  });

  it('caps against the whole payoff for BOTH', () => {
    expect(
      validateLoanOp('waive', { amount: '1700', waiveType: 'BOTH', reason: 'goodwill gesture' }, ctx({ quote: quoteOf(1500, 200) })),
    ).toBeNull();
    expectExplains(
      validateLoanOp('waive', { amount: '1701', waiveType: 'BOTH' }, ctx({ quote: quoteOf(1500, 200) })),
      'total balance of 1700',
    );
  });
});

describe('foreclose and close', () => {
  it('refuses foreclose while principal is outstanding, and says what to do', () => {
    expectExplains(
      validateLoanOp('foreclose', {}, ctx({ quote: quoteOf(1500) })),
      '1500',
      'prepayment',
    );
  });

  it('allows foreclose once principal is clear', () => {
    expect(
      validateLoanOp('foreclose', { reason: 'employee exiting' }, ctx({ quote: quoteOf(0, 50) })),
    ).toBeNull();
  });

  it('uses the SERVER\'s 0.005 epsilon, so it never refuses what the server allows', () => {
    // `loan-lifecycle.service.ts` foreclosing test is `principal > 0.005`. A
    // stricter client would block a foreclosure the server would have permitted,
    // and a false refusal has no workaround — worse than the round trip saved.
    expect(
      validateLoanOp('foreclose', { reason: 'employee exiting' }, ctx({ quote: quoteOf(0.004) })),
    ).toBeNull();
    expectExplains(
      validateLoanOp('foreclose', { reason: 'employee exiting' }, ctx({ quote: quoteOf(0.006) })),
      'outstanding',
    );
  });

  it('leaves the close threshold to the server, whatever the balance', () => {
    // The threshold is the configurable `loan_rounding_tolerance` setting, which
    // the client cannot read. Guessing it would refuse closes the server allows
    // the moment an admin raises it, so close is delegated entirely — the
    // server's refusal names both the balance and the tolerance.
    expect(validateLoanOp('close', { reason: 'closing this loan' }, ctx({ quote: quoteOf(1500) }))).toBeNull();
    expect(validateLoanOp('close', { reason: 'closing this loan' }, ctx({ quote: quoteOf(0.4) }))).toBeNull();
  });
});

describe('convert', () => {
  it('rejects a non-positive or fractional instalment count', () => {
    const advance = ctx({ loan: { status: 'ACTIVE', type: 'ADVANCE' } as any });
    expectExplains(validateLoanOp('convert', { installments: '0' }, advance), 'at least 1');
    expectExplains(validateLoanOp('convert', { installments: '2.5' }, advance), 'at least 1');
    expectExplains(validateLoanOp('convert', { installments: '' }, advance), 'enter how many');
  });

  it('refuses to convert an advance with nothing left on it', () => {
    expectExplains(
      validateLoanOp('convert', { installments: '3' }, {
        loan: { status: 'ACTIVE', type: 'ADVANCE' } as any,
        quote: quoteOf(0),
        schedule: [row(1, 'PAID')],
      }),
      'nothing left to convert',
    );
  });
});

describe('hold', () => {
  it('accepts a blank or valid until-date and rejects gibberish', () => {
    const reason = 'pausing recovery';
    expect(validateLoanOp('hold', { until: '', reason }, ctx())).toBeNull();
    expect(validateLoanOp('hold', { until: '2026-12-31', reason }, ctx())).toBeNull();
    expectExplains(validateLoanOp('hold', { until: 'not-a-date', reason }, ctx()), 'not a valid date');
  });
});

describe('no message is ever vague', () => {
  const everyOp: LoanOp[] = [
    'prepay', 'close', 'foreclose', 'writeOff', 'reinstate',
    'waive', 'hold', 'resume', 'skip', 'convert',
  ];

  it('returns either null or a specific sentence for a blank form on every op', () => {
    for (const op of everyOp) {
      const msg = validateLoanOp(op, {}, ctx());
      if (msg === null) continue;
      expect(msg.length, `${op} produced a stub message`).toBeGreaterThan(20);
      expect(msg, `${op} produced a vague message`).not.toMatch(
        /could not be completed|invalid input|something went wrong|failed$/i,
      );
      // A sentence, so it reads as an explanation rather than a field label.
      expect(msg, `${op} message is not a sentence`).toMatch(/[.!]$/);
    }
  });

  it('never throws, whatever junk the form holds', () => {
    const junk = { amount: 'NaN', installmentNo: '1e999', installments: '-0', reason: '' };
    for (const op of everyOp) {
      expect(() => validateLoanOp(op, junk, ctx()), op).not.toThrow();
      expect(() => validateLoanOp(op, junk, ctx({ quote: null, schedule: [] })), op).not.toThrow();
    }
  });
});
