'use client';

import { useTranslations } from 'next-intl';
import { MeterList, PanelHeader, PanelLink, type MeterRow } from '@/components/module-landing/primitives';
import type { HubDepartment } from '@/types/attendanceHub';

/**
 * Which departments are short-handed, worst first.
 *
 * Sorted (by the server) on attendance RATE rather than absence count: a
 * department of four with two missing is in more trouble than a department of
 * eighty with three, and a count-ordered list puts the big department on top
 * every single day.
 *
 * The bar shows who turned up, not who is missing, so a full bar is good news —
 * a chart where "more" means "worse" has to be read twice.
 *
 * A department that filed no attendance at all sits at the bottom reading
 * "no records" rather than a confident 0%. The two look identical in a
 * percentage and mean completely different things: one is a staffing problem,
 * the other is that nobody in that team uses the clock.
 */
export default function DepartmentAttendanceBars({
  rows,
  loading = false,
  limit = 6,
  periodLabel,
}: {
  rows?: HubDepartment[];
  loading?: boolean;
  limit?: number;
  periodLabel?: string;
}) {
  const t = useTranslations('timeHub');

  if (loading) {
    return (
      <div className="surface-panel p-5 h-[320px] animate-pulse rounded-[20px]">
        <div className="h-3.5 w-44 rounded bg-surface-border" />
        <div className="mt-8 space-y-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-2.5 rounded-full bg-surface-border/70" />
          ))}
        </div>
      </div>
    );
  }

  const ranked = (rows ?? []).filter((r) => r.headcount > 0);
  const shown = ranked.slice(0, limit);
  const hidden = ranked.length - shown.length;

  // Progressive gradient shades matching reference image 2
  const SHADES = [
    'var(--color-brand-accent, #FF5A1F)',
    'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 88%, white)',
    'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 75%, white)',
    'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 60%, white)',
    'color-mix(in srgb, var(--color-brand-accent, #FF5A1F) 45%, white)',
  ];

  const meters: MeterRow[] = shown.map((r, i) => {
    const pct = r.hasData && r.rate !== null ? Math.round(r.rate) : 0;
    return {
      key: r.id,
      // "0 absent · 90%" reads as a contradiction — the gap is usually approved
      // leave, not absence. Show the fraction the percentage came from instead,
      // and only name absences when there actually are some.
      label: !r.hasData
        ? t('deptMeterNoData', { name: r.name })
        : r.absent > 0
        ? t('deptMeterAbsent', { name: r.name, absent: r.absent })
        : t('deptMeterLabel', { name: r.name, present: r.present, expected: r.expected }),
      percent: pct,
      valueLabel: r.hasData && r.rate !== null ? `${pct}%` : '—',
      color: r.hasData ? SHADES[i % SHADES.length] : 'var(--color-surface-border)',
    };
  });

  return (
    <div className="surface-panel p-6 rounded-[20px] flex flex-col justify-between">
      <PanelHeader
        title={t('byDepartment')}
        hint={periodLabel ? t('byDepartmentHintPeriod', { period: periodLabel }) : t('byDepartmentHint')}
        action={<PanelLink href="/dashboard/attendance">{t('seeOverview')}</PanelLink>}
      />

      {meters.length === 0 ? (
        <p className="text-[13px] text-text-muted">{t('noDepartmentData')}</p>
      ) : (
        <MeterList rows={meters} />
      )}

      {hidden > 0 && (
        <p className="mt-4 text-[11px] text-text-muted">{t('andMoreDepartments', { count: hidden })}</p>
      )}
    </div>
  );
}
