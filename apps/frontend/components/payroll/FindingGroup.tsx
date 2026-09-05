'use client';

import Link from 'next/link';
import { AlertTriangle, XCircle } from 'lucide-react';
import type {
  PayrollEmployeeStatus,
  PayrollFinding,
} from '@/services/payrollExtensionsService';

/**
 * One employee's problems as a single row.
 *
 * Grouped deliberately, and the reasoning is worth keeping from where this came
 * from: a check that asks for two things produces two findings per employee, so
 * six employees fill the screen with twelve near-identical lines. The employee
 * is the unit an operator acts on, not the individual finding.
 */
export function FindingGroup({
  employee,
  severity,
}: {
  employee: PayrollEmployeeStatus;
  severity: 'BLOCKING' | 'WARNING';
}) {
  const findings = employee.findings.filter((f) => f.severity === severity);
  if (findings.length === 0) return null;

  const blocking = severity === 'BLOCKING';
  // One link per distinct destination — the same "Review attendance" three
  // times is noise, not help.
  const fixes: NonNullable<PayrollFinding['fix']>[] = Array.from(
    new Map(
      findings.filter((f) => f.fix).map((f) => [f.fix!.href, f.fix!] as const),
    ).values(),
  );

  return (
    <div
      data-testid={blocking ? 'preflight-blocked-employee' : 'preflight-warned-employee'}
      data-employee-code={employee.employeeCode}
      className={`rounded-lg px-3 py-2 text-sm ${
        blocking ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
      }`}
    >
      <div className="flex items-start gap-2">
        {blocking ? (
          <XCircle size={15} className="mt-0.5 shrink-0" />
        ) : (
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-medium">
            {employee.fullName} ({employee.employeeCode})
          </span>
          <ul className="mt-1 space-y-0.5">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className="flex gap-1">
                <span className="opacity-50">·</span>
                <span>
                  {f.message}
                  <span className="ml-1 font-mono text-[11px] opacity-60">{f.code}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {fixes.length > 0 && (
          <div className="flex shrink-0 flex-col gap-1">
            {fixes.map((fix) => (
              <Link
                key={fix.href}
                href={fix.href}
                className="whitespace-nowrap rounded-md bg-white/70 px-2 py-1 text-xs font-medium underline"
              >
                {fix.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
