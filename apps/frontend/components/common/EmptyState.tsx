'use client';

import type { ComponentType } from 'react';
import { Inbox, AlertTriangle } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * What a screen shows when it has nothing to show.
 *
 * Fifty-four of these are inlined across thirty-five files, most of them a
 * single muted sentence — `<div className="py-10 text-center text-text-muted">
 * There are no leave applications yet</div>` — and several hardcode `slate-400`
 * rather than a token.
 *
 * On a desktop that sentence sits in a table with a header, filters and a
 * sidebar around it, so the reader has context and a next step. **On a phone
 * the empty state IS the screen**: 650px of nothing with one grey line in the
 * middle. So this component insists on the two things that fix that — an icon
 * that says which kind of nothing, and room for an action that says what to do
 * about it.
 *
 * Two states, one component, because they are the same shape and confusing them
 * is the actual defect: an `error` rendered as `empty` tells the user they have
 * no leave requests when in fact the request failed.
 *
 *     empty  → "no rows yet"          → the action creates the first one
 *     error  → "we could not load it" → the action retries
 *
 * A third case worth spelling separately at the call site: *filtered* to empty
 * is not empty. Pass different copy and a "Clear filters" action, or the reader
 * concludes their records are gone.
 */

export interface EmptyStateProps {
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: string;
  hint?: string;
  /** Rendered as an `h-12` primary button — the thumb-sized floor for a phone. */
  action?: { label: string; onClick: () => void; testId?: string };
  tone?: 'empty' | 'error';
  /** Tightens the vertical padding for a small panel. */
  compact?: boolean;
  className?: string;
  testId?: string;
}

export default function EmptyState({
  icon,
  title,
  hint,
  action,
  tone = 'empty',
  compact = false,
  className,
  testId,
}: EmptyStateProps) {
  const Icon = icon ?? (tone === 'error' ? AlertTriangle : Inbox);

  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'py-8' : 'py-12',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-14 w-14 items-center justify-center rounded-2xl',
          tone === 'error' ? 'bg-status-error-bg' : 'bg-surface-page',
        )}
      >
        <Icon
          size={24}
          className={tone === 'error' ? 'text-status-error' : 'text-text-muted'}
        />
      </span>

      <p className="mt-4 text-sm font-semibold text-text-heading">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-xs leading-relaxed text-text-muted">{hint}</p>}

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          data-testid={action.testId}
          className="mt-5 inline-flex h-12 touch-manipulation items-center justify-center rounded-[--radius-button] bg-brand-primary px-5 text-sm font-semibold text-text-on-brand transition-transform active:scale-[0.98]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
