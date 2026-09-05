import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import VisaSection from './VisaSection';

/**
 * The per-employee visa section.
 *
 * The visa reports screen only READS what this component writes, so this is
 * where the lifecycle actually happens: issue, renew, cancel. Three rules are
 * worth holding here rather than leaving to the server:
 *
 *  - issue-before-expiry is checked client-side, so the user is told before a
 *    round trip;
 *  - renew is offered only on the CURRENT record and cancel only on a live one,
 *    because the server refuses both otherwise and a button that always 400s is
 *    worse than no button;
 *  - a renewal posts the NEW dates, not an edit of the old row — the difference
 *    between a history and an overwrite.
 *
 * Who may see what is a role question, asserted here too: `canDelete` is ADMIN
 * alone, which is stricter than every other write on this screen.
 */

vi.mock('@/services/visaService', () => ({
  default: {
    getByEmployee: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    renew: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
  },
}));

vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import visaService from '@/services/visaService';
import libraryService from '@/services/libraryService';
import { toast } from '@/lib/toast';

const CURRENT = {
  id: 'visa-1',
  employeeId: 'emp-1',
  category: 'VISA',
  documentNumber: 'OM-12345',
  documentType: 'Employment Visa',
  country: 'Oman',
  nationality: 'IN',
  issueDate: '2025-01-01',
  expiryDate: '2027-01-01',
  status: 'ACTIVE',
  isCurrent: true,
  attachments: [],
};

const SUPERSEDED = {
  ...CURRENT,
  id: 'visa-0',
  documentNumber: 'OM-00001',
  status: 'RENEWED',
  isCurrent: false,
};

const CANCELLED = {
  ...CURRENT,
  id: 'visa-2',
  documentNumber: 'OM-99999',
  status: 'CANCELLED',
  isCurrent: true,
};

const renderSection = (
  visas: unknown[] = [CURRENT],
  opts: { role?: string; canEdit?: boolean } = {},
) => {
  vi.mocked(visaService.getByEmployee).mockResolvedValue({
    success: true,
    data: visas,
  } as never);
  return renderWithProviders(
    <VisaSection employeeId="emp-1" canEdit={opts.canEdit ?? true} />,
    { role: (opts.role ?? 'HR_MANAGER') as never },
  );
};

