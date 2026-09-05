'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { PreflightFinding, PreflightSeverity } from '@/types/payroll';

/**
 * What a run WOULD refuse, before anybody creates one.
 *
 * A BLOCKER stops generation and a WARNING is a fact the approver carries into
 * the run. That distinction is the SERVER's — `canGenerate` comes back on the
 * same response — and nothing here re-derives it: a screen that decided for
 * itself which findings were fatal would eventually disagree with the endpoint
 * that actually refuses.
 */

const SEVERITY_STYLE: Record<PreflightSeverity, string> = {
  BLOCKER: 'bg-status-error-bg text-status-error',
  WARNING: 'bg-status-warning-bg text-status-warning',
};

function SeverityIcon({ severity }: { severity: PreflightSeverity }) {
  return severity === 'BLOCKER' ? (
    <XCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
  ) : (
    <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
  );
}

/**
 * One finding, rendered the same way wherever it came from.
 *
 * Used for anything the run objects to that is NOT about one person — an empty
 * population, a period nobody worked. A per-employee objection goes through
 * `FindingGroup` instead.
 */
export function FindingRow({ finding }: { finding: PreflightFinding }) {
  return (
    <div
      data-testid={finding.severity === 'BLOCKER' ? 'finding-blocking' : 'finding-warning'}
      data-code={finding.code}
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${SEVERITY_STYLE[finding.severity]}`}
    >
      <SeverityIcon severity={finding.severity} />
      <div className="min-w-0 flex-1">
        {finding.employeeName && <span className="font-medium">{finding.employeeName} — </span>}
        {finding.message}
        <span className="ms-1 font-mono text-[11px] opacity-60">{finding.code}</span>
      </div>
    </div>
  );
}

/**
 * One employee's objections as a single row.
 *
 * Grouped deliberately: a check that asks for two things produces two findings
 * per employee, so six employees fill the screen with twelve near-identical
 * lines. The employee is the unit somebody acts on, not the individual finding
 * — and their record is the one link that resolves every one of them.
 */
export function FindingGroup({
  employeeId,
  employeeName,
  findings,
  severity,
}: {
  employeeId?: string;
  employeeName: string;
  findings: PreflightFinding[];
  severity: PreflightSeverity;
}) {
  if (findings.length === 0) return null;

  return (
    <div
      data-testid={severity === 'BLOCKER' ? 'preflight-blocked-employee' : 'preflight-warned-employee'}
      data-employee-id={employeeId}
      className={`rounded-lg px-3 py-2 text-sm ${SEVERITY_STYLE[severity]}`}
    >
      <div className="flex items-start gap-2">
        <SeverityIcon severity={severity} />
        <div className="min-w-0 flex-1">
          <span className="font-medium">{employeeName}</span>
          <ul className="mt-1 space-y-0.5">
            {findings.map((finding, index) => (
              <li key={`${finding.code}-${index}`} className="flex gap-1">
                <span className="opacity-50">·</span>
                <span>
                  {finding.message}
                  <span className="ms-1 font-mono text-[11px] opacity-60">{finding.code}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        {employeeId && (
          <Link
            href={`/dashboard/employees/${employeeId}`}
            className="shrink-0 whitespace-nowrap rounded-md bg-white/70 px-2 py-1 text-xs font-medium underline"
          >
            Open record
          </Link>
        )}
      </div>
    </div>
  );
}

/** Findings of one severity, collapsed to one row per person. */
function SeveritySection({
  severity,
  findings,
  title,
  hint,
}: {
  severity: PreflightSeverity;
  findings: PreflightFinding[];
  title: string;
  hint: string;
}) {
  const mine = findings.filter((finding) => finding.severity === severity);
  if (mine.length === 0) return null;

  // Order is preserved: the map keeps insertion order, so the list reads in the
  // order the server produced it rather than in an order the browser invented.
  const byEmployee = new Map<string, { name: string; id?: string; items: PreflightFinding[] }>();
  const general: PreflightFinding[] = [];

  for (const finding of mine) {
    const key = finding.employeeId ?? finding.employeeName;
    if (!key) {
      general.push(finding);
      continue;
    }
    const existing = byEmployee.get(key);
    if (existing) existing.items.push(finding);
    else {
      byEmployee.set(key, {
        name: finding.employeeName ?? key,
        id: finding.employeeId,
        items: [finding],
      });
    }
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-text-heading">{title}</h3>
        <span className="text-xs text-text-muted">{hint}</span>
      </div>
      <div className="space-y-2">
        {general.map((finding, index) => (
          <FindingRow key={`${finding.code}-${index}`} finding={finding} />
        ))}
        {[...byEmployee.entries()].map(([key, group]) => (
          <FindingGroup
            key={key}
            employeeId={group.id}
            employeeName={group.name}
            findings={group.items}
            severity={severity}
          />
        ))}
      </div>
    </section>
  );
}

export default function PreflightFindings({
  findings,
  /** The server's verdict. Never recomputed from the list above. */
  canGenerate,
}: {
  findings: PreflightFinding[];
  canGenerate?: boolean;
}) {
  const blockers = findings.filter((finding) => finding.severity === 'BLOCKER').length;
  const warnings = findings.length - blockers;

  if (findings.length === 0) {
    return (
      <div
        data-testid="preflight-clear"
        className="flex items-start gap-2 rounded-lg bg-status-success-bg px-3 py-2 text-sm text-status-success"
      >
        <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Nothing objected to this period.
          {canGenerate === false && ' The run still cannot be generated — the server said so.'}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="preflight-findings">
      <SeveritySection
        severity="BLOCKER"
        findings={findings}
        title={`Blocking (${blockers})`}
        hint="Generation is refused until every one of these is resolved."
      />
      <SeveritySection
        severity="WARNING"
        findings={findings}
        title={`Warnings (${warnings})`}
        hint="The run will generate. These travel with it to whoever approves."
      />
    </div>
  );
}
