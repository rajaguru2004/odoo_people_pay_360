import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { StatCard } from '@/components/common/StatCard';

export interface AttendanceStat {
  key: string;
  label: string;
  /** Already formatted. An unknown figure arrives as an em dash, never as 0. */
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}

/**
 * The KPI row that heads an attendance list.
 *
 * Presentational: every figure is decided by the screen and formatted before it
 * gets here, so the bar has no opinion about what a rate divides by. That
 * matters because `null` and `0` mean different things in this module — nothing
 * to divide by against a total no-show — and a component that formatted its own
 * numbers would have to re-learn the distinction.
 */
export function AttendanceStatsBar({
  stats,
  loading = false,
}: {
  stats: AttendanceStat[];
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.key} className="h-[104px] animate-pulse p-5">
            <div className="h-3 w-24 rounded bg-surface-border-light" />
            <div className="mt-3 h-6 w-16 rounded bg-surface-border-light" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <StatCard
          key={stat.key}
          label={stat.label}
          value={stat.value}
          hint={stat.hint}
          icon={stat.icon}
        />
      ))}
    </div>
  );
}
