'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Play, CheckCircle2, Trash2, Loader2, X, Target, Ban } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useProjectPermissions } from '@/hooks/useProjectPermissions';
import sprintService, { CreateSprintData } from '@/services/sprintService';
import type { Sprint } from '@/types/project';

const STATUS_STYLE: Record<string, string> = {
  PLANNING: 'bg-status-info-bg text-status-info',
  ACTIVE: 'bg-status-success-bg text-status-success',
  COMPLETED: 'bg-surface-border-light text-text-muted',
  CANCELLED: 'bg-status-error-bg text-status-error',
};

/**
 * The state machine this tab is allowed to drive, and the only place it is
 * written down on the client.
 *
 * PLANNING ──start──▶ ACTIVE ──complete──▶ COMPLETED (terminal)
 *    └────────────────┴──────cancel──────▶ CANCELLED (terminal)
 *
 * COMPLETED and CANCELLED offer nothing (R37: `cancel` used to be reachable
 * only through the generic PATCH, where it had no side effects and a CANCELLED
 * sprint could be started again — the server refuses that now, and the screen
 * must not invite it either). `remove` is deliberately absent: deleting a sprint
 * is not a transition and stays available in every state.
 */
const TRANSITIONS: Record<string, ReadonlyArray<'start' | 'complete' | 'cancel'>> = {
  PLANNING: ['start', 'cancel'],
  ACTIVE: ['complete', 'cancel'],
  COMPLETED: [],
  CANCELLED: [],
};

const offers = (status: string, verb: 'start' | 'complete' | 'cancel') =>
  (TRANSITIONS[status] ?? []).includes(verb);

