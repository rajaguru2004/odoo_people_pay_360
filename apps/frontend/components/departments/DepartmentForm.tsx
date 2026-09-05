'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Network, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranches } from '@/hooks/useBranches';
import {
  useCreateDepartment,
  useDepartment,
  useDepartments,
  useUpdateDepartment,
} from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { Department } from '@/types/department';

const departmentSchema = z.object({
  code: z.string().trim().min(1, 'A code is required').max(32, 'At most 32 characters'),
  name: z.string().trim().min(1, 'A name is required').max(255, 'At most 255 characters'),
  description: z.string().optional(),
  branchId: z.string().optional(),
  parentId: z.string().optional(),
  managerId: z.string().optional(),
  isActive: z.boolean().optional(),
});

export type DepartmentFormValues = z.infer<typeof departmentSchema>;

const EMPTY: DepartmentFormValues = {
  code: '',
  name: '',
  description: '',
  branchId: '',
  parentId: '',
  managerId: '',
  isActive: true,
};

/**
 * The department itself and everything under it.
 *
 * The server refuses a parent that would close a cycle, and it is right to —
 * but a select that OFFERS the choice has already misled the reader about what
 * the structure allows. Walked from the flat list rather than the tree endpoint
 * so the exclusion holds even for a unit the chart is not currently drawing.
 */
function subtreeOf(departments: Department[], rootId: string | undefined): Set<string> {
  const excluded = new Set<string>();
  if (!rootId) return excluded;

  const childrenOf = new Map<string, string[]>();
  for (const department of departments) {
    if (!department.parentId) continue;
    const siblings = childrenOf.get(department.parentId) ?? [];
    siblings.push(department.id);
    childrenOf.set(department.parentId, siblings);
  }

  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return excluded;
}

export default function DepartmentForm({
  mode,
  departmentId,
}: {
  mode: 'create' | 'edit';
  departmentId?: string;
}) {
  const router = useRouter();

  usePageHeader(
    mode === 'create' ? 'New department' : 'Edit department',
    mode === 'create'
      ? 'A unit, where it sits and who is accountable for it.'
      : 'Moving a unit moves everything under it.',
  );

  const { data: departmentResponse, isLoading: loadingDepartment } = useDepartment(
    mode === 'edit' ? departmentId : undefined,
  );
  const allDepartments = useDepartments({ includeInactive: true });
  const branches = useBranches();
  const employees = useEmployees({ limit: 200, status: 'ACTIVE' });

  const createDepartment = useCreateDepartment();
  const updateDepartment = useUpdateDepartment();
  const saving = createDepartment.isPending || updateDepartment.isPending;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentSchema),
    defaultValues: EMPTY,
  });

  useEffect(() => {
    const department = departmentResponse?.data;
    if (mode !== 'edit' || !department) return;

    reset({
      code: department.code,
      name: department.name,
      description: department.description ?? '',
      branchId: department.branchId ?? '',
      parentId: department.parentId ?? '',
      managerId: department.managerId ?? '',
      isActive: department.isActive,
    });
  }, [mode, departmentResponse, reset]);

  const parentOptions = useMemo(() => {
    const rows = allDepartments.data?.data ?? [];
    const excluded = subtreeOf(rows, mode === 'edit' ? departmentId : undefined);
    return rows.filter((department) => !excluded.has(department.id));
  }, [allDepartments.data, mode, departmentId]);

  const onSubmit = async (values: DepartmentFormValues) => {
    const text = (value?: string) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    };

    const shared = {
      code: values.code.trim(),
      name: values.name.trim(),
      description: text(values.description),
      branchId: text(values.branchId),
      managerId: text(values.managerId),
    };

    try {
      if (mode === 'create') {
        const created = await createDepartment.mutateAsync({
          ...shared,
          parentId: text(values.parentId),
        });
        toast.success(`${shared.name} created`);
        router.push(`/dashboard/departments/${created.data.id}`);
      } else if (departmentId) {
        await updateDepartment.mutateAsync({
          id: departmentId,
          payload: {
            ...shared,
            // Explicit null, not undefined: clearing the select must MOVE the
            // unit to the top level, and omitting the field leaves the old
            // parent in place.
            parentId: text(values.parentId) ?? null,
            isActive: values.isActive,
          },
        });
        toast.success(`${shared.name} saved`);
        router.push(`/dashboard/departments/${departmentId}`);
      }
    } catch (error) {
      toast.error(apiErrorMessage(error, 'The department could not be saved'));
    }
  };

  if (mode === 'edit' && loadingDepartment) {
    return <Card className="p-6 text-sm text-text-muted">Loading department…</Card>;
  }

  const selectClass =
    'w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40';

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card className="space-y-8 p-6">
        <section className="space-y-5">
          <div className="flex items-start gap-3 border-b border-surface-border-light pb-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary">
              <Network className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-base font-semibold text-text-heading">Identity</h2>
              <p className="mt-0.5 text-sm text-text-muted">
                How the unit is named and referred to elsewhere.
              </p>
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <Input
              label="Department code"
              placeholder="OPS"
              error={errors.code?.message}
              {...register('code')}
            />
            <Input
              label="Department name"
              placeholder="Operations"
              error={errors.name?.message}
              {...register('name')}
            />
          </div>

          <div>
            <label
              htmlFor="department-description"
              className="mb-1.5 block text-sm font-medium text-text-body"
            >
              Description
            </label>
            <textarea
              id="department-description"
              rows={3}
              placeholder="What this unit is responsible for."
              className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
              {...register('description')}
            />
          </div>
        </section>

        <section className="space-y-5">
          <div className="flex items-start gap-3 border-b border-surface-border-light pb-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary">
              <Users className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-base font-semibold text-text-heading">Placement</h2>
              <p className="mt-0.5 text-sm text-text-muted">
                Where the unit sits, and who signs for the people in it.
              </p>
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label
                htmlFor="department-branch"
                className="mb-1.5 block text-sm font-medium text-text-body"
              >
                Branch
              </label>
              <select id="department-branch" className={selectClass} {...register('branchId')}>
                <option value="">No location</option>
                {(branches.data?.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="department-parent"
                className="mb-1.5 block text-sm font-medium text-text-body"
              >
                Reports to
              </label>
              <select id="department-parent" className={selectClass} {...register('parentId')}>
                <option value="">Top level</option>
                {parentOptions.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code})
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-text-muted">
                A unit cannot report to itself or to anything already beneath it.
              </p>
            </div>

            <div>
              <label
                htmlFor="department-head"
                className="mb-1.5 block text-sm font-medium text-text-body"
              >
                Department head
              </label>
              <select id="department-head" className={selectClass} {...register('managerId')}>
                <option value="">Nobody yet</option>
                {(employees.data?.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {fullName(employee)} ({employee.employeeCode})
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-text-muted">
                Without a head, nothing routed by department has an approver.
              </p>
            </div>

            {mode === 'edit' && (
              <label className="flex items-start gap-3 self-end rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-4">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-brand-primary"
                  {...register('isActive')}
                />
                <span>
                  <span className="text-sm font-medium text-text-body">Open</span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    A closed unit keeps its history but takes no new people.
                  </span>
                </span>
              </label>
            )}
          </div>
        </section>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" isLoading={saving}>
          {mode === 'create' ? 'Create department' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
