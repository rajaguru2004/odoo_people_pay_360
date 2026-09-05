'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Calendar, Save, Upload, X } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  useCreateLeaveRequest,
  useLeaveBalance,
  useLeaveTypes,
  useUploadLeaveAttachment,
} from '@/hooks/useLeaveRequests';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { apiErrorMessage } from '@/utils/apiError';
import type { LeaveTypeOption } from '@/types/leave';

const leaveSchema = z.object({
  leaveType: z.string().min(1, 'Leave type is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  reason: z.string().min(10, 'The reason must be at least 10 characters'),
});

type LeaveFormData = z.infer<typeof leaveSchema>;

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
const MAX_SIZE = 10 * 1024 * 1024;

/** Today, as the date pickers' floor. */
function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Both endpoints count, so a single day off is one day rather than zero.
 *
 * A preview only: the server settles the figure against the working calendar
 * when the request is decided, which is why the panel says so beside it.
 */
function inclusiveDays(startDate?: string, endDate?: string) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diff = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diff / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Which types this employee may actually apply for.
 *
 * A gender-restricted type must not be offered to somebody who can only be
 * refused it, so the balance payload names the employee's gender and this
 * compares against it.
 *
 * An unknown gender offers everything. Hiding an entitlement because a record
 * is incomplete is a silent denial, and the server still refuses what it
 * should — whereas offering one that is then refused says plainly which field
 * needs filling in.
 */
function offeredTypes(
  types: LeaveTypeOption[],
  gender: string | null | undefined,
): LeaveTypeOption[] {
  if (!gender) return types;
  const normalised = gender.toUpperCase();
  return types.filter(
    (type) =>
      !type.genderRestriction ||
      type.genderRestriction.toUpperCase() === normalised,
  );
}

function NewLeaveForm() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employee?.id ?? user?.employeeId ?? undefined;

  usePageHeader('New leave request', 'Fill in the details below to submit your request');

  // Admin and HR decide other people's requests. Letting them file their own
  // here would produce a request they are also an approver for.
  const isHrOrAdmin = user?.role === 'ADMIN' || user?.role === 'HR_MANAGER';

  const [attachments, setAttachments] = useState<File[]>([]);

  const leaveTypesQuery = useLeaveTypes();
  const balanceQuery = useLeaveBalance(isHrOrAdmin ? undefined : employeeId);
  const createRequest = useCreateLeaveRequest();
  const uploadAttachment = useUploadLeaveAttachment();

  const balance = balanceQuery.data?.data;

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    setValue,
    getValues,
  } = useForm<LeaveFormData>({
    resolver: zodResolver(leaveSchema),
    defaultValues: { leaveType: '', startDate: '', endDate: '', reason: '' },
  });

  const visibleTypes = useMemo<LeaveTypeOption[]>(() => {
    const all = leaveTypesQuery.data?.data ?? [];
    return offeredTypes(all, balance?.gender);
  }, [leaveTypesQuery.data, balance]);

  // Seed the picker, and re-seed it if the visible list narrows out from under
  // a selection the employee is no longer offered.
  useEffect(() => {
    if (visibleTypes.length === 0) return;
    const current = getValues('leaveType');
    if (!current || !visibleTypes.some((type) => type.label === current)) {
      setValue('leaveType', visibleTypes[0].label);
    }
  }, [visibleTypes, getValues, setValue]);

  // `useWatch` rather than the form's `watch()`: the latter hands back a fresh
  // function on every render, which opts this component out of compilation.
  const startDate = useWatch({ control, name: 'startDate' });
  const endDate = useWatch({ control, name: 'endDate' });
  const estimatedDays = inclusiveDays(startDate, endDate);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;

    const accepted: File[] = [];
    for (const file of Array.from(event.target.files)) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`Invalid file type for "${file.name}". Only PDF and JPG/PNG images are allowed.`);
        continue;
      }
      if (file.size > MAX_SIZE) {
        toast.error(`File "${file.name}" exceeds the 10MB limit.`);
        continue;
      }
      accepted.push(file);
    }

    setAttachments((previous) => [...previous, ...accepted]);
    // Clearing the control lets the same file be picked again after a removal.
    event.target.value = '';
  };

  const removeFile = (index: number) => {
    setAttachments((previous) => previous.filter((_, i) => i !== index));
  };

  const onSubmit = handleSubmit(async (data) => {
    try {
      const response = await createRequest.mutateAsync(data);
      const leaveId = response.data.id;

      // Create first, then attach. The two are not one transaction, so a failed
      // upload must surface on its own rather than reading as a failed request.
      for (const file of attachments) {
        await uploadAttachment.mutateAsync({ leaveRequestId: leaveId, file });
      }

      toast.success('Leave request submitted. It is now awaiting approval.');
      router.push('/dashboard/my-leaves');
    } catch (error) {
      // The axios interceptor rejects with a FLAT object — there is no
      // `.response` to read through.
      toast.error(apiErrorMessage(error, 'Failed to submit leave request'));
    }
  });

  if (isHrOrAdmin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="space-y-3 text-center">
          <h2 className="text-lg font-semibold text-text-heading">This screen is self-service</h2>
          <p className="text-sm text-text-muted">
            HR and admin users do not file their own leave here.
          </p>
          <p className="text-sm text-text-muted">
            Go back to the list to review the requests waiting on you.
          </p>
          <Button className="mt-4" onClick={() => router.push('/dashboard/leaves')}>
            Back to leave requests
          </Button>
        </div>
      </div>
    );
  }

  const submitting = createRequest.isPending || uploadAttachment.isPending;

  return (
    <div className="space-y-5" data-testid="leave-new">
      <div className="flex justify-start">
        <Button variant="outline" onClick={() => router.back()}>
          Back
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <form onSubmit={onSubmit} className="space-y-4">
            <Select
              label="Leave type"
              error={errors.leaveType?.message}
              {...register('leaveType')}
            >
              {visibleTypes.map((type) => (
                <option key={type.id} value={type.label}>
                  {type.label}
                </option>
              ))}
            </Select>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Start date"
                type="date"
                min={today()}
                error={errors.startDate?.message}
                {...register('startDate')}
              />
              <Input
                label="End date"
                type="date"
                // Floored at the start date so the picker cannot produce a range
                // that runs backwards.
                min={startDate || today()}
                error={errors.endDate?.message}
                {...register('endDate')}
              />
            </div>

            {estimatedDays > 0 && (
              <div className="rounded-[var(--radius-card)] border border-status-info/20 bg-status-info-bg p-3">
                <p className="text-sm font-medium text-status-info">
                  <span className="font-semibold">Estimated Days:</span> {estimatedDays} days
                  <span className="ms-2 text-xs text-text-muted">
                    (Weekends included here; the exact figure is settled on approval.)
                  </span>
                </p>
              </div>
            )}

            <Textarea
              label="Reason"
              rows={4}
              placeholder="Give the approver enough to decide on"
              error={errors.reason?.message}
              {...register('reason')}
            />

            <div className="space-y-2">
              <label
                htmlFor="leave-attachments"
                className="block text-sm font-medium text-text-body"
              >
                Attachments{' '}
                <span className="font-normal text-text-muted">
                  (optional, PDF/JPG/PNG only, max 10MB each)
                </span>
              </label>
              <div className="flex w-full items-center justify-center">
                <label
                  htmlFor="leave-attachments"
                  className="flex w-full cursor-pointer flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-surface-border bg-surface-page p-4 transition-colors hover:bg-surface-border-light"
                >
                  <Upload className="mb-1.5 h-5 w-5 text-text-muted" aria-hidden />
                  <p className="text-sm text-text-body">
                    <span className="font-semibold">Click to upload</span> or drag and drop
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    PDF, PNG, JPG or JPEG — 10MB per file
                  </p>
                  <input
                    id="leave-attachments"
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={handleFileChange}
                  />
                </label>
              </div>

              {attachments.length > 0 && (
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                    Selected files
                  </p>
                  <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {attachments.map((file, index) => (
                      <li
                        key={`${file.name}-${index}`}
                        className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-2.5 text-sm text-text-body"
                      >
                        <span className="truncate">{file.name}</span>
                        <span className="shrink-0 text-xs text-text-muted">
                          ({(file.size / (1024 * 1024)).toFixed(2)} MB)
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => removeFile(index)}
                          className="shrink-0 rounded-[var(--radius-button)] p-1 text-status-error hover:bg-status-error-bg"
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {uploadAttachment.isPending && (
                <p className="text-sm text-text-muted">Uploading attachments…</p>
              )}
            </div>

            <div className="flex gap-3 border-t border-surface-border-light pt-4">
              <Button type="submit" className="flex-1" isLoading={submitting} data-testid="leave-submit">
                <Save className="h-4 w-4" aria-hidden />
                Submit request
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          {balance && balance.leaveTypeBalances && balance.leaveTypeBalances.length > 0
            ? balance.leaveTypeBalances.map((tb) => (
                <Card key={tb.id} className="p-4">
                  <div className="mb-2 flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                      <Calendar className="h-4 w-4" aria-hidden />
                    </span>
                    <p className="truncate text-xs font-medium text-text-muted">
                      Remaining {tb.leaveTypeKey}
                    </p>
                  </div>
                  <p className="text-2xl font-semibold tabular-nums text-text-heading">
                    {tb.remaining}
                    <span className="ms-1 text-xs font-normal text-text-muted">
                      / {tb.allocated + tb.carriedOver} days
                    </span>
                  </p>
                </Card>
              ))
            : balance && (
                <>
                  <Card className="p-4">
                    <div className="mb-2 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-brand-primary/10 text-brand-primary">
                        <Calendar className="h-4 w-4" aria-hidden />
                      </span>
                      <p className="truncate text-xs font-medium text-text-muted">
                        Remaining annual leave
                      </p>
                    </div>
                    <p className="text-2xl font-semibold tabular-nums text-text-heading">
                      {balance.remainingAnnual ??
                        balance.annualLeave + balance.carriedOver - balance.usedAnnual}
                      <span className="ms-1 text-xs font-normal text-text-muted">
                        / {balance.annualLeave + balance.carriedOver} days
                      </span>
                    </p>
                  </Card>
                  <Card className="p-4">
                    <div className="mb-2 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] bg-status-success-bg text-status-success">
                        <Calendar className="h-4 w-4" aria-hidden />
                      </span>
                      <p className="truncate text-xs font-medium text-text-muted">
                        Remaining sick leave
                      </p>
                    </div>
                    <p className="text-2xl font-semibold tabular-nums text-text-heading">
                      {balance.remainingSick ?? balance.sickLeave - balance.usedSick}
                      <span className="ms-1 text-xs font-normal text-text-muted">
                        / {balance.sickLeave} days
                      </span>
                    </p>
                  </Card>
                </>
              )}

          <div className="rounded-[var(--radius-card)] border border-status-warning/30 bg-status-warning-bg p-3">
            <p className="mb-1.5 text-sm font-medium text-status-warning">Before you submit</p>
            <ul className="space-y-1 text-xs text-status-warning">
              <li>• Annual leave should be requested three days in advance.</li>
              <li>• Sick leave needs medical confirmation attached.</li>
              <li>• Weekends and holidays are excluded when the days are settled.</li>
              <li>• The request goes to your direct manager for approval.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NewLeavePage() {
  return (
    <ProtectedRoute>
      <NewLeaveForm />
    </ProtectedRoute>
  );
}
