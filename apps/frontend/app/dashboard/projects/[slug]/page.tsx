'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Settings, Users, LayoutGrid, ListTodo, Loader2,
  Pencil, Calendar, CalendarRange, Rocket, Activity, Trash2, AlertCircle,
} from 'lucide-react';
import { ArrowLeftIcon } from '@/components/common/icons/directional';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { useProjectPermissions } from '@/hooks/useProjectPermissions';
import projectService from '@/services/projectService';
import { apiErrorMessage } from '@/utils/apiError';
import { formatWallClockDate } from '@/utils/formatters';
import NewProjectModal from '@/components/projects/NewProjectModal';
import ProjectMembers from '@/components/projects/ProjectMembers';
import ProjectRolesManager from '@/components/projects/ProjectRolesManager';
import ProjectTasksView from '@/components/projects/ProjectTasksView';
import ProjectAnalytics from '@/components/projects/ProjectAnalytics';
import ProjectSprints from '@/components/projects/ProjectSprints';
import ProjectCalendar from '@/components/projects/ProjectCalendar';
import ProjectActivityLog from '@/components/projects/ProjectActivityLog';
import { ProjectStatusBadge, ProjectPriorityBadge } from '@/components/projects/ProjectBadges';
import type { Project } from '@/types/project';

type Tab = 'overview' | 'tasks' | 'calendar' | 'sprints' | 'members' | 'activity' | 'settings';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [showEdit, setShowEdit] = useState(false);
  const { can } = useProjectPermissions(project?.id);
  const t = useTranslations('projectDetailPage');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await projectService.getBySlug(slug)) as any;
      setProject(res.data);
    } catch {
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { if (slug) load(); }, [slug, load]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!project) {
    return (
      <div data-testid="project-detail-notfound" className="py-16 text-center text-text-muted">
        {t('notFound')}
        <button onClick={() => router.push('/dashboard/projects')} data-testid="project-back" className="ms-2 text-brand-primary underline">{t('backToProjectsBtn')}</button>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: any }[] = [
    { key: 'overview', label: t('tabOverview'), icon: LayoutGrid },
    { key: 'tasks', label: t('tabTasks'), icon: ListTodo },
    { key: 'calendar', label: t('tabCalendar'), icon: CalendarRange },
    { key: 'sprints', label: t('tabSprints'), icon: Rocket },
    { key: 'members', label: t('tabMembers'), icon: Users },
    { key: 'activity', label: t('tabActivity'), icon: Activity },
    { key: 'settings', label: t('tabSettings'), icon: Settings },
  ];

  return (
    <ProtectedRoute requiredPermission="VIEW_PROJECTS">
      <div className="space-y-5" data-testid="ess-project-detail">
        {/* Header */}
        <div>
          <button onClick={() => router.push('/dashboard/projects')} data-testid="project-back" className="mb-3 flex items-center gap-1 text-sm text-text-muted hover:text-text-body">
            <ArrowLeftIcon className="h-4 w-4" /> {t('projectsBackLabel')}
          </button>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-[--radius-button] text-base font-bold text-white" style={{ backgroundColor: project.color }}>
                {project.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-text-heading">{project.name}</h1>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-text-muted">{project.projectCode}</span>
                  <ProjectStatusBadge status={project.status} />
                  <ProjectPriorityBadge priority={project.priority} />
                </div>
              </div>
            </div>
            {can('PROJECT_EDIT') && (
              <button onClick={() => setShowEdit(true)} data-testid="project-edit" className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2 text-sm text-text-body hover:bg-surface-page">
                <Pencil className="h-4 w-4" /> {t('editBtn')}
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div data-testid="project-tabs" className="flex gap-1 border-b border-surface-border">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} data-testid={`project-tab-${t.key}`}
              className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                tab === t.key ? 'border-brand-primary text-brand-primary' : 'border-transparent text-text-muted hover:text-text-body'
              }`}>
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'overview' && <OverviewTab project={project} />}
        {tab === 'tasks' && <ProjectTasksView project={project} view="list" />}
        {tab === 'calendar' && <ProjectCalendar project={project} />}
        {tab === 'sprints' && <ProjectSprints projectId={project.id} />}
        {tab === 'members' && <ProjectMembers projectId={project.id} />}
        {tab === 'activity' && <ProjectActivityLog projectId={project.id} />}
        {tab === 'settings' && <SettingsTab project={project} onEdit={() => setShowEdit(true)} onChanged={load} />}

        <NewProjectModal open={showEdit} project={project} onClose={() => setShowEdit(false)} onSaved={load} />
      </div>
    </ProtectedRoute>
  );
}

function OverviewTab({ project }: { project: Project }) {
  const t = useTranslations('projectDetailPage');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');
  const fmt = (d?: string) => (d ? formatWallClockDate(d) : '—');

  const VISIBILITY_LABELS: Record<string, string> = {
    PRIVATE: te('visibilityPrivate'),
    INTERNAL: te('visibilityInternal'),
    PUBLIC: te('visibilityPublic'),
  };

  return (
    <div className="space-y-5">
    <ProjectAnalytics slug={project.slug} />
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
          <h3 className="mb-2 font-semibold text-text-heading">{t('descriptionHeading')}</h3>
          <p data-testid="project-overview-description" className="text-sm text-text-body whitespace-pre-wrap">{project.description || t('emptyNoDescription')}</p>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[
            { key: 'tasks', label: t('statTasks'), value: project._count?.tasks ?? 0 },
            { key: 'members', label: t('statMembers'), value: project._count?.members ?? 0 },
            { key: 'sprints', label: t('statSprints'), value: project._count?.sprints ?? 0 },
          ].map((s) => (
            <div key={s.label} data-testid={`project-overview-stat-${s.key}`} className="rounded-[--radius-card] border border-surface-border bg-surface-card p-4 text-center">
              <p className="text-2xl font-bold text-text-heading">{s.value}</p>
              <p className="text-xs text-text-muted">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-[--radius-card] border border-surface-border bg-surface-card p-5 text-sm">
        <Detail testId="owner" label={t('ownerLabel')} value={project.owner?.fullName || '—'} />
        <Detail testId="department" label={tc('department')} value={project.department?.name || '—'} />
        <Detail testId="team" label={tc('team')} value={project.team?.name || '—'} />
        <Detail testId="visibility" label={t('visibilityLabel')} value={VISIBILITY_LABELS[project.visibility] ?? project.visibility} />
        <Detail testId="start-date" label={tc('startDate')} value={fmt(project.startDate)} icon={<Calendar className="h-3.5 w-3.5" />} />
        <Detail testId="end-date" label={tc('endDate')} value={fmt(project.endDate)} icon={<Calendar className="h-3.5 w-3.5" />} />
      </div>
    </div>
    </div>
  );
}

function Detail({ label, value, icon, testId }: { label: string; value: string; icon?: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between" data-testid={testId ? `project-detail-${testId}` : undefined}>
      <span className="text-text-muted">{label}</span>
      <span className="flex items-center gap-1 font-medium text-text-body">{icon}{value}</span>
    </div>
  );
}

function SettingsTab({ project, onEdit, onChanged }: { project: Project; onEdit: () => void; onChanged: () => void }) {
  const t = useTranslations('projectDetailPage');
  const router = useRouter();
  const { can } = useProjectPermissions(project.id);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const toggleArchive = async () => {
    if (project.isArchived) await projectService.unarchive(project.id);
    else await projectService.archive(project.id);
    onChanged();
  };

  /**
   * R22 — `DELETE /projects/:id` was unreachable from the UI.
   *
   * `PROJECT_DELETE` is one of the twelve catalogued project permissions. It is
   * granted, it is enforced by `ProjectPermissionGuard`, it is covered at the
   * API — and no screen could invoke it. The danger zone stopped at archive, so
   * an admin holding the permission (their own `my-permissions` says so) had no
   * way to exercise it, tab by tab, anywhere on this page.
   *
   * Gated on the project permission rather than a global role, like every other
   * control here, and guarded by the same `confirm()` mechanism
   * `ProjectRolesManager.removeRole` uses — a native prompt naming the project,
   * because "are you sure?" against the wrong project is the mistake it exists
   * to catch.
   *
   * The confirmation says what the server actually does. `ProjectsService.remove`
   * writes `deletedAt`, so the row survives; what does not survive is any route
   * back to it from this app. Calling that "permanent" would be a lie and
   * calling it "reversible" would be a worse one.
   */
  const removeProject = async () => {
    if (!confirm(t('deleteConfirmMessage', { name: project.name }))) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await projectService.delete(project.id);
      router.push('/dashboard/projects');
    } catch (e) {
      setDeleteError(apiErrorMessage(e, t('deleteFailedFallback')));
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="max-w-xl space-y-4">
        <div className="rounded-[--radius-card] border border-surface-border bg-surface-card p-5">
          <h3 className="font-semibold text-text-heading">{t('settingsGeneralHeading')}</h3>
          <p className="mt-1 text-sm text-text-muted">{t('settingsGeneralDesc')}</p>
          {can('PROJECT_EDIT') && (
            <button onClick={onEdit} data-testid="project-settings-edit" className="mt-3 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark">{t('editProjectBtn')}</button>
          )}
        </div>
        {(can('PROJECT_ARCHIVE') || can('PROJECT_DELETE')) && (
          <div className="rounded-[--radius-card] border border-status-error/30 bg-status-error-bg/40 p-5">
            <h3 className="font-semibold text-status-error">{t('dangerZoneHeading')}</h3>
            {can('PROJECT_ARCHIVE') && (
              <>
                <p className="mt-1 text-sm text-text-muted">{project.isArchived ? t('archivedNote') : t('archiveNote')}</p>
                <button onClick={toggleArchive} data-testid={project.isArchived ? 'project-unarchive' : 'project-archive'} className="mt-3 rounded-[--radius-button] border border-status-error/40 px-4 py-2 text-sm font-medium text-status-error hover:bg-status-error-bg">
                  {project.isArchived ? t('unarchiveBtn') : t('archiveBtn')}
                </button>
              </>
            )}
            {can('PROJECT_DELETE') && (
              <div className={can('PROJECT_ARCHIVE') ? 'mt-5 border-t border-status-error/20 pt-4' : 'mt-1'}>
                <p className="text-sm text-text-muted">{t('deleteNote')}</p>
                <button
                  onClick={removeProject}
                  disabled={deleting}
                  data-testid="project-delete"
                  className="mt-3 flex items-center gap-2 rounded-[--radius-button] bg-status-error px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  {t('deleteBtn')}
                </button>
                {deleteError && (
                  <p data-testid="project-delete-error" className="mt-2 flex items-center gap-1.5 text-sm text-status-error">
                    <AlertCircle className="h-4 w-4 shrink-0" />{deleteError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {can('ROLE_MANAGE') && <ProjectRolesManager projectId={project.id} />}
    </div>
  );
}
