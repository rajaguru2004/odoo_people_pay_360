'use client';

import { Department } from '@/types/department';
import { Building2, Users, AlertCircle, TrendingUp, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

interface DepartmentTableViewProps {
  departments: Department[];
  onView: (id: string) => void;
  loading?: boolean;
}

// Helper: Get team capacity insight
const getTeamCapacityInsight = (
  employeeCount: number,
  hasManager: boolean,
  t: ReturnType<typeof useTranslations>
) => {
  if (!hasManager && employeeCount > 0) {
    return { type: 'warning', text: t('insightNeedsManagement'), icon: AlertCircle };
  }
  if (employeeCount === 0) {
    return { type: 'info', text: t('insightEmpty'), icon: AlertCircle };
  }
  if (employeeCount >= 20) {
    return { type: 'success', text: t('insightCrowded'), icon: TrendingUp };
  }
  if (employeeCount >= 10) {
    return { type: 'success', text: t('insightStable'), icon: Shield };
  }
  return { type: 'neutral', text: t('insightSmall'), icon: Users };
};

export default function DepartmentTableView({ departments, onView, loading = false }: DepartmentTableViewProps) {
  const t = useTranslations('departmentTableView');
  const tc = useTranslations('common');

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand sticky top-0">
            <tr>
              {[t('colCode'), t('colName'), t('colManager'), t('colEmployees'), t('colSubDepts'), t('colInsight'), t('colStatus')].map((header) => (
                <th key={header} className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...Array(5)].map((_, i) => (
              <tr key={i} className="animate-pulse border-b border-surface-border-light">
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-20"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-32"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-24"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-16"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-4 bg-slate-100 rounded w-16"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-6 bg-slate-100 rounded-full w-24"></div></td> {/* neutral */}
                <td className="px-4 py-3"><div className="h-6 bg-slate-100 rounded-full w-20"></div></td> {/* neutral */}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (departments.length === 0) {
    return (
      <div data-testid="dept-empty" className="flex flex-col items-center justify-center py-16 text-text-muted">
        <Building2 size={64} className="mb-4" />
        <p className="text-lg font-medium">{t('noDepartmentsFound')}</p>
        <p className="text-sm mt-1">{t('tryAdjustingFilters')}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand sticky top-0 shadow-lg">
          <tr>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colCode')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colName')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colManager')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colEmployees')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colSubDepts')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colInsight')}
            </th>
            <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
              {t('colStatus')}
            </th>
          </tr>
        </thead>
        <tbody className="bg-surface-card divide-y divide-surface-border-light">
          {departments.map((dept, index) => (
            <motion.tr
              key={dept.id}
              data-testid={`dept-row-${dept.code}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.03 }}
              onClick={() => onView(dept.id)}
              className="hover:bg-brand-primary-light/10 transition-all cursor-pointer group border-b border-surface-border-light"
            >
              <td className="px-4 py-3 text-sm font-semibold text-brand-primary group-hover:underline">
                {dept.code}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-[--radius-input] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-md shadow-brand-primary/30">
                    <Building2 size={16} className="text-text-on-brand" />
                  </div>
                  <span className="text-sm font-semibold text-text-heading">{dept.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-sm text-text-body">
                {dept.manager ? (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-xs shadow-md shadow-brand-primary/30">
                      {dept.manager.fullName.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </div>
                    <span className="font-medium text-text-body">{dept.manager.fullName}</span>
                  </div>
                ) : (
                  <span className="text-text-muted text-xs font-medium">{t('notAssigned')}</span>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1">
                  <Users size={14} className="text-brand-accent" />
                  <span className="text-sm font-bold text-text-heading">{dept._count?.employees || 0}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1">
                  <Building2 size={14} className="text-brand-primary" />
                  <span className="text-sm font-bold text-text-heading">{dept._count?.children || 0}</span>
                </div>
              </td>
              <td className="px-4 py-3">
                {(() => {
                  const insight = getTeamCapacityInsight(dept._count?.employees || 0, !!dept.manager, t);
                  const InsightIcon = insight.icon;
                  const colorClasses = {
                    warning: 'bg-status-warning-bg text-status-warning border-status-warning/20',
                    info: 'bg-surface-page text-text-muted border-surface-border',
                    success: 'bg-status-success-bg text-status-success border-status-success/20',
                    neutral: 'bg-brand-primary-light/10 text-brand-primary border-brand-primary/20',
                  };
                  
                  return (
                    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-[--radius-badge] border text-xs font-semibold ${colorClasses[insight.type as keyof typeof colorClasses]}`}>
                      <InsightIcon size={12} />
                      <span>{insight.text}</span>
                    </div>
                  );
                })()}
              </td>
              <td className="px-4 py-3">
                <span className={`px-3 py-1 rounded-[--radius-badge] text-xs font-bold ${
                  dept.isActive 
                    ? 'bg-status-success text-white shadow-md' 
                    : 'bg-surface-page text-text-muted border border-surface-border'
                }`}>
                  {dept.isActive ? tc('active') : tc('inactive')}
                </span>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
