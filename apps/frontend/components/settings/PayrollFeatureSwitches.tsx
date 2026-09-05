'use client';

import React from 'react';

/**
 * The payroll extension switches, declared as data.
 *
 * Every other setting on this screen is hand-wired in five separate places — the
 * typed state object, the parser, the JSX, `handleSave`'s payload, and the
 * branding mirror — which is how a toggle ends up writing `true` and rendering
 * OFF. These are declared once and rendered by a loop, so adding the next one is
 * a line in this array rather than five edits spread over a 4,600-line file.
 */
export interface FeatureSwitch {
  key: string;
  label: string;
  /** What the feature does when it is ON. */
  help: string;
  /** What OFF means — the sentence an admin actually needs before flipping it. */
  off: string;
  /** Switches that are meaningless until this one is on. */
  children?: FeatureSwitch[];
}

export const PAYROLL_FEATURE_SWITCHES: FeatureSwitch[] = [
  {
    key: 'payroll_item_lines_enabled',
    label: 'Itemised payslips',
    help:
      'Show what each figure is made of — housing and transport separately rather ' +
      'than one Allowances total, PF apart from ESI, income tax apart from ' +
      'professional tax, and loss of pay as a line of its own.',
    off: 'Payslips show one Allowances total and one Deduction total, as today.',
    children: [
      {
        key: 'payroll_item_lines_strict_reconciliation',
        label: 'Refuse a payroll whose lines do not add up',
        help:
          'The breakdown must sum to the stored totals. On by default: a payslip ' +
          'that shows its working and gets it wrong is harder to argue with than ' +
          'one that shows nothing.',
        off: 'The mismatch is recorded in the audit trail and the run continues.',
      },
    ],
  },
  {
    key: 'leave_carry_forward_enabled',
    label: 'Year-end leave carry-forward',
    help: 'Carries unused balance into the next year, capped per leave type.',
    off: 'No leave balance is ever moved automatically.',
  },
];


function Row({
  spec,
  value,
  onChange,
  nested,
}: {
  spec: FeatureSwitch;
  value: boolean;
  onChange: (key: string, next: boolean) => void;
  nested?: boolean;
}) {
  return (
    <div
      className={
        nested
          ? 'flex items-start justify-between gap-4 py-3 pl-4 border-l-2 border-slate-200'
          : 'flex items-start justify-between gap-4 py-3 border-b border-slate-100'
      }
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{spec.label}</p>
        <p className="text-xs text-slate-500 mt-0.5">{spec.help}</p>
        <p className="text-xs text-slate-400 mt-0.5">
          <span className="font-medium">Off:</span> {spec.off}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={spec.label}
        data-testid={`feature-toggle-${spec.key}`}
        onClick={() => onChange(spec.key, !value)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          value ? 'bg-brand-primary' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

/**
 * Renders the switches and reports changes as a flat `{key: 'true'|'false'}`
 * patch, which is exactly what `POST /system-settings` accepts — it upserts the
 * keys it is given and leaves the rest alone, so this never has to know about
 * the rest of the payroll form.
 */
export function PayrollFeatureSwitches({
  values,
  onChange,
}: {
  values: Record<string, boolean>;
  onChange: (key: string, next: boolean) => void;
}) {
  return (
    <div className="surface-panel p-4 sm:p-5">
      <h3 className="text-sm sm:text-base font-semibold text-slate-800">
        Payroll extensions
      </h3>
      <p className="text-xs text-slate-500 mt-0.5 mb-3">
        Additive features that sit on top of the payroll you already run. Every
        one is off until you turn it on, and turning one off returns payroll to
        exactly its current behaviour.
      </p>
      <div className="divide-y divide-slate-100">
        {PAYROLL_FEATURE_SWITCHES.map((spec) => (
          <div key={spec.key}>
            <Row spec={spec} value={!!values[spec.key]} onChange={onChange} />
            {values[spec.key] &&
              spec.children?.map((child) => (
                <Row
                  key={child.key}
                  spec={child}
                  value={!!values[child.key]}
                  onChange={onChange}
                  nested
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
