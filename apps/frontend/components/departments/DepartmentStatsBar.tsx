'use client';

import { Network, UserX, Users } from 'lucide-react';
import { StatCard } from '@/components/common/StatCard';
import type { DepartmentStats } from './departmentFacts';

/**
 * The four figures the department list is read against.
 *
 * Counted across every unit the endpoint returned, not across the filtered
 * view: the bar is the fixed backdrop a narrowed list is compared to, and a
 * total that moved with the filter could never contradict what is on screen.
 */
export default function DepartmentStatsBar({ stats }: { stats: DepartmentStats }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Units"
        value={<span data-testid="department-stat-total">{stats.total}</span>}
        icon={<Network className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="Top level"
        value={<span data-testid="department-stat-top-level">{stats.topLevel}</span>}
        hint="Reporting to nobody"
      />
      <StatCard
        label="Without a head"
        value={<span data-testid="department-stat-headless">{stats.headless}</span>}
        hint="Nothing routed here has an approver"
        icon={<UserX className="h-5 w-5" aria-hidden />}
      />
      <StatCard
        label="People placed"
        value={<span data-testid="department-stat-people">{stats.people}</span>}
        icon={<Users className="h-5 w-5" aria-hidden />}
      />
    </div>
  );
}
