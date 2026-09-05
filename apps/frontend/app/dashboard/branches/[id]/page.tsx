'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Building2,
  Users,
  MapPin,
  Clock,
  Globe,
  Navigation,
  Crosshair,
  Edit,
  Trash2,
  User,
  IdCard,
} from 'lucide-react';
import { motion } from 'framer-motion';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { useBranch, useDeleteBranch } from '@/hooks/useBranches';
import { Branch } from '@/types/branch';

export default function BranchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const t = useTranslations('branchDetailPage');
  const tc = useTranslations('common');
  const { id } = use(params);

  const { data, isLoading, isError } = useBranch(id);
  const branch: Branch | undefined = data?.data;
  const deleteBranch = useDeleteBranch();

  // The one heading for this route, rendered by TopHeader, and the record crumb
  // the global breadcrumb trail names the branch with. Declared above the
  // loading/not-found early-returns so the hook order never changes; it falls
  // back to the section label until the branch has loaded.
  usePageHeader(branch?.name ?? t('breadcrumbBranches'), branch?.code ?? undefined);

  useEffect(() => {
    if (isError) {
      alert(t('noBranchFound'));
      router.push('/dashboard/branches');
    }
  }, [isError, router, t]);

  const handleDelete = async () => {
    if (!window.confirm(t('confirmDelete'))) return;
    try {
      await deleteBranch.mutateAsync(id);
      alert(t('deleteSuccess'));
      router.push('/dashboard/branches');
    } catch (error: any) {
      alert(getApiErrorMessage(error, t('deleteFailed')));
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-slate-200 rounded w-48">{/* neutral */}</div>
          <div className="h-40 bg-slate-100 rounded-xl">{/* neutral */}</div>
          <div className="grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-40 bg-slate-100 rounded-xl">{/* neutral */}</div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!branch) return null;

  // Config fields fall back to the global default when unset.
  const orInherit = (v: string | number | null | undefined) =>
    v !== null && v !== undefined && String(v).trim() !== '' ? String(v) : t('inheritsGlobal');
  const orNotSet = (v: string | number | null | undefined) =>
    v !== null && v !== undefined && String(v).trim() !== '' ? String(v) : t('notSet');

  const officeHours =
    branch.officeStartTime && branch.officeEndTime
      ? `${branch.officeStartTime} – ${branch.officeEndTime}`
      : t('inheritsGlobal');

  const addressRows: { label: string; value?: string }[] = [
    { label: t('addressLineLabel'), value: branch.addressLine || undefined },
    { label: t('cityLabel'), value: branch.city || undefined },
    { label: t('stateLabel'), value: branch.state || undefined },
    { label: t('countryLabel'), value: branch.country || undefined },
    { label: t('postalCodeLabel'), value: branch.postalCode || undefined },
  ];
  const hasAddress = addressRows.some((r) => r.value);

  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <div className="max-w-7xl mx-auto">
        {/* Back navigation and actions only. The global PageBreadcrumbs in
            DashboardLayout already renders this route's trail — with the branch
            named through usePageHeader above — so the hand-rolled trail that used
            to sit here was a second trail answering the same question. */}
        <div className="mb-6">
          <PageActionRow
            onBack={() => router.back()}
            action={
              <div className="flex gap-2">
                <button
                  data-testid="branch-detail-edit"
                  onClick={() => router.push(`/dashboard/branches/${id}/edit`)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-surface-card border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-page hover:border-surface-border/90 transition-all font-semibold shadow-sm hover:shadow-md cursor-pointer"
                >
                  <Edit size={18} /> {t('editBtn')}
                </button>
                <button
                  data-testid="branch-detail-delete"
                  onClick={handleDelete}
                  className="flex items-center gap-2 px-5 py-2.5 bg-status-error-bg text-status-error border-2 border-status-error/20 rounded-[--radius-button] hover:bg-status-error hover:text-white transition-all font-semibold shadow-sm hover:shadow-md cursor-pointer"
                >
                  <Trash2 size={18} /> {t('deleteBtn')}
                </button>
              </div>
            }
          />
        </div>

        {/* Header Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-r from-brand-primary to-brand-primary-dark rounded-[--radius-card] p-8 mb-6 text-text-on-brand shadow-2xl relative overflow-hidden"
        >
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-0 end-0 w-96 h-96 bg-white rounded-full blur-3xl transform translate-x-1/2 -translate-y-1/2"></div>
            <div className="absolute bottom-0 start-0 w-96 h-96 bg-white rounded-full blur-3xl transform -translate-x-1/2 translate-y-1/2"></div>
          </div>
          <div className="relative z-10">
            <div className="flex items-start gap-6 mb-6">
              <div className="w-24 h-24 rounded-[--radius-card] bg-white/20 backdrop-blur-sm flex items-center justify-center border-2 border-white/30 shadow-xl">
                <Building2 size={48} className="text-text-on-brand" />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  {/* h2, not h1: the page's single heading slot belongs to TopHeader. */}
                  <h2 data-testid="branch-detail-name" className="text-4xl font-bold">{branch.name}</h2>
                  <span
                    className={`px-4 py-1.5 rounded-[--radius-badge] text-sm font-bold ${
                      branch.isActive
                        ? 'bg-status-success-bg text-status-success border border-status-success/20'
                        : 'bg-status-error-bg text-status-error border border-status-error/20'
                    }`}
                  >
                    {branch.isActive ? tc('active') : tc('inactive')}
                  </span>
                </div>
                <p className="text-brand-primary-light font-bold text-xl mb-4">
                  {t('codeLabel')}
                  {branch.code}
                </p>
                {branch.description && (
                  <p className="text-white/90 max-w-3xl leading-relaxed text-lg">{branch.description}</p>
                )}
              </div>
            </div>

            {/* Quick Stats in Header */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <Users className="text-white/80 mb-2" size={24} />
                <p data-testid="branch-detail-staff" className="text-3xl font-bold mb-1">{branch._count?.employees || 0}</p>
                <p className="text-white/80 text-sm font-medium">{t('statStaff')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <Globe className="text-white/80 mb-2" size={24} />
                <p data-testid="branch-detail-timezone" className="text-lg font-bold mb-1 truncate">{orInherit(branch.timezone)}</p>
                <p className="text-white/80 text-sm font-medium">{t('statTimezone')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <Clock className="text-white/80 mb-2" size={24} />
                <p data-testid="branch-detail-hours" className="text-lg font-bold mb-1 truncate">{officeHours}</p>
                <p className="text-white/80 text-sm font-medium">{t('statOfficeHours')}</p>
              </div>
              <div className="bg-white/10 backdrop-blur-sm rounded-[--radius-card] p-4 border border-white/20">
                <Navigation className="text-white/80 mb-2" size={24} />
                <p className="text-lg font-bold mb-1">
                  {branch.geofencingEnabled ? t('geofenceEnabled') : t('geofenceDisabled')}
                </p>
                <p className="text-white/80 text-sm font-medium">{t('statGeofence')}</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Info grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Address */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                <MapPin className="text-text-on-accent" size={24} />
              </div>
              <h3 className="text-xl font-bold text-text-heading">{t('addressHeading')}</h3>
            </div>
            {hasAddress ? (
              <div className="space-y-3">
                {addressRows
                  .filter((r) => r.value)
                  .map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light last:border-0">
                      <span className="text-sm text-text-muted font-medium">{row.label}</span>
                      <span className="text-sm text-text-heading font-semibold text-end">{row.value}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t('noAddress')}</p>
            )}
          </motion.div>

          {/* Work configuration */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-lg">
                <Clock className="text-text-on-brand" size={24} />
              </div>
              <h3 className="text-xl font-bold text-text-heading">{t('workConfigHeading')}</h3>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light">
                <span className="text-sm text-text-muted font-medium">{t('timezoneLabel')}</span>
                <span className="text-sm text-text-heading font-semibold text-end">{orInherit(branch.timezone)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light">
                <span className="text-sm text-text-muted font-medium">{t('officeStartLabel')}</span>
                <span className="text-sm text-text-heading font-semibold text-end">{orInherit(branch.officeStartTime)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-text-muted font-medium">{t('officeEndLabel')}</span>
                <span className="text-sm text-text-heading font-semibold text-end">{orInherit(branch.officeEndTime)}</span>
              </div>
            </div>
          </motion.div>

          {/* Geofence */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                <Navigation className="text-text-on-accent" size={24} />
              </div>
              <h3 className="text-xl font-bold text-text-heading">{t('geofenceHeading')}</h3>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light">
                <span className="text-sm text-text-muted font-medium">{t('geofenceStatusLabel')}</span>
                <span
                  className={`px-3 py-1 rounded-[--radius-badge] text-xs font-bold ${
                    branch.geofencingEnabled
                      ? 'bg-status-success-bg text-status-success border border-status-success/20'
                      : 'bg-surface-page text-text-muted border border-surface-border'
                  }`}
                >
                  {branch.geofencingEnabled ? t('geofenceEnabled') : t('geofenceDisabled')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light">
                <span className="flex items-center gap-1.5 text-sm text-text-muted font-medium">
                  <Crosshair size={14} /> {t('latitudeLabel')}
                </span>
                <span className="text-sm text-text-heading font-semibold text-end">{orNotSet(branch.latitude)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2 border-b border-surface-border-light">
                <span className="flex items-center gap-1.5 text-sm text-text-muted font-medium">
                  <Crosshair size={14} /> {t('longitudeLabel')}
                </span>
                <span className="text-sm text-text-heading font-semibold text-end">{orNotSet(branch.longitude)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-text-muted font-medium">{t('radiusLabel')}</span>
                <span className="text-sm text-text-heading font-semibold text-end">
                  {branch.geofenceRadiusM != null
                    ? `${branch.geofenceRadiusM}${t('metersSuffix')}`
                    : t('notSet')}
                </span>
              </div>
            </div>
          </motion.div>

          {/* Manager */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-light flex items-center justify-center shadow-lg">
                <User className="text-text-on-brand" size={24} />
              </div>
              <h3 className="text-xl font-bold text-text-heading">{t('managerHeading')}</h3>
            </div>
            {branch.manager ? (
              <div className="flex items-center gap-4 p-4 bg-brand-primary-light/10 rounded-[--radius-card] border border-brand-primary/20">
                <div className="w-14 h-14 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-xl shadow-lg">
                  {branch.manager.fullName.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-text-heading">{branch.manager.fullName}</p>
                  <div className="flex items-center gap-1.5 text-sm text-text-body mt-1">
                    <IdCard size={14} className="text-text-muted" />
                    <span className="font-medium">{branch.manager.employeeCode}</span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t('noManager')}</p>
            )}
          </motion.div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
