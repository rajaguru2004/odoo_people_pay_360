import { cn } from '@/utils/cn';
import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-border-light text-text-muted',
  success: 'bg-status-success-bg text-status-success',
  warning: 'bg-status-warning-bg text-status-warning',
  error: 'bg-status-error-bg text-status-error',
  info: 'bg-status-info-bg text-status-info',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--radius-badge)] px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
