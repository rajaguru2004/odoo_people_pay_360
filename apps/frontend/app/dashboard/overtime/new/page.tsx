'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { toast } from 'sonner';
import { ArrowLeft, Clock, Info } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useCreateOvertime } from '@/hooks/useOvertime';
import { useHolidays } from '@/hooks/useHolidays';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  buildOvertimeWindow,
  formatOvertimeHours,
} from '@/components/overtime/overtimeFormat';
import { apiErrorMessage } from '@/utils/apiError';

/**
 * How far the picker lets the overtime day move.
 *
 * Overtime is usually filed the morning after it was worked, so the window
 * opens backwards rather than pinning `min` to today. These bounds only keep a
 * mistyped year out of the field; the server still enforces the real caps.
 */
const BACKDATE_DAYS = 90;
const FORWARD_DAYS = 90;

const overtimeSchema = z
  .object({
    date: z.string().min(1, 'Pick the day you worked'),
    startTime: z.string().min(1, 'Give a start time'),
    endTime: z.string().min(1, 'Give an end time'),
    reason: z.string().min(10, 'Say what the extra hours were for, in a sentence'),
  })
  /**
   * An overnight shift is legitimate — 22:00 to 02:00 is four hours — so the end
   * is allowed to precede the start and rolls forward a day. What can never
   * mean anything is the two being IDENTICAL: with that roll-forward, picking
   * 09:00 twice files a 24-hour claim for a shift nobody worked.
   */
  .refine((values) => values.startTime !== values.endTime, {
    message: 'Start and end time cannot be the same',
    path: ['endTime'],
  });

type OvertimeForm = z.infer<typeof overtimeSchema>;

function NewOvertimeForm() {
  const router = useRouter();
  const role = useAuthStore((state) => state.user?.role);
  const createOvertime = useCreateOvertime();

  usePageHeader('File overtime', 'Claim the hours you worked past your shift');

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<OvertimeForm>({
    resolver: zodResolver(overtimeSchema),
    defaultValues: { date: '', startTime: '', endTime: '', reason: '' },
  });

  // `useWatch` rather than the form's own `watch()`: the latter hands back a
  // fresh function each render, which the compiler cannot memoize past.
  const date = useWatch({ control, name: 'date' });
  const startTime = useWatch({ control, name: 'startTime' });
  const endTime = useWatch({ control, name: 'endTime' });

  const bounds = useMemo(() => {
    const today = DateTime.now();
    return {
      min: today.minus({ days: BACKDATE_DAYS }).toFormat('yyyy-MM-dd'),
      max: today.plus({ days: FORWARD_DAYS }).toFormat('yyyy-MM-dd'),
    };
  }, []);

  const year = date ? Number(date.slice(0, 4)) : undefined;
  const { data: holidayData } = useHolidays(year ? { year } : {});

  /**
   * What kind of day this is, as far as the browser can tell.
   *
   * A hint only. Which tier the hours are actually paid at comes from the
   * employee's overtime policy and the branch calendar, and only the server can
   * resolve those — so this says "expect the rest-day rate", never a figure.
   */
  const dayNote = useMemo(() => {
    if (!date) return null;
    const day = DateTime.fromISO(date, { zone: 'utc' });
    if (!day.isValid) return null;

    const holiday = (holidayData?.data ?? []).find(
      (entry) => entry.date.slice(0, 10) === date,
    );
    if (holiday) return `${holiday.name} — a public holiday`;
    // Luxon numbers Sunday 7.
    if (day.weekday === 7) return 'A Sunday — the weekly rest day';
    return null;
  }, [date, holidayData]);

  const estimate = useMemo(() => {
    if (!date || !startTime || !endTime || startTime === endTime) return null;
    const window = buildOvertimeWindow(date, startTime, endTime);
    return window.hours > 0 ? window : null;
  }, [date, startTime, endTime]);

  const onSubmit = handleSubmit(async (values) => {
    const { startIso, endIso, hours } = buildOvertimeWindow(
      values.date,
      values.startTime,
      values.endTime,
    );

    if (hours <= 0) {
      toast.warning('That window has no hours in it');
      return;
    }

    try {
      await createOvertime.mutateAsync({
        date: values.date,
        startTime: startIso,
        endTime: endIso,
        hours,
        reason: values.reason.trim(),
      });
      toast.success('Overtime filed');
      // Back to whichever list this person actually has: an employee has no
      // access to the queue, so sending them there is a bounce to /403.
      router.push(role === 'EMPLOYEE' ? '/dashboard/my-overtime' : '/dashboard/overtime');
    } catch (error) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` to read through.
      toast.error(apiErrorMessage(error, 'Could not file the overtime'));
    }
  });

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => router.back()}>
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
        Back
      </Button>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Input
              label="Day worked"
              type="date"
              min={bounds.min}
              max={bounds.max}
              error={errors.date?.message}
              {...register('date')}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Started at"
                type="time"
                error={errors.startTime?.message}
                {...register('startTime')}
              />
              <Input
                label="Finished at"
                type="time"
                error={errors.endTime?.message}
                {...register('endTime')}
              />
            </div>

            {estimate && (
              <div
                data-testid="ot-estimate"
                data-hours={estimate.hours}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-surface-border-light bg-surface-page p-3 text-sm"
              >
                <Clock className="h-4 w-4 text-brand-primary" aria-hidden />
                <span className="text-text-body">
                  That is{' '}
                  <span className="font-semibold tabular-nums text-text-heading">
                    {formatOvertimeHours(estimate.hours)}
                  </span>
                  {startTime > endTime ? ', crossing midnight' : ''}
                </span>
                {dayNote && <span className="text-text-muted">· {dayNote}</span>}
              </div>
            )}

            <Textarea
              label="What the hours were for"
              rows={5}
              placeholder="Month-end close — the reconciliation had to be finished before the cut-off"
              error={errors.reason?.message}
              {...register('reason')}
            />

            <div className="flex flex-wrap justify-end gap-2 border-t border-surface-border-light pt-4">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" isLoading={createOvertime.isPending}>
                File it
              </Button>
            </div>
          </form>
        </Card>

        <Card className="h-fit p-5">
          <div className="mb-3 flex items-center gap-2">
            <Info className="h-4 w-4 text-brand-primary" aria-hidden />
            <h2 className="text-base font-semibold text-text-heading">Before you file</h2>
          </div>
          <ul className="space-y-2 text-sm text-text-body">
            <li>
              A claim needs approval before it reaches a payslip. It stays pending until
              every approver in the chain has answered.
            </li>
            <li>
              A shift that runs past midnight is fine — give the day it started on and the
              clock times as worked.
            </li>
            <li>
              The rate depends on the day and on the policy that governs you, so the
              payable figure is settled on approval rather than here.
            </li>
            <li>You can withdraw a claim yourself for as long as it is still pending.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default function NewOvertimePage() {
  return (
    // Ungated: anyone with a session may claim their own hours, and the server
    // files it against the caller's own employee record.
    <ProtectedRoute>
      <NewOvertimeForm />
    </ProtectedRoute>
  );
}
