'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  FileSignature,
  Loader2,
  Check,
  X,
  Download,
  ShieldCheck,
  UserMinus,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import letterService from '@/services/letterService';
import { apiErrorMessage } from '@/utils/apiError';
import vaultService from '@/services/vaultService';
import { LetterRequest, LetterStatus, LetterTemplate } from '@/types/letter';

/**
 * Mirrors `RejectLetterDto`: `reason` is required, trimmed before validation,
 * `@MinLength(5)` and `@MaxLength(500)`. The client used to gate on
 * `!reason.trim()` alone, so a one-character reason passed here and took a 400
 * from the server — a round trip whose explanation the user could not read
 * until R73 was fixed, and which is avoidable at the keystroke either way.
 */
const REJECT_REASON_MIN = 5;
const REJECT_REASON_MAX = 500;

const STATUS_STYLE: Record<LetterStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  ISSUED: 'bg-emerald-50 text-emerald-700',
  REJECTED: 'bg-red-50 text-red-700',
};

/**
 * R66 — the queue names the leaver.
 *
 * A termination is a STATUS change, not a delete, so `LetterRequest`'s cascade
 * never fires and the request survives its subject's exit. It is still PENDING,
 * and PENDING is this screen's default filter, so it is sitting in front of HR
 * right now with nothing to distinguish it from a serving employee's. The
 * product decision was that it may still be issued — an experience letter is
 * most often asked for after leaving — so this marks the row and gates nothing.
 * The Issue and Reject buttons are untouched.
 */
function FormerEmployeeBadge({ row }: { row: LetterRequest }) {
  if (!row.employee?.isFormerEmployee) return null;
  return (
    <span
      data-testid={`letter-row-former-${row.id}`}
      title={`No longer an active employee (status ${row.employee.status}). The request survived their exit and may still be issued.`}
      className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
    >
      <UserMinus size={11} /> Former employee
    </span>
  );
}

function fmtDate(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

function LettersQueueInner() {
  const [rows, setRows] = useState<LetterRequest[]>([]);
  const [templates, setTemplates] = useState<LetterTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<LetterStatus | ''>('PENDING');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Letter Requests', 'Issue salary certificates, NOCs and other letters');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqs, tmpl] = await Promise.all([
        letterService.getAll(status || undefined),
        letterService.listTemplates(false),
      ]);
      setRows(Array.isArray(reqs.data) ? reqs.data : []);
      setTemplates(Array.isArray(tmpl.data) ? tmpl.data : []);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load letter requests'));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const issue = async (row: LetterRequest) => {
    setBusyId(row.id);
    try {
      const res = await letterService.issue(row.id);
      toast.success(`Issued — reference ${res.data?.serialNumber ?? ''}`);
      // R66 — a sibling of `data`, not a field in it. The success toast above
      // and this one are both true and say different things: the letter was
      // minted, AND it was minted for someone who has left. Held longer than
      // the default because it is the half a person needs time to read.
      if (res.warning) toast.warning(res.warning, { duration: 12_000 });
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to issue the letter'));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (row: LetterRequest) => {
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.warning('Please enter a reason');
      return;
    }
    if (trimmed.length < REJECT_REASON_MIN) {
      toast.warning(
        `Please give a reason of at least ${REJECT_REASON_MIN} characters — the employee reads it verbatim`,
      );
      return;
    }
    if (trimmed.length > REJECT_REASON_MAX) {
      toast.warning(`A rejection reason must be ${REJECT_REASON_MAX} characters or fewer`);
      return;
    }
    setBusyId(row.id);
    try {
      const res = await letterService.reject(row.id, trimmed);
      toast.success('Rejected');
      if (res.warning) toast.warning(res.warning, { duration: 12_000 });
      setRejecting(null);
      setReason('');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to reject'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <select
          data-testid="letter-status-filter"
          className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
          value={status}
          onChange={(e) => setStatus(e.target.value as LetterStatus | '')}
        >
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="ISSUED">Issued</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="letter-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          Nothing here.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const template = templates.find(
              (t) => t.key === row.templateKey && t.locale === row.locale,
            );
            const busy = busyId === row.id;
            return (
              <div
                key={row.id}
                data-testid={`letter-row-${row.id}`}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <FileSignature size={15} className="text-brand-primary" />
                      <p className="text-sm font-semibold text-slate-800">
                        {template?.name ?? row.templateKey}
                      </p>
                      <span
                        data-testid={`letter-row-status-${row.id}`}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                      >
                        {row.status}
                      </span>
                      {row.locale === 'ar' && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                          العربية
                        </span>
                      )}
                      <FormerEmployeeBadge row={row} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {row.employee?.fullName} ({row.employee?.employeeCode})
                      {row.employee?.department?.name
                        ? ` · ${row.employee.department.name}`
                        : ''}{' '}
                      · requested {fmtDate(row.createdAt)}
                    </p>
                    {(row.addressedTo || row.purpose) && (
                      <p className="mt-1 text-sm text-slate-700">
                        {row.addressedTo ? `To: ${row.addressedTo}` : ''}
                        {row.addressedTo && row.purpose ? ' · ' : ''}
                        {row.purpose ? `Purpose: ${row.purpose}` : ''}
                      </p>
                    )}
                    {row.serialNumber && (
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {row.serialNumber}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {row.status === 'PENDING' && (
                      <>
                        <button
                          data-testid={`letter-issue-${row.id}`}
                          onClick={() => issue(row)}
                          disabled={busy}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50"
                        >
                          {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check size={14} />
                          )}
                          Issue
                        </button>
                        <button
                          data-testid={`letter-reject-${row.id}`}
                          onClick={() =>
                            setRejecting(rejecting === row.id ? null : row.id)
                          }
                          disabled={busy}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-600 disabled:opacity-50"
                        >
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                    {row.status === 'ISSUED' && row.documentId && (
                      <button
                        data-testid={`letter-download-${row.id}`}
                        onClick={async () => {
                          try {
                            await vaultService.download(
                              'employee-document',
                              row.documentId!,
                              `${row.serialNumber ?? row.templateKey}.pdf`,
                            );
                          } catch {
                            toast.error('Could not download that letter.');
                          }
                        }}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <ShieldCheck size={13} className="text-emerald-600" />
                        <Download size={14} /> Download
                      </button>
                    )}
                  </div>
                </div>

                {rejecting === row.id && (
                  <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
                    <input
                      data-testid={`letter-reject-reason-${row.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={`Reason for rejection… (at least ${REJECT_REASON_MIN} characters)`}
                      minLength={REJECT_REASON_MIN}
                      maxLength={REJECT_REASON_MAX}
                      className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-sm focus:border-brand-primary focus:outline-none"
                    />
                    <button
                      data-testid={`letter-reject-submit-${row.id}`}
                      onClick={() => reject(row)}
                      disabled={busy}
                      className="inline-flex h-9 shrink-0 items-center rounded-lg bg-red-600 px-3 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Confirm reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LettersQueuePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <LettersQueueInner />
    </ProtectedRoute>
  );
}
