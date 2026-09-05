'use client';

import { Building2, CheckCircle2, Navigation, Users } from 'lucide-react';
import { StatCard } from '@/components/common/StatCard';
import type { BranchStats } from './branchFacts';

/**
 * The four figures the Organisation module is judged on at a glance.
 *
 * Geofenced counts branches whose fence would actually stop a clock-in — see
 * `hasCompleteFence`. A switch turned on over an empty coordinate pair is an
 * intention, and reporting it here as a running control is the one number on
 * this bar that could talk somebody out of investigating.
 */
export default function BranchStatsBar({ stats }: { stats: BranchStats }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Total branches"
        value={<span data-testid="branch-stat-total">{stats.total}</span>}
        icon={<Building2 className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Active"
        value={<span data-testid="branch-stat-active">{stats.active}</span>}
        hint="Not retired"
        icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Geofenced"
        value={<span data-testid="branch-stat-geofenced">{stats.geofenced}</span>}
        hint="Fence has a centre and a radius"
        icon={<Navigation className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Employees"
        value={<span data-testid="branch-stat-employees">{stats.employees}</span>}
        hint="Across every branch listed"
        icon={<Users className="h-5 w-5" aria-hidden />}
      />
    </div>
  );
}
