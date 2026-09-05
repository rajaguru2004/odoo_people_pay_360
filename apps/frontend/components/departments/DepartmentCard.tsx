'use client';

import { Building2, Users, AlertCircle, Crown, TrendingUp, Award } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@/components/common/icons/directional';

interface DepartmentCardProps {
  department: any;
  onAssignManager?: (id: string) => void;
}

// Calculate department health status
const getDepartmentStatus = (dept: any, t: ReturnType<typeof useTranslations>) => {
  const hasManager = !!dept.managerId;
  const employeeCount = dept._count?.employees || 0;
  const childCount = dept._count?.children || 0;
  const isTeam = !!dept.parentId;

  if (isTeam) {
    if (hasManager) {
      return { status: 'healthy', label: t('teamLead'), color: 'purple', icon: Award };
    }
    return { status: 'action', label: t('noLeadYet'), color: 'yellow', icon: AlertCircle };
  }

  if (!hasManager && employeeCount === 0) {
    return { status: 'risk', label: t('risk'), color: 'red', icon: AlertCircle };
  }
  if (!hasManager) {
    return { status: 'action', label: t('needsProcessing'), color: 'yellow', icon: AlertCircle };
  }
  if (employeeCount === 0) {
    return { status: 'empty', label: t('noStaffYet'), color: 'gray', icon: Users };
  }
  return { status: 'healthy', label: t('stable'), color: 'green', icon: TrendingUp };
};

const getStatusStyles = (color: string) => {
  const styles = {
    green: 'bg-status-success-bg text-status-success border-status-success/20',
    yellow: 'bg-status-warning-bg text-status-warning border-status-warning/20',
    red: 'bg-status-error-bg text-status-error border-status-error/20',
    purple: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20',
    gray: 'bg-surface-page text-text-muted border-surface-border',
  };
  return styles[color as keyof typeof styles] || styles.gray;
};

const getDepartmentType = (dept: any, t: ReturnType<typeof useTranslations>) => {
  const isCEO = dept.code === 'CEO' || dept.name.includes('Director');
  if (isCEO) return { label: t('typeManagement'), color: 'brand-accent' };
  if (!dept.parentId) return { label: t('typeDepartments'), color: 'brand-primary' };
  return { label: t('typeSubordinateRoom'), color: 'brand-primary-light' };
};

export default function DepartmentCard({ department, onAssignManager }: DepartmentCardProps) {
  const t = useTranslations('departmentCard');
  const tc = useTranslations('common');
  const status = getDepartmentStatus(department, t);
  const type = getDepartmentType(department, t);
  const employeeCount = department._count?.employees || 0;
  const childCount = department._count?.children || 0;
  const StatusIcon = status.icon;
  const isCEO = type.label === t('typeManagement');
  const hasManager = !!department.managerId;

  return (
    <div data-testid={`dept-card-${department.code}`} className={`group relative h-full flex flex-col bg-surface-card rounded-[--radius-card] border-2 transition-all duration-200 overflow-hidden ${
      isCEO 
        ? 'border-brand-accent/20 hover:border-brand-accent hover:shadow-lg hover:shadow-brand-accent/10' 
        : type.color === 'brand-primary'
        ? 'border-surface-border hover:border-brand-primary hover:shadow-lg hover:shadow-brand-primary/10'
        : 'border-surface-border hover:border-brand-primary/50 hover:shadow-lg hover:shadow-brand-primary/5'
    }`}>
      {/* Header */}
      <div className="p-4 border-b border-surface-border-light">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className={`w-11 h-11 rounded-[--radius-card] flex items-center justify-center ${
            isCEO ? 'bg-brand-accent text-text-on-accent' :
            type.color === 'brand-primary' ? 'bg-brand-primary text-text-on-brand' :
            'bg-brand-primary-light/20 text-brand-primary'
          }`}>
            {isCEO ? <Crown size={20} /> : <Building2 size={20} />}
          </div>

          {/* Title & Code */}
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-base text-text-heading mb-0.5 line-clamp-1">
              {department.name}
            </h3>
            <p className="text-sm text-text-muted font-medium">{department.code}</p>
          </div>

          {/* Status Badge - Only show if no manager or inactive */}
          {(!hasManager || !department.isActive) && (
            <div className={`flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-[--radius-badge] border ${getStatusStyles(status.color)}`}>
              <AlertCircle size={11} />
              <span>{!hasManager ? t('noManagerYet') : tc('inactive')}</span>
            </div>
          )}
        </div>

        {/* Type Badge */}
        <div className="mt-2">
          <span className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded-[--radius-badge] ${
            isCEO 
              ? 'bg-brand-accent/10 text-brand-accent' 
              : type.color === 'brand-primary'
              ? 'bg-brand-primary-light/20 text-brand-primary'
              : 'bg-brand-primary-light/10 text-brand-primary'
          }`}>
            {type.label}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Description */}
        {department.description && (
          <p className="text-sm text-text-body leading-relaxed line-clamp-2">
            {department.description}
          </p>
        )}

        {/* Metrics */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/25">
            <Users className="text-brand-accent" size={16} />
            <span className="text-sm font-bold text-text-heading">{employeeCount}</span>
            <span className="text-sm text-brand-accent">{t('staffBadge')}</span>
          </div>
          {childCount > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-primary-light/20 rounded-[--radius-card] border border-brand-primary/20">
              <Building2 className="text-brand-primary" size={16} />
              <span className="text-sm font-bold text-brand-primary">{childCount}</span>
              <span className="text-sm text-brand-primary">{t('teamBadge')}</span>
            </div>
          )}
        </div>

        {/* Manager Info */}
        {department.manager ? (
          <div className="flex items-center gap-2.5 p-3 bg-surface-page rounded-[--radius-card] border border-surface-border-light">
            <div className="w-9 h-9 rounded-full bg-brand-primary flex items-center justify-center text-text-on-brand font-bold text-xs">
              {department.manager.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-text-muted uppercase">
                {type.label === t('typeSubordinateRoom') ? t('departmentManager') : t('typeManagement')}
              </p>
              <p className="text-sm font-bold text-text-heading truncate">{department.manager.fullName}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-3 bg-status-warning-bg rounded-[--radius-card] border border-status-warning/20">
            <AlertCircle size={16} className="text-status-warning" />
            <span className="text-sm font-semibold text-status-warning">{t('unmanaged')}</span>
          </div>
        )}

        {/* Footer Area - Pushed to the bottom */}
        <div className="mt-auto space-y-3 pt-2">
          {/* Parent Department */}
          {department.parent && (
            <div className="pt-2 border-t border-surface-border">
              <p className="text-[10px] text-text-muted">
                {t('belongsTo')} <span className="text-text-body font-semibold">{department.parent.name}</span>
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {!department.managerId && onAssignManager && (
              <button
                onClick={() => onAssignManager(department.id)}
                className="flex-1 px-3 py-2 text-sm font-semibold text-brand-primary bg-brand-primary-light/10 rounded-[--radius-button] hover:bg-brand-primary-light/20 border border-brand-primary/20 transition-colors"
              >
                {t('appointment')}
              </button>
            )}
            <Link
              href={`/dashboard/departments/${department.id}`}
              className="px-3 py-2 text-sm font-semibold text-text-on-brand bg-brand-primary rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors flex items-center gap-1"
            >
              {t('details')}
              <ChevronRightIcon size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
