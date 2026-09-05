'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { COMPONENT_TYPES, COMPONENT_TYPE_LABEL } from '@/components/payroll/ComponentTypeBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useEmployees } from '@/hooks/useEmployees';
import { useSalaryComponents } from '@/hooks/useSalaryComponents';
import {
  useCreateSalaryStructure,
  useUpdateSalaryStructure,
} from '@/hooks/useSalaryStructures';
import { useBrandingStore } from '@/store/brandingStore';
import { apiErrorMessage } from '@/utils/apiError';
import { CURRENCY_DECIMALS } from '@/utils/constants';
import { formatCurrency, fullName } from '@/utils/formatters';
import { toAmount } from '@/utils/payrollTotals';
import type { ApiResponse } from '@/types/api';
import type {
  CreateSalaryStructurePayload,
  SalaryComponent,
  SalaryStructure,
  UpdateSalaryStructurePayload,
} from '@/types/salaryStructure';

const CURRENCIES = Object.keys(CURRENCY_DECIMALS);

/** The catalogue is bounded; 200 is the API's ceiling and covers all of it. */
const CATALOGUE_LIMIT = 200;

/**
 * The two sentences the SERVER answers with, repeated verbatim.
 *
 * Not paraphrased. A clerk who hits the rule client-side and then hits it again
 * from the API on a different route has to recognise it as the same rule; two
 * wordings for one refusal reads as two different problems.
 */
const NO_EARNING = 'A salary structure must have at least one earning line.';
const DUPLICATE_COMPONENT =
  'The same salary component appears twice in this structure. Each component may only be listed once — combine the two amounts into a single line.';

/**
 * The structure as the form holds it.
 *
 * Every field is a STRING, including the amounts, and each is converted only
 * when the payload is built. Bound to a number, a cleared amount field becomes
 * `NaN` — which serialises to `null` and reaches the API as "no answer" rather
 * than as the blank the user is looking at.
 *
 * The earning rule needs the CATALOGUE to answer — only the component knows
 * whether an amount is pay — so the schema is rebuilt whenever the catalogue
 * changes, and the resolver with it. `useForm` re-reads its options on every
 * render, so the next validation uses the newest schema without the form being
 * remounted and its values thrown away.
 */
function buildSchema(catalogue: Map<string, SalaryComponent>) {
  return z
    .object({
      employeeId: z.string().min(1, 'Choose the employee this structure is for'),
      currency: z.string().min(1, 'A currency is required'),
      effectiveFrom: z.string().min(1, 'An effective-from date is required'),
      lines: z
        .array(
          z.object({
            componentId: z.string().min(1, 'Choose a salary component'),
            amount: z.string().min(1, 'An amount is required'),
          }),
        )
        .min(1, NO_EARNING),
    })
    .superRefine((values, ctx) => {
      const seen = new Set<string>();
      let paysSomething = false;

      values.lines.forEach((line, index) => {
        const amount = Number(line.amount);
        if (line.amount.trim() === '' || !Number.isFinite(amount) || amount < 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['lines', index, 'amount'],
            message: 'An amount has to be a number of zero or more',
          });
        }

        if (line.componentId) {
          // Caught here rather than at the server's unique index, so the second
          // occurrence is the one flagged and the reader can see which row to
          // merge.
          if (seen.has(line.componentId)) {
            ctx.addIssue({
              code: 'custom',
              path: ['lines', index, 'componentId'],
              message: DUPLICATE_COMPONENT,
            });
          }
          seen.add(line.componentId);

          // An earning of zero is not an earning: the structure would compute a
          // gross of nothing and produce a payslip paying the employee nothing.
          const component = catalogue.get(line.componentId);
          if (component?.type === 'EARNING' && Number.isFinite(amount) && amount > 0) {
            paysSomething = true;
          }
        }
      });

      if (values.lines.length > 0 && !paysSomething) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: NO_EARNING });
      }
    });
}

type StructureFormValues = z.infer<ReturnType<typeof buildSchema>>;

export interface SalaryStructureFormProps {
  /** Present for an edit. Absent assigns a new structure. */
  structure?: SalaryStructure;
  /** Preselects the person when the form is opened from their record. */
  employeeId?: string;
  onSaved?: (structure: SalaryStructure) => void;
  onCancel?: () => void;
}

