import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderWithProviders, screen, waitFor } from '@/test/render';
import NewProjectModal from './NewProjectModal';
import type { Project } from '@/types/project';

/**
 * The project dialog — create AND edit, one component, switched on `project`.
 *
 * Two reasons it earns component cover rather than a browser journey. First,
 * the payload: `submit()` rewrites every blank optional field to `undefined`
 * before it posts, because `''` reaches Prisma as a real value and a foreign
 * key of `''` is a 500 rather than a validation error. Second, the date order
 * (R48) and the colour format (R49) are now enforced at the API too, so this
 * form is no longer the only thing refusing them — it is the thing that has to
 * refuse them *legibly*, at the field, before the round trip.
 */

vi.mock('@/services/projectService', () => ({
  default: {
    create: vi.fn(),
    update: vi.fn(),
    getMembers: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
  },
}));
vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn(), getDirectory: vi.fn() },
}));
vi.mock('@/services/departmentService', () => ({ default: { getAll: vi.fn() } }));
vi.mock('@/services/teamService', () => ({ default: { getAll: vi.fn() } }));

import projectService from '@/services/projectService';
import employeeService from '@/services/employeeService';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';

const create = vi.mocked(projectService.create);
const update = vi.mocked(projectService.update);
const getMembers = vi.mocked(projectService.getMembers);
const addMember = vi.mocked(projectService.addMember);
const removeMember = vi.mocked(projectService.removeMember);

const EMPLOYEES = [
  { id: 'e-1', fullName: 'Aisha Rahman', employeeCode: 'EMP001', department: { name: 'Engineering' } },
  { id: 'e-2', fullName: 'Bilal Haddad', employeeCode: 'EMP002', department: { name: 'Engineering' } },
  { id: 'e-3', fullName: 'Carla Nunes', employeeCode: 'EMP003', department: { name: 'Finance' } },
];
const DEPARTMENTS = [{ id: 'd-1', name: 'Engineering', code: 'ENG' }];
const TEAMS = [{ id: 't-1', name: 'Platform', code: 'PLT' }];

const EXISTING: Project = {
  id: 'p-1',
  projectCode: 'PROJ-0001',
  name: 'Atlas Rollout',
  slug: 'atlas-rollout',
  taskPrefix: 'ATL',
  description: 'Migrate the HO estate.',
  color: '#16A34A',
  status: 'ACTIVE',
  priority: 'HIGH',
  visibility: 'INTERNAL',
  startDate: '2026-03-01T00:00:00.000Z',
  endDate: '2026-09-30T00:00:00.000Z',
  departmentId: 'd-1',
  teamId: 't-1',
  ownerId: 'e-1',
  isArchived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const nameInput = () => screen.getByTestId('project-form-name') as HTMLInputElement;
const submitButton = () => screen.getByTestId('project-form-submit') as HTMLButtonElement;
const form = () => screen.getByTestId('project-form') as HTMLFormElement;
const startDate = () => screen.getByTestId('project-form-start-date') as HTMLInputElement;
const endDate = () => screen.getByTestId('project-form-end-date') as HTMLInputElement;

/** Mounts the dialog open and waits for its three lookup calls to land. */
async function mount(project?: Project) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <NewProjectModal open onClose={onClose} onSaved={onSaved} project={project ?? null} />,
    { role: 'ADMIN' },
  );
  await waitFor(() => expect(screen.getByTestId('project-form-name')).toBeInTheDocument());
  // The employee list arrives asynchronously and the member picker depends on it.
  await waitFor(() => expect(employeeService.getAll).toHaveBeenCalled());
  return { ...view, onSaved, onClose };
}

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  getMembers.mockReset();
  addMember.mockReset();
  removeMember.mockReset();
  vi.mocked(employeeService.getAll).mockResolvedValue({ success: true, data: EMPLOYEES } as never);
  vi.mocked(departmentService.getAll).mockResolvedValue({ success: true, data: DEPARTMENTS } as never);
  vi.mocked(teamService.getAll).mockResolvedValue({ success: true, data: TEAMS } as never);
  getMembers.mockResolvedValue({ success: true, data: [] } as never);
});

