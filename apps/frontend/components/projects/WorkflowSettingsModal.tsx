'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { KeyboardSensor } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import {
  X, GripVertical, Plus, Trash2, Check, Pencil, Loader2,
} from 'lucide-react';
import projectTaskService from '@/services/projectTaskService';

type Category = 'TODO' | 'IN_PROGRESS' | 'DONE';

interface Status {
  id: string;
  name: string;
  color: string;
  category: Category;
  position: number;
}

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

const PRESET_COLORS = [
  '#6366f1', '#3b82f6', '#0ea5e9', '#14b8a6',
  '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#64748b', '#f97316', '#10b981',
];

// ── Sortable row ─────────────────────────────────────────────────────────────

function StatusRow({
  status,
  onUpdate,
  onDelete,
  isOnly,
}: {
  status: Status;
  onUpdate: (id: string, patch: Partial<Status>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  isOnly: boolean;
}) {
  const t = useTranslations('workflowSettingsModal');
  const te = useTranslations('projectEnums');
  const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
    { value: 'TODO', label: te('categoryTodo') },
    { value: 'IN_PROGRESS', label: te('categoryInProgress') },
    { value: 'DONE', label: te('categoryDone') },
  ];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: status.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.7 : 1,
  };

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  const [category, setCategory] = useState<Category>(status.category);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    const patch: Partial<Status> = {};
    if (name.trim() !== status.name) patch.name = name.trim();
    if (color !== status.color) patch.color = color;
    if (category !== status.category) patch.category = category;
    if (Object.keys(patch).length) {
      setSaving(true);
      try { await onUpdate(status.id, patch); } finally { setSaving(false); }
    }
    setEditing(false);
    setShowColorPicker(false);
  };

  const cancelEdit = () => {
    setName(status.name);
    setColor(status.color);
    setCategory(status.category);
    setEditing(false);
    setShowColorPicker(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try { await onDelete(status.id); } finally { setDeleting(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`status-row-${status.id}`}
      className={`group flex items-center gap-3 rounded-[--radius-button] border bg-surface-card px-3 py-2.5 transition-shadow ${
        isDragging ? 'shadow-lg border-brand-primary/30' : 'border-surface-border'
      }`}
    >
      {/* Drag handle */}
      <button
        {...listeners}
        {...attributes}
        data-testid={`status-drag-handle-${status.id}`}
        className="cursor-grab text-text-muted opacity-40 hover:opacity-80 active:cursor-grabbing touch-none"
        tabIndex={-1}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Color dot / picker trigger */}
      <div className="relative">
        <button
          onClick={() => editing && setShowColorPicker((v) => !v)}
          data-testid={`status-color-${status.id}`}
          className={`h-3 w-3 flex-shrink-0 rounded-full transition-transform ${editing ? 'cursor-pointer scale-125' : 'cursor-default'}`}
          style={{ backgroundColor: color }}
          title={editing ? t('changeColorTooltip') : undefined}
        />
        {showColorPicker && editing && (
          <div className="absolute start-0 top-6 z-50 rounded-[--radius-card] border border-surface-border bg-surface-card p-3 shadow-xl">
            <p className="mb-2 text-[10px] font-semibold text-text-muted uppercase tracking-wide">{t('colorLabel')}</p>
            <div className="grid grid-cols-6 gap-1.5 mb-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => { setColor(c); setShowColorPicker(false); }}
                  data-testid={`status-color-option-${c.replace('#', '')}`}
                  className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${color === c ? 'ring-2 ring-offset-1 ring-brand-primary' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-6 w-8 cursor-pointer rounded border border-surface-border bg-transparent"
              />
              <span className="text-xs text-text-muted font-mono">{color}</span>
            </div>
          </div>
        )}
      </div>

      {/* Name */}
      {editing ? (
        <input
          ref={inputRef}
          value={name}
          data-testid={`status-name-input-${status.id}`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancelEdit(); }}
          className="flex-1 rounded-[--radius-button] border border-brand-primary/40 bg-surface-page px-2 py-0.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
        />
      ) : (
        <span data-testid={`status-name-${status.id}`} className="flex-1 text-sm font-medium text-text-body">{status.name}</span>
      )}

      {/* Category (only when editing) */}
      {editing && (
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          data-testid={`status-category-${status.id}`}
          className="rounded-[--radius-button] border border-surface-border bg-surface-page px-2 py-0.5 text-xs text-text-body focus:outline-none"
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}

      {/* Category badge (not editing) */}
      {!editing && (
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
          status.category === 'DONE' ? 'bg-status-success-bg text-status-success' :
          status.category === 'IN_PROGRESS' ? 'bg-brand-primary-light text-brand-primary' :
          'bg-surface-page text-text-muted'
        }`}>
          {CATEGORY_OPTIONS.find((o) => o.value === status.category)?.label}
        </span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1">
        {editing ? (
          <>
            <button
              onClick={save}
              disabled={saving || !name.trim()}
              data-testid={`status-save-${status.id}`}
              className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-2 py-1 text-[10px] font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {t('saveBtn')}
            </button>
            <button
              onClick={cancelEdit}
              data-testid={`status-edit-cancel-${status.id}`}
              className="rounded-[--radius-button] px-2 py-1 text-[10px] text-text-muted hover:bg-surface-page"
            >
              {t('cancelBtn')}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              data-testid={`status-edit-${status.id}`}
              className="rounded-[--radius-button] p-1.5 text-text-muted opacity-0 transition hover:bg-surface-page hover:text-text-body group-hover:opacity-100"
              title={t('editTooltip')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || isOnly}
              data-testid={`status-delete-${status.id}`}
              className="rounded-[--radius-button] p-1.5 text-text-muted opacity-0 transition hover:bg-status-error-bg hover:text-status-error group-hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed"
              title={isOnly ? t('cannotDeleteLastStatusTooltip') : t('deleteTooltip')}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Add status form ──────────────────────────────────────────────────────────

function AddStatusForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, color: string, category: Category) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('workflowSettingsModal');
  const te = useTranslations('projectEnums');
  const CATEGORY_OPTIONS: { value: Category; label: string }[] = [
    { value: 'TODO', label: te('categoryTodo') },
    { value: 'IN_PROGRESS', label: te('categoryInProgress') },
    { value: 'DONE', label: te('categoryDone') },
  ];
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [category, setCategory] = useState<Category>('IN_PROGRESS');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try { await onAdd(name.trim(), color, category); }
    finally { setSaving(false); }
  };

  return (
    <div data-testid="status-add-form" className="rounded-[--radius-button] border border-brand-primary/30 bg-brand-primary-light/10 p-3">
      <div className="flex items-center gap-3">
        <GripVertical className="h-4 w-4 text-text-muted opacity-30" />
        <button
          className="h-3 w-3 flex-shrink-0 rounded-full ring-2 ring-offset-1 ring-brand-primary/50"
          style={{ backgroundColor: color }}
          title={t('colorLabel')}
          onClick={() => {}}
        />
        <input
          autoFocus
          value={name}
          data-testid="status-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder={t('statusNamePlaceholder')}
          className="flex-1 rounded-[--radius-button] border border-brand-primary/30 bg-surface-page px-2 py-0.5 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          data-testid="status-category"
          className="rounded-[--radius-button] border border-surface-border bg-surface-page px-2 py-0.5 text-xs text-text-body focus:outline-none"
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 ps-7">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            data-testid={`status-add-color-${c.replace('#', '')}`}
            className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${color === c ? 'ring-2 ring-offset-1 ring-brand-primary' : ''}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button onClick={onCancel} data-testid="status-add-cancel" className="rounded-[--radius-button] px-3 py-1 text-xs text-text-muted hover:bg-surface-page">
          {t('cancelBtn')}
        </button>
        <button
          onClick={submit}
          disabled={saving || !name.trim()}
          data-testid="status-add-submit"
          className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-3 py-1 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />} {t('addStatusBtn')}
        </button>
      </div>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export default function WorkflowSettingsModal({ projectId, open, onClose, onChanged }: Props) {
  const t = useTranslations('workflowSettingsModal');
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reordering, setReordering] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await projectTaskService.getStatuses(projectId)) as any;
      setStatuses(res.data || []);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = statuses.findIndex((s) => s.id === active.id);
    const newIdx = statuses.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(statuses, oldIdx, newIdx);
    setStatuses(reordered);
    setReordering(true);
    try {
      await projectTaskService.reorderStatuses(reordered.map((s, i) => ({ id: s.id, position: i })));
      onChanged();
    } catch {
      load(); // revert
    } finally {
      setReordering(false);
    }
  };

  const handleUpdate = async (id: string, patch: Partial<Status>) => {
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    await projectTaskService.updateStatus(id, patch as any);
    onChanged();
  };

  const handleDelete = async (id: string) => {
    try {
      await projectTaskService.deleteStatus(id);
      setStatuses((prev) => prev.filter((s) => s.id !== id));
      onChanged();
    } catch (err: any) {
      const msg = err?.response?.data?.message || t('deleteFailedFallback');
      alert(msg);
    }
  };

  const handleAdd = async (name: string, color: string, category: Category) => {
    const res = (await projectTaskService.createStatus({ projectId, name, color, category })) as any;
    setStatuses((prev) => [...prev, res.data]);
    setAdding(false);
    onChanged();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div data-testid="workflow-settings-modal" className="w-full max-w-lg rounded-[--radius-card] border border-surface-border bg-surface-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text-heading">{t('heading')}</h2>
            <p className="mt-0.5 text-xs text-text-muted">{t('subtext')}</p>
          </div>
          <button onClick={onClose} data-testid="workflow-settings-close" className="rounded-[--radius-button] p-1.5 text-text-muted hover:bg-surface-page hover:text-text-body">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={statuses.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {statuses.map((s) => (
                    <StatusRow
                      key={s.id}
                      status={s}
                      onUpdate={handleUpdate}
                      onDelete={handleDelete}
                      isOnly={statuses.length <= 1}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {/* Add form */}
          {adding && (
            <div className="mt-2">
              <AddStatusForm onAdd={handleAdd} onCancel={() => setAdding(false)} />
            </div>
          )}

          {/* Add trigger */}
          {!adding && !loading && (
            <button
              onClick={() => setAdding(true)}
              data-testid="status-create"
              className="mt-3 flex w-full items-center gap-2 rounded-[--radius-button] border border-dashed border-surface-border px-3 py-2 text-sm text-text-muted transition hover:border-brand-primary/40 hover:text-brand-primary"
            >
              <Plus className="h-4 w-4" /> {t('addStatusTriggerBtn')}
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-surface-border px-5 py-3">
          <span className="text-xs text-text-muted">
            {reordering ? (
              <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> {t('savingOrderText')}</span>
            ) : (
              t('statusesConfiguredCount', { count: statuses.length })
            )}
          </span>
          <button
            onClick={onClose}
            data-testid="workflow-settings-done"
            className="rounded-[--radius-button] bg-text-heading px-4 py-1.5 text-sm font-medium text-surface-card hover:opacity-90"
          >
            {t('doneBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
