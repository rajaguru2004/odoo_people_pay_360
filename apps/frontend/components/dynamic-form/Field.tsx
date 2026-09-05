'use client';

import { Controller, useFormContext } from 'react-hook-form';
import { TemplateField, fieldName } from '@/types/profile-template';
import { PHONE_COUNTRIES, countryDial } from '@/lib/countries';
import { FileUploadField } from './FileUploadField';

/**
 * One template field, rendered.
 *
 * The markup is copied VERBATIM from the hand-written employee forms — same
 * Tailwind token classes, same error styling, same helper-text placement — so
 * moving a screen onto the template changes what is rendered, never how it
 * looks. That is what makes the switch reviewable.
 *
 * Two things this fixes on the way, both real defects in the existing dynamic
 * renderer at components/profile/PaymentInformationSection.tsx:
 *
 *   - `SELECT` there falls through to a text input even though the field type
 *     is declared, so a configured option list silently does nothing;
 *   - it holds values in a loose `useState` record, which means `trigger()`,
 *     `setError()` and the wizard's per-step validation cannot see them. This
 *     is react-hook-form native.
 */

const INPUT_BASE =
  'w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body';
const INPUT_READONLY =
  'w-full px-4 py-2 border border-surface-border rounded-[--radius-input] bg-surface-page text-text-muted cursor-not-allowed';

export interface FieldOptionSources {
  /**
   * Live option lists. Keyed by the field's `optionSource` (POSITION,
   * EMPLOYMENT_TYPE, …), by the source a relation-shaped fieldType implies
   * (DEPARTMENT, BRANCH, EMPLOYEE), or — as a last resort — by fieldKey, which
   * is how one-off selects like `overtimePolicyId` get their choices.
   */
  [source: string]: { value: string; label: string }[] | undefined;
}

/**
 * FILE fields that hold a picture of a person, so the control previews them as
 * an avatar rather than as a file chip. Everything else is treated as a
 * document — an admin-invented FILE field is far more often a scan than a face.
 */
const IMAGE_FIELDS = new Set(['avatarUrl', 'photoUrl', 'photo']);

/** Relation-shaped field types carry their own source. */
const IMPLIED_SOURCE: Record<string, string> = {
  DEPARTMENT_SELECT: 'DEPARTMENT',
  BRANCH_SELECT: 'BRANCH',
  EMPLOYEE_SELECT: 'EMPLOYEE',
};

export interface FieldProps {
  field: TemplateField;
  /** Read-only rendering — used for locked/auto-generated values. */
  readOnly?: boolean;
  optionSources?: FieldOptionSources;
  /** Overrides the RHF name, for forms that nest the whole template. */
  namePrefix?: string;
}

/** Read a possibly-nested RHF error by dotted path. */
function errorAt(errors: unknown, path: string): { message?: string } | undefined {
  return path.split('.').reduce<any>((acc, part) => acc?.[part], errors);
}

