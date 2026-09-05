'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateSchedule, useUpdateSchedule } from '@/hooks/useSchedules';
import { apiErrorMessage } from '@/utils/apiError';
import {
  SHIFT_ORDER,
  crossesMidnight,
  shiftHours,
  todayKey,
} from '@/utils/scheduleHours';
import type { ShiftType, WorkSchedule } from '@/types/attendance';

/**
 * The shift each type suggests when it is picked.
 *
 * A DEFAULT, never a constraint: the server stores whatever clocks it is sent,
 * and a plant that runs its mornings from 06:00 must be able to say so. Pre-
 * filling saves the ordinary case four keystrokes; refusing the unusual one
 * would make the screen useless at exactly the site that needs it.
 */
const SHIFT_DEFAULTS: Record<ShiftType, { start: string; end: string } | null> = {
  MORNING: { start: '06:00', end: '14:00' },
  AFTERNOON: { start: '14:00', end: '22:00' },
  FULL_DAY: { start: '08:00', end: '17:00' },
  NIGHT: { start: '22:00', end: '06:00' },
  FLEXIBLE: null,
};

export interface ScheduleModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** The row being edited. Absent means this is a create. */
  schedule?: WorkSchedule | null;
  /** Pre-selected on create. The employee picker is hidden when it is fixed. */
  employeeId?: string;
  employeeName?: string;
  /** Pre-filled date on create, e.g. the cell that was clicked. */
  date?: string;
}

/**
 * Roster one shift, or edit one.
 *
 * `employeeId` and `date` are fixed once a row exists: the table is unique on
 * the pair, so moving a row to another person or another day is a DIFFERENT row
 * — delete this one and roster that one. The fields are shown disabled while
 * editing rather than hidden, because "which day am I editing" is the first
 * thing a reader checks.
 */
/**
 * The form is MOUNTED when the modal opens and unmounted when it closes.
 *
 * That is what seeds the fields, rather than an effect that copies props into
 * state: React's own guidance is to key a component on the thing it is editing
 * and let the mount do the work. An effect here also re-rendered the whole form
 * twice on every open, and got the "keeps the last person's night rota" bug
 * wrong in the one case that mattered — opening the create form directly after
 * an edit, where `schedule` goes from a row to `null` and the identity check
 * fires a frame late.
 */
export default function ScheduleModal(props: ScheduleModalProps) {
  if (!props.open) return null;
  return (
    <ScheduleForm
      {...props}
      key={props.schedule?.id ?? `new-${props.employeeId ?? ''}-${props.date ?? ''}`}
    />
  );
}

