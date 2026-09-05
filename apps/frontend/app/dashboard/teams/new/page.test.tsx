import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import NewTeamPage from './page';

/**
 * Creating an org team.
 *
 * This screen is the odd one out in People and worth pinning for that reason
 * alone: it has no `ProtectedRoute`, it validates with `window.alert` instead
 * of inline errors, and it reports server refusals the same way. It is also
 * unreachable from the sidebar — the sidebar's "Teams" points at
 * `/dashboard/supervisor-teams`, a different feature on a different model.
 *
 * Two things are asserted as they BEHAVE rather than as they read:
 *
 *  - the handler opens with an `alert()`-based required-fields check that no
 *    user ever sees, because the same three controls are natively `required`
 *    and the browser refuses the submit first;
 *  - the failure path used to read `error.response?.data?.message`, which this
 *    app's axios interceptor never populates (it rejects with a flat object),
 *    so every refusal read the same. It now uses `getApiErrorMessage`.
 */

vi.mock('@/services/teamService', () => ({
  default: { create: vi.fn(), getAll: vi.fn() },
}));

vi.mock('@/services/departmentService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/services/employeeService', () => ({
  default: { getAll: vi.fn() },
}));

import teamService from '@/services/teamService';
import departmentService from '@/services/departmentService';
import employeeService from '@/services/employeeService';

const create = vi.mocked(teamService.create);

const DEPARTMENTS = [
  { id: 'dept-1', code: 'ENG', name: 'Engineering', isActive: true },
  { id: 'dept-2', code: 'OPS', name: 'Operations', isActive: true },
  // Inactive departments must not be offered — the server refuses them.
  { id: 'dept-3', code: 'OLD', name: 'Retired', isActive: false },
];

const EMPLOYEES = [
  {
    id: 'emp-1',
    fullName: 'Ada Lovelace',
    position: 'Engineer',
    departmentId: 'dept-1',
    status: 'ACTIVE',
  },
  {
    id: 'emp-2',
    fullName: 'Grace Hopper',
    position: 'Engineer',
    departmentId: 'dept-2',
    status: 'ACTIVE',
  },
];