export function Field({
  field,
  readOnly,
  optionSources,
  namePrefix,
}: FieldProps) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = useFormContext();

  const name = namePrefix
    ? `${namePrefix}.${fieldName(field)}`
    : fieldName(field);
  const error = errorAt(errors, name);
  const hasError = Boolean(error?.message);
  // Only PHONE_COUNTRY reads this; watch() on an unrelated field is cheap and
  // keeps the hook call unconditional, which the rules of hooks require.
  const selectedDial =
    field.fieldType === 'PHONE_COUNTRY' ? countryDial(watch(name)) : '';
  const cls = readOnly
    ? INPUT_READONLY
    : `${INPUT_BASE} ${hasError ? 'border-status-error' : 'border-surface-border'}`;

  // A SELECT's choices come from static `options` or from a live source the
  // parent supplied. An unresolved source renders an empty list rather than a
  // free-text box, so a misconfigured field is visible instead of silently
  // accepting anything.
  //
  // The relation-shaped types imply their own source, so a template does not
  // have to set `optionSource: 'DEPARTMENT'` on a DEPARTMENT_SELECT to work.
  const impliedSource = IMPLIED_SOURCE[field.fieldType as string];
  const sourceKey = field.optionSource || impliedSource || field.fieldKey;
  const options =
    field.options && field.options.length
      ? field.options
      : optionSources?.[sourceKey] || [];

  const labelNode = (
    <label className="block text-sm font-medium text-text-heading mb-2">
      {field.label}
      {field.required && <span className="text-status-error"> *</span>}
    </label>
  );

  const footer = (
    <>
      {hasError && (
        <p className="mt-1 text-sm text-status-error">{error?.message}</p>
      )}
      {!hasError && field.helpText && (
        <p className="mt-1 text-xs text-text-muted">{field.helpText}</p>
      )}
    </>
  );

  const control_ = (() => {
    switch (field.fieldType) {
      case 'TEXTAREA':
        return (
          <textarea
            {...register(name)}
            rows={3}
            readOnly={readOnly}
            className={cls}
            placeholder={field.placeholder ?? ''}
          />
        );

      case 'BOOLEAN':
        return (
          <Controller
            name={name}
            control={control}
            render={({ field: rhf }) => (
              <label className="flex items-center gap-2 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={Boolean(rhf.value)}
                  onChange={(e) => rhf.onChange(e.target.checked)}
                  className="h-4 w-4 rounded border-surface-border text-brand-primary focus:ring-brand-primary/20"
                />
                <span className="text-sm text-text-body">
                  {field.placeholder ?? field.label}
                </span>
              </label>
            )}
          />
        );

      case 'SELECT':
      case 'LIBRARY_SELECT':
      case 'DEPARTMENT_SELECT':
      case 'BRANCH_SELECT':
      case 'EMPLOYEE_SELECT':
        return (
          <select {...register(name)} disabled={readOnly} className={cls}>
            <option value="">
              {field.placeholder ?? `Select ${field.label.toLowerCase()}`}
            </option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );

      case 'MULTISELECT':
        return (
          <Controller
            name={name}
            control={control}
            render={({ field: rhf }) => {
              const selected: string[] = Array.isArray(rhf.value) ? rhf.value : [];
              return (
                <div
                  className={`${cls} !h-auto flex flex-wrap gap-2 py-3`}
                  role="group"
                >
                  {options.length === 0 && (
                    <span className="text-sm text-text-muted">
                      No options configured
                    </span>
                  )}
                  {options.map((o) => {
                    const on = selected.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        disabled={readOnly}
                        onClick={() =>
                          rhf.onChange(
                            on
                              ? selected.filter((v) => v !== o.value)
                              : [...selected, o.value],
                          )
                        }
                        className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                          on
                            ? 'bg-brand-primary text-white border-brand-primary'
                            : 'bg-surface-page text-text-body border-surface-border hover:border-brand-primary'
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              );
            }}
          />
        );

      case 'DATE':
        return (
          <input
            type="date"
            {...register(name)}
            readOnly={readOnly}
            className={cls}
          />
        );

      case 'DATETIME':
        return (
          <input
            type="datetime-local"
            {...register(name)}
            readOnly={readOnly}
            className={cls}
          />
        );

      case 'NUMBER':
      case 'DECIMAL':
      case 'CURRENCY':
        return (
          <input
            type="number"
            // A CURRENCY column is Decimal(12,2); stepping by 1 would make the
            // spinner unable to reach a valid cents value.
            step={field.fieldType === 'NUMBER' ? '1' : '0.01'}
            min={field.minValue ?? undefined}
            max={field.maxValue ?? undefined}
            {...register(name, { valueAsNumber: true })}
            readOnly={readOnly}
            className={cls}
            placeholder={field.placeholder ?? ''}
          />
        );

      case 'EMAIL':
        return (
          <input
            type="email"
            {...register(name)}
            readOnly={readOnly}
            className={cls}
            placeholder={field.placeholder ?? ''}
          />
        );

      case 'PHONE':
        return (
          <input
            type="tel"
            {...register(name)}
            readOnly={readOnly}
            className={cls}
            placeholder={field.placeholder ?? ''}
          />
        );

      case 'PHONE_COUNTRY':
        // Its own type rather than a SELECT with ~240 static options: the list
        // is a client constant, so the template payload stays small, and the
        // live "+968" readout the hand-written form had survives.
        return (
          <div className="space-y-1">
            <select
              {...register(name)}
              disabled={readOnly}
              className={cls}
            >
              <option value="">Use branch default</option>
              {PHONE_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} (+{c.dial})
                </option>
              ))}
            </select>
            {selectedDial ? (
              <p className="text-xs text-slate-500">
                Numbers will be dialled as +{selectedDial}
              </p>
            ) : null}
          </div>
        );

      case 'FILE':
        // The template only ever holds a URL — but producing that URL is the
        // upload widget's job, not the user's. A bare text box here meant
        // "Photo" could only be filled in by someone who had already hosted the
        // image somewhere.
        return (
          <Controller
            name={name}
            control={control}
            render={({ field: rhf }) => (
              <FileUploadField
                value={typeof rhf.value === 'string' ? rhf.value : ''}
                onChange={(next) => rhf.onChange(next)}
                variant={IMAGE_FIELDS.has(field.fieldKey) ? 'image' : 'file'}
                disabled={readOnly}
                hasError={hasError}
                hint={field.placeholder ?? undefined}
              />
            )}
          />
        );

      case 'TEXT':
      default:
        return (
          <input
            {...register(name)}
            readOnly={readOnly}
            className={cls}
            placeholder={field.placeholder ?? ''}
          />
        );
    }
  })();

  return (
    <div
      // Every template-rendered field is addressable by its key, so a test can
      // name a field without matching its label — labels are translated.
      data-testid={`field-${field.fieldKey}`}
      style={{ gridColumn: field.colSpan > 1 ? `span ${field.colSpan}` : undefined }}
    >
      {field.fieldType !== 'BOOLEAN' && labelNode}
      {control_}
      {footer}
    </div>
  );
}

export default Field;