describe('VisaSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(libraryService.getAll).mockResolvedValue({
      success: true,
      data: [{ label: 'Employment Visa' }, { label: 'Visit Visa' }],
    } as never);
    vi.mocked(visaService.create).mockResolvedValue({ success: true } as never);
    vi.mocked(visaService.renew).mockResolvedValue({ success: true } as never);
    vi.mocked(visaService.cancel).mockResolvedValue({ success: true } as never);
  });

  describe('what it offers, and to whom', () => {
    it('offers renew and cancel on a current, live record', async () => {
      renderSection();
      await waitFor(() =>
        expect(screen.getByTestId('visa-row-OM-12345')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('visa-renew-OM-12345')).toBeInTheDocument();
      expect(screen.getByTestId('visa-cancel-OM-12345')).toBeInTheDocument();
    });

    it('offers neither on a CANCELLED record, because the server refuses both', async () => {
      renderSection([CANCELLED]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-row-OM-99999')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('visa-renew-OM-99999')).toBeNull();
      expect(screen.queryByTestId('visa-cancel-OM-99999')).toBeNull();
    });

    it('shows a superseded record as history, with no actions on it', async () => {
      // The renewal chain is the point of this model: the old row survives as
      // RENEWED and must not be editable, or the history it exists to keep
      // stops being a history. It is collapsed by default — current first,
      // history on request.
      const { user } = renderSection([CURRENT, SUPERSEDED]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-history-toggle')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('visa-row-OM-00001')).toBeNull();
      await user.click(screen.getByTestId('visa-history-toggle'));
      await waitFor(() =>
        expect(screen.getByTestId('visa-row-OM-00001')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('visa-renew-OM-00001')).toBeNull();
      expect(screen.queryByTestId('visa-edit-OM-00001')).toBeNull();
    });

    it('offers nothing to a reader who cannot edit', async () => {
      renderSection([CURRENT], { role: 'MANAGER', canEdit: false });
      await waitFor(() =>
        expect(screen.getByTestId('visa-row-OM-12345')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('visa-add')).toBeNull();
      expect(screen.queryByTestId('visa-renew-OM-12345')).toBeNull();
    });

    it('offers delete to ADMIN alone — stricter than every other write here', async () => {
      renderSection([CURRENT], { role: 'HR_MANAGER' });
      await waitFor(() =>
        expect(screen.getByTestId('visa-row-OM-12345')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('visa-delete-OM-12345')).toBeNull();

      renderSection([CURRENT], { role: 'ADMIN' });
      await waitFor(() =>
        expect(
          screen.getAllByTestId('visa-delete-OM-12345').length,
        ).toBeGreaterThan(0),
      );
    });

    it('shows the empty state when the employee holds nothing', async () => {
      renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-empty')).toBeInTheDocument(),
      );
    });
  });

  describe('issuing a visa', () => {
    const fillNew = async (
      user: ReturnType<typeof renderWithProviders>['user'],
      over: Partial<{ number: string; country: string; issue: string; expiry: string }> = {},
    ) => {
      const v = {
        number: 'OM-77777',
        country: 'Oman',
        issue: '2026-01-01',
        expiry: '2028-01-01',
        ...over,
      };
      await user.click(screen.getByTestId('visa-add'));
      await user.type(screen.getByTestId('visa-form-number'), v.number);
      await user.type(screen.getByTestId('visa-form-country'), v.country);
      await user.type(screen.getByTestId('visa-form-issue'), v.issue);
      await user.type(screen.getByTestId('visa-form-expiry'), v.expiry);
    };

    it('posts the employee it belongs to along with the dates', async () => {
      const { user } = renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-add')).toBeInTheDocument(),
      );
      await fillNew(user);
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(visaService.create).toHaveBeenCalledTimes(1));
      expect(vi.mocked(visaService.create).mock.calls[0][0]).toMatchObject({
        employeeId: 'emp-1',
        documentNumber: 'OM-77777',
        country: 'Oman',
        issueDate: '2026-01-01',
        expiryDate: '2028-01-01',
      });
    });

    it('refuses an expiry that precedes the issue date, before any round trip', async () => {
      const { user } = renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-add')).toBeInTheDocument(),
      );
      await fillNew(user, { issue: '2028-01-01', expiry: '2026-01-01' });
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(visaService.create).not.toHaveBeenCalled();
    });

    it('includes the selected nationality in the create payload', async () => {
      const { user } = renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-add')).toBeInTheDocument(),
      );
      await fillNew(user);
      await user.selectOptions(screen.getByTestId('visa-form-nationality'), 'IN');
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(visaService.create).toHaveBeenCalledTimes(1));
      expect(vi.mocked(visaService.create).mock.calls[0][0]).toMatchObject({
        nationality: 'IN',
      });
    });

    it('omits nationality when left unset — it is optional', async () => {
      const { user } = renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-add')).toBeInTheDocument(),
      );
      await fillNew(user);
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(visaService.create).toHaveBeenCalledTimes(1));
      expect(
        vi.mocked(visaService.create).mock.calls[0][0].nationality,
      ).toBeUndefined();
    });

    it('refuses two dates that are the same day', async () => {
      // The server refuses this too ('Issue date must be before expiry date');
      // the boundary is `>=`, not `>`.
      const { user } = renderSection([]);
      await waitFor(() =>
        expect(screen.getByTestId('visa-add')).toBeInTheDocument(),
      );
      await fillNew(user, { issue: '2026-01-01', expiry: '2026-01-01' });
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(visaService.create).not.toHaveBeenCalled();
    });
  });

  describe('renewing', () => {
    it('renews the record it was opened from, and sends the NEW dates', async () => {
      const { user } = renderSection();
      await waitFor(() =>
        expect(screen.getByTestId('visa-renew-OM-12345')).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('visa-renew-OM-12345'));

      // The renew form opens carrying the document TYPE, country and sponsor
      // forward but blank on number and dates: a renewal issues a new document,
      // so those are the three things that must be re-entered.
      expect(
        (screen.getByTestId('visa-form-country') as HTMLInputElement).value,
      ).toBe('Oman');
      expect(
        (screen.getByTestId('visa-form-nationality') as HTMLSelectElement).value,
      ).toBe('IN');
      expect(
        (screen.getByTestId('visa-form-number') as HTMLInputElement).value,
      ).toBe('');

      await user.type(screen.getByTestId('visa-form-number'), 'OM-54321');
      await user.type(screen.getByTestId('visa-form-issue'), '2027-01-01');
      await user.type(screen.getByTestId('visa-form-expiry'), '2029-01-01');
      await user.click(screen.getByTestId('visa-form-submit'));

      await waitFor(() => expect(visaService.renew).toHaveBeenCalledTimes(1));
      const [id, payload] = vi.mocked(visaService.renew).mock.calls[0];
      expect(id).toBe('visa-1');
      expect(payload).toMatchObject({
        documentNumber: 'OM-54321',
        expiryDate: '2029-01-01',
      });
      // A renewal is not an edit: the old row must not be updated in place.
      expect(visaService.update).not.toHaveBeenCalled();
    });
  });
});
