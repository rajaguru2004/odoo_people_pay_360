import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import { useAuthStore } from '@/store/authStore';
import { usePageHeaderStore } from '@/store/pageHeaderStore';
import MigratePage from './page';

/**
 * Migrating a legacy bank profile onto the validated bank-detail model.
 *
 * This screen has no fixed form. Every input on it comes from
 * `bankingConfigService.fields(country)` — an admin-editable table — so what a
 * user sees is a projection of configuration, and the things worth defending
 * are the projection rules: one control per configured row, in the order the
 * config gives them, marked required where the config says so, and a country
 * picker that appears only when there is genuinely a choice to make.
 *
 * The case that earns this file, though, is the failure path. The server
 * answers a bad account with `{ message, errors: { iban: '…' } }` and
 * `lib/axios.ts` rejects with a FLAT object whose body sits under `details` —
 * so the natural `e.response.data.errors` reads undefined and the whole refusal
 * degrades to "Failed to migrate". A bank rejects an ENTIRE wage file over one
 * mistyped digit; the sentence naming which field is wrong is not a nicety, it
 * is the only actionable part of the answer. `apiErrorBody()` is what keeps it,
 * and the stubs below reject with the real flat shape so that stays proven.
 */

vi.mock('@/services/bankChangeService', () => ({
  default: {
    migrationCandidates: vi.fn(),
    migrate: vi.fn(),
  },
}));

vi.mock('@/services/bankService', () => ({
  default: { getAll: vi.fn() },
}));

