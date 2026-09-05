'use client';

import Link from 'next/link';
import { Network } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { fullName } from '@/utils/formatters';
import type { Department } from '@/types/department';

/**
 * One department as a card.
 *
 * The name is rendered exactly once inside the link. A second copy in a title
 * attribute makes "find the unit called X" return two hits for one card, which
 * is the difference between a search that lands and one that asks the reader to
 * disambiguate.
 */
export default function DepartmentCard({ department }: { department: Department }) {
  const headcount = department._count?.employees ?? 0;
  const subUnits = department._count?.children ?? department.children?.length ?? 0;

  return (
    <Link
      href={`/dashboard/departments/${department.id}`}
      data-testid={`department-card-${department.code}`}
      className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand">
          <Network className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
            {department.name}
          </h3>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            {department.code}
          </p>
        </div>
        {!department.isActive && <Badge tone="error">Closed</Badge>}
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Branch</dt>
          <dd className="truncate text-text-body">{department.branch?.name ?? 'Unassigned'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Reports to</dt>
          <dd className="truncate text-text-body">{department.parent?.name ?? 'Top level'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-text-muted">Head</dt>
          {/* A department with no head is not a blank field — the people in it
              have no approver, which is the whole point of flagging it. */}
          <dd
            className={`truncate ${department.manager ? 'text-text-body' : 'font-medium text-status-warning'}`}
          >
            {department.manager ? fullName(department.manager) : 'Nobody'}
          </dd>
        </div>
      </dl>

      <div className="mt-auto grid grid-cols-2 gap-3 border-t border-surface-border-light pt-3 text-sm">
        <div>
          <p className="text-xs text-text-muted">People</p>
          <p className="font-semibold tabular-nums text-text-heading">{headcount}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Sub-units</p>
          <p className="font-semibold tabular-nums text-text-heading">{subUnits}</p>
        </div>
      </div>
    </Link>
  );
}