function ScheduleForm({
  onClose,
  onSaved,
  schedule,
  employeeId,
  employeeName,
  date,
}: ScheduleModalProps) {
  const t = useTranslations('schedules');
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const editing = Boolean(schedule);

  const [shiftType, setShiftType] = useState<ShiftType>(
    schedule?.shiftType ?? 'FULL_DAY',
  );
  const [startTime, setStartTime] = useState(schedule?.startTime ?? '08:00');
  const [endTime, setEndTime] = useState(schedule?.endTime ?? '17:00');
  const [requiredHours, setRequiredHours] = useState(
    schedule?.requiredHours != null ? String(Number(schedule.requiredHours)) : '8',
  );
  const [isWorkDay, setIsWorkDay] = useState(schedule?.isWorkDay ?? true);
  const [notes, setNotes] = useState(schedule?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const effectiveDate = schedule?.date?.slice(0, 10) ?? date ?? todayKey();
  const effectiveEmployeeId = schedule?.employeeId ?? employeeId ?? '';

  const flexible = shiftType === 'FLEXIBLE';

  const onShiftTypeChange = (next: ShiftType) => {
    setShiftType(next);
    const preset = SHIFT_DEFAULTS[next];
    if (preset) {
      setStartTime(preset.start);
      setEndTime(preset.end);
    }
  };

  /** The length the reader is about to save, so it is never a surprise. */
  const length = useMemo(
    () =>
      shiftHours({
        shiftType,
        startTime,
        endTime,
        requiredHours: flexible ? Number(requiredHours) : null,
      }),
    [shiftType, startTime, endTime, requiredHours, flexible],
  );

  const wrapsMidnight = !flexible && crossesMidnight(startTime, endTime);
  const saving = create.isPending || update.isPending;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (flexible && !(Number(requiredHours) > 0)) {
      setError(t('modalRequiredHoursHint'));
      return;
    }
    if (!flexible && length === 0) {
      setError(t('modalCrossesMidnight', { end: endTime, hours: 0 }));
      return;
    }

    const payload = {
      shiftType,
      startTime: flexible ? null : startTime,
      endTime: flexible ? null : endTime,
      requiredHours: flexible ? Number(requiredHours) : null,
      isWorkDay,
      notes: notes.trim() || null,
    };

    try {
      if (schedule) {
        await update.mutateAsync({ id: schedule.id, payload });
      } else {
        await create.mutateAsync({
          ...payload,
          employeeId: effectiveEmployeeId,
          date: effectiveDate,
        });
      }
      onSaved?.();
      onClose();
    } catch (err) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` on it — so the message has to come through this helper.
      setError(apiErrorMessage(err, t('loadFailed')));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? t('modalEditTitle') : t('modalCreateTitle')}
      data-testid="schedule-modal"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[var(--radius-card)] border border-surface-border bg-surface-card shadow-lg">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 className="text-base font-bold text-text-heading">
            {editing ? t('modalEditTitle') : t('modalCreateTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('cancel')}
            data-testid="schedule-modal-close"
            className="rounded-[var(--radius-button)] p-1.5 text-text-muted hover:bg-surface-border-light"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          {error && (
            <p
              role="alert"
              data-testid="schedule-modal-error"
              className="rounded-[var(--radius-card)] border border-status-error/30 bg-status-error-bg/40 px-3 py-2 text-sm font-medium text-status-error"
            >
              {error}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('modalEmployee')}
              // The embedded ref carries first and last name, never a joined
              // one — `fullName` is a server-side convenience the roster rows
              // do not include.
              value={
                employeeName ??
                (schedule?.employee
                  ? [schedule.employee.firstName, schedule.employee.lastName]
                      .filter(Boolean)
                      .join(' ')
                  : '')
              }
              readOnly
              disabled
            />
            <Input
              label={t('modalDate')}
              type="date"
              value={effectiveDate}
              readOnly
              disabled
              data-testid="schedule-modal-date"
            />
          </div>

          <Select
            label={t('modalShiftType')}
            value={shiftType}
            onChange={(e) => onShiftTypeChange(e.target.value as ShiftType)}
            data-testid="schedule-modal-type"
          >
            {SHIFT_ORDER.map((type) => (
              <option key={type} value={type}>
                {t(`shift.${type}`)}
              </option>
            ))}
          </Select>

          {flexible ? (
            <div>
              <Input
                label={t('modalRequiredHours')}
                type="number"
                min={0.5}
                max={24}
                step={0.5}
                value={requiredHours}
                onChange={(e) => setRequiredHours(e.target.value)}
                data-testid="schedule-modal-hours"
              />
              <p className="mt-1.5 text-[11px] text-text-muted">
                {t('modalRequiredHoursHint')}
              </p>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t('modalStartTime')}
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  data-testid="schedule-modal-start"
                />
                <Input
                  label={t('modalEndTime')}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  data-testid="schedule-modal-end"
                />
              </div>
              {/* An end before the start is a NIGHT shift, not an error. Saying
                  so here is what stops somebody "fixing" a correct 22:00–06:00
                  rota into a sixteen-hour day. */}
              <p
                className="mt-1.5 text-[11px] text-text-muted"
                data-testid="schedule-modal-length"
              >
                {wrapsMidnight
                  ? t('modalCrossesMidnight', { end: endTime, hours: length })
                  : t('modalLength', { hours: length })}
              </p>
            </div>
          )}

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={isWorkDay}
              onChange={(e) => setIsWorkDay(e.target.checked)}
              data-testid="schedule-modal-workday"
              className="mt-0.5 h-4 w-4 accent-[var(--color-brand-primary)]"
            />
            <span>
              <span className="block text-sm font-medium text-text-body">
                {t('modalIsWorkDay')}
              </span>
              <span className="block text-[11px] text-text-muted">
                {t('modalIsWorkDayHint')}
              </span>
            </span>
          </label>

          <Textarea
            label={t('modalNotes')}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="schedule-modal-notes"
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              isLoading={saving}
              data-testid="schedule-modal-save"
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
