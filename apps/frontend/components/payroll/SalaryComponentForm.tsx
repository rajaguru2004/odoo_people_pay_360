'use client';

import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { COMPONENT_TYPES, COMPONENT_TYPE_LABEL } from '@/components/payroll/ComponentTypeBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  useCreateSalaryComponent,
  useUpdateSalaryComponent,
} from '@/hooks/useSalaryComponents';
import { apiErrorMessage } from '@/utils/apiError';
import type { ApiResponse } from '@/types/api';
import type { SalaryComponentType } from '@/types/payroll';
import type {
  CreateSalaryComponentPayload,
  SalaryComponent,
  UpdateSalaryComponentPayload,
} from '@/types/salaryStructure';

/**
 * The salary RULE, as a form.
 *
 * A component is the rule in this design: `type` decides which bucket the
 * amount lands in, `isTaxable` and `isGratuityBase` decide how the rest of the
 * system has to treat it, and `sequence` decides where it prints on a payslip.
 * There is no separate rule model because the engine reads exactly these
 * properties and nothing else.
 *
 * Every field is a STRING in the schema and converted only when the payload is
 * built. A number input bound to a number turns into `NaN` the moment the field
 * is cleared, and `NaN` reaches the API as `null` — a sequence that silently
 * became "no answer" reorders somebody's payslip.
 */
const componentSchema = z
  .object({
    code: z.string().min(1, 'A code is required'),
    name: z.string().min(1, 'A name is required'),
    type: z.string().min(1, 'A type is required'),
    sequence: z.string(),
    isTaxable: z.boolean(),
    isGratuityBase: z.boolean(),
  })
  .superRefine((values, ctx) => {
    // The same rule the server enforces, so a rejected code is caught while the
    // person can still see which characters they typed.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(values.code.trim())) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message:
          'A code has to start with a letter and hold only letters, numbers and underscores',
      });
    }

    if (values.code.trim().length > 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'A code cannot be longer than 32 characters',
      });
    }

    if (values.sequence.trim()) {
      const sequence = Number(values.sequence);
      if (!Number.isInteger(sequence) || sequence < 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['sequence'],
          message: 'The print order has to be a whole number of zero or more',
        });
      }
    }
  });

type ComponentFormValues = z.infer<typeof componentSchema>;

export interface SalaryComponentFormProps {
  /** Present for an edit. Absent creates a new component. */
  component?: SalaryComponent;
  /** Where to go once the write lands. Defaults to the catalogue. */
  onSaved?: (component: SalaryComponent) => void;
}

