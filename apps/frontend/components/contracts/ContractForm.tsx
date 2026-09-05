'use client';

import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateContract } from '@/hooks/useContracts';
import { useEmployees } from '@/hooks/useEmployees';
import { useBrandingStore } from '@/store/brandingStore';
import { apiErrorMessage } from '@/utils/apiError';
import { CURRENCY_DECIMALS } from '@/utils/constants';
import { fullName } from '@/utils/formatters';
import type { ContractType, CreateContractPayload, WorkType } from '@/types/contract';

const CONTRACT_TYPES: Array<{ value: ContractType; label: string }> = [
  { value: 'PERMANENT', label: 'Permanent' },
  { value: 'FIXED_TERM', label: 'Fixed term' },
  { value: 'PROBATION', label: 'Probation' },
  { value: 'PART_TIME', label: 'Part time' },
  { value: 'INTERNSHIP', label: 'Internship' },
  { value: 'CONSULTANT', label: 'Consultant' },
];

const WORK_TYPES: Array<{ value: WorkType; label: string }> = [
  { value: 'FULL_TIME', label: 'Full time' },
  { value: 'PART_TIME', label: 'Part time' },
  { value: 'REMOTE', label: 'Remote' },
  { value: 'HYBRID', label: 'Hybrid' },
];

const CURRENCIES = Object.keys(CURRENCY_DECIMALS);

/**
 * The contract as the form holds it, and the two rules a term has to satisfy
 * before it is worth sending.
 *
 * Both are checked HERE rather than only server-side. A contract that ends
 * before it starts, or a probation that finishes outside the term, is a typo
 * with a settlement attached — the notice period and the final payslip are both
 * calculated from these dates — and the person filling the form is the only one
 * who can still see which field they meant.
 */
const contractSchema = z
  .object({
    employeeId: z.string().min(1, 'Employee is required'),
    contractType: z.string().min(1, 'Contract type is required'),
    workType: z.string(),
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string(),
    probationEndDate: z.string(),
    workHoursPerWeek: z.string(),
    salary: z.string().min(1, 'Salary is required'),
    currency: z.string().min(1),
    noticePeriodDays: z.string(),
    annualLeaveDays: z.string(),
    terms: z.string(),
  })
  .superRefine((values, ctx) => {
    if (Number.isNaN(Number(values.salary)) || Number(values.salary) < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['salary'],
        message: 'Salary must be a number of zero or more',
      });
    }

    if (values.endDate && values.startDate && values.endDate <= values.startDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'The end date has to fall after the start date',
      });
    }

    if (values.probationEndDate && values.startDate) {
      if (values.probationEndDate <= values.startDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['probationEndDate'],
          message: 'Probation has to end after the contract starts',
        });
      } else if (values.endDate && values.probationEndDate > values.endDate) {
        ctx.addIssue({
          code: 'custom',
          path: ['probationEndDate'],
          message: 'Probation cannot end after the contract does',
        });
      }
    }
  });

type ContractFormValues = z.infer<typeof contractSchema>;

export interface ContractFormProps {
  /** Preselects the employee when the form is opened from their record. */
  employeeId?: string;
  /** Where to go once the contract exists. Defaults to its own detail page. */
  onCreated?: (contractId: string) => void;
}

export default function ContractForm({ employeeId, onCreated }: ContractFormProps) {
  const router = useRouter();
  const createContract = useCreateContract();
  const defaultCurrency = useBrandingStore((s) => s.branding.default_currency);

  const people = useEmployees({ limit: 200, sortBy: 'firstName', sortOrder: 'asc' });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ContractFormValues>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      employeeId: employeeId ?? '',
      contractType: 'PERMANENT',
      workType: 'FULL_TIME',
      startDate: '',
      endDate: '',
      probationEndDate: '',
      workHoursPerWeek: '40',
      salary: '',
      currency: defaultCurrency || 'OMR',
      noticePeriodDays: '30',
      annualLeaveDays: '30',
      terms: '',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    const payload: CreateContractPayload = {
      employeeId: values.employeeId,
      contractType: values.contractType as ContractType,
      workType: values.workType as WorkType,
      startDate: values.startDate,
      salary: Number(values.salary),
      currency: values.currency,
      ...(values.endDate ? { endDate: values.endDate } : {}),
      ...(values.probationEndDate ? { probationEndDate: values.probationEndDate } : {}),
      ...(values.workHoursPerWeek ? { workHoursPerWeek: Number(values.workHoursPerWeek) } : {}),
      ...(values.noticePeriodDays ? { noticePeriodDays: Number(values.noticePeriodDays) } : {}),
      ...(values.annualLeaveDays ? { annualLeaveDays: Number(values.annualLeaveDays) } : {}),
      ...(values.terms.trim() ? { terms: values.terms.trim() } : {}),
    };

    try {
      const created = await createContract.mutateAsync(payload);
      toast.success('Contract created');
      if (onCreated) {
        onCreated(created.data.id);
      } else {
        router.push(`/dashboard/contracts/${created.data.id}`);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not create this contract'));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Card>
        <CardHeader title="Parties" subtitle="Who the contract is with, and on what basis." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          <Select
            label="Contract type"
            error={errors.contractType?.message}
            {...register('contractType')}
          >
            {CONTRACT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select label="Work type" {...register('workType')}>
            {WORK_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Term"
          subtitle="Leave the end date empty for a contract that does not expire."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            type="date"
            label="Start date"
            error={errors.startDate?.message}
            {...register('startDate')}
          />
          <Input
            type="date"
            label="End date"
            error={errors.endDate?.message}
            {...register('endDate')}
          />
          <Input
            type="date"
            label="Probation end date"
            error={errors.probationEndDate?.message}
            {...register('probationEndDate')}
          />
          <Input
            type="number"
            min={1}
            max={168}
            label="Hours per week"
            error={errors.workHoursPerWeek?.message}
            {...register('workHoursPerWeek')}
          />
          <Input
            type="number"
            min={0}
            label="Notice period (days)"
            error={errors.noticePeriodDays?.message}
            {...register('noticePeriodDays')}
          />
          <Input
            type="number"
            min={0}
            label="Annual leave (days)"
            error={errors.annualLeaveDays?.message}
            {...register('annualLeaveDays')}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Pay" subtitle="Gross monthly salary, in the contract's own currency." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Three decimals because the Gulf currencies are thousandths; a step
              of 0.01 would round every OMR amount to the nearest 10 baisa. */}
          <Input
            type="number"
            step="0.001"
            min={0}
            label="Salary"
            error={errors.salary?.message}
            {...register('salary')}
          />
          <Select label="Currency" error={errors.currency?.message} {...register('currency')}>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-2 lg:col-span-3">
            <Textarea
              label="Terms"
              rows={4}
              placeholder="Anything the standard template does not cover."
              {...register('terms')}
            />
          </div>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          Create contract
        </Button>
      </div>
    </form>
  );
}