describe('required fields', () => {
  it('keeps the submit button disabled until a name is typed', async () => {
    const { user } = await mount();

    expect(submitButton()).toBeDisabled();

    await user.type(nameInput(), 'Atlas');
    expect(submitButton()).toBeEnabled();
  });

  it('treats whitespace as no name at all', async () => {
    const { user } = await mount();

    await user.type(nameInput(), '   ');

    expect(submitButton()).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it('states the reason when the form is submitted with no name', async () => {
    // Reached by submitting the form itself rather than by clicking the button,
    // which the disabled state blocks. Both guards exist and both are asserted:
    // the button stops the ordinary user, `submit()`'s own check stops
    // everything else (implicit submission, an autofill, a future keyboard
    // shortcut) from posting an empty name.
    await mount();

    fireEvent.submit(form());

    await waitFor(() =>
      expect(screen.getByTestId('project-form-error')).toHaveTextContent('Project name is required'),
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  it('posts the identity fields with the defaults the dialog opens on', async () => {
    const { user, onSaved, onClose } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);

    await user.type(nameInput(), 'Atlas Rollout');
    await user.type(screen.getByTestId('project-form-task-prefix'), 'atl');
    await user.type(screen.getByTestId('project-form-description'), 'Migrate the HO estate.');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'Atlas Rollout',
      description: 'Migrate the HO estate.',
      // The prefix is upper-cased as it is typed — task codes are ATL-1, not atl-1.
      taskPrefix: 'ATL',
      status: 'PLANNING',
      priority: 'MEDIUM',
      visibility: 'PRIVATE',
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('sends undefined, never an empty string, for every untouched optional field', async () => {
    // `''` is not "absent" to Prisma. `departmentId: ''` is a foreign key that
    // matches nothing and 500s; `startDate: ''` fails date coercion.
    const { user } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);

    await user.type(nameInput(), 'Bare Minimum');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    for (const key of ['startDate', 'endDate', 'departmentId', 'teamId', 'ownerId', 'taskPrefix']) {
      expect(payload[key], `${key} must be undefined, not ''`).toBeUndefined();
    }
  });

  it('carries the chosen status, priority, visibility and relations', async () => {
    const { user } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);

    await user.type(nameInput(), 'Atlas');
    await user.click(screen.getByTestId('project-form-status-ACTIVE'));
    await user.click(screen.getByTestId('project-form-priority-URGENT'));
    await user.click(screen.getByTestId('project-form-visibility-PUBLIC'));
    await user.selectOptions(screen.getByTestId('project-form-department'), 'd-1');
    await user.selectOptions(screen.getByTestId('project-form-team'), 't-1');
    await user.selectOptions(screen.getByTestId('project-form-owner'), 'e-2');
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      status: 'ACTIVE',
      priority: 'URGENT',
      visibility: 'PUBLIC',
      departmentId: 'd-1',
      teamId: 't-1',
      ownerId: 'e-2',
    });
  });
});

describe('edit mode', () => {
  it('pre-fills from the project and updates rather than creates', async () => {
    update.mockResolvedValue({ success: true, data: {} } as never);
    const { user } = await mount(EXISTING);

    await waitFor(() => expect(nameInput()).toHaveValue('Atlas Rollout'));
    expect(screen.getByTestId('project-form-task-prefix')).toHaveValue('ATL');
    expect(screen.getByTestId('project-form-description')).toHaveValue('Migrate the HO estate.');
    // The ISO timestamps are cut back to the `yyyy-mm-dd` a date input accepts;
    // left whole, the inputs render blank and the next save wipes the dates.
    expect(startDate()).toHaveValue('2026-03-01');
    expect(endDate()).toHaveValue('2026-09-30');
    expect(screen.getByTestId('project-form-department')).toHaveValue('d-1');
    expect(screen.getByTestId('project-form-owner')).toHaveValue('e-1');

    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][0]).toBe('p-1');
    expect(create).not.toHaveBeenCalled();
  });

  it('adds only the newly picked members and removes only the dropped ones', async () => {
    getMembers.mockResolvedValue({
      success: true,
      data: [
        { id: 'm-1', role: 'OWNER', employee: { id: 'e-1', fullName: 'Aisha Rahman' } },
        { id: 'm-2', role: 'MEMBER', employee: { id: 'e-2', fullName: 'Bilal Haddad' } },
      ],
    } as never);
    update.mockResolvedValue({ success: true, data: {} } as never);
    addMember.mockResolvedValue({ success: true, data: [] } as never);
    removeMember.mockResolvedValue({ success: true, data: null } as never);

    const { user } = await mount(EXISTING);
    await waitFor(() => expect(screen.getByTestId('project-form-member-chip-e-2')).toBeInTheDocument());

    // Drop Bilal, add Carla.
    await user.click(screen.getByTestId('project-form-member-chip-remove-e-2'));
    await user.click(screen.getByTestId('project-form-members'));
    await user.click(await screen.findByTestId('project-form-member-option-e-3'));
    await user.click(screen.getByTestId('project-form-member-done'));

    await user.click(submitButton());

    await waitFor(() => expect(addMember).toHaveBeenCalledWith('p-1', ['e-3'], 'MEMBER'));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('p-1', 'm-2'));
    // The OWNER membership is never removable from here — dropping it would
    // leave a project only a global admin could edit. R69 was that this rule
    // held on THIS screen and nowhere else: the roster on the members tab drew
    // a delete control on the same membership. `ProjectMembers` now draws none
    // (see `ProjectMembers.test.tsx`), so the two screens agree.
    expect(removeMember).toHaveBeenCalledTimes(1);
  });
});