export default function SalaryComponentForm({
  component,
  onSaved,
}: SalaryComponentFormProps) {
  const router = useRouter();
  const createComponent = useCreateSalaryComponent();
  const updateComponent = useUpdateSalaryComponent();
  const editing = Boolean(component);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ComponentFormValues>({
    resolver: zodResolver(componentSchema),
    defaultValues: {
      code: component?.code ?? '',
      name: component?.name ?? '',
      type: component?.type ?? 'EARNING',
      sequence: String(component?.sequence ?? 100),
      isTaxable: component?.isTaxable ?? true,
      isGratuityBase: component?.isGratuityBase ?? false,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (component) {
        // `code` and `type` are absent on purpose — the PATCH DTO omits them,
        // and sending either would be rejected as a non-whitelisted property.
        const payload: UpdateSalaryComponentPayload = {
          name: values.name.trim(),
          isTaxable: values.isTaxable,
          isGratuityBase: values.isGratuityBase,
          ...(values.sequence.trim() ? { sequence: Number(values.sequence) } : {}),
        };
        // The shared mutation helper in `useSalaryComponents` is generic over
        // its VARIABLES only, so its result is typed `unknown`. The service it
        // wraps resolves the envelope, and the cast says which one.
        const saved = (await updateComponent.mutateAsync({
          id: component.id,
          payload,
        })) as ApiResponse<SalaryComponent>;
        toast.success('Salary component updated');
        if (onSaved) onSaved(saved.data);
        else router.push('/dashboard/payroll/salary-components');
        return;
      }

      const payload: CreateSalaryComponentPayload = {
        // Uppercased here as well as on the server, so the field shows the code
        // that will actually exist rather than the one that was typed.
        code: values.code.trim().toUpperCase(),
        name: values.name.trim(),
        type: values.type as SalaryComponentType,
        isTaxable: values.isTaxable,
        isGratuityBase: values.isGratuityBase,
        ...(values.sequence.trim() ? { sequence: Number(values.sequence) } : {}),
      };
      const saved = (await createComponent.mutateAsync(
        payload,
      )) as ApiResponse<SalaryComponent>;
      toast.success('Salary component created');
      if (onSaved) onSaved(saved.data);
      else router.push('/dashboard/payroll/salary-components');
    } catch (err) {
      // The interceptor rejects with a FLAT object: `err.response` does not
      // exist, and the duplicate-code sentence is on `err.message`.
      toast.error(
        apiErrorMessage(
          err,
          editing ? 'Could not update this component' : 'Could not create this component',
        ),
      );
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Card>
        <CardHeader
          title="Identity"
          subtitle={
            editing
              ? 'The code and the type are fixed once a component exists.'
              : 'The code is the stable key a payslip line joins on.'
          }
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {editing ? (
            <>
              {/* Read-only rather than merely disabled inputs, so there is
                  nothing on screen that looks editable and silently is not. */}
              <div className="min-w-0">
                <p className="mb-1.5 text-sm font-medium text-text-body">Code</p>
                <p className="rounded-[var(--radius-input)] border border-surface-border bg-surface-border-light/60 px-3 py-2 font-mono text-sm text-text-body">
                  {component?.code}
                </p>
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-sm font-medium text-text-body">Type</p>
                <p className="rounded-[var(--radius-input)] border border-surface-border bg-surface-border-light/60 px-3 py-2 text-sm text-text-body">
                  {COMPONENT_TYPE_LABEL[component!.type] ?? component!.type}
                </p>
              </div>
            </>
          ) : (
            <>
              <Input
                label="Code"
                placeholder="HRA"
                className="font-mono uppercase"
                error={errors.code?.message}
                {...register('code')}
              />
              <Select label="Type" error={errors.type?.message} {...register('type')}>
                {COMPONENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {COMPONENT_TYPE_LABEL[type]}
                  </option>
                ))}
              </Select>
            </>
          )}

          <Input
            label="Name"
            placeholder="Housing allowance"
            error={errors.name?.message}
            {...register('name')}
          />
        </CardBody>

        {editing && (
          <div className="flex items-start gap-2 border-t border-surface-border-light px-5 py-4 text-sm text-text-muted">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              A payslip line joins on the code, so renaming it orphans every
              report that groups by it — and turning an earning into a deduction
              would change the meaning of money that has already been paid.
              Retire this component and create its successor instead.
            </p>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Rule"
          subtitle="How the rest of the system has to treat this component."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              type="number"
              min={0}
              step={1}
              label="Print order"
              error={errors.sequence?.message}
              {...register('sequence')}
            />
          </div>

          <div className="space-y-3 border-t border-surface-border-light pt-4">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-surface-border accent-[var(--color-brand-primary)]"
                {...register('isTaxable')}
              />
              <span>
                <span className="font-medium text-text-body">Taxable</span>
                <span className="block text-text-muted">
                  Counts toward the taxable pay a statutory report totals.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-surface-border accent-[var(--color-brand-primary)]"
                {...register('isGratuityBase')}
              />
              <span>
                <span className="font-medium text-text-body">Counts toward gratuity</span>
                <span className="block text-text-muted">
                  Part of the base an end-of-service accrual is calculated on.
                </span>
              </span>
            </label>
          </div>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {editing ? 'Save changes' : 'Create component'}
        </Button>
      </div>
    </form>
  );
}
