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
import { useBranches } from '@/hooks/useBranches';
import { useDepartments } from '@/hooks/useDepartments';
import { useCreateEmployee, useEmployees, useUpdateEmployee } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { CreateEmployeePayload, Employee, EmployeeStatus } from '@/types/employee';

/**
 * The shape of the record as the form holds it: strings throughout, including
 * the selects.
 *
 * Nothing is coerced while the user is typing. A half-entered date or a cleared
 * select is a legitimate intermediate state, and turning it into `undefined` on
 * every keystroke is what makes a field forget what was in it.
 */
const employeeSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .min(1, 'Employee code is required')
    .max(32, 'Employee code cannot be longer than 32 characters'),
  firstName: z.string().trim().min(1, 'First name is required').max(120),
  lastName: z.string().trim().min(1, 'Last name is required').max(120),
  workEmail: z.union([z.literal(''), z.email('Enter a valid work email')]),
  personalEmail: z.union([z.literal(''), z.email('Enter a valid personal email')]),
  phone: z.string().trim().max(32),
  position: z.string().trim().max(160),
  status: z.string(),
  hireDate: z.string(),
  dateOfBirth: z.string(),
  gender: z.string(),
  // Two letters, because that is what the API stores and a full country name
  // would be silently rejected at the far end of the request.
  nationality: z.union([
    z.literal(''),
    z.string().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, such as OM'),
  ]),
  nationalId: z.string().trim().max(64),
  address: z.string().trim(),
  branchId: z.string(),
  departmentId: z.string(),
  managerId: z.string(),
  supervisorId: z.string(),
  timezone: z.string().trim().max(64),
});

type EmployeeFormValues = z.infer<typeof employeeSchema>;

/**
 * Fields the API will accept as an empty string, which is the only way this form
 * can clear one.
 *
 * The rest — the emails, the nationality code, every relation — are validated
 * server-side in a way an empty string fails, so a cleared value is omitted from
 * the PATCH and the stored value survives. Sending the field anyway would turn a
 * tidy-up into a 400 the user cannot read.
 */
const CLEARABLE: ReadonlyArray<keyof CreateEmployeePayload> = [
  'phone',
  'position',
  'nationalId',
  'address',
  'timezone',
];

const STATUS_OPTIONS: Array<{ value: EmployeeStatus; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_LEAVE', label: 'On leave' },
  { value: 'SUSPENDED', label: 'Suspended' },
];

const GENDER_OPTIONS = ['Female', 'Male', 'Other'];

function defaults(employee?: Employee): EmployeeFormValues {
  return {
    employeeCode: employee?.employeeCode ?? '',
    firstName: employee?.firstName ?? '',
    lastName: employee?.lastName ?? '',
    workEmail: employee?.workEmail ?? '',
    personalEmail: employee?.personalEmail ?? '',
    phone: employee?.phone ?? '',
    position: employee?.position ?? '',
    status: employee?.status ?? 'ACTIVE',
    // Sliced rather than parsed: a date input wants `YYYY-MM-DD`, and putting a
    // date-only value through an instant parse moves it a day west of Greenwich.
    hireDate: employee?.hireDate?.slice(0, 10) ?? '',
    dateOfBirth: employee?.dateOfBirth?.slice(0, 10) ?? '',
    gender: employee?.gender ?? '',
    nationality: employee?.nationality ?? '',
    nationalId: employee?.nationalId ?? '',
    address: employee?.address ?? '',
    branchId: employee?.branch?.id ?? '',
    departmentId: employee?.department?.id ?? '',
    managerId: employee?.manager?.id ?? '',
    supervisorId: employee?.supervisor?.id ?? '',
    timezone: employee?.timezone ?? '',
  };
}

export interface EmployeeFormProps {
  /** Present for an edit; the submit label and the request both read it. */
  employee?: Employee;
}

