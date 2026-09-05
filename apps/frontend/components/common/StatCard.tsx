import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

export function StatCard({
  label,
  value,
  icon,
  hint,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-muted">{label}</p>
          {/* tabular-nums so a column of figures lines up digit-for-digit. */}
          <p className="mt-2 truncate text-2xl font-semibold tabular-nums text-text-heading">{value}</p>
          {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
        </div>
        {icon && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
            {icon}
          </span>
        )}
      </div>
    </Card>
  );
}
