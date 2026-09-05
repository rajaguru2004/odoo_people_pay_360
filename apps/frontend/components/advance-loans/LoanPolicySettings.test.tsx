import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import LoanPolicySettings from './LoanPolicySettings';

/**
 * The rest of the loan policy, on screen at last.
 *
 * Four keys were editable; the engine read thirty-eight. The thirty-four
 * missing ones decide the take-home floor, what happens when pay cannot cover
 * an instalment, which loan is recovered first and who may write one off — so
 * "no UI" meant those decisions could only be made with a raw POST.
 *
 * The panel is driven by the server's own registry, and these cases pin the
 * properties that keeps it honest: it shows what the server lists (not a
 * hard-coded set), it sends only what was touched, and a refusal is shown in
 * the server's words because only the server knows the allowed values.
 */

vi.mock('@/services/systemSettingsService', () => ({
  default: { getAll: vi.fn(), getPublic: vi.fn(), update: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import systemSettingsService from '@/services/systemSettingsService';
import { toast } from '@/lib/toast';

const getAll = vi.mocked(systemSettingsService.getAll);
const update = vi.mocked(systemSettingsService.update);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);

function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-19T00:00:00.000Z',
    path: '/system-settings',
    errors: null,
    details: { message },
  };
}

const SETTINGS = [
  { key: 'advance_loan_enabled', value: 'true', description: 'Master switch' },
  { key: 'loan_module_v2_enabled', value: 'false', description: 'MASTER SWITCH' },
  { key: 'loan_min_net_pay_amount', value: '0', description: 'Take-home floor' },
  { key: 'loan_shortfall_policy', value: 'PARTIAL', description: 'When pay is short' },
  { key: 'payroll_currency', value: 'OMR', description: 'Not a loan key' },
];

beforeEach(() => {
  vi.clearAllMocks();
  getAll.mockResolvedValue({ success: true, data: SETTINGS } as never);
});

async function renderPanel() {
  const result = renderWithProviders(<LoanPolicySettings />, { role: 'ADMIN' });
  await waitFor(() => expect(getAll).toHaveBeenCalled());
  return result;
}

describe('what the panel shows', () => {
  it('lists the loan keys the server registers', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.queryByTestId('loan-policy-settings')).toBeTruthy());
    const keys = screen
      .getAllByTestId('loan-policy-row')
      .map((r) => r.getAttribute('data-key'));
    expect(keys).toContain('loan_module_v2_enabled');
    expect(keys).toContain('loan_shortfall_policy');
  });

  it('leaves out the four keys the dedicated controls already own', async () => {
    // Two controls writing one key is how a screen ends up disagreeing with
    // itself about what is saved.
    await renderPanel();

    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));
    const keys = screen
      .getAllByTestId('loan-policy-row')
      .map((r) => r.getAttribute('data-key'));
    expect(keys).not.toContain('advance_loan_enabled');
  });

  it('leaves out settings that are not about loans', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));
    const keys = screen
      .getAllByTestId('loan-policy-row')
      .map((r) => r.getAttribute('data-key'));
    expect(keys).not.toContain('payroll_currency');
  });

  it('picks the control from the value’s shape', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));

    const boolRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_module_v2_enabled')!;
    expect(within(boolRow).queryByTestId('loan-policy-toggle')).toBeTruthy();

    const enumRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_shortfall_policy')!;
    // Left as free text: the client is not told the allowed set, and guessing
    // one would refuse values the server accepts.
    expect(
      (within(enumRow).getByTestId('loan-policy-value') as HTMLInputElement).type,
    ).toBe('text');

    const numberRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_min_net_pay_amount')!;
    expect(
      (within(numberRow).getByTestId('loan-policy-value') as HTMLInputElement).type,
    ).toBe('number');
  });

  it('shows the server’s own description of each key', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));
    expect(screen.getByText('Take-home floor')).toBeTruthy();
  });
});

describe('saving', () => {
  it('is disabled until something changes', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.queryByTestId('loan-policy-save')).toBeTruthy());
    expect((screen.getByTestId('loan-policy-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('sends only the keys that were touched', async () => {
    // A panel that posted all thirty-four every time would rewrite values
    // another admin had just changed.
    update.mockResolvedValue({ success: true, message: 'ok' } as never);

    const { user } = await renderPanel();
    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));

    const boolRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_module_v2_enabled')!;
    await user.click(within(boolRow).getByTestId('loan-policy-toggle'));
    await user.click(screen.getByTestId('loan-policy-save'));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ loan_module_v2_enabled: 'true' }),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('re-reads the registry after saving, so the screen shows what was stored', async () => {
    update.mockResolvedValue({ success: true, message: 'ok' } as never);

    const { user } = await renderPanel();
    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));

    const numberRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_min_net_pay_amount')!;
    await user.clear(within(numberRow).getByTestId('loan-policy-value'));
    await user.type(within(numberRow).getByTestId('loan-policy-value'), '250');
    await user.click(screen.getByTestId('loan-policy-save'));

    await waitFor(() => expect(getAll).toHaveBeenCalledTimes(2));
  });

  it('shows the server’s validation refusal verbatim', async () => {
    // Only the server knows the allowed set for a key like
    // `loan_shortfall_policy`; its message names it.
    update.mockRejectedValue(
      interceptorRejection(
        400,
        'loan_shortfall_policy must be one of PARTIAL, DEFER, SKIP',
      ),
    );

    const { user } = await renderPanel();
    await waitFor(() => expect(screen.queryAllByTestId('loan-policy-row').length).toBeGreaterThan(0));

    const enumRow = screen
      .getAllByTestId('loan-policy-row')
      .find((r) => r.getAttribute('data-key') === 'loan_shortfall_policy')!;
    await user.clear(within(enumRow).getByTestId('loan-policy-value'));
    await user.type(within(enumRow).getByTestId('loan-policy-value'), 'BANANA');
    await user.click(screen.getByTestId('loan-policy-save'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'loan_shortfall_policy must be one of PARTIAL, DEFER, SKIP',
      ),
    );
  });
});

describe('when the registry cannot be read', () => {
  it('says so rather than rendering an empty policy', async () => {
    // An empty panel would read as "there is nothing else to configure".
    getAll.mockRejectedValue(interceptorRejection(403, 'Admins only'));

    await renderPanel();

    await waitFor(() => expect(screen.queryByTestId('loan-policy-failed')).toBeTruthy());
    expect(screen.getByTestId('loan-policy-failed').textContent).toContain('Admins only');
    expect(screen.queryByTestId('loan-policy-settings')).toBeNull();
  });
});