describe('New team page', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(departmentService.getAll).mockResolvedValue({
      success: true,
      data: DEPARTMENTS,
    } as never);
    vi.mocked(employeeService.getAll).mockResolvedValue({
      success: true,
      data: EMPLOYEES,
    } as never);
    create.mockResolvedValue({ success: true, data: { id: 'team-1' } } as never);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  /**
   * Waits for the fetched data, not merely for the control.
   *
   * The department `<select>` is in the DOM on the first render, holding only
   * its placeholder, so waiting for the element proves nothing: it is already
   * there before `fetchData()` resolves. Every case here then selects
   * 'dept-1', and selecting an option that has not arrived yet fails. It
   * usually did arrive first — the mocked promise settles in a microtask — but
   * under a loaded worker it did not, which is exactly the shape of an
   * intermittent failure. Waiting for the OPTIONS removes the race.
   */
  const waitForOptions = async () => {
    await waitFor(() => {
      const select = screen.getByTestId('team-form-department') as HTMLSelectElement;
      expect(Array.from(select.options).some((o) => o.value === 'dept-1')).toBe(true);
    });
  };

  const fill = async (
    user: ReturnType<typeof renderWithProviders>['user'],
    over: Partial<{ name: string; code: string; departmentId: string }> = {},
  ) => {
    const v = { name: 'Backend', code: 'ENG-BE', departmentId: 'dept-1', ...over };
    if (v.name) await user.type(screen.getByTestId('team-form-name'), v.name);
    if (v.code) await user.type(screen.getByTestId('team-form-code'), v.code);
    if (v.departmentId)
      await user.selectOptions(
        screen.getByTestId('team-form-department'),
        v.departmentId,
      );
  };

  describe('the validation it does', () => {
    it.each([
      ['name', { name: '' }],
      ['code', { code: '' }],
      ['department', { departmentId: '' }],
    ])('refuses to submit without a %s', async (_label, over) => {
      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await fill(user, over);
      await user.click(screen.getByTestId('team-form-submit'));

      // Nothing is sent — which is the rule that matters.
      await waitFor(() => expect(create).not.toHaveBeenCalled());
    });

    it('never reaches its own alert(), because the fields are natively required', () => {
      // `handleSubmit` opens with
      //   if (!name || !code || !departmentId) { alert(...); return; }
      // but all three controls carry `required`, so the browser refuses the
      // submit first and that branch is unreachable through the UI. Worth
      // recording rather than deleting: the alert is the only thing standing
      // between a future `noValidate` (or a programmatic submit) and a request
      // the server would reject — and a reader of the handler would reasonably
      // assume it is what users see today. They never do.
      renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      expect(screen.getByTestId('team-form-name')).toBeRequired();
      expect(screen.getByTestId('team-form-code')).toBeRequired();
      expect(screen.getByTestId('team-form-department')).toBeRequired();
    });
  });

  describe('what it offers', () => {
    it('offers only ACTIVE departments as a home for the team', async () => {
      renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      const select = screen.getByTestId(
        'team-form-department',
      ) as HTMLSelectElement;
      const values = Array.from(select.options)
        .map((o) => o.value)
        .filter(Boolean);
      expect(values).toEqual(['dept-1', 'dept-2']);
    });

    it('narrows the team lead to the chosen department, because the server requires it', async () => {
      // 'Team lead must belong to the same department' is a server rule; the
      // form has to agree or every save with a mismatched lead is a round trip
      // to a 400 the user could not have predicted.
      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await user.selectOptions(
        screen.getByTestId('team-form-department'),
        'dept-1',
      );

      const leads = screen.getByTestId('team-form-lead') as HTMLSelectElement;
      const values = Array.from(leads.options)
        .map((o) => o.value)
        .filter(Boolean);
      expect(values).toEqual(['emp-1']);
    });
  });

  describe('what it sends', () => {
    it('posts exactly the fields the create DTO accepts', async () => {
      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await fill(user);
      await user.click(screen.getByTestId('team-form-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toMatchObject({
        name: 'Backend',
        code: 'ENG-BE',
        departmentId: 'dept-1',
        type: 'PERMANENT',
      });
    });

    it('omits the optional fields rather than sending empty strings', async () => {
      // Was P36: the form posted its raw state, so `teamLeadId: ''` reached a
      // `@IsUUID()` validator and EVERY create without a lead answered
      // "teamLeadId must be a UUID" — while the label beside the control said
      // the lead was optional. Creating a team without one was impossible
      // through the UI.
      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await fill(user);
      await user.click(screen.getByTestId('team-form-submit'));

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(payload.teamLeadId).toBeUndefined();
      expect(payload.description).toBeUndefined();
    });

    it('upper-cases the code as the user types, so it matches what the server stores', async () => {
      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await fill(user, { code: 'eng-be' });
      expect(
        (screen.getByTestId('team-form-code') as HTMLInputElement).value,
      ).toBe('ENG-BE');
    });
  });

  describe('failure handling', () => {
    it('shows the server’s own reason, from the shape the interceptor really sends', async () => {
      // `lib/axios.ts` rejects with a FLAT object, so the old
      // `error.response?.data?.message` path was always undefined and a
      // duplicate code showed the same words as a network outage. It now uses
      // `getApiErrorMessage`. Asserted with the real shape — mocking an
      // AxiosError would prove only that a fictional error would work.
      create.mockRejectedValue({
        statusCode: 409,
        message: 'Team code already exists',
        errors: null,
      } as never);

      const { user } = renderWithProviders(<NewTeamPage />, { role: 'ADMIN' });
      await waitForOptions();
      await fill(user);
      await user.click(screen.getByTestId('team-form-submit'));

      await waitFor(() => expect(alertSpy).toHaveBeenCalled());
      expect(String(alertSpy.mock.calls.at(-1)?.[0] ?? '')).toContain(
        'Team code already exists',
      );
    });
  });
});
