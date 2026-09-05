'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Building2, Clock, MapPin, Navigation, Phone, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranch, useCreateBranch, useUpdateBranch } from '@/hooks/useBranches';
import { useEmployees } from '@/hooks/useEmployees';
import { apiErrorMessage } from '@/utils/apiError';
import { fullName } from '@/utils/formatters';
import type { CreateBranchPayload } from '@/types/branch';

/**
 * ISO weekday numbers, 1 = Monday — the convention `Branch.weeklyOffDays`
 * stores, so nothing here has to translate between two numberings.
 */
const WEEKDAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 7, short: 'Sun', long: 'Sunday' },
];

/**
 * Every optional field is a STRING here, not a number or a null.
 *
 * A branch's calendar and geofence columns are nullable and mean "inherit the
 * company value" when unset, so the form has to be able to express "left
 * blank". Numbers are parsed on submit, where blank becomes `undefined` and the
 * field is simply not sent.
 */
const numericInRange = (min: number, max: number, message: string) =>
  z
    .string()
    .optional()
    .refine(
      (value) =>
        !value ||
        value.trim() === '' ||
        (!Number.isNaN(Number(value)) && Number(value) >= min && Number(value) <= max),
      { message },
    );

const branchSchema = z
  .object({
    code: z.string().trim().min(1, 'A code is required').max(32, 'At most 32 characters'),
    name: z.string().trim().min(1, 'A name is required').max(255, 'At most 255 characters'),
    description: z.string().optional(),
    isActive: z.boolean().optional(),

    addressLine: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z
      .string()
      .optional()
      .refine((value) => !value || value.trim() === '' || value.trim().length === 2, {
        message: 'Use the two-letter country code',
      }),
    postalCode: z.string().optional(),

    phone: z.string().optional(),
    email: z
      .string()
      .optional()
      .refine((value) => !value || value.trim() === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), {
        message: 'Enter a valid email address',
      }),
    crNumber: z.string().optional(),
    vatNumber: z.string().optional(),
    managerId: z.string().optional(),

    timezone: z.string().optional(),
    officeStartTime: z.string().optional(),
    officeEndTime: z.string().optional(),
    graceMinutes: numericInRange(0, 240, 'Between 0 and 240 minutes'),
    weeklyOffDays: z.array(z.number()),

    geofencingEnabled: z.boolean(),
    latitude: numericInRange(-90, 90, 'Between -90 and 90'),
    longitude: numericInRange(-180, 180, 'Between -180 and 180'),
    // The bounds are the server's: below ten metres GPS noise alone would push
    // somebody outside their own office.
    geofenceRadiusM: numericInRange(10, 50_000, 'Between 10 and 50,000 metres'),
  })
  /**
   * The server refuses an enabled fence with no centre, and so does this.
   *
   * Not to duplicate the rule for its own sake: a form that lets you press Save
   * spends a round trip to be told something it already knew, and the reader
   * loses the field they were on while the page re-renders the error.
   */
  .refine((values) => !values.geofencingEnabled || !!values.latitude?.trim(), {
    message: 'A geofence needs a latitude',
    path: ['latitude'],
  })
  .refine((values) => !values.geofencingEnabled || !!values.longitude?.trim(), {
    message: 'A geofence needs a longitude',
    path: ['longitude'],
  });

export type BranchFormValues = z.infer<typeof branchSchema>;

