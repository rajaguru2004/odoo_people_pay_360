'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, Plus, Users, Crown, AlertCircle, TrendingUp, BarChart3, Layers } from 'lucide-react';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';
import { Department } from '@/types/department';
import { Team } from '@/types/team';
import { motion } from 'framer-motion';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';

// Components
import DepartmentFilterPanel from '@/components/departments/DepartmentFilterPanel';
import DepartmentViewSwitcher, { DepartmentViewType } from '@/components/departments/DepartmentViewSwitcher';
import DepartmentCardView from '@/components/departments/DepartmentCardView';
import DepartmentTableView from '@/components/departments/DepartmentTableView';
import DepartmentOrgView from '@/components/departments/DepartmentOrgView';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function DepartmentsPage() {
  const router = useRouter();
  const { can } = usePermission();
  const t = useTranslations('departmentsListPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  // Data State
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  // UI State
  const [currentView, setCurrentView] = useState<DepartmentViewType>('card');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [managerFilter, setManagerFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  useEffect(() => {
    fetchDepartments();
  }, []);

  const fetchDepartments = useCallback(async () => {
    try {
      setLoading(true);
      const [deptsRes, teamsRes] = await Promise.all([
        departmentService.getAll(),
        teamService.getAll()
      ]);
      setDepartments(deptsRes.data);
      setTeams(teamsRes.data);
    } catch (error) {
      console.error('Failed to fetch departments:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Filter departments
  const filteredDepartments = departments.filter(dept => {
    // Search filter
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      const matchesSearch =
        dept.name.toLowerCase().includes(search) ||
        dept.code.toLowerCase().includes(search) ||
        dept.description?.toLowerCase().includes(search);
      if (!matchesSearch) return false;
    }

    // Status filter
    if (statusFilter === 'active' && !dept.isActive) return false;
    if (statusFilter === 'inactive' && dept.isActive) return false;

    // Manager filter
    if (managerFilter === 'assigned' && !dept.managerId) return false;
    if (managerFilter === 'unassigned' && dept.managerId) return false;

    // Type filter
    const isCEO = dept.code === 'CEO' || dept.name.includes('Director');
    const isMain = !dept.parentId && !isCEO;
    const isSub = !!dept.parentId;

    if (typeFilter === 'ceo' && !isCEO) return false;
    if (typeFilter === 'main' && !isMain) return false;
    if (typeFilter === 'sub' && !isSub) return false;

    return true;
  });

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (managerFilter !== 'all' ? 1 : 0) +
    (typeFilter !== 'all' ? 1 : 0);

  const clearFilters = () => {
    setStatusFilter('all');
    setManagerFilter('all');
    setTypeFilter('all');
    setSearchTerm('');
  };

  const handleExport = () => {
    // TODO: Implement export functionality
    console.log('Export departments');
  };

  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <>
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Heading lives in TopHeader via usePageHeader — only the action stays here. */}
          <PageActionRow
            action={
              can('MANAGE_DEPARTMENTS') && (
                <button
                  data-testid="dept-new"
                  onClick={() => router.push('/dashboard/departments/new')}
                  className="flex items-center gap-2 px-5 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-xl transition-all font-semibold shadow-lg"
                >
                  <Plus size={20} />
                  {t('addDepartment')}
                </button>
              )
            }
          />

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-brand-primary/40 hover:shadow-lg transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-[--radius-card] bg-brand-primary text-text-on-brand flex items-center justify-center shadow-lg">
                  <Building2 size={24} />
                </div>
                <div className="px-2 py-1 rounded-[--radius-badge] bg-brand-primary-light/20 border border-brand-primary/20 text-brand-primary">
                  <TrendingUp size={14} />
                </div>
              </div>
              <p className="text-sm font-semibold text-text-muted mb-1">{t('generalDepartment')}</p>
              <p data-testid="dept-stat-total" className="text-3xl font-bold text-text-heading">{departments.length}</p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-status-success/40 hover:shadow-lg transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-[--radius-card] bg-status-success text-white flex items-center justify-center shadow-lg">
                  <BarChart3 size={24} />
                </div>
                <span className="px-2 py-1 rounded-[--radius-badge] bg-status-success-bg text-status-success text-xs font-bold border border-status-success/20">
                  {Math.round((departments.filter(d => d.isActive).length / departments.length) * 100)}%
                </span>
              </div>
              <p className="text-sm font-semibold text-text-muted mb-1">{tc('active')}</p>
              <p data-testid="dept-stat-active" className="text-3xl font-bold text-text-heading">
                {departments.filter(d => d.isActive).length}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-brand-accent/40 hover:shadow-lg transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent text-text-on-accent flex items-center justify-center shadow-lg">
                  <Crown size={24} />
                </div>
                <div className="px-2 py-1 rounded-[--radius-badge] bg-brand-accent/15 border border-brand-accent/20 text-brand-accent">
                  <Layers size={14} />
                </div>
              </div>
              <p className="text-sm font-semibold text-text-muted mb-1">{t('highLevel')}</p>
              <p data-testid="dept-stat-toplevel" className="text-3xl font-bold text-text-heading">
                {departments.filter(d => !d.parentId).length}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-status-warning/40 hover:shadow-lg transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-[--radius-card] bg-status-warning text-white flex items-center justify-center shadow-lg">
                  <Users size={24} />
                </div>
                <span className="px-2 py-1 rounded-[--radius-badge] bg-status-warning-bg text-status-warning text-xs font-bold border border-status-warning/20">
                  {tc('teams')}
                </span>
              </div>
              <p className="text-sm font-semibold text-text-muted mb-1">{t('totalTeams')}</p>
              <p data-testid="dept-stat-teams" className="text-3xl font-bold text-text-heading">{teams.length}</p>
            </motion.div>
          </div>

          {/* Toolbar */}
          <DepartmentFilterPanel
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            managerFilter={managerFilter}
            onManagerChange={setManagerFilter}
            typeFilter={typeFilter}
            onTypeChange={setTypeFilter}
            activeFilterCount={activeFilterCount}
            onClearFilters={clearFilters}
            onExport={handleExport}
            resultCount={filteredDepartments.length}
            totalCount={departments.length}
          />

          {/* Content Area */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border overflow-hidden shadow-lg"
          >
            {/* View Switcher */}
            <div className="px-6 py-4 border-b-2 border-surface-border bg-surface-page">
              <DepartmentViewSwitcher currentView={currentView} onViewChange={setCurrentView} />
            </div>

            {currentView === 'card' && (
              <div className="p-6 space-y-8">
                <DepartmentCardView
                  departments={filteredDepartments}
                  onView={(id) => router.push(`/dashboard/departments/${id}`)}
                  loading={loading}
                />

                {/* Teams Section */}
                {!loading && teams.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent text-text-on-accent flex items-center justify-center shadow-lg">
                          <Users size={24} />
                        </div>
                        <div>
                          <h2 className="text-xl font-bold text-text-heading">{tc('teams')}</h2>
                          <p className="text-sm text-text-muted">
                            {t('teamsMembersCount', { teams: teams.length, members: teams.reduce((sum, t) => sum + (t._count?.members || 0), 0) })}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => router.push('/dashboard/teams')}
                        className="text-sm text-brand-primary hover:text-brand-primary-dark font-semibold"
                      >
                        {t('seeAllArrow')}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {teams.map((team) => (
                        <motion.div
                          key={team.id}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          onClick={() => router.push(`/dashboard/teams/${team.id}`)}
                          className="group bg-surface-card rounded-[--radius-card] border-2 border-surface-border hover:border-brand-accent/40 hover:shadow-xl transition-all cursor-pointer overflow-hidden flex flex-col h-full"
                        >
                          {/* Header with gradient */}
                          <div className="p-5 bg-brand-accent/5 border-b-2 border-surface-border-light">
                            <div className="flex items-start gap-3 mb-3">
                              <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent text-text-on-accent flex items-center justify-center shadow-lg">
                                <Users size={20} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-base text-text-heading mb-1 line-clamp-1 group-hover:text-brand-accent transition-colors">
                                  {team.name}
                                </h3>
                                <p className="text-sm text-text-muted font-semibold">{team.code}</p>
                              </div>
                              {!team.isActive && (
                                <span className="px-2 py-1 text-xs font-bold rounded-[--radius-badge] bg-status-error-bg text-status-error border border-status-error/20">
                                  {tc('inactive')}
                                </span>
                              )}
                            </div>
                            {/* Type Badge */}
                            <span className="inline-block px-3 py-1 text-xs font-bold rounded-[--radius-badge] bg-surface-card border-2 border-brand-accent/20 text-brand-accent">
                              {team.type === 'PERMANENT' ? t('typeFixed') : team.type === 'PROJECT' ? t('typeProject') : t('typeInterFunctional')}
                            </span>
                          </div>

                          {/* Content */}
                          <div className="p-5 space-y-4 flex-1 flex flex-col">
                            {/* Description */}
                            {team.description && (
                              <p className="text-sm text-text-body leading-relaxed line-clamp-2">
                                {team.description}
                              </p>
                            )}

                            {/* Members Count */}
                            <div className="flex items-center gap-2 px-4 py-3 bg-brand-accent/5 rounded-[--radius-card] border-2 border-brand-accent/10">
                              <Users className="text-brand-accent" size={18} />
                              <span className="text-lg font-bold text-brand-accent">{team._count?.members || 0}</span>
                              <span className="text-sm text-brand-accent/80 font-medium">{t('memberSingular')}</span>
                            </div>

                            {/* Footer pushed to bottom */}
                            <div className="mt-auto space-y-4 pt-2">
                              {/* Department */}
                              {team.department && (
                                <div className="pt-3 border-t-2 border-surface-border-light">
                                  <p className="text-xs text-text-muted font-semibold mb-1">{t('departmentsLabel')}</p>
                                  <p className="text-sm text-text-heading font-bold">{team.department.name}</p>
                                </div>
                              )}

                              {/* Team Lead */}
                              {team.teamLead ? (
                                <div className="flex items-center gap-3 p-3 bg-surface-page rounded-[--radius-card] border-2 border-surface-border-light">
                                  <div className="w-10 h-10 rounded-full bg-brand-accent flex items-center justify-center text-text-on-accent font-bold text-sm shadow-md">
                                    {team.teamLead.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-text-muted uppercase">{t('teamLead')}</p>
                                    <p className="text-sm font-bold text-text-heading truncate">{team.teamLead.fullName}</p>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 p-3 bg-status-warning-bg rounded-[--radius-card] border-2 border-status-warning/20">
                                  <AlertCircle size={16} className="text-status-warning" />
                                  <span className="text-sm font-bold text-status-warning">{t('noTeamLead')}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {currentView === 'table' && (
              <DepartmentTableView
                departments={filteredDepartments}
                onView={(id) => router.push(`/dashboard/departments/${id}`)}
                loading={loading}
              />
            )}

            {currentView === 'org-structure' && (
              <div className="p-6">
                <DepartmentOrgView
                  departments={filteredDepartments}
                  teams={teams}
                  onView={(id) => router.push(`/dashboard/departments/${id}`)}
                />
              </div>
            )}
          </motion.div>
        </div>
      </>
    </ProtectedRoute>
  );
}

