import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Card } from '@/components/ui/Card';

export function StatCard({
  label,
  value,
  icon,
  hint,
  index = 0,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: string;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.08 + index * 0.08 }}
    >
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
    </motion.div>
  );
}
