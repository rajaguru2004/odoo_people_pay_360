'use client';

import { BellRing, UserCheck } from 'lucide-react';
import { Field, SectionCard, SettingInput } from './SettingsPrimitives';

/** The keys this section owns. The save bar patches exactly these. */
export const PEOPLE_KEYS = [
  'contract_expiry_alert_days',
  'probation_alert_days',
  'visa_expiry_alert_days',
  'default_notice_period_days',
  'default_annual_leave_days',
] as const;

/** One number-of-days field, since every setting on this screen is one. */
function DaysField({
  label,
  hint,
  settingKey,
  values,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  settingKey: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <SettingInput
          id={id}
          type="number"
          min={0}
          value={values[settingKey] ?? ''}
          onChange={(value) => onChange(settingKey, value)}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

export function PeopleSection({
  values,
  onChange,
  disabled,
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const shared = { values, onChange, disabled };

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="Expiry warnings"
        description="How far ahead a date that is about to lapse starts being reported"
        icon={BellRing}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <DaysField
            {...shared}
            label="Contract expiry (days)"
            settingKey="contract_expiry_alert_days"
            hint="Days before a contract ends that it appears on the expiring list."
          />
          <DaysField
            {...shared}
            label="Probation ending (days)"
            settingKey="probation_alert_days"
            hint="Days before a probation period ends that it is flagged for a decision."
          />
          <DaysField
            {...shared}
            label="Visa expiry (days)"
            settingKey="visa_expiry_alert_days"
            hint="Days before a visa or labour card expires that it is reported for renewal."
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Employment defaults"
        description="What a new employment record starts with, before anyone edits it"
        icon={UserCheck}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DaysField
            {...shared}
            label="Notice period (days)"
            settingKey="default_notice_period_days"
            hint="Pre-filled on a new contract. Changing it here leaves existing contracts alone."
          />
          <DaysField
            {...shared}
            label="Annual leave (days)"
            settingKey="default_annual_leave_days"
            hint="The yearly entitlement a new employee starts with, before any leave-type allocation of its own."
          />
        </div>
      </SectionCard>
    </div>
  );
}
