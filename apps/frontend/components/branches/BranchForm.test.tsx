import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import BranchForm from './BranchForm';

/**
 * Creating and editing a branch.
 *
 * A branch is not a lookup row: it carries the office hours payroll prorates
 * against, the timezone attendance is rendered in, and the geofence that
 * decides whether a check-in is accepted at all. A latitude that silently saves
 * as 910 does not fail loudly — it quietly stops everyone at that site from
 * clocking in.
 *
 * The coordinate rules are the interesting part, because they are range checks
 * on *optional string* fields. Empty has to stay legal (geofencing off), while
 * a present-but-impossible value has to be rejected, and those two cases are
 * easy to collapse into one another.
 */

vi.mock('@/hooks/useBranches', () => ({
  useBranch: vi.fn(),
  useCreateBranch: vi.fn(),
  useUpdateBranch: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useBranch, useCreateBranch, useUpdateBranch } from '@/hooks/useBranches';

const createMutate = vi.fn();
const updateMutate = vi.fn();

const codeInput = () => document.querySelector('input[name="code"]') as HTMLInputElement;
const nameInput = () => document.querySelector('input[name="name"]') as HTMLInputElement;
const geofenceToggle = () => document.querySelector('input[name="geofencingEnabled"]') as HTMLInputElement;
const latInput = () => document.querySelector('input[name="latitude"]') as HTMLInputElement;
const lngInput = () => document.querySelector('input[name="longitude"]') as HTMLInputElement;
const radiusInput = () => document.querySelector('input[name="geofenceRadiusM"]') as HTMLInputElement;
const submitButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('type') === 'submit')!;

function renderCreate() {
  return renderWithProviders(<BranchForm mode="create" />, { role: 'ADMIN' });
}

/** Fills the two fields the schema actually requires. */
async function fillRequired(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.type(codeInput(), 'MCT');
  await user.type(nameInput(), 'Muscat Office');
}

beforeEach(() => {
  createMutate.mockReset();
  updateMutate.mockReset();
  vi.mocked(useBranch).mockReturnValue({ data: undefined, isLoading: false } as never);
  vi.mocked(useCreateBranch).mockReturnValue({ mutateAsync: createMutate, isPending: false } as never);
  vi.mocked(useUpdateBranch).mockReturnValue({ mutateAsync: updateMutate, isPending: false } as never);
});

describe('required fields', () => {
  it('refuses a branch with no code or name', async () => {
    const { user } = renderCreate();

    await user.click(submitButton());

    await waitFor(() => expect(createMutate).not.toHaveBeenCalled());
  });

  it('accepts a branch with only code and name', async () => {
    // Everything else is optional by design — a branch can be created before
    // its address, hours or geofence are known.
    const { user } = renderCreate();

    await fillRequired(user);
    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
  });
});

describe('the geofence block', () => {
  it('is off by default, so a new branch does not silently gate check-in', async () => {
    renderCreate();
    expect(geofenceToggle()).not.toBeChecked();
  });

  it('reveals the coordinate fields once enabled', async () => {
    const { user } = renderCreate();

    await user.click(geofenceToggle());

    await waitFor(() => expect(geofenceToggle()).toBeChecked());
    expect(latInput()).toBeInTheDocument();
    expect(lngInput()).toBeInTheDocument();
    expect(radiusInput()).toBeInTheDocument();
  });

  it('sends the enabled flag through', async () => {
    const { user } = renderCreate();

    await fillRequired(user);
    await user.click(geofenceToggle());
    await user.type(latInput(), '23.5859');
    await user.type(lngInput(), '58.4059');
    await user.type(radiusInput(), '150');
    await user.click(submitButton());

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({ geofencingEnabled: true })),
    );
  });
});

