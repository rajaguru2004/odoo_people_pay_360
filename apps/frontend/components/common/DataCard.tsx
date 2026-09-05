'use client';

import React from 'react';
import { cn } from '@/utils/cn';

export interface DataCardItem {
  label: string;
  value: React.ReactNode;
  /** Span both columns (use for long values like a reason/description). */
  full?: boolean;
}

interface DataCardProps {
  /** Primary line — typically the row's main identifier. */
  title?: React.ReactNode;
  /** Rendered at the top-right — typically a status badge. */
  headerRight?: React.ReactNode;
  /** Label/value pairs rendered as a compact two-column definition list. */
  items?: DataCardItem[];
  /** Footer area — typically action buttons, right-aligned. */
  footer?: React.ReactNode;
  /** Extra content (e.g. an expandable breakdown) rendered after the items. */
  children?: React.ReactNode;
  onClick?: () => void;
  className?: string;
  /**
   * Opt-in `data-testid` for the card root. Mirrors the opt-in `testIdPrefix` on
   * `Pagination` and `testId` on `ExportButton`.
   *
   * A page that renders BOTH a desktop table and this card list for the same
   * rows must give the card a DIFFERENT id from the row: Playwright's `.count()`
   * includes hidden elements, so sharing one id silently doubles every count.
   */
  testId?: string;
}

/**
 * Mobile presentation of a single table row.
 *
 * The table→card pattern: keep the real `<table>` inside `hidden md:block` and
 * render a list of these cards inside `md:hidden`. Used across the ESS pages
 * whose tables are too wide for a phone (leaves, attendance, payroll).
 * Purely presentational — all data/formatting stays in the page.
 */
export default function DataCard({
  title,
  headerRight,
  items,
  footer,
  children,
  onClick,
  className,
  testId,
}: DataCardProps) {
  return (
    <div
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'rounded-xl border border-surface-border bg-surface-card p-4',
        onClick && 'cursor-pointer transition-colors hover:bg-surface-page',
        className,
      )}
    >
      {(title || headerRight) && (
        <div className="flex items-start justify-between gap-3">
          {title && <div className="min-w-0 font-semibold text-text-heading">{title}</div>}
          {headerRight && <div className="shrink-0">{headerRight}</div>}
        </div>
      )}

      {items && items.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          {items.map((item, i) => (
            <div key={i} className={cn('min-w-0', item.full && 'col-span-2')}>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                {item.label}
              </dt>
              <dd className="mt-0.5 text-sm text-text-body wrap-break-word">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {children}

      {footer && <div className="mt-3 flex items-center justify-end gap-2">{footer}</div>}
    </div>
  );
}