describe('the member picker', () => {
  it('adds a chip on pick and drops it on remove', async () => {
    const { user } = await mount();

    await user.click(screen.getByTestId('project-form-members'));
    await user.click(await screen.findByTestId('project-form-member-option-e-1'));
    expect(screen.getByTestId('project-form-member-chip-e-1')).toHaveTextContent('Aisha Rahman');

    await user.click(screen.getByTestId('project-form-member-chip-remove-e-1'));
    expect(screen.queryByTestId('project-form-member-chip-e-1')).not.toBeInTheDocument();
  });

  it('filters on name and on employee code, and says so when nothing matches', async () => {
    const { user } = await mount();

    await user.click(screen.getByTestId('project-form-members'));
    const search = await screen.findByTestId('project-form-member-search');

    await user.type(search, 'EMP003');
    expect(screen.getByTestId('project-form-member-option-e-3')).toBeInTheDocument();
    expect(screen.queryByTestId('project-form-member-option-e-1')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'nobody');
    expect(screen.getByTestId('project-form-member-empty')).toBeInTheDocument();
  });

  it('posts the picked members after the project is created', async () => {
    const { user } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);
    addMember.mockResolvedValue({ success: true, data: [] } as never);

    await user.type(nameInput(), 'Atlas');
    await user.click(screen.getByTestId('project-form-members'));
    await user.click(await screen.findByTestId('project-form-member-option-e-1'));
    await user.click(screen.getByTestId('project-form-member-option-e-2'));
    await user.click(screen.getByTestId('project-form-member-done'));
    await user.click(submitButton());

    await waitFor(() => expect(addMember).toHaveBeenCalledWith('p-new', ['e-1', 'e-2'], 'MEMBER'));
  });
});