export default function EmployeeForm({ employee }: EmployeeFormProps) {
  const router = useRouter();
  const isEdit = Boolean(employee);

  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();

  const departments = useDepartments();
  const branches = useBranches();
  // The reporting selects want people, not a page of them. 200 is the API's
  // ceiling, and a company past it needs a picker rather than a longer list.
  const people = useEmployees({ limit: 200, sortBy: 'firstName', sortOrder: 'asc' });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeFormValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: defaults(employee),
  });

  const colleagues = (people.data?.data ?? []).filter((p) => p.id !== employee?.id);

  const buildPayload = (values: EmployeeFormValues): CreateEmployeePayload => {
    const raw: Record<string, string> = { ...values };
    const payload: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(raw)) {
      const trimmed = value.trim();
      if (trimmed) {
        payload[key] = trimmed;
      } else if (isEdit && CLEARABLE.includes(key as keyof CreateEmployeePayload)) {
        payload[key] = '';
      }
    }

    return payload as unknown as CreateEmployeePayload;
  };

  const onSubmit = handleSubmit(async (values) => {
    const payload = buildPayload(values);

    try {
      if (employee) {
        await updateEmployee.mutateAsync({ id: employee.id, payload });
        toast.success('Employee updated');
        router.push(`/dashboard/employees/${employee.id}`);
      } else {
        const created = await createEmployee.mutateAsync(payload);
        toast.success('Employee created');
        router.push(`/dashboard/employees/${created.data.id}`);
      }
    } catch (err) {
      // The interceptor rejects with a FLAT object — there is no `.response` to
      // reach into, and doing so lands on the generic fallback instead of the
      // message the API actually sent.
      toast.error(apiErrorMessage(err, 'Could not save this employee'));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Card>
        <CardHeader title="Identity" subtitle="Who this person is on paper." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            label="Employee code"
            placeholder="EMP-0021"
            error={errors.employeeCode?.message}
            {...register('employeeCode')}
          />
          <Input label="First name" error={errors.firstName?.message} {...register('firstName')} />
          <Input label="Last name" error={errors.lastName?.message} {...register('lastName')} />
          <Input
            type="date"
            label="Date of birth"
            error={errors.dateOfBirth?.message}
            {...register('dateOfBirth')}
          />
          <Select label="Gender" placeholder="Not stated" {...register('gender')}>
            {GENDER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Input
            label="Nationality"
            placeholder="OM"
            maxLength={2}
            error={errors.nationality?.message}
            {...register('nationality')}
          />
          <Input
            label="National ID"
            placeholder="Civil or national id"
            error={errors.nationalId?.message}
            {...register('nationalId')}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Contact" subtitle="How to reach them, during and after employment." />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            type="email"
            label="Work email"
            error={errors.workEmail?.message}
            {...register('workEmail')}
          />
          <Input
            type="email"
            label="Personal email"
            error={errors.personalEmail?.message}
            {...register('personalEmail')}
          />
          <Input label="Phone" placeholder="+96890000000" error={errors.phone?.message} {...register('phone')} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Textarea label="Address" error={errors.address?.message} {...register('address')} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Employment"
          subtitle="Where they sit, and who signs their work off."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Input label="Position" error={errors.position?.message} {...register('position')} />
          <Select label="Status" {...register('status')}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {/* A record that is already terminated keeps the option, so opening
                it and saving cannot quietly bring somebody back onto the books. */}
            {employee?.status === 'TERMINATED' && <option value="TERMINATED">Terminated</option>}
          </Select>
          <Input
            type="date"
            label="Hire date"
            error={errors.hireDate?.message}
            {...register('hireDate')}
          />
          <Select label="Branch" placeholder="Unassigned" {...register('branchId')}>
            {(branches.data?.data ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
          <Select label="Department" placeholder="Unassigned" {...register('departmentId')}>
            {(departments.data?.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Select label="Line manager" placeholder="None" {...register('managerId')}>
            {colleagues.map((person) => (
              <option key={person.id} value={person.id}>
                {fullName(person)}
              </option>
            ))}
          </Select>
          {/* Deliberately separate from the line manager: a matrixed engineer
              reports to a functional head and is signed off by a project lead,
              and payroll reads the second of those. */}
          <Select label="Supervisor" placeholder="None" {...register('supervisorId')}>
            {colleagues.map((person) => (
              <option key={person.id} value={person.id}>
                {fullName(person)}
              </option>
            ))}
          </Select>
          <Input
            label="Timezone"
            placeholder="Asia/Muscat"
            error={errors.timezone?.message}
            {...register('timezone')}
          />
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {isEdit ? 'Save changes' : 'Create employee'}
        </Button>
      </div>
    </form>
  );
}
