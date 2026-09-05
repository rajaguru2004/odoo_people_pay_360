'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  GraduationCap,
  Loader2,
  BadgeCheck,
  AlertTriangle,
  Sparkles,
  CalendarDays,
} from 'lucide-react';
import { toast } from 'sonner';
import { usePageHeader } from '@/hooks/usePageHeader';
import trainingService from '@/services/trainingService';
import { NominationStatus, TrainingNomination } from '@/types/training';

const STATUS_STYLE: Record<NominationStatus, string> = {
  PENDING: 'bg-status-warning-bg/40 text-status-warning',
  APPROVED: 'bg-status-success-bg/40 text-status-success',
  REJECTED: 'bg-status-error-bg/40 text-status-error',
  CANCELLED: 'bg-surface-page text-text-muted',
  ATTENDED: 'bg-status-info-bg/40 text-status-info',
  NO_SHOW: 'bg-orange-50 text-orange-700',
};

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

function daysUntil(d?: string | null): number | null {
  if (!d) return null;
  const ms = new Date(d).getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(ms / 86_400_000);
}

/** ESS: the employee's own training record and certificate status. */
export default function MyTrainingPage() {
  const [rows, setRows] = useState<TrainingNomination[]>([]);
  const [loading, setLoading] = useState(true);

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Training', 'Courses you are booked on, and your certificates');

  const load = useCallback(async () => {
    try {
      const res = await trainingService.getMyTraining();
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load your training');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const upcoming = rows.filter((r) => ['PENDING', 'APPROVED'].includes(r.status));
  const completed = rows.filter((r) => ['ATTENDED', 'NO_SHOW'].includes(r.status));
  // A certificate inside its final 90 days is worth surfacing before HR chases.
  const expiringSoon = completed.filter((r) => {
    const d = daysUntil(r.certificateExpiry);
    return d !== null && d >= 0 && d <= 90;
  });

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="ess-my-training">
      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-surface-border bg-surface-card p-8 text-text-muted shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {expiringSoon.length > 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-status-warning/30 bg-status-warning-bg/40 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-warning" />
              <div className="text-sm text-status-warning">
                <p className="font-semibold">
                  {expiringSoon.length} certificate
                  {expiringSoon.length === 1 ? '' : 's'} expiring within 90 days
                </p>
                <ul className="mt-1 space-y-0.5 text-status-warning">
                  {expiringSoon.map((r) => (
                    <li key={r.id}>
                      {r.session?.course?.title} — expires{' '}
                      {fmtDate(r.certificateExpiry)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
              <CalendarDays className="h-4 w-4" /> Upcoming ({upcoming.length})
            </h2>
            {upcoming.length === 0 ? (
              <div className="rounded-2xl border border-surface-border bg-surface-card p-8 text-center text-sm text-text-muted shadow-sm">
                Nothing booked.
              </div>
            ) : (
              upcoming.map((r) => (
                <div
                  key={r.id}
                  className="rounded-2xl border border-surface-border bg-surface-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <GraduationCap size={15} className="text-brand-primary" />
                    <p className="text-sm font-semibold text-text-heading">
                      {r.session?.course?.title}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}
                    >
                      {r.status}
                    </span>
                    {r.source === 'APPRAISAL' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">
                        <Sparkles size={10} /> From your appraisal
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {fmtDate(r.session?.startDate)} → {fmtDate(r.session?.endDate)}
                    {r.session?.location ? ` · ${r.session.location}` : ''}
                  </p>
                  {r.justification && (
                    <p className="mt-1 text-xs italic text-text-muted">
                      “{r.justification}”
                    </p>
                  )}
                  {r.rejectedReason && (
                    <p className="mt-1 text-xs italic text-status-error">
                      Rejected: {r.rejectedReason}
                    </p>
                  )}
                </div>
              ))
            )}
          </section>

          {completed.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-text-body">
                <BadgeCheck className="h-4 w-4" /> Completed ({completed.length})
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-surface-border bg-surface-card shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-surface-page text-left text-xs uppercase text-text-muted">
                    <tr>
                      <th className="px-4 py-3">Course</th>
                      <th className="px-4 py-3">Attended</th>
                      <th className="px-4 py-3">Score</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3">Certificate expires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border-light">
                    {completed.map((r) => {
                      const d = daysUntil(r.certificateExpiry);
                      return (
                        <tr key={r.id}>
                          <td className="px-4 py-3 text-text-heading">
                            {r.session?.course?.title}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {fmtDate(r.attendedAt)}
                          </td>
                          <td className="px-4 py-3 text-text-muted">
                            {r.score ?? '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}
                            >
                              {r.status === 'ATTENDED'
                                ? r.passed === false
                                  ? 'Not passed'
                                  : 'Passed'
                                : 'No-show'}
                            </span>
                          </td>
                          <td
                            className={`px-4 py-3 ${d !== null && d <= 90 ? 'font-medium text-status-warning' : 'text-text-muted'}`}
                          >
                            {r.certificateExpiry
                              ? `${fmtDate(r.certificateExpiry)}${d !== null && d >= 0 ? ` (${d}d)` : ''}`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
