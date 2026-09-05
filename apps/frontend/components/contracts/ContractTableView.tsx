'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { daysUntilDate, expiryLabel, expiryTone } from '@/utils/contractExpiry';
import { formatDateOnly } from '@/utils/formatDate';
import { formatCurrency, fullName } from '@/utils/formatters';
import { CONTRACT_STATUS_TONE, humanise } from './contractFacts';
import type { Contract } from '@/types/contract';

/** The contract list as rows — the view this screen has always opened on. */
export default function ContractTableView({ contracts }: { contracts: Contract[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="border-b border-surface-border-light text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">Number</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Employee</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Type</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Term</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Salary</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Expiry</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border-light">
          {contracts.map((contract) => {
            // The list endpoint does not compute a countdown — only the expiry
            // report does — so it is worked out here from the term.
            const days = contract.status === 'ACTIVE' ? daysUntilDate(contract.endDate) : null;
            const tone = expiryTone(days);

            return (
              <tr key={contract.id} className="hover:bg-surface-border-light/60">
                <td className="px-5 py-3">
                  <Link
                    href={`/dashboard/contracts/${contract.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {contract.contractNumber}
                  </Link>
                </td>
                <td className="px-5 py-3 text-text-body">
                  {contract.employee ? (
                    <Link
                      href={`/dashboard/employees/${contract.employeeId}`}
                      className="hover:underline"
                    >
                      {fullName(contract.employee)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-5 py-3 text-text-body">{humanise(contract.contractType)}</td>
                <td className="px-5 py-3 text-text-body">
                  {formatDateOnly(contract.startDate)} –{' '}
                  {contract.endDate ? formatDateOnly(contract.endDate) : 'open ended'}
                </td>
                {/* A decimal STRING from the API. formatCurrency reads the
                    decimal count from the contract's own currency, which is
                    three for OMR and two for AED. */}
                <td className="px-5 py-3 tabular-nums text-text-body">
                  {formatCurrency(contract.salary, contract.currency)}
                </td>
                <td className="px-5 py-3">
                  {days === null ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    <span
                      className={
                        tone === 'error'
                          ? 'font-semibold text-status-error'
                          : tone === 'warning'
                            ? 'font-semibold text-status-warning'
                            : 'text-text-body'
                      }
                    >
                      {expiryLabel(days)}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={CONTRACT_STATUS_TONE[contract.status]}>
                    {humanise(contract.status)}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
