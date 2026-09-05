'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { X, Loader2, MapPin } from 'lucide-react';
import projectTaskService, { CreateProjectTaskData } from '@/services/projectTaskService';
import employeeService from '@/services/employeeService';
import type { ProjectTask, ProjectTaskStatus, Label } from '@/types/project';

interface Props {
  open: boolean;
  projectId: string;
  statuses: ProjectTaskStatus[];
  labels: Label[];
  defaultStatusId?: string;
  task?: ProjectTask | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function NewProjectTaskModal({
  open, projectId, statuses, labels, defaultStatusId, task, onClose, onSaved,
}: Props) {
  const t = useTranslations('taskForm');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');
  const isEdit = !!task;

  const TYPES = [
    { value: 'TASK', label: te('taskTypeTask') },
    { value: 'BUG', label: te('taskTypeBug') },
    { value: 'EPIC', label: te('taskTypeEpic') },
    { value: 'STORY', label: te('taskTypeStory') },
    { value: 'SUBTASK', label: te('taskTypeSubtask') },
  ];

  const PRIORITIES = [
    { value: 'LOW', label: te('priorityLow') },
    { value: 'MEDIUM', label: te('priorityMedium') },
    { value: 'HIGH', label: te('priorityHigh') },
    { value: 'CRITICAL', label: te('priorityCritical') },
  ];

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [employees, setEmployees] = useState<any[]>([]);
  const [geoLoading, setGeoLoading] = useState(false);
  const [form, setForm] = useState<CreateProjectTaskData>({
    title: '', description: '', projectId, type: 'TASK', priority: 'MEDIUM',
    statusId: defaultStatusId, assigneeIds: [], labelIds: [],
  });

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const emp = (await employeeService.getAll({ limit: 200 } as any)) as any;
        setEmployees(emp.data || []);
      } catch { /* noop */ }
    })();
  }, [open]);

  useEffect(() => {
    if (task) {
      setForm({
        title: task.title, description: task.description || '', projectId,
        type: task.type, priority: task.priority, statusId: task.statusId,
        storyPoints: task.storyPoints, dueDate: task.dueDate?.slice(0, 10),
        startDate: task.startDate?.slice(0, 10),
        assigneeIds: task.assignees?.map((a) => a.id) || [],
        labelIds: task.labels?.map((l) => l.label.id) || [],
      });
    } else {
      setForm({
        title: '', description: '', projectId, type: 'TASK', priority: 'MEDIUM',
        statusId: defaultStatusId || statuses[0]?.id, assigneeIds: [], labelIds: [],
      });
    }
  }, [task, open, defaultStatusId, projectId, statuses]);

  const set = (k: keyof CreateProjectTaskData, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const captureLocation = () => {
    if (!navigator.geolocation) return;
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setForm((p) => ({ ...p, latitude, longitude }));
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
            { headers: { 'Accept-Language': 'en' } },
          );
          const data = await res.json();
          if (data.display_name) {
            const name = data.display_name.split(',').slice(0, 3).join(',').trim();
            setForm((p) => ({ ...p, locationName: name }));
          }
        } catch { /* ignore reverse-geocode errors */ }
        setGeoLoading(false);
      },
      () => setGeoLoading(false),
      { timeout: 10000 },
    );
  };
  const toggleArr = (k: 'assigneeIds' | 'labelIds', id: string) =>
    setForm((p) => {
      const arr = new Set(p[k] || []);
      arr.has(id) ? arr.delete(id) : arr.add(id);
      return { ...p, [k]: Array.from(arr) };
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) { setError(t('errorTitleRequired')); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        dueDate: form.dueDate || undefined,
        startDate: form.startDate || undefined,
        storyPoints: form.storyPoints ? Number(form.storyPoints) : undefined,
      };
      if (isEdit && task) await projectTaskService.update(task.id, payload);
      else await projectTaskService.create(payload);
      onSaved(); onClose();
    } catch (err: any) {
      setError(err?.message || t('errorSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30';
  const labelCls = 'block text-xs font-medium text-text-muted mb-1';

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
          <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
            data-testid="task-modal" className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-[--radius-card] bg-surface-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
              <h2 className="text-lg font-semibold text-text-heading">{isEdit ? t('editTaskTitle') : t('newTaskTitle')}</h2>
              <button onClick={onClose} data-testid="task-modal-close" className="text-text-muted hover:text-text-body"><X className="h-5 w-5" /></button>
            </div>

            <form onSubmit={submit} data-testid="task-form" className="space-y-4 px-6 py-5">
              {error && <div data-testid="task-form-error" className="rounded-[--radius-button] bg-status-error-bg px-3 py-2 text-sm text-status-error">{error}</div>}

              <div>
                <label className={labelCls}>{t('titleLabel')} *</label>
                <input className={inputCls} data-testid="task-form-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Build the navbar" />
              </div>
              <div>
                <label className={labelCls}>{tc('description')}</label>
                <textarea className={inputCls} data-testid="task-form-description" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div>
                  <label className={labelCls}>{t('typeLabel')}</label>
                  <select className={inputCls} data-testid="task-form-type" value={form.type} onChange={(e) => set('type', e.target.value)}>
                    {TYPES.map((tt) => <option key={tt.value} value={tt.value}>{tt.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>{t('priorityLabel')}</label>
                  <select className={inputCls} data-testid="task-priority-select" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>{t('statusLabel')}</label>
                  <select className={inputCls} data-testid="task-status-select" value={form.statusId || ''} onChange={(e) => set('statusId', e.target.value)}>
                    {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>{t('storyPointsLabel')}</label>
                  <input type="number" min={0} className={inputCls} data-testid="task-form-story-points" value={form.storyPoints ?? ''} onChange={(e) => set('storyPoints', e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>{t('startDateLabel')}</label>
                  <input type="date" className={inputCls} data-testid="task-form-start-date" value={form.startDate || ''} onChange={(e) => set('startDate', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>{t('dueDateLabel')}</label>
                  <input type="date" className={inputCls} data-testid="task-form-due-date" value={form.dueDate || ''} onChange={(e) => set('dueDate', e.target.value)} />
                </div>
              </div>

              <div>
                <label className={labelCls}>{t('assigneesLabel')}</label>
                <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto rounded-[--radius-button] border border-surface-border p-2">
                  {employees.map((e) => {
                    const sel = form.assigneeIds?.includes(e.id);
                    return (
                      <button type="button" key={e.id} onClick={() => toggleArr('assigneeIds', e.id)} data-testid={`task-form-assignee-option-${e.id}`}
                        className={`rounded-full px-2.5 py-1 text-xs transition ${sel ? 'bg-brand-primary text-text-on-brand' : 'bg-surface-page text-text-body hover:bg-surface-border-light'}`}>
                        {e.fullName}
                      </button>
                    );
                  })}
                </div>
              </div>

              {labels.length > 0 && (
                <div>
                  <label className={labelCls}>{t('labelsLabel')}</label>
                  <div className="flex flex-wrap gap-2">
                    {labels.map((l) => {
                      const sel = form.labelIds?.includes(l.id);
                      return (
                        <button type="button" key={l.id} onClick={() => toggleArr('labelIds', l.id)} data-testid={`task-form-label-${l.id}`}
                          className="rounded-full px-2.5 py-1 text-xs font-medium transition"
                          style={sel
                            ? { backgroundColor: l.color, color: '#fff' }
                            : { backgroundColor: `${l.color}22`, color: l.color }}>
                          {l.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── Location (optional) ── */}
              <div>
                <label className={labelCls}>{t('locationLabel')}</label>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      className={`${inputCls} flex-1`}
                      data-testid="task-form-location-name"
                      value={form.locationName || ''}
                      onChange={(e) => set('locationName', e.target.value)}
                      placeholder={t('locationNamePlaceholder')}
                    />
                    <button
                      type="button"
                      onClick={captureLocation}
                      data-testid="task-form-location-capture"
                      disabled={geoLoading}
                      className="flex shrink-0 items-center gap-1.5 rounded-[--radius-button] border border-surface-border px-3 py-2 text-xs text-text-muted hover:bg-surface-page disabled:opacity-50"
                    >
                      {geoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                      {geoLoading ? t('detectingLocationBtn') : t('useMyLocationBtn')}
                    </button>
                  </div>
                  {form.latitude != null && form.longitude != null && (
                    <div className="flex items-center gap-3">
                      <a
                        href={`https://maps.google.com/?q=${form.latitude},${form.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline"
                      >
                        <MapPin className="h-3 w-3" />
                        {Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}
                      </a>
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, locationName: '', latitude: undefined, longitude: undefined }))}
                        data-testid="task-form-location-clear"
                        className="text-xs text-status-error hover:underline"
                      >
                        {t('clearBtn')}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
                <button type="button" onClick={onClose} data-testid="task-form-cancel" className="rounded-[--radius-button] border border-surface-border px-4 py-2 text-sm text-text-body hover:bg-surface-page">{t('cancelBtn')}</button>
                <button type="submit" disabled={saving} data-testid="task-form-submit" className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-60">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}{isEdit ? t('saveBtn') : t('createTaskBtn')}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