export default function SalaryStructureForm({
  structure,
  employeeId,
  onSaved,
  onCancel,
}: SalaryStructureFormProps) {
  const router = useRouter();
  const createStructure = useCreateSalaryStructure();
  const updateStructure = useUpdateSalaryStructure();
  const defaultCurrency = useBrandingStore((s) => s.branding.default_currency);
  const editing = Boolean(structure);

  const people = useEmployees({
    limit: CATALOGUE_LIMIT,
    status: 'ACTIVE',
    sortBy: 'firstName',
    sortOrder: 'asc',
  });
  const catalogue = useSalaryComponents({ isActive: true, limit: CATALOGUE_LIMIT });

  /**
   * What the line picker offers.
   *
   * The active catalogue, plus any component this structure already holds. A
   * component retired since the structure was written would otherwise leave its
   * row showing an empty select — the amount visible, the thing it pays for
   * gone — and there would be nothing on screen saying what had to be removed
   * before the structure could be saved again.
   */
  const options = useMemo(() => {
    const byId = new Map<string, SalaryComponent>();
    for (const component of catalogue.data?.data ?? []) byId.set(component.id, component);
    for (const line of structure?.lines ?? []) {
      if (line.component && !byId.has(line.component.id)) {
        byId.set(line.component.id, line.component);
      }
    }
    return [...byId.values()].sort(
      (a, b) =>
        COMPONENT_TYPES.indexOf(a.type) - COMPONENT_TYPES.indexOf(b.type) ||
        a.sequence - b.sequence ||
        a.code.localeCompare(b.code),
    );
  }, [catalogue.data, structure]);

  const byId = useMemo(
    () => new Map(options.map((component) => [component.id, component])),
    [options],
  );

  const resolver = useMemo(() => zodResolver(buildSchema(byId)), [byId]);

  const {
    control,
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<StructureFormValues>({
    resolver,
    defaultValues: {
      employeeId: structure?.employeeId ?? employeeId ?? '',
      currency: structure?.currency ?? defaultCurrency ?? 'OMR',
      effectiveFrom: structure?.effectiveFrom?.slice(0, 10) ?? '',
      lines:
        structure?.lines?.map((line) => ({
          componentId: line.componentId,
          amount: String(line.amount ?? ''),
        })) ?? [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  // `useWatch` rather than `watch()`: the latter hands back a function the React
  // Compiler cannot memoize, which opts this whole form out of compilation.
  const watchedLines = useWatch({ control, name: 'lines' });
  const currency = useWatch({ control, name: 'currency' });

  /**
   * What this structure comes to, as it is being written.
   *
   * The same three rules the calculator uses: employer contributions sit
   * outside gross, outside deductions and outside net, and net floors at zero.
   * A total on the form that disagreed with the run would be worse than no
   * total at all.
   */
  const totals = useMemo(() => {
    let gross = 0;
    let deductions = 0;
    let employerCost = 0;

    for (const line of watchedLines ?? []) {
      const amount = toAmount(line?.amount);
      const type = byId.get(line?.componentId)?.type;
      if (type === 'EARNING') gross += amount;
      else if (type === 'DEDUCTION') deductions += amount;
      else if (type === 'EMPLOYER_CONTRIBUTION') employerCost += amount;
    }

    return { gross, deductions, net: Math.max(0, gross - deductions), employerCost };
  }, [watchedLines, byId]);

  const onSubmit = handleSubmit(async (values) => {
    const lines = values.lines.map((line) => ({
      componentId: line.componentId,
      amount: Number(line.amount),
    }));

    try {
      if (structure) {
        // Sending `lines` REPLACES the whole set. That is the point: a revision
        // that drops an allowance cannot be expressed by a merge.
        const payload: UpdateSalaryStructurePayload = {
          currency: values.currency,
          effectiveFrom: values.effectiveFrom,
          lines,
        };
        // The shared mutation helper in `useSalaryStructures` is generic over
        // its VARIABLES only, so its result is typed `unknown`. The service it
        // wraps resolves the envelope, and the cast says which one.
        const saved = (await updateStructure.mutateAsync({
          id: structure.id,
          payload,
        })) as ApiResponse<SalaryStructure>;
        toast.success('Salary structure updated');
        if (onSaved) onSaved(saved.data);
        else router.push(`/dashboard/payroll/structures/${structure.id}`);
        return;
      }

      const payload: CreateSalaryStructurePayload = {
        employeeId: values.employeeId,
        currency: values.currency,
        effectiveFrom: values.effectiveFrom,
        lines,
      };
      const saved = (await createStructure.mutateAsync(
        payload,
      )) as ApiResponse<SalaryStructure>;
      toast.success('Salary structure assigned');
      if (onSaved) onSaved(saved.data);
      else router.push(`/dashboard/payroll/structures/${saved.data.id}`);
    } catch (err) {
      // Flat rejection: the currency-mismatch and already-assigned sentences
      // are on `err.message`, and `err.response` does not exist at all.
      toast.error(
        apiErrorMessage(
          err,
          editing
            ? 'Could not update this salary structure'
            : 'Could not assign this salary structure',
        ),
      );
    }
  });

  const linesError = errors.lines?.message ?? errors.lines?.root?.message;

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Card>
        <CardHeader
          title="Assignment"
          subtitle="One structure per employee, priced in the currency their contract uses."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {editing ? (
            // A structure is keyed to one person, so moving it would give one
            // employee two definitions of their pay and leave the other with
            // none. The API omits `employeeId` from its PATCH for that reason.
            <div className="min-w-0">
              <p className="mb-1.5 text-sm font-medium text-text-body">Employee</p>
              <p className="rounded-[var(--radius-input)] border border-surface-border bg-surface-border-light/60 px-3 py-2 text-sm text-text-body">
                {fullName(structure?.employee)}
                {structure?.employee?.employeeCode
                  ? ` — ${structure.employee.employeeCode}`
                  : ''}
              </p>
            </div>
          ) : (
            <Select
              label="Employee"
              placeholder="Choose an employee"
              error={errors.employeeId?.message}
              {...register('employeeId')}
            >
              {(people.data?.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {fullName(person)} — {person.employeeCode}
                </option>
              ))}
            </Select>
          )}

          <Select label="Currency" error={errors.currency?.message} {...register('currency')}>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>

          {/* Date only — it is stored and read without a zone, so the field
              hands over exactly the YYYY-MM-DD the user picked. */}
          <Input
            type="date"
            label="Effective from"
            error={errors.effectiveFrom?.message}
            {...register('effectiveFrom')}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Lines"
          subtitle="Fixed amounts from the salary component catalogue. Each component may appear once."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ componentId: '', amount: '' })}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add line
            </Button>
          }
        />
        <CardBody className="space-y-4">
          {fields.length === 0 && (
            <p className="rounded-[var(--radius-input)] border border-dashed border-surface-border px-4 py-6 text-center text-sm text-text-muted">
              No lines yet. A structure needs at least one earning before anybody
              can be paid from it.
            </p>
          )}

          {fields.map((field, index) => {
            const component = byId.get(watchedLines?.[index]?.componentId ?? '');
            const rowErrors = errors.lines?.[index];

            return (
              <div
                key={field.id}
                className="grid gap-3 border-b border-surface-border-light pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-start"
              >
                <Select
                  label={index === 0 ? 'Component' : undefined}
                  aria-label="Salary component"
                  placeholder="Choose a component"
                  error={rowErrors?.componentId?.message}
                  {...register(`lines.${index}.componentId` as const)}
                >
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.code} — {option.name} ({COMPONENT_TYPE_LABEL[option.type]})
                      {option.isActive ? '' : ' · retired'}
                    </option>
                  ))}
                </Select>

                {/* Three decimals: the Gulf currencies are thousandths, and a
                    step of 0.01 makes the browser refuse 12.750 outright. */}
                <Input
                  type="number"
                  step="0.001"
                  min={0}
                  label={index === 0 ? 'Amount' : undefined}
                  aria-label="Amount"
                  error={rowErrors?.amount?.message}
                  {...register(`lines.${index}.amount` as const)}
                />

                <div className={index === 0 ? 'sm:pt-7' : undefined}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(index)}
                    aria-label={`Remove ${component?.code ?? 'this'} line`}
                  >
                    <Trash2 className="h-4 w-4 text-status-error" aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}

          {linesError && <p className="text-sm text-status-error">{linesError}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What this comes to"
          subtitle="Employer contributions are recorded and never paid, so they sit outside all three."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Total label="Gross" value={totals.gross} currency={currency} />
          <Total label="Deductions" value={totals.deductions} currency={currency} />
          <Total label="Net" value={totals.net} currency={currency} emphasis />
          <Total label="Employer cost" value={totals.employerCost} currency={currency} />
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => (onCancel ? onCancel() : router.back())}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {editing ? 'Save changes' : 'Assign structure'}
        </Button>
      </div>
    </form>
  );
}

function Total({
  label,
  value,
  currency,
  emphasis,
}: {
  label: string;
  value: number;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-input)] bg-surface-border-light/60 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p
        className={
          emphasis
            ? 'mt-1 text-xl font-semibold tabular-nums text-text-heading'
            : 'mt-1 text-lg font-medium tabular-nums text-text-body'
        }
      >
        {formatCurrency(value, currency)}
      </p>
    </div>
  );
}
