import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, userEvent } from '@/test/render';
import PaymentInformationSection from './PaymentInformationSection';

/**
 * The only screen in the app that raises a bank change request.
 *
 * Two behaviours are asserted here rather than in a browser journey, because
 * both are decided entirely inside this component:
 *
 *  1. **It never edits a bank detail directly.** Submitting posts a
 *     `BankChangeRequest`; the record changes when that is approved. A form that
 *     said "saved" while nothing had changed — or while something had — is the
 *     failure this guards.
 *  2. **Per-FIELD server errors are rendered beside the field they belong to.**
 *     The API answers a bad account with `{ errors: { iban: '…' } }`. The
 *     component used to read `err.response.data.message`, which is always
 *     `undefined` under this app's axios interceptor, so the reason never
 *     arrived at all; then it arrived as one merged toast, which left the user
 *     hunting for which input was wrong.
 */

const current = vi.fn();
const submitRequest = vi.fn();
const listBanks = vi.fn();
const listFields = vi.fn();

vi.mock('@/services/bankChangeService', () => ({
  default: {
    current: (...args: unknown[]) => current(...args),
    currentFor: (...args: unknown[]) => current(...args),
    create: (...args: unknown[]) => submitRequest(...args),
  },
}));

vi.mock('@/services/bankService', () => ({
  default: {
    getAll: (...args: unknown[]) => listBanks(...args),
  },
}));

vi.mock('@/services/bankingConfigService', () => ({
  default: {
    fields: (...args: unknown[]) => listFields(...args),
  },
}));

const FIELDS = [
  {
    fieldKey: 'accountHolderName',
    label: 'Account Holder Name',
    fieldType: 'TEXT',
    validationType: 'NONE',
    required: true,
    displayOrder: 1,
    isSensitive: false,
  },
  {
    fieldKey: 'iban',
    label: 'IBAN',
    fieldType: 'TEXT',
    validationType: 'IBAN',
    required: true,
    displayOrder: 2,
    isSensitive: true,
  },
];

describe('PaymentInformationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    current.mockResolvedValue({
      data: { pendingRequestId: null, countries: ['OM'], detail: null },
    });
    listBanks.mockResolvedValue({ data: [{ id: 'bank-1', name: 'Test Bank', country: 'OM' }] });
    listFields.mockResolvedValue({ data: FIELDS });
  });

  it('shows the pending banner and withdraws the change control while a request is open', async () => {
    current.mockResolvedValue({
      data: { pendingRequestId: 'req-1', countries: ['OM'], detail: null },
    });

    renderWithProviders(<PaymentInformationSection />, { role: 'EMPLOYEE' });

    await waitFor(() => expect(screen.getByTestId('pay-info-pending')).toBeInTheDocument());
    // One open request per employee is a partial unique index, not advice — so
    // the control is withdrawn rather than left to 409.
    expect(screen.queryByTestId('pay-info-request-change')).toBeNull();
  });

  it('offers the change control when nothing is pending', async () => {
    renderWithProviders(<PaymentInformationSection />, { role: 'EMPLOYEE' });
    await waitFor(() =>
      expect(screen.getByTestId('pay-info-request-change')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('pay-info-pending')).toBeNull();
  });

  it('renders a per-field server error beside the field it names', async () => {
    // The flat shape this app's interceptor actually rejects with: no
    // `.response`, the body merged onto the error itself.
    submitRequest.mockRejectedValue({
      message: 'Bank details are invalid',
      errors: { iban: 'IBAN checksum failed' },
      status: 400,
    });

    const user = userEvent.setup();
    renderWithProviders(<PaymentInformationSection />, { role: 'EMPLOYEE' });

    await waitFor(() =>
      expect(screen.getByTestId('pay-info-request-change')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('pay-info-request-change'));

    await waitFor(() => expect(screen.getByTestId('pay-info-bank')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('pay-info-bank'), 'bank-1');
    await user.type(screen.getByTestId('pay-info-field-accountHolderName'), 'Test Holder');
    await user.type(screen.getByTestId('pay-info-field-iban'), 'NOPE');
    await user.click(screen.getByTestId('pay-info-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('pay-info-error-iban')).toHaveTextContent(
        /checksum failed/i,
      ),
    );
    // The field that was fine carries no error of its own.
    expect(screen.queryByTestId('pay-info-error-accountHolderName')).toBeNull();
  });

  it('clears a field error as soon as that field is edited', async () => {
    submitRequest.mockRejectedValue({
      message: 'Bank details are invalid',
      errors: { iban: 'IBAN checksum failed' },
      status: 400,
    });

    const user = userEvent.setup();
    renderWithProviders(<PaymentInformationSection />, { role: 'EMPLOYEE' });

    await waitFor(() =>
      expect(screen.getByTestId('pay-info-request-change')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('pay-info-request-change'));
    await waitFor(() => expect(screen.getByTestId('pay-info-bank')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('pay-info-bank'), 'bank-1');
    // Every required field filled: the point of this case is the error CLEARING,
    // not the form refusing to submit for an unrelated reason.
    await user.type(screen.getByTestId('pay-info-field-accountHolderName'), 'Test Holder');
    await user.type(screen.getByTestId('pay-info-field-iban'), 'NOPE');
    await user.click(screen.getByTestId('pay-info-submit'));

    await waitFor(() => expect(screen.getByTestId('pay-info-error-iban')).toBeInTheDocument());

    await user.type(screen.getByTestId('pay-info-field-iban'), 'X');
    await waitFor(() => expect(screen.queryByTestId('pay-info-error-iban')).toBeNull());
  });

  it('submits a REQUEST rather than writing the detail', async () => {
    submitRequest.mockResolvedValue({ data: { id: 'req-9', status: 'PENDING' } });

    const user = userEvent.setup();
    renderWithProviders(<PaymentInformationSection />, { role: 'EMPLOYEE' });

    await waitFor(() =>
      expect(screen.getByTestId('pay-info-request-change')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('pay-info-request-change'));
    await waitFor(() => expect(screen.getByTestId('pay-info-bank')).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId('pay-info-bank'), 'bank-1');
    await user.type(screen.getByTestId('pay-info-field-accountHolderName'), 'Test Holder');
    await user.type(screen.getByTestId('pay-info-field-iban'), 'OM810180000001299123456');
    await user.click(screen.getByTestId('pay-info-submit'));

    await waitFor(() => expect(submitRequest).toHaveBeenCalledTimes(1));
    const payload = submitRequest.mock.calls[0][0] as { bankId: string; data: Record<string, string> };
    expect(payload.bankId).toBe('bank-1');
    expect(payload.data.iban).toContain('OM81');
  });
});
