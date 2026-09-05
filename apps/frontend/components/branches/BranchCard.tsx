'use client';

import { Building2, Users, MapPin, Clock, Navigation, Edit, Trash2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@/components/common/icons/directional';
import { Branch } from '@/types/branch';

interface BranchCardProps {
  branch: Branch;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Only passed for a retired branch — switches it back on. */
  onReactivate?: (id: string) => void;
}

// Compose "City, Country" from whichever address parts exist.
const formatLocation = (branch: Branch): string => {
  const parts = [branch.city, branch.country].filter(Boolean);
  return parts.join(', ');
};

export default function BranchCard({ branch, onEdit, onDelete, onReactivate }: BranchCardProps) {
  const t = useTranslations('branchCard');
  const tc = useTranslations('common');

  const employeeCount = branch._count?.employees || 0;
  const location = formatLocation(branch);
  const geofenced = !!branch.geofencingEnabled;
  const officeHours =
    branch.officeStartTime && branch.officeEndTime
      ? `${branch.officeStartTime} – ${branch.officeEndTime}`
      : null;

  return (
    <div
      data-testid={`branch-card-${branch.code}`}
      className={`group relative h-full flex flex-col bg-surface-card rounded-[--radius-card] border-2 transition-all duration-200 overflow-hidden ${
        branch.isActive
          ? 'border-surface-border hover:border-brand-primary hover:shadow-lg hover:shadow-brand-primary/10'
          : 'border-surface-border hover:border-brand-primary/50 hover:shadow-lg hover:shadow-brand-primary/5'
      }`}
    >
      {/* Header */}
      <div className="p-4 border-b border-surface-border-light">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="w-11 h-11 rounded-[--radius-card] flex items-center justify-center bg-brand-primary text-text-on-brand shrink-0">
            <Building2 size={20} />
          </div>

          {/* Title & Code */}
          <div className="flex-1 min-w-0">
            <h3 data-testid="branch-card-name" className="font-bold text-base text-text-heading mb-0.5 line-clamp-1">{branch.name}</h3>
            <p data-testid="branch-card-code" className="text-sm text-text-muted font-medium">{branch.code}</p>
          </div>

          {/* Status Badge */}
          <span
            data-testid="branch-card-status"
            className={`px-2 py-1 text-[10px] font-bold rounded-[--radius-badge] border shrink-0 ${
              branch.isActive
                ? 'bg-status-success-bg text-status-success border-status-success/20'
                : 'bg-surface-page text-text-muted border-surface-border'
            }`}
          >
            {branch.isActive ? tc('active') : tc('inactive')}
          </span>
        </div>

        {/* Geofence badge */}
        {geofenced && (
          <div className="mt-2">
            <span data-testid="branch-card-geofenced" className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-[--radius-badge] bg-brand-accent/10 text-brand-accent border border-brand-accent/20">
              <Navigation size={11} />
              {t('geofenced')}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Description */}
        {branch.description && (
          <p className="text-sm text-text-body leading-relaxed line-clamp-2">{branch.description}</p>
        )}

        {/* Location */}
        <div className="flex items-start gap-2 text-sm text-text-body">
          <MapPin size={16} className="text-brand-primary mt-0.5 shrink-0" />
          <span data-testid="branch-card-location" className="line-clamp-2">{location || t('noLocationSet')}</span>
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/25">
            <Users className="text-brand-accent" size={16} />
            <span data-testid="branch-card-staff" className="text-sm font-bold text-text-heading">{employeeCount}</span>
            <span className="text-sm text-brand-accent">{t('staffBadge')}</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-2 bg-brand-primary-light/20 rounded-[--radius-card] border border-brand-primary/20">
            <Clock className="text-brand-primary" size={16} />
            <span data-testid="branch-card-hours" className="text-sm font-semibold text-brand-primary">
              {officeHours || t('inheritsDefault')}
            </span>
          </div>
        </div>

        {/* Footer Area - Pushed to the bottom */}
        <div className="mt-auto flex gap-2 pt-2">
          {/* A retired branch offers exactly one action. Edit and Details are
              deliberately absent: the detail route 404s on an inactive branch,
              so those buttons would only lead to a dead end. */}
          {!branch.isActive && onReactivate && (
            <button
              data-testid="branch-card-reactivate"
              onClick={(e) => {
                e.stopPropagation();
                onReactivate(branch.id);
              }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold text-text-on-brand bg-brand-primary rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors"
            >
              <RotateCcw size={14} />
              {t('reactivate')}
            </button>
          )}
          {branch.isActive && onDelete && (
            <button
              data-testid="branch-card-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(branch.id);
              }}
              title={tc('delete')}
              className="px-3 py-2 text-sm font-semibold text-status-error bg-status-error-bg/40 rounded-[--radius-button] hover:bg-status-error-bg border border-status-error/20 transition-colors"
            >
              <Trash2 size={16} />
            </button>
          )}
          {branch.isActive && onEdit && (
            <button
              data-testid="branch-card-edit"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(branch.id);
              }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold text-brand-primary bg-brand-primary-light/10 rounded-[--radius-button] hover:bg-brand-primary-light/20 border border-brand-primary/20 transition-colors"
            >
              <Edit size={14} />
              {t('edit')}
            </button>
          )}
          {branch.isActive && (
            <Link
              data-testid="branch-card-details"
              href={`/dashboard/branches/${branch.id}`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 px-3 py-2 text-sm font-semibold text-text-on-brand bg-brand-primary rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors"
            >
              {t('details')}
              <ChevronRightIcon size={14} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
