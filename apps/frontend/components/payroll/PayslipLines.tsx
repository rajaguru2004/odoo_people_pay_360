'use client';

import type { PayslipRow } from '@/utils/payslipLines';

/**
 * The rows of one payslip section.
 *
 * Markup is deliberately identical to the hardcoded rows this replaced, so that
 * with itemisation off the rendered page is unchanged down to the class names.
 * The only new thing a reader can see is that a row may now be a component name
 * instead of an aggregate.
 */
export function PayslipLines({
  rows,
  tone,
  t,
  formatCurrency,
}: {
  rows: PayslipRow[];
  tone: 'success' | 'error' | 'brand';
  /** next-intl translator, passed in so this stays a dumb renderer. */
  t: (key: string, values?: Record<string, string | number>) => string;
  formatCurrency: (n: number) => string;
}) {
  const toneClass =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'error'
        ? 'text-status-error'
        : 'text-brand-primary';

  return (
    <>
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex justify-between py-2 border-b border-surface-border-light"
          data-testid={`payslip-row-${row.key}`}
          data-source={row.source}
        >
          <span className="text-text-body">
            {row.labelKey ? t(row.labelKey, row.labelValues) : row.label}
            {row.sublabelKey && (
              <span className="block text-xs text-text-muted">
                {t(row.sublabelKey, row.sublabelValues)}
              </span>
            )}
          </span>
          <span
            className={
              row.sign === 'none'
                ? 'font-semibold text-text-heading'
                : `font-semibold ${toneClass}`
            }
          >
            {row.sign === 'plus' ? '+' : row.sign === 'minus' ? '-' : ''}
            {formatCurrency(row.amount)}
          </span>
        </div>
      ))}
    </>
  );
}
