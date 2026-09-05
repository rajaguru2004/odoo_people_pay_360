'use client';

import { Building2, Clock, UserCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { usePublicBranding } from '@/hooks/useSettings';
import { useAuthStore } from '@/store/authStore';
import { CURRENCY_DECIMALS } from '@/utils/constants';
import { formatDateTime } from '@/utils/formatDate';
import { fullName } from '@/utils/formatters';
import type { UserRole } from '@/types/auth';
import { SectionCard } from './SettingsPrimitives';

const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  HR_MANAGER: 'HR manager',
  PAYROLL_OFFICER: 'Payroll officer',
  MANAGER: 'Department manager',
  EMPLOYEE: 'Employee',
};

/** One label above its value, for a panel that only reads. */
function ReadOnlyField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-text-heading">{value || '—'}</dd>
    </div>
  );
}

/**
 * What Settings shows somebody who may not configure the company.
 *
 * The nav offers Settings to every role, but `GET /system-settings` and the
 * PATCH behind it are administrators only. Rather than route four roles to a
 * permission-denied screen from a link the product itself drew, this reads the
 * unauthenticated branding endpoint — which anyone may call — and prints the
 * company profile beside the session's own details. Everything on it is
 * read-only because nothing here has a write endpoint this caller may reach.
 */
export function PreferencesSection() {
  const user = useAuthStore((state) => state.user);
  const { data, isLoading } = usePublicBranding();
  const branding = data?.data;

  const currency = branding?.default_currency ?? '';
  const decimals = CURRENCY_DECIMALS[currency];

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="Your account"
        description="What this portal knows about the session you are signed in with"
        icon={UserCircle}
      >
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadOnlyField
            label="Name"
            value={user?.employee ? fullName(user.employee) : user?.email}
          />
          <ReadOnlyField label="Email" value={user?.email} />
          <ReadOnlyField
            label="Role"
            value={user?.role ? <Badge tone="info">{ROLE_LABEL[user.role]}</Badge> : null}
          />
          <ReadOnlyField label="Employee code" value={user?.employee?.employeeCode} />
          <ReadOnlyField label="Department" value={user?.employee?.department?.name} />
          <ReadOnlyField label="Branch" value={user?.employee?.branch?.name} />
          <ReadOnlyField
            label="Last signed in"
            value={user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'This session'}
          />
        </dl>

        <p className="text-xs text-text-muted">
          Your own details are maintained on your employee profile. Anything wrong here is
          a change for HR to make.
        </p>
      </SectionCard>

      <SectionCard
        title="Company profile"
        description="The settings every screen in this portal is rendered against"
        icon={Building2}
      >
        {isLoading ? (
          <p className="py-4 text-sm text-text-muted">Loading…</p>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ReadOnlyField label="Company" value={branding?.company_name} />
            <ReadOnlyField label="Short name" value={branding?.company_short_name} />
            <ReadOnlyField
              label="Currency"
              value={
                currency &&
                `${currency}${decimals === undefined ? '' : ` · ${decimals} decimal${decimals === 1 ? '' : 's'}`}`
              }
            />
            <ReadOnlyField label="Timezone" value={branding?.default_timezone} />
          </dl>
        )}
      </SectionCard>

      <SectionCard
        title="Times and dates"
        description="How this portal reads a clock"
        icon={Clock}
      >
        <p className="text-sm text-text-body">
          Attendance windows, leave periods and payroll cut-offs are wall-clock times in{' '}
          <strong className="text-text-heading">
            {branding?.default_timezone ?? 'the company timezone'}
          </strong>
          , not in your device&apos;s. A punch you record at 08:00 locally is stored as the
          instant it happened and shown back to everyone in the company zone, so a
          timesheet reads the same wherever it is opened.
        </p>
        {user?.employee?.timezone && (
          <p className="text-sm text-text-muted">
            Your employee record carries its own zone,{' '}
            <strong className="text-text-heading">{user.employee.timezone}</strong>, which
            the schedule screens use for your personal roster.
          </p>
        )}
      </SectionCard>
    </div>
  );
}
