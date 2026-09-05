'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Briefcase,
  Building2,
  FileSignature,
  Pencil,
  UserRound,
  Wallet,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useAuthStore } from '@/store/authStore';
import {
  useEmployeeProfile,
  useUpdateEmployeeProfile,
} from '@/hooks/useEmployeeProfile';
import { useSalaryStructure } from '@/hooks/usePayslips';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { EmptyState } from '@/components/common/EmptyState';
import {
  changedFields,
  describeMissing,
  toForm,
  validate,
  type ProfileForm,
} from '@/components/profile/profileFields';
import { amountOf, groupLines } from '@/components/payroll/payslipFormat';
import { formatDateOnly } from '@/utils/formatDate';
import { apiErrorMessage } from '@/utils/apiError';
import { formatCurrency, initials } from '@/utils/formatters';
import type { EmployeeStatus } from '@/types/employee';
import type { EmployeeProfile } from '@/types/employeeProfile';

const STATUS_TONE: Record<EmployeeStatus, 'success' | 'info' | 'warning' | 'error'> = {
  ACTIVE: 'success',
  ON_LEAVE: 'info',
  SUSPENDED: 'warning',
  TERMINATED: 'error',
};

const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];

/** One label-and-value row. Blank reads as "not filled in", never as an em dash. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-surface-border-light py-2.5 last:border-0">
      <dt className="shrink-0 text-sm text-text-muted">{label}</dt>
      <dd className="text-end text-sm font-medium text-text-heading">{children}</dd>
    </div>
  );
}

function Blank() {
  return <span className="italic text-text-muted">Not filled in</span>;
}

/** How much of the self-maintained half has been filled in. */
function CompletionBar({ profile }: { profile: EmployeeProfile }) {
  const percent = profile.profileCompletionPercentage;
  const missing = describeMissing(profile.missingFields);
  const tone =
    percent >= 80 ? 'bg-status-success' : percent >= 50 ? 'bg-status-warning' : 'bg-status-error';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-text-body">Profile completeness</p>
        <p className="text-sm font-semibold tabular-nums text-text-heading">{percent}%</p>
      </div>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-[var(--radius-badge)] bg-surface-border-light"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Profile completeness"
      >
        <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        {/* Naming what is missing, because a bar at 66% tells nobody which
            third to go and fill in. */}
        {missing ? `Still to add: ${missing}.` : 'Everything you maintain is filled in.'}
      </p>
    </div>
  );
}

