'use client';

import React from 'react';
import { LoanScheduleRow } from '@/types/advanceLoan';
import { formatCurrency, formatDate } from '@/utils/formatters';
import {
  LOAN_BADGE_BASE,
  scheduleStatusClass,
  scheduleStatusLabel,
} from './loanStatus';

/**
 * The amortization plan.
 *
 * Only LIVE rows are returned by the API — a regenerated schedule keeps its
 * superseded rows in the database as the audit trail, but showing both would
 * make the instalment numbers look duplicated.
 */
export default function LoanScheduleTable({
  rows,
  showInterest,
  emptyMessage,
}: {
  rows: LoanScheduleRow[];
  showInterest?: boolean;
  /** Overrides the "waiting for approval" wording where that is not the case. */
  emptyMessage?: string;
}) {
  if (!rows?.length) {
    return (
      <p className="text-sm text-text-muted">
        {emptyMessage ??
          'No schedule yet — one is generated when the request is approved.'}
      </p>
    );
  }

  const nextDueId = rows.find((r) => r.status === 'SCHEDULED')?.id;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-surface-border text-left text-xs uppercase text-text-muted">
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Due</th>
            <th className="py-2 pr-3 text-right">Instalment</th>
            <th className="py-2 pr-3 text-right">Principal</th>
            {showInterest && <th className="py-2 pr-3 text-right">Interest</th>}
            <th className="py-2 pr-3 text-right">Balance after</th>
            <th className="py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // The first still-scheduled row is the one payroll takes next. It is
            // the single row a reader is usually looking for, so it is marked
            // rather than left to be counted down to.
            const isNext = r.id === nextDueId;
            return (
            <tr
              key={r.id}
              data-testid="loan-schedule-row"
              data-installment-no={r.installmentNo}
              data-schedule-status={r.status}
              className={`border-b border-surface-border-light ${isNext ? 'bg-brand-primary/5' : ''}`}
            >
              <td className="py-2 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  {r.installmentNo}
                  {isNext && (
                    <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-primary">
                      next
                    </span>
                  )}
                </span>
              </td>
              <td className="py-2 pr-3">{formatDate(r.dueDate)}</td>
              <td className="py-2 pr-3 text-right font-medium">
                {formatCurrency(Number(r.emiAmount))}
              </td>
              <td className="py-2 pr-3 text-right">
                {formatCurrency(Number(r.principalComponent))}
              </td>
              {showInterest && (
                <td className="py-2 pr-3 text-right">
                  {formatCurrency(Number(r.interestComponent))}
                </td>
              )}
              <td className="py-2 pr-3 text-right text-text-muted">
                {formatCurrency(Number(r.closingBalance))}
              </td>
              <td className="py-2 pr-3">
                <span
                  className={`${LOAN_BADGE_BASE} ${scheduleStatusClass(r.status)}`}
                  title={r.note ?? undefined}
                >
                  {scheduleStatusLabel(r.status)}
                </span>
                {r.note && (
                  <p className="mt-0.5 max-w-[220px] text-[11px] text-text-muted">
                    {r.note}
                  </p>
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
