'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Clock, Pencil, Plus, Power, Star, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/common/EmptyState';
import { useLibraryItems } from '@/hooks/useLibraryItems';
import {
  useCreateOvertimePolicy,
  useDeleteOvertimePolicy,
  useOvertimePolicies,
  useSetDefaultOvertimePolicy,
  useSetOvertimePolicyActive,
  useUpdateOvertimePolicy,
} from '@/hooks/useOvertimePolicies';
import { apiErrorMessage } from '@/utils/apiError';
import type { OvertimePolicy, OvertimePolicyRules } from '@/types/overtime';
import { Field, SectionCard, SettingInput, ToggleRow } from './SettingsPrimitives';

/**
 * The four company-wide switches, which are deliberately NOT per policy: they
 * decide whether the overtime feature is open at all, and a rate card should
 * not be able to contradict that.
 *
 * Every one is read server-side as `!== 'false'`, so an unset key is on.
 */
export const OVERTIME_GATE_KEYS = [
  'overtime_enabled',
  'overtime_allow_employee_submit',
  'overtime_require_manager_approval',
  'overtime_require_reason',
] as const;

const GATES: { key: (typeof OVERTIME_GATE_KEYS)[number]; label: string; description: string }[] = [
  {
    key: 'overtime_enabled',
    label: 'Overtime is open',
    description:
      'Turns the whole module off company-wide. Requests already recorded are kept either way.',
  },
  {
    key: 'overtime_allow_employee_submit',
    label: 'Employees may submit their own',
    description: 'With this off, only HR and administrators log overtime on their behalf.',
  },
  {
    key: 'overtime_require_manager_approval',
    label: 'Approval required before it pays',
    description: 'Unapproved hours are recorded but never reach a payslip.',
  },
  {
    key: 'overtime_require_reason',
    label: 'A reason is mandatory',
    description: 'With this off the reason field stays on the form but may be left blank.',
  },
];

/**
 * What a policy that specifies nothing behaves like.
 *
 * The server composes a partial `rules` blob over the company overtime config,
 * so these are the editor's starting point rather than the authority — a new
 * policy saved untouched writes exactly what the company already does.
 */
const DEFAULT_RULES: OvertimePolicyRules = {
  eligible: true,
  holidayBehavior: 'STANDARD',
  lateThreshold: '22:00',
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  doubleOtAllowAnytime: true,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  dayEndBoundary: null,
  foodAllowanceEnabled: true,
  foodAllowanceAmount: 150,
  foodAllowanceThreshold: '22:00',
  doubleFoodAllowanceAnyTime: false,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
};

interface PolicyForm {
  id?: string;
  name: string;
  description: string;
  employmentType: string;
  isDefault: boolean;
  isActive: boolean;
  rules: OvertimePolicyRules;
}

const blankForm = (): PolicyForm => ({
  name: '',
  description: '',
  employmentType: '',
  isDefault: false,
  isActive: true,
  rules: structuredClone(DEFAULT_RULES),
});

/**
 * Defaults are merged UNDER a stored policy, including into the two rate tiers.
 *
 * A policy written before a rule existed has no value for it, and a number
 * input handed `undefined` becomes uncontrolled — React then keeps whatever the
 * previous policy left in the DOM when the drawer is reopened on another row.
 */
const formOf = (policy: OvertimePolicy): PolicyForm => ({
  id: policy.id,
  name: policy.name,
  description: policy.description ?? '',
  employmentType: policy.employmentType ?? '',
  isDefault: policy.isDefault,
  isActive: policy.isActive,
  rules: {
    ...DEFAULT_RULES,
    ...policy.rules,
    sunday: { ...DEFAULT_RULES.sunday, ...policy.rules?.sunday },
    holiday: { ...DEFAULT_RULES.holiday, ...policy.rules?.holiday },
  },
});

/** A rate multiplier or an hour cap. */
function NumberField({
  label,
  hint,
  value,
  onChange,
  step = 0.1,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <SettingInput
          id={id}
          type="number"
          step={step}
          min={0}
          value={Number.isFinite(value) ? String(value) : ''}
          // A cleared field is zero, not NaN. Sending NaN serialises to null and
          // the API rejects the whole payload for a field the user only blanked
          // on the way to typing a new number.
          onChange={(raw) => onChange(raw === '' ? 0 : Number(raw))}
        />
      )}
    </Field>
  );
}

