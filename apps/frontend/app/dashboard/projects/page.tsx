'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import {
  Plus, Search, FolderKanban, CheckCircle2, Activity, PauseCircle,
  RefreshCw, Users, ListTodo, Archive,
} from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageActionRow from '@/components/common/PageActionRow';
import { usePermission } from '@/hooks/usePermission';
import { usePageHeader } from '@/hooks/usePageHeader';
import projectService from '@/services/projectService';
import { ProjectStatusBadge, ProjectPriorityBadge } from '@/components/projects/ProjectBadges';
import type { Project } from '@/types/project';

const STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export default function ProjectsPage() {
  const router = useRouter();
  const { can } = usePermission();
  const t = useTranslations('projectsListPage');
  const te = useTranslations('projectEnums');
  const tc = useTranslations('common');

  const STATUS_LABELS: Record<string, string> = {
    PLANNING: te('statusPlanning'),
    ACTIVE: te('statusActive'),
    ON_HOLD: te('statusOnHold'),
    COMPLETED: te('statusCompleted'),
    CANCELLED: te('statusCancelled'),
  };

  const PRIORITY_LABELS: Record<string, string> = {
    LOW: te('priorityLow'),
    MEDIUM: te('priorityMedium'),
    HIGH: te('priorityHigh'),
    URGENT: te('priorityUrgent'),
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  /**
   * R78. `buildWhere()` pins `isArchived: false` unless the query asks
   * otherwise, so before this filter existed an archived project vanished from
   * the only screen that lists projects and could be reached only by typing its
   * slug into the address bar. '' keeps the live default; 'true' asks for the
   * archive.
   */
  const [archivedFilter, setArchivedFilter] = useState('');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle', { count: projects.length }));

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [res, statsRes] = (await Promise.all([
        projectService.getAll({
          search: search || undefined,
          status: statusFilter || undefined,
          priority: priorityFilter || undefined,
          isArchived: archivedFilter === 'true' ? true : undefined,
          limit: 50,
        }),
        projectService.getStats(),
      ])) as [any, any];
      setProjects(res.data || []);
      setStats(statsRes.data);
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, priorityFilter, archivedFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const statCards = stats ? [
    { key: 'total', label: t('statTotal'), value: stats.total, icon: FolderKanban, color: 'from-brand-primary-light/35 to-brand-primary-light/50 text-brand-primary' },
    { key: 'active', label: te('statusActive'), value: stats.active, icon: Activity, color: 'from-status-success-bg to-status-success/30 text-status-success' },
    { key: 'on-hold', label: t('statOnHold'), value: stats.onHold, icon: PauseCircle, color: 'from-status-warning-bg to-status-warning/30 text-status-warning' },
    { key: 'completed', label: te('statusCompleted'), value: stats.completed, icon: CheckCircle2, color: 'from-surface-border-light to-surface-border text-text-muted' },
  ] : [];

  return (
    <ProtectedRoute requiredPermission="VIEW_PROJECTS">
      <div className="space-y-6" data-testid="ess-projects">
        {/* Actions only — the title/subtitle live in the sticky TopHeader,
            declared via usePageHeader above. */}
        <PageActionRow
          action={
            <>
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={fetchData}
                data-testid="project-refresh"
                className="flex items-center gap-2 rounded-[--radius-button] border border-surface-border bg-surface-card px-4 py-2.5 text-sm text-text-body hover:bg-surface-page transition-all shadow-sm">
                <RefreshCw className="h-4 w-4" />
              </motion.button>
              {can('CREATE_PROJECT') && (
                <motion.button
                  whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                  onClick={() => router.push('/dashboard/projects/new')}
                  data-testid="project-new"
                  className="flex items-center gap-2 rounded-[--radius-button] bg-brand-primary px-4 py-2.5 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark transition-all shadow-sm">
                  <Plus className="h-4 w-4" /> {t('newProjectBtn')}
                </motion.button>
              )}
            </>
          }
        />


        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {statCards.map((s) => (
            <div key={s.label} data-testid={`project-stat-${s.key}`} className={`rounded-[--radius-card] bg-gradient-to-br ${s.color} p-4 border border-surface-border`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium opacity-80">{s.label}</p>
                  <p className="text-2xl font-bold">{s.value ?? 0}</p>
                </div>
                <s.icon className="h-7 w-7 opacity-70" />
              </div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchPlaceholder')}
              data-testid="project-search"
              className="w-full rounded-[--radius-button] border border-surface-border bg-surface-card py-2.5 ps-10 pe-3 text-sm text-text-body focus:outline-none focus:ring-2 focus:ring-brand-primary/30" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            data-testid="project-status-filter"
            className="rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2.5 text-sm text-text-body">
            <option value="">{t('allStatusOption')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}
            data-testid="project-priority-filter"
            className="rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2.5 text-sm text-text-body">
            <option value="">{t('allPriorityOption')}</option>
            {PRIORITIES.map((s) => <option key={s} value={s}>{PRIORITY_LABELS[s]}</option>)}
          </select>
          <select value={archivedFilter} onChange={(e) => setArchivedFilter(e.target.value)}
            data-testid="project-archived-filter"
            className="rounded-[--radius-button] border border-surface-border bg-surface-card px-3 py-2.5 text-sm text-text-body">
            <option value="">{t('activeProjectsOption')}</option>
            <option value="true">{t('archivedProjectsOption')}</option>
          </select>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-[--radius-card] border border-surface-border bg-surface-card" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div data-testid="project-empty" className="flex flex-col items-center justify-center rounded-[--radius-card] border border-dashed border-surface-border bg-surface-card py-16 text-center">
            <FolderKanban className="h-12 w-12 text-text-muted" />
            <p className="mt-3 text-text-body font-medium">
              {archivedFilter === 'true' ? t('emptyNoArchivedProjects') : t('emptyNoProjects')}
            </p>
            {archivedFilter !== 'true' && can('CREATE_PROJECT') && (
              <button
                onClick={() => router.push('/dashboard/projects/new')}
                data-testid="project-create-first"
                className="mt-4 rounded-[--radius-button] bg-brand-primary px-4 py-2 text-sm font-medium text-text-on-brand hover:bg-brand-primary-dark">
                {t('createFirstProjectBtn')}
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <motion.div
                key={p.id} whileHover={{ y: -2 }}
                onClick={() => router.push(`/dashboard/projects/${p.slug}`)}
                data-testid={`project-card-${p.slug}`}
                className="cursor-pointer rounded-[--radius-card] border border-surface-border bg-surface-card p-5 shadow-sm transition hover:shadow-md flex flex-col"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[--radius-button] text-sm font-bold text-white"
                      style={{ backgroundColor: p.color }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <h3 className="font-semibold text-text-heading line-clamp-1">{p.name}</h3>
                      <p className="text-xs text-text-muted">{p.projectCode}</p>
                    </div>
                  </div>
                  {p.isArchived && <Archive className="h-4 w-4 text-text-muted" />}
                </div>

                {p.description && <p className="mt-3 text-sm text-text-muted line-clamp-2 flex-1">{p.description}</p>}

                <div className="mt-3 flex items-center gap-2">
                  <ProjectStatusBadge status={p.status} />
                  <ProjectPriorityBadge priority={p.priority} />
                </div>

                <div className="mt-4 flex items-center gap-4 border-t border-surface-border pt-3 text-xs text-text-muted">
                  <span className="flex items-center gap-1"><ListTodo className="h-3.5 w-3.5" /> {t('tasksCountSuffix', { count: p._count?.tasks ?? 0 })}</span>
                  <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {t('membersCountSuffix', { count: p._count?.members ?? 0 })}</span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
