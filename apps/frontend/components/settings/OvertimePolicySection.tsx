'use client';

import { ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Clock,
  Plus,
  Trash2,
  Pencil,
  Star,
  Power,
  Save,
  X,
  Info,
} from 'lucide-react';
import systemSettingsService from '@/services/systemSettingsService';
import libraryService from '@/services/libraryService';
import overtimePolicyService, {
  EmploymentType,
  HolidayBehavior,
  OvertimePolicy,
  OvertimePolicyRules,
} from '@/services/overtimePolicyService';

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30 transition-all';

// Defaults mirror the backend global overtime defaults, so a policy created
// without touching a field behaves like the standard rules.
const DEFAULT_RULES: OvertimePolicyRules = {
  eligible: true,
  holidayBehavior: 'STANDARD',
  lateThreshold: '22:00',
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2.0,
  doubleOtAllowAnytime: true,
  sunday: { regularRate: 2.0, lateRate: 2.0, lateThreshold: '22:00' },
  holiday: { regularRate: 2.0, lateRate: 2.0, lateThreshold: '22:00' },
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

interface FormState {
  id?: string;
  name: string;
  description: string;
  employmentType: '' | EmploymentType;
  isDefault: boolean;
  isActive: boolean;
  rules: OvertimePolicyRules;
}

const blankForm = (): FormState => ({
  name: '',
  description: '',
  employmentType: '',
  isDefault: false,
  isActive: true,
  rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
});

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-primary/30 ${checked ? 'bg-brand-primary' : 'bg-slate-300'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

// Hover tooltip (info "ⓘ" icon) explaining what a setting does.
function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <Info className="h-3.5 w-3.5 cursor-help text-slate-400 hover:text-slate-600" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-56 -translate-x-1/2 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600">
      {label}
      {hint && <Hint text={hint} />}
    </span>
  );
}

