'use client';

import Link from 'next/link';
import { Briefcase, CalendarDays, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { daysUntilDate, expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { CONTRACT_STATUS_TONE, humanise } from './contractFacts';
import type { Contract } from '@/types/contract';

/**
 * The same contracts as cards.
 *
 * The card leads with the person rather than the contract number, because that
 * is what somebody browsing rather than looking one up is scanning for. The
 * number stays the link, so the two views agree about what is clickable.
 */
export default function ContractCardView({ contracts }: { contracts: Contract[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {contracts.map((contract) => {
        const days = contract.status === 'ACTIVE' ? daysUntilDate(contract.endDate) : null;
        const tone = expiryTone(days);

        return (
          <Link
            key={contract.id}
            href={`/dashboard/contracts/${contract.id}`}
            data-testid={`contract-card-${contract.contractNumber}`}
            className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
          >
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand">
                <Briefcase className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
                  {fullName(contract.employee)}
                </h3>
                <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
                  {contract.contractNumber}
                </p>
              </div>
              <Badge tone={CONTRACT_STATUS_TONE[contract.status]}>
                {humanise(contract.status)}
              </Badge>
            </div>

            <dl className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-text-muted">Type</dt>
                <dd className="truncate text-text-body">
                  {humanise(contract.contractType)} · {humanise(contract.workType)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-text-muted">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                  Term
                </dt>
                <dd className="truncate text-text-body">
                  {formatDateOnly(contract.startDate)} –{' '}
                  {contract.endDate ? formatDateOnly(contract.endDate) : 'open ended'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-text-muted">
                  <Wallet className="h-3.5 w-3.5" aria-hidden />
                  Salary
                </dt>
                {/* A decimal string from the API, formatted against the
                    contract's own currency — OMR carries three places. */}
                <dd className="tabular-nums text-text-body">
                  {formatCurrency(contract.salary, contract.currency)}
                </dd>
              </div>
            </dl>

            <div className="mt-auto border-t border-surface-border-light pt-3 text-sm">
              {/* An em dash where there is no countdown to run: a draft has not
                  started and a permanent contract has no end to count to. */}
              {days === null ? (
                <p className="text-text-muted">No countdown —</p>
              ) : (
                <p
                  className={
                    tone === 'error'
                      ? 'font-semibold text-status-error'
                      : tone === 'warning'
                        ? 'font-semibold text-status-warning'
                        : 'text-text-body'
                  }
                >
                  {expiryLabel(days)}
                </p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
