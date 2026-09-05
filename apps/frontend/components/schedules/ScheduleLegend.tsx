'use client';

import { useTranslations } from 'next-intl';
import { SHIFT_ORDER } from '@/utils/scheduleHours';
import { DAY_PALETTE, SHIFT_PALETTE } from './shiftStyles';

/**
 * What the colours on the grid mean.
 *
 * Every screen that shades a cell renders this, from the same palette the cells
 * read — a legend maintained separately from the thing it explains is a legend
 * that eventually explains the wrong colours.
 */
export default function ScheduleLegend({
  showShiftTypes = true,
}: {
  /** Off on a screen that draws one shift type at a time. */
  showShiftTypes?: boolean;
}) {
  const t = useTranslations('schedules');

  const swatches = [
    ...(showShiftTypes
      ? SHIFT_ORDER.map((type) => ({
          key: type,
          label: t(`shift.${type}`),
          palette: SHIFT_PALETTE[type],
        }))
      : [
          {
            key: 'shift',
            label: t('legendWork'),
            palette: SHIFT_PALETTE.FULL_DAY,
          },
        ]),
    { key: 'leave', label: t('legendLeave'), palette: DAY_PALETTE.leave },
    { key: 'holiday', label: t('legendHoliday'), palette: DAY_PALETTE.holiday },
    {
      key: 'weekly-off',
      label: t('legendWeeklyOff'),
      palette: DAY_PALETTE.weeklyOff,
    },
  ];

  return (
    <div
      data-testid="schedule-legend"
      className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[var(--radius-card)] border border-surface-border bg-surface-card px-4 py-3"
    >
      <span className="text-[11px] font-bold tracking-wider text-text-muted uppercase">
        {t('legend')}
      </span>
      {swatches.map((swatch) => (
        <span key={swatch.key} className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-3.5 w-3.5 rounded-[4px] border"
            style={{
              background: swatch.palette.background,
              borderColor: swatch.palette.border,
            }}
          />
          <span className="text-[13px] font-medium text-text-body">
            {swatch.label}
          </span>
        </span>
      ))}
    </div>
  );
}
