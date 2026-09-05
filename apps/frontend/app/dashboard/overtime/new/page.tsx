'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useAuthStore } from '@/store/authStore';
import { useCreateOvertime } from '@/hooks/useOvertime';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import { formatHours, toOvertimeInstant, windowHours } from '@/utils/overtimeCalc';

const schema = z.object({
  employeeId: z.string().optional(),
  date: z.string().min(1, 'Pick the day worked'),
  startTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  endTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  reason: z.string().max(1000).optional(),
});

type FormValues = z.infer<typeof schema>;

/**
 * Logging overtime.
 *
 * The form computes the LENGTH of the window and nothing else. How those hours
 * split across the payable tiers, whether a food allowance applies and whether
 * the day is a rest day all depend on the employee's overtime policy and on the
 * branch calendar — neither of which the browser has. Guessing here would put a
 * figure on screen that the approval then contradicts.
 *
 * Times are sent as wall clocks tagged UTC. An entered 17:30 goes up as
 * "…T17:30:00Z" whatever zone the browser is in; building the instant with a
 * local constructor would post 13:30 from Muscat and the server would refuse the
 * request as not matching its own hours.
 */
function LogOvertimeContent() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isHr = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  const createOvertime = useCreateOvertime();
  const employees = useEmployees(isHr ? { limit: 200 } : {});

  usePageHeader(
    'Log overtime',
    'Overtime has to start outside the working day.',
  );

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employeeId: '',
      date: '',
      startTime: '17:30',
      endTime: '21:30',
      reason: '',
    },
  });

  // `useWatch` rather than `watch()`: the latter hands back a function the
  // React compiler refuses to memoise, so the whole form opts out of
  // compilation for the sake of two subscriptions.
  const startTime = useWatch({ control, name: 'startTime' });
  const endTime = useWatch({ control, name: 'endTime' });

  const hours = useMemo(
    () => windowHours(startTime, endTime),
    [startTime, endTime],
  );
  // An end at or before the start is read as crossing midnight, exactly as the
  // server reads it — not as an error.
  const crossesMidnight = useMemo(() => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
    return eh * 60 + em <= sh * 60 + sm;
  }, [startTime, endTime]);

  const onSubmit = handleSubmit(async (values) => {
    const start = toOvertimeInstant(values.date, values.startTime);
    const end = toOvertimeInstant(values.date, values.endTime);
    const computed = windowHours(values.startTime, values.endTime);

    if (!start || !end || computed === null) {
      toast.error('The date and times could not be read.');
      return;
    }

    try {
      await createOvertime.mutateAsync({
        employeeId: values.employeeId || undefined,
        payload: {
          date: values.date,
          startTime: start,
          endTime: end,
          hours: computed,
          reason: values.reason?.trim() || undefined,
        },
      });
      toast.success('Overtime logged. It is now waiting on an approver.');
      router.push(isHr ? '/dashboard/overtime' : '/dashboard/my-overtime');
    } catch (err) {
      // The interceptor rejects with a FLAT object, so the server's precise
      // message — a cap, a duplicate date, an overlap with the working day — is
      // read through `apiErrorMessage` rather than `err.response.data.message`.
      toast.error(apiErrorMessage(err, 'The overtime could not be logged.'));
    }
  });

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-5">
      <Card>
        <CardHeader
          title="The window worked"
          subtitle="Enter the clock times as they were worked; the server splits them into the payable tiers."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {isHr && (
            <div className="sm:col-span-2">
              <Select
                label="Employee"
                placeholder="Myself"
                {...register('employeeId')}
              >
                {(employees.data?.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {fullName(employee)} · {employee.employeeCode}
                  </option>
                ))}
              </Select>
              <p className="mt-1.5 text-xs text-text-muted">
                These hours become their pay, so recording them for somebody else
                is an HR action.
              </p>
            </div>
          )}

          <div className="sm:col-span-2">
            <Input
              type="date"
              label="Day worked"
              error={errors.date?.message}
              {...register('date')}
            />
          </div>

          <Input
            type="time"
            label="Started"
            error={errors.startTime?.message}
            {...register('startTime')}
          />
          <Input
            type="time"
            label="Finished"
            error={errors.endTime?.message}
            {...register('endTime')}
          />

          <div className="sm:col-span-2">
            <Textarea
              label="Reason"
              rows={3}
              placeholder="Line 3 changeover ran past the shift"
              error={errors.reason?.message}
              {...register('reason')}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What will be filed"
          subtitle="The tier split, the allowance and the day type are decided by the server against this employee's policy."
        />
        <CardBody>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums text-text-heading">
              {formatHours(hours)}
            </span>
            <span className="text-sm text-text-muted">worked</span>
          </div>

          {crossesMidnight && (
            <p className="mt-3 text-sm text-text-muted">
              This window crosses midnight and is read as finishing the next
              morning. How much of it is payable depends on when the company
              closes its attendance day.
            </p>
          )}

          <p className="mt-3 text-sm text-text-muted">
            The payable total can be lower than this: overtime is counted up to
            the close of the attendance day and never past it.
          </p>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" isLoading={isSubmitting || createOvertime.isPending}>
          Log the overtime
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function LogOvertimePage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE']}
    >
      <LogOvertimeContent />
    </ProtectedRoute>
  );
}
