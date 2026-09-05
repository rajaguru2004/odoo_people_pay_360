'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  Edit, Trash2, Building2, Users, User, TrendingUp,
  Award, Target, Crown, UserPlus, FileText, History,
  BarChart3, Clock, CheckCircle2, AlertCircle,
  ArrowUpRight, Mail
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import departmentService from '@/services/departmentService';
import teamService from '@/services/teamService';
import { Department } from '@/types/department';
import { Team } from '@/types/team';
import PerformanceDashboard from '@/components/departments/PerformanceDashboard';
import ProtectedRoute from '@/components/auth/ProtectedRoute';

export default function DepartmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const t = useTranslations('departmentDetailPage');
  const tc = useTranslations('common');
  const { id } = use(params);
  const [department, setDepartment] = useState<Department | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [performanceData, setPerformanceData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // The one heading for this route, rendered by TopHeader — and the record crumb
  // PageBreadcrumbs appends, so the trail names the department rather than stopping
  // on All Departments and marking IT the current page. Above the early-returns so
  // the hook order never changes.
  usePageHeader(department?.name ?? t('breadcrumbDepartment'), department?.code ?? undefined);
  const [performanceLoading, setPerformanceLoading] = useState(true);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'employees' | 'teams' | 'performance' | 'history'>('overview');

  useEffect(() => {
    fetchDepartment();
    fetchPerformance();
  }, [id]);

  const fetchDepartment = async () => {
    try {
      setLoading(true);
      const [deptRes, teamsRes] = await Promise.all([
        departmentService.getById(id),
        teamService.getAll(id)
      ]);
      setDepartment(deptRes.data);
      setTeams(teamsRes.data);
    } catch (error) {
      console.error('Failed to fetch department:', error);
      alert(t('noDeptFound'));
      router.push('/dashboard/departments');
    } finally {
      setLoading(false);
    }
  };

  const fetchPerformance = async () => {
    try {
      setPerformanceLoading(true);
      const res = await departmentService.getPerformance(id);
      setPerformanceData(res.data);
    } catch (error) {
      console.error('Failed to fetch performance:', error);
    } finally {
      setPerformanceLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t('confirmDelete'))) return;

    try {
      await departmentService.delete(id);
      alert(t('deleteSuccess'));
      router.push('/dashboard/departments');
    } catch (error: any) {
      console.error('Failed to delete department:', error);
      // The axios interceptor rejects with a FLAT ApiError, so
      // `error.response.data.message` is always undefined — every refusal used
      // to collapse to the generic string, and the two rules that could have
      // caused it (staff, sub-departments) were indistinguishable.
      alert(getApiErrorMessage(error, t('deleteFailed')));
    }
  };

  const handleAppointManager = () => {
    router.push(`/dashboard/departments/${id}/edit`);
  };

  const handleTransferEmployee = () => {
    router.push(`/dashboard/employees?departmentId=${id}`);
  };

  const handleViewChangeRequests = () => {
    router.push('/dashboard/departments/change-requests');
  };

  const handleExportReport = async () => {
    try {
      alert(t('exportingReport'));
      // TODO: Implement export functionality
    } catch (error) {
      alert(t('exportFailed'));
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-slate-200 rounded w-48">{/* neutral */}</div>
          <div className="h-10 bg-slate-200 rounded w-96">{/* neutral */}</div>
          <div className="grid grid-cols-4 gap-4 mt-8">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-slate-100 rounded-xl">{/* neutral */}</div>
            ))}
          </div>
          <div className="h-64 bg-slate-100 rounded-xl mt-6">{/* neutral */}</div>
        </div>
      </div>
    );
  }

  if (!department) return null;

  const actionButtons = [
    {
      icon: Crown,
      label: t('actionAppointHeadLabel'),
      description: t('actionAppointHeadDesc'),
      bgColor: 'bg-brand-accent',
      onClick: handleAppointManager,
    },
    {
      icon: UserPlus,
      label: t('actionTransferStaffLabel'),
      description: t('actionTransferStaffDesc'),
      bgColor: 'bg-brand-primary',
      onClick: handleTransferEmployee,
    },
    {
      icon: History,
      label: t('actionChangeRequestsLabel'),
      description: t('actionChangeRequestsDesc'),
      bgColor: 'bg-brand-accent',
      onClick: handleViewChangeRequests,
    },
    {
      icon: FileText,
      label: t('actionExportReportLabel'),
      description: t('actionExportReportDesc'),
      bgColor: 'bg-status-success',
      onClick: handleExportReport,
    },
  ];

  return (
    <ProtectedRoute requiredPermission="VIEW_DEPARTMENTS">
      <div className="max-w-7xl mx-auto">
        {/* Back + this department's actions. The `Department > <name>` trail this
            row used to draw by hand is now the global one DashboardLayout renders
            for every route (PageBreadcrumbs) — drawing it here as well was two
            trails answering one question. */}
        <PageActionRow
          onBack={() => router.back()}
          action={
            <div className="flex gap-2 relative">
              <button
                data-testid="dept-detail-edit"
                onClick={() => router.push(`/dashboard/departments/${id}/edit`)}
                className="flex items-center gap-2 px-5 py-2.5 bg-surface-card border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page hover:border-surface-border/90 transition-all font-semibold shadow-sm hover:shadow-md cursor-pointer"
              >
                <Edit size={18} /> {t('editBtn')}
              </button>
              <div className="relative">
                <button
                  data-testid="dept-detail-actions"
                  onClick={() => setShowActionMenu(!showActionMenu)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all font-semibold cursor-pointer"
                >
                  {t('actionBtn')}
                </button>
                <AnimatePresence>
                  {showActionMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: -10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10, scale: 0.95 }}
                      className="absolute right-0 mt-2 w-72 bg-surface-overlay rounded-[--radius-card] shadow-2xl border border-surface-border overflow-hidden z-50"
                    >
                      <div className="p-2">
                        {actionButtons.map((action, index) => (
                          <button
                            key={index}
                            onClick={() => { action.onClick(); setShowActionMenu(false); }}
                            className="w-full flex items-center gap-3 p-3 rounded-[--radius-button] hover:bg-surface-page transition-all group cursor-pointer"
                          >
                            <div className={`w-10 h-10 rounded-[--radius-card] ${action.bgColor} flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform`}>
                              <action.icon className="text-white" size={18} />
                            </div>
                            <div className="text-left flex-1">
                              <p className="font-semibold text-text-heading text-sm">{action.label}</p>
                              <p className="text-xs text-text-muted">{action.description}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                      <div className="border-t border-surface-border p-2">
                        <button
                          data-testid="dept-detail-delete"
                          onClick={() => { handleDelete(); setShowActionMenu(false); }}
                          className="w-full flex items-center gap-3 p-3 rounded-[--radius-button] hover:bg-status-error-bg/10 transition-all group cursor-pointer"
                        >
                          <div className="w-10 h-10 rounded-[--radius-card] bg-status-error-bg flex items-center justify-center flex-shrink-0 group-hover:bg-status-error-bg/20 transition-colors">
                            <Trash2 className="text-status-error" size={18} />
                          </div>
                          <div className="text-left flex-1">
                            <p className="font-semibold text-status-error text-sm">{t('deleteDepartment')}</p>
                            <p className="text-xs text-status-error/85">{t('cannotUndo')}</p>
                          </div>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          }
        />

        {/* Header Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-r from-brand-primary to-brand-primary-dark rounded-[--radius-card] p-8 mb-6 text-text-on-brand shadow-2xl relative overflow-hidden"
        >
          {/* Background Pattern */}
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-0 end-0 w-96 h-96 bg-white rounded-full blur-3xl transform translate-x-1/2 -translate-y-1/2"></div>
            <div className="absolute bottom-0 start-0 w-96 h-96 bg-white rounded-full blur-3xl transform -translate-x-1/2 translate-y-1/2"></div>
          </div>
          <div className="relative z-10">
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-start gap-6">
                <div className="w-24 h-24 rounded-[--radius-card] bg-white/20 backdrop-blur-sm flex items-center justify-center border-2 border-white/30 shadow-xl">
                  <Building2 size={48} className="text-text-on-brand" />
                </div>
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h2 data-testid="dept-detail-name" className="text-4xl font-bold">{department.name}</h2>
                    <span className={`px-4 py-1.5 rounded-[--radius-badge] text-sm font-bold ${
                      department.isActive 
                        ? 'bg-status-success-bg text-status-success border border-status-success/20'
                        : 'bg-status-error-bg text-status-error border border-status-error/20'
                    }`}>
                      {department.isActive ? tc('active') : tc('inactive')}
                    </span>
                  </div>
                  <p className="text-brand-primary-light font-bold text-xl mb-4">{t('codeLabel')}{department.code}</p>
                  {department.description && (
                    <p className="text-white/90 max-w-3xl leading-relaxed text-lg">{department.description}</p>
                  )}
                  {department.parent && (
                    <div className="mt-4 flex items-center gap-2 text-text-on-brand bg-white/10 backdrop-blur-sm px-4 py-2 rounded-[--radius-card] border border-white/20 inline-flex">
                      <Building2 size={16} />
                      <span className="text-sm font-medium">{t('affiliatedWith')}</span>
                      <span className="font-bold">{department.parent.name}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Quick Stats in Header */}
            <div className="grid grid-cols-4 gap-4 mt-6">
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <div className="flex items-center justify-between mb-2">
                  <Users className="text-white/80" size={24} />
                  <ArrowUpRight className="text-green-300" size={16} />
                </div>
                <p className="text-3xl font-bold mb-1">{department._count?.employees || 0}</p>
                <p className="text-white/80 text-sm font-medium">{t('statStaff')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <div className="flex items-center justify-between mb-2">
                  <Building2 className="text-white/80" size={24} />
                  <CheckCircle2 className="text-green-300" size={16} />
                </div>
                <p className="text-3xl font-bold mb-1">{department._count?.children || 0}</p>
                <p className="text-white/80 text-sm font-medium">{t('statSubDepartments')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <div className="flex items-center justify-between mb-2">
                  <Target className="text-white/80" size={24} />
                  <TrendingUp className="text-purple-300" size={16} />
                </div>
                <p className="text-3xl font-bold mb-1">{teams.length}</p>
                <p className="text-white/80 text-sm font-medium">{tc('teams')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <div className="flex items-center justify-between mb-2">
                  <BarChart3 className="text-white/80" size={24} />
                  <Clock className="text-orange-300" size={16} />
                </div>
                <p className="text-3xl font-bold mb-1">{performanceData?.attendanceRate || 0}%</p>
                <p className="text-white/80 text-sm font-medium">{t('statAttendance')}</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Tabs Navigation */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-surface-card rounded-[--radius-card] p-2 mb-6 border border-surface-border shadow-sm"
        >
          <div className="flex gap-2">
            {[
              { id: 'overview', label: t('tabOverview'), icon: Building2 },
              { id: 'employees', label: t('tabEmployees'), icon: Users },
              { id: 'teams', label: t('tabTeams'), icon: Target },
              { id: 'performance', label: t('tabPerformance'), icon: TrendingUp },
              { id: 'history', label: t('tabHistory'), icon: History },
            ].map((tab) => (
              <button
                key={tab.id}
                data-testid={`dept-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-6 py-3 rounded-[--radius-button] font-semibold transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand shadow-lg'
                    : 'text-text-muted hover:bg-surface-page'
                }`}
              >
                <tab.icon size={18} />
                {tab.label}
              </button>
            ))}
          </div>
        </motion.div>

        {/* Tab Content */}
        <AnimatePresence mode="wait">
          {activeTab === 'overview' && (
            <motion.div
              key="overview"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              {/* Manager Info */}
              {department.manager ? (
                <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                      <Crown className="text-text-on-accent" size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-text-heading">{t('departmentManager')}</h3>
                      <p className="text-sm text-text-muted font-medium">{t('departmentManager')}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 p-6 bg-brand-accent/5 rounded-[--radius-card] border-2 border-brand-accent/20">
                    <div className="w-20 h-20 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center text-text-on-accent text-2xl font-bold shadow-xl">
                      {department.manager.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </div>
                    <div className="flex-1">
                      <h4 data-testid="dept-detail-manager" className="text-2xl font-bold text-text-heading mb-1">{department.manager.fullName}</h4>
                      <p className="text-brand-accent font-bold text-lg mb-3">{department.manager.position}</p>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="flex items-center gap-2 text-text-body">
                          <User size={16} className="text-text-muted" />
                          <span className="font-semibold">{department.manager.employeeCode}</span>
                        </div>
                        <div className="flex items-center gap-2 text-text-body">
                          <Mail size={16} className="text-text-muted" />
                          <span className="font-medium">{department.manager.email}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleAppointManager}
                      className="px-6 py-3 bg-surface-card border-2 border-brand-accent/35 text-brand-accent rounded-[--radius-button] hover:bg-brand-accent/10 transition-all font-bold shadow-sm cursor-pointer"
                    >
                      {t('changeBtn')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-surface-card rounded-[--radius-card] p-6 border-2 border-dashed border-surface-border">
                  <div className="text-center py-8">
                    <div className="w-16 h-16 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                      <AlertCircle className="text-text-muted" size={32} />
                    </div>
                    <h3 className="text-lg font-bold text-text-heading mb-2">{t('noDeptHead')}</h3>
                    <p className="text-text-muted mb-4">{t('noDeptHeadDesc')}</p>
                    <button
                      onClick={handleAppointManager}
                      className="px-6 py-3 bg-gradient-to-r from-brand-accent to-brand-accent-dark text-text-on-accent rounded-[--radius-button] hover:shadow-lg transition-all font-bold cursor-pointer"
                    >
                      <Crown size={18} className="inline me-2" /> {t('appointDeptHead')}
                    </button>
                  </div>
                </div>
              )}

              {/* Sub-departments */}
              {department.children && department.children.length > 0 && (
                <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-light flex items-center justify-center shadow-lg">
                      <Building2 className="text-text-on-brand" size={24} />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-text-heading">{t('subordinateDepartments')}</h3>
                      <p className="text-sm text-text-muted">{t('subDeptsCount', { count: department.children.length })}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {department.children.map((child) => (
                      <motion.div
                        key={child.id}
                        whileHover={{ scale: 1.02 }}
                        onClick={() => router.push(`/dashboard/departments/${child.id}`)}
                        className="group p-5 border-2 border-surface-border rounded-[--radius-card] hover:border-brand-primary/45 hover:bg-brand-primary-light/10 transition-all cursor-pointer"
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-14 h-14 rounded-[--radius-card] bg-brand-primary-light/20 group-hover:bg-brand-primary-light/35 flex items-center justify-center transition-colors">
                            <Building2 className="text-brand-primary" size={24} />
                          </div>
                          <div className="flex-1">
                            <p className="font-bold text-text-heading group-hover:text-brand-primary transition-colors text-lg">{child.name}</p>
                            <p className="text-sm text-text-muted font-semibold">{child.code}</p>
                          </div>
                          <div className="text-end">
                            <p className="text-2xl font-bold text-brand-primary">{child._count?.employees || 0}</p>
                            <p className="text-xs text-text-muted font-medium">{t('employeeSingular')}</p>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'employees' && (
            <motion.div
              key="employees"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-status-success to-status-success flex items-center justify-center shadow-lg">
                    <Users className="text-white" size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-text-heading">{t('employeeListHeading')}</h3>
                    <p className="text-sm text-text-muted">{t('employeeCount', { count: department._count?.employees || 0 })}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleTransferEmployee}
                    className="px-5 py-2.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all font-semibold cursor-pointer"
                  >
                    <UserPlus size={18} className="inline me-2" /> {t('addStaff')}
                  </button>
                  {(department._count?.employees || 0) > 0 && (
                    <button
                      onClick={() => router.push(`/dashboard/employees?departmentId=${id}`)}
                      className="px-5 py-2.5 bg-surface-card border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-all font-semibold cursor-pointer"
                    >
                      {t('seeAll')}
                    </button>
                  )}
                </div>
              </div>

              {department.employees && department.employees.length > 0 ? (
                <div className="space-y-3">
                  {department.employees.slice(0, 10).map((employee, index) => (
                    <motion.div
                      key={employee.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      onClick={() => router.push(`/dashboard/employees/${employee.id}`)}
                      className="group flex items-center gap-5 p-5 border-2 border-surface-border rounded-[--radius-card] hover:border-brand-primary/45 hover:bg-brand-primary-light/10 transition-all cursor-pointer"
                    >
                      <div className="w-16 h-16 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-xl shadow-lg">
                        {employee.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                      </div>
                      <div className="flex-1">
                        <p className="font-bold text-text-heading group-hover:text-brand-primary transition-colors text-lg">{employee.fullName}</p>
                        <p className="text-brand-primary font-semibold">{employee.position}</p>
                        <div className="flex items-center gap-4 mt-2">
                          <div className="flex items-center gap-1.5 text-sm text-text-body">
                            <User size={14} className="text-text-muted" />
                            <span className="font-medium">{employee.employeeCode}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-sm text-text-body">
                            <Mail size={14} className="text-text-muted" />
                            <span>{employee.email}</span>
                          </div>
                        </div>
                      </div>
                      <div className="text-end">
                        <span className={`px-3 py-1.5 rounded-[--radius-badge] text-xs font-bold ${
                          employee.status === 'ACTIVE'
                            ? 'bg-status-success-bg text-status-success'
                            : 'bg-surface-page text-text-muted border border-surface-border'
                        }`}>
                          {employee.status === 'ACTIVE' ? t('statusWorking') : t('statusNotWorking')}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="w-20 h-20 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                    <Users className="text-text-muted" size={40} />
                  </div>
                  <h3 className="text-lg font-bold text-text-heading mb-2">{t('noEmployeesYet')}</h3>
                  <p className="text-text-muted mb-6">{t('noEmployeesYetDesc')}</p>
                  <button
                    onClick={handleTransferEmployee}
                    className="px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all font-bold cursor-pointer"
                  >
                    <UserPlus size={18} className="inline me-2" /> {t('addFirstEmployee')}
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'teams' && (
            <motion.div
              key="teams"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                    <Target className="text-text-on-accent" size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-text-heading">{t('teamsHeading')}</h3>
                    <p className="text-sm text-text-muted">{t('teamsCount', { count: teams.length })}</p>
                  </div>
                </div>
                <button
                  onClick={() => router.push('/dashboard/teams')}
                  className="px-5 py-2.5 bg-surface-card border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page transition-all font-semibold cursor-pointer"
                >
                  {t('seeAll')}
                </button>
              </div>

              {teams.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {teams.map((team, index) => (
                    <motion.div
                      key={team.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.05 }}
                      onClick={() => router.push(`/dashboard/teams/${team.id}`)}
                      className="group p-5 border-2 border-surface-border rounded-[--radius-card] hover:border-brand-accent/45 hover:bg-brand-accent/10 transition-all cursor-pointer"
                    >
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-[--radius-card] bg-brand-accent/15 group-hover:bg-brand-accent/25 flex items-center justify-center transition-colors">
                            <Target className="text-brand-accent" size={20} />
                          </div>
                          <div>
                            <p className="font-bold text-text-heading group-hover:text-brand-accent transition-colors">{team.name}</p>
                            <p className="text-sm text-text-muted font-semibold">{team.code}</p>
                          </div>
                        </div>
                        <div className="text-end">
                          <p className="text-2xl font-bold text-brand-accent">{team._count?.members || 0}</p>
                          <p className="text-xs text-text-muted font-medium">{t('memberSingular')}</p>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="w-20 h-20 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                    <Target className="text-text-muted" size={40} />
                  </div>
                  <h3 className="text-lg font-bold text-text-heading mb-2">{t('noTeamYet')}</h3>
                  <p className="text-text-muted">{t('noTeamYetDesc')}</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'performance' && (
            <motion.div
              key="performance"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              {performanceData ? (
                <PerformanceDashboard data={performanceData} loading={performanceLoading} />
              ) : (
                <div className="bg-surface-card rounded-[--radius-card] p-12 border border-surface-border text-center">
                  <div className="w-20 h-20 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                    <BarChart3 className="text-text-muted" size={40} />
                  </div>
                  <h3 className="text-lg font-bold text-text-heading mb-2">{t('noPerformanceData')}</h3>
                  <p className="text-text-muted">{t('noPerformanceDataDesc')}</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
            >
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-light flex items-center justify-center shadow-lg">
                  <History className="text-text-on-brand" size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-text-heading">{t('changeHistory')}</h3>
                  <p className="text-sm text-text-muted">{t('trackImportantChanges')}</p>
                </div>
              </div>
              <div className="text-center py-12">
                <div className="w-20 h-20 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-4">
                  <History className="text-text-muted" size={40} />
                </div>
                <h3 className="text-lg font-bold text-text-heading mb-2">{t('underDevelopment')}</h3>
                <p className="text-text-muted mb-6">{t('underDevelopmentDesc')}</p>
                <button
                  onClick={handleViewChangeRequests}
                  className="px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-lg transition-all font-bold cursor-pointer"
                >
                  {t('viewChangeRequest')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ProtectedRoute>
  );
}
