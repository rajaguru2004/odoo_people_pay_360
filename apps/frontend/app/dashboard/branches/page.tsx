'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, Plus, Users, Navigation, CheckCircle2, Search, LayoutGrid, List, Archive } from 'lucide-react';
import { motion } from 'framer-motion';

// RBAC
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePermission } from '@/hooks/usePermission';

// Data
import { useBranches, useDeleteBranch, useUpdateBranch } from '@/hooks/useBranches';
import { Branch } from '@/types/branch';

// Components
import BranchCard from '@/components/branches/BranchCard';
import BranchTableView from '@/components/branches/BranchTableView';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

type BranchViewType = 'card' | 'table';

function BranchCardSkeleton() {
  return (
    <div className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border p-6 animate-pulse">
      <div className="flex items-start gap-4 mb-4">
        <div className="w-12 h-12 bg-slate-200 rounded-[--radius-card]">{/* neutral */}</div>
        <div className="flex-1">
          <div className="h-5 bg-slate-200 rounded w-3/4 mb-2">{/* neutral */}</div>
          <div className="h-4 bg-slate-200 rounded w-1/2">{/* neutral */}</div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-4 bg-slate-200 rounded w-full">{/* neutral */}</div>
        <div className="flex gap-2">
          <div className="h-8 bg-slate-200 rounded w-24">{/* neutral */}</div>
          <div className="h-8 bg-slate-200 rounded w-24">{/* neutral */}</div>
        </div>
      </div>
    </div>
  );
}

