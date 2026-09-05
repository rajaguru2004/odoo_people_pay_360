'use client';

import { Department } from '@/types/department';
import DepartmentCard from './DepartmentCard';
import { Crown, Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

// Inline skeleton component
function DepartmentCardSkeleton() {
  return (
    <div className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border p-6 animate-pulse">
      <div className="flex items-start gap-4 mb-4">
        <div className="w-12 h-12 bg-slate-200 rounded-[--radius-card]"></div>
        <div className="flex-1">
          <div className="h-5 bg-slate-200 rounded w-3/4 mb-2"></div>
          <div className="h-4 bg-slate-200 rounded w-1/2"></div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-4 bg-slate-200 rounded w-full"></div>
        <div className="h-4 bg-slate-200 rounded w-5/6"></div>
        <div className="flex gap-2">
          <div className="h-6 bg-slate-200 rounded w-16"></div>
          <div className="h-6 bg-slate-200 rounded w-16"></div>
        </div>
      </div>
    </div>
  );
}

interface DepartmentCardViewProps {
  departments: Department[];
  onView: (id: string) => void;
  loading?: boolean;
}

export default function DepartmentCardView({ departments, onView, loading = false }: DepartmentCardViewProps) {
  const t = useTranslations('departmentCardView');

  // Show skeleton loading
  if (loading) {
    return (
      <div className="space-y-8">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-gray-200 rounded-[--radius-input] animate-pulse"></div>
            <div className="flex-1">
              <div className="h-6 w-32 bg-gray-200 rounded animate-pulse mb-1"></div>
              <div className="h-4 w-24 bg-gray-200 rounded animate-pulse"></div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <DepartmentCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Separate by logic - ONLY departments, not teams
  const ceoDepartment = departments.find(d => d.code === 'CEO' || d.name.includes('Director'));
  const otherDepartments = departments.filter(d => d.code !== 'CEO' && !d.name.includes('Director'));

  return (
    <div className="space-y-8">
      {/* CEO/Leadership */}
      {ceoDepartment && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-[--radius-card] bg-brand-accent flex items-center justify-center">
              <Crown className="text-text-on-accent" size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-text-heading">{t('managementHeading')}</h2>
              <p className="text-xs text-text-muted font-medium">{t('highestExecutiveLevel')}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div onClick={() => onView(ceoDepartment.id)} className="cursor-pointer h-full">
              <DepartmentCard department={ceoDepartment} />
            </div>
          </div>
        </div>
      )}

      {/* Other Departments */}
      {otherDepartments.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-[--radius-card] bg-brand-primary flex items-center justify-center">
              <Building2 className="text-text-on-brand" size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-text-heading">{t('departmentsHeading')}</h2>
              <p className="text-xs text-text-muted font-medium">
                {otherDepartments.length} {otherDepartments.length === 1 ? t('departmentSingular') : t('departmentPlural')} • {otherDepartments.reduce((sum, d) => sum + (d._count?.employees || 0), 0)} {t('employeesSuffix')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {otherDepartments.map((dept) => (
              <div key={dept.id} onClick={() => onView(dept.id)} className="cursor-pointer h-full">
                <DepartmentCard department={dept} />
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && departments.length === 0 && (
        <div data-testid="dept-empty" className="text-center py-12">
          <div className="w-16 h-16 rounded-full bg-surface-page flex items-center justify-center mx-auto mb-3">
            <Building2 className="text-text-muted" size={32} />
          </div>
          <p className="text-base font-semibold text-text-body mb-1">{t('noDepartmentFound')}</p>
          <p className="text-sm text-text-muted">{t('tryAdjustingFiltersOrSearch')}</p>
        </div>
      )}
    </div>
  );
}
