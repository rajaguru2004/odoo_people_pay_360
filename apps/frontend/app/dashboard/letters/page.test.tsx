import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import type { LetterRequest, LetterTemplate } from '@/types/letter';
import LettersQueuePage from './page';

/**
 * R66 on HR's side of the glass.
 *
 * A termination writes `Employee.status = 'INACTIVE'`; it does not delete the
 * row, so `LetterRequest`'s cascade never fires and an open request outlives its
 * subject's exit. It stays PENDING, and PENDING is this screen's default filter
 * — so the request is in front of HR right now, and until this change nothing
 * on the row said whose it was. The product decision was NOT to block it (an
 * experience letter is most often asked for precisely after leaving), which
 * makes the marker the entire fix: an Issue that still works, over a subject the
 * issuer can see has gone.
 *
 * The subtle half is where the after-the-fact warning lives. `issue` and
 * `reject` put `warning` at the TOP LEVEL of the envelope, a sibling of `data`,
 * and `lib/axios.ts` resolves with the whole `response.data` — so it survives
 * the unwrap, but only for a caller that does not go looking inside `.data`.
 * Reading it off the wrong level fails silently: the success toast still fires,
 * the letter is still minted, and the one line saying it was minted for a leaver
 * never appears. That is why the two toast cases below assert on the envelope
 * shape the server actually sends rather than on a hand-made object.
 */

vi.mock('@/services/letterService', () => ({
  default: {
    listTemplates: vi.fn(),
    getMyRequests: vi.fn(),
    getAll: vi.fn(),
    request: vi.fn(),
    issue: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock('@/services/vaultService', () => ({
  default: { download: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import letterService from '@/services/letterService';
import { toast } from 'sonner';

const getAll = vi.mocked(letterService.getAll);
const listTemplates = vi.mocked(letterService.listTemplates);
const issue = vi.mocked(letterService.issue);
const reject = vi.mocked(letterService.reject);
const toastWarning = vi.mocked(toast.warning);
const toastSuccess = vi.mocked(toast.success);

const TEMPLATES: LetterTemplate[] = [
  {
    id: 't-1',
    key: 'SALARY_CERTIFICATE',
    name: 'Salary Certificate',
    locale: 'en',
    bodyHtml: '',
    requiresApproval: true,
    isActive: true,
  },
];

/** `employeeStatus` is the raw column; the flag beside it is what the UI reads. */
function row(id: string, employeeStatus: string): LetterRequest {
  return {
    id,
    employeeId: `e-${id}`,
    templateKey: 'SALARY_CERTIFICATE',
    locale: 'en',
    purpose: 'Bank loan',
    addressedTo: 'Bank Muscat',
    status: 'PENDING',
    serialNumber: null,
    documentId: null,
    issuedAt: null,
    rejectedReason: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    employee: {
      id: `e-${id}`,
      employeeCode: `EMP-${id}`,
      fullName: `Person ${id}`,
      status: employeeStatus,
      isFormerEmployee: employeeStatus !== 'ACTIVE',
      department: { name: 'Finance' },
    },
  };
}

const SERVING = row('serving', 'ACTIVE');
const LEAVER = row('leaver', 'INACTIVE');

beforeEach(() => {
  vi.clearAllMocks();
  // `renderWithProviders` seeds user/isAuthenticated/isLoading but not
  // `hasHydrated`, and `ProtectedRoute` renders nothing until that flag is set.
  useAuthStore.setState({ hasHydrated: true });
  listTemplates.mockResolvedValue({ success: true, data: TEMPLATES } as never);
  getAll.mockResolvedValue({ success: true, data: [SERVING, LEAVER] } as never);
});

async function renderQueue() {
  const result = renderWithProviders(<LettersQueuePage />, { role: 'HR_MANAGER' });
  await waitFor(() => expect(getAll).toHaveBeenCalled());
  await screen.findByTestId(`letter-row-${SERVING.id}`);
  return result;
}

describe('R66 — the queue marks a request whose subject has left', () => {
  it('the leaver is flagged and the serving employee is not', async () => {
    await renderQueue();

    expect(screen.getByTestId(`letter-row-former-${LEAVER.id}`)).toBeInTheDocument();
    // The negative is the load-bearing half: a badge on every row marks nothing.
    expect(
      screen.queryByTestId(`letter-row-former-${SERVING.id}`),
    ).not.toBeInTheDocument();
  });

  it('the flag is read, not inferred from the status string', async () => {
    // R72: all three exits write INACTIVE and `TERMINATED` is a CONTRACT status,
    // so a client that keyed on the word "TERMINATED" would miss every leaver.
    // The server derives the flag; this row proves the client trusts it rather
    // than re-deriving it from a vocabulary it does not own.
    const odd = row('odd', 'SUSPENDED');
    getAll.mockResolvedValue({ success: true, data: [odd] } as never);
    renderWithProviders(<LettersQueuePage />, { role: 'HR_MANAGER' });

    expect(await screen.findByTestId('letter-row-former-odd')).toBeInTheDocument();
  });

  it('the marker gates nothing — a leaver can still be issued or rejected', async () => {
    await renderQueue();

    // The whole product decision, in two assertions. An experience letter is
    // most often requested after leaving; the finding was that HR could not SEE
    // the exit, not that the letter was wrong to mint.
    expect(screen.getByTestId(`letter-issue-${LEAVER.id}`)).toBeEnabled();
    expect(screen.getByTestId(`letter-reject-${LEAVER.id}`)).toBeEnabled();
  });
});

describe('R66 — the warning rides on the envelope, not inside data', () => {
  it('issuing a leaver surfaces the top-level warning', async () => {
    const { user } = await renderQueue();
    issue.mockResolvedValue({
      success: true,
      message: 'Letter issued.',
      data: { ...LEAVER, status: 'ISSUED', serialNumber: 'SAL-0007' },
      // Sibling of `data`. Moving this one level down is the silent failure.
      warning: 'Person leaver is no longer an active employee (status INACTIVE). The letter was issued anyway.',
    } as never);

    await user.click(screen.getByTestId(`letter-issue-${LEAVER.id}`));

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringContaining('no longer an active employee'),
        expect.anything(),
      ),
    );
    // Both are true and both are said: the letter WAS issued, and it was issued
    // for someone who has left.
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('SAL-0007'));
  });

  it('rejecting a leaver surfaces it too', async () => {
    const { user } = await renderQueue();
    reject.mockResolvedValue({
      success: true,
      message: 'Request rejected.',
      data: { ...LEAVER, status: 'REJECTED' },
      warning: 'Person leaver is no longer an active employee (status INACTIVE).',
    } as never);

    await user.click(screen.getByTestId(`letter-reject-${LEAVER.id}`));
    await user.type(
      screen.getByTestId(`letter-reject-reason-${LEAVER.id}`),
      'Records are no longer held for this period',
    );
    await user.click(screen.getByTestId(`letter-reject-submit-${LEAVER.id}`));

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringContaining('no longer an active employee'),
        expect.anything(),
      ),
    );
  });

  it('a serving employee produces no warning at all', async () => {
    const { user } = await renderQueue();
    issue.mockResolvedValue({
      success: true,
      message: 'Letter issued.',
      data: { ...SERVING, status: 'ISSUED', serialNumber: 'SAL-0008' },
    } as never);

    await user.click(screen.getByTestId(`letter-issue-${SERVING.id}`));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // A warning on every issue is a warning on none.
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
