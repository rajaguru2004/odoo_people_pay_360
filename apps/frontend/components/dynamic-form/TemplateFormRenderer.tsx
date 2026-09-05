'use client';

import { FormProvider, UseFormReturn } from 'react-hook-form';
import {
  ResolvedTemplate,
  TemplateField,
  TemplateSection,
} from '@/types/profile-template';
import { Field, FieldOptionSources } from './Field';

/**
 * Renders a template as a form.
 *
 * Sections become headed grids, exactly as the hand-written employee form laid
 * them out; `wizardStep` selects which of them appear, so the create wizard's
 * steps are data and an admin regrouping them needs no code change.
 *
 * The admin builder renders this same component for its preview, so the preview
 * cannot drift from what employees actually see.
 */

export interface TemplateFormRendererProps {
  template: ResolvedTemplate;
  /** The `useForm` instance owned by the page. */
  form: UseFormReturn<any>;
  /** Render only this wizard step. Omit to render every section. */
  step?: number;
  /** Fields to render read-only (e.g. auto-generated codes). */
  readOnlyFields?: string[];
  optionSources?: FieldOptionSources;
  /**
   * Replace the control for one field. Return undefined to keep the default.
   * Exists for the handful of fields with a bespoke widget the generic renderer
   * has no business knowing about — the grouped timezone picker, for instance.
   */
  renderField?: (field: TemplateField) => React.ReactNode | undefined;
  /** Rendered after a section's grid — used for bespoke blocks. */
  renderSectionFooter?: (section: TemplateSection) => React.ReactNode;
  /** Wraps the whole thing in a FormProvider. Off when the page already has one. */
  withProvider?: boolean;
  className?: string;
}

const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-3',
  4: 'grid-cols-1 md:grid-cols-4',
};

export function TemplateFormRenderer({
  template,
  form,
  step,
  readOnlyFields = [],
  optionSources,
  renderField,
  renderSectionFooter,
  withProvider = true,
  className,
}: TemplateFormRendererProps) {
  const readOnly = new Set(readOnlyFields);

  const sections = (
    step === undefined
      ? template.sections
      : template.sections.filter((s) => s.wizardStep === step)
  ).filter((s) => s.fields.some((f) => f.isActive));

  const body = (
    <div className={className ?? 'space-y-6'}>
      {sections.map((section) => (
        <div key={section.sectionKey}>
          <h2 className="text-lg font-bold text-brand-primary mb-4 pb-2 border-b-2 border-brand-primary-light/20">
            {section.label}
          </h2>
          <div className={`grid ${GRID_COLS[section.columns] ?? GRID_COLS[2]} gap-6`}>
            {section.fields
              .filter((f) => f.isActive)
              .map((field: TemplateField) => {
                const custom = renderField?.(field);
                if (custom !== undefined) {
                  return (
                    <div
                      key={field.fieldKey}
                      style={{
                        gridColumn:
                          field.colSpan > 1 ? `span ${field.colSpan}` : undefined,
                      }}
                    >
                      {custom}
                    </div>
                  );
                }
                return (
                  <Field
                    key={field.fieldKey}
                    field={field}
                    readOnly={readOnly.has(field.fieldKey)}
                    optionSources={optionSources}
                  />
                );
              })}
          </div>
          {renderSectionFooter?.(section)}
        </div>
      ))}

      {sections.length === 0 && (
        // Reachable when every field in a step is hidden from this role. Saying
        // so beats an unexplained blank panel.
        <p className="text-sm text-text-muted">
          No fields are configured for you in this section.
        </p>
      )}
    </div>
  );

  if (!withProvider) return body;
  return <FormProvider {...form}>{body}</FormProvider>;
}

export default TemplateFormRenderer;