export default function BranchesPage() {
  const router = useRouter();
  const { isAdmin, isHRManager } = usePermission();
  const t = useTranslations('branchesListPage');
  const tc = useTranslations('common');

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(t('title'), t('subtitle'));

  const canManage = isAdmin() || isHRManager();

  // Retired branches are hidden from this list AND 404 on the detail route, so
  // without this toggle a branch switched off by mistake could not be reached
  // again from anywhere in the UI.
  const [showInactive, setShowInactive] = useState(false);
  const { data, isLoading } = useBranches(true, showInactive);
  const branches: Branch[] = data?.data ?? [];
  const deleteBranch = useDeleteBranch();
  const updateBranch = useUpdateBranch();

  const [currentView, setCurrentView] = useState<BranchViewType>('card');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredBranches = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    if (!search) return branches;
    return branches.filter((branch) => {
      return (
        branch.name.toLowerCase().includes(search) ||
        branch.code.toLowerCase().includes(search) ||
        branch.city?.toLowerCase().includes(search) ||
        branch.country?.toLowerCase().includes(search) ||
        branch.description?.toLowerCase().includes(search)
      );
    });
  }, [branches, searchTerm]);

  const stats = useMemo(
    () => ({
      total: branches.length,
      active: branches.filter((b) => b.isActive).length,
      geofenced: branches.filter((b) => b.geofencingEnabled).length,
      employees: branches.reduce((sum, b) => sum + (b._count?.employees || 0), 0),
    }),
    [branches],
  );

  const handleView = (id: string) => router.push(`/dashboard/branches/${id}`);
  const handleEdit = (id: string) => router.push(`/dashboard/branches/${id}/edit`);

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('confirmDelete'))) return;
    try {
      await deleteBranch.mutateAsync(id);
      alert(t('deleteSuccess'));
    } catch (error: any) {
      alert(getApiErrorMessage(error, t('deleteFailed')));
    }
  };

  // Reactivation is the existing PATCH — the endpoint never blocked a retired
  // branch, only the UI had no way to reach one.
  const handleReactivate = async (id: string) => {
    if (!window.confirm(t('confirmReactivate'))) return;
    try {
      await updateBranch.mutateAsync({ id, data: { isActive: true } });
      alert(t('reactivateSuccess'));
    } catch (error: any) {
      alert(getApiErrorMessage(error, t('reactivateFailed')));
    }
  };

  const views: { id: BranchViewType; icon: typeof LayoutGrid; label: string }[] = [
    { id: 'card', icon: LayoutGrid, label: t('cardsView') },
    { id: 'table', icon: List, label: t('tableView') },
  ];

  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Heading lives in TopHeader via usePageHeader — only the action stays here. */}
        <PageActionRow
          action={
            canManage && (
              <button
                data-testid="branch-new"
                onClick={() => router.push('/dashboard/branches/new')}
                className="flex items-center gap-2 px-5 py-3 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-xl transition-all font-semibold shadow-lg"
              >
                <Plus size={20} />
                {t('addBranch')}
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
            <div className="w-12 h-12 rounded-[--radius-card] bg-brand-primary text-text-on-brand flex items-center justify-center shadow-lg mb-4">
              <Building2 size={24} />
            </div>
            <p className="text-sm font-semibold text-text-muted mb-1">{t('statTotal')}</p>
            <p data-testid="branch-stat-total" className="text-3xl font-bold text-text-heading">{stats.total}</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-status-success/40 hover:shadow-lg transition-all"
          >
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-success text-white flex items-center justify-center shadow-lg mb-4">
              <CheckCircle2 size={24} />
            </div>
            <p className="text-sm font-semibold text-text-muted mb-1">{t('statActive')}</p>
            <p data-testid="branch-stat-active" className="text-3xl font-bold text-text-heading">{stats.active}</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-brand-accent/40 hover:shadow-lg transition-all"
          >
            <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent text-text-on-accent flex items-center justify-center shadow-lg mb-4">
              <Navigation size={24} />
            </div>
            <p className="text-sm font-semibold text-text-muted mb-1">{t('statGeofenced')}</p>
            <p data-testid="branch-stat-geofenced" className="text-3xl font-bold text-text-heading">{stats.geofenced}</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="group bg-surface-card rounded-[--radius-card] p-6 border-2 border-surface-border hover:border-status-warning/40 hover:shadow-lg transition-all"
          >
            <div className="w-12 h-12 rounded-[--radius-card] bg-status-warning text-white flex items-center justify-center shadow-lg mb-4">
              <Users size={24} />
            </div>
            <p className="text-sm font-semibold text-text-muted mb-1">{t('statEmployees')}</p>
            <p data-testid="branch-stat-employees" className="text-3xl font-bold text-text-heading">{stats.employees}</p>
          </motion.div>
        </div>

        {/* Content Area */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border overflow-hidden shadow-lg"
        >
          {/* Toolbar: search + view switcher */}
          <div className="px-6 py-4 border-b-2 border-surface-border bg-surface-page flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
              <input
                data-testid="branch-search"
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="w-full ps-10 pe-4 py-2.5 border-2 border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-4 focus:ring-brand-primary/20 focus:border-brand-primary text-sm bg-surface-card text-text-body"
              />
            </div>

            <div className="flex items-center gap-3">
              {canManage && (
                <button
                  data-testid="branch-toggle-inactive"
                  type="button"
                  aria-pressed={showInactive}
                  onClick={() => setShowInactive((v) => !v)}
                  title={t('showInactiveHint')}
                  className={`flex items-center gap-2 px-3 py-2 rounded-[--radius-button] text-sm font-semibold border-2 transition-colors ${
                    showInactive
                      ? 'bg-brand-primary text-text-on-brand border-brand-primary'
                      : 'bg-surface-card text-text-muted border-surface-border hover:text-text-heading hover:border-brand-primary/40'
                  }`}
                >
                  <Archive size={16} />
                  <span className="hidden sm:inline">{t('showInactive')}</span>
                </button>
              )}
              <span className="text-sm text-text-muted font-medium hidden sm:inline">
                {t('resultCount', { shown: filteredBranches.length, total: branches.length })}
              </span>
              <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-[--radius-input]" /* neutral */>
                {views.map((view) => {
                  const Icon = view.icon;
                  const isActive = currentView === view.id;
                  return (
                    <button
                      key={view.id}
                      data-testid={`branch-view-${view.id}`}
                      onClick={() => setCurrentView(view.id)}
                      title={view.label}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-[--radius-button] text-sm font-medium transition-all ${
                        isActive
                          ? 'bg-surface-card text-brand-primary shadow-sm'
                          : 'text-text-muted hover:text-text-heading hover:bg-slate-50' /* neutral hover */
                      }`}
                    >
                      <Icon size={16} />
                      <span className="hidden sm:inline">{view.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Card view */}
          {currentView === 'card' && (
            <div className="p-6">
              {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <BranchCardSkeleton key={i} />
                  ))}
                </div>
              ) : filteredBranches.length === 0 ? (
                <div data-testid="branch-empty" className="text-center py-16">
                  <div className="w-16 h-16 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-3">
                    <Building2 className="text-text-muted" size={32} />
                  </div>
                  <p className="text-base font-semibold text-text-body mb-1">{t('noBranchesFound')}</p>
                  <p className="text-sm text-text-muted">{t('tryAdjustingSearch')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredBranches.map((branch) => (
                    <div
                      key={branch.id}
                      // A retired branch has no detail page to open — the card's
                      // reactivate button is its only action.
                      onClick={() => branch.isActive && handleView(branch.id)}
                      className={branch.isActive ? 'cursor-pointer h-full' : 'h-full'}
                    >
                      <BranchCard
                        branch={branch}
                        onEdit={canManage ? handleEdit : undefined}
                        onDelete={canManage ? handleDelete : undefined}
                        onReactivate={canManage ? handleReactivate : undefined}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Table view */}
          {currentView === 'table' && (
            <BranchTableView
              branches={filteredBranches}
              onView={handleView}
              onEdit={canManage ? handleEdit : undefined}
              onDelete={canManage ? handleDelete : undefined}
              onReactivate={canManage ? handleReactivate : undefined}
              loading={isLoading}
            />
          )}
        </motion.div>
      </div>
    </ProtectedRoute>
  );
}
