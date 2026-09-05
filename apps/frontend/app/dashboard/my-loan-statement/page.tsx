'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import loanReportService from '@/services/loanReportService';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { loanStatusLabel, loanStatusClass, LOAN_BADGE_BASE } from '@/components/advance-loans/loanStatus';

/**
 * An employee's own loan statement.
 *
 * `GET /advance-loans/reports/my-statement` has existed, been tested and been
 * exposed through a client wrapper (`loanReportService.myStatement`) that no
 * page ever called — so a borrower could see a list of their requests and their
 * balance, and never the ledger behind it: what was paid, when, out of which
 * payroll, and what is still due.
 *
 * The one thing this screen must never do is state a debt that is not owed.
 * The server already draws that line — `outstanding` is zero for any terminal
 * status — so the screen shows what it is given rather than recomputing it from
 * `amount - repaid`, which is exactly how a settled loan came to read as still
 * owing on the borrower's own statement.
 */
export default function MyLoanStatementPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  const [loans, setLoans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'My loan statement',
    'Every advance and loan of yours, with what has been recovered and what is still due.',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const res: any = await loanReportService.myStatement();
      setLoans(Array.isArray(res) ? res : (res?.data ?? []));
    } catch (e) {
      // "You have no loans" and "we could not read your loans" are different
      // sentences, and only one of them is reassuring.
      const reason = apiErrorMessage(e, 'Could not load your loan statement');
      setFailed(reason);
      setLoans([]);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  return (
    <div className="p-4 sm:p-6 space-y-4" data-testid="ess-loan-statement">
      <PageActionRow
        onBack={() => router.push('/dashboard/advance-loans')}
      />

      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && failed && (
        <div
          data-testid="statement-failed"
          className="rounded-lg border border-status-error bg-status-error-bg p-3"
        >
          <p className="text-sm font-medium text-text-heading">
            Your statement could not be loaded
          </p>
          <p className="mt-1 text-sm text-text-muted">{failed}</p>
        </div>
      )}

      {!loading && !failed && loans.length === 0 && (
        <p data-testid="statement-empty" className="text-sm text-text-muted">
          You have never taken an advance or a loan.
        </p>
      )}

      {!loading &&
        !failed &&
        loans.map((loan) => (
          <div
            key={loan.id}
            data-testid="statement-loan"
            data-loan-id={loan.id}
            data-outstanding={loan.outstanding}
            className="rounded-lg border border-surface-border p-3 space-y-2"
          >
            <div className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-medium text-text-heading">
                {loan.referenceNo ?? loan.id.slice(0, 8)}
              </span>
              <span
                data-testid="statement-status"
                className={`${LOAN_BADGE_BASE} ${loanStatusClass(loan.status)}`}
              >
                {loanStatusLabel(loan.status)}
              </span>
              <span className="text-text-muted">
                {loan.type === 'ADVANCE' ? 'Advance' : 'Loan'} ·{' '}
                {formatDate(loan.createdAt)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <div className="text-[11px] text-text-muted">Borrowed</div>
                <div data-testid="statement-amount">{formatCurrency(Number(loan.amount))}</div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">Repaid</div>
                <div data-testid="statement-repaid">
                  {formatCurrency(Number(loan.amountRepaid ?? 0))}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">Still due</div>
                {/* Straight from the server: it is the only side that knows a
                    written-off or settled loan owes nothing, whatever the
                    arithmetic on the other columns suggests. */}
                <div data-testid="statement-outstanding">
                  {formatCurrency(Number(loan.outstanding ?? 0))}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">Instalments</div>
                <div data-testid="statement-installments">
                  {loan.installments}
                  {loan.installmentAmount
                    ? ` × ${formatCurrency(Number(loan.installmentAmount))}`
                    : ''}
                </div>
              </div>
            </div>

            <button
              data-testid="statement-toggle"
              onClick={() => setOpenId(openId === loan.id ? null : loan.id)}
              // A bare 16px text link is not a target. The schedule it opens
              // is the only reason this screen is opened on a phone.
              className="inline-flex h-11 touch-manipulation items-center text-sm font-medium text-brand-primary"
            >
              {openId === loan.id ? 'Hide the schedule' : 'Show the schedule'}
            </button>

            {openId === loan.id && (
              <div className="overflow-x-auto">
                {(loan.schedules ?? []).length === 0 ? (
                  <p data-testid="statement-schedule-empty" className="text-sm text-text-muted">
                    No instalments have been planned yet.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-text-muted">
                      <tr>
                        <th className="px-2 py-1 text-start">#</th>
                        <th className="px-2 py-1 text-start">Due</th>
                        <th className="px-2 py-1 text-start">Instalment</th>
                        <th className="px-2 py-1 text-start">Principal</th>
                        <th className="px-2 py-1 text-start">Interest</th>
                        <th className="px-2 py-1 text-start">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(loan.schedules ?? []).map((row: any) => (
                        <tr
                          key={`${row.version}-${row.installmentNo}`}
                          data-testid="statement-schedule-row"
                          data-installment={row.installmentNo}
                          data-status={row.status}
                          className="border-t border-surface-border"
                        >
                          <td className="px-2 py-1">{row.installmentNo}</td>
                          <td className="px-2 py-1">{formatDate(row.dueDate)}</td>
                          <td className="px-2 py-1">{formatCurrency(Number(row.emiAmount))}</td>
                          <td className="px-2 py-1">
                            {formatCurrency(Number(row.principalComponent))}
                          </td>
                          <td className="px-2 py-1">
                            {formatCurrency(Number(row.interestComponent))}
                          </td>
                          <td className="px-2 py-1">{row.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
