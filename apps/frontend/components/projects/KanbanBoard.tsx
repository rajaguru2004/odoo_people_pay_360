'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useTranslations } from 'next-intl';
import { MessageSquare, Paperclip, GitBranch, Plus, X, Loader2 } from 'lucide-react';
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge';
import type { KanbanColumn, ProjectTask } from '@/types/project';
import { triggerPermissionError } from '@/lib/permissionError';

export interface QuickCreateData { title: string; priority: string; dueDate?: string }

interface Props {
  columns: KanbanColumn[];
  onMove: (taskId: string, statusId: string) => void;
  onOpenTask: (task: ProjectTask) => void;
  onQuickCreate?: (statusId: string, data: QuickCreateData) => Promise<void>;
  canCreate?: boolean;
  canMove?: boolean;
}

// ── Card (sortable) ──────────────────────────────────────────────────────────

function TaskCard({
  task,
  onOpen,
  overlay = false,
}: {
  task: ProjectTask;
  onOpen?: () => void;
  overlay?: boolean;
}) {
  const t = useTranslations('kanbanBoard');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { task, type: 'card' } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  };

  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        data-testid={`task-card-placeholder-${task.taskCode}`}
        className="h-[72px] rounded-[--radius-button] border-2 border-dashed border-brand-primary/30 bg-brand-primary-light/20"
      />
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={onOpen}
      data-testid={overlay ? `task-card-overlay-${task.taskCode}` : `task-card-${task.taskCode}`}
      className={`cursor-grab rounded-[--radius-button] border border-surface-border bg-surface-card p-3 shadow-sm transition-shadow active:cursor-grabbing hover:shadow-md select-none ${
        overlay ? 'rotate-2 shadow-2xl ring-2 ring-brand-primary/30 scale-[1.02]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-text-body line-clamp-2">{task.title}</p>
        <TaskPriorityBadge priority={task.priority} />
      </div>
      {task.labels && task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span
              key={l.label.id}
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: `${l.label.color}22`, color: l.label.color }}
            >
              {l.label.name}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
        <span>{task.taskCode}</span>
        <div className="flex items-center gap-2">
          {task.storyPoints != null && (
            <span className="rounded bg-surface-page px-1.5 py-0.5">{t('ptsSuffix', { count: task.storyPoints })}</span>
          )}
          {!!task._count?.comments && (
            <span className="flex items-center gap-0.5">
              <MessageSquare className="h-3 w-3" />{task._count.comments}
            </span>
          )}
          {!!task._count?.attachments && (
            <span className="flex items-center gap-0.5">
              <Paperclip className="h-3 w-3" />{task._count.attachments}
            </span>
          )}
          {!!task._count?.childTasks && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="h-3 w-3" />{task._count.childTasks}
            </span>
          )}
        </div>
      </div>
      {task.assignees && task.assignees.length > 0 && (
        <div className="mt-2 flex -space-x-2 rtl:space-x-reverse">
          {task.assignees.slice(0, 4).map((a) => (
            <div
              key={a.id}
              title={a.fullName}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface-card bg-brand-primary-light/60 text-[10px] font-semibold text-brand-primary"
            >
              {a.fullName.slice(0, 2).toUpperCase()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Quick-add form ───────────────────────────────────────────────────────────

function QuickAddForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (d: QuickCreateData) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations('kanbanBoard');
  const te = useTranslations('projectEnums');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const PRIORITIES = [
    { value: 'LOW', label: te('priorityLow') },
    { value: 'MEDIUM', label: te('priorityMedium') },
    { value: 'HIGH', label: te('priorityHigh') },
    { value: 'URGENT', label: te('priorityUrgent') },
  ];

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try { await onSubmit({ title: title.trim(), priority, dueDate: dueDate || undefined }); }
    finally { setSaving(false); }
  };

  return (
    <div data-testid="kanban-quick-add" className="rounded-[--radius-button] border border-surface-border bg-surface-card p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-text-heading">{t('createNewTaskHeading')}</span>
        <button onClick={onCancel} data-testid="kanban-quick-add-close" className="text-text-muted hover:text-text-body">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <input
        autoFocus
        value={title}
        data-testid="kanban-quick-add-title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
        placeholder={t('whatNeedsDonePlaceholder')}
        className="mb-2 w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-2.5 py-1.5 text-sm text-text-body placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
      />
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-text-muted">{t('dueDateLabel')}</label>
          <input
            type="date"
            value={dueDate}
            data-testid="kanban-quick-add-due-date"
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-2 py-1 text-xs text-text-body"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-text-muted">{t('priorityLabel')}</label>
          <select
            value={priority}
            data-testid="kanban-quick-add-priority"
            onChange={(e) => setPriority(e.target.value)}
            className="w-full rounded-[--radius-button] border border-surface-border bg-surface-page px-2 py-1 text-xs text-text-body"
          >
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          data-testid="kanban-quick-add-cancel"
          className="rounded-[--radius-button] px-3 py-1 text-xs text-text-body hover:bg-surface-page"
        >
          {t('cancelBtn')}
        </button>
        <button
          onClick={submit}
          disabled={saving || !title.trim()}
          data-testid="kanban-quick-add-submit"
          className="flex items-center gap-1 rounded-[--radius-button] bg-brand-primary px-3 py-1 text-xs font-medium text-text-on-brand hover:bg-brand-primary-dark disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />} {t('createTaskBtn')}
        </button>
      </div>
    </div>
  );
}

// ── Column ───────────────────────────────────────────────────────────────────

function Column({
  column,
  onOpenTask,
  onQuickCreate,
  canCreate,
  isDragOver,
}: {
  column: KanbanColumn;
  onOpenTask: (t: ProjectTask) => void;
  onQuickCreate?: (statusId: string, data: QuickCreateData) => Promise<void>;
  canCreate?: boolean;
  isDragOver?: boolean;
}) {
  const t = useTranslations('kanbanBoard');
  const { setNodeRef } = useDroppable({ id: column.id, data: { type: 'column', columnId: column.id } });
  const [adding, setAdding] = useState(false);
  const taskIds = useMemo(() => column.tasks.map((t) => t.id), [column.tasks]);

  return (
    <div data-testid={`kanban-column-${column.id}`} className="group/col flex w-72 flex-shrink-0 flex-col rounded-[--radius-card] bg-surface-page">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: column.color }} />
          <span className="text-sm font-semibold text-text-heading">{column.name}</span>
          <span data-testid={`kanban-column-count-${column.id}`} className="rounded-full bg-surface-border-light px-2 py-0.5 text-xs text-text-muted">
            {column.tasks.length}
          </span>
        </div>
        {canCreate && onQuickCreate && !adding && (
          <button
            onClick={() => setAdding(true)}
            data-testid={`kanban-column-add-${column.id}`}
            className="flex items-center gap-1 rounded-[--radius-button] px-1.5 py-1 text-xs text-text-muted opacity-0 transition hover:bg-surface-border-light hover:text-text-body group-hover/col:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" /> {t('addTaskBtn')}
          </button>
        )}
      </div>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          data-testid={`kanban-column-dropzone-${column.id}`}
          className={`flex-1 space-y-2 rounded-[--radius-button] p-2 transition-colors duration-150 min-h-[60px] ${
            isDragOver ? 'bg-brand-primary-light/25 ring-2 ring-inset ring-brand-primary/25' : ''
          }`}
        >
          {adding && onQuickCreate && (
            <QuickAddForm
              onSubmit={async (d) => { await onQuickCreate(column.id, d); setAdding(false); }}
              onCancel={() => setAdding(false)}
            />
          )}
          {column.tasks.map((t) => (
            <TaskCard key={t.id} task={t} onOpen={() => onOpenTask(t)} />
          ))}
          {column.tasks.length === 0 && !adding && (
            <div data-testid={`kanban-column-empty-${column.id}`} className={`rounded-[--radius-button] border border-dashed py-8 text-center text-xs text-text-muted transition-colors duration-150 ${
              isDragOver ? 'border-brand-primary/40 text-brand-primary' : 'border-surface-border'
            }`}>
              {t('dropTasksHereEmpty')}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export default function KanbanBoard({ columns: propColumns, onMove, onOpenTask, onQuickCreate, canCreate, canMove = true }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [cols, setCols] = useState<KanbanColumn[]>(propColumns);
  const [activeTask, setActiveTask] = useState<ProjectTask | null>(null);
  const [overColId, setOverColId] = useState<string | null>(null);
  const isDragging = useRef(false);

  // Sync parent → local only when not dragging
  useEffect(() => {
    if (!isDragging.current) setCols(propColumns);
  }, [propColumns]);

  const taskById = useMemo(() => {
    const map: Record<string, ProjectTask> = {};
    cols.forEach((c) => c.tasks.forEach((t) => (map[t.id] = t)));
    return map;
  }, [cols]);

  const findColByTaskId = useCallback(
    (taskId: string) => cols.find((c) => c.tasks.some((t) => t.id === taskId)),
    [cols],
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    isDragging.current = true;
    setActiveTask(taskById[active.id as string] || null);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) { setOverColId(null); return; }

    const activeId = active.id as string;
    const overId = over.id as string;

    const srcCol = findColByTaskId(activeId);
    if (!srcCol) return;

    // Determine target column
    let dstColId: string;
    const overIsCol = cols.some((c) => c.id === overId);
    if (overIsCol) {
      dstColId = overId;
    } else {
      const colWithOver = findColByTaskId(overId);
      if (!colWithOver) return;
      dstColId = colWithOver.id;
    }

    setOverColId(dstColId);

    if (srcCol.id === dstColId) {
      // Within-column reorder
      const oldIdx = srcCol.tasks.findIndex((t) => t.id === activeId);
      const newIdx = srcCol.tasks.findIndex((t) => t.id === overId);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        setCols((prev) =>
          prev.map((c) =>
            c.id === srcCol.id
              ? { ...c, tasks: arrayMove(c.tasks, oldIdx, newIdx) }
              : c,
          ),
        );
      }
    } else {
      // Cross-column move — update visual immediately
      const task = srcCol.tasks.find((t) => t.id === activeId);
      if (!task) return;

      const overTaskIdx = cols.find((c) => c.id === dstColId)?.tasks.findIndex((t) => t.id === overId) ?? -1;

      setCols((prev) => {
        const filtered = prev.map((c) =>
          c.id === srcCol.id ? { ...c, tasks: c.tasks.filter((t) => t.id !== activeId) } : c,
        );
        return filtered.map((c) => {
          if (c.id !== dstColId) return c;
          const tasks = [...c.tasks];
          const insertAt = overTaskIdx === -1 ? tasks.length : overTaskIdx;
          tasks.splice(insertAt, 0, { ...task, statusId: dstColId });
          return { ...c, tasks };
        });
      });
    }
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    isDragging.current = false;
    setActiveTask(null);
    setOverColId(null);

    if (!over) return;

    const activeId = active.id as string;

    // Find where the card ended up after onDragOver mutations
    const dstCol = cols.find((c) => c.tasks.some((t) => t.id === activeId));
    const originalCol = propColumns.find((c) => c.tasks.some((t) => t.id === activeId));

    if (dstCol && originalCol && dstCol.id !== originalCol.id) {
      if (!canMove) {
        setCols(propColumns); // revert optimistic UI
        triggerPermissionError("You don't have permission to move tasks in this project.");
        return;
      }
      onMove(activeId, dstCol.id);
    }
  };

  const onDragCancel = () => {
    isDragging.current = false;
    setActiveTask(null);
    setOverColId(null);
    setCols(propColumns); // revert
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div data-testid="kanban-board" className="flex gap-4 overflow-x-auto pb-4">
        {cols.map((c) => (
          <Column
            key={c.id}
            column={c}
            onOpenTask={onOpenTask}
            onQuickCreate={onQuickCreate}
            canCreate={canCreate}
            isDragOver={overColId === c.id}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{
        duration: 200,
        easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
      }}>
        {activeTask ? <TaskCard task={activeTask} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
