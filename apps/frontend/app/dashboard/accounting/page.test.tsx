import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import AccountingPage from './page';

/**
 * The loan ledger, on screen.
 *
 * Gap report §1: there was no accounting anywhere, and
 * `LoanTransaction.journalRef` was declared, indexed and written by nothing —
 * catalogue §14 was 0% testable because none of it existed.
 *
 * What this screen has to get right is the setup ORDER and the honesty of the
 * result. Accounts, then mappings, then posting; an unmapped event is a work
 * list ("six could not post because WRITE_OFF has no mapping"), not a failure,
 * and an unreadable ledger is not an empty one.
 */

vi.mock('@/services/accountingService', () => ({
  default: {
    accounts: vi.fn(),
    createAccount: vi.fn(),
    mappings: vi.fn(),
    upsertMapping: vi.fn(),
    removeMapping: vi.fn(),
    journal: vi.fn(),
    postPending: vi.fn(),
    reverse: vi.fn(),
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const confirmMock = vi.fn(async () => true);
vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock, ConfirmDialog: () => null }),
}));

import accountingService from '@/services/accountingService';
import { toast } from '@/lib/toast';

const accounts = vi.mocked(accountingService.accounts);
const createAccount = vi.mocked(accountingService.createAccount);
const mappings = vi.mocked(accountingService.mappings);
const upsertMapping = vi.mocked(accountingService.upsertMapping);
const journal = vi.mocked(accountingService.journal);
const postPending = vi.mocked(accountingService.postPending);
const reverse = vi.mocked(accountingService.reverse);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);
const toastSuccess = vi.mocked(toast.success);

function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-19T00:00:00.000Z',
    path: '/accounting',
    errors: null,
    details: { message },
  };
}

const BANK = { id: 'a-bank', code: '1010', name: 'Bank', type: 'ASSET', isActive: true, branchId: null };
const RECV = { id: 'a-recv', code: '1310', name: 'Staff loans', type: 'ASSET', isActive: true, branchId: null };

const ENTRY = {
  id: 'je-1',
  reference: 'JE-202608-0001',
  entryDate: '2026-08-31',
  narration: 'EMI_RECOVERY',
  sourceType: 'LOAN_TRANSACTION',
  sourceId: 'txn-1',
  status: 'POSTED' as const,
  lines: [
    {
      id: 'jl-1',
      amount: '206.00',
      component: 'TOTAL',
      narration: null,
      debitAccount: BANK,
      creditAccount: RECV,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  useAuthStore.setState({ hasHydrated: true });
  accounts.mockResolvedValue({ data: [] } as never);
  mappings.mockResolvedValue({ data: [] } as never);
  journal.mockResolvedValue({ data: [] } as never);
});

async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  const result = renderWithProviders(<AccountingPage />, { role: 'ADMIN', ...options });
  return result;
}

describe('who may see the ledger', () => {
  it.each(['MANAGER', 'EMPLOYEE'] as const)('tells a %s the rule', async (role) => {
    await renderPage({ role });

    await waitFor(() => expect(screen.queryByTestId('accounting-forbidden')).toBeTruthy());
    expect(accounts).not.toHaveBeenCalled();
  });

  it('lets HR read it but not post', async () => {
    // The accounts decide how money is REPORTED; changing them is an admin act.
    await renderPage({ role: 'HR_MANAGER' });

    await waitFor(() => expect(accounts).toHaveBeenCalled());
    expect(screen.queryByTestId('accounting-post')).toBeNull();
    expect(screen.queryByTestId('accounting-account-add')).toBeNull();
  });
});

