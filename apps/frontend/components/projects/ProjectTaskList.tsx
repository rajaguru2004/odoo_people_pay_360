'use client';

import React, { useState } from 'react';
import { Plus, Check, X, ChevronDown, Loader2, Calendar, MessageSquare, Paperclip } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge';
import type { ProjectTask, ProjectTaskStatus } from '@/types/project';

export interface ListQuickCreateData {
  title: string;
  priority: string;
  statusId?: string;
  assigneeIds: string[];
  dueDate?: string;
}

interface Props {
  tasks: ProjectTask[];
  statuses: ProjectTaskStatus[];
  members: any[];
  onOpenTask: (t: ProjectTask) => void;
  onQuickCreate?: (data: ListQuickCreateData) => Promise<void>;
  canCreate?: boolean;
}

function Avatars({ assignees }: { assignees?: ProjectTask['assignees'] }) {
  const t = useTranslations('projectTaskList');
  if (!assignees || assignees.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <div className="flex -space-x-2 rtl:space-x-reverse">
      {assignees.slice(0, 3).map((a) => (
        <div key={a.id} title={a.fullName}
          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-card bg-brand-primary-light/60 text-[10px] font-semibold text-brand-primary">
          {a.fullName.slice(0, 2).toUpperCase()}
        </div>
      ))}
      {assignees.length > 3 && (
        <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-card bg-surface-border-light text-[10px] font-semibold text-text-muted">
          {t('overflowCount', { count: assignees.length - 3 })}
        </div>
      )}
    </div>
  );
}

