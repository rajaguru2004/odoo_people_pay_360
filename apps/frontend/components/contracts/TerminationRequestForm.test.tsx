import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import TerminationRequestForm from './TerminationRequestForm';

/**
 * Raising a termination request.
 *
 * This is the form that starts someone's offboarding, so the rules worth
 * asserting are the ones that decide WHAT gets sent, not how it looks: the five
 * categories the server accepts and no sixth, the exact payload shape, and that
 * a server refusal reaches the user rather than disappearing into a console.
 *
 * The date-order question is deliberately asserted as it behaves rather than as
 * it ought to: nothing on either side stops a termination date that precedes
 * the notice date (backend `TERM-API-05` pins the same absence). Recording it
 * here means re-adding the rule is a visible change on both sides at once.
 *
 */

vi.mock('@/services/terminationRequestService', () => ({
  terminationRequestService: { createTerminationRequest: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { terminationRequestService } from '@/services/terminationRequestService';
import { toast } from '@/lib/toast';

const create = vi.mocked(terminationRequestService.createTerminationRequest);

const renderForm = (props: Partial<Record<string, unknown>> = {}) =>
  renderWithProviders(
    <TerminationRequestForm
      contractId="contract-1"
      userId="user-1"
      {...(props as any)}
    />,
    { role: 'HR_MANAGER' },
  );

const fill = async (
  user: ReturnType<typeof renderWithProviders>['user'],
  over: Partial<{
    category: string;
    noticeDate: string;
    terminationDate: string;
    reason: string;
  }> = {},
) => {
  const v = {
    category: 'RESIGNATION',
    noticeDate: '2026-09-01',
    terminationDate: '2026-10-01',
    reason: 'Moving on',
    ...over,
  };
  await user.selectOptions(screen.getByTestId('con-termreq-category'), v.category);
  await user.type(screen.getByTestId('con-termreq-notice'), v.noticeDate);
  await user.type(screen.getByTestId('con-termreq-date'), v.terminationDate);
  await user.type(screen.getByTestId('con-termreq-reason'), v.reason);
};

describe('TerminationRequestForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ success: true, data: { id: 'req-1' } } as never);
  });

  describe('the categories it offers', () => {
    it('offers exactly the five the server accepts', () => {
      renderForm();
      const select = screen.getByTestId('con-termreq-category') as HTMLSelectElement;
      const values = Array.from(select.options)
        .map((o) => o.value)
        .filter(Boolean);
      expect(values).toEqual([
        'RESIGNATION',
        'MUTUAL_AGREEMENT',
        'COMPANY_TERMINATION',
        'CONTRACT_EXPIRATION',
        'DISCIPLINARY',
      ]);
    });
  });

  describe('what it sends', () => {
    it('posts the contract and requester it was handed, not anything the user typed', async () => {
      const { user } = renderForm();
      await fill(user);
      await user.click(screen.getByTestId('con-termreq-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toEqual({
        contractId: 'contract-1',
        requestedBy: 'user-1',
        terminationCategory: 'RESIGNATION',
        noticeDate: '2026-09-01',
        terminationDate: '2026-10-01',
        reason: 'Moving on',
      });
    });

    it('calls onSuccess once the server has accepted, not before', async () => {
      const onSuccess = vi.fn();
      const { user } = renderForm({ onSuccess });
      await fill(user);
      expect(onSuccess).not.toHaveBeenCalled();

      await user.click(screen.getByTestId('con-termreq-submit'));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    });
  });

  describe('what it refuses to send', () => {
    it('marks the reason required so the browser refuses an empty one', () => {
      // Asserted as an attribute rather than by clicking submit: jsdom's
      // constraint validation is not a browser's — it blocks an empty required
      // <select> here but not an empty required <textarea>, so a click-based
      // assertion would encode a jsdom quirk rather than the rule. The rule is
      // enforced for real in two places that do test it: the browser journey
      // (people-termination.spec.ts) and the server (TERM-API-04).
      renderForm();
      expect(screen.getByTestId('con-termreq-reason')).toBeRequired();
      expect(screen.getByTestId('con-termreq-notice')).toBeRequired();
      expect(screen.getByTestId('con-termreq-date')).toBeRequired();
    });

    it('will not submit without a category', async () => {
      const { user } = renderForm();
      await user.type(screen.getByTestId('con-termreq-notice'), '2026-09-01');
      await user.type(screen.getByTestId('con-termreq-date'), '2026-10-01');
      await user.type(screen.getByTestId('con-termreq-reason'), 'Moving on');
      await user.click(screen.getByTestId('con-termreq-submit'));

      await waitFor(() => expect(create).not.toHaveBeenCalled());
    });

    it('accepts a termination date BEFORE the notice date — the rule nobody enforces', async () => {
      // Asserted as it behaves, matching backend TERM-API-05. If either side
      // ever adds the ordering rule, this case turns red and the change is
      // deliberate rather than incidental.
      const { user } = renderForm();
      await fill(user, {
        noticeDate: '2026-10-01',
        terminationDate: '2026-09-01',
      });
      await user.click(screen.getByTestId('con-termreq-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    });
  });

  describe('failure handling', () => {
    /**
     * The rejection shape is the whole point of this case.
     *
     * `lib/axios.ts` does not reject with an AxiosError — its interceptor
     * builds a FLAT object (`{ statusCode, message, errors, details }`). This
     * form used to read `error.response?.data?.message`, a path that shape
     * never fills, so a duplicate request, a stale contract and a clearance
     * refusal all showed the same generic sentence. It now uses
     * `getApiErrorMessage`, which knows the real shape.
     *
     * Asserted with that real shape: mocking `{ response: { data: { message } } }`
     * would prove only that a fictional error would work.
     */
    it('surfaces the server’s own refusal, from the shape the interceptor really sends', async () => {
      create.mockRejectedValue({
        statusCode: 400,
        message: 'A termination request is already pending approval for this contract.',
        errors: null,
      } as never);

      const { user } = renderForm();
      await fill(user);
      await user.click(screen.getByTestId('con-termreq-submit'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'A termination request is already pending approval for this contract.',
        ),
      );
    });

    it('leaves the form usable after a refusal so the work is not lost', async () => {
      create.mockRejectedValue({ statusCode: 500, message: 'boom' } as never);
      const { user } = renderForm();
      await fill(user);
      await user.click(screen.getByTestId('con-termreq-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(screen.getByTestId('con-termreq-submit')).not.toBeDisabled();
      expect(
        (screen.getByTestId('con-termreq-reason') as HTMLTextAreaElement).value,
      ).toBe('Moving on');
    });
  });
});
