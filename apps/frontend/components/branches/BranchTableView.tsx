'use client';

import { Branch } from '@/types/branch';
import { Building2, Users, MapPin, Navigation, Edit, Trash2, RotateCcw } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

interface BranchTableViewProps {
  branches: Branch[];
  onView: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Only passed for a retired branch — switches it back on. */
  onReactivate?: (id: string) => void;
  loading?: boolean;
}

const formatLocation = (branch: Branch): string => {
  const parts = [branch.city, branch.state, branch.country].filter(Boolean);
  return parts.join(', ');
};

export default function BranchTableView({
  branches,
  onView,
  onEdit,
  onDelete,
  onReactivate,
  loading = false,
}: BranchTableViewProps) {
  const t = useTranslations('branchTableView');
  const tc = useTranslations('common');

  const headers = [
    t('colCode'),
    t('colName'),
    t('colLocation'),
    t('colEmployees'),
    t('colGeofence'),
    t('colStatus'),
    t('colActions'),
  ];

  if (loading) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand sticky top-0">
            <tr>
              {headers.map((header) => (
                <th key={header} className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...Array(5)].map((_, i) => (
              <tr key={i} className="animate-pulse border-b border-surface-border-light">
                {[...Array(7)].map((__, j) => (
                  <td key={j} className="px-4 py-3">
                    <div className="h-4 bg-slate-100 rounded w-20">{/* neutral */}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div data-testid="branch-empty" className="flex flex-col items-center justify-center py-16 text-text-muted">
        <Building2 size={64} className="mb-4" />
        <p className="text-lg font-medium">{t('noBranchesFound')}</p>
        <p className="text-sm mt-1">{t('tryAdjustingSearch')}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand sticky top-0 shadow-lg">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface-card divide-y divide-surface-border-light">
          {branches.map((branch, index) => {
            const location = formatLocation(branch);
            return (
              <motion.tr
                key={branch.id}
                data-testid={`branch-row-${branch.code}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * 0.03 }}
                // The detail route 404s on a retired branch, so its row is not
                // a link — the reactivate button is the only way out.
                onClick={() => branch.isActive && onView(branch.id)}
                className={`hover:bg-brand-primary-light/10 transition-all group border-b border-surface-border-light ${
                  branch.isActive ? 'cursor-pointer' : 'opacity-70'
                }`}
              >
                <td className="px-4 py-3 text-sm font-semibold text-brand-primary group-hover:underline">
                  {branch.code}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-[--radius-input] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-md shadow-brand-primary/30">
                      <Building2 size={16} className="text-text-on-brand" />
                    </div>
                    <span className="text-sm font-semibold text-text-heading">{branch.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-text-body">
                  {location ? (
                    <div className="flex items-center gap-1.5">
                      <MapPin size={14} className="text-brand-primary shrink-0" />
                      <span className="font-medium text-text-body">{location}</span>
                    </div>
                  ) : (
                    <span className="text-text-muted text-xs font-medium">{t('noLocation')}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <Users size={14} className="text-brand-accent" />
                    <span className="text-sm font-bold text-text-heading">{branch._count?.employees || 0}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {branch.geofencingEnabled ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[--radius-badge] border text-xs font-semibold bg-brand-accent/10 text-brand-accent border-brand-accent/20">
                      <Navigation size={12} />
                      {t('geofenceOn')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[--radius-badge] border text-xs font-semibold bg-surface-page text-text-muted border-surface-border">
                      {t('geofenceOff')}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`px-3 py-1 rounded-[--radius-badge] text-xs font-bold ${
                      branch.isActive
                        ? 'bg-status-success text-white shadow-md'
                        : 'bg-surface-page text-text-muted border border-surface-border'
                    }`}
                  >
                    {branch.isActive ? tc('active') : tc('inactive')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    {!branch.isActive && onReactivate && (
                      <button
                        data-testid="branch-row-reactivate"
                        onClick={(e) => {
                          e.stopPropagation();
                          onReactivate(branch.id);
                        }}
                        title={t('reactivateTitle')}
                        className="p-2 rounded-[--radius-button] text-brand-primary hover:bg-brand-primary-light/15 transition-colors"
                      >
                        <RotateCcw size={16} />
                      </button>
                    )}
                    {branch.isActive && onEdit && (
                      <button
                        data-testid="branch-row-edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(branch.id);
                        }}
                        title={t('editTitle')}
                        className="p-2 rounded-[--radius-button] text-text-muted hover:text-brand-primary hover:bg-brand-primary-light/15 transition-colors"
                      >
                        <Edit size={16} />
                      </button>
                    )}
                    {branch.isActive && onDelete && (
                      <button
                        data-testid="branch-row-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(branch.id);
                        }}
                        title={t('deleteTitle')}
                        className="p-2 rounded-[--radius-button] text-text-muted hover:text-status-error hover:bg-status-error-bg transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
