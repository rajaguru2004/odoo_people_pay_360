'use client';

import Link from 'next/link';
import { AlertTriangle, XCircle } from 'lucide-react';
import type { PayrollFinding } from '@/services/payrollExtensionsService';

/**
 * One problem, rendered the same way wherever it came from.
 *
 * Every pre-flight check answers the same shape of question — what is wrong,
 * per employee, and which screen fixes it — so they all render through the same
 * component. Two components would drift, and the drift would be visible to the
 * same operator on two screens a minute apart.
 */
export function FindingRow({ finding }: { finding: PayrollFinding }) {
  const blocking = finding.severity === 'BLOCKING';
  return (
    <div
      data-testid={blocking ? 'finding-blocking' : 'finding-warning'}
      data-code={finding.code}
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
        blocking ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'
      }`}
    >
      {blocking ? (
        <XCircle size={15} className="mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        {(finding.employeeCode || finding.employeeName) && (
          <span className="font-medium">
            {finding.employeeName ?? finding.employeeCode}
            {finding.employeeCode && finding.employeeName
              ? ` (${finding.employeeCode})`
              : ''}{' '}
            —{' '}
          </span>
        )}
        {finding.message}
        <span className="ml-1 font-mono text-[11px] opacity-60">{finding.code}</span>
      </div>
      {finding.fix && (
        <Link
          href={finding.fix.href}
          className="shrink-0 whitespace-nowrap rounded-md bg-white/70 px-2 py-1 text-xs font-medium underline"
        >
          {finding.fix.label}
        </Link>
      )}
    </div>
  );
}