describe('a refused save', () => {
  it('surfaces the server message on the form and keeps the user\'s input', async () => {
    // The one thing that must not happen is the dialog closing on a 400 — the
    // slug and project code collide often, and the typed name would be gone.
    const { user, onSaved, onClose } = await mount();
    create.mockRejectedValue({
      response: { data: { message: 'Project slug already exists' } },
    });

    await user.type(nameInput(), 'Atlas Rollout');
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByTestId('project-form-error')).toHaveTextContent('Project slug already exists'),
    );
    expect(nameInput()).toHaveValue('Atlas Rollout');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the server sends no reason', async () => {
    const { user } = await mount();
    create.mockRejectedValue({});

    await user.type(nameInput(), 'Atlas');
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByTestId('project-form-error')).toBeInTheDocument());
    expect(screen.getByTestId('project-form-error').textContent?.trim()).not.toBe('');
  });
});

/**
 * R48 / R48b — the inverted date range, closed at both ends.
 *
 * R48 (API, `PRJ-API-10`): nothing compared `startDate` with `endDate`. The
 * create DTO validated both as dates and the update DTO was a `PartialType` of
 * it, so an inverted range was stored verbatim; `ProjectGantt` then drew a bar
 * of negative width and the charts endpoint divided by a negative span. Fixed —
 * the order is enforced on create AND on patch.
 *
 * R48b (this form): neither date input carried a `min`/`max` from the other, so
 * the browser's own picker offered the impossible range, and `submit()` looked
 * only at the name. Fixed here: the inputs bound each other, and a range that
 * still comes out inverted — typed, pasted, or restored — is refused at the
 * field and at the top of the form instead of becoming a rejected save the user
 * has to decode.
 */
describe('R48b — an inverted date range', () => {
  it('refuses an end date before the start date instead of posting it', async () => {
    const { user } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);

    await user.type(nameInput(), 'Time Traveller');
    fireEvent.change(startDate(), { target: { value: '2026-09-30' } });
    fireEvent.change(endDate(), { target: { value: '2026-03-01' } });

    // Said where the user went wrong, in the page, in words. The whole finding
    // is that the impossible range left silently; a refusal the user has to
    // hover a control to discover would not have closed it (R76 is the same
    // mistake on the asset register).
    expect(screen.getByTestId('project-form-date-error')).toBeVisible();

    // Clicking submits nothing: `min`/`max` make the end-date field itself
    // invalid, so the browser never fires the form's submit event. This is the
    // same shape as the no-name case above — the control stops the ordinary
    // user…
    await user.click(submitButton());
    expect(create).not.toHaveBeenCalled();

    // …and `submit()`'s own cross-field check stops everything else: implicit
    // submission, an autofill, a browser with no native date input, anything
    // that reaches the handler without the field constraint having run. It
    // answers at the top of the form, where a submit is answered.
    fireEvent.submit(form());

    await waitFor(() =>
      expect(screen.getByTestId('project-form-error')).toHaveTextContent(
        'The end date cannot be earlier than the start date.',
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('bounds each date input by the other, so the picker cannot offer the range', async () => {
    const { user } = await mount();

    fireEvent.change(startDate(), { target: { value: '2026-09-30' } });
    expect(endDate()).toHaveAttribute('min', '2026-09-30');

    fireEvent.change(endDate(), { target: { value: '2026-10-31' } });
    expect(startDate()).toHaveAttribute('max', '2026-10-31');

    // The bound is a bound, not a lock: a legal range still submits.
    await user.type(nameInput(), 'Well Ordered');
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      startDate: '2026-09-30',
      endDate: '2026-10-31',
    });
  });

  it('surfaces the server\'s own refusal if an inverted range reaches it anyway', async () => {
    // The API enforces the order now, and `lib/axios` rejects with a FLAT
    // object — so the natural `err.response.data.message` reads `undefined` and
    // the message used to be swallowed by the generic fallback (R73).
    const { user } = await mount();
    create.mockRejectedValue({
      statusCode: 400,
      message: 'endDate must be on or after startDate',
    });

    await user.type(nameInput(), 'Round Trip');
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByTestId('project-form-error')).toHaveTextContent(
        'endDate must be on or after startDate',
      ),
    );
  });
});

