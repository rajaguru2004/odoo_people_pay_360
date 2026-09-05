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
import { useCreateLeaveRequest, useLeaveTypes } from '@/hooks/useLeaveRequests';
import { useEmployeeLeaveBalance } from '@/hooks/useLeaveBalances';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { formatDays } from '@/components/leave/leaveFormat';
import { fullName } from '@/utils/formatters';

const schema = z
  .object({
    // Empty means "file my own". HR picks somebody; everybody else cannot.
    employeeId: z.string().optional(),
    leaveType: z.string().min(1, 'Pick a leave type'),
    startDate: z.string().min(1, 'Pick the first day off'),
    endDate: z.string().min(1, 'Pick the last day off'),
    reason: z.string().min(3, 'Say why, in a sentence').max(1000),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The last day is before the first',
    path: ['endDate'],
  });

type FormValues = z.infer<typeof schema>;

/**
 * Filing leave.
 *
 * The form does NOT price the request. How many working days it costs depends on
 * the employee's branch calendar and on the holidays in force there, neither of
 * which the browser has — so the server counts them and the confirmation reports
 * what it counted. A client-side estimate would disagree with the balance the
 * approval actually spends, and the reader would have no way to tell which was
 * right.
 *
 * What the form DOES show is the balance, because "you have four days left" is
 * the fact that decides whether the request is worth filing at all.
 */
function NewLeaveRequestContent() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const isHr = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';
  const ownEmployeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  const types = useLeaveTypes();
  const createRequest = useCreateLeaveRequest();

  usePageHeader('File leave', 'The days are counted against the branch calendar.');

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employeeId: '',
      leaveType: '',
      startDate: '',
      endDate: '',
      reason: '',
    },
  });

  // Only loaded for the HR picker; an employee filing their own never fetches
  // the directory.
  const employees = useEmployees(isHr ? { limit: 200 } : {});
  // `useWatch` rather than `watch()`: the latter hands back a function the
  // React compiler refuses to memoise, so the whole form opts out of
  // compilation for the sake of two subscriptions.
  const watchedEmployeeId = useWatch({ control, name: 'employeeId' });
  const selectedType = useWatch({ control, name: 'leaveType' });
  const selectedEmployeeId = watchedEmployeeId || ownEmployeeId;

  const balance = useEmployeeLeaveBalance(selectedEmployeeId);
  const typeBalance = useMemo(
    () =>
      balance.data?.data.leaveTypeBalances.find(
        (b) => b.leaveTypeKey === selectedType,
      ),
    [balance.data, selectedType],
  );

  const chosenType = types.data?.data.find((t) => t.label === selectedType);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createRequest.mutateAsync({
        employeeId: values.employeeId || undefined,
        leaveType: values.leaveType,
        startDate: values.startDate,
        endDate: values.endDate,
        reason: values.reason,
      });
      toast.success('Leave filed. It is now waiting on an approver.');
      router.push(isHr ? '/dashboard/leaves' : '/dashboard/my-leaves');
    } catch (err) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` on it — so the precise server message is read through
      // `apiErrorMessage`, not `err.response.data.message`.
      toast.error(apiErrorMessage(err, 'The leave request could not be filed.'));
    }
  });

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-5">
      <Card>
        <CardHeader
          title="The request"
          subtitle="Weekly rest days and public holidays are excluded from the count."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {isHr && (
            <div className="sm:col-span-2">
              <Select
                label="Employee"
                placeholder="Myself"
                error={errors.employeeId?.message}
                {...register('employeeId')}
              >
                {(employees.data?.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {fullName(employee)} · {employee.employeeCode}
                  </option>
                ))}
              </Select>
              <p className="mt-1.5 text-xs text-text-muted">
                The days come out of their balance, so filing for somebody else
                is an HR action.
              </p>
            </div>
          )}

          <div className="sm:col-span-2">
            <Select
              label="Leave type"
              placeholder="Choose a type"
              error={errors.leaveType?.message}
              {...register('leaveType')}
            >
              {(types.data?.data ?? []).map((type) => (
                <option key={type.id} value={type.label}>
                  {type.label}
                </option>
              ))}
            </Select>
            {chosenType && (
              <p className="mt-1.5 text-xs text-text-muted">
                {chosenType.affectsBalance
                  ? `Counts against your ${chosenType.label} balance.`
                  : 'Recorded and approved, but costs no entitlement.'}
                {chosenType.requiresNoticeDays > 0 &&
                  ` Needs ${chosenType.requiresNoticeDays} days notice.`}
              </p>
            )}
          </div>

          <Input
            type="date"
            label="First day off"
            error={errors.startDate?.message}
            {...register('startDate')}
          />
          <Input
            type="date"
            label="Last day off"
            error={errors.endDate?.message}
            {...register('endDate')}
          />

          <div className="sm:col-span-2">
            <Textarea
              label="Reason"
              rows={4}
              placeholder="What the time off is for"
              error={errors.reason?.message}
              {...register('reason')}
            />
          </div>
        </CardBody>
      </Card>

      {selectedType && (
        <Card>
          <CardHeader title="Balance" subtitle={`Your ${selectedType} this year.`} />
          <CardBody>
            {balance.isLoading ? (
              <div className="h-6 w-40 animate-pulse rounded bg-surface-border/60" />
            ) : typeBalance ? (
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Figure label="Allocated" value={formatDays(typeBalance.allocated)} />
                <Figure label="Carried over" value={formatDays(typeBalance.carriedOver)} />
                <Figure label="Taken" value={formatDays(typeBalance.used)} />
                <Figure label="Remaining" value={formatDays(typeBalance.remaining)} emphasis />
              </dl>
            ) : (
              <p className="text-sm text-text-muted">
                {/* Not "0 days": no row means the year has not been set up, which
                    is a different fact from an exhausted entitlement. */}
                No balance has been set up for this type yet.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" isLoading={isSubmitting || createRequest.isPending}>
          File the request
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? 'mt-1 text-lg font-semibold tabular-nums text-brand-primary'
            : 'mt-1 text-lg font-semibold tabular-nums text-text-heading'
        }
      >
        {value}
      </dd>
    </div>
  );
}

export default function NewLeaveRequestPage() {
  return (
    <ProtectedRoute
      requiredRoles={['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE']}
    >
      <NewLeaveRequestContent />
    </ProtectedRoute>
  );
}
