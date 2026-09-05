'use client';

import { useTranslations } from 'next-intl';
import {
  DonutChart,
  DonutLegend,
  PanelHeader,
  PanelLink,
  type DonutSlice,
} from '@/components/module-landing/primitives';
import type { PeopleHubSummary } from '@/types/peopleHub';

/**
 * The workforce split by where each person stands, not by what team they are on.
 *
 * Three of the four buckets are DERIVED — `Employee.status` stores only ACTIVE
 * and INACTIVE. Probation is an active contract of that type; notice is an open
 * termination request; active is everybody else. The server applies them in
 * that order so somebody on probation who has also resigned is counted once,
 * as leaving — which is the fact that changes what HR does next.
 *
 * Legend keys are title case: they are labels, not sentence fragments borrowed
 * from an attention strip.
 */
const SLICE_COLORS: Record<string, string> = {
  active: 'var(--color-status-success)',
  probation: 'var(--color-brand-primary)',
  notice: 'var(--color-status-warning)',
  inactive: 'var(--color-text-muted)',
};

export default function EmployeeStatusDonut({
  split,
  total,
  loading = false,
  failed = false,
}: {
  split?: PeopleHubSummary['statusSplit'];
  total?: number;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useTranslations('peopleHub');

  const slices: DonutSlice[] = (split ?? [])
    .filter((s) => s.count > 0)
    .map((s) => ({
      key: s.key,
      label: t(`status.${s.key}`),
      value: s.count,
      color: SLICE_COLORS[s.key] ?? 'var(--color-text-muted)',
    }));

  const sum = slices.reduce((a, s) => a + s.value, 0);

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col h-full">
      <PanelHeader
        title={t('employeeStatus')}
        hint={t('employeeStatusHint')}
        action={<PanelLink href="/dashboard/employees">{t('seeDirectory')}</PanelLink>}
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center py-6">
          <div className="h-[160px] w-[160px] rounded-full bg-surface-page animate-pulse" />
        </div>
      ) : failed ? (
        // Neutral, not another "not an all-clear": the attention strip above
        // already says the read failed.
        <p className="text-[13px] text-text-muted py-8">{t('chartUnavailable')}</p>
      ) : sum === 0 ? (
        <p className="text-[13px] text-text-muted py-8">{t('noEmployees')}</p>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <DonutChart
            slices={slices}
            size={160}
            thickness={21}
            caption={String(total ?? sum)}
            subCaption={t('employees')}
          />
          <div className="w-full">
            <DonutLegend slices={slices} total={sum} />
          </div>
        </div>
      )}
    </div>
  );
}
