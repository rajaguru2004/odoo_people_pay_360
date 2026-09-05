'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { X, Loader2, Trash2, Share2, Maximize2, Check, Plus, ChevronDown, MapPin } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useProjectPermissions } from '@/hooks/useProjectPermissions';
import { triggerPermissionError } from '@/lib/permissionError';
import projectTaskService from '@/services/projectTaskService';
import projectService from '@/services/projectService';
import sprintService from '@/services/sprintService';
import MarkdownField from '@/components/projects/task-detail/MarkdownField';
import Subtasks from '@/components/projects/task-detail/Subtasks';
import TaskDependencies from '@/components/projects/task-detail/TaskDependencies';
import TaskComments from '@/components/projects/task-detail/TaskComments';
import TaskAttachments from '@/components/projects/task-detail/TaskAttachments';
import TaskActivity from '@/components/projects/task-detail/TaskActivity';
import StageTimer from '@/components/projects/task-detail/StageTimer';
import type { ProjectTaskStatus, Label, Sprint } from '@/types/project';

// ─── Palettes ──────────────────────────────────────────────────────────────────

const TASK_TYPES = ['TASK', 'BUG', 'EPIC', 'STORY', 'SUBTASK'];
const PRIORITIES  = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const TYPE_HEX: Record<string, string> = {
  TASK: '#3b82f6', BUG: '#ef4444', EPIC: '#f59e0b', STORY: '#22c55e', SUBTASK: '#8b5cf6',
};
const PRIORITY_HEX: Record<string, string> = {
  LOW: '#22c55e', MEDIUM: '#f59e0b', HIGH: '#ef4444', URGENT: '#7c3aed',
};
const LABEL_PALETTE = [
  '#3b82f6','#8b5cf6','#22c55e','#f59e0b','#ef4444','#64748b',
  '#a855f7','#ec4899','#14b8a6','#f97316','#06b6d4','#84cc16',
];

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' }) : '—';

// ─── Color badge ──────────────────────────────────────────────────────────────

function ColorBadge({ label, hex }: { label: string; hex: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold text-white"
      style={{ backgroundColor: hex }}>
      {label}
    </span>
  );
}

// ─── Property block (matches Work Hive rail pattern) ─────────────────────────
// Label + Edit on one row, value display on row below

