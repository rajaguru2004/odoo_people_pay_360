'use client';

import Link from 'next/link';
import { Building2, MapPin, Navigation } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { fullName } from '@/utils/formatters';
import { officeWindow, WEEKDAY_LABELS } from './branchFacts';
import type { Branch } from '@/types/branch';

/**
 * One branch as a card.
 *
 * The whole card is the link and the branch NAME appears exactly once inside
 * it. A second copy in a title attribute makes "find the branch called X"
 * return two hits for one card, which is the difference between a search that
 * lands and one that asks the reader to disambiguate.
 */
export default function BranchCard({ branch }: { branch: Branch }) {
  const staff = branch._count?.employees ?? 0;
  const units = branch._count?.departments ?? branch.departments?.length ?? 0;
  const where = [branch.city, branch.country].filter(Boolean).join(', ');
  const hours = officeWindow(branch);

  return (
    <Link
      href={`/dashboard/branches/${branch.id}`}
      data-testid={`branch-card-${branch.code}`}
      className="surface-panel group flex h-full flex-col gap-4 rounded-[var(--radius-card)] p-5 transition-all"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary transition-colors group-hover:bg-brand-primary group-hover:text-text-on-brand">
          <Building2 className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-text-heading transition-colors group-hover:text-brand-primary">
            {branch.name}
          </h3>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            {branch.code}
          </p>
        </div>
        {!branch.isActive && <Badge tone="error">Retired</Badge>}
      </div>

      {where && (
        <p className="flex items-center gap-1.5 text-sm text-text-body">
          <MapPin className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          <span className="truncate">{where}</span>
        </p>
      )}

      {/* Occupancy first: it is the only figure on the card that changes
          without anybody editing the branch. */}
      <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-surface-border-light pt-3 text-sm">
        <div>
          <dt className="text-xs text-text-muted">People</dt>
          <dd className="font-semibold tabular-nums text-text-heading">{staff}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Units</dt>
          <dd className="font-semibold tabular-nums text-text-heading">{units}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Hours</dt>
          <dd className="truncate font-semibold tabular-nums text-text-heading">
            {hours ?? 'Company default'}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>
          Manager: <span className="text-text-body">{fullName(branch.manager)}</span>
        </span>
        {branch.weeklyOffDays.length > 0 && (
          <span>
            · Off {branch.weeklyOffDays.map((day) => WEEKDAY_LABELS[day] ?? day).join(', ')}
          </span>
        )}
        {branch.geofencingEnabled && (
          <span className="inline-flex items-center gap-1 text-status-info">
            <Navigation className="h-3 w-3" aria-hidden />
            Geofenced
          </span>
        )}
      </div>
    </Link>
  );
}
