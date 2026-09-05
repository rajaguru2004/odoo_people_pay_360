'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useBulkSchedule } from '@/hooks/useSchedules';
import { apiErrorMessage } from '@/utils/apiError';
import {
  SHIFT_ORDER,
  crossesMidnight,
  dayKeysBetween,
  isoWeekday,
  shiftHours,
  todayKey,
} from '@/utils/scheduleHours';
import type { BulkScheduleResult } from '@/services/workScheduleService';
import type { ShiftType } from '@/types/attendance';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface BulkScheduleModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** The people to choose from — already filtered by the screen behind this. */
  employees: Array<{ id: string; fullName: string; employeeCode: string }>;
  /** Ticked when the modal opens, e.g. whoever the list was filtered down to. */
  initialEmployeeIds?: string[];
}

/**
 * Lay one shift pattern over a range of dates for a group of people.
 *
 * The result is REPORTED rather than swallowed: the endpoint answers with what
 * it created, replaced, skipped and failed, and the panel at the foot of this
 * form prints all four. Somebody laying a March night shift over a month that
 * already has three hand-made exceptions in it wants to know about those three,
 * and `overwrite` is off by default so they keep them unless they say otherwise.
 */
/**
 * Mounted on open, unmounted on close — see the note on `ScheduleModal`.
 *
 * It matters more here than there: this form carries the RESULT of the last
 * run, and a stale "312 created" panel sitting above an untouched form is a
 * report of something that did not just happen.
 */
export default function BulkScheduleModal(props: BulkScheduleModalProps) {
  if (!props.open) return null;
  return <BulkScheduleForm {...props} />;
}

