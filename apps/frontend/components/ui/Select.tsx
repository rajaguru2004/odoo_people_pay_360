'use client';

import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  /** Shown as a disabled-looking first row for an optional field. */
  placeholder?: string;
  children: ReactNode;
}

/**
 * A native `<select>` dressed to match `Input`.
 *
 * Native rather than a custom listbox on purpose: these screens are filled in
 * by HR staff on desktop and on a phone, and the platform picker is the one
 * control that is already keyboard-navigable, screen-reader-correct and usable
 * with a thumb. Nothing here needs multi-select or search.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, label, error, placeholder, id, children, ...props },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-text-body">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'w-full appearance-none rounded-[var(--radius-input)] border bg-surface-card px-3 py-2 pe-9',
            'text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40',
            error ? 'border-status-error' : 'border-surface-border',
            className,
          )}
          {...props}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute inset-y-0 end-3 my-auto h-4 w-4 text-text-muted"
          aria-hidden
        />
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-status-error">
          {error}
        </p>
      )}
    </div>
  );
});
