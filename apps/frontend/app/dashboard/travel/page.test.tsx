import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import TravelPage from './page';

/**
 * Raising a trip, and who is allowed to withdraw one.
 *
 * The screen is a list and a filing form on one route, so almost everything
 * worth defending here is form-shaped: four fields that must be present, a
 * fifth that is required only for one travel type, a picker fed from a master
 * list, and a filter whose options are a copy of a TypeScript union. None of
 * that needs a browser, a database or an approval chain — which is the whole
 * reason these live at this layer rather than in the travel journey.
 *
 * Three of them are regression guards rather than new coverage:
 *
 *  - `COMPLETED` was removed from `types/travel.ts` because nothing ever wrote
 *    it. The filter reads its options from `STATUS_STYLE`, a *second* hand-kept
 *    copy of the same union, and picking a value the backend's `@IsIn` no
 *    longer accepts answered 400 while the list silently kept its old rows.
 *  - the failure paths used to read `e.response?.data?.message`, which this
 *    app's axios interceptor never populates — it rejects with a FLAT object —
 *    so every refusal read as the generic fallback. They now go through
 *    `apiErrorMessage`, and the stubs below reject with the real shape.
 *  - the row used to offer Cancel to every role, so a MANAGER — who reaches
 *    this screen but is not an approver — was shown a button that could only
 *    ever answer "Not permitted to cancel this travel request".
 */