export default function ProjectSprints({ projectId }: { projectId: string }) {
  const t = useTranslations('projectSprints');
  const te = useTranslations('projectEnums');
  // Label map for display only — every status comparison below (s.status === 'PLANNING', etc.)
  // must keep comparing against the raw status codes, never against these translated labels.
  const STATUS_LABEL: Record<string, string> = {
    PLANNING: te('statusPlanning'),
    ACTIVE: te('statusActive'),
    COMPLETED: te('statusCompleted'),
    CANCELLED: te('statusCancelled'),
  };
  const { can } = useProjectPermissions(projectId);
  const canManage = can('SPRINT_MANAGE');
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The sprint whose cancel is awaiting confirmation, if any. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** What the last close did to the backlog. Sticky until dismissed — see below. */
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await sprintService.list(projectId)) as any;
      setSprints(res.data || []);
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  /**
   * R39/R37 — say what moved.
   *
   * Closing a sprint detaches its still-open tasks in the same transaction, so
   * rows the user never named leave the sprint they were looking at. Reported as
   * a sticky line rather than a toast on purpose: the tasks vanish from this
   * very screen as the list reloads, and "3 open tasks returned to the backlog"
   * has to still be readable when the user looks back up and asks where they
   * went. The count comes off the response; the sentence is built here because
   * the server's own `message` is English-only and this tab is translated.
   */
  const announceClose = (verb: 'completed' | 'cancelled', returned: number) => {
    if (returned > 0) {
      setNotice(
        t(
          verb === 'completed' ? 'closedCompletedWithBacklog' : 'closedCancelledWithBacklog',
          { count: returned },
        ),
      );
    } else {
      setNotice(t(verb === 'completed' ? 'closedCompleted' : 'closedCancelled'));
    }
  };

  const start = async (id: string) => {
    setBusyId(id);
    try { await sprintService.start(id); await load(); } finally { setBusyId(null); }
  };

  const complete = async (id: string) => {
    setBusyId(id);
    try {
      const res = await sprintService.complete(id);
      announceClose('completed', res?.tasksReturnedToBacklog ?? 0);
      await load();
    } finally { setBusyId(null); }
  };

  /**
   * Only ever reached through `confirming` — a cancel cannot be undone and it
   * empties the sprint of its open work, which is two irreversible things for
   * one unguarded click. The confirmation is inline rather than a native
   * `confirm()` so it can state both consequences and be driven by testid.
   */
  const cancel = async (id: string) => {
    setBusyId(id);
    try {
      const res = await sprintService.cancel(id);
      setConfirming(null);
      announceClose('cancelled', res?.tasksReturnedToBacklog ?? 0);
      await load();
    } finally { setBusyId(null); }
  };

  const remove = async (id: string) => { if (confirm(t('deleteSprintConfirm'))) { await sprintService.remove(id); load(); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-text-heading">{t('heading')}</h3>
        {canManage && (
          <button onClick={() => setShowModal(true)} data-testid="sprint-create" className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark">
            <Plus className="h-4 w-4" /> {t('newSprintBtn')}
          </button>
        )}
      </div>

      {notice && (
        <div
          data-testid="sprint-close-notice"
          role="status"
          className="flex items-start gap-2 rounded-[--radius-card] border border-surface-border bg-status-info-bg px-3 py-2 text-sm text-status-info"
        >
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            data-testid="sprint-close-notice-dismiss"
            aria-label={t('dismissNotice')}
            title={t('dismissNotice')}
            className="opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loading ? <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-brand-primary" /></div> : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sprints.map((s) => (
            <div key={s.id} data-testid={`sprint-row-${s.id}`} className="rounded-[--radius-card] border border-surface-border bg-surface-card p-4">
              <div className="flex items-start justify-between">
                <h4 className="font-semibold text-text-heading">{s.name}</h4>
                <span data-testid={`sprint-status-${s.id}`} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[s.status]}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              </div>
              {s.goal && <p className="mt-1 flex items-start gap-1 text-sm text-text-muted"><Target className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{s.goal}</p>}
              <p className="mt-2 text-xs text-text-muted">{t('tasksCountSuffix', { count: s._count?.tasks ?? 0 })}</p>
              {canManage && (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
                    {offers(s.status, 'start') && (
                      <button onClick={() => start(s.id)} disabled={busyId === s.id} data-testid={`sprint-start-${s.id}`} className="flex items-center gap-1 rounded-[--radius-button] bg-status-success-bg px-2.5 py-1 text-xs font-medium text-status-success disabled:opacity-50">
                        <Play className="h-3 w-3" /> {t('startBtn')}
                      </button>
                    )}
                    {offers(s.status, 'complete') && (
                      <button onClick={() => complete(s.id)} disabled={busyId === s.id} data-testid={`sprint-complete-${s.id}`} className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary-light/40 px-2.5 py-1 text-xs font-medium text-brand-primary disabled:opacity-50">
                        <CheckCircle2 className="h-3 w-3" /> {t('completeBtn')}
                      </button>
                    )}
                    {offers(s.status, 'cancel') && (
                      <button onClick={() => setConfirming(s.id)} disabled={busyId === s.id} data-testid={`sprint-cancel-${s.id}`} className="flex items-center gap-1 rounded-[--radius-button] bg-status-error-bg px-2.5 py-1 text-xs font-medium text-status-error disabled:opacity-50">
                        <Ban className="h-3 w-3" /> {t('cancelSprintBtn')}
                      </button>
                    )}
                    <button onClick={() => remove(s.id)} data-testid={`sprint-delete-${s.id}`} className="ms-auto text-text-muted hover:text-status-error"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  {confirming === s.id && (
                    <div data-testid={`sprint-cancel-confirm-${s.id}`} className="mt-2 rounded-[--radius-button] border border-status-error-bg bg-status-error-bg/60 p-2.5">
                      <p className="text-xs text-status-error">{t('cancelConfirmPrompt')}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <button onClick={() => cancel(s.id)} disabled={busyId === s.id} data-testid={`sprint-cancel-yes-${s.id}`} className="flex items-center gap-1 rounded-[--radius-button] bg-status-error px-2.5 py-1 text-xs font-medium text-text-on-brand disabled:opacity-50">
                          {busyId === s.id && <Loader2 className="h-3 w-3 animate-spin" />} {t('cancelConfirmYes')}
                        </button>
                        <button onClick={() => setConfirming(null)} data-testid={`sprint-cancel-no-${s.id}`} className="rounded-[--radius-button] border border-surface-border px-2.5 py-1 text-xs text-text-body">
                          {t('cancelConfirmNo')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {sprints.length === 0 && (
            <div data-testid="sprint-empty" className="col-span-full rounded-[--radius-card] border border-dashed border-surface-border bg-surface-card py-12 text-center text-text-muted">{t('emptyNoSprints')}</div>
          )}
        </div>
      )}

      <SprintModal open={showModal} projectId={projectId} onClose={() => setShowModal(false)} onSaved={load} />
    </div>
  );
}

function SprintModal({ open, projectId, onClose, onSaved }: { open: boolean; projectId: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('projectSprints');
  const [form, setForm] = useState<CreateSprintData>({ projectId, name: '', goal: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ projectId, name: '', goal: '' }); }, [open, projectId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await sprintService.create({ ...form, startDate: form.startDate || undefined, endDate: form.endDate || undefined });
      onSaved(); onClose();
    } finally { setSaving(false); }
  };
  const inputCls = 'w-full rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30';

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
          <motion.div initial={{ scale: 0.96 }} animate={{ scale: 1 }} exit={{ scale: 0.96 }} className="w-full max-w-md rounded-[--radius-card] bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
              <h2 className="text-lg font-semibold text-text-heading">{t('newSprintBtn')}</h2>
              <button onClick={onClose} data-testid="sprint-form-close" className="text-text-muted hover:text-text-body"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={submit} data-testid="sprint-form" className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1 block text-xs text-text-muted">{t('nameLabel')}</label>
                <input className={inputCls} data-testid="sprint-form-name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder={t('namePlaceholder')} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-text-muted">{t('goalLabel')}</label>
                <textarea className={inputCls} data-testid="sprint-form-goal" rows={2} value={form.goal} onChange={(e) => setForm((p) => ({ ...p, goal: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs text-text-muted">{t('startLabel')}</label>
                  <input type="date" className={inputCls} data-testid="sprint-form-start-date" value={form.startDate || ''} onChange={(e) => setForm((p) => ({ ...p, startDate: e.target.value }))} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-text-muted">{t('endLabel')}</label>
                  <input type="date" className={inputCls} data-testid="sprint-form-end-date" value={form.endDate || ''} onChange={(e) => setForm((p) => ({ ...p, endDate: e.target.value }))} />
                </div>
              </div>
              <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
                <button type="button" onClick={onClose} data-testid="sprint-form-cancel" className="rounded-[--radius-button] border border-surface-border px-4 py-2 text-sm text-text-body hover:bg-surface-page">{t('cancelBtn')}</button>
                <button type="submit" disabled={saving} data-testid="sprint-form-submit" className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('createBtn')}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