describe('coordinate ranges', () => {
  async function submitWith(
    user: ReturnType<typeof renderWithProviders>['user'],
    values: { lat?: string; lng?: string; radius?: string },
  ) {
    await fillRequired(user);
    await user.click(geofenceToggle());
    await waitFor(() => expect(latInput()).toBeInTheDocument());
    if (values.lat) await user.type(latInput(), values.lat);
    if (values.lng) await user.type(lngInput(), values.lng);
    if (values.radius) await user.type(radiusInput(), values.radius);
    await user.click(submitButton());
  }

  it('rejects a latitude beyond ±90', async () => {
    // The silent failure this prevents: a nonsense coordinate saves, and every
    // check-in at that site is refused for reasons nobody can see.
    const { user } = renderCreate();

    await submitWith(user, { lat: '95', lng: '58.4', radius: '150' });

    await waitFor(() => expect(createMutate).not.toHaveBeenCalled());
  });

  it('rejects a longitude beyond ±180', async () => {
    const { user } = renderCreate();

    await submitWith(user, { lat: '23.5', lng: '200', radius: '150' });

    await waitFor(() => expect(createMutate).not.toHaveBeenCalled());
  });

  it('accepts the boundary values', async () => {
    // ±90 and ±180 are legal, not off-by-one rejects.
    const { user } = renderCreate();

    await submitWith(user, { lat: '90', lng: '180', radius: '1' });

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
  });

  it('accepts a negative coordinate', async () => {
    // Southern and western hemispheres exist; a naive "must be positive" rule
    // would exclude half the planet.
    const { user } = renderCreate();

    await submitWith(user, { lat: '-33.86', lng: '-70.66', radius: '150' });

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
  });

  it('rejects a non-numeric coordinate', async () => {
    const { user } = renderCreate();

    await submitWith(user, { lat: 'north', lng: '58.4', radius: '150' });

    await waitFor(() => expect(createMutate).not.toHaveBeenCalled());
  });

  it('rejects a zero or negative radius', async () => {
    // A radius of 0 accepts nothing, which reads as "geofencing is broken"
    // rather than as a configuration mistake.
    const { user } = renderCreate();

    await submitWith(user, { lat: '23.5', lng: '58.4', radius: '0' });

    await waitFor(() => expect(createMutate).not.toHaveBeenCalled());
  });

  it('allows the coordinates to be left empty', async () => {
    // Empty must stay legal: the fields are optional strings, and a branch
    // without a geofence is the normal case.
    const { user } = renderCreate();

    await fillRequired(user);
    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
  });
});

describe('edit mode', () => {
  it('loads the existing branch and updates rather than creates', async () => {
    vi.mocked(useBranch).mockReturnValue({
      data: {
        data: {
          id: 'br-1',
          code: 'HO',
          name: 'Head Office',
          isActive: true,
          geofencingEnabled: false,
        },
      },
      isLoading: false,
    } as never);

    const { user } = renderWithProviders(<BranchForm mode="edit" branchId="br-1" />, { role: 'ADMIN' });

    await waitFor(() => expect(codeInput()).toHaveValue('HO'));
    expect(nameInput()).toHaveValue('Head Office');

    await user.click(submitButton());

    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    expect(createMutate).not.toHaveBeenCalled();
  });
});

/**
 * The per-branch calendar and clock.
 *
 * These four fields — timezone, the two office times and the weekly-off set —
 * are the ones that change what "late", "a working day" and "a month's working
 * days" mean for everyone at that site. The form's job is to send exactly what
 * was chosen, and to send NOTHING when nothing was chosen, because an omitted
 * field is how a branch keeps inheriting the company default.
 */
describe('the office calendar', () => {
  it('omits the config fields entirely when they are left blank', async () => {
    // Not `''` and not a default: a blank has to be absent from the payload, or
    // the branch stops inheriting and silently pins itself to whatever the form
    // happened to send.
    const { user } = renderCreate();
    await fillRequired(user);
    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const payload = createMutate.mock.calls[0][0];
    expect(payload.timezone).toBeUndefined();
    expect(payload.officeStartTime).toBeUndefined();
    expect(payload.officeEndTime).toBeUndefined();
    // The weekly-off set is the exception, and deliberately so: `null` means
    // "inherit", while `''` would read as a week with no days off at all.
    expect(payload.weeklyOffDays).toBeNull();
  });

  it('sends the office hours and timezone it was given', async () => {
    const { user } = renderCreate();
    await fillRequired(user);

    await user.type(document.querySelector('input[name="timezone"]') as HTMLInputElement, 'Asia/Muscat');
    const start = document.querySelector('input[name="officeStartTime"]') as HTMLInputElement;
    const end = document.querySelector('input[name="officeEndTime"]') as HTMLInputElement;
    await user.clear(start);
    await user.type(start, '08:00');
    await user.clear(end);
    await user.type(end, '16:30');

    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    const payload = createMutate.mock.calls[0][0];
    expect(payload.timezone).toBe('Asia/Muscat');
    expect(payload.officeStartTime).toBe('08:00');
    expect(payload.officeEndTime).toBe('16:30');
  });

  it('builds the weekly-off set as the CSV of day numbers the backend parses', async () => {
    // The backend reads "5,6" as Friday and Saturday. A different separator, or
    // day names, would validate on the client and be refused by the server.
    const { user } = renderCreate();
    await fillRequired(user);

    await user.click(screen.getByTestId('branch-weekoff-5'));
    await user.click(screen.getByTestId('branch-weekoff-6'));
    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(createMutate.mock.calls[0][0].weeklyOffDays).toBe('5,6');
  });

  it('lets a weekly-off day be taken back off again', async () => {
    const { user } = renderCreate();
    await fillRequired(user);

    await user.click(screen.getByTestId('branch-weekoff-5'));
    await user.click(screen.getByTestId('branch-weekoff-6'));
    await user.click(screen.getByTestId('branch-weekoff-5'));
    await user.click(submitButton());

    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(createMutate.mock.calls[0][0].weeklyOffDays).toBe('6');
  });

  // The Taneka Head Office branch was saved with Mon–Sat selected — the WORKING
  // days typed into the OFF-days field. Every Mon–Sat overtime request after
  // that was classified as rest-day work and paid at 2x. Reading the working
  // days back is what makes an inverted selection visible while it is still on
  // screen; past five off days it is called out explicitly.
  it('reads the working days back so an inverted selection is visible', async () => {
    const { user } = renderCreate();
    await fillRequired(user);

    await user.click(screen.getByTestId('branch-weekoff-0'));

    const summary = await screen.findByTestId('branch-weekoff-summary');
    expect(summary).toHaveTextContent('Working days: Mon, Tue, Wed, Thu, Fri, Sat');
    expect(summary).not.toHaveTextContent('rest-day (double) rates');
  });

  it('warns when the selection leaves almost no working days', async () => {
    const { user } = renderCreate();
    await fillRequired(user);

    for (const day of ['1', '2', '3', '4', '5', '6']) {
      await user.click(screen.getByTestId(`branch-weekoff-${day}`));
    }

    const summary = await screen.findByTestId('branch-weekoff-summary');
    expect(summary).toHaveTextContent('Working days: Sun');
    expect(summary).toHaveTextContent('rest-day (double) rates');
  });

  it('shows no summary at all until a day is picked', async () => {
    const { user } = renderCreate();
    await fillRequired(user);

    expect(screen.queryByTestId('branch-weekoff-summary')).toBeNull();
  });
});