const EMPTY: BranchFormValues = {
  code: '',
  name: '',
  description: '',
  isActive: true,
  addressLine: '',
  city: '',
  state: '',
  country: '',
  postalCode: '',
  phone: '',
  email: '',
  crNumber: '',
  vatNumber: '',
  managerId: '',
  timezone: '',
  officeStartTime: '',
  officeEndTime: '',
  graceMinutes: '',
  weeklyOffDays: [],
  geofencingEnabled: false,
  latitude: '',
  longitude: '',
  geofenceRadiusM: '',
};

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3 border-b border-surface-border-light pb-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] bg-brand-primary/10 text-brand-primary">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-heading">{title}</h2>
          <p className="mt-0.5 text-sm text-text-muted">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function BranchForm({
  mode,
  branchId,
}: {
  mode: 'create' | 'edit';
  branchId?: string;
}) {
  const router = useRouter();

  // Both /new and /[id]/edit route through this component, so the heading is
  // mode-conditional. Topbar draws it; the form must not repeat it.
  usePageHeader(
    mode === 'create' ? 'New branch' : 'Edit branch',
    mode === 'create'
      ? 'A location, its working calendar and where it may be clocked into from.'
      : 'Changes apply to everyone posted to this location.',
  );

  const { data: branchResponse, isLoading: loadingBranch } = useBranch(
    mode === 'edit' ? branchId : undefined,
  );
  const employees = useEmployees({ limit: 200, status: 'ACTIVE' });
  const createBranch = useCreateBranch();
  const updateBranch = useUpdateBranch();
  const saving = createBranch.isPending || updateBranch.isPending;

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<BranchFormValues>({
    resolver: zodResolver(branchSchema),
    defaultValues: EMPTY,
  });

  // `useWatch` rather than `watch()`: the latter hands back a function the
  // React compiler refuses to memoise, so the whole form opts out of
  // compilation for the sake of two subscriptions.
  const geofencingEnabled = useWatch({ control, name: 'geofencingEnabled' });
  const weeklyOffDays = useWatch({ control, name: 'weeklyOffDays' });

  useEffect(() => {
    const branch = branchResponse?.data;
    if (mode !== 'edit' || !branch) return;

    reset({
      ...EMPTY,
      code: branch.code,
      name: branch.name,
      description: branch.description ?? '',
      isActive: branch.isActive,
      addressLine: branch.addressLine ?? '',
      city: branch.city ?? '',
      state: branch.state ?? '',
      country: branch.country ?? '',
      postalCode: branch.postalCode ?? '',
      phone: branch.phone ?? '',
      email: branch.email ?? '',
      crNumber: branch.crNumber ?? '',
      vatNumber: branch.vatNumber ?? '',
      managerId: branch.managerId ?? '',
      timezone: branch.timezone ?? '',
      officeStartTime: branch.officeStartTime ?? '',
      officeEndTime: branch.officeEndTime ?? '',
      graceMinutes: branch.graceMinutes != null ? String(branch.graceMinutes) : '',
      weeklyOffDays: branch.weeklyOffDays ?? [],
      geofencingEnabled: Boolean(branch.geofencingEnabled),
      latitude: branch.latitude != null ? String(branch.latitude) : '',
      longitude: branch.longitude != null ? String(branch.longitude) : '',
      geofenceRadiusM: branch.geofenceRadiusM != null ? String(branch.geofenceRadiusM) : '',
    });
  }, [mode, branchResponse, reset]);

  const toggleDay = (day: number) => {
    const next = weeklyOffDays.includes(day)
      ? weeklyOffDays.filter((value) => value !== day)
      : [...weeklyOffDays, day].sort((a, b) => a - b);
    setValue('weeklyOffDays', next, { shouldDirty: true });
  };

  const onSubmit = async (values: BranchFormValues) => {
    const text = (value?: string) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    };
    const num = (value?: string) => {
      const trimmed = value?.trim();
      return trimmed ? Number(trimmed) : undefined;
    };

    // A blank calendar field is OMITTED rather than sent as an empty string:
    // the column being null is what makes the branch inherit the company
    // setting, and sending '' would pin it to a value of its own.
    const payload: CreateBranchPayload = {
      code: values.code.trim(),
      name: values.name.trim(),
      description: text(values.description),
      addressLine: text(values.addressLine),
      city: text(values.city),
      state: text(values.state),
      country: text(values.country)?.toUpperCase(),
      postalCode: text(values.postalCode),
      phone: text(values.phone),
      email: text(values.email),
      crNumber: text(values.crNumber),
      vatNumber: text(values.vatNumber),
      managerId: text(values.managerId),
      timezone: text(values.timezone),
      officeStartTime: text(values.officeStartTime),
      officeEndTime: text(values.officeEndTime),
      graceMinutes: num(values.graceMinutes),
      weeklyOffDays: values.weeklyOffDays,
      geofencingEnabled: values.geofencingEnabled,
      latitude: num(values.latitude),
      longitude: num(values.longitude),
      geofenceRadiusM: num(values.geofenceRadiusM),
    };

    try {
      if (mode === 'create') {
        const created = await createBranch.mutateAsync(payload);
        toast.success(`${payload.name} created`);
        router.push(`/dashboard/branches/${created.data.id}`);
      } else if (branchId) {
        await updateBranch.mutateAsync({
          id: branchId,
          payload: { ...payload, isActive: values.isActive },
        });
        toast.success(`${payload.name} saved`);
        router.push(`/dashboard/branches/${branchId}`);
      }
    } catch (error) {
      // The axios interceptor rejects with a FLAT object, so the precise
      // backend message is on `message` and nowhere near `response.data`.
      toast.error(apiErrorMessage(error, 'The branch could not be saved'));
    }
  };

  if (mode === 'edit' && loadingBranch) {
    return <Card className="p-6 text-sm text-text-muted">Loading branch…</Card>;
  }

  const fenceHint = geofencingEnabled
    ? 'A clock-in outside this circle is refused.'
    : 'Turn the fence on to set its centre and radius.';

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card className="space-y-8 p-6">
        <Section
          icon={<Building2 className="h-5 w-5" aria-hidden />}
          title="Identity"
          description="How this location is named and referred to everywhere else."
        >
          <div className="grid gap-5 md:grid-cols-2">
            <Input
              label="Branch code"
              placeholder="HQ"
              error={errors.code?.message}
              {...register('code')}
            />
            <Input
              label="Branch name"
              placeholder="Head Office"
              error={errors.name?.message}
              {...register('name')}
            />
          </div>

          <div>
            <label
              htmlFor="branch-description"
              className="mb-1.5 block text-sm font-medium text-text-body"
            >
              Description
            </label>
            <textarea
              id="branch-description"
              rows={3}
              placeholder="What happens at this location."
              className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
              {...register('description')}
            />
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label
                htmlFor="branch-manager"
                className="mb-1.5 block text-sm font-medium text-text-body"
              >
                Branch manager
              </label>
              <select
                id="branch-manager"
                className="w-full rounded-[var(--radius-input)] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
                {...register('managerId')}
              >
                <option value="">Nobody yet</option>
                {(employees.data?.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {fullName(employee)} ({employee.employeeCode})
                  </option>
                ))}
              </select>
            </div>

            {mode === 'edit' && (
              <label className="flex items-start gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-4">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-brand-primary"
                  {...register('isActive')}
                />
                <span>
                  <span className="text-sm font-medium text-text-body">Open</span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    A retired branch keeps its history but takes no new postings.
                  </span>
                </span>
              </label>
            )}
          </div>
        </Section>

        <Section
          icon={<MapPin className="h-5 w-5" aria-hidden />}
          title="Address"
          description="Where the location physically is."
        >
          <Input
            label="Address line"
            placeholder="Building 12, Al Khuwair"
            {...register('addressLine')}
          />
          <div className="grid gap-5 md:grid-cols-2">
            <Input label="City" placeholder="Muscat" {...register('city')} />
            <Input label="State or region" {...register('state')} />
            <Input
              label="Country code"
              placeholder="OM"
              maxLength={2}
              error={errors.country?.message}
              {...register('country')}
            />
            <Input label="Postal code" {...register('postalCode')} />
          </div>
        </Section>

        <Section
          icon={<Phone className="h-5 w-5" aria-hidden />}
          title="Contact and registration"
          description="How the location is reached, and how it is registered."
        >
          <div className="grid gap-5 md:grid-cols-2">
            <Input label="Phone" placeholder="+968 2400 0000" {...register('phone')} />
            <Input
              label="Email"
              type="email"
              placeholder="hq@example.com"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input label="CR number" {...register('crNumber')} />
            <Input label="VAT number" {...register('vatNumber')} />
          </div>
        </Section>

        <Section
          icon={<Clock className="h-5 w-5" aria-hidden />}
          title="Working calendar"
          description="Leave a field blank to inherit the company setting."
        >
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            <Input label="Timezone" placeholder="Asia/Muscat" {...register('timezone')} />
            {/* Wall clock, not an instant: the office opens at eight where the
                branch is, whatever zone the reader is sitting in. */}
            <Input label="Office start" type="time" {...register('officeStartTime')} />
            <Input label="Office end" type="time" {...register('officeEndTime')} />
            <Input
              label="Grace minutes"
              type="number"
              min={0}
              max={240}
              error={errors.graceMinutes?.message}
              {...register('graceMinutes')}
            />
          </div>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-text-body">Weekly off days</legend>
            <p className="mb-2 text-xs text-text-muted">
              Select none to inherit the company week. Every day selected here is a rest day, and
              overtime worked on one is paid at the rest-day rate.
            </p>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const selected = weeklyOffDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={selected}
                    aria-label={day.long}
                    onClick={() => toggleDay(day.value)}
                    className={`rounded-[var(--radius-button)] border px-3.5 py-2 text-xs font-semibold transition-colors ${
                      selected
                        ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                        : 'border-surface-border bg-surface-card text-text-muted hover:text-text-body'
                    }`}
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </Section>

        <Section
          icon={<Navigation className="h-5 w-5" aria-hidden />}
          title="Geofence"
          description={fenceHint}
        >
          <label className="flex items-start gap-3 rounded-[var(--radius-card)] border border-surface-border bg-surface-page p-4">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-brand-primary"
              {...register('geofencingEnabled')}
            />
            <span>
              <span className="text-sm font-medium text-text-body">
                Restrict clock-in to this location
              </span>
              <span className="mt-0.5 block text-xs text-text-muted">
                Attendance recorded outside the circle below is refused.
              </span>
            </span>
          </label>

          {/* Disabled rather than hidden. A coordinate typed into a fence that
              is switched off is silently ignored on save, and the reader has no
              way to tell that from a value that stuck. */}
          <div className="grid gap-5 md:grid-cols-3">
            <Input
              label="Latitude"
              inputMode="decimal"
              placeholder="23.5880"
              disabled={!geofencingEnabled}
              error={errors.latitude?.message}
              {...register('latitude')}
            />
            <Input
              label="Longitude"
              inputMode="decimal"
              placeholder="58.3829"
              disabled={!geofencingEnabled}
              error={errors.longitude?.message}
              {...register('longitude')}
            />
            <Input
              label="Radius in metres"
              inputMode="numeric"
              placeholder="150"
              disabled={!geofencingEnabled}
              error={errors.geofenceRadiusM?.message}
              {...register('geofenceRadiusM')}
            />
          </div>
        </Section>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button type="submit" isLoading={saving}>
          {mode === 'create' ? 'Create branch' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
