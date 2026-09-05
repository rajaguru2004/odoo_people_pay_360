import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import LoanLifecycleActions from './LoanLifecycleActions';

/**
 * The three operations the product could not perform.
 *
 * Note the field ids: `LoanLifecycleActions` kebab-cases its form keys, so
 * `newMethod` is reached as `loan-op-new-method`. The BUTTON ids do not —
 * `loan-op-rateChange` — which is the inconsistency recorded as B6.
 *
 * Each of these existed server-side as enum members, columns and settings with
 * no route or no caller, and the loan screens therefore had no button:
 *
 *   **disburse**   — `DISBURSED` was a status nothing wrote, so "approved but
 *                    not yet paid out" could not be expressed.
 *   **rateChange** — `LoanRateChange` was a fully-modelled table with zero
 *                    references anywhere.
 *   **topup**      — `TOPPED_UP` and `TOPUP_SETTLEMENT` had no producer.
 *
 * What this file protects is the part a screen decides on its own: which
 * buttons a loan's status earns, and which refusals are said before a round
 * trip rather than after one.
 */

vi.mock('@/services/advanceLoanService', () => ({
  default: {
    disburse: vi.fn(),
    rateChange: vi.fn(),
    topup: vi.fn(),
    prepay: vi.fn(),
    close: vi.fn(),
    foreclose: vi.fn(),
    writeOff: vi.fn(),
    reinstate: vi.fn(),
    waive: vi.fn(),
    hold: vi.fn(),
    resume: vi.fn(),
    skipInstallment: vi.fn(),
    convert: vi.fn(),
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import advanceLoanService from '@/services/advanceLoanService';

const disburse = vi.mocked(advanceLoanService.disburse);
const rateChange = vi.mocked(advanceLoanService.rateChange);
const topup = vi.mocked(advanceLoanService.topup);

function loan(over: Record<string, unknown> = {}) {
  return {
    id: 'loan-1',
    employeeId: 'e-employee',
    type: 'LOAN',
    status: 'ACTIVE',
    amount: '1200.00',
    amountRepaid: '0.00',
    installments: 6,
    installmentAmount: '200.00',
    interestMethod: 'FLAT',
    interestRate: '6',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as never;
}

const quote = {
  loanId: 'loan-1',
  status: 'ACTIVE',
  outstandingPrincipal: 1200,
  outstandingInterest: 0,
  payoffAmount: 1200,
  asOf: '2026-08-19T00:00:00.000Z',
} as never;

function render(over: Record<string, unknown> = {}) {
  return renderWithProviders(
    <LoanLifecycleActions
      loan={loan(over.loan as Record<string, unknown>)}
      quote={quote}
      schedule={[]}
      canManage={(over.canManage as boolean) ?? true}
      canWriteOff={(over.canWriteOff as boolean) ?? true}
      onDone={vi.fn()}
    />,
    { role: 'ADMIN' },
  );
}

/** Opens one operation's modal. */
async function open(
  user: ReturnType<typeof renderWithProviders>['user'],
  op: string,
) {
  await user.click(screen.getByTestId(`loan-op-${op}`));
  await waitFor(() => expect(screen.queryByTestId('loan-op-modal')).toBeTruthy());
}

const errorText = () => screen.queryByTestId('loan-op-error')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('which buttons a loan earns', () => {
  it('offers the payout only while the loan is APPROVED', async () => {
    render({ loan: { status: 'APPROVED' } });
    expect(screen.queryByTestId('loan-op-disburse')).toBeTruthy();
  });

  it('withdraws it once the money has gone out', async () => {
    // Nothing left to record; a button that can only refuse is worse than none.
    render({ loan: { status: 'DISBURSED' } });
    expect(screen.queryByTestId('loan-op-disburse')).toBeNull();
  });

  // Two renders in one case would leave both trees mounted, so the pair is
  // split rather than sharing a body.
  it('offers a top-up on a loan', async () => {
    render({ loan: { type: 'LOAN' } });
    expect(screen.queryByTestId('loan-op-topup')).toBeTruthy();
  });

  it('does not offer one on an advance — an advance is converted, not topped up', async () => {
    render({ loan: { type: 'ADVANCE' } });
    expect(screen.queryByTestId('loan-op-topup')).toBeNull();
  });

  it('offers neither to somebody who cannot manage the loan', async () => {
    render({ canManage: false, loan: { status: 'APPROVED' } });
    expect(screen.queryByTestId('loan-op-disburse')).toBeNull();
    expect(screen.queryByTestId('loan-op-rateChange')).toBeNull();
  });
});

describe('recording the payout', () => {
  it('sends the date, the amount and the reference', async () => {
    disburse.mockResolvedValue({} as never);

    const { user } = render({ loan: { status: 'APPROVED' } });
    await open(user, 'disburse');

    const modal = screen.getByTestId('loan-op-modal');
    await user.type(within(modal).getByTestId('loan-op-disbursement-date'), '2026-08-10');
    await user.type(within(modal).getByTestId('loan-op-disbursed-amount'), '1150');
    await user.type(within(modal).getByTestId('loan-op-reference'), 'NEFT-1');
    await user.click(screen.getByTestId('loan-op-confirm'));

    await waitFor(() =>
      expect(disburse).toHaveBeenCalledWith('loan-1', {
        disbursementDate: '2026-08-10',
        disbursedAmount: 1150,
        reference: 'NEFT-1',
      }),
    );
  });

  it('sends nothing but the defaults when the fields are left blank', async () => {
    // Blank means "today, full principal less any fee" — the ordinary case.
    disburse.mockResolvedValue({} as never);

    const { user } = render({ loan: { status: 'APPROVED' } });
    await open(user, 'disburse');
    await user.click(screen.getByTestId('loan-op-confirm'));

    await waitFor(() =>
      expect(disburse).toHaveBeenCalledWith('loan-1', {
        disbursementDate: undefined,
        disbursedAmount: undefined,
        reference: undefined,
      }),
    );
  });

  it('refuses a future payout before the round trip', async () => {
    const { user } = render({ loan: { status: 'APPROVED' } });
    await open(user, 'disburse');

    const ahead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await user.type(screen.getByTestId('loan-op-disbursement-date'), ahead);
    await user.click(screen.getByTestId('loan-op-confirm'));

    expect(errorText()).toMatch(/has not happened yet/i);
    expect(disburse).not.toHaveBeenCalled();
  });
});

describe('changing the interest', () => {
  it('sends the method, the rate and what moves', async () => {
    rateChange.mockResolvedValue({} as never);

    const { user } = render();
    await open(user, 'rateChange');

    const modal = screen.getByTestId('loan-op-modal');
    await user.selectOptions(within(modal).getByTestId('loan-op-new-method'), 'FLAT');
    await user.type(within(modal).getByTestId('loan-op-new-rate'), '9.5');
    await user.selectOptions(within(modal).getByTestId('loan-op-mode'), 'KEEP_EMI');
    await user.type(within(modal).getByTestId('loan-op-reason'), 'Repriced at renewal');
    await user.click(screen.getByTestId('loan-op-confirm'));

    await waitFor(() =>
      expect(rateChange).toHaveBeenCalledWith(
        'loan-1',
        expect.objectContaining({
          newRate: 9.5,
          newMethod: 'FLAT',
          mode: 'KEEP_EMI',
          reason: 'Repriced at renewal',
        }),
      ),
    );
  });

  it('refuses a method with no rate', async () => {
    const { user } = render();
    await open(user, 'rateChange');

    await user.selectOptions(screen.getByTestId('loan-op-new-method'), 'FLAT');
    await user.type(screen.getByTestId('loan-op-new-rate'), '0');
    await user.type(screen.getByTestId('loan-op-reason'), 'A good reason');
    await user.click(screen.getByTestId('loan-op-confirm'));

    expect(errorText()).toMatch(/needs a rate above 0/i);
    expect(rateChange).not.toHaveBeenCalled();
  });

  it('refuses a rate with no method', async () => {
    const { user } = render();
    await open(user, 'rateChange');

    await user.selectOptions(screen.getByTestId('loan-op-new-method'), 'NONE');
    await user.type(screen.getByTestId('loan-op-new-rate'), '9');
    await user.type(screen.getByTestId('loan-op-reason'), 'A good reason');
    await user.click(screen.getByTestId('loan-op-confirm'));

    expect(errorText()).toMatch(/Choose an interest method/i);
    expect(rateChange).not.toHaveBeenCalled();
  });
});

describe('topping up', () => {
  it('sends the new principal and term', async () => {
    topup.mockResolvedValue({} as never);

    const { user } = render();
    await open(user, 'topup');

    const modal = screen.getByTestId('loan-op-modal');
    await user.type(within(modal).getByTestId('loan-op-amount'), '3000');
    await user.type(within(modal).getByTestId('loan-op-installments'), '12');
    await user.type(within(modal).getByTestId('loan-op-reason'), 'Needs more');
    await user.click(screen.getByTestId('loan-op-confirm'));

    await waitFor(() =>
      expect(topup).toHaveBeenCalledWith(
        'loan-1',
        expect.objectContaining({ amount: 3000, installments: 12 }),
      ),
    );
  });

  it('refuses a top-up that is not larger than the balance, and says what to do', async () => {
    // Smaller than the balance is a part-payment, which is what Record payment
    // is for — saying so here saves a round trip and a confusing 400.
    const { user } = render();
    await open(user, 'topup');

    await user.type(screen.getByTestId('loan-op-amount'), '900');
    await user.type(screen.getByTestId('loan-op-installments'), '12');
    await user.type(screen.getByTestId('loan-op-reason'), 'Needs more');
    await user.click(screen.getByTestId('loan-op-confirm'));

    expect(errorText()).toMatch(/record a payment instead/i);
    expect(topup).not.toHaveBeenCalled();
  });
});
