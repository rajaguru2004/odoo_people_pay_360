'use client';

import { formatCurrency } from '@/utils/formatters';
import type { PayslipLine } from '@/types/payslip';

export type LineTone = 'success' | 'error' | 'brand';

const TONE_CLASS: Record<LineTone, string> = {
  success: 'text-status-success',
  error: 'text-status-error',
  brand: 'text-brand-primary',
};

/**
 * The rows of one payslip section.
 *
 * A dumb renderer on purpose: the section decides which lines it holds, what
 * they are called and whether the figures add to the payslip or come off it.
 * That is what lets the same component print earnings, deductions AND the
 * employer contributions that belong to none of the three totals — the caller
 * says so by passing `sign="none"`, and nothing here has to know the rule.
 *
 * Every amount goes through `formatCurrency` with the RUN's currency, never a
 * default: an OMR line rendered at two decimals silently rounds 125.500 to
 * 125.50, and a payslip that rounds does not reconcile against the bank.
 */
export default function PayslipLines({
  lines,
  tone,
  currency,
  sign = 'none',
  emptyLabel,
}: {
  lines: PayslipLine[];
  tone: LineTone;
  currency: string;
  /** What to print in front of the amount. `none` for a figure that is neither. */
  sign?: 'plus' | 'minus' | 'none';
  emptyLabel?: string;
}) {
  if (lines.length === 0) {
    return emptyLabel ? (
      <p className="py-2 text-sm text-text-muted">{emptyLabel}</p>
    ) : null;
  }

  return (
    <>
      {lines.map((line) => (
        <div
          key={line.id}
          data-testid={`payslip-row-${line.code}`}
          data-code={line.code}
          className="flex items-start justify-between gap-4 border-b border-surface-border-light py-2 last:border-b-0"
        >
          <span className="min-w-0 text-sm text-text-body">
            {/* The label is a COLUMN on the line, frozen at issue: a component
                renamed years later cannot change what this payslip says it
                paid. The code beside it is what a report joins on. */}
            {line.label}
            <span className="block font-mono text-[11px] text-text-muted">{line.code}</span>
          </span>
          <span
            className={`shrink-0 text-sm font-semibold tabular-nums ${
              sign === 'none' ? 'text-text-heading' : TONE_CLASS[tone]
            }`}
          >
            {sign === 'plus' ? '+ ' : sign === 'minus' ? '− ' : ''}
            {formatCurrency(line.amount, currency)}
          </span>
        </div>
      ))}
    </>
  );
}

/** The lines of one type, in the order the payslip prints them. */
export function linesOfType(
  lines: PayslipLine[] | undefined,
  type: PayslipLine['type'],
): PayslipLine[] {
  return (lines ?? [])
    .filter((line) => line.type === type)
    .sort((a, b) => a.sequence - b.sequence);
}