function Num({
  label,
  value,
  onChange,
  step = 0.1,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} hint={hint} />
      <input
        type="number"
        step={step}
        className={inputCls}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function Time({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <FieldLabel label={label} hint={hint} />
      <input
        type="time"
        className={inputCls}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

// A labelled on/off row with an optional tooltip — mirrors the global settings.
function ToggleField({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-sm text-slate-700">
        {label}
        {hint && <Hint text={hint} />}
      </span>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

// Section wrapper: a titled card, matching the global Overtime Settings layout.
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        {title}
        {hint && <Hint text={hint} />}
      </h4>
      {children}
    </div>
  );
}

// Company-wide overtime gates (not per-policy). Managed here now that the legacy
// Overtime Settings screen is gone.
type Gates = {
  overtime_enabled: boolean;
  overtime_allow_employee_submit: boolean;
  overtime_require_manager_approval: boolean;
  overtime_require_reason: boolean;
};

export default function OvertimePolicySection() {
  const [gates, setGates] = useState<Gates>({
    overtime_enabled: true,
    overtime_allow_employee_submit: true,
    overtime_require_manager_approval: true,
    overtime_require_reason: true,
  });
  const [policies, setPolicies] = useState<OvertimePolicy[]>([]);
  const [contractTypes, setContractTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingGate, setSavingGate] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [settingsRes, listRes, ctRes] = await Promise.all([
        systemSettingsService.getAll(),
        overtimePolicyService.list(),
        libraryService.getAll('EMPLOYMENT_TYPE', true).catch(() => null),
      ]);
      const gv = (k: string) =>
        settingsRes.data.find((s) => s.key === k)?.value !== 'false';
      setGates({
        overtime_enabled: gv('overtime_enabled'),
        overtime_allow_employee_submit: gv('overtime_allow_employee_submit'),
        overtime_require_manager_approval: gv('overtime_require_manager_approval'),
        overtime_require_reason: gv('overtime_require_reason'),
      });
      setPolicies(listRes.data || []);
      setContractTypes((ctRes?.data || []).map((i) => i.label));
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message || e?.message || 'Failed to load policies',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveGate = async (key: keyof Gates, v: boolean) => {
    setSavingGate(true);
    try {
      await systemSettingsService.update({ [key]: String(v) });
      setGates((g) => ({ ...g, [key]: v }));
      toast.success('Overtime settings updated');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to update');
    } finally {
      setSavingGate(false);
    }
  };

  const openCreate = () => setForm(blankForm());
  const openEdit = (p: OvertimePolicy) =>
    setForm({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      employmentType: p.employmentType ?? '',
      isDefault: p.isDefault,
      isActive: p.isActive,
      rules: { ...DEFAULT_RULES, ...p.rules, sunday: { ...DEFAULT_RULES.sunday, ...p.rules.sunday }, holiday: { ...DEFAULT_RULES.holiday, ...p.rules.holiday } },
    });

  const setRule = <K extends keyof OvertimePolicyRules>(
    key: K,
    val: OvertimePolicyRules[K],
  ) => setForm((f) => (f ? { ...f, rules: { ...f.rules, [key]: val } } : f));

  const setTier = (
    tier: 'sunday' | 'holiday',
    key: keyof OvertimePolicyRules['sunday'],
    val: number | string,
  ) =>
    setForm((f) =>
      f ? { ...f, rules: { ...f.rules, [tier]: { ...f.rules[tier], [key]: val } } } : f,
    );

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast.error('Policy name is required');
      return;
    }
    setSaving(true);
    try {
      const dto = {
        name: form.name.trim(),
        description: form.description || undefined,
        isActive: form.isActive,
        isDefault: form.isDefault,
        employmentType: form.employmentType || null,
        rules: form.rules,
      };
      if (form.id) {
        await overtimePolicyService.update(form.id, dto);
        toast.success('Policy updated');
      } else {
        await overtimePolicyService.create(dto);
        toast.success('Policy created');
      }
      setForm(null);
      await load();
    } catch (e: any) {
      toast.error(
        e?.response?.data?.message || e?.message || 'Failed to save policy',
      );
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (p: OvertimePolicy) => {
    try {
      await overtimePolicyService.setDefault(p.id);
      toast.success(`"${p.name}" is now the company default`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed');
    }
  };

  const toggleActive = async (p: OvertimePolicy) => {
    try {
      await overtimePolicyService.setActive(p.id, !p.isActive);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed');
    }
  };

  const remove = async (p: OvertimePolicy) => {
    if (!confirm(`Delete overtime policy "${p.name}"? Assignees fall back to their employment-type / default policy.`))
      return;
    try {
      await overtimePolicyService.remove(p.id);
      toast.success('Policy deleted');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to delete');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Company-wide overtime controls */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-1 flex items-center gap-2 font-semibold text-slate-800">
          <Clock className="h-5 w-5 text-brand-primary" /> Overtime controls
          {savingGate && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        </div>
        <p className="mb-4 max-w-3xl text-sm text-slate-500">
          Company-wide overtime switches. Pay rates, thresholds and holiday
          behaviour are configured per <strong>policy</strong> below — each
          employee resolves one via <strong>Employee Override → Employment Type →
          Company Default</strong>.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <ToggleField
            label="Enable overtime"
            checked={gates.overtime_enabled}
            onChange={(v) => saveGate('overtime_enabled', v)}
            hint="Turn the overtime request system on/off company-wide. When off, employees and managers cannot view or submit overtime. Existing requests are preserved."
          />
          <ToggleField
            label="Allow employee submission"
            checked={gates.overtime_allow_employee_submit}
            onChange={(v) => saveGate('overtime_allow_employee_submit', v)}
            hint="When on, employees can submit their own overtime. When off, only admins / HR log overtime for them."
          />
          <ToggleField
            label="Require manager approval"
            checked={gates.overtime_require_manager_approval}
            onChange={(v) => saveGate('overtime_require_manager_approval', v)}
            hint="When on, overtime must be approved by a manager or HR before it counts towards payroll."
          />
          <ToggleField
            label="Require overtime reason"
            checked={gates.overtime_require_reason}
            onChange={(v) => saveGate('overtime_require_reason', v)}
            hint="When on, the reason field is mandatory (min. 10 characters) on the overtime request form. When off, it is shown as optional and may be left blank."
          />
        </div>
      </div>

      {/* Policy list */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <h3 className="font-semibold text-slate-800">Policies</h3>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> New policy
          </button>
        </div>

        {policies.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No policies yet. Create a Company Default, then add targeted policies
            (e.g. a Daily Wage policy that ignores National Holidays).
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {policies.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-800">{p.name}</span>
                    {p.isDefault && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        <Star className="h-3 w-3" /> Default
                      </span>
                    )}
                    {!p.isActive && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                        Inactive
                      </span>
                    )}
                    {p.rules?.holidayBehavior === 'IGNORE' && (
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        Ignores holidays
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {p.employmentType
                      ? `Employment type: ${p.employmentType}`
                      : p.isDefault
                        ? 'Company-wide default'
                        : 'Not targeted'}
                    {typeof p._count?.employees === 'number' &&
                      ` · ${p._count.employees} direct assignee(s)`}
                    {` · Reg ${p.rules?.regularRate}× / Late ${p.rules?.lateRate}× / Double ${p.rules?.doubleRate}×`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!p.isDefault && (
                    <button
                      title="Set as company default"
                      onClick={() => setDefault(p)}
                      className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-amber-600"
                    >
                      <Star className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    title={p.isActive ? 'Deactivate' : 'Activate'}
                    onClick={() => toggleActive(p)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                  >
                    <Power className="h-4 w-4" />
                  </button>
                  <button
                    title="Edit"
                    onClick={() => openEdit(p)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-brand-primary"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    title="Delete"
                    onClick={() => remove(p)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor — right slide-over drawer */}
      {form && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={() => setForm(null)}
        >
          <div
            className="flex h-full w-full max-w-4xl flex-col bg-slate-50 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-slate-800">
                  {form.id ? 'Edit overtime policy' : 'New overtime policy'}
                </h3>
                <p className="text-xs text-slate-500">
                  The same settings as global Overtime Settings, scoped to this policy.
                </p>
              </div>
              <button
                onClick={() => setForm(null)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <Section title="Policy">
                <div className="space-y-3">
                  <label className="block">
                    <FieldLabel label="Name *" />
                    <input
                      className={inputCls}
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Daily Wage OT"
                    />
                  </label>
                  <label className="block">
                    <FieldLabel label="Description" />
                    <input
                      className={inputCls}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </label>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <FieldLabel
                        label="Employment type target"
                        hint="Which Employment Type (from the library) this policy applies to. Employees of this type inherit it unless they have a direct override. Leave blank for an untargeted policy."
                      />
                      <select
                        className={inputCls}
                        value={form.employmentType}
                        onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                      >
                        <option value="">— Not targeted —</option>
                        {form.employmentType &&
                          !contractTypes.includes(form.employmentType) && (
                            <option value={form.employmentType}>{form.employmentType}</option>
                          )}
                        {contractTypes.map((label) => (
                          <option key={label} value={label}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <FieldLabel
                        label="Holiday behaviour"
                        hint="STANDARD pays the holiday premium tier on National Holidays. IGNORE treats a National Holiday as an ordinary weekday (no premium) — e.g. for daily-wage staff."
                      />
                      <select
                        className={inputCls}
                        value={form.rules.holidayBehavior}
                        onChange={(e) => setRule('holidayBehavior', e.target.value as HolidayBehavior)}
                      >
                        <option value="STANDARD">Standard (holiday premium)</option>
                        <option value="IGNORE">Ignore (treat holiday as weekday)</option>
                      </select>
                    </label>
                  </div>
                </div>
              </Section>

              <Section title="Status">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <ToggleField
                    label="Eligible for OT"
                    checked={form.rules.eligible}
                    onChange={(v) => setRule('eligible', v)}
                    hint="When off, employees under this policy cannot register overtime at all."
                  />
                  <ToggleField
                    label="Company default"
                    checked={form.isDefault}
                    onChange={(v) => setForm({ ...form, isDefault: v })}
                    hint="Fallback policy for employees with no override and no matching employment-type policy. Exactly one active default."
                  />
                  <ToggleField
                    label="Active"
                    checked={form.isActive}
                    onChange={(v) => setForm({ ...form, isActive: v })}
                    hint="Inactive policies are skipped during resolution."
                  />
                </div>
              </Section>

              <Section title="Shift & overtime boundaries">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Time
                    label="Shift end (OT after)"
                    value={form.rules.shiftEndTime}
                    onChange={(v) => setRule('shiftEndTime', v)}
                    hint="Weekday overtime is only permitted after this time (end of the normal shift)."
                  />
                  <Time
                    label="Late OT threshold"
                    value={form.rules.lateThreshold}
                    onChange={(v) => setRule('lateThreshold', v)}
                    hint="Weekday OT worked past this time is paid at the Late rate instead of the Regular OT rate."
                  />
                  <Time
                    label="Day-end boundary"
                    value={form.rules.dayEndBoundary ?? ''}
                    onChange={(v) => setRule('dayEndBoundary', v || null)}
                    hint="Overtime is only counted up to this attendance-day boundary. Leave blank to inherit the global attendance day-end time."
                  />
                </div>
              </Section>

              <Section title="Weekday OT rates" hint="Multipliers applied to the hourly rate for weekday overtime.">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Num label="Regular ×" value={form.rules.regularRate} onChange={(v) => setRule('regularRate', v)} hint="Multiplier for weekday OT before the late threshold." />
                  <Num label="Late ×" value={form.rules.lateRate} onChange={(v) => setRule('lateRate', v)} hint="Multiplier for weekday OT worked after the late threshold." />
                </div>
              </Section>

              <Section title="Rest-day & holiday rates">
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ToggleField
                      label="Double OT enabled"
                      checked={form.rules.doubleOtEnabled}
                      onChange={(v) => setRule('doubleOtEnabled', v)}
                      hint="Enable the higher rest-day / holiday (double) OT tier. When off, all OT uses weekday rates."
                    />
                    <ToggleField
                      label="Double OT any time"
                      checked={form.rules.doubleOtAllowAnytime}
                      onChange={(v) => setRule('doubleOtAllowAnytime', v)}
                      hint="Allow rest-day / holiday OT to be logged at any time of day, not just after shift end."
                    />
                  </div>
                  <Num
                    label="Fallback double ×"
                    value={form.rules.doubleRate}
                    onChange={(v) => setRule('doubleRate', v)}
                    hint="Multiplier used for a rest-day/holiday when no specific Sunday/Holiday rate applies (legacy fallback)."
                  />
                  <div className="grid grid-cols-3 gap-3">
                    <Num label="Sunday reg ×" value={form.rules.sunday.regularRate} onChange={(v) => setTier('sunday', 'regularRate', v)} hint="Rest-day (weekly-off) OT multiplier before the Sunday late threshold." />
                    <Num label="Sunday late ×" value={form.rules.sunday.lateRate} onChange={(v) => setTier('sunday', 'lateRate', v)} hint="Rest-day OT multiplier after the Sunday late threshold." />
                    <Time label="Sunday late at" value={form.rules.sunday.lateThreshold} onChange={(v) => setTier('sunday', 'lateThreshold', v)} hint="Time after which rest-day OT switches to the Sunday late rate." />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Num label="Holiday reg ×" value={form.rules.holiday.regularRate} onChange={(v) => setTier('holiday', 'regularRate', v)} hint="National-Holiday OT multiplier before the holiday late threshold." />
                    <Num label="Holiday late ×" value={form.rules.holiday.lateRate} onChange={(v) => setTier('holiday', 'lateRate', v)} hint="National-Holiday OT multiplier after the holiday late threshold." />
                    <Time label="Holiday late at" value={form.rules.holiday.lateThreshold} onChange={(v) => setTier('holiday', 'lateThreshold', v)} hint="Time after which holiday OT switches to the holiday late rate." />
                  </div>
                </div>
              </Section>

              <Section title="Food allowance">
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ToggleField
                      label="Enabled"
                      checked={form.rules.foodAllowanceEnabled}
                      onChange={(v) => setRule('foodAllowanceEnabled', v)}
                      hint="Pay a flat food allowance when OT runs past the threshold time."
                    />
                    <ToggleField
                      label="Any time on double days"
                      checked={form.rules.doubleFoodAllowanceAnyTime}
                      onChange={(v) => setRule('doubleFoodAllowanceAnyTime', v)}
                      hint="On rest-day / holiday OT, pay the food allowance regardless of the threshold time."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Num label="Amount" value={form.rules.foodAllowanceAmount} step={1} onChange={(v) => setRule('foodAllowanceAmount', v)} hint="Flat food-allowance amount paid per qualifying OT day." />
                    <Time label="Threshold" value={form.rules.foodAllowanceThreshold} onChange={(v) => setRule('foodAllowanceThreshold', v)} hint="OT ending after this time qualifies for the food allowance." />
                  </div>
                </div>
              </Section>

              <Section title="Hour caps" hint="Maximum overtime hours accepted; requests exceeding a cap are rejected.">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Num label="Per weekday" value={form.rules.maxHoursPerDay} step={1} onChange={(v) => setRule('maxHoursPerDay', v)} hint="Max OT hours on a normal weekday." />
                  <Num label="Per rest day" value={form.rules.maxHoursPerDoubleDay} step={1} onChange={(v) => setRule('maxHoursPerDoubleDay', v)} hint="Max OT hours on a rest day / holiday." />
                  <Num label="Per month" value={form.rules.maxHoursPerMonth} step={1} onChange={(v) => setRule('maxHoursPerMonth', v)} hint="Max OT hours per employee per month." />
                  <Num label="Per year" value={form.rules.maxHoursPerYear} step={1} onChange={(v) => setRule('maxHoursPerYear', v)} hint="Max OT hours per employee per year." />
                </div>
              </Section>

              <p className="px-1 pb-2 text-xs text-slate-400">
                Feature enable, employee submission and manager-approval rules are company-wide —
                manage them in Overtime Settings.
              </p>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
              <button
                onClick={() => setForm(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {form.id ? 'Save changes' : 'Create policy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