vi.mock('@/services/travelService', () => ({
  default: {
    getAll: vi.fn(),
    create: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('@/services/libraryService', () => ({
  default: { getAll: vi.fn() },
}));

// The page reports every outcome through sonner, so the toast IS the user-
// visible result for validation and for server refusals alike.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import travelService from '@/services/travelService';
import libraryService from '@/services/libraryService';
import { toast } from 'sonner';

const getAll = vi.mocked(travelService.getAll);
const create = vi.mocked(travelService.create);
const cancel = vi.mocked(travelService.cancel);
const libraryGetAll = vi.mocked(libraryService.getAll);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);

/** Two active PER_DIEM_DESTINATION rows, as the library endpoint returns them. */
const DESTINATIONS = [
  { id: 'lib-1', label: 'Dubai', perDiemRate: 45 },
  { id: 'lib-2', label: 'Muscat', perDiemRate: 30 },
];

/** A pending domestic trip owned by `e-other` unless a test says otherwise. */
function trip(over: Record<string, unknown> = {}) {
  return {
    id: 'tr-1',
    employeeId: 'e-other',
    purpose: 'Vendor audit',
    travelType: 'DOMESTIC',
    destination: 'Muscat',
    country: null,
    departureDate: '2026-09-01',
    returnDate: '2026-09-05',
    perDiemRate: null,
    perDiemDays: null,
    estimatedCost: 400,
    advanceAmount: null,
    status: 'PENDING',
    approverId: null,
    approvedAt: null,
    approverRemarks: null,
    rejectedReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    employee: {
      id: 'e-other',
      employeeCode: 'EMP-902',
      fullName: 'Grace Hopper',
    },
    ...over,
  };
}

/** The FLAT object `lib/axios.ts` really rejects with — no `.response`. */
function interceptorRejection(statusCode: number, message: string) {
  return {
    success: false,
    statusCode,
    message,
    timestamp: '2026-08-16T00:00:00.000Z',
    path: '/travel-requests',
    errors: null,
    details: { message },
  };
}

function mockList(rows: unknown[] = []) {
  getAll.mockResolvedValue({ data: rows, meta: { total: rows.length } } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // `renderWithProviders` seeds user/isAuthenticated/isLoading but not
  // `hasHydrated`, and `ProtectedRoute` renders nothing until that flag is set.
  useAuthStore.setState({ hasHydrated: true });
  mockList();
  libraryGetAll.mockResolvedValue({ success: true, data: DESTINATIONS } as never);
});

/** Renders as an approver by default; the list has settled when this returns. */
async function renderPage(
  options: Parameters<typeof renderWithProviders>[1] = {},
) {
  const result = renderWithProviders(<TravelPage />, { role: 'ADMIN', ...options });
  await waitFor(() => expect(getAll, 'the list loads on mount').toHaveBeenCalled());
  await waitFor(() =>
    expect(
      screen.queryByTestId('travel-empty') ?? screen.queryAllByTestId('travel-row')[0],
      'the loading placeholder has been replaced by the list',
    ).toBeTruthy(),
  );
  return result;
}

/** Opens the filing form and waits for the destination master to arrive. */
async function openForm(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(screen.getByTestId('travel-new'));
  await waitFor(() =>
    expect(
      screen.getByTestId('travel-destination'),
      'the destination picker unlocks once the library has answered',
    ).not.toBeDisabled(),
  );
}

interface TripFields {
  purpose?: string;
  destination?: string;
  departure?: string;
  return?: string;
  cost?: string;
  country?: string;
}

/** Fills the form. Any field passed as `''` is left untouched, i.e. missing. */
async function fillTrip(
  user: ReturnType<typeof renderWithProviders>['user'],
  over: TripFields = {},
) {
  const v: Required<Omit<TripFields, 'country'>> & { country?: string } = {
    purpose: 'Client onboarding workshop',
    destination: 'Dubai',
    departure: '2026-09-01',
    return: '2026-09-05',
    cost: '1200',
    ...over,
  };
  if (v.purpose) await user.type(screen.getByTestId('travel-purpose'), v.purpose);
  if (v.destination)
    await user.selectOptions(screen.getByTestId('travel-destination'), v.destination);
  if (v.departure) await user.type(screen.getByTestId('travel-departure'), v.departure);
  if (v.return) await user.type(screen.getByTestId('travel-return'), v.return);
  if (v.cost) {
    // The control ships with 0 in it, so a bare `type` would produce "01200".
    await user.clear(screen.getByTestId('travel-cost'));
    await user.type(screen.getByTestId('travel-cost'), v.cost);
  }
  if (v.country) await user.type(screen.getByTestId('travel-country'), v.country);
}

describe('the fields a trip cannot be filed without', () => {
  it.each([
    ['purpose', { purpose: '' }],
    ['destination', { destination: '' }],
    ['departure date', { departure: '' }],
    ['return date', { return: '' }],
  ])('refuses a trip with no %s', async (_field, missing) => {
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user, missing);
    await user.click(screen.getByTestId('travel-submit'));

    expect(
      toastWarning,
      'one sentence names all four required fields, whichever is missing',
    ).toHaveBeenCalledWith('Purpose, destination and dates are required');
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });

  it('treats a purpose of only spaces as no purpose at all', async () => {
    // `form.purpose.trim()` is the guard; a space-only purpose tells an
    // approver nothing and would pass a bare truthiness check.
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user, { purpose: '   ' });
    await user.click(screen.getByTestId('travel-submit'));

    expect(
      toastWarning,
      'whitespace does not satisfy the purpose field',
    ).toHaveBeenCalledWith('Purpose, destination and dates are required');
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });
});

describe('the country rule, which applies to international trips only', () => {
  it('refuses an international trip with no country', async () => {
    // Country is what the server hangs the visa check on, so an international
    // trip without one is a request that cannot be assessed.
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('travel-type'), 'INTERNATIONAL');
    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    expect(
      toastWarning,
      'the refusal explains why the country matters, not just that it is missing',
    ).toHaveBeenCalledWith(
      'Country is required for international travel (drives the visa check)',
    );
    expect(create, 'nothing reaches the server').not.toHaveBeenCalled();
  });

  it('accepts an international trip once a country is given', async () => {
    create.mockResolvedValue({ data: { id: 'tr-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await user.selectOptions(screen.getByTestId('travel-type'), 'INTERNATIONAL');
    await fillTrip(user, { country: 'United Arab Emirates' });
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() =>
      expect(create, 'the trip is filed').toHaveBeenCalledTimes(1),
    );
    expect(
      create.mock.calls[0][0],
      'the country travels with the request',
    ).toMatchObject({ travelType: 'INTERNATIONAL', country: 'United Arab Emirates' });
  });

  it('does not ask a domestic trip for a country', async () => {
    // The country control is not even rendered for DOMESTIC, so the rule has to
    // be conditional or every domestic filing would be blocked by an invisible
    // field.
    create.mockResolvedValue({ data: { id: 'tr-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    expect(
      screen.queryByTestId('travel-country'),
      'a domestic trip is not shown a country field',
    ).not.toBeInTheDocument();

    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() =>
      expect(create, 'a domestic trip files without a country').toHaveBeenCalledTimes(1),
    );
  });
});

describe('what a valid filing sends', () => {
  it('posts exactly the fields the create DTO accepts, and nothing else', async () => {
    // Asserted as a whole object rather than with `objectContaining`: an extra
    // key here is a 400 from the DTO whitelist, so "nothing else" is the rule.
    create.mockResolvedValue({ data: { id: 'tr-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() =>
      expect(create, 'the trip is filed once').toHaveBeenCalledTimes(1),
    );
    expect(create, 'the payload is exactly what was typed').toHaveBeenCalledWith({
      purpose: 'Client onboarding workshop',
      travelType: 'DOMESTIC',
      destination: 'Dubai',
      departureDate: '2026-09-01',
      returnDate: '2026-09-05',
      estimatedCost: 1200,
    });
  });

  it('leaves the optional cash advance off the payload when it is left blank', async () => {
    // `advanceAmount` starts undefined and must stay undefined — sending `0`
    // or `''` would record a cash advance nobody asked for.
    create.mockResolvedValue({ data: { id: 'tr-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(
      create.mock.calls[0][0].advanceAmount,
      'no advance is requested unless one is typed',
    ).toBeUndefined();
  });

  it('sends a cash advance when one is typed', async () => {
    create.mockResolvedValue({ data: { id: 'tr-9' } } as never);
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user);
    await user.type(screen.getByTestId('travel-advance'), '300');
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(
      create.mock.calls[0][0].advanceAmount,
      'the advance is sent as a number, not a string',
    ).toBe(300);
  });
});

describe('the destination picker', () => {
  it('asks the library for ACTIVE per-diem destinations only', async () => {
    // The rate is snapshotted from this master at submit, so a retired
    // destination must not be offerable.
    await renderPage();

    await waitFor(() =>
      expect(
        libraryGetAll,
        'the picker is fed from the PER_DIEM_DESTINATION master, active rows only',
      ).toHaveBeenCalledWith('PER_DIEM_DESTINATION', true),
    );
  });

  it('offers one option per configured destination', async () => {
    const { user } = await renderPage();
    await openForm(user);

    const select = screen.getByTestId('travel-destination') as HTMLSelectElement;
    expect(
      Array.from(select.options).map((o) => o.value).filter(Boolean),
      'every active destination is selectable, in library order',
    ).toEqual(['Dubai', 'Muscat']);
  });

  it('disables the picker and points at the master when nothing is configured', async () => {
    // A bare placeholder makes the form look broken; the hint says what is
    // missing and links to the screen that fixes it.
    libraryGetAll.mockResolvedValue({ success: true, data: [] } as never);
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-new'));

    await waitFor(() =>
      expect(
        screen.getByTestId('travel-destination'),
        'an empty master leaves nothing to pick',
      ).toBeDisabled(),
    );
    expect(
      screen.getByText(/No travel destinations configured yet/i),
      'the empty-master hint is shown instead of a silently empty dropdown',
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'No destinations configured' }),
      'the placeholder says why the picker is empty',
    ).toBeInTheDocument();
  });

  it('keeps the form usable when the destination master fails to load', async () => {
    // Non-fatal by design — the picker is empty, but the page must not crash.
    libraryGetAll.mockRejectedValue(new Error('network'));
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-new'));

    expect(
      screen.getByTestId('travel-purpose'),
      'the rest of the form still renders',
    ).toBeInTheDocument();
  });
});

describe('the status filter', () => {
  it('offers exactly the four statuses a trip can hold', async () => {
    // `STATUS_STYLE` is a second copy of the `TravelStatus` union, and this is
    // the assertion that keeps the two in step.
    await renderPage();

    const select = screen.getByTestId('travel-filter-status') as HTMLSelectElement;
    expect(
      Array.from(select.options).map((o) => o.value).filter(Boolean),
      'the filter mirrors types/travel.ts exactly',
    ).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
  });

  it('no longer offers COMPLETED, which nothing ever writes', async () => {
    // It matched no rows, and once the backend DTO dropped it from its `@IsIn`
    // the request answered 400 while the list kept the previous page of rows.
    await renderPage();

    const select = screen.getByTestId('travel-filter-status') as HTMLSelectElement;
    expect(
      Array.from(select.options).map((o) => o.value),
      'a status no code path writes is not a filter option',
    ).not.toContain('COMPLETED');
  });

  it('re-queries from the first page when the filter changes', async () => {
    const { user } = await renderPage();

    await user.selectOptions(screen.getByTestId('travel-filter-status'), 'APPROVED');

    await waitFor(() =>
      expect(
        getAll,
        'a narrowed filter must not keep the page offset of the wider one',
      ).toHaveBeenCalledWith(expect.objectContaining({ page: 1, status: 'APPROVED' })),
    );
  });
});

describe('when the server refuses', () => {
  it('shows the server’s own sentence on a refused filing', async () => {
    // The defect this guards: `e.response?.data?.message` is `undefined` on the
    // shape our interceptor produces, so "Travel is disabled for this company"
    // reached the user as "Failed to submit". Mocking an AxiosError instead
    // would only prove that a fictional error shape works.
    create.mockRejectedValue(
      interceptorRejection(400, 'Travel is disabled for this company') as never,
    );
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() =>
      expect(
        toastError,
        'the backend explanation reaches the user verbatim',
      ).toHaveBeenCalledWith('Travel is disabled for this company'),
    );
    expect(
      toastError,
      'the generic fallback never appears when the server explained itself',
    ).not.toHaveBeenCalledWith('Failed to submit');
  });

  it('leaves the form open and re-enabled after a refusal, so the trip can be retried', async () => {
    create.mockRejectedValue(
      interceptorRejection(400, 'Return date must follow the departure date') as never,
    );
    const { user } = await renderPage();
    await openForm(user);

    await fillTrip(user);
    await user.click(screen.getByTestId('travel-submit'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(
      screen.getByTestId('travel-submit'),
      'the submit button is not left spinning',
    ).not.toBeDisabled();
    expect(
      (screen.getByTestId('travel-purpose') as HTMLInputElement).value,
      'the typed purpose survives the refusal',
    ).toBe('Client onboarding workshop');
  });

  it('shows the server’s own sentence on a refused cancellation', async () => {
    mockList([trip({ employeeId: 'e-admin', employee: { id: 'e-admin', employeeCode: 'EMP-001', fullName: 'Ada Lovelace' } })]);
    cancel.mockRejectedValue(
      interceptorRejection(
        400,
        'Cannot cancel a completed travel request',
      ) as never,
    );
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-cancel'));
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() =>
      expect(
        toastError,
        'the reason a cancellation was blocked is the server’s to give',
      ).toHaveBeenCalledWith('Cannot cancel a completed travel request'),
    );
  });
});

describe('withdrawing a trip', () => {
  const ownTrip = () => [
    trip({
      employeeId: 'e-admin',
      employee: { id: 'e-admin', employeeCode: 'EMP-001', fullName: 'Ada Lovelace' },
    }),
  ];

  it('withdraws nothing when the confirmation is dismissed', async () => {
    // The dialog warns that cancelling also withdraws the trip's expense
    // claims, so backing out has to mean backing out.
    mockList(ownTrip());
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-cancel'));
    // The row control and the dialog's dismiss button are both called "Cancel",
    // which is a small confusion of its own; the dialog's is the untagged one.
    const dismiss = screen
      .getAllByRole('button', { name: 'Cancel' })
      .find((b) => b.getAttribute('data-testid') !== 'travel-cancel')!;
    await user.click(dismiss);

    expect(
      cancel,
      'a dismissed confirmation withdraws nothing',
    ).not.toHaveBeenCalled();
  });

  it('dismisses the confirmation dialog once the cancellation has settled', async () => {
    // `confirm()` deliberately leaves the dialog up so the caller can paint
    // "Processing…" over its own async work — which means the caller owes it a
    // `closeModal()` on EVERY exit. This page carried a comment saying exactly
    // that and then never called it, so the modal was stranded in its loading
    // state on top of the reloaded list and the screen could not be used again
    // without a refresh.
    cancel.mockResolvedValue({ message: 'Travel request cancelled' } as never);
    mockList(ownTrip());
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-cancel'));
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith('tr-1'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('confirm-modal-confirm'),
        'the dialog was left covering the refreshed list',
      ).not.toBeInTheDocument(),
    );
  });

  it('dismisses it on the REFUSAL path too, which is the one nobody exercises by hand', async () => {
    // The close lives in a `finally` for this reason: a refused cancellation
    // strands the dialog just as thoroughly as a successful one.
    cancel.mockRejectedValue({ message: 'Cannot cancel a rejected travel request' } as never);
    mockList(ownTrip());
    const { user } = await renderPage();

    await user.click(screen.getByTestId('travel-cancel'));
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByTestId('confirm-modal-confirm'),
        'a refused cancellation left the dialog up',
      ).not.toBeInTheDocument(),
    );
  });
});

describe('who is offered Cancel', () => {
  const OTHERS_TRIP = () => [trip()];
  const OWN_TRIP = (employeeId: string) => [
    trip({
      employeeId,
      employee: { id: employeeId, employeeCode: 'EMP-100', fullName: 'Self' },
    }),
  ];

  it.each(['ADMIN', 'HR_MANAGER'] as const)(
    'draws Cancel for %s on somebody else’s trip, because they may withdraw any of them',
    async (role) => {
      mockList(OTHERS_TRIP());
      await renderPage({ role });

      expect(
        screen.getByTestId('travel-cancel'),
        `${role} mirrors TravelService.cancel and may withdraw any trip`,
      ).toBeInTheDocument();
    },
  );

  it('draws Cancel for the traveller looking at their own trip', async () => {
    mockList(OWN_TRIP('e-manager'));
    await renderPage({ role: 'MANAGER' });

    expect(
      screen.getByTestId('travel-cancel'),
      'a traveller may always withdraw their own trip',
    ).toBeInTheDocument();
  });

  it('draws no Cancel for a MANAGER looking at somebody else’s trip', async () => {
    // A MANAGER reaches this screen but is not an approver, so the button
    // could only ever answer "Not permitted to cancel this travel request".
    // A control that exists only to be refused reads as a broken screen.
    mockList(OTHERS_TRIP());
    await renderPage({ role: 'MANAGER' });

    expect(
      screen.getByTestId('travel-row'),
      'the trip is on screen — the absent button is a projection, not an empty list',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('travel-cancel'),
      'a manager is not offered a button that can only be refused',
    ).not.toBeInTheDocument();
  });

  it('draws no approve or reject controls for a MANAGER either', async () => {
    mockList(OTHERS_TRIP());
    await renderPage({ role: 'MANAGER' });

    expect(
      screen.getByTestId('travel-row'),
      'the trip is on screen — the absent buttons are a projection, not an empty list',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('travel-approve'),
      'approval is an ADMIN/HR_MANAGER act',
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('travel-reject'),
      'rejection is an ADMIN/HR_MANAGER act',
    ).not.toBeInTheDocument();
  });

  it('draws no Cancel on a trip that has already been settled', async () => {
    // Cancel is offered for PENDING and APPROVED only; a REJECTED trip has
    // nothing left to withdraw.
    mockList([trip({ status: 'REJECTED' })]);
    await renderPage({ role: 'ADMIN' });

    expect(
      screen.getByTestId('travel-row'),
      'the trip is on screen — the absent button is a status rule, not an empty list',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('travel-cancel'),
      'a rejected trip cannot be cancelled',
    ).not.toBeInTheDocument();
  });
});
