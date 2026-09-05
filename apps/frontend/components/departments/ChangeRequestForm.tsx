'use client';

import { useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useCreateChangeRequest } from '@/hooks/useChangeRequests';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { Department, DepartmentChangeType } from '@/types/department';

const CHANGE_TYPES: Array<{ value: DepartmentChangeType; label: string }> = [
  { value: 'MANAGER', label: 'Change the department head' },
  { value: 'PARENT', label: 'Move it under a different unit' },
  { value: 'RENAME', label: 'Rename it' },
  { value: 'DEACTIVATE', label: 'Close it' },
];

/**
 * The reason is the ONLY thing the reviewer sees beside the before and after,
 * so ten characters is the floor the server enforces and this mirrors.
 */
const changeRequestSchema = z
  .object({
    changeType: z.enum(['MANAGER', 'PARENT', 'RENAME', 'DEACTIVATE']),
    newManagerId: z.string().optional(),
    newParentId: z.string().optional(),
    newName: z.string().optional(),
    effectiveDate: z.string().min(1, 'Pick a date for the change to take effect'),
    reason: z.string().trim().min(10, 'Say why, in a sentence the reviewer can act on'),
  })
  .refine((values) => values.changeType !== 'MANAGER' || !!values.newManagerId?.trim(), {
    message: 'Name the person taking over',
    path: ['newManagerId'],
  })
  .refine((values) => values.changeType !== 'PARENT' || !!values.newParentId?.trim(), {
    message: 'Choose the unit it should report to',
    path: ['newParentId'],
  })
  .refine(
    (values) => values.changeType !== 'RENAME' || (values.newName?.trim().length ?? 0) >= 2,
    { message: 'Give the new name', path: ['newName'] },
  );

type ChangeRequestValues = z.infer<typeof changeRequestSchema>;

export default function ChangeRequestForm({
  department,
  onDone,
}: {
  department: Department;
  onDone: () => void;
}) {
  const createRequest = useCreateChangeRequest();
  const allDepartments = useDepartments();
  const employees = useEmployees({ limit: 200, status: 'ACTIVE' });

  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ChangeRequestValues>({
    resolver: zodResolver(changeRequestSchema),
    defaultValues: {
      changeType: 'MANAGER',
      newManagerId: '',
      newParentId: '',
      newName: department.name,
      effectiveDate: '',
      reason: '',
    },
  });

  const changeType = useWatch({ control, name: 'changeType' });

  // A unit cannot be moved under itself. Its descendants are refused by the
  // server too, but this list is what the reader is choosing from.
  const parentOptions = useMemo(
    () => (allDepartments.data?.data ?? []).filter((row) => row.id !== department.id),
    [allDepartments.data, department.id],
  );

  const onSubmit = async (values: ChangeRequestValues) => {
    try {
      await createRequest.mutateAsync({
        departmentId: department.id,
        changeType: values.changeType,
        reason: values.reason.trim(),
        effectiveDate: values.effectiveDate,
        newManagerId: values.changeType === 'MANAGER' ? values.newManagerId : undefined,
        newParentId: values.changeType === 'PARENT' ? values.newParentId : undefined,
        newName: values.changeType === 'RENAME' ? values.newName?.trim() : undefined,
      });
      toast.success('Change request raised');
      onDone();
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The request could not be raised'));
    }
  };

  const selectClass =
    'w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40';

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <div>
        <label
          htmlFor="change-type"
          className="mb-1.5 block text-sm font-medium text-text-body"
        >
          What should change
        </label>
        <select id="change-type" className={selectClass} {...register('changeType')}>
          {CHANGE_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      {changeType === 'MANAGER' && (
        <div>
          <label
            htmlFor="change-new-manager"
            className="mb-1.5 block text-sm font-medium text-text-body"
          >
            New head
          </label>
          <select id="change-new-manager" className={selectClass} {...register('newManagerId')}>
            <option value="">Choose somebody</option>
            {(employees.data?.data ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {fullName(employee)} ({employee.employeeCode})
              </option>
            ))}
          </select>
          {errors.newManagerId?.message && (
            <p className="mt-1.5 text-sm text-status-error">{errors.newManagerId.message}</p>
          )}
        </div>
      )}

      {changeType === 'PARENT' && (
        <div>
          <label
            htmlFor="change-new-parent"
            className="mb-1.5 block text-sm font-medium text-text-body"
          >
            New parent unit
          </label>
          <select id="change-new-parent" className={selectClass} {...register('newParentId')}>
            <option value="">Choose a unit</option>
            {parentOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} ({row.code})
              </option>
            ))}
          </select>
          {errors.newParentId?.message && (
            <p className="mt-1.5 text-sm text-status-error">{errors.newParentId.message}</p>
          )}
        </div>
      )}

      {changeType === 'RENAME' && (
        <Input label="New name" error={errors.newName?.message} {...register('newName')} />
      )}

      <Input
        label="Takes effect on"
        type="date"
        error={errors.effectiveDate?.message}
        {...register('effectiveDate')}
      />

      <div>
        <label htmlFor="change-reason" className="mb-1.5 block text-sm font-medium text-text-body">
          Reason
        </label>
        <textarea
          id="change-reason"
          rows={4}
          placeholder="What the reviewer needs to know to decide."
          className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
          {...register('reason')}
        />
        {errors.reason?.message && (
          <p className="mt-1.5 text-sm text-status-error">{errors.reason.message}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" isLoading={createRequest.isPending}>
          Raise request
        </Button>
      </div>
    </form>
  );
}
