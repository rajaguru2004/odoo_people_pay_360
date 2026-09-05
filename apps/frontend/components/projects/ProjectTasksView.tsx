'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, LayoutGrid, List, Loader2, Settings2, GanttChartSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useProjectPermissions } from '@/hooks/useProjectPermissions';
import projectTaskService from '@/services/projectTaskService';
import projectService from '@/services/projectService';
import KanbanBoard, { QuickCreateData } from '@/components/projects/KanbanBoard';
import ProjectTaskList, { ListQuickCreateData } from '@/components/projects/ProjectTaskList';
import TaskDetailDrawer from '@/components/projects/TaskDetailDrawer';
import WorkflowSettingsModal from '@/components/projects/WorkflowSettingsModal';
import ProjectGantt from '@/components/projects/ProjectGantt';
import type {
  Project, ProjectTask, ProjectTaskStatus, Label, KanbanColumn,
} from '@/types/project';

interface Props {
  project: Project;
  view: 'list' | 'kanban' | 'gantt';
}

export default function ProjectTasksView({ project, view: initialView }: Props) {
  const t = useTranslations('projectTasksView');
  const { can } = useProjectPermissions(project.id);
  const router = useRouter();
  const [view, setView] = useState<'list' | 'kanban' | 'gantt'>(initialView);
  const [loading, setLoading] = useState(true);
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [statuses, setStatuses] = useState<ProjectTaskStatus[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [showWorkflow, setShowWorkflow] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusesRes, labelsRes, membersRes] = (await Promise.all([
        projectTaskService.getStatuses(project.id),
        projectTaskService.getLabels(project.id),
        projectService.getMembers(project.id),
      ])) as [any, any, any];
      setStatuses(statusesRes.data || []);
      setLabels(labelsRes.data || []);
      setMembers(membersRes.data || []);

      if (view === 'kanban') {
        const k = (await projectTaskService.kanban(project.id)) as any;
        setColumns(k.data?.columns || []);
      } else if (view === 'list') {
        const l = (await projectTaskService.list(project.id)) as any;
        setTasks(l.data || []);
      }
      // gantt fetches its own data internally
    } finally {
      setLoading(false);
    }
  }, [project.id, view]);

  useEffect(() => { load(); }, [load]);

  const handleMove = async (taskId: string, statusId: string) => {
    // optimistic
    setColumns((cols) => {
      const next = cols.map((c) => ({ ...c, tasks: c.tasks.filter((t) => t.id !== taskId) }));
      let moved: ProjectTask | undefined;
      cols.forEach((c) => { const f = c.tasks.find((t) => t.id === taskId); if (f) moved = f; });
      if (moved) {
        const target = next.find((c) => c.id === statusId);
        if (target) target.tasks.unshift({ ...moved, statusId });
      }
      return next;
    });
    try {
      await projectTaskService.moveStatus(taskId, statusId);
    } catch {
      load(); // revert on failure
    }
  };

  const openTask = (t: ProjectTask) => setOpenTaskId(t.id);

  const quickCreateKanban = async (statusId: string, data: QuickCreateData) => {
    const tempId = `temp-${Date.now()}`;
    const status = statuses.find((s) => s.id === statusId);
    const tempTask: any = {
      id: tempId, title: data.title, priority: data.priority, statusId,
      workflowStatus: status, type: 'TASK', taskCode: '···', assignees: [], labels: [], _isTemp: true,
    };
    setColumns((cols) => cols.map((c) =>
      c.id === statusId ? { ...c, tasks: [...c.tasks, tempTask] } : c,
    ));
    try {
      const res = await projectTaskService.create({
        projectId: project.id, title: data.title, priority: data.priority,
        statusId, dueDate: data.dueDate, type: 'TASK',
      }) as any;
      const real = res.data;
      setColumns((cols) => cols.map((c) => ({
        ...c, tasks: c.tasks.map((t) => (t.id === tempId ? real : t)),
      })));
    } catch {
      setColumns((cols) => cols.map((c) => ({
        ...c, tasks: c.tasks.filter((t) => t.id !== tempId),
      })));
    }
  };

  const quickCreateList = async (data: ListQuickCreateData) => {
    const tempId = `temp-${Date.now()}`;
    const status = statuses.find((s) => s.id === data.statusId);
    const tempTask: any = {
      id: tempId, title: data.title, priority: data.priority, statusId: data.statusId,
      workflowStatus: status, type: 'TASK', taskCode: '···',
      assignees: (data.assigneeIds || []).map((id: string) => {
        const m = members.find((m: any) => m.employee?.id === id);
        return m?.employee || { id };
      }),
      labels: [], _isTemp: true,
    };
    setTasks((prev) => [...prev, tempTask]);
    try {
      const res = await projectTaskService.create({
        projectId: project.id, title: data.title, priority: data.priority,
        statusId: data.statusId, assigneeIds: data.assigneeIds, dueDate: data.dueDate, type: 'TASK',
      }) as any;
      const real = res.data;
      setTasks((prev) => prev.map((t) => (t.id === tempId ? real : t)));
    } catch {
      setTasks((prev) => prev.filter((t) => t.id !== tempId));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-[--radius-button] border border-surface-border bg-surface-card p-1">
          <button onClick={() => setView('list')} data-testid="project-view-list"
            className={`flex items-center gap-1.5 rounded-[--radius-button] px-3 py-1.5 text-sm transition ${view === 'list' ? 'bg-brand-primary text-text-on-brand' : 'text-text-muted hover:text-text-body'}`}>
            <List className="h-4 w-4" /> {t('viewList')}
          </button>
          <button onClick={() => setView('kanban')} data-testid="project-view-kanban"
            className={`flex items-center gap-1.5 rounded-[--radius-button] px-3 py-1.5 text-sm transition ${view === 'kanban' ? 'bg-brand-primary text-text-on-brand' : 'text-text-muted hover:text-text-body'}`}>
            <LayoutGrid className="h-4 w-4" /> {t('viewBoard')}
          </button>
          <button onClick={() => setView('gantt')} data-testid="project-view-gantt"
            className={`flex items-center gap-1.5 rounded-[--radius-button] px-3 py-1.5 text-sm transition ${view === 'gantt' ? 'bg-brand-primary text-text-on-brand' : 'text-text-muted hover:text-text-body'}`}>
            <GanttChartSquare className="h-4 w-4" /> {t('viewGantt')}
          </button>
        </div>
        <div className="flex gap-2">
          {view === 'kanban' && can('STATUS_MANAGE') && (
            <button
              onClick={() => setShowWorkflow(true)}
              data-testid="workflow-settings-open"
              className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body hover:bg-surface-page"
              title={t('workflowSettingsTooltip')}
            >
              <Settings2 className="h-4 w-4" />
            </button>
          )}
          <button onClick={load} data-testid="task-refresh" className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body hover:bg-surface-page">
            <RefreshCw className="h-4 w-4" />
          </button>
          {can('TASK_CREATE') && (
            <button
              onClick={() => router.push(`/dashboard/projects/${project.slug}/tasks/new`)}
              data-testid="task-new"
              className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark"
            >
              <Plus className="h-4 w-4" /> {t('newTaskBtn')}
            </button>
          )}
        </div>
      </div>

      {view === 'gantt' ? (
        <ProjectGantt project={project} />
      ) : loading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-brand-primary" /></div>
      ) : view === 'kanban' ? (
        <KanbanBoard columns={columns} onMove={handleMove} onOpenTask={openTask}
          onQuickCreate={quickCreateKanban} canCreate={can('TASK_CREATE')} canMove={can('TASK_STATUS_UPDATE')} />
      ) : (
        <ProjectTaskList tasks={tasks} statuses={statuses} members={members} onOpenTask={openTask}
          onQuickCreate={quickCreateList} canCreate={can('TASK_CREATE')} />
      )}

      <TaskDetailDrawer taskId={openTaskId} slug={project.slug} onClose={() => setOpenTaskId(null)} onChanged={load} />

      <WorkflowSettingsModal
        projectId={project.id}
        open={showWorkflow}
        onClose={() => setShowWorkflow(false)}
        onChanged={load}
      />
    </div>
  );
}
