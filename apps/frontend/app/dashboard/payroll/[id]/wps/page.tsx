'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import { apiErrorBody, apiErrorMessage } from '@/utils/apiError';
import wpsService, {
  WpsEmployeeStatus,
  WpsFile,
  WpsFileDetail,
  WpsFinding,
  WpsPreflight,
} from '@/services/wpsService';

const STATUS_STYLES: Record<string, string> = {
  GENERATING: 'bg-slate-100 text-slate-600',
  GENERATED: 'bg-blue-50 text-blue-700',
  FAILED: 'bg-red-50 text-red-700',
  SUBMITTED: 'bg-amber-50 text-amber-700',
  ACKNOWLEDGED: 'bg-green-50 text-green-700',
  PARTIALLY_REJECTED: 'bg-orange-50 text-orange-700',
  REJECTED: 'bg-red-50 text-red-700',
  SUPERSEDED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

function FindingRow({ finding }: { finding: WpsFinding }) {
  const blocking = finding.severity === 'BLOCKING';
  return (
    <div
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
            {finding.employeeCode && finding.employeeName ? ` (${finding.employeeCode})` : ''} —{' '}
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

/**
 * One employee's problems as a single row.
 *
 * Grouped deliberately: a format that asks for two identifiers produced two
 * findings per employee, so six employees filled the screen with twelve
 * near-identical lines. The employee is the unit an operator acts on, not the
 * individual finding.
 */
function EmployeeFindingGroup({
  employee,
  severity,
}: {
  employee: WpsEmployeeStatus;
  severity: 'BLOCKING' | 'WARNING';
}) {
  const findings = employee.findings.filter((f) => f.severity === severity);
  if (findings.length === 0) return null;

  const blocking = severity === 'BLOCKING';
  // One link per distinct destination — the same "Add document" three times is noise.
  const fixes: NonNullable<WpsFinding['fix']>[] = Array.from(
    new Map(
      findings
        .filter((f) => f.fix)
        .map((f) => [f.fix!.href, f.fix!] as const),
    ).values(),
  );

  return (
    <div
      data-testid={blocking ? 'wps-blocked-employee' : 'wps-warned-employee'}
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
            {employee.fullName}{' '}
            <span className="font-normal opacity-70">({employee.employeeCode})</span>
          </span>
          <ul className="mt-0.5 space-y-0.5">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className="flex gap-1.5">
                <span aria-hidden className="opacity-50">
                  •
                </span>
                <span>
                  {f.message}
                  <span className="ml-1 font-mono text-[11px] opacity-60">{f.code}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
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
      </div>
    </div>
  );
}

function WpsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: payrollId } = use(params);
  const router = useRouter();

  const [preflight, setPreflight] = useState<WpsPreflight | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [files, setFiles] = useState<WpsFile[]>([]);
  const [detail, setDetail] = useState<WpsFileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());

  // The one heading for this route, rendered by TopHeader. TopHeader's static
  // fallback derives "Wps" from the path segment, which is wrong for this page.
  usePageHeader(
    'Salary Payment File (WPS)',
    preflight
      ? `${preflight.formatName} · ${preflight.branchCode} · ${String(preflight.period.month).padStart(2, '0')}/${preflight.period.year}`
      : 'Wage Protection System',
  );

  const load = useCallback(async () => {
    setLoading(true);
    setSetupError(null);
    try {
      const filesRes = await wpsService.files({ payrollId });
      const list = filesRes.data ?? [];
      setFiles(list);

      // The newest non-superseded file is the one being worked on.
      const active = list.find((f) => f.status !== 'SUPERSEDED') ?? list[0];
      if (active) {
        const d = await wpsService.file(active.id);
        setDetail(d.data);
      } else {
        setDetail(null);
      }

      try {
        const pf = await wpsService.preflight(payrollId);
        setPreflight(pf.data);
        setAcked(new Set());
      } catch (e: any) {
        // A 400 here is a setup problem (no config, wrong branch), not a data
        // problem — those come back as findings inside a successful response.
        setPreflight(null);
        setSetupError(apiErrorMessage(e, 'Pre-flight could not run.'));
      }
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load WPS state'));
    } finally {
      setLoading(false);
    }
  }, [payrollId]);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    if (!preflight) return;
    const missing = preflight.requiresAcknowledgement.filter((c) => !acked.has(c));
    if (missing.length > 0) {
      toast.warning(`Acknowledge the warnings first: ${missing.join(', ')}`);
      return;
    }
    setBusy('generate');
    try {
      const res = await wpsService.generate({
        payrollId,
        acknowledgeWarnings: [...acked],
      });
      toast.success(`Generated ${res.data.fileName}`);
      await load();
    } catch (e: any) {
      // Always show the server's own reason — "A wage file for this payroll already
      // exists (version 1, GENERATED)" tells the operator what to do; "Generation
      // failed" does not. Longer duration because these messages are worth reading.
      toast.error(apiErrorMessage(e, 'Generation failed'), { duration: 10_000 });

      // The generate route attaches the full pre-flight report to its error, so the
      // report on screen refreshes to match the refusal without a second request.
      const body = apiErrorBody<{ preflight?: WpsPreflight }>(e);
      if (body?.preflight) {
        setPreflight(body.preflight);
        setAcked(new Set());
      } else {
        // No embedded report (e.g. a 409 about existing versions) — reload so the
        // screen shows the file that is actually blocking.
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const download = async (file: WpsFile) => {
    setBusy(`dl-${file.id}`);
    try {
      await wpsService.download(file);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Download failed'));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (file: WpsFile) => {
    setBusy(`vf-${file.id}`);
    try {
      const res = await wpsService.verify(file.id);
      if (res.data.matches) {
        toast.success('Fingerprint matches — the stored file is unaltered.');
      } else {
        toast.error('Fingerprint MISMATCH — the stored file does not match what we generated.');
      }
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Verification failed'));
    } finally {
      setBusy(null);
    }
  };

  const markSubmitted = async (file: WpsFile) => {
    const reference = window.prompt(
      "Bank's reference for this upload (optional):",
      '',
    );
    if (reference === null) return;
    setBusy(`sub-${file.id}`);
    try {
      await wpsService.submit(file.id, { reference: reference || undefined });
      toast.success('Marked as submitted to the bank');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not mark submitted'));
    } finally {
      setBusy(null);
    }
  };

  const recordResponse = async (
    file: WpsFile,
    outcome: 'ACKNOWLEDGED' | 'REJECTED',
  ) => {
    setBusy(`resp-${file.id}`);
    try {
      await wpsService.recordBankResponse(file.id, { outcome });
      toast.success(`Recorded: ${outcome}`);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Could not record the response'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  const blocked = preflight?.byEmployee.filter((e) => e.status === 'BLOCKED') ?? [];
  const warned = preflight?.byEmployee.filter((e) => e.status === 'WARNING') ?? [];
  const runBlockers =
    preflight?.runFindings.filter((f) => f.severity === 'BLOCKING').length ?? 0;
  const pct = preflight && preflight.total > 0
    ? Math.round((preflight.ready / preflight.total) * 100)
    : 0;

  return (
    <div className="space-y-6 p-6">
      <PageActionRow
        action={
          <>
            <button
              data-testid="wps-recheck"
              onClick={load}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw size={14} /> Re-check
            </button>
            <button
              onClick={() => router.push(`/dashboard/payroll/${payrollId}`)}
              className="inline-flex h-9 items-center rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to payroll
            </button>
          </>
        }
      />

      {/* The HRMS does not move money — say so plainly. */}
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        <p>
          This produces the salary instruction file your bank requires. It does not
          transfer money — after downloading, upload it to your bank portal. The bank
          validates it and pays the employees.
        </p>
      </div>

      {setupError && (
        <div data-testid="wps-setup-error" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Not ready to run</p>
              <p className="mt-0.5">{setupError}</p>
              <Link
                href="/dashboard/settings?tab=wps"
                className="mt-2 inline-block rounded-md bg-white px-2.5 py-1 text-xs font-medium underline"
              >
                Open WPS settings
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ── Pre-flight ─────────────────────────────────────────────────── */}
      {preflight && (
        <div
          data-testid="wps-preflight"
          data-can-generate={String(preflight.canGenerate)}
          data-ready={String(preflight.ready)}
          data-total={String(preflight.total)}
          data-blocked={String(preflight.blockedEmployees)}
          data-run-blockers={String(runBlockers)}
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Pre-flight check</h2>
              <p className="text-sm text-slate-500">
                {preflight.ready} of {preflight.total} employees ready
                {preflight.blockedEmployees > 0 && ` · ${preflight.blockedEmployees} blocked`}
                {preflight.warningEmployees > 0 && ` · ${preflight.warningEmployees} with warnings`}
              </p>
              {/* Employee readiness alone is misleading: a run-level problem blocks
                  the file even when every employee is individually fine. */}
              {runBlockers > 0 && (
                <p className="mt-0.5 text-sm font-medium text-red-700">
                  Blocked by {runBlockers} problem{runBlockers === 1 ? '' : 's'} with the
                  payroll or employer setup, below.
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-slate-400">File total</p>
              <p className="text-xl font-bold text-slate-900">
                {preflight.totalPreview.formatted} {preflight.totalPreview.currency}
              </p>
            </div>
          </div>

          <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full transition-all ${
                preflight.canGenerate
                  ? 'bg-green-500'
                  : runBlockers > 0 || preflight.blockedEmployees > 0
                    ? 'bg-red-500'
                    : 'bg-amber-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {preflight.runFindings.length > 0 && (
            <div className="mb-3 space-y-1.5">
              {preflight.runFindings.map((f, i) => (
                <FindingRow key={`${f.code}-${i}`} finding={f} />
              ))}
            </div>
          )}

          {blocked.length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-semibold text-red-700">
                Blocks the file — no file is produced until every one is fixed
                <span className="ml-1 font-normal text-slate-500">
                  ({blocked.length} employee{blocked.length === 1 ? '' : 's'})
                </span>
              </p>
              <div className="space-y-1.5">
                {blocked.map((e) => (
                  <EmployeeFindingGroup key={e.employeeId} employee={e} severity="BLOCKING" />
                ))}
              </div>
            </div>
          )}

          {warned.length > 0 && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-semibold text-amber-700">
                Warns but allows
                <span className="ml-1 font-normal text-slate-500">
                  ({warned.length} employee{warned.length === 1 ? '' : 's'})
                </span>
              </p>
              <div className="space-y-1.5">
                {warned.map((e) => (
                  <EmployeeFindingGroup key={e.employeeId} employee={e} severity="WARNING" />
                ))}
              </div>
            </div>
          )}

          {preflight.requiresAcknowledgement.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <p className="mb-2 text-sm font-medium text-amber-900">
                Confirm you have read these before generating:
              </p>
              {preflight.requiresAcknowledgement.map((code) => (
                <label key={code} className="flex items-center gap-2 py-0.5 text-sm text-amber-900">
                  <input
                    data-testid="wps-acknowledge"
                    data-code={code}
                    type="checkbox"
                    checked={acked.has(code)}
                    onChange={(e) =>
                      setAcked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(code);
                        else next.delete(code);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-xs">{code}</span>
                </label>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {!preflight.canGenerate && (
              <p className="mr-auto text-sm text-slate-500">
                Fix the blocking problems above, then Re-check.
              </p>
            )}
            <button
              data-testid="wps-generate"
              onClick={generate}
              disabled={!preflight.canGenerate || busy === 'generate'}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand-primary px-4 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'generate' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText size={15} />
              )}
              Generate wage file
            </button>
          </div>
        </div>
      )}

      {/* ── The generated file ─────────────────────────────────────────── */}
      {detail && (
        <div
          data-testid="wps-file"
          data-file-status={detail.status}
          data-file-version={String(detail.version)}
          data-file-name={detail.fileName ?? ''}
          data-employee-count={String(detail.employeeCount)}
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-slate-900">
                  {detail.fileName ?? 'Wage file'}
                </h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    STATUS_STYLES[detail.status] ?? 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {detail.status}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                  v{detail.version}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {detail.employeeCount} employees · {detail.total.formatted} {detail.currency}
                {detail.byteSize ? ` · ${detail.byteSize} bytes` : ''} ·{' '}
                {detail.formatName}
              </p>
              <p className="mt-1 font-mono text-[11px] text-slate-400">
                spec {detail.specVersion}
                {detail.sha256 ? ` · sha256 ${detail.sha256.slice(0, 24)}…` : ''}
              </p>
              {detail.generationError && (
                <p className="mt-2 rounded bg-red-50 px-2 py-1 text-sm text-red-700">
                  {detail.generationError}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {detail.downloadable && (
                <button
                  data-testid="wps-download"
                  onClick={() => download(detail)}
                  disabled={busy === `dl-${detail.id}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy === `dl-${detail.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  Download
                </button>
              )}
              {detail.sha256 && (
                <button
                  data-testid="wps-verify"
                  onClick={() => verify(detail)}
                  disabled={busy === `vf-${detail.id}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <ShieldCheck size={14} /> Verify
                </button>
              )}
              {detail.status === 'GENERATED' && (
                <button
                  onClick={() => markSubmitted(detail)}
                  disabled={busy === `sub-${detail.id}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Upload size={14} /> Mark submitted
                </button>
              )}
              {detail.status === 'SUBMITTED' && (
                <>
                  <button
                    onClick={() => recordResponse(detail, 'ACKNOWLEDGED')}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-green-200 bg-green-50 px-3 text-sm font-medium text-green-700 hover:bg-green-100"
                  >
                    <CheckCircle2 size={14} /> Bank accepted
                  </button>
                  <button
                    onClick={() => recordResponse(detail, 'REJECTED')}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100"
                  >
                    <XCircle size={14} /> Bank rejected
                  </button>
                </>
              )}
            </div>
          </div>

          {detail.submittedAt && (
            <p className="mb-3 text-sm text-slate-600">
              Submitted {new Date(detail.submittedAt).toLocaleString()}
              {detail.submissionReference ? ` · ref ${detail.submissionReference}` : ''}
              {detail.bankResponseAt &&
                ` · bank responded ${new Date(detail.bankResponseAt).toLocaleString()}`}
            </p>
          )}

          {/* Rows — accounts and identifiers are masked server-side. */}
          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Bank</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2 text-right">Basic</th>
                  <th className="px-3 py-2 text-right">Allowances</th>
                  <th className="px-3 py-2 text-right">Deductions</th>
                  <th className="px-3 py-2 text-right">Net</th>
                  <th className="px-3 py-2">Row</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((r) => (
                  <tr key={r.id} data-testid="wps-file-row" className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-400">{r.sequence}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-slate-800">{r.employeeName}</span>
                      <span className="ml-1 text-xs text-slate-400">{r.employeeCode}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">
                      {r.bankCode ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">
                      {r.account ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{r.basic.formatted}</td>
                    <td className="px-3 py-2 text-right">{r.allowances.formatted}</td>
                    <td className="px-3 py-2 text-right">{r.deductions.formatted}</td>
                    <td className="px-3 py-2 text-right font-semibold">{r.net.formatted}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          r.status === 'REJECTED'
                            ? 'bg-red-50 text-red-700'
                            : r.status === 'ACCEPTED'
                              ? 'bg-green-50 text-green-700'
                              : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {r.status}
                      </span>
                      {r.rejectionReason && (
                        <span className="ml-1 text-xs text-red-600">{r.rejectionReason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 font-semibold">
                <tr>
                  <td colSpan={7} className="px-3 py-2 text-right text-slate-500">
                    File total
                  </td>
                  <td className="px-3 py-2 text-right">{detail.total.formatted}</td>
                  <td className="px-3 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── Version history ───────────────────────────────────────────── */}
      {files.length > 1 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Version history</h2>
          <div className="space-y-2">
            {files.map((f) => (
              <div
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-700">v{f.version}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      STATUS_STYLES[f.status] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {f.status}
                  </span>
                  <span className="text-slate-500">{f.fileName ?? '—'}</span>
                  <span className="text-slate-400">
                    {f.employeeCount} employees · {f.total.formatted} {f.currency}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">
                    {new Date(f.generatedAt).toLocaleString()} · {f.downloadCount} download(s)
                  </span>
                  {f.downloadable && (
                    <button
                      onClick={() => download(f)}
                      className="inline-flex h-7 items-center gap-1 rounded border border-slate-200 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Download size={12} /> Download
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!detail && !preflight && !setupError && (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm">
          <Check className="mx-auto mb-2 h-6 w-6" />
          Nothing to show for this payroll.
        </div>
      )}
    </div>
  );
}

export default function WpsPageGuarded({ params }: { params: Promise<{ id: string }> }) {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <WpsPage params={params} />
    </ProtectedRoute>
  );
}