describe('editing an existing branch', () => {
  const existing = {
    id: 'br-1',
    code: 'MCT',
    name: 'Muscat Office',
    isActive: true,
    city: 'Muscat',
    country: 'OM',
    timezone: 'Asia/Muscat',
    officeStartTime: '08:00',
    officeEndTime: '16:30',
    weeklyOffDays: '5,6',
    geofencingEnabled: true,
    latitude: 23.588,
    longitude: 58.3829,
    geofenceRadiusM: 250,
  };

  it('prefills every field it will later send back', async () => {
    // A field that loads blank is a field the next save wipes.
    vi.mocked(useBranch).mockReturnValue({ data: { data: existing }, isLoading: false } as never);

    renderWithProviders(<BranchForm mode="edit" branchId="br-1" />, { role: 'ADMIN' });

    await waitFor(() => expect(codeInput()).toHaveValue('MCT'));
    expect((document.querySelector('input[name="city"]') as HTMLInputElement).value).toBe('Muscat');
    expect((document.querySelector('select[name="country"]') as HTMLSelectElement).value).toBe('OM');
    expect((document.querySelector('input[name="timezone"]') as HTMLInputElement).value).toBe('Asia/Muscat');
    expect((document.querySelector('input[name="officeStartTime"]') as HTMLInputElement).value).toBe('08:00');
    expect(geofenceToggle().checked).toBe(true);
    expect(latInput()).toHaveValue('23.588');
    expect(radiusInput()).toHaveValue('250');
  });

  it('carries the active flag through the update, which create never sends', async () => {
    // `isActive` is the second way to retire a branch, and it exists only in
    // edit mode — a create that sent it could resurrect the flag's meaning.
    vi.mocked(useBranch).mockReturnValue({ data: { data: existing }, isLoading: false } as never);
    updateMutate.mockResolvedValue({});

    const { user } = renderWithProviders(<BranchForm mode="edit" branchId="br-1" />, { role: 'ADMIN' });
    await waitFor(() => expect(codeInput()).toHaveValue('MCT'));

    await user.click(submitButton());

    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    const { id, data } = updateMutate.mock.calls[0][0];
    expect(id).toBe('br-1');
    expect(data.isActive).toBe(true);
    expect(data.geofenceRadiusM).toBe(250);
  });
});

describe('when the server refuses the save', () => {
  it('reports the server’s own reason and stays put', async () => {
    // This form has no banner — the reason reaches the user through
    // `window.alert` and nowhere else, so if the wrong property is read there is
    // no second place the text could still show up.
    const alerts: string[] = [];
    vi.spyOn(window, 'alert').mockImplementation((message?: unknown) => {
      alerts.push(String(message));
    });
    createMutate.mockRejectedValue({ message: 'Branch code already exists' });

    const { user } = renderCreate();
    await fillRequired(user);
    await user.click(submitButton());

    await waitFor(() => expect(alerts.length).toBeGreaterThan(0));
    expect(alerts.join('\n')).toContain('Branch code already exists');
    expect(codeInput()).toHaveValue('MCT');
  });
});