function TimeField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <SettingInput id={id} type="time" value={value} onChange={onChange} />}
    </Field>
  );
}

/** One row of the policy list. */
function PolicyRow({
  policy,
  onEdit,
  onSetDefault,
  onToggleActive,
  onDelete,
  busy,
}: {
  policy: OvertimePolicy;
  onEdit: () => void;
  onSetDefault: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const scope = policy.employmentType
    ? `Employment type: ${policy.employmentType}`
    : policy.isDefault
      ? 'Company-wide fallback'
      : 'Not targeted at anyone';

  const rates = `Regular ${policy.rules?.regularRate}× · Late ${policy.rules?.lateRate}× · Double ${policy.rules?.doubleRate}×`;
  const assignees = policy._count?.employees;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-heading">{policy.name}</span>
          {policy.isDefault && <Badge tone="warning">Default</Badge>}
          {!policy.isActive && <Badge>Inactive</Badge>}
          {policy.rules?.holidayBehavior === 'IGNORE' && <Badge tone="info">Ignores holidays</Badge>}
          {policy.rules?.eligible === false && <Badge tone="error">Not eligible</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {scope}
          {typeof assignees === 'number' && ` · ${assignees} assigned directly`} · {rates}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!policy.isDefault && (
          <button
            type="button"
            aria-label={`Make ${policy.name} the company default`}
            title="Make the company default"
            disabled={busy}
            onClick={onSetDefault}
            className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-surface-border-light hover:text-status-warning disabled:opacity-60"
          >
            <Star className="h-4 w-4" aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label={`${policy.isActive ? 'Deactivate' : 'Activate'} ${policy.name}`}
          title={policy.isActive ? 'Deactivate' : 'Activate'}
          disabled={busy}
          onClick={onToggleActive}
          className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-surface-border-light hover:text-brand-primary disabled:opacity-60"
        >
          <Power className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Edit ${policy.name}`}
          title="Edit"
          onClick={onEdit}
          className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-surface-border-light hover:text-brand-primary"
        >
          <Pencil className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Delete ${policy.name}`}
          title="Delete"
          disabled={busy}
          onClick={onDelete}
          className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-status-error-bg hover:text-status-error disabled:opacity-60"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}

export function OvertimePolicySection({
  settings,
  onChangeSetting,
  canEdit,
}: {
  /** The settings map, for the four company-wide gates. */
  settings: Record<string, string>;
  onChangeSetting: (key: string, value: string) => void;
  /** ADMIN. HR may read the policies; every mutation route is administrators only. */
  canEdit: boolean;
}) {
  const [form, setForm] = useState<PolicyForm | null>(null);

  const { data, isLoading, isError, error } = useOvertimePolicies();
  const employmentTypes = useLibraryItems({ type: 'EMPLOYMENT_TYPE', activeOnly: true });

  const createPolicy = useCreateOvertimePolicy();
  const updatePolicy = useUpdateOvertimePolicy();
  const setDefault = useSetDefaultOvertimePolicy();
  const setActive = useSetOvertimePolicyActive();
  const deletePolicy = useDeleteOvertimePolicy();

  const policies = data?.data ?? [];
  const typeLabels = (employmentTypes.data?.data ?? []).map((item) => item.label);
  const busy = setDefault.isPending || setActive.isPending || deletePolicy.isPending;
  const saving = createPolicy.isPending || updatePolicy.isPending;

  const setRule = <K extends keyof OvertimePolicyRules>(key: K, value: OvertimePolicyRules[K]) =>
    setForm((current) => (current ? { ...current, rules: { ...current.rules, [key]: value } } : current));

  const setTier = (
    tier: 'sunday' | 'holiday',
    key: 'regularRate' | 'lateRate' | 'lateThreshold',
    value: number | string,
  ) =>
    setForm((current) =>
      current
        ? { ...current, rules: { ...current.rules, [tier]: { ...current.rules[tier], [key]: value } } }
        : current,
    );

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast.error('Give the policy a name');
      return;
    }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      isActive: form.isActive,
      isDefault: form.isDefault,
      // '' means "not targeted", which the column stores as null rather than as
      // an employment type nobody has.
      employmentType: form.employmentType || null,
      rules: form.rules,
    };

    try {
      if (form.id) {
        await updatePolicy.mutateAsync({ id: form.id, payload });
        toast.success('Policy updated');
      } else {
        await createPolicy.mutateAsync(payload);
        toast.success('Policy created');
      }
      setForm(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save the policy'));
    }
  };

  const promote = async (policy: OvertimePolicy) => {
    try {
      await setDefault.mutateAsync(policy.id);
      toast.success(`"${policy.name}" is now the company default`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not change the default'));
    }
  };

  const flip = async (policy: OvertimePolicy) => {
    try {
      await setActive.mutateAsync({ id: policy.id, isActive: !policy.isActive });
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not change the policy'));
    }
  };

  const remove = async (policy: OvertimePolicy) => {
    if (
      !window.confirm(
        `Delete "${policy.name}"? Everyone on it falls back to their employment-type policy, then to the company default.`,
      )
    ) {
      return;
    }
    try {
      await deletePolicy.mutateAsync(policy.id);
      toast.success('Policy deleted');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not delete the policy'));
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="Overtime controls"
        description="Company-wide switches. Rates and caps are set per policy below."
        icon={Clock}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {GATES.map((gate) => (
            <ToggleRow
              key={gate.key}
              label={gate.label}
              description={gate.description}
              disabled={!canEdit}
              checked={settings[gate.key] !== 'false'}
              onChange={(value) => onChangeSetting(gate.key, value ? 'true' : 'false')}
            />
          ))}
        </div>
        <p className="text-xs text-text-muted">
          Each employee resolves one policy, in order: their own override, then their
          employment type, then the company default.
        </p>
      </SectionCard>

      <div className="surface-panel">
        <div className="flex items-center justify-between gap-4 border-b border-surface-border-light px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold text-text-heading sm:text-base">Policies</h3>
          {canEdit && (
            <Button size="sm" onClick={() => setForm(blankForm())}>
              <Plus className="h-4 w-4" aria-hidden />
              New policy
            </Button>
          )}
        </div>

        {isLoading ? (
          <p className="px-4 py-10 text-center text-sm text-text-muted sm:px-5">Loading policies…</p>
        ) : isError ? (
          <p className="px-4 py-10 text-center text-sm text-status-error sm:px-5">
            {apiErrorMessage(error, 'Could not load the overtime policies')}
          </p>
        ) : policies.length === 0 ? (
          <EmptyState
            title="No overtime policies yet"
            description="Create a company default first, then add targeted policies — a daily-wage policy that treats a public holiday as an ordinary day, for instance."
            icon={<Clock className="h-6 w-6" aria-hidden />}
          />
        ) : (
          <ul className="divide-y divide-surface-border-light">
            {policies.map((policy) => (
              <PolicyRow
                key={policy.id}
                policy={policy}
                busy={busy || !canEdit}
                onEdit={() => setForm(formOf(policy))}
                onSetDefault={() => promote(policy)}
                onToggleActive={() => flip(policy)}
                onDelete={() => remove(policy)}
              />
            ))}
          </ul>
        )}
      </div>

      {form && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-text-heading/40"
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? 'Edit overtime policy' : 'New overtime policy'}
          onClick={() => setForm(null)}
        >
          <div
            className="flex h-full w-full max-w-3xl flex-col bg-surface-page shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-surface-border bg-surface-card px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-text-heading">
                  {form.id ? 'Edit overtime policy' : 'New overtime policy'}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted">
                  Everything here is scoped to this policy. The company-wide switches stay
                  on the panel behind.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setForm(null)}
                className="rounded-[var(--radius-button)] p-1.5 text-text-muted transition-colors hover:bg-surface-border-light"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {/*
              A reader gets the same drawer with every control inert. `fieldset`
              rather than a prop threaded through forty inputs: it disables the
              whole subtree natively, so a control added later is covered without
              anyone remembering to. HR may look at a rate card — every write
              route behind it is administrators only.
            */}
            <fieldset
              disabled={!canEdit}
              className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4 [min-inline-size:0] disabled:opacity-90 sm:p-5"
            >
              <SectionCard title="Policy" icon={Clock} collapsible={false}>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Name">
                    {(id) => (
                      <SettingInput
                        id={id}
                        value={form.name}
                        onChange={(name) => setForm({ ...form, name })}
                        placeholder="Daily wage overtime"
                      />
                    )}
                  </Field>

                  <Field label="Description">
                    {(id) => (
                      <SettingInput
                        id={id}
                        value={form.description}
                        onChange={(description) => setForm({ ...form, description })}
                        placeholder="Who this is for, in a line"
                      />
                    )}
                  </Field>

                  <Field
                    label="Employment type"
                    hint="Everyone of this type inherits the policy unless they have an override of their own. Leave it unset for a policy nobody inherits."
                  >
                    {(id) => (
                      <Select
                        id={id}
                        value={form.employmentType}
                        onChange={(event) =>
                          setForm({ ...form, employmentType: event.target.value })
                        }
                      >
                        <option value="">Not targeted</option>
                        {/* A stored value the library no longer offers is kept as
                            an option: dropping it would silently retarget the
                            policy on the next save. */}
                        {form.employmentType && !typeLabels.includes(form.employmentType) && (
                          <option value={form.employmentType}>
                            {form.employmentType} (no longer in the library)
                          </option>
                        )}
                        {typeLabels.map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>

                  <Field
                    label="Public holidays"
                    hint="Ignore treats a public holiday as an ordinary weekday, which is how daily-wage staff are paid in several of the jurisdictions this runs in."
                  >
                    {(id) => (
                      <Select
                        id={id}
                        value={form.rules.holidayBehavior}
                        onChange={(event) =>
                          setRule('holidayBehavior', event.target.value as 'STANDARD' | 'IGNORE')
                        }
                      >
                        <option value="STANDARD">Pay the holiday premium</option>
                        <option value="IGNORE">Ignore — treat as a weekday</option>
                      </Select>
                    )}
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <ToggleRow
                    label="Eligible for overtime"
                    checked={form.rules.eligible}
                    onChange={(eligible) => setRule('eligible', eligible)}
                  />
                  <ToggleRow
                    label="Company default"
                    checked={form.isDefault}
                    onChange={(isDefault) => setForm({ ...form, isDefault })}
                  />
                  <ToggleRow
                    label="Active"
                    checked={form.isActive}
                    onChange={(isActive) => setForm({ ...form, isActive })}
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Boundaries"
                description="When a working day becomes overtime, and when it stops counting"
                icon={Clock}
                collapsible={false}
              >
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <TimeField
                    label="Shift end"
                    hint="Weekday overtime is only counted after this time."
                    value={form.rules.shiftEndTime}
                    onChange={(value) => setRule('shiftEndTime', value)}
                  />
                  <TimeField
                    label="Late threshold"
                    hint="Weekday overtime worked past this time pays the late rate instead of the regular one."
                    value={form.rules.lateThreshold}
                    onChange={(value) => setRule('lateThreshold', value)}
                  />
                  <Field
                    label="Day-end override"
                    hint="Leave blank to inherit the attendance day end from the Attendance settings."
                  >
                    {(id) => (
                      <SettingInput
                        id={id}
                        type="time"
                        value={form.rules.dayEndBoundary ?? ''}
                        onChange={(value) => setRule('dayEndBoundary', value || null)}
                      />
                    )}
                  </Field>
                </div>
              </SectionCard>

              <SectionCard
                title="Rates"
                description="Multipliers applied to the hourly rate"
                icon={Clock}
                collapsible={false}
              >
                <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                  <NumberField
                    label="Weekday regular ×"
                    hint="Before the late threshold."
                    value={form.rules.regularRate}
                    onChange={(value) => setRule('regularRate', value)}
                  />
                  <NumberField
                    label="Weekday late ×"
                    hint="After the late threshold."
                    value={form.rules.lateRate}
                    onChange={(value) => setRule('lateRate', value)}
                  />
                  <NumberField
                    label="Fallback double ×"
                    hint="Used on a rest day or holiday when no specific tier below applies."
                    value={form.rules.doubleRate}
                    onChange={(value) => setRule('doubleRate', value)}
                  />
                </div>

                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <ToggleRow
                    label="Rest-day and holiday tier"
                    description="Off makes every hour pay the weekday rates."
                    checked={form.rules.doubleOtEnabled}
                    onChange={(value) => setRule('doubleOtEnabled', value)}
                  />
                  <ToggleRow
                    label="Countable at any hour"
                    description="Rest-day and holiday overtime need not wait for the shift to end."
                    checked={form.rules.doubleOtAllowAnytime}
                    onChange={(value) => setRule('doubleOtAllowAnytime', value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                  <NumberField
                    label="Rest day regular ×"
                    value={form.rules.sunday.regularRate}
                    onChange={(value) => setTier('sunday', 'regularRate', value)}
                  />
                  <NumberField
                    label="Rest day late ×"
                    value={form.rules.sunday.lateRate}
                    onChange={(value) => setTier('sunday', 'lateRate', value)}
                  />
                  <TimeField
                    label="Rest day late from"
                    value={form.rules.sunday.lateThreshold}
                    onChange={(value) => setTier('sunday', 'lateThreshold', value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                  <NumberField
                    label="Holiday regular ×"
                    value={form.rules.holiday.regularRate}
                    onChange={(value) => setTier('holiday', 'regularRate', value)}
                  />
                  <NumberField
                    label="Holiday late ×"
                    value={form.rules.holiday.lateRate}
                    onChange={(value) => setTier('holiday', 'lateRate', value)}
                  />
                  <TimeField
                    label="Holiday late from"
                    value={form.rules.holiday.lateThreshold}
                    onChange={(value) => setTier('holiday', 'lateThreshold', value)}
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Food allowance"
                description="A flat amount paid on a qualifying overtime day"
                icon={Clock}
                collapsible={false}
              >
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <ToggleRow
                    label="Pay a food allowance"
                    checked={form.rules.foodAllowanceEnabled}
                    onChange={(value) => setRule('foodAllowanceEnabled', value)}
                  />
                  <ToggleRow
                    label="Always on rest days"
                    description="Pay it on a rest day or holiday regardless of the hour."
                    checked={form.rules.doubleFoodAllowanceAnyTime}
                    onChange={(value) => setRule('doubleFoodAllowanceAnyTime', value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                  <NumberField
                    label="Amount"
                    step={1}
                    hint="Quoted in the company's default currency."
                    value={form.rules.foodAllowanceAmount}
                    onChange={(value) => setRule('foodAllowanceAmount', value)}
                  />
                  <TimeField
                    label="Qualifying time"
                    hint="Overtime ending after this time earns the allowance."
                    value={form.rules.foodAllowanceThreshold}
                    onChange={(value) => setRule('foodAllowanceThreshold', value)}
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Caps"
                description="Hours beyond these are refused when the request is filed"
                icon={Clock}
                collapsible={false}
              >
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <NumberField
                    label="Per weekday"
                    step={1}
                    value={form.rules.maxHoursPerDay}
                    onChange={(value) => setRule('maxHoursPerDay', value)}
                  />
                  <NumberField
                    label="Per rest day"
                    step={1}
                    value={form.rules.maxHoursPerDoubleDay}
                    onChange={(value) => setRule('maxHoursPerDoubleDay', value)}
                  />
                  <NumberField
                    label="Per month"
                    step={1}
                    value={form.rules.maxHoursPerMonth}
                    onChange={(value) => setRule('maxHoursPerMonth', value)}
                  />
                  <NumberField
                    label="Per year"
                    step={1}
                    value={form.rules.maxHoursPerYear}
                    onChange={(value) => setRule('maxHoursPerYear', value)}
                  />
                </div>
              </SectionCard>
            </fieldset>

            <div className="flex justify-end gap-2 border-t border-surface-border bg-surface-card px-5 py-4">
              <Button variant="outline" onClick={() => setForm(null)}>
                {canEdit ? 'Cancel' : 'Close'}
              </Button>
              {canEdit && (
                <Button onClick={save} isLoading={saving}>
                  {form.id ? 'Save changes' : 'Create policy'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
