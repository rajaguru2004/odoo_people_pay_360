'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, error, icon, id, ...props },
  ref,
) {
  // Generated so the label's htmlFor always matches, even for several instances
  // of the same field on one page.
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-text-body">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-text-muted">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'w-full rounded-[var(--radius-input)] border bg-surface-card px-3 py-2 text-sm text-text-body',
            'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40',
            icon && 'ps-10',
            error ? 'border-status-error' : 'border-surface-border',
            className,
          )}
          {...props}
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