/** The editable half: contact and personal details. */
function DetailsSection({
  profile,
  employeeId,
}: {
  profile: EmployeeProfile;
  employeeId: string;
}) {
  // Seeded once per mount. The caller keys this component on the record's
  // `updatedAt`, so a row that changes underneath — a save here, or an edit HR
  // made to the same person — remounts with fresh values, while a background
  // refetch that changed nothing leaves what is being typed alone.
  const original = useMemo(() => toForm(profile), [profile]);
  const [form, setForm] = useState<ProfileForm>(original);
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileForm, string>>>({});

  const update = useUpdateEmployeeProfile(employeeId);

  const set = (key: keyof ProfileForm) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const cancel = () => {
    setForm(original);
    setErrors({});
    setEditing(false);
  };

  const save = async () => {
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const payload = changedFields(form, original);
    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }

    try {
      await update.mutateAsync({
        ...payload,
        // The API keys country-scoped lookups on the uppercase alpha-2 form, so
        // a lowercase code would match no rule at all.
        ...(payload.nationality
          ? { nationality: payload.nationality.toUpperCase() }
          : {}),
      });
      toast.success('Profile updated');
      setEditing(false);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not save your profile'));
    }
  };

  return (
    <Card>
      <CardHeader
        title="Contact and personal details"
        subtitle="The part of your record you maintain. Everything else is set by HR."
        action={
          editing ? undefined : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Button>
          )
        }
      />
      <CardBody>
        {!editing ? (
          <dl>
            <Fact label="Phone">{profile.phone || <Blank />}</Fact>
            <Fact label="Personal email">{profile.personalEmail || <Blank />}</Fact>
            <Fact label="Work email">{profile.workEmail || <Blank />}</Fact>
            <Fact label="Address">{profile.address || <Blank />}</Fact>
            <Fact label="Date of birth">
              {profile.dateOfBirth ? formatDateOnly(profile.dateOfBirth) : <Blank />}
            </Fact>
            <Fact label="Gender">{profile.gender || <Blank />}</Fact>
            <Fact label="Nationality">{profile.nationality || <Blank />}</Fact>
          </dl>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Phone"
                value={form.phone}
                onChange={(e) => set('phone')(e.target.value)}
                placeholder="+968 9123 4567"
              />
              <Input
                label="Personal email"
                type="email"
                value={form.personalEmail}
                error={errors.personalEmail}
                onChange={(e) => set('personalEmail')(e.target.value)}
                placeholder="you@example.com"
              />
              <Input
                label="Date of birth"
                type="date"
                value={form.dateOfBirth}
                error={errors.dateOfBirth}
                onChange={(e) => set('dateOfBirth')(e.target.value)}
              />
              <Select
                label="Gender"
                placeholder="Not stated"
                value={form.gender}
                onChange={(e) => set('gender')(e.target.value)}
              >
                {GENDERS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
              <Input
                label="Nationality"
                value={form.nationality}
                error={errors.nationality}
                onChange={(e) => set('nationality')(e.target.value)}
                placeholder="OM"
                maxLength={2}
              />
            </div>

            <Textarea
              label="Address"
              value={form.address}
              onChange={(e) => set('address')(e.target.value)}
              placeholder="Building, street, area, city"
            />

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button onClick={() => void save()} isLoading={update.isPending}>
                Save changes
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** The standing salary structure, when the caller is allowed one. */
function PaySection({ employeeId }: { employeeId: string }) {
  const { data, isLoading, isError } = useSalaryStructure(employeeId);
  const structure = data?.data;

  if (isLoading) {
    return (
      <Card>
        <CardHeader title="Salary structure" />
        <CardBody>
          <p className="text-sm text-text-muted">Loading your salary structure…</p>
        </CardBody>
      </Card>
    );
  }

  // A 404 here is ordinary — plenty of people are paid without a structure on
  // record — so it gets a sentence rather than an error state.
  if (isError || !structure) {
    return (
      <Card>
        <CardHeader title="Salary structure" />
        <CardBody>
          <p className="text-sm text-text-muted">
            No standing salary structure is on record for you. Your payslips are still
            in{' '}
            <Link href="/dashboard/payroll" className="font-medium text-brand-primary hover:underline">
              My payslips
            </Link>
            .
          </p>
        </CardBody>
      </Card>
    );
  }

  const { earnings, deductions } = groupLines(
    structure.lines.map((line) => ({ ...line, componentId: line.componentId })),
  );

  return (
    <Card>
      <CardHeader
        title="Salary structure"
        subtitle={`In force since ${formatDateOnly(structure.effectiveFrom)}. This is the standing figure, not what any one payslip came to.`}
      />
      <CardBody>
        <dl>
          {earnings.map((line) => (
            <Fact key={line.id} label={line.label}>
              <span className="tabular-nums">
                {formatCurrency(line.amount, structure.currency)}
              </span>
            </Fact>
          ))}
          {deductions.map((line) => (
            <Fact key={line.id} label={line.label}>
              <span className="tabular-nums text-status-warning">
                −{formatCurrency(amountOf(line.amount), structure.currency)}
              </span>
            </Fact>
          ))}
          <Fact label="Monthly net">
            <span className="tabular-nums font-semibold">
              {formatCurrency(structure.totals.net, structure.currency)}
            </span>
          </Fact>
        </dl>
      </CardBody>
    </Card>
  );
}

function MyProfile() {
  const user = useAuthStore((s) => s.user);
  const employeeId = user?.employeeId ?? user?.employee?.id ?? undefined;

  const { data, isLoading, isError, error } = useEmployeeProfile(employeeId);
  const profile = data?.data;

  usePageHeader('My profile', profile?.position ?? 'Your own record');

  if (!employeeId) {
    return (
      <Card>
        <EmptyState
          icon={<UserRound className="h-6 w-6" aria-hidden />}
          title="This account is not attached to an employee record"
          description="An operator account is not part of the workforce, so there is no profile behind it."
        />
      </Card>
    );
  }

  if (isLoading) {
    return <p className="text-sm text-text-muted">Loading your profile…</p>;
  }

  if (isError || !profile) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-status-error">
            {apiErrorMessage(error, 'Could not load your profile.')}
          </p>
        </CardBody>
      </Card>
    );
  }

  const contract = profile.contract;

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-start gap-5">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xl font-semibold text-brand-primary">
            {initials(profile)}
          </span>

          <div className="min-w-[16rem] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-text-heading">
                {profile.fullName}
              </h2>
              <Badge tone={STATUS_TONE[profile.status]}>{profile.status}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-text-muted">
              {profile.position ?? 'No position on record'} · {profile.employeeCode}
            </p>
            <p className="mt-0.5 text-sm text-text-muted">
              {profile.department?.name ?? 'No department'}
              {profile.branch ? ` · ${profile.branch.name}` : ''}
            </p>
          </div>

          <div className="w-full max-w-sm">
            <CompletionBar profile={profile} />
          </div>
        </CardBody>
      </Card>

      {/* items-start so the shorter column keeps its own height instead of
          stretching into a card of whitespace beside the taller one. */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <DetailsSection
          key={profile.updatedAt}
          profile={profile}
          employeeId={employeeId}
        />

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Employment"
              subtitle="Set by HR. Ask them if something here is wrong."
            />
            <CardBody>
              <dl>
                <Fact label="Employee code">{profile.employeeCode}</Fact>
                <Fact label="Position">{profile.position || <Blank />}</Fact>
                <Fact label="Department">
                  {profile.department?.name || <Blank />}
                </Fact>
                <Fact label="Branch">{profile.branch?.name || <Blank />}</Fact>
                <Fact label="Hire date">
                  {profile.hireDate ? formatDateOnly(profile.hireDate) : <Blank />}
                </Fact>
                <Fact label="Manager">{profile.manager?.fullName || <Blank />}</Fact>
                <Fact label="Supervisor">
                  {profile.supervisor?.fullName || <Blank />}
                </Fact>
                <Fact label="Time zone">
                  {profile.timezone ??
                    profile.branch?.timezone ?? (
                      <span className="text-text-muted">Company default</span>
                    )}
                </Fact>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Contract"
              subtitle={
                contract
                  ? `${contract.contractNumber} · ${contract.status.toLowerCase()}`
                  : undefined
              }
            />
            <CardBody>
              {contract ? (
                <dl>
                  <Fact label="Type">
                    {contract.contractType.replace(/_/g, ' ').toLowerCase()}
                  </Fact>
                  <Fact label="Work type">
                    {contract.workType.replace(/_/g, ' ').toLowerCase()}
                  </Fact>
                  <Fact label="Started">{formatDateOnly(contract.startDate)}</Fact>
                  <Fact label="Ends">
                    {contract.endDate ? (
                      formatDateOnly(contract.endDate)
                    ) : (
                      <span className="text-text-muted">Open ended</span>
                    )}
                  </Fact>
                  {contract.probationEndDate && (
                    <Fact label="Probation ends">
                      {formatDateOnly(contract.probationEndDate)}
                    </Fact>
                  )}
                  <Fact label="Hours a week">
                    <span className="tabular-nums">{contract.workHoursPerWeek}</span>
                  </Fact>
                  <Fact label="Notice period">
                    <span className="tabular-nums">{contract.noticePeriodDays} days</span>
                  </Fact>
                  <Fact label="Annual leave">
                    <span className="tabular-nums">{contract.annualLeaveDays} days</span>
                  </Fact>
                  <Fact label="Contracted salary">
                    <span className="tabular-nums">
                      {formatCurrency(contract.salary, contract.currency)}
                    </span>
                  </Fact>
                </dl>
              ) : (
                <p className="flex items-center gap-2 text-sm text-text-muted">
                  <FileSignature className="h-4 w-4" aria-hidden />
                  No active contract is on record for you.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <PaySection employeeId={employeeId} />

      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard/payroll">
          <Button variant="outline">
            <Wallet className="h-4 w-4" aria-hidden />
            My payslips
          </Button>
        </Link>
        <Link href="/dashboard/my-attendance">
          <Button variant="outline">
            <Briefcase className="h-4 w-4" aria-hidden />
            My attendance
          </Button>
        </Link>
        {profile.branch && (
          <Link href="/dashboard/branches">
            <Button variant="ghost">
              <Building2 className="h-4 w-4" aria-hidden />
              {profile.branch.name}
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_OWN_PROFILE">
      <MyProfile />
    </ProtectedRoute>
  );
}
