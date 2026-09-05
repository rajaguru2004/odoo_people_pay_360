'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  FileSignature,
  Loader2,
  Plus,
  X,
  Download,
  ShieldCheck,
  Clock,
  UserMinus,
} from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import letterService from '@/services/letterService';
import vaultService from '@/services/vaultService';
import {
  LetterLocale,
  LetterRequest,
  LetterStatus,
  LetterTemplate,
  RequestLetterData,
} from '@/types/letter';

const STATUS_STYLE: Record<LetterStatus, string> = {
  PENDING: 'bg-status-warning-bg/40 text-status-warning',
  ISSUED: 'bg-status-success-bg/40 text-status-success',
  REJECTED: 'bg-status-error-bg/40 text-status-error',
};

const inputCls =
  'w-full h-12 md:h-10 px-3 border border-surface-border rounded-lg text-base md:text-sm bg-surface-card focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

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

/** ESS: request a letter, track it, download it once issued. */
function MyLettersScreen() {
  const [rows, setRows] = useState<LetterRequest[]>([]);
  const [templates, setTemplates] = useState<LetterTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RequestLetterData>({
    templateKey: '',
    locale: 'en',
  });

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Letters', 'Salary certificates, NOCs, experience and embassy letters');

  const load = useCallback(async () => {
    try {
      const [reqs, tmpl] = await Promise.all([
        letterService.getMyRequests(),
        letterService.listTemplates(true),
      ]);
      setRows(Array.isArray(reqs.data) ? reqs.data : []);
      setTemplates(Array.isArray(tmpl.data) ? tmpl.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load your letters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // One entry per letter type; locale is a separate choice.
  const letterTypes = Array.from(
    new Map(templates.map((t) => [t.key, t])).values(),
  );
  const selected = templates.find(
    (t) => t.key === form.templateKey && t.locale === (form.locale ?? 'en'),
  );

  const submit = async () => {
    if (!form.templateKey) {
      toast.warning('Pick a letter type');
      return;
    }
    setSaving(true);
    try {
      const res = await letterService.request(form);
      toast.success(
        res.data?.status === 'ISSUED'
          ? 'Letter issued — it is in your documents'
          : 'Requested. HR will review and issue it.',
      );
      setShowForm(false);
      setForm({ templateKey: '', locale: 'en' });
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to request the letter');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="ess-my-letters">
      <PageActionRow
        action={
          <button
            data-testid="letter-request-open"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex h-12 md:h-10 w-full md:w-auto justify-center items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-text-on-brand touch-manipulation"
          >
            <Plus size={16} /> Request a letter
          </button>
        }
      />

      {showForm && (
        <div className="rounded-2xl border border-surface-border bg-surface-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-heading">Request a letter</h3>
            <button onClick={() => setShowForm(false)} className="text-text-muted">
              <X size={18} />
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <select
              data-testid="letter-request-type"
              className={inputCls}
              value={form.templateKey}
              onChange={(e) => setForm({ ...form, templateKey: e.target.value })}
            >
              <option value="">Letter type…</option>
              {letterTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              data-testid="letter-request-locale"
              className={inputCls}
              value={form.locale ?? 'en'}
              onChange={(e) =>
                setForm({ ...form, locale: e.target.value as LetterLocale })
              }
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
            <input
              data-testid="letter-request-addressed-to"
              className={inputCls}
              placeholder="Addressed to (e.g. Bank Muscat)"
              value={form.addressedTo ?? ''}
              onChange={(e) => setForm({ ...form, addressedTo: e.target.value })}
            />
            <input
              data-testid="letter-request-purpose"
              className={inputCls}
              placeholder="Purpose (appears in the letter)"
              value={form.purpose ?? ''}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            />
          </div>
          {form.templateKey && !selected && (
            <p className="mt-2 text-xs text-status-warning">
              This letter is not available in the selected language yet.
            </p>
          )}
          {selected && (
            <p className="mt-2 text-xs text-text-muted">
              {selected.requiresApproval
                ? 'HR will review and issue this letter.'
                : 'This letter is issued immediately.'}
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <button
              data-testid="letter-request-submit"
              onClick={submit}
              disabled={saving || !selected}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Request
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-surface-border bg-surface-card p-8 text-text-muted shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="my-letters-empty"
          className="rounded-2xl border border-surface-border bg-surface-card p-10 text-center text-text-muted shadow-sm"
        >
          No letters requested yet.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const template = templates.find(
              (t) => t.key === row.templateKey && t.locale === row.locale,
            );
            return (
              <div
                key={row.id}
                data-testid={`my-letter-row-${row.id}`}
                className="rounded-2xl border border-surface-border bg-surface-card p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <FileSignature size={15} className="text-brand-primary" />
                      <p className="text-sm font-semibold text-text-heading">
                        {template?.name ?? row.templateKey}
                      </p>
                      <span
                        data-testid={`my-letter-status-${row.id}`}
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                      >
                        {row.status}
                      </span>
                      {row.locale === 'ar' && (
                        <span className="rounded-full bg-surface-page px-2 py-0.5 text-[11px] text-text-muted">
                          العربية
                        </span>
                      )}
                      {/*
                        R66, the same card as the HR queue and deliberately the
                        same wording. `GET /letters/my-requests` carries the
                        flag too, and the two screens must not disagree: HR sees
                        a request marked as a leaver's, so the person whose
                        request it is has to be able to see the same thing
                        rather than wonder why theirs is treated differently.
                        It explains why the request is still live after an exit
                        — nothing here is blocked by it.
                      */}
                      {row.employee?.isFormerEmployee && (
                        <span
                          data-testid={`my-letter-former-${row.id}`}
                          title={`Your employment record is ${row.employee.status}. The request stands and can still be issued.`}
                          className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
                        >
                          <UserMinus size={11} /> Former employee
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-text-muted">
                      Requested {fmtDate(row.createdAt)}
                      {row.addressedTo ? ` · to ${row.addressedTo}` : ''}
                      {row.serialNumber ? ` · ref ${row.serialNumber}` : ''}
                    </p>
                    {row.status === 'PENDING' && (
                      <p className="mt-1 inline-flex items-center gap-1 text-xs text-status-warning">
                        <Clock size={11} /> Awaiting HR
                      </p>
                    )}
                    {row.rejectedReason && (
                      <p className="mt-1 text-xs italic text-status-error">
                        Rejected: {row.rejectedReason}
                      </p>
                    )}
                  </div>

                  {row.status === 'ISSUED' && row.documentId && (
                    <button
                      data-testid={`my-letter-download-${row.id}`}
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
                      className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg border border-surface-border px-3 text-base md:text-sm font-medium text-text-body hover:bg-surface-page"
                      title="Stored privately — served through an authenticated download"
                    >
                      <ShieldCheck size={13} className="text-status-success" />
                      <Download size={14} /> Download
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * R17 — the guard the three ESS screens were missing.
 *
 * `/dashboard/my-assets`, `/dashboard/my-letters` and `/dashboard/my-documents`
 * were the only dashboard screens that exported their component directly, with
 * no `<ProtectedRoute>` anywhere: the shell rendered for whoever the browser
 * happened to be and the payload was safe only because the server scopes it to
 * the caller. Every other screen decides client-side first.
 *
 * The guard here is deliberately BARE — no `requiredPermission`, no
 * `requiredRoles`. These are self-service screens: every authenticated role may
 * open them and each one sees only their own records, so narrowing by role
 * would take the page away from the people it exists for. What was missing was
 * not authorisation but a settled answer to "is anybody signed in?", which is
 * exactly what `ProtectedRoute` computes: it renders nothing until the auth
 * store has hydrated AND the session has resolved, so a signed-out or
 * mid-restore visitor never sees an ESS shell fire its requests and then blank.
 */
export default function MyLettersPage() {
  return (
    <ProtectedRoute>
      <MyLettersScreen />
    </ProtectedRoute>
  );
}