describe('an unreadable ledger is not an empty one', () => {
  it('says the ledger could not be read', async () => {
    accounts.mockRejectedValue(interceptorRejection(403, 'Admins only'));

    await renderPage();

    await waitFor(() => expect(screen.queryByTestId('accounting-failed')).toBeTruthy());
    expect(screen.queryByTestId('accounting-accounts-empty')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('Admins only');
  });

  it('says nothing can post while the ledger has no accounts', async () => {
    await renderPage();
    await waitFor(() =>
      expect(screen.queryByTestId('accounting-accounts-empty')).toBeTruthy(),
    );
  });
});

describe('setting the ledger up', () => {
  it('adds an account', async () => {
    createAccount.mockResolvedValue({ data: BANK } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryByTestId('accounting-account-add')).toBeTruthy());

    await user.type(screen.getByTestId('accounting-account-code'), '1010');
    await user.type(screen.getByTestId('accounting-account-name'), 'Bank');
    await user.click(screen.getByTestId('accounting-account-add'));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ code: '1010', name: 'Bank', type: 'ASSET' }),
      ),
    );
  });

  it('refuses an account with no code or name', async () => {
    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryByTestId('accounting-account-add')).toBeTruthy());
    await user.click(screen.getByTestId('accounting-account-add'));

    expect(toastWarning).toHaveBeenCalledWith('An account needs a code and a name');
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('maps an event to a debit and a credit account', async () => {
    accounts.mockResolvedValue({ data: [BANK, RECV] } as never);
    upsertMapping.mockResolvedValue({ data: {} } as never);

    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-mappings'));
    await waitFor(() => expect(screen.queryByTestId('accounting-mapping-add')).toBeTruthy());

    await user.selectOptions(screen.getByTestId('accounting-mapping-debit'), 'a-bank');
    await user.selectOptions(screen.getByTestId('accounting-mapping-credit'), 'a-recv');
    await user.click(screen.getByTestId('accounting-mapping-add'));

    await waitFor(() =>
      expect(upsertMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'EMI_RECOVERY',
          debitAccountId: 'a-bank',
          creditAccountId: 'a-recv',
        }),
      ),
    );
  });

  it('refuses a mapping whose two sides are the same account', async () => {
    // An entry that debits and credits one account moves nothing, and hides
    // that it moves nothing.
    accounts.mockResolvedValue({ data: [BANK, RECV] } as never);

    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-mappings'));
    await waitFor(() => expect(screen.queryByTestId('accounting-mapping-add')).toBeTruthy());

    await user.selectOptions(screen.getByTestId('accounting-mapping-debit'), 'a-bank');
    await user.selectOptions(screen.getByTestId('accounting-mapping-credit'), 'a-bank');
    await user.click(screen.getByTestId('accounting-mapping-add'));

    expect(toastWarning).toHaveBeenCalledWith(
      'The debit and credit sides must be different accounts',
    );
    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it('says plainly that nothing will post while nothing is mapped', async () => {
    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-mappings'));
    await waitFor(() =>
      expect(screen.queryByTestId('accounting-mappings-empty')).toBeTruthy(),
    );
  });
});

describe('posting', () => {
  it('reports what posted', async () => {
    postPending.mockResolvedValue({
      data: { considered: 3, posted: 3, failures: [] },
    } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryByTestId('accounting-post')).toBeTruthy());
    await user.click(screen.getByTestId('accounting-post'));

    await waitFor(() => expect(postPending).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('3 entries posted'));
  });

  it('shows what could not be mapped as a work list, not an error', async () => {
    // "Six could not post because WRITE_OFF has no mapping" is something to
    // do, not something that failed.
    postPending.mockResolvedValue({
      data: {
        considered: 4,
        posted: 3,
        failures: [{ transactionId: 't-9', reason: 'No ledger mapping for WRITE_OFF' }],
      },
    } as never);

    const { user } = await renderPage();
    await waitFor(() => expect(screen.queryByTestId('accounting-post')).toBeTruthy());
    await user.click(screen.getByTestId('accounting-post'));

    await waitFor(() => expect(screen.queryByTestId('accounting-unposted')).toBeTruthy());
    expect(screen.getByTestId('accounting-unposted').textContent).toContain(
      'No ledger mapping for WRITE_OFF',
    );
  });
});

describe('the journal', () => {
  it('lists entries with their lines', async () => {
    journal.mockResolvedValue({ data: [ENTRY] } as never);

    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-journal'));

    await waitFor(() =>
      expect(screen.queryAllByTestId('accounting-journal-row').length).toBe(1),
    );
    expect(screen.getByTestId('accounting-journal-line').textContent).toContain('1010');
  });

  it('reverses a posted entry after confirming', async () => {
    journal.mockResolvedValue({ data: [ENTRY] } as never);
    reverse.mockResolvedValue({ data: ENTRY } as never);

    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-journal'));
    await waitFor(() =>
      expect(screen.queryByTestId('accounting-journal-reverse')).toBeTruthy(),
    );

    await user.click(screen.getByTestId('accounting-journal-reverse'));
    await waitFor(() => expect(reverse).toHaveBeenCalledWith('je-1', expect.any(String)));
  });

  it('offers no reversal on an entry that is already reversed', async () => {
    journal.mockResolvedValue({
      data: [{ ...ENTRY, status: 'REVERSED' as const }],
    } as never);

    const { user } = await renderPage();
    await user.click(screen.getByTestId('accounting-tab-journal'));

    await waitFor(() =>
      expect(screen.queryAllByTestId('accounting-journal-row').length).toBe(1),
    );
    expect(screen.queryByTestId('accounting-journal-reverse')).toBeNull();
  });
});
