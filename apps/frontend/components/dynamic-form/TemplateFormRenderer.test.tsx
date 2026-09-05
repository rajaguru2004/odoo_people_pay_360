import { describe, expect, it, vi } from 'vitest';
import { FormProvider, useForm, UseFormReturn } from 'react-hook-form';
import { renderWithProviders, screen } from '@/test/render';
import { TemplateFormRenderer } from './TemplateFormRenderer';
import type { ResolvedTemplate, TemplateField, TemplateSection } from '@/types/profile-template';

/**
 * The template rendered as a form.
 *
 * Two things here have real consequences. `wizardStep` decides which sections
 * the onboarding wizard shows on each step — get it wrong and a required field
 * is never presented, so the user cannot pass a validation gate they cannot
 * see. And `isActive` decides whether a field exists at all: rendering a
 * deactivated field re-introduces a column an admin deliberately retired.
 *
 * The admin builder previews with this same component, so a divergence here
 * would also mean the preview stops matching what employees get.
 */

function makeField(overrides: Partial<TemplateField> = {}): TemplateField {
  return {
    id: null,
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

function makeSection(overrides: Partial<TemplateSection> = {}): TemplateSection {
  return {
    id: null,
    sectionKey: 'personal',
    label: 'Personal',
    icon: null,
    wizardStep: 1,
    columns: 2,
    displayOrder: 1,
    fields: [makeField()],
    ...overrides,
  };
}

function makeTemplate(sections: TemplateSection[]): ResolvedTemplate {
  return {
    templateId: 't1',
    source: 'COMPANY',
    scope: 'COMPANY',
    branchId: null,
    country: null,
    name: 'Default',
    fields: sections.flatMap((s) => s.fields),
    sections,
  } as ResolvedTemplate;
}

/** Owns the `useForm` the renderer is handed, mirroring the real page. */
function Harness({
  template,
  onForm,
  ...props
}: {
  template: ResolvedTemplate;
  onForm?: (form: UseFormReturn<Record<string, unknown>>) => void;
} & Omit<React.ComponentProps<typeof TemplateFormRenderer>, 'template' | 'form'>) {
  const form = useForm({ defaultValues: {} });
  onForm?.(form as UseFormReturn<Record<string, unknown>>);
  return <TemplateFormRenderer template={template} form={form} {...props} />;
}

describe('section rendering', () => {
  it('renders every section when no step is given', () => {
    const template = makeTemplate([
      makeSection({ sectionKey: 'personal', label: 'Personal', wizardStep: 1 }),
      makeSection({
        sectionKey: 'employment',
        label: 'Employment',
        wizardStep: 2,
        fields: [makeField({ fieldKey: 'position', label: 'Position' })],
      }),
    ]);

    renderWithProviders(<Harness template={template} />);

    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Employment')).toBeInTheDocument();
  });

  it('renders only the requested wizard step', () => {
    // The wizard's contract: step 2 must not leak step 1's inputs, or the
    // per-step `trigger()` validates fields the user was never shown.
    const template = makeTemplate([
      makeSection({ sectionKey: 'personal', label: 'Personal', wizardStep: 1 }),
      makeSection({
        sectionKey: 'employment',
        label: 'Employment',
        wizardStep: 2,
        fields: [makeField({ fieldKey: 'position', label: 'Position' })],
      }),
    ]);

    renderWithProviders(<Harness template={template} step={2} />);

    expect(screen.queryByText('Personal')).not.toBeInTheDocument();
    expect(screen.getByText('Employment')).toBeInTheDocument();
  });

  it('renders section labels in the order given', () => {
    const template = makeTemplate([
      makeSection({ sectionKey: 'a', label: 'Alpha' }),
      makeSection({ sectionKey: 'b', label: 'Beta', fields: [makeField({ fieldKey: 'b1' })] }),
    ]);

    renderWithProviders(<Harness template={template} />);

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Alpha', 'Beta']);
  });
});

describe('field activation', () => {
  it('omits a deactivated field', () => {
    // A retired field must disappear, not merely be ignored on submit.
    const template = makeTemplate([
      makeSection({
        fields: [
          makeField({ fieldKey: 'fullName', label: 'Full Name', isActive: true }),
          makeField({ fieldKey: 'nickname', label: 'Nickname', isActive: false }),
        ],
      }),
    ]);

    renderWithProviders(<Harness template={template} />);

    expect(screen.getByText('Full Name')).toBeInTheDocument();
    expect(screen.queryByText('Nickname')).not.toBeInTheDocument();
  });

  it('drops a section whose fields are all deactivated', () => {
    // Otherwise the form shows a heading over an empty grid.
    const template = makeTemplate([
      makeSection({ sectionKey: 'personal', label: 'Personal' }),
      makeSection({
        sectionKey: 'ghost',
        label: 'Ghost Section',
        fields: [makeField({ fieldKey: 'g1', isActive: false })],
      }),
    ]);

    renderWithProviders(<Harness template={template} />);

    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.queryByText('Ghost Section')).not.toBeInTheDocument();
  });

  it('explains an entirely empty form instead of showing a blank panel', () => {
    // Reachable when every field in a step is hidden from this role.
    const template = makeTemplate([
      makeSection({ fields: [makeField({ isActive: false })] }),
    ]);

    renderWithProviders(<Harness template={template} />);

    expect(screen.getByText('No fields are configured for you in this section.')).toBeInTheDocument();
  });

  it('explains an empty step even when other steps have fields', () => {
    const template = makeTemplate([
      makeSection({ sectionKey: 'personal', wizardStep: 1 }),
    ]);

    renderWithProviders(<Harness template={template} step={5} />);

    expect(screen.getByText('No fields are configured for you in this section.')).toBeInTheDocument();
  });
});

describe('read-only projection', () => {
  it('marks only the named fields read-only', () => {
    // Employee code and ID card are server-generated; the rest stay editable.
    const template = makeTemplate([
      makeSection({
        fields: [
          makeField({ fieldKey: 'employeeCode', label: 'Employee Code' }),
          makeField({ fieldKey: 'fullName', label: 'Full Name' }),
        ],
      }),
    ]);

    renderWithProviders(<Harness template={template} readOnlyFields={['employeeCode']} />);

    const [code, name] = screen.getAllByRole('textbox');
    expect(code).toHaveAttribute('readonly');
    expect(name).not.toHaveAttribute('readonly');
  });

  it('leaves everything editable when no read-only list is given', () => {
    const template = makeTemplate([makeSection()]);

    renderWithProviders(<Harness template={template} />);

    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
  });
});

describe('renderField escape hatch', () => {
  it('replaces the control for the named field only', () => {
    // Exists for the few fields with a bespoke widget — the grouped timezone
    // picker, for instance — without the generic renderer knowing about them.
    const template = makeTemplate([
      makeSection({
        fields: [
          makeField({ fieldKey: 'timezone', label: 'Timezone' }),
          makeField({ fieldKey: 'fullName', label: 'Full Name' }),
        ],
      }),
    ]);

    renderWithProviders(
      <Harness
        template={template}
        renderField={(f) => (f.fieldKey === 'timezone' ? <div>bespoke picker</div> : undefined)}
      />,
    );

    expect(screen.getByText('bespoke picker')).toBeInTheDocument();
    // The other field kept its default control.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('keeps the default control when the hook returns undefined', () => {
    const template = makeTemplate([makeSection()]);
    const renderField = vi.fn(() => undefined);

    renderWithProviders(<Harness template={template} renderField={renderField} />);

    expect(renderField).toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('honours colSpan on a replaced control', () => {
    const template = makeTemplate([
      makeSection({ fields: [makeField({ fieldKey: 'notes', colSpan: 2 })] }),
    ]);

    renderWithProviders(
      <Harness template={template} renderField={() => <div data-testid="custom">x</div>} />,
    );

    expect(screen.getByTestId('custom').parentElement!.style.gridColumn).toBe('span 2');
  });

  it('lets a hook render null to hide a field entirely', () => {
    // `null` is a value, so it wins over the default control — distinct from
    // `undefined`, which means "no opinion".
    const template = makeTemplate([makeSection()]);

    renderWithProviders(<Harness template={template} renderField={() => null} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('section footer', () => {
  it('renders a footer under each section', () => {
    const template = makeTemplate([
      makeSection({ sectionKey: 'a', label: 'Alpha' }),
      makeSection({ sectionKey: 'b', label: 'Beta', fields: [makeField({ fieldKey: 'b1' })] }),
    ]);

    renderWithProviders(
      <Harness template={template} renderSectionFooter={(s) => <p>footer for {s.sectionKey}</p>} />,
    );

    expect(screen.getByText('footer for a')).toBeInTheDocument();
    expect(screen.getByText('footer for b')).toBeInTheDocument();
  });

  it('renders no footer when the section was filtered out', () => {
    const template = makeTemplate([
      makeSection({ sectionKey: 'ghost', fields: [makeField({ isActive: false })] }),
    ]);

    renderWithProviders(
      <Harness template={template} renderSectionFooter={(s) => <p>footer for {s.sectionKey}</p>} />,
    );

    expect(screen.queryByText('footer for ghost')).not.toBeInTheDocument();
  });
});

describe('form provider wiring', () => {
  it('supplies its own FormProvider by default', () => {
    // Without one, Field's useFormContext returns null and the render throws.
    const template = makeTemplate([makeSection()]);
    expect(() => renderWithProviders(<Harness template={template} />)).not.toThrow();
  });

  it('can defer to a provider the page already owns', () => {
    function OuterProvider() {
      const form = useForm({ defaultValues: {} });
      return (
        <FormProvider {...form}>
          <TemplateFormRenderer template={makeTemplate([makeSection()])} form={form} withProvider={false} />
        </FormProvider>
      );
    }

    renderWithProviders(<OuterProvider />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('writes values into the page’s form instance', async () => {
    // The reason the renderer takes a `form` rather than making its own: the
    // page needs `trigger()`, `setError()` and the submitted values.
    let captured: UseFormReturn<Record<string, unknown>> | undefined;
    const template = makeTemplate([makeSection()]);

    const { user } = renderWithProviders(
      <Harness
        template={template}
        onForm={(f) => {
          captured = f;
        }}
      />,
    );

    await user.type(screen.getByRole('textbox'), 'Jane');

    expect(captured!.getValues('fullName')).toBe('Jane');
  });
});

describe('grid columns', () => {
  it.each([
    [1, 'grid-cols-1'],
    [2, 'md:grid-cols-2'],
    [3, 'md:grid-cols-3'],
    [4, 'md:grid-cols-4'],
  ])('lays a %i-column section out accordingly', (columns, expected) => {
    const template = makeTemplate([makeSection({ columns })]);
    const { container } = renderWithProviders(<Harness template={template} />);
    expect(container.querySelector(`.${CSS.escape(expected)}`)).toBeInTheDocument();
  });

  it('falls back to two columns for an out-of-range value', () => {
    const template = makeTemplate([makeSection({ columns: 9 })]);
    const { container } = renderWithProviders(<Harness template={template} />);
    expect(container.querySelector(`.${CSS.escape('md:grid-cols-2')}`)).toBeInTheDocument();
  });
});