vi.mock('@/services/bankingConfigService', () => ({
  default: { fields: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

import bankChangeService from '@/services/bankChangeService';
import bankService from '@/services/bankService';
import bankingConfigService from '@/services/bankingConfigService';
import { toast } from 'sonner';

const migrationCandidates = vi.mocked(bankChangeService.migrationCandidates);
const migrate = vi.mocked(bankChangeService.migrate);
const listBanks = vi.mocked(bankService.getAll);
const fields = vi.mocked(bankingConfigService.fields);
const toastError = vi.mocked(toast.error);
const toastSuccess = vi.mocked(toast.success);
const toastWarning = vi.mocked(toast.warning);

/**
 * Oman's configured fields, in `displayOrder`, as the API returns them.
 *
 * The keys are deliberately not in alphabetical order relative to the display
 * order (`accountHolderName`, `iban`, `bankBranch`), so a page that re-sorted
 * by key or by label would produce a visibly different sequence.
 */
const OM_FIELDS = [
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
  {
    fieldKey: 'bankBranch',
    label: 'Branch Name',
    fieldType: 'TEXT',
    validationType: 'NONE',
    required: false,
    displayOrder: 3,
    isSensitive: false,
  },
];

/** A different country config, so a country switch is visible in the DOM. */
const AE_FIELDS = [
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
    fieldKey: 'routingCode',
    label: 'Routing Code',
    fieldType: 'TEXT',
    validationType: 'ROUTING',
    required: true,
    displayOrder: 2,
    isSensitive: false,
  },
];

const BANKS = [
  { id: 'bank-om-1', country: 'OM', name: 'Bank Muscat', bankCode: '001', swift: null, isActive: true },
  { id: 'bank-om-2', country: 'OM', name: 'Sohar International', bankCode: '002', swift: null, isActive: true },
  { id: 'bank-ae-1', country: 'AE', name: 'Emirates NBD', bankCode: '033', swift: null, isActive: true },
];

/** One allowed banking country: nothing to choose, so nothing is asked. */
const ONE_COUNTRY = {
  id: 'emp-1',
  fullName: 'Ada Lovelace',
  employeeCode: 'E-001',
  branchId: 'br-ho',
  countries: ['OM'],
  profile: {
    bankName: 'Legacy Bank',
    bankBranch: 'Ruwi',
    bankAccountNumber: '1112223334',
    bankAccountHolderName: 'ADA B LOVELACE',
  },
};

/** Two allowed countries: the picker has to appear. */
const TWO_COUNTRIES = {
  id: 'emp-2',
  fullName: 'Grace Hopper',
  employeeCode: 'E-002',
  branchId: 'br-ho',
  countries: ['OM', 'AE'],
  profile: { bankAccountHolderName: null },
};

/** A branch nobody configured banking countries for. */
const NO_COUNTRIES = {
  id: 'emp-3',
  fullName: 'Alan Turing',
  employeeCode: 'E-003',
  branchId: 'br-dub',
  countries: [],
  profile: {},
};

/** Exactly what `lib/axios.ts` puts on the rejection path — flat, body under `details`. */
function rejectedWith(statusCode: number, body: Record<string, unknown> | null) {
  return {
    success: false,
    statusCode,
    message: body?.message ?? 'An error occurred',
    timestamp: '2026-08-16T00:00:00.000Z',
    path: '/bank-change-requests/migration',
    errors: body?.errors ?? null,
    details: body,
  };
}

const IBAN_REFUSAL =
  'IBAN check digits are invalid — a character is mistyped or transposed';
const VALID_IBAN = 'OM810180000001299123456';

const fieldInputs = () =>
  Array.from(
    document.querySelectorAll('[data-testid^="migrate-field-"]'),
  ) as HTMLInputElement[];

const fieldKeysOnScreen = () =>
  fieldInputs().map((i) => i.getAttribute('data-testid')!.replace('migrate-field-', ''));

const valueOf = (testId: string) =>
  (screen.getByTestId(testId) as HTMLInputElement | HTMLSelectElement).value;

/** Renders the queue as HR and waits for the first paint after the load settles. */
async function renderQueue(
  candidates: unknown[] = [ONE_COUNTRY],
  opts: { role?: 'ADMIN' | 'HR_MANAGER' } = {},
) {
  migrationCandidates.mockResolvedValue({ success: true, data: candidates } as never);
  const result = renderWithProviders(<MigratePage />, { role: opts.role ?? 'HR_MANAGER' });
  await waitFor(() =>
    expect(
      document.querySelector('[data-testid="migrate-row"], [data-testid="migrate-empty"]'),
      'the queue should have finished loading',
    ).not.toBeNull(),
  );
  return result;
}

const rowFor = (employeeId: string) =>
  document.querySelector(`[data-testid="migrate-row"][data-employee-id="${employeeId}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  // `renderWithProviders` seeds the user but not `hasHydrated`, which belongs to
  // the persist middleware. Without it `ProtectedRoute` stays in its `pending`
  // verdict and renders nothing at all.
  useAuthStore.setState({ hasHydrated: true });
  migrationCandidates.mockResolvedValue({ success: true, data: [ONE_COUNTRY] } as never);
  listBanks.mockResolvedValue({ success: true, data: BANKS } as never);
  fields.mockImplementation(async (country: string) =>
    ({ success: true, data: country === 'AE' ? AE_FIELDS : OM_FIELDS }) as never,
  );
  migrate.mockResolvedValue({ success: true, data: { id: 'bd-1' } } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('who the screen is for', () => {
  it('shows the migration queue to HR, who runs it', async () => {
    await renderQueue();
    // The screen no longer paints its own <h1>: the dashboard has one heading
    // slot, in TopHeader, and the page declares its title to it through
    // `usePageHeader`. TopHeader renders outside this tree, so the title is
    // read from that store rather than from the DOM.
    expect(
      usePageHeaderStore.getState().entry?.title,
      'HR is one of the two roles the guard admits',
    ).toBe('Bank Detail Migration');
    expect(
      document.querySelector('[data-testid="migrate-row"]'),
      'and it is the queue that renders, not a refusal',
    ).not.toBeNull();
  });

  it.each(['EMPLOYEE', 'MANAGER'] as const)(
    'sends %s to the forbidden page without asking the server for anybody’s bank profile',
    async (role) => {
      // The queue lists every employee's legacy account details. A denied role
      // must not merely be unable to act on it — the request must never leave.
      renderWithProviders(<MigratePage />, { role });

      await waitFor(() =>
        expect(routerMock.replace, 'a denied role is moved to /403').toHaveBeenCalledWith('/403'),
      );
      expect(
        migrationCandidates,
        'the guard has to refuse before the fetch, not after it',
      ).not.toHaveBeenCalled();
    },
  );
});

describe('the form is built from the country’s field configuration', () => {
  it('renders one control per configured field and nothing else', async () => {
    await renderQueue();
    expect(
      fieldKeysOnScreen(),
      'the row is exactly the config, with nothing invented and nothing dropped',
    ).toEqual(['accountHolderName', 'iban', 'bankBranch']);
  });

  it('keeps the configured display order instead of sorting the keys', async () => {
    // Alphabetically the keys are accountHolderName, bankBranch, iban. The
    // config says accountHolderName, iban, bankBranch — and that is what a user
    // filling the row from a bank letter expects to meet.
    await renderQueue();
    expect(
      fieldKeysOnScreen(),
      'a page that sorted its own fields would produce this instead',
    ).not.toEqual([...fieldKeysOnScreen()].sort());
    expect(fieldKeysOnScreen()[1], 'IBAN is second because displayOrder says so').toBe('iban');
  });

  it('marks a required field and leaves an optional one unmarked', async () => {
    await renderQueue();
    expect(
      screen.getByTestId('migrate-field-iban'),
      'a required field carries the asterisk',
    ).toHaveAttribute('placeholder', 'IBAN *');
    expect(
      screen.getByTestId('migrate-field-bankBranch'),
      'an optional field must not be marked required',
    ).toHaveAttribute('placeholder', 'Branch Name');
  });

  it('carries the legacy account-holder name forward, because it is the one value already known', async () => {
    await renderQueue();
    expect(
      valueOf('migrate-field-accountHolderName'),
      'the legacy profile already holds the name; re-typing it invites a typo',
    ).toBe('ADA B LOVELACE');
  });

  it('falls back to the employee’s own name when the legacy profile has no holder', async () => {
    await renderQueue([{ ...ONE_COUNTRY, profile: {} }]);
    expect(
      valueOf('migrate-field-accountHolderName'),
      'a blank legacy holder must not leave a required field empty',
    ).toBe('Ada Lovelace');
  });

  it('asks for a field configuration once per distinct banking country', async () => {
    // Two candidates, three country slots, two distinct countries.
    await renderQueue([ONE_COUNTRY, TWO_COUNTRIES]);
    expect(fields, 'one lookup per country, not per candidate').toHaveBeenCalledTimes(2);
    expect(
      fields.mock.calls.map(([c]) => c).sort(),
      'and both countries in play are looked up',
    ).toEqual(['AE', 'OM']);
  });

  it('says a country has no fields rather than offering an empty row', async () => {
    fields.mockResolvedValue({ success: true, data: [] } as never);
    await renderQueue();
    expect(
      screen.getByText('No fields configured for OM.'),
      'the reason has to name the country, since that is what an admin fixes',
    ).toBeInTheDocument();
    expect(fieldInputs(), 'and there is nothing to type into').toHaveLength(0);
  });

  it('treats a failed field lookup as no fields, not as a broken page', async () => {
    // The load catches per country on purpose: one misconfigured country must
    // not take the whole queue down with it.
    fields.mockRejectedValue(rejectedWith(500, { message: 'boom' }));
    await renderQueue();
    expect(
      screen.getByText('No fields configured for OM.'),
      'a 500 on one country degrades that row, not the screen',
    ).toBeInTheDocument();
  });

  it('says a country has no banks rather than offering an empty picker', async () => {
    listBanks.mockResolvedValue({ success: true, data: [] } as never);
    await renderQueue();
    expect(
      screen.getByText('No banks configured for OM.'),
      'fields without a bank to attach them to cannot be submitted',
    ).toBeInTheDocument();
  });
});

describe('choosing the banking country', () => {
  it('offers no country picker when the branch allows exactly one', async () => {
    await renderQueue();
    expect(
      screen.queryByTestId('migrate-country'),
      'there is no choice, so there is no question',
    ).toBeNull();
  });

  it('pre-selects that single country, so the fields are ready immediately', async () => {
    await renderQueue();
    expect(
      screen.getByTestId('migrate-bank'),
      'the bank picker only appears once a country is settled',
    ).toBeInTheDocument();
    expect(fieldKeysOnScreen(), 'and the country’s fields are already drawn').toHaveLength(3);
  });

  it('offers a country picker when the branch allows more than one', async () => {
    await renderQueue([TWO_COUNTRIES]);
    const picker = screen.getByTestId('migrate-country') as HTMLSelectElement;
    expect(
      Array.from(picker.options).map((o) => o.value),
      'the branch’s two countries, behind an unset placeholder',
    ).toEqual(['', 'OM', 'AE']);
  });

  it('asks nothing until a country is picked', async () => {
    await renderQueue([TWO_COUNTRIES]);
    expect(
      screen.queryByTestId('migrate-bank'),
      'which banks are valid depends on the country',
    ).toBeNull();
    expect(fieldInputs(), 'and so does which fields exist').toHaveLength(0);
  });

  it('lists only the banks of the chosen country', async () => {
    const { user } = await renderQueue([TWO_COUNTRIES]);
    await user.selectOptions(screen.getByTestId('migrate-country'), 'AE');

    const banks = screen.getByTestId('migrate-bank') as HTMLSelectElement;
    expect(
      Array.from(banks.options).map((o) => o.value).filter(Boolean),
      'an Omani bank cannot hold a UAE account',
    ).toEqual(['bank-ae-1']);
  });

  it('rebuilds the fields when the country changes', async () => {
    const { user } = await renderQueue([TWO_COUNTRIES]);

    await user.selectOptions(screen.getByTestId('migrate-country'), 'OM');
    expect(fieldKeysOnScreen(), 'Oman’s configuration').toEqual([
      'accountHolderName',
      'iban',
      'bankBranch',
    ]);

    await user.selectOptions(screen.getByTestId('migrate-country'), 'AE');
    expect(
      fieldKeysOnScreen(),
      'a different country is a different form, not the same one relabelled',
    ).toEqual(['accountHolderName', 'routingCode']);
  });

  it('drops a bank chosen under the previous country', async () => {
    // Keeping it would post a UAE account against an Omani bank — the exact
    // mismatch the server refuses with "Selected bank is for OM, not…".
    const { user } = await renderQueue([TWO_COUNTRIES]);
    await user.selectOptions(screen.getByTestId('migrate-country'), 'OM');
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');

    await user.selectOptions(screen.getByTestId('migrate-country'), 'AE');
    expect(
      valueOf('migrate-bank'),
      'a bank from the old country must not survive the switch',
    ).toBe('');
  });

  it('offers nothing to migrate when the branch has no banking countries at all', async () => {
    await renderQueue([NO_COUNTRIES]);
    expect(
      screen.getByText(/No banking countries set for this branch/i),
      'the row explains what an admin has to configure first',
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('migrate-submit'),
      'and offers no submit, because nothing could be valid',
    ).toBeNull();
  });
});

describe('what the row refuses to send', () => {
  it('will not submit until both a country and a bank are chosen', async () => {
    // These two are guarded by a disabled control rather than by a message, so
    // the page's own 'Select a country' / 'Select a bank' warnings are never
    // reached through the UI. Recorded, not deleted: they are the only defence
    // if the button is ever enabled or the row submitted programmatically.
    const { user } = await renderQueue([TWO_COUNTRIES]);
    expect(
      screen.getByTestId('migrate-submit'),
      'nothing is chosen yet, so nothing can be sent',
    ).toBeDisabled();

    await user.selectOptions(screen.getByTestId('migrate-country'), 'OM');
    expect(
      screen.getByTestId('migrate-submit'),
      'a country alone is not enough — the account still has no bank',
    ).toBeDisabled();

    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    expect(
      screen.getByTestId('migrate-submit'),
      'country plus bank is the minimum a migration needs',
    ).toBeEnabled();
  });

  it('names the empty required field rather than refusing in general', async () => {
    // 'IBAN is required' tells the user where to look. 'Please complete the
    // form' does not, and this row can carry four or five configured fields.
    const { user } = await renderQueue();
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.click(screen.getByTestId('migrate-submit'));

    await waitFor(() =>
      expect(toastWarning, 'the refusal must name the field').toHaveBeenCalledWith(
        'IBAN is required',
      ),
    );
    expect(migrate, 'and nothing is sent').not.toHaveBeenCalled();
  });

  it('names whichever required field is empty, not always the same one', async () => {
    const { user } = await renderQueue();
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.clear(screen.getByTestId('migrate-field-accountHolderName'));
    await user.type(screen.getByTestId('migrate-field-iban'), VALID_IBAN);
    await user.click(screen.getByTestId('migrate-submit'));

    await waitFor(() =>
      expect(
        toastWarning,
        'the label comes from the config row, so any configured field can be named',
      ).toHaveBeenCalledWith('Account Holder Name is required'),
    );
    expect(migrate, 'and nothing is sent').not.toHaveBeenCalled();
  });

  it('treats whitespace in a required field as empty', async () => {
    const { user } = await renderQueue();
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.type(screen.getByTestId('migrate-field-iban'), '   ');
    await user.click(screen.getByTestId('migrate-submit'));

    await waitFor(() =>
      expect(toastWarning, 'three spaces are not an IBAN').toHaveBeenCalledWith(
        'IBAN is required',
      ),
    );
    expect(migrate, 'and nothing is sent').not.toHaveBeenCalled();
  });

  it('lets an optional field through empty', async () => {
    const { user } = await renderQueue();
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.type(screen.getByTestId('migrate-field-iban'), VALID_IBAN);
    await user.click(screen.getByTestId('migrate-submit'));

    await waitFor(() =>
      expect(
        migrate,
        'an unmarked field is genuinely optional, not required-by-accident',
      ).toHaveBeenCalledTimes(1),
    );
  });
});

describe('what it sends, and what happens after', () => {
  async function fillAndSubmit(user: ReturnType<typeof renderWithProviders>['user']) {
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.type(screen.getByTestId('migrate-field-iban'), VALID_IBAN);
    await user.type(screen.getByTestId('migrate-field-bankBranch'), 'Ruwi');
    await user.click(screen.getByTestId('migrate-submit'));
  }

  it('posts the employee, the bank, and one entry per configured field', async () => {
    const { user } = await renderQueue();
    await fillAndSubmit(user);

    await waitFor(() => expect(migrate, 'exactly one call').toHaveBeenCalledTimes(1));
    expect(migrate, 'the payload shape the migration endpoint accepts').toHaveBeenCalledWith({
      employeeId: 'emp-1',
      bankId: 'bank-om-1',
      data: {
        accountHolderName: 'ADA B LOVELACE',
        iban: VALID_IBAN,
        bankBranch: 'Ruwi',
      },
    });
  });

  it('keys the payload by field key, so an admin renaming a label changes nothing', async () => {
    // The label is presentation; `fieldKey` is the contract with the server.
    const { user } = await renderQueue();
    await fillAndSubmit(user);

    await waitFor(() => expect(migrate, 'exactly one call').toHaveBeenCalledTimes(1));
    const [payload] = migrate.mock.calls[0] as [{ data: Record<string, string> }];
    expect(
      Object.keys(payload.data),
      '`data` is keyed by fieldKey, never by the displayed label',
    ).toEqual(OM_FIELDS.map((f) => f.fieldKey));
  });

  it('takes the migrated employee off the queue and says who moved', async () => {
    const { user } = await renderQueue([ONE_COUNTRY, NO_COUNTRIES]);
    await fillAndSubmit(user);

    await waitFor(() =>
      expect(toastSuccess, 'the confirmation names the person').toHaveBeenCalledWith(
        'Ada Lovelace migrated',
      ),
    );
    expect(rowFor('emp-1'), 'a migrated employee is no longer a candidate').toBeNull();
    expect(rowFor('emp-3'), 'and nobody else is touched').not.toBeNull();
  });
});

describe('when the server refuses the account', () => {
  async function submitAndFail(rejection: unknown) {
    migrate.mockRejectedValue(rejection);
    const { user } = await renderQueue();
    await user.selectOptions(screen.getByTestId('migrate-bank'), 'bank-om-1');
    await user.type(screen.getByTestId('migrate-field-iban'), 'OM810180000001299123400');
    await user.click(screen.getByTestId('migrate-submit'));
    await waitFor(() =>
      expect(toastError, 'a refusal has to reach the user somehow').toHaveBeenCalled(),
    );
    return user;
  }

  it('shows the sentence naming the field, not a generic failure', async () => {
    // THE case in this file. `{ errors: { iban: … } }` arrives under `details`
    // on a flat rejection, so the natural `e.response.data.errors` reads
    // undefined — which is how this screen used to answer a transposed digit
    // with "Failed to migrate". The assertion is an EXACT match on purpose: the
    // user must get the actionable sentence itself, not a summary with it
    // appended somewhere ("Bank details validation failed — iban: …").
    await submitAndFail(
      rejectedWith(400, {
        message: 'Bank details validation failed',
        errors: { iban: IBAN_REFUSAL },
      }),
    );

    expect(
      toastError,
      'the per-field sentence is the whole value of the refusal',
    ).toHaveBeenCalledWith(IBAN_REFUSAL);
    expect(toastError, 'the fallback must lose to a real answer').not.toHaveBeenCalledWith(
      'Failed to migrate',
    );
  });

  it('shows every refused field, so a second attempt is not a second guess', async () => {
    await submitAndFail(
      rejectedWith(400, {
        message: 'Bank details validation failed',
        errors: {
          iban: IBAN_REFUSAL,
          accountHolderName: 'Account Holder Name is required',
        },
      }),
    );

    expect(
      toastError,
      'showing one of two refusals costs the user another round trip',
    ).toHaveBeenCalledWith(`${IBAN_REFUSAL}\nAccount Holder Name is required`);
  });

  it('shows the server’s sentence when the refusal names no field', async () => {
    // A payroll lock is about the request, not about a value on the form.
    await submitAndFail(
      rejectedWith(409, {
        message: 'Bank details are locked while a payroll run is in progress',
      }),
    );

    expect(
      toastError,
      'no field map means the sentence is the answer',
    ).toHaveBeenCalledWith('Bank details are locked while a payroll run is in progress');
  });

  it('uses its own words only when the server said nothing at all', async () => {
    await submitAndFail({});
    expect(
      toastError,
      'the fallback is correct here, and only here',
    ).toHaveBeenCalledWith('Failed to migrate');
  });

  it('keeps the row and re-enables it, so the value can be corrected and retried', async () => {
    await submitAndFail(
      rejectedWith(400, {
        message: 'Bank details validation failed',
        errors: { iban: IBAN_REFUSAL },
      }),
    );

    expect(rowFor('emp-1'), 'a refused migration has not happened').not.toBeNull();
    expect(
      screen.getByTestId('migrate-submit'),
      'the row must be retryable, not stuck saving',
    ).toBeEnabled();
    expect(
      valueOf('migrate-field-iban'),
      'the typed value survives, so only the wrong character has to change',
    ).toBe('OM810180000001299123400');
  });
});

describe('loading the queue', () => {
  it('says the queue is empty rather than showing a blank page', async () => {
    await renderQueue([]);
    expect(
      screen.getByTestId('migrate-empty'),
      '"nothing left to migrate" and "failed to load" must look different',
    ).toBeInTheDocument();
  });

  it('reports a failed load with the server’s own reason', async () => {
    migrationCandidates.mockRejectedValue(
      rejectedWith(403, { message: 'Branch scope does not include this employee' }),
    );
    renderWithProviders(<MigratePage />, { role: 'HR_MANAGER' });

    await waitFor(() =>
      expect(
        toastError,
        'a scoping refusal is actionable; "Failed to load migration data" is not',
      ).toHaveBeenCalledWith('Branch scope does not include this employee'),
    );
  });
});

describe('the developer autofill', () => {
  it('is offered in a development build', async () => {
    await renderQueue();
    expect(
      screen.getByTestId('migrate-autofill'),
      'the tool exists locally, where hand-typing a valid IBAN is otherwise impossible',
    ).toBeInTheDocument();
  });

  it('does not exist in a production build', async () => {
    // `isDevMode()` reads `process.env.NODE_ENV`, which Next folds at build
    // time — so in a real deployment the button and its generator are removed
    // by dead-code elimination rather than merely hidden. Nothing runtime-
    // configurable may be allowed to bring it back.
    vi.stubEnv('NODE_ENV', 'production');
    await renderQueue();

    expect(
      screen.queryByTestId('migrate-autofill'),
      'a production build must not carry a button that invents bank details',
    ).toBeNull();
    expect(
      screen.getByTestId('migrate-submit'),
      'the real control is untouched',
    ).toBeInTheDocument();
  });

  it('fills every required field with a value built to pass validation', async () => {
    const { user } = await renderQueue();
    await user.click(screen.getByTestId('migrate-autofill'));

    await waitFor(() =>
      expect(
        valueOf('migrate-field-iban'),
        'a 23-character Omani IBAN, not a placeholder string',
      ).toMatch(/^OM\d{21}$/),
    );
    expect(
      valueOf('migrate-bank'),
      'it picks a bank too, because the IBAN has to carry that bank’s code',
    ).toBe('bank-om-1');
    expect(
      screen.getByTestId('migrate-submit'),
      'the point of the tool is that the row becomes submittable',
    ).toBeEnabled();
  });

  it('refuses to guess when no country has been chosen', async () => {
    const { user } = await renderQueue([TWO_COUNTRIES]);
    await user.click(screen.getByTestId('migrate-autofill'));

    expect(
      toastWarning,
      'the IBAN format is country-specific, so there is nothing to generate yet',
    ).toHaveBeenCalledWith('Select a country first');
    expect(fieldInputs(), 'and nothing was written').toHaveLength(0);
  });
});

describe('several candidates at once', () => {
  it('keeps each row’s answers to itself', async () => {
    // One shared `rows` map keyed by employee id. A patch that leaked would
    // migrate one person's account onto another's record.
    const { user } = await renderQueue([ONE_COUNTRY, TWO_COUNTRIES]);

    const first = within(rowFor('emp-1'));
    await user.selectOptions(first.getByTestId('migrate-bank'), 'bank-om-2');
    await user.type(first.getByTestId('migrate-field-iban'), VALID_IBAN);

    const second = within(rowFor('emp-2'));
    expect(
      second.queryByTestId('migrate-bank'),
      'the second row is untouched and still has no country',
    ).toBeNull();
    await user.selectOptions(second.getByTestId('migrate-country'), 'AE');
    expect(
      (second.getByTestId('migrate-bank') as HTMLSelectElement).value,
      'and picks up no bank from its neighbour',
    ).toBe('');

    expect(
      (first.getByTestId('migrate-field-iban') as HTMLInputElement).value,
      'the first row kept what was typed into it',
    ).toBe(VALID_IBAN);
  });
});
