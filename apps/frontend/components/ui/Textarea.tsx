'use client';

import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, label, error, id, rows = 3, ...props },
  ref,
) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  const errorId = `${areaId}-error`;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={areaId} className="mb-1.5 block text-sm font-medium text-text-body">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'w-full rounded-[var(--radius-input)] border bg-surface-card px-3 py-2 text-sm text-text-body',
          'placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40',
          error ? 'border-status-error' : 'border-surface-border',
          className,
        )}
        {...props}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-sm text-status-error">
          {error}
        </p>
      )}
    </div>
  );
});