function BulkScheduleForm({
  onClose,
  onSaved,
  employees,
  initialEmployeeIds,
}: BulkScheduleModalProps) {
  const t = useTranslations('schedules');
  const bulk = useBulkSchedule();

  const [selected, setSelected] = useState<string[]>(initialEmployeeIds ?? []);
  const [startDate, setStartDate] = useState(todayKey());
  const [endDate, setEndDate] = useState(todayKey());
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [shiftType, setShiftType] = useState<ShiftType>('FULL_DAY');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('17:00');
  const [requiredHours, setRequiredHours] = useState('8');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkScheduleResult | null>(null);

  const flexible = shiftType === 'FLEXIBLE';

  /**
   * How many days the pattern will actually land on.
   *
   * Computed here rather than left to the server so the button can say
   * "Roster 20 days for 6 people" before anything is written. A confirmation
   * that names the size of what is about to happen is the only guard a bulk
   * write has.
   */
  const affectedDays = useMemo(() => {
    const keys = dayKeysBetween(startDate, endDate);
    if (!weekdays.length) return keys.length;
    return keys.filter((key) => weekdays.includes(isoWeekday(key))).length;
  }, [startDate, endDate, weekdays]);

  const rangeInvalid = startDate > endDate;
  const length = shiftHours({
    shiftType,
    startTime,
    endTime,
    requiredHours: flexible ? Number(requiredHours) : null,
  });

  const toggleWeekday = (day: number) =>
    setWeekdays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );

  const toggleEmployee = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((e) => e !== id) : [...current, id],
    );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!selected.length) {
      setError(t('bulkNoEmployees'));
      return;
    }
    if (rangeInvalid) {
      setError(t('loadFailed'));
      return;
    }

    try {
      const response = await bulk.mutateAsync({
        employeeIds: selected,
        startDate,
        endDate,
        // Empty means every day in the range, which is what the server expects —
        // this is a list of days the pattern APPLIES to, not a skip list.
        weekdays: weekdays.length ? [...weekdays].sort() : undefined,
        shiftType,
        startTime: flexible ? null : startTime,
        endTime: flexible ? null : endTime,
        requiredHours: flexible ? Number(requiredHours) : null,
        overwrite,
      });
      setResult(response.data);
      onSaved?.();
    } catch (err) {
      setError(apiErrorMessage(err, t('loadFailed')));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('bulkTitle')}
      data-testid="bulk-schedule-modal"
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[var(--radius-card)] border border-surface-border bg-surface-card shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-text-heading">
              {t('bulkTitle')}
            </h2>
            <p className="mt-0.5 text-[12px] text-text-muted">{t('bulkSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('bulkClose')}
            data-testid="bulk-modal-close"
            className="rounded-[var(--radius-button)] p-1.5 text-text-muted hover:bg-surface-border-light"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-5 py-5">
          {error && (
            <p
              role="alert"
              data-testid="bulk-modal-error"
              className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg/40 px-3 py-2 text-sm font-medium text-status-error"
            >
              {error}
            </p>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-text-body">
                {t('bulkEmployees')}
              </span>
              <span className="flex items-center gap-2 text-[12px]">
                <span
                  className="font-semibold text-text-muted"
                  data-testid="bulk-selected-count"
                >
                  {t('bulkSelected', { count: selected.length })}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(employees.map((e) => e.id))}
                  className="font-semibold text-brand-primary hover:underline"
                  data-testid="bulk-select-all"
                >
                  {t('bulkSelectAll')}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected([])}
                  className="font-semibold text-text-muted hover:underline"
                >
                  {t('bulkClear')}
                </button>
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-[var(--radius-card)] border border-surface-border">
              {employees.map((employee) => (
                <label
                  key={employee.id}
                  className="flex cursor-pointer items-center gap-2.5 border-b border-surface-border px-3 py-2 last:border-b-0 hover:bg-surface-page"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(employee.id)}
                    onChange={() => toggleEmployee(employee.id)}
                    data-testid={`bulk-employee-${employee.employeeCode}`}
                    className="h-4 w-4 accent-[var(--color-brand-primary)]"
                  />
                  <span className="truncate text-sm text-text-body">
                    {employee.fullName}
                  </span>
                  <span className="ms-auto text-[11px] font-semibold text-text-muted">
                    {employee.employeeCode}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('bulkFrom')}
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              data-testid="bulk-start-date"
              error={rangeInvalid ? ' ' : undefined}
            />
            <Input
              label={t('bulkTo')}
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              data-testid="bulk-end-date"
              error={rangeInvalid ? ' ' : undefined}
            />
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-text-body">
              {t('bulkWeekdays')}
            </span>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const on = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    aria-pressed={on}
                    data-testid={`bulk-weekday-${day}`}
                    className={`h-8 min-w-11 rounded-[var(--radius-button)] border px-2 text-[12px] font-semibold transition-colors ${
                      on
                        ? 'border-brand-primary bg-brand-primary text-text-on-brand'
                        : 'border-surface-border bg-surface-card text-text-body hover:bg-surface-page'
                    }`}
                  >
                    {t(`weekday.${day}`)}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-text-muted">
              {t('bulkWeekdaysHint')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('modalShiftType')}
              value={shiftType}
              onChange={(e) => setShiftType(e.target.value as ShiftType)}
              data-testid="bulk-shift-type"
            >
              {SHIFT_ORDER.map((type) => (
                <option key={type} value={type}>
                  {t(`shift.${type}`)}
                </option>
              ))}
            </Select>

            {flexible ? (
              <Input
                label={t('modalRequiredHours')}
                type="number"
                min={0.5}
                max={24}
                step={0.5}
                value={requiredHours}
                onChange={(e) => setRequiredHours(e.target.value)}
                data-testid="bulk-hours"
              />
            ) : (
              <>
                <Input
                  label={t('modalStartTime')}
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  data-testid="bulk-start-time"
                />
                <Input
                  label={t('modalEndTime')}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  data-testid="bulk-end-time"
                />
              </>
            )}
          </div>

          <p className="text-[11px] text-text-muted" data-testid="bulk-length">
            {!flexible && crossesMidnight(startTime, endTime)
              ? t('modalCrossesMidnight', { end: endTime, hours: length })
              : t('modalLength', { hours: length })}
          </p>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              data-testid="bulk-overwrite"
              className="mt-0.5 h-4 w-4 accent-[var(--color-brand-primary)]"
            />
            <span>
              <span className="block text-sm font-medium text-text-body">
                {t('bulkOverwrite')}
              </span>
              <span className="block text-[11px] text-text-muted">
                {t('bulkOverwriteHint')}
              </span>
            </span>
          </label>

          {result && (
            <div
              data-testid="bulk-result"
              className="rounded-[var(--radius-card)] border border-surface-border bg-surface-page px-3 py-2.5"
            >
              <p className="text-sm font-semibold text-text-heading">
                {t('bulkResult', {
                  created: result.created,
                  replaced: result.replaced,
                  skipped: result.skipped,
                  failed: result.failed,
                })}
              </p>
              {/* Only the rows that did NOT go through. A list of four hundred
                  successes is noise; the eleven that were refused is the answer. */}
              {result.results.some((r) => r.outcome === 'skipped' || r.outcome === 'failed') && (
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-[11px] text-text-muted">
                  {result.results
                    .filter((r) => r.outcome === 'skipped' || r.outcome === 'failed')
                    .slice(0, 40)
                    .map((row, i) => (
                      <li key={`${row.employeeId}-${row.date}-${i}`}>
                        {row.date} — {row.message ?? row.outcome}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              {result ? t('bulkClose') : t('cancel')}
            </Button>
            <Button
              type="submit"
              isLoading={bulk.isPending}
              disabled={!selected.length || rangeInvalid || affectedDays === 0}
              data-testid="bulk-apply"
            >
              {t('bulkApply', { days: affectedDays, people: selected.length })}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
