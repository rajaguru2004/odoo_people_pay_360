import { ReactNode, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { FormProvider, useForm } from 'react-hook-form';
import { renderWithProviders, screen, within } from '@/test/render';
import { Field, FieldOptionSources } from './Field';
import type { TemplateField } from '@/types/profile-template';

/**
 * One template field, rendered.
 *
 * This component is the floor the whole employee form stands on: 17 field types
 * feeding create, edit, self-service and the onboarding wizard. A regression
 * here does not break one screen, it breaks every screen that edits a person —
 * and the interesting failures are quiet ones. A SELECT that falls through to a
 * text input still looks like a working form; it just accepts anything.
 *
 * `buildTemplateSchema` and `fieldValue` already cover the rules underneath.
 * What is tested here is only what rendering adds: which control appears, how
 * options resolve, how errors and read-only surface, and how values round-trip
 * into react-hook-form.
 */

/** Minimal valid field; every test overrides only what it is about. */
function makeField(overrides: Partial<TemplateField> = {}): TemplateField {
  return {
    id: 'f1',
    sectionKey: 'personal',
    fieldKey: 'fullName',
    label: 'Full Name',
    fieldType: 'TEXT',
    storage: 'COLUMN',
    boundColumn: 'fullName',
    validationType: 'NONE',
    regex: null,
    options: null,
    optionSource: null,
    required: false,
    displayOrder: 1,
    placeholder: null,
    helpText: null,
    defaultValue: null,
    colSpan: 1,
    isSensitive: false,
    minValue: null,
    maxValue: null,
    minLength: null,
    maxLength: null,
    visibleToRoles: [],
    editableByRoles: [],
    selfVisible: true,
    selfEditable: true,
    includeInCompletion: true,
    isActive: true,
    systemDeprecated: false,
    origin: 'SYSTEM',
    locked: false,
    systemRequired: false,
    lockReason: null,
    ...overrides,
  };
}

/**
 * Field reads from `useFormContext`, so it needs a real form around it. The
 * form's live values are exposed through `onValues` rather than returned,
 * because assertions happen after user interaction.
 */
function FormHarness({
  children,
  defaultValues = {},
  onValues,
  errors,
}: {
  children: ReactNode;
  defaultValues?: Record<string, unknown>;
  onValues?: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}) {
  const methods = useForm({ defaultValues });
  onValues?.(methods.watch() as Record<string, unknown>);

  // Seed errors imperatively — the point is Field's rendering of them, not the
  // resolver that produced them. In an effect, not in the render body: setError
  // triggers a re-render, and calling it inline loops forever.
  useEffect(() => {
    for (const [name, message] of Object.entries(errors ?? {})) {
      methods.setError(name, { message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <FormProvider {...methods}>{children}</FormProvider>;
}

function renderField(
  field: TemplateField,
  opts: {
    readOnly?: boolean;
    optionSources?: FieldOptionSources;
    namePrefix?: string;
    defaultValues?: Record<string, unknown>;
    errors?: Record<string, string>;
  } = {},
) {
  const values: { current: Record<string, unknown> } = { current: {} };
  const result = renderWithProviders(
    <FormHarness
      defaultValues={opts.defaultValues}
      errors={opts.errors}
      onValues={(v) => {
        values.current = v;
      }}
    >
      <Field
        field={field}
        readOnly={opts.readOnly}
        optionSources={opts.optionSources}
        namePrefix={opts.namePrefix}
      />
    </FormHarness>,
  );
  return { ...result, values };
}

describe('control selection per field type', () => {
  it('renders a text input for TEXT', () => {
    renderField(makeField({ fieldType: 'TEXT', placeholder: 'e.g. Jane Doe' }));
    const input = screen.getByPlaceholderText('e.g. Jane Doe');
    expect(input.tagName).toBe('INPUT');
    // No explicit type — the browser default. Asserted so a future change to
    // `type="text"` is noticed rather than assumed.
    expect(input).not.toHaveAttribute('type');
  });

  it('renders a textarea for TEXTAREA', () => {
    renderField(makeField({ fieldType: 'TEXTAREA', fieldKey: 'notes', label: 'Notes' }));
    expect(document.querySelector('textarea')).toBeInTheDocument();
  });

  it('renders a checkbox for BOOLEAN and no separate label element', () => {
    // BOOLEAN puts its label beside the box, so the standalone label is
    // deliberately suppressed. Restoring it would double the caption.
    renderField(makeField({ fieldType: 'BOOLEAN', fieldKey: 'isActive', label: 'Active' }));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(document.querySelectorAll('label').length).toBe(1);
  });

  it('renders a date input for DATE', () => {
    renderField(makeField({ fieldType: 'DATE', fieldKey: 'dateOfBirth', label: 'DOB' }));
    expect(document.querySelector('input[type="date"]')).toBeInTheDocument();
  });

  it('renders a datetime-local input for DATETIME', () => {
    renderField(makeField({ fieldType: 'DATETIME', fieldKey: 'startsAt', label: 'Starts' }));
    expect(document.querySelector('input[type="datetime-local"]')).toBeInTheDocument();
  });

  it('renders an email input for EMAIL', () => {
    renderField(makeField({ fieldType: 'EMAIL', fieldKey: 'email', label: 'Email' }));
    expect(document.querySelector('input[type="email"]')).toBeInTheDocument();
  });

  it('renders a tel input for PHONE', () => {
    renderField(makeField({ fieldType: 'PHONE', fieldKey: 'phone', label: 'Phone' }));
    expect(document.querySelector('input[type="tel"]')).toBeInTheDocument();
  });

  it('falls back to a text input for an unknown field type', () => {
    // A template written against a newer backend must still render something
    // editable rather than blanking the field.
    renderField(makeField({ fieldType: 'QUANTUM_FLUX', placeholder: 'still editable' }));
    expect(screen.getByPlaceholderText('still editable')).toBeInTheDocument();
  });
});

describe('numeric types', () => {
  it('steps NUMBER by 1', () => {
    renderField(makeField({ fieldType: 'NUMBER', fieldKey: 'headcount', label: 'Headcount' }));
    expect(document.querySelector('input[type="number"]')).toHaveAttribute('step', '1');
  });

  it.each(['DECIMAL', 'CURRENCY'])('steps %s by 0.01 so cents are reachable', (fieldType) => {
    // A CURRENCY column is Decimal(12,2); a step of 1 makes the spinner unable
    // to land on a valid amount.
    renderField(makeField({ fieldType, fieldKey: 'baseSalary', label: 'Salary' }));
    expect(document.querySelector('input[type="number"]')).toHaveAttribute('step', '0.01');
  });

  it('applies min and max when the template sets them', () => {
    renderField(makeField({ fieldType: 'NUMBER', minValue: 1, maxValue: 40 }));
    const input = document.querySelector('input[type="number"]')!;
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '40');
  });

  it('stores the value as a number, not a string', async () => {
    // Registered with `valueAsNumber`. A string here reaches the API as "5"
    // and fails a numeric DTO.
    const { user, values } = renderField(makeField({ fieldType: 'NUMBER', fieldKey: 'headcount' }));
    await user.type(document.querySelector('input[type="number"]')!, '5');
    expect(values.current.headcount).toBe(5);
  });
});

describe('select-shaped types', () => {
  const SELECT_TYPES = ['SELECT', 'LIBRARY_SELECT', 'DEPARTMENT_SELECT', 'BRANCH_SELECT', 'EMPLOYEE_SELECT'];

  it.each(SELECT_TYPES)('renders a real <select> for %s, never a text box', (fieldType) => {
    // The specific defect this component was written to fix: a declared SELECT
    // falling through to a free-text input, so the configured options do
    // nothing and any value is accepted.
    renderField(
      makeField({ fieldType, fieldKey: 'position', label: 'Position', options: [{ value: 'p1', label: 'Engineer' }] }),
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Engineer' })).toBeInTheDocument();
  });

  it('prefers the template’s static options over a live source', () => {
    renderField(
      makeField({
        fieldType: 'SELECT',
        fieldKey: 'position',
        options: [{ value: 'static', label: 'From template' }],
        optionSource: 'POSITION',
      }),
      { optionSources: { POSITION: [{ value: 'live', label: 'From source' }] } },
    );
    expect(screen.getByRole('option', { name: 'From template' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'From source' })).not.toBeInTheDocument();
  });

  it('resolves options by optionSource when the template lists none', () => {
    renderField(
      makeField({ fieldType: 'LIBRARY_SELECT', fieldKey: 'position', optionSource: 'POSITION', options: [] }),
      { optionSources: { POSITION: [{ value: 'p1', label: 'Engineer' }] } },
    );
    expect(screen.getByRole('option', { name: 'Engineer' })).toBeInTheDocument();
  });

  it.each([
    ['DEPARTMENT_SELECT', 'DEPARTMENT'],
    ['BRANCH_SELECT', 'BRANCH'],
    ['EMPLOYEE_SELECT', 'EMPLOYEE'],
  ])('%s implies the %s source without the template declaring it', (fieldType, source) => {
    renderField(makeField({ fieldType, fieldKey: 'someRelation', optionSource: null }), {
      optionSources: { [source]: [{ value: 'x1', label: 'Resolved' }] },
    });
    expect(screen.getByRole('option', { name: 'Resolved' })).toBeInTheDocument();
  });

  it('falls back to the fieldKey as the source, for one-off selects', () => {
    renderField(makeField({ fieldType: 'SELECT', fieldKey: 'overtimePolicyId', optionSource: null }), {
      optionSources: { overtimePolicyId: [{ value: 'op1', label: 'Company Default' }] },
    });
    expect(screen.getByRole('option', { name: 'Company Default' })).toBeInTheDocument();
  });

  it('renders an empty select — not a text box — when the source is unresolved', () => {
    // A misconfigured field must be visibly empty rather than silently
    // accepting free text.
    renderField(makeField({ fieldType: 'SELECT', fieldKey: 'position', optionSource: 'MISSING' }));
    const select = screen.getByRole('combobox');
    expect(within(select).getAllByRole('option')).toHaveLength(1); // the placeholder only
  });

  it('shows a generated placeholder option derived from the label', () => {
    renderField(makeField({ fieldType: 'SELECT', label: 'Position', fieldKey: 'position' }));
    expect(screen.getByRole('option', { name: 'Select position' })).toBeInTheDocument();
  });

  it('prefers an explicit placeholder over the generated one', () => {
    renderField(makeField({ fieldType: 'SELECT', label: 'Position', placeholder: 'Pick one' }));
    expect(screen.getByRole('option', { name: 'Pick one' })).toBeInTheDocument();
  });
});

describe('MULTISELECT', () => {
  const field = makeField({
    fieldType: 'MULTISELECT',
    fieldKey: 'skills',
    label: 'Skills',
    options: [
      { value: 'ts', label: 'TypeScript' },
      { value: 'go', label: 'Go' },
    ],
  });

  it('renders one toggle per option', () => {
    renderField(field);
    expect(screen.getByRole('button', { name: 'TypeScript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
  });

  it('accumulates selections as an array', async () => {
    const { user, values } = renderField(field);
    await user.click(screen.getByRole('button', { name: 'TypeScript' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(values.current.skills).toEqual(['ts', 'go']);
  });

  it('removes a selection when toggled again', async () => {
    const { user, values } = renderField(field, { defaultValues: { skills: ['ts', 'go'] } });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(values.current.skills).toEqual(['ts']);
  });

  it('tolerates a non-array stored value instead of crashing', async () => {
    // Legacy rows hold a comma string here; the control must not throw on read.
    const { values, user } = renderField(field, { defaultValues: { skills: 'ts,go' } });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(values.current.skills).toEqual(['go']);
  });

  it('says so when no options are configured', () => {
    renderField(makeField({ fieldType: 'MULTISELECT', fieldKey: 'skills', options: [] }));
    expect(screen.getByText('No options configured')).toBeInTheDocument();
  });

  it('disables the toggles when read-only', () => {
    renderField(field, { readOnly: true });
    expect(screen.getByRole('button', { name: 'TypeScript' })).toBeDisabled();
  });
});

describe('PHONE_COUNTRY', () => {
  const field = makeField({ fieldType: 'PHONE_COUNTRY', fieldKey: 'phoneCountry', label: 'Phone country' });

  it('offers a branch-default option rather than forcing a country', () => {
    renderField(field);
    expect(screen.getByRole('option', { name: 'Use branch default' })).toBeInTheDocument();
  });

  it('shows the dial code once a country is chosen', () => {
    // The live "+968" readout the hand-written form had; losing it would make
    // the field ambiguous for numbers stored without a prefix.
    renderField(field, { defaultValues: { phoneCountry: 'OM' } });
    expect(screen.getByText('Numbers will be dialled as +968')).toBeInTheDocument();
  });

  it('shows no dial readout while unset', () => {
    renderField(field);
    expect(screen.queryByText(/Numbers will be dialled/)).not.toBeInTheDocument();
  });
});

describe('FILE', () => {
  it('renders the upload widget, not a bare URL text box', () => {
    // A text input here meant "Photo" could only be filled by someone who had
    // already hosted the image elsewhere.
    renderField(makeField({ fieldType: 'FILE', fieldKey: 'passportScan', label: 'Passport' }));
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it.each(['avatarUrl', 'photoUrl', 'photo'])('previews %s as an image', (fieldKey) => {
    renderField(makeField({ fieldType: 'FILE', fieldKey, label: 'Photo' }), {
      defaultValues: { [fieldKey]: 'https://example.test/a.png' },
    });
    expect(document.querySelector('img')).toBeInTheDocument();
  });

  it('treats any other FILE field as a document, not a face', () => {
    renderField(makeField({ fieldType: 'FILE', fieldKey: 'passportScan' }), {
      defaultValues: { passportScan: 'https://example.test/scan.pdf' },
    });
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });
});

describe('label, required marker, help text and errors', () => {
  it('shows the label', () => {
    renderField(makeField({ label: 'Full Name' }));
    expect(screen.getByText('Full Name')).toBeInTheDocument();
  });

  it('marks a required field with an asterisk', () => {
    renderField(makeField({ label: 'Full Name', required: true }));
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('omits the asterisk when optional', () => {
    renderField(makeField({ label: 'Full Name', required: false }));
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('shows help text when there is no error', () => {
    renderField(makeField({ helpText: 'As it appears on the passport' }));
    expect(screen.getByText('As it appears on the passport')).toBeInTheDocument();
  });

  it('replaces help text with the error message, rather than stacking both', () => {
    // Two lines of small print under one input is how a validation message
    // gets missed.
    renderField(makeField({ fieldKey: 'fullName', helpText: 'As it appears on the passport' }), {
      errors: { fullName: 'Full name is required' },
    });
    expect(screen.getByText('Full name is required')).toBeInTheDocument();
    expect(screen.queryByText('As it appears on the passport')).not.toBeInTheDocument();
  });

  it('reads a nested error for a JSONB field', () => {
    // JSONB fields register as `customFields.<key>`, so the error lookup has to
    // walk the dotted path rather than index a flat map.
    renderField(makeField({ fieldKey: 'bloodGroup', storage: 'JSONB' }), {
      errors: { 'customFields.bloodGroup': 'Not a valid blood group' },
    });
    expect(screen.getByText('Not a valid blood group')).toBeInTheDocument();
  });
});

describe('storage and name binding', () => {
  it('registers a COLUMN field under its bare key', async () => {
    const { user, values } = renderField(makeField({ fieldKey: 'fullName', storage: 'COLUMN' }));
    await user.type(screen.getByRole('textbox'), 'Jane');
    expect(values.current.fullName).toBe('Jane');
  });

  it('registers a JSONB field under customFields', async () => {
    const { user, values } = renderField(makeField({ fieldKey: 'bloodGroup', storage: 'JSONB' }));
    await user.type(screen.getByRole('textbox'), 'O+');
    expect(values.current.customFields).toEqual({ bloodGroup: 'O+' });
  });

  it('honours a namePrefix for forms that nest the whole template', async () => {
    const { user, values } = renderField(makeField({ fieldKey: 'fullName' }), { namePrefix: 'employee' });
    await user.type(screen.getByRole('textbox'), 'Jane');
    expect(values.current.employee).toEqual({ fullName: 'Jane' });
  });
});

describe('read-only rendering', () => {
  it('marks a text input read-only', () => {
    renderField(makeField({ fieldType: 'TEXT' }), { readOnly: true });
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  });

  it('disables a select', () => {
    renderField(makeField({ fieldType: 'SELECT' }), { readOnly: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('disables a checkbox', () => {
    renderField(makeField({ fieldType: 'BOOLEAN' }), { readOnly: true });
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('refuses edits to a read-only input', async () => {
    // The locked/auto-generated case: employee code and ID card are filled by
    // the server, and a typed value would be discarded confusingly.
    const { user, values } = renderField(makeField({ fieldKey: 'employeeCode' }), { readOnly: true });
    await user.type(screen.getByRole('textbox'), 'HACK');
    expect(values.current.employeeCode ?? '').toBe('');
  });
});

describe('layout', () => {
  it('spans multiple grid columns when colSpan > 1', () => {
    const { container } = renderField(makeField({ colSpan: 2 }));
    expect((container.firstChild as HTMLElement).style.gridColumn).toBe('span 2');
  });

  it('sets no explicit span for a single-column field', () => {
    const { container } = renderField(makeField({ colSpan: 1 }));
    expect((container.firstChild as HTMLElement).style.gridColumn).toBe('');
  });
});

describe('BOOLEAN value handling', () => {
  it('stores a real boolean, not the checkbox event', async () => {
    const { user, values } = renderField(makeField({ fieldType: 'BOOLEAN', fieldKey: 'isActive' }));
    await user.click(screen.getByRole('checkbox'));
    expect(values.current.isActive).toBe(true);
  });

  it('coerces a truthy stored value into a checked box', () => {
    // Legacy rows hold 'true'/1 here rather than a boolean.
    renderField(makeField({ fieldType: 'BOOLEAN', fieldKey: 'isActive' }), {
      defaultValues: { isActive: 1 },
    });
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