/**
 * R49 / R49b — the colour field, closed at both ends.
 *
 * R49 (API, `PRJ-API-03`): `color` was length-checked only, so `'not-a-hex'`
 * was accepted and served back to the client, which dropped it straight into
 * `style` and `backgroundColor`. Fixed — the hex is validated.
 *
 * R49b (this form) was always half closed: a colour can only be picked from ten
 * hard-coded hexes, so nothing invalid can ORIGINATE here. The open half was
 * the edit path — `color` was pre-filled from whatever the server held and
 * posted back untouched, so a bad value that arrived by any other route (the
 * API directly, an import, a future screen) was re-committed by an unrelated
 * edit, with the swatch row showing nothing selected while it happened.
 *
 * The R49 fix turns that silent round trip into a refusal: rename a project,
 * get "color must be a valid hex" back, and no indication which field is meant.
 * So the value is normalised on the way IN, and the substitution is stated —
 * an edit that changes a field the user did not touch has to say so.
 */
describe('R49b — the colour field', () => {
  it('offers only valid six-digit hexes, and no free-text colour input', async () => {
    await mount();

    const swatches = Array.from(
      screen.getByTestId('project-form-color').querySelectorAll('[data-testid^="project-form-color-"]'),
    );
    expect(swatches).toHaveLength(10);
    for (const el of swatches) {
      const hex = el.getAttribute('data-testid')!.replace('project-form-color-', '');
      expect(`#${hex}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(document.querySelector('input[type="color"]')).toBeNull();
  });

  it('sends the picked hex verbatim', async () => {
    const { user } = await mount();
    create.mockResolvedValue({ success: true, data: { id: 'p-new' } } as never);

    await user.type(nameInput(), 'Atlas');
    await user.click(screen.getByTestId('project-form-color-DC2626'));
    await user.click(submitButton());

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].color).toBe('#DC2626');
  });

  it('normalises a non-hex colour on load, and says it did', async () => {
    update.mockResolvedValue({ success: true, data: {} } as never);
    const { user } = await mount({ ...EXISTING, color: 'not-a-hex' });

    await waitFor(() => expect(nameInput()).toHaveValue('Atlas Rollout'));
    // Stated before the save, not discovered after it: the swatch row shows the
    // substitution rather than silently posting a colour the user never picked.
    expect(screen.getByTestId('project-form-color-normalised')).toBeVisible();

    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].color).toBe('#00358F');
    expect(update.mock.calls[0][1].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('leaves a valid stored hex alone, even one that is not among the ten', async () => {
    // Normalising is about what the server would REFUSE, not about narrowing
    // the field to this form's palette. `#123ABC` is a legal colour that this
    // picker cannot produce; re-committing it verbatim is correct, and nothing
    // is claimed about it on screen.
    update.mockResolvedValue({ success: true, data: {} } as never);
    const { user } = await mount({ ...EXISTING, color: '#123ABC' });

    await waitFor(() => expect(nameInput()).toHaveValue('Atlas Rollout'));
    expect(screen.queryByTestId('project-form-color-normalised')).not.toBeInTheDocument();

    await user.click(submitButton());

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].color).toBe('#123ABC');
  });

  it('surfaces a colour refusal from the server against the form, not as a mystery', async () => {
    // The belt to the braces. If a bad value ever reaches the wire by another
    // path, the reason the save failed is the server's own sentence — reachable
    // only because the flat `ApiError` is read through `apiErrorMessage` (R73).
    const { user } = await mount(EXISTING);
    update.mockRejectedValue({
      statusCode: 400,
      message: 'color must be a valid hex colour, e.g. #00358F',
    });

    await waitFor(() => expect(nameInput()).toHaveValue('Atlas Rollout'));
    await user.click(submitButton());

    await waitFor(() =>
      expect(screen.getByTestId('project-form-error')).toHaveTextContent(
        'color must be a valid hex colour',
      ),
    );
  });
});
