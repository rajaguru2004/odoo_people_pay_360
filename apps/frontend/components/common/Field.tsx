'use client';

import { useId, type ReactElement, cloneElement } from 'react';
import { cn } from '@/utils/cn';

/**
 * One form-control recipe, and the label that goes above it.
 *
 * ## Why `text-base` is not a style preference
 *
 * Every form control in this app is `h-10 … text-sm` — 40px tall at 14px.
 * **Mobile Safari zooms the whole page in when a focused input's font-size is
 * below 16px.** That is not a hint or a setting; it is unconditional. And in
 * this shell the consequence is worse than usual: `<main>` is the scroll
 * container (`DashboardLayout`), so the zoom leaves the reader scrolled
 * sideways *inside a container whose own `scrollWidth` still measures clean* —
 * invisible to the horizontal-overflow assertion, invisible in a screenshot,
 * and it does not undo when the field blurs.
 *
 * So: `text-base` (16px), `h-12` (48px, Material's touch floor and comfortably
 * over WCAG's 44). Both are baked into the exported class strings rather than
 * left to each screen, because the failure is silent and the fix is one token.
 *
 * ## The other three rules
 *
 * - **Label above, always.** Never a placeholder standing in for a label: it
 *   vanishes the moment the reader types, which is exactly when they are most
 *   likely to want it, and it is not an accessible name.
 * - **Single column.** Two fields side by side at 390px gives each ~180px.
 *   Stack them; `md:` may put them back in a row.
 * - **Match the keyboard to the field.** This is a documentation contract, not
 *   a prop — typing it would mean twenty new props for something the native
 *   attributes already express:
 *
 *       amount        type="number"  inputMode="decimal"
 *       whole count   type="number"  inputMode="numeric"
 *       phone         type="tel"
 *       email         type="email"   autoComplete="email"
 *       date / time   type="date" / type="time"
 *       search        type="search"  enterKeyHint="search"
 *
 *   `components/common/ess-mobile-standard.test.ts` enforces the size rules
 *   against the source; the keyboard hints are reviewed in the diff.
 */

const CONTROL_BASE =
  'w-full rounded-[--radius-input] border border-surface-border bg-surface-card ' +
  'text-base text-text-body placeholder:text-text-muted ' +
  'focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** `<input>`. 48px tall, 16px text. */
export const inputClass = `h-12 px-3 ${CONTROL_BASE}`;

/** `<select>`. Same box; the options list is the OS picker on a phone, which is
 *  why this app does not build a custom one — nothing we write is better, and
 *  the native one is already localised. */
export const selectClass = `h-12 px-3 ${CONTROL_BASE}`;

/** `<textarea>`. No fixed height; `rows` decides. */
export const textareaClass = `px-3 py-2.5 ${CONTROL_BASE}`;

export interface FieldProps {
  label: string;
  /** The control. Gets `id`, and `aria-invalid`/`aria-describedby` when in error. */
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
  required?: boolean;
  /** Shown under the control, and announced — the control is marked invalid. */
  error?: string;
  /** Shown under the control when there is no error. */
  hint?: string;
  className?: string;
}

export default function Field({
  label,
  children,
  required = false,
  error,
  hint,
  className,
}: FieldProps) {
  const id = useId();
  const messageId = `${id}-msg`;
  const message = error ?? hint;

  return (
    <div className={cn('w-full', className)}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-body">
        {label}
        {required && (
          <span aria-hidden="true" className="ms-0.5 text-status-error">
            *
          </span>
        )}
      </label>

      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': message ? messageId : undefined,
      })}

      {message && (
        <p
          id={messageId}
          className={cn('mt-1.5 text-xs', error ? 'text-status-error' : 'text-text-muted')}
        >
          {message}
        </p>
      )}
    </div>
  );
}
