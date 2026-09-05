'use client';

import { CheckCircle2, Clock, FileSignature, XCircle } from 'lucide-react';
import { StatCard } from '@/components/common/StatCard';

export interface ContractStats {
  /** Undefined until the count is known — never guessed from a page of rows. */
  total?: number;
  active?: number;
  expiringSoon?: number;
  expired?: number;
}

/** An em dash, never a nought: nothing was counted yet, which is not "none". */
function figure(value: number | undefined) {
  return value === undefined ? '—' : value;
}

export default function ContractStatsBar({
  stats,
  expiryWindowDays,
}: {
  stats: ContractStats;
  expiryWindowDays: number;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Total contracts"
        value={<span data-testid="contract-stat-total">{figure(stats.total)}</span>}
        hint="Every contract on file"
        icon={<FileSignature className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Active"
        value={<span data-testid="contract-stat-active">{figure(stats.active)}</span>}
        hint="In effect today"
        icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Expiring soon"
        value={<span data-testid="contract-stat-expiring">{figure(stats.expiringSoon)}</span>}
        hint={`Active, ending within ${expiryWindowDays} days`}
        icon={<Clock className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Expired"
        value={<span data-testid="contract-stat-expired">{figure(stats.expired)}</span>}
        hint="Term lapsed, not renewed"
        icon={<XCircle className="h-5 w-5" aria-hidden />}
      />
    </div>
  );
}