function QuickAddRow({
  statuses, members, onSubmit, onCancel,
}: {
  statuses: ProjectTaskStatus[];
  members: any[];
  onSubmit: (d: ListQuickCreateData) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('projectTaskList');
  const te = useTranslations('projectEnums');
  const PRIORITIES = [
    { value: 'LOW', label: te('priorityLow') },
    { value: 'MEDIUM', label: te('priorityMedium') },
    { value: 'HIGH', label: te('priorityHigh') },
    { value: 'URGENT', label: te('priorityUrgent') },
  ];
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [statusId, setStatusId] = useState(statuses.find((s) => s.isDefault)?.id || statuses[0]?.id || '');
  const [assignees, setAssignees] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try { await onSubmit({ title: title.trim(), priority, statusId: statusId || undefined, assigneeIds: assignees, dueDate: dueDate || undefined }); }
    finally { setSaving(false); }
  };

  const toggle = (id: string) => setAssignees((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const inputCls = 'rounded-[--radius-button] border border-surface-border bg-surface-page px-2 py-1.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30';

  return (
    <tr data-testid="task-list-quick-add" className="border-b border-surface-border bg-brand-primary/5">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <input
            autoFocus value={title} data-testid="task-list-quick-add-title" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
            placeholder={t('titlePlaceholder')}
            className={`${inputCls} flex-1`}
          />
          <button onClick={submit} disabled={saving || !title.trim()} data-testid="task-list-quick-add-submit" title={t('createTooltip')}
            className="rounded-[--radius-button] p-1.5 text-status-success hover:bg-status-success-bg disabled:opacity-40">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
          <button onClick={onCancel} data-testid="task-list-quick-add-cancel" title={t('cancelTooltip')} className="rounded-[--radius-button] p-1.5 text-status-error hover:bg-status-error-bg">
            <X className="h-4 w-4" />
          </button>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <select value={priority} onChange={(e) => setPriority(e.target.value)} data-testid="task-list-quick-add-priority" className={inputCls}>
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </td>
      <td className="px-4 py-2.5">
        <select value={statusId} onChange={(e) => setStatusId(e.target.value)} data-testid="task-list-quick-add-status" className={inputCls}>
          {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </td>
      <td className="px-4 py-2.5">
        <div className="relative">
          <button onClick={() => setPickerOpen((p) => !p)} data-testid="task-list-quick-add-assignees"
            className={`${inputCls} flex items-center gap-1.5 whitespace-nowrap`}>
            {assignees.length > 0 ? t('selectedCountSuffix', { count: assignees.length }) : <span className="text-text-muted">{t('selectAssigneesPlaceholder')}</span>}
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          </button>
          {pickerOpen && (
            <div className="absolute start-0 top-full z-30 mt-1 max-h-48 w-56 overflow-y-auto rounded-[--radius-card] border border-surface-border bg-surface-card shadow-lg">
              {members.length === 0 ? (
                <p data-testid="task-list-quick-add-assignee-empty" className="py-3 text-center text-xs text-text-muted">{t('noMembersOption')}</p>
              ) : members.map((m) => {
                const name = m.employee?.fullName || t('fallbackUnknown');
                const id = m.employee?.id;
                const sel = assignees.includes(id);
                return (
                  <button key={m.id} onClick={() => toggle(id)} data-testid={`task-list-quick-add-assignee-option-${id}`}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-surface-page ${sel ? 'bg-brand-primary/5' : ''}`}>
                    <div className={`flex h-4 w-4 items-center justify-center rounded border ${sel ? 'border-brand-primary bg-brand-primary' : 'border-surface-border'}`}>
                      {sel && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <span className="truncate text-text-body">{name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </td>
      <td className="px-4 py-2.5">
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} data-testid="task-list-quick-add-due-date" className={inputCls} />
      </td>
    </tr>
  );
}

export default function ProjectTaskList({ tasks, statuses, members, onOpenTask, onQuickCreate, canCreate }: Props) {
  const t = useTranslations('projectTaskList');
  const tc = useTranslations('common');
  const [adding, setAdding] = useState(false);

  return (
    <div className="overflow-visible rounded-[--radius-card] border border-surface-border bg-surface-card">
      <table data-testid="task-list" className="w-full text-sm">
        <thead>
          {/* neutral — table header */}
          <tr className="border-b border-surface-border text-start text-text-muted">
            <th className="px-4 py-3 font-medium">{t('colTask')}</th>
            <th className="px-4 py-3 font-medium">{t('colPriority')}</th>
            <th className="px-4 py-3 font-medium">{tc('status')}</th>
            <th className="px-4 py-3 font-medium">{t('colAssignees')}</th>
            <th className="px-4 py-3 font-medium">{t('colDueDate')}</th>
          </tr>
        </thead>
        <tbody>
          {canCreate && onQuickCreate && (
            adding ? (
              <QuickAddRow
                statuses={statuses} members={members}
                onSubmit={async (d) => { await onQuickCreate(d); setAdding(false); }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <tr className="border-b border-surface-border-light">
                <td colSpan={5} className="px-4 py-2">
                  <button onClick={() => setAdding(true)} data-testid="task-list-add"
                    className="flex items-center gap-1.5 text-sm text-text-muted hover:text-brand-primary">
                    <Plus className="h-4 w-4" /> {t('addTaskBtn')}
                  </button>
                </td>
              </tr>
            )
          )}
          {tasks.map((t) => (
            <tr key={t.id} onClick={() => onOpenTask(t)} data-testid={`task-row-${t.taskCode}`}
              className="cursor-pointer border-b border-surface-border-light last:border-0 hover:bg-surface-page">
              <td className="px-4 py-3 font-medium text-text-body">
                <div className="flex items-center gap-2">
                  <span>{t.title}</span>
                  <span className="rounded bg-surface-page px-1.5 py-0.5 text-[10px] text-text-muted">{t.taskCode}</span>
                  {t.labels?.map((l) => (
                    <span key={l.label.id} className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ backgroundColor: `${l.label.color}22`, color: l.label.color }}>{l.label.name}</span>
                  ))}
                </div>
                {(!!t._count?.comments || !!t._count?.attachments) && (
                  <div className="mt-1 flex items-center gap-3 text-xs text-text-muted">
                    {!!t._count?.comments && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t._count.comments}</span>}
                    {!!t._count?.attachments && <span className="flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{t._count.attachments}</span>}
                  </div>
                )}
              </td>
              <td className="px-4 py-3"><TaskPriorityBadge priority={t.priority} /></td>
              <td className="px-4 py-3">
                {t.workflowStatus ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-white"
                    style={{ backgroundColor: t.workflowStatus.color }}>
                    {t.workflowStatus.name}
                  </span>
                ) : <span className="text-text-muted">—</span>}
              </td>
              <td className="px-4 py-3"><Avatars assignees={t.assignees} /></td>
              <td className="px-4 py-3 whitespace-nowrap">
                {t.dueDate ? (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <Calendar className="h-3.5 w-3.5" />
                    {new Date(t.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                ) : <span className="text-text-muted">—</span>}
              </td>
            </tr>
          ))}
          {tasks.length === 0 && !adding && (
            <tr data-testid="task-list-empty"><td colSpan={5} className="px-4 py-10 text-center text-text-muted">{t('emptyNoTasks')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