function PropBlock({
  label, onEdit, editLabel = 'Edit', locked, children, anchorId,
}: {
  label: string; onEdit?: () => void; editLabel?: string; locked?: boolean; children: React.ReactNode; anchorId?: string;
}) {
  const t = useTranslations('taskDetailShared');
  const handleEdit = locked
    ? () => triggerPermissionError(t('permissionEditError'))
    : onEdit;

  const fieldTestId = anchorId ? anchorId.replace('rail-field-', '') : undefined;

  return (
    <div id={anchorId} data-testid={fieldTestId ? `task-detail-${fieldTestId}` : undefined}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-text-body">{label}</p>
        {onEdit && (
          <button
            onClick={handleEdit}
            data-testid={fieldTestId ? `task-detail-${fieldTestId}-edit` : undefined}
            className={`rounded px-1 py-0.5 text-xs transition ${
              locked
                ? 'cursor-not-allowed opacity-40 blur-[0.6px]'
                : 'text-text-muted hover:text-text-body'
            }`}>
            {editLabel}
          </button>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionDivider({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex-1 border-t border-surface-border" />
      <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {title}
      </span>
      <div className="flex-1 border-t border-surface-border" />
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  taskId: string | null;
  slug: string;
  onClose: () => void;
  onChanged?: () => void;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TaskDetailDrawer({ taskId, slug, onClose, onChanged }: Props) {
  const router    = useRouter();

  const t  = useTranslations('taskDetailShared');
  const te = useTranslations('projectEnums');

  const TASK_TYPE_LABELS: Record<string, string> = {
    TASK: te('taskTypeTask'),
    BUG: te('taskTypeBug'),
    EPIC: te('taskTypeEpic'),
    STORY: te('taskTypeStory'),
    SUBTASK: te('taskTypeSubtask'),
  };
  const PRIORITY_LABELS: Record<string, string> = {
    LOW: te('priorityLow'),
    MEDIUM: te('priorityMedium'),
    HIGH: te('priorityHigh'),
    URGENT: te('priorityUrgent'),
  };

  // Anchored via `end-0`, which is the right edge in the one locale the portal
  // ships, so the drawer slides in from there.
  const offscreenX = '100%';

  const [task,      setTask]      = useState<any>(null);
  const [statuses,  setStatuses]  = useState<ProjectTaskStatus[]>([]);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [sprints,   setSprints]   = useState<Sprint[]>([]);
  const [members,   setMembers]   = useState<any[]>([]);
  const [loading,   setLoading]   = useState(false);

  const { can }   = useProjectPermissions(task?.projectId);
  const canEdit   = can('TASK_EDIT');
  const canDelete = can('TASK_DELETE');

  // open rail field
  const [field,      setField]      = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState('');
  const [draftDue,   setDraftDue]   = useState('');

  // title inline
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle,   setDraftTitle]   = useState('');

  // location drafts
  const [locationNameDraft, setLocationNameDraft] = useState('');
  const [latDraft,          setLatDraft]          = useState<number | null>(null);
  const [lngDraft,          setLngDraft]          = useState<number | null>(null);
  const [geoLoading,        setGeoLoading]        = useState(false);

  // new-label form
  const [showNewLabel,  setShowNewLabel]  = useState(false);
  const [newLabelName,  setNewLabelName]  = useState('');
  const [newLabelColor, setNewLabelColor] = useState(LABEL_PALETTE[0]);

  // member search
  const [memberQ, setMemberQ] = useState('');
  const [reporterQ, setReporterQ] = useState('');

  // right rail ref — used for scroll-into-view when a picker opens
  const railRef = useRef<HTMLElement>(null);

  // ── load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = (await projectTaskService.get(taskId)) as any;
      const t   = res.data;
      setTask(t);
      if (t?.projectId) {
        const [s, l, sp, m] = await Promise.all([
          projectTaskService.getStatuses(t.projectId),
          projectTaskService.getLabels(t.projectId),
          sprintService.list(t.projectId),
          projectService.getMembers(t.projectId),
        ]) as [any, any, any, any];
        setStatuses(s.data  || []);
        setAllLabels(l.data || []);
        setSprints(sp.data  || []);
        setMembers(m.data   || []);
      }
    } finally { setLoading(false); }
  }, [taskId]);

  useEffect(() => {
    if (taskId) {
      setField(null); setEditingTitle(false); setShowNewLabel(false);
      load();
    }
  }, [taskId, load]);

  // Scroll active picker into view inside the right rail when it opens
  useEffect(() => {
    if (!field || !railRef.current) return;
    requestAnimationFrame(() => {
      const el = railRef.current?.querySelector(`#rail-field-${field}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [field]);

  const patch = async (data: any) => {
    if (!taskId || !task) return;
    const snapshot = task;
    setTask((t: any) => t ? applyOptimistic(t, data) : t);
    setField(null);
    try {
      await projectTaskService.update(taskId, data as any);
      // Only notify parent for status changes (card moves between columns)
      if ('statusId' in data) onChanged?.();
    } catch {
      setTask(snapshot);
    }
  };

  const toggleField = (f: string) => {
    if (f === 'dates' && field !== 'dates') {
      setDraftStart(task?.startDate ? task.startDate.slice(0, 10) : '');
      setDraftDue(task?.dueDate     ? task.dueDate.slice(0, 10)   : '');
    }
    if (f === 'location' && field !== 'location') {
      setLocationNameDraft(task?.locationName || '');
      setLatDraft(task?.latitude != null ? Number(task.latitude) : null);
      setLngDraft(task?.longitude != null ? Number(task.longitude) : null);
    }
    if (f === 'assignees' && field !== f) setMemberQ('');
    if (f === 'reporter' && field !== f) setReporterQ('');
    setField((prev) => (prev === f ? null : f));
  };

  const captureGeo = () => {
    if (!navigator.geolocation) return;
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setLatDraft(latitude);
        setLngDraft(longitude);
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
            { headers: { 'Accept-Language': 'en' } },
          );
          const data = await res.json();
          if (data.display_name) {
            setLocationNameDraft(data.display_name.split(',').slice(0, 3).join(',').trim());
          }
        } catch { /* ignore */ }
        setGeoLoading(false);
      },
      () => setGeoLoading(false),
      { timeout: 10000 },
    );
  };

  const del = async () => {
    if (!confirm(t('deleteConfirmMessage'))) return;
    await projectTaskService.remove(taskId!);
    onClose(); onChanged?.();
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/dashboard/projects/${slug}/tasks/${taskId}`,
      );
    } catch { /* ignore */ }
  };

  // ── label helpers ─────────────────────────────────────────────────────────
  const taskLabelIds: string[] = (task?.labels || []).map((l: any) => l.label?.id || l.id);

  const toggleLabel = async (labelId: string) => {
    const next = taskLabelIds.includes(labelId)
      ? taskLabelIds.filter((id) => id !== labelId)
      : [...taskLabelIds, labelId];
    await patch({ labelIds: next });
  };

  const createLabel = async () => {
    if (!newLabelName.trim() || !task?.projectId) return;
    const res = (await projectTaskService.createLabel({
      projectId: task.projectId, name: newLabelName.trim(), color: newLabelColor,
    })) as any;
    const newLabel = res.data;
    if (!newLabel) return;
    setAllLabels((prev: any[]) => [...prev, newLabel]);
    setTask((t: any) => t ? {
      ...t,
      labels: [...(t.labels || []), { label: newLabel, labelId: newLabel.id }],
    } : t);
    await projectTaskService.update(taskId!, { labelIds: [...taskLabelIds, newLabel.id] } as any);
    setNewLabelName(''); setShowNewLabel(false);
  };

  // ── assignee helpers ──────────────────────────────────────────────────────
  const taskAssigneeIds: string[] = (task?.assignees || []).map((a: any) => a.id);

  const toggleAssignee = async (empId: string) => {
    const next = taskAssigneeIds.includes(empId)
      ? taskAssigneeIds.filter((id) => id !== empId)
      : [...taskAssigneeIds, empId];
    await patch({ assigneeIds: next });
  };

  const filteredMembers = members.filter((m) =>
    (m.employee?.fullName || '').toLowerCase().includes(memberQ.toLowerCase()),
  );

  const applyOptimistic = (prev: any, data: any): any => {
    const next = { ...prev, ...data };
    if ('sprintId' in data)
      next.sprint = data.sprintId ? (sprints.find((s: any) => s.id === data.sprintId) ?? prev.sprint) : null;
    if ('statusId' in data && data.statusId) {
      const s = statuses.find((s: any) => s.id === data.statusId);
      if (s) { next.workflowStatus = s; next.statusId = data.statusId; }
    }
    if ('assigneeIds' in data)
      next.assignees = (data.assigneeIds || []).map((id: string) => {
        const m = members.find((m: any) => m.employee?.id === id);
        return m?.employee || { id, fullName: 'Member' };
      });
    if ('reporterId' in data) {
      const m = members.find((m: any) => m.employee?.id === data.reporterId);
      next.reporter = data.reporterId ? (m?.employee || { id: data.reporterId, fullName: 'Member' }) : null;
    }
    if ('labelIds' in data)
      next.labels = (data.labelIds || []).map((id: string) => {
        const l = allLabels.find((l: any) => l.id === id);
        return l ? { label: l, labelId: id } : null;
      }).filter(Boolean);
    return next;
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {taskId && (
        <>
          {/* backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/30"
            onClick={onClose}
          />

          {/* drawer */}
          <motion.aside
            initial={{ x: offscreenX }} animate={{ x: 0 }} exit={{ x: offscreenX }}
            transition={{ type: 'tween', duration: 0.22 }}
            className="fixed inset-y-0 end-0 z-50 flex w-full max-w-[1140px] flex-col bg-surface-card shadow-2xl"
            data-testid="task-drawer"
          >
            {loading || !task ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
              </div>
            ) : (
              <>
                {/* ── Top bar ── */}
                <div className="flex shrink-0 items-center justify-between border-b border-surface-border px-5 py-3">
                  <button
                    onClick={() => router.push(`/dashboard/projects/${slug}/tasks/${task.id}`)}
                    data-testid="task-drawer-expand"
                    title={t('openFullPageTooltip')}
                    className="rounded-[--radius-button] p-1.5 text-text-muted hover:bg-surface-page hover:text-text-body">
                    <Maximize2 className="h-4 w-4" />
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button onClick={share} data-testid="task-detail-share" title={t('copyLinkTooltip')}
                      className="rounded-[--radius-button] p-1.5 text-text-muted hover:bg-surface-page hover:text-text-body">
                      <Share2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={canDelete ? del : () => triggerPermissionError(t('permissionDeleteError'))}
                      data-testid="task-delete"
                      title={t('deleteTaskTooltip')}
                      className={`rounded-[--radius-button] p-1.5 text-status-error hover:bg-red-50 ${!canDelete ? 'cursor-not-allowed opacity-40 blur-[0.6px]' : ''}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <button onClick={onClose} data-testid="task-drawer-close"
                      className="rounded-[--radius-button] p-1.5 text-text-muted hover:bg-surface-page hover:text-text-body">
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                {/* ── Task code + title ── */}
                <div className="shrink-0 border-b border-surface-border px-6 py-4">
                  <p data-testid="task-detail-code" className="mb-1 text-xs font-medium text-text-muted">{task.taskCode}</p>
                  {editingTitle ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus value={draftTitle}
                        data-testid="task-detail-title-input"
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter') { await patch({ title: draftTitle }); setEditingTitle(false); }
                          if (e.key === 'Escape') setEditingTitle(false);
                        }}
                        className="flex-1 rounded-[--radius-button] border border-brand-primary bg-surface-page px-3 py-2 text-xl font-bold text-text-heading focus:outline-none"
                      />
                      <button
                        onClick={async () => { await patch({ title: draftTitle }); setEditingTitle(false); }}
                        data-testid="task-save"
                        className="rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm text-text-on-brand hover:bg-brand-primary-dark">
                        {t('saveBtn')}
                      </button>
                      <button
                        onClick={() => setEditingTitle(false)}
                        data-testid="task-detail-title-cancel"
                        className="rounded-[--radius-button] border border-surface-border px-4 py-2 text-sm text-text-body hover:bg-surface-page">
                        {t('cancelBtn')}
                      </button>
                    </div>
                  ) : (
                    <h1
                      data-testid="task-detail-title"
                      onClick={() => {
                        if (canEdit) { setDraftTitle(task.title); setEditingTitle(true); }
                        else triggerPermissionError(t('permissionEditError'));
                      }}
                      className="cursor-text text-xl font-bold capitalize text-text-heading hover:opacity-80">
                      {task.title}
                    </h1>
                  )}
                  {task.reporter && (
                    <p className="mt-1 text-xs text-text-muted">
                      {t('createdByPrefix')}<span className="font-medium text-text-body">{task.reporter.fullName}</span>
                    </p>
                  )}
                </div>

                {/* ── Two-column body ── */}
                <div className="flex min-h-0 flex-1 overflow-hidden">

                  {/* ─── Left: main content ─── */}
                  <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
                    <MarkdownField
                      value={task.description || ''}
                      canEdit={canEdit}
                      onSave={async (d) => patch({ description: d })}
                    />
                    <TaskAttachments taskId={task.id} />
                    <Subtasks taskId={task.id} />
                    <TaskDependencies taskId={task.id} projectId={task.projectId} />
                    <TaskComments taskId={task.id} />
                  </div>

                  {/* ─── Right: property rail ─── */}
                  <aside ref={railRef} className="w-[360px] shrink-0 space-y-4 overflow-x-hidden overflow-y-auto border-s border-surface-border bg-surface-page/50 px-5 py-5">

                    {/* Task Type */}
                    <PropBlock
                      label={t('taskTypeLabel')}
                      anchorId="rail-field-type"
                      onEdit={() => toggleField('type')}
                      locked={!canEdit}
                      editLabel={field === 'type' ? t('closeToggle') : t('editToggle')}>
                      <ColorBadge
                        label={TASK_TYPE_LABELS[task.type] ?? TASK_TYPE_LABELS.TASK}
                        hex={TYPE_HEX[task.type] || '#64748b'}
                      />
                      {field === 'type' && (
                        <ul className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          {TASK_TYPES.map((code) => (
                            <li key={code}>
                              <button
                                onClick={() => patch({ type: code })}
                                data-testid={`task-detail-type-option-${code}`}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-page ${task.type === code ? 'bg-surface-page/70' : ''}`}>
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: TYPE_HEX[code] }} />
                                {TASK_TYPE_LABELS[code]}
                                {task.type === code && <Check className="ms-auto h-3.5 w-3.5 text-brand-primary" />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </PropBlock>

                    {/* Sprint */}
                    <PropBlock
                      label={t('sprintLabel')}
                      anchorId="rail-field-sprint"
                      onEdit={() => toggleField('sprint')}
                      locked={!canEdit}
                      editLabel={field === 'sprint' ? t('closeToggle') : t('editToggle')}>
                      {task.sprint
                        ? <ColorBadge label={task.sprint.name} hex="#6366f1" />
                        : <span className="text-xs text-text-muted">{t('noneLabel')}</span>}
                      {field === 'sprint' && (
                        <ul className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          <li>
                            <button
                              onClick={() => patch({ sprintId: null })}
                              data-testid="task-detail-sprint-option-backlog"
                              className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-page ${!task.sprintId ? 'bg-surface-page/70' : ''}`}>
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-surface-border-light" />
                              {t('backlogOption')}
                              {!task.sprintId && <Check className="ms-auto h-3.5 w-3.5 text-brand-primary" />}
                            </button>
                          </li>
                          {sprints.map((s) => (
                            <li key={s.id}>
                              <button
                                onClick={() => patch({ sprintId: s.id })}
                                data-testid={`task-detail-sprint-option-${s.id}`}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-page ${task.sprintId === s.id ? 'bg-surface-page/70' : ''}`}>
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#6366f1]" />
                                {s.name}
                                {task.sprintId === s.id && <Check className="ms-auto h-3.5 w-3.5 text-brand-primary" />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </PropBlock>

                    {/* Priority */}
                    <PropBlock
                      label={t('priorityLabel')}
                      anchorId="rail-field-priority"
                      onEdit={() => toggleField('priority')}
                      locked={!canEdit}
                      editLabel={field === 'priority' ? t('closeToggle') : t('editToggle')}>
                      <ColorBadge
                        label={PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.MEDIUM}
                        hex={PRIORITY_HEX[task.priority] || '#f59e0b'}
                      />
                      {field === 'priority' && (
                        <ul className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          {PRIORITIES.map((p) => (
                            <li key={p}>
                              <button
                                onClick={() => patch({ priority: p })}
                                data-testid={`task-priority-option-${p}`}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-page ${task.priority === p ? 'bg-surface-page/70' : ''}`}>
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_HEX[p] }} />
                                {PRIORITY_LABELS[p]}
                                {task.priority === p && <Check className="ms-auto h-3.5 w-3.5 text-brand-primary" />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </PropBlock>

                    {/* Status */}
                    <PropBlock
                      label={t('statusLabel')}
                      anchorId="rail-field-status"
                      onEdit={() => toggleField('status')}
                      locked={!canEdit}
                      editLabel={field === 'status' ? t('closeToggle') : t('editToggle')}>
                      {task.workflowStatus
                        ? <ColorBadge label={task.workflowStatus.name} hex={task.workflowStatus.color} />
                        : <span className="text-xs text-text-muted">—</span>}
                      {field === 'status' && (
                        <ul className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          {statuses.map((s) => (
                            <li key={s.id}>
                              <button
                                data-testid={`task-status-option-${s.id}`}
                                onClick={async () => {
                                  const snapshot = task;
                                  setTask((t: any) => t ? { ...t, statusId: s.id, workflowStatus: s } : t);
                                  setField(null);
                                  try {
                                    await projectTaskService.moveStatus(taskId!, s.id);
                                    onChanged?.();
                                  } catch {
                                    setTask(snapshot);
                                  }
                                }}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-page ${task.statusId === s.id ? 'bg-surface-page/70' : ''}`}>
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                                {s.name}
                                {task.statusId === s.id && <Check className="ms-auto h-3.5 w-3.5 text-brand-primary" />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </PropBlock>

                    {/* Stage Timer */}
                    <StageTimer
                      taskId={task.id}
                      assigneeIds={(task.assignees || []).map((a: any) => a.id)}
                      canManage={can('TASK_ASSIGN')}
                      currentStatusName={task.workflowStatus?.name}
                      statusId={task.statusId}
                    />

                    {/* Date Range */}
                    <PropBlock
                      label={t('dateRangeLabel')}
                      anchorId="rail-field-dates"
                      onEdit={() => toggleField('dates')}
                      locked={!canEdit}
                      editLabel={field === 'dates' ? t('doneToggle') : t('editToggle')}>
                      {field === 'dates' ? (
                        <div className="space-y-3">
                          <div>
                            <p className="mb-1 text-xs text-text-muted">{t('startDateLabel')}</p>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="date" value={draftStart}
                                data-testid="task-detail-start-date"
                                onChange={(e) => setDraftStart(e.target.value)}
                                className="flex-1 rounded-[--radius-button] border border-surface-border bg-surface-card px-2.5 py-1.5 text-xs text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                              />
                              {draftStart && (
                                <button onClick={() => setDraftStart('')} className="text-text-muted hover:text-status-error">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div>
                            <p className="mb-1 text-xs text-text-muted">{t('dueDateLabel')}</p>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="date" value={draftDue}
                                data-testid="task-detail-due-date"
                                onChange={(e) => setDraftDue(e.target.value)}
                                className="flex-1 rounded-[--radius-button] border border-surface-border bg-surface-card px-2.5 py-1.5 text-xs text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                              />
                              {draftDue && (
                                <button onClick={() => setDraftDue('')} className="text-text-muted hover:text-status-error">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => patch({ startDate: draftStart || null, dueDate: draftDue || null })}
                            data-testid="task-detail-dates-save"
                            className="w-full rounded-[--radius-button] bg-brand-primary py-2 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark">
                            {t('saveDatesBtn')}
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div>
                            <p className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">{t('startDateLabel')}</p>
                            <span className="inline-block rounded-full border border-surface-border bg-surface-card px-3 py-1 text-xs text-text-body">
                              {fmtDate(task.startDate)}
                            </span>
                          </div>
                          <div>
                            <p className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">{t('dueDateLabel')}</p>
                            <span className="inline-block rounded-full border border-surface-border bg-surface-card px-3 py-1 text-xs text-text-body">
                              {fmtDate(task.dueDate)}
                            </span>
                          </div>
                        </div>
                      )}
                    </PropBlock>

                    {/* Location */}
                    <PropBlock
                      label={t('locationLabel')}
                      anchorId="rail-field-location"
                      onEdit={() => toggleField('location')}
                      locked={!canEdit}
                      editLabel={field === 'location' ? t('closeToggle') : t('editToggle')}>
                      {task.locationName || task.latitude != null ? (
                        <div className="space-y-1">
                          {task.locationName && (
                            <p className="truncate text-xs text-text-body">{task.locationName}</p>
                          )}
                          {task.latitude != null && task.longitude != null && (
                            <a
                              href={`https://maps.google.com/?q=${task.latitude},${task.longitude}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline">
                              <MapPin className="h-3 w-3" />
                              {Number(task.latitude).toFixed(5)}, {Number(task.longitude).toFixed(5)}
                            </a>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">{t('emptyNoLocationSet')}</span>
                      )}
                      {field === 'location' && (
                        <div className="mt-2 space-y-2">
                          <div>
                            <p className="mb-1 text-xs text-text-muted">{t('locationNameLabel')}</p>
                            <input
                              value={locationNameDraft}
                              data-testid="task-detail-location-name"
                              onChange={(e) => setLocationNameDraft(e.target.value)}
                              placeholder={t('locationNamePlaceholder')}
                              className="w-full rounded-[--radius-button] border border-surface-border bg-surface-card px-2.5 py-1.5 text-xs text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                            />
                          </div>
                          {latDraft != null && lngDraft != null && (
                            <a
                              href={`https://maps.google.com/?q=${latDraft},${lngDraft}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-brand-primary hover:underline">
                              <MapPin className="h-3 w-3" />
                              {latDraft.toFixed(5)}, {lngDraft.toFixed(5)}
                            </a>
                          )}
                          <button
                            onClick={captureGeo}
                            data-testid="task-detail-location-capture"
                            disabled={geoLoading}
                            className="flex w-full items-center justify-center gap-2 rounded-[--radius-button] border border-surface-border py-1.5 text-xs text-text-muted hover:bg-surface-page disabled:opacity-50">
                            {geoLoading
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <MapPin className="h-3.5 w-3.5" />}
                            {geoLoading ? t('detectingBtn') : t('useMyLocationBtn')}
                          </button>
                          <div className="flex gap-2">
                            <button
                              data-testid="task-detail-location-save"
                              onClick={() => patch({
                                locationName: locationNameDraft || null,
                                latitude: latDraft,
                                longitude: lngDraft,
                              })}
                              className="flex-1 rounded-[--radius-button] bg-brand-primary py-1.5 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark">
                              {t('saveBtn')}
                            </button>
                            {(task.locationName || task.latitude != null) && (
                              <button
                                onClick={() => patch({ locationName: null, latitude: null, longitude: null })}
                                data-testid="task-detail-location-clear"
                                className="rounded-[--radius-button] border border-surface-border px-3 py-1.5 text-xs text-status-error hover:bg-surface-page">
                                {t('clearLocationBtn')}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </PropBlock>

                    {/* ─── ASSIGNMENT ─── */}
                    <SectionDivider title={t('assignmentHeading')} />

                    {/* Assignees */}
                    <PropBlock
                      label={t('assigneesLabel')}
                      anchorId="rail-field-assignees"
                      onEdit={() => { setMemberQ(''); toggleField('assignees'); }}
                      locked={!canEdit}
                      editLabel={field === 'assignees' ? t('closeToggle') : t('editToggle')}>
                      {(task.assignees || []).length === 0 ? (
                        <span className="text-xs text-text-muted">{t('unassignedLabel')}</span>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {(task.assignees || []).map((a: any) => (
                            <div key={a.id} className="flex items-center gap-2">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-[11px] font-semibold text-brand-primary">
                                {a.fullName.slice(0, 2).toUpperCase()}
                              </div>
                              <span className="text-xs text-text-body">{a.fullName}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {field === 'assignees' && (
                        <div className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          <div className="border-b border-surface-border p-2">
                            <input
                              autoFocus value={memberQ} data-testid="task-detail-assignee-search" onChange={(e) => setMemberQ(e.target.value)}
                              placeholder={t('searchMembersPlaceholder')}
                              className="w-full rounded-[--radius-button] bg-surface-page px-2.5 py-1.5 text-xs text-text-body placeholder:text-text-muted focus:outline-none"
                            />
                          </div>
                          <ul className="max-h-48 overflow-y-auto py-1">
                            {filteredMembers.map((m) => {
                              const name  = m.employee?.fullName || t('fallbackUnknown');
                              const empId = m.employee?.id;
                              const sel   = taskAssigneeIds.includes(empId);
                              return (
                                <li key={m.id}>
                                  <button
                                    onClick={() => toggleAssignee(empId)}
                                    data-testid={`task-assignee-option-${empId}`}
                                    className={`flex w-full items-center gap-2.5 px-3 py-2 hover:bg-surface-page ${sel ? 'bg-surface-page/60' : ''}`}>
                                    <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${sel ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'}`}>
                                      {sel && <Check className="h-3 w-3 text-white" />}
                                    </div>
                                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-primary/20 text-[10px] font-semibold text-brand-primary">
                                      {name.slice(0, 2).toUpperCase()}
                                    </div>
                                    <span className="truncate text-sm text-text-body">{name}</span>
                                  </button>
                                </li>
                              );
                            })}
                            {filteredMembers.length === 0 && (
                              <li data-testid="task-detail-assignee-empty" className="py-3 text-center text-xs text-text-muted">{t('emptyNoMembersFound')}</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </PropBlock>

                    {/* Reporter */}
                    <PropBlock
                      label={t('reporterLabel')}
                      anchorId="rail-field-reporter"
                      onEdit={() => toggleField('reporter')}
                      locked={!canEdit}
                      editLabel={field === 'reporter' ? t('closeToggle') : t('editToggle')}>
                      {task.reporter ? (
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-border-light text-[11px] font-semibold text-text-muted">
                            {task.reporter.fullName.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="text-xs text-text-body">{task.reporter.fullName}</span>
                          {canEdit && (
                            <button
                              onClick={() => patch({ reporterId: null })}
                              data-testid="task-detail-reporter-clear"
                              className="ms-auto text-text-muted hover:text-status-error"
                              title={t('clearReporterTooltip')}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">{t('noneLabel')}</span>
                      )}
                      {field === 'reporter' && (
                        <div className="mt-2 overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card shadow-md">
                          <div className="border-b border-surface-border p-2">
                            <input
                              autoFocus value={reporterQ} data-testid="task-detail-reporter-search" onChange={(e) => setReporterQ(e.target.value)}
                              placeholder={t('searchMembersPlaceholder')}
                              className="w-full rounded-[--radius-button] bg-surface-page px-2.5 py-1.5 text-xs text-text-body placeholder:text-text-muted focus:outline-none"
                            />
                          </div>
                          <ul className="max-h-48 overflow-y-auto py-1">
                            {members
                              .filter((m) => (m.employee?.fullName || '').toLowerCase().includes(reporterQ.toLowerCase()))
                              .map((m) => {
                                const name  = m.employee?.fullName || t('fallbackUnknown');
                                const empId = m.employee?.id;
                                const isCurrent = task.reporter?.id === empId;
                                return (
                                  <li key={m.id}>
                                    <button
                                      data-testid={`task-detail-reporter-option-${empId}`}
                                      onClick={async () => {
                                        await patch({ reporterId: isCurrent ? null : empId });
                                        setField(null);
                                      }}
                                      className={`flex w-full items-center gap-2.5 px-3 py-2 hover:bg-surface-page ${isCurrent ? 'bg-surface-page/60' : ''}`}>
                                      <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isCurrent ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'}`}>
                                        {isCurrent && <Check className="h-3 w-3 text-white" />}
                                      </div>
                                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-border-light text-[10px] font-semibold text-text-muted">
                                        {name.slice(0, 2).toUpperCase()}
                                      </div>
                                      <span className="truncate text-sm text-text-body">{name}</span>
                                    </button>
                                  </li>
                                );
                              })}
                            {members.filter((m) => (m.employee?.fullName || '').toLowerCase().includes(reporterQ.toLowerCase())).length === 0 && (
                              <li data-testid="task-detail-reporter-empty" className="py-3 text-center text-xs text-text-muted">{t('emptyNoMembersFound')}</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </PropBlock>

                    {/* ─── LABELS ─── */}
                    <SectionDivider title={t('labelsHeading')} />

                    <PropBlock
                      label={t('labelsHeading')}
                      anchorId="rail-field-labels"
                      onEdit={() => toggleField('labels')}
                      locked={!canEdit}
                      editLabel={field === 'labels' ? t('closeToggle') : t('editToggle')}>
                      {(task.labels || []).length === 0 ? (
                        <p data-testid="task-detail-labels-empty" className="text-xs text-text-muted">{t('emptyNoCurrentLabels')}</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {(task.labels || []).map((l: any) => {
                            const lbl = l.label || l;
                            return (
                              <span
                                key={lbl.id}
                                className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
                                style={{ backgroundColor: `${lbl.color}20`, color: lbl.color }}>
                                {lbl.name}
                                <button
                                  onClick={canEdit ? () => toggleLabel(lbl.id) : () => triggerPermissionError(t('permissionEditError'))}
                                  data-testid={`task-detail-label-remove-${lbl.id}`}
                                  className={`opacity-60 hover:opacity-100 ${!canEdit ? 'cursor-not-allowed blur-[0.5px]' : ''}`}>
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </PropBlock>

                    {/* labels panel */}
                    {canEdit && field === 'labels' && (
                        <div className="overflow-hidden rounded-[--radius-card] border border-surface-border bg-surface-card">
                          {/* toggle available */}
                          <div className="border-b border-surface-border p-3">
                            <p className="mb-2 text-xs font-semibold text-text-body">{t('availableLabelsHeading')}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {allLabels.map((l: any) => {
                                const sel = taskLabelIds.includes(l.id);
                                return (
                                  <button
                                    key={l.id}
                                    onClick={() => toggleLabel(l.id)}
                                    data-testid={`task-detail-label-option-${l.id}`}
                                    className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition ${sel ? 'opacity-100 ring-2 ring-offset-1' : 'opacity-60 hover:opacity-100'}`}
                                    style={{ backgroundColor: `${l.color}20`, color: l.color }}>
                                    {sel && <Check className="h-3 w-3" />}
                                    {l.name}
                                  </button>
                                );
                              })}
                              {allLabels.length === 0 && <p data-testid="task-detail-labels-catalog-empty" className="text-xs text-text-muted">{t('emptyNoLabelsYet')}</p>}
                            </div>
                          </div>

                          {/* new label form */}
                          {!showNewLabel ? (
                            <button
                              onClick={() => setShowNewLabel(true)}
                              data-testid="task-detail-label-new"
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-text-muted hover:text-brand-primary">
                              <Plus className="h-3.5 w-3.5" /> {t('addNewLabelBtn')}
                            </button>
                          ) : (
                            <div className="space-y-2.5 p-3">
                              <div>
                                <p className="mb-1 text-xs font-medium text-text-body">{t('labelNameLabel')}</p>
                                <input
                                  autoFocus value={newLabelName}
                                  data-testid="task-detail-label-name"
                                  onChange={(e) => setNewLabelName(e.target.value)}
                                  placeholder={t('labelNamePlaceholder')}
                                  className="w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-2.5 py-1.5 text-xs text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
                                />
                              </div>
                              <div>
                                <p className="mb-1.5 text-xs font-medium text-text-body">{t('colorLabel')}</p>
                                <div className="grid grid-cols-6 gap-1.5">
                                  {LABEL_PALETTE.map((c) => (
                                    <button
                                      key={c} onClick={() => setNewLabelColor(c)}
                                      data-testid={`task-detail-label-color-${c.replace('#', '')}`}
                                      className={`h-6 w-6 rounded-full transition ${newLabelColor === c ? 'ring-2 ring-brand-primary ring-offset-1' : ''}`}
                                      style={{ backgroundColor: c }} />
                                  ))}
                                </div>
                              </div>
                              {newLabelName && (
                                <div>
                                  <p className="mb-1 text-[10px] text-text-muted">{t('labelPreviewLabel')}</p>
                                  <span
                                    className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                                    style={{ backgroundColor: `${newLabelColor}20`, color: newLabelColor }}>
                                    {newLabelName}
                                  </span>
                                </div>
                              )}
                              <div className="flex gap-2">
                                <button
                                  onClick={createLabel} disabled={!newLabelName.trim()}
                                  data-testid="task-detail-label-create"
                                  className="flex-1 rounded-[--radius-button] bg-brand-primary py-1.5 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-50">
                                  {t('addLabelBtn')}
                                </button>
                                <button
                                  onClick={() => { setShowNewLabel(false); setNewLabelName(''); }}
                                  data-testid="task-detail-label-cancel"
                                  className="rounded-[--radius-button] border border-surface-border px-3 py-1.5 text-xs text-text-body hover:bg-surface-page">
                                  {t('cancelBtn')}
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="border-t border-surface-border p-2">
                            <button
                              onClick={() => { setField(null); setShowNewLabel(false); }}
                              data-testid="task-detail-labels-close"
                              className="w-full text-center text-xs text-text-muted hover:text-text-body">
                              {t('closeBtn')}
                            </button>
                          </div>
                        </div>
                    )}

                    {/* ─── ACTIVITIES ─── */}
                    <SectionDivider title={t('activitiesHeading')} />
                    <TaskActivity activities={task.activities || []} />

                  </aside>
                </div>
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
